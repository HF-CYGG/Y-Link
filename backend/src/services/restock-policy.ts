/** 补货有效状态的唯一口径：截止时间只派生过期，不改写已完成或已撤回的历史状态。 */
import { createHash } from 'node:crypto'
import type { ClientRestockRequest, RestockEffectiveStatus } from '../entities/client-restock-request.entity.js'
import { BizError } from '../utils/errors.js'

export function effectiveRestockStatus(request: Pick<ClientRestockRequest, 'status' | 'latestPickupAt'>, now: Date): RestockEffectiveStatus {
  return (request.status === 'requested' || request.status === 'accepted') && request.latestPickupAt.getTime() <= now.getTime()
    ? 'expired'
    : request.status
}

export const effectiveRestockStatusSql = (alias: string) => `CASE WHEN ${alias}.status IN ('requested', 'accepted') AND ${alias}.latestPickupAt <= :restockNow THEN 'expired' ELSE ${alias}.status END`

export interface CreateRestockRequestInput {
  productId: string
  skuId: string
  quantity: number
  latestPickupAt: string
  remark?: string
  clientRequestId: string
}

export function normalizeRestockRequest(input: CreateRestockRequestInput) {
  const productId = String(input.productId ?? '').trim()
  const skuId = String(input.skuId ?? '').trim()
  if (![productId, skuId].every((id) => /^[1-9]\d{0,19}$/.test(id))) throw new BizError('商品或规格标识无效', 400)
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 2147483647) throw new BizError('补货数量必须为正整数', 400)
  // 显式时区且精确到分钟；拒绝 JS Date 对非法日期的静默进位。
  const rawTime = String(input.latestPickupAt ?? '').trim()
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::00(?:\.000)?)?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.exec(rawTime)
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59) throw new BizError('最晚取货时间须带时区并精确到分钟', 400)
  const day = new Date(`${match[1]}T00:00:00Z`)
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== match[1]) throw new BizError('最晚取货日期无效', 400)
  const latestPickupAt = new Date(rawTime)
  if (!Number.isFinite(latestPickupAt.getTime())) throw new BizError('最晚取货时间无效', 400)
  const remark = typeof input.remark === 'string' ? input.remark.trim() : ''
  if (remark.length > 1000) throw new BizError('补货备注不能超过 1000 字', 400)
  const clientRequestId = String(input.clientRequestId ?? '').trim()
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(clientRequestId)) throw new BizError('请求标识格式无效', 400)
  const payloadDigest = createHash('sha256').update(JSON.stringify({ productId, skuId, quantity: input.quantity, latestPickupAt: latestPickupAt.toISOString(), remark })).digest('hex')
  return { productId, skuId, quantity: input.quantity, latestPickupAt, remark: remark || null, clientRequestId, payloadDigest }
}

export function buildRestockView(request: ClientRestockRequest | null | undefined, now = new Date()) {
  if (!request) return null
  return {
    id: String(request.id), conversationId: String(request.conversationId), productId: String(request.productId), skuId: String(request.skuId),
    productNameSnapshot: request.productNameSnapshot, productCodeSnapshot: request.productCodeSnapshot,
    skuCodeSnapshot: request.skuCodeSnapshot, specTextSnapshot: request.specTextSnapshot,
    quantity: request.quantity, latestPickupAt: request.latestPickupAt, remark: request.remark,
    status: request.status, effectiveStatus: effectiveRestockStatus(request, now), handledAt: request.handledAt,
    createdAt: request.createdAt, updatedAt: request.updatedAt,
  }
}
