/** 使用隔离内存存储和受控时钟验证目录 Store 的延迟写入与账号代次。 */
import assert from 'node:assert/strict'
import { createPinia, setActivePinia } from 'pinia'
import type { O2oMallStorefrontConfig } from '../src/api/modules/o2o'
import { useClientCartStore } from '../src/store/modules/client-cart'
import { useClientCatalogStore } from '../src/store/modules/client-catalog'
import { useClientOrderStore } from '../src/store/modules/client-order'
import { clearClientSessionData } from '../src/utils/client-session-cleanup'

let now = 0
let serial = 0
const timers = new Map<number, { at: number; run: () => void }>()
const originalSet = globalThis.setTimeout
const originalClear = globalThis.clearTimeout
globalThis.setTimeout = ((run: () => void, delay = 0) => {
  const id = ++serial
  timers.set(id, { at: now + Number(delay), run })
  return id
}) as typeof setTimeout
globalThis.clearTimeout = ((id: number) => { timers.delete(id) }) as typeof clearTimeout
const advance = (ms: number) => {
  const end = now + ms
  while (true) {
    const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
    if (!next) break
    now = next[1].at
    timers.delete(next[0])
    next[1].run()
  }
  now = end
}
class MemoryStorage {
  values = new Map<string, string>()
  writes: string[] = []
  fail = false
  get length() { return this.values.size }
  key(i: number) { return [...this.values.keys()][i] ?? null }
  getItem(key: string) { return this.values.get(key) ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) {
    if (this.fail) throw new DOMException('配额不足', 'QuotaExceededError')
    this.writes.push(key)
    this.values.set(key, value)
  }
}
const storage = new MemoryStorage()
const page = new EventTarget()
const documentTarget = new EventTarget() as EventTarget & { visibilityState: string }
documentTarget.visibilityState = 'visible'
Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(page, { localStorage: storage, sessionStorage: storage }) })
Object.defineProperty(globalThis, 'document', { configurable: true, value: documentTarget })
const dataWrites = () => storage.writes.filter((key) => key.includes('catalog') && !key.includes('storefront') && !key.includes('context')).length
const browseKey = (owner: string) => `y-link.client-catalog.context:${owner}`
const browseWrites = () => storage.writes.filter((key) => key.startsWith('y-link.client-catalog.context:')).length
const data = (name: string) => [{ id: name, productName: name, skus: [] }] as Parameters<ReturnType<typeof useClientCatalogStore>['setProducts']>[0]
try {
  setActivePinia(createPinia())
  const store = useClientCatalogStore()
  store.initialize('A')
  store.setProducts(data('一'))
  advance(100)
  store.setProducts(data('二'))
  advance(199)
  assert.equal(dataWrites(), 0)
  advance(1)
  assert.equal(dataWrites(), 1, '密集更新合并一次')
  const beforeContinuous = dataWrites()
  for (let i = 0; i < 10; i++) { store.setProducts(data(String(i))); advance(100) }
  assert.equal(dataWrites(), beforeContinuous + 1, '持续更新最迟一秒写入')
  store.setProducts(data('页面隐藏'))
  page.dispatchEvent(new Event('pagehide'))
  assert.equal(dataWrites(), beforeContinuous + 2)
  store.setProducts(data('旧账号'))
  const stale = [...timers.values()].map((timer) => timer.run)
  store.initialize('B')
  store.initialize('A')
  const beforeStale = dataWrites()
  stale.forEach((run) => run())
  advance(1000)
  assert.equal(dataWrites(), beforeStale, 'A-B-A 后旧回调失效')
  store.setProducts(data('清除'))
  const cleared = [...timers.values()].map((timer) => timer.run)
  store.clearAll()
  cleared.forEach((run) => run())
  assert.equal(dataWrites(), beforeStale, '清理后旧回调失效')
  assert.ok(storage.values.has('y-link.client-catalog.public-data.v2'), '清理账号时保留公共目录')
  store.initialize('A')
  store.setProducts(data('隐藏'))
  documentTarget.visibilityState = 'hidden'
  documentTarget.dispatchEvent(new Event('visibilitychange'))
  assert.equal(dataWrites(), beforeStale + 1, '隐藏时冲刷')
  documentTarget.visibilityState = 'visible'
  storage.fail = true
  assert.doesNotThrow(() => { store.setProducts(data('配额')); advance(200) })
  assert.equal(store.products[0]?.productName, '配额')
  storage.fail = false
  store.setProducts(data('释放'))
  const beforeDispose = dataWrites()
  store.$dispose()
  assert.equal(dataWrites(), beforeDispose + 1, '释放 Store 时冲刷')
  advance(1000)
  assert.equal(dataWrites(), beforeDispose + 1, '释放后无残留定时写入')

  // 同账号 initialize 必须完全幂等：保留原定时任务身份、quiet/max 截止时间及 dirty 数据。
  for (const trigger of ['deadline', 'pagehide', 'dispose', 'maximum'] as const) {
    setActivePinia(createPinia())
    const sameOwner = useClientCatalogStore()
    sameOwner.initialize('A')
    sameOwner.setProducts(data(`同账号-${trigger}`))
    advance(100)
    const pending = [...timers.entries()]
    const before = dataWrites()
    sameOwner.initialize(' A ')
    assert.deepEqual([...timers.entries()], pending, '同账号初始化不得取消、替换或推迟当前任务')
    let expectedName = `同账号-${trigger}`
    if (trigger === 'deadline') {
      advance(99)
      assert.equal(dataWrites(), before)
      advance(1)
    } else if (trigger === 'pagehide') {
      page.dispatchEvent(new Event('pagehide'))
    } else if (trigger === 'dispose') {
      sameOwner.$dispose()
    } else {
      // 连续更新压住 quiet timer，同账号初始化不能把一秒最大截止时间向后移动。
      for (let i = 1; i <= 8; i++) {
        sameOwner.setProducts(data(`持续同账号-${i}`))
        advance(100)
        sameOwner.initialize('A')
        assert.equal(dataWrites(), before)
      }
      expectedName = '同账号最大截止终值'
      sameOwner.setProducts(data(expectedName))
      advance(99)
      sameOwner.initialize('A')
      assert.equal(dataWrites(), before)
      advance(1)
    }
    assert.equal(dataWrites(), before + 1, `${trigger} 应写入未丢失的 dirty 数据`)
    const saved = JSON.parse(storage.getItem('y-link.client-catalog.public-data.v2') ?? '{}')
    assert.equal(saved.products?.[0]?.productName, expectedName)
    if (trigger !== 'dispose') sameOwner.$dispose()
    advance(1000)
    assert.equal(dataWrites(), before + 1, `${trigger} 冲刷后不得重复写入`)
  }

  // 换号、空账号、未初始化的同账号 reinit 仍须推进代次，旧回调不得写入或冲刷新任务。
  for (const transition of ['switch', 'empty', 'reinit'] as const) {
    setActivePinia(createPinia())
    const owner = useClientCatalogStore()
    owner.initialize('A')
    owner.setProducts(data('旧代次'))
    const callbacks = [...timers.values()].map(timer => timer.run)
    if (transition === 'reinit') owner.initialized = false
    owner.initialize(transition === 'switch' ? 'B' : transition === 'empty' ? null : 'A')
    const before = dataWrites()
    if (transition !== 'empty') owner.setProducts(data('新代次'))
    callbacks.forEach(run => run())
    assert.equal(dataWrites(), before, `${transition} 后旧回调必须失效`)
    advance(200)
    assert.equal(dataWrites(), before + (transition === 'empty' ? 0 : 1))
    owner.$dispose()
  }

  // 分类滚动变化不触发本帧同步写入；查询和排序共用小快照定时器。
  const sessionPinia = createPinia()
  const browse = useClientCatalogStore(sessionPinia)
  const cart = useClientCartStore(sessionPinia)
  const order = useClientOrderStore(sessionPinia)
  browse.initialize('A')
  cart.initialize('A')
  order.initialize('A')
  const browseBefore = browseWrites()
  browse.setActiveCategoryKey('tea')
  advance(100)
  browse.setKeyword('红茶')
  browse.setSortMode('recommended')
  advance(399)
  assert.equal(browseWrites(), browseBefore)
  browse.setActiveCategoryKey('tea')
  browse.setKeyword('红茶')
  browse.setSortMode('recommended')
  advance(1)
  assert.equal(browseWrites(), browseBefore + 1, '无变化的值不延期且不增加写入')
  assert.deepEqual(JSON.parse(storage.getItem(browseKey('A')) ?? '{}'), { activeCategoryKey: 'tea', keyword: '红茶', sortMode: 'recommended' })
  browse.setKeyword('可见性刷新')
  documentTarget.visibilityState = 'hidden'
  documentTarget.dispatchEvent(new Event('visibilitychange'))
  assert.equal(browseWrites(), browseBefore + 2)
  documentTarget.visibilityState = 'visible'

  browse.setKeyword('待清除的旧词')
  browse.setProducts(data('待清除的目录'))
  order.setSearch('账户A的订单', 'contains')
  const canceled = [...timers.values()].map((timer) => timer.run)
  const afterHiddenWrite = browseWrites()
  const beforeClearData = dataWrites()
  clearClientSessionData(sessionPinia, 'A')
  assert.equal(cart.clientUserId, '')
  assert.equal(order.keyword, '')
  assert.equal(browse.keyword, '')
  assert.equal(storage.getItem(browseKey('A')), null)
  assert.equal(storage.getItem('y-link.client-cart.snapshot:A'), null)
  assert.equal(storage.getItem('y-link.client-order.snapshot.meta:A'), null)
  assert.ok(storage.values.has('y-link.client-catalog.public-data.v2'))
  browse.initialize('B')
  browse.setKeyword('账号B')
  page.dispatchEvent(new Event('pagehide'))
  browse.initialize('A')
  canceled.forEach((run) => run())
  advance(1000)
  assert.equal(browse.keyword, '')
  assert.equal(storage.getItem(browseKey('A')), null)
  assert.equal(JSON.parse(storage.getItem(browseKey('B')) ?? '{}').keyword, '账号B')
  assert.equal(browseWrites(), afterHiddenWrite + 1, '只有账号 B 被 pagehide 写入，切回 A 不得复活旧词')
  assert.equal(dataWrites(), beforeClearData, '账号切换同时取消旧目录快照写入')

  const actualNow = Date.now
  try {
    Date.now = () => 10_000
    order.initialize('B')
    order.setOrders([])
    assert.equal(order.isFresh, true)
    Date.now = () => 10_000 + 3 * 60_000 + 1
    assert.equal(order.isFreshNow(), false, '没有响应字段发生变化，订单请求仍按当前时间判过期')
  } finally {
    Date.now = actualNow
    browse.$dispose()
    cart.$dispose()
    order.$dispose()
  }

  // 订单详情可能从未加载商品目录，独立门店快照也应能恢复，并在兼容旧响应时补齐取货地址。
  const storefrontKey = 'y-link.client-catalog.public-storefront.v2'
  storage.values.clear()
  storage.values.set(storefrontKey, JSON.stringify({ storefront: { businessHoursText: '09:00 - 11:30', mallAnnouncementText: '' } }))
  setActivePinia(createPinia())
  const pickupStore = useClientCatalogStore()
  pickupStore.initialize('A')
  assert.equal(pickupStore.storefront.businessHoursText, '09:00 - 11:30')
  assert.equal(pickupStore.storefront.pickupAddress, '海右书院112房间')

  const oldStorefront = { businessHoursText: '10:00 - 22:00', mallAnnouncementText: '' }
  const newStorefront = { businessHoursText: '09:00 - 11:30；14:00 - 20:00', mallAnnouncementText: '新公告', pickupAddress: '  北区窗口  ' }
  storage.values.set(storefrontKey, JSON.stringify({ storefront: { ...newStorefront, pickupAddress: '上次取货点' } }))
  pickupStore.initialize('B')
  pickupStore.setProducts({ list: [], storefront: oldStorefront })
  assert.equal(await pickupStore.refreshStorefront(async () => { throw new Error('刷新失败') }), null)
  assert.equal(pickupStore.storefront.pickupAddress, '上次取货点', '先到的旧目录和独立刷新失败都不能回滚已恢复快照')
  assert.equal(pickupStore.storefront.businessHoursText, newStorefront.businessHoursText)

  const holdStorefront = () => {
    let finish!: (value: O2oMallStorefrontConfig) => void
    const pending = new Promise<O2oMallStorefrontConfig>((resolve) => { finish = resolve })
    return { pending, finish }
  }
  let requests = 0
  const oldResponse = holdStorefront()
  const loadOldStorefront = () => { requests += 1; return oldResponse.pending }
  const firstRefresh = pickupStore.refreshStorefront(loadOldStorefront)
  const duplicateRefresh = pickupStore.refreshStorefront(loadOldStorefront, 'manual')
  await Promise.resolve()
  assert.equal(requests, 1, '普通展示刷新共用同一门店请求')
  const fresh = await pickupStore.refreshStorefront(async () => newStorefront, 'checkout')
  assert.equal(fresh?.pickupAddress, '北区窗口', '新单独立回源，不等待正在进行的普通请求')
  oldResponse.finish(oldStorefront)
  assert.deepEqual(await Promise.all([firstRefresh, duplicateRefresh]), [null, null], '同账号的旧展示请求不可覆盖新单回源')
  pickupStore.setProducts({ list: [], storefront: oldStorefront })
  assert.equal(pickupStore.storefront.pickupAddress, '北区窗口', '迟到目录应答不得回滚独立门店配置')
  assert.equal(pickupStore.storefront.businessHoursText, newStorefront.businessHoursText)

  const staleDisplay = holdStorefront()
  const privateResponse = holdStorefront()
  const staleDisplayRefresh = pickupStore.refreshStorefront(() => staleDisplay.pending, 'manual')
  const checkoutRefresh = pickupStore.refreshStorefront(() => privateResponse.pending, 'checkout')
  staleDisplay.finish(oldStorefront)
  assert.equal(await staleDisplayRefresh, null)
  const joiningDisplay = pickupStore.refreshStorefront(loadOldStorefront, 'manual')
  privateResponse.finish(newStorefront)
  assert.equal((await checkoutRefresh)?.pickupAddress, '北区窗口')
  assert.equal((await joiningDisplay)?.pickupAddress, '北区窗口', '旧 finally 不能清除仍在进行的私有回源')
  assert.equal(requests, 1)

  const oldOwnerResponse = holdStorefront()
  const oldOwnerRefresh = pickupStore.refreshStorefront(() => oldOwnerResponse.pending, 'manual')
  pickupStore.initialize('A')
  pickupStore.initialize('B')
  assert.equal((await pickupStore.refreshStorefront(async () => newStorefront))?.pickupAddress, '北区窗口')
  oldOwnerResponse.finish(oldStorefront)
  assert.equal(await oldOwnerRefresh, null, '换号切回仍丢弃旧请求')
  assert.equal(await pickupStore.refreshStorefront(async () => { throw new Error('强刷失败') }, 'checkout'), null)
  assert.equal(pickupStore.storefront.pickupAddress, '北区窗口', '失败保留可信快照')
  assert.equal(JSON.parse(storage.getItem(storefrontKey) ?? '{}').storefront?.pickupAddress, '北区窗口')
  pickupStore.$dispose()
} finally {
  globalThis.setTimeout = originalSet
  globalThis.clearTimeout = originalClear
}
