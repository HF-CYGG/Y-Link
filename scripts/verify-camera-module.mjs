/** 执行真实扫码composable，受控模块边界验证12格式、并发重试与会话清理；真实解码另由compiled浏览器验收。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as Vue from 'vue'

const source = fs.readFileSync('src/composables/useCameraQrScanner.ts', 'utf8')
const ast = ts.createSourceFile('scanner.ts', source, ts.ScriptTarget.Latest, true)
let replacedImports = 0
const transformed = ts.transform(ast, [(context) => {
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0]?.text === '@/utils/html5-qrcode-module') {
      replacedImports += 1
      return ts.factory.createCallExpression(ts.factory.createIdentifier('__loadScannerModule'), undefined, [])
    }
    return ts.visitEachChild(node, visit, context)
  }
  return (node) => ts.visitNode(node, visit)
}])
assert.equal(replacedImports, 1, '只替换真实模块加载边界，不替换composable逻辑')
const compiled = ts.transpileModule(ts.createPrinter().printFile(transformed.transformed[0]), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
transformed.dispose()
const core = {}
vm.runInNewContext(ts.transpileModule(fs.readFileSync('node_modules/html5-qrcode/esm/core.js', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: core })
const formats = core.Html5QrcodeSupportedFormats
const sourceFormats = ['qr_code', 'code_128', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_39', 'itf', 'codabar', 'pdf_417', 'data_matrix', 'aztec']
const expectedFormats = ['QR_CODE', 'CODE_128', 'EAN_13', 'EAN_8', 'UPC_A', 'UPC_E', 'CODE_39', 'ITF', 'CODABAR', 'PDF_417', 'DATA_MATRIX', 'AZTEC'].map((name) => formats[name])
let imports = 0, failLoad = false, failStart = false, unmount
const instances = [], warnings = [], detected = [], host = []
class ScannerBoundary {
  constructor(id, config) { this.id = id; this.config = config; this.isScanning = false; this.stopped = 0; this.cleared = 0; instances.push(this) }
  async start(camera, config, success) {
    this.camera = camera; this.scanConfig = config; this.success = success
    if (failStart) throw new Error('camera permission denied')
    this.isScanning = true
  }
  async stop() { this.stopped += 1; this.isScanning = false }
  clear() { this.cleared += 1 }
  async scanFile(file, showImage) { assert.equal(showImage, false); return file.decoded }
}
const module = { Html5Qrcode: ScannerBoundary, Html5QrcodeSupportedFormats: formats }
// closeScanDialog同步返回；跨VM await stop的续体不由Vue.nextTick完成，等一轮事件循环再检查清理。
const settleCleanup = () => new Promise((resolve) => setImmediate(resolve))
const exports = {}
vm.runInNewContext(compiled, {
  exports, Error,
  require(name) {
    if (name === 'vue') return { ...Vue, onBeforeUnmount: (callback) => { unmount = callback } }
    if (name === '@/utils/app-alert') return { showAppWarning: (message) => warnings.push(message), showAppError: (message) => warnings.push(message) }
    throw new Error(`意外运行依赖：${name}`)
  },
  __loadScannerModule: async () => { imports += 1; if (failLoad) throw new Error('受控加载失败'); return module },
  navigator: { mediaDevices: { getUserMedia() {} } }, isSecureContext: true,
  FileReader: class {}, matchMedia: () => ({ matches: false }),
  document: { createElement: () => ({ style: {}, remove() { host.splice(host.indexOf(this), 1) } }), body: { append: (element) => host.push(element) } },
})
const create = (formatList = sourceFormats) => {
  const state = exports.useCameraQrScanner({ formats: formatList, normalizeCode: (value) => value.trim(), onDetected: async (value) => detected.push(value) })
  state.bindScannerContainer({ id: '' })
  return state
}
const first = create(), second = create()
failLoad = true
await Promise.all([first.openScanDialog(), second.openScanDialog()])
assert.equal(imports, 1, '并发首次失败只能加载一次')
assert.equal(instances.length, 0)
assert.ok(warnings.every((message) => /扫码库加载失败/.test(message)))
failLoad = false
await Promise.all([first.openScanDialog(), second.openScanDialog()])
assert.equal(imports, 2, '失败后应可重新加载且并发共享')
assert.equal(instances.length, 2)
assert.notEqual(instances[0], instances[1])
for (const instance of instances) {
  assert.deepEqual([...instance.config.formatsToSupport], expectedFormats)
  assert.equal(instance.config.useBarCodeDetectorIfSupported, true)
  assert.equal(instance.scanConfig.fps, 10)
  assert.equal(instance.camera.facingMode.ideal, 'environment')
}
const original = instances[0]
first.closeScanDialog(); await settleCleanup()
assert.equal(original.stopped, 1); assert.equal(original.cleared, 1)
await original.success('旧会话不得回填', {})
assert.deepEqual(detected, [])
second.closeScanDialog(); await settleCleanup()
const third = create(['unknown'])
await third.openScanDialog()
assert.equal(imports, 2, '成功后后续会话复用模块')
assert.deepEqual([...instances.at(-1).config.formatsToSupport], [formats.QR_CODE])
await instances.at(-1).success('  QR-REAL-BOUNDARY  ', {})
assert.deepEqual(detected, ['QR-REAL-BOUNDARY'])
await settleCleanup()
assert.equal(instances.at(-1).cleared, 1)
const image = create()
await image.handleImageInputChange({ target: { value: 'photo.png', files: [{ type: 'image/png', decoded: ' PHOTO-BOUNDARY ' }] } })
assert.deepEqual(detected, ['QR-REAL-BOUNDARY', 'PHOTO-BOUNDARY'])
assert.equal(host.length, 0, '图片临时宿主应清理')
failStart = true
const permission = create()
await permission.openScanDialog(); await settleCleanup()
assert.match(warnings.at(-1), /未授予摄像头权限/)
assert.equal(permission.scanDialogVisible.value, false)
assert.equal(instances.at(-1).cleared, 1)
failStart = false
await permission.openScanDialog()
const last = instances.at(-1)
unmount(); await settleCleanup()
assert.equal(last.stopped, 1); assert.equal(last.cleared, 1)
console.log('真实扫码composable：12格式、加载并发/失败重试、独立实例、权限回退、旧回调、图片和卸载清理通过；算法由compiled专项验证')
