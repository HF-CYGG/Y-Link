/**
 * 模块说明：scripts/verify-client-ux-review-regressions.ts
 * 文件职责：覆盖本次独立深审确认的四个问题及直接回归。
 * 实现逻辑：以可控异步和内存存储验证结算/SSE；用 Vue 自定义渲染器运行生产模板片段验证类型切换和唯一规格入口。
 * 维护说明：只使用已安装 Vue 工具，无浏览器、网络、真实账号或业务数据；由统一验收阶段执行。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as Vue from 'vue'
import { baseParse, compile, NodeTypes } from '@vue/compiler-dom'
import { parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import type { O2oMallProduct, O2oMallSku } from '../src/api/modules/o2o'
import { settleCurrentClientCheckoutSuccess } from '../src/views/client/client-checkout-submit-policy'
import { createFeedbackDetailLifecycle } from '../src/views/client/client-feedback-detail-lifecycle'
import { retryFeedbackDetailAndEnsureRealtime } from '../src/views/client/client-feedback-retry-policy'
import { resolveCatalogDetailSelection, resolveExplicitDetailSkuReplacement } from '../src/views/client/client-mall-catalog-policy'
import { normalizeClientOrderKeyword } from '../src/utils/client-order-storage'
import { formatDateTime } from '../src/utils/date-time'
import {
  buildClientPreorderSubmitIntentKey, createClientPreorderSubmitLock, readActiveClientPreorderSubmitLock,
  clearClientPreorderSubmitLock, redactClientPreorderSubmitLocks,
} from '../src/utils/client-preorder-submit-guard'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
const storage = {} as Storage
Object.defineProperties(storage, {
  getItem: { value: (key: string) => Object.hasOwn(storage, key) ? storage[key] : null },
  setItem: { value: (key: string, value: string) => { storage[key] = String(value) } },
  removeItem: { value: (key: string) => { delete storage[key] } },
  key: { value: (index: number) => Object.keys(storage)[index] ?? null },
  length: { get: () => Object.keys(storage).length },
})
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
Object.defineProperty(globalThis, 'window', { configurable: true, value: { sessionStorage: storage } })
try {
  const payload = { isSystemApplied: false, pickupContact: '原领取人', remark: '  原备注  \n保留空白', items: [{ productId: 'p1', skuId: 's1', qty: 2 }] }
  const intent = buildClientPreorderSubmitIntentKey({ ...payload, clientUserId: 'leaving', clientOrderType: 'walkin' })
  const key = createClientPreorderSubmitLock('leaving', intent, payload)
  let pageActive = true
  let currentAccount = 'leaving'
  const originalCart = [{ skuId: 's1', qty: 2 }]
  let uiWrites = 0
  let clearCalls = 0
  const response = deferred()
  const lateSuccess = response.promise.then(() => settleCurrentClientCheckoutSuccess({
    isCurrent: () => pageActive && currentAccount === 'leaving',
    applyConfirmedItems: () => { originalCart.splice(0); uiWrites += 1 },
    clearPending: () => { clearClientPreorderSubmitLock('leaving', key); clearCalls += 1 },
  }))
  pageActive = false
  response.resolve()
  assert.equal(await lateSuccess, false)
  assert.equal(uiWrites, 0, '失效页面收到成功响应不得修改 UI 或购物车')
  assert.equal(clearCalls, 0, '保留购物车时不能单独清掉原请求锁')
  assert.deepEqual(originalCart, [{ skuId: 's1', qty: 2 }])
  const restored = readActiveClientPreorderSubmitLock('leaving')!
  assert.equal(restored.requestKey, key, '再次进入必须仍恢复原 key')
  assert.deepEqual(restored.payload, { ...payload, clientRequestId: key })
  assert.throws(() => createClientPreorderSubmitLock('leaving', intent, payload), /未确认/, '不能为保留的原购物车生成新 key')

  // 原账号切走时，成功回包不得清除脱敏 pending 标记或更新新账号界面。
  const switchedKey = createClientPreorderSubmitLock('old-account', 'old-intent', payload)
  const newAccountUi = { cart: ['new-account-sku'], message: '新账号内容' }
  redactClientPreorderSubmitLocks()
  currentAccount = 'new-account'
  assert.equal(settleCurrentClientCheckoutSuccess({
    isCurrent: () => currentAccount === 'old-account',
    applyConfirmedItems: () => { newAccountUi.cart.splice(0); newAccountUi.message = '旧单成功' },
    clearPending: () => clearClientPreorderSubmitLock('old-account', switchedKey),
  }), false)
  assert.deepEqual(newAccountUi, { cart: ['new-account-sku'], message: '新账号内容' })
  assert.equal(readActiveClientPreorderSubmitLock('old-account')!.requestKey, switchedKey)
  assert.equal(readActiveClientPreorderSubmitLock('old-account')!.payload, null)

  // 页面仍有效时，先同步已确认商品，再清原锁。
  const events: string[] = []
  assert.equal(settleCurrentClientCheckoutSuccess({
    isCurrent: () => true,
    applyConfirmedItems: () => { events.push('cart'); originalCart.splice(0) },
    clearPending: () => { events.push('lock'); clearClientPreorderSubmitLock('leaving', key) },
  }), true)
  assert.deepEqual(events, ['cart', 'lock'])
  assert.equal(originalCart.length, 0)
  assert.equal(readActiveClientPreorderSubmitLock('leaving'), null)
} finally {
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
  else Reflect.deleteProperty(globalThis, 'window')
}

// 使用生产生命周期与 Vue 同步 watcher 驱动真实代次变化，连接持有真实 guard，不能以 boolean 假装有效。
const ownerContext = Vue.reactive<{ ownerId: string | null; sessionGeneration: number; conversationId: string }>({
  ownerId: 'A', sessionGeneration: 1, conversationId: 'C1',
})
const feedbackMounted = Vue.ref(true)
const feedbackVisible = Vue.ref(true)
const feedbackLifecycle = createFeedbackDetailLifecycle({ readContext: () => ownerContext, isMounted: () => feedbackMounted.value })
const lifecycleScope = Vue.effectScope()
let loadedConversationId = ''
lifecycleScope.run(() => {
  Vue.watch([() => ownerContext.ownerId, () => ownerContext.sessionGeneration, () => ownerContext.conversationId], () => {
    feedbackLifecycle.invalidatePage()
    loadedConversationId = ''
  }, { flush: 'sync' })
  Vue.watch(feedbackMounted, (mounted) => { if (!mounted) feedbackLifecycle.invalidatePage() }, { flush: 'sync' })
})
interface GuardedConnection {
  isCurrent: () => boolean
  onOpen: () => void
  onConversation: () => void
  onError: () => void
}
let feedbackConnection: GuardedConnection | null = null
let connectionCount = 0
const deliveredCallbacks: string[] = []
const hasCurrentConnection = () => Boolean(feedbackConnection && feedbackConnection.isCurrent())
const connect = () => {
  const isCurrent = feedbackLifecycle.startRealtime()
  const deliver = (event: string) => { if (feedbackVisible.value && isCurrent()) deliveredCallbacks.push(event) }
  feedbackConnection = {
    isCurrent,
    onOpen: () => deliver('open'),
    onConversation: () => deliver('conversation'),
    onError: () => deliver('error'),
  }
  connectionCount += 1
}
const currentConnection = () => {
  assert.ok(feedbackConnection)
  return feedbackConnection as GuardedConnection
}
const loadDetail = async (load: () => Promise<unknown>) => {
  const isCurrent = feedbackLifecycle.capturePage()
  const conversationId = ownerContext.conversationId
  await load()
  if (isCurrent()) loadedConversationId = conversationId
}
const retry = (load: () => Promise<unknown>) => retryFeedbackDetailAndEnsureRealtime({
  load: () => loadDetail(load), isCurrent: feedbackLifecycle.capturePage(),
  hasDetail: () => loadedConversationId === ownerContext.conversationId,
  eligible: () => feedbackMounted.value && feedbackVisible.value && Boolean(ownerContext.ownerId),
  hasConnection: hasCurrentConnection, connect,
})
await assert.rejects(retry(async () => { throw new Error('首次回读失败') }), /首次回读失败/)
assert.equal(connectionCount, 0)
const firstRetry = deferred()
const concurrentRetry = deferred()
const firstResult = retry(() => firstRetry.promise)
const concurrentResult = retry(() => concurrentRetry.promise)
assert.equal(connectionCount, 0, '回读完成前不能提前建立连接')
firstRetry.resolve()
await firstResult
assert.equal(connectionCount, 1, '首次加载失败后的成功重试必须恢复 SSE')
concurrentRetry.resolve()
await concurrentResult
await retry(async () => {})
assert.equal(connectionCount, 1, '并发或重复成功重试不能重复连接')

const streamBeforeUpload = currentConnection()
const pageReadBeforeUpload = feedbackLifecycle.capturePage()
const firstUpload = feedbackLifecycle.startUpload()
assert.equal(firstUpload(), true)
assert.equal(pageReadBeforeUpload(), true, '开始上传不能淘汰页面回读')
assert.equal(streamBeforeUpload.isCurrent(), true, '开始上传不能淘汰当前 SSE')
streamBeforeUpload.onOpen()
streamBeforeUpload.onConversation()
streamBeforeUpload.onError()
assert.deepEqual(deliveredCallbacks, ['open', 'conversation', 'error'], '上传后有效 SSE 的全部回调仍应工作')
const pendingPageRead = deferred()
const readDuringUpload = loadDetail(() => pendingPageRead.promise)
const secondUpload = feedbackLifecycle.startUpload()
assert.equal(firstUpload(), false, '新上传只淘汰旧上传')
assert.equal(secondUpload(), true)
assert.equal(streamBeforeUpload.isCurrent(), true)
assert.equal(pageReadBeforeUpload(), true)
loadedConversationId = ''
pendingPageRead.resolve()
await readDuringUpload
assert.equal(loadedConversationId, 'C1', '上传代次改变后，在途页面回读仍可更新同一会话')
await retry(async () => {})
assert.equal(connectionCount, 1, '上传后重试应复用仍有效的 SSE，无需重建连接')

// 即使引用尚未释放，失效的真实连接 guard 也不能冒充当前连接阻止恢复。
feedbackLifecycle.invalidateRealtime()
assert.notEqual(feedbackConnection, null)
assert.equal(hasCurrentConnection(), false)
assert.equal(secondUpload(), true, '停止或替换 SSE 不能淘汰上传')
await retry(async () => {})
assert.equal(connectionCount, 2)
const callbackCount = deliveredCallbacks.length
streamBeforeUpload.onOpen()
streamBeforeUpload.onConversation()
streamBeforeUpload.onError()
assert.equal(deliveredCallbacks.length, callbackCount, '旧连接的所有回调必须被连接代次淘汰')
currentConnection().onConversation()
assert.equal(deliveredCallbacks.length, callbackCount + 1)

await assert.rejects(retry(async () => { throw new Error('回读失败') }), /回读失败/)
feedbackLifecycle.invalidateRealtime()
feedbackConnection = null
feedbackVisible.value = false
await retry(async () => {})
assert.equal(connectionCount, 2, '隐藏页不能建立连接')
feedbackVisible.value = true

for (const changeOwner of [
  () => { ownerContext.ownerId = 'B' },
  () => { ownerContext.ownerId = null },
  () => { ownerContext.conversationId = 'C2' },
  () => { ownerContext.sessionGeneration += 1 },
  () => { feedbackMounted.value = false },
]) {
  Object.assign(ownerContext, { ownerId: 'A', sessionGeneration: 1, conversationId: 'C1' })
  feedbackMounted.value = true
  await retry(async () => {})
  const previousConnection = currentConnection()
  const previousPage = feedbackLifecycle.capturePage()
  const previousUpload = feedbackLifecycle.startUpload()
  const lateRead = deferred()
  const lateRetry = retry(() => lateRead.promise)
  const connectionsBeforeChange = connectionCount
  const callbacksBeforeChange = deliveredCallbacks.length
  changeOwner()
  assert.equal(previousPage(), false)
  assert.equal(previousUpload(), false)
  assert.equal(previousConnection.isCurrent(), false)
  assert.equal(hasCurrentConnection(), false, '旧引用非空也不能被认作当前连接')
  previousConnection.onOpen()
  previousConnection.onConversation()
  previousConnection.onError()
  assert.equal(deliveredCallbacks.length, callbacksBeforeChange, '换号、登出、换会话、换登录会话或卸载必须阻止旧 SSE 回写')
  lateRead.resolve()
  await lateRetry
  assert.equal(connectionCount, connectionsBeforeChange, '旧页面回读完成不能为新归属建立连接')
}
Object.assign(ownerContext, { ownerId: 'A', sessionGeneration: 1, conversationId: 'C1' })
feedbackMounted.value = true
await retry(async () => {})
const beforeRoundTrip = currentConnection()
const beforeRoundTripPage = feedbackLifecycle.capturePage()
ownerContext.ownerId = 'B'
ownerContext.ownerId = 'A'
assert.equal(beforeRoundTrip.isCurrent(), false, 'A 到 B 再到 A 仍须淘汰旧连接，不能仅比较最终账号')
assert.equal(beforeRoundTripPage(), false)
const connectionsBeforeRecovery = connectionCount
await retry(async () => {})
assert.equal(connectionCount, connectionsBeforeRecovery + 1)
assert.equal(currentConnection().isCurrent(), true)
lifecycleScope.stop()

// 执行页面真正使用的 script setup 声明，隔离请求、存储和浏览器事件。
const evaluatePage = <T>(filename: string, names: string[], dependencies: Record<string, unknown>, includeWatch = false): T => {
  const { descriptor } = parse(readFileSync(new URL(`../src/views/client/${filename}`, import.meta.url), 'utf8'))
  assert.ok(descriptor.scriptSetup)
  const script = ts.createSourceFile(filename, descriptor.scriptSetup.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const declarations = script.statements.filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations)
    .filter((declaration) => names.includes(declaration.name.getText(script)))
  assert.equal(declarations.length, names.length)
  const watchSource = includeWatch ? script.statements.find((statement) => statement.getText(script).startsWith('watch(warnBeforeReload,')) : undefined
  if (includeWatch) assert.ok(watchSource)
  const executable = ts.transpileModule([
    ...declarations.map((declaration) => `const ${declaration.getText(script)}`),
    watchSource?.getText(script) ?? '',
  ].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return new Function(...Object.keys(dependencies), `${executable}\nreturn { ${names.join(', ')} }`)(...Object.values(dependencies))
}

{
  const keywordInput = Vue.ref('')
  const activeStatus = Vue.ref('all')
  const clientOrderStore = Vue.reactive({
    keyword: '原关键词', pageSize: 20,
    setSearch(keyword: string, mode: string) {
      assert.equal(mode, 'contains')
      this.keyword = normalizeClientOrderKeyword(keyword)
    },
    initialize() {},
  })
  const requests: unknown[] = []
  const search = evaluatePage<{
    exceedsContainsTermLimit(keyword: string): boolean
    keywordLimitError: Vue.ComputedRef<string>
    commitSearch(keyword: string): void
    handleStatusChange(value: string): void
    buildListQuery(page: number): unknown
    syncStoreWithCurrentUser(): void
  }>('ClientOrdersView.vue', [
    'MAX_CONTAINS_TERMS', 'exceedsContainsTermLimit', 'effectiveKeyword', 'keywordLimitError', 'commitSearch',
    'handleStatusChange', 'buildListQuery', 'syncStoreWithCurrentUser',
  ], {
    keywordInput, activeStatus, clientOrderStore, normalizeClientOrderKeyword, computed: Vue.computed,
    stopKeywordDebounce: () => {}, loadOrders: () => { requests.push(search.buildListQuery(1)) },
    clientAuthStore: { currentUser: { id: 'fixture' } },
  })
  const valid = 'A a\u3000b\tc d  e f'
  assert.equal(search.exceedsContainsTermLimit(valid), false)
  search.commitSearch(valid)
  keywordInput.value = `${valid} g`
  assert.match(search.keywordLimitError.value, /最多支持 6 个不同的搜索关键词/)
  search.commitSearch(keywordInput.value)
  assert.equal(clientOrderStore.keyword, valid)
  search.handleStatusChange('pending')
  assert.deepEqual(requests, [{ page: 1, pageSize: 20, status: 'pending', keyword: valid, searchMode: 'contains' }])
  assert.deepEqual(search.buildListQuery(2), { page: 2, pageSize: 20, status: 'pending', keyword: valid, searchMode: 'contains' })
  clientOrderStore.keyword = keywordInput.value
  search.syncStoreWithCurrentUser()
  assert.equal(clientOrderStore.keyword, '', '旧版本缓存中超限关键词不能随页面恢复直接发出')
  assert.match(search.keywordLimitError.value, /最多支持/)
}

{
  const pending = {
    payload: { clientRequestId: 'original-request-key', pickupAt: '2026-11-21T16:30:00.000Z', items: [
      { productId: 'removed-id', skuId: 'removed-sku', qty: 2 },
      { productId: 'new-id', skuId: 'matching-sku', qty: 3 },
      { productId: 'new-id', skuId: 'missing-sku', qty: 1 },
      { productId: 'missing-id', qty: 4 },
    ] },
  }
  const original = structuredClone(pending)
  const summary = evaluatePage<{
    pendingPickupTime: Vue.ComputedRef<string>
    pendingItemSummaries: Vue.ComputedRef<unknown[]>
  }>('ClientCheckoutView.vue', ['pendingPickupTime', 'pendingItemSummaries'], {
    pendingSubmit: Vue.ref(pending), computed: Vue.computed, formatDateTime,
    clientCartStore: { items: [{ productId: 'removed-id', skuId: 'removed-sku', productName: '下架商品', specText: '历史规格' }] },
    clientCatalogStore: { products: [{ id: 'new-id', productName: '目录商品', skus: [{ id: 'matching-sku', specText: '目录规格' }] }] },
  })
  assert.equal(summary.pendingPickupTime.value, '2026-11-22 00:30:00', '跨日恢复摘要按业务时区显示')
  assert.deepEqual(summary.pendingItemSummaries.value, [
    { productName: '下架商品', specText: '历史规格', qty: 2 },
    { productName: '目录商品', specText: '目录规格', qty: 3 },
    { productName: '目录商品', specText: '原规格资料暂不可用', qty: 1 },
    { productName: '原商品资料暂不可用', specText: '默认规格', qty: 4 },
  ])
  assert.deepEqual(pending, original, '恢复摘要不能改动原始请求体或幂等键')
}

{
  const listeners = new Set<(event: Event) => void>()
  const editDialogVisible = Vue.ref(false), returnDialogVisible = Vue.ref(false)
  const editDraft = Vue.ref('原改单'), returnDraft = Vue.ref('原退货')
  const clientAuthStore = Vue.reactive<{currentUser: {id: string} | null}>({ currentUser: { id: 'fixture' } })
  const scope = Vue.effectScope()
  try {
    const state = scope.run(() => evaluatePage<{editDraftBaseline: Vue.Ref<string>; returnDraftBaseline: Vue.Ref<string>}>(
      'ClientOrderDetailView.vue', ['editDraftBaseline', 'returnDraftBaseline', 'hasUnsavedOrderDrafts', 'handleOrderDraftBeforeUnload', 'warnBeforeReload'], {
        ref: Vue.ref, computed: Vue.computed, watch: Vue.watch, clientAuthStore, editDialogVisible, returnDialogVisible,
        currentEditDraft: () => editDraft.value, currentReturnDraft: () => returnDraft.value,
        globalThis: { window: {
          addEventListener: (type: string, listener: (event: Event) => void) => { assert.equal(type, 'beforeunload'); listeners.add(listener) },
          removeEventListener: (type: string, listener: (event: Event) => void) => { assert.equal(type, 'beforeunload'); listeners.delete(listener) },
        } },
      }, true,
    ))!
    state.editDraftBaseline.value = editDraft.value
    state.returnDraftBaseline.value = returnDraft.value
    editDialogVisible.value = true
    assert.equal(listeners.size, 0, '未改动的弹窗不应妨碍刷新')
    editDraft.value = '改单输入'
    assert.equal(listeners.size, 1)
    const event = new Event('beforeunload', { cancelable: true })
    // Node 的普通 Event 使用只读 returnValue，替身对应浏览器可写的 BeforeUnloadEvent。
    const beforeUnload = { preventDefault: () => event.preventDefault(), returnValue: undefined }
    for (const listener of listeners) listener(beforeUnload as unknown as Event)
    assert.equal(event.defaultPrevented, true)
    assert.equal(beforeUnload.returnValue, true)
    state.editDraftBaseline.value = editDraft.value
    assert.equal(listeners.size, 0, '保存新基线后取消刷新拦截')
    returnDialogVisible.value = true
    returnDraft.value = '退货输入'
    assert.equal(listeners.size, 1)
    clientAuthStore.currentUser = null
    assert.equal(listeners.size, 0, '退出登录释放当前草稿的刷新拦截')
  } finally { scope.stop() }
}

// 自定义 Vue host 只存节点与事件，不创建浏览器或使用真实 DOM。
interface TestNode {
  tag: string
  text: string
  parent: TestNode | null
  children: TestNode[]
  props: Record<string, unknown>
  style: { display: string }
}
const node = (tag: string, text = ''): TestNode => ({ tag, text, parent: null, children: [], props: {}, style: { display: '' } })
const remove = (child: TestNode) => {
  if (!child.parent) return
  const index = child.parent.children.indexOf(child)
  if (index >= 0) child.parent.children.splice(index, 1)
  child.parent = null
}
const renderer = Vue.createRenderer<TestNode, TestNode>({
  createElement: (tag) => node(tag), createText: (text) => node('#text', text), createComment: (text) => node('#comment', text),
  setText: (target, text) => { target.text = text },
  setElementText: (target, text) => { target.children.forEach((child) => { child.parent = null }); target.children = []; target.text = text },
  patchProp: (target, key, _previous, value) => { target.props[key] = value },
  insert: (child, parent, anchor = null) => {
    remove(child)
    const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index < 0) parent.children.push(child)
    else parent.children.splice(index, 0, child)
    child.parent = parent
  },
  remove, parentNode: (target) => target.parent,
  nextSibling: (target) => target.parent?.children[target.parent.children.indexOf(target) + 1] ?? null,
})
const find = (root: TestNode, predicate: (item: TestNode) => boolean): TestNode | null => {
  if (predicate(root)) return root
  for (const child of root.children) { const found = find(child, predicate); if (found) return found }
  return null
}
interface ParsedNode { type: number; tag?: string; children?: ParsedNode[]; loc: { source: string } }
const templateTree = (name: string) => {
  const source = readFileSync(new URL('../src/views/client/' + name, import.meta.url), 'utf8')
  const { descriptor, errors } = parse(source)
  assert.equal(errors.length, 0)
  assert.ok(descriptor.template)
  return baseParse(descriptor.template.content) as unknown as ParsedNode
}
const findParsed = (root: ParsedNode, predicate: (item: ParsedNode) => boolean): ParsedNode | null => {
  if (predicate(root)) return root
  for (const child of root.children ?? []) { const found = findParsed(child, predicate); if (found) return found }
  return null
}
const compileRender = (source: string) => new Function('Vue', compile(source, { mode: 'function', prefixIdentifiers: true }).code)(Vue) as Vue.RenderFunction

// 保留生产模板的条件、v-show 与事件绑定，仅把普通表单内部替换成可观测标记。
const createTree = templateTree('ClientFeedbackCreateView.vue')
const createParent = findParsed(createTree, (item) => Boolean(item.children?.some((child) => child.tag === 'ClientRestockForm')))!
assert.ok(createParent)
const restockIndex = createParent.children!.findIndex((child) => child.tag === 'ClientRestockForm')
const restockNode = createParent.children![restockIndex]!
const ordinaryNode = createParent.children!.slice(restockIndex + 1).find((child) => child.type === NodeTypes.ELEMENT)!
assert.equal(ordinaryNode.tag, 'template')
const ordinaryOpeningTag = ordinaryNode.loc.source.slice(0, ordinaryNode.loc.source.indexOf('>') + 1)
const createRender = compileRender(restockNode.loc.source + '\n' + ordinaryOpeningTag + '<div data-ordinary-form="true">普通反馈表单</div></template>')
const restockHasMounted = Vue.ref(false)
const isRestockMode = Vue.ref(false)
let restockMounts = 0
let restockUnmounts = 0
const RestockStub = Vue.defineComponent({
  props: { active: Boolean },
  setup() {
    restockMounts += 1
    Vue.onUnmounted(() => { restockUnmounts += 1 })
    return () => Vue.h('div', { 'data-restock-form': true }, '补货草稿实例')
  },
})
const createApp = renderer.createApp(Vue.defineComponent({
  setup: () => ({ restockHasMounted, isRestockMode, restockBusy: Vue.ref(false) }), render: createRender,
}))
createApp.component('ClientRestockForm', RestockStub)
const createRoot = node('root')
createApp.mount(createRoot)
assert.ok(find(createRoot, (item) => item.props['data-ordinary-form'] === 'true'))
assert.equal(restockMounts, 0)
restockHasMounted.value = true
isRestockMode.value = true
await Vue.nextTick()
const retainedRestock = find(createRoot, (item) => item.props['data-restock-form'] === true)!
assert.ok(retainedRestock)
assert.equal(find(createRoot, (item) => item.props['data-ordinary-form'] === 'true'), null)
isRestockMode.value = false
await Vue.nextTick()
assert.ok(find(createRoot, (item) => item.props['data-ordinary-form'] === 'true'), '进入过补货后切回普通类型必须仍显示表单')
assert.equal(find(createRoot, (item) => item.props['data-restock-form'] === true), retainedRestock)
assert.equal(retainedRestock.style.display, 'none')
isRestockMode.value = true
await Vue.nextTick()
assert.equal(find(createRoot, (item) => item.props['data-restock-form'] === true), retainedRestock)
assert.equal(restockMounts, 1, '类型切换保留同一个补货实例，不能丢失草稿')
assert.equal(restockUnmounts, 0)
createApp.unmount()

const remainingSku = { id: 'remaining', isActive: true, isCurrent: true, specValues: {}, specText: '', skuCode: '', availableStock: 5 } as O2oMallSku
const currentProduct = { id: 'p1', skus: [remainingSku] } as O2oMallProduct
const invalidSelection = resolveCatalogDetailSelection([currentProduct], 'p1', 'removed')
assert.equal(invalidSelection.sku, null, '目录更新不能自动选择唯一候选')
assert.equal(invalidSelection.unavailable, true)
assert.equal(resolveExplicitDetailSkuReplacement(null, true), null, '下架商品不能展示旧规格入口')
assert.equal(resolveExplicitDetailSkuReplacement(currentProduct, false), null, '有效单规格选择保持原展示')
const selectionUnavailable = Vue.ref(true)
const selectedSku = Vue.shallowRef<O2oMallSku | null>(null)
const detailSingleReplacementSku = Vue.computed(() => resolveExplicitDetailSkuReplacement(currentProduct, selectionUnavailable.value))
const mallTree = templateTree('ClientMallView.vue')
const skuSection = findParsed(mallTree, (item) => item.tag === 'div' && item.loc.source.split('>')[0]!.includes('class="client-detail-sku-section"'))!
assert.ok(skuSection)
const skuApp = renderer.createApp(Vue.defineComponent({
  setup: () => ({
    hasDetailSkuChoices: false, detailSingleReplacementSku, detailSkuSpecGroups: [],
    selectDetailSku: (sku: O2oMallSku) => { selectedSku.value = sku; selectionUnavailable.value = false },
    selectDetailSkuOption: () => assert.fail('唯一候选必须通过明确选择入口'),
  }),
  render: compileRender(skuSection.loc.source),
}))
skuApp.component('ElButton', Vue.defineComponent({ inheritAttrs: false, setup: (_props, { attrs, slots }) => () => Vue.h('button', attrs, slots.default?.()) }))
const skuRoot = node('root')
skuApp.mount(skuRoot)
assert.equal(selectedSku.value, null, '显示候选不等于选中候选')
const chooseSkuButton = find(skuRoot, (item) => item.tag === 'button')!
assert.ok(chooseSkuButton, '失效规格只剩一个候选时，实际模板也必须渲染明确选择按钮')
assert.equal(typeof chooseSkuButton.props.onClick, 'function')
;(chooseSkuButton.props.onClick as () => void)()
await Vue.nextTick()
assert.equal(selectedSku.value, remainingSku, '只有显式点击才选中当前目录对象')
assert.equal(find(skuRoot, (item) => item.tag === 'button'), null)
assert.equal(resolveCatalogDetailSelection([currentProduct], 'p1', selectedSku.value!.id).unavailable, false)
skuApp.unmount()
console.log('四项 UX 审查回归验证通过')
