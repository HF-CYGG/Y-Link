/** 文件职责：验证正式出库单只读聚合、历史快照与金额安全边界。 */
import assert from 'node:assert/strict'
import { aggregateOrderVoucherItems } from '../src/views/order-list/order-voucher-aggregation.ts'

const source = [
  { id: 'red', productId: 'p-1', skuId: 'sku-red', productName: '帆布包（红色）', specText: '红色', qty: '2.00', unitPrice: '10.00', subTotal: '20.00', remark: '红色款' },
  { id: 'blue', productId: 'p-1', skuId: 'sku-blue', productName: '帆布包（蓝色）', specText: '蓝色', qty: '3.00', unitPrice: '15.00', subTotal: '45.00', remark: '蓝色款' },
  { id: 'same-name', productId: 'p-2', productName: '帆布包（红色）', specText: '红色', qty: '1.00', unitPrice: '8.00', subTotal: '8.00', remark: null },
] as const
const sourceSnapshot = structuredClone(source)
const grouped = aggregateOrderVoucherItems(source)
assert.deepEqual(source, sourceSnapshot, '展示聚合不能修改原始明细')
assert.equal(grouped.length, 2, '不同 SKU 的同商品应归一组，同名不同商品仍独立')
assert.equal(grouped[0]?.productName, '帆布包', '只精确拆除末尾匹配的规格快照')
assert.equal(grouped[0]?.qty, '5', '数量不应有无意义的末尾零')
assert.equal(grouped[0]?.subTotal, '65.00', '组金额应累加原始明细小计')
assert.deepEqual(grouped[0]?.details.map((item) => [item.specText, item.qty, item.unitPrice, item.subTotal, item.remark]), [
  ['红色', '2', '10.00', '20.00', '红色款'],
  ['蓝色', '3', '15.00', '45.00', '蓝色款'],
], '组内各规格、单价、金额和备注应可逐项核对')
assert.equal(grouped[1]?.productName, '帆布包')

const repeatedRemark = '需按班级分发。'.repeat(40)
const sameSku = aggregateOrderVoucherItems([
  { productId: 'p-repeat', skuId: 'sku-a', productName: '练习本（A5）', specText: 'A5', qty: '1.00', unitPrice: '2.00', subTotal: '2.00', remark: repeatedRemark },
  { productId: 'p-repeat', skuId: 'sku-a', productName: '练习本（A5）', specText: 'A5', qty: '2.00', unitPrice: '2.00', subTotal: '4.00', remark: repeatedRemark },
  { productId: 'p-repeat', skuId: 'sku-a', productName: '练习本（A5）', specText: 'A5', qty: '1.00', unitPrice: '3.00', subTotal: '3.00', remark: '加急' },
])
assert.equal(sameSku[0]?.details.length, 2, '相同 SKU/规格/价格/备注的重复行应合并')
assert.equal(sameSku[0]?.details[0]?.qty, '3')
assert.equal(sameSku[0]?.details[0]?.subTotal, '6.00')
assert.equal(sameSku[0]?.details[0]?.remark, repeatedRemark, '长备注只保留一次，不截断')
assert.equal(sameSku[0]?.details[1]?.unitPrice, '3.00', '不同价格仍逐项展示')

const names = aggregateOrderVoucherItems([
  { id: 'a', productId: 'p-3', productName: '笔记本（A5）限定版', specText: 'A5', qty: '0.10', unitPrice: '0.10', subTotal: '0.01' },
  { id: 'b', productId: 'p-3', productName: '笔记本（B5）', specText: 'B5', qty: '0.20', unitPrice: '0.10', subTotal: '0.02' },
  { id: 'c', productId: 'p-3', productName: '笔记本（默认）', specText: '默认', qty: '0.30', unitPrice: '0.10', subTotal: '0.03' },
])
assert.equal(names[0]?.productName, '笔记本（A5）限定版 / 笔记本')
assert.equal(names[0]?.qty, '0.6', '小数数量应精确累加后去掉末尾零')
assert.equal(names[0]?.subTotal, '0.06', '不得用单价乘数量重算金额')
assert.equal(names[0]?.details[0]?.nameSnapshot, '笔记本（A5）限定版')

const malformed = aggregateOrderVoucherItems([
  { id: 'missing-one', productId: '', productName: 'undefined', qty: 'bad', unitPrice: '', subTotal: 'bad', remark: 'undefined' },
  { id: 'missing-two', productId: null, productName: '', qty: null, unitPrice: 'NaN', subTotal: undefined },
])
assert.equal(malformed.length, 2, '缺 productId 的历史明细逐条独立')
for (const item of malformed) {
  assert.equal(item.productName, '未记录商品名称')
  assert.equal(item.qty, '—')
  assert.equal(item.subTotal, '—')
  assert.equal(item.details[0]?.unitPrice, '—')
  assert.equal(item.details[0]?.specText, null, '无规格快照的历史商品按普通数量展示')
  assert.equal(item.details[0]?.remark, null)
}

const mixed = aggregateOrderVoucherItems([
  { productId: 'p-4', productName: '异常商品', qty: '1', unitPrice: '9.90', subTotal: '9.90' },
  { productId: 'p-4', productName: '异常商品', qty: '1.005', unitPrice: '', subTotal: '1.005' },
])
assert.equal(mixed[0]?.qty, '—', '混合异常数量不能显示部分合计')
assert.equal(mixed[0]?.subTotal, '—', '混合异常金额不能显示部分合计')
assert.equal(mixed[0]?.details[0]?.subTotal, '9.90')
assert.equal(mixed[0]?.details[1]?.subTotal, '—')

const maximum = '90071992547409.91'
const edge = aggregateOrderVoucherItems([{ productId: 'edge', qty: maximum, unitPrice: '1', subTotal: maximum }])
assert.equal(edge[0]?.qty, maximum)
assert.equal(edge[0]?.subTotal, maximum)
const overflow = aggregateOrderVoucherItems([
  { productId: 'edge', qty: maximum, unitPrice: '1', subTotal: maximum },
  { productId: 'edge', qty: '0.01', unitPrice: '1', subTotal: '0.01' },
])
assert.equal(overflow[0]?.qty, '—')
assert.equal(overflow[0]?.subTotal, '—')
assert.deepEqual(aggregateOrderVoucherItems([]), [])
console.log('正式出库单展示聚合验证通过')
