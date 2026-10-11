/** 管理端 WebAuthn 前端契约与真实 HTTP 拦截器回归。 */
import assert from 'node:assert/strict'
import { rolldown } from 'rolldown'
import axios from 'axios'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import ts from 'typescript'
import { createMemoryHistory, createRouter, isNavigationFailure } from 'vue-router'

const authStoreSource = fs.readFileSync('src/store/modules/auth.ts', 'utf8')
const authStoreAst = ts.createSourceFile('auth.ts', authStoreSource, ts.ScriptTarget.Latest, true)
assert.equal(
  authStoreAst.statements.some((statement) =>
    ts.isImportDeclaration(statement)
    && !statement.importClause?.isTypeOnly
    && statement.moduleSpecifier.text === '@/api/modules/admin-webauthn'),
  false,
  '共享认证 Store 不得静态加载仅在密钥登录时使用的 WebAuthn API',
)

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

const outputPath = path.resolve('tmp/webauthn-compat-ui/http-interceptor-test.mjs')
fs.mkdirSync(path.dirname(outputPath), { recursive: true })
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
await bundle.write({ file: outputPath, format: 'esm', sourcemap: true })
await bundle.close()
const helperPath = path.resolve('tmp/webauthn-compat-ui/webauthn-helper-test.mjs')
const helperBundle = await rolldown({ input: 'src/utils/admin-webauthn.ts' })
await helperBundle.write({ file: helperPath, format: 'esm', sourcemap: true })
await helperBundle.close()
const recoveryPastePath = path.resolve('tmp/webauthn-compat-ui/recovery-paste-test.mjs')
const recoveryPasteBundle = await rolldown({ input: 'src/utils/admin-mfa-recovery-code.ts' })
await recoveryPasteBundle.write({ file: recoveryPastePath, format: 'esm', sourcemap: true })
await recoveryPasteBundle.close()
const passwordHelperPath = path.resolve('tmp/webauthn-compat-ui/password-credential-test.mjs')
const passwordHelperBundle = await rolldown({ input: 'src/utils/admin-password-credential.ts' })
await passwordHelperBundle.write({ file: passwordHelperPath, format: 'esm', sourcemap: true })
await passwordHelperBundle.close()
const apiEntryPath = path.resolve('tmp/webauthn-compat-ui/api-entry.ts')
const apiPath = path.resolve('tmp/webauthn-compat-ui/api-test.mjs')
fs.writeFileSync(apiEntryPath, [
  "export * from '../../src/api/modules/admin-webauthn.ts'",
  "export { resetUserMfa, resetUserWebAuthn } from '../../src/api/modules/user.ts'",
  "export * from '../../src/api/modules/admin-mfa.ts'",
  "export { completeMfaWebAuthnLogin } from '../../src/api/modules/auth.ts'",
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
await apiBundle.write({ file: apiPath, format: 'esm', codeSplitting: false, sourcemap: true })
await apiBundle.close()
try {
  const { assessWebAuthnAvailability, createWebAuthnFlow, createLoginAttemptGate, isWebAuthnCancellation } = await import(pathToFileURL(helperPath).href)
  const { containsMultipleRecoveryCodes, guardRecoveryCodePaste } = await import(pathToFileURL(recoveryPastePath).href)
  const firstRecovery = 'ABCD-EFGH-JKLM'
  const secondRecovery = 'PQRS-TUVW-XY23'
  for (const single of [firstRecovery, 'ABCD EFGH JKLM', 'ABCD\nEFGH\nJKLM', 'ABCDEFGHJKLM']) {
    assert.equal(containsMultipleRecoveryCodes(single), false, '单条恢复码的常见分组和换行不得误判为多条')
  }
  for (const batch of [`${firstRecovery}\n${secondRecovery}`, `${firstRecovery}, ${secondRecovery}`, 'ABCD EFGH JKLM\nPQRS TUVW XY23', 'ABCDEFGHJKLMPQRSTUVWXY23']) {
    assert.equal(containsMultipleRecoveryCodes(batch), true, '完整多条恢复码粘贴须识别')
  }
  const pasteWarnings = []
  const makePasteEvent = (text) => ({
    defaultPrevented: false,
    clipboardData: { getData: () => text },
    preventDefault() { this.defaultPrevented = true },
  })
  const batchPaste = makePasteEvent(`${firstRecovery}\n${secondRecovery}`)
  guardRecoveryCodePaste(batchPaste, (message) => pasteWarnings.push(message))
  assert.equal(batchPaste.defaultPrevented, true, '批量码须在浏览器粘贴前阻止，保留已有输入')
  assert.deepEqual(pasteWarnings, ['一次只能输入一个恢复码，请从备份中单独复制一条'])
  assert.equal(pasteWarnings[0].includes(firstRecovery), false, '提示不能回显秘密')
  const singlePaste = makePasteEvent(firstRecovery)
  guardRecoveryCodePaste(singlePaste, (message) => pasteWarnings.push(message))
  assert.equal(singlePaste.defaultPrevented, false, '单条恢复码须交给输入框正常粘贴')
  assert.equal(pasteWarnings.length, 1)
  const gate = createLoginAttemptGate()
  const passwordAttempt = gate.begin()
  assert.equal(gate.commit(passwordAttempt.id), true, '密码请求发送时须冻结切换账号与离页')
  assert.equal(gate.cancel(), false, '可能设置会话 Cookie 的请求不可取消')
  assert.equal(gate.isCommitted(), true)
  assert.equal(gate.begin(), null, '最终请求完成前不得开启另一种登录方式')
  assert.equal(gate.settle(passwordAttempt.id), true)
  const optionsAttempt = gate.begin()
  assert.ok(optionsAttempt)
  assert.equal(gate.cancel(), true, '尚未发送最终请求的候选流程可取消')
  assert.equal(optionsAttempt.signal.aborted, true)
  assert.equal(gate.isCurrent(optionsAttempt.id), false, '取消后旧选项回应不得继续认证')
  const { createPasswordCredentialHandoff } = await import(pathToFileURL(passwordHelperPath).href)
  const storedPasswords = []
  const handoff = createPasswordCredentialHandoff({
    PasswordCredential: class { constructor(data) { Object.assign(this, data) } },
    store: async (credential) => { storedPasswords.push(credential) },
  })
  assert.equal(handoff.capture('管理员账号', '测试密码', 300), true)
  assert.equal(storedPasswords.length, 0, '密码第一步接受后也不能提前触发浏览器保存')
  await handoff.storeOnce()
  await handoff.storeOnce()
  assert.equal(storedPasswords.length, 1, '完整登录后至多调用一次浏览器保存')
  handoff.capture('另一个账号', '另一个测试密码', 300)
  handoff.discard()
  await handoff.storeOnce()
  assert.equal(storedPasswords.length, 1, '取消或切换账号后不得保留待保存密码')
  const unsupportedHandoff = createPasswordCredentialHandoff({})
  assert.equal(unsupportedHandoff.capture('账号', '测试密码', 300), false)
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
    ['/auth/login/mfa/webauthn/options', { challengeId: 'mfa-1', options: { challenge: 'def' }, expiresInSeconds: 300 }],
    ['/auth/login/mfa/webauthn/verify', { expiresAt: '2026-12-01', user: { id: '1', username: 'admin', displayName: '管理员', role: 'admin', status: 'enabled', permissions: [], email: null, lastLoginAt: null, createdAt: '2026-01-01', updatedAt: '2026-01-01' } }],
    ['/auth/webauthn/step-up/options', { challengeId: 'step-1', options: { challenge: 'ghi' }, expiresInSeconds: 300 }],
    ['/auth/webauthn/step-up/verify', { stepUpProof: '一次性证明', expiresInSeconds: 300 }],
    ['/auth/mfa/totp/disable', true],
    ['/auth/mfa/webauthn/enable', { recoveryCodes: Array.from({ length: 10 }, (_, i) => `TEST-${i}`) }],
    ['/auth/webauthn/credentials/7', true],
    ['/users/2/webauthn/reset', { revokedCount: 2 }],
    ['/users/2/mfa/reset', { reset: true }],
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
  await api.startAdminWebAuthnRegistration({ name: '第二因素密钥', kind: 'security_key', usage: 'second_factor', currentPassword: '仅测试' })
  await api.startAdminMfaWebAuthnLogin('仅测试票据')
  await api.completeMfaWebAuthnLogin({ mfaTicket: '仅测试票据', challengeId: 'mfa-1', response: { id: 'key', rawId: 'key', type: 'public-key', response: {}, clientExtensionResults: {} } })
  await api.startAdminWebAuthnStepUp({ currentPassword: '仅测试', action: 'mfa.webauthn.enable' })
  await api.verifyAdminWebAuthnStepUp({ challengeId: 'step-1', response: { id: 'key', rawId: 'key', type: 'public-key', response: {}, clientExtensionResults: {} } })
  await api.enableAdminWebAuthnMfa({ currentPassword: '仅测试', stepUpProof: '一次性证明' })
  await api.disableAdminTotp({ currentPassword: '仅测试', stepUpProof: '一次性证明' })
  await api.verifyAdminWebAuthnRegistration({ challengeId: 'register-1', response: { id: 'key', rawId: 'key', type: 'public-key', response: {}, clientExtensionResults: {} } })
  responses.set('/auth/webauthn/credentials/7', { id: '7', name: '改名', createdAt: '2026-01-01', lastUsedAt: null, deviceType: 'singleDevice', backedUp: false })
  await api.renameAdminWebAuthnCredential('7', '改名')
  responses.set('/auth/webauthn/credentials/7', true)
  await api.deleteAdminWebAuthnCredential('7', { currentPassword: '仅测试', recoveryCode: '测试恢复码' })
  assert.deepEqual(await api.resetUserWebAuthn('2', { currentPassword: '仅测试', reason: '密钥遗失' }), { revokedCount: 2 })
  await api.resetUserMfa('2', { currentPassword: '仅测试', stepUpProof: '一次性证明' })
  assert.ok(calls.some((call) => call.method === 'POST' && call.url === '/auth/webauthn/login/options' && Object.keys(call.data).length === 0))
  assert.ok(calls.some((call) => call.method === 'POST' && call.url === '/auth/webauthn/login/options' && call.data.captchaId === 'captcha-1' && call.data.code === '1234' && !('captchaCode' in call.data)))
  assert.ok(calls.some((call) => call.url === '/auth/webauthn/register/options' && call.data.usage === 'second_factor' && call.data.kind === 'security_key'))
  assert.ok(calls.some((call) => call.url === '/auth/webauthn/step-up/options' && call.data.action === 'mfa.webauthn.enable'))
  assert.ok(calls.some((call) => call.method === 'POST' && call.url === '/auth/webauthn/register/options' && call.data.kind === 'security_key' && call.data.code === '123456'))
  assert.ok(calls.some((call) => call.method === 'PATCH' && call.url === '/auth/webauthn/credentials/7' && Object.keys(call.data).join() === 'name'), '改名只能提交名称')
  assert.ok(calls.some((call) => call.method === 'DELETE' && call.url === '/auth/webauthn/credentials/7' && call.data.recoveryCode))
  assert.ok(calls.some((call) => call.method === 'POST' && call.url === '/users/2/webauthn/reset' && call.data.reason === '密钥遗失'))
  assert.ok(calls.some((call) => call.method === 'POST' && call.url === '/users/2/mfa/reset' && call.data.currentPassword === '仅测试' && call.data.stepUpProof === '一次性证明'))
  const authStore = api.useAuthStore(api.pinia)
  const storeLogin = await authStore.completeWebAuthnLogin({ challengeId: 'login-1', response: { id: 'key', rawId: 'key', type: 'public-key', response: {}, clientExtensionResults: {} } })
  assert.equal(storeLogin?.user.id, '1')
  assert.equal(authStore.isAuthenticated, true, 'WebAuthn 成功须进入管理端统一登录态')
  assert.equal(authStore.expiresAt, '2026-12-01')
  assert.equal(JSON.parse(values.get('y-link.auth.user')).id, '1', '登录态快照须沿用现有安全持久化入口')
  authStore.clearAuthState({ resetInitialized: true })
  await authStore.completeMfaWebAuthnLogin({ mfaTicket: '仅测试票据', challengeId: 'mfa-1', response: { id: 'key', rawId: 'key', type: 'public-key', response: {}, clientExtensionResults: {} } })
  assert.equal(authStore.isAuthenticated, true, '密码后实体密钥验证成功须进入统一登录态')
  authStore.clearAuthState({ resetInitialized: true })
  assert.equal(values.has('y-link.auth.user'), false)

  const findStoreWebAuthnCompletion = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(authStoreAst) === 'completeWebAuthnLogin') return node
    return ts.forEachChild(node, findStoreWebAuthnCompletion)
  }
  const storeWebAuthnCompletion = findStoreWebAuthnCompletion(authStoreAst)
  assert.ok(storeWebAuthnCompletion?.initializer, '须测试真实 Store 的密钥登录动作')
  const completionJavascript = ts.transpileModule(
    `const completeWebAuthnLogin = ${storeWebAuthnCompletion.initializer.getText(authStoreAst).replace("import('@/api/modules/admin-webauthn')", 'loadTestWebAuthnApi()')};`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
  ).outputText
  const makeWebAuthnCompletion = new Function('binding', `with (binding) { ${completionJavascript}; return completeWebAuthnLogin }`)
  let moduleLoads = 0
  let verifiedRequests = 0
  const appliedSessions = []
  let transitions = 0
  const completion = makeWebAuthnCompletion({
    loadTestWebAuthnApi: async () => {
      moduleLoads += 1
      if (moduleLoads === 1) throw new Error('密钥验证模块加载失败')
      return { verifyAdminWebAuthnLogin: async () => { verifiedRequests += 1; return login } }
    },
    setAuthState: (session) => appliedSessions.push(session),
    startPostLoginTransition: () => { transitions += 1 },
  })
  const completionPayload = { challengeId: 'retry-1', response: { id: 'key', rawId: 'key', type: 'public-key', response: {}, clientExtensionResults: {} } }
  await assert.rejects(completion(completionPayload), /密钥验证模块加载失败/)
  assert.equal(appliedSessions.length, 0, '动态模块加载失败不得建立登录态')
  assert.equal(transitions, 0, '动态模块加载失败不得进入系统过渡态')
  assert.equal((await completion(completionPayload))?.user.id, '1', '第二次尝试须重新加载模块并完成登录')
  assert.equal(moduleLoads, 2, '不得缓存首次失败的模块加载 Promise')
  assert.equal(verifiedRequests, 1)
  assert.equal(appliedSessions.length, 1)
  assert.equal(transitions, 1)
  const abortedCompletion = new AbortController()
  abortedCompletion.abort()
  assert.equal(await completion(completionPayload, abortedCompletion.signal), null)
  assert.equal(appliedSessions.length, 1, '最终请求被中止后不得写入登录态')

  const mfaSource = fs.readFileSync('src/components/account/AdminMfaDialog.vue', 'utf8')
  const mfaRecoveryInput = mfaSource.match(/<el-input\b(?=[^>]*v-model\.trim="form\.recoveryCode")[^>]*\/>/)?.[0]
  assert.ok(mfaRecoveryInput, '两步验证管理弹窗须保留恢复码输入框')
  assert.match(mfaRecoveryInput, /placeholder="单个恢复码，例如ABCD-EFGH-JKLM"/)
  assert.match(mfaRecoveryInput, /maxlength="32"/, '两步验证管理弹窗须允许服务端限长内的完整单个输入')
  assert.match(mfaRecoveryInput, /@paste="guardRecoveryCodePaste\(\$event, showAppWarning\)"/, '批量恢复码粘贴须在输入前拦截')
  assert.match(mfaSource, /@click="copyText\(code, '单条恢复码已复制'\)"/, '恢复码展示须可逐条复制')
  assert.match(mfaSource, /@click="copyText\(recoveryCodes\.join\('\\n'\), '全部恢复码已复制，请妥善保存'\)"/, '批量复制仍须包含全部恢复码')
  const mfaScript = mfaSource.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1]
  assert.ok(mfaScript)
  const mfaAst = ts.createSourceFile('AdminMfaDialog.ts', mfaScript, ts.ScriptTarget.Latest, true)
  const mfaCopyStatement = mfaAst.statements.find((statement) => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some((item) => item.name.getText(mfaAst) === 'copyText'))
  assert.ok(mfaCopyStatement)
  const mfaCopyJavascript = ts.transpileModule(mfaCopyStatement.getText(mfaAst), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  const mfaClipboard = []
  const mfaCopyMessages = []
  const mfaCopyText = new Function('binding', `with (binding) { ${mfaCopyJavascript}; return copyText }`)({
    navigator: { clipboard: { writeText: async (text) => { mfaClipboard.push(text) } } },
    showAppSuccess: (message) => { mfaCopyMessages.push(message) },
    showAppWarning: (message) => { mfaCopyMessages.push(message) },
  })
  await mfaCopyText(firstRecovery, '单条恢复码已复制')
  await mfaCopyText(`${firstRecovery}\n${secondRecovery}`, '全部恢复码已复制，请妥善保存')
  assert.deepEqual(mfaClipboard, [firstRecovery, `${firstRecovery}\n${secondRecovery}`])
  assert.equal(mfaCopyMessages.every((message) => !message.includes(firstRecovery) && !message.includes(secondRecovery)), true, '复制反馈不得回显恢复码')
  const mfaDisableStatement = mfaAst.statements.find((statement) => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some((item) => item.name.getText(mfaAst) === 'handleDisable'))
  assert.ok(mfaDisableStatement)
  const mfaDisableJavascript = ts.transpileModule(mfaDisableStatement.getText(mfaAst), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  const mfaRef = (value) => ({ value })
  let mfaStatusReloads = 0
  let mfaAuthClears = 0
  let mfaRedirects = 0
  let mfaCloseEvents = 0
  const mfaBinding = {
    form: { currentPassword: '仅测试密码', code: '', recoveryCode: '' }, stage: mfaRef('disable'), submitting: mfaRef(false), disableAllPending: mfaRef(false),
    ElMessageBox: { confirm: async () => undefined }, checkedFactor: async () => ({ stepUpProof: '仅测试证明' }),
    disableAdminMfa: async () => undefined, disableAdminTotp: async () => undefined,
    loadStatus: async () => { mfaStatusReloads += 1 }, authStore: { clearAuthState: () => { mfaAuthClears += 1 } },
    redirectToAdminLogin: () => { mfaRedirects += 1 }, emit: (event, visible) => { if (event === 'update:modelValue' && visible === false) mfaCloseEvents += 1 },
    showAppWarning: () => undefined, showAppError: () => undefined, showAppSuccess: () => undefined,
    isWebAuthnCancellation: () => false, extractErrorMessage: () => '测试错误',
  }
  const mfaDisable = new Function('binding', `with (binding) { ${mfaDisableJavascript}; return handleDisable }`)(mfaBinding)
  await mfaDisable()
  assert.equal(mfaStatusReloads, 0, '完全停用后服务端已吊销会话，不得再读取受保护状态')
  assert.equal(mfaAuthClears, 1, '完全停用后须清理本地登录态')
  assert.equal(mfaCloseEvents, 1, '完全停用后须关闭弹窗')
  assert.equal(mfaRedirects, 1, '完全停用后须前往登录页')
  mfaBinding.stage.value = 'disable-totp'
  mfaBinding.form.currentPassword = '仅测试密码'
  await mfaDisable()
  assert.equal(mfaStatusReloads, 1, '只关闭动态码后仍须刷新两步验证状态')

  const mfaConfirmStatement = mfaAst.statements.find((statement) => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some((item) => item.name.getText(mfaAst) === 'handleConfirmEnrollment'))
  assert.ok(mfaConfirmStatement)
  const mfaConfirmJavascript = ts.transpileModule(mfaConfirmStatement.getText(mfaAst), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  let confirmStatusLoads = 0
  const confirmMessages = []
  const confirmBinding = {
    form: { code: '123456' }, submitting: mfaRef(false), recoveryFinalPending: mfaRef(false), recoveryCodes: mfaRef([]), stage: mfaRef('enroll-scan'),
    normalizeCodeInput: (value) => value, confirmAdminMfaEnrollment: async () => ({ recoveryCodes: [] }),
    clearEnrollment: () => undefined, goToStage: (next) => { confirmBinding.stage.value = next },
    loadStatus: async () => { confirmStatusLoads += 1; confirmBinding.stage.value = 'status' },
    showAppWarning: () => undefined, showAppError: () => undefined, showAppSuccess: (message) => confirmMessages.push(message),
    normalizeRequestError: (error) => ({ message: error.message, status: 500 }),
  }
  const confirmEnrollment = new Function('binding', `with (binding) { ${mfaConfirmJavascript}; return handleConfirmEnrollment }`)(confirmBinding)
  await confirmEnrollment()
  assert.equal(confirmBinding.stage.value, 'status', '已有 key-only MFA 后补绑 TOTP 时没有新恢复码，不得显示空保存页')
  assert.equal(confirmStatusLoads, 1)
  assert.match(confirmMessages[0], /原恢复码.*有效/)

  const mfaWorkflowNames = ['goToStage', 'closeDialog', 'handleConfirmEnrollment', 'handleRegenerate', 'handleEnableKey', 'handleFinishRecoveryCodes']
  const mfaWorkflowSource = mfaWorkflowNames.map((name) => {
    const statement = mfaAst.statements.find((item) => ts.isVariableStatement(item)
      && item.declarationList.declarations.some((declaration) => declaration.name.getText(mfaAst) === name))
    assert.ok(statement, `缺少真实 MFA 函数 ${name}`)
    return statement.getText(mfaAst)
  }).join('\n')
  const mfaRouteCall = mfaAst.statements.find((statement) => ts.isExpressionStatement(statement)
    && ts.isCallExpression(statement.expression) && statement.expression.expression.getText(mfaAst) === 'onBeforeRouteLeave')
  assert.ok(mfaRouteCall)
  const mfaWorkflowJavascript = ts.transpileModule(`const routeGuard = ${mfaRouteCall.expression.arguments[0].getText(mfaAst)};\n${mfaWorkflowSource}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  const makeMfaActions = new Function('binding', `with (binding) { ${mfaWorkflowJavascript}; return { routeGuard, goToStage, closeDialog, handleConfirmEnrollment, handleRegenerate, handleEnableKey, handleFinishRecoveryCodes } }`)
  for (const flow of ['confirm', 'regenerate', 'enable']) {
    for (const outcome of ['success', 'failure']) {
      let settle
      let reject
      let finalCalls = 0
      let closeEvents = 0
      const finalPromise = new Promise((resolve, rejectPromise) => { settle = resolve; reject = rejectPromise })
      const binding = {
        stage: mfaRef(flow === 'confirm' ? 'enroll-scan' : flow === 'regenerate' ? 'regenerate' : 'enable-key'),
        submitting: mfaRef(false), disableAllPending: mfaRef(false), recoveryFinalPending: mfaRef(false), recoveryCodes: mfaRef([]),
        status: mfaRef({ mfaRequired: true, availableMethods: ['webauthn'] }),
        form: { currentPassword: '测试密码', code: '123456', recoveryCode: '', useWebAuthn: false },
        stepUpFlow: { cancel: () => undefined }, resetForm: () => undefined, clearEnrollment: () => undefined,
        normalizeCodeInput: (value) => value, checkedFactor: async () => ({}), obtainWebAuthnProof: async () => '证明',
        confirmAdminMfaEnrollment: () => { finalCalls += 1; return finalPromise },
        regenerateAdminMfaRecoveryCodes: () => { finalCalls += 1; return finalPromise },
        enableAdminWebAuthnMfa: () => { finalCalls += 1; return finalPromise },
        loadStatus: async () => { binding.stage.value = 'status' },
        emit: (event, value) => { if (event === 'update:modelValue' && value === false) closeEvents += 1 },
        showAppSuccess: () => undefined, showAppError: () => undefined, showAppWarning: () => undefined,
        normalizeRequestError: (error) => ({ message: error.message, status: 500 }),
        isWebAuthnCancellation: () => false, extractErrorMessage: () => '测试异常',
      }
      const actions = makeMfaActions(binding)
      const mfaRouter = createRouter({ history: createMemoryHistory(), routes: ['/dashboard', '/client/login'].map((path) => ({ path, component: {} })) })
      await mfaRouter.push('/dashboard')
      const removeGuard = mfaRouter.beforeEach(() => actions.routeGuard())
      const finalAction = flow === 'confirm' ? actions.handleConfirmEnrollment : flow === 'regenerate' ? actions.handleRegenerate : actions.handleEnableKey
      const pending = finalAction()
      for (let i = 0; i < 3; i += 1) await Promise.resolve()
      assert.equal(finalCalls, 1, `${flow} 应发送一次最终请求`)
      assert.ok(isNavigationFailure(await mfaRouter.push('/client/login')), `${flow} 最终请求在途时不得离页`)
      actions.closeDialog()
      actions.goToStage('status')
      assert.equal(closeEvents, 0, `${flow} 最终请求在途时不得关闭`)
      assert.notEqual(binding.stage.value, 'status', `${flow} 最终请求在途时不得切换阶段`)
      if (outcome === 'success') {
        settle({ recoveryCodes: Array.from({ length: 10 }, (_, index) => `NEW-${index}`) })
        await pending
        assert.equal(binding.stage.value, 'recovery-codes')
        assert.equal(binding.recoveryCodes.value.length, 10)
        await finalAction()
        assert.equal(finalCalls, 1, `${flow} 一次性恢复码展示期间不得重复提交`)
        actions.closeDialog()
        actions.goToStage('status')
        assert.equal(closeEvents, 0)
        assert.equal(binding.stage.value, 'recovery-codes')
        assert.ok(isNavigationFailure(await mfaRouter.push('/client/login')), `${flow} 恢复码确认保存前不得离页`)
        await actions.handleFinishRecoveryCodes()
        assert.equal(binding.recoveryCodes.value.length, 0)
      } else {
        reject(new Error('模拟最终请求失败'))
        await pending
        assert.equal(binding.recoveryFinalPending.value, false)
        assert.equal(binding.recoveryCodes.value.length, 0)
      }
      await mfaRouter.push('/client/login')
      assert.equal(mfaRouter.currentRoute.value.path, '/client/login', `${flow} ${outcome} 后须释放守卫`)
      removeGuard()
    }
  }

  // 从真实 SFC setup 中提取原函数运行，API 和确认框只在异步边界替身化。
  const dialogSource = fs.readFileSync('src/components/account/AdminWebAuthnDialog.vue', 'utf8')
  const dialogRecoveryInput = dialogSource.match(/<el-input\b(?=[^>]*v-model="form\.recoveryCode")[^>]*\/>/)?.[0]
  assert.ok(dialogRecoveryInput)
  assert.match(dialogRecoveryInput, /@paste="guardRecoveryCodePaste\(\$event, showAppWarning\)"/)
  assert.match(dialogSource, /@click="copyRecoveryCode\(code\)"/, '密钥弹窗须支持逐条复制恢复码')
  assert.match(dialogSource, /@click="copyRecoveryCodes">复制全部用于保存/, '批量复制须明确只用于保存')
  const dialogScript = dialogSource.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1]
  assert.ok(dialogScript)
  const dialogAst = ts.createSourceFile('AdminWebAuthnDialog.ts', dialogScript, ts.ScriptTarget.Latest, true)
  const copyDeclaration = (name) => {
    const statement = dialogAst.statements.find((candidate) => ts.isVariableStatement(candidate)
      && candidate.declarationList.declarations.some((item) => item.name.getText(dialogAst) === name))
    assert.ok(statement, `缺少恢复码复制函数 ${name}`)
    return statement.getText(dialogAst)
  }
  const copyJavascript = ts.transpileModule(`${copyDeclaration('copyRecoveryCode')}\n${copyDeclaration('copyRecoveryCodes')}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  const credentialClipboard = []
  const credentialCopyMessages = []
  const credentialCopyActions = new Function('binding', `with (binding) { ${copyJavascript}; return { copyRecoveryCode, copyRecoveryCodes } }`)({
    recoveryCodes: { value: [firstRecovery, secondRecovery] },
    navigator: { clipboard: { writeText: async (text) => { credentialClipboard.push(text) } } },
    showAppSuccess: (message) => { credentialCopyMessages.push(message) },
    showAppWarning: (message) => { credentialCopyMessages.push(message) },
  })
  await credentialCopyActions.copyRecoveryCode(secondRecovery)
  await credentialCopyActions.copyRecoveryCodes()
  assert.deepEqual(credentialClipboard, [secondRecovery, `${firstRecovery}\n${secondRecovery}`])
  assert.equal(credentialCopyMessages.every((message) => !message.includes(firstRecovery) && !message.includes(secondRecovery)), true, '密钥弹窗复制反馈不得回显恢复码')
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
  const functionSource = ['clearProof', 'clearSensitive', 'close', 'updateVisible', 'goToList', 'current', 'checkedName', 'checkedProof', 'addCredential', 'renameCredential', 'deleteCredential', 'acknowledgeRecoveryCodes']
    .map(declaration).join('\n')
  const javascript = ts.transpileModule(functionSource.replaceAll("await import('@simplewebauthn/browser')", 'await loadTestWebAuthnSdk()'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  const makeDialogActions = new Function('binding', `with (binding) { ${javascript}; return { clearSensitive, close, updateVisible, goToList, addCredential, renameCredential, deleteCredential, acknowledgeRecoveryCodes } }`)
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
    const form = { name: '测试密钥', kind: 'passkey', usage: 'passwordless', currentPassword: '旧密码', code: '', recoveryCode: '', useRecoveryCode: false, useWebAuthn: false }
    const stage = ref('add')
    const submitting = ref(false)
    const deletePending = ref(false)
    const confirmationPending = ref(false)
    const ceremonyPhase = ref('idle')
    const binding = {
      props, form, stage, submitting, deletePending, confirmationPending, ceremonyPhase,
      epoch: 1, confirmationSerial: 1,
      loadController: null,
      selected: ref(null), credentials: ref([]), recoveryCodes: ref([]), capabilities: ref(null), mfaStatus: ref({ enabled: false }),
      mfaPhase: ref('ready'), listError: ref(''), listLoading: ref(false),
      availability: ref({ available: true }),
      busy: { get value() { return submitting.value || confirmationPending.value || ceremonyPhase.value !== 'idle' } },
      committed: { get value() { return submitting.value || ceremonyPhase.value === 'verify' || binding.recoveryCodes.value.length > 0 } },
      ceremony: createWebAuthnFlow(() => undefined),
      stepUpCeremony: createWebAuthnFlow(() => undefined),
      resolveStepUpProof: async (proof) => proof,
      emit: (name, visible) => { if (name === 'update:modelValue' && visible === false) closeEvents += 1 },
      showAppWarning: () => undefined, showAppError: (message) => errorMessages.push(message), showAppSuccess: (message) => successMessages.push(message),
      isWebAuthnCancellation: () => false,
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
      resolveVerify: (value = { id: '新密钥' }) => resolveVerify(value),
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

  await managementRouter.push('/dashboard')
  const recoveryAdd = createDialogHarness()
  const removeRecoveryGuard = managementRouter.beforeEach((to, from) => {
    if (from.matched[0]?.path === '/' && to.matched[0]?.path !== '/') return makeDialogRouteGuard(recoveryAdd.binding)()
  })
  const registeringRecovery = recoveryAdd.actions.addCredential()
  recoveryAdd.resolveOptions({ challengeId: 'register-recovery', options: {} })
  for (let i = 0; i < 4; i += 1) await Promise.resolve()
  assert.equal(recoveryAdd.binding.ceremonyPhase.value, 'verify')
  assert.ok(isNavigationFailure(await managementRouter.push('/client/login')), '一次性恢复码注册最终请求在途时不得离页')
  recoveryAdd.actions.updateVisible(false)
  assert.equal(recoveryAdd.props.modelValue, true)
  recoveryAdd.resolveVerify({ id: 'first-factor', recoveryCodes: Array.from({ length: 10 }, (_, index) => `NEW-${index}`) })
  await registeringRecovery
  assert.equal(recoveryAdd.stage.value, 'recovery')
  assert.equal(recoveryAdd.binding.recoveryCodes.value.length, 10)
  recoveryAdd.actions.close()
  recoveryAdd.actions.goToList()
  assert.equal(recoveryAdd.stage.value, 'recovery', '一次性恢复码展示期间不得关闭或切换阶段')
  assert.ok(isNavigationFailure(await managementRouter.push('/client/login')), '一次性恢复码明确保存前不得离页')
  recoveryAdd.actions.acknowledgeRecoveryCodes()
  assert.equal(recoveryAdd.binding.recoveryCodes.value.length, 0)
  await managementRouter.push('/client/login')
  assert.equal(managementRouter.currentRoute.value.path, '/client/login')
  removeRecoveryGuard()

  await managementRouter.push('/dashboard')
  const recoveryFailed = createDialogHarness()
  const removeRecoveryFailureGuard = managementRouter.beforeEach((to, from) => {
    if (from.matched[0]?.path === '/' && to.matched[0]?.path !== '/') return makeDialogRouteGuard(recoveryFailed.binding)()
  })
  const failingRecovery = recoveryFailed.actions.addCredential()
  recoveryFailed.resolveOptions({ challengeId: 'register-failure', options: {} })
  for (let i = 0; i < 4; i += 1) await Promise.resolve()
  assert.ok(isNavigationFailure(await managementRouter.push('/client/login')))
  recoveryFailed.rejectVerify()
  await failingRecovery
  assert.equal(recoveryFailed.binding.ceremonyPhase.value, 'idle')
  await managementRouter.push('/client/login')
  assert.equal(managementRouter.currentRoute.value.path, '/client/login', '注册失败后须释放离页守卫')
  removeRecoveryFailureGuard()

  const keyOnlyAdd = createDialogHarness()
  keyOnlyAdd.binding.mfaStatus.value = { enabled: false, mfaRequired: true, availableMethods: ['webauthn'] }
  keyOnlyAdd.form.useWebAuthn = true
  keyOnlyAdd.form.usage = 'second_factor'
  keyOnlyAdd.form.kind = 'security_key'
  let keyOnlyPayload
  keyOnlyAdd.binding.resolveStepUpProof = async (proof) => ({ ...proof, stepUpProof: '仅测试证明' })
  keyOnlyAdd.binding.startAdminWebAuthnRegistration = (payload) => { keyOnlyPayload = payload; return new Promise((resolve) => { keyOnlyAdd.binding.resolveKeyOptions = resolve }) }
  const addingKey = keyOnlyAdd.actions.addCredential()
  for (let i = 0; i < 3; i += 1) await Promise.resolve()
  assert.equal(keyOnlyPayload.usage, 'second_factor')
  assert.equal(keyOnlyPayload.kind, 'security_key')
  assert.equal(keyOnlyPayload.stepUpProof, '仅测试证明', 'key-only 管理敏感操作须以强凭据复核')
  assert.equal(keyOnlyPayload.code, undefined)
  keyOnlyAdd.binding.resolveKeyOptions({ challengeId: 'key-only', options: {} })
  for (let i = 0; i < 4; i += 1) await Promise.resolve()
  keyOnlyAdd.resolveVerify({ id: '新密钥', recoveryCodes: Array.from({ length: 10 }, (_, index) => `TEST-${index}`) })
  await addingKey
  assert.equal(keyOnlyAdd.stage.value, 'recovery', '首次独立实体密钥启用后的恢复码须留在一次性展示阶段')
  assert.equal(keyOnlyAdd.binding.recoveryCodes.value.length, 10)

  const numericDelete = createDialogHarness()
  numericDelete.stage.value = 'delete'
  numericDelete.binding.selected.value = { id: 7, name: '数字主键密钥' }
  numericDelete.binding.mfaStatus.value = { mfaRequired: true, availableMethods: ['webauthn'] }
  numericDelete.form.useWebAuthn = true
  let credentialStepUpTarget
  const stepUpJavascript = ts.transpileModule(dialogSource.match(/const resolveStepUpProof = async[\s\S]*?\n}\n/)?.[0].replace("await import('@simplewebauthn/browser')", 'await loadTestWebAuthnSdk()') ?? '', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  numericDelete.binding.resolveStepUpProof = new Function('binding', `with (binding) { ${stepUpJavascript}; return resolveStepUpProof }`)(numericDelete.binding)
  numericDelete.binding.startAdminWebAuthnStepUp = async (request) => { credentialStepUpTarget = request.targetId; return { challengeId: 'test-step-up', options: {} } }
  numericDelete.binding.loadTestWebAuthnSdk = async () => ({ startAuthentication: async () => ({ id: 'assertion' }) })
  numericDelete.binding.verifyAdminWebAuthnStepUp = async () => ({ stepUpProof: 'test-proof' })
  numericDelete.binding.sdk = null
  const numericDeleting = numericDelete.actions.deleteCredential()
  numericDelete.resolveConfirm()
  await numericDeleting
  assert.equal(credentialStepUpTarget, '7', 'SQLite 数字凭据主键须作为十进制字符串进入 step-up 请求')

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
  for (const model of ['resetMfaForm', 'revokeWebAuthnForm']) {
    const recoveryInput = userSource.match(new RegExp(`<el-input\\b(?=[^>]*v-model="${model}\\.recoveryCode")[^>]*\\/>`))?.[0]
    assert.ok(recoveryInput, `${model} 须保留恢复码输入框`)
    assert.match(recoveryInput, /@paste="guardRecoveryCodePaste\(\$event, showAppWarning\)"/, `${model} 须阻止批量码粘贴`)
  }
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
  const userJavascript = ts.transpileModule(['clearRevokeWebAuthn', 'updateRevokeWebAuthnVisible', 'deactivateRevokeWebAuthn', 'getRevokeMfaNotice', 'handleSubmitRevokeWebAuthn'].map(userDeclaration).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  let resolveUserConfirm
  let userResetCalls = 0
  let userConfirmCalls = 0
  let userConfirmMessage = ''
  const userSuccessMessages = []
  const revokeForm = { currentPassword: '旧密码', code: '', recoveryCode: '', useRecoveryCode: false, useWebAuthn: false, reason: '密钥丢失' }
  const revokeTarget = { id: '2', displayName: '目标账号', webauthnCredentialsCount: 1, mfaRequired: true, mfaEnabled: false }
  const revokeBinding = {
    revokeWebAuthnEpoch: 1,
    revokeWebAuthnVisible: ref(true), revokeWebAuthnSubmitting: ref(false), revokeWebAuthnConfirmationPending: ref(false), revokeWebAuthnTarget: ref(revokeTarget),
    revokeWebAuthnActive: true, revokeWebAuthnMounted: true, revokeWebAuthnRefreshOnActivate: false,
    revokeWebAuthnMfaStatus: ref({ enabled: false }), revokeWebAuthnMfaPhase: ref('ready'), revokeWebAuthnForm: revokeForm,
    authStore: { isAdmin: true, currentUser: { id: '1' } }, ensurePermission: () => true,
    userStepUpFlow: createWebAuthnFlow(() => undefined),
    showAppError: () => undefined, showAppSuccess: (message) => { userSuccessMessages.push(message) },
    ElMessageBox: { confirm: (message) => { userConfirmCalls += 1; userConfirmMessage = message; return new Promise((resolve) => { resolveUserConfirm = resolve }) }, close: () => undefined },
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
  assert.match(userConfirmMessage, /两步验证仍会保留.*恢复码已用尽.*管理员另行重置两步验证/,
    '密钥是唯一方式时，二次确认必须说明另行重置两步验证的恢复路径')
  assert.match(userSuccessMessages.at(-1) ?? '', /两步验证仍会保留.*恢复码已用尽.*管理员另行重置两步验证/,
    '撤销成功反馈必须保留目标账号两步验证的处置说明')
  assert.match(userSource, /:title="`将撤销[^"`]*getRevokeMfaNotice\(revokeWebAuthnTarget\)[^"`]*`"/,
    '撤销对话框必须事先提示目标两步验证策略仍保留')

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

  revokeBinding.revokeWebAuthnActive = true
  revokeBinding.revokeWebAuthnVisible.value = true
  revokeBinding.revokeWebAuthnTarget.value = { id: 2, displayName: '数字主键账号', webauthnCredentialsCount: 1 }
  revokeBinding.revokeWebAuthnMfaPhase.value = 'ready'
  revokeBinding.revokeWebAuthnMfaStatus.value = { mfaRequired: true, availableMethods: ['webauthn'] }
  revokeForm.currentPassword = '仅测试密码'
  revokeForm.reason = '数字主键兼容'
  revokeForm.useWebAuthn = true
  let userStepUpTarget
  revokeBinding.obtainUserStepUp = async (_action, targetId) => { userStepUpTarget = targetId; return 'test-proof' }
  revokeBinding.resetUserWebAuthn = async () => ({ revokedCount: 1 })
  const numericUserReset = userActions.handleSubmitRevokeWebAuthn()
  resolveUserConfirm()
  await numericUserReset
  assert.equal(userStepUpTarget, '2', 'SQLite 数字用户主键须作为十进制字符串进入撤销密钥 step-up 请求')

  // 使用真实 Vue Router memory history 驱动登录页守卫；仅替身化浏览器认证器和网络回应。
  const loginSource = fs.readFileSync('src/views/auth/LoginView.vue', 'utf8')
  const loginRecoveryInput = loginSource.match(/<el-input\b(?=[^>]*v-model\.trim="mfaForm\.recoveryCode")[^>]*\/>/)?.[0]
  assert.ok(loginRecoveryInput, '登录第二步须保留恢复码输入框')
  assert.match(loginRecoveryInput, /placeholder="单个恢复码，例如ABCD-EFGH-JKLM"/)
  assert.match(loginRecoveryInput, /maxlength="32"/, '登录第二步须允许服务端限长内的完整单个输入')
  assert.match(loginRecoveryInput, /@paste="guardRecoveryCodePaste\(\$event, showAppWarning\)"/, '登录第二步须阻止多码粘贴')
  assert.match(loginSource, /使用已绑定的通行密钥或安全密钥完成验证/)
  assert.match(loginSource, /改用通行密钥或安全密钥/)
  const loginTemplate = loginSource.match(/<el-form[\s\S]*?<\/el-form>/)?.[0] ?? ''
  assert.doesNotMatch(loginTemplate, /<el-form[^>]*autocomplete="off"/, '登录表单须允许浏览器密码管理器识别')
  assert.match(loginTemplate, /name="username"[\s\S]*?autocomplete="username webauthn"/, '账号框须有稳定名称和 conditional WebAuthn 标记')
  assert.match(loginTemplate, /name="password"[\s\S]*?autocomplete="current-password"/, '密码框须有稳定名称和标准自动填充标记')
  assert.equal((loginTemplate.match(/@submit\.prevent="handleSubmit"/g) ?? []).length, 1)
  assert.doesNotMatch(loginTemplate, /@keyup\.enter="handleSubmit"|@click="handleSubmit"/, '登录只能从表单原生提交入口发起')
  assert.match(loginTemplate, /native-type="submit"/, '提交按钮须触发表单原生 submit')
  assert.match(loginTemplate, /<el-form[\s\S]*?:disabled="finalRequestPending"/, '最终请求在途必须冻结所有登录输入控件')
  const loginScript = loginSource.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1]
  assert.ok(loginScript)
  const loginAst = ts.createSourceFile('LoginView.ts', loginScript, ts.ScriptTarget.Latest, true)
  const finalWebAuthnCalls = []
  const collectFinalWebAuthnCalls = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(loginAst) === 'authStore'
      && node.expression.name.text === 'completeWebAuthnLogin') finalWebAuthnCalls.push(node)
    ts.forEachChild(node, collectFinalWebAuthnCalls)
  }
  collectFinalWebAuthnCalls(loginAst)
  assert.equal(finalWebAuthnCalls.length, 2, '条件式与主动密钥登录均须进入统一最终验证入口')
  assert.ok(finalWebAuthnCalls.every((call) => call.arguments.length === 1), '最终验证不得复用会被离页/隐藏事件中止的选项请求 signal')
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
  const loginFunctions = ['cancelWebAuthnLogin', 'handleWebAuthnLogin', 'handleVisibility', 'handleMfaSubmit', 'handleSubmit'].map(loginDeclaration).join('\n')
    .replaceAll("await import('@simplewebauthn/browser')", 'await loadTestWebAuthnSdk()')
  const loginJavascript = ts.transpileModule(`const routeGuard = ${routeCall.expression.arguments[0].getText(loginAst)};\n${loginFunctions}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  const makeLoginActions = new Function('binding', `with (binding) { ${loginJavascript}; return { routeGuard, cancelWebAuthnLogin, handleWebAuthnLogin, handleVisibility, handleMfaSubmit, handleSubmit } }`)
  for (const recoveryCode of ['ABCD-EFGH-JKLM', 'A'.repeat(32)]) {
    let submittedProof
    const recoveryBinding = {
      mfaChallenge: ref({ expiresAt: Date.now() + 60_000 }), mfaMode: ref('recovery_code'),
      mfaForm: { code: '', recoveryCode }, loginGate: createLoginAttemptGate(),
      submitPhase: ref('idle'), finalRequestPending: ref(false),
      authStore: { completeMfaLogin: async (proof) => { submittedProof = proof; return {} } },
      finishLogin: async () => undefined,
      resetMfaChallenge: () => undefined, showAppWarning: () => undefined,
      passwordHandoff: { discard: () => undefined },
    }
    await makeLoginActions(recoveryBinding).handleMfaSubmit('仅测试票据')
    assert.equal(submittedProof?.recoveryCode, recoveryCode, '单个恢复码须完整传至登录复核请求，不得前端截断')
  }
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
      passwordSaveSerial: 0,
      submitPhase: ref('idle'), webAuthnPhase, webAuthnVerifyPending, finalRequestPending: ref(false),
      loginGate: createLoginAttemptGate(), stopConditional: () => undefined,
      passwordHandoff: { discard: () => undefined }, webAuthnSdk: null,
      webAuthnBusy: { get value() { return webAuthnPhase.value !== 'idle' } },
      webAuthnAvailability: ref({ available: true }),
      captchaVisible: ref(false), captchaState: { captchaId: '' },
      form: { captcha: '', password: '旧密码', username: '测试账号' }, webAuthnHint: ref(''),
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
  failingLogin.rejectVerify(new Error('密钥验证模块加载失败'))
  await failing
  assert.equal(failingLogin.binding.webAuthnVerifyPending.value, false, '验证失败后须释放路由守卫')
  await router.push('/client/login')
  assert.equal(router.currentRoute.value.path, '/client/login', '验证失败后应允许离开')
  failingLogin.removeGuard()

  await router.push('/admin/login')
  let releaseValidation
  let releasePasswordLogin
  let validationCalls = 0
  let passwordCalls = 0
  const capturedPasswords = []
  const passwordForm = { username: '测试账号', password: '短期测试密码', captcha: '' }
  const passwordBinding = {
    passwordSaveSerial: 0, document: { visibilityState: 'visible' },
    submitPhase: ref('idle'), finalRequestPending: ref(false), webAuthnPhase: ref('idle'), webAuthnVerifyPending: ref(false),
    loginGate: createLoginAttemptGate(), stopConditional: () => undefined, webAuthnFlow: createWebAuthnFlow(() => undefined),
    passwordHandoff: { capture: (username, password) => { capturedPasswords.push({ username, password }) }, discard: () => undefined },
    mfaChallenge: ref(null), form: passwordForm, formRef: { value: { validate: () => { validationCalls += 1; return new Promise((resolve) => { releaseValidation = resolve }) } } },
    captchaVisible: ref(false), captchaState: { captchaId: '' }, securityHint: ref(''),
    authStore: { login: () => { passwordCalls += 1; return new Promise((resolve) => { releasePasswordLogin = resolve }) } },
    finishLogin: async () => router.push('/dashboard'),
    showAppWarning: () => undefined, showAppError: () => undefined,
    normalizeRequestError: (error) => ({ message: error.message, status: 500 }), applySecurityHintFromMessage: () => undefined,
    ensureCaptchaVisible: async () => undefined, refreshCaptcha: async () => undefined,
  }
  const passwordActions = makeLoginActions(passwordBinding)
  const removePasswordGuard = router.beforeEach(passwordActions.routeGuard)
  const firstPasswordSubmit = passwordActions.handleSubmit()
  await passwordActions.handleSubmit()
  assert.equal(validationCalls, 1, '异步表单校验尚未返回时重复提交不得再次校验或发请求')
  releaseValidation(true)
  for (let i = 0; i < 3; i += 1) await Promise.resolve()
  assert.equal(passwordCalls, 1)
  assert.ok(isNavigationFailure(await router.push('/client/login')), '密码首次最终请求在途也须阻止离页')
  passwordForm.username = '未验证的另一个账号'
  passwordForm.password = '未验证的新密码'
  releasePasswordLogin({ user: { id: '1' } })
  await firstPasswordSubmit
  assert.deepEqual(capturedPasswords, [{ username: '测试账号', password: '短期测试密码' }], '待保存凭据必须严格对应已被服务端接受的请求快照')
  assert.equal(passwordForm.password, '', '密码成功后必须清空登录表单原始密码')
  assert.equal(router.currentRoute.value.path, '/dashboard')
  removePasswordGuard()

  const hiddenPasswordScenario = async (mfaRequired) => {
    let releaseLogin
    let captureCalls = 0
    let storeCalls = 0
    let discarded = false
    const handoff = {
      capture: () => { captureCalls += 1; discarded = false },
      discard: () => { discarded = true },
      storeOnce: async () => { if (!discarded && captureCalls) storeCalls += 1 },
    }
    const binding = {
      passwordSaveSerial: 0, document: { visibilityState: 'visible' },
      conditionalPhase: ref('stopped'), usernameFocused: ref(false), stopConditional: () => undefined,
      submitPhase: ref('idle'), finalRequestPending: ref(false), webAuthnPhase: ref('idle'), webAuthnVerifyPending: ref(false),
      loginGate: createLoginAttemptGate(), webAuthnFlow: createWebAuthnFlow(() => undefined), passwordHandoff: handoff,
      mfaChallenge: ref(null), mfaMode: ref('totp'), mfaForm: { code: '123456', recoveryCode: '' },
      form: { username: '已验证账号', password: '仅测试密码', captcha: '' }, formRef: { value: { validate: async () => true } },
      captchaVisible: ref(false), captchaState: { captchaId: '' }, securityHint: ref(''),
      authStore: { login: () => new Promise((resolve) => { releaseLogin = resolve }), completeMfaLogin: async () => ({ user: { id: '1' } }) },
      finishLogin: async () => { await handoff.storeOnce() }, resetCaptchaState: () => undefined,
      resetMfaChallenge: () => undefined, mfaExpiryTimer: null,
      showAppWarning: () => undefined, showAppError: () => undefined,
      normalizeRequestError: (error) => ({ message: error.message, status: 500 }), applySecurityHintFromMessage: () => undefined,
      ensureCaptchaVisible: async () => undefined, refreshCaptcha: async () => undefined,
    }
    const actions = makeLoginActions(binding)
    const submitting = actions.handleSubmit()
    for (let i = 0; i < 3; i += 1) await Promise.resolve()
    assert.equal(binding.finalRequestPending.value, true)
    binding.document.visibilityState = 'hidden'
    actions.handleVisibility()
    binding.document.visibilityState = 'visible'
    actions.handleVisibility()
    releaseLogin(mfaRequired
      ? { mfaRequired: true, mfaTicket: '短期票据', expiresInSeconds: 300, availableMethods: ['totp'] }
      : { user: { id: '1' } })
    await submitting
    if (mfaRequired) await actions.handleMfaSubmit('短期票据')
    assert.equal(captureCalls, 0, '最终密码请求在途曾隐藏后不得重新暂存凭据')
    assert.equal(storeCalls, 0, '最终密码请求在途曾隐藏后完整登录也不得触发密码保存')
    if (binding.mfaExpiryTimer) clearTimeout(binding.mfaExpiryTimer)
  }
  await hiddenPasswordScenario(false)
  await hiddenPasswordScenario(true)

  const conditionalFunctions = ['clearConditionalExpiry', 'stopConditional', 'startConditionalLogin']
    .map(loginDeclaration).join('\n').replaceAll("await import('@simplewebauthn/browser')", 'await loadTestWebAuthnSdk()')
  const makeConditionalActions = new Function('binding', `with (binding) { ${ts.transpileModule(conditionalFunctions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}; return { stopConditional, startConditionalLogin } }`)
  let releaseProbe
  let optionCalls = 0
  const conditionalErrors = []
  const conditionalBinding = {
    conditionalId: null, conditionalProbeSerial: 0, conditionalExpiryTimer: null,
    conditionalPhase: ref('unavailable'), mfaChallenge: ref(null), finalRequestPending: ref(false),
    webAuthnBusy: ref(false), webAuthnPhase: ref('idle'), webAuthnVerifyPending: ref(false),
    document: { visibilityState: 'visible' },
    canUseConditionalMediation: () => new Promise((resolve) => { releaseProbe = resolve }),
    webAuthnFlow: createWebAuthnFlow(() => undefined), loginGate: createLoginAttemptGate(),
    startAdminWebAuthnLogin: async () => { optionCalls += 1; return { challengeId: 'conditional', options: {}, expiresInSeconds: 300 } },
    loadTestWebAuthnSdk: async () => ({ startAuthentication: async () => ({ id: '候选响应' }) }),
    authStore: { completeWebAuthnLogin: async () => { throw new Error('最终验证网络失败') } },
    normalizeRequestError: (error) => ({ message: error.message, status: 500 }),
    showAppError: (message) => conditionalErrors.push(message), applySecurityHintFromMessage: () => undefined,
    finishLogin: async () => undefined,
  }
  const conditionalActions = makeConditionalActions(conditionalBinding)
  const lateProbe = conditionalActions.startConditionalLogin()
  conditionalBinding.document.visibilityState = 'hidden'
  conditionalActions.stopConditional()
  releaseProbe(true)
  await lateProbe
  assert.equal(optionCalls, 0, '页面隐藏后迟到的能力探针不得再领取挑战')
  conditionalBinding.document.visibilityState = 'visible'
  conditionalBinding.canUseConditionalMediation = async () => true
  await conditionalActions.startConditionalLogin()
  assert.equal(optionCalls, 1)
  assert.deepEqual(conditionalErrors, ['最终验证网络失败'], '条件式候选最终验证失败须反馈真实错误')
  assert.equal(conditionalBinding.finalRequestPending.value, false)
  assert.equal(conditionalBinding.conditionalPhase.value, 'stopped')
  assert.equal(conditionalBinding.webAuthnFlow.isCurrent(2), false, '失败后旧浏览器认证仪式须结束')

  console.log('通过：WebAuthn 能力、API、Store、真实 HTTP 拦截器、组件竞态和登录路由守卫')
} finally {
  delete globalThis.window
  delete globalThis.CustomEvent
}
