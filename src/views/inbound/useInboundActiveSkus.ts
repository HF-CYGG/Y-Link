/**
 * 模块说明：src/views/inbound/useInboundActiveSkus.ts
 * 文件职责：为供货方送货、送货历史编辑与入库扫码编辑三处明细表提供“商品当前可入库规格”查询。
 * 实现逻辑：
 * - 可入库规格 = 有 ID、未停用且为当前版本的 SKU；退役规格不再出现在候选列表中；
 * - 按商品 ID 预先建好“商品 → 可入库规格”映射，模板里每行每次渲染都是 O(1) 取值，
 *   不再对全量商品逐行 find + filter；商品列表变化时映射自动重建。
 * 维护说明：
 * - 返回的规格数组在多行之间共享，调用方只能读取，不要原地修改；
 * - O2O 入库管理页有自己的商品映射，口径相同但未接入本文件，调整规则时需同步核对。
 */

import { computed, type Ref } from 'vue'
import type { ProductRecord, ProductSkuRecord } from '@/api/modules/product'

const EMPTY_SKUS: readonly ProductSkuRecord[] = Object.freeze([])

export const useInboundActiveSkus = (products: Ref<ProductRecord[]>) => {
  const activeSkuMap = computed(() => new Map(products.value.map((product) => [
    String(product.id),
    (product.skus ?? []).filter((sku) => sku.id && sku.isActive !== false && sku.isCurrent !== false),
  ])))

  /** 取某个商品当前可入库的规格；未知商品返回空列表。 */
  const getActiveProductSkus = (productId: string): readonly ProductSkuRecord[] => {
    return activeSkuMap.value.get(String(productId)) ?? EMPTY_SKUS
  }

  return { getActiveProductSkus }
}
