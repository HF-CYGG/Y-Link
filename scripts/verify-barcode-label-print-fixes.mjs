import assert from 'node:assert/strict'
import fs from 'node:fs'
import ts from 'typescript'
import JsBarcode from 'jsbarcode'
import * as Vue from 'vue'
import { parse } from '@vue/compiler-sfc'
import { compile } from '@vue/compiler-ssr'
import * as VueServerRenderer from '@vue/server-renderer'

const dialogSource = fs.readFileSync('src/views/inventory/components/BarcodeLabelPrintDialog.vue', 'utf8')
const cardSource = fs.readFileSync('src/views/inventory/components/BarcodeLabelCard.vue', 'utf8')
const script = parse(dialogSource).descriptor.scriptSetup.content
const ast = ts.createSourceFile('dialog.ts', script, ts.ScriptTarget.Latest, true)
const helpers = await import('../src/views/inventory/components/barcode-label-print.helpers.ts')

const declaration = (name) => {
  for (const statement of ast.statements) {
    if (!ts.isVariableStatement(statement)) continue
    const item = statement.declarationList.declarations.find((entry) => entry.name.getText(ast) === name)
    if (item) return `const ${item.getText(ast)};`
  }
  throw new Error(`找不到 ${name}`)
}
const transpile = (names) => ts.transpileModule(names.map(declaration).join('\n'), {
  compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
}).outputText
const cardRender = new Function('require', compile(parse(cardSource).descriptor.template.content).code)((name) =>
  name === 'vue' ? Vue : VueServerRenderer,
)

class SvgNode {
  constructor(name) {
    this.nodeName = name
    this.attributes = new Map()
    this.children = []
  }
  hasAttribute(key) { return this.attributes.has(key) }
  getAttribute(key) { return this.attributes.get(key) ?? null }
  setAttribute(key, value) { this.attributes.set(key, String(value)) }
  appendChild(node) { this.children.push(node); return node }
  removeChild(node) { this.children.splice(this.children.indexOf(node), 1) }
  get firstChild() { return this.children[0] ?? null }
  get outerHTML() {
    const attrs = [...this.attributes].map(([key, value]) => ` ${key}="${value}"`).join('')
    return `<${this.nodeName}${attrs}>${this.children.map((node) => node.outerHTML ?? node.textContent).join('')}</${this.nodeName}>`
  }
}
const document = { createElementNS(_namespace, name) { return new SvgNode(name) }, createTextNode(text) { return { textContent: text } } }
globalThis.document = document

const failures = []
const renderedCases = new Map()
const check = async (name, task) => {
  try {
    await task()
    console.log(`PASS ${name}`)
  } catch (error) {
    failures.push(name)
    console.error(`FAIL ${name}: ${error.message}`)
  }
}

await check('合法原型键真实生成 SVG 并在标签卡片呈现', async () => {
  const js = transpile(['renderBarcodes'])
  for (const value of ['constructor', 'toString', '__proto__', 'WC02001', 'YZ0100001', 'A'.repeat(64)]) {
    const labels = Vue.ref([{ skuCode: 'WC02001', barcode: value, factoryBarcode: value }])
    const barcodeSvgMap = Vue.ref(Object.create(null))
    const barcodeModuleMap = Vue.ref(Object.create(null))
    const failedBarcodes = Vue.ref([])
    const loadError = Vue.ref('')
    const renderBarcodes = new Function(
      'loadJsBarcode', 'barcodeSvgMap', 'barcodeModuleMap', 'failedBarcodes', 'labels', 'resolveBarcodeValue', 'settings', 'document', 'showAppWarning', 'showAppError', 'loadError',
      `${js}; return renderBarcodes`,
    )(async () => ({ default: JsBarcode }), barcodeSvgMap, barcodeModuleMap, failedBarcodes, labels, helpers.resolveBarcodeValue,
      { barcodeSource: 'factory_barcode' }, document, () => {}, () => {}, loadError)
    await renderBarcodes()
    assert.equal(Object.hasOwn(barcodeSvgMap.value, value), true, `${value} 必须是自有键`)
    const svg = barcodeSvgMap.value[value]
    assert.match(svg, /^<svg\b/)
    assert.match(svg, /<rect\b/)
    assert.ok(barcodeModuleMap.value[value] > 0, `${value} 必须记录真实 Code128 模块数`)
    renderedCases.set(value, { labels, barcodeSvgMap, barcodeModuleMap, failedBarcodes })
    const card = Vue.createSSRApp({
      props: ['label', 'template', 'barcodeSvg', 'encodedText', 'showSpec', 'showPrice', 'showLocation', 'showPrintDate', 'printDateText'],
      ssrRender: cardRender,
    }, {
      label: { productName: '合成商品', specText: '', price: 1, locationCode: '' }, template: 'thermal', barcodeSvg: svg,
      encodedText: value, showSpec: false, showPrice: false, showLocation: false, showPrintDate: false, printDateText: '',
    })
    assert.match(await VueServerRenderer.renderToString(card), /<svg\b/, `${value} 标签卡片应含SVG`)
  }
})

await check('生成图、缺码、净高与密度都接入最终打印阻断', () => {
  const js = transpile(['getGeneratedBarcodeSvg', 'barcodeSvgFor', 'labelLayoutError', 'barcodeDensityError', 'missingBarcodes', 'printBlockedReason'])
  const checkGuard = (value, width, height, mapOverride, template = 'thermal') => {
    const rendered = renderedCases.get(value)
    assert.ok(rendered)
    const settings = { template, barcodeSource: 'factory_barcode', labelWidthMm: width, labelHeightMm: height,
      showSpec: true, showPrice: true, showLocation: false, showPrintDate: true }
    const result = new Function(
      'computed', 'barcodeSvgMap', 'barcodeModuleMap', 'labels', 'failedBarcodes', 'settings', 'resolveBarcodeValue',
      'getLabelLayoutError', 'getCode128DensityError', 'loading', 'loadError', 'exceedsLimit', 'totalLabelCount', 'a4LayoutError', 'MAX_TOTAL_LABELS',
      `${js}; return { getGeneratedBarcodeSvg, barcodeSvgFor, missingBarcodes, printBlockedReason }`,
    )((getter) => ({ get value() { return getter() } }), mapOverride ?? rendered.barcodeSvgMap, rendered.barcodeModuleMap,
      rendered.labels, rendered.failedBarcodes, settings, helpers.resolveBarcodeValue, helpers.getLabelLayoutError,
      helpers.getCode128DensityError, { value: false }, { value: '' }, { value: false }, { value: 1 }, { value: '' }, 2000)
    return { labelCount: rendered.labels.value.length, source: helpers.resolveBarcodeValue(rendered.labels.value[0], settings.barcodeSource),
      svg: result.barcodeSvgFor(rendered.labels.value[0]), direct: result.getGeneratedBarcodeSvg(value),
      missing: result.missingBarcodes.value, blocked: result.printBlockedReason.value }
  }
  const prototype = checkGuard('constructor', 60, 30)
  assert.match(prototype.svg, /^<svg\b/)
  assert.deepEqual(prototype.missing, [])
  assert.equal(prototype.blocked, '', '宽标签的合法原型键应可打印')
  const missing = checkGuard('constructor', 60, 30, { value: {} })
  assert.match(missing.blocked, /无法生成/, `无自有SVG应阻断：${JSON.stringify(missing)}`)
  assert.match(checkGuard('WC02001', 40, 10).blocked, /条码区/, '10mm净高应阻断')
  assert.match(checkGuard('A'.repeat(64), 40, 30).blocked, /每模块/, '长码密度应阻断')
  assert.match(checkGuard('YZ0100001', 32, 30, undefined, 'a4').blocked, /每模块/, 'A4 32mm 单元格边框不能被净宽估算漏掉')
  assert.equal(checkGuard('YZ0100001', 32, 30).blocked, '', '无边框热敏 32mm 恰好达到 0.25mm 基线')
  assert.equal(checkGuard('WC02001', 40, 30).blocked, '')
  assert.equal(checkGuard('YZ0100001', 40, 30).blocked, '')
  assert.equal(checkGuard('WC02001', 40, 30, undefined, 'a4').blocked, '')
  assert.equal(checkGuard('YZ0100001', 40, 30, undefined, 'a4').blocked, '')
})

await check('10mm 无条码净高，30mm 默认尺寸正常', () => {
  assert.equal(typeof helpers.getLabelLayoutError, 'function', '需要净高校验函数')
  const base = { template: 'thermal', labelWidthMm: 40, showSpec: true, showPrice: true, showLocation: false, showPrintDate: true }
  assert.match(helpers.getLabelLayoutError({ ...base, labelHeightMm: 10 }), /增高|隐藏|尺寸/)
  assert.equal(helpers.getLabelLayoutError({ ...base, labelHeightMm: 30 }), '')
  for (const template of ['a4', 'yz-full', 'yz-compact']) {
    assert.ok(helpers.getLabelLayoutError({ ...base, template, labelHeightMm: 10 }), `${template} 10mm 应阻断`)
    assert.equal(helpers.getLabelLayoutError({ ...base, template, labelHeightMm: 30 }), '', `${template} 30mm 应通过`)
  }
})

await check('真实 Code128 模块数限制高密度并保留默认短码', () => {
  assert.equal(typeof helpers.getCode128DensityError, 'function', '需要模块宽度校验函数')
  const cases = [
    ['WC02001', false], ['YZ0100001', false], ['6901234567892', false], ['A'.repeat(64), true],
  ]
  for (const [value, shouldBlock] of cases) {
    const target = {}
    JsBarcode(target, value, { format: 'CODE128', displayValue: false, margin: 0, height: 60, width: 2 })
    const moduleCount = target.encodings.reduce((count, encoding) => count + encoding.data.length, 0)
    const message = helpers.getCode128DensityError(40, moduleCount, 'thermal')
    assert.equal(Boolean(message), shouldBlock, `${value} 模块数 ${moduleCount}`)
  }
})

await check('A4 单元格 border-box 边框同时计入横向和纵向净尺寸', () => {
  assert.match(dialogSource, /\.barcode-label\s*\{[^}]*box-sizing:\s*border-box/s)
  assert.match(dialogSource, /\.barcode-label--cell\s*\{[^}]*border:\s*0\.2mm\s+dashed/s)
  const target = {}
  JsBarcode(target, 'YZ0100001', { format: 'CODE128', displayValue: false, margin: 0, height: 60, width: 2 })
  const modules = target.encodings.reduce((count, encoding) => count + encoding.data.length, 0)
  assert.equal(modules, 112)
  assert.equal(helpers.getCode128DensityError(32, modules, 'thermal'), '')
  assert.match(helpers.getCode128DensityError(32, modules, 'a4'), /每模块/)
  const base = { labelWidthMm: 40, labelHeightMm: 25.4, showSpec: true, showPrice: true,
    showLocation: false, showPrintDate: false }
  assert.equal(helpers.getLabelLayoutError({ ...base, template: 'thermal' }), '')
  assert.match(helpers.getLabelLayoutError({ ...base, template: 'a4' }), /条码区/)
})

if (failures.length) {
  console.error(`barcode-label-print-fixes: ${failures.length} 项未通过`)
  process.exitCode = 1
} else {
  console.log('barcode-label-print-fixes: 全部通过')
}
