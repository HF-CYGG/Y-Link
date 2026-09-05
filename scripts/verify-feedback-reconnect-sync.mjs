/**
 * 文件说明：scripts/verify-feedback-reconnect-sync.mjs
 * 文件职责：静态校验客户端反馈 SSE 首次连接与重连后的权威状态同步契约。
 * 维护说明：连接恢复只能触发反馈配置、列表或详情的只读刷新，不得在 onOpen 中创建消息或执行其他业务写入。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

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
assertIncludes(listViewSource, 'const refreshAuthoritativeFeedbackState = async () =>', '反馈列表页应统一收口权威状态刷新')

const listOnOpen = listViewSource.match(/onOpen:\s*\(payload\)\s*=>\s*\{([\s\S]*?)\n\s*\},\n\s*onConversation:/)?.[1] ?? ''
assert.ok(listOnOpen, '反馈列表页应声明 SSE onOpen 处理')
assertIncludes(listOnOpen, 'refreshAuthoritativeFeedbackState()', '反馈列表 SSE 首次连接与重连后应刷新入口配置和会话列表')
assert.ok(!/append|create|submit|upload/i.test(listOnOpen), '反馈列表 SSE onOpen 不得执行消息创建或其他业务写入')

const detailOnOpen = detailViewSource.match(/onOpen:\s*\(payload\)\s*=>\s*\{([\s\S]*?)\n\s*\},\n\s*onConversation:/)?.[1] ?? ''
assert.ok(detailOnOpen, '反馈详情页应声明 SSE onOpen 处理')
assertIncludes(detailOnOpen, 'refreshAuthoritativeConversationDetail(', '反馈详情 SSE 首次连接与重连后应刷新当前权威详情')
assert.ok(!/append|create|submit|upload/i.test(detailOnOpen), '反馈详情 SSE onOpen 不得执行消息创建或其他业务写入')

assertIncludes(detailViewSource, 'preserveLocalState: true', 'SSE 自动刷新详情时应保留用户未提交的本地输入和界面状态')
assertIncludes(detailViewSource, 'detailRequest.cancel()', '详情页离开当前会话时应取消未完成的详情请求')

console.log('[verify:feedback-reconnect-sync] 客户端反馈 SSE 重连权威状态同步契约验证通过')
