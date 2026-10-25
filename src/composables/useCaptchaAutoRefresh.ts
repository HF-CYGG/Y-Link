/**
 * 模块说明：src/composables/useCaptchaAutoRefresh.ts
 * 文件职责：为登录页图形验证码提供“到期前自动换新”的计时能力，避免用户输入已失效的验证码后才收到报错。
 * 实现逻辑：
 * - 每次拿到新验证码后按服务端 `expiresInSeconds` 换算绝对截止时间，提前 `leadSeconds` 秒触发刷新，
 *   不再逐秒递减计数，后台标签页定时器被节流时也不会算错剩余时间；
 * - 到点时页面若处于隐藏状态，先记下待刷新，等页面重新可见再刷新，避免后台无意义地拉取验证码；
 *   页面重新可见时若已越过刷新时间点（定时器被节流延后），立即补做刷新；
 * - 可选的 `remainingSeconds` 每秒按截止时间重新计算，供页面展示“约 N 秒后自动更换”提示；
 * - 所在作用域销毁时自动清理定时器与 `visibilitychange` 监听。
 * 维护说明：
 * - 只有刷新成功后由页面再次调用 `schedule` 才会进入下一轮，刷新失败不会自动重试，避免接口异常时反复弹错；
 * - 刷新回调由页面提供，是否清空已输入的验证码由页面决定；提交进行中不宜刷新时，页面调用 `retryAfter`
 *   稍后重试，而不是直接放弃本轮，避免提交失败分支没有换新时验证码停留在已失效状态。
 */
import { getCurrentScope, onScopeDispose, ref } from 'vue'

interface CaptchaAutoRefreshOptions {
  /** 到期时执行的刷新动作，由页面决定拉取哪个作用域的验证码以及是否清空输入。 */
  onExpire: () => void
  /** 提前多少秒刷新，给用户提交和网络往返留出余量。 */
  leadSeconds?: number
  /** 是否每秒更新 `remainingSeconds`，只在页面需要展示倒计时提示时开启。 */
  countdown?: boolean
}

export const useCaptchaAutoRefresh = (options: CaptchaAutoRefreshOptions) => {
  const leadMs = Math.max(0, options.leadSeconds ?? 3) * 1000
  const remainingSeconds = ref(0)
  let refreshAt = 0
  let expireTimer: ReturnType<typeof globalThis.setTimeout> | null = null
  let countdownTimer: ReturnType<typeof globalThis.setInterval> | null = null
  let pendingUntilVisible = false
  let listening = false

  const isPageHidden = () => typeof document !== 'undefined' && document.hidden

  const updateRemaining = () => {
    remainingSeconds.value = refreshAt ? Math.max(0, Math.ceil((refreshAt - Date.now()) / 1000)) : 0
  }

  const clearTimers = () => {
    if (expireTimer) globalThis.clearTimeout(expireTimer)
    if (countdownTimer) globalThis.clearInterval(countdownTimer)
    expireTimer = null
    countdownTimer = null
  }

  const stopListening = () => {
    if (!listening) return
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    listening = false
  }

  const cancel = () => {
    clearTimers()
    stopListening()
    refreshAt = 0
    pendingUntilVisible = false
    remainingSeconds.value = 0
  }

  const expire = () => {
    cancel()
    options.onExpire()
  }

  function handleVisibilityChange() {
    if (isPageHidden() || !refreshAt) return
    if (pendingUntilVisible || Date.now() >= refreshAt) {
      expire()
      return
    }
    updateRemaining()
  }

  const handleTimeout = () => {
    expireTimer = null
    if (isPageHidden()) {
      pendingUntilVisible = true
      if (countdownTimer) globalThis.clearInterval(countdownTimer)
      countdownTimer = null
      remainingSeconds.value = 0
      return
    }
    expire()
  }

  /** 新验证码到手后调用：按服务端有效期安排下一次自动刷新，并替换上一轮计时。 */
  const schedule = (expiresInSeconds: number) => {
    cancel()
    if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) return
    const now = Date.now()
    // 有效期过短时至少保留一半时间给用户，避免刚拿到就被立即换掉。
    const lead = Math.min(leadMs, (expiresInSeconds * 1000) / 2)
    refreshAt = now + expiresInSeconds * 1000 - lead
    expireTimer = globalThis.setTimeout(handleTimeout, refreshAt - now)
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange)
      listening = true
    }
    if (options.countdown) {
      updateRemaining()
      countdownTimer = globalThis.setInterval(updateRemaining, 1000)
    }
  }

  /**
   * 页面暂时不便刷新（如提交进行中）时调用：稍后再触发一次到期处理，不展示倒计时。
   * 提交结果若已自行换新验证码，会通过 `schedule` 覆盖这次重试。
   */
  const retryAfter = (delayMs: number) => {
    cancel()
    refreshAt = Date.now() + Math.max(0, delayMs)
    expireTimer = globalThis.setTimeout(handleTimeout, Math.max(0, delayMs))
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange)
      listening = true
    }
  }

  if (getCurrentScope()) {
    onScopeDispose(cancel)
  }

  return { remainingSeconds, schedule, retryAfter, cancel }
}
