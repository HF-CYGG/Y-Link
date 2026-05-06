<script setup lang="ts">
/**
 * 模块说明：src/views/client/ClientForgotPasswordView.vue
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */


import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { getClientAuthCapabilities, getClientCaptcha, type ClientAuthCapabilities } from '@/api/modules/client-auth'
import { useStableRequest } from '@/composables/useStableRequest'
import { useIdempotentAction } from '@/composables/useIdempotentAction'
import { useClientAuthStore } from '@/store'
import pinia from '@/store/pinia'
import {
  CLIENT_CONFIRM_INPUT_MISMATCH_MESSAGE,
  CLIENT_CONFIRM_NEW_PASSWORD_PLACEHOLDER,
  CLIENT_NEW_PASSWORD_PLACEHOLDER,
  CLIENT_NEW_PASSWORD_RULE_HINT,
  isClientNewPasswordValid,
} from '@/utils/client-password-policy'
import { normalizeRequestError } from '@/utils/error'

const router = useRouter()
const clientAuthStore = useClientAuthStore(pinia)
const { runLatest: runLatestCaptchaRequest, cancel: cancelCaptchaRequest } = useStableRequest()
const { runLatest: runLatestCapabilityRequest, cancel: cancelCapabilityRequest } = useStableRequest()
const { runWithGate } = useIdempotentAction()

const step = ref<1 | 2>(1)
const submitting = ref(false)
const resetToken = ref('')
const securityHint = ref('')
const verificationSending = ref(false)
const verificationCountdown = ref(0)
let verificationTimer: ReturnType<typeof globalThis.setInterval> | null = null
let captchaExpireTimer: ReturnType<typeof globalThis.setInterval> | null = null
const capabilityLoading = ref(false)
const authCapabilities = ref<ClientAuthCapabilities | null>(null)
const captchaLoading = ref(false)
const captcha = reactive({
  captchaId: '',
  captchaSvg: '',
  expiresInSeconds: 0,
})

const verifyForm = reactive({
  account: '',
  captcha: '',
  verificationCode: '',
})

const resetForm = reactive({
  newPassword: '',
  confirmPassword: '',
})

const forgotPasswordAvailable = ref(false)
const passwordStrengthHint = CLIENT_NEW_PASSWORD_RULE_HINT
const captchaHintText = computed(() => {
  if (captcha.expiresInSeconds <= 0) {
    return '发送验证码前请先输入图形验证码，点击图片可立即刷新。'
  }
  return `发送验证码前请先输入图形验证码，约 ${captcha.expiresInSeconds}s 后失效。`
})

const loadAuthCapabilities = async () => {
  capabilityLoading.value = true
  await runLatestCapabilityRequest({
    executor: (signal) => getClientAuthCapabilities({ signal }),
    onSuccess: (result) => {
      authCapabilities.value = result
      forgotPasswordAvailable.value = result.forgotPasswordEnabled
    },
    onError: (error) => {
      const normalizedError = normalizeRequestError(error, '加载找回密码能力失败，请稍后重试')
      ElMessage.error(normalizedError.message)
    },
    onFinally: () => {
      capabilityLoading.value = false
    },
  })
}

const applySecurityHintFromMessage = (message: string) => {
  securityHint.value = /频繁|锁定|稍后|重试/.test(message) ? message : ''
}

const refreshCaptcha = async (silent = false) => {
  captchaLoading.value = true
  await runLatestCaptchaRequest({
    executor: (signal) => getClientCaptcha({ signal }),
    onSuccess: (result) => {
      captcha.captchaId = result.captchaId
      captcha.captchaSvg = result.captchaSvg
      captcha.expiresInSeconds = result.expiresInSeconds
      if (captchaExpireTimer) {
        globalThis.clearInterval(captchaExpireTimer)
      }
      captchaExpireTimer = globalThis.setInterval(() => {
        if (captcha.expiresInSeconds <= 1) {
          captcha.expiresInSeconds = 0
          if (captchaExpireTimer) {
            globalThis.clearInterval(captchaExpireTimer)
            captchaExpireTimer = null
          }
          return
        }
        captcha.expiresInSeconds -= 1
      }, 1000)
      if (!silent) {
        ElMessage.success('已刷新验证码')
      }
    },
    onError: (error) => {
      const normalizedError = normalizeRequestError(error, '验证码刷新失败，请稍后重试')
      if (!silent) {
        ElMessage.error(normalizedError.message)
      }
    },
    onFinally: () => {
      captchaLoading.value = false
    },
  })
}

const clearCaptcha = () => {
  captcha.captchaId = ''
  captcha.captchaSvg = ''
  captcha.expiresInSeconds = 0
  if (captchaExpireTimer) {
    globalThis.clearInterval(captchaExpireTimer)
    captchaExpireTimer = null
  }
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
  if (normalized.includes('@')) {
    return validateAccount(normalized) ? 'email' : null
  }
  return validateAccount(normalized) ? 'mobile' : null
}

const validatePassword = (password: string) => {
  return isClientNewPasswordValid(password)
}

const normalizeInputText = (value: string) => {
  return value.replaceAll(/\s+/g, ' ').trim()
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
  if (!captcha.captchaId || !verifyForm.captcha.trim()) {
    ElMessage.warning('发送验证码前请先输入图形验证码')
    await refreshCaptcha(true)
    return
  }
  const runResult = await runWithGate({
    actionKey: 'client-forgot-password-send-verification-code',
    onDuplicated: () => {
      ElMessage.info('验证码发送中，请勿重复点击')
    },
    executor: async () => {
      verificationSending.value = true
      try {
        const result = await clientAuthStore.sendVerificationCode({
          channel,
          target: normalizeInputText(verifyForm.account),
          scene: 'forgot_password',
          captchaId: captcha.captchaId,
          captchaCode: normalizeInputText(verifyForm.captcha),
        })
        ElMessage.success(`${channel === 'email' ? '邮箱' : '手机'}验证码已发送`)
        verifyForm.captcha = ''
        await refreshCaptcha(true)
        startVerificationCountdown(result.expireSeconds)
      } catch (error) {
        const normalizedError = normalizeRequestError(error, '验证码发送失败，请稍后重试')
        applySecurityHintFromMessage(normalizedError.message)
        ElMessage.error(normalizedError.message)
        verifyForm.captcha = ''
        await refreshCaptcha(true)
      } finally {
        verificationSending.value = false
      }
    },
  })
  if (runResult === null) {
    return
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

  const runResult = await runWithGate({
    actionKey: 'client-forgot-password-verify',
    onDuplicated: () => {
      ElMessage.info('身份校验中，请勿重复提交')
    },
    executor: async () => {
      submitting.value = true
      try {
        const result = await clientAuthStore.requestPasswordResetToken({
          account: normalizeInputText(verifyForm.account),
          verificationCode: normalizeInputText(verifyForm.verificationCode),
        })
        resetToken.value = result.resetToken
        step.value = 2
        ElMessage.success('身份校验通过，请设置新密码')
      } catch (error) {
        const normalizedError = normalizeRequestError(error, '身份校验失败，请稍后重试')
        applySecurityHintFromMessage(normalizedError.message)
        ElMessage.error(normalizedError.message)
      } finally {
        submitting.value = false
      }
    },
  })
  if (runResult === null) {
    return
  }
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const handleReset = async () => {
  if (!resetToken.value.trim()) {
    ElMessage.warning('身份校验凭证已失效，请重新验证账号')
    step.value = 1
    return
  }
  if (!validatePassword(resetForm.newPassword)) {
    ElMessage.warning(passwordStrengthHint)
    return
  }
  if (resetForm.newPassword !== resetForm.confirmPassword) {
    ElMessage.warning(CLIENT_CONFIRM_INPUT_MISMATCH_MESSAGE)
    return
  }

  const runResult = await runWithGate({
    actionKey: 'client-forgot-password-reset',
    onDuplicated: () => {
      ElMessage.info('重置请求处理中，请勿重复提交')
    },
    executor: async () => {
      submitting.value = true
      try {
        await clientAuthStore.confirmPasswordReset({
          account: normalizeInputText(verifyForm.account),
          resetToken: resetToken.value,
          newPassword: resetForm.newPassword,
        })
        ElMessage.success('密码已重置，请重新登录')
        await router.replace('/client/login')
      } catch (error) {
        const normalizedError = normalizeRequestError(error, '重置密码失败，请稍后重试')
        applySecurityHintFromMessage(normalizedError.message)
        ElMessage.error(normalizedError.message)
      } finally {
        submitting.value = false
      }
    },
  })
  if (runResult === null) {
    return
  }
}

onMounted(async () => {
  await Promise.allSettled([loadAuthCapabilities(), refreshCaptcha(true)])
})

onUnmounted(() => {
  cancelCapabilityRequest()
  cancelCaptchaRequest()
  resetVerificationTimer()
  clearCaptcha()
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
          <input v-model.trim="verifyForm.captcha" class="client-input" placeholder="先输入图形验证码，再发送手机/邮箱验证码" />
          <button type="button" class="captcha-image-box" :disabled="captchaLoading" @click="refreshCaptcha()">
            <span v-if="captchaLoading" class="text-xs text-slate-500">刷新中</span>
            <span v-else class="captcha-render" v-html="captcha.captchaSvg"></span>
          </button>
        </div>
        <p class="text-xs leading-6 text-slate-500">{{ captchaHintText }}</p>
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
        <input v-model="resetForm.newPassword" class="client-input" type="password" :placeholder="CLIENT_NEW_PASSWORD_PLACEHOLDER" />
        <input
          v-model="resetForm.confirmPassword"
          class="client-input"
          type="password"
          :placeholder="CLIENT_CONFIRM_NEW_PASSWORD_PLACEHOLDER"
        />
        <p class="text-xs leading-6 text-slate-500">{{ passwordStrengthHint }}</p>
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

.captcha-image-box {
  width: 7.5rem;
  min-height: 3.5rem;
  border-radius: 1rem;
  border: 1px dashed rgb(203 213 225);
  background: white;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.captcha-render :deep(svg) {
  width: 100px;
  height: 36px;
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
