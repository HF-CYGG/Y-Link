/**
 * 文件说明：Issue #52 客户端购物车目录对账回归验证。
 * 文件职责：以真实 Pinia Store 与浏览器存储替身覆盖库存刷新、缓存恢复和多标签页隔离语义；不访问业务数据库或网络。
 * 维护说明：本脚本只验证购物车本地状态不能在后台目录刷新时静默减量或取消勾选，结算提交拦截由结算页守卫单独覆盖。
 */

import assert from 'node:assert/strict'

import { createPinia, setActivePinia } from 'pinia'

import type { O2oMallProduct } from '../src/api/modules/o2o'
import { useClientCartStore } from '../src/store/modules/client-cart'
import {
  buildClientPreorderSubmitIntentKey,
  clearClientPreorderSubmitLock,
  createClientPreorderSubmitLock,
  readActiveClientPreorderSubmitLock,
} from '../src/utils/client-preorder-submit-guard'
import { decideClientCheckoutSubmit } from '../src/views/client/client-checkout-submit-policy'

class MemoryStorage {
  private readonly values = new Map<string, string>()

  get length() {
    return this.values.size
  }

  clear() {
    this.values.clear()
  }

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string) {
    this.values.delete(key)
  }

  setItem(key: string, value: string) {
    this.values.set(key, String(value))
  }
}

const storage = new MemoryStorage()
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { localStorage: storage, sessionStorage: storage },
})

const createProduct = ({
  id = 'product-1',
  availableStock,
  skuId = 'sku-1',
  skuActive = true,
  skuCurrent = true,
}: {
  id?: string
  availableStock: number
  skuId?: string
  skuActive?: boolean
  skuCurrent?: boolean
}): O2oMallProduct => ({
  id,
  productName: `商品 ${id}`,
  defaultPrice: '12.00',
  originalPrice: '12.00',
  discountRate: '10',
  discountedPrice: '12.00',
  availableStock,
  limitPerUser: 0,
  skus: [{
    id: skuId,
    productId: id,
    skuCode: skuId,
    specText: '标准款',
    specValues: {},
    defaultPrice: '12.00',
    originalPrice: '12.00',
    discountRate: '10',
    discountedPrice: '12.00',
    availableStock,
    currentStock: availableStock,
    preOrderedStock: 0,
    isActive: skuActive,
    isCurrent: skuCurrent,
    thumbnail: null,
    sortOrder: 0,
    o2oRecommended: false,
  }],
  thumbnail: null,
  categoryName: null,
  description: null,
  isRecommended: false,
  sortOrder: 0,
})

const createCart = (clientUserId: string) => {
  const pinia = createPinia()
  setActivePinia(pinia)
  const cart = useClientCartStore(pinia)
  cart.initialize(clientUserId)
  return cart
}

storage.clear()
const firstTabCart = createCart('client-1')
const originalCatalogItem = createProduct({ availableStock: 5 })
firstTabCart.addProduct(originalCatalogItem, 5, originalCatalogItem.skus?.[0] ?? null)
firstTabCart.syncWithCatalog([createProduct({ availableStock: 1 })])

assert.equal(firstTabCart.items[0]?.qty, 5, '目录库存从 5 降到 1 时，后台同步不得静默把用户数量减为 1')
assert.equal(firstTabCart.items[0]?.selected, true, '目录库存减少时，后台同步不得取消用户原有勾选')
assert.equal(firstTabCart.selectedCheckoutConflicts.length, 1, '超出可购量的已选商品必须被标记为结算冲突')
assert.equal(firstTabCart.createSelectedCheckoutSnapshot(), null, '含超库存选中行时不得生成部分提交载荷')

firstTabCart.updateQty('sku-1', 4)
assert.equal(firstTabCart.items[0]?.qty, 1, '用户主动改数量时仍应按当前可购量收口，而不是由后台刷新静默改写')
assert.deepEqual(
  firstTabCart.createSelectedCheckoutSnapshot(),
  [{ productId: 'product-1', skuId: 'sku-1', qty: 1 }],
  '用户主动缩量后才允许生成提交快照',
)

const outOfStockCart = createCart('client-out-of-stock')
outOfStockCart.addProduct(originalCatalogItem, 5, originalCatalogItem.skus?.[0] ?? null)
outOfStockCart.syncWithCatalog([createProduct({ availableStock: 0 })])
assert.equal(outOfStockCart.items[0]?.qty, 5, '库存归零时不得删除或改写原选数量')
assert.equal(outOfStockCart.items[0]?.selected, true, '库存归零时不得取消原有勾选')
assert.equal(outOfStockCart.items[0]?.availabilityStatus, 'out_of_stock', '库存归零应显式标记为无库存')

const reloadedCart = createCart('client-out-of-stock')
assert.equal(reloadedCart.items[0]?.qty, 5, '刷新恢复必须保留无库存行的原选数量')
assert.equal(reloadedCart.items[0]?.selected, true, '刷新恢复必须保留无库存行的原有勾选')
assert.equal(reloadedCart.items[0]?.availabilityStatus, 'out_of_stock', '刷新恢复必须保留已知失效状态')

const firstConcurrentTabCart = createCart('client-two-tabs')
firstConcurrentTabCart.addProduct(originalCatalogItem, 5, originalCatalogItem.skus?.[0] ?? null)
const secondTabCart = createCart('client-two-tabs')
secondTabCart.syncWithCatalog([])
assert.equal(firstConcurrentTabCart.items[0]?.qty, 5, '另一 Pinia 实例对账时不得回写第一个标签页的内存购物车')
assert.equal(firstConcurrentTabCart.items[0]?.selected, true, '另一 Pinia 实例对账时不得取消第一个标签页的选择')
assert.equal(secondTabCart.items[0]?.qty, 5, '另一标签页发现目录缺商品时不得删除原选数量')
assert.equal(secondTabCart.items[0]?.availabilityStatus, 'product_unavailable', '目录缺失商品不得继续保留旧库存')
assert.equal(secondTabCart.items[0]?.availableStock, 0, '目录缺失商品必须清空旧库存快照')

const skuUnavailableCart = createCart('client-sku')
const skuProduct = createProduct({ id: 'product-sku', availableStock: 2 })
skuUnavailableCart.addProduct(skuProduct, 2, skuProduct.skus?.[0] ?? null)
skuUnavailableCart.syncWithCatalog([createProduct({ id: 'product-sku', availableStock: 2, skuActive: false })])
assert.equal(skuUnavailableCart.items[0]?.qty, 2, 'SKU 下架时不得删除原选数量')
assert.equal(skuUnavailableCart.items[0]?.availabilityStatus, 'sku_unavailable', 'SKU 下架必须显式标记为不可购买')
assert.equal(skuUnavailableCart.createSelectedCheckoutSnapshot(), null, '选中不可用 SKU 时不得生成部分提交载荷')

const mixedCart = createCart('client-mixed')
const validProduct = createProduct({ id: 'product-valid', skuId: 'sku-valid', availableStock: 2 })
const invalidProduct = createProduct({ id: 'product-invalid', skuId: 'sku-invalid', availableStock: 1 })
mixedCart.addProduct(validProduct, 1, validProduct.skus?.[0] ?? null)
mixedCart.addProduct(invalidProduct, 1, invalidProduct.skus?.[0] ?? null)
mixedCart.syncWithCatalog([validProduct, createProduct({ id: 'product-invalid', skuId: 'sku-invalid', availableStock: 0 })])
assert.equal(mixedCart.createSelectedCheckoutSnapshot(), null, '混合有效/无效的选中商品不得静默只提交有效行')
mixedCart.toggleItemSelected('sku-invalid', false)
assert.deepEqual(
  mixedCart.createSelectedCheckoutSnapshot(),
  [{ productId: 'product-valid', skuId: 'sku-valid', qty: 1 }],
  '用户主动取消无效行勾选后，其他有效商品应可正常结算',
)

const frozenSnapshot = mixedCart.createSelectedCheckoutSnapshot()
mixedCart.syncWithCatalog([createProduct({ id: 'product-valid', skuId: 'sku-valid', availableStock: 0 })])
assert.deepEqual(
  frozenSnapshot,
  [{ productId: 'product-valid', skuId: 'sku-valid', qty: 1 }],
  '已固定的结算请求快照不得被后续目录刷新改写',
)

const pendingCart = createCart('client-pending')
const pendingProduct = createProduct({ id: 'product-pending', skuId: 'sku-pending', availableStock: 1 })
pendingCart.addProduct(pendingProduct, 1, pendingProduct.skus?.[0] ?? null)
const pendingSnapshot = pendingCart.createSelectedCheckoutSnapshot()
assert.ok(pendingSnapshot, '有效商品应能生成首次提交快照')
const pendingIntent = buildClientPreorderSubmitIntentKey({
  clientUserId: 'client-pending',
  clientOrderType: 'walkin',
  isSystemApplied: false,
  pickupContact: '测试用户',
  items: pendingSnapshot,
})
const pendingRequestKey = createClientPreorderSubmitLock('client-pending', pendingIntent)
// 模拟服务端已成功占库存、但首个响应在网络层丢失；目录刷新后本地行应为无库存，
// 而相同冻结意图仍必须命中同一 requestKey，交给服务端幂等层回查原订单。
pendingCart.syncWithCatalog([createProduct({ id: 'product-pending', skuId: 'sku-pending', availableStock: 0 })])
assert.equal(pendingCart.selectedCheckoutConflicts.length, 1, '响应丢失后的目录刷新应显示库存冲突')
assert.equal(
  buildClientPreorderSubmitIntentKey({
    clientUserId: 'client-pending',
    clientOrderType: 'walkin',
    isSystemApplied: false,
    pickupContact: '测试用户',
    items: pendingSnapshot,
  }),
  pendingIntent,
  '冻结的首次提交意图在目录刷新后必须保持不变',
)
assert.equal(
  readActiveClientPreorderSubmitLock('client-pending')?.requestKey,
  pendingRequestKey,
  '完全相同意图必须仍可复用结果未知订单的 requestKey',
)
assert.notEqual(
  buildClientPreorderSubmitIntentKey({
    clientUserId: 'client-pending',
    clientOrderType: 'walkin',
    isSystemApplied: false,
    pickupContact: '测试用户',
    items: [{ productId: 'product-pending', skuId: 'sku-pending', qty: 2 }],
  }),
  pendingIntent,
  '更改数量后的意图不得匹配未决订单 requestKey',
)
clearClientPreorderSubmitLock('client-pending', pendingRequestKey)

const submitItems = [{ productId: 'product-submit', skuId: 'sku-submit', qty: 1 }]
const requestedSubmitIntent = 'requested-intent'
const freshSubmitIntent = requestedSubmitIntent
const assertBlockedDecision = (decision: ReturnType<typeof decideClientCheckoutSubmit>, reason: string) => {
  assert.equal(decision.type, 'blocked', `应阻断提交：${reason}`)
  if (decision.type === 'blocked') {
    assert.equal(decision.reason, reason, `阻断原因应为：${reason}`)
  }
}

assertBlockedDecision(decideClientCheckoutSubmit({
  refreshSucceeded: false,
  requestedItems: submitItems,
  requestedIntentKey: requestedSubmitIntent,
  activeSubmitLock: null,
  selectedConflictCount: 0,
  freshItems: submitItems,
  freshIntentKey: freshSubmitIntent,
}), 'refresh_failed')
assertBlockedDecision(decideClientCheckoutSubmit({
  refreshSucceeded: true,
  requestedItems: submitItems,
  requestedIntentKey: requestedSubmitIntent,
  activeSubmitLock: null,
  selectedConflictCount: 1,
  freshItems: null,
  freshIntentKey: null,
}), 'selected_conflicts')
assert.deepEqual(decideClientCheckoutSubmit({
  refreshSucceeded: true,
  requestedItems: submitItems,
  requestedIntentKey: requestedSubmitIntent,
  activeSubmitLock: { intentKey: requestedSubmitIntent, requestKey: 'original-request-key' },
  selectedConflictCount: 1,
  freshItems: null,
  freshIntentKey: null,
}), {
  type: 'retry_pending',
  items: submitItems,
  intentKey: requestedSubmitIntent,
  requestKey: 'original-request-key',
}, '结果未知且同意图时必须用原 payload 与 requestKey 重试')
assertBlockedDecision(decideClientCheckoutSubmit({
  refreshSucceeded: true,
  requestedItems: submitItems,
  requestedIntentKey: 'changed-intent',
  activeSubmitLock: { intentKey: requestedSubmitIntent, requestKey: 'original-request-key' },
  selectedConflictCount: 0,
  freshItems: submitItems,
  freshIntentKey: freshSubmitIntent,
}), 'pending_intent_changed')
assert.deepEqual(decideClientCheckoutSubmit({
  refreshSucceeded: true,
  requestedItems: submitItems,
  requestedIntentKey: requestedSubmitIntent,
  activeSubmitLock: null,
  selectedConflictCount: 0,
  freshItems: submitItems,
  freshIntentKey: freshSubmitIntent,
}), {
  type: 'new_submit',
  items: submitItems,
  intentKey: freshSubmitIntent,
}, '全新且无冲突的意图应生成最新快照的新提交决策')
assertBlockedDecision(decideClientCheckoutSubmit({
  refreshSucceeded: true,
  requestedItems: submitItems,
  requestedIntentKey: requestedSubmitIntent,
  activeSubmitLock: null,
  selectedConflictCount: 0,
  freshItems: [{ productId: 'product-submit', skuId: 'sku-submit', qty: 2 }],
  freshIntentKey: 'selection-changed-intent',
}), 'selection_changed_after_refresh')

console.log('[verify:client-cart-reconciliation] 购物车目录对账回归验证通过')
