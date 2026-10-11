/**
 * 模块说明：开单提交准备的真实函数回归。
 * 文件职责：固定数量、SKU、库存聚合与部门/散客载荷边界，避免按需加载时改动出库语义。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import type { ProductRecord } from '../src/api/modules/product'
import type { OrderHeaderForm, OrderItemRow } from '../src/views/order-entry/types'
import { prepareOrderSubmission } from '../src/views/order-entry/composables/prepare-order-submission'
import { createTimedAsyncLoader } from '../src/utils/timed-async-loader'

const product = (skus: Array<{ id: string; availableStock: number }>): ProductRecord => ({
  id: 'product-1',
  productName: '测试商品',
  skus: skus.map((sku) => ({
    id: sku.id,
    specText: sku.id,
    isCurrent: true,
    isActive: true,
    availableStock: sku.availableStock,
    defaultPrice: 10,
  })),
} as ProductRecord)

const header = (overrides: Partial<OrderHeaderForm> = {}): OrderHeaderForm => ({
  orderType: 'walkin',
  hasCustomerOrder: true,
  isSystemApplied: true,
  issuerName: ' 开单人 ',
  customerDepartmentName: '销售部',
  customerDepartmentNodeId: 'node-1',
  customerName: ' 客户 ',
  remark: ' 备注 ',
  ...overrides,
})
const row = (overrides: Partial<OrderItemRow> = {}): OrderItemRow => ({
  uid: 'row-1', productId: 'product-1', skuId: 'sku-1', qty: 1, unitPrice: 10, remark: ' 行备注 ', ...overrides,
})
const checkError = (label: string, value: ReturnType<typeof prepareOrderSubmission>, message: string) => {
  assert.equal(value.error, message, label)
  assert.equal(value.payload, undefined, `${label}：非法输入不得构建载荷`)
}

const singleSku = [product([{ id: 'sku-1', availableStock: 10 }])]
const walkinRow = row()
const walkin = prepareOrderSubmission(header(), [walkinRow], singleSku)
assert.equal(walkin.error, undefined)
assert.equal(walkinRow.skuId, 'sku-1', '有效明细必须保留行内 SKU')
assert.deepEqual(walkin.payload, {
  orderType: 'walkin', hasCustomerOrder: false, isSystemApplied: false,
  issuerName: '开单人', customerDepartmentName: undefined, customerDepartmentNodeId: undefined,
  customerName: '客户', remark: '备注',
  items: [{ productId: 'product-1', skuId: 'sku-1', qty: 1, unitPrice: 10, remark: '行备注' }],
}, '散客载荷必须保持字段和顺序口径')

const department = prepareOrderSubmission(header({ orderType: 'department' }), [row()], singleSku)
assert.equal(department.error, undefined)
assert.equal(department.payload?.hasCustomerOrder, true)
assert.equal(department.payload?.isSystemApplied, true)
assert.equal(department.payload?.customerDepartmentName, '销售部')
assert.equal(department.payload?.customerDepartmentNodeId, 'node-1')

checkError('数量为零', prepareOrderSubmission(header(), [row({ qty: 0 })], singleSku), '数量必须为正整数')
checkError('数量非整数', prepareOrderSubmission(header(), [row({ qty: 1.5 })], singleSku), '数量必须为正整数')
checkError('无有效明细', prepareOrderSubmission(header(), [row({ productId: '' })], singleSku), '请至少录入一条有效明细（已选择产品且数量大于 0）')
checkError('失效商品', prepareOrderSubmission(header(), [row({ productId: 'missing' })], singleSku), '存在未建档、已停用或暂无可用规格的商品，请重新选择')
checkError('多规格缺选择', prepareOrderSubmission(header(), [row({ skuId: '' })], [product([{ id: 'sku-1', availableStock: 10 }, { id: 'sku-2', availableStock: 10 }])]), '存在多规格商品尚未选择规格')
checkError('单规格缺选择沿用预检', prepareOrderSubmission(header(), [row({ skuId: '' })], singleSku), '存在商品暂无当前启用规格')
checkError('单价非正', prepareOrderSubmission(header(), [row({ unitPrice: 0 })], singleSku), '存在单价小于等于 0 的明细，请先修正后再保存')
checkError('出单人缺失', prepareOrderSubmission(header({ issuerName: ' ' }), [row()], singleSku), '请填写出单人')
checkError('部门缺失', prepareOrderSubmission(header({ orderType: 'department', customerDepartmentName: '' }), [row()], singleSku), '部门单必须填写客户部门')
checkError('部门超长', prepareOrderSubmission(header({ orderType: 'department', customerDepartmentName: '部'.repeat(272) }), [row()], singleSku), '客户部门名称不能超过 271 个字符')
checkError('同SKU多行库存汇总', prepareOrderSubmission(header(), [row({ qty: 2 }), row({ uid: 'row-2', qty: 2 })], [product([{ id: 'sku-1', availableStock: 3 }])]), '商品“测试商品”规格“sku-1”可用库存 3，本单需要 4，请调整数量')

// 执行 composable 的真实提交函数；只把动态模块获取替换成可控 Promise，以覆盖首次加载时的事件交错与失败。
const composableSource = readFileSync(new URL('../src/views/order-entry/composables/useOrderEntryForm.ts', import.meta.url), 'utf8')
assert.ok(composableSource.includes("load: () => import('./prepare-order-submission')"), '提交准备必须仅在点击保存后按需加载')
assert.ok(composableSource.includes('const loadOrderEntrySubmission = createTimedAsyncLoader({'), '提交模块必须共用超时加载器')
assert.ok(composableSource.includes('timeoutMs: 15_000'), '提交模块必须在十五秒后解锁并提示')
const composableAst = ts.createSourceFile('useOrderEntryForm.ts', composableSource, ts.ScriptTarget.Latest, true)
let submitDeclaration: ts.VariableDeclaration | undefined
const findSubmitDeclaration = (node: ts.Node) => {
  if (ts.isVariableDeclaration(node) && node.name.getText(composableAst) === 'submitOrder') submitDeclaration = node
  if (!submitDeclaration) ts.forEachChild(node, findSubmitDeclaration)
}
findSubmitDeclaration(composableAst)
assert.ok(submitDeclaration, '必须保留开单提交编排')
const submitSource = submitDeclaration.getText(composableAst)
  .replace('loadOrderEntrySubmission()', 'loadPreparation()')
const submitCode = ts.transpileModule(submitSource, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText

type Harness = {
  submit: () => Promise<void>
  resolveLoad: (value: { prepareOrderSubmission: typeof prepareOrderSubmission }) => void
  setLoader: (loader: () => Promise<{ prepareOrderSubmission: typeof prepareOrderSubmission }>) => void
  rows: { value: OrderItemRow[] }
  saving: { value: boolean }
  pendingScanCount: { value: number }
  pending: { value: { idempotencyKey: string; fingerprint: string } | null }
  requests: Array<Record<string, unknown>>
  messages: string[]
  draftWrites: number[]
  setSubmitResponse: (response: (payload: Record<string, unknown>) => Promise<unknown>) => void
}
const createHarness = (): Harness => {
  const saving = { value: false }
  const pendingScanCount = { value: 0 }
  const rows = { value: [row()] }
  const pending: Harness['pending'] = { value: null }
  const requests: Array<Record<string, unknown>> = []
  const messages: string[] = []
  const draftWrites: number[] = []
  let resolveLoad = (_value: { prepareOrderSubmission: typeof prepareOrderSubmission }) => undefined
  let loadPreparation = () => new Promise<{ prepareOrderSubmission: typeof prepareOrderSubmission }>((resolve) => { resolveLoad = resolve })
  let submitResponse: (payload: Record<string, unknown>) => Promise<unknown> = async (_payload) => ({
    idempotentReplay: false, order: { id: 'order-1', systemNo: 'SYS-1', businessNo: 'BIZ-1' }, inventoryDeductedQty: 1,
  })
  const submit = new Function(
    'isSaving', 'pendingScanCount', 'headerForm', 'itemRows', 'products', 'pendingSubmission', 'loadPreparation',
    'showAppWarning', 'showAppError', 'showAppSuccess', 'showCriticalErrorDialog',
    'orderApi', 'persistDraft', 'resetForm', 'router', 'loadDepartmentOptions', 'loadProducts',
    `${submitCode}; return submitOrder`,
  )(
    saving, pendingScanCount, header(), rows, { value: singleSku }, pending, () => loadPreparation(),
    (message: string) => messages.push(`warning:${message}`),
    (message: string) => messages.push(`error:${message}`),
    (message: string) => messages.push(`success:${message}`),
    (_error: unknown) => messages.push('critical'),
    { submitOrder: async (payload: Record<string, unknown>) => { requests.push(payload); return submitResponse(payload) } },
    () => { draftWrites.push(1) },
    () => { rows.value = []; pending.value = null },
    { push: async () => undefined },
    async () => undefined,
    async () => undefined,
  ) as () => Promise<void>
  return {
    submit,
    resolveLoad: (value) => resolveLoad(value),
    setLoader: (loader) => { loadPreparation = loader },
    rows, saving, pendingScanCount, pending, requests, messages, draftWrites,
    setSubmitResponse: (response) => { submitResponse = response },
  }
}

const delayed = createHarness()
delayed.pendingScanCount.value = 1
await delayed.submit()
assert.equal(delayed.saving.value, false, '扫码识别未完成时不能进入按需模块加载')
assert.equal(delayed.requests.length, 0, '扫码识别未完成时不能请求订单 API')
assert.ok(delayed.messages.some((message) => message.includes('正在识别条码')), '扫码期间必须给出可见提示')
delayed.pendingScanCount.value = 0
const firstPending = delayed.submit()
const duplicatePending = delayed.submit()
assert.equal(delayed.saving.value, true, '动态模块尚在加载时必须锁定提交')
assert.equal(delayed.requests.length, 0, '加载期间不能发起订单 API')
delayed.rows.value[0].qty = 2
delayed.resolveLoad({ prepareOrderSubmission })
await Promise.all([firstPending, duplicatePending])
assert.equal(delayed.requests.length, 1, '双击只能提交一次')
assert.equal((delayed.requests[0].items as Array<{ qty: number }>)[0].qty, 2, '异步加载后须读取最新且一致的表单状态')
assert.equal(delayed.saving.value, false)

const failedLoad = createHarness()
failedLoad.setLoader(async () => { throw new Error('chunk failed') })
await failedLoad.submit()
assert.equal(failedLoad.requests.length, 0, '提交准备模块加载失败时不得请求订单 API')
assert.equal(failedLoad.pending.value, null, '加载失败不得生成幂等键')
assert.equal(failedLoad.draftWrites.length, 0, '加载失败不得改写草稿')
assert.equal(failedLoad.rows.value.length, 1, '加载失败必须保留录入明细')
assert.equal(failedLoad.saving.value, false, '加载失败后应允许用户重试')
assert.ok(failedLoad.messages.some((message) => message.includes('加载失败')), '加载失败须提示用户')

const timedOut = createHarness()
let resolveLateModule: (value: { prepareOrderSubmission: typeof prepareOrderSubmission }) => void = () => undefined
timedOut.setLoader(createTimedAsyncLoader({
  load: () => new Promise((resolve) => { resolveLateModule = resolve }),
  timeoutMs: 5,
  timeoutMessage: '提交模块加载超时',
  onLoading: () => undefined,
  onSuccess: () => undefined,
  onError: () => undefined,
}))
await timedOut.submit()
assert.equal(timedOut.requests.length, 0, '超时不得请求订单 API')
assert.equal(timedOut.pending.value, null, '超时不得生成幂等键')
assert.equal(timedOut.draftWrites.length, 0, '超时不得改写草稿')
assert.equal(timedOut.rows.value.length, 1, '超时必须保留录入明细')
assert.equal(timedOut.saving.value, false, '超时后必须解除点击锁')
resolveLateModule({ prepareOrderSubmission })
await new Promise<void>((resolve) => setTimeout(resolve, 0))
assert.equal(timedOut.requests.length, 0, '超时后晚到模块不得补发 API')
timedOut.setLoader(async () => ({ prepareOrderSubmission }))
await timedOut.submit()
assert.equal(timedOut.requests.length, 1, '超时后再次提交应能恢复')

const unknownResult = createHarness()
unknownResult.setLoader(async () => ({ prepareOrderSubmission }))
unknownResult.setSubmitResponse(async () => { throw new Error('timeout') })
await unknownResult.submit()
assert.equal(unknownResult.requests.length, 1)
const firstKey = unknownResult.requests[0].idempotencyKey
assert.equal(typeof firstKey, 'string')
assert.equal(unknownResult.pending.value?.idempotencyKey, firstKey, '结果未知时须保留原幂等键')
unknownResult.setSubmitResponse(async () => ({
  idempotentReplay: true, order: { id: 'order-1', systemNo: 'SYS-1', businessNo: 'BIZ-1' }, inventoryDeductedQty: 0,
}))
await unknownResult.submit()
assert.equal(unknownResult.requests.length, 2)
assert.equal(unknownResult.requests[1].idempotencyKey, firstKey, '相同载荷重试须复用原幂等键')
assert.equal(unknownResult.pending.value, null, '成功后须清理待确认幂等态')

console.log('[verify:order-entry-submit-preparation] 开单提交准备边界通过')
