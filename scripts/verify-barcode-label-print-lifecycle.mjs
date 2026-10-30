/** 原生命周期回归：真实 Vue setup、初次加载、同批复读与系统打印边界。 */
import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { watch, nextTick } from 'vue'
import { withBrowser, mountSetup, readyToPrint, resetBarcodeHost, flush, deferred, setLabelsResponse, testLabel, calls } from './barcode-behavior-test-runtime.mjs'
afterEach(resetBarcodeHost)
const resources = (state, browser) => ({ printing: state.printing.value, style: browser.styles.size, bodyClass: browser.classes.size,
  listeners: [...browser.listeners.values()].reduce((sum, entries) => sum + entries.size, 0), timers: browser.timers.size })
const cleaned = { printing: false, style: 0, bodyClass: 0, listeners: 0, timers: 0 }
test('同步 print 抛错后清理资源并反馈', async () => withBrowser(async (browser) => {
  const { state } = await mountSetup(); await readyToPrint(state)
  browser.setPrint(() => { throw new Error('隔离打印失败') })
  await state.handlePrint(); assert.deepEqual(resources(state, browser), cleaned)
}))
test('真实 Vue nextTick 调度失败时清理且不打开 print', async () => withBrowser(async (browser) => {
  const { state } = await mountSetup(); await readyToPrint(state)
  // 模拟实际 Vue 调度器中的同步更新失败，不抽取或替换生产 handlePrint。
  let stop
  stop = watch(state.printing, (value) => { if (value) { stop(); throw new Error('隔离调度失败') } }, { flush: 'pre' })
  await state.handlePrint()
  assert.equal(browser.printed.length, 0); assert.deepEqual(resources(state, browser), cleaned)
}))
test('afterprint 清理且旧回调不会误清新会话', async () => withBrowser(async (browser) => {
  const { state } = await mountSetup(); await readyToPrint(state); await state.handlePrint()
  const old = [...browser.timers.values()].map((timer) => timer.callback)
  browser.dispatch('afterprint'); assert.deepEqual(resources(state, browser), cleaned)
  await state.handlePrint(); for (const callback of old) callback()
  assert.equal(state.printing.value, true); browser.dispatch('afterprint'); assert.deepEqual(resources(state, browser), cleaned)
}))
test('页面失焦时延迟兜底不提前撤销打印根节点', async () => withBrowser(async (browser) => {
  const { state } = await mountSetup(); await readyToPrint(state); await state.handlePrint()
  browser.focused = false; browser.runTimer([...browser.timers.keys()][0]); assert.equal(state.printing.value, true)
  browser.focused = true; browser.runTimer([...browser.timers.keys()][0]); assert.deepEqual(resources(state, browser), cleaned)
}))
test('焦点回归延迟兜底且重复点击只复读/打印一次', async () => withBrowser(async (browser) => {
  const { state } = await mountSetup(); await readyToPrint(state)
  const first = state.handlePrint(), second = state.handlePrint(); await Promise.all([first, second])
  assert.equal(browser.printed.length, 1)
  browser.dispatch('blur'); browser.dispatch('focus'); assert.deepEqual([...browser.timers.values()].map((timer) => timer.delay), [750])
  browser.runTimer([...browser.timers.keys()][0]); assert.deepEqual(resources(state, browser), cleaned)
}))
test('生产 nextTick 前关闭不会打开 print', async () => withBrowser(async (browser) => {
  const { state, props } = await mountSetup(); await readyToPrint(state)
  const stop = watch(state.printing, (value) => { if (value) props.modelValue = false }, { flush: 'sync' })
  await state.handlePrint(); stop(); await nextTick()
  assert.equal(browser.printed.length, 0); assert.deepEqual(resources(state, browser), cleaned)
}))
test('关闭和卸载均清理监听、计时器及打印样式', async () => withBrowser(async (browser) => {
  for (const action of ['close', 'unmount']) {
    const { state, props, unmount } = await mountSetup(); await readyToPrint(state); await state.handlePrint()
    if (action === 'close') props.modelValue = false; else unmount()
    await flush(); assert.deepEqual(resources(state, browser), cleaned, action)
  }
}))

test('真实复读期间份数意图变化中止打印，保留新设置等待用户重新确认', async () => withBrowser(async (browser) => {
  const { state } = await mountSetup(); const label = testLabel(); await readyToPrint(state, label)
  const waiting = deferred(), received = []
  setLabelsResponse(async (...args) => { received.push(args); return waiting.promise })
  const printing = state.handlePrint()
  assert.equal(state.preflighting.value, true)
  const requestCount = calls.loading
  await state.handlePrint(); assert.equal(calls.loading, requestCount, '重复点击不得另开复读')
  state.settings.copies = state.settings.copies + 1
  waiting.resolve([label]); await printing
  assert.deepEqual(received[0][0], [label.skuId], '实际SKU请求参数不能被测试适配丢弃')
  assert.match(state.preflightMessage.value, /打印意图已变化/)
  assert.equal(state.requiresLocationConfirmation.value, true); assert.equal(state.frozenPrint.value, null)
  assert.equal(browser.printed.length, 0); assert.deepEqual(resources(state, browser), cleaned)
}))
