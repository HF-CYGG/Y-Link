<script setup lang="ts">
/**
 * 模块说明：src/views/client/ClientProfileView.vue
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import { useRouter } from 'vue-router'
import { useClientAuthStore } from '@/store'
import { clientChangePassword } from '@/api/modules/client-auth'

const router = useRouter()
const clientAuthStore = useClientAuthStore()

const passwordDialogVisible = ref(false)
const profileDialogVisible = ref(false)
const submitting = ref(false)
const profileSubmitting = ref(false)
const formRef = ref<FormInstance>()
const profileFormRef = ref<FormInstance>()
const form = reactive({
  currentPassword: '',
  newPassword: '',
})
const profileForm = reactive({
  username: '',
  mobile: '',
  email: '',
  departmentName: '',
})

const rules: FormRules = {
  currentPassword: [{ required: true, message: '请输入原密码', trigger: 'blur' }],
  newPassword: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    { min: 6, message: '新密码至少6位', trigger: 'blur' },
  ],
}

const profileRules: FormRules = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  mobile: [
    {
      validator: (_rule, value: string, callback) => {
        if (value && !/^1\d{10}$/.test(value.trim())) {
          callback(new Error('手机号格式不正确'))
          return
        }
        if (!value.trim() && !profileForm.email.trim()) {
          callback(new Error('手机号和邮箱至少保留一项'))
          return
        }
        callback()
      },
      trigger: 'blur',
    },
  ],
  email: [
    {
      validator: (_rule, value: string, callback) => {
        if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) {
          callback(new Error('邮箱格式不正确'))
          return
        }
        if (!value.trim() && !profileForm.mobile.trim()) {
          callback(new Error('手机号和邮箱至少保留一项'))
          return
        }
        callback()
      },
      trigger: 'blur',
    },
  ],
}

const openProfileDialog = () => {
  profileForm.username = clientAuthStore.currentUser?.account || clientAuthStore.currentUser?.realName || ''
  profileForm.mobile = clientAuthStore.currentUser?.mobile || ''
  profileForm.email = clientAuthStore.currentUser?.email || ''
  profileForm.departmentName = clientAuthStore.currentUser?.departmentName || ''
  profileDialogVisible.value = true
  profileFormRef.value?.clearValidate()
}

const openPasswordDialog = () => {
  form.currentPassword = ''
  form.newPassword = ''
  passwordDialogVisible.value = true
  // Reset fields if formRef exists
  if (formRef.value) {
    formRef.value.resetFields()
  }
}

const submitChangePassword = async () => {
  if (!formRef.value) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return

  try {
    submitting.value = true
    await clientChangePassword({
      currentPassword: form.currentPassword,
      newPassword: form.newPassword,
    })
    ElMessage.success('密码修改成功，请重新登录')
    passwordDialogVisible.value = false
    clientAuthStore.clearAuthState()
    await router.replace('/client/login')
  } catch (error: any) {
    ElMessage.error(error.message || '修改密码失败')
  } finally {
    submitting.value = false
  }
}

const submitUpdateProfile = async () => {
  if (!profileFormRef.value) return
  const valid = await profileFormRef.value.validate().catch(() => false)
  if (!valid) return

  const normalizedUsername = profileForm.username.trim()
  const normalizedMobile = profileForm.mobile.trim()
  const normalizedEmail = profileForm.email.trim().toLowerCase()
  if (normalizedUsername !== normalizedMobile && normalizedUsername !== normalizedEmail) {
    ElMessage.warning('用户名必须与手机号或邮箱保持一致')
    return
  }

  try {
    profileSubmitting.value = true
    await clientAuthStore.updateProfile({
      username: normalizedUsername,
      mobile: normalizedMobile || undefined,
      email: normalizedEmail || undefined,
      departmentName: profileForm.departmentName.trim() || undefined,
    })
    ElMessage.success('资料更新成功')
    profileDialogVisible.value = false
  } catch (error: any) {
    ElMessage.error(error.message || '资料更新失败')
  } finally {
    profileSubmitting.value = false
  }
}
</script>

<template>
  <section class="space-y-4 pb-20">
    <div class="rounded-[1.4rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
      <p class="text-xl font-semibold text-slate-900">我的</p>
      <p class="mt-1 text-sm text-slate-500">查看账号信息与取货相关资料</p>
    </div>

    <div class="rounded-[1.2rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
      <div class="mb-4 flex items-center justify-between">
        <div>
          <p class="text-base font-semibold text-slate-900">资料信息</p>
          <p class="mt-1 text-xs text-slate-400">可修改用户名、手机号、邮箱与部门信息</p>
        </div>
        <button
          type="button"
          class="rounded-full border border-slate-200 px-4 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 hover:text-slate-900"
          @click="openProfileDialog"
        >
          编辑
        </button>
      </div>

      <p class="text-xs text-slate-400">用户名</p>
      <p class="mt-1 text-base font-semibold text-slate-900">{{ clientAuthStore.currentUser?.account || clientAuthStore.currentUser?.realName || '-' }}</p>

      <p class="mt-4 text-xs text-slate-400">手机号</p>
      <p class="mt-1 text-base font-semibold text-slate-900">{{ clientAuthStore.currentUser?.mobile || '-' }}</p>

      <p class="mt-4 text-xs text-slate-400">邮箱</p>
      <p class="mt-1 text-base font-semibold text-slate-900">{{ clientAuthStore.currentUser?.email || '-' }}</p>

      <p class="mt-4 text-xs text-slate-400">部门</p>
      <p class="mt-1 text-base font-semibold text-slate-900">{{ clientAuthStore.currentUser?.departmentName || '未设置' }}</p>
    </div>

    <div class="rounded-[1.2rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
      <div class="flex items-center justify-between">
        <div>
          <p class="text-base font-semibold text-slate-900">修改密码</p>
          <p class="mt-1 text-xs text-slate-400">定期修改密码以保护账号安全</p>
        </div>
        <button
          type="button"
          class="rounded-full border border-slate-200 px-4 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 hover:text-slate-900"
          @click="openPasswordDialog"
        >
          修改
        </button>
      </div>
    </div>

    <el-dialog v-model="passwordDialogVisible" title="修改密码" width="90%" style="max-width: 400px" append-to-body>
      <el-form ref="formRef" :model="form" :rules="rules" label-position="top" @submit.prevent>
        <el-form-item label="原密码" prop="currentPassword">
          <el-input v-model="form.currentPassword" type="password" show-password placeholder="请输入原密码" />
        </el-form-item>
        <el-form-item label="新密码" prop="newPassword">
          <el-input v-model="form.newPassword" type="password" show-password placeholder="请输入新密码（至少6位）" />
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="flex justify-end gap-3">
          <el-button @click="passwordDialogVisible = false">取消</el-button>
          <el-button type="primary" :loading="submitting" @click="submitChangePassword">确认</el-button>
        </div>
      </template>
    </el-dialog>

    <el-dialog v-model="profileDialogVisible" title="编辑资料" width="90%" style="max-width: 420px" append-to-body>
      <el-form ref="profileFormRef" :model="profileForm" :rules="profileRules" label-position="top" @submit.prevent>
        <el-form-item label="用户名" prop="username">
          <el-input v-model="profileForm.username" placeholder="请输入用户名（需与手机号或邮箱一致）" />
        </el-form-item>
        <el-form-item label="手机号" prop="mobile">
          <el-input v-model="profileForm.mobile" placeholder="请输入手机号" />
        </el-form-item>
        <el-form-item label="邮箱" prop="email">
          <el-input v-model="profileForm.email" placeholder="请输入邮箱" />
        </el-form-item>
        <el-form-item label="部门" prop="departmentName">
          <el-input v-model="profileForm.departmentName" placeholder="请输入部门（选填）" />
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="flex justify-end gap-3">
          <el-button @click="profileDialogVisible = false">取消</el-button>
          <el-button type="primary" :loading="profileSubmitting" @click="submitUpdateProfile">保存</el-button>
        </div>
      </template>
    </el-dialog>
  </section>
</template>
