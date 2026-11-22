/** 使用实际页面方法、Vue 同步 watch 和可控请求验证回复目标及迟到 UI 结果，不启动业务服务。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import { effectScope, nextTick, reactive, ref, watch } from 'vue'

const text = fs.readFileSync(new URL('../src/views/system/CustomerServiceWorkbenchView.vue', import.meta.url), 'utf8').split('<script setup lang="ts">')[1].split('</script>')[0]
const ast = ts.createSourceFile('workbench.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const declarations = new Map()
for (const statement of ast.statements) if (ts.isVariableStatement(statement)) {
  for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) {
    declarations.set(declaration.name.text, statement.getText(ast))
  }
}
const methods = ['getScrollbarWrap', 'captureScrollbarTop', 'restoreScrollbarTop', 'runWithSuspendedDraftTracking',
  'captureWorkbenchDetailUiSnapshot', 'restoreWorkbenchDetailUiSnapshot', 'syncVisibleConversationSelection',
  'loadConversationDetail', 'loadConversations', 'handleSelectConversation', 'handleReply',
  'loadPresence', 'refreshWorkbenchData', 'readFirstSnapshot', 'connectRealtime', 'disposeRealtimeConnection']
const generations = ['lifecycleToken', 'conversationGeneration', 'replyOperationGeneration', 'replyDraftGeneration', 'detailUiGeneration',
  'readyRealtimeAttempt', 'snapshotStartedForAttempt', 'firstSnapshotStarted', 'firstSnapshotTimer', 'realtimeAttempt',
  'realtimeConnection', 'reconnectTimer', 'pendingRefresh', 'refreshInFlight']
const watches = ast.statements.filter(statement => ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)
  && statement.expression.expression.getText(ast) === 'watch').map(statement => statement.getText(ast))
  .filter(source => /^watch\((?:selectedConversationId|replyDraft|\[selectedQuickReplyKey)/.test(source)
    || source.includes('issueForm.title') || source.includes('issueForm.internalRemark'))
const extracted = [...generations.map(name => declarations.get(name) ?? `let ${name} = 0`),
  ...methods.map(name => { assert.ok(declarations.has(name), `页面方法缺失：${name}`); return declarations.get(name) }), ...watches].join('\n')
const deferred = () => {
  let resolve, reject
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await nextTick() }
const record = id => ({ id, restock: null, messages: [], title: id, fields: { title: id, status: 'open', priority: 'medium' } })

function setup() {
  const scope = effectScope(), issue = deferred(), append = deferred(), calls = { issues: [], messages: [], errors: [], success: [], scroll: 0 }
  const issueForm = reactive({ title: 'A原标题', status: 'open', priority: 'medium', issueType: 'general', category: '',
    orderRef: '', expectedResult: '', actualResult: '', reproductionSteps: '', contactPreference: '', tagText: '原标签', internalRemark: '' })
  const state = { selectedConversationId: ref('A'), selectedConversation: ref(record('A')), replyDraft: ref('A原正文'),
    conversations: ref([record('A'), record('B')]), replying: ref(false), loading: ref(false), detailLoading: ref(false),
    realtimeState: ref('offline'), presence: ref(null),
    draftTrackingSuspended: ref(false), hasUnsavedReplyDraft: ref(true), reconnectTip: ref('原提示'),
    activeDetailTab: ref('conversation'), selectedQuickReplyKey: ref(''), transferAssigneeUserId: ref(''),
    conversationListPanelRef: ref(null), conversationMessageScrollbarRef: ref(null), issueFormScrollbarRef: ref(null), issueForm,
    searchForm: reactive({ keyword: '', status: '', priority: '', assigneeScope: 'all', issueType: '', restockStatus: '', productId: '', dateRange: null }) }
  const api = {
    issue: async (id, input) => { calls.issues.push({ id, input: structuredClone(input) }); await issue.promise },
    append: async (id, input) => { calls.messages.push({ id, input: structuredClone(input) }); await append.promise },
    list: async () => [record('A'), record('B')], detail: async id => record(id),
    presence: async () => ({ availability: { isOnline: false }, session: { currentConversationEventId: 0 } }),
  }
  const streams = [], timers = new Map()
  const channel = () => {
    let version = 0
    return { runLatest: async options => {
      const current = ++version
      try { const value = await options.executor(); if (current === version) await options.onSuccess?.(value) }
      finally { if (current === version) options.onFinally?.() }
    } }
  }
  const helpers = { ...state, nextTick, watch, normalizeSubmitText: value => value.trim(), parseTagText: value => value.split(',').map(v => v.trim()).filter(Boolean),
    updateFeedbackIssue: (...args) => api.issue(...args), appendStaffFeedbackMessage: (...args) => api.append(...args),
    listSupportFeedbackConversations: (...args) => api.list(...args), getSupportFeedbackConversation: (...args) => api.detail(...args),
    getQuickViewFilteredConversations: () => state.conversations.value,
    isWorkbenchResident: ref(true),
    presenceRequest: channel(), getCustomerServicePresence: () => api.presence(),
    handleRealtimeConversation: () => {},
    openFeedbackRealtimeStream: (_realm, handlers) => {
      streams.push(handlers)
      return { close: () => {} }
    },
    setTimeout: (callback) => {
      const id = Symbol()
      timers.set(id, callback)
      return id
    },
    clearTimeout: (id) => timers.delete(id),
    listRequest: channel(), detailRequest: channel(), markFreshConversationIds: () => {}, markFreshMessageIds: () => {},
    syncLocalDraftFlags: () => { if (!state.draftTrackingSuspended.value) state.hasUnsavedReplyDraft.value = Boolean(state.replyDraft.value.trim()) },
    syncIssueForm: value => {
      state.draftTrackingSuspended.value = true
      try { Object.assign(issueForm, value?.fields ?? { title: '', status: 'open', priority: 'medium' }) }
      finally { state.draftTrackingSuspended.value = false }
    },
    showAppWarning: () => {}, showAppSuccess: message => calls.success.push(message),
    showCriticalErrorDialog: error => calls.errors.push(error), scrollConversationToBottom: async () => { calls.scroll++ },
  }
  const code = `const {${Object.keys(helpers).join(',')}} = h;\n${extracted}\nreturn {handleReply,handleSelectConversation,loadConversations,loadPresence,connectRealtime,readFirstSnapshot};`
  const javascript = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  const controller = scope.run(() => new Function('h', javascript)(helpers))
  return { ...state, ...controller, api, issue, append, calls, streams, timers, stop: () => scope.stop() }
}

test('首次 SSE 快速就绪只读一份快照，断线重新就绪必须补新快照', async () => {
  const h = setup()
  let reads = 0
  h.api.list = async () => { reads += 1; return [record('A')] }
  try {
    h.connectRealtime(0)
    h.streams[0].onOpen({})
    h.readFirstSnapshot(0)
    h.streams[0].onOpen({})
    await flush()
    assert.equal(reads, 1)
    h.streams[0].onError()
    const [reconnect] = h.timers.values()
    reconnect()
    h.streams[1].onOpen({})
    await flush()
    assert.equal(reads, 2, '短暂断线也必须错开旧快照的时间边界')
  } finally { h.stop() }
})

test('SSE 慢于已开始的快照时排队补读，覆盖无回放区间', async () => {
  const h = setup(), initial = deferred()
  let reads = 0
  h.api.list = async () => ++reads === 1 ? initial.promise : [record('B')]
  try {
    h.connectRealtime(0)
    h.readFirstSnapshot(0)
    h.streams[0].onOpen({})
    assert.equal(reads, 1, '前次快照仍在途时避免并发补刷')
    initial.resolve([record('A')])
    await flush()
    assert.equal(reads, 2)
    assert.equal(h.conversations.value[0].id, 'B')
  } finally { h.stop() }
})

test('握手前读到离线的 presence 响应不能覆盖 SSE 已建立状态', async () => {
  const h = setup(), request = deferred()
  try {
    h.connectRealtime(0)
    h.api.presence = () => request.promise
    const pending = h.loadPresence()
    h.streams[0].onOpen({ availability: { isOnline: true }, session: { currentConversationEventId: 10 } })
    request.resolve({ availability: { isOnline: false }, session: { currentConversationEventId: 9 } })
    await pending
    assert.equal(h.realtimeState.value, 'online')
    assert.equal(h.presence.value.availability.isOnline, true)
    assert.equal(h.presence.value.session.currentConversationEventId, 10)
    h.api.presence = async () => ({ availability: { isOnline: true }, session: { currentConversationEventId: 11 } })
    await h.loadPresence()
    assert.equal(h.presence.value.session.currentConversationEventId, 11, '同一连接代次内的独立请求仍可补充会话状态')
  } finally { h.stop() }
})

test('断流前读到在线的 presence 响应不能重新显示在线', async () => {
  const h = setup(), request = deferred()
  try {
    h.connectRealtime(0)
    h.streams[0].onOpen({ availability: { isOnline: true }, session: { currentConversationEventId: 10 } })
    h.api.presence = () => request.promise
    const pending = h.loadPresence()
    h.streams[0].onError()
    request.resolve({ availability: { isOnline: true }, session: { currentConversationEventId: 11 } })
    await pending
    assert.equal(h.realtimeState.value, 'offline')
    assert.equal(h.presence.value.session.currentConversationEventId, 10, '断流前的旧会话信息不得回写')
  } finally { h.stop() }
})

test('手动切B后原A仍合法发送，首个await前的ID/正文/工单字段不串单，不清空B新草稿', async () => {
  const h = setup()
  try {
    const send = h.handleReply()
    await h.handleSelectConversation('B')
    h.replyDraft.value = 'B新草稿'; h.issueForm.title = 'B新标题'; h.issueForm.tagText = 'B标签'
    h.issue.resolve(); await flush()
    assert.deepEqual(h.calls.issues, [{ id: 'A', input: { title: 'A原标题', status: 'open', priority: 'medium', issueType: 'general', category: '', orderRef: '', expectedResult: '', actualResult: '', reproductionSteps: '', contactPreference: '', tags: ['原标签'] } }])
    assert.deepEqual(h.calls.messages, [{ id: 'A', input: { body: 'A原正文' } }])
    h.append.resolve(); await send
    assert.equal(h.selectedConversationId.value, 'B'); assert.equal(h.replyDraft.value, 'B新草稿'); assert.equal(h.issueForm.title, 'B新标题')
    assert.equal(h.reconnectTip.value, '原提示')
  } finally { h.stop() }
})

test('筛选/SSE的实际队列刷新切B，不改变在途原A发送目标或B草稿', async () => {
  const h = setup()
  try {
    const send = h.handleReply()
    h.api.list = async () => [record('B')]
    await h.loadConversations({ preserveUiState: true })
    assert.equal(h.selectedConversationId.value, 'B')
    h.replyDraft.value = 'B刷新后新草稿'
    h.issue.resolve(); await flush(); h.append.resolve(); await send
    assert.equal(h.calls.messages[0].id, 'A'); assert.equal(h.replyDraft.value, 'B刷新后新草稿')
  } finally { h.stop() }
})

test('同一tick内A→B→A也形成新会话代次，旧发送不清空同值的新会话草稿', async () => {
  const h = setup()
  try {
    const send = h.handleReply()
    h.selectedConversationId.value = 'B'; h.selectedConversationId.value = 'A'
    h.issue.resolve(); await flush(); h.append.resolve(); await send
    assert.equal(h.calls.messages[0].id, 'A'); assert.equal(h.replyDraft.value, 'A原正文')
  } finally { h.stop() }
})

test('同A在途新增草稿或编辑工单，旧成功不清空或回刷覆盖新输入', async () => {
  const h = setup()
  try {
    const send = h.handleReply(); h.replyDraft.value = 'A后续新草稿'; h.issueForm.title = '后续编辑'
    h.issue.resolve(); await flush(); h.append.resolve(); await send
    assert.equal(h.replyDraft.value, 'A后续新草稿'); assert.equal(h.issueForm.title, '后续编辑')
    assert.equal(h.calls.messages[0].input.body, 'A原正文')
  } finally { h.stop() }
})

for (const phase of ['list', 'detail']) test(`成功后的${phase}刷新迟到，不恢复旧快照覆盖新草稿`, async () => {
  const h = setup(), refresh = deferred()
  try {
    h.api[phase] = async () => refresh.promise
    const send = h.handleReply(); h.issue.resolve(); h.append.resolve(); await flush()
    assert.equal(h.replyDraft.value, '', '发送成功后原草稿应已清空')
    h.replyDraft.value = '刷新在途新草稿'; h.issueForm.title = '刷新在途新编辑'
    refresh.resolve(phase === 'list' ? [record('A')] : record('A')); await send
    assert.equal(h.replyDraft.value, '刷新在途新草稿'); assert.equal(h.issueForm.title, '刷新在途新编辑')
  } finally { h.stop() }
})

for (const phase of ['issue', 'append']) test(`${phase}失败保持当前草稿、解除发送态且不误写下一步`, async () => {
  const h = setup()
  try {
    const send = h.handleReply()
    if (phase === 'issue') h.issue.reject(new Error('fixture failure'))
    else { h.issue.resolve(); await flush(); h.append.reject(new Error('fixture failure')) }
    await send
    assert.equal(h.replyDraft.value, 'A原正文'); assert.equal(h.replying.value, false); assert.equal(h.calls.errors.length, 1)
    if (phase === 'issue') assert.equal(h.calls.messages.length, 0)
  } finally { h.stop() }
})

test('发送中重复快捷键不会启动第二个操作，补货会话继续跳过工单写入', async () => {
  const h = setup()
  try {
    h.selectedConversation.value.restock = { id: 'restock-fixture' }
    const first = h.handleReply(); await h.handleReply()
    assert.equal(h.calls.issues.length, 0); assert.equal(h.calls.messages.length, 1)
    h.append.resolve(); await first; assert.equal(h.replying.value, false)
  } finally { h.stop() }
})
