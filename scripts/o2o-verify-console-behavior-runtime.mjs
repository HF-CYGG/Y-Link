/** 核销页行为宿主：权限与请求保护走生产代码，只提供网络/摄像头/路由/确认框边界。 */
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createPinia } from 'pinia'
import { reactive } from 'vue'
import { rolldown } from 'rolldown'
import { root, host, compileBehaviorSfc, freshness, mountBehavior, flush } from './vue-behavior-test-runtime.mjs'
export { host, flush }
export const output = path.join(root, 'tmp/coverage-vue-kingdee/O2oVerifyConsoleView-setup.mjs')
export const component = await compileBehaviorSfc('src/views/o2o/O2oVerifyConsoleView.vue', output)

// 测试通过/auth/me网络边界恢复真实Pinia认证Store，不替换权限判断或稳定请求函数。
const authOutput = path.join(root, 'tmp/coverage-vue-kingdee/VerifyConsoleAuthStore.mjs')
const sharedFreshness = path.join(root, 'tmp/coverage-vue-kingdee/kingdee-freshness.mjs')
await freshness()
const bundle = await rolldown({ input: path.join(root, 'src/store/modules/auth.ts'), external: ['vue', 'axios', 'pinia'], plugins: [{
  name: '认证测试的网络与资源预热边界',
  resolveId(id) {
    if (id === '@/api/http') return '\0verify-auth-network'
    if (id === '@/router/route-performance') return '\0verify-route-assets'
    if (id === '@/utils/kingdee-freshness') return { id: pathToFileURL(sharedFreshness).href, external: true }
    if (['@/api/modules/auth', '@/utils/auth-storage'].includes(id)) return path.join(root, 'src', id.slice(2) + '.ts')
  },
  load(id) {
    if (id === '\0verify-auth-network') return 'export const request = (...args) => globalThis.__ylinkBehavior.authRequest(...args)'
    if (id === '\0verify-route-assets') return 'export const resolvePostLoginWarmupTargets = () => []; export const scheduleRouteComponentWarmup = (...args) => globalThis.__ylinkBehavior.warmups.push(args)'
  },
}] })
fs.mkdirSync(path.dirname(authOutput), { recursive: true })
await bundle.write({ file: authOutput, format: 'esm', sourcemap: true, codeSplitting: false }); await bundle.close()
const { useAuthStore } = await import(pathToFileURL(authOutput).href)
export const mountConsole = async () => {
  host.errors.length = 0; host.warnings.length = 0; host.successes.length = 0
  host.route = reactive({ query: {} }); host.warmups = []; host.confirm = async (...args) => { host.confirmations.push(args) }; host.confirmations = []
  host.authRequest = async (request) => {
    assert.equal(request.method, 'GET'); assert.equal(request.url, '/auth/me')
    return { id: '185', username: 'verify-operator', displayName: '隔离核销员', role: 'operator', status: 'enabled', permissions: ['orders:view', 'orders:update', 'orders:create'] }
  }
  host.auth = useAuthStore(createPinia()); assert.equal(await host.auth.initializeAuth(), true)
  const mounted = mountBehavior(component, {}); await flush(); return mounted
}
export const preorder = (id, version = 1) => ({
  order: { id, preorderNo: `PRE-D-${id === 'A' ? '000001' : '000002'}`, verifyCode: `code-${id}`, status: 'pending', clientOrderType: 'department', totalQty: 1, totalAmount: '1.00', updateCount: 0, hasCustomerOrder: false, isSystemApplied: true, kingdeeVersion: version, kingdeeVoucherNo: `KD-${version}`, kingdeeStatus: 'registered', kingdeeEditable: true },
  items: [], returnRequests: [],
})
export const result = (id, version = 1) => ({ verifyTargetType: 'preorder', detail: preorder(id, version) })
export const search = async (state, id) => { state.verifyCode.value = `code-${id}`; await state.handleSearch(); await flush() }
