/** 出库开单扫码纯规则回归：候选守卫、空白行复用与重复 SKU 的人工价格保护。 */
import assert from 'node:assert/strict'
import { effectScope, reactive, ref } from 'vue'
import type { ProductRecord } from '@/api/modules/product'
import type { ProductLookupResult } from '@/api/modules/inventory'
import type { OrderItemRow } from './types'
import { addScannedSkuToOrderRows } from './scan-order-entry'
import { watchScanUserScope } from './scan-user-scope'

const candidate = {
  id: 'product-1', productName: '测试商品', isActive: true,
  skus: [{ id: 'sku-1', skuCode: 'WC01001', isCurrent: true, isActive: true, defaultPrice: '12.50' }],
} as ProductRecord
const lookup = {
  product: { id: 'product-1', productName: '测试商品', isActive: true },
  sku: { id: 'sku-1', isCurrent: true, isActive: true },
} as ProductLookupResult
let sequence = 0
const uid = () => `scan-${++sequence}`
const row = (uidValue: string, changes: Partial<OrderItemRow> = {}): OrderItemRow => ({
  uid: uidValue, productId: '', skuId: '', qty: null, unitPrice: null, remark: '', ...changes,
})
const scan = (rows: OrderItemRow[], products = [candidate], result = lookup) =>
  addScannedSkuToOrderRows(rows, products, result, uid)

const first = scan([])
assert.equal(first.error, null)
assert.deepEqual(first.rows?.map(({ productId, skuId, qty, unitPrice, remark }) => ({ productId, skuId, qty, unitPrice, remark })), [
  { productId: 'product-1', skuId: 'sku-1', qty: 1, unitPrice: 12.5, remark: '' },
])

const blank = row('blank')
const reused = scan([blank])
assert.equal(reused.rows?.length, 1)
assert.equal(reused.rowUid, 'blank', '首扫应复用完全空白行')
assert.equal(blank.productId, '', '规则计算不得提前修改原草稿')
const partial = scan([row('partial', { remark: '人工备注' })])
assert.equal(partial.rows?.length, 2, '有人工内容的行不能被当成空白行覆盖')

const manual = row('manual', { productId: 'product-1', skuId: 'sku-1', qty: 2, unitPrice: 9.9, remark: '特价' })
const once = scan([manual])
assert.equal(once.rows?.[0]?.qty, 3)
assert.equal(once.rows?.[0]?.unitPrice, 9.9)
assert.equal(once.rows?.[0]?.remark, '特价')
assert.equal(manual.qty, 2, '连扫不能原地修改共享测试输入')
const twice = scan(once.rows!)
assert.equal(twice.rows?.[0]?.qty, 4, '连续扫码同规格逐次累加')

const ambiguous = [manual, row('other-manual', { productId: 'product-1', skuId: 'sku-1', qty: 1, unitPrice: 8, remark: '赠品价' })]
const separate = scan(ambiguous)
assert.equal(separate.rows?.length, 3, '多个人工行时应新增默认价行')
assert.equal(separate.rows?.[2]?.unitPrice, 12.5)
assert.equal(separate.rows?.[0]?.qty, 2)
const defaultLine = row('default', { productId: 'product-1', skuId: 'sku-1', qty: 1, unitPrice: 12.5, remark: '' })
const specific = scan([...ambiguous, defaultLine])
assert.equal(specific.rows?.length, 3)
assert.equal(specific.rows?.[2]?.qty, 2, '多行时只复用唯一明确的默认价普通行')
const twoDefaults = scan([...ambiguous, defaultLine, row('default-2', { ...defaultLine, uid: 'default-2' })])
assert.equal(twoDefaults.rows?.length, 5, '多个普通行也有歧义，应新增默认价行')

for (const invalid of [
  { products: [], result: lookup },
  { products: [candidate], result: { ...lookup, product: { ...lookup.product, isActive: false } } },
  { products: [candidate], result: { ...lookup, sku: { ...lookup.sku, isActive: false } } },
  { products: [candidate], result: { ...lookup, sku: { ...lookup.sku, isCurrent: false } } },
  { products: [candidate], result: { ...lookup, sku: { ...lookup.sku, id: 'retired' } } },
]) {
  const rejected = scan([row('keep')], invalid.products, invalid.result as ProductLookupResult)
  assert.ok(rejected.error, '失效或未知候选必须可读拒绝')
  assert.equal(rejected.rows, null)
}

const account = reactive<{ userId: string | undefined }>({ userId: 'operator-a' })
const manualCode = ref('WC03001')
const scanStatus = ref('已加入上一账号的商品')
const oldTickets = new Map([['queued', { userId: 'operator-a' }]])
let epoch = 0
const scope = effectScope()
scope.run(() => watchScanUserScope(() => account.userId, {
  manualCode,
  scanStatus,
  tickets: oldTickets,
  invalidate: () => { epoch += 1 },
}))
account.userId = 'operator-b'
assert.equal(manualCode.value, '', '切换账号须同步清空尚未提交的条码')
assert.equal(scanStatus.value, '', '切换账号须同步清空旧账号反馈')
assert.equal(oldTickets.size, 0, '旧账号排队扫码不能流入新草稿')
assert.equal(epoch, 1, '正在查询的旧票据也应因代次变化失效')
account.userId = 'operator-b'
assert.equal(epoch, 1, '同一账号的状态更新不应误清理扫码')
scope.stop()

console.log('[verify:order-entry-scan] 入单规则与失效候选回归通过')
