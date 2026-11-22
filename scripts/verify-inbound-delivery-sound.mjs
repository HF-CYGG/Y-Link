/**
 * 文件职责：执行实际送货单池 SFC 脚本和 useStableRequest，验证提示音与增量轮询的异步边界。
 * 实现逻辑：仅替换浏览器时钟、AudioContext、存储和 API；页面控制与稳定请求取消逻辑保持原代码。
 * 维护说明：大整数断言只验证前端十进制比较，不代表后端 SQL/MAX 或端到端 ID 精度验收。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const pagePath = '../src/views/inbound/components/InboundDeliveryPoolPanel.vue'
const pageSource = readFileSync(new URL(pagePath, import.meta.url), 'utf8').split('<script setup lang="ts">')[1]?.split('</script>')[0]
assert.ok(pageSource, '必须执行实际送货单池页面脚本')
const pageAst = ts.createSourceFile('InboundDeliveryPoolPanel.ts', pageSource, ts.ScriptTarget.Latest, true)
const pageCode = pageAst.statements.filter((statement) => !ts.isImportDeclaration(statement)).map((statement) => statement.getText(pageAst)).join('\n')
const stableSource = readFileSync(new URL('../src/composables/useStableRequest.ts', import.meta.url), 'utf8')
const stableAst = ts.createSourceFile('useStableRequest.ts', stableSource, ts.ScriptTarget.Latest, true)
const stableFactory = stableAst.statements.filter(ts.isVariableStatement).flatMap((statement) => [...statement.declarationList.declarations]).find((declaration) => declaration.name.getText(stableAst) === 'useStableRequest')?.initializer?.getText(stableAst)
assert.ok(stableFactory, '必须保留真实稳定请求实现，不能以 mock 替代取消语义')
const javascript = ts.transpileModule(`const useStableRequest = ${stableFactory};\n${pageCode}\nglobalThis.subject = { soundEnabled, latestOrderId, handleSoundChange, playSound, loadPool, higherOrderId, activateRuntime, deactivateRuntime };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText
const flush = async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve() }
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const pool = (latestOrderId, newOrderCount = 0) => ({ records: [], total: 0, page: 1, poolCounts: { all: 0, pending: 0, verified: 0 }, latestOrderId, newOrderCount })

const harness = ({ savedSound = false, storageBroken = false, initialId = '10' } = {}) => {
  const hooks = { mounted: [], activated: [], deactivated: [], unmount: [] }
  const listeners = new Map()
  const timers = new Map()
  const responses = []
  const requests = []
  const tones = []
  const warnings = []
  const notices = []
  const contexts = []
  const pendingResumes = []
  let timerId = 0
  let now = 0
  let current = pool(initialId)
  let resumeMode = 'resolve'
  let resumeCount = 0
  const finish = (tone) => { if (!tone.ended) { tone.ended = true; tone.onended?.() } }
  class FakeAudioContext {
    constructor() { this.state = 'suspended'; this.destination = {}; contexts.push(this) }
    get currentTime() { return now / 1000 }
    resume() {
      resumeCount += 1
      if (resumeMode === 'reject') return Promise.reject(new Error('fixture permission denied'))
      if (resumeMode === 'pending') {
        const waiting = deferred()
        pendingResumes.push(() => { this.state = 'running'; waiting.resolve() })
        return waiting.promise
      }
      this.state = 'running'
      return Promise.resolve()
    }
    close() { this.state = 'closed'; return Promise.resolve() }
    createOscillator() {
      const tone = { frequency: { value: 0 }, ended: false, onended: null, connect() {}, disconnect() {}, start(at) { tone.startedAt = at; tones.push(tone) }, stop(at) { tone.stopAt = at; if (at === undefined) finish(tone) } }
      return tone
    }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} } }
  }
  const document = {
    visibilityState: 'visible',
    addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback) },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback) },
  }
  const sandbox = {
    AbortController, Date, Promise, console,
    ref: (value) => ({ value }),
    computed: (getter) => ({ get value() { return getter() } }),
    onMounted: (fn) => hooks.mounted.push(fn),
    onActivated: (fn) => hooks.activated.push(fn),
    onDeactivated: (fn) => hooks.deactivated.push(fn),
    onBeforeUnmount: (fn) => hooks.unmount.push(fn),
    defineEmits: () => () => undefined,
    useDevice: () => ({ isPhone: { value: false } }),
    isRequestCanceled: (error) => error?.name === 'AbortError',
    dayjs: () => ({ format: () => 'fixture-time' }),
    extractErrorMessage: (_error, fallback) => fallback,
    showAppError: (message) => { throw new Error(message) },
    showAppInfo: (message) => notices.push(message),
    showAppWarning: (message) => warnings.push(message),
    getInboundDetail: async () => ({}),
    getInboundAdminPool: async (query, { signal }) => {
      requests.push({ query, signal })
      // 有意忽略 AbortSignal，让实际稳定请求层证明迟到结果被丢弃。
      const next = responses.shift() ?? current
      const result = await next
      current = result
      return result
    },
    localStorage: {
      getItem() { if (storageBroken) throw new Error('fixture storage denied'); return savedSound ? 'on' : 'off' },
      setItem() { if (storageBroken) throw new Error('fixture storage denied') },
    },
    window: { AudioContext: FakeAudioContext },
    document,
    setInterval(callback, duration) { const id = ++timerId; timers.set(id, { callback, duration, nextAt: now + duration }); return id },
    clearInterval(id) { timers.delete(id) },
  }
  vm.runInNewContext(javascript, sandbox, { filename: 'actual-inbound-delivery-pool.js' })
  const subject = sandbox.subject
  return {
    subject, document, timers, requests, tones, warnings, notices, contexts,
    get resumeCount() { return resumeCount },
    setResumeMode: (mode) => { resumeMode = mode },
    resolveResumes: () => { pendingResumes.splice(0).forEach((resolve) => resolve()) },
    finishTones: () => [...tones].forEach(finish),
    dispatch: (event) => { for (const listener of listeners.get(event) ?? []) listener() },
    async mount() { hooks.mounted.forEach((callback) => callback()); hooks.activated.forEach((callback) => callback()); await flush() },
    async activate() { hooks.activated.forEach((callback) => callback()); await flush() },
    deactivate() { hooks.deactivated.forEach((callback) => callback()) },
    unmount() { hooks.unmount.forEach((callback) => callback()) },
    async load(result, silent = true) { responses.push(result); await subject.loadPool({ silent }); await flush() },
    queue: (result) => responses.push(result),
    async tick(milliseconds) {
      const until = now + milliseconds
      for (;;) {
        const earliest = [...timers.values()].filter((timer) => timer.nextAt <= until).sort((a, b) => a.nextAt - b.nextAt)[0]
        if (!earliest) break
        now = earliest.nextAt
        earliest.nextAt += earliest.duration
        earliest.callback()
        await flush()
      }
      now = until
      await flush()
    },
  }
}

const main = harness({ initialId: '9007199254740992' })
await main.mount()
assert.equal(main.subject.soundEnabled.value, false, '首次未保存偏好时默认关闭')
assert.equal(main.tones.length, 0, '首次加载必须静音')
assert.equal(main.contexts.length, 0, '首载不得自动创建音频上下文')
assert.equal(main.timers.size, 1, 'mounted 与 activated 重叠也只能有一个轮询定时器')
main.subject.soundEnabled.value = true
main.setResumeMode('reject')
main.subject.handleSoundChange()
await flush()
assert.equal(main.tones.length, 0)
assert.ok(main.warnings.length, '手势开启失败必须给出可恢复提示')
main.setResumeMode('resolve')
main.dispatch('pointerdown')
await flush()
assert.ok(main.resumeCount >= 2, '再次用户手势可恢复挂起上下文')
assert.equal(main.tones.length, 0, '普通解锁手势本身不应重复响铃')
await main.load(pool('9007199254740993', 1))
assert.equal(main.tones.length, 2, '超过前端大整数高水位的新提交应触发一次双音提醒')
assert.equal(main.tones[0].startedAt, 0.01)
assert.ok(Math.abs(main.tones[1].startedAt - 0.21) < 1e-9)
main.finishTones()
await main.load(pool('9007199254740993', 8))
await main.load(pool('9007199254740992', 8))
assert.equal(main.tones.length, 2, '重复或撤销回退后的更旧 ID 不得重复响')
assert.equal(main.subject.latestOrderId.value, '9007199254740993')
main.queue(pool('9007199254740994', 1))
await main.tick(15_000)
assert.equal(main.tones.length, 4, '边界时钟到达轮询周期才执行实际增量提醒')
main.finishTones()
await main.activate()
await main.activate()
assert.equal(main.timers.size, 1)
main.document.visibilityState = 'hidden'
main.dispatch('visibilitychange')
assert.equal(main.timers.size, 0)
main.document.visibilityState = 'visible'
main.dispatch('visibilitychange')
main.dispatch('visibilitychange')
await flush()
assert.equal(main.timers.size, 1, '重复恢复可见仍最多一个定时器')
main.deactivate()
assert.equal(main.timers.size, 0)
await main.activate()
await main.activate()
assert.equal(main.timers.size, 1, 'KeepAlive 再激活必须恢复且不叠加定时器')
main.unmount()
assert.equal(main.timers.size, 0)

const saved = harness({ savedSound: true })
await saved.mount()
assert.equal(saved.tones.length, 0, '已保存声音开启偏好也不能首载响铃')
saved.unmount()
const storage = harness({ storageBroken: true })
await storage.mount()
assert.equal(storage.subject.soundEnabled.value, false)
storage.subject.soundEnabled.value = true
storage.subject.handleSoundChange()
await flush()
assert.equal(storage.tones.length, 2, '存储读写均不可用不能阻止当前页面启用音频')
storage.unmount()

for (const reason of ['off', 'hidden', 'deactivated', 'unmount']) {
  const subject = harness({ savedSound: true })
  await subject.mount()
  subject.setResumeMode('pending')
  const inFlight = subject.subject.playSound(true)
  if (reason === 'off') { subject.subject.soundEnabled.value = false; subject.subject.handleSoundChange() }
  if (reason === 'hidden') { subject.document.visibilityState = 'hidden'; subject.dispatch('visibilitychange') }
  if (reason === 'deactivated') subject.deactivate()
  if (reason === 'unmount') subject.unmount()
  subject.resolveResumes()
  await inFlight
  assert.equal(subject.tones.length, 0, `${reason} 后迟到的 resume 不得创建音调`)
  subject.unmount()
}

const lateRequest = harness({ savedSound: true })
await lateRequest.mount()
lateRequest.dispatch('pointerdown')
await flush()
const waiting = deferred()
lateRequest.queue(waiting.promise)
const loading = lateRequest.subject.loadPool({ silent: true })
await flush()
lateRequest.document.visibilityState = 'hidden'
lateRequest.dispatch('visibilitychange')
waiting.resolve(pool('100', 4))
await loading
assert.equal(lateRequest.tones.length, 0, '隐藏时即便 API 忽略取消信号，迟到增量也不得响铃')
assert.equal(lateRequest.notices.length, 0, '实际稳定请求层必须丢弃迟到提示')
assert.equal(lateRequest.subject.latestOrderId.value, '10', '被取消结果不得推进高水位')
lateRequest.unmount()
console.log('OK 送货单池实际页面与稳定请求：首载静音、手势失败恢复、增量去重、大整数前端比较、迟到取消、单一定时器及存储降级通过；未验证真实扬声器或后端大整数边界')
