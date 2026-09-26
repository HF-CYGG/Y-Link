/** 文件职责：防止客户端凭证异步导出期间读取已变化的预览 DOM。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const dialog = readFileSync(new URL('../src/views/client/components/ClientOrderVoucherDialog.vue', import.meta.url), 'utf8')
const detail = readFileSync(new URL('../src/views/client/ClientOrderDetailView.vue', import.meta.url), 'utf8')

assert.match(detail, /createClientVoucherExportSnapshot\(sourceElement\)/, '点击导出时应立即固定纸面 DOM')
assert.match(detail, /sourceElement:\s*exportSnapshot\.sourceElement/, '异步导出应读取固定快照')
assert.match(detail, /exportSnapshot\?\.dispose\(\)/, '导出失败或成功都应释放快照')
assert.match(dialog, /:show-close="!exportPdfLoading"/, '导出期间应禁用标题栏关闭')
assert.match(dialog, /:disabled="exportPdfLoading"[^>]*>关闭/, '导出期间应禁用页脚关闭')
assert.match(dialog, /<el-radio-group[^>]*:disabled="exportPdfLoading"/, '导出期间应禁用方向切换')
assert.equal((dialog.match(/:disabled="exportPdfLoading"/g) ?? []).length >= 6, true, '导出期间应禁用四个补填输入、方向和关闭')
console.log('客户端正式出库单导出竞态验证通过')
