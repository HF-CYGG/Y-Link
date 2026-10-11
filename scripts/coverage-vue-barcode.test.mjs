/** 执行原始条码弹窗脚本的实际交互状态，并保留到 Vue SFC 的源码映射。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { parse, compileScript } from '@vue/compiler-sfc'
import { rolldown } from 'rolldown'
import { createSSRApp, h } from 'vue'
import { renderToString } from '@vue/server-renderer'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = path.join(root, 'src/views/inventory/components/BarcodeLabelPrintDialog.vue')
const outputRoot = path.join(root, 'tmp/coverage-vue-barcode')
fs.mkdirSync(outputRoot, { recursive: true })

const source = fs.readFileSync(sourcePath, 'utf8')
const parsed = parse(source, { filename: sourcePath, sourceMap: true })
assert.equal(parsed.errors.length, 0)
const compiled = compileScript(parsed.descriptor, { id: 'pr153-barcode', sourceMap: true })
assert.ok(compiled.map, 'SFC 必须保留原始源码映射')

const calls = { warnings: [], errors: [], loading: 0 }
let loadResult = async () => []
const stub = { setup: () => () => h('div') }
const bundle = await rolldown({
  input: sourcePath,
  external: (specifier) => specifier === 'vue' || specifier === 'jsbarcode',
  plugins: [{
    name: '条码弹窗测试依赖隔离',
    resolveId(specifier) {
      if (specifier === sourcePath) return sourcePath
      if (specifier.startsWith('@/') || specifier.endsWith('.vue')) return `\0barcode:${specifier}`
    },
    load(id) {
      if (id === sourcePath) return { code: compiled.content, map: compiled.map, moduleType: 'ts' }
      if (id === '\0barcode:@/components/common') return 'export const BizCrudDialogShell = {}; export const PassiveNumberInput = {}'
      if (id === '\0barcode:@/api/modules/inventory') return 'export const getProductLabels = async () => globalThis.__barcodeTestLoad()'
      if (id === '\0barcode:@/utils/app-alert') {
        return 'export const showAppError = (...a) => globalThis.__barcodeTestError(...a); export const showAppWarning = (...a) => globalThis.__barcodeTestWarning(...a)'
      }
      if (id?.startsWith('\0barcode:') && id.endsWith('.vue')) return 'export default {}'
    },
  }],
})
globalThis.__barcodeTestLoad = async () => { calls.loading += 1; return loadResult() }
globalThis.__barcodeTestError = (message) => calls.errors.push(message)
globalThis.__barcodeTestWarning = (message) => calls.warnings.push(message)
const output = path.join(outputRoot, 'BarcodeLabelPrintDialog-setup.mjs')
await bundle.write({ file: output, format: 'esm', sourcemap: true })
await bundle.close()
const component = (await import(pathToFileURL(output).href)).default

const setup = async (skuIds = []) => {
  let state
  await renderToString(createSSRApp({
    setup() {
      state = component.setup({ modelValue: false, skuIds }, { emit: () => {}, expose: () => {} })
      return () => h('div')
    },
  }))
  return state
}

test('非法标签宽度回退，三种条码来源保持历史值与原厂值口径', async () => {
  const state = await setup()
  assert.equal(state.settings.labelWidthMm, 40)
  state.labelWidthModel.value = null
  assert.equal(state.settings.labelWidthMm, 40)
  state.labelWidthModel.value = 999
  assert.equal(state.settings.labelWidthMm, 40)
  state.labelWidthModel.value = 50
  assert.equal(state.settings.labelWidthMm, 50)

  const label = { skuCode: 'WC02001', barcode: 'WC02001', factoryBarcode: 'FACTORY-1' }
  assert.equal(state.encodedTextFor(label), 'WC02001')
  state.settings.barcodeSource = 'factory_barcode'
  assert.equal(state.encodedTextFor(label), 'FACTORY-1')
  state.settings.barcodeSource = 'sku_code'
  assert.equal(state.encodedTextFor(label), 'WC02001')
})

test('没有生成条码图及原厂值时阻断打印并指出对应标签', async () => {
  const state = await setup()
  const label = { skuCode: 'WC02001', barcode: 'WC02001', factoryBarcode: '' }
  state.labels.value = [label]
  assert.deepEqual(state.missingBarcodes.value, ['WC02001'])
  assert.match(state.printBlockedReason.value, /WC02001/)
  state.settings.barcodeSource = 'factory_barcode'
  assert.equal(state.encodedTextFor(label), '')
  assert.deepEqual(state.missingBarcodes.value, ['WC02001（无原厂条码）'])
  assert.match(state.printBlockedReason.value, /无原厂条码/)
  assert.equal(calls.loading, 0, '本地校验不得请求标签数据')
})

test('打印数量与 A4 版式越界分别阻断，预览和分页只复制已生成的标签', async () => {
  const state = await setup()
  const label = { skuCode: 'WC02001', barcode: 'WC02001', factoryBarcode: '' }
  state.labels.value = [label]
  state.barcodeSvgMap.value = { WC02001: '<svg />' }
  assert.equal(state.barcodeSvgFor(label), '<svg />')
  assert.deepEqual(state.missingBarcodes.value, [])

  state.settings.template = 'a4'
  state.settings.columns = 6
  state.settings.labelWidthMm = 50
  assert.match(state.a4LayoutError.value, /超出 A4 可打印区域/)
  assert.match(state.printBlockedReason.value, /超出 A4 可打印区域/)

  state.settings.columns = 3
  state.settings.labelWidthMm = 40
  state.labels.value = Array.from({ length: 11 }, () => label)
  state.settings.copies = 200
  assert.equal(state.totalLabelCount.value, 2200)
  assert.equal(state.exceedsLimit.value, true)
  assert.match(state.printBlockedReason.value, /单次最多打印 2000 张/)

  state.settings.copies = 2
  assert.equal(state.previewA4Labels.value.length, 22)
  state.printing.value = true
  assert.equal(state.expandedLabels.value.length, 22)
  assert.equal(state.a4Pages.value.length, 1)
  state.printing.value = false
  assert.deepEqual(state.expandedLabels.value, [])
})

test('预览尺寸来自已校验的设置，缺少标签时点击打印只告警', async () => {
  const state = await setup()
  assert.equal(state.settings.barcodeSource, 'factory_barcode_first')
  assert.deepEqual(state.thermalStyle.value, { width: '40mm', height: '30mm' })
  assert.deepEqual(state.a4GridStyle.value, {
    gridTemplateColumns: 'repeat(3, 40mm)', gridTemplateRows: 'repeat(8, 30mm)',
  })
  const warningsBefore = calls.warnings.length
  await state.handlePrint()
  assert.equal(calls.warnings.length, warningsBefore + 1)
  assert.match(calls.warnings.at(-1), /没有可打印的标签/)
  assert.equal(state.printing.value, false)
})

test('条码数据请求失败时清空旧标签并显示错误，不继续生成打印图', async () => {
  const state = await setup(['sku-1'])
  state.labels.value = [{ skuCode: 'OLD', barcode: 'OLD', factoryBarcode: '' }]
  loadResult = async () => { throw new Error('隔离请求失败') }
  try {
    const requestedBefore = calls.loading
    await state.loadLabels()
    assert.equal(calls.loading, requestedBefore + 1)
    assert.deepEqual(state.labels.value, [])
    assert.equal(state.loading.value, false)
    assert.match(state.loadError.value, /数据加载失败/)
    assert.equal(calls.errors.at(-1)?.message, '隔离请求失败')
  } finally {
    loadResult = async () => []
  }
})
