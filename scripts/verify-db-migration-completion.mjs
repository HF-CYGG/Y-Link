/** 文件职责：验证自动迁移完成判定与真实进度组件渲染，防止将切换或重启等待提前显示为完成。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'
import * as vue from 'vue'
import { parse, compileScript } from '@vue/compiler-sfc'
import { renderToString } from '@vue/server-renderer'
import { ElAlert, ElTag, ElButton, ID_INJECTION_KEY } from 'element-plus'

const require = createRequire(import.meta.url)
const componentPath = 'src/views/system/components/DatabaseMigrationAutomaticProgressSection.vue'
const componentSource = fs.readFileSync(componentPath, 'utf8')
assert.ok(componentSource.includes('迁移已完成'), '进度区应显式处理迁移成功终态')
const load = (source) => {
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', code)((name) => name === 'vue' ? vue : require(name), module, module.exports)
  return module.exports
}
const { isAutomaticMigrationCompleted } = load(fs.readFileSync('src/views/system/database-migration-completion.ts', 'utf8'))
const task = { id: 'automatic-demo', mode: 'automatic', status: 'succeeded', stage: 'cutover', readState: 'healthy',
  allowedActions: [], finishedAt: '2026-09-06T01:00:00+08:00', result: { validation: { passed: true, blockingFailure: false } } }
const runtime = { effectiveDatabase: { dbType: 'mysql' }, runtimeOverrideStatus: { pendingRestart: false } }
assert.equal(isAutomaticMigrationCompleted(task, runtime), true)
for (const status of ['queued', 'running', 'restart_pending', 'verifying', 'failed', 'rolled_back']) {
  assert.equal(isAutomaticMigrationCompleted({ ...task, status }, runtime), false, status)
}
assert.equal(isAutomaticMigrationCompleted(task, null), false)
assert.equal(isAutomaticMigrationCompleted(null, runtime), false)
assert.equal(isAutomaticMigrationCompleted({ ...task, mode: 'manual' }, runtime), false)
assert.equal(isAutomaticMigrationCompleted({ ...task, readState: 'corrupted' }, runtime), false)
assert.equal(isAutomaticMigrationCompleted({ ...task, result: undefined }, runtime), false)
assert.equal(isAutomaticMigrationCompleted({ ...task, result: { validation: { passed: true, blockingFailure: true } } }, runtime), false)
assert.equal(isAutomaticMigrationCompleted(task, { ...runtime, effectiveDatabase: { dbType: 'sqlite' } }), false)
assert.equal(isAutomaticMigrationCompleted(task, { ...runtime, runtimeOverrideStatus: { pendingRestart: true } }), false)

const { descriptor } = parse(componentSource, { filename: componentPath })
const Component = load(compileScript(descriptor, { id: 'completion-test', inlineTemplate: true }).content).default
const render = async (testTask, completed) => {
  const app = vue.createSSRApp(Component, { task: testTask, completed, hasCurrentTabRescueCredential: false })
  app.component('ElAlert', ElAlert).component('ElTag', ElTag).component('ElButton', ElButton)
  app.provide(ID_INJECTION_KEY, { prefix: 101, current: 0 })
  return renderToString(app)
}
const completed = await render(task, true)
assert.ok(completed.includes('迁移已完成'))
assert.equal((completed.match(/data-phase-state="complete"/g) ?? []).length, 6, '成功后六个阶段全部完成')
assert.ok(!completed.includes('当前：cutover'))
assert.ok(!completed.includes('border-amber-300'), '最终切换不再黄色高亮')
for (const status of ['restart_pending', 'verifying', 'failed', 'rolled_back']) {
  const html = await render({ ...task, status }, false)
  assert.ok(!html.includes('迁移已完成'), `${status} 不得展示完成提示`)
  assert.notEqual((html.match(/data-phase-state="complete"/g) ?? []).length, 6)
}
const pending = await render(task, false)
assert.ok(pending.includes('等待确认运行状态'))
console.log('[verify:db-migration-completion] 完成判定、六阶段完成态及重启/验收/失败/回退场景通过')
