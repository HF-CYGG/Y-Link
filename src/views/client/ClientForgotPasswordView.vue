<script setup lang="ts">
/**
 * 模块说明：src/views/client/ClientForgotPasswordView.vue
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */


import { onMounted, onUnmounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { getClientAuthCapabilities, type ClientAuthCapabilities } from '@/api/modules/client-auth'
import { useClientAuthStore } from '@/store'
import { extractErrorMessage } from '@/utils/error'

const router = useRouter()
const clientAuthStore = useClientAuthStore()

const step = ref<1 | 2>(1)
const submitting = ref(false)
const resetToken = ref('')
const securityHint = ref('')
const verificationSending = ref(false)
const verificationCountdown = ref(0)
let verificationTimer: ReturnType<typeof globalThis.setInterval> | null = null
const capabilityLoading = ref(false)
const authCapabilities = ref<ClientAuthCapabilities | null>(null)

const verifyForm = reactive({
  account: '',
  verificationCode: '',
})

const resetForm = reactive({
  newPassword: '',
  confirmPassword: '',
})

const forgotPasswordAvailable = ref(false)

const loadAuthCapabilities = async () => {
  capabilityLoading.value = true
  try {
    const result = await getClientAuthCapabilities()
    authCapabilities.value = result
    forgotPasswordAvailable.value = result.forgotPasswordEnabled
  } finally {
    capabilityLoading.value = false
  }
}

const applySecurityHintFromMessage = (message: string) => {
  securityHint.value = /频繁|锁定|稍后|重试/.test(message) ? message : ''
}

const validateAccount = (account: string) => {
  const normalized = account.trim()
  if (!normalized) {
    return false
  }
  if (normalized.includes('@')) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
  }
  return /^1\d{10}$/.test(normalized)
}

const resolveChannel = (account: string): 'mobile' | 'email' | null => {
  const normalized = account.trim()
  if (!normalized) {
    return null
  }
  return normalized.includes('@') ? (validateAccount(normalized) ? 'email' : null) : (validateAccount(normalized) ? 'mobile' : null)
}

const resetVerificationTimer = () => {
  if (verificationTimer) {
    globalThis.clearInterval(verificationTimer)
    verificationTimer = null
  }
  verificationCountdown.value = 0
}

const startVerificationCountdown = (seconds: number) => {
  resetVerificationTimer()
  verificationCountdown.value = seconds
  verificationTimer = globalThis.setInterval(() => {
    if (verificationCountdown.value <= 1) {
      resetVerificationTimer()
      return
    }
    verificationCountdown.value -= 1
  }, 1000)
}

const handleSendVerificationCode = async () => {
  const channel = resolveChannel(verifyForm.account)
  if (!channel) {
    ElMessage.warning('请输入正确的用户名（手机号或邮箱）')
    return
  }
  verificationSending.value = true
  try {
    const result = await clientAuthStore.sendVerificationCode({
      channel,
      target: verifyForm.account.trim(),
      scene: 'forgot_password',
    })
    ElMessage.success(`${channel === 'email' ? '邮箱' : '手机'}验证码已发送`)
    startVerificationCountdown(result.expireSeconds)
  } catch (error) {
    const message = extractErrorMessage(error, '验证码发送失败，请稍后重试')
    applySecurityHintFromMessage(message)
    ElMessage.error(message)
  } finally {
    verificationSending.value = false
  }
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const handleVerify = async () => {
  if (!forgotPasswordAvailable.value) {
    ElMessage.warning('当前系统未同时启用手机与邮箱验证码，请联系管理员手动修改密码')
    return
  }
  if (!validateAccount(verifyForm.account)) {
    ElMessage.warning('请输入正确的用户名（手机号或邮箱）')
    return
  }
  if (!verifyForm.verificationCode.trim()) {
    ElMessage.warning('请输入手机/邮箱验证码')
    return
  }

  submitting.value = true
  try {
    const result = await clientAuthStore.requestPasswordResetToken({
      account: verifyForm.account.trim(),
      verificationCode: verifyForm.verificationCode.trim(),
    })
    resetToken.value = result.resetToken
    step.value = 2
    ElMessage.success('身份校验通过，请设置新密码')
  } catch (error) {
    const message = extractErrorMessage(error, '身份校验失败，请稍后重试')
    applySecurityHintFromMessage(message)
    ElMessage.error(message)
  } finally {
    submitting.value = false
  }
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const handleReset = async () => {
  if (resetForm.newPassword.trim().length < 6) {
    ElMessage.warning('新密码至少 6 位')
    return
  }
  if (resetForm.newPassword !== resetForm.confirmPassword) {
    ElMessage.warning('两次输入的新密码不一致')
    return
  }

  submitting.value = true
  try {
    await clientAuthStore.confirmPasswordReset({
      account: verifyForm.account.trim(),
      resetToken: resetToken.value,
      newPassword: resetForm.newPassword,
    })
    ElMessage.success('密码已重置，请重新登录')
    await router.replace('/client/login')
  } catch (error) {
    const message = extractErrorMessage(error, '重置密码失败，请稍后重试')
    applySecurityHintFromMessage(message)
    ElMessage.error(message)
  } finally {
    submitting.value = false
  }
}

onMounted(async () => {
  await loadAuthCapabilities()
})

onUnmounted(() => {
  resetVerificationTimer()
})
</script>

<template>
  <div class="min-h-[100dvh] bg-slate-50 px-4 py-8">
    <div class="mx-auto max-w-md rounded-[2rem] bg-white p-6 shadow-[0_20px_60px_rgba(15,23,42,0.08)]">
      <div class="mb-6">
        <p class="text-2xl font-semibold text-slate-900">找回密码</p>
        <p class="mt-2 text-sm text-slate-500">仅在系统同时启用手机与邮箱验证码时支持自助找回</p>
      </div>

      <el-alert
        v-if="securityHint"
        class="mb-4"
        type="warning"
        :closable="false"
        show-icon
        :title="securityHint"
      />

      <el-alert
        v-if="!capabilityLoading && !forgotPasswordAvailable"
        class="mb-4"
        type="warning"
        :closable="false"
        show-icon
        title="当前系统未同时启用手机与邮箱验证码，暂不支持自助找回密码，请联系管理员手动修改密码。"
      />

      <div class="mb-6 flex items-center gap-3 text-sm">
        <span class="rounded-full px-3 py-1" :class="step === 1 ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-400'">
          1. 身份验证
        </span>
        <span class="rounded-full px-3 py-1" :class="step === 2 ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-400'">
          2. 重置密码
        </span>
      </div>

      <form v-if="step === 1 && forgotPasswordAvailable" class="space-y-4" @submit.prevent="handleVerify">
        <input v-model.trim="verifyForm.account" class="client-input" placeholder="请输入用户名（手机号或邮箱）" />
        <div class="grid grid-cols-[1fr_auto] gap-3">
          <input v-model.trim="verifyForm.verificationCode" class="client-input" placeholder="请输入手机/邮箱验证码" />
          <button type="button" class="captcha-box" :disabled="verificationSending || verificationCountdown > 0" @click="handleSendVerificationCode">
            <span class="text-xs text-slate-500">
              {{ verificationCountdown > 0 ? `${verificationCountdown}s 后重发` : verificationSending ? '发送中' : '发送验证码' }}
            </span>
          </button>
        </div>
        <button class="client-submit" type="submit" :disabled="submitting">
          {{ submitting ? '校验中...' : '下一步' }}
        </button>
      </form>

      <form v-else-if="step === 2" class="space-y-4" @submit.prevent="handleReset">
        <input v-model="resetForm.newPassword" class="client-input" type="password" placeholder="请输入新密码" />
        <input v-model="resetForm.confirmPassword" class="client-input" type="password" placeholder="请再次输入新密码" />
        <button class="client-submit" type="submit" :disabled="submitting">
          {{ submitting ? '提交中...' : '确认重置密码' }}
        </button>
      </form>

      <button type="button" class="mt-4 text-sm font-medium text-brand" @click="router.replace('/client/login')">
        返回客户端登录
      </button>
    </div>
  </div>
</template>

<style scoped>
.client-input {
  width: 100%;
  border-radius: 1rem;
  border: 1px solid rgb(226 232 240);
  background: rgb(248 250 252);
  padding: 0.95rem 1rem;
  color: rgb(15 23 42);
  outline: none;
}

.captcha-box {
  min-width: 7.5rem;
  border-radius: 1rem;
  border: 1px solid rgb(226 232 240);
  background: white;
  padding: 0 0.75rem;
}

.client-submit {
  width: 100%;
  border-radius: 999px;
  background: rgb(15 23 42);
  padding: 0.95rem 1rem;
  color: white;
  font-weight: 600;
}
</style>
