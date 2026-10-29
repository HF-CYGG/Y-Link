/** 补货专用纯规则：只认真实当前启用 SKU 库存，时间固定为 UTC+8，数量不受购物限购约束。 */
import type { ClientRestockRequest, O2oMallProduct, O2oMallSku, RestockEffectiveStatus } from '../../packages/shared-types/src/index'

export const RESTOCK_MAX_QUANTITY = 2147483647
export const RESTOCK_STATUS_LABELS: Record<RestockEffectiveStatus, string> = {
  requested: '待受理', accepted: '已受理', restocked: '已补货', cancelled: '已撤回', expired: '已过期',
}
export const getRestockSkus = (product: Pick<O2oMallProduct, 'skus'> | null | undefined): O2oMallSku[] =>
  (product?.skus ?? []).filter((sku) => sku.isCurrent && sku.isActive && Number(sku.availableStock) === 0)

export const formatRestockTime = (value: string): string => {
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return '-'
  return new Date(time + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ')
}

/** 日期控件的值是北京时间墙上时间，不能交给浏览器默认时区解析。 */
export const toRestockIso = (value: string): string | null => {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value)) return null
  const iso = `${value.replace(' ', 'T')}:00+08:00`
  return Number.isFinite(Date.parse(iso)) && formatRestockTime(iso) === value ? iso : null
}

export const isValidRestockQuantity = (quantity: number) => Number.isInteger(quantity) && quantity >= 1 && quantity <= RESTOCK_MAX_QUANTITY
export const isActiveRestock = (restock: ClientRestockRequest | null | undefined) => Boolean(restock && ['requested', 'accepted'].includes(restock.effectiveStatus))

/** 仅为到期刷新确定唤醒时间；展示状态仍以服务端 effectiveStatus 为准。 */
export const getRestockExpiryDelay = (restock: ClientRestockRequest, serverNow: string): number | null => {
  if (!isActiveRestock(restock)) return null
  const serverTime = Date.parse(serverNow)
  const deadline = Date.parse(restock.latestPickupAt)
  if (!Number.isFinite(serverTime) || !Number.isFinite(deadline)) return null
  return Math.max(0, deadline - serverTime)
}
