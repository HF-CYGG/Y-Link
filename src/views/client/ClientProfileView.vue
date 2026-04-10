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
const submitting = ref(false)
const formRef = ref<FormInstance>()
const form = reactive({
  currentPassword: '',
  newPassword: '',
})

const rules: FormRules = {
  currentPassword: [{ required: true, message: '请输入原密码', trigger: 'blur' }],
  newPassword: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    { min: 6, message: '新密码至少6位', trigger: 'blur' },
  ],
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
</script>

<template>
  <section class="space-y-4 pb-20">
    <div class="rounded-[1.4rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
      <p class="text-xl font-semibold text-slate-900">我的</p>
      <p class="mt-1 text-sm text-slate-500">查看账号信息与取货相关资料</p>
    </div>

    <div class="rounded-[1.2rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
      <p class="text-xs text-slate-400">姓名</p>
      <p class="mt-1 text-base font-semibold text-slate-900">{{ clientAuthStore.currentUser?.realName || '-' }}</p>

      <p class="mt-4 text-xs text-slate-400">手机号</p>
      <p class="mt-1 text-base font-semibold text-slate-900">{{ clientAuthStore.currentUser?.mobile || '-' }}</p>

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
  </section>
</template>
