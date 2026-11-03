/**
 * 模块说明：src/utils/supplier-delivery-draft.ts
 * 文件职责：为供货方“送货单录入”页提供按登录用户隔离的本地草稿读写，同时承接历史页“再来一单”的明细传递。
 * 实现逻辑：
 * - 草稿只保存商品 / 规格 / 数量、备注与预计送达时间，统一序列化为 JSON 存入 localStorage；
 * - 键名复用 storage-user-scope 的用户作用域规则，缺少用户标识时直接跳过持久化，避免串号；
 * - 读取时逐字段校验结构，任何异常（隐私策略、JSON 损坏、字段类型不符）都按“无草稿”处理并尽力清理。
 * 维护说明：
 * - 草稿内的商品、规格是否仍有效，由录入页结合当前启用商品目录判断，本工具不访问接口；
 * - 新增草稿字段时必须同步扩展 normalize 校验，旧版本草稿缺字段时应按默认值兜底。
 */

import { getBrowserStorage, resolveUserScopedStorageKey } from '@/utils/storage-user-scope'

const SUPPLIER_DELIVERY_DRAFT_KEY_PREFIX = 'y-link:supplier-delivery-draft'

// 单行数量上限：200 行 * 9,999,999 仍小于数据库整型上限，避免合并同规格后溢出。
export const SUPPLIER_DELIVERY_ITEM_QTY_MAX = 9_999_999
// 与后端 MAX_INBOUND_ORDER_ITEM_COUNT 保持一致。
export const SUPPLIER_DELIVERY_MAX_ITEM_COUNT = 200

export interface SupplierDeliveryDraftItem {
  productId: string
  skuId: string
  qty: number
}

export interface SupplierDeliveryDraft {
  items: SupplierDeliveryDraftItem[]
  remark: string
  /** ISO 字符串；为空表示未选择。 */
  expectedArrivalAt: string | null
}

const resolveDraftKey = (userId: unknown) => resolveUserScopedStorageKey(SUPPLIER_DELIVERY_DRAFT_KEY_PREFIX, userId)

const normalizeDraft = (raw: unknown): SupplierDeliveryDraft | null => {
  if (!raw || typeof raw !== 'object') {
    return null
  }

  const source = raw as Record<string, unknown>
  const rawItems = Array.isArray(source.items) ? source.items : []
  const items: SupplierDeliveryDraftItem[] = []
  for (const rawItem of rawItems.slice(0, SUPPLIER_DELIVERY_MAX_ITEM_COUNT)) {
    if (!rawItem || typeof rawItem !== 'object') {
      continue
    }
    const item = rawItem as Record<string, unknown>
    const productId = typeof item.productId === 'string' || typeof item.productId === 'number' ? String(item.productId).trim() : ''
    const skuId = typeof item.skuId === 'string' || typeof item.skuId === 'number' ? String(item.skuId).trim() : ''
    const qty = Number(item.qty)
    if (!productId) {
      continue
    }
    items.push({
      productId,
      skuId,
      qty: Number.isFinite(qty) && qty >= 1 ? Math.min(Math.floor(qty), SUPPLIER_DELIVERY_ITEM_QTY_MAX) : 1,
    })
  }

  const remark = typeof source.remark === 'string' ? source.remark.slice(0, 255) : ''
  const expectedArrivalAt = typeof source.expectedArrivalAt === 'string' && source.expectedArrivalAt ? source.expectedArrivalAt : null

  if (!items.length && !remark.trim() && !expectedArrivalAt) {
    return null
  }

  return { items, remark, expectedArrivalAt }
}

export const clearSupplierDeliveryDraft = (userId: unknown) => {
  try {
    const storage = getBrowserStorage('local')
    const key = resolveDraftKey(userId)
    if (!storage || !key) {
      return
    }
    storage.removeItem(key)
  } catch {
    // 存储被拒绝时静默跳过：草稿只是便利功能，不能影响主流程。
  }
}

export const readSupplierDeliveryDraft = (userId: unknown): SupplierDeliveryDraft | null => {
  try {
    const storage = getBrowserStorage('local')
    const key = resolveDraftKey(userId)
    if (!storage || !key) {
      return null
    }
    const raw = storage.getItem(key)
    if (!raw) {
      return null
    }
    const draft = normalizeDraft(JSON.parse(raw))
    if (!draft) {
      clearSupplierDeliveryDraft(userId)
    }
    return draft
  } catch {
    clearSupplierDeliveryDraft(userId)
    return null
  }
}

/**
 * 写入草稿：内容为空（无商品、无备注、无时间）时等同于清除，返回是否写入成功。
 */
export const writeSupplierDeliveryDraft = (userId: unknown, draft: SupplierDeliveryDraft): boolean => {
  try {
    const storage = getBrowserStorage('local')
    const key = resolveDraftKey(userId)
    if (!storage || !key) {
      return false
    }
    const normalized = normalizeDraft(draft)
    if (!normalized) {
      storage.removeItem(key)
      return true
    }
    storage.setItem(key, JSON.stringify(normalized))
    return true
  } catch {
    return false
  }
}
