/**
 * 模块说明：实际页面异步操作归属回归。
 * 文件职责：执行生产 SFC 的商城刷新、下单收尾、商家进度及反馈动作，验证刷新与跨上下文迟到响应。
 * 实现逻辑：只抽取生产声明，使用真实 Vue ref/watch 和反馈生命周期；网络、确认框与界面提示是可控边界。
 * 维护说明：不复制 handler、不访问真实 API/账号/数据库；购物车数量与后端事务另由对应专项覆盖。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { ref, shallowRef, computed, reactive, watch, nextTick } from 'vue'

const read = (file) => fs.readFileSync(file, 'utf8')
const pageAst = (file) => ts.createSourceFile(file, read(file).split('<script setup lang="ts">')[1].split('</script>')[0], ts.ScriptTarget.Latest, true)
const declarations = (ast, names) => names.map((name) => {
  const declaration = ast.statements.filter(ts.isVariableStatement).flatMap((statement) => [...statement.declarationList.declarations]).find((item) => item.name.getText(ast) === name)
  assert.ok(declaration?.initializer, `生产声明必须存在：${name}`)
  return `let ${name} = ${declaration.initializer.getText(ast)};`
}).join('\n')
const execute = (source, bindings, names) => {
  const sandbox = { ref, computed, reactive, watch, ...bindings }
  const javascript = ts.transpileModule(`${source}\nglobalThis.subject = {${names.join(',')}}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  vm.runInNewContext(javascript, sandbox)
  return sandbox.subject
}
const helper = (file) => {
  const output = ts.transpileModule(read(file), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const exports = {}; new Function('exports', output)(exports); return exports
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const flush = async () => { for (let index=0; index<12; index++) await Promise.resolve(); await nextTick() }
const plain = (value) => JSON.parse(JSON.stringify(value))

const mallAst = pageAst('src/views/client/ClientMallView.vue')
const mallActions = ['togglePhoneStorefront', 'refreshMallStorefront', 'revalidateCatalogInBackground',
  'handleMallVisibilityChange', 'loadProducts', 'activateMallRuntime', 'deactivateMallRuntime']
const searchNames = ['keywordDraft', 'normalizedKeyword', 'startSearchComposition', 'finishSearchComposition', 'commitSearch']
const mallNames = ['mallStorefront', 'compactAnnouncementCollapsed', 'loading', 'refreshing', ...mallActions, ...searchNames]
const mallHooks = mallAst.statements.filter((statement) => ts.isExpressionStatement(statement)
  && /^(?:on(?:Mounted|Activated|Deactivated|BeforeRouteLeave)\(|watch\(\s*announcementSessionSources,)/.test(statement.getText(mallAst)))
assert.equal(mallHooks.length, 6, '必须执行商城挂载、激活、失活、离页和两段归属监听')
const searchHooks = mallAst.statements.filter((statement) => ts.isExpressionStatement(statement)
  && /^watch\((?:keywordDraft,|keyword,)/.test(statement.getText(mallAst)))
assert.equal(searchHooks.length, 2)
const mallSource = declarations(mallAst, [
  'CATALOG_BACKGROUND_REVALIDATE_MS', 'CATALOG_REVALIDATE_MIN_GAP_MS', 'lastCatalogRevalidateAt',
  'catalogRevalidateTimer', 'mallRuntimeActive', 'hasActivatedOnce', 'storefrontRequest', 'cancelStorefrontRefresh',
  'confirmedMallStorefront', 'mallStorefront', 'mallAnnouncementText', 'compactAnnouncementCollapsed', 'loading',
  'refreshing', 'finishProductRefresh', 'acknowledgedAnnouncementText', ...mallActions, 'announcementSessionSources',
  'keyword', 'keywordDraft', 'searchComposition', 'normalizedKeyword', 'cancelSearchCommit', 'commitSearch', 'scheduleSearchCommit',
  'startSearchComposition', 'finishSearchComposition', 'flushSearchBeforeLeave',
]) + '\n' + [...mallHooks, ...searchHooks].map((statement) => statement.getText(mallAst)).join('\n')
const stableRequestFile = 'src/composables/useStableRequest.ts'
const stableRequestAst = ts.createSourceFile(stableRequestFile, read(stableRequestFile), ts.ScriptTarget.Latest, true)
const stableRequestSource = declarations(stableRequestAst, ['useStableRequest'])
const storefront = (mallAnnouncementText, businessHoursText = '09:00-18:00', pickupAddress = '东门') => ({
  mallAnnouncementText, businessHoursText, pickupAddress, pickupWindowHours: null,
})
const cachedStorefront = storefront('缓存公告')
const mall = () => {
  const noop = () => {}
  const deactivated = []
  const onDeactivated = (callback) => deactivated.push(callback)
  const { useStableRequest } = execute(stableRequestSource, {
    AbortController, onDeactivated, onBeforeUnmount: noop, isRequestCanceled: () => false,
  }, ['useStableRequest'])
  const clientAuthStore = reactive({ currentUser: { id: 'A' }, sessionGeneration: 1 })
  const flushedSearches = []
  // 模拟共享 Store 已恢复独立快照，商品回包不能替换它。
  const clientCatalogStore = reactive({
    products: [{ id: 'p' }], storefront: cachedStorefront, initialize: noop, isFreshNow: () => true, keyword: '',
    setKeyword(value) { this.keyword = value },
    flushBrowseContext() { flushedSearches.push(this.keyword) },
    async refreshStorefront(load) { this.storefront = await load() },
  })
  const document = { visibilityState: 'visible', addEventListener: noop, removeEventListener: noop }
  let interval
  let searchTimer
  const windowEvents = new Map()
  const window = {
    addEventListener: (name, callback) => windowEvents.set(name, callback),
    removeEventListener: (name) => windowEvents.delete(name),
    setInterval: (callback, delay) => { assert.equal(delay, 30_000); interval = callback; return 1 },
    clearInterval: () => { interval = undefined },
  }
  const isMallRoute = ref(true)
  const requestError = ref(null)
  const reads = [], publicReads = [], productSignals = []
  let clock = 10_000
  let productFailure = false
  let nextProductsRead
  let mount, activate, routeLeave
  class HTMLInputElement { constructor(value) { this.value = value } }
  const subject = execute(mallSource, {
    clientAuthStore, clientCatalogStore, isMallRoute, document, window, requestError, useStableRequest,
    Date: { now: () => clock }, navigator: { onLine: true }, runLatest: useStableRequest().runLatest,
    pendingStorefrontRefresh: undefined, phonePaneTooShort: ref(false), products: computed(() => clientCatalogStore.products),
    announcementDialogVisible: ref(false), detailMotionMedia: null, feedbackController: new AbortController(),
    detailVisible: ref(false), cartDrawerVisible: ref(false), checkoutDrawerVisible: ref(false),
    imagePreviewVisible: ref(false), mobileSearchVisible: ref(false), searchInputFocused: ref(false),
    drawerHandoffGeneration: 0, drawerHandoff: ref(null), cartReturnFocus: null, checkoutFromCart: false,
    floatingLayoutResizeObserver: null, categoryListGeometry: null, categoryRailGeometry: null,
    onMounted: (callback) => { mount = callback }, onActivated: (callback) => { activate = callback },
    onDeactivated, onBeforeRouteLeave: (guard) => { routeLeave = guard },
    stopDetailModeMotion: noop, stopStorefrontMotion: noop, stopMallFeedback: noop, invalidateClearCartConfirm: noop,
    syncMallDocumentScrollLock: noop, scheduleMallFloatingLayoutSync: noop, releaseCategoryScrollLock: noop,
    searchCommitTimer: undefined, shallowRef, HTMLInputElement,
    setTimeout: (callback, delayMs) => { assert.equal(delayMs, 180); searchTimer = callback; return 1 },
    clearTimeout: () => { searchTimer = undefined },
    syncMallViewportAfterRender: noop, warmupProductImages: noop,
    clientCartStore: { syncWithCatalog: noop, initialize: noop },
    getO2oCheckoutStorefront: ({ signal }) => {
      const response = deferred()
      reads.push({ signal, ...response })
      return response.promise
    },
    getO2oMallStorefront: () => {
      const response = deferred()
      publicReads.push(response)
      return response.promise
    },
    normalizeStorefront: (value) => value,
    getO2oMallProducts: async ({ signal }) => {
      productSignals.push(signal)
      if (nextProductsRead) {
        const response = nextProductsRead
        nextProductsRead = undefined
        return response.promise
      }
      if (productFailure) throw new Error('商品暂不可用')
      return { storefront: storefront('公开目录内门店') }
    },
    applyCatalogResult: noop,
    normalizeRequestError: (error) => error,
  }, mallNames)
  return { subject, clientAuthStore, clientCatalogStore, document, requestError, reads, publicReads, productSignals, mount,
    advance: (ms) => { clock += ms }, flushedSearches,
    pagehide: () => windowEvents.get('pagehide')(),
    expireSearchTimer: () => searchTimer?.(),
    finishComposition: (value) => subject.finishSearchComposition({ target: new HTMLInputElement(value) }),
    poll: () => interval(),
    failProducts: () => { productFailure = true },
    holdProducts: () => { nextProductsRead = deferred(); return nextProductsRead },
    leave: () => { routeLeave(); isMallRoute.value = false; deactivated.forEach((callback) => callback()) },
    enter: () => { isMallRoute.value = true; activate() },
    displayed: () => plain(subject.mallStorefront.value),
  }
}
{
  const h = mall()
  await h.mount()
  h.subject.keywordDraft.value = '刚输入的词'
  assert.equal(h.clientCatalogStore.keyword, '')
  h.pagehide()
  assert.equal(h.flushedSearches.at(-1), '刚输入的词', '刷新或关闭页面前先提交搜索，再写缓存')

  h.subject.keywordDraft.value = 'cha'
  h.subject.startSearchComposition()
  h.expireSearchTimer()
  h.subject.commitSearch({ isComposing: true })
  assert.equal(h.clientCatalogStore.keyword, '刚输入的词', '组合输入期间取消上一条待提交搜索')
  h.finishComposition('茶叶')
  assert.equal(h.clientCatalogStore.keyword, '刚输入的词')
  h.expireSearchTimer()
  assert.equal(h.clientCatalogStore.keyword, '茶叶')

  h.subject.keywordDraft.value = '离开前已确认'
  h.subject.startSearchComposition()
  h.subject.keywordDraft.value = '离开前已确认sheng'
  h.pagehide()
  assert.equal(h.flushedSearches.at(-1), '离开前已确认', '组字期间刷新只保存开始组字前已确认的词')
  assert.equal(h.subject.normalizedKeyword.value, '茶叶', '保存缓存不能在组字期间切换活动搜索')
  h.finishComposition('离开前已确认生产')
  h.expireSearchTimer()
  assert.equal(h.subject.normalizedKeyword.value, '离开前已确认生产')

  h.subject.keywordDraft.value = '离页前的词'
  h.subject.startSearchComposition()
  h.leave()
  assert.equal(h.flushedSearches.at(-1), '离页前的词', '同账号在组字期间离页也保存已确认的词')
}
{
  const h = mall()
  await h.mount()
  assert.deepEqual(h.displayed(), cachedStorefront, '等待私有请求期间继续展示目录缓存')
  assert.equal(h.reads.length, 1, '缓存首入的后台目录校验不得发第二个私有请求')
  h.subject.togglePhoneStorefront()
  await h.subject.loadProducts(true)
  assert.equal(h.reads.length, 1, '手动刷新与在途入场请求合并')
  const initial = storefront('入场公告')
  h.reads[0].resolve(initial)
  await flush()
  assert.deepEqual(h.displayed(), initial)
  assert.equal(h.subject.compactAnnouncementCollapsed.value, false, '合并刷新仍执行入场公告确认')

  h.subject.togglePhoneStorefront()
  h.advance(30_000)
  h.poll()
  const background = storefront('后台新公告', '10:00-20:00', '北门')
  h.reads[1].resolve(background)
  await flush()
  assert.deepEqual(h.displayed(), background, '后台校验更新门店三字段')
  assert.equal(h.subject.compactAnnouncementCollapsed.value, true, '后台新公告保留折叠选择')
  h.clientCatalogStore.storefront = storefront('迟到的公开缓存')
  assert.deepEqual(h.displayed(), background, '迟到的公开缓存不能覆盖已确认门店')
  h.leave()
  h.enter()
  h.reads[2].resolve(background)
  await flush()
  assert.equal(h.subject.compactAnnouncementCollapsed.value, false, '后台更新不消耗新公告的入场确认')
  h.subject.togglePhoneStorefront()
  h.leave()
  h.enter()
  h.reads[3].resolve(background)
  await flush()
  assert.equal(h.subject.compactAnnouncementCollapsed.value, true, '重进时同公告保留收起状态')

  h.advance(9_999)
  h.subject.handleMallVisibilityChange()
  assert.equal(h.reads.length, 4, '可见性刷新遵守后台最短间隔')
  h.advance(1)
  h.document.visibilityState = 'hidden'
  await h.subject.revalidateCatalogInBackground()
  assert.equal(h.reads.length, 4, '隐藏时跳过后台刷新')
  h.document.visibilityState = 'visible'
  h.subject.handleMallVisibilityChange()
  h.reads[4].reject(new Error('门店暂不可用'))
  await flush()
  assert.deepEqual(h.displayed(), background, '门店刷新失败保留最后确认展示')

  h.failProducts()
  await h.subject.loadProducts(true)
  assert.equal(h.reads.length, 6, '手动刷新门店不受后台最短间隔限制')
  assert.match(h.requestError.value.message, /商品暂不可用/)
  const manual = storefront('手动新公告', '11:00-21:00', '西门')
  h.reads[5].resolve(manual)
  await flush()
  assert.deepEqual(h.displayed(), manual, '商品失败不影响门店私有展示')
  assert.equal(h.subject.compactAnnouncementCollapsed.value, true, '手动刷新也保留折叠选择')
  assert.equal(h.publicReads.length, 0, '健康读取及已有确认时的失败都不重复发公开请求')
}
for (const mode of ['5xx', 'empty']) {
  const h = mall()
  await h.mount()
  assert.deepEqual(h.displayed(), cachedStorefront)
  if (mode === '5xx') h.reads[0].reject({ status: 503 })
  else h.reads[0].resolve({ businessHoursText: '  ' })
  await flush()
  assert.equal(h.publicReads.length, 1, `${mode} 私有读取失败时通过独立的公开接口更新旧缓存`)
  const fallback = storefront('公开回退公告', '12:00-21:00', '南门')
  h.publicReads[0].resolve(fallback)
  await flush()
  assert.deepEqual(h.displayed(), fallback, '商品目录无法替换旧独立快照时仍能刷新展示')
}
{
  const h = mall()
  await h.mount()
  h.reads[0].reject({ status: 503 })
  await flush()
  await h.subject.loadProducts(true)
  const confirmed = storefront('私有确认先于已在途的公开回退')
  h.reads[1].resolve(confirmed)
  await flush()
  h.publicReads[0].resolve(storefront('公开回退晚到'))
  await flush()
  assert.deepEqual(h.displayed(), confirmed, '在途公开回退不能覆盖后来确认的私有展示')
}
{
  const h = mall()
  await h.mount()
  h.reads[0].resolve(storefront('入场门店'))
  await flush()
  const held = h.holdProducts()
  const manual = h.subject.loadProducts(true)
  assert.equal(h.subject.refreshing.value, true, '手动商品请求在途')
  h.leave()
  assert.equal(h.productSignals[1].aborted, true, 'KeepAlive 失活中止商品请求')
  assert.equal(h.subject.refreshing.value, false, '取消商品请求后恢复刷新按钮')
  assert.equal(h.subject.loading.value, false)
  h.advance(30_000)
  h.enter()
  await flush()
  assert.equal(h.productSignals.length, 3, '缓存命中重入也能后台校验商品')
  assert.equal(h.reads.length, 3, '缓存重入与后台校验合并门店请求')
  held.resolve({ storefront: cachedStorefront })
  await manual
  h.reads[2].resolve(storefront('重入门店'))
  await flush()
  h.advance(30_000)
  h.poll()
  assert.equal(h.productSignals.length, 4, '重入后的定时校验正常')
  assert.equal(h.reads.length, 4, '重入后的定时校验刷新门店')
}
for (const mode of ['route', 'account', 'session', 'ABA']) {
  const h = mall()
  await h.mount()
  if (mode === 'route') {
    h.leave()
    await h.subject.loadProducts(true)
    assert.equal(h.reads.length, 1, '离开商城后不能发私有门店请求')
    h.enter()
  } else {
    h.clientAuthStore.sessionGeneration++
    if (mode === 'account' || mode === 'ABA') h.clientAuthStore.currentUser = { id: 'B' }
    if (mode === 'ABA') {
      h.clientAuthStore.sessionGeneration++
      h.clientAuthStore.currentUser = { id: 'A' }
    }
    await flush()
  }
  assert.equal(h.reads.length, 2, `${mode} 取消后可重新发起私有请求`)
  assert.equal(h.reads[0].signal.aborted, true, `${mode} 中止旧请求`)
  if (mode === 'route') h.reads[0].resolve({ businessHoursText: '' })
  else if (mode === 'account') h.reads[0].reject({ status: 503 })
  else h.reads[0].resolve(storefront('旧请求迟到回复'))
  await flush()
  assert.deepEqual(h.displayed(), cachedStorefront, `${mode} 拒绝旧请求回写`)
  assert.equal(h.publicReads.length, 0, `${mode} 失效请求不得发起公开回退`)
  await h.subject.loadProducts(true)
  assert.equal(h.reads.length, 2, `${mode} 旧请求不得清掉新请求的合并状态`)
  const current = storefront('当前会话公告')
  h.reads[1].resolve(current)
  await flush()
  assert.deepEqual(h.displayed(), current)
}

const checkoutPolicy = helper('src/views/client/client-checkout-submit-policy.ts')
const checkoutAst = pageAst('src/views/client/ClientCheckoutView.vue')
const checkoutSource = declarations(checkoutAst, ['sendFrozenSubmission'])
const payload = { clientRequestId:'original-key', isSystemApplied:false, pickupContact:'原领取人', items:[{productId:'p',skuId:'s',qty:2}] }
const checkout = ({status, recovered=true, refreshSuccess=true, alreadyConsumed=false}={}) => {
  const sent=deferred(), refreshed=deferred(), calls={clear:[],consume:[],apply:[],sync:[],success:[],warning:[],error:[],navigate:[],restore:0}
  let current=true
  const subject=execute(checkoutSource, {
    ...checkoutPolicy, submitO2oPreorder:()=>sent.promise,
    normalizeRequestError:(error)=>({status:error.status,message:'fixture'}),
    restorePendingSubmit:()=>{calls.restore++}, clearClientPreorderSubmitLock:(...args)=>calls.clear.push(args), pendingSubmit:ref({payload}),
    clientCartStore:{consumeSubmittedItems:(items,requestKey)=>{calls.consume.push([plain(items),requestKey]);return !alreadyConsumed},syncWithCatalog:(items)=>calls.sync.push(items)},
    clientCatalogStore:{products:[{availableStock:8}],applyPreorderSubmission:(items)=>calls.apply.push(items)},
    refreshMallSnapshot:async(context)=>{await refreshed.promise;assert.equal(context.isCurrent(),current);return {success:refreshSuccess}},
    showAppSuccess:(value)=>calls.success.push(value), showAppWarning:(value)=>calls.warning.push(value), showCriticalErrorDialog:(value)=>calls.error.push(value),
    props:{standalone:true},emit:()=>assert.fail('独立宿主不应关闭父弹层'),router:{replace:async(value)=>calls.navigate.push(value)},
  }, ['sendFrozenSubmission'])
  const running=subject.sendFrozenSubmission(payload,()=>current,'owner',recovered)
  if(status!==undefined) sent.reject({status})
  return {calls,running,sent,refreshed,leave:()=>{current=false}}
}
for(const status of [500,501,502,503,504,507,599]) {
  const h=checkout({status});await h.running
  assert.equal(h.calls.clear.length,0,`${status}不能清原请求键`);assert.equal(h.calls.consume.length,0);assert.equal(h.calls.warning.length,1);assert.equal(h.calls.restore,1)
}
{
  const h=checkout();h.sent.reject({status:undefined});await h.running
  assert.equal(h.calls.clear.length,0,'无响应不能清原请求键');assert.equal(h.calls.warning.length,1)
}
for(const status of [400,403,409,422]) {const h=checkout({status});await h.running;assert.equal(h.calls.clear.length,1);assert.equal(h.calls.error.length,1)}
for(const refreshSuccess of [true,false]) {
  const h=checkout({refreshSuccess});h.sent.resolve({order:{id:'original-order'}});await flush()
  assert.deepEqual(h.calls.consume,[[payload.items,payload.clientRequestId]]);assert.equal(h.calls.apply.length,0,'确认恢复不能重复增量扣库存')
  h.refreshed.resolve();await h.running
  assert.equal(h.calls.clear.length,1);assert.equal(h.calls.success.length,1);assert.equal(h.calls.error.length,0);assert.equal(h.calls.warning.length,refreshSuccess?0:1)
  assert.deepEqual(h.calls.navigate,['/client/orders/original-order'])
}
{
  const h=checkout({recovered:false});h.sent.resolve({order:{id:'new'}});await h.running
  assert.deepEqual(h.calls.consume,[[payload.items,payload.clientRequestId]])
  assert.equal(h.calls.apply.length,1,'首次提交仍只增量扣一次')
}
{
  const h=checkout({recovered:false,alreadyConsumed:true});h.sent.resolve({order:{id:'new'}});await h.running
  assert.equal(h.calls.apply.length,0,'同键成功结果已消费则跳过本地库存增量扣减')
  assert.equal(h.calls.clear.length,1)
  assert.deepEqual(h.calls.navigate,['/client/orders/new'])
}
{
  const h=checkout();h.leave();h.sent.resolve({order:{id:'old'}});await h.running
  assert.equal(h.calls.clear.length,0);assert.equal(h.calls.consume.length,0);assert.equal(h.calls.navigate.length,0)
}

const checkoutRecoveryNames = [
  'remark', 'pendingSubmit', 'recoveryError', 'confirmingRecovery', 'restorePendingSubmit', 'checkoutActive',
  'checkoutGeneration', 'invalidateCheckout', 'handleDismissPendingSubmit',
]
const checkoutRecoverySource = declarations(checkoutAst, checkoutRecoveryNames)
const checkoutGuard = helper('src/utils/client-preorder-submit-guard.ts')
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
try {
  for (const change of ['cancel', 'switch-account', 'new-session', 'close-page', 'change-route', 'replace-marker', 'deny-read', 'confirm']) {
    const owner = 'checkout-owner'
    const storageKey = `ylink:client:preorder:submit-lock:${owner}`
    const marker = JSON.stringify({ version: 2, owner, createdAt: 100, expiresAt: 200, requestKey: 'original', payload: null })
    const records = new Map([[storageKey, marker]])
    let denyRead = false
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { sessionStorage: {
      getItem(key) { if (denyRead) throw new Error('无法读取'); return records.get(key) ?? null },
      setItem: (key, value) => records.set(key, value),
      removeItem: (key) => records.delete(key),
    } } })
    const clientAuthStore = reactive({ currentUser: { id: owner }, sessionGeneration: 1 })
    const currentRoute = ref({ name: 'client-checkout' })
    const confirmation = deferred()
    const warnings = []
    let confirmCount = 0
    let submitCount = 0
    let pickupChecks = 0
    const subject = execute(checkoutRecoverySource, {
      ...checkoutGuard, clientAuthStore, props: {}, router: { currentRoute }, submitting: ref(false), pickupClock: ref(0),
      ElMessageBox: { confirm: () => { confirmCount++; return confirmation.promise } },
      showAppWarning: (value) => warnings.push(value), recheckPickupDraft: () => { pickupChecks++ },
      handleSubmit: () => { submitCount++ }, submitO2oPreorder: () => { submitCount++ },
    }, checkoutRecoveryNames)
    subject.remark.value = '用户另填的备注'
    subject.restorePendingSubmit()
    const running = subject.handleDismissPendingSubmit()
    await subject.handleDismissPendingSubmit()
    assert.equal(confirmCount, 1, '同一时刻只打开一个恢复确认框')
    if (change === 'switch-account') clientAuthStore.currentUser = { id: 'other-account' }
    if (change === 'new-session') clientAuthStore.sessionGeneration += 2 // 同账号重登或 A → B → A。
    if (change === 'close-page') subject.invalidateCheckout()
    if (change === 'change-route') currentRoute.value = { name: 'client-orders' }
    const replacement = marker.replace('original', 'different-order')
    if (change === 'replace-marker') records.set(storageKey, replacement)
    if (change === 'deny-read') denyRead = true
    if (change === 'cancel') confirmation.reject('cancel')
    else confirmation.resolve('confirm')
    await running
    assert.equal(subject.confirmingRecovery.value, false)
    assert.equal(subject.remark.value, '用户另填的备注', `${change} 不应修改当前草稿`)
    assert.equal(submitCount, 0, `${change} 不应触发订单提交`)
    assert.equal(pickupChecks, change === 'confirm' ? 1 : 0)
    if (change === 'confirm') {
      assert.equal(records.has(storageKey), false)
      assert.equal(subject.pendingSubmit.value, null)
    } else {
      assert.equal(records.get(storageKey), change === 'replace-marker' ? replacement : marker, `${change} 不应清除未决标记`)
      if (change === 'deny-read') assert.match(subject.recoveryError.value, /无法读取原始提交记录/)
      if (change === 'replace-marker') assert.match(warnings[0], /原提交记录已变化/)
    }
  }
} finally {
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
  else Reflect.deleteProperty(globalThis, 'window')
}

const progressAst=pageAst('src/views/o2o/O2oOrderQueryView.vue')
const progressNames=['activeBusinessStatus','draftBusinessStatus','businessStatusSaving','businessStatusOwnerGeneration','businessStatusOperation','businessStatusPageActive','handleBusinessStatusChange','deactivatePageRuntime']
const progressWatcher=progressAst.statements.find((statement)=>ts.isExpressionStatement(statement)&&statement.getText(progressAst).startsWith('watch(')&&statement.getText(progressAst).includes('businessStatusOwnerGeneration'))
assert.ok(progressWatcher,'必须执行真实归属watcher')
const progressSource=declarations(progressAst,progressNames)+'\n'+progressWatcher.getText(progressAst)
const order=(id,status='awaiting_shipment')=>({order:{id,preorderNo:id,businessStatus:status}})
const progress=()=>{
  const activeOrderId=ref('A'),activeOrderDetail=ref(order('A')),authStore=reactive({currentUser:{id:'admin'}})
  const confirms=[],posts=[],success=[],errors=[]
  const subject=execute(progressSource,{activeOrderId,activeOrderDetail,authStore,
    pageRuntimeActive:true,document:{removeEventListener:()=>{}},handleVisibilityChange:()=>{},scheduleAutoRefresh:()=>{},stopSecondTick:()=>{},
    getO2oOrderBusinessStatusMeta:(value)=>({label:value}),
    ElMessageBox:{confirm:()=>{const d=deferred();confirms.push(d);return d.promise}},
    updateO2oOrderBusinessStatus:(id,value)=>{const d=deferred();posts.push({id,value,...d});return d.promise},
    mergeOrderSummaryFromDetail:()=>{},showAppSuccess:(value)=>success.push(value),showAppError:(value)=>errors.push(value),
  },progressNames)
  return {subject,activeOrderId,activeOrderDetail,authStore,confirms,posts,success,errors,
    switch:(id)=>{activeOrderId.value=id??'';activeOrderDetail.value=id?order(id,'preparing'):null},
    unmount:()=>subject.deactivatePageRuntime(),
  }
}
// 生命周期变量由handler闭包读取，卸载测试必须执行真实deactivate中的归属失效语句。
const deactivate=progressAst.statements.filter(ts.isVariableStatement).flatMap(s=>[...s.declarationList.declarations]).find(d=>d.name.getText(progressAst)==='deactivatePageRuntime')
assert.ok(deactivate.initializer.getText(progressAst).includes('businessStatusPageActive = false'))
for(const mode of ['B','empty','ABA','account','unmount']) {
  const h=progress(),p=h.subject.handleBusinessStatusChange('ready')
  if(mode==='unmount')h.unmount()
  else if(mode==='account')h.authStore.currentUser={id:'other'}
  else {h.switch(mode==='empty'?null:'B');if(mode==='ABA')h.switch('A')}
  h.confirms[0].resolve();await p
  assert.equal(h.posts.length,0,`确认期间${mode}不得发请求`)
}
{
  const h=progress(),p=h.subject.handleBusinessStatusChange('ready');h.confirms[0].resolve();await flush()
  h.switch('B');h.switch('A');h.posts[0].resolve(order('A','ready'));await p
  assert.equal(h.activeOrderDetail.value.order.businessStatus,'preparing','在途A→B→A也不能复活旧操作')
}
{
  const h=progress(),p=h.subject.handleBusinessStatusChange('ready');h.switch('B');h.confirms[0].reject('cancel');await p
  assert.equal(h.subject.draftBusinessStatus.value,'preparing','取消旧确认不能覆盖B草稿')
}
for(const reject of [false,true]) {
  const h=progress(),p=h.subject.handleBusinessStatusChange('ready');h.confirms[0].resolve();await flush()
  assert.equal(h.posts[0].id,'A');h.switch('B')
  const next=h.subject.handleBusinessStatusChange('after_sale');h.confirms[1].resolve();await flush()
  if(reject)h.posts[0].reject(new Error('old failure'));else h.posts[0].resolve(order('A','ready'))
  await p
  assert.equal(h.activeOrderDetail.value.order.id,'B');assert.equal(h.subject.businessStatusSaving.value,true,'旧finally不能清新操作saving')
  assert.equal(h.success.length,0);assert.equal(h.errors.length,0)
  h.posts[1].resolve(order('B','after_sale'));await next
  assert.equal(h.activeOrderDetail.value.order.businessStatus,'after_sale')
}

const feedbackAst=pageAst('src/views/client/ClientFeedbackDetailView.vue')
const feedbackNames=['handleConfirmResolved','handleWithdrawConversation','handleSubmitSatisfaction']
const feedbackWatcher=feedbackAst.statements.find(statement=>ts.isExpressionStatement(statement)&&statement.getText(feedbackAst).startsWith('watch(')&&statement.getText(feedbackAst).includes('detailLifecycle.invalidatePage'))
assert.ok(feedbackWatcher)
const feedbackSource=declarations(feedbackAst,feedbackNames)+'\n'+feedbackWatcher.getText(feedbackAst)
const {createFeedbackDetailLifecycle}=helper('src/views/client/client-feedback-detail-lifecycle.ts')
const replyPolicy=helper('src/views/client/client-feedback-reply-policy.ts')
const feedback=()=>{
  let mounted=true
  const route=reactive({params:{id:'A'}}),clientAuthStore=reactive({currentUser:{id:'owner'},sessionGeneration:1})
  const conversation=ref({id:'A',issueNo:'A',status:'resolved',satisfaction:null}),confirms=[],posts=[],reads=[],success=[],errors=[]
  const fields=Object.fromEntries(['replySubmitting','confirmingResolved','withdrawingConversation','satisfactionSubmitting','uploadingReplyAttachments','satisfactionDialogVisible','unavailable','loading','detailLoading'].map(name=>[name,ref(false)]))
  Object.assign(fields,Object.fromEntries(['satisfactionComment','replyDraft','previewImageUrl','loadError','refreshWarning','reconnectTip'].map(name=>[name,ref('')])),{replyAttachments:ref([]),selectedSatisfactionLevel:ref('satisfied'),availability:ref(null)})
  const detailLifecycle=createFeedbackDetailLifecycle({isMounted:()=>mounted,readContext:()=>({ownerId:clientAuthStore.currentUser?.id,sessionGeneration:clientAuthStore.sessionGeneration,conversationId:route.params.id})})
  const post=(kind,id,payload)=>{const d=deferred();posts.push({kind,id,payload:payload&&plain(payload),...d});return d.promise}
  const subject=execute(feedbackSource,{...fields,...replyPolicy,conversation,route,clientAuthStore,detailLifecycle,
    detailRequest:{cancel:()=>{}},stopRealtime:()=>{},normalizeSubmitText:(value)=>value.trim(),
    canWithdrawConversation:computed(()=>conversation.value?.status!=='closed'),canRateSatisfaction:computed(()=>['resolved','closed'].includes(conversation.value?.status)),hasRatedSatisfaction:computed(()=>Boolean(conversation.value?.satisfaction)),
    ElMessageBox:{confirm:()=>{const d=deferred();confirms.push(d);return d.promise}},
    confirmClientFeedbackResolved:id=>post('confirm',id),withdrawClientFeedbackConversation:id=>post('withdraw',id),submitClientFeedbackSatisfaction:(id,payload)=>post('rating',id,payload),
    loadConversationDetail:async(id)=>{const d=deferred();reads.push({id,...d});await d.promise},
    showAppSuccess:value=>success.push(value),showAppWarning:()=>{},showAppError:value=>errors.push(value),showCriticalErrorDialog:value=>errors.push(value),
  },feedbackNames)
  const change=(mode)=>{
    if(mode==='account')clientAuthStore.currentUser={id:'other'}
    else if(mode==='session')clientAuthStore.sessionGeneration++
    else if(mode==='unmount'){mounted=false;detailLifecycle.invalidatePage()}
    else {route.params.id='B';if(mode==='ABA')route.params.id='A'}
    conversation.value={id:route.params.id,issueNo:route.params.id,status:'resolved',satisfaction:null}
  }
  return {subject,fields,conversation,confirms,posts,reads,success,errors,change}
}
const handlers={confirm:'handleConfirmResolved',withdraw:'handleWithdrawConversation',rating:'handleSubmitSatisfaction'}
for(const mode of ['conversation','account','session','unmount','ABA']) {
  const h=feedback(),running=h.subject.handleWithdrawConversation();h.change(mode);h.confirms[0].resolve();await running
  assert.equal(h.posts.length,0,`撤回确认期间${mode}不得撤回新目标`)
}
for(const [kind,name] of Object.entries(handlers))for(const mode of ['conversation','account','session','unmount','ABA'])for(const rejected of [false,true]) {
  const h=feedback();h.fields.satisfactionComment.value='原评价';const running=h.subject[name]()
  if(kind==='withdraw'){h.confirms[0].resolve();await flush()}
  assert.equal(h.posts[0].id,'A');if(kind==='rating')assert.deepEqual(h.posts[0].payload,{level:'satisfied',comment:'原评价'})
  await h.subject[name]();assert.equal(h.posts.length,1,'在途重复点击不能再发POST')
  h.change(mode)
  if(rejected)h.posts[0].reject(new Error('old failure'));else h.posts[0].resolve({level:'satisfied',comment:'原评价',ratedAt:'2026-11-09T00:00:00Z'})
  await running
  assert.equal(h.reads.length,0,'失效POST回包不能读取新会话');assert.equal(h.success.length,0);assert.equal(h.errors.length,0)
}
for(const [kind,name] of Object.entries(handlers)) {
  const h=feedback(),running=h.subject[name]();if(kind==='withdraw'){h.confirms[0].resolve();await flush()}
  h.posts[0].resolve({level:'satisfied',ratedAt:'2026-11-09T00:00:00Z'});await flush()
  assert.equal(h.reads[0].id,'A');h.reads[0].reject(new Error('GET failed'));await running
  assert.equal(h.success.length,1,'POST成功立即按成功反馈');assert.equal(h.errors.length,0,'回读失败不能提示写入失败')
  assert.ok(h.fields.refreshWarning.value.includes('同步失败'))
  await h.subject[name]();assert.equal(h.posts.length,1,'已确认成功但回读失败不能诱导重复提交')
}
for(const [kind,name] of Object.entries(handlers))for(const mode of ['conversation','account','session','unmount','ABA']) {
  const h=feedback(),running=h.subject[name]();if(kind==='withdraw'){h.confirms[0].resolve();await flush()}
  h.posts[0].resolve({level:'satisfied',ratedAt:'2026-11-09T00:00:00Z'});await flush()
  assert.equal(h.reads[0].id,'A');h.change(mode)
  h.reads[0].reject(new Error('late GET failed'));await running
  assert.equal(h.conversation.value.status,'resolved','迟到回读不能改新会话状态')
  assert.equal(h.fields.refreshWarning.value,'','迟到回读不能写新上下文警告');assert.equal(h.errors.length,0)
}
console.log('[verify:async-action-ownership] 真实商城刷新、下单收尾、商家状态与反馈动作的归属和迟到回读回归通过')
