/** 管理端 WebAuthn 前端契约与真实 HTTP 拦截器回归。 */
import assert from 'node:assert/strict'
import { rolldown } from 'rolldown'
import axios from 'axios'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import ts from 'typescript'
import { createMemoryHistory, createRouter, isNavigationFailure } from 'vue-router'

const values = new Map()
const storage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: (key) => values.delete(key),
}
let redirects = 0
globalThis.window = {
  localStorage: storage,
  location: {
    pathname: '/dashboard',
    search: '',
    hash: '',
    replace: () => { redirects += 1 },
  },
  dispatchEvent: () => { redirects += 1; return false },
}
globalThis.CustomEvent = class {
  constructor(name, options) {
    this.type = name
    this.detail = options?.detail
  }
}

const outputPath = path.resolve('tmp/admin-webauthn-20261009-frontend/http-interceptor-test.mjs')
const bundle = await rolldown({
  input: 'src/api/http.ts',
  external: (source) => !source.startsWith('.') && !source.startsWith('@/') && !path.isAbsolute(source),
  plugins: [{
    name: '前端测试别名与环境',
    resolveId(source) {
      if (!source.startsWith('@/')) return
      const target = path.resolve('src', source.slice(2))
      for (const candidate of [target, `${target}.ts`, `${target}/index.ts`]) {
        if (fs.existsSync(candidate)) return candidate
      }
    },
    transform(code, id) { if (id.endsWith('.ts')) return code.replaceAll('import.meta.env', '({ VITE_API_BASE_URL: "/api", DEV: false })') },
  }],
})
await bundle.write({ file: outputPath, format: 'esm' })
await bundle.close()
const helperPath = path.resolve('tmp/admin-webauthn-20261009-frontend/webauthn-helper-test.mjs')
const helperBundle = await rolldown({ input: 'src/utils/admin-webauthn.ts' })
await helperBundle.write({ file: helperPath, format: 'esm' })
await helperBundle.close()
const apiEntryPath = path.resolve('tmp/admin-webauthn-20261009-frontend/api-entry.ts')
const apiPath = path.resolve('tmp/admin-webauthn-20261009-frontend/api-test.mjs')
fs.writeFileSync(apiEntryPath, [
  "export * from '../../src/api/modules/admin-webauthn.ts'",
  "export { resetUserWebAuthn } from '../../src/api/modules/user.ts'",
  "export { http } from '../../src/api/http.ts'",
  "export { useAuthStore } from '../../src/store/modules/auth.ts'",
  "export { pinia } from '../../src/store/pinia.ts'",
].join('\n'))
const apiBundle = await rolldown({
  input: apiEntryPath,
  external: (source) => !source.startsWith('.') && !source.startsWith('@/') && !path.isAbsolute(source),
  plugins: [{
    name: '前端 API 测试别名与环境',
    resolveId(source) {
      if (source.endsWith('.vue')) return `\0无关页面占位:${source}`
      if (!source.startsWith('@/')) return
      const target = path.resolve('src', source.slice(2))
      for (const candidate of [target, `${target}.ts`, `${target}/index.ts`]) {
        if (fs.existsSync(candidate)) return candidate
      }
    },
    load(id) { if (id.startsWith('\0无关页面占位:')) return 'export default {}' },
    transform(code, id) { if (id.endsWith('.ts')) return code.replaceAll('import.meta.env', '({ VITE_API_BASE_URL: "/api", DEV: false })') },
  }],
})
await apiBundle.write({ file: apiPath, format: 'esm', codeSplitting: false })
await apiBundle.close()
try {
  const { assessWebAuthnAvailability, createWebAuthnFlow, isWebAuthnCancellation } = await import(pathToFileURL(helperPath).href)
  const capabilities = { enabled: true, rpId: 'example.test', rpName: 'Y-Link', allowedOrigins: ['https://example.test'] }
  assert.equal(assessWebAuthnAvailability(capabilities, { origin: 'https://example.test', secure: true, supported: true }).available, true)
  assert.equal(assessWebAuthnAvailability({ ...capabilities, enabled: false }, { origin: 'https://example.test', secure: true, supported: true }).available, false)
  assert.equal(assessWebAuthnAvailability(capabilities, { origin: 'https://evil.test', secure: true, supported: true }).available, false)
  assert.equal(assessWebAuthnAvailability(capabilities, { origin: 'https://example.test', secure: false, supported: true }).available, false)
  assert.equal(assessWebAuthnAvailability(capabilities, { origin: 'https://example.test', secure: true, supported: false }).available, false)
  assert.equal(isWebAuthnCancellation({ name: 'NotAllowedError' }), true)
  assert.equal(isWebAuthnCancellation({ code: 'ERROR_CEREMONY_ABORTED' }), true)
  assert.equal(isWebAuthnCancellation({ name: 'SecurityError' }), false)
  let sdkCancels = 0
  const flow = createWebAuthnFlow(() => { sdkCancels += 1 })
  const first = flow.start()
  const second = flow.start()
  assert.equal(first.signal.aborted, true)
  assert.equal(flow.isCurrent(first.id), false)
  assert.equal(flow.isCurrent(second.id), true)
  flow.cancel()
  assert.equal(second.signal.aborted, true)
  assert.equal(flow.isCurrent(second.id), false)
  assert.equal(sdkCancels, 2)

  const { http } = await import(pathToFileURL(outputPath).href)
  http.defaults.adapter = async (config) => {
    const response = { status: 401, statusText: 'Unauthorized', data: { code: 401, message: '会话无效' }, headers: {}, config }
    throw new axios.AxiosError('会话无效', 'ERR_BAD_REQUEST', config, undefined, response)
  }

  for (const url of ['/auth/webauthn/login/options', '/auth/webauthn/login/verify']) {
    values.set('y-link.auth.user', '{"id":"saved"}')
    redirects = 0
    await assert.rejects(http.post(url, {}))
    assert.equal(values.get('y-link.auth.user'), '{"id":"saved"}', `${url} 的登录失败不得清理本地用户快照`)
    assert.equal(redirects, 0, `${url} 的登录失败不得触发全局跳转`)
  }

  for (const url of ['/auth/webauthn/credentials', '/auth/webauthn/register/options']) {
    values.set('y-link.auth.user', '{"id":"saved"}')
    redirects = 0
    await assert.rejects(http.post(url, {}))
    assert.equal(values.has('y-link.auth.user'), false, `${url} 的 401 必须清理过期会话快照`)
    assert.equal(redirects, 1, `${url} 的 401 必须触发全局重新登录`)
  }
  const api = await import(pathToFileURL(apiPath).href)
  const calls = []
  const responses = new Map([
    ['/auth/webauthn/capabilities', { enabled: false, rpId: null, rpName: null, allowedOrigins: [] }],
    ['/auth/webauthn/credentials', [{ id: '7', name: '办公室密钥', createdAt: '2026-01-01', lastUsedAt: null, deviceType: 'singleDevice', backedUp: false }]],
    ['/auth/webauthn/login/options', { challengeId: 'login-1', options: { challenge: 'abc', rpId: 'example.test' }, expiresInSeconds: 300 }],
    ['/auth/webauthn/login/verify', { expiresAt: '2026-12-01', user: { id: '1', username: 'admin', displayName: '管理员', role: 'admin', status: 'enabled', permissions: [], email: null, lastLoginAt: null, createdAt: '2026-01-01', updatedAt: '2026-01-01' } }],
    ['/auth/webauthn/register/options', { challengeId: 'register-1', options: { challenge: 'abc' }, expiresInSeconds: 300 }],
    ['/auth/webauthn/register/verify', { id: '8', name: '新密钥', createdAt: '2026-01-01', lastUsedAt: null, deviceType: 'singleDevice', backedUp: false }],
    ['/auth/webauthn/credentials/7', true],
    ['/users/2/webauthn/reset', { revokedCount: 2 }],
  ])
  api.http.defaults.adapter = async (config) => {
    calls.push({ method: config.method?.toUpperCase(), url: config.url, data: config.data ? JSON.parse(config.data) : undefined })
    const data = responses.get(config.url)
    return { status: 200, statusText: 'OK', headers: {}, config, data: { code: 0, message: 'ok', data } }
  }
  assert.equal((await api.getAdminWebAuthnCapabilities()).enabled, false)
  assert.equal((await api.getAdminWebAuthnCredentials()).length, 1, '功能关闭时仍须可查看已有凭据')
  await api.startAdminWebAuthnLogin({})
  await api.startAdminWebAuthnLogin({ captchaId: 'captcha-1', code: '1234' })
  const login = await api.verifyAdminWebAuthnLogin({ challengeId: 'login-1', response: { id: 'key', rawId: 'key', type: 'public-key', response: {}, clientExtensionResults: {} } })
  assert.ok(login.user.permissions.includes('users:view'), '密钥登录结果须归一化权限，供路由守卫复用')
  await api.startAdminWebAuthnRegistration({ name: '新密钥', kind: 'security_key', currentPassword: '仅测试', code: '123456' })
  await api.verifyAdminWebAuthnRegistration({ challengeId: 'register-1', response: { id: 'key', rawId: 'key', type: 'public-key', response: {}, clientExtensionResults: {} } })
  responses.set('/auth/webauthn/credentials/7', { id: '7', name: '改名', createdAt: '2026-01-01', lastUsedAt: null, deviceType: 'singleDevice', backedUp: false })
  await api.renameAdminWebAuthnCredential('7', '改名')
  responses.set('/auth/webauthn/credentials/7', true)
  await api.deleteAdminWebAuthnCredential('7', { currentPassword: '仅测试', recoveryCode: '测试恢复码' })
  assert.deepEqual(await api.resetUserWebAuthn('2', { currentPassword: '仅测试', reason: '密钥遗失' }), { revokedCount: 2 })
  assert.ok(calls.some((call) => call.method === 'POST' && call.url === '/auth/webauthn/login/options' && Object.keys(call.data).length === 0))
  assert.ok(calls.some((call) => call.method === 'POST' && call.url === '/auth/webauthn/login/options' && call.data.captchaId === 'captcha-1' && call.data.code === '1234' && !('captchaCode' in call.data)))
  assert.ok(calls.some((call) => call.method === 'POST' && call.url === '/auth/webauthn/register/options' && call.data.kind === 'security_key' && call.data.code === '123456'))
  assert.ok(calls.some((call) => call.method === 'PATCH' && call.url === '/auth/webauthn/credentials/7' && Object.keys(call.data).join() === 'name'), '改名只能提交名称')
  assert.ok(calls.some((call) => call.method === 'DELETE' && call.url === '/auth/webauthn/credentials/7' && call.data.recoveryCode))
  assert.ok(calls.some((call) => call.method === 'POST' && call.url === '/users/2/webauthn/reset' && call.data.reason === '密钥遗失'))
  const authStore = api.useAuthStore(api.pinia)
  const storeLogin = await authStore.completeWebAuthnLogin({ challengeId: 'login-1', response: { id: 'key', rawId: 'key', type: 'public-key', response: {}, clientExtensionResults: {} } })
  assert.equal(storeLogin?.user.id, '1')
  assert.equal(authStore.isAuthenticated, true, 'WebAuthn 成功须进入管理端统一登录态')
  assert.equal(authStore.expiresAt, '2026-12-01')
  assert.equal(JSON.parse(values.get('y-link.auth.user')).id, '1', '登录态快照须沿用现有安全持久化入口')
  authStore.clearAuthState({ resetInitialized: true })
  assert.equal(values.has('y-link.auth.user'), false)

  // 从真实 SFC setup 中提取原函数运行，API 和确认框只在异步边界替身化。
  const dialogSource = fs.readFileSync('src/components/account/AdminWebAuthnDialog.vue', 'utf8')
  const dialogScript = dialogSource.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1]
  assert.ok(dialogScript)
  const dialogAst = ts.createSourceFile('AdminWebAuthnDialog.ts', dialogScript, ts.ScriptTarget.Latest, true)
  const dialogRouteCall = dialogAst.statements.find((statement) =>
    ts.isExpressionStatement(statement)
    && ts.isCallExpression(statement.expression)
    && statement.expression.expression.getText(dialogAst) === 'onBeforeRouteLeave')
  assert.ok(dialogRouteCall, '管理端密钥弹窗须注册最终删除路由离开守卫')
  const dialogRouteJavascript = ts.transpileModule(`const routeGuard = ${dialogRouteCall.expression.arguments[0].getText(dialogAst)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  const makeDialogRouteGuard = new Function('binding', `with (binding) { ${dialogRouteJavascript}; return routeGuard }`)
  const declaration = (name) => {
    for (const statement of dialogAst.statements) {
      if (!ts.isVariableStatement(statement)) continue
      for (const item of statement.declarationList.declarations) {
        if (item.name.getText(dialogAst) === name) return `const ${item.getText(dialogAst)};`
      }
    }
    throw new Error(`缺少真实组件函数 ${name}`)
  }
  const functionSource = ['clearProof', 'clearSensitive', 'close', 'updateVisible', 'goToList', 'current', 'checkedName', 'checkedProof', 'addCredential', 'renameCredential', 'deleteCredential']
    .map(declaration).join('\n')
  const javascript = ts.transpileModule(functionSource.replaceAll("await import('@simplewebauthn/browser')", 'await loadTestWebAuthnSdk()'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  const makeDialogActions = new Function('binding', `with (binding) { ${javascript}; return { clearSensitive, close, updateVisible, goToList, addCredential, renameCredential, deleteCredential } }`)
  const ref = (value) => ({ value })
  const createDialogHarness = ({ delayDelete = false } = {}) => {
    let resolveOptions
    let resolveConfirm
    let resolveVerify
    let rejectVerify
    let resolveDelete
    let rejectDelete
    let deleteCalls = 0
    let confirmationCalls = 0
    let closeEvents = 0
    const successMessages = []
    const errorMessages = []
    const props = { modelValue: true }
    const form = { name: '测试密钥', kind: 'passkey', currentPassword: '旧密码', code: '', recoveryCode: '', useRecoveryCode: false }
    const stage = ref('add')
    const submitting = ref(false)
    const deletePending = ref(false)
    const confirmationPending = ref(false)
    const ceremonyPhase = ref('idle')
    const binding = {
      props, form, stage, submitting, deletePending, confirmationPending, ceremonyPhase,
      epoch: 1, confirmationSerial: 1,
      loadController: null,
      selected: ref(null), credentials: ref([]), capabilities: ref(null), mfaStatus: ref({ enabled: false }),
      mfaPhase: ref('ready'), listError: ref(''), listLoading: ref(false),
      availability: ref({ available: true }),
      busy: { get value() { return submitting.value || confirmationPending.value || ceremonyPhase.value !== 'idle' } },
      committed: { get value() { return submitting.value || ceremonyPhase.value === 'verify' } },
      ceremony: createWebAuthnFlow(() => undefined),
      emit: (name, visible) => { if (name === 'update:modelValue' && visible === false) closeEvents += 1 },
      showAppWarning: () => undefined, showAppError: (message) => errorMessages.push(message), showAppSuccess: (message) => successMessages.push(message),
      startAdminWebAuthnRegistration: () => new Promise((resolve) => { resolveOptions = resolve }),
      verifyAdminWebAuthnRegistration: () => new Promise((resolve, reject) => { resolveVerify = resolve; rejectVerify = reject }),
      loadTestWebAuthnSdk: async () => ({ startRegistration: async () => ({ id: '测试响应' }) }),
      loadCredentials: () => Promise.resolve([]),
      renameAdminWebAuthnCredential: async () => ({ id: '7', name: form.name }),
      ElMessageBox: { confirm: () => { confirmationCalls += 1; return new Promise((resolve) => { resolveConfirm = resolve }) }, close: () => undefined },
      deleteAdminWebAuthnCredential: () => { deleteCalls += 1; return delayDelete ? new Promise((resolve, reject) => { resolveDelete = resolve; rejectDelete = reject }) : Promise.resolve(true) },
      authStore: { currentUser: { username: '原管理账号' }, clearAuthState: () => undefined }, redirectToAdminLogin: () => undefined,
      extractErrorMessage: () => '测试异常',
    }
    return {
      props, form, stage, binding,
      actions: makeDialogActions(binding),
      resolveOptions: (value) => resolveOptions(value),
      resolveConfirm: () => resolveConfirm(),
      resolveVerify: () => resolveVerify({ id: '新密钥' }),
      rejectVerify: () => rejectVerify(new Error('连接中断')),
      resolveDelete: () => resolveDelete(true),
      rejectDelete: () => rejectDelete(new Error('删除失败')),
      get deleteCalls() { return deleteCalls },
      get confirmationCalls() { return confirmationCalls },
      get closeEvents() { return closeEvents },
      get successMessages() { return successMessages },
      get errorMessages() { return errorMessages },
    }
  }
  const addHarness = createDialogHarness()
  const oldAdd = addHarness.actions.addCredential()
  addHarness.props.modelValue = false
  addHarness.actions.clearSensitive()
  addHarness.props.modelValue = true
  addHarness.stage.value = 'add'
  addHarness.form.currentPassword = '新流程密码'
  addHarness.resolveOptions({ challengeId: 'old', options: {} })
  await oldAdd
  assert.equal(addHarness.form.currentPassword, '新流程密码', '旧添加请求的 finally 不得清空重新打开后的输入')

  const deleteHarness = createDialogHarness()
  deleteHarness.stage.value = 'delete'
  deleteHarness.binding.selected.value = { id: '7', name: '同一把密钥' }
  const oldDelete = deleteHarness.actions.deleteCredential()
  deleteHarness.props.modelValue = false
  deleteHarness.actions.clearSensitive()
  deleteHarness.props.modelValue = true
  deleteHarness.stage.value = 'delete'
  deleteHarness.binding.selected.value = { id: '7', name: '同一把密钥' }
  deleteHarness.form.currentPassword = '新流程密码'
  deleteHarness.resolveConfirm()
  await oldDelete
  assert.equal(deleteHarness.deleteCalls, 0, '旧确认框返回后不得对重新打开的同一密钥执行删除')
  assert.equal(deleteHarness.form.currentPassword, '新流程密码')

  const doubleDelete = createDialogHarness()
  doubleDelete.stage.value = 'delete'
  doubleDelete.binding.selected.value = { id: '7', name: '同一把密钥' }
  const firstDelete = doubleDelete.actions.deleteCredential()
  await doubleDelete.actions.deleteCredential()
  assert.equal(doubleDelete.confirmationCalls, 1, '待确认删除不可叠加第二个确认框')
  doubleDelete.resolveConfirm()
  await firstDelete
  assert.equal(doubleDelete.deleteCalls, 1)

  const committedDelete = createDialogHarness({ delayDelete: true })
  const managementRouter = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/login', component: {} },
      { path: '/client/login', component: {} },
      { path: '/', component: {}, children: [
        { path: 'dashboard', component: {} },
        { path: 'system/users', component: {} },
      ] },
    ],
  })
  await managementRouter.push('/client/login')
  await managementRouter.push('/dashboard')
  const deleteRouteGuard = makeDialogRouteGuard(committedDelete.binding)
  const removeDeleteRouteGuard = managementRouter.beforeEach((to, from) => {
    if (from.matched[0]?.path === '/' && to.matched[0]?.path !== '/') return deleteRouteGuard()
  })
  let deleteRedirect
  committedDelete.binding.redirectToAdminLogin = () => { deleteRedirect = managementRouter.push('/login') }
  committedDelete.stage.value = 'delete'
  committedDelete.binding.selected.value = { id: '7', name: '待删除密钥' }
  const deleting = committedDelete.actions.deleteCredential()
  committedDelete.resolveConfirm()
  for (let i = 0; i < 3; i += 1) await Promise.resolve()
  assert.equal(committedDelete.deleteCalls, 1)
  assert.equal(committedDelete.binding.deletePending.value, true)
  assert.ok(isNavigationFailure(await managementRouter.push('/client/login')), '删除最终请求在途时不得离开管理端布局')
  managementRouter.back()
  for (let i = 0; i < 3; i += 1) await Promise.resolve()
  assert.equal(managementRouter.currentRoute.value.path, '/dashboard', '删除在途时后退不得离开管理端')
  await managementRouter.push('/system/users')
  assert.equal(managementRouter.currentRoute.value.path, '/system/users', '同一管理端布局内导航无需阻止')
  committedDelete.actions.close()
  committedDelete.actions.updateVisible(false)
  committedDelete.actions.goToList()
  assert.equal(committedDelete.closeEvents, 0, '删除请求已发出后不得关闭弹窗')
  assert.equal(committedDelete.stage.value, 'delete')
  committedDelete.resolveDelete()
  await deleting
  assert.ok(deleteRedirect, '删除成功须请求跳转管理端登录页')
  await deleteRedirect
  assert.equal(committedDelete.binding.deletePending.value, false)
  assert.equal(managementRouter.currentRoute.value.path, '/login', '删除成功后应放行自身登录跳转')
  removeDeleteRouteGuard()

  await managementRouter.push('/dashboard')
  const renamed = createDialogHarness()
  renamed.stage.value = 'rename'
  renamed.binding.selected.value = { id: '7', name: '旧名称' }
  const removeRenameRouteGuard = managementRouter.beforeEach((to, from) => {
    if (from.matched[0]?.path === '/' && to.matched[0]?.path !== '/') return makeDialogRouteGuard(renamed.binding)()
  })
  await renamed.actions.renameCredential()
  assert.equal(renamed.binding.deletePending.value, false, '改名成功不得误锁离开管理端')
  await managementRouter.push('/client/login')
  assert.equal(managementRouter.currentRoute.value.path, '/client/login')
  await managementRouter.push('/dashboard')
  renamed.stage.value = 'rename'
  renamed.binding.selected.value = { id: '7', name: '旧名称' }
  renamed.form.name = '失败改名'
  renamed.binding.renameAdminWebAuthnCredential = async () => { throw new Error('改名失败') }
  await renamed.actions.renameCredential()
  assert.equal(renamed.binding.deletePending.value, false, '改名失败不得误锁离开管理端')
  await managementRouter.push('/client/login')
  assert.equal(managementRouter.currentRoute.value.path, '/client/login')
  removeRenameRouteGuard()

  await managementRouter.push('/dashboard')
  const failedDelete = createDialogHarness({ delayDelete: true })
  failedDelete.stage.value = 'delete'
  failedDelete.binding.selected.value = { id: '7', name: '待删除密钥' }
  const removeFailedDeleteRouteGuard = managementRouter.beforeEach((to, from) => {
    if (from.matched[0]?.path === '/' && to.matched[0]?.path !== '/') return makeDialogRouteGuard(failedDelete.binding)()
  })
  const failingDelete = failedDelete.actions.deleteCredential()
  failedDelete.resolveConfirm()
  for (let i = 0; i < 3; i += 1) await Promise.resolve()
  assert.ok(isNavigationFailure(await managementRouter.push('/client/login')))
  failedDelete.rejectDelete()
  await failingDelete
  assert.equal(failedDelete.binding.deletePending.value, false, '删除请求失败后须释放路由守卫')
  await managementRouter.push('/client/login')
  assert.equal(managementRouter.currentRoute.value.path, '/client/login')
  removeFailedDeleteRouteGuard()

  const committedAdd = createDialogHarness()
  const adding = committedAdd.actions.addCredential()
  committedAdd.resolveOptions({ challengeId: 'register', options: {} })
  for (let i = 0; i < 4; i += 1) await Promise.resolve()
  assert.equal(committedAdd.binding.ceremonyPhase.value, 'verify')
  committedAdd.actions.close()
  committedAdd.actions.updateVisible(false)
  committedAdd.actions.goToList()
  assert.equal(committedAdd.closeEvents, 0, '注册最终验证阶段不得关闭弹窗')
  assert.equal(committedAdd.stage.value, 'add', '注册最终验证阶段不得返回并丢弃结果')
  committedAdd.resolveVerify()
  await adding
  assert.equal(committedAdd.stage.value, 'list')

  const unmountedAdd = createDialogHarness()
  const verifyingAfterUnmount = unmountedAdd.actions.addCredential()
  unmountedAdd.resolveOptions({ challengeId: 'register-unmounted', options: {} })
  for (let i = 0; i < 4; i += 1) await Promise.resolve()
  assert.equal(unmountedAdd.binding.ceremonyPhase.value, 'verify')
  unmountedAdd.props.modelValue = false
  unmountedAdd.actions.clearSensitive()
  unmountedAdd.props.modelValue = true
  unmountedAdd.stage.value = 'add'
  unmountedAdd.form.currentPassword = '新流程密码'
  unmountedAdd.resolveVerify()
  await verifyingAfterUnmount
  assert.match(unmountedAdd.successMessages[0], /原管理账号.*测试密钥/, '卸载后旧注册成功须反馈原账号与密钥')
  assert.equal(unmountedAdd.form.currentPassword, '新流程密码', '卸载后旧注册成功不得覆盖新弹窗输入')

  const unmountedFailedAdd = createDialogHarness()
  const failedAfterUnmount = unmountedFailedAdd.actions.addCredential()
  unmountedFailedAdd.resolveOptions({ challengeId: 'register-failed', options: {} })
  for (let i = 0; i < 4; i += 1) await Promise.resolve()
  unmountedFailedAdd.props.modelValue = false
  unmountedFailedAdd.actions.clearSensitive()
  unmountedFailedAdd.rejectVerify()
  await failedAfterUnmount
  assert.match(unmountedFailedAdd.errorMessages[0], /结果尚未确认.*检查密钥列表/, '卸载后注册请求失败须提示核对服务端实际结果')

  const userSource = fs.readFileSync('src/views/system/UserManageView.vue', 'utf8')
  const userScript = userSource.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1]
  assert.ok(userScript)
  assert.match(userScript, /onDeactivated\(deactivateRevokeWebAuthn\)/)
  assert.match(userScript, /onBeforeUnmount\(\(\) => \{[\s\S]*?deactivateRevokeWebAuthn\(\)/)
  const userAst = ts.createSourceFile('UserManageView.ts', userScript, ts.ScriptTarget.Latest, true)
  const userDeclaration = (name) => {
    for (const statement of userAst.statements) {
      if (!ts.isVariableStatement(statement)) continue
      for (const item of statement.declarationList.declarations) {
        if (item.name.getText(userAst) === name) return `const ${item.getText(userAst)};`
      }
    }
    throw new Error(`缺少真实用户管理函数 ${name}`)
  }
  const userJavascript = ts.transpileModule(['clearRevokeWebAuthn', 'updateRevokeWebAuthnVisible', 'deactivateRevokeWebAuthn', 'handleSubmitRevokeWebAuthn'].map(userDeclaration).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  let resolveUserConfirm
  let userResetCalls = 0
  let userConfirmCalls = 0
  const revokeForm = { currentPassword: '旧密码', code: '', recoveryCode: '', useRecoveryCode: false, reason: '密钥丢失' }
  const revokeTarget = { id: '2', displayName: '目标账号', webauthnCredentialsCount: 1 }
  const revokeBinding = {
    revokeWebAuthnEpoch: 1,
    revokeWebAuthnVisible: ref(true), revokeWebAuthnSubmitting: ref(false), revokeWebAuthnConfirmationPending: ref(false), revokeWebAuthnTarget: ref(revokeTarget),
    revokeWebAuthnActive: true, revokeWebAuthnMounted: true, revokeWebAuthnRefreshOnActivate: false,
    revokeWebAuthnMfaStatus: ref({ enabled: false }), revokeWebAuthnMfaPhase: ref('ready'), revokeWebAuthnForm: revokeForm,
    authStore: { isAdmin: true, currentUser: { id: '1' } }, ensurePermission: () => true,
    showAppError: () => undefined, showAppSuccess: () => undefined,
    ElMessageBox: { confirm: () => { userConfirmCalls += 1; return new Promise((resolve) => { resolveUserConfirm = resolve }) }, close: () => undefined },
    resetUserWebAuthn: () => { userResetCalls += 1; return Promise.resolve({ revokedCount: 1 }) },
    loadData: () => Promise.resolve(), extractErrorMessage: () => '测试异常',
  }
  const userActions = new Function('binding', `with (binding) { ${userJavascript}; return { clearRevokeWebAuthn, updateRevokeWebAuthnVisible, deactivateRevokeWebAuthn, handleSubmitRevokeWebAuthn } }`)(revokeBinding)
  const oldRevoke = userActions.handleSubmitRevokeWebAuthn()
  revokeBinding.revokeWebAuthnVisible.value = false
  userActions.clearRevokeWebAuthn()
  revokeBinding.revokeWebAuthnVisible.value = true
  revokeBinding.revokeWebAuthnTarget.value = revokeTarget
  revokeBinding.revokeWebAuthnMfaPhase.value = 'ready'
  revokeForm.currentPassword = '新流程密码'
  resolveUserConfirm()
  await oldRevoke
  assert.equal(userResetCalls, 0, '旧管理员确认框返回后不得撤销重新打开的同一账号')
  assert.equal(revokeForm.currentPassword, '新流程密码')

  revokeForm.reason = '再次核对密钥丢失'
  const deactivating = userActions.handleSubmitRevokeWebAuthn()
  await userActions.handleSubmitRevokeWebAuthn()
  assert.equal(userConfirmCalls, 2, '等待旧确认框后，同一流程不得叠加确认框')
  userActions.deactivateRevokeWebAuthn()
  resolveUserConfirm()
  await deactivating
  assert.equal(userResetCalls, 0, 'KeepAlive 离开页面后旧确认不得发撤销请求')

  revokeBinding.revokeWebAuthnActive = true
  revokeBinding.revokeWebAuthnVisible.value = true
  revokeBinding.revokeWebAuthnTarget.value = revokeTarget
  revokeBinding.revokeWebAuthnMfaPhase.value = 'ready'
  revokeForm.currentPassword = '提交密码'
  revokeForm.reason = '确认撤销遗失密钥'
  let resolveReset
  revokeBinding.resetUserWebAuthn = () => { userResetCalls += 1; return new Promise((resolve) => { resolveReset = resolve }) }
  const committedRevoke = userActions.handleSubmitRevokeWebAuthn()
  await userActions.handleSubmitRevokeWebAuthn()
  assert.equal(userConfirmCalls, 3, '重复确认不得叠加弹窗')
  resolveUserConfirm()
  for (let i = 0; i < 3; i += 1) await Promise.resolve()
  assert.equal(userResetCalls, 1)
  userActions.updateRevokeWebAuthnVisible(false)
  assert.equal(revokeBinding.revokeWebAuthnVisible.value, true, '管理员撤销请求已发出时不得关闭弹窗')
  resolveReset({ revokedCount: 1 })
  await committedRevoke
  assert.equal(revokeBinding.revokeWebAuthnVisible.value, false)

  revokeBinding.revokeWebAuthnActive = true
  revokeBinding.revokeWebAuthnVisible.value = true
  revokeBinding.revokeWebAuthnTarget.value = revokeTarget
  revokeBinding.revokeWebAuthnMfaPhase.value = 'ready'
  revokeForm.currentPassword = '不得留存的密码'
  revokeForm.reason = '再次撤销'
  let rejectReset
  revokeBinding.resetUserWebAuthn = () => new Promise((_resolve, reject) => { rejectReset = reject })
  const failingRevoke = userActions.handleSubmitRevokeWebAuthn()
  resolveUserConfirm()
  for (let i = 0; i < 3; i += 1) await Promise.resolve()
  assert.equal(revokeBinding.revokeWebAuthnSubmitting.value, true)
  userActions.deactivateRevokeWebAuthn()
  assert.equal(revokeForm.currentPassword, '', '在途撤销离页时须立即清除缓存密码')
  rejectReset(new Error('网络中断'))
  await failingRevoke
  assert.equal(revokeBinding.revokeWebAuthnVisible.value, false)
  assert.equal(revokeForm.currentPassword, '', '离页时最终请求失败也须清除缓存表单密码')
  assert.equal(revokeForm.code, '')

  // 使用真实 Vue Router memory history 驱动登录页守卫；仅替身化浏览器认证器和网络回应。
  const loginSource = fs.readFileSync('src/views/auth/LoginView.vue', 'utf8')
  const loginScript = loginSource.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1]
  assert.ok(loginScript)
  const loginAst = ts.createSourceFile('LoginView.ts', loginScript, ts.ScriptTarget.Latest, true)
  const loginDeclaration = (name) => {
    for (const statement of loginAst.statements) {
      if (!ts.isVariableStatement(statement)) continue
      for (const item of statement.declarationList.declarations) {
        if (item.name.getText(loginAst) === name) return `const ${item.getText(loginAst)};`
      }
    }
    throw new Error(`缺少真实登录函数 ${name}`)
  }
  const routeCall = loginAst.statements.find((statement) =>
    ts.isExpressionStatement(statement)
    && ts.isCallExpression(statement.expression)
    && statement.expression.expression.getText(loginAst) === 'onBeforeRouteLeave')
  assert.ok(routeCall, '登录页须注册最终验证路由离开守卫')
  const loginFunctions = ['cancelWebAuthnLogin', 'handleWebAuthnLogin', 'handleSubmit'].map(loginDeclaration).join('\n')
    .replaceAll("await import('@simplewebauthn/browser')", 'await loadTestWebAuthnSdk()')
  const loginJavascript = ts.transpileModule(`const routeGuard = ${routeCall.expression.arguments[0].getText(loginAst)};\n${loginFunctions}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  const makeLoginActions = new Function('binding', `with (binding) { ${loginJavascript}; return { routeGuard, cancelWebAuthnLogin, handleWebAuthnLogin, handleSubmit } }`)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: ['/before', '/admin/login', '/client/login', '/dashboard'].map((routePath) => ({ path: routePath, component: {} })),
  })
  await router.push('/before')
  await router.push('/admin/login')
  const makeLoginHarness = () => {
    let resolveVerify
    let rejectVerify
    const verifyResult = new Promise((resolve, reject) => { resolveVerify = resolve; rejectVerify = reject })
    const webAuthnPhase = ref('idle')
    const webAuthnVerifyPending = ref(false)
    let passwordAttempts = 0
    const binding = {
      submitPhase: ref('idle'), webAuthnPhase, webAuthnVerifyPending,
      webAuthnBusy: { get value() { return webAuthnPhase.value !== 'idle' } },
      webAuthnAvailability: ref({ available: true }),
      captchaVisible: ref(false), captchaState: { captchaId: '' },
      form: { captcha: '', password: '旧密码' }, webAuthnHint: ref(''),
      showAppWarning: () => undefined, showAppError: () => undefined,
      webAuthnFlow: createWebAuthnFlow(() => undefined),
      startAdminWebAuthnLogin: async () => ({ challengeId: 'login', options: {} }),
      loadTestWebAuthnSdk: async () => ({ startAuthentication: async () => ({ id: '测试认证响应' }) }),
      authStore: { completeWebAuthnLogin: () => verifyResult },
      finishLogin: async () => router.push('/dashboard'),
      isWebAuthnCancellation: () => false,
      normalizeRequestError: (error) => ({ message: error.message, status: 500 }),
      applySecurityHintFromMessage: () => undefined,
      ensureCaptchaVisible: async () => undefined,
      refreshCaptcha: async () => undefined,
      formRef: { value: { validate: () => { passwordAttempts += 1; return Promise.resolve(true) } } },
    }
    const actions = makeLoginActions(binding)
    const removeGuard = router.beforeEach(actions.routeGuard)
    return { binding, actions, removeGuard, resolveVerify, rejectVerify, get passwordAttempts() { return passwordAttempts } }
  }
  const successfulLogin = makeLoginHarness()
  const authenticating = successfulLogin.actions.handleWebAuthnLogin()
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
  assert.equal(successfulLogin.binding.webAuthnVerifyPending.value, true)
  assert.ok(isNavigationFailure(await router.push('/client/login')), '最终验证在途时须阻止切换到另一登录页')
  router.back()
  for (let i = 0; i < 3; i += 1) await Promise.resolve()
  assert.equal(router.currentRoute.value.path, '/admin/login', '最终验证在途时后退不得离开')
  await successfulLogin.actions.handleSubmit()
  assert.equal(successfulLogin.passwordAttempts, 0, '最终验证在途时不得启动密码登录')
  successfulLogin.actions.cancelWebAuthnLogin()
  assert.equal(successfulLogin.binding.webAuthnVerifyPending.value, true, '最终验证在途时取消不能丢弃会话回应')
  successfulLogin.resolveVerify({ user: { id: '1' } })
  await authenticating
  assert.equal(router.currentRoute.value.path, '/dashboard', '验证成功后须放行本次登录跳转')
  successfulLogin.removeGuard()

  await router.push('/admin/login')
  const failingLogin = makeLoginHarness()
  const failing = failingLogin.actions.handleWebAuthnLogin()
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
  failingLogin.rejectVerify(new Error('验证失败'))
  await failing
  assert.equal(failingLogin.binding.webAuthnVerifyPending.value, false, '验证失败后须释放路由守卫')
  await router.push('/client/login')
  assert.equal(router.currentRoute.value.path, '/client/login', '验证失败后应允许离开')
  failingLogin.removeGuard()

  console.log('通过：WebAuthn 能力、API、Store、真实 HTTP 拦截器、组件竞态和登录路由守卫')
} finally {
  delete globalThis.window
  delete globalThis.CustomEvent
}
