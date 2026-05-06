/**
 * 模块说明：src/utils/storage-user-scope.ts
 * 文件职责：提供浏览器本地/会话存储的“按用户隔离”键生成与历史全局键清理能力。
 * 实现逻辑：
 * 1. 统一归一化用户标识，兼容 string / number 两种来源，避免各模块各自处理不一致；
 * 2. 统一读取 localStorage / sessionStorage，降低 SSR、测试环境下直接访问 window 的风险；
 * 3. 统一清理历史遗留的全局缓存 key，保证升级到“按用户隔离”后不会继续读到旧缓存。
 * 维护说明：
 * - 新增任何“与当前账号强绑定”的前端缓存时，优先复用这里的用户作用域工具；
 * - 若后续需要引入门店、租户等更细粒度作用域，可在本文件扩展键拼装规则。
 */

export type BrowserStorageType = 'local' | 'session'

/**
 * 获取浏览器存储对象：
 * - 默认读取 localStorage；
 * - 在非浏览器环境下直接返回 null，避免工具链阶段报错。
 */
export const getBrowserStorage = (storageType: BrowserStorageType = 'local'): Storage | null => {
  if (globalThis.window === undefined) {
    return null
  }

  return storageType === 'session' ? globalThis.window.sessionStorage : globalThis.window.localStorage
}

/**
 * 归一化用户作用域标识：
 * - 兼容后端或历史代码可能传入的 string / number；
 * - 返回空串表示当前没有可用的账号作用域，不应继续写入用户隔离缓存。
 */
export const normalizeStorageScopeId = (value: unknown): string => {
  if (typeof value === 'string') {
    return value.trim()
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value).trim()
  }

  return ''
}

/**
 * 生成按用户隔离的缓存 key：
 * - 有效用户标识时返回 `${baseKey}:${scopeId}`；
 * - 无有效用户标识时返回 null，调用方应直接跳过持久化。
 */
export const resolveUserScopedStorageKey = (baseKey: string, scopeId: unknown): string | null => {
  const normalizedScopeId = normalizeStorageScopeId(scopeId)
  if (!normalizedScopeId) {
    return null
  }

  return `${baseKey}:${normalizedScopeId}`
}

/**
 * 清理历史遗留的全局 key：
 * - 旧版本若使用未分片的固定 key，会在切换账号时造成串号；
 * - 新版本每次读写时都顺手清理一次，确保升级后尽快摆脱旧缓存。
 */
export const clearLegacyScopedStorageKey = (storage: Storage, legacyKey: string) => {
  storage.removeItem(legacyKey)
}
