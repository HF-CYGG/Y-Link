/**
 * 文件说明：Issue #52 客户端购物车目录对账回归验证。
 * 文件职责：以真实 Pinia Store 与浏览器存储替身覆盖库存刷新、缓存恢复和多标签页隔离语义；不访问业务数据库或网络。
 * 维护说明：本脚本只验证购物车本地状态不能在后台目录刷新时静默减量或取消勾选，结算提交拦截由结算页守卫单独覆盖；
 * Issue #97 追加手动输入数量断言：合法值按可购上限收口，非法值（空、非数字、小于 1）不得写入 NaN 或删除商品。
 */

import assert from 'node:assert/strict'

import { createPinia, setActivePinia } from 'pinia'

import type { O2oMallProduct, SubmitO2oPreorderPayload } from '../src/api/modules/o2o'
import { useClientCartStore } from '../src/store/modules/client-cart'
import { resolveUserScopedStorageKey } from '../src/utils/storage-user-scope'
import {
  buildClientPreorderSubmitIntentKey,
  clearClientPreorderSubmitLock,
  createClientPreorderSubmitLock,
  readActiveClientPreorderSubmitLock,
} from '../src/utils/client-preorder-submit-guard'
import { decideClientCheckoutSubmit } from '../src/views/client/client-checkout-submit-policy'

class MemoryStorage {
  private readonly values = new Map<string, string>()
  failOperation: 'get' | 'set' | 'remove' | null = null
  failRemoveKey: string | null = null

  get length() {
    return this.values.size
  }

  clear() {
    this.values.clear()
  }

  getItem(key: string) {
    if (this.failOperation === 'get') throw new DOMException('读取被拒绝', 'SecurityError')
    return this.values.get(key) ?? null
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string) {
    if (this.failOperation === 'remove' && (!this.failRemoveKey || this.failRemoveKey === key)) throw new DOMException('删除被拒绝', 'SecurityError')
    this.values.delete(key)
  }

  setItem(key: string, value: string) {
    if (this.failOperation === 'set') throw new DOMException('存储配额耗尽', 'QuotaExceededError')
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
const pendingPayload: Omit<SubmitO2oPreorderPayload, 'clientRequestId'> = {
  isSystemApplied: false,
  kingdeeVoucherNo: null,
  pickupContact: '测试用户',
  pickupAt: null,
  remark: '  原始备注  \n  保留内部空白  ',
  items: pendingSnapshot,
}
const pendingIntent = buildClientPreorderSubmitIntentKey({
  ...pendingPayload,
  clientUserId: 'client-pending',
  clientOrderType: 'walkin',
})
const pendingRequestKey = createClientPreorderSubmitLock('client-pending', pendingIntent, pendingPayload)
// 模拟服务端已成功占库存、但首个响应在网络层丢失；目录刷新后本地行应为无库存，
// 而相同冻结意图仍必须命中同一 requestKey，交给服务端幂等层回查原订单。
pendingCart.syncWithCatalog([createProduct({ id: 'product-pending', skuId: 'sku-pending', availableStock: 0 })])
assert.equal(pendingCart.selectedCheckoutConflicts.length, 1, '响应丢失后的目录刷新应显示库存冲突')
assert.equal(
  buildClientPreorderSubmitIntentKey({
    ...pendingPayload,
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
const restoredPendingLock = readActiveClientPreorderSubmitLock('client-pending')
assert.ok(restoredPendingLock, '刷新后必须恢复原提交记录')
assert.equal(restoredPendingLock.version, 2, '提交记录必须使用支持精确恢复的版本')
assert.equal(restoredPendingLock.owner, 'client-pending', '原提交记录必须绑定当前账号')
assert.equal(restoredPendingLock.expired, false, '刚创建的原提交必须处于确认期内')
assert.equal(restoredPendingLock.expiresAt - restoredPendingLock.createdAt, 30 * 60 * 1000, '原提交确认期固定为 30 分钟')
assert.deepEqual(restoredPendingLock.payload, { ...pendingPayload, clientRequestId: pendingRequestKey },
  '目录库存归零及刷新恢复不能改写原载荷，包括备注空白、提货信息和显式空值')
assert.throws(() => createClientPreorderSubmitLock('client-pending', 'changed-intent', pendingPayload), /未确认/,
  '未决订单存在时不能通过更换意图或请求键绕过原提交')
assert.notEqual(
  buildClientPreorderSubmitIntentKey({
    ...pendingPayload,
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
const originalSubmitPayload: SubmitO2oPreorderPayload = {
  clientRequestId: 'original-request-key',
  isSystemApplied: true,
  kingdeeVoucherNo: '  KD-Original-AbC  ',
  pickupContact: '原领取教师',
  pickupAt: '2026-11-06T04:00:00.000Z',
  remark: '  第一行  \n 第二行\t原始空白  ',
  items: submitItems,
}
const activeSubmitLock = {
  intentKey: requestedSubmitIntent,
  requestKey: originalSubmitPayload.clientRequestId,
  payload: originalSubmitPayload,
}
const expectedPendingRetry = {
  type: 'retry_pending',
  items: submitItems,
  intentKey: requestedSubmitIntent,
  requestKey: originalSubmitPayload.clientRequestId,
  payload: originalSubmitPayload,
}
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
  activeSubmitLock,
  selectedConflictCount: 1,
  freshItems: null,
  freshIntentKey: null,
}), expectedPendingRetry, '结果未知且同意图时必须返回完整原 payload 与 requestKey，不能只返回商品或重建字段')
assertBlockedDecision(decideClientCheckoutSubmit({
  refreshSucceeded: true,
  requestedItems: submitItems,
  requestedIntentKey: 'changed-intent',
  activeSubmitLock,
  selectedConflictCount: 0,
  freshItems: submitItems,
  freshIntentKey: freshSubmitIntent,
}), 'pending_intent_changed')
assert.deepEqual(decideClientCheckoutSubmit({
  refreshSucceeded: false,
  requestedItems: [{ productId: 'new-cart-product', skuId: 'new-cart-sku', qty: 8 }],
  requestedIntentKey: requestedSubmitIntent,
  activeSubmitLock,
  selectedConflictCount: 1,
  freshItems: null,
  freshIntentKey: null,
}), expectedPendingRetry, '确认原提交不依赖目录刷新成功，也不能采用当前购物车重造原载荷')
for (const unrecoverableLock of [
  { intentKey: requestedSubmitIntent, requestKey: originalSubmitPayload.clientRequestId },
  { ...activeSubmitLock, payload: null },
  { ...activeSubmitLock, expired: true },
  { ...activeSubmitLock, requestKey: 'mismatched-request-key' },
]) {
  assertBlockedDecision(decideClientCheckoutSubmit({
    refreshSucceeded: true,
    requestedItems: submitItems,
    requestedIntentKey: requestedSubmitIntent,
    activeSubmitLock: unrecoverableLock,
    selectedConflictCount: 0,
    freshItems: submitItems,
    freshIntentKey: freshSubmitIntent,
  }), 'pending_unrecoverable')
}
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

// 购物车辅助缓存失败必须保留内存中的最新库存与原选数量；首次 POST 的原提交记录仍必须成功持久化。
const unavailableStorageCart = createCart('client-storage-failure')
unavailableStorageCart.addProduct(originalCatalogItem, 2, originalCatalogItem.skus?.[0] ?? null)
try {
  storage.failOperation = 'set'
  assert.doesNotThrow(() => unavailableStorageCart.syncWithCatalog([createProduct({ availableStock: 3 })]), '配额耗尽不能将已成功的目录同步变成异常')
  assert.equal(unavailableStorageCart.items[0]?.availableStock, 3)
  assert.equal(unavailableStorageCart.items[0]?.qty, 2)
  assert.equal(unavailableStorageCart.items[0]?.selected, true)
  const snapshot = unavailableStorageCart.createSelectedCheckoutSnapshot()
  assert.deepEqual(snapshot, [{ productId: 'product-1', skuId: 'sku-1', qty: 2 }])
  assert.equal(decideClientCheckoutSubmit({
    refreshSucceeded: true,
    requestedItems: snapshot!,
    requestedIntentKey: 'storage-failure-intent',
    activeSubmitLock: null,
    selectedConflictCount: unavailableStorageCart.selectedCheckoutConflicts.length,
    freshItems: snapshot,
    freshIntentKey: 'storage-failure-intent',
  }).type, 'new_submit', '缓存写入失败后仍可用完整内存快照下单')
  assert.doesNotThrow(() => unavailableStorageCart.syncWithCatalog([createProduct({ availableStock: 1 })]))
  assert.equal(unavailableStorageCart.items[0]?.qty, 2)
  assert.equal(unavailableStorageCart.createSelectedCheckoutSnapshot(), null, '缓存降级不能绕过真实库存不足')
  storage.failOperation = 'remove'
  assert.doesNotThrow(() => unavailableStorageCart.syncWithCatalog([createProduct({ availableStock: 3 })]), '历史缓存清理失败也不能阻断目录同步')
  storage.failRemoveKey = 'y-link.client-cart.snapshot:client-storage-failure'
  assert.doesNotThrow(() => unavailableStorageCart.clearSelectedItems(), '空购物车删除缓存失败不能阻断清理内存')
  assert.equal(unavailableStorageCart.items.length, 0)
  assert.doesNotThrow(() => unavailableStorageCart.clearAll(), '退出账号清理缓存失败不能阻断状态重置')
  storage.failOperation = 'get'
  assert.deepEqual(createCart('client-denied-read').items, [], '拒绝读取时使用空内存购物车')
  storage.failOperation = null
  storage.setItem('y-link.client-cart.snapshot:client-corrupt', '{invalid json')
  storage.failOperation = 'remove'
  storage.failRemoveKey = 'y-link.client-cart.snapshot:client-corrupt'
  assert.deepEqual(createCart('client-corrupt').items, [], '损坏缓存且删除受限时也应完成初始化')
  Object.defineProperty(globalThis.window, 'localStorage', {
    configurable: true,
    get() { throw new DOMException('存储访问被禁用', 'SecurityError') },
  })
  const deniedCart = createCart('client-denied-access')
  assert.doesNotThrow(() => deniedCart.addProduct(originalCatalogItem, 1, originalCatalogItem.skus?.[0] ?? null))
  assert.doesNotThrow(() => deniedCart.syncWithCatalog([createProduct({ availableStock: 2 })]))
  assert.equal(deniedCart.createSelectedCheckoutSnapshot()?.[0]?.qty, 1)
  assert.doesNotThrow(() => deniedCart.clearAll())
} finally {
  storage.failOperation = null
  storage.failRemoveKey = null
  Object.defineProperty(globalThis.window, 'localStorage', { configurable: true, value: storage })
}
const restoredWritableCart = createCart('client-storage-recovered')
restoredWritableCart.addProduct(originalCatalogItem, 1, originalCatalogItem.skus?.[0] ?? null)
assert.equal(createCart('client-storage-recovered').items[0]?.qty, 1, '恢复可写后应继续正常持久化与恢复')
assert.equal(createCart('client-other-storage-user').items.length, 0, '降级不得退回共享账号缓存')

// Issue #97：购物车数量支持直接输入，但必须复用 updateQty 的可购上限，且非法输入不能污染或删除购物车行。
const manualQtyCart = createCart('client-manual-qty')
const manualQtyProduct = createProduct({ id: 'product-manual', skuId: 'sku-manual', availableStock: 5 })
manualQtyCart.addProduct(manualQtyProduct, 1, manualQtyProduct.skus?.[0] ?? null)
manualQtyCart.setQtyFromInput('sku-manual', 3)
assert.equal(manualQtyCart.items[0]?.qty, 3, '手动输入可购范围内的数量应直接生效')
manualQtyCart.setQtyFromInput('sku-manual', 99)
assert.equal(manualQtyCart.items[0]?.qty, 5, '手动输入超出可预订库存时必须按上限收口，不能绕过库存限制')
// 小数必须按非法输入拒绝：输入框不再逐字过滤非数字字符，“2.7”会原样送到这里，静默取整与提示文案不符。
manualQtyCart.setQtyFromInput('sku-manual', 2.7)
assert.equal(manualQtyCart.items[0]?.qty, 5, '手动输入小数应按非法输入拒绝并保留原数量')
manualQtyCart.setQtyFromInput('sku-manual', 0)
assert.equal(manualQtyCart.items.length, 1, '手动输入 0 不得被当成删除商品')
assert.equal(manualQtyCart.items[0]?.qty, 5, '手动输入 0 时应保留原数量')
manualQtyCart.setQtyFromInput('sku-manual', null)
manualQtyCart.setQtyFromInput('sku-manual', Number.NaN)
assert.equal(manualQtyCart.items[0]?.qty, 5, '空值或非数字输入不得把数量写成 NaN')
assert.equal(createCart('client-manual-qty').items[0]?.qty, 5, '手动输入后的合法数量应正常持久化恢复')

const limitedQtyCart = createCart('client-manual-limit')
const limitedQtyProduct = { ...createProduct({ id: 'product-limit', skuId: 'sku-limit', availableStock: 10 }), limitPerUser: 3 }
limitedQtyCart.addProduct(limitedQtyProduct, 1, limitedQtyProduct.skus?.[0] ?? null)
limitedQtyCart.setQtyFromInput('sku-limit', 8)
assert.equal(limitedQtyCart.items[0]?.qty, 3, '手动输入超出单人限购时必须按限购上限收口')

// 后端商品库存上限 999999999、单人限购上限 999999，手动输入不得被输入框长度卡在四位以内。
const largeQtyCart = createCart('client-manual-large')
const largeQtyProduct = createProduct({ id: 'product-large', skuId: 'sku-large', availableStock: 120000 })
largeQtyCart.addProduct(largeQtyProduct, 1, largeQtyProduct.skus?.[0] ?? null)
largeQtyCart.setQtyFromInput('sku-large', 100000)
assert.equal(largeQtyCart.items[0]?.qty, 100000, '库存允许时必须支持录入五位以上的合法数量')

// 多规格本次新增量整体提交，失败不得影响已有行或选中态。
const batchCart = createCart('client-batch')
const batchProduct = createProduct({ id: 'batch-product', skuId: 'batch-a', availableStock: 10 })
batchProduct.limitPerUser = 5
batchProduct.skus!.push({ ...batchProduct.skus![0]!, id: 'batch-b' })
assert.deepEqual(batchCart.addProductsBatch(batchProduct, [{ skuId: 'batch-a', qty: 0 }]), {
  ok: true, addedQty: 0, conflicts: [], addedSkus: [],
}, '全零数量不得写入购物车')
assert.equal(batchCart.items.length, 0)
assert.equal(batchCart.addProductsBatch(batchProduct, [{ skuId: 'batch-a', qty: 2 }]).addedQty, 2)
batchCart.toggleItemSelected('batch-a', false)
const batchSuccess = batchCart.addProductsBatch(batchProduct, [
  { skuId: 'batch-a', qty: 1 }, { skuId: 'batch-b', qty: 1 }, { skuId: 'batch-b', qty: 1 },
])
assert.equal(batchSuccess.addedQty, 3, '跨规格共享商品总限购，重复规格累计本次新增量')
assert.deepEqual(batchCart.items.map(({ skuId, qty, selected }) => [skuId, qty, selected]), [
  ['batch-a', 3, false], ['batch-b', 2, true],
])
const batchBefore = JSON.stringify(batchCart.items)
const persistedBatchBefore = storage.getItem(resolveUserScopedStorageKey('y-link.client-cart.snapshot', 'client-batch')!)
assert.ok(persistedBatchBefore, '原车快照应已持久化')
for (const invalidQty of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  const result = batchCart.addProductsBatch(batchProduct, [{ skuId: 'batch-a', qty: invalidQty }])
  assert.equal(result.ok, false)
  assert.equal(result.conflicts[0]?.code, 'invalid_qty')
  assert.equal(JSON.stringify(batchCart.items), batchBefore, '非法数量不得改变原车')
}
for (const badSku of [
  { ...batchProduct.skus![0]!, id: 'missing', productId: 'other-product' },
  { ...batchProduct.skus![0]!, isActive: false },
  { ...batchProduct.skus![0]!, isCurrent: false },
]) {
  const result = batchCart.addProductsBatch({ ...batchProduct, skus: [badSku] }, [{ skuId: badSku.id, qty: 1 }])
  assert.equal(result.ok, false)
  assert.equal(result.conflicts[0]?.code, 'sku_unavailable')
}
const exceededBatch = batchCart.addProductsBatch(batchProduct, [
  { skuId: 'batch-a', qty: 1 }, { skuId: 'batch-b', qty: 1 },
])
assert.equal(exceededBatch.ok, false)
assert.equal(exceededBatch.addedQty, 0)
assert.deepEqual(exceededBatch.addedSkus, [])
assert.equal(JSON.stringify(batchCart.items), batchBefore, '其中一项超量时合法项也不得写入')
assert.equal(storage.getItem(resolveUserScopedStorageKey('y-link.client-cart.snapshot', 'client-batch')!), persistedBatchBefore)
assert.equal(batchCart.addProductsBatch(batchProduct, [{ skuId: 'batch-a', qty: 2 }, { skuId: 'batch-a', qty: 1 }]).ok, false, '重复规格不得绕过含已有量上限')
assert.equal(batchCart.addProductsBatch({ ...batchProduct, skus: [] }, [{ skuId: 'batch-a', qty: 1 }]).ok, false)
const stockConflictProduct = { ...batchProduct, limitPerUser: 0, skus: batchProduct.skus!.map((sku) => ({ ...sku, availableStock: 3 })) }
assert.equal(batchCart.addProductsBatch(stockConflictProduct, [{ skuId: 'batch-a', qty: 1 }]).ok, false, '库存必须包含已有量')
storage.failOperation = 'set'
assert.equal(batchCart.addProductsBatch({ ...batchProduct, limitPerUser: 0 }, [{ skuId: 'batch-a', qty: 1 }]).ok, true, '持久化拒写仍保留内存成功语义')
assert.equal(batchCart.items[0]?.qty, 4)
assert.equal(batchCart.items[0]?.selected, false)
storage.failOperation = null

const sharedLimitCart = createCart('shared-limit')
assert.equal(sharedLimitCart.addProductsBatch(batchProduct, [{ skuId: 'batch-a', qty: 3 }, { skuId: 'batch-b', qty: 3 }]).ok, false, 'A3+B3不能绕过商品限购5')
assert.equal(sharedLimitCart.items.length, 0, '总量超限整批零写入')
assert.equal(sharedLimitCart.addProductsBatch(batchProduct, [{ skuId: 'batch-a', qty: 3 }, { skuId: 'batch-b', qty: 2 }]).ok, true)
assert.equal(sharedLimitCart.addProduct(batchProduct, 1, batchProduct.skus![1]), 0, '普通加购计入其它规格已有量')
sharedLimitCart.setQtyFromInput('batch-b', 4)
assert.equal(sharedLimitCart.items.find((item) => item.skuId === 'batch-b')?.qty, 2, '手输上限同样共享，不能改另一行数量')
const staleLimitCart = createCart('stale-shared-limit')
assert.equal(staleLimitCart.addProductsBatch({ ...batchProduct, limitPerUser: 0 }, [{ skuId: 'batch-a', qty: 3 }, { skuId: 'batch-b', qty: 3 }]).ok, true)
staleLimitCart.syncWithCatalog([batchProduct])
assert.equal(staleLimitCart.totalQty, 6, '目录限购变化不能静默缩量')
assert.equal(staleLimitCart.selectedCheckoutConflicts.length, 2, '已选多规格合计超限必须拦截结算')
staleLimitCart.toggleItemSelected('batch-b', false)
assert.equal(staleLimitCart.selectedCheckoutConflicts.length, 0, '取消其它规格选择后只校验本次结算总量')

const recoveryCart = createCart('confirmed-recovery-quantity')
recoveryCart.addProductsBatch({ ...batchProduct, limitPerUser: 0 }, [{ skuId: 'batch-a', qty: 5 }, { skuId: 'batch-b', qty: 3 }])
recoveryCart.toggleItemSelected('batch-a', false)
recoveryCart.consumeSubmittedItems([{ productId: batchProduct.id, skuId: 'batch-a', qty: 2 }])
assert.deepEqual(recoveryCart.items.map(({ skuId, qty, selected }) => [skuId, qty, selected]), [['batch-a', 3, false], ['batch-b', 3, true]], '确认原2件后保留后加3件及其它SKU')
recoveryCart.consumeSubmittedItems([{ productId: batchProduct.id, skuId: 'batch-a', qty: 8 }])
assert.deepEqual(recoveryCart.items.map(({ skuId, qty }) => [skuId, qty]), [['batch-b', 3]], '消费不产生负数或影响其它SKU')

console.log('[verify:client-cart-reconciliation] 购物车目录对账及存储故障降级回归验证通过')
