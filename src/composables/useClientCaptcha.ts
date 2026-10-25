/**
 * 模块说明：src/composables/useClientCaptcha.ts
 * 文件职责：客户端登录/注册页与找回密码页共用的图形验证码状态，负责拉取、清空、按需准备与到期自动换新。
 * 实现逻辑：
 * - 验证码请求接入 `useStableRequest`，连点刷新或自动刷新与手动刷新并发时只保留最后一次结果；
 * - 图片优先使用后端 PNG data URL，旧服务只返回 SVG 时也编码为图片地址，不走 `v-html` 注入；
 * - 到期换新交给 `useCaptchaAutoRefresh`：验证码未展示时丢弃旧票据，页面提交或发码进行中稍后重试，
 *   其余情况先由页面清空已输入的旧码（`onAutoRefresh`），再静默拉取新图。
 * 维护说明：
 * - 页面卸载时仍需调用 `cancelCaptchaRequest` 与 `clearCaptcha`，与其它请求的取消时机保持一致；
 * - 管理端登录页的验证码有独立的请求序号与密钥流程判定，不复用本文件。
 */
import { computed, reactive, ref } from 'vue'
import { getClientCaptcha } from '@/api/modules/client-auth'
import { useCaptchaAutoRefresh } from '@/composables/useCaptchaAutoRefresh'
import { useStableRequest } from '@/composables/useStableRequest'
import { normalizeRequestError } from '@/utils/error'
import { showAppError, showAppSuccess } from '@/utils/app-alert'

interface ClientCaptchaOptions {
  /** 验证码当前是否展示给用户。 */
  isVisible: () => boolean
  /** 页面是否有提交或发码请求在途。 */
  isBusy: () => boolean
  /** 自动换新前的页面处理，通常是清空表单里已输入的旧验证码。 */
  onAutoRefresh: () => void
}

export const useClientCaptcha = (options: ClientCaptchaOptions) => {
  const { runLatest, cancel: cancelCaptchaRequest } = useStableRequest()
  const captchaLoading = ref(false)
  const captcha = reactive({
    captchaId: '',
    captchaImage: '',
    captchaSvg: '',
  })

  const captchaImageSrc = computed(() => captcha.captchaImage || (captcha.captchaSvg
    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(captcha.captchaSvg)}`
    : ''))

  const refreshCaptcha = async (silent = false) => {
    captchaLoading.value = true
    await runLatest({
      executor: (signal) => getClientCaptcha({ signal }),
      onSuccess: (result) => {
        captcha.captchaId = result.captchaId
        captcha.captchaImage = result.captchaImage ?? ''
        captcha.captchaSvg = result.captchaSvg
        autoRefresh.schedule(result.expiresInSeconds)
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
    captcha.captchaImage = ''
    captcha.captchaSvg = ''
    autoRefresh.cancel()
  }

  const autoRefresh = useCaptchaAutoRefresh({
    countdown: true,
    isVisible: options.isVisible,
    isBusy: options.isBusy,
    onDiscard: clearCaptcha,
    onExpire: () => {
      options.onAutoRefresh()
      void refreshCaptcha(true)
    },
  })

  const ensureCaptchaReady = async () => {
    if (captcha.captchaId && (captcha.captchaImage || captcha.captchaSvg)) {
      return
    }
    await refreshCaptcha(true)
  }

  const handleManualRefreshCaptcha = async () => {
    await refreshCaptcha()
  }

  return {
    captcha,
    captchaLoading,
    captchaImageSrc,
    captchaRemainingSeconds: autoRefresh.remainingSeconds,
    refreshCaptcha,
    clearCaptcha,
    ensureCaptchaReady,
    handleManualRefreshCaptcha,
    cancelCaptchaRequest,
  }
}
