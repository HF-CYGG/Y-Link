/**
 * 模块说明：src/utils/client-auth-risk.ts
 * 文件职责：生成并维护客户端认证风控标识，用于把登录/注册/找回密码频控从“强依赖公网 IP”收敛为“浏览器会话/浏览器实例优先”。
 * 实现逻辑：
 * - 浏览器实例标识写入 `localStorage`，同一浏览器资料目录内长期复用，降低企业/校园共享公网 IP 的误伤；
 * - 浏览器会话标识写入 `sessionStorage`，当前会话结束后自动失效，兼顾忘记密码、重新打开浏览器后的可恢复性；
 * - 若浏览器存储不可用，则回退到当前运行时内存值，保证请求头透传链路不中断。
 * 维护说明：
 * - 请求层应统一消费 `getClientRiskHeaderSnapshot()`，避免各模块自行生成不一致的风控头；
 * - 后端若后续升级为 Redis 风控，可继续沿用当前请求头协议，无需重新改客户端页面。
 */

const CLIENT_RISK_BROWSER_ID_KEY = 'y-link.client-auth.risk.browser-id'
const CLIENT_RISK_SESSION_ID_KEY = 'y-link.client-auth.risk.session-id'

let memoryBrowserRiskId: string | null = null
let memorySessionRiskId: string | null = null

const getStorage = (storageType: 'local' | 'session'): Storage | null => {
  if (typeof globalThis.window === 'undefined') {
    return null
  }
  return storageType === 'session' ? globalThis.window.sessionStorage : globalThis.window.localStorage
}

const createRiskId = (prefix: 'br' | 'sess') => {
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function') {
    return `${prefix}-${globalThis.crypto.randomUUID()}`
  }

  const randomPart = `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
  return `${prefix}-${randomPart}`
}

const readOrCreateRiskId = (storageType: 'local' | 'session', storageKey: string, prefix: 'br' | 'sess') => {
  const storage = getStorage(storageType)
  if (!storage) {
    if (storageType === 'session') {
      memorySessionRiskId ||= createRiskId(prefix)
      return memorySessionRiskId
    }
    memoryBrowserRiskId ||= createRiskId(prefix)
    return memoryBrowserRiskId
  }

  const currentValue = storage.getItem(storageKey)?.trim()
  if (currentValue) {
    return currentValue
  }

  const nextValue = createRiskId(prefix)
  storage.setItem(storageKey, nextValue)
  return nextValue
}

export const getClientBrowserRiskId = () => {
  return readOrCreateRiskId('local', CLIENT_RISK_BROWSER_ID_KEY, 'br')
}

export const getClientSessionRiskId = () => {
  return readOrCreateRiskId('session', CLIENT_RISK_SESSION_ID_KEY, 'sess')
}

export const getClientRiskHeaderSnapshot = () => {
  return {
    browserId: getClientBrowserRiskId(),
    sessionId: getClientSessionRiskId(),
  }
}
