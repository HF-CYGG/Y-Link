import assert from 'node:assert/strict'
import fs from 'node:fs'
import LegacyJsBarcode from 'jsbarcode'
import * as Vue from 'vue'
import { parse } from '@vue/compiler-sfc'
import { withBrowser, mountSetup, replaceLabels, testLabel } from './barcode-behavior-test-runtime.mjs'
import { compile } from '@vue/compiler-ssr'
import * as VueServerRenderer from '@vue/server-renderer'

const dialogSource = fs.readFileSync('src/views/inventory/components/BarcodeLabelPrintDialog.vue', 'utf8')
const cardSource = fs.readFileSync('src/views/inventory/components/BarcodeLabelCard.vue', 'utf8')
const helpers = await import('../src/views/inventory/components/barcode-label-print.helpers.ts')

const cardRender = new Function('require', compile(parse(cardSource).descriptor.template.content).code)((name) =>
  name === 'vue' ? Vue : VueServerRenderer,
)

await withBrowser(async (browser) => {
const document = browser.document
// 同一组原有断言可直接验证产品virtual预设，避免只验证旧完整库。
let JsBarcode = LegacyJsBarcode
if (process.argv.includes('--code128-preset')) {
  const { createPresetFactory } = await import('./code128-preset-test-runtime.mjs')
  JsBarcode = (await createPresetFactory(document)).factory
}

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
  for (const value of ['constructor', 'toString', '__proto__', 'WC02001', 'YZ0100001', 'A'.repeat(64)]) {
    const { state, unmount } = await mountSetup()
    state.settings.barcodeSource = 'factory_barcode'
    await replaceLabels(state, [testLabel('WC02001', value, { barcode: value })])
    const labels = { value: state.labels.value.map((label) => ({ ...label })) }
    const barcodeSvgMap = { value: { ...state.barcodeSvgMap.value } }
    const barcodeModuleMap = { value: { ...state.barcodeModuleMap.value } }
    const failedBarcodes = { value: [...state.failedBarcodes.value] }
    unmount()
    assert.equal(Object.hasOwn(barcodeSvgMap.value, value), true, `${value} 必须是自有键`)
    const svg = barcodeSvgMap.value[value]
    assert.match(svg, /^<svg\b/)
    assert.match(svg, /<rect\b/)
    assert.ok(barcodeModuleMap.value[value] > 0, `${value} 必须记录真实 Code128 模块数`)
    renderedCases.set(value, { labels, barcodeSvgMap, barcodeModuleMap, failedBarcodes })
    const card = Vue.createSSRApp({
      props: ['label', 'template', 'barcodeSvg', 'encodedText', 'showSpec', 'showCode', 'showPrice', 'showLocation', 'showPrintDate', 'printDateText', 'fitStyle'],
      ssrRender: cardRender,
    }, {
      label: { productName: '合成商品', specText: '', price: 1, locationCode: '' }, template: 'thermal', barcodeSvg: svg,
      encodedText: value, showSpec: false, showCode: true, showPrice: false, showLocation: false, showPrintDate: false, printDateText: '', fitStyle: {},
    })
    assert.match(await VueServerRenderer.renderToString(card), /<svg\b/, `${value} 标签卡片应含SVG`)
  }
})

await check('生成图与缺码接入最终打印阻断，密度风险独立提示', async () => {
  const checkGuard = async (value, width, height, mapOverride, template = 'thermal', selectedOverride) => {
    const { state, unmount } = await mountSetup()
    try {
      Object.assign(state.settings, { template, barcodeSource: 'factory_barcode', labelWidthMm: width, labelHeightMm: height, showSpec: true, showCode: true, showPrice: true, showLocation: false, showPrintDate: true })
      await replaceLabels(state, [testLabel('WC02001', value, { barcode: value })])
      if (mapOverride) state.barcodeSvgMap.value = mapOverride.value
      if (selectedOverride?.value.length === 0) state.toggleAllSelected(false)
      return { svg: state.barcodeSvgFor(state.labels.value[0]), missing: state.missingBarcodes.value, blocked: state.printBlockedReason.value }
    } finally { unmount() }
  }
  const prototype = await checkGuard('constructor', 60, 30)
  assert.match(prototype.svg, /^<svg/); assert.deepEqual(prototype.missing, []); assert.equal(prototype.blocked, '')
  assert.match((await checkGuard('constructor', 60, 30, { value: {} })).blocked, /无法生成/)
  const unselected = await checkGuard('constructor', 60, 30, { value: {} }, 'thermal', { value: [] })
  assert.deepEqual(unselected.missing, []); assert.equal(unselected.blocked, '请至少勾选一个要打印的规格')
  for (const [value, width, height, template] of [['WC02001',40,10,'thermal'], ['A'.repeat(64),40,30,'thermal'], ['YZ0100001',32,30,'a4'], ['YZ0100001',37,30,'thermal'], ['WC02001',40,30,'thermal'], ['YZ0100001',40,30,'thermal'], ['WC02001',40,30,'a4'], ['YZ0100001',40,30,'a4']]) {
    assert.equal((await checkGuard(value, width, height, undefined, template)).blocked, '', value)
  }
})

await check('固定纸张适配后 20mm 有保守图形高度，10mm 有基本可见区与风险提示', () => {
  const base = { labelWidthMm: 30, showSpec: true, showCode: true, showPrice: true, showLocation: true, showPrintDate: true }
  for (const template of ['thermal', 'a4', 'yz-full', 'yz-compact']) {
    const normal = { ...base, template, labelHeightMm: 20 }
    const tiny = { ...normal, labelHeightMm: 10 }
    assert.equal(helpers.getLabelLayoutError(normal), '', template)
    assert.ok(helpers.getLabelContentFit(normal).graphicHeightMm >= 2, template)
    assert.ok(helpers.getLabelContentFit(tiny).graphicHeightMm >= 2, template)
    assert.match(helpers.getLabelLayoutWarning(tiny), /保守建议/, template)
    assert.equal(helpers.getLabelLayoutError(tiny), '', template)
    assert.match(helpers.getLabelLayoutError({ ...tiny, labelHeightMm: 5 }), /基本可见下限/, template)
  }
})

await check('真实 Code128 模块数仅提示高密度并保留默认短码', () => {
  assert.equal(typeof helpers.getCode128DensityError, 'function', '需要模块宽度校验函数')
  const cases = [
    ['WC02001', false], ['YZ0100001', false], ['6901234567892', false], ['A'.repeat(64), true],
  ]
  for (const [value, shouldBlock] of cases) {
    const target = {}
    JsBarcode(target, value, { format: 'CODE128', displayValue: false, margin: 0, height: 60, width: 2 })
    const moduleCount = target.encodings.reduce((count, encoding) => count + encoding.data.length, 0)
    const message = helpers.getCode128DensityError({ template: 'thermal', labelWidthMm: 40, labelHeightMm: 30,
      showSpec: true, showCode: true, showPrice: true, showLocation: false, showPrintDate: false }, moduleCount)
    assert.equal(Boolean(message), shouldBlock, `${value} 模块数 ${moduleCount}`)
  }
})

await check('截图长 SKU 在 30mm 手动纸宽下保留高密度风险', () => {
  for (const value of ['P-260420-0008-SKU-1', 'P-260420-0008-SKU-12']) {
    const target = {}
    JsBarcode(target, value, { format: 'CODE128', displayValue: false, margin: 0, height: 60, width: 2 })
    const modules = target.encodings.reduce((count, encoding) => count + encoding.data.length, 0)
    const settings = { template: 'thermal', labelWidthMm: 30, labelHeightMm: 20,
      showSpec: true, showCode: true, showPrice: true, showLocation: false, showPrintDate: false }
    assert.match(helpers.getCode128DensityError(settings, modules), /每模块/)
    assert.deepEqual([settings.labelWidthMm, settings.labelHeightMm], [30, 20])
  }
})

await check('实际 SVG 两侧各预留至少十个模块的静区，宽度计算只加入一次', async () => {
  const rendered = renderedCases.get('YZ0100001')
  assert.ok(rendered)
  const svg = rendered.barcodeSvgMap.value.YZ0100001
  const totalModules = Number(svg.match(/viewBox="0 0 (\d+) /)?.[1]) / 2
  const symbolModules = rendered.barcodeModuleMap.value.YZ0100001
  assert.equal(totalModules - symbolModules, 20)
  const target = {}
  JsBarcode(target, 'YZ0100001', { format: 'CODE128', displayValue: false, margin: 0, width: 2 })
  assert.equal(symbolModules, target.encodings[0].data.length)
  assert.equal(totalModules, symbolModules + helpers.CODE128_QUIET_ZONE_MODULES_PER_SIDE * 2)
})

await check('四模板全部字段只调整内部比例，不改变尺寸或隐藏字段', () => {
  const base = { labelWidthMm: 30, labelHeightMm: 20, showSpec: true, showCode: true,
    showPrice: true, showLocation: true, showPrintDate: true }
  for (const template of ['thermal', 'a4', 'yz-full', 'yz-compact']) {
    const settings = { ...base, template }
    const fit = helpers.getLabelContentFit(settings)
    assert.ok(fit.scale >= 0.45 && fit.scale <= 1, `${template}: ${fit.scale}`)
    assert.ok(fit.graphicHeightMm >= 2, `${template}: ${fit.graphicHeightMm}`)
    assert.deepEqual([settings.labelWidthMm, settings.labelHeightMm], [30, 20])
  }
})

await check('数值长码按可用宽度缩人眼文字，不省略编码', () => {
  const value = '123456789012345678901234567890'
  const target = {}
  JsBarcode(target, value, { format: 'CODE128', displayValue: false, margin: 0, height: 60, width: 2 })
  const modules = target.encodings.reduce((count, encoding) => count + encoding.data.length, 0)
  assert.ok(modules > 0)
  const settings = { template: 'thermal', labelWidthMm: 40, labelHeightMm: 20,
    showSpec: true, showCode: true, showPrice: true, showLocation: false, showPrintDate: false }
  assert.ok(helpers.getHumanCodeFontSizePt(settings, value) < 8)
  assert.equal(helpers.getHumanCodeFitWarning(settings, value), '')
  assert.match(helpers.getHumanCodeFitWarning({ ...settings, labelWidthMm: 20 }, 'A'.repeat(80)), /基本可读建议/)
  assert.match(dialogSource, /\.barcode-label__text\s*\{[^}]*white-space:\s*nowrap/s)
  assert.doesNotMatch(dialogSource, /\.barcode-label__text\s*\{[^}]*text-overflow:\s*ellipsis/s)
})

await check('隐藏可读编码释放图形净高，但不改变实际条码值', () => {
  const base = { template: 'thermal', labelWidthMm: 30, labelHeightMm: 23,
    showSpec: true, showPrice: true, showLocation: false, showPrintDate: false }
  const shown = helpers.getLabelContentFit({ ...base, showCode: true }).graphicHeightMm
  const hidden = helpers.getLabelContentFit({ ...base, showCode: false }).graphicHeightMm
  assert.ok(hidden >= shown)
  assert.equal(helpers.getLabelLayoutError({ ...base, labelHeightMm: 20, showCode: false }), '')
})

await check('四种标签隐藏可读编码时仍保留 SVG 且不输出编码文本', async () => {
  for (const template of ['thermal', 'a4', 'yz-full', 'yz-compact']) {
    const props = { label: { productName: '测试', specText: '', price: 1, locationCode: '' }, template,
      barcodeSvg: '<svg data-code="完整编码" />', encodedText: '完整编码', showSpec: false,
      showCode: false, showPrice: false, showLocation: false, showPrintDate: false, printDateText: '', fitStyle: {} }
    const card = Vue.createSSRApp({ props: Object.keys(props), ssrRender: cardRender }, props)
    const html = await VueServerRenderer.renderToString(card)
    assert.match(html, /<svg\b/, `${template} 仍需保留可扫描条码`)
    assert.equal((html.match(/完整编码/g) ?? []).length, 1, `${template} 不得渲染可读编码文字`)
  }
})

await check('A4 单元格 border-box 边框同时计入横向和纵向净尺寸', () => {
  assert.match(dialogSource, /\.barcode-label\s*\{[^}]*box-sizing:\s*border-box/s)
  assert.match(dialogSource, /\.barcode-label--cell\s*\{[^}]*border:\s*0\.2mm\s+dashed/s)
  const target = {}
  JsBarcode(target, 'YZ0100001', { format: 'CODE128', displayValue: false, margin: 0, height: 60, width: 2 })
  const modules = target.encodings.reduce((count, encoding) => count + encoding.data.length, 0)
  assert.equal(modules, 112)
  const base = { labelWidthMm: 37, labelHeightMm: 25.4, showSpec: true, showCode: true, showPrice: true,
    showLocation: false, showPrintDate: false }
  assert.ok(helpers.getLabelContentFit({ ...base, template: 'a4' }).contentWidthMm <
    helpers.getLabelContentFit({ ...base, template: 'thermal' }).contentWidthMm)
  assert.equal(helpers.getCode128DensityError({ ...base, template: 'thermal' }, modules), '')
  assert.match(helpers.getCode128DensityError({ ...base, template: 'a4' }, modules), /每模块/)
  assert.ok(helpers.getLabelContentFit({ ...base, template: 'a4' }).graphicHeightMm <
    helpers.getLabelContentFit({ ...base, template: 'thermal' }).graphicHeightMm)
})

if (failures.length) {
  console.error(`barcode-label-print-fixes: ${failures.length} 项未通过`)
  process.exitCode = 1
} else {
  console.log('barcode-label-print-fixes: 全部通过')
}

})
