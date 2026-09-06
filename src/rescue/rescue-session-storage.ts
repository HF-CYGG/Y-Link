/**
 * 模块说明：src/rescue/rescue-session-storage.ts
 * 文件职责：只在当前浏览器标签页保存数据库救援凭证，供独立救援入口读取。
 * 实现逻辑：
 * - 使用 sessionStorage，关闭标签页后浏览器自动清除，避免把一次性凭证写入持久化存储；
 * - 读取时校验过期时间并主动删除失效值，页面和普通任务列表均不保留明文凭证；
 * - 工具只接受显式传入的 StorageLike，便于单测且不在模块加载时访问浏览器全局对象。
 * 维护说明：凭证不得写入 URL、日志、localStorage 或任何迁移任务对象。
 */

const RESCUE_CREDENTIAL_STORAGE_KEY = 'ylink.database-rescue.credential.v1'

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface RescueCredential {
  taskId: string
  credential: string
  expiresAt: string
}

const isRescueCredential = (value: unknown): value is RescueCredential => {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Partial<RescueCredential>
  return typeof candidate.taskId === 'string'
    && typeof candidate.credential === 'string'
    && typeof candidate.expiresAt === 'string'
    && candidate.taskId.length > 0
    && candidate.credential.length > 0
    && Number.isFinite(Date.parse(candidate.expiresAt))
}

export const storeRescueCredential = (storage: StorageLike, value: RescueCredential) => {
  storage.setItem(RESCUE_CREDENTIAL_STORAGE_KEY, JSON.stringify(value))
}

export const readStoredRescueCredential = (storage: StorageLike, now = new Date()): RescueCredential | null => {
  const rawValue = storage.getItem(RESCUE_CREDENTIAL_STORAGE_KEY)
  if (!rawValue) {
    return null
  }

  try {
    const parsedValue: unknown = JSON.parse(rawValue)
    if (!isRescueCredential(parsedValue) || Date.parse(parsedValue.expiresAt) <= now.getTime()) {
      storage.removeItem(RESCUE_CREDENTIAL_STORAGE_KEY)
      return null
    }
    return parsedValue
  } catch {
    storage.removeItem(RESCUE_CREDENTIAL_STORAGE_KEY)
    return null
  }
}

export const clearStoredRescueCredential = (storage: StorageLike) => {
  storage.removeItem(RESCUE_CREDENTIAL_STORAGE_KEY)
}
