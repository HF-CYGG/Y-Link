/**
 * 模块说明：scripts/html2pdf-module-id-shortener.test.mjs
 * 文件职责：验证 html2pdf 内部模块 ID 双射转换，并确保供应商结构变化时拒绝构建。
 * 实现逻辑：以本机已安装的原始成品为正例，向临时内存夹具注入动态引用、逃逸和未知路径作反例。
 * 维护说明：升级 html2pdf 时先复核真实 Webpack 引用结构和 PDF 行为，再更新供应商哈希。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { shortenHtml2pdfModuleIds, validateHtml2pdfModuleIdClosure } from './html2pdf-module-id-shortener.mjs'

const require = createRequire(import.meta.url)
const source = readFileSync(require.resolve('html2pdf.js'), 'utf8')
const directCall = source.match(/__webpack_require__\((?:\/\*[\s\S]*?\*\/\s*)?"(\.\/node_modules\/[^"\n]+)"\)/)?.[0]
const boundCall = source.match(/__webpack_require__\.bind\(__webpack_require__,\s*(?:\/\*[\s\S]*?\*\/\s*)?"(\.\/node_modules\/[^"\n]+)"\)/)?.[0]
const externalBind = source.match(/__webpack_require__\.t\.bind\(__webpack_require__,\s*(?:\/\*[\s\S]*?\*\/\s*)?"html2canvas",\s*23\)/)?.[0]
assert.ok(directCall, '夹具缺少 Webpack 直接导入')
assert.ok(boundCall, '夹具缺少 Webpack bind 导入')
assert.ok(externalBind, '夹具缺少外部 html2canvas bind 导入')

test('缩名只改变封闭的 300 个内部模块 ID，保留外部 html2canvas 引用', () => {
  const { code, report } = shortenHtml2pdfModuleIds(source)
  assert.equal(report.moduleCount, 300)
  assert.equal(report.literalCount, 1457)
  assert.equal(report.directCalls, 1155)
  assert.equal(report.boundCalls, 2)
  assert.equal(report.savedBytes, 70032)
  assert.equal(report.transformedSha256, '58d3bc47db10afc2a06e4eae3f236de532e3e14dc86c83c95355ee6463742b76')
  assert.ok(report.savedBytes > 60000)
  assert.ok(code.includes('require("html2canvas")'))
  assert.ok(code.includes(externalBind))
  assert.ok(code.includes('~00'))
  assert.ok(code.includes('~01'))
  assert.equal(validateHtml2pdfModuleIdClosure(source).report.structuralHash, report.structuralHash)
})

test('原供应商文件的任何改动先由哈希门禁拒绝', () => {
  assert.throws(() => shortenHtml2pdfModuleIds(`${source}\n`), /源码 SHA 已变化/)
})

test('动态 require 模块 ID 被拒绝', () => {
  const changed = source.replace(directCall, '__webpack_require__(window.__pdfModuleId)')
  assert.notEqual(changed, source)
  assert.throws(() => validateHtml2pdfModuleIdClosure(changed), /require 出现动态模块 ID/)
})

test('动态 bind 模块 ID 与变化的接收者被拒绝', () => {
  const dynamic = source.replace(boundCall, boundCall.replace(/"\.\/node_modules\/[^"\n]+"/, 'window.__pdfModuleId'))
  assert.notEqual(dynamic, source)
  assert.throws(() => validateHtml2pdfModuleIdClosure(dynamic), /bind 出现动态模块 ID/)
  const changedReceiver = source.replace(boundCall, boundCall.replace('(__webpack_require__,', '(window.__otherRequire,'))
  assert.notEqual(changedReceiver, source)
  assert.throws(() => validateHtml2pdfModuleIdClosure(changedReceiver), /bind 的接收者发生变化/)
})

test('模块表逃逸与表外路径字面量被拒绝', () => {
  assert.throws(() => validateHtml2pdfModuleIdClosure(`${source}\nvoid __webpack_modules__;`), /模块表发生未知外泄/)
  assert.throws(() => validateHtml2pdfModuleIdClosure(`${source}\nvoid "\.\/node_modules\/new-module.js";`), /模块表外路径字面量/)
})

test('已知模块 ID 出现在未知引用位置被拒绝', () => {
  const id = directCall.match(/"([^"]+)"/)?.[1]
  assert.ok(id)
  assert.throws(() => validateHtml2pdfModuleIdClosure(`${source}\nvoid ${JSON.stringify(id)};`), /模块 ID 出现未识别的引用位置/)
})
