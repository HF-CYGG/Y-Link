/** 文件职责：防止客户端凭证异步导出期间读取已变化的预览 DOM。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createClientVoucherExportSnapshot } from '../src/views/client/client-order-voucher-export'

const dialog = readFileSync(new URL('../src/views/client/components/ClientOrderVoucherDialog.vue', import.meta.url), 'utf8')
const detail = readFileSync(new URL('../src/views/client/ClientOrderDetailView.vue', import.meta.url), 'utf8')

const snapshotCall = detail.indexOf('createClientVoucherExportSnapshot(sourceElement, voucherOrder.value.businessNo)')
const asyncLoad = detail.indexOf('await ensureVoucherUiModulesReady()', snapshotCall)
assert.ok(snapshotCall >= 0 && asyncLoad > snapshotCall, '点击导出时应在异步加载前固定纸面 DOM 和业务号')
assert.match(detail, /sourceElement:\s*exportSnapshot\.sourceElement/, '异步导出应读取固定快照')
assert.match(detail, /filename:\s*exportSnapshot\.filename/, '异步导出应使用点击时固定的业务号文件名')
assert.match(detail, /exportSnapshot\?\.dispose\(\)/, '导出失败或成功都应释放快照')
assert.match(dialog, /:show-close="!exportPdfLoading"/, '导出期间应禁用标题栏关闭')
assert.match(dialog, /:disabled="exportPdfLoading"[^>]*>关闭/, '导出期间应禁用页脚关闭')
assert.match(dialog, /<el-radio-group[^>]*:disabled="exportPdfLoading"/, '导出期间应禁用方向切换')
assert.equal((dialog.match(/:disabled="exportPdfLoading"/g) ?? []).length >= 6, true, '导出期间应禁用四个补填输入、方向和关闭')

const originalDocument = globalThis.document
const host = { style: {} as Record<string, string>, setAttribute: () => {}, appendChild: () => {}, remove: () => {} }
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: { createElement: () => host, body: { appendChild: () => {} } },
})
try {
  const sourceElement = {
    getBoundingClientRect: () => ({ width: 420 }),
    cloneNode: () => ({}),
  } as unknown as HTMLElement
  let releaseLoad: () => void = () => {}
  const moduleLoad = new Promise<void>((resolve) => { releaseLoad = resolve })
  const order = { id: 'same-order-id', businessNo: 'hyyz000001' }
  const exportInFlight = (async () => {
    const snapshot = createClientVoucherExportSnapshot(sourceElement, order.businessNo)
    await moduleLoad
    const filename = snapshot.filename
    snapshot.dispose()
    return filename
  })()
  order.businessNo = 'hyyz000002'
  releaseLoad()
  assert.equal(await exportInFlight, 'hyyz000001-正式出库单.pdf', '同 ID 业务号在异步加载期间变化，不得改写点击时的 PDF 文件名')
} finally {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument })
}
console.log('客户端正式出库单导出竞态验证通过')
