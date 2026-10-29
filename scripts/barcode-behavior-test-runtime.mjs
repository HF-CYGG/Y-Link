/** 条码测试入口：网络只供应标签响应，加载/选中/条码生成/复读/打印全部走生产 SFC。 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { compileBehaviorSfc, root, host, mountBehavior, flush, withBrowser, deferred, unmountAll } from './vue-behavior-test-runtime.mjs'
export { host, flush, withBrowser, deferred, unmountAll }
export const barcodeOutput = path.join(root, 'tmp/coverage-vue-barcode/BarcodeLabelPrintDialog-setup.mjs')
export const component = await compileBehaviorSfc('src/views/inventory/components/BarcodeLabelPrintDialog.vue', barcodeOutput)
export const testLabel = (skuCode = 'WC02001', factoryBarcode = 'FACTORY-1', overrides = {}) => ({
  skuId: skuCode, productId: 'product-1', skuCode, barcode: skuCode, factoryBarcode, productName: '测试商品', specText: '默认规格', price: '1.00', categoryName: null, locationCode: 'A', variantCode: null, sizeCode: null, seriesName: null, codeScheme: 'legacy',
  printLocations: { capability: 'full', mainLocationId: 'main', mainLocationCode: 'A', mainLocationStatus: 'valid', options: [{ locationId: 'main', locationCode: 'A', isMain: true, qty: 0 }, { locationId: 'other', locationCode: 'B', isMain: false, qty: 4 }], distributionKey: 'distribution-1' }, ...overrides,
})
export const calls = { loading: 0, requests: [], warnings: host.warnings, errors: host.errors }
let response = async () => []
export const setLabelsResponse = (callback) => { response = callback }
host.api.getProductLabels = async (...args) => { calls.loading += 1; calls.requests.push(args[0]); return response(...args) }
const mountedByState = new WeakMap()
export const mountSetup = async (skuIds = [], modelValue = false) => {
  const mounted = mountBehavior(component, { skuIds, modelValue })
  mountedByState.set(mounted.state, mounted)
  await flush()
  return mounted
}
export const replaceLabels = async (state, labels) => {
  // 通过生产的打开/批次 watcher 或手动刷新加载，不直接赋值内部 labels，也不伪造 SVG。
  setLabelsResponse(async () => structuredClone(labels))
  const mounted = mountedByState.get(state)
  assert.ok(mounted)
  const ids = [...new Set(labels.map((label) => label.skuId))]
  const changed = !mounted.props.modelValue || JSON.stringify(mounted.props.skuIds) !== JSON.stringify(ids)
  mounted.props.skuIds = ids
  mounted.props.modelValue = true
  if (!changed) await state.loadLabels()
  await flush()
  assert.equal(state.loading.value, false)
}
export const readyToPrint = async (state, label = testLabel()) => { await replaceLabels(state, [label]); assert.equal(state.printBlockedReason.value, '') }
export const resetBarcodeHost = () => { unmountAll(); response = async () => []; calls.loading = 0; calls.requests.length = 0; calls.warnings.length = 0; calls.errors.length = 0 }
