/** 管理端 WebAuthn 浏览器可用性与流程生命周期工具。 */

export interface AdminWebAuthnCapabilities {
  enabled: boolean
  rpId: string | null
  rpName: string | null
  allowedOrigins: string[]
}

export interface WebAuthnBrowserContext {
  origin: string
  secure: boolean
  supported: boolean
}

export const assessWebAuthnAvailability = (capabilities: AdminWebAuthnCapabilities, context: WebAuthnBrowserContext) => {
  if (!capabilities.enabled) return { available: false, message: '管理员尚未开启通行密钥登录。' }
  if (!context.secure) return { available: false, message: '当前页面不是安全连接，请使用 HTTPS 或本机地址。' }
  if (!context.supported) return { available: false, message: '当前浏览器不支持通行密钥或安全密钥。' }
  if (!capabilities.allowedOrigins.includes(context.origin)) return { available: false, message: '当前访问地址未获准使用通行密钥。' }
  return { available: true, message: '可使用通行密钥或安全密钥。' }
}

export const isWebAuthnCancellation = (error: unknown) => {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { name?: unknown; code?: unknown }
  return candidate.name === 'NotAllowedError'
    || candidate.name === 'AbortError'
    || candidate.code === 'ERROR_CEREMONY_ABORTED'
}

/** 每次开始或关闭流程时终止旧 HTTP 请求与浏览器仪式，并使旧异步结果失效。 */
export const createWebAuthnFlow = (cancelCeremony: () => void) => {
  let sequence = 0
  let controller: AbortController | null = null
  const cancel = () => {
    sequence += 1
    if (controller) {
      controller.abort()
      controller = null
      cancelCeremony()
    }
  }
  return {
    start: () => {
      cancel()
      controller = new AbortController()
      return { id: sequence, signal: controller.signal }
    },
    isCurrent: (id: number) => id === sequence && controller !== null && !controller.signal.aborted,
    finish: (id: number) => {
      if (id === sequence) {
        sequence += 1
        controller = null
      }
    },
    cancel,
  }
}

/** 统一登录尝试的可取消阶段与最终请求冻结状态。最终请求完成前不得丢弃可能写入 Cookie 的回应。 */
export const createLoginAttemptGate = () => {
  let sequence = 0
  let controller: AbortController | null = null
  let committed = false
  return {
    begin: () => {
      if (committed) return null
      controller?.abort()
      controller = new AbortController()
      sequence += 1
      return { id: sequence, signal: controller.signal }
    },
    isCurrent: (id: number) => id === sequence && controller !== null && !controller.signal.aborted,
    isCommitted: () => committed,
    commit: (id: number) => {
      if (id !== sequence || controller === null || controller.signal.aborted) return false
      committed = true
      return true
    },
    settle: (id: number) => {
      if (id !== sequence || !committed) return false
      committed = false
      controller = null
      sequence += 1
      return true
    },
    cancel: () => {
      if (committed) return false
      controller?.abort()
      controller = null
      sequence += 1
      return true
    },
  }
}
