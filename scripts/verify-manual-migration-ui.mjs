/** 执行实际SFC处理器：先保留救援能力再冻结，取消目标在首次await前锁定，不把复制完成当成恢复营业。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import { ref } from 'vue'
const source = fs.readFileSync(new URL('../src/views/system/DatabaseMigrationView.vue', import.meta.url), 'utf8').split('<script setup lang="ts">')[1].split('</script>')[0]
const ast = ts.createSourceFile('migration.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const handlers = ast.statements.filter(ts.isVariableStatement).flatMap(statement => statement.declarationList.declarations)
  .filter(node => ['handleRunTask', 'handleRollbackToSqlite'].includes(node.name.getText(ast)))
const executable = ts.transpileModule(handlers.map(node => 'const ' + node.getText(ast)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const task = { id: 'A', mode: 'manual', readState: 'healthy', status: 'succeeded', allowedActions: ['manual_switch', 'cancel'] }

test('前端allowedActions类型精确包含后端自动恢复与手动switch/cancel动作', () => {
  const api = ts.createSourceFile('data-maintenance.ts', fs.readFileSync(new URL('../src/api/modules/data-maintenance.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  const alias = api.statements.find(node => ts.isTypeAliasDeclaration(node) && node.name.text === 'DatabaseMigrationAllowedAction')
  assert.ok(alias && ts.isUnionTypeNode(alias.type))
  assert.deepEqual(alias.type.types.map(type => { assert.ok(ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)); return type.literal.text }).sort(),
    ['prepare_rollback', 'resume_rollback', 'manual_switch', 'cancel'].sort())
})

function setup({ storageFailure = false, prompt, protocol = 'https:', credentialError, runError } = {}) {
  const calls = [], selectedTask = ref(task), runtimeState = ref({ activeOverride: null })
  const dependencies = {
    ensurePermission: () => true, ElMessageBox: { confirm: async message => { calls.push(['confirm', message]) }, prompt: prompt ?? (async () => ({ value: '隔离取消' })) },
    showAppWarning: value => calls.push(['warning', value]), showAppSuccess: value => calls.push(['success', value]), showCriticalErrorDialog: async error => { calls.push(['error', error]) },
    taskRunningId: ref(''), currentTabRescueCredentialTaskId: ref(''), selectedTaskId: ref(''), rollbackLoading: ref(false), runtimeState, selectedTask,
    issueDatabaseMigrationRescueCredential: async id => { calls.push(['credential', id]); if (credentialError) throw credentialError; return { taskId: id, credential: 'fixture-only' } },
    storeRescueCredential: (_storage, credential) => { calls.push(['store', credential.taskId]); if (storageFailure) throw new Error('storage unavailable') },
    window: { location: { protocol }, sessionStorage: {} }, runSQLiteToMySqlMigrationTask: async id => { calls.push(['run', id]); if (runError) throw runError; return task },
    upsertTaskRecord: () => {}, enterStepFlow: () => {}, loadOverview: async () => {}, DATABASE_MIGRATION_RESTART_EFFECT_TEXT: '重启验收',
    getSQLiteToMySqlMigrationTaskDetail: async id => ({ ...task, id, status: 'rolled_back' }),
    DATABASE_MIGRATION_ROLLBACK_REASON_DEFAULT: '隔离取消', rollbackDatabaseMigrationSwitch: async body => { calls.push(['cancel', body.taskId]); return { rollbackMode: 'clear', activeOverride: null } },
  }
  return { ...new Function(...Object.keys(dependencies), executable + ';return {handleRunTask,handleRollbackToSqlite}')( ...Object.values(dependencies)), calls, selectedTask }
}
test('取得并暂存当前任务救援凭证后才开始冻结；复制完成提示持续只读', async () => {
  const context = setup(); await context.handleRunTask(task)
  assert.deepEqual(context.calls.filter(([kind]) => ['credential', 'store', 'run'].includes(kind)), [['credential', 'A'], ['store', 'A'], ['run', 'A']])
  assert.ok(context.calls.some(([kind, message]) => kind === 'success' && message.includes('持续只读')))
})
test('救援凭证无法暂存时不能开始不可恢复的手动冻结', async () => {
  const context = setup({ storageFailure: true }); await context.handleRunTask(task)
  assert.equal(context.calls.some(([kind]) => kind === 'run'), false)
})

test('HTTP保留手动执行并明确本地CLI准备，不请求远程明文凭证', async () => {
  const context = setup({ protocol: 'http:' }); await context.handleRunTask(task)
  assert.equal(context.calls.some(([kind]) => kind === 'credential' || kind === 'store'), false)
  assert.deepEqual(context.calls.find(([kind]) => kind === 'run'), ['run', 'A'])
  const confirmation = context.calls.find(([kind]) => kind === 'confirm')[1]
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
  assert.deepEqual(context.calls.find(([kind]) => kind === 'cancel'), ['cancel', 'A'])
  assert.ok(context.calls.some(([kind, message]) => kind === 'success' && message.includes('副本切换资格已撤销')))
})
