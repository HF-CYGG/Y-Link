/**
 * 商品列表预览图选择规则：客户端商城与线上展示管理页共用。
 * 仅考虑当前启用规格，优先推荐规格、再优先有货规格，最后按展示顺序选取；所选规格无图时回退商品图。
 */
export interface ProductPreviewSku {
  isCurrent?: boolean
  isActive?: boolean
  o2oRecommended?: boolean
  availableStock?: number
  sortOrder?: number
  thumbnail?: string | null
}

export interface ProductPreviewSource<TSku extends ProductPreviewSku> {
  o2oRecommended: boolean
  thumbnail?: string | null
  skus?: TSku[] | null
}

const imageUrl = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim()
  return trimmed || null
}

export function resolveSortedActivePreviewSkus<TSku extends ProductPreviewSku>(product: Pick<ProductPreviewSource<TSku>, 'skus'>): TSku[] {
  return (product.skus ?? [])
    .filter((sku) => sku.isCurrent !== false && sku.isActive !== false)
    .slice()
    .sort((left, right) => {
      const leftOrder = Number.isFinite(Number(left.sortOrder)) ? Number(left.sortOrder) : 0
      const rightOrder = Number.isFinite(Number(right.sortOrder)) ? Number(right.sortOrder) : 0
      return leftOrder - rightOrder
    })
}

export function resolveProductPreviewSku<TSku extends ProductPreviewSku>(product: ProductPreviewSource<TSku>): TSku | null {
  const activeSkus = resolveSortedActivePreviewSkus(product)
  if (!activeSkus.length) return null
  const recommendedSkus = product.o2oRecommended
    ? activeSkus
    : activeSkus.filter((sku) => sku.o2oRecommended === true)
  const candidates = recommendedSkus.length ? recommendedSkus : activeSkus
  return candidates.find((sku) => Math.max(0, Number(sku.availableStock ?? 0)) > 0) ?? candidates[0] ?? null
}

/** 返回真实图片 URL；缺图返回 null，调用方可据此筛选，再按需显示占位图。 */
export function resolveProductPreviewImage<TSku extends ProductPreviewSku>(product: ProductPreviewSource<TSku>): string | null {
  return imageUrl(resolveProductPreviewSku(product)?.thumbnail) ?? imageUrl(product.thumbnail)
}
