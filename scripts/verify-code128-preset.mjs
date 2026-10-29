/** 比较原完整库和同版本官方Code128预设的真实编码/SVG/有效性及私有作用域。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import LegacyJsBarcode from 'jsbarcode'
import { buildCode128BarcodeModule, code128BarcodePlugin, CODE128_BARCODE_MODULE_ID, CODE128_BARCODE_RESOLVED_ID } from './code128-barcode-module.mjs'
import { createSvgDocument, createPresetFactory } from './code128-preset-test-runtime.mjs'

const document = createSvgDocument()
globalThis.document = document
const { factory, moduleCode, globalAccess } = await createPresetFactory(document)
const plugin = code128BarcodePlugin()
assert.equal(plugin.resolveId(CODE128_BARCODE_MODULE_ID), CODE128_BARCODE_RESOLVED_ID)
for (const id of ['jsbarcode', `${CODE128_BARCODE_MODULE_ID}/other`, `${CODE128_BARCODE_RESOLVED_ID}/other`]) {
  assert.equal(plugin.resolveId(id), undefined)
  assert.equal(plugin.load(id), undefined)
}
const packagePath = createRequire(import.meta.url).resolve('jsbarcode/package.json')
const metadata = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
const vendor = fs.readFileSync(path.join(path.dirname(packagePath), 'dist/barcodes/JsBarcode.code128.min.js'), 'utf8')
assert.ok(moduleCode.includes(vendor), '供应商预设包括license必须逐字保留')
assert.match(vendor, /MIT/)
assert.throws(() => buildCode128BarcodeModule(`${vendor}\n`, metadata.version), /版本或指纹/)
assert.throws(() => buildCode128BarcodeModule(vendor, '0.0.0'), /版本或指纹/)
const options = { format: 'CODE128', displayValue: false, margin: 0, marginLeft: 20, marginRight: 20, height: 60, width: 2 }
const errorSummary = (caught, value) => {
  const message = String(caught.message ?? caught)
  const prefix = `"${String(value)}" is not a valid input for `
  // 两个固定供应商实现均由InvalidInputException路径产生，官方minified类名为e；不规范其他错误。
  const knownInvalidInput = message === `${prefix}CODE128AUTO` || message === `${prefix}e`
  return { kind: typeof caught, name: caught?.name ?? null, message: knownInvalidInput ? `${prefix}CODE128` : message }
}
const render = (implementation, value) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  const valid = []
  let error = null
  try { implementation(svg, value, { ...options, valid: (accepted) => valid.push(accepted) }) }
  catch (caught) { error = errorSummary(caught, value) }
  const encoded = {}
  let encodingError = null
  try { implementation(encoded, value, { ...options }) }
  catch (caught) { encodingError = errorSummary(caught, value) }
  return { svg: svg.outerHTML, valid, error, encodings: encoded.encodings ? JSON.parse(JSON.stringify(encoded.encodings)) : null, encodingError }
}
const values = ['WC02001', 'YZ0100001', '12345678', '1234567', '00123', 'constructor', 'toString', '__proto__', 'A'.repeat(64),
  'A\u0000B\u001fC\u007f', Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index)).join(''), '', '中文不应有效', 'ABC\u0100']
for (const value of values) assert.deepEqual(render(factory, value), render(LegacyJsBarcode, value), `编码/SVG/valid不一致：${JSON.stringify(value)}`)
const result = render(factory, 'YZ0100001')
assert.deepEqual(result.valid, [true])
assert.equal(result.encodings.reduce((sum, entry) => sum + entry.data.length, 0), 112)
assert.match(result.svg, /translate\(20, 0\)/, '10模块静区乘2像素保持20像素')
assert.deepEqual(globalAccess(), { reads: 0, writes: 0 })
console.log(`Code128官方预设真实SVG/valid/静区与原库${values.length}组等价、精确virtual范围及升级失败guard通过`)
