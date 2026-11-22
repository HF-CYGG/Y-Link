/**
 * 模块说明：正式出库技术号的响应可见性投影。
 * 文件职责：在 API 序列化边界为非管理员移除 systemNo 及一周期 showNo 兼容字段。
 * 维护说明：只为有变化的分支分配新容器，禁止改写服务缓存、事务结果或审计快照。
 */

import { isDate, isProxy } from 'node:util/types'
import type { UserRole } from '../types/auth.js'

const isRestrictedSystemIdentifierKey = (key: string): boolean => {
  const normalizedKey = key.toLowerCase()
  return normalizedKey.includes('systemno') || normalizedKey.endsWith('showno')
}

const dateSerializationHooks = ['toJSON', 'toISOString', 'valueOf', 'toString', Symbol.toPrimitive] as const

function projectArray(source: unknown[]): unknown[] {
  // 自定义原型或序列化 hook 必须隔离；仍以数组格式序列化。
  const canShare = Object.getPrototypeOf(source) === Array.prototype && !('toJSON' in source)
  let projected: unknown[] | undefined
  for (let index = 0; index < source.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(source, index)
    const nestedValue: unknown = descriptor?.value
    const child = projectValue(nestedValue)
    if (!projected && (!canShare || !Object.is(child, nestedValue)
      || (descriptor ? !('value' in descriptor) : index in source))) {
      projected = Object.setPrototypeOf(new Array(source.length), null)
      for (let previous = 0; previous < index; previous += 1) {
        if (Object.hasOwn(source, previous)) projected![previous] = source[previous]
      }
    }
    if (projected && descriptor) projected[index] = child
  }
  return projected ?? (canShare ? source : Object.setPrototypeOf([], null))
}

function projectRecord(source: Record<string, unknown>): Record<string, unknown> {
  const prototype = Object.getPrototypeOf(source)
  const plain = prototype === Object.prototype || prototype === null
  const matchType = Object.getOwnPropertyDescriptor(source, 'matchedIdentifierType')
    ?? (prototype === Object.prototype ? Object.getOwnPropertyDescriptor(prototype, 'matchedIdentifierType') : undefined)
  const redactMatch = matchType ? !('value' in matchType) || matchType.value === 'systemNo' : !plain
  const keys = Object.keys(source)
  let projected: Record<string, unknown> | undefined = plain && !('toJSON' in source) ? undefined : Object.create(null)
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!
    const descriptor = Object.getOwnPropertyDescriptor(source, key)!
    const restricted = isRestrictedSystemIdentifierKey(key)
    const matchField = redactMatch && (key === 'matchedIdentifierType' || key === 'matchedIdentifierValue')
    // 不执行访问器或自定义序列化，避免投影后再读出未过滤的数据。
    const accessor = !('value' in descriptor)
    const nestedValue: unknown = descriptor.value
    const child = restricted || matchField || accessor ? undefined : projectValue(nestedValue)
    if (!projected && (restricted || matchField || accessor || !Object.is(child, nestedValue))) {
      projected = Object.create(null) as Record<string, unknown>
      for (let previous = 0; previous < index; previous += 1) {
        const previousKey = keys[previous]!
        projected[previousKey] = source[previousKey]
      }
    }
    if (!projected || restricted) continue
    if (matchField) {
      if (key === 'matchedIdentifierType') projected.matchedIdentifierType = null
      projected.matchedIdentifierValue = null
    } else if (!accessor) {
      projected[key] = child
    }
  }
  return projected ?? source
}

function projectValue(value: unknown): unknown {
  if (typeof value === 'function') return undefined
  if (!value || typeof value !== 'object') return value
  if (isProxy(value)) return undefined
  if (isDate(value)) {
    if (Object.getPrototypeOf(value) === Date.prototype
      && dateSerializationHooks.every((key) => !Object.hasOwn(value, key))) return value
    return Number.isFinite(Date.prototype.getTime.call(value)) ? Date.prototype.toISOString.call(value) : null
  }
  return Array.isArray(value) ? projectArray(value) : projectRecord(value as Record<string, unknown>)
}

/** 管理员保留技术追溯字段；其他角色及客户端/匿名上下文只得到业务编号。 */
export function projectSystemIdentifiersForRole<T>(value: T, role?: UserRole | null): T {
  return (role === 'admin' ? value : projectValue(value)) as T
}
