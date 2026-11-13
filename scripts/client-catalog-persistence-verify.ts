/** 使用隔离内存存储和受控时钟验证目录 Store 的延迟写入与账号代次。 */
import assert from 'node:assert/strict'
import { createPinia, setActivePinia } from 'pinia'
import { useClientCatalogStore } from '../src/store/modules/client-catalog'

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
} finally {
  globalThis.setTimeout = originalSet
  globalThis.clearTimeout = originalClear
}
