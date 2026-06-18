<script setup lang="ts">
/**
 * 模块说明：src/views/client/ClientProfileView.vue
 * 文件职责：客户端个人中心页面，负责展示资料信息、编辑资料以及用户本人修改登录密码。
 * 维护说明：
 * - 资料编辑与改密都属于当前登录用户自助操作；
 * - 本次改密口径需与客户端注册、找回密码保持一致，避免用户在不同入口看到不同规则；
 * - 改密成功后会强制清理客户端会话与订单缓存，避免共享设备上继续残留旧账号数据。
 */

import { computed, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'

import type { FormInstance, FormRules } from 'element-plus'
import { BizCrudDialogShell } from '@/components/common'
import { useClientAuthStore } from '@/store'
import pinia from '@/store/pinia'
import { redirectToClientLogin } from '@/utils/client-auth-navigation'
import {
  clientChangePassword,
} from '@/api/modules/client-auth'
import { showAppError, showAppInfo, showAppSuccess, showAppWarning } from '@/utils/app-alert'
import {
  CLIENT_CONFIRM_NEW_PASSWORD_PLACEHOLDER,
  CLIENT_NEW_PASSWORD_PLACEHOLDER,
  CLIENT_NEW_PASSWORD_RULE_HINT,
  validateClientConfirmNewPassword,
  validateClientNewPassword,
} from '@/utils/client-password-policy'

const clientAuthStore = useClientAuthStore(pinia)
const router = useRouter()

const passwordDialogVisible = ref(false)
const profileDialogVisible = ref(false)
const submitting = ref(false)
const profileSubmitting = ref(false)
const formRef = ref<FormInstance>()
const profileFormRef = ref<FormInstance>()
const form = reactive({
  currentPassword: '',
  newPassword: '',
  confirmPassword: '',
})
const profileForm = reactive({
  username: '',
  mobile: '',
  email: '',
})

const isDepartmentAccount = computed(() => clientAuthStore.currentUser?.accountType === 'department')
const accountTypeLabel = computed(() => (isDepartmentAccount.value ? '部门账户' : '个人账户'))
const displayName = computed(() => (
  clientAuthStore.currentUser?.username
  || clientAuthStore.currentUser?.realName
  || clientAuthStore.currentUser?.account
  || '-'
))
const displayDepartmentName = computed(() => clientAuthStore.currentUser?.departmentName?.trim() || '未设置')
const displayStaffNo = computed(() => clientAuthStore.currentUser?.staffNo?.trim() || '未登记')

const rules: FormRules = {
  currentPassword: [{ required: true, message: '请输入原密码', trigger: 'blur' }],
  newPassword: [
    {
      validator: (_rule, value: string, callback) => {
        validateClientNewPassword(value, callback)
      },
      trigger: 'blur',
    },
  ],
  confirmPassword: [
    {
      validator: (_rule, value: string, callback) => {
        validateClientConfirmNewPassword(value, form.newPassword, callback)
      },
      trigger: 'blur',
    },
  ],
}

const profileRules: FormRules = {
  username: [{ required: true, message: '请输入姓名', trigger: 'blur' }],
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
  if (isDepartmentAccount.value) {
    showAppInfo('部门账户资料由管理员或教职工目录维护，客户端仅支持查看')
    return
  }
  profileForm.username = clientAuthStore.currentUser?.username || clientAuthStore.currentUser?.account || clientAuthStore.currentUser?.realName || ''
  profileForm.mobile = clientAuthStore.currentUser?.mobile || ''
  profileForm.email = clientAuthStore.currentUser?.email || ''
  profileDialogVisible.value = true
  profileFormRef.value?.clearValidate()
}

const openPasswordDialog = () => {
  form.currentPassword = ''
  form.newPassword = ''
  form.confirmPassword = ''
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
    showAppSuccess('密码修改成功，请重新登录')
    passwordDialogVisible.value = false
    clientAuthStore.clearAuthState()
    // 改密后强制重建客户端页面树，避免旧登录态壳层残留。
    redirectToClientLogin()
  } catch (error: any) {
    showAppError(error.message || '修改密码失败')
  } finally {
    submitting.value = false
  }
}

const submitUpdateProfile = async () => {
  if (!profileFormRef.value) return
  const valid = await profileFormRef.value.validate().catch(() => false)
  if (!valid) return

  const normalizedUsername = profileForm.username.trim()
  if (!normalizedUsername) {
    showAppWarning('请输入姓名')
    return
  }
  const normalizedMobile = profileForm.mobile.trim()
  const normalizedEmail = profileForm.email.trim().toLowerCase()

  try {
    profileSubmitting.value = true
    await clientAuthStore.updateProfile({
      username: normalizedUsername,
      mobile: normalizedMobile || undefined,
      email: normalizedEmail || undefined,
    })
    showAppSuccess('资料更新成功')
    profileDialogVisible.value = false
  } catch (error: any) {
    showAppError(error.message || '资料更新失败')
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
          <p class="mt-1 text-xs text-slate-400">
            {{ isDepartmentAccount ? '部门账户资料由管理员或教职工目录维护，客户端仅展示身份信息' : '个人账户可维护姓名、手机号与邮箱，后续可用联系方式登录' }}
          </p>
        </div>
        <button
          v-if="!isDepartmentAccount"
          type="button"
          class="profile-action-button"
          @click="openProfileDialog"
        >
          编辑
        </button>
      </div>

      <p class="text-xs text-slate-400">账户类型</p>
      <p class="mt-1 text-base font-semibold text-slate-900">{{ accountTypeLabel }}</p>

      <p class="mt-4 text-xs text-slate-400">姓名</p>
      <p class="mt-1 text-base font-semibold text-slate-900">
        {{ displayName }}
      </p>

      <template v-if="isDepartmentAccount">
        <p class="mt-4 text-xs text-slate-400">教职工号</p>
        <p class="mt-1 text-base font-semibold text-slate-900">{{ displayStaffNo }}</p>

        <p class="mt-4 text-xs text-slate-400">部门</p>
        <p class="mt-1 text-base font-semibold text-slate-900">{{ displayDepartmentName }}</p>
      </template>

      <template v-else>
        <p class="mt-4 text-xs text-slate-400">手机号</p>
        <p class="mt-1 text-base font-semibold text-slate-900">{{ clientAuthStore.currentUser?.mobile || '-' }}</p>

        <p class="mt-4 text-xs text-slate-400">邮箱</p>
        <p class="mt-1 text-base font-semibold text-slate-900">{{ clientAuthStore.currentUser?.email || '-' }}</p>
      </template>
    </div>

    <div class="rounded-[1.2rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
      <div class="flex items-center justify-between">
        <div>
          <p class="text-base font-semibold text-slate-900">修改密码</p>
          <p class="mt-1 text-xs text-slate-400">定期修改密码以保护账号安全</p>
        </div>
        <button
          type="button"
          class="profile-action-button"
          @click="openPasswordDialog"
        >
          修改
        </button>
      </div>
    </div>

    <div class="rounded-[1.2rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
      <div class="flex items-center justify-between gap-3">
        <div>
          <p class="text-base font-semibold text-slate-900">反馈与客服</p>
          <p class="mt-1 text-xs text-slate-400">统一进入反馈会话页，提交 Issue 字段并查看客服处理进度。</p>
        </div>
        <button
          type="button"
          class="profile-action-button"
          @click="router.push('/client/feedback')"
        >
          进入
        </button>
      </div>
    </div>

    <!-- 共享弹窗壳承接轻量表单弹层：
     - 改密与资料编辑都属于短内容 CRUD 场景，统一切到 auto 模式避免继续使用原生弹窗散点宽高配置；
     - 后续若客户端个人中心还要补充更多资料项，可直接沿用同一接入方式。
    -->
    <BizCrudDialogShell
      v-model="passwordDialogVisible"
      title="修改密码"
      height-mode="auto"
      phone-width="94%"
      tablet-width="420px"
      desktop-width="400px"
      :confirm-loading="submitting"
      confirm-text="确认"
      @confirm="submitChangePassword"
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-position="top" @submit.prevent>
        <el-form-item label="原密码" prop="currentPassword">
          <el-input v-model="form.currentPassword" type="password" show-password placeholder="请输入原密码" />
        </el-form-item>
        <el-form-item label="新密码" prop="newPassword">
          <el-input v-model="form.newPassword" type="password" show-password :placeholder="CLIENT_NEW_PASSWORD_PLACEHOLDER" />
        </el-form-item>
        <el-form-item label="确认新密码" prop="confirmPassword">
          <el-input
            v-model="form.confirmPassword"
            type="password"
            show-password
            :placeholder="CLIENT_CONFIRM_NEW_PASSWORD_PLACEHOLDER"
          />
        </el-form-item>
        <p class="mt-1 text-xs leading-6 text-slate-500">{{ CLIENT_NEW_PASSWORD_RULE_HINT }}</p>
      </el-form>
    </BizCrudDialogShell>

    <BizCrudDialogShell
      v-model="profileDialogVisible"
      title="编辑资料"
      height-mode="auto"
      phone-width="94%"
      tablet-width="440px"
      desktop-width="420px"
      :confirm-loading="profileSubmitting"
      confirm-text="保存"
      @confirm="submitUpdateProfile"
    >
      <el-form ref="profileFormRef" :model="profileForm" :rules="profileRules" label-position="top" @submit.prevent>
        <el-form-item label="姓名" prop="username">
          <el-input v-model="profileForm.username" placeholder="请输入真实姓名" />
        </el-form-item>
        <el-form-item label="手机号" prop="mobile">
          <el-input v-model="profileForm.mobile" placeholder="请输入手机号" />
        </el-form-item>
        <el-form-item label="邮箱" prop="email">
          <el-input v-model="profileForm.email" placeholder="请输入邮箱" />
        </el-form-item>
      </el-form>
    </BizCrudDialogShell>
  </section>
</template>

<style scoped>
/*
 * 个人中心右侧操作按钮：
 * - 移动端窄屏下强制保持单行显示，避免“编辑 / 进入 / 修改”被按字换行；
 * - 通过最小宽度与 shrink-0 约束，让卡片正文再窄也不会把按钮挤成竖排。
 */
.profile-action-button {
  display: inline-flex;
  min-width: 4.5rem;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  white-space: nowrap;
  border: 1px solid rgb(226 232 240);
  border-radius: 9999px;
  padding: 0.375rem 1rem;
  font-size: 0.875rem;
  font-weight: 500;
  color: rgb(51 65 85);
  transition:
    background-color 0.18s ease,
    color 0.18s ease,
    transform 0.18s ease;
}

.profile-action-button:hover {
  background: rgb(248 250 252);
  color: rgb(15 23 42);
}
</style>
