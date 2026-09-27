/** 文件职责：核验客户端预览、打印和 PDF 共用已测量的正式出库单分页。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { paginateVoucherRows } from '../src/views/order-list/order-voucher-pagination.ts'

const dialog = readFileSync(new URL('../src/views/client/components/ClientOrderVoucherDialog.vue', import.meta.url), 'utf8')
const detail = readFileSync(new URL('../src/views/client/ClientOrderDetailView.vue', import.meta.url), 'utf8')

const rows = Array.from({ length: 24 }, (_, index) => ({ key: `line-${index}` }))
const pages = paginateVoucherRows(rows, {
  paperHeight: 100,
  headerHeight: 20,
  footerHeight: 30,
  rowHeights: Object.fromEntries(rows.map((row) => [row.key, 18])),
})
assert.ok(pages.length > 1, '长单应有续页')
assert.match(dialog, /@pages-change="[^\"]+"/, '客户端可见预览应上报实测分页')
assert.match(detail, /:pages="voucherPages"/, '隐藏打印模板应复用可见预览分页')
assert.match(detail, /:page-filler-counts="voucherFillerCounts"/, '隐藏打印模板应复用补空行数量')
assert.match(detail, /:measure-pages="false"/, '隐藏打印模板不应在 display:none 中重新测量')
assert.match(dialog, /共\s*\{\{\s*pageCount\b/, '页数文案应基于实测分页')
assert.doesNotMatch(detail, /voucherPrintRootRef\.value\?\.querySelector\('\.voucher-print-document'\)/, 'PDF 不应从隐藏打印节点生成')
console.log('客户端正式出库单分页链路验证通过')
