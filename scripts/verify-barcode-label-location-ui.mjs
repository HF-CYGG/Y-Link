/** #178：生产 SFC 初始化、临时选择、同批复读、四模板和冻结生命周期场景。 */
import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { watch } from 'vue'
import { calls, withBrowser, mountSetup, replaceLabels, setLabelsResponse, testLabel, resetBarcodeHost, deferred, flush } from './barcode-behavior-test-runtime.mjs'
afterEach(resetBarcodeHost)
const limited = (label) => ({ ...label, printLocations: { capability: 'main_only', mainLocationId: 'main', mainLocationCode: 'A', mainLocationStatus: 'valid', options: [{ locationId: 'main', locationCode: 'A', isMain: true }] } })
test('full 主0件默认可选，每SKU独立；份数与显示开关不修改条码或真实主库位', async () => withBrowser(async (browser) => {
  const { state } = await mountSetup()
  await replaceLabels(state, [testLabel('WC02001'), testLabel('WC02002')])
  assert.deepEqual(state.selectedLocationIds.value, { WC02001: 'main', WC02002: 'main' })
  state.setPrintLocation('WC02001', 'other'); state.settings.copies = 3; state.settings.showLocation = true
  assert.deepEqual(state.selectedLabels.value.map((label) => label.locationCode), ['B','A'])
  assert.deepEqual(state.labels.value.map((label) => label.locationCode), ['A','A'])
  state.settings.showLocation = false; assert.equal(state.totalLabelCount.value, 6)
  state.settings.showLocation = true; assert.equal(state.selectedLocationIds.value.WC02001, 'other')
  for (const template of ['thermal','a4','yz-full','yz-compact']) {
    state.settings.template = template; await flush()
    const source = state.settings.barcodeSource
    const beforeSvg = state.barcodeSvgFor(state.selectedLabels.value[0])
    await state.handlePrint()
    assert.equal(state.frozenPrint.value.settings.template, template)
    assert.equal(state.expandedLabels.value.length, 6)
    assert.equal(state.frozenPrint.value.labels[0].locationCode, 'B')
    assert.equal(state.printBarcodeSvgFor(state.frozenPrint.value.labels[0]), beforeSvg)
    assert.equal(state.printSettings.value.barcodeSource, source)
    browser.dispatch('afterprint')
  }
  assert.equal(browser.printed.length, 4)
  assert.equal(calls.loading, 5, '一次初始加载，每次打印必须同批复读')
}))
test('main_only 真实加载只选主库位，不能用不存在的其他候选修改', async () => withBrowser(async (browser) => {
  const { state } = await mountSetup(); const label = limited(testLabel())
  await replaceLabels(state, [label]); state.settings.showLocation = true
  state.setPrintLocation(label.skuId, 'other'); assert.equal(state.selectedLocationIds.value[label.skuId], 'main')
  assert.ok(!('distributionKey' in state.labels.value[0].printLocations))
  assert.ok(!('qty' in state.labels.value[0].printLocations.options[0]))
  await state.handlePrint(); assert.equal(browser.printed.length, 1)
}))
test('主库位未设置/缺失/停用：有效其他库位须明确选择，不能静默回主', async () => withBrowser(async () => {
  for (const status of ['unset','missing','disabled']) {
    const { state, unmount } = await mountSetup(); const label = testLabel()
    label.printLocations.mainLocationStatus = status; if(status==='unset'){label.printLocations.mainLocationId=null;label.printLocations.mainLocationCode=null;label.locationCode=null} label.printLocations.options = label.printLocations.options.filter((option) => !option.isMain)
    await replaceLabels(state, [label]); state.settings.showLocation = true
    assert.equal(state.selectedLocationIds.value[label.skuId], null); assert.match(state.printBlockedReason.value, /选择有效打印库位/)
    state.setPrintLocation(label.skuId, 'other'); await state.handlePrint(); assert.equal(state.frozenPrint.value.labels[0].locationCode, 'B')
    unmount()
  }
}))
test('过滤项分布变化中止且保留选择；刷新确认后仍需重新复读', async () => withBrowser(async (browser) => {
  const { state } = await mountSetup(); const original = testLabel(); await replaceLabels(state, [original]); state.setPrintLocation(original.skuId,'other')
  const latest = structuredClone(original); latest.printLocations.distributionKey = 'disabled-location-qty-changed'
  setLabelsResponse(async () => [structuredClone(latest)])
  await state.handlePrint(); assert.equal(browser.printed.length,0); assert.match(state.preflightMessage.value,/分布已变化/)
  assert.equal(state.selectedLocationIds.value[original.skuId],'other')
  await state.refreshPrintData(); assert.equal(state.requiresLocationConfirmation.value,true)
  state.confirmRefreshedPrintData(); const before = calls.loading; await state.handlePrint()
  assert.equal(calls.loading,before+1); assert.equal(browser.printed.length,1)
}))
test('权限降级中止，不保留失效的其他库位；显式选择新主候选后确认', async () => withBrowser(async (browser) => {
  const { state } = await mountSetup(); const original = testLabel(); await replaceLabels(state,[original]); state.settings.showLocation=true; state.setPrintLocation(original.skuId,'other')
  setLabelsResponse(async () => [limited(original)])
  await state.handlePrint(); assert.match(state.preflightMessage.value,/权限已变化/); assert.equal(browser.printed.length,0)
  assert.equal(state.selectedLocationIds.value[original.skuId],null)
  state.setPrintLocation(original.skuId,'main'); state.confirmRefreshedPrintData(); await state.handlePrint(); assert.equal(browser.printed.length,1)
}))
test('初次失败/打印前失败不能当零数据成功，刷新失败保留本次意图', async () => withBrowser(async (browser) => {
  setLabelsResponse(async () => { throw new Error('隔离网络失败') })
  const failed = await mountSetup(['missing'],true); assert.match(failed.state.loadError.value,/加载失败/)
  await failed.state.handlePrint(); assert.equal(browser.printed.length,0); failed.unmount()
  const { state } = await mountSetup(); await replaceLabels(state,[testLabel()]); state.setPrintLocation('WC02001','other')
  setLabelsResponse(async () => { throw new Error('隔离复读失败') }); await state.handlePrint()
  assert.match(state.preflightMessage.value,/复核失败/); assert.equal(state.selectedLocationIds.value.WC02001,'other')
  await state.refreshPrintData(); assert.match(state.preflightMessage.value,/刷新失败/); assert.equal(browser.printed.length,0)
}))
test('迟到预检、关闭/卸载和重复点击不能开启或恢复旧打印', async () => withBrowser(async (browser) => {
  for (const action of ['close','unmount']) for (const outcome of ['resolve','reject']) {
    const { state, props, unmount } = await mountSetup(); await replaceLabels(state,[testLabel()])
    const waiting=deferred(); setLabelsResponse(() => waiting.promise); const before=calls.loading
    const first=state.handlePrint(); await state.handlePrint(); assert.equal(calls.loading,before+1)
    if(action==='close') props.modelValue=false; else unmount()
    waiting[outcome](outcome==='resolve'?[testLabel()]:new Error('旧复读失败')); await first; await flush()
    assert.equal(state.printing.value,false); assert.equal(state.frozenPrint.value,null); assert.equal(browser.printed.length,0); unmount()
  }
}))
test('冻结后设置/SVG/选择变化不污染打印；nextTick 批次变化时不打开窗口', async () => withBrowser(async (browser) => {
  const { state, props } = await mountSetup(); await replaceLabels(state,[testLabel()]); state.settings.showLocation=true; state.setPrintLocation('WC02001','other')
  await state.handlePrint(); const frozen=state.frozenPrint.value; const svg=state.printBarcodeSvgFor(frozen.labels[0]); const text=state.printEncodedTextFor(frozen.labels[0])
  state.settings.copies=9; state.settings.labelWidthMm=90; state.settings.showCode=false
  state.barcodeSvgMap.value={}; state.selectedLocationIds.value={ WC02001:'main' }
  assert.equal(state.expandedLabels.value.length,frozen.settings.copies); assert.equal(state.printSettings.value.labelWidthMm,40)
  assert.equal(state.printBarcodeSvgFor(frozen.labels[0]),svg); assert.equal(state.printEncodedTextFor(frozen.labels[0]),text); assert.equal(frozen.labels[0].locationCode,'B')
  browser.dispatch('afterprint'); await replaceLabels(state,[testLabel()])
  const stop=watch(state.printing,(value)=>{ if(value) props.skuIds=['new-batch'] },{flush:'sync'})
  await state.handlePrint(); stop(); assert.equal(browser.printed.length,1); assert.equal(state.printing.value,false)
}))
