/** 文件职责：以可控异步导出核验管理端正式出库单的纸面快照和导出锁定。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const vue = readFileSync(new URL('../src/views/order-list/components/OrderVoucherWorkbenchDialog.vue', import.meta.url), 'utf8')
const script = vue.split('<script setup lang="ts">')[1]?.split('</script>')[0]
assert.ok(script, '应能读取管理端正式出库单脚本')
const source = ts.createSourceFile('OrderVoucherWorkbenchDialog.ts', script, ts.ScriptTarget.Latest, true)

const initializerOf = (name: string) => source.statements
  .filter(ts.isVariableStatement)
  .flatMap((statement) => [...statement.declarationList.declarations])
  .find((declaration) => declaration.name.getText(source) === name)?.initializer?.getText(source)

const snapshotInitializer = initializerOf('createVoucherExportSnapshot')
assert.ok(snapshotInitializer, '管理端应在点击导出时复制已分页纸面')
const exportInitializer = initializerOf('handleExportVoucherPdf')
assert.ok(exportInitializer, '应保留管理端 PDF 导出入口')

const evaluate = <T>(initializer: string, values: Record<string, unknown>): T => {
  const compiled = ts.transpileModule(`const subject = ${initializer}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  return new Function(...Object.keys(values), `${compiled}\nreturn subject`) (...Object.values(values)) as T
}

class FakeElement {
  style: Record<string, string> = {}
  children: FakeElement[] = []
  parent: FakeElement | null = null
  isConnected = true
  textContent = ''
  sheetCount = 2
  constructor(readonly width = 281) {}
  setAttribute() {}
  getBoundingClientRect() { return { width: this.width } }
  appendChild(child: FakeElement) { child.parent = this; this.children.push(child); return child }
  cloneNode() { const copy = new FakeElement(this.width); copy.textContent = this.textContent; return copy }
  querySelectorAll() { return Array.from({ length: this.sheetCount }) }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this)
    this.parent = null
    this.isConnected = false
  }
}

const body = new FakeElement()
const document = { createElement: () => new FakeElement(), body }
const createVoucherExportSnapshot = evaluate<(element: FakeElement) => { sourceElement: FakeElement; dispose: () => void }>(
  snapshotInitializer,
  { document, HTMLElement: FakeElement },
)

const deferred = () => {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

const paginationRevision = { value: 0 }
const readyPaginationRevision = { value: 0 }
const voucherPages = { value: [[{ key: 'old-row' }]] as Array<Array<{ key: string }>> }
const voucherFillerCounts = { value: [0] }
const invalidateInitializer = initializerOf('invalidateVoucherPagination')
const updateInitializer = initializerOf('updateVoucherPages')
assert.ok(invalidateInitializer && updateInitializer, '管理端应维护可失效的实测分页状态')
const invalidateVoucherPagination = evaluate<() => void>(invalidateInitializer, {
  paginationRevision, readyPaginationRevision, voucherPages, voucherFillerCounts,
})
const measuredDocument = new FakeElement()
const pendingTick = deferred()
const currentOrder = { id: 'order-a' }
const updateVoucherPages = evaluate<(pages: Array<Array<{ key: string }>>, fillers: number[]) => Promise<void>>(
  updateInitializer,
  {
    paginationRevision, readyPaginationRevision, voucherPages, voucherFillerCounts,
    props: { order: currentOrder }, voucherOrientation: { value: 'landscape' }, dialogVisible: { value: true },
    voucherPreviewRootRef: { value: { querySelector: () => measuredDocument } },
    nextTick: () => pendingTick.promise, HTMLElement: FakeElement,
  },
)
const staleUpdate = updateVoucherPages([[{ key: 'old-row' }]], [0])
invalidateVoucherPagination()
assert.equal(voucherPages.value.length, 0, '字段变化必须立即撤销旧分页就绪状态')
pendingTick.resolve()
await staleUpdate
assert.equal(voucherPages.value.length, 0, '旧测量回调不得恢复已失效的分页')
measuredDocument.sheetCount = 4
await updateVoucherPages([[{ key: 'new-row-1' }], [{ key: 'new-row-2' }]], [0, 0])
assert.equal(voucherPages.value.length, 2, '两联 DOM 完成渲染后才接受新分页')
assert.equal(readyPaginationRevision.value, paginationRevision.value)

const scenario = () => {
  const original = new FakeElement()
  original.textContent = '已测量的第一联与第二联'
  const pending = deferred()
  const calls: Array<{ sourceElement: FakeElement; filename: string; orientation: string }> = []
  const errors: string[] = []
  const successes: string[] = []
  const exportPdfLoading = { value: false }
  const voucherOrientation = { value: 'landscape' }
  const props = { modelValue: true, enableHtml2pdfExport: true, order: { id: 'order-a', businessNo: 'TEST-001' } }
  const handler = evaluate<() => Promise<void>>(exportInitializer, {
    props,
    voucherPages: { value: [[{ key: 'row-1' }]] },
    isVoucherPaginationReady: { value: true },
    dialogVisible: { value: true },
    voucherOrientation,
    voucherPreviewRootRef: { value: { querySelector: () => original } },
    exportPdfLoading,
    HTMLElement: FakeElement,
    createVoucherExportSnapshot,
    exportVoucherPdf: (options: { sourceElement: FakeElement; filename: string; orientation: string }) => {
      calls.push(options)
      return pending.promise
    },
    showAppWarning: (message: string) => errors.push(message),
    showAppInfo: (message: string) => errors.push(message),
    showAppError: (message: string) => errors.push(message),
    showAppSuccess: (message: string) => successes.push(message),
    extractErrorMessage: (error: Error) => error.message,
    document,
  })
  return { original, pending, calls, errors, successes, exportPdfLoading, voucherOrientation, props, handler }
}

const success = scenario()
const successRun = success.handler()
assert.equal(success.exportPdfLoading.value, true, '点击导出后应立即锁定编辑状态')
await success.handler()
assert.equal(success.calls.length, 1, '导出中不得重复启动第二次导出')
assert.equal(success.calls[0]?.sourceElement.textContent, '已测量的第一联与第二联')
success.original.textContent = '异步等待期间改变的预览'
success.voucherOrientation.value = 'portrait'
success.props.order.businessNo = 'TEST-002'
assert.equal(success.calls[0]?.sourceElement.textContent, '已测量的第一联与第二联', 'PDF 必须读取点击时的纸面快照')
assert.equal(success.calls[0]?.filename, 'TEST-001-正式出库单.pdf', '文件名应固定为点击时的订单')
assert.equal(success.calls[0]?.orientation, 'landscape', '方向应固定为点击时的方向')
success.pending.resolve()
await successRun
assert.equal(body.children.length, 0, '成功后应释放离屏纸面')
assert.equal(success.exportPdfLoading.value, false, '成功后应恢复编辑状态')

const failed = scenario()
const failedRun = failed.handler()
failed.pending.reject(new Error('模拟导出失败'))
await failedRun
assert.equal(body.children.length, 0, '失败后也应释放离屏纸面')
assert.equal(failed.exportPdfLoading.value, false, '失败后应恢复编辑状态')
assert.deepEqual(failed.errors, ['模拟导出失败'])

assert.match(vue, /watch\(voucherEditableForm,[\s\S]*?flush:\s*'sync'/, '补填变化应同步使分页失效')
assert.match(vue, /watch\(voucherOrientation,[\s\S]*?flush:\s*'sync'/, '方向变化应同步使分页失效')
assert.match(vue, /:show-close="!exportPdfLoading"/, '导出期间应锁标题栏关闭')
assert.match(vue, /:close-on-click-modal="!exportPdfLoading"/, '导出期间应锁遮罩关闭')
assert.match(vue, /:close-on-press-escape="!exportPdfLoading"/, '导出期间应锁 Escape 关闭')
assert.match(vue, /<el-radio-group[^>]*:disabled="exportPdfLoading"/, '导出期间应锁页面方向')
assert.equal((vue.match(/<el-input[\s\S]*?:disabled="exportPdfLoading"/g) ?? []).length >= 4, true, '导出期间应锁四个补填输入')
assert.match(vue, /<el-button[^>]*:disabled="exportPdfLoading"[^>]*>关闭/, '导出期间应锁页脚关闭')
assert.match(vue, /<el-button[^>]*:disabled="exportPdfLoading\s*\|\|[^>]*"[^>]*>打印/, '导出期间应锁打印')

// 直接执行生产导出函数，验证字体测量样式只活在本次捕获期，等待字体且失败也清理。
const pdfTool = readFileSync(new URL('../src/utils/pdf/export-voucher-pdf.ts', import.meta.url), 'utf8')
const pdfSource = ts.createSourceFile('export-voucher-pdf.ts', pdfTool, ts.ScriptTarget.Latest, true)
const pdfInitializer = pdfSource.statements.filter(ts.isVariableStatement)
  .flatMap((statement) => [...statement.declarationList.declarations])
  .find((declaration) => declaration.name.getText(pdfSource) === 'exportVoucherPdf')?.initializer?.getText(pdfSource)
assert.ok(pdfInitializer)
for (const failure of [false, true]) {
  const fontsReady = deferred(), capture = deferred()
  const styles: Array<{ dataset: Record<string, string>; textContent: string; remove: () => void }> = []
  const captureDocument = {
    createElement: () => { const node = { dataset: {} as Record<string, string>, textContent: '', remove: () => { styles.splice(styles.indexOf(node), 1) } }; return node },
    head: { appendChild: (node: typeof styles[number]) => styles.push(node) },
    fonts: { ready: fontsReady.promise },
  }
  const frozenPaper = { ownerDocument: captureDocument }
  const calls: Array<{ options: Record<string, any>; source?: unknown; filename?: string }> = []
  const factory = () => {
    const call = { options: {} } as typeof calls[number]; calls.push(call)
    const worker = { set: (options: Record<string, any>) => { call.options = options; return worker }, from: (source: unknown) => { call.source = source; return worker }, save: (filename: string) => { call.filename = filename; return capture.promise } }
    return worker
  }
  const actualExport = evaluate<(options: unknown) => Promise<void>>(pdfInitializer, { resolveHtml2PdfFactory: async () => factory })
  const run = actualExport({ sourceElement: frozenPaper, filename: '两联.pdf', orientation: 'landscape' })
  await Promise.resolve(); await Promise.resolve()
  assert.equal(styles.length, 1, '字体等待期间已安装独立的测量样式')
  assert.match(styles[0]!.textContent, /body > div\[style\*="visibility: hidden"\]\[style\*="font-family:"\] > img/, '只能影响隐藏字体测量图片，不能覆盖凭证或全站业务图片')
  assert.equal(calls.length, 0, '字体尚未就绪不能开始捕获')
  fontsReady.resolve(); await Promise.resolve(); await Promise.resolve()
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.source, frozenPaper, '继续使用调用方冻结的纸面')
  assert.equal(calls[0]!.options.margin, 8); assert.equal(calls[0]!.options.html2canvas.scale, 2)
  assert.equal(calls[0]!.options.jsPDF.orientation, 'landscape')
  assert.deepEqual(calls[0]!.options.pagebreak.mode, ['css', 'legacy'])
  if (failure) { capture.reject(new Error('捕获失败')); await assert.rejects(run, /捕获失败/) }
  else { capture.resolve(); await run }
  assert.equal(styles.length, 0, '成功或失败都必须释放本次测量样式')
}

console.log('管理端正式出库单导出竞态验证通过')
