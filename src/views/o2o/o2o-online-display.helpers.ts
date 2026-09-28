/** 线上展示页的纯状态规则，供分页选择和最小 PATCH 回归验证。 */
import type { ProductRecord, UpdateProductOnlineDisplayDto } from '@/api/modules/product'
import { resolveProductPreviewImage } from '@/utils/product-preview'

export interface OnlineDisplayFilters {
  online: 'all' | 'listed' | 'unlisted'
  base: 'all' | 'active' | 'inactive'
  image: 'all' | 'missing'
}

export interface OnlineDisplaySnapshot {
  o2oStatus: 'listed' | 'unlisted'
  recommendationMode: 'all' | 'selected' | 'none'
  selectedSkuIds: string[]
  limitPerUser: number
  detailContent: string
}

export function filterOnlineDisplayProducts(products: ProductRecord[], filters: OnlineDisplayFilters): ProductRecord[] {
  return products.filter((product) => {
    if (filters.online !== 'all' && product.o2oStatus !== filters.online) return false
    if (filters.base === 'active' && !product.isActive) return false
    if (filters.base === 'inactive' && product.isActive) return false
    if (filters.image === 'missing' && resolveProductPreviewImage(product)) return false
    return true
  })
}

export function clampOnlineDisplayPage(page: number, pageSize: number, total: number): number {
  return Math.min(Math.max(1, page), Math.max(1, Math.ceil(total / pageSize)))
}

export function mergeOnlineDisplayPageSelection(
  selectedIds: string[], pageProducts: ProductRecord[], selectedRows: ProductRecord[],
): string[] {
  const pageIds = new Set(pageProducts.map((product) => product.id))
  return [...new Set([
    ...selectedIds.filter((id) => !pageIds.has(id)),
    ...selectedRows.map((product) => product.id),
  ])]
}

export function buildOnlineDisplayPatch(
  original: OnlineDisplaySnapshot,
  current: OnlineDisplaySnapshot,
  currentSkuIds: string[],
): UpdateProductOnlineDisplayDto {
  const payload: UpdateProductOnlineDisplayDto = {}
  if (current.o2oStatus !== original.o2oStatus) payload.o2oStatus = current.o2oStatus
  if (current.limitPerUser !== original.limitPerUser) payload.limitPerUser = current.limitPerUser
  if (current.detailContent !== original.detailContent) payload.detailContent = current.detailContent.trim() || null
  const oldIds = [...original.selectedSkuIds].sort()
  const newIds = [...current.selectedSkuIds].sort()
  if (current.recommendationMode !== original.recommendationMode
    || (current.recommendationMode === 'selected' && (
      oldIds.length !== newIds.length || newIds.some((id, index) => id !== oldIds[index])
    ))) {
    payload.recommendation = {
      mode: current.recommendationMode,
      expectedSkuIds: currentSkuIds,
      ...(current.recommendationMode === 'selected' ? { skuIds: current.selectedSkuIds } : {}),
    }
  }
  return payload
}

export function validateOnlineDisplayPatch(payload: UpdateProductOnlineDisplayDto): string | null {
  if (payload.limitPerUser !== undefined
    && (!Number.isSafeInteger(payload.limitPerUser) || payload.limitPerUser < 1 || payload.limitPerUser > 999999)) {
    return '单人限购必须为 1 至 999999 的整数'
  }
  if (typeof payload.detailContent === 'string' && payload.detailContent.length > 20000) {
    return '商品详情不能超过 20000 个字符'
  }
  return null
}
