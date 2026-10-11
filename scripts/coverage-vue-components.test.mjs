/** 用现有编译器执行 PR 认证组件的原始 SFC，源映射保留到 .vue 行。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test, { beforeEach } from 'node:test'
import ts from 'typescript'
import { parse, compileScript } from '@vue/compiler-sfc'
import { rolldown } from 'rolldown'
import { createSSRApp, h } from 'vue'
import { renderToString } from '@vue/server-renderer'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputRoot = path.join(projectRoot, 'tmp', 'coverage-vue-components')
fs.mkdirSync(outputRoot, { recursive: true })

const status = {
  mfaRequired: true, totpEnabled: true, availableMethods: ['totp', 'recovery_code'],
  recoveryCodesRemaining: 6, enabledAt: '2026-01-01T00:00:00.000Z',
}
const credential = { id: 'credential-1', name: '测试密钥', usage: 'passwordless', kind: 'passkey' }
const calls = { warnings: [], successes: [], emissions: [], passwordHandoff: [], api: [], redirects: 0, routes: [] }
const apiOverrides = new Map()
const loginSuccess = { user: { id: 'self', displayName: '隔离管理员', role: 'admin' } }
const apiCall = async (name, args, fallback) => {
  calls.api.push([name, ...args])
  return apiOverrides.has(name) ? apiOverrides.get(name)(...args) : fallback
}
const sdk = {
  startRegistration: async (...args) => apiCall('sdk.startRegistration', args, { id: 'isolated-registration' }),
  startAuthentication: async (...args) => apiCall('sdk.startAuthentication', args, { id: 'isolated-authentication' }),
  WebAuthnAbortService: { cancelCeremony: () => calls.api.push(['sdk.cancelCeremony']) },
}
globalThis.__pr153CoverageSdk = sdk
beforeEach(() => {
  for (const value of Object.values(calls)) if (Array.isArray(value)) value.length = 0
  calls.redirects = 0
  apiOverrides.clear()
})
const flow = () => ({
  start: () => ({ id: 1, signal: new AbortController().signal }),
  isCurrent: () => true, cancel: () => {}, finish: () => {},
})
const gate = () => ({
  begin: () => ({ id: 1 }), isCurrent: () => true, commit: () => true,
  settle: () => {}, cancel: () => {}, isCommitted: () => false,
})
const authStore = {
  isAdmin: true, isAuthenticated: false, currentUser: { id: 'self', username: 'admin', role: 'admin' },
  login: async (...args) => apiCall('login', args, { mfaRequired: true, mfaTicket: '隔离测试票据', availableMethods: ['totp'], expiresInSeconds: 30 }),
  completeMfaLogin: async (...args) => apiCall('completeMfaLogin', args, loginSuccess),
  completeMfaWebAuthnLogin: async (...args) => apiCall('completeMfaWebAuthnLogin', args, loginSuccess),
  completeWebAuthnLogin: async (...args) => apiCall('completeWebAuthnLogin', args, loginSuccess),
  warmupPostLoginEntry: async (...args) => apiCall('warmupPostLoginEntry', args),
  clearAuth: () => {},
  clearAuthState: () => { calls.api.push(['clearAuthState']) },
}
const slotComponent = {
  props: ['modelValue'],
  setup(props, { slots }) {
    return () => props.modelValue === false ? null
      : h('div', Object.entries(slots).flatMap(([, render]) => render({ isPhone: false, isTablet: false })))
  },
}
const special = {
  'vue-router': {
    onBeforeRouteLeave: () => {}, useRoute: () => ({ query: {} }),
    useRouter: () => ({ push: async (path) => { calls.routes.push(['push', path]) }, replace: async (path) => { calls.routes.push(['replace', path]) } }),
  },
  'element-plus': { ElMessageBox: {
    close: () => {},
    confirm: async (...args) => apiCall('message.confirm', args, 'confirm'),
    alert: async (...args) => apiCall('message.alert', args, 'confirm'),
  } },
  '@/store': { useAuthStore: () => authStore },
  '@/store/pinia': { default: {} },
  '@/components/common': new Proxy({}, { get: () => slotComponent }),
  '@/composables/usePermissionAction': { usePermissionAction: () => ({ hasPermission: () => true, ensurePermission: () => true }) },
  '@/composables/useStableRequest': { useStableRequest: () => ({
    run: async (_key, callback) => callback(), cancel: () => {},
    runLatest: async ({ executor, onSuccess, onError, onFinally }) => {
      try { onSuccess(await executor(new AbortController().signal)) } catch (error) { onError(error) } finally { onFinally() }
    },
  }) },
  '@/utils/list': {
    createPaginatedListState: () => ({ records: [], list: [], total: 0, loading: false, query: { page: 1, pageSize: 10 } }),
    applyPaginatedResult: (list, result) => { list.records = result.records; list.total = result.total },
  },
  '@/utils/admin-webauthn': {
    assessWebAuthnAvailability: () => ({ available: true, message: '' }),
    createWebAuthnFlow: flow, createLoginAttemptGate: gate, isWebAuthnCancellation: () => false,
  },
  '@/utils/admin-password-credential': {
    createPasswordCredentialHandoff: () => ({
      capture: (...args) => calls.passwordHandoff.push(args), discard: () => {}, storeOnce: async () => {},
    }),
  },
  '@/api/modules/admin-mfa': {
    getAdminMfaStatus: async (...args) => apiCall('getAdminMfaStatus', args, status),
    startAdminMfaEnrollment: async (...args) => apiCall('startAdminMfaEnrollment', args, { secret: 'TESTSECRET', otpauthUri: 'otpauth://totp/isolated' }),
    confirmAdminMfaEnrollment: async (...args) => apiCall('confirmAdminMfaEnrollment', args, { recoveryCodes: ['隔离测试恢复码'] }),
    disableAdminTotp: async (...args) => apiCall('disableAdminTotp', args),
    disableAdminMfa: async (...args) => apiCall('disableAdminMfa', args),
    regenerateAdminMfaRecoveryCodes: async (...args) => apiCall('regenerateAdminMfaRecoveryCodes', args, { recoveryCodes: ['新恢复码'] }),
    enableAdminWebAuthnMfa: async (...args) => apiCall('enableAdminWebAuthnMfa', args, { recoveryCodes: ['密钥恢复码'] }),
  },
  '@/api/modules/admin-webauthn': {
    getAdminWebAuthnCredentials: async () => [credential],
    getAdminWebAuthnCapabilities: async (...args) => apiCall('getAdminWebAuthnCapabilities', args, { enabled: true }),
    renameAdminWebAuthnCredential: async (...args) => apiCall('renameAdminWebAuthnCredential', args),
    startAdminWebAuthnRegistration: async (...args) => apiCall('startAdminWebAuthnRegistration', args, { challengeId: 'registration-challenge', options: { challenge: 'isolated' } }),
    verifyAdminWebAuthnRegistration: async (...args) => apiCall('verifyAdminWebAuthnRegistration', args, { recoveryCodes: [] }),
    deleteAdminWebAuthnCredential: async (...args) => apiCall('deleteAdminWebAuthnCredential', args),
    startAdminWebAuthnStepUp: async (...args) => apiCall('startAdminWebAuthnStepUp', args, { challengeId: 'step-up-challenge', options: { challenge: 'isolated' } }),
    verifyAdminWebAuthnStepUp: async (...args) => apiCall('verifyAdminWebAuthnStepUp', args, { stepUpProof: 'isolated-step-up-proof' }),
    startAdminWebAuthnLogin: async (...args) => apiCall('startAdminWebAuthnLogin', args, { challengeId: 'direct-challenge', options: { challenge: 'isolated' }, expiresInSeconds: 30 }),
    startAdminMfaWebAuthnLogin: async (...args) => apiCall('startAdminMfaWebAuthnLogin', args, { challengeId: 'mfa-challenge', options: { challenge: 'isolated' } }),
  },
  '@/api/modules/user': {
    getUserList: async (...args) => apiCall('getUserList', args, { records: [], total: 0 }),
    resetUserWebAuthn: async (...args) => apiCall('resetUserWebAuthn', args, { revokedCount: 1 }),
    resetUserMfa: async (...args) => apiCall('resetUserMfa', args),
  },
  '@/api/modules/auth': {
    ADMIN_MFA_TICKET_EXPIRED_REASON: 'ADMIN_MFA_TICKET_EXPIRED', ROLE_LABEL_MAP: { admin: '管理员' },
    getAdminCaptcha: async (...args) => apiCall('getAdminCaptcha', args, { captchaId: 'captcha-1', captchaSvg: '<svg/>', expiresInSeconds: 60 }),
  },
  '@/constants/app-meta': { APP_META: { name: 'Y-Link' } },
  '@/router': { resolveDefaultManagementRedirect: () => '/dashboard', resolveSafeRedirect: () => '/dashboard' },
  '@/utils/app-alert': {
    showAppWarning: (message) => calls.warnings.push(message),
    showAppError: (message) => calls.warnings.push(message), showAppSuccess: (message) => calls.successes.push(message),
  },
  '@/utils/error': {
    extractErrorMessage: (error) => String(error),
    normalizeRequestError: (error) => ({ message: error?.message ?? String(error), status: error?.status ?? 0 }),
    extractRequestErrorReason: (error) => error?.reason ?? '',
  },
  '@/utils/admin-mfa-recovery-code': { guardRecoveryCodePaste: () => {} },
  '@/utils/auth-navigation': { redirectToAdminLogin: () => { calls.redirects += 1 } },
  '@/views/system/user-governance.helpers': {
    accountTypeDescriptions: {}, roleOptions: [], getAccountTypeDescription: () => '',
    getGovernancePermissionLabels: () => [], getRoleTagType: () => 'info', getStatusTagType: () => 'info',
  },
}

const fallback = () => undefined
const getStub = (source, name) => {
  const configured = special[source]?.[name]
  if (configured !== undefined) return configured
  if (source.startsWith('@/components/') || source.endsWith('.vue') || source === '@element-plus/icons-vue') return slotComponent
  if (source === '@/api/modules/admin-mfa' || source === '@/api/modules/admin-webauthn') return async () => ({})
  return fallback
}
globalThis.__pr153CoverageStub = getStub
globalThis.document = { visibilityState: 'visible' }

const components = [
  'src/components/account/AdminMfaDialog.vue',
  'src/components/account/AdminWebAuthnDialog.vue',
  'src/views/auth/LoginView.vue',
  'src/views/system/UserManageView.vue',
]

const loaded = new Map()
for (const relativeSource of components) {
  const sourcePath = path.join(projectRoot, relativeSource)
  const source = fs.readFileSync(sourcePath, 'utf8')
  const parsed = parse(source, { filename: sourcePath, sourceMap: true })
  assert.equal(parsed.errors.length, 0, `${relativeSource} 必须能解析`)
  const imports = new Map()
  const variants = {}
  const modes = relativeSource.includes('/components/account/') ? ['setup', 'ssr'] : ['setup']
  for (const mode of modes) {
    const compiled = compileScript(parsed.descriptor, {
      id: `pr153-${mode}-${path.basename(sourcePath)}`,
      sourceMap: true, inlineTemplate: mode === 'ssr',
      ...(mode === 'ssr' ? { templateOptions: { ssr: true } } : {}),
    })
    assert.ok(compiled.map, `${relativeSource} ${mode} 必须保留源码映射`)
    const tree = ts.createSourceFile(sourcePath, compiled.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    for (const statement of tree.statements) {
      if (!ts.isImportDeclaration(statement) || !statement.importClause) continue
      const specifier = statement.moduleSpecifier.text
      const names = imports.get(specifier) ?? new Set()
      if (statement.importClause.name) names.add('default')
      const bindings = statement.importClause.namedBindings
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) names.add((element.propertyName ?? element.name).text)
      }
      imports.set(specifier, names)
    }
    const bundle = await rolldown({
      input: sourcePath,
      external: (specifier) => specifier === 'vue' || specifier === 'dayjs'
        || specifier === 'vue/server-renderer' || specifier === 'qrcode',
      plugins: [{
        name: '真实 SFC 覆盖率测试依赖隔离',
        resolveId(specifier) {
          if (specifier === sourcePath) return sourcePath
          if (specifier === '@simplewebauthn/browser') return '\0coverage:sdk'
          if (specifier.startsWith('@/') || specifier === 'vue-router' || specifier === 'element-plus'
            || specifier === '@element-plus/icons-vue' || specifier.endsWith('.vue')) return `\0coverage:${specifier}`
        },
        load(id) {
          if (id === sourcePath) return { code: compiled.content, map: compiled.map, moduleType: 'ts' }
          if (!id.startsWith('\0coverage:')) return
          if (id === '\0coverage:sdk') return [
            'export const startRegistration = (...args) => globalThis.__pr153CoverageSdk.startRegistration(...args)',
            'export const startAuthentication = (...args) => globalThis.__pr153CoverageSdk.startAuthentication(...args)',
            'export const WebAuthnAbortService = globalThis.__pr153CoverageSdk.WebAuthnAbortService',
          ].join('\n')
          const specifier = id.slice('\0coverage:'.length)
          const names = imports.get(specifier) ?? new Set(['default'])
          return [...names].map((name) => name === 'default'
            ? `export default globalThis.__pr153CoverageStub(${JSON.stringify(specifier)}, 'default')`
            : `export const ${name} = globalThis.__pr153CoverageStub(${JSON.stringify(specifier)}, ${JSON.stringify(name)})`).join('\n')
        },
      }],
    })
    const output = path.join(outputRoot, `${path.basename(sourcePath, '.vue')}-${mode}.mjs`)
    await bundle.write({ file: output, format: 'esm', sourcemap: true, codeSplitting: false })
    await bundle.close()
    variants[mode] = (await import(pathToFileURL(output).href)).default
  }
  loaded.set(relativeSource, { ...variants, source })
}

const setup = async (relativeSource, props = { modelValue: false }) => {
  const component = loaded.get(relativeSource).setup
  let state
  await renderToString(createSSRApp({
    setup() {
      state = component.setup(props, {
        emit: (...args) => calls.emissions.push(args), expose: () => {},
      })
      return () => h('div')
    },
  }))
  return state
}

test('密钥弹窗的添加、改名、删除和关闭保持真实阶段及内存清理行为', async () => {
  const state = await setup('src/components/account/AdminWebAuthnDialog.vue')
    state.capabilities.value = { enabled: true }
    state.capabilitiesPhase.value = 'ready'
    state.openAdd()
    assert.equal(state.stage.value, 'add')
    state.openRename(credential)
    assert.equal(state.stage.value, 'rename')
    assert.equal(state.form.name, credential.name)
    state.openDelete(credential)
    assert.equal(state.stage.value, 'delete')
    state.close()
    assert.equal(state.stage.value, 'list')
    assert.deepEqual(calls.emissions.at(-1), ['update:modelValue', false])
})

test('密钥弹窗先校验名称和本人复核方式，错误输入不会发起请求', async () => {
  const state = await setup('src/components/account/AdminWebAuthnDialog.vue')
  state.mfaPhase.value = 'ready'
  state.mfaStatus.value = status
  assert.equal(state.checkedName(), null)
  assert.match(calls.warnings.at(-1), /名称/)
  state.form.name = '  测试密钥  '
  assert.equal(state.checkedName(), '测试密钥')
  assert.equal(state.checkedProof(), null)
  assert.match(calls.warnings.at(-1), /当前密码/)
  state.form.currentPassword = '隔离测试输入'
  state.form.code = '12 3456'
  assert.deepEqual(state.checkedProof(), { currentPassword: '隔离测试输入', code: '123456' })
  state.form.useRecoveryCode = true
  state.form.recoveryCode = ''
  assert.equal(state.checkedProof(), null)
  assert.match(calls.warnings.at(-1), /恢复码/)
})

test('直接添加密钥按选定用途提交挑战并仅在服务端核验成功后回列表', async () => {
  const state = await setup('src/components/account/AdminWebAuthnDialog.vue', { modelValue: true })
  state.capabilities.value = { enabled: true }
  state.capabilitiesPhase.value = 'ready'
  state.mfaStatus.value = status
  state.mfaPhase.value = 'ready'
  state.openAdd()
  assert.equal(state.stage.value, 'add')
  state.form.name = '  新通行密钥  '
  state.form.currentPassword = '隔离测试密码'
  state.form.code = '123 456'
  await state.addCredential()
  const challenge = calls.api.find(([name]) => name === 'startAdminWebAuthnRegistration')
  assert.deepEqual(challenge[1], {
    name: '新通行密钥', kind: 'passkey', usage: 'passwordless',
    currentPassword: '隔离测试密码', code: '123456',
  })
  assert.ok(challenge[2].signal instanceof AbortSignal)
  assert.ok(calls.api.some(([name]) => name === 'sdk.startRegistration'))
  const verified = calls.api.find(([name]) => name === 'verifyAdminWebAuthnRegistration')
  assert.equal(verified[1].challengeId, 'registration-challenge')
  assert.equal(verified.length, 2, '最终核验请求不得附加可被关闭页面中止的 signal')
  assert.equal(state.stage.value, 'list')
  assert.equal(state.form.currentPassword, '')
  assert.match(calls.successes.at(-1), /新通行密钥/)
})

test('密钥注册最终请求在途冻结关闭，恢复码必须确认保存后才清空', async () => {
  let finishVerification
  apiOverrides.set('verifyAdminWebAuthnRegistration', () => new Promise((resolve) => { finishVerification = resolve }))
  const state = await setup('src/components/account/AdminWebAuthnDialog.vue', { modelValue: true })
  state.capabilities.value = { enabled: true }
  state.mfaStatus.value = status
  state.mfaPhase.value = 'ready'
  state.openAdd()
  state.form.name = '恢复测试密钥'
  state.form.currentPassword = '隔离测试密码'
  state.form.code = '123456'
  const pending = state.addCredential()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(state.ceremonyPhase.value, 'verify')
  const emissions = calls.emissions.length
  state.close()
  assert.equal(calls.emissions.length, emissions)
  finishVerification({ recoveryCodes: ['仅展示一次的恢复码'] })
  await pending
  assert.equal(state.stage.value, 'recovery')
  assert.deepEqual(state.recoveryCodes.value, ['仅展示一次的恢复码'])
  state.close()
  assert.equal(calls.emissions.length, emissions)
  state.acknowledgeRecoveryCodes()
  assert.equal(state.stage.value, 'list')
  assert.deepEqual(state.recoveryCodes.value, [])
})

test('仅密钥可复核的账号添加密钥时完成本人 StepUp，并拒绝错误用途组合', async () => {
  const state = await setup('src/components/account/AdminWebAuthnDialog.vue', { modelValue: true })
  state.capabilities.value = { enabled: true }
  state.mfaStatus.value = { ...status, availableMethods: ['webauthn'] }
  state.mfaPhase.value = 'ready'
  state.openAdd()
  assert.equal(state.form.useWebAuthn, true)
  state.form.name = '强密钥'
  state.form.currentPassword = '隔离测试密码'
  state.form.usage = 'second_factor'
  state.form.kind = 'passkey'
  await state.addCredential()
  assert.match(calls.warnings.at(-1), /安全密钥类型/)
  assert.equal(calls.api.some(([name]) => name === 'startAdminWebAuthnRegistration'), false)
  state.form.kind = 'security_key'
  await state.addCredential()
  const proofChallenge = calls.api.find(([name]) => name === 'startAdminWebAuthnStepUp')
  assert.equal(proofChallenge[1].action, 'webauthn.register')
  assert.ok(calls.api.some(([name]) => name === 'verifyAdminWebAuthnStepUp'))
  const registration = calls.api.find(([name]) => name === 'startAdminWebAuthnRegistration')
  assert.equal(registration[1].stepUpProof, 'isolated-step-up-proof')
  assert.equal(registration[1].usage, 'second_factor')
  assert.equal(registration[1].kind, 'security_key')
})

test('改名与删除密钥分别遵守当前账户会话语义，取消确认不会调用删除接口', async () => {
  const state = await setup('src/components/account/AdminWebAuthnDialog.vue', { modelValue: true })
  state.mfaStatus.value = status
  state.mfaPhase.value = 'ready'
  state.openRename(credential)
  state.form.name = '  更清晰的名称  '
  await state.renameCredential()
  assert.deepEqual(calls.api.find(([name]) => name === 'renameAdminWebAuthnCredential').slice(0, 3),
    ['renameAdminWebAuthnCredential', credential.id, '更清晰的名称'])
  assert.equal(state.stage.value, 'list')
  state.openDelete(credential)
  state.form.currentPassword = '隔离测试密码'
  state.form.code = '123456'
  apiOverrides.set('message.confirm', () => Promise.reject('cancel'))
  await state.deleteCredential()
  assert.equal(calls.api.some(([name]) => name === 'deleteAdminWebAuthnCredential'), false)
  apiOverrides.delete('message.confirm')
  await state.deleteCredential()
  const deletion = calls.api.find(([name]) => name === 'deleteAdminWebAuthnCredential')
  assert.equal(deletion[1], credential.id)
  assert.deepEqual(deletion[2], { currentPassword: '隔离测试密码', code: '123456' })
  assert.ok(calls.api.some(([name]) => name === 'clearAuthState'))
  assert.equal(calls.redirects, 1)
  assert.equal(state.form.currentPassword, '')
})

test('两步验证弹窗阻止恢复码未保存时关闭，并按阶段清理', async () => {
  const state = await setup('src/components/account/AdminMfaDialog.vue')
    state.goToStage('enroll-password')
    assert.equal(state.dialogTitle.value, '开启两步验证')
    state.recoveryCodes.value = ['隔离测试恢复码']
    const count = calls.emissions.length
    state.closeDialog()
    assert.equal(calls.emissions.length, count)
    state.recoveryCodes.value = []
    state.handleClosed()
    assert.equal(state.stage.value, 'status')
    state.closeDialog()
    assert.deepEqual(calls.emissions.at(-1), ['update:modelValue', false])
})

test('两步验证绑定完成后仅一次展示恢复码，确认保存才回到状态页', async () => {
  const state = await setup('src/components/account/AdminMfaDialog.vue')
  state.stage.value = 'enroll-scan'
  state.form.code = '123 456'
  await state.handleConfirmEnrollment()
  assert.deepEqual(calls.api.at(-1), ['confirmAdminMfaEnrollment', '123456'])
  assert.equal(state.stage.value, 'recovery-codes')
  assert.deepEqual(state.recoveryCodes.value, ['隔离测试恢复码'])
  await state.handleFinishRecoveryCodes()
  assert.deepEqual(state.recoveryCodes.value, [])
  assert.equal(state.stage.value, 'status')
})

test('两步验证关闭动态码时要求本人密码与六位动态码', async () => {
  const state = await setup('src/components/account/AdminMfaDialog.vue')
  state.status.value = status
  state.goToStage('disable-totp')
  await state.handleDisable()
  assert.match(calls.warnings.at(-1), /当前登录密码/)
  state.form.currentPassword = '隔离测试输入'
  state.form.code = '12 3456'
  await state.handleDisable()
  assert.deepEqual(calls.api.find(([name]) => name === 'disableAdminTotp')[1], { currentPassword: '隔离测试输入', code: '123456' })
  assert.equal(state.form.currentPassword, '')
})

test('两步验证绑定获取秘钥并生成二维码，过期确认返回状态页且清理秘钥', async () => {
  const state = await setup('src/components/account/AdminMfaDialog.vue')
  state.goToStage('enroll-password')
  await state.handleStartEnrollment()
  assert.match(calls.warnings.at(-1), /当前登录密码/)
  state.form.currentPassword = '隔离测试密码'
  await state.handleStartEnrollment()
  assert.equal(state.stage.value, 'enroll-scan')
  assert.equal(state.enrollment.secret, 'TESTSECRET')
  assert.equal(state.groupedSecret.value, 'TEST SECR ET')
  assert.equal(calls.api.find(([name]) => name === 'startAdminMfaEnrollment')[1], '隔离测试密码')
  apiOverrides.set('confirmAdminMfaEnrollment', () => { throw Object.assign(new Error('绑定已过期'), { status: 409 }) })
  state.form.code = '123456'
  await state.handleConfirmEnrollment()
  assert.equal(state.stage.value, 'status')
  assert.equal(state.enrollment.secret, '')
  assert.equal(state.form.code, '')
  assert.match(calls.warnings.at(-1), /绑定已过期/)
})

test('完全停用两步验证先确认并校验因素，服务端吊销后清状态重新登录', async () => {
  const state = await setup('src/components/account/AdminMfaDialog.vue')
  state.status.value = status
  state.goToStage('disable')
  state.form.currentPassword = '隔离测试密码'
  state.form.code = '123456'
  await state.handleDisable()
  assert.ok(calls.api.some(([name]) => name === 'message.confirm'))
  assert.deepEqual(calls.api.find(([name]) => name === 'disableAdminMfa')[1],
    { currentPassword: '隔离测试密码', code: '123456' })
  assert.ok(calls.api.some(([name]) => name === 'clearAuthState'))
  assert.deepEqual(calls.emissions.at(-1), ['update:modelValue', false])
  assert.equal(calls.redirects, 1)
  assert.equal(state.form.currentPassword, '')
})

test('重生恢复码不接受旧恢复码复核，动态码成功后只显示新码一次', async () => {
  const state = await setup('src/components/account/AdminMfaDialog.vue')
  state.status.value = status
  state.goToStage('regenerate')
  state.form.currentPassword = '隔离测试密码'
  state.form.useRecoveryCode = true
  state.form.recoveryCode = '旧码'
  await state.handleRegenerate()
  assert.match(calls.warnings.at(-1), /恢复码不能用于生成新的恢复码/)
  assert.equal(calls.api.some(([name]) => name === 'regenerateAdminMfaRecoveryCodes'), false)
  state.form.useRecoveryCode = false
  state.form.code = '12 3456'
  await state.handleRegenerate()
  assert.deepEqual(calls.api.find(([name]) => name === 'regenerateAdminMfaRecoveryCodes')[1],
    { currentPassword: '隔离测试密码', code: '123456' })
  assert.equal(state.stage.value, 'recovery-codes')
  assert.deepEqual(state.recoveryCodes.value, ['新恢复码'])
  await state.handleFinishRecoveryCodes()
  assert.deepEqual(state.recoveryCodes.value, [])
})

test('用已有安全密钥开启两步验证时，StepUp 绑定动作与恢复码只向本人返回', async () => {
  const state = await setup('src/components/account/AdminMfaDialog.vue')
  state.goToStage('enable-key')
  await state.handleEnableKey()
  assert.match(calls.warnings.at(-1), /当前登录密码/)
  state.form.currentPassword = '隔离测试密码'
  await state.handleEnableKey()
  assert.equal(calls.api.find(([name]) => name === 'startAdminWebAuthnStepUp')[1].action, 'mfa.webauthn.enable')
  assert.ok(calls.api.some(([name]) => name === 'sdk.startAuthentication'))
  assert.deepEqual(calls.api.find(([name]) => name === 'enableAdminWebAuthnMfa')[1],
    { currentPassword: '隔离测试密码', stepUpProof: 'isolated-step-up-proof' })
  assert.equal(state.stage.value, 'recovery-codes')
  assert.deepEqual(state.recoveryCodes.value, ['密钥恢复码'])
  assert.equal(state.form.currentPassword, '')
})

test('登录密码第一步成功后只暂存短期票据并清除表单密码', async () => {
  const state = await setup('src/views/auth/LoginView.vue', {})
    state.form.username = 'admin'
    state.form.password = '隔离测试输入'
    state.formRef.value = { validate: async () => true }
    await state.handleSubmit()
    assert.equal(state.form.password, '')
    assert.equal(state.mfaChallenge.value.ticket, '隔离测试票据')
    assert.equal(state.submitPhase.value, 'idle')
    assert.equal(calls.passwordHandoff.length, 1)
    state.resetMfaChallenge()
})

test('动态码第二步只提交短票据和六位码，成功后投递预热并跳转', async () => {
  const state = await setup('src/views/auth/LoginView.vue', {})
  state.mfaChallenge.value = { ticket: '仅内存票据', username: 'admin', availableMethods: ['totp', 'recovery_code'], expiresAt: Date.now() + 30_000 }
  state.mfaForm.code = '12 3456'
  await state.handleSubmit()
  assert.deepEqual(calls.api.find(([name]) => name === 'completeMfaLogin')[1],
    { mfaTicket: '仅内存票据', code: '123456' })
  assert.equal(state.mfaChallenge.value, null)
  assert.equal(state.submitPhase.value, 'success')
  assert.equal(calls.api.find(([name]) => name === 'warmupPostLoginEntry')[1], '/dashboard')
  assert.deepEqual(calls.routes.at(-1), ['replace', '/dashboard'])
})

test('恢复码只作为已开放的 MFA 第二因素，成功后提示剩余量；过期票据必须重回密码步', async () => {
  const state = await setup('src/views/auth/LoginView.vue', {})
  state.mfaChallenge.value = { ticket: '恢复票据', username: 'admin', availableMethods: ['totp', 'recovery_code'], expiresAt: Date.now() + 30_000 }
  state.toggleMfaMode('webauthn')
  assert.equal(state.mfaMode.value, 'totp', '不可切换到服务端未开放的方式')
  state.toggleMfaMode('recovery_code')
  state.mfaForm.recoveryCode = '  隔离恢复码  '
  apiOverrides.set('completeMfaLogin', () => ({ ...loginSuccess, recoveryCodesRemaining: 2 }))
  await state.handleSubmit()
  assert.deepEqual(calls.api.find(([name]) => name === 'completeMfaLogin')[1],
    { mfaTicket: '恢复票据', recoveryCode: '隔离恢复码' })
  assert.ok(calls.api.some(([name, message]) => name === 'message.alert' && /还剩 2 个/.test(message)))
  const expired = await setup('src/views/auth/LoginView.vue', {})
  expired.mfaChallenge.value = { ticket: '过期票据', username: 'admin', availableMethods: ['totp'], expiresAt: Date.now() - 1 }
  await expired.handleSubmit()
  assert.equal(expired.mfaChallenge.value, null)
  assert.match(calls.warnings.at(-1), /已过期/)
  assert.equal(calls.api.filter(([name]) => name === 'completeMfaLogin').length, 1)
})

test('MFA 失败按服务端票据过期原因清理挑战，不保留已输入因素', async () => {
  const state = await setup('src/views/auth/LoginView.vue', {})
  state.mfaChallenge.value = { ticket: '即将失效', username: 'admin', availableMethods: ['totp'], expiresAt: Date.now() + 30_000 }
  state.mfaForm.code = '123456'
  apiOverrides.set('completeMfaLogin', () => { throw Object.assign(new Error('票据已过期'), { reason: 'ADMIN_MFA_TICKET_EXPIRED', status: 400 }) })
  await state.handleSubmit()
  assert.equal(state.mfaChallenge.value, null)
  assert.equal(state.mfaForm.code, '')
  assert.equal(state.submitPhase.value, 'idle')
  assert.match(calls.warnings.at(-1), /票据已过期/)
})

test('匿名密钥直接登录只有最终核验后更新登录页并跳转，最终请求不带取消信号', async () => {
  const state = await setup('src/views/auth/LoginView.vue', {})
  state.webAuthnCapabilities.value = { enabled: true }
  state.webAuthnCapabilitiesPhase.value = 'ready'
  state.form.password = '不应保留的密码'
  await state.handleWebAuthnLogin()
  assert.equal(calls.api.find(([name]) => name === 'startAdminWebAuthnLogin')[1].captchaId, undefined)
  assert.ok(calls.api.some(([name]) => name === 'sdk.startAuthentication'))
  const finalCall = calls.api.find(([name]) => name === 'completeWebAuthnLogin')
  assert.deepEqual(finalCall[1], { challengeId: 'direct-challenge', response: { id: 'isolated-authentication' } })
  assert.equal(finalCall.length, 2)
  assert.equal(state.form.password, '')
  assert.equal(state.submitPhase.value, 'success')
  assert.deepEqual(calls.routes.at(-1), ['replace', '/dashboard'])
})

test('密码后安全密钥严格使用 MFA ticket 端点，不混入匿名直接登录', async () => {
  const state = await setup('src/views/auth/LoginView.vue', {})
  state.webAuthnCapabilities.value = { enabled: true }
  state.mfaChallenge.value = { ticket: '第二步票据', username: 'admin', availableMethods: ['webauthn'], expiresAt: Date.now() + 30_000 }
  state.toggleMfaMode('webauthn')
  await state.handleSubmit()
  assert.equal(calls.api.find(([name]) => name === 'startAdminMfaWebAuthnLogin')[1], '第二步票据')
  assert.equal(calls.api.some(([name]) => name === 'startAdminWebAuthnLogin'), false)
  assert.deepEqual(calls.api.find(([name]) => name === 'completeMfaWebAuthnLogin')[1],
    { mfaTicket: '第二步票据', challengeId: 'mfa-challenge', response: { id: 'isolated-authentication' } })
  assert.equal(state.mfaChallenge.value, null)
  assert.deepEqual(calls.routes.at(-1), ['replace', '/dashboard'])
})

test('密码错误触发验证码时只展示 data URL，并清除登录提交状态', async () => {
  const state = await setup('src/views/auth/LoginView.vue', {})
  state.form.username = 'admin'
  state.form.password = '隔离测试密码'
  state.formRef.value = { validate: async () => true }
  apiOverrides.set('login', () => { throw Object.assign(new Error('需要验证码后重试'), { status: 428 }) })
  await state.handleSubmit()
  assert.equal(state.captchaVisible.value, true)
  assert.equal(state.captchaState.captchaId, 'captcha-1')
  assert.match(state.captchaImageSrc.value, /^data:image\/svg\+xml;charset=utf-8,/)
  assert.equal(state.finalRequestPending.value, false)
  assert.equal(state.submitPhase.value, 'idle')
  assert.match(state.securityHint.value, /重试/)
})

test('条件式密钥候选在可用浏览器完成挑战与最终核验后才登录', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'PublicKeyCredential')
  Object.defineProperty(globalThis, 'PublicKeyCredential', {
    configurable: true, value: { isConditionalMediationAvailable: async () => true },
  })
  try {
    const state = await setup('src/views/auth/LoginView.vue', {})
    state.webAuthnCapabilities.value = { enabled: true }
    state.webAuthnCapabilitiesPhase.value = 'ready'
    await state.startConditionalLogin()
    assert.equal(calls.api.find(([name]) => name === 'startAdminWebAuthnLogin')[1].captchaId, undefined)
    assert.equal(calls.api.find(([name]) => name === 'sdk.startAuthentication')[1].useBrowserAutofill, true)
    assert.deepEqual(calls.api.find(([name]) => name === 'completeWebAuthnLogin')[1],
      { challengeId: 'direct-challenge', response: { id: 'isolated-authentication' } })
    assert.equal(state.conditionalPhase.value, 'stopped')
    assert.equal(state.finalRequestPending.value, false)
    assert.equal(state.submitPhase.value, 'success')
    assert.deepEqual(calls.routes.at(-1), ['replace', '/dashboard'])
  } finally {
    if (original) Object.defineProperty(globalThis, 'PublicKeyCredential', original)
    else delete globalThis.PublicKeyCredential
  }
})

test('条件式挑战在页面隐藏后拒绝迟到结果，浏览器不可用时不发挑战', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'PublicKeyCredential')
  Object.defineProperty(globalThis, 'PublicKeyCredential', {
    configurable: true, value: { isConditionalMediationAvailable: async () => true },
  })
  try {
    let resolveChallenge
    apiOverrides.set('startAdminWebAuthnLogin', () => new Promise((resolve) => { resolveChallenge = resolve }))
    const state = await setup('src/views/auth/LoginView.vue', {})
    state.webAuthnCapabilities.value = { enabled: true }
    const pending = state.startConditionalLogin()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(state.conditionalPhase.value, 'active')
    document.visibilityState = 'hidden'
    state.handleVisibility()
    resolveChallenge({ challengeId: '迟到挑战', options: { challenge: '隔离' }, expiresInSeconds: 30 })
    await pending
    assert.equal(calls.api.some(([name]) => name === 'sdk.startAuthentication'), false)
    assert.equal(calls.api.some(([name]) => name === 'completeWebAuthnLogin'), false)
    document.visibilityState = 'visible'
    delete globalThis.PublicKeyCredential
    const unavailable = await setup('src/views/auth/LoginView.vue', {})
    unavailable.webAuthnCapabilities.value = { enabled: true }
    await unavailable.startConditionalLogin()
    assert.equal(unavailable.conditionalPhase.value, 'unavailable')
    assert.equal(calls.api.filter(([name]) => name === 'startAdminWebAuthnLogin').length, 1)
  } finally {
    document.visibilityState = 'visible'
    if (original) Object.defineProperty(globalThis, 'PublicKeyCredential', original)
    else delete globalThis.PublicKeyCredential
  }
})

test('条件式密钥候选挑战到期和风控拒绝均不签发会话', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'PublicKeyCredential')
  Object.defineProperty(globalThis, 'PublicKeyCredential', {
    configurable: true, value: { isConditionalMediationAvailable: async () => true },
  })
  try {
    let finishCeremony
    apiOverrides.set('startAdminWebAuthnLogin', () => ({ challengeId: '即将过期', options: { challenge: '隔离' }, expiresInSeconds: 0 }))
    apiOverrides.set('sdk.startAuthentication', () => new Promise((resolve) => { finishCeremony = resolve }))
    const expired = await setup('src/views/auth/LoginView.vue', {})
    expired.webAuthnCapabilities.value = { enabled: true }
    const pending = expired.startConditionalLogin()
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(expired.conditionalPhase.value, 'expired')
    finishCeremony({ id: '迟到的认证结果' })
    await pending
    assert.equal(calls.api.some(([name]) => name === 'completeWebAuthnLogin'), false)
    apiOverrides.delete('sdk.startAuthentication')
    apiOverrides.set('startAdminWebAuthnLogin', () => { throw Object.assign(new Error('请求过于频繁'), { status: 429 }) })
    const limited = await setup('src/views/auth/LoginView.vue', {})
    limited.webAuthnCapabilities.value = { enabled: true }
    await limited.startConditionalLogin()
    assert.equal(limited.conditionalPhase.value, 'stopped')
    assert.equal(calls.api.some(([name]) => name === 'completeWebAuthnLogin'), false)
  } finally {
    if (original) Object.defineProperty(globalThis, 'PublicKeyCredential', original)
    else delete globalThis.PublicKeyCredential
  }
})

test('密钥能力查询成功与失败分开反馈，密码表单校验失败不发登录请求', async () => {
  const state = await setup('src/views/auth/LoginView.vue', {})
  await state.loadWebAuthnCapabilities()
  assert.equal(state.webAuthnCapabilitiesPhase.value, 'ready')
  assert.equal(state.webAuthnCapabilities.value.enabled, true)
  apiOverrides.set('getAdminWebAuthnCapabilities', () => { throw new Error('能力查询失败') })
  await state.loadWebAuthnCapabilities()
  assert.equal(state.webAuthnCapabilitiesPhase.value, 'error')
  assert.equal(state.webAuthnCapabilities.value, null)
  state.formRef.value = { validate: async () => false }
  await state.handleSubmit()
  assert.equal(calls.api.some(([name]) => name === 'login'), false)
  assert.equal(state.submitPhase.value, 'idle')
})

test('匿名密钥最终核验遇风控先刷新验证码，MFA 密钥过期票据清除挑战', async () => {
  apiOverrides.set('completeWebAuthnLogin', () => { throw Object.assign(new Error('需要验证码后重试'), { status: 428 }) })
  const direct = await setup('src/views/auth/LoginView.vue', {})
  direct.webAuthnCapabilities.value = { enabled: true }
  await direct.handleWebAuthnLogin()
  assert.equal(direct.captchaVisible.value, true)
  assert.equal(direct.captchaState.captchaId, 'captcha-1')
  assert.equal(direct.finalRequestPending.value, false)
  assert.equal(direct.submitPhase.value, 'idle')
  apiOverrides.delete('completeWebAuthnLogin')
  apiOverrides.set('completeMfaWebAuthnLogin', () => {
    throw Object.assign(new Error('第二步票据已过期'), { reason: 'ADMIN_MFA_TICKET_EXPIRED', status: 400 })
  })
  const mfa = await setup('src/views/auth/LoginView.vue', {})
  mfa.webAuthnCapabilities.value = { enabled: true }
  mfa.mfaChallenge.value = { ticket: '即将过期', username: 'admin', availableMethods: ['webauthn'], expiresAt: Date.now() + 30_000 }
  mfa.toggleMfaMode('webauthn')
  await mfa.handleSubmit()
  assert.equal(mfa.mfaChallenge.value, null)
  assert.equal(mfa.finalRequestPending.value, false)
  assert.match(calls.warnings.at(-1), /票据已过期/)
})

test('最终密钥请求在途时取消与隐藏不会丢弃迟到的成功结果', async () => {
  let complete
  apiOverrides.set('completeWebAuthnLogin', () => new Promise((resolve) => { complete = resolve }))
  const state = await setup('src/views/auth/LoginView.vue', {})
  state.webAuthnCapabilities.value = { enabled: true }
  const pending = state.handleWebAuthnLogin()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(state.webAuthnPhase.value, 'verifying')
  assert.equal(state.finalRequestPending.value, true)
  state.cancelWebAuthnLogin()
  assert.equal(state.webAuthnPhase.value, 'verifying')
  document.visibilityState = 'hidden'
  state.handleVisibility()
  assert.equal(state.finalRequestPending.value, true)
  complete(loginSuccess)
  await pending
  document.visibilityState = 'visible'
  assert.equal(state.submitPhase.value, 'success')
  assert.deepEqual(calls.routes.at(-1), ['replace', '/dashboard'])
})

test('用户治理只允许管理员对他人且确有密钥的账户显示撤销入口', async () => {
  const state = await setup('src/views/system/UserManageView.vue', {})
    const other = { id: 'other', accountState: 'active', webauthnCredentialsCount: 1 }
    assert.equal(state.canShowRevokeWebAuthnAction(other), true)
    assert.equal(state.canShowRevokeWebAuthnAction({ ...other, id: 'self' }), false)
    assert.equal(state.canShowRevokeWebAuthnAction({ ...other, webauthnCredentialsCount: 0 }), false)
})

test('用户治理撤销密钥先校验本人因素和撤销原因，拒绝空理由与错误动态码', async () => {
  const state = await setup('src/views/system/UserManageView.vue', {})
  const other = { id: 'other', displayName: '其他管理员', accountState: 'active', webauthnCredentialsCount: 1 }
  await state.handleOpenRevokeWebAuthn(other)
  assert.equal(state.revokeWebAuthnVisible.value, true)
  assert.equal(state.revokeWebAuthnMfaPhase.value, 'ready')
  await state.handleSubmitRevokeWebAuthn()
  assert.match(calls.warnings.at(-1), /撤销原因/)
  state.revokeWebAuthnForm.reason = '丢失设备'
  await state.handleSubmitRevokeWebAuthn()
  assert.match(calls.warnings.at(-1), /当前密码/)
  state.revokeWebAuthnForm.currentPassword = '隔离测试输入'
  state.revokeWebAuthnForm.code = '12'
  await state.handleSubmitRevokeWebAuthn()
  assert.match(calls.warnings.at(-1), /6 位数字动态码/)
  assert.equal(calls.api.some(([name]) => name === 'resetUserWebAuthn'), false)
})

test('管理员撤销他人全部密钥时保留目标 MFA，记录原因并提示另行重置方式', async () => {
  const state = await setup('src/views/system/UserManageView.vue', {})
  const target = { id: 'other', displayName: '目标管理员', accountState: 'active', webauthnCredentialsCount: 2, mfaRequired: true }
  await state.handleOpenRevokeWebAuthn(target)
  assert.equal(state.revokeWebAuthnMfaPhase.value, 'ready')
  state.revokeWebAuthnForm.reason = '设备遗失需吊销'
  state.revokeWebAuthnForm.currentPassword = '隔离测试密码'
  state.revokeWebAuthnForm.code = '12 3456'
  await state.handleSubmitRevokeWebAuthn()
  const revoke = calls.api.find(([name]) => name === 'resetUserWebAuthn')
  assert.equal(revoke[1], 'other')
  assert.deepEqual(revoke[2], { currentPassword: '隔离测试密码', reason: '设备遗失需吊销', code: '123456' })
  assert.match(calls.api.find(([name]) => name === 'message.confirm')[1], /另行重置两步验证/)
  assert.match(calls.successes.at(-1), /另行重置两步验证/)
  assert.equal(state.revokeWebAuthnVisible.value, false)
  assert.equal(state.revokeWebAuthnForm.currentPassword, '')
  assert.ok(calls.api.some(([name]) => name === 'getUserList'))
})

test('管理员仅有安全密钥可复核时，撤销他人密钥须通过带目标 ID 的 StepUp', async () => {
  apiOverrides.set('getAdminMfaStatus', () => ({ ...status, availableMethods: ['webauthn'] }))
  const state = await setup('src/views/system/UserManageView.vue', {})
  const target = { id: 'other', displayName: '目标管理员', accountState: 'active', webauthnCredentialsCount: 1, mfaRequired: true }
  await state.handleOpenRevokeWebAuthn(target)
  assert.equal(state.revokeWebAuthnForm.useWebAuthn, true)
  state.revokeWebAuthnForm.reason = '管理员确认失陷'
  state.revokeWebAuthnForm.currentPassword = '隔离测试密码'
  await state.handleSubmitRevokeWebAuthn()
  const stepUp = calls.api.find(([name]) => name === 'startAdminWebAuthnStepUp')
  assert.deepEqual(stepUp[1], { action: 'user.webauthn.reset', targetId: 'other', currentPassword: '隔离测试密码' })
  assert.equal(calls.api.find(([name]) => name === 'resetUserWebAuthn')[2].stepUpProof, 'isolated-step-up-proof')
  assert.equal(state.revokeWebAuthnVisible.value, false)
})

test('管理员重置他人 MFA 允许明确的恢复码复核，不会误操作本人', async () => {
  apiOverrides.set('getAdminMfaStatus', () => ({ ...status, availableMethods: ['recovery_code'] }))
  const state = await setup('src/views/system/UserManageView.vue', {})
  const self = { id: 'self', displayName: '本人', mfaRequired: true, accountState: 'active' }
  await state.handleResetMfa(self)
  assert.equal(state.resetMfaVisible.value, false)
  const target = { id: 'other', displayName: '目标管理员', mfaRequired: true, accountState: 'active' }
  await state.handleResetMfa(target)
  assert.equal(state.resetMfaPhase.value, 'ready')
  assert.equal(state.resetMfaForm.mode, 'recovery_code')
  state.resetMfaForm.currentPassword = '隔离测试密码'
  state.resetMfaForm.recoveryCode = '  独立恢复码  '
  await state.handleSubmitResetMfa()
  assert.deepEqual(calls.api.find(([name]) => name === 'resetUserMfa').slice(1, 3),
    ['other', { currentPassword: '隔离测试密码', recoveryCode: '独立恢复码' }])
  assert.equal(state.resetMfaVisible.value, false)
  assert.equal(state.resetMfaForm.currentPassword, '')
  assert.ok(calls.api.some(([name]) => name === 'getUserList'))
})

test('管理员两步验证状态读取过期或失败时不误提交目标重置', async () => {
  const state = await setup('src/views/system/UserManageView.vue', {})
  const target = { id: 'other', displayName: '其他管理员', mfaRequired: true, accountState: 'active' }
  let finishStatus
  apiOverrides.set('getAdminMfaStatus', () => new Promise((resolve) => { finishStatus = resolve }))
  const pending = state.handleResetMfa(target)
  assert.equal(state.resetMfaPhase.value, 'loading')
  state.closeResetMfa()
  finishStatus(status)
  await pending
  assert.equal(state.resetMfaVisible.value, false)
  assert.equal(state.resetMfaStatus.value, null)
  apiOverrides.set('getAdminMfaStatus', () => { throw new Error('本人状态暂不可用') })
  await state.handleResetMfa(target)
  assert.equal(state.resetMfaPhase.value, 'error')
  await state.handleSubmitResetMfa()
  assert.equal(calls.api.some(([name]) => name === 'resetUserMfa'), false)
})

test('管理员重置两步验证拒绝错误动态码、取消确认与服务端失败并抹除输入', async () => {
  const state = await setup('src/views/system/UserManageView.vue', {})
  const target = { id: 'other', displayName: '其他管理员', mfaRequired: true, accountState: 'active' }
  await state.handleResetMfa(target)
  state.resetMfaForm.currentPassword = '隔离测试输入'
  state.resetMfaForm.code = '12'
  await state.handleSubmitResetMfa()
  assert.match(calls.warnings.at(-1), /6 位数字动态码/)
  assert.equal(calls.api.some(([name]) => name === 'resetUserMfa'), false)
  state.resetMfaForm.code = '123456'
  apiOverrides.set('message.confirm', () => { throw new Error('管理员取消确认') })
  await state.handleSubmitResetMfa()
  assert.equal(state.resetMfaConfirmationPending.value, false)
  assert.equal(calls.api.some(([name]) => name === 'resetUserMfa'), false)
  apiOverrides.delete('message.confirm')
  apiOverrides.set('resetUserMfa', () => { throw new Error('服务端拒绝重置') })
  await state.handleSubmitResetMfa()
  assert.match(calls.warnings.at(-1), /服务端拒绝重置/)
  assert.equal(state.resetMfaVisible.value, true)
  assert.equal(state.resetMfaSubmitting.value, false)
  assert.equal(state.resetMfaForm.currentPassword, '')
  assert.equal(state.resetMfaForm.code, '')
})

test('撤销密钥状态读取失败、无恢复码与取消确认均阻止服务端撤销', async () => {
  const state = await setup('src/views/system/UserManageView.vue', {})
  const target = { id: 'other', displayName: '其他管理员', accountState: 'active', webauthnCredentialsCount: 1, mfaRequired: true }
  apiOverrides.set('getAdminMfaStatus', () => { throw new Error('本人状态暂不可用') })
  await state.handleOpenRevokeWebAuthn(target)
  assert.equal(state.revokeWebAuthnMfaPhase.value, 'error')
  await state.handleSubmitRevokeWebAuthn()
  assert.match(calls.warnings.at(-1), /尚未确认本人两步验证状态/)
  state.updateRevokeWebAuthnVisible(false)
  apiOverrides.set('getAdminMfaStatus', () => ({ ...status, availableMethods: ['recovery_code'] }))
  await state.handleOpenRevokeWebAuthn(target)
  state.revokeWebAuthnForm.reason = '设备丢失'
  state.revokeWebAuthnForm.currentPassword = '隔离测试输入'
  state.revokeWebAuthnForm.useRecoveryCode = true
  await state.handleSubmitRevokeWebAuthn()
  assert.match(calls.warnings.at(-1), /请输入恢复码/)
  state.revokeWebAuthnForm.recoveryCode = '  独立恢复码  '
  apiOverrides.set('message.confirm', () => { throw new Error('管理员取消确认') })
  await state.handleSubmitRevokeWebAuthn()
  assert.equal(state.revokeWebAuthnConfirmationPending.value, false)
  assert.equal(calls.api.some(([name]) => name === 'resetUserWebAuthn'), false)
})

test('撤销请求已在途时离页擦除复核输入，迟到结果只收尾且不恢复弹窗', async () => {
  let finishRevoke
  apiOverrides.set('resetUserWebAuthn', () => new Promise((resolve) => { finishRevoke = resolve }))
  const state = await setup('src/views/system/UserManageView.vue', {})
  const target = { id: 'other', displayName: '其他管理员', accountState: 'active', webauthnCredentialsCount: 1, mfaRequired: true }
  await state.handleOpenRevokeWebAuthn(target)
  state.revokeWebAuthnForm.reason = '密钥失陷'
  state.revokeWebAuthnForm.currentPassword = '隔离测试输入'
  state.revokeWebAuthnForm.code = '123456'
  const pending = state.handleSubmitRevokeWebAuthn()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(state.revokeWebAuthnSubmitting.value, true)
  state.deactivateRevokeWebAuthn()
  assert.equal(state.revokeWebAuthnForm.currentPassword, '')
  assert.equal(state.revokeWebAuthnForm.code, '')
  finishRevoke({ revokedCount: 1 })
  await pending
  assert.equal(state.revokeWebAuthnVisible.value, false)
  assert.equal(state.revokeWebAuthnForm.reason, '')
  assert.equal(calls.api.filter(([name]) => name === 'resetUserWebAuthn').length, 1)
})

test('密钥和两步验证 SFC 的实际模板路径可渲染关键状态提示', async () => {
  for (const [source, expected] of [
    ['src/components/account/AdminWebAuthnDialog.vue', '添加密钥'],
    ['src/components/account/AdminMfaDialog.vue', '两步验证'],
  ]) {
    const app = createSSRApp(loaded.get(source).ssr, { modelValue: true })
    const names = [...loaded.get(source).source.matchAll(/<\s*(el-[a-z-]+)/g)].map((match) => match[1])
    for (const name of new Set(names)) app.component(name, slotComponent)
    app.directive('loading', { getSSRProps: () => ({}) })
    const html = await renderToString(app)
    assert.match(html, new RegExp(expected))
  }
})

test('生成仅导入四个 SFC 的独立覆盖率负例', () => {
  const probePath = path.join(outputRoot, 'import-only.test.mjs')
  fs.writeFileSync(probePath, [
    "import assert from 'node:assert/strict'",
    'globalThis.__pr153CoverageStub = () => () => undefined',
    ...components.map((relativeSource) => {
      const name = path.basename(relativeSource, '.vue')
      return `assert.equal(typeof (await import('./${name}-setup.mjs')).default.setup, 'function')`
    }),
  ].join('\n'))
  assert.equal(components.length, 4)
  assert.ok(fs.existsSync(probePath), '独立导入负例夹具必须生成供 runner 执行')
})

test('生成四个 SFC 真实 setup 但不调用业务处理器的独立覆盖率负例', () => {
  const probePath = path.join(outputRoot, 'setup-uncalled.test.mjs')
  fs.writeFileSync(probePath, [
    "import assert from 'node:assert/strict'",
    "import { createSSRApp, h } from 'vue'",
    "import { renderToString } from '@vue/server-renderer'",
    "globalThis.document = { visibilityState: 'visible' }",
    'const noop = () => undefined',
    'const flow = () => ({ cancel: noop, finish: noop, start: () => ({ id: 1, signal: new AbortController().signal }), isCurrent: () => true })',
    'const gate = () => ({ begin: () => ({ id: 1 }), commit: () => true, cancel: noop, settle: noop, isCurrent: () => true, isCommitted: () => false })',
    "const authStore = { isAdmin: true, currentUser: { id: 'self', username: 'admin' }, login: async () => ({ mfaRequired: true, mfaTicket: '隔离票据', availableMethods: ['totp'], expiresInSeconds: 30 }) }",
    'globalThis.__pr153CoverageStub = (source, name) => {',
    "  if (source === 'vue-router') return name === 'onBeforeRouteLeave' ? noop : name === 'useRoute' ? () => ({ query: {} }) : () => ({ push: noop, replace: noop })",
    "  if (source === 'element-plus' && name === 'ElMessageBox') return { close: noop, confirm: async () => 'confirm' }",
    "  if (source === '@/store' && name === 'useAuthStore') return () => authStore",
    "  if (source === '@/store/pinia') return {}",
    "  if (source === '@/utils/admin-webauthn') return name === 'createWebAuthnFlow' ? flow : name === 'createLoginAttemptGate' ? gate : name === 'assessWebAuthnAvailability' ? () => ({ available: false, message: '' }) : noop",
    "  if (source === '@/utils/admin-password-credential' && name === 'createPasswordCredentialHandoff') return () => ({ capture: noop, discard: noop, storeOnce: async () => {} })",
    "  if (source === '@/utils/list') return name === 'createPaginatedListState' ? () => ({ records: [], list: [], total: 0, loading: false, query: { page: 1, pageSize: 10 } }) : noop",
    "  if (source === '@/composables/usePermissionAction') return () => ({ hasPermission: () => true, ensurePermission: () => true })",
    "  if (source === '@/composables/useStableRequest') return () => ({ runLatest: noop, run: noop, cancel: noop })",
    "  if (source === '@/api/modules/auth') return name === 'ROLE_LABEL_MAP' ? {} : name === 'ADMIN_MFA_TICKET_EXPIRED_REASON' ? 'ADMIN_MFA_TICKET_EXPIRED' : async () => ({})",
    "  if (source === '@/constants/app-meta') return { name: 'Y-Link' }",
    "  if (source === '@/views/system/user-governance.helpers') return name === 'roleOptions' ? [] : name === 'accountTypeDescriptions' ? {} : noop",
    "  if (source === '@/api/modules/admin-webauthn') return name === 'getAdminWebAuthnCredentials' ? async () => [] : name === 'getAdminWebAuthnCapabilities' ? async () => ({ enabled: false }) : async () => ({})",
    "  if (source === '@/api/modules/admin-mfa') return name === 'getAdminMfaStatus' ? async () => ({ mfaRequired: false, availableMethods: [] }) : name === 'confirmAdminMfaEnrollment' ? async () => ({ recoveryCodes: ['隔离码'] }) : async () => ({})",
    "  if (source === '@/api/modules/user') return name === 'getUserList' ? async () => ({ records: [], total: 0 }) : async () => ({})",
    "  if (source.startsWith('@/components/')) return {}",
    '  return noop',
    '}',
    "const probes = [['AdminWebAuthnDialog', 'openRename'], ['AdminMfaDialog', 'handleConfirmEnrollment'], ['LoginView', 'handleSubmit'], ['UserManageView', 'handleSubmitResetMfa']]",
    'const states = new Map()',
    'for (const [name, handler] of probes) {',
    "  const component = (await import(`./${name}-setup.mjs`)).default",
    '  let state',
    '  const html = await renderToString(createSSRApp({ setup() {',
    '    state = component.setup({ modelValue: false }, { emit: noop, expose: noop })',
    "    return () => h('div')",
    '  } }))',
    "  assert.equal(html, '<div></div>', `${name} 的真实模板不应在 setup 负例被渲染`)",
    "  assert.equal(typeof state[handler], 'function', `${name} 的处理器必须存在但未调用`)",
    '  states.set(name, state)',
    '}',
    "const selected = process.env.PR153_COVERAGE_PROBE_HANDLER ?? ''",
    "assert.ok(!selected || probes.some(([name]) => name === selected), '仅允许四个已审查的单处理器探针')",
    "if (selected === 'AdminWebAuthnDialog') {",
    "  states.get(selected).openRename({ id: 'credential-one', name: '隔离密钥' })",
    "  assert.equal(states.get(selected).form.name, '隔离密钥')",
    '}',
    "if (selected === 'AdminMfaDialog') {",
    '  const state = states.get(selected)',
    "  state.goToStage('enroll-scan')",
    "  state.form.code = '123456'",
    '  await state.handleConfirmEnrollment()',
    "  assert.deepEqual(state.recoveryCodes.value, ['隔离码'])",
    '}',
    "if (selected === 'LoginView') {",
    '  const state = states.get(selected)',
    "  state.form.username = 'admin'",
    "  state.form.password = '隔离测试输入'",
    '  state.formRef.value = { validate: async () => true }',
    '  await state.handleSubmit()',
    "  assert.equal(state.mfaChallenge.value.ticket, '隔离票据')",
    '  state.resetMfaChallenge()',
    '}',
    "if (selected === 'UserManageView') {",
    '  const state = states.get(selected)',
    "  state.resetMfaTarget.value = { id: 'other', displayName: '其他管理员' }",
    '  state.resetMfaStatus.value = { mfaRequired: false, availableMethods: [] }',
    "  state.resetMfaPhase.value = 'ready'",
    '  state.resetMfaVisible.value = true',
    "  state.resetMfaForm.currentPassword = '隔离测试输入'",
    '  await state.handleSubmitResetMfa()',
    '  assert.equal(state.resetMfaVisible.value, false)',
    '}',
  ].join('\n'))
  for (const [relativeSource, marker] of [
    ['src/components/account/AdminWebAuthnDialog.vue', 'form.name = credential.name'],
    ['src/components/account/AdminMfaDialog.vue', 'const result = await confirmAdminMfaEnrollment(code)'],
    ['src/views/auth/LoginView.vue', 'const result = await authStore.login({'],
    ['src/views/system/UserManageView.vue', 'await resetUserMfa(target.id, proof)'],
  ]) assert.ok(loaded.get(relativeSource).source.includes(marker), `${relativeSource} 未调用业务标记必须存在`)
  assert.ok(fs.existsSync(probePath), '独立负例夹具必须生成供 runner 执行')
})
