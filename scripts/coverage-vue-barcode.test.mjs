/** 原条码回归场景：挂载生产 SFC，经真实 loadLabels/复读与 handler，不合成打印就绪。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test, { before, after, beforeEach, afterEach } from 'node:test'
import { nextTick } from 'vue'
import { root, buildModule } from './vue-behavior-test-runtime.mjs'
import { calls, flush, withBrowser, deferred, unmountAll, mountSetup, replaceLabels as loadProductionLabels, setLabelsResponse, testLabel, resetBarcodeHost } from './barcode-behavior-test-runtime.mjs'
const helperPath = path.join(root, 'src/views/inventory/components/barcode-label-print.helpers.ts')
const outputRoot = path.join(root, 'tmp/coverage-vue-barcode')
const helperOutput = path.join(outputRoot, 'barcode-label-print-helpers.mjs')
const { getLabelContentFit } = await buildModule('src/views/inventory/components/barcode-label-print.helpers.ts', helperOutput)
let loadResult = async () => []
let defaultBrowserLifetime
const lifetime = deferred()
before(() => { defaultBrowserLifetime = withBrowser(async () => { await lifetime.promise }) })
after(async () => { lifetime.resolve(); await defaultBrowserLifetime })
beforeEach(() => { resetBarcodeHost(); loadResult = async () => []; setLabelsResponse((...args) => loadResult(...args)) })
afterEach(() => unmountAll())
const setup = async (skuIds = []) => (await mountSetup(skuIds, false)).state
const replaceLabels = async (state, labels) => {
  loadResult = async () => structuredClone(labels)
  await loadProductionLabels(state, labels)
  setLabelsResponse((...args) => loadResult(...args))
}
const readyToPrint = async (state, label = testLabel()) => { await replaceLabels(state, [label]); assert.equal(state.printBlockedReason.value, '') }
test('独立 helper 编译产物保留真实 TS 源码图供覆盖率归属', () => {
  assert.match(fs.readFileSync(helperOutput, 'utf8'), /sourceMappingURL=barcode-label-print-helpers\.mjs\.map/u)
  const map = JSON.parse(fs.readFileSync(`${helperOutput}.map`, 'utf8'))
  assert.equal(map.file, path.basename(helperOutput))
  assert.deepEqual(map.sources.map((source) => path.resolve(outputRoot, source)), [helperPath])
  assert.deepEqual(map.sourcesContent, [fs.readFileSync(helperPath, 'utf8')])
})
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
  const label = testLabel('WC02001', '')
  await replaceLabels(state, [label])
  state.barcodeSvgMap.value = Object.create(null)
  assert.deepEqual(state.missingBarcodes.value, ['WC02001'])
  assert.match(state.printBlockedReason.value, /WC02001/)
  state.settings.barcodeSource = 'factory_barcode'
  assert.equal(state.encodedTextFor(label), '')
  assert.deepEqual(state.missingBarcodes.value, ['WC02001（无原厂条码）'])
  assert.match(state.printBlockedReason.value, /无原厂条码/)
  assert.equal(calls.loading, 1, '只有初始化请求，本地缺图校验不得额外请求')
})

test('只打印勾选的规格：取消勾选后不参与缺码检查与计数，全不选时阻断打印', async () => {
  const state = await setup()
  const ok = testLabel('WC02001')
  const broken = testLabel('WC02002', '')
  state.settings.barcodeSource = 'factory_barcode'
  await replaceLabels(state, [ok, broken])
  assert.deepEqual(state.missingBarcodes.value, ['WC02002（无原厂条码）'], '默认全选时缺码规格应阻断')
  state.toggleSkuSelected(broken.skuId, false)
  assert.deepEqual(state.missingBarcodes.value, [], '未勾选的规格不参与缺码检查')
  assert.equal(state.totalLabelCount.value, state.settings.copies)
  assert.equal(state.printBlockedReason.value, '')
  state.toggleAllSelected(false)
  assert.equal(state.printBlockedReason.value, '请至少勾选一个要打印的规格')
  state.toggleAllSelected(true)
  assert.equal(state.selectedLabels.value.length, 2)
})

test('手动 30×20 是唯一纸张尺寸，长旧编码生成及打印不得反写尺寸', async () => {
  await withBrowser(async (browser) => {
    const { state, unmount } = await mountSetup([], true)
    try {
      state.labelWidthModel.value = 30
      state.labelHeightModel.value = 20
      state.settings.barcodeSource = 'sku_code'
      const values = ['P-260420-0008-SKU-1', 'P-260420-0007-SKU-1-2', 'P-260420-0003-DEFAULT']
      await replaceLabels(state, values.map((value) => testLabel(value)))
      await nextTick()
      assert.deepEqual([state.labelWidthModel.value, state.labelHeightModel.value], [30, 20])
      assert.deepEqual(state.thermalStyle.value, { width: '30mm', height: '20mm' })
      assert.equal(state.printBlockedReason.value, '')
      await state.handlePrint()
      assert.equal(browser.printed.length, 1)
      assert.match([...browser.styles.values()][0].textContent, /@page \{ size: 30mm 20mm; margin: 0; \}/)
      assert.deepEqual([state.settings.labelWidthMm, state.settings.labelHeightMm], [30, 20])
    } finally { unmount() }
  })
})

test('首选字号旧存储默认 9pt，4–24pt 只影响内部字号且打印持久化', async () => {
  await withBrowser(async (browser) => {
    browser.saved.set('y-link:barcode-label-settings', JSON.stringify({
      template: 'thermal', labelWidthMm: 30, labelHeightMm: 20, fontSizePt: 99,
    }))
    const { state, unmount } = await mountSetup([], true)
    try {
      assert.equal(state.settings.fontSizePt, 9)
      state.settings.barcodeSource = 'sku_code'
      const label = testLabel('P-260420-0008-SKU-1')
      await replaceLabels(state, [label])
      const baseline = getLabelContentFit(state.settings).scale
      state.fontSizeModel.value = 4
      assert.equal(state.settings.fontSizePt, 4)
      assert.ok(getLabelContentFit(state.settings).scale <= 4 / 9)
      assert.ok(getLabelContentFit(state.settings).scale <= baseline)
      state.fontSizeModel.value = 24
      assert.equal(state.settings.fontSizePt, 24)
      assert.ok(getLabelContentFit(state.settings).scale <= 24 / 9)
      assert.deepEqual([state.settings.labelWidthMm, state.settings.labelHeightMm], [30, 20])
      await state.handlePrint()
      assert.equal(browser.printed.length, 1)
      assert.match([...browser.styles.values()][0].textContent, /size: 30mm 20mm/)
      assert.equal(JSON.parse(browser.saved.get('y-link:barcode-label-settings')).fontSizePt, 24)
    } finally { unmount() }
  })
})

test('数字清空编辑暂态不改纸张与 A4 排版，失焦同步显示真实约束值', async () => {
  await withBrowser(async () => {
    const { state, unmount } = await mountSetup()
    try {
      state.labelWidthModel.value = null
      assert.equal(state.settings.labelWidthMm, 40)
      state.commitNumberDraft('labelWidthMm')
      assert.equal(state.settings.labelWidthMm, 40)
      assert.equal(state.inputRevision.labelWidthMm, 1)
      state.settings.template = 'a4'
      state.labelWidthModel.value = 50
      assert.equal(state.settings.columns, 3)
      state.rowsModel.value = 9
      assert.equal(state.settings.rows, 8)
      state.commitNumberDraft('rows')
      assert.equal(state.inputRevision.rows, 1)
      state.fontSizeModel.value = null
      state.commitNumberDraft('fontSizePt')
      assert.equal(state.settings.fontSizePt, 9)
      assert.equal(state.inputRevision.fontSizePt, 1)
    } finally { unmount() }
  })
})

test('打印数量与 A4 版式越界分别阻断，预览和分页只复制已生成的标签', async () => {
  const state = await setup()
  const label = testLabel('WC02001', '')
  await replaceLabels(state, [label])
  assert.match(state.barcodeSvgFor(label), /^<svg/)
  assert.deepEqual(state.missingBarcodes.value, [])

  state.settings.template = 'a4'
  state.settings.columns = 6
  state.settings.labelWidthMm = 200
  assert.match(state.a4LayoutError.value, /超出 A4 可打印区域/)
  assert.match(state.printBlockedReason.value, /超出 A4 可打印区域/)

  // 先恢复真实纸宽再设置列数；生产同步收敛会按当前200mm纸宽将先写入的3列压成1列。
  state.settings.labelWidthMm = 40
  state.settings.columns = 3
  await replaceLabels(state, Array.from({ length: 11 }, (_, index) => testLabel(`WC02${String(index).padStart(3, '0')}`)))
  state.settings.copies = 200
  assert.equal(state.totalLabelCount.value, 2200)
  assert.equal(state.exceedsLimit.value, true)
  assert.match(state.printBlockedReason.value, /单次最多打印 2000 张/)

  state.settings.copies = 2
  assert.equal(state.previewA4Labels.value.length, 22)
  await state.handlePrint()
  assert.equal(state.expandedLabels.value.length, 22)
  assert.equal(state.a4Pages.value.length, 1)
  state.finishPrintSession()
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
  await replaceLabels(state, [testLabel('OLD', '')])
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
      await readyToPrint(state)
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
      await readyToPrint(state)
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
      await readyToPrint(state)
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
      await readyToPrint(state)
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

test('开始退场但父modelValue仍为true时，迟到前检不得打印', async () => {
  await withBrowser(async (browser) => {
    const { state, props } = await mountSetup()
    const label = testLabel('WC02001')
    await readyToPrint(state, label)
    const held = deferred()
    loadResult = () => held.promise
    const pending = state.handlePrint()
    await flush()
    assert.equal(state.preflighting.value, true)
    assert.equal(props.modelValue, true)
    state.handleDialogClosing()
    assert.equal(props.modelValue, true, '模拟Element Plus在动画结束前尚未回传modelValue')
    held.resolve([label]); await pending; await nextTick()
    assert.equal(browser.printed.length, 0, '开始关闭即撤销代次，不能等动画结束')
    assert.equal(state.frozenPrint.value, null)
    assert.equal(browser.styles.size, 0)
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
      await replaceLabels(state, [testLabel('WC02001'), testLabel('WC02001'), testLabel('WC02002', '')])
      assert.equal(browser.svgCreated.length, 1, '相同实际编码值只应生成一次 SVG')
      assert.match(state.barcodeSvgMap.value['FACTORY-1'], /^<svg/)
      assert.ok(state.barcodeModuleMap.value['FACTORY-1'] > 0)
      assert.deepEqual(state.failedBarcodes.value, ['WC02002（无原厂条码）'])
      assert.match(state.printBlockedReason.value, /WC02002（无原厂条码）/)

      await replaceLabels(state, [testLabel('WC02001', '🙂'), testLabel('WC02002', 'FACTORY-2')])
      assert.deepEqual(state.failedBarcodes.value, ['🙂'])
      assert.match(state.barcodeSvgMap.value['FACTORY-2'], /^<svg/)
      assert.match(state.printBlockedReason.value, /🙂/)
      assert.match(calls.warnings.at(-1), /🙂/)

      browser.corruptViewBox = true
      await replaceLabels(state, [testLabel('WC02003', 'FACTORY-3')])
      assert.deepEqual(state.failedBarcodes.value, ['FACTORY-3'])
      assert.equal(state.barcodeSvgMap.value['FACTORY-3'], undefined)
      assert.match(state.printBlockedReason.value, /FACTORY-3/)
    } finally {
      unmount()
    }
  })
})

test('长条码密度只警告，四模板字段增多时保持手动高度', async () => {
  await withBrowser(async () => {
    const { state, unmount } = await mountSetup()
    try {
      state.settings.barcodeSource = 'factory_barcode'
      await nextTick()
      const longValue = `FACTORY-${'A'.repeat(80)}`
      await replaceLabels(state, [testLabel('WC02004', longValue)])
      assert.match(state.barcodeSvgMap.value[longValue], /^<svg/)
      assert.ok(state.barcodeModuleMap.value[longValue] > 100)
      assert.match(state.barcodeDensityWarning.value, /条码每模块/)
      state.settings.showCode = false
      assert.equal(state.printBlockedReason.value, '')

      await replaceLabels(state, [testLabel('WC02005', 'FACTORY-5')])
      state.settings.template = 'yz-full'
      state.settings.labelHeightMm = 20
      state.settings.showPrice = true
      state.settings.showLocation = true
      state.settings.showPrintDate = true
      await nextTick()
      assert.equal(state.settings.labelHeightMm, 20)
      assert.equal(state.labelLayoutError.value, '')
      assert.equal(state.printBlockedReason.value, '')

      state.settings.template = 'thermal'
      state.settings.labelHeightMm = 23
      state.settings.showLocation = true
      await nextTick()
      assert.equal(state.settings.labelHeightMm, 23)
      assert.equal(state.labelLayoutError.value, '')
      assert.equal(state.settings.showLocation, true)
    } finally {
      unmount()
    }
  })
})

test('批次最长 SKU 完成生成后保持手动尺寸，并同步预览与打印纸张', async () => {
  await withBrowser(async (browser) => {
    const { state, unmount } = await mountSetup([], true)
    try {
      state.settings.barcodeSource = 'sku_code'
      await replaceLabels(state, [testLabel('P-260420-0008-SKU-1'), testLabel('P-260420-0008-SKU-12')])
      await nextTick()
      assert.equal(state.settings.labelWidthMm, 40)
      assert.deepEqual(state.thermalStyle.value, { width: '40mm', height: '30mm' })
      assert.match(state.barcodeDensityWarning.value, /低于.*保守阈值/)
      assert.equal(state.printBlockedReason.value, '')
      await state.handlePrint()
      assert.equal(browser.printed.length, 1)
      assert.match([...browser.styles.values()][0].textContent, /@page \{ size: 40mm 30mm; margin: 0; \}/)
    } finally {
      unmount()
    }
  })
})

test('A4 长码不改变手动宽高，仅在版式越界时减少列数', async () => {
  await withBrowser(async () => {
    const { state, unmount } = await mountSetup()
    try {
      state.settings.template = 'a4'
      state.settings.barcodeSource = 'sku_code'
      await replaceLabels(state, [testLabel('P-260420-0008-SKU-12')])
      await nextTick()
      assert.equal(state.settings.labelWidthMm, 40)
      assert.equal(state.settings.columns, 3)
      assert.equal(state.a4LayoutError.value, '')
      assert.deepEqual(state.a4GridStyle.value, {
        gridTemplateColumns: 'repeat(3, 40mm)', gridTemplateRows: 'repeat(8, 30mm)',
      })
      state.labelWidthModel.value = 70
      assert.equal(state.settings.columns, 2)
      assert.match(state.autoLayoutNotice.value, /2 列/)
    } finally {
      unmount()
    }
  })
})

test('过长可读文字与密度只提示，隐藏文字仍保留原条码', async () => {
  await withBrowser(async () => {
    const { state, unmount } = await mountSetup()
    try {
      state.settings.barcodeSource = 'sku_code'
      await replaceLabels(state, [testLabel('A'.repeat(64))])
      await nextTick()
      assert.equal(state.settings.labelWidthMm, 40)
      assert.equal(state.printBlockedReason.value, '')
      assert.match(state.barcodeTextWarning.value, /完整编码文字.*基本可读建议/)
      state.settings.showCode = false
      assert.equal(state.printBlockedReason.value, '')
      assert.match(state.barcodeDensityWarning.value, /保守阈值/)
    } finally {
      unmount()
    }
  })
})

test('旧本机设置默认显示可读编码，隐藏仅改变版式不改变实际编码', async () => {
  await withBrowser(async (browser) => {
    browser.saved.set('y-link:barcode-label-settings', JSON.stringify({ template: 'thermal', labelHeightMm: 23 }))
    const { state, unmount } = await mountSetup()
    try {
      assert.equal(state.settings.showCode, true)
      const label = testLabel('WC02001')
      state.settings.barcodeSource = 'sku_code'
      await replaceLabels(state, [label])
      state.barcodeModuleMap.value = { WC02001: 101 }
      assert.equal(state.settings.labelHeightMm, 23)
      assert.equal(state.labelLayoutError.value, '')
      state.settings.showCode = false
      assert.equal(state.encodedTextFor(label), 'WC02001')
      assert.match(state.barcodeSvgFor(label), /^<svg/)
      assert.equal(state.labelLayoutError.value, '')
    } finally {
      unmount()
    }
  })
})

test('小热敏标签保持全字段及纸高，显示开关只改变内部条码净高', async () => {
  const state = await setup()
  state.settings.template = 'thermal'
  state.settings.labelWidthMm = 30
  state.settings.labelHeightMm = 20
  state.settings.barcodeSource = 'sku_code'
  state.settings.showSpec = true
  state.settings.showPrice = true
  state.settings.showCode = true
  assert.equal(state.labelLayoutError.value, '')
  const fullHeight = getLabelContentFit(state.settings).graphicHeightMm
  state.settings.showCode = false
  assert.equal(state.labelLayoutError.value, '')
  assert.ok(getLabelContentFit(state.settings).graphicHeightMm >= fullHeight)
  state.settings.showSpec = false
  assert.equal(state.labelLayoutError.value, '')
  assert.deepEqual([state.settings.labelWidthMm, state.settings.labelHeightMm], [30, 20])
})

test('手工缩小和放大宽度均保持原值，条码密度风险不能反写输入', async () => {
  await withBrowser(async () => {
    const { state, unmount } = await mountSetup()
    try {
      state.settings.barcodeSource = 'sku_code'
      await replaceLabels(state, [testLabel('P-260420-0008-SKU-1')])
      assert.equal(state.settings.labelWidthMm, 40)
      state.labelWidthModel.value = 40
      assert.equal(state.settings.labelWidthMm, 40)
      state.labelWidthModel.value = 70
      assert.equal(state.settings.labelWidthMm, 70)
      state.labelWidthModel.value = 30
      assert.equal(state.settings.labelWidthMm, 30)
      assert.match(state.barcodeDensityWarning.value, /保守阈值/)
    } finally {
      unmount()
    }
  })
})

test('隐藏可读编码时长数字码保持尺寸和原条形编码', async () => {
  await withBrowser(async () => {
    const { state, unmount } = await mountSetup()
    try {
      state.settings.barcodeSource = 'sku_code'
      state.settings.showCode = false
      await replaceLabels(state, [testLabel('123456789012345678901234567890')])
      assert.equal(state.settings.labelWidthMm, 40)
      assert.equal(state.printBlockedReason.value, '')
      assert.match(state.barcodeSvgMap.value['123456789012345678901234567890'], /^<svg/)
    } finally {
      unmount()
    }
  })
})

test('显示完整长数字码时收缩人眼字体而非纸宽', async () => {
  await withBrowser(async () => {
    const { state, unmount } = await mountSetup()
    try {
      state.settings.barcodeSource = 'sku_code'
      await replaceLabels(state, [testLabel('123456789012345678901234567890')])
      assert.equal(state.settings.labelWidthMm, 40)
      assert.equal(state.settings.labelHeightMm, 30)
      assert.equal(state.printBlockedReason.value, '')
    } finally {
      unmount()
    }
  })
})

test('切换到 YZ 模板先更新默认来源，不按迟到的旧原厂模块扩宽', async () => {
  await withBrowser(async () => {
    const { state, unmount } = await mountSetup()
    try {
      const label = { ...testLabel('WC02001', 'FACTORY-' + 'A'.repeat(28)), barcode: 'FACTORY-' + 'A'.repeat(28) }
      await replaceLabels(state, [label])
      state.settings.template = 'yz-full'
      assert.equal(state.settings.barcodeSource, 'sku_code', '模板切换需先确定新编码来源')
      state.barcodeModuleMap.value = { [label.factoryBarcode]: 420 }
      assert.equal(state.settings.labelWidthMm, 40, '迟到的旧原厂模块不得再扩大新模板')
      assert.equal(state.settings.labelWidthMm, 40)
    } finally {
      unmount()
    }
  })
})

test('手动选择原厂条码后切换 YZ 模板仍保留原厂值和手动尺寸', async () => {
  await withBrowser(async () => {
    const { state, unmount } = await mountSetup()
    try {
      state.settings.barcodeSource = 'factory_barcode'
      state.settings.template = 'yz-compact'
      assert.equal(state.settings.barcodeSource, 'factory_barcode')
      await replaceLabels(state, [testLabel('WC02001', 'FACTORY-' + 'A'.repeat(28))])
      assert.equal(state.settings.labelWidthMm, 40)
      assert.equal(state.encodedTextFor(state.labels.value[0]), 'FACTORY-' + 'A'.repeat(28))
      assert.equal(state.printBlockedReason.value, '')
    } finally {
      unmount()
    }
  })
})

test('30×20 热敏全字段在固定纸张内适配，打印纸型仍为 30×20', async () => {
  await withBrowser(async (browser) => {
    const { state, unmount } = await mountSetup([], true)
    try {
      state.settings.barcodeSource = 'sku_code'
      state.settings.labelWidthMm = 30
      state.settings.labelHeightMm = 20
      state.settings.showSpec = true
      state.settings.showCode = true
      state.settings.showPrice = true
      await replaceLabels(state, [testLabel('WC02001')])
      await nextTick()
      assert.deepEqual([state.settings.labelWidthMm, state.settings.labelHeightMm], [30, 20])
      assert.deepEqual([state.settings.showSpec, state.settings.showCode, state.settings.showPrice], [true, true, true])
      assert.equal(state.labelLayoutError.value, '')
      assert.equal(state.printBlockedReason.value, '')
      assert.ok(getLabelContentFit(state.settings).graphicHeightMm >= 8)
      await state.handlePrint()
      assert.equal(browser.printed.length, 1)
      assert.match([...browser.styles.values()][0].textContent,
        new RegExp(`size: ${state.settings.labelWidthMm}mm ${state.settings.labelHeightMm}mm`))
    } finally { unmount() }
  })
})

test('四模板保留全部字段，以内部缩放适配 30×20 纸张', async () => {
  await withBrowser(async () => {
    const { state, unmount } = await mountSetup()
    try {
      await replaceLabels(state, [testLabel('WC02001')])
      state.settings.barcodeSource = 'sku_code'
      for (const template of ['thermal', 'a4', 'yz-full', 'yz-compact']) {
        state.settings.template = template
        state.settings.showSpec = true
        state.settings.showCode = true
        state.settings.showPrice = true
        state.settings.showLocation = true
        state.settings.showPrintDate = true
        state.settings.labelWidthMm = 30
        state.settings.labelHeightMm = 20
        assert.equal(state.labelLayoutError.value, '', template)
        assert.deepEqual([state.settings.labelWidthMm, state.settings.labelHeightMm], [30, 20], template)
        assert.ok(getLabelContentFit(state.settings).graphicHeightMm >= 2, template)
        assert.deepEqual([state.settings.showSpec, state.settings.showCode, state.settings.showPrice,
          state.settings.showLocation, state.settings.showPrintDate], [true, true, true, true, true])
      }
    } finally { unmount() }
  })
})

test('A4 手工和旧存储越界均自动减少行列，宽度未改变也修正', async () => {
  await withBrowser(async (browser) => {
    browser.saved.set('y-link:barcode-label-settings', JSON.stringify({
      template: 'a4', labelWidthMm: 50, labelHeightMm: 30, columns: 6, rows: 16,
    }))
    const { state, unmount } = await mountSetup()
    try {
      assert.equal(state.settings.columns, 3)
      assert.equal(state.settings.rows, 8)
      assert.equal(state.a4LayoutError.value, '')
      state.settings.columns = 6
      state.settings.rows = 16
      assert.equal(state.settings.columns, 3)
      assert.equal(state.settings.rows, 8)
      assert.match(state.autoLayoutNotice.value, /3 列 × 8 行/)
    } finally { unmount() }
  })
})

test('清空和更换 skuIds 时立即丢弃旧批次，迟到请求不可恢复旧标签', async () => {
  await withBrowser(async () => {
    let resolveFirst
    let resolveSecond
    loadResult = () => new Promise((resolve) => {
      if (!resolveFirst) resolveFirst = resolve
      else resolveSecond = resolve
    })
    const { state, props, unmount } = await mountSetup(['old'], true)
    try {
      props.skuIds = ['new']
      await nextTick()
      assert.deepEqual(state.labels.value, [])
      resolveSecond([testLabel('NEW')])
      await nextTick()
      resolveFirst([testLabel('OLD')])
      await flush()
      assert.deepEqual(state.labels.value.map((label) => label.skuCode), ['NEW'])
      props.skuIds = []
      await nextTick()
      assert.deepEqual(state.labels.value, [])
      assert.match(state.printBlockedReason.value, /没有可打印的标签/)
    } finally { loadResult = async () => []; unmount() }
  })
})

test('条码来源切换后迟到 SVG 生成不得混入新来源', async () => {
  await withBrowser(async () => {
    const { state, unmount } = await mountSetup()
    try {
      await replaceLabels(state, [testLabel('NEW', 'OLD')])
      state.settings.barcodeSource = 'factory_barcode'
      const oldRender = state.renderBarcodes()
      state.settings.barcodeSource = 'sku_code'
      const newRender = state.renderBarcodes()
      await Promise.all([oldRender, newRender])
      assert.equal(state.barcodeSvgMap.value.OLD, undefined)
      assert.match(state.barcodeSvgMap.value.NEW, /^<svg/)
    } finally { unmount() }
  })
})

test('准备打印到 nextTick 期间切换批次，旧打印会话不得调用 print', async () => {
  await withBrowser(async (browser) => {
    loadResult = async () => []
    const { state, props, unmount } = await mountSetup(['old'], true)
    try {
      await state.loadLabels()
      await readyToPrint(state)
      const response = deferred()
      loadResult = () => response.promise
      const pending = state.handlePrint()
      props.skuIds = ['new']
      response.resolve([])
      await pending
      assert.equal(browser.printed.length, 0)
      assert.equal(state.printing.value, false)
      assert.deepEqual(state.labels.value, [])
      assert.equal(browser.styles.size, 0)
    } finally { unmount() }
  })
})

test('截图多类长旧编码混短 SKU，所有条码保留原值且不改尺寸份数', async () => {
  await withBrowser(async () => {
    const { state, unmount } = await mountSetup()
    try {
      state.settings.barcodeSource = 'sku_code'
      state.settings.copies = 2
      const values = ['WC02001', 'P-260420-0008-SKU-1', 'P-260420-0007-SKU-1-2', 'P-260420-0003-DEFAULT']
      await replaceLabels(state, values.map((value) => testLabel(value)))
      assert.equal(state.settings.labelWidthMm, 40)
      assert.equal(state.totalLabelCount.value, 8)
      assert.equal(state.settings.copies, 2)
      assert.equal(state.printBlockedReason.value, '')
      for (const value of values) assert.match(state.barcodeSvgMap.value[value], /^<svg/)
    } finally { unmount() }
  })
})

test('父组件直接卸载时，迟到成功或失败请求均不回填、不弹旧错误', async () => {
  await withBrowser(async () => {
    for (const outcome of ['success', 'failure']) {
      let settle
      loadResult = () => new Promise((resolve, reject) => { settle = outcome === 'success' ? resolve : reject })
      const { state, unmount } = await mountSetup(['old'], true)
      const errorsBefore = calls.errors.length
      unmount()
      if (outcome === 'success') settle([testLabel('OLD')])
      else settle(new Error('过期请求失败'))
      await nextTick()
      assert.deepEqual(state.labels.value, [])
      assert.equal(state.loading.value, false)
      assert.equal(calls.errors.length, errorsBefore)
    }
    loadResult = async () => []
  })
})

test('父组件传入内容相同的新 skuIds 数组不重载，也不取消正在打印的会话', async () => {
  await withBrowser(async (browser) => {
    loadResult = async () => [testLabel('WC02001')]
    const { state, props, unmount } = await mountSetup(['same'], true)
    try {
      await state.loadLabels()
      assert.equal(state.printBlockedReason.value, '')
      await state.handlePrint()
      assert.equal(browser.printed.length, 1)
      const loadsBefore = calls.loading
      const labelsBefore = state.labels.value
      props.skuIds = ['same']
      await nextTick()
      assert.equal(calls.loading, loadsBefore)
      assert.equal(state.printing.value, true)
      assert.equal(state.labels.value, labelsBefore)
      assert.equal(browser.styles.size, 1)
    } finally { loadResult = async () => []; unmount() }
  })
})
