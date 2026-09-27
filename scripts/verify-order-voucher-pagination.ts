/** 文件职责：验证正式出库单在固定纸张高度内为每联独立分片，并给末页保留汇总签字。 */
import assert from 'node:assert/strict'
import * as pagination from '../src/views/order-list/order-voucher-pagination.ts'

assert.equal(typeof pagination.paginateVoucherRows, 'function', '应提供纸张高度驱动的分页函数')
const rows = Array.from({ length: 8 }, (_, index) => ({ key: `row-${index}` }))
const pages = pagination.paginateVoucherRows(rows, {
  paperHeight: 100,
  headerHeight: 20,
  footerHeight: 20,
  rowHeights: Object.fromEntries(rows.map((row) => [row.key, 18])),
})
assert.deepEqual(pages.map((page) => page.map((row) => row.key)), [
  ['row-0', 'row-1', 'row-2', 'row-3'],
  ['row-4', 'row-5', 'row-6'],
  ['row-7'],
], '续页可用正文高度，末页还应保留汇总签字高度')
assert.deepEqual(pagination.paginateVoucherRows([], { paperHeight: 100, headerHeight: 20, footerHeight: 20, rowHeights: {} }), [[]])
const pairedRows = [
  { key: 'a', groupKey: 'a' },
  { key: 'b', groupKey: 'b' },
  { key: 'b-total', groupKey: 'b', keepWithPrevious: true },
]
const pairedPages = pagination.paginateVoucherRows(pairedRows, {
  paperHeight: 100, headerHeight: 20, footerHeight: 20,
  rowHeights: { a: 40, b: 35, 'b-total': 20 },
})
assert.deepEqual(pairedPages.map((page) => page.map((row) => row.key)), [['a'], ['b', 'b-total']], '商品小计不应与最后一条规格拆到不同页')
const footerOverflowPages = pagination.paginateVoucherRows([{ key: 'large-line' }], {
  paperHeight: 100, headerHeight: 20, footerHeight: 30, rowHeights: { 'large-line': 70 },
})
assert.deepEqual(footerOverflowPages.map((page) => page.map((row) => row.key)), [['large-line'], []], '末页单条明细与签字无法同页时，应新增独立汇总签字页')
console.log('正式出库单分页验证通过')
