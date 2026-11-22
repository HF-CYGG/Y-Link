/** 执行实际SFC处理器：先保留救援能力再冻结，取消目标在首次await前锁定，不把复制完成当成恢复营业。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import { ref } from 'vue'
const source = fs.readFileSync(new URL('../src/views/system/DatabaseMigrationView.vue', import.meta.url), 'utf8').split('<script setup lang="ts">')[1].split('</script>')[0]
const ast = ts.createSourceFile('migration.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const extract = (tree, names) => {
  const declarations = tree.statements.filter(ts.isVariableStatement).flatMap(statement => statement.declarationList.declarations)
    .filter(node => names.includes(node.name.getText(tree)))
  assert.equal(declarations.length, names.length)
  return ts.transpileModule(declarations.map(node => 'const ' + node.getText(tree)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
}
const handlerNames = ['promptMigrationPassword', 'showMigrationActionError', 'handleRunTask', 'handleRollbackToSqlite', 'handleCreateAutomaticTask']
const executable = extract(ast, handlerNames)
const task = { id: 'A', mode: 'manual', readState: 'healthy', status: 'succeeded', allowedActions: ['manual_switch', 'cancel'] }
const currentPassword = 'fixture-current-password'

test('前端allowedActions类型精确包含后端自动恢复与手动switch/cancel动作', () => {
  const api = ts.createSourceFile('data-maintenance.ts', fs.readFileSync(new URL('../src/api/modules/data-maintenance.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  const alias = api.statements.find(node => ts.isTypeAliasDeclaration(node) && node.name.text === 'DatabaseMigrationAllowedAction')
  assert.ok(alias && ts.isUnionTypeNode(alias.type))
  assert.deepEqual(alias.type.types.map(type => { assert.ok(ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)); return type.literal.text }).sort(),
    ['prepare_rollback', 'resume_rollback', 'manual_switch', 'cancel'].sort())
})

function setup({ storageFailure = false, prompt, passwordPrompt, protocol = 'https:', credentialError, runError, precheck = { canProceed: true, issues: [] } } = {}) {
  const calls = [], selectedTask = ref(task), runtimeState = ref({ activeOverride: null })
  const dependencies = {
    ensurePermission: () => true, ElMessageBox: { prompt: async (message, title, options) => {
      if (options.inputType === 'password') {
        calls.push(['password', message, title]); assert.equal(options.inputValidator(' '), false)
        return passwordPrompt ? passwordPrompt() : { value: currentPassword }
      }
      return prompt ? prompt() : { value: '隔离取消' }
    } },
    showAppWarning: value => calls.push(['warning', value]), showAppSuccess: value => calls.push(['success', value]), showCriticalErrorDialog: async error => { calls.push(['error', error]) },
    taskRunningId: ref(''), currentTabRescueCredentialTaskId: ref(''), selectedTaskId: ref(''), rollbackLoading: ref(false), runtimeState, selectedTask,
    issueDatabaseMigrationRescueCredential: async (id, password) => { calls.push(['credential', id, password]); if (credentialError) throw credentialError; return { taskId: id, credential: 'fixture-only' } },
    storeRescueCredential: (_storage, credential) => { calls.push(['store', credential.taskId]); if (storageFailure) throw new Error('storage unavailable') },
    window: { location: { protocol }, sessionStorage: {} }, runSQLiteToMySqlMigrationTask: async (id, password) => { calls.push(['run', id, password]); if (runError) throw runError; return task },
    upsertTaskRecord: () => {}, enterStepFlow: () => {}, loadOverview: async () => {}, DATABASE_MIGRATION_RESTART_EFFECT_TEXT: '重启验收',
    getSQLiteToMySqlMigrationTaskDetail: async id => ({ ...task, id, status: 'rolled_back' }),
    DATABASE_MIGRATION_ROLLBACK_REASON_DEFAULT: '隔离取消', rollbackDatabaseMigrationSwitch: async (body, password) => { calls.push(['cancel', body, password]); return { rollbackMode: 'clear', activeOverride: null } },
    automaticMigrationCompleted: ref(false), connectionTestLoading: ref(false), precheckLoading: ref(false), automaticMigrationBusy: ref(false),
    automaticTaskCreating: ref(false), precheckResult: ref(null), validateTargetForm: () => true,
    buildNormalizedTarget: () => ({ host: 'fixture', port: 3306, database: 'fixture', dbSync: false }), migrationForm: { note: '' },
    testConnection: async () => { calls.push(['precheck']); return precheck },
    createAutomaticSQLiteToMySqlMigrationTask: async (body, password) => { calls.push(['automatic', body, password]); return task },
    startAutomaticTaskPolling: () => {},
  }
  return { ...new Function(...Object.keys(dependencies), executable + `;return {${handlerNames}}`)(...Object.values(dependencies)), calls, selectedTask }
}
test('取得并暂存当前任务救援凭证后才开始冻结；复制完成提示持续只读', async () => {
  const context = setup(); await context.handleRunTask(task)
  assert.deepEqual(context.calls.filter(([kind]) => ['credential', 'store', 'run'].includes(kind)), [['credential', 'A', currentPassword], ['store', 'A'], ['run', 'A', currentPassword]])
  assert.ok(context.calls.some(([kind, message]) => kind === 'success' && message.includes('持续只读')))
})
test('救援凭证无法暂存时不能开始不可恢复的手动冻结', async () => {
  const context = setup({ storageFailure: true }); await context.handleRunTask(task)
  assert.equal(context.calls.some(([kind]) => kind === 'run'), false)
})

test('HTTP保留手动执行并明确本地CLI准备，不请求远程明文凭证', async () => {
  const context = setup({ protocol: 'http:' }); await context.handleRunTask(task)
  assert.equal(context.calls.some(([kind]) => kind === 'credential' || kind === 'store'), false)
  assert.deepEqual(context.calls.find(([kind]) => kind === 'run'), ['run', 'A', currentPassword])
  const confirmation = context.calls.find(([kind]) => kind === 'password')[1]
  assert.match(confirmation, /prepare-manual-credential A/)
  assert.match(confirmation, /HTTP.*不会远程传输明文救援凭证/)
})

test('HTTPS普通403或认证失败不回退为无凭证run；HTTP run认证失败不吞掉', async () => {
  for (const status of [401, 403]) {
    const error = Object.assign(new Error('fixture auth rejected'), { status })
    const secure = setup({ credentialError: error }); await secure.handleRunTask(task)
    assert.equal(secure.calls.some(([kind]) => kind === 'run'), false)
    assert.equal(secure.calls.find(([kind]) => kind === 'error')[1], error)
    const plain = setup({ protocol: 'http:', runError: error }); await plain.handleRunTask(task)
    assert.equal(plain.calls.find(([kind]) => kind === 'error')[1], error)
    assert.equal(plain.calls.some(([kind]) => kind === 'success'), false)
  }
})
test('取消提示期间切换选中任务，仍取消操作开始时的A', async () => {
  let release
  const pending = new Promise(resolve => { release = resolve })
  const context = setup({ prompt: () => pending }), work = context.handleRollbackToSqlite()
  context.selectedTask.value = { ...task, id: 'B' }; release({ value: '取消A' }); await work
  assert.deepEqual(context.calls.find(([kind]) => kind === 'cancel'), ['cancel', { taskId: 'A', reason: '取消A' }, currentPassword])
  assert.ok(context.calls.some(([kind, message]) => kind === 'success' && message.includes('副本切换资格已撤销')))
})

test('自动任务先完成预检，再请求本人密码；取消密码提示不提交任务', async () => {
  const blocked = setup({ precheck: { canProceed: false, issues: [] } })
  await blocked.handleCreateAutomaticTask()
  assert.deepEqual(blocked.calls.map(([kind]) => kind), ['precheck', 'warning'])

  const dismissed = setup({ passwordPrompt: async () => { throw 'cancel' } })
  await dismissed.handleCreateAutomaticTask()
  assert.deepEqual(dismissed.calls.map(([kind]) => kind), ['precheck', 'password'])

  const accepted = setup()
  await accepted.handleCreateAutomaticTask()
  assert.deepEqual(accepted.calls.map(([kind]) => kind), ['precheck', 'password', 'automatic', 'success'])
  assert.deepEqual(accepted.calls[2], ['automatic', { target: { host: 'fixture', port: 3306, database: 'fixture' }, note: undefined }, currentPassword])
})

test('迁移控制 API 只在请求体传本人密码，连接预检只发送连接参数', async () => {
  const api = ts.createSourceFile('data-maintenance.ts', fs.readFileSync(new URL('../src/api/modules/data-maintenance.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  const cases = [
    ['precheckSQLiteToMySqlMigration', 'POST', 'precheck', [{ purpose: 'automatic' }], { purpose: 'automatic' }],
    ['createSQLiteToMySqlMigrationTask', 'POST', 'tasks', [{ note: '手动' }, currentPassword], { note: '手动', currentPassword }],
    ['createAutomaticSQLiteToMySqlMigrationTask', 'POST', 'automatic-tasks', [{ note: '自动' }, currentPassword], { note: '自动', currentPassword }],
    ['runSQLiteToMySqlMigrationTask', 'POST', 'tasks/A/run', ['A', currentPassword], { currentPassword }],
    ['issueDatabaseMigrationRescueCredential', 'POST', 'tasks/A/rescue-credential', ['A', currentPassword], { currentPassword }],
    ['applyDatabaseMigrationSwitch', 'POST', 'switch', [{ taskId: 'A' }, currentPassword], { taskId: 'A', currentPassword }],
    ['rollbackDatabaseMigrationSwitch', 'POST', 'rollback', [{ taskId: 'A' }, currentPassword], { taskId: 'A', currentPassword }],
    ['clearDatabaseMigrationRuntimeOverride', 'DELETE', 'runtime-override', [currentPassword], { currentPassword }],
  ]
  const names = cases.map(([name]) => name)
  const actions = new Function('request', extract(api, names) + `;return {${names}}`)(options => options)
  for (const [name, method, suffix, args, body] of cases) {
    const { url, method: sentMethod, data } = await actions[name](...args)
    assert.equal(url, `/data-maintenance/db-migration/${suffix}`)
    assert.equal(sentMethod, method)
    assert.deepEqual(data, body)
  }
})
