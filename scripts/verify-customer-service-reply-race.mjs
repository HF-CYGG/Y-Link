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
  'loadConversationDetail', 'loadConversations', 'handleSelectConversation', 'handleReply']
const generations = ['lifecycleToken', 'conversationGeneration', 'replyOperationGeneration', 'replyDraftGeneration', 'detailUiGeneration']
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
    draftTrackingSuspended: ref(false), hasUnsavedReplyDraft: ref(true), reconnectTip: ref('原提示'),
    activeDetailTab: ref('conversation'), selectedQuickReplyKey: ref(''), transferAssigneeUserId: ref(''),
    conversationListPanelRef: ref(null), conversationMessageScrollbarRef: ref(null), issueFormScrollbarRef: ref(null), issueForm,
    searchForm: reactive({ keyword: '', status: '', priority: '', assigneeScope: 'all', issueType: '', restockStatus: '', productId: '', dateRange: null }) }
  const api = {
    issue: async (id, input) => { calls.issues.push({ id, input: structuredClone(input) }); await issue.promise },
    append: async (id, input) => { calls.messages.push({ id, input: structuredClone(input) }); await append.promise },
    list: async () => [record('A'), record('B')], detail: async id => record(id),
  }
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
  const code = `const {${Object.keys(helpers).join(',')}} = h;\n${extracted}\nreturn {handleReply,handleSelectConversation,loadConversations};`
  const javascript = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  const controller = scope.run(() => new Function('h', javascript)(helpers))
  return { ...state, ...controller, api, issue, append, calls, stop: () => scope.stop() }
}

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
