/**
 * 模块说明：正式出库技术号的响应可见性投影。
 * 文件职责：在 API 序列化边界为非管理员移除 systemNo 及一周期 showNo 兼容字段。
 * 维护说明：函数必须返回新对象，禁止原地改写服务缓存、事务结果或审计快照。
 */

import type { UserRole } from '../types/auth.js'

const isRestrictedSystemIdentifierKey = (key: string): boolean => {
  const normalizedKey = key.toLowerCase()
  return normalizedKey.includes('systemno') || normalizedKey.endsWith('showno')
}

const projectValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => projectValue(item))
  }
  if (!value || typeof value !== 'object' || value instanceof Date) {
    return value
  }

  const source = value as Record<string, unknown>
  const projected: Record<string, unknown> = {}
  for (const [key, nestedValue] of Object.entries(source)) {
    if (isRestrictedSystemIdentifierKey(key)) continue
    if (key === 'matchedIdentifierType' && nestedValue === 'systemNo') {
      projected.matchedIdentifierType = null
      projected.matchedIdentifierValue = null
      continue
    }
    if (key === 'matchedIdentifierValue' && source.matchedIdentifierType === 'systemNo') {
      if (!('matchedIdentifierValue' in projected)) projected.matchedIdentifierValue = null
      continue
    }
    projected[key] = projectValue(nestedValue)
  }
  return projected
}

/** 管理员保留技术追溯字段；其他角色及客户端/匿名上下文只得到业务编号。 */
export function projectSystemIdentifiersForRole<T>(value: T, role?: UserRole | null): T {
  return (role === 'admin' ? value : projectValue(value)) as T
}
