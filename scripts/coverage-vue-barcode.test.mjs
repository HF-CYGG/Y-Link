/** 执行原始条码弹窗脚本的实际交互状态，并保留到 Vue SFC 的源码映射。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { parse, compileScript } from '@vue/compiler-sfc'
import { rolldown } from 'rolldown'
import { createRenderer, createSSRApp, h, nextTick, reactive } from 'vue'
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

const renderer = createRenderer({
  createElement: (tag) => ({ tag, children: [], parent: null }),
  createText: (text) => ({ text, parent: null }),
  createComment: (text) => ({ text, parent: null }),
  setText: (node, text) => { node.text = text },
  setElementText: (node, text) => { node.children = [{ text, parent: node }] },
  patchProp: () => {},
  insert: (node, parent) => { node.parent = parent; parent.children.push(node) },
  remove: (node) => { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1) },
  parentNode: (node) => node.parent,
  nextSibling: () => null,
})
const mountSetup = async (skuIds = [], modelValue = false) => {
  let state
  const props = reactive({ modelValue, skuIds })
  const app = renderer.createApp({
    setup() {
      state = component.setup(props, { emit: () => {}, expose: () => {} })
      return () => h('div')
    },
  })
  app.mount({ children: [] })
  await nextTick()
  return { state, props, unmount: () => app.unmount() }
}
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

const withBrowser = async (run) => {
  const keys = ['document', 'localStorage', 'addEventListener', 'removeEventListener', 'print', 'setTimeout', 'clearTimeout']
  const originals = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const listeners = new Map()
  const timers = new Map()
  const styles = new Map()
  const classes = new Set()
  const saved = new Map()
  const printed = []
  const svgCreated = []
  let nextTimer = 1
  let printImpl = () => { printed.push(true) }
  const createSvgNode = (tag) => {
    const attributes = new Map()
    const children = []
    return {
      nodeName: tag,
      attributes,
      children,
      setAttribute: (name, value) => attributes.set(name, String(value)),
      getAttribute: (name) => tag === 'svg' && name === 'viewBox' && browser.corruptViewBox
        ? '0 0 not-a-number 60' : attributes.get(name) ?? null,
      hasAttribute: (name) => attributes.has(name),
      appendChild: (child) => { children.push(child); return child },
      removeChild: (child) => { children.splice(children.indexOf(child), 1); return child },
      get firstChild() { return children[0] ?? null },
      get outerHTML() {
        const attrs = [...attributes].map(([name, value]) => ` ${name}="${value}"`).join('')
        return `<${tag}${attrs}>${children.map((child) => child.outerHTML ?? '').join('')}</${tag}>`
      },
    }
  }
  const browser = {
    listeners,
    timers,
    styles,
    classes,
    saved,
    printed,
    svgCreated,
    corruptViewBox: false,
    setPrint: (callback) => { printImpl = callback },
    dispatch: (type) => { for (const callback of [...(listeners.get(type) ?? [])]) callback() },
    runTimer: (id) => { const timer = timers.get(id); assert.ok(timer, `计时器 ${id} 必须存在`); timers.delete(id); timer.callback() },
  }
  const document = {
    visibilityState: 'visible',
    hasFocus: () => true,
    getElementById: (id) => styles.get(id) ?? null,
    createElement: (tag) => {
      assert.equal(tag, 'style')
      const style = { id: '', textContent: '', remove: () => styles.delete(style.id) }
      return style
    },
    createElementNS: (_namespace, tag) => {
      const node = createSvgNode(tag)
      if (tag === 'svg') svgCreated.push(node)
      return node
    },
    head: { appendChild: (style) => styles.set(style.id, style) },
    body: { classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) } },
  }
  browser.document = document
  const replacements = {
    document,
    localStorage: { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) },
    addEventListener: (type, callback) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(callback)
    },
    removeEventListener: (type, callback) => listeners.get(type)?.delete(callback),
    print: () => printImpl(),
    setTimeout: (callback, delay) => { const id = nextTimer++; timers.set(id, { callback, delay }); return id },
    clearTimeout: (id) => timers.delete(id),
  }
  try {
    for (const [key, value] of Object.entries(replacements)) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
    }
    return await run(browser)
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  }
}

const testLabel = (skuCode = 'WC02001', factoryBarcode = 'FACTORY-1') => ({
  skuCode, barcode: skuCode, factoryBarcode,
})
const readyToPrint = (state, label = testLabel()) => {
  state.labels.value = [label]
  state.barcodeSvgMap.value = { [state.encodedTextFor(label)]: '<svg />' }
  assert.equal(state.printBlockedReason.value, '')
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

test('真实打印会话注册监听、保存版式，并在 afterprint 后清理样式与计时器', async () => {
  await withBrowser(async (browser) => {
    const { state, unmount } = await mountSetup([], true)
    let mounted = true
    try {
      readyToPrint(state)
      await state.handlePrint()
      assert.equal(browser.printed.length, 1)
      assert.equal(state.printing.value, true)
      assert.equal(browser.styles.size, 1)
      assert.match([...browser.styles.values()][0].textContent, /@page \{ size: 40mm 30mm; margin: 0; \}/)
      assert.equal(browser.classes.size, 1)
      assert.equal(browser.listeners.get('afterprint')?.size, 1)
      assert.equal(browser.listeners.get('blur')?.size, 1)
      assert.equal(browser.listeners.get('focus')?.size, 1)
      assert.deepEqual([...browser.timers.values()].map((timer) => timer.delay), [120_000])
      assert.equal(JSON.parse([...browser.saved.values()][0]).template, 'thermal')
      await state.handlePrint()
      assert.equal(browser.printed.length, 1, '同一打印会话不得再次打开打印窗口')

      browser.dispatch('afterprint')
      assert.equal(state.printing.value, false)
      assert.equal(browser.styles.size, 0)
      assert.equal(browser.classes.size, 0)
      assert.equal(browser.timers.size, 0)
      assert.equal(browser.listeners.get('afterprint')?.size, 0)
      assert.equal(browser.listeners.get('blur')?.size, 0)
      assert.equal(browser.listeners.get('focus')?.size, 0)

      await state.handlePrint()
      assert.equal(state.printing.value, true)
      unmount()
      mounted = false
      assert.equal(state.printing.value, false, '卸载中的活跃打印会话必须立即终止')
      assert.equal(browser.styles.size, 0)
      assert.equal(browser.classes.size, 0)
      assert.equal(browser.timers.size, 0)
      assert.equal(browser.listeners.get('afterprint')?.size, 0)
    } finally {
      if (mounted) unmount()
    }
  })
})

test('失焦后的打印回退仅在重新可见且聚焦时清理，关闭和旧回调不影响新会话', async () => {
  await withBrowser(async (browser) => {
    const { state, props, unmount } = await mountSetup([], true)
    try {
      readyToPrint(state)
      await state.handlePrint()
      const oldAfterPrint = [...browser.listeners.get('afterprint')][0]
      const oldTimeout = [...browser.timers.values()][0].callback
      browser.dispatch('blur')
      browser.dispatch('focus')
      assert.deepEqual([...browser.timers.values()].map((timer) => timer.delay), [750])
      browser.document.visibilityState = 'hidden'
      browser.runTimer([...browser.timers.keys()][0])
      assert.equal(state.printing.value, true)
      assert.deepEqual([...browser.timers.values()].map((timer) => timer.delay), [120_000])
      props.modelValue = false
      await nextTick()
      assert.equal(state.printing.value, false)
      assert.equal(browser.styles.size, 0)
      assert.equal(browser.timers.size, 0)
      assert.equal(browser.listeners.get('afterprint')?.size, 0)

      browser.document.visibilityState = 'visible'
      props.modelValue = true
      await nextTick()
      await state.handlePrint()
      assert.equal(browser.printed.length, 2)
      oldAfterPrint()
      oldTimeout()
      assert.equal(state.printing.value, true, '前一会话的迟到事件不得清理当前会话')
      assert.equal(browser.styles.size, 1)
      browser.runTimer([...browser.timers.keys()][0])
      assert.equal(state.printing.value, false)
      assert.equal(browser.styles.size, 0)
    } finally {
      unmount()
    }
  })
})

test('打印窗口异常及在 nextTick 前关闭弹窗均清理监听和页面打印样式', async () => {
  await withBrowser(async (browser) => {
    const { state, props, unmount } = await mountSetup([], true)
    try {
      readyToPrint(state)
      browser.setPrint(() => { throw new Error('隔离打印异常') })
      await state.handlePrint()
      assert.equal(state.printing.value, false)
      assert.equal(browser.styles.size, 0)
      assert.equal(browser.listeners.get('afterprint')?.size, 0)
      assert.equal(calls.errors.at(-1)?.message, '隔离打印异常')

      browser.setPrint(() => { browser.printed.push(true) })
      const pending = state.handlePrint()
      props.modelValue = false
      await pending
      await nextTick()
      assert.equal(browser.printed.length, 0, '已关闭弹窗不得打开打印窗口')
      assert.equal(state.printing.value, false)
      assert.equal(browser.styles.size, 0)
      assert.equal(browser.timers.size, 0)
    } finally {
      unmount()
    }
  })
})

test('模板切换时默认条码来源随模板更新，手选的非默认原厂口径保留', async () => {
  const { state, unmount } = await mountSetup()
  try {
    const label = testLabel('WC02001', 'FACTORY-1')
    assert.equal(state.settings.barcodeSource, 'factory_barcode_first')
    state.settings.template = 'yz-full'
    await nextTick()
    assert.equal(state.settings.barcodeSource, 'sku_code')
    assert.equal(state.encodedTextFor(label), 'WC02001')
    state.settings.barcodeSource = 'factory_barcode'
    state.settings.template = 'a4'
    await nextTick()
    assert.equal(state.settings.barcodeSource, 'factory_barcode')
    assert.equal(state.encodedTextFor(label), 'FACTORY-1')
  } finally {
    unmount()
  }
})

test('真实 SVG 生成复用重复条码，并将空原厂码和生成异常列为打印阻断原因', async () => {
  await withBrowser(async (browser) => {
    const { state, unmount } = await mountSetup()
    try {
      state.settings.barcodeSource = 'factory_barcode'
      await nextTick()
      state.labels.value = [testLabel('WC02001'), testLabel('WC02001'), testLabel('WC02002', '')]
      await state.renderBarcodes()
      assert.equal(browser.svgCreated.length, 1, '相同实际编码值只应生成一次 SVG')
      assert.match(state.barcodeSvgMap.value['FACTORY-1'], /^<svg/)
      assert.ok(state.barcodeModuleMap.value['FACTORY-1'] > 0)
      assert.deepEqual(state.failedBarcodes.value, ['WC02002（无原厂条码）'])
      assert.match(state.printBlockedReason.value, /WC02002（无原厂条码）/)

      state.labels.value = [testLabel('WC02001', '🙂'), testLabel('WC02002', 'FACTORY-2')]
      await state.renderBarcodes()
      assert.deepEqual(state.failedBarcodes.value, ['🙂'])
      assert.match(state.barcodeSvgMap.value['FACTORY-2'], /^<svg/)
      assert.match(state.printBlockedReason.value, /🙂/)
      assert.match(calls.warnings.at(-1), /🙂/)

      browser.corruptViewBox = true
      state.labels.value = [testLabel('WC02003', 'FACTORY-3')]
      await state.renderBarcodes()
      assert.deepEqual(state.failedBarcodes.value, ['FACTORY-3'])
      assert.equal(state.barcodeSvgMap.value['FACTORY-3'], undefined)
      assert.match(state.printBlockedReason.value, /FACTORY-3/)
    } finally {
      unmount()
    }
  })
})

test('真实长条码被密度门槛阻断，YZ 详情标签可通过隐藏附加字段恢复净高', async () => {
  await withBrowser(async () => {
    const { state, unmount } = await mountSetup()
    try {
      state.settings.barcodeSource = 'factory_barcode'
      await nextTick()
      const longValue = `FACTORY-${'A'.repeat(80)}`
      state.labels.value = [testLabel('WC02004', longValue)]
      await state.renderBarcodes()
      assert.match(state.barcodeSvgMap.value[longValue], /^<svg/)
      assert.ok(state.barcodeModuleMap.value[longValue] > 100)
      assert.match(state.barcodeDensityError.value, /条码每模块/)
      assert.match(state.printBlockedReason.value, /低于.*保守阈值/)

      state.labels.value = [testLabel('WC02005', 'FACTORY-5')]
      await state.renderBarcodes()
      state.settings.template = 'yz-full'
      state.settings.labelHeightMm = 20
      state.settings.showPrice = true
      state.settings.showLocation = true
      state.settings.showPrintDate = true
      await nextTick()
      assert.match(state.labelLayoutError.value, /条码区/)
      assert.match(state.printBlockedReason.value, /至少需要 8 毫米/)
      state.settings.showPrice = false
      state.settings.showLocation = false
      assert.match(state.labelLayoutError.value, /条码区/, '仅保留日期时净高仍不足')
      state.settings.showPrintDate = false
      assert.equal(state.labelLayoutError.value, '')
      assert.equal(state.printBlockedReason.value, '')

      state.settings.template = 'thermal'
      state.settings.labelHeightMm = 23
      state.settings.showLocation = true
      await nextTick()
      assert.match(state.labelLayoutError.value, /条码区/, '旧模板显示库位时需预留页脚高度')
      state.settings.showLocation = false
      assert.equal(state.labelLayoutError.value, '')
      state.settings.showPrice = true
      assert.match(state.labelLayoutError.value, /条码区/, '旧模板显示售价时同样占用页脚高度')
    } finally {
      unmount()
    }
  })
})
