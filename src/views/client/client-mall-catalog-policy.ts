/**
 * 模块说明：src/views/client/client-mall-catalog-policy.ts
 * 文件职责：按商品与规格 ID 关联替换后的目录，禁止详情把旧对象写回购物车。
 * 实现逻辑：保留有效选择与数量；失效选择只标记不可购，搜索仅纳入当前启用 SKU。
 * 维护说明：此处不排序、不分页、不选择替代规格，也不静默缩减用户数量。
 */
import type { O2oMallProduct, O2oMallSku } from '@/api/modules/o2o'

export const buildActiveSkuSearchText = (product: O2oMallProduct) => product.skus
  .filter((sku) => sku.isActive && sku.isCurrent)
  .flatMap((sku) => [sku.skuCode, sku.specText, ...Object.values(sku.specValues ?? {})])
  .join(' ').toLowerCase()

export const resolveCatalogDetailSelection = (products: O2oMallProduct[], productId: string, skuId: string | null) => {
  const product = products.find((item) => String(item.id) === String(productId)) ?? null
  const sku: O2oMallSku | null = product?.skus.find((item) => String(item.id) === String(skuId) && item.isActive && item.isCurrent) ?? null
  return { product, sku, unavailable: !product || !sku }
}

/** 规格失效后只剩一个有效 SKU 时也需要用户明确确认，不把唯一候选自动设为选中。 */
export const resolveExplicitDetailSkuReplacement = (product: O2oMallProduct | null, selectionUnavailable: boolean): O2oMallSku | null => {
  if (!selectionUnavailable) return null
  const skus = product?.skus.filter((sku) => sku.isActive && sku.isCurrent) ?? []
  return skus.length === 1 ? skus[0] ?? null : null
}
