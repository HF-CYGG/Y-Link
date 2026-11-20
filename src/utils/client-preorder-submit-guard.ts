/**
 * 模块说明：src/utils/client-preorder-submit-guard.ts
 * 文件职责：保存客户端预订单原请求快照，支持刷新后的同键原载荷确认与账号隔离。
 * 实现逻辑：首次 POST 前写入并读回带版本和 owner 的 30 分钟快照；核实订单后可解除同账号的无载荷标记。
 * 维护说明：intentKey 是有损指纹，不能重建载荷；登出/换号只保留不含业务明文的 pending 标记。
 */
import type { O2oClientOrderType, SubmitO2oPreorderPayload } from '@/api/modules/o2o'

export interface ClientPreorderSubmitItemInput {
  productId: string | number
  skuId?: string | number | null
  qty: number
}

export interface ClientPreorderSubmitIntentInput {
  clientUserId: ClientPreorderSubmitUserId
  clientOrderType: O2oClientOrderType
  isSystemApplied: boolean
  kingdeeVoucherNo?: string | null
  pickupContact: string
  /** 部门单到店取货时间；改变取货时间属于不同下单意图，不得复用结果未知订单的请求键。 */
  pickupAt?: string | null
  remark?: string
  items: ClientPreorderSubmitItemInput[]
}

export interface ClientPreorderSubmitLockSnapshot {
  version: 2
  owner: string
  expiresAt: number
  payload: SubmitO2oPreorderPayload | null
  expired: boolean
  intentKey: string
  requestKey: string
  createdAt: number
  dismissibleMarker: string | null
}

const CLIENT_PREORDER_SUBMIT_LOCK_KEY_PREFIX = 'ylink:client:preorder:submit-lock:'
// 请求超时、移动网络切换和页面重新进入可能持续数分钟；保留 30 分钟可覆盖人工重试窗口。
// 明确成功或明确失败都会立即清理，不会阻止用户完成后一笔内容相同的新订单。
const CLIENT_PREORDER_SUBMIT_LOCK_TTL_MS = 30 * 60 * 1000
type ClientPreorderSubmitUserId = string | number | null | undefined

const normalizeClientUserId = (value: ClientPreorderSubmitUserId) => {
  return String(value ?? '').trim() || 'anonymous'
}

const resolveSubmitLockStorageKey = (clientUserId: ClientPreorderSubmitUserId) => {
  return `${CLIENT_PREORDER_SUBMIT_LOCK_KEY_PREFIX}${normalizeClientUserId(clientUserId)}`
}

const getSubmitLockStorage = () => {
  if (globalThis.window === undefined) {
    return null
  }
  return globalThis.window.sessionStorage
}

const normalizeText = (value: string | null | undefined) => {
  return (value ?? '').trim()
}

const normalizeRemark = (value: string | null | undefined) => {
  return normalizeText(value).replaceAll(/\s+/g, ' ')
}

const normalizeItemsForFingerprint = (items: ClientPreorderSubmitItemInput[]) => {
  return items
    .map((item) => ({
      productId: String(item.productId ?? '').trim(),
      skuId: item.skuId === null || item.skuId === undefined ? '' : String(item.skuId).trim(),
      qty: Math.max(0, Math.floor(Number(item.qty ?? 0))),
    }))
    .filter((item) => item.productId && item.qty > 0)
    .sort((prev, next) => {
      const productCompare = prev.productId.localeCompare(next.productId, 'en')
      return productCompare || prev.skuId.localeCompare(next.skuId, 'en')
    })
}

export const buildClientPreorderSubmitIntentKey = (input: ClientPreorderSubmitIntentInput) => {
  const normalizedItems = normalizeItemsForFingerprint(input.items)
  return JSON.stringify({
    clientUserId: normalizeClientUserId(input.clientUserId),
    clientOrderType: input.clientOrderType,
    isSystemApplied: Boolean(input.isSystemApplied),
    ...(input.kingdeeVoucherNo?.trim() ? { kingdeeVoucherNo: input.kingdeeVoucherNo.trim() } : {}),
    pickupContact: normalizeText(input.pickupContact),
    remark: normalizeRemark(input.remark),
    items: normalizedItems,
    // 仅在携带取货时间时写入指纹，未携带时指纹与旧版本一致，不影响已存在的散客单提交锁。
    ...(input.pickupAt ? { pickupAt: input.pickupAt } : {}),
  })
}

// 只接受完整原始载荷；旧版 intentKey 是有损指纹，绝不能用它重造请求。
const isPayload = (value: unknown, requestKey: string): value is SubmitO2oPreorderPayload => {
  if (!value || typeof value !== 'object') return false
  const p = value as SubmitO2oPreorderPayload
  return p.clientRequestId === requestKey && typeof p.isSystemApplied === 'boolean'
    && typeof p.pickupContact === 'string' && (!('remark' in p) || typeof p.remark === 'string')
    && (p.pickupAt === undefined || p.pickupAt === null || typeof p.pickupAt === 'string')
    && (p.kingdeeVoucherNo === undefined || p.kingdeeVoucherNo === null || typeof p.kingdeeVoucherNo === 'string')
    && Array.isArray(p.items) && p.items.length > 0 && p.items.every((item) => item
      && ['string', 'number'].includes(typeof item.productId)
      && (item.skuId == null || ['string', 'number'].includes(typeof item.skuId))
      && Number.isSafeInteger(item.qty) && item.qty > 0)
}

const parseSubmitLockRecord = (raw: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch { /* 损坏记录仍按未决处理。 */ }
  return {}
}

const matchesLegacySubmitIntent = (raw: string, owner: string) => {
  const intent = parseSubmitLockRecord(raw)
  return intent.clientUserId === owner && (intent.clientOrderType === 'walkin' || intent.clientOrderType === 'department')
    && typeof intent.isSystemApplied === 'boolean' && typeof intent.remark === 'string'
    && typeof intent.pickupContact === 'string' && intent.pickupContact.trim() !== ''
    && (intent.kingdeeVoucherNo === undefined || typeof intent.kingdeeVoucherNo === 'string')
    && (intent.pickupAt === undefined || typeof intent.pickupAt === 'string')
    && Array.isArray(intent.items) && intent.items.length > 0 && intent.items.every((item) => item
      && typeof item.productId === 'string' && item.productId.trim() !== ''
      && (item.skuId === undefined || typeof item.skuId === 'string')
      && Number.isSafeInteger(item.qty) && item.qty > 0)
}

const isValidCreatedAt = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

const isOwnedSubmitLock = (p: Record<string, unknown>, owner: string) => p.version === 2 && p.owner === owner
  && isValidCreatedAt(p.createdAt) && typeof p.expiresAt === 'number' && Number.isFinite(p.expiresAt)
  && p.expiresAt > p.createdAt && p.expiresAt <= p.createdAt + CLIENT_PREORDER_SUBMIT_LOCK_TTL_MS

const isDismissibleSubmitMarker = (p: Record<string, unknown>, owner: string) => isOwnedSubmitLock(p, owner)
  && p.payload === null && typeof p.requestKey === 'string' && p.requestKey.trim() !== '' && p.dismissalBlocked === undefined

export const readActiveClientPreorderSubmitLock = (clientUserId: ClientPreorderSubmitUserId): ClientPreorderSubmitLockSnapshot | null => {
  const storage = getSubmitLockStorage()
  if (!storage) throw new Error('无法访问会话存储，请恢复浏览器存储后再提交')
  const key = resolveSubmitLockStorageKey(clientUserId)
  const raw = storage.getItem(key)
  if (raw === null) return null
  const p = parseSubmitLockRecord(raw)
  const createdAt = typeof p.createdAt === 'number' && Number.isFinite(p.createdAt) ? p.createdAt : Date.now()
  const expiresAt = typeof p.expiresAt === 'number' && Number.isFinite(p.expiresAt)
    ? Math.min(p.expiresAt, createdAt + CLIENT_PREORDER_SUBMIT_LOCK_TTL_MS)
    : createdAt + CLIENT_PREORDER_SUBMIT_LOCK_TTL_MS
  const requestKey = typeof p.requestKey === 'string' ? p.requestKey : ''
  const owner = normalizeClientUserId(clientUserId)
  const expired = Date.now() >= expiresAt
  const originalPayload = isOwnedSubmitLock(p, owner) && p.dismissalBlocked === undefined
    && typeof p.intentKey === 'string' && requestKey.trim() !== '' && isPayload(p.payload, requestKey)
    ? p.payload : null
  const payload = expired ? null : originalPayload
  let dismissibleMarker: string | null = null
  if (!payload) {
    // 旧版账号由其存储键与原指纹共同确定，仅脱敏迁移完整且同账号的旧记录。
    const ownedLegacy = p.version === undefined && p.owner === undefined && p.payload === undefined
      && p.expiresAt === undefined && p.dismissalBlocked === undefined
      && isValidCreatedAt(p.createdAt) && requestKey.trim() !== ''
      && typeof p.intentKey === 'string' && matchesLegacySubmitIntent(p.intentKey, owner)
    const canDismiss = Boolean(originalPayload) || ownedLegacy || isDismissibleSubmitMarker(p, owner)
    const marker = JSON.stringify({ version: 2, owner, createdAt, expiresAt, requestKey, payload: null,
      ...(canDismiss ? {} : { dismissalBlocked: true }) })
    if (raw !== marker) {
      storage.setItem(key, marker)
      if (storage.getItem(key) !== marker) throw new Error('无法保存脱敏后的原始提交记录')
    }
    if (canDismiss) dismissibleMarker = marker
  }
  return { version: 2, owner, createdAt, expiresAt, expired, requestKey, payload, dismissibleMarker,
    intentKey: payload && typeof p.intentKey === 'string' ? p.intentKey : '' }
}

/** 只解除用户已核实且仍为同一条的无载荷标记；结算页负责校验确认操作的会话归属。 */
export const dismissClientPreorderSubmitMarker = (clientUserId: ClientPreorderSubmitUserId, marker: string) => {
  const storage = getSubmitLockStorage()
  if (!storage) throw new Error('无法访问会话存储，请恢复浏览器存储后再提交')
  const key = resolveSubmitLockStorageKey(clientUserId)
  const current = storage.getItem(key)
  if (current !== marker) return false
  if (!isDismissibleSubmitMarker(parseSubmitLockRecord(current), normalizeClientUserId(clientUserId))) return false
  storage.removeItem(key)
  if (storage.getItem(key) !== null) throw new Error('原始提交记录清理失败')
  return true
}

export const createClientPreorderSubmitLock = (
  clientUserId: ClientPreorderSubmitUserId,
  intentKey: string,
  payload?: Omit<SubmitO2oPreorderPayload, 'clientRequestId'>,
) => {
  const storage = getSubmitLockStorage()
  if (!storage) throw new Error('无法保存原始提交，请恢复浏览器会话存储后重试')
  if (readActiveClientPreorderSubmitLock(clientUserId)) throw new Error('仍有未确认的订单，请先查看订单')
  const requestKey = globalThis.crypto?.randomUUID?.() ?? `client-preorder-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const createdAt = Date.now()
  const snapshot = { version: 2, owner: normalizeClientUserId(clientUserId), intentKey, requestKey, createdAt,
    expiresAt: createdAt + CLIENT_PREORDER_SUBMIT_LOCK_TTL_MS,
    payload: payload ? { ...payload, clientRequestId: requestKey } : null }
  const encoded = JSON.stringify(snapshot)
  const key = resolveSubmitLockStorageKey(clientUserId)
  storage.setItem(key, encoded)
  if (storage.getItem(key) !== encoded) throw new Error('原始提交保存失败，本次未发送')
  return requestKey
}

// 未决重试不延长原始有效期，也不以当前表单覆盖首次提交。
export const refreshClientPreorderSubmitLock = (clientUserId: ClientPreorderSubmitUserId, _intentKey: string, requestKey: string) => {
  const snapshot = readActiveClientPreorderSubmitLock(clientUserId)
  if (!snapshot || snapshot.requestKey !== requestKey) throw new Error('原始提交记录不可用，请查看订单')
}

export const clearClientPreorderSubmitLock = (clientUserId: ClientPreorderSubmitUserId, requestKey?: string) => {
  const storage = getSubmitLockStorage()
  if (!storage) return
  if (!requestKey || readActiveClientPreorderSubmitLock(clientUserId)?.requestKey === requestKey) {
    storage.removeItem(resolveSubmitLockStorageKey(clientUserId))
  }
}

/** 退出/换号清除业务明文，保留原到期时间和无载荷标记，重新登录不能绕过未决请求。 */
export const redactClientPreorderSubmitLocks = () => {
  try {
    const storage = getSubmitLockStorage()
    if (!storage) return
    for (const key of Object.keys(storage)) {
      if (!key.startsWith(CLIENT_PREORDER_SUBMIT_LOCK_KEY_PREFIX)) continue
      const owner = key.slice(CLIENT_PREORDER_SUBMIT_LOCK_KEY_PREFIX.length)
      const snapshot = readActiveClientPreorderSubmitLock(owner)
      if (!snapshot?.payload) continue // 读锁时已将不可重试的记录脱敏并保留原有解除资格。
      storage.setItem(key, JSON.stringify({ version: 2, owner,
        createdAt: snapshot.createdAt, expiresAt: snapshot.expiresAt, requestKey: snapshot.requestKey, payload: null }))
    }
  } catch {
    // 浏览器禁止存储访问时无法清理；页面仍必须立即释放内存中的业务字段。
  }
}
