/**
 * 文件职责：执行真实 Vue 连接测试状态，验证参数变化、请求乱序、失败与离页取消。
 * 维护说明：只替换 HTTP 边界，保留 Vue 响应式和 useStableRequest 的真实实现；不连接或迁移数据库。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import ts from 'typescript'
import * as vue from 'vue'
import { compileScript, parse } from '@vue/compiler-sfc'
import { renderToString } from '@vue/server-renderer'
import { ElAlert, ID_INJECTION_KEY } from 'element-plus'

const require = createRequire(import.meta.url)
const entry = 'src/views/system/useDatabaseMigrationConnectionTest.ts'
assert.ok(fs.existsSync(entry), '主卡片应提供可取消且会失效旧结果的连接测试状态')
const pending = []
const modules = new Map()
const load = (filename) => {
  const absolute = path.resolve(filename)
  if (modules.has(absolute)) return modules.get(absolute)
  const module = { exports: {} }
  modules.set(absolute, module.exports)
  let source = fs.readFileSync(absolute, 'utf8')
  if (absolute.endsWith('.vue')) {
    const { descriptor } = parse(source, { filename: absolute })
    source = compileScript(descriptor, { id: 'connection-result-test', inlineTemplate: true }).content
  }
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const localRequire = (name) => {
    if (name === 'vue') return vue
    if (name === '@/api/modules/data-maintenance') return {
      precheckSQLiteToMySqlMigration: (payload, config) => new Promise((resolve, reject) => {
        pending.push({ payload, config, resolve, reject })
      }),
    }
    if (name.startsWith('@/')) return load(`src/${name.slice(2)}.ts`)
    return require(name)
  }
  new Function('require', 'module', 'exports', code)(localRequire, module, module.exports)
  return module.exports
}
const { useDatabaseMigrationConnectionTest } = load(entry)
const target = vue.reactive({ host: 'mysql', port: 3306, user: 'demo', password: 'secret-sentinel', database: 'demo' })
let state
let invalidations = 0
const renderer = vue.createRenderer({
  createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
  insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {},
  parentNode: () => null, nextSibling: () => null,
})
const app = renderer.createApp({
  setup() {
    state = useDatabaseMigrationConnectionTest(() => ({ ...target }), () => { invalidations += 1 })
    return () => null
  },
})
app.mount({})
const result = (canProceed, reachable = true) => ({
  canProceed, checkedAt: new Date().toISOString(), target: { reachable, version: '8.4.10' },
  issues: canProceed ? [] : [{ level: 'error', code: 'target_access_denied', message: '请检查密码与授权范围。' }],
})

const first = state.testConnection()
assert.equal(state.loading.value, true)
assert.equal(pending[0].payload.allowTargetWithData, false, '主卡片固定检查空库，不继承高级覆盖选项')
assert.equal(pending[0].payload.target.host, 'mysql')
pending[0].resolve(result(true))
assert.equal((await first).canProceed, true)
assert.equal(state.title.value, '连接成功，迁移预检通过')
assert.equal(state.loading.value, false)
target.password = 'changed-secret'
assert.equal(state.result.value, null, '密码变化立即使旧结果失效')
assert.ok(invalidations > 0)

const stale = state.testConnection()
target.host = 'new-mysql'
assert.equal(pending[1].config.signal.aborted, true)
const latest = state.testConnection()
pending[2].resolve(result(false))
await latest
pending[1].resolve(result(true))
assert.equal(await stale, null, '迟到成功不能用于创建任务')
assert.equal(state.result.value.canProceed, false)
assert.equal(state.title.value, '连接成功，但尚不满足迁移条件')

const unreachable = state.testConnection()
pending[3].resolve(result(false, false))
await unreachable
assert.equal(state.title.value, '连接失败，请检查 MySQL 配置')
const failure = state.testConnection()
assert.equal(state.result.value, null, '重新测试先清除历史结果')
pending[4].reject(new Error('Network Error'))
await failure
assert.ok(state.error.value)
assert.equal(state.title.value, '连接测试未完成')
assert.equal(state.loading.value, false)

const leaving = state.testConnection()
app.unmount()
assert.equal(pending[5].config.signal.aborted, true)
pending[5].resolve(result(true))
assert.equal(await leaving, null)
assert.equal(state.result.value, null)

const ResultComponent = load('src/views/system/components/DatabaseMigrationConnectionTestResult.vue').default
const renderResult = async (props) => {
  const app = vue.createSSRApp(ResultComponent, props)
  app.component('ElAlert', ElAlert)
  app.provide(ID_INJECTION_KEY, { prefix: 100, current: 0 })
  return renderToString(app)
}
const blocked = result(false)
blocked.issues = [
  { level: 'error', code: 'target_not_empty', message: '旧高级提示允许清空目标数据' },
  { level: 'error', code: 'target_unreachable', message: '<img src=x onerror=alert(1)>' },
]
const blockedHtml = await renderResult({ loading: false, result: blocked, error: '', title: '连接成功，但尚不满足迁移条件', alertType: 'warning' })
assert.ok(blockedHtml.includes('目标库已有数据，请改用专用空库后重新测试。'))
assert.ok(!blockedHtml.includes('允许清空'))
assert.ok(blockedHtml.includes('问题代码：target_not_empty'))
assert.ok(!blockedHtml.includes('<img src=x'), '问题提示必须经过 Vue 文本转义')
const failedHtml = await renderResult({ loading: false, result: null, error: '网络连接失败，请重试', title: '连接测试未完成', alertType: 'error' })
assert.ok(failedHtml.includes('网络连接失败，请重试'))
console.log('[verify:db-migration-connection-test] 连接状态、空库策略、参数失效、乱序、失败、离页取消与真实组件渲染通过')
