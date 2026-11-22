/**
 * 文件说明：scripts/verify-feedback-reconnect-sync.mjs
 * 文件职责：校验客户端反馈 SSE 的连接回收、重连抢占及权威状态同步。
 * 维护说明：连接恢复只能触发反馈配置、列表或详情的只读刷新，不得在 onOpen 中创建消息或执行其他业务写入。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const apiSource = readFileSync('src/api/modules/customer-service-feedback.ts', 'utf8')
const listViewSource = readFileSync('src/views/client/ClientFeedbackView.vue', 'utf8')
const detailViewSource = readFileSync('src/views/client/ClientFeedbackDetailView.vue', 'utf8')

const assertIncludes = (source, needle, message) => {
  assert.ok(source.includes(needle), message)
}

assertIncludes(
  apiSource,
  'getClientFeedbackPortalConfig = async (requestConfig: RequestConfig = {})',
  '反馈入口配置查询应允许稳定请求通道传入 AbortSignal',
)
assertIncludes(
  apiSource,
  'listClientFeedbackConversations = async (requestConfig: RequestConfig = {})',
  '反馈列表查询应允许稳定请求通道传入 AbortSignal',
)

assertIncludes(listViewSource, 'const portalConfigRequest = useStableRequest()', '反馈列表页应为入口配置建立稳定请求通道')
assertIncludes(listViewSource, 'const conversationListRequest = useStableRequest()', '反馈列表页应为会话列表建立稳定请求通道')
assertIncludes(listViewSource, 'const refreshAuthoritativeFeedbackState = async (mayApply:', '反馈列表页应统一收口权威状态刷新')

const onOpenBody = (source) => source.match(/onOpen:\s*\(payload, isCurrentRealtime\)\s*=>\s*\{([\s\S]*?)\r?\n\s*\},\r?\n\s*onConversation:/)?.[1] ?? ''
const listOnOpen = onOpenBody(listViewSource)
assert.ok(listOnOpen, '反馈列表页应声明 SSE onOpen 处理')
assertIncludes(listOnOpen, 'refreshAuthoritativeFeedbackState(isCurrentRealtime)', '反馈列表 SSE 首次连接与重连后应刷新入口配置和会话列表')
assert.ok(!/append|create|submit|upload/i.test(listOnOpen), '反馈列表 SSE onOpen 不得执行消息创建或其他业务写入')

const detailOnOpen = onOpenBody(detailViewSource)
assert.ok(detailOnOpen, '反馈详情页应声明 SSE onOpen 处理')
assertIncludes(detailOnOpen, 'refreshAuthoritativeConversationDetail(', '反馈详情 SSE 首次连接与重连后应刷新当前权威详情')
assert.ok(!/append|create|submit|upload/i.test(detailOnOpen), '反馈详情 SSE onOpen 不得执行消息创建或其他业务写入')

assertIncludes(detailViewSource, 'preserveLocalState: true', 'SSE 自动刷新详情时应保留用户未提交的本地输入和界面状态')
assertIncludes(detailViewSource, 'detailRequest.cancel()', '详情页离开当前会话时应取消未完成的详情请求')
assertIncludes(listViewSource, '() => clientAuthStore.sessionGeneration] as const', '列表页需按会话代次回收连接')

const source = readFileSync('src/views/client/client-feedback-realtime.ts', 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const exports = {}, timers = new Map(), streams = [], events = []
const setTimeoutFake = (run, delay) => {
  assert.equal(delay, 3000)
  const id = Symbol()
  timers.set(id, () => { timers.delete(id); run() })
  return id
}
new Function('exports', 'setTimeout', 'clearTimeout', compiled)(exports, setTimeoutFake, (id) => timers.delete(id))
let sessionGeneration = 1
let active = true
let delayedOpenMayApply
const realtime = exports.createClientFeedbackRealtime({
  openStream: (handlers) => {
    const stream = { handlers, closeCount: 0 }
    streams.push(stream)
    return { close: () => { stream.closeCount += 1; handlers.onError() } }
  },
  captureOwner: () => {
    const session = sessionGeneration
    return () => session === sessionGeneration
  },
  isEligible: () => active,
  onConnecting: () => events.push('connecting'),
  onOpen: (_payload, mayApply) => { delayedOpenMayApply = mayApply; events.push('open') },
  onConversation: () => events.push('conversation'),
  onDisconnect: () => events.push('disconnect'),
})

realtime.connect()
realtime.connect()
assert.equal(streams.length, 1)
streams[0].handlers.onOpen({})
assert.equal(delayedOpenMayApply(), true)
streams[0].handlers.onError()
streams[0].handlers.onError()
streams[0].handlers.onOpen({})
streams[0].handlers.onConversation(null)
assert.equal(delayedOpenMayApply(), false, '断线前在途的异步刷新不可再更新 UI')
assert.equal(streams[0].closeCount, 1)
assert.equal(timers.size, 1)
assert.deepEqual(events, ['connecting', 'open', 'disconnect'])
const [cancelledRetry] = timers.values()
realtime.connect()
assert.equal(timers.size, 0, '主动重连应清理待执行计时器')
cancelledRetry()
assert.equal(streams.length, 2, '已入队的旧计时器也不能抢占新连接')
streams[1].handlers.onOpen({})
streams[1].handlers.onConversation(null)
assert.deepEqual(events.slice(-3), ['connecting', 'open', 'conversation'])
streams[1].handlers.onError()
const [invalidOwnerRetry] = timers.values()
sessionGeneration += 1
invalidOwnerRetry()
assert.equal(streams.length, 2, '同账号重登后的旧会话计时器不可建连接')
realtime.connect()
streams[2].handlers.onError()
const [automaticRetry] = timers.values()
automaticRetry()
assert.equal(streams.length, 4, '到期时当前页面应自动重连一次')
assert.equal(timers.size, 0)
active = false
realtime.stop()
streams[3].handlers.onError()
assert.equal(streams[3].closeCount, 1)
assert.equal(timers.size, 0, '离页并关闭后，旧事件不得再安排重连')

console.log('[verify:feedback-reconnect-sync] 客户端反馈 SSE 重连权威状态同步契约验证通过')
