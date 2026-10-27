/** 补货前端专项：纯业务边界 + Vue 模板语法 + 必要跨页契约，不访问网络、服务或数据库。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as vue from 'vue'
import dayjs from 'dayjs'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import type { ClientRestockRequest, O2oMallSku } from '../packages/shared-types/src/index'
import { formatRestockTime, getRestockExpiryDelay, getRestockSkus, isValidRestockQuantity, RESTOCK_MAX_QUANTITY, toRestockIso } from '../src/utils/restock'

const sku = (id: string, stock: number, isActive = true, isCurrent = true): O2oMallSku => ({
  id, productId: 'p1', skuCode: id, specValues: {}, specText: id, defaultPrice: '1', originalPrice: '1', discountRate: '1', discountedPrice: '1',
  currentStock: stock, preOrderedStock: 0, availableStock: stock, isActive, isCurrent, o2oRecommended: false, thumbnail: null, sortOrder: 0,
})
// 总库存有货、多 SKU 混合时仍可对确切缺货规格申请；限购不参与此函数。
assert.deepEqual(getRestockSkus({ skus: [sku('stocked', 5), sku('empty', 0), sku('disabled', 0, false), sku('retired', 0, true, false)] }).map((item) => item.id), ['empty'])
assert.deepEqual(getRestockSkus(null), [])
assert.deepEqual(getRestockSkus({ skus: [sku('unknown', Number.NaN), sku('negative', -1)] }), [])
assert.equal(isValidRestockQuantity(1), true)
assert.equal(isValidRestockQuantity(RESTOCK_MAX_QUANTITY), true)
for (const value of [0, -1, 1.2, Number.NaN, Infinity, RESTOCK_MAX_QUANTITY + 1]) assert.equal(isValidRestockQuantity(value), false)

// 跨 UTC 日期、闰年、无效日期和设备时区不同的分钟口径。
assert.equal(toRestockIso('2028-02-29 00:01'), '2028-02-29T00:01:00+08:00')
assert.equal(formatRestockTime('2026-10-25T16:01:00.000Z'), '2026-10-26 00:01')
assert.equal(formatRestockTime('2026-10-26T23:59:00+08:00'), '2026-10-26 23:59')
for (const value of ['2027-02-29 12:00', '2026-04-31 12:00', '2026-10-26 24:00', '2026-10-26 12:61', '2026-10-26 12:00:01', '2026-10-26T12:00Z']) assert.equal(toRestockIso(value), null)
const restock = { id: 'r1', effectiveStatus: 'requested', latestPickupAt: '2026-10-26T01:01:00Z' } as ClientRestockRequest
assert.equal(getRestockExpiryDelay(restock, '2026-10-26T01:00:00Z'), 60000)
assert.equal(getRestockExpiryDelay(restock, '2026-10-26T02:00:00Z'), 0)
for (const status of ['expired', 'restocked', 'cancelled'] as const) assert.equal(getRestockExpiryDelay({ ...restock, effectiveStatus: status }, '2026-10-26T01:00:00Z'), null)
assert.equal(getRestockExpiryDelay(restock, 'invalid'), null)

// 执行真实工作台 composable 与稳定请求器，API 仅以内存数据源替代；验证相同区间重查与缓存页返回。
const deactivationCallbacks: Array<() => void> = []
const vueRuntime = { ...vue, onBeforeUnmount: () => undefined, onDeactivated: (callback: () => void) => deactivationCallbacks.push(callback) }
const rankingCalls: Array<[string, string] | null> = []
let currentRequestCount = 1
const evaluate = (filename: string, imports: Record<string, unknown>, globals: Record<string, unknown> = {}) => {
  // API模块的Vite环境入口仅在测试VM中显式替换；真实提示函数直接执行，禁止网络/上传副作用。
  const source = readFileSync(filename, 'utf8').replaceAll('import.meta.env', '__TEST_IMPORT_META_ENV__')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  const exports: Record<string, any> = {}
  vm.runInNewContext(compiled, { exports, require: (name: string) => {
    assert.ok(Object.hasOwn(imports, name), `${filename} 需要显式声明测试依赖 ${name}`)
    return imports[name]
  }, AbortController, Date, console, __TEST_IMPORT_META_ENV__: Object.freeze({ VITE_API_BASE_URL: '/api' }), ...globals }, { filename })
  return exports
}
const stableRequestRuntime = evaluate('src/composables/useStableRequest.ts', {
  vue: vueRuntime, '@/utils/error': { isRequestCanceled: (error: unknown) => error instanceof Error && error.name === 'AbortError' },
})
const feedbackRuntime = evaluate('src/api/modules/customer-service-feedback.ts', {
  '@/api/http': { request: () => { throw new Error('提示规则不得调用网络') } },
  '@/utils/image-upload': { compressImageForUpload: () => { throw new Error('提示规则不得上传') } },
})
const promptBase = { status: 'processing', unreadForClient: 0, unreadForStaff: 1 } as any
const ordinaryPrompt = feedbackRuntime.buildClientFeedbackNextStepPrompt(promptBase)
assert.match(ordinaryPrompt.nextStep, /无需重复提交.*保持消息畅通/, '普通反馈保留原指导')
assert.match(feedbackRuntime.buildClientFeedbackReplyHint(promptBase), /不需要重新新建反馈/, '普通反馈补充说明保持原文')
for (const status of ['pending', 'processing', 'resolved', 'closed']) {
  const getPrompt = (effectiveStatus: string) => feedbackRuntime.buildClientFeedbackNextStepPrompt({ ...promptBase, status, restock: { effectiveStatus } })
  assert.match(getPrompt('expired').nextStep, /重新申请补货/, '过期指导不受聊天状态覆盖')
  assert.match(getPrompt('cancelled').nextStep, /重新申请补货/, '撤回需求按业务终态说明')
  assert.match(getPrompt('restocked').nextStep, /返回商城.*现有流程下单/, '已补货仍需正常下单')
  for (const effectiveStatus of ['expired', 'cancelled', 'restocked']) assert.doesNotMatch(getPrompt(effectiveStatus).nextStep, /无需重复|保持消息/)
  for (const effectiveStatus of ['expired', 'cancelled']) assert.match(feedbackRuntime.buildClientFeedbackReplyHint({ ...promptBase, status, restock: { effectiveStatus } }), /当前会话继续交流.*重新申请/)
  assert.match(feedbackRuntime.buildClientFeedbackReplyHint({ ...promptBase, status, restock: { effectiveStatus: 'restocked' } }), /当前会话继续交流.*返回商城.*下单/)
}
assert.match(feedbackRuntime.buildClientFeedbackNextStepPrompt({ ...promptBase, restock: { effectiveStatus: 'accepted' } }).stageLabel, /已受理/)
const analyticsRuntime = evaluate('src/views/dashboard/composables/useDashboardAnalytics.ts', {
  vue: vueRuntime, dayjs,
  '@/api/modules/dashboard': {
    getDashboardAnalytics: async () => ({ trend: [], topProducts: [], topCustomers: [], range: { startDate: '2026-10-01', endDate: '2026-10-26', granularity: 'day' } }),
    getDashboardRestockRanking: async (range: [string, string] | null) => {
      rankingCalls.push(range ? Array.from(range) as [string, string] : null)
      return { range: { startDate: range?.[0] ?? '2026-10-01', endDate: range?.[1] ?? '2026-10-26', isDefault: !range }, list: [{ productId: 'p1', productName: '补货商品', productCode: 'p1', requestCount: currentRequestCount }], serverNow: '2026-10-26T00:00:00Z' }
    },
  },
  '@/composables/useStableRequest': stableRequestRuntime,
  '@/utils/error': { extractErrorMessage: (error: unknown) => String(error) },
  '@/utils/app-alert': { showAppError: (message: string) => { throw new Error(message) } },
})
const analytics = analyticsRuntime.useDashboardAnalytics()
const settleRequests = () => new Promise<void>((resolve) => setImmediate(resolve))
analytics.ensureAnalyticsReady()
await settleRequests()
assert.equal(rankingCalls.length, 1)
assert.equal(analytics.restockResult.value.list[0].requestCount, 1)
currentRequestCount = 2
analytics.handleSearch()
await settleRequests()
assert.equal(rankingCalls.length, 2, '同默认区间点击查询统计也必须请求最新补货排行')
assert.equal(analytics.restockResult.value.list[0].requestCount, 2)
analytics.draftFilter.rangeValue = ['2026-10-01', '2026-10-26']
analytics.draftFilter.orderType = 'department'
analytics.handleSearch()
await settleRequests()
assert.deepEqual(rankingCalls[2], ['2026-10-01', '2026-10-26'])
analytics.handleRankOptionsChange({ topN: 20, productId: 'outbound-only' })
await settleRequests()
assert.equal(rankingCalls.length, 3, '出库榜维度不触发补货请求')
for (const callback of deactivationCallbacks) callback()
currentRequestCount = 4
analytics.ensureAnalyticsReady()
await settleRequests()
assert.equal(rankingCalls.length, 4, '缓存页返回即使日期未变也重新加载补货排行')
assert.deepEqual(rankingCalls[3], ['2026-10-01', '2026-10-26'])
assert.equal(analytics.restockResult.value.list[0].requestCount, 4, '返回工作台展示离开期间新增需求')
currentRequestCount = 5
analytics.handleSearch()
await settleRequests()
assert.equal(rankingCalls.length, 5, '相同自定义区间再次查询不能被签名缓存跳过')
assert.equal(analytics.restockResult.value.list[0].requestCount, 5)
analytics.handleReset()
await settleRequests()
assert.equal(rankingCalls.length, 6)
assert.equal(rankingCalls[5], null, '重置统计条件也应恢复本月最新补货榜')

const vueFiles = [
  'src/views/client/ClientMallView.vue', 'src/views/client/ClientFeedbackView.vue', 'src/views/client/ClientFeedbackCreateView.vue', 'src/views/client/ClientFeedbackDetailView.vue',
  'src/views/client/components/ClientRestockButton.vue', 'src/views/client/components/ClientRestockForm.vue', 'src/views/client/components/RestockRequestSummary.vue',
  'src/views/system/CustomerServiceWorkbenchView.vue', 'src/views/dashboard/DashboardView.vue', 'src/views/dashboard/components/RestockRankingCard.vue',
]
for (const filename of vueFiles) {
  const source = readFileSync(filename, 'utf8')
  const parsed = parse(source, { filename })
  assert.deepEqual(parsed.errors, [], `${filename} SFC 结构必须合法`)
  const script = compileScript(parsed.descriptor, { id: filename })
  const template = compileTemplate({ source: parsed.descriptor.template!.content, filename, id: filename, compilerOptions: { bindingMetadata: script.bindings, expressionPlugins: ['typescript'] } })
  assert.deepEqual(template.errors, [], `${filename} 模板必须合法`)
}
const read = (path: string) => readFileSync(path, 'utf8')
const mall = read('src/views/client/ClientMallView.vue')
assert.equal((mall.match(/<ClientRestockButton :product=/g) ?? []).length, 4, '四套卡片均有补货按钮')
assert.match(mall, /itemHeight: 98/, '虚拟列表高度契约保留')
assert.match(mall, /ClientRestockButton v-if="detailProduct"/, '商品详情覆盖缺货入口')
const form = read('src/views/client/components/ClientRestockForm.vue')
assert.match(form, /const payload = pendingSubmission.value/, '结果未知的重试保留原始请求载荷')
assert.match(form, /clientRequestId: crypto.randomUUID\(\)/, '新意图生成请求键')
const service = read('src/views/system/CustomerServiceWorkbenchView.vue')
assert.match(service, /issueType: searchForm.issueType/, '类型筛选发送到服务端')
assert.match(service, /dateRange: searchForm.dateRange/, '日期筛选发送到服务端')
assert.match(service, /restock: summaryRecord.restock/, 'SSE 摘要合并保留补货字段')
assert.match(service, /syncRestockRouteQuery/, '缓存页响应下钻 query')
const dashboard = read('src/api/modules/dashboard.ts')
const restockEndpoint = dashboard.slice(dashboard.indexOf('export const getDashboardRestockRanking'), dashboard.indexOf('export interface DashboardStats'))
assert.doesNotMatch(restockEndpoint, /orderType|productSpecMode|topN/, '补货排行不能继承出库维度')
assert.match(read('src/views/dashboard/components/RestockRankingCard.vue'), /customer_service:view/, '下钻受客服查看权限门禁约束')

// 执行真实Web API事件映射与详情回调/撤回后HTTP重拉；覆盖SQLite数字ID和MySQL字符串ID。
const detailSource = parse(read('src/views/client/ClientFeedbackDetailView.vue')).descriptor.scriptSetup!.content
const detailAst = ts.createSourceFile('ClientFeedbackDetailView.ts', detailSource, ts.ScriptTarget.Latest, true)
const detailFunction = (name: string, globals: Record<string, unknown>, property = false, ast = detailAst) => {
  const matches: string[] = []
  const visit = (node: ts.Node) => {
    if ((property ? ts.isPropertyAssignment(node) : ts.isVariableDeclaration(node)) && (node as ts.VariableDeclaration).name.getText(ast) === name) {
      const initializer = (node as ts.VariableDeclaration).initializer
      if (initializer) matches.push(initializer.getText(ast))
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.equal(matches.length, 1, `详情真实函数${name}必须唯一`)
  const compiled = ts.transpileModule(`exports.callback = (${matches[0]});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const exports: Record<string, any> = {}
  vm.runInNewContext(compiled, { exports, ...globals })
  return exports.callback
}
const wireSummary: any = {
  id: 3, clientUserId: 2, assignedUserId: 1, assignedUsername: 'operator', assignedDisplayName: '客服', conversationNo: 'F3', subject: '补货',
  status: 'open', priority: 'normal', clientAccount: '测试账号', clientUsername: '测试客户', clientAccountType: 'personal',
  fields: { issueType: 'restock', category: 'product', actualResult: '缺货', expectedResult: '补货', tags: [], sourceLabel: 'client' },
  unreadForClientCount: 0, unreadForServiceCount: 1, lastMessageSenderType: 'client', lastMessagePreview: '',
  createdAt: '2026-10-27T00:00:00Z', updatedAt: '2026-10-27T00:00:00Z', lastMessageAt: '2026-10-27T00:00:00Z',
  restock: { ...restock, effectiveStatus: 'requested' }, serverNow: '2026-10-27T00:00:00Z',
}
const wireMessage: any = { id: 8, senderType: 'service', senderName: '客服', content: '公开说明', createdAt: '2026-10-27T00:00:00Z', attachments: [{ id: 9 }, { id: null }, {}] }
const apiCalls: string[] = []
let eventSource: TestEventSource | undefined
class TestEventSource {
  listeners = new Map<string, (event: { data: string }) => void>()
  onerror: (() => void) | null = null
  constructor(_url: string, options: { withCredentials: boolean }) { assert.equal(options.withCredentials, true); eventSource = this }
  addEventListener(name: string, callback: (event: { data: string }) => void) { this.listeners.set(name, callback) }
  emit(payload: unknown) { this.listeners.get('conversation')!({ data: JSON.stringify(payload) }) }
  close() { this.listeners.clear() }
}
const streamApi = evaluate('src/api/modules/customer-service-feedback.ts', {
  '@/api/http': { request: async (config: any) => {
    apiCalls.push(`${config.method} ${config.url}`)
    if (config.url === '/customer-service/assignees') return [{ id: 1, username: 'operator' }]
    if (config.method === 'PATCH') { wireSummary.status = 'closed'; wireSummary.restock.effectiveStatus = 'cancelled'; return { changed: true } }
    return structuredClone({ conversation: wireSummary, messages: [wireMessage], internalRemark: { updatedByUserId: 1 } })
  } }, '@/utils/image-upload': {},
}, { window: { location: { origin: 'https://fixture.invalid' } }, EventSource: TestEventSource, URL })
const detailConversation = vue.ref(await streamApi.getClientFeedbackConversation('3'))
assert.equal(detailConversation.value.id, '3')
assert.equal(detailConversation.value.clientUserId, '2')
assert.equal(detailConversation.value.assigneeUserId, '1')
assert.equal(detailConversation.value.messages[0].id, '8')
assert.equal(detailConversation.value.messages[0].attachments[0].id, '9')
assert.equal(detailConversation.value.messages[0].attachments[1].id, null)
assert.equal(detailConversation.value.messages[0].attachments[2].id, undefined)
assert.equal((await streamApi.listSupportAssignableUsers())[0].id, '1')
const serviceDetail = await streamApi.getSupportFeedbackConversation('3')
assert.equal(serviceDetail.internalRemark.updatedByUserId, '1')
for (const absent of [undefined, null]) {
  wireSummary.assignedUserId = absent
  assert.equal((await streamApi.getClientFeedbackConversation('3')).assigneeUserId, null)
}
wireSummary.assignedUserId = 1
const reconnectTip = vue.ref('')
const currentConversationId = vue.ref('3')
const loading = vue.ref(false), detailLoading = vue.ref(false)
const loadDetail = detailFunction('loadConversationDetail', {
  conversation: detailConversation, currentConversationId, detailRequest: stableRequestRuntime.useStableRequest(), loading, detailLoading,
  getClientFeedbackConversation: streamApi.getClientFeedbackConversation, captureDetailUiSnapshot: () => null, restoreDetailUiSnapshot: async () => undefined,
  markFreshMessageIds: () => undefined, satisfactionComment: vue.ref(''), selectedSatisfactionLevel: vue.ref('satisfied'), satisfactionDialogVisible: vue.ref(false),
  showAppWarning: (text: string) => assert.fail(text), router: { replace: () => assert.fail('不得错误离开当前详情') },
})
const withdraw = detailFunction('handleWithdrawConversation', {
  conversation: detailConversation, canWithdrawConversation: vue.ref(true), withdrawingConversation: vue.ref(false), ElMessageBox: { confirm: async () => undefined },
  withdrawClientFeedbackConversation: streamApi.withdrawClientFeedbackConversation, loadConversationDetail: loadDetail, reconnectTip,
  showAppSuccess: () => undefined, showAppWarning: (text: string) => assert.fail(text), showAppError: (text: string) => assert.fail(text),
  showCriticalErrorDialog: (error: unknown) => { throw error },
})
await withdraw()
assert.equal(eventSource, undefined, '撤回HTTP同步不得依赖SSE已连接')
assert.equal(detailConversation.value.restock.effectiveStatus, 'cancelled', '真实撤回处理函数必须权威替换restock')
assert.equal(detailConversation.value.status, 'closed')
assert.ok(apiCalls.includes('PATCH /client-feedback/conversations/3/withdraw'))
assert.equal(apiCalls.at(-1), 'GET /client-feedback/conversations/3')
const refreshedIds: string[] = []
const realOnConversation = detailFunction('onConversation', {
  isRealtimeEligible: () => true, currentConversationId, reconnectTip,
  refreshAuthoritativeConversationDetail: async (id: string) => { refreshedIds.push(id) },
  showAppError: (text: string) => assert.fail(text), extractErrorMessage: (error: unknown) => String(error),
}, true)
const mappedEvents: any[] = []
const stream = streamApi.openFeedbackRealtimeStream('client', { onConversation: (payload: any) => { mappedEvents.push(payload); return realOnConversation(payload) } })
for (const id of [3, '3', 4, '4']) {
  eventSource!.emit({ eventType: 'message_created', conversationId: id, clientUserId: 2, conversation: { ...wireSummary, id }, message: wireMessage })
  await settleRequests()
}
assert.deepEqual(refreshedIds, ['3', '3'], '数字/字符串当前会话均刷新，无关会话不得触发详情请求')
assert.ok(mappedEvents.every((payload) => typeof payload.conversationId === 'string' && typeof payload.clientUserId === 'string' && typeof payload.conversation.id === 'string'))
assert.match(reconnectTip.value, /新进展.*自动刷新/)
stream.close()

// 执行真实工作台owner computed和操作回调：Store数字/字符串两种ID均与API字符串ID一致。
const workbenchScript = parse(read('src/views/system/CustomerServiceWorkbenchView.vue')).descriptor.scriptSetup!.content
const workbenchAst = ts.createSourceFile('CustomerServiceWorkbenchView.ts', workbenchScript, ts.ScriptTarget.Latest, true)
const workbenchValue = (name: string, globals: Record<string, unknown>) => detailFunction(name, { computed: vue.computed, ...globals }, false, workbenchAst)
for (const authId of [1, '1']) {
  const authStore = vue.reactive({ currentUser: { id: authId } })
  const currentUserId = workbenchValue('currentUserId', { authStore })
  const selectedConversation = vue.ref({ id: '3', assigneeUserId: '1' as string | null, assigneeName: '管理员', restock: { effectiveStatus: 'accepted' } })
  const owned = workbenchValue('isSelectedConversationOwnedByCurrentUser', { currentUserId, selectedConversation })
  assert.equal(currentUserId.value, '1')
  assert.equal(owned.value, true, `auth ${typeof authId}应识别为当前负责人`)
  assert.equal(workbenchValue('getAssigneeTagLabel', { currentUserId })(selectedConversation.value), '我负责')
  assert.equal(workbenchValue('getAssigneeTagType', { currentUserId })(selectedConversation.value), 'success')
  assert.equal(workbenchValue('takeOverButtonText', { selectedConversation, isSelectedConversationOwnedByCurrentUser: owned }).value, '当前由我负责')
  assert.match(workbenchValue('assignmentActionTip', { selectedConversation, isSelectedConversationOwnedByCurrentUser: owned }).value, /由你负责/)
  const assigneeOptions = vue.ref<any[]>([])
  const loadAssignable = workbenchValue('loadAssignableUsers', { assigneeOptions, assigneeLoading: vue.ref(false), assigneeRequest: stableRequestRuntime.useStableRequest(), listSupportAssignableUsers: async () => [{ id: 1 }, { id: '2' }] })
  await loadAssignable()
  assert.deepEqual(assigneeOptions.value.map((item) => item.id), ['1', '2'])
  const candidates = workbenchValue('transferAssigneeOptions', { assigneeOptions, selectedConversation })
  assert.deepEqual(candidates.value.map((item: any) => item.id), ['2'], '候选规范化后排除当前负责人')
  const calls: Array<[string, string]> = []
  const bindings = { selectedConversation, currentUserId, assigneeUpdating: vue.ref(false), reconnectTip: vue.ref(''),
    updateSupportConversationAssignee: async (conversationId: string, ownerId: string) => { calls.push([conversationId, ownerId]) },
    loadConversations: async () => undefined, showAppSuccess: () => undefined, showAppInfo: () => undefined,
    showAppWarning: (message: string) => assert.fail(message), showAppError: (message: string) => assert.fail(message), showCriticalErrorDialog: (error: unknown) => { throw error },
  }
  const takeOver = workbenchValue('handleTakeOver', bindings)
  await takeOver(); assert.equal(calls.length, 0, '本人负责不能多次转派')
  selectedConversation.value.assigneeUserId = '2'
  assert.equal(owned.value, false)
  await takeOver(); assert.deepEqual(calls.at(-1), ['3', '1'], '转派自己请求ID必须为字符串')
  const transfer = workbenchValue('handleTransferConversation', { ...bindings, transferAssigneeUserId: vue.ref('2') })
  await transfer(); assert.deepEqual(calls.at(-1), ['3', '2'])
  selectedConversation.value.assigneeUserId = '1'
  let replyCount = 0
  const shortcut = workbenchValue('handleReplyShortcut', { replying: vue.ref(false), isSelectedConversationOwnedByCurrentUser: owned, handleReply: async () => { replyCount += 1 } })
  shortcut({ preventDefault() {} }); assert.equal(replyCount, 1)
  const restockCalls: Array<[string, string]> = []
  const handleRestock = workbenchValue('handleRestockStatus', { ...bindings, restockUpdating: vue.ref(false), isSelectedConversationOwnedByCurrentUser: owned, ensurePermission: () => true,
    updateSupportRestockRequest: async (id: string, input: { status: string }) => { restockCalls.push([id, input.status]) }, extractErrorMessage: String })
  await handleRestock('restocked'); assert.deepEqual(restockCalls, [['3', 'restocked']])
  selectedConversation.value.assigneeUserId = '2'
  shortcut({ preventDefault() {} }); assert.equal(replyCount, 1, '非本人不能通过快捷键回复')
  await handleRestock('restocked'); assert.equal(restockCalls.length, 1, '非本人不能调用补货处理API')
  selectedConversation.value.assigneeUserId = null
  assert.equal(owned.value, false)
  const remarks: string[] = []
  await workbenchValue('handleSaveInternalRemark', { ...bindings, remarkSaving: vue.ref(false), issueForm: { internalRemark: '内部草稿' }, hasUnsavedInternalRemarkDraft: vue.ref(true),
    updateFeedbackInternalRemark: async (id: string) => { remarks.push(id) }, loadConversationDetail: async (id: string) => { assert.equal(id, '3') } })()
  assert.deepEqual(remarks, ['3'], '内部备注沿用其原权限与可空负责人规则，使用规范化会话ID')
  authStore.currentUser.id = 2
  assert.equal(currentUserId.value, '2', '规范化computed仍响应真实账号切换')
}
console.log('补货前端纯规则、工作台刷新行为、Vue 模板与跨页契约通过')
