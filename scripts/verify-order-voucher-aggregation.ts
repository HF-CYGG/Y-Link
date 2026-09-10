/**
 * 文件职责：用固定 DTO 回归正式出库单的展示聚合规则，不连接后端或业务数据。
 */

import assert from 'node:assert/strict'
import { aggregateOrderVoucherItems } from '../src/views/order-list/order-voucher-aggregation.ts'

const aggregated = aggregateOrderVoucherItems([
  {
    id: 'line-red',
    productId: 'product-1',
    productCode: 'P-001',
    productName: '帆布包（红色）',
    qty: '2.00',
    unitPrice: '10.00',
    subTotal: '20.00',
    remark: '红色款',
  },
  {
    id: 'line-blue',
    productId: 'product-1',
    productCode: 'P-001',
    productName: '帆布包（蓝色）',
    qty: '3.00',
    unitPrice: '15.00',
    subTotal: '45.00',
    remark: '蓝色款',
  },
  {
    id: 'same-name-other-product',
    productId: 'product-2',
    productCode: 'P-002',
    productName: '帆布包（红色）',
    qty: '1.00',
    unitPrice: '8.00',
    subTotal: '8.00',
    remark: null,
  },
])

assert.equal(aggregated.length, 2, '同一 productId 应聚合，不同 productId 即使同名也不能合并')
assert.deepEqual(aggregated[0], {
  key: 'product:product-1',
  productName: '帆布包（红色） / 帆布包（蓝色）',
  qty: '5.00',
  unitPrice: '多价',
  subTotal: '65.00',
  remark: '红色款；蓝色款',
})
assert.equal(aggregated[1]?.qty, '1.00')
assert.equal(aggregated[1]?.subTotal, '8.00')

const samePrice = aggregateOrderVoucherItems([
  {
    id: 'line-one',
    productId: 'product-3',
    productCode: 'P-003',
    productName: '笔记本（A5）',
    qty: '0.10',
    unitPrice: '0.10',
    subTotal: '0.01',
    remark: '长备注'.repeat(80),
  },
  {
    id: 'line-two',
    productId: 'product-3',
    productCode: 'P-003',
    productName: '笔记本（B5）',
    qty: '0.20',
    unitPrice: '0.10',
    subTotal: '0.02',
    remark: '长备注'.repeat(80),
  },
  {
    id: 'line-three',
    productId: 'product-3',
    productCode: 'P-003',
    productName: '笔记本（A5）',
    qty: '0.30',
    unitPrice: '0.10',
    subTotal: '0.03',
    remark: '补充说明',
  },
])

assert.equal(samePrice.length, 1)
assert.equal(samePrice[0]?.qty, '0.60', '数量聚合不能受 0.1 + 0.2 浮点误差影响')
assert.equal(samePrice[0]?.unitPrice, '0.10', '相同单价应保留原单价')
assert.equal(samePrice[0]?.subTotal, '0.06', '金额必须逐行相加，不能由单价乘数量重算')
assert.equal(samePrice[0]?.remark, `${'长备注'.repeat(80)}；补充说明`, '不同备注必须完整保留，重复备注可去重')

const malformed = aggregateOrderVoucherItems([
  {
    id: 'missing-id-one',
    productId: '',
    productCode: '',
    productName: 'undefined',
    qty: 'not-a-number',
    unitPrice: '',
    subTotal: 'bad',
    remark: 'undefined',
  },
  {
    id: 'missing-id-two',
    productId: null,
    productCode: '',
    productName: '',
    qty: null,
    unitPrice: 'NaN',
    subTotal: undefined,
    remark: null,
  },
])

assert.equal(malformed.length, 2, '缺失 productId 的历史行必须逐行保留，不能错误合并')
for (const item of malformed) {
  assert.equal(item.productName, '未记录商品名称')
  assert.equal(item.qty, '—')
  assert.equal(item.unitPrice, '—', '无效单价不能伪造成 0.00')
  assert.equal(item.subTotal, '—')
  assert.equal(item.remark, null)
  assert.equal(item.key.startsWith('item:'), true)
}

assert.deepEqual(aggregateOrderVoucherItems([]), [], '空明细必须稳定输出空行集')

const mixedInput = [
  {
    id: 'valid-row',
    productId: 'product-4',
    productName: '混合异常商品',
    qty: '1.00',
    unitPrice: '9.90',
    subTotal: '9.90',
    remark: '有效备注',
  },
  {
    id: 'invalid-row',
    productId: 'product-4',
    productName: '混合异常商品（历史规格）',
    qty: '1.005',
    unitPrice: '',
    subTotal: '1.005',
    remark: '异常行备注',
  },
] as const
const mixedInputSnapshot = structuredClone(mixedInput)
const mixed = aggregateOrderVoucherItems(mixedInput)

assert.deepEqual(mixedInput, mixedInputSnapshot, '聚合不能修改原始订单明细')
assert.deepEqual(mixed[0], {
  key: 'product:product-4',
  productName: '混合异常商品 / 混合异常商品（历史规格）',
  qty: '—',
  unitPrice: '—',
  subTotal: '—',
  remark: '有效备注；异常行备注',
}, '混合合法与非法字段时不能拼出不可信的数量、单价或金额')

const safeIntegerLimit = '90071992547409.91'
const safeIntegerFormattingEdge = '90071992547409.90'
const safeIntegerEdge = aggregateOrderVoucherItems([
  {
    id: 'safe-integer-edge',
    productId: 'product-safe-integer-edge',
    productName: '安全整数边界商品',
    qty: safeIntegerFormattingEdge,
    unitPrice: '1.00',
    subTotal: safeIntegerFormattingEdge,
    remark: null,
  },
])

assert.equal(safeIntegerEdge[0]?.qty, safeIntegerFormattingEdge, '最大安全分值的数量必须保留到最后一分')
assert.equal(safeIntegerEdge[0]?.subTotal, safeIntegerFormattingEdge, '最大安全分值的金额必须保留到最后一分')

const overflow = aggregateOrderVoucherItems([
  {
    id: 'overflow-one',
    productId: 'product-overflow',
    productName: '超界商品',
    qty: safeIntegerLimit,
    unitPrice: '1.00',
    subTotal: safeIntegerLimit,
    remark: null,
  },
  {
    id: 'overflow-two',
    productId: 'product-overflow',
    productName: '超界商品',
    qty: safeIntegerLimit,
    unitPrice: '1.00',
    subTotal: safeIntegerLimit,
    remark: null,
  },
])

assert.equal(overflow[0]?.qty, '—', '累计数量越过安全整数范围时必须显式占位')
assert.equal(overflow[0]?.subTotal, '—', '累计金额越过安全整数范围时必须显式占位')
assert.equal(overflow[0]?.unitPrice, '1.00')

console.log('正式出库单展示聚合验证通过')
