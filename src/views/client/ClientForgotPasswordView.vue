<script setup lang="ts">
/**
 * 模块说明：src/views/client/ClientForgotPasswordView.vue
 * 文件职责：客户端找回密码页，负责能力探测、验证码发送、身份校验与新密码重置。
 * 实现逻辑：
 * - 首屏先渲染标题与主流程骨架，再延后补齐“是否支持自助找回”的能力配置；
 * - 验证码、身份校验、重置密码均接入“重复提交门禁 + 可取消旧请求”双保险；
 * - 错误提示、加载态与弱网回退统一走同一套提示口径，避免用户误判当前状态。
 * 维护说明：
 * - 若后续扩展找回方式，请同步检查 `forgotPasswordAvailable`、验证码表单与接口入参；
 * - 若修改页面文案，请保持与登录/注册页的安全提示口径一致。
 */

import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { Key, Lock, Message, User } from '@element-plus/icons-vue'
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
import { showCriticalErrorDialog } from '@/utils/error-dialog'

import { showAppError, showAppInfo, showAppSuccess, showAppWarning } from '@/utils/app-alert'

const route = useRoute()
const router = useRouter()
const clientAuthStore = useClientAuthStore(pinia)
const { runLatest: runLatestCaptchaRequest, cancel: cancelCaptchaRequest } = useStableRequest()
const { runLatest: runLatestCapabilityRequest, cancel: cancelCapabilityRequest } = useStableRequest()
const { runLatest: runLatestVerificationCodeRequest, cancel: cancelVerificationCodeRequest } = useStableRequest()
const { runLatest: runLatestVerifyRequest, cancel: cancelVerifyRequest } = useStableRequest()
const { runLatest: runLatestResetRequest, cancel: cancelResetRequest } = useStableRequest()
const { runWithGate } = useIdempotentAction()

const step = ref<1 | 2>(1)
const submitting = ref(false)
const resetToken = ref('')
const securityHint = ref('')
const verificationSending = ref(false)
const verificationCountdown = ref(0)
const capabilityLoading = ref(false)
const capabilityErrorMessage = ref('')
const authCapabilities = ref<ClientAuthCapabilities | null>(null)
const captchaLoading = ref(false)
const captcha = reactive({
  captchaId: '',
  captchaSvg: '',
  expiresInSeconds: 0,
})
let verificationTimer: ReturnType<typeof globalThis.setInterval> | null = null
let captchaExpireTimer: ReturnType<typeof globalThis.setInterval> | null = null
let capabilityDeferredTimer: ReturnType<typeof globalThis.setTimeout> | null = null

const verifyForm = reactive({
  account: '',
  captcha: '',
  verificationCode: '',
})

const resetForm = reactive({
  newPassword: '',
  confirmPassword: '',
})

const forgotPasswordAvailable = computed(() => authCapabilities.value?.forgotPasswordEnabled ?? false)
const isCapabilityHintVisible = computed(() => capabilityLoading.value && !authCapabilities.value)
const isCapabilityFallbackVisible = computed(() => !capabilityLoading.value && !!capabilityErrorMessage.value && !authCapabilities.value)
const shouldPrepareCaptcha = computed(() => step.value === 1 && forgotPasswordAvailable.value)
const passwordStrengthHint = CLIENT_NEW_PASSWORD_RULE_HINT

// 安全说明：验证码接口返回的是 SVG 文本，
// 这里统一编码成 data URL 图片，避免使用 v-html 直接注入 SVG 片段。
const captchaImageSrc = computed(() => {
  return captcha.captchaSvg
    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(captcha.captchaSvg)}`
    : ''
})

const captchaHintText = computed(() => {
  if (captcha.expiresInSeconds <= 0) {
    return '发送验证码前请先输入图形验证码，点击右侧图片可立即刷新。'
  }
  return `发送验证码前请先输入图形验证码，约 ${captcha.expiresInSeconds}s 后失效。`
})

const loadAuthCapabilities = async (options: { silent?: boolean } = {}) => {
  capabilityLoading.value = true
  capabilityErrorMessage.value = ''
  await runLatestCapabilityRequest({
    executor: (signal) => getClientAuthCapabilities({ signal }),
    onSuccess: (result) => {
      authCapabilities.value = result
      capabilityErrorMessage.value = ''
    },
    onError: (error) => {
      const normalizedError = normalizeRequestError(error, '加载找回密码能力失败，请稍后重试')
      capabilityErrorMessage.value = normalizedError.message
      if (!options.silent) {
        showAppError(normalizedError.message)
      }
    },
    onFinally: () => {
      capabilityLoading.value = false
    },
  })
}

const scheduleDeferredCapabilityLoad = () => {
  if (authCapabilities.value || capabilityLoading.value) {
    return
  }
  if (capabilityDeferredTimer) {
    globalThis.clearTimeout(capabilityDeferredTimer)
  }
  // 首屏先渲染标题与主流程框架，再在下一帧补能力配置，减少弱网下的空白等待。
  capabilityDeferredTimer = globalThis.setTimeout(() => {
    capabilityDeferredTimer = null
    void loadAuthCapabilities({ silent: true })
  }, 0)
}

const handleRetryLoadAuthCapabilities = async () => {
  await loadAuthCapabilities()
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
        showAppSuccess('已刷新验证码')
      }
    },
    onError: (error) => {
      const normalizedError = normalizeRequestError(error, '验证码刷新失败，请稍后重试')
      if (!silent) {
        showAppError(normalizedError.message)
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

const ensureCaptchaReady = async () => {
  if (captcha.captchaId && captcha.captchaSvg) {
    return
  }
  await refreshCaptcha(true)
}

const handleManualRefreshCaptcha = async () => {
  await refreshCaptcha()
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
    showAppWarning('请输入正确的手机号或邮箱')
    return
  }
  if (!captcha.captchaId || !verifyForm.captcha.trim()) {
    showAppWarning('发送验证码前请先输入图形验证码')
    await ensureCaptchaReady()
    return
  }
  const runResult = await runWithGate({
    actionKey: 'client-forgot-password-send-verification-code',
    onDuplicated: () => {
      showAppInfo('验证码发送中，请勿重复点击')
    },
    executor: async () => {
      verificationSending.value = true
      securityHint.value = ''
      await runLatestVerificationCodeRequest({
        executor: (signal) =>
          clientAuthStore.sendVerificationCode(
            {
              channel,
              target: normalizeInputText(verifyForm.account),
              scene: 'forgot_password',
              captchaId: captcha.captchaId,
              captchaCode: normalizeInputText(verifyForm.captcha),
            },
            { signal },
          ),
        onSuccess: async (result) => {
          showAppSuccess(`${channel === 'email' ? '邮箱' : '手机'}验证码已发送`)
          verifyForm.captcha = ''
          await refreshCaptcha(true)
          startVerificationCountdown(result.expireSeconds)
        },
        onError: async (error) => {
          const normalizedError = normalizeRequestError(error, '验证码发送失败，请稍后重试')
          applySecurityHintFromMessage(normalizedError.message)
          showAppError(normalizedError.message)
          verifyForm.captcha = ''
          await refreshCaptcha(true)
        },
        onFinally: () => {
          verificationSending.value = false
        },
      })
    },
  })
  if (runResult === null) {
    return
  }
}

const handleVerify = async () => {
  if (!forgotPasswordAvailable.value) {
    showAppWarning('当前系统未同时启用手机与邮箱验证码，请联系管理员手动修改密码')
    return
  }
  if (!validateAccount(verifyForm.account)) {
    showAppWarning('请输入正确的手机号或邮箱')
    return
  }
  if (!verifyForm.verificationCode.trim()) {
    showAppWarning('请输入手机/邮箱验证码')
    return
  }

  const runResult = await runWithGate({
    actionKey: 'client-forgot-password-verify',
    onDuplicated: () => {
      showAppInfo('身份校验中，请勿重复提交')
    },
    executor: async () => {
      submitting.value = true
      securityHint.value = ''
      await runLatestVerifyRequest({
        executor: (signal) =>
          clientAuthStore.requestPasswordResetToken(
            {
              account: normalizeInputText(verifyForm.account),
              verificationCode: normalizeInputText(verifyForm.verificationCode),
            },
            { signal },
          ),
        onSuccess: async (result) => {
          resetToken.value = result.resetToken
          step.value = 2
          showAppSuccess('身份校验通过，请设置新密码')
          await refreshCaptcha(true)
        },
        onError: (error) => {
          const normalizedError = normalizeRequestError(error, '身份校验失败，请稍后重试')
          applySecurityHintFromMessage(normalizedError.message)
          showAppError(normalizedError.message)
        },
        onFinally: () => {
          submitting.value = false
        },
      })
    },
  })
  if (runResult === null) {
    return
  }
}

const handleReset = async () => {
  if (!resetToken.value.trim()) {
    showAppWarning('身份校验凭证已失效，请重新验证账号')
    step.value = 1
    return
  }
  if (!validatePassword(resetForm.newPassword)) {
    showAppWarning(passwordStrengthHint)
    return
  }
  if (resetForm.newPassword !== resetForm.confirmPassword) {
    showAppWarning(CLIENT_CONFIRM_INPUT_MISMATCH_MESSAGE)
    return
  }

  const runResult = await runWithGate({
    actionKey: 'client-forgot-password-reset',
    onDuplicated: () => {
      showAppInfo('重置请求处理中，请勿重复提交')
    },
    executor: async () => {
      submitting.value = true
      securityHint.value = ''
      await runLatestResetRequest({
        executor: (signal) =>
          clientAuthStore.confirmPasswordReset(
            {
              account: normalizeInputText(verifyForm.account),
              resetToken: resetToken.value,
              newPassword: resetForm.newPassword,
            },
            { signal },
          ),
        onSuccess: async () => {
          showAppSuccess('密码已重置，请重新登录')
          await router.replace('/client/login')
        },
        onError: (error) => {
          const normalizedError = normalizeRequestError(error, '重置密码失败，请稍后重试')
          applySecurityHintFromMessage(normalizedError.message)
          void showCriticalErrorDialog(normalizedError, {
            title: '重置密码失败',
            fallback: '重置密码失败，请稍后重试',
            operation: '客户端找回密码',
          })
        },
        onFinally: () => {
          submitting.value = false
        },
      })
    },
  })
  if (runResult === null) {
    return
  }
}

watch(shouldPrepareCaptcha, (shouldLoadCaptcha) => {
  if (shouldLoadCaptcha) {
    void ensureCaptchaReady()
  }
})

onMounted(() => {
  const routeAccount = typeof route.query.account === 'string' ? route.query.account.trim() : ''
  if (routeAccount) {
    verifyForm.account = routeAccount
  }
  scheduleDeferredCapabilityLoad()
})

onUnmounted(() => {
  cancelCapabilityRequest()
  cancelCaptchaRequest()
  cancelVerificationCodeRequest()
  cancelVerifyRequest()
  cancelResetRequest()
  if (capabilityDeferredTimer) {
    globalThis.clearTimeout(capabilityDeferredTimer)
    capabilityDeferredTimer = null
  }
  resetVerificationTimer()
  clearCaptcha()
})
</script>

<template>
  <div class="forgot-password-page">
    <div class="forgot-password-card">
      <div class="forgot-password-header">
        <p class="forgot-password-title">找回密码</p>
        <p class="forgot-password-desc">仅在系统同时启用手机与邮箱验证码时支持自助找回。</p>
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
        v-if="isCapabilityHintVisible"
        class="mb-4"
        type="info"
        :closable="false"
        show-icon
        title="正在确认找回密码能力，基础页面已渲染完成，请稍候。"
      />
      <el-alert v-else-if="isCapabilityFallbackVisible" class="mb-4" type="warning" :closable="false" show-icon>
        <template #title>找回密码能力加载较慢，请重新加载后再继续。</template>
        <template #default>
          <div class="capability-alert__content">
            <span>{{ capabilityErrorMessage }}</span>
            <el-button link type="primary" @click="handleRetryLoadAuthCapabilities">重新加载</el-button>
          </div>
        </template>
      </el-alert>
      <el-alert
        v-else-if="authCapabilities && !forgotPasswordAvailable"
        class="mb-4"
        type="warning"
        :closable="false"
        show-icon
        title="当前系统未同时启用手机与邮箱验证码，暂不支持自助找回密码，请联系管理员手动修改密码。"
      />

      <div class="step-badges">
        <span class="step-badge" :class="{ 'step-badge--active': step === 1 }">1. 身份验证</span>
        <span class="step-badge" :class="{ 'step-badge--active': step === 2 }">2. 重置密码</span>
      </div>

      <div v-if="step === 1">
        <div v-if="isCapabilityHintVisible" class="loading-placeholder">
          <el-skeleton animated :rows="5" />
        </div>

        <el-form v-else-if="forgotPasswordAvailable" class="space-y-4" @submit.prevent="handleVerify">
          <el-input v-model="verifyForm.account" placeholder="请输入手机号或邮箱" class="geo-input" size="large" clearable>
            <template #prefix>
              <el-icon class="input-icon"><User /></el-icon>
            </template>
          </el-input>

          <div class="captcha-row">
            <el-input
              v-model="verifyForm.captcha"
              placeholder="先输入图形验证码，再发送手机/邮箱验证码"
              class="geo-input flex-1"
              size="large"
              clearable
            >
              <template #prefix>
                <el-icon class="input-icon"><Key /></el-icon>
              </template>
            </el-input>
            <button type="button" class="captcha-image-box" :disabled="captchaLoading" @click="handleManualRefreshCaptcha">
              <span v-if="captchaLoading" class="captcha-loading">刷新中</span>
              <img
                v-else
                class="captcha-render"
                :src="captchaImageSrc"
                alt="图形验证码"
                draggable="false"
              />
            </button>
          </div>
          <p class="hint-text">{{ captchaHintText }}</p>

          <div class="captcha-row">
            <el-input v-model="verifyForm.verificationCode" placeholder="请输入手机/邮箱验证码" class="geo-input flex-1" size="large" clearable>
              <template #prefix>
                <el-icon class="input-icon"><Message /></el-icon>
              </template>
            </el-input>
            <el-button
              class="verification-button"
              :loading="verificationSending"
              :disabled="verificationCountdown > 0"
              @click="handleSendVerificationCode"
            >
              {{ verificationCountdown > 0 ? `${verificationCountdown}s 后重发` : '发送验证码' }}
            </el-button>
          </div>

          <el-button class="submit-button" native-type="submit" :loading="submitting">下一步</el-button>
        </el-form>

        <div v-else class="empty-state-card">
          <p class="empty-state-title">暂不可自助找回</p>
          <p class="empty-state-desc">请联系管理员手动修改密码，或稍后重新加载能力配置确认状态。</p>
          <el-button plain @click="handleRetryLoadAuthCapabilities">重新加载</el-button>
        </div>
      </div>

      <el-form v-else class="space-y-4" @submit.prevent="handleReset">
        <el-input
          v-model="resetForm.newPassword"
          :placeholder="CLIENT_NEW_PASSWORD_PLACEHOLDER"
          type="password"
          class="geo-input"
          size="large"
          show-password
        >
          <template #prefix>
            <el-icon class="input-icon"><Lock /></el-icon>
          </template>
        </el-input>
        <el-input
          v-model="resetForm.confirmPassword"
          :placeholder="CLIENT_CONFIRM_NEW_PASSWORD_PLACEHOLDER"
          type="password"
          class="geo-input"
          size="large"
          show-password
        >
          <template #prefix>
            <el-icon class="input-icon"><Lock /></el-icon>
          </template>
        </el-input>
        <p class="hint-text">{{ passwordStrengthHint }}</p>
        <el-button class="submit-button" native-type="submit" :loading="submitting">确认重置密码</el-button>
      </el-form>

      <el-button link type="primary" class="mt-4" @click="router.replace('/client/login')">返回客户端登录</el-button>
    </div>
  </div>
</template>

<style scoped>
.forgot-password-page {
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f8fafc;
  padding: 24px 16px;
}

.forgot-password-card {
  width: 100%;
  max-width: 460px;
  border-radius: 32px;
  background: #ffffff;
  padding: 32px 28px;
  box-shadow: 0 20px 60px rgba(15, 23, 42, 0.08);
}

.forgot-password-header {
  margin-bottom: 24px;
}

.forgot-password-title {
  font-size: 28px;
  line-height: 1.2;
  font-weight: 700;
  color: #0f172a;
}

.forgot-password-desc {
  margin-top: 10px;
  font-size: 14px;
  line-height: 1.7;
  color: #64748b;
}

.step-badges {
  display: flex;
  gap: 10px;
  margin-bottom: 20px;
}

.step-badge {
  border-radius: 999px;
  background: #f1f5f9;
  color: #475569;
  padding: 8px 14px;
  font-size: 13px;
  line-height: 1;
  font-weight: 600;
}

.step-badge--active {
  background: #0f172a;
  color: #ffffff;
}

.loading-placeholder {
  border-radius: 24px;
  background: #f8fafc;
  padding: 20px 18px;
}

.geo-input :deep(.el-input__wrapper) {
  height: 52px;
  border-radius: 14px;
  background-color: #f8fafc;
  border: 1px solid transparent;
  box-shadow: none !important;
  padding: 0 16px;
  transition:
    background-color var(--ylink-motion-normal) var(--ylink-motion-ease),
    border-color var(--ylink-motion-normal) var(--ylink-motion-ease),
    box-shadow var(--ylink-motion-normal) var(--ylink-motion-ease);
}

.geo-input :deep(.el-input__wrapper:hover) {
  background-color: #f1f5f9;
}

.geo-input :deep(.el-input__wrapper.is-focus) {
  background-color: #ffffff;
  border-color: #0d9488;
  box-shadow: 0 0 0 3px rgba(13, 148, 136, 0.1) !important;
}

.geo-input :deep(.el-input__inner) {
  color: #0f172a;
  font-size: 14px;
  font-weight: 500;
}

.input-icon {
  font-size: 18px;
  color: #94a3b8;
}

.geo-input :deep(.el-input__wrapper.is-focus .input-icon) {
  color: #0d9488;
}

.captcha-row {
  display: flex;
  gap: 12px;
}

.captcha-image-box {
  width: 120px;
  height: 52px;
  border-radius: 14px;
  border: 1px dashed #cbd5e1;
  background: #ffffff;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  transition: background 0.2s, transform 0.2s;
}

.captcha-image-box:hover {
  background: #f8fafc;
  transform: translateY(-1px);
}

.captcha-image-box:disabled {
  cursor: wait;
  transform: none;
}

.captcha-loading {
  font-size: 12px;
  color: #64748b;
}

.captcha-render {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100px;
  height: 36px;
  object-fit: contain;
}

.hint-text {
  margin-top: -6px;
  font-size: 12px;
  line-height: 1.6;
  color: #64748b;
}

.verification-button {
  min-width: 124px;
  border-radius: 14px;
}

.submit-button {
  width: 100%;
  height: 52px;
  border-radius: 14px !important;
  background-color: #0f766e !important;
  border: none !important;
  color: #ffffff !important;
  font-size: 15px !important;
  font-weight: 600 !important;
}

.empty-state-card {
  border-radius: 24px;
  background: #f8fafc;
  padding: 24px 20px;
}

.empty-state-title {
  font-size: 16px;
  font-weight: 700;
  color: #0f172a;
}

.empty-state-desc {
  margin: 8px 0 16px;
  font-size: 13px;
  line-height: 1.7;
  color: #64748b;
}

.capability-alert__content {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  line-height: 1.6;
}

@media (max-width: 640px) {
  .forgot-password-card {
    padding: 28px 20px;
    border-radius: 28px;
  }

  .captcha-row {
    flex-direction: column;
  }

  .captcha-image-box,
  .verification-button {
    width: 100%;
  }
}
</style>
