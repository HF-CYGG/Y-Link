/**
 * 管理端 WebAuthn 独立负向验收：仅使用自建 ASCII SQLite 与真实 ES256 软件认证器。
 * 不修改生产验证器或降低频控；每个断言通过 HTTP 路由或既有服务入口执行。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

const inherited = [
  'ENV_FILE', 'APP_PROFILE', 'DB_TYPE', 'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD',
  'DB_NAME', 'SQLITE_DB_PATH', 'Y_LINK_DATA_DIR', 'Y_LINK_DATA_ENCRYPTION_KEY',
].filter((key) => process.env[key] !== undefined)
assert.equal(inherited.length, 0, `隔离验证拒绝继承数据库、密钥或 env 配置：${inherited.join(', ')}`)
const backendRoot = path.resolve(process.cwd())
const profile = 'admin-webauthn-negative-verify'
assert.equal(fs.existsSync(path.join(backendRoot, '.env')), false, '隔离验证拒绝读取 backend/.env')
assert.equal(fs.existsSync(path.join(backendRoot, `.env.${profile}`)), false, '隔离验证拒绝读取 profile env')
const testDataRoot = path.resolve(backendRoot, '../tmp/admin-webauthn-20261009-backend/test-data')
assert.equal(path.basename(testDataRoot), 'test-data')
fs.mkdirSync(testDataRoot, { recursive: true })
const tempRoot = fs.mkdtempSync(path.join(testDataRoot, `run-negative-${process.pid}-`))
const databasePath = path.join(tempRoot, 'negative.sqlite')
assert.equal(fs.existsSync(databasePath), false)
process.env.NODE_ENV = 'test'
process.env.APP_PROFILE = profile
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'false'
process.env.SQLITE_DB_PATH = databasePath
process.env.Y_LINK_DATA_DIR = path.join(tempRoot, 'app-data')
process.env.Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE = 'true'
process.env.INIT_ADMIN_PASSWORD = 'Negative-Verify#Admin2026'
process.env.PERMANENT_DELETE_PASSWORD = 'Negative-Verify#Permanent2026'
process.env.AUTH_WEBAUTHN_ENABLED = 'true'
process.env.AUTH_WEBAUTHN_RP_ID = 'localhost'
process.env.AUTH_WEBAUTHN_RP_NAME = 'Y-Link 负向验证'
process.env.AUTH_WEBAUTHN_ORIGINS = '["http://localhost:3000"]'

const { AppDataSource } = await import('../src/config/data-source.js')
const { prepareDatabaseRuntime, initializeDatabaseSchemaIfNeeded } = await import('../src/config/database-bootstrap.js')
const { authService } = await import('../src/services/auth.service.js')
const { userService } = await import('../src/services/user.service.js')
const { adminWebauthnService } = await import('../src/services/admin-webauthn.service.js')
const { SysUser } = await import('../src/entities/sys-user.entity.js')
const { SysUserSession } = await import('../src/entities/sys-user-session.entity.js')
const { SysUserWebauthnCredential } = await import('../src/entities/sys-user-webauthn-credential.entity.js')
const { SysAuditLog } = await import('../src/entities/sys-audit-log.entity.js')
const { TestWebauthnAuthenticator } = await import('./admin-webauthn-fixture.js')
const { createApp } = await import('../src/app.js')

const ORIGIN = 'http://localhost:3000'
const ADMIN_PASSWORD = process.env.INIT_ADMIN_PASSWORD!
const OPERATOR_PASSWORD = 'Negative-Verify#Operator2026'
const OPERATOR_NEW_PASSWORD = 'Negative-Verify#Changed2026'
type Session = { cookies: string; headers: Record<string, string>; token: string }
type RegisterOptions = { challengeId: string; options: { challenge: string; user: { id: string } } }
type RegisterResult = { response: Response; options: RegisterOptions }
let server: Server | undefined
let baseUrl = ''

async function call(method: string, route: string, body?: unknown, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}${route}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}
function noAdminCookie(response: Response) {
  assert.ok(!response.headers.getSetCookie().some((line) => line.startsWith('y_link_admin_session=')), '拒绝请求不得签发管理端会话')
}
async function passwordSession(username: string, password: string): Promise<Session> {
  const response = await call('POST', '/api/auth/login', { username, password })
  assert.equal(response.status, 200, `${username} 原密码登录应成功`)
  const cookies = response.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ')
  const token = /y_link_admin_session=([^;]+)/.exec(cookies)?.[1] ?? ''
  const csrf = decodeURIComponent(/y_link_admin_csrf=([^;]+)/.exec(cookies)?.[1] ?? '')
  assert.ok(token && csrf)
  return { cookies, token, headers: { Origin: ORIGIN, Cookie: cookies, 'x-csrf-token': csrf } }
}
async function registerOptions(session: Session, password: string, name: string): Promise<RegisterOptions> {
  const response = await call('POST', '/api/auth/webauthn/register/options', {
    name, kind: 'passkey', currentPassword: password,
  }, session.headers)
  assert.equal(response.status, 200, `${name} 应取得注册挑战`)
  const body = await response.json() as { data?: RegisterOptions }
  assert.ok(body.data?.challengeId && body.data.options?.challenge && body.data.options.user?.id)
  return body.data
}
async function completeRegistration(session: Session, options: RegisterOptions, response: ReturnType<TestWebauthnAuthenticator['registration']>) {
  return call('POST', '/api/auth/webauthn/register/verify', { challengeId: options.challengeId, response }, session.headers)
}
async function register(session: Session, password: string, authenticator: TestWebauthnAuthenticator, name: string) {
  const options = await registerOptions(session, password, name)
  const response = await completeRegistration(session, options, authenticator.registration(options.options.challenge, ORIGIN, 'localhost'))
  assert.equal(response.status, 200, `${name} 真实 none attestation 应注册成功`)
  const body = await response.json() as { data?: { id?: string } }
  assert.ok(body.data?.id)
  return { id: body.data.id, handle: options.options.user.id }
}
async function keyTicket() {
  return adminWebauthnService.beginLogin(ORIGIN)
}
async function keyVerify(ticket: Awaited<ReturnType<typeof keyTicket>>, response: ReturnType<TestWebauthnAuthenticator['authentication']>) {
  return call('POST', '/api/auth/webauthn/login/verify', { challengeId: ticket.challengeId, response }, {
    Origin: ORIGIN, Cookie: `y_link_webauthn_nonce=${ticket.nonce}`,
  })
}
async function credentialState(id: string) {
  const rows = await AppDataSource.query(
    'SELECT id, user_id AS userId, name, counter, last_used_at AS lastUsedAt FROM sys_user_webauthn_credential WHERE id = ?', [id],
  ) as Array<{ id: string | number; userId: string | number; name: string; counter: number | string; lastUsedAt: string | null }>
  assert.equal(rows.length, 1)
  return rows[0]
}
async function expectRejectedKey(authenticator: TestWebauthnAuthenticator, handle: string, kind: 'signature' | 'rp' | 'origin') {
  const ticket = await keyTicket()
  const signed = authenticator.authentication(
    ticket.options.challenge, kind === 'origin' ? 'https://evil.example' : ORIGIN,
    kind === 'rp' ? 'evil.example' : 'localhost', handle, 1,
  )
  if (kind === 'signature') {
    const signature = Buffer.from(signed.response.signature, 'base64url')
    signature[signature.length - 1] ^= 1
    signed.response.signature = signature.toString('base64url')
  }
  const response = await keyVerify(ticket, signed)
  assert.equal(response.status, 401, `${kind} 真实认证断言必须拒绝`)
  noAdminCookie(response)
}

try {
  prepareDatabaseRuntime()
  await AppDataSource.initialize()
  await initializeDatabaseSchemaIfNeeded(AppDataSource)
  await authService.ensureDefaultAdmin()
  server = createApp().listen(0, 'localhost')
  await new Promise<void>((resolve) => server!.once('listening', resolve))
  baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`
  const adminSession = await passwordSession('admin', ADMIN_PASSWORD)
  const secondAdminSession = await passwordSession('admin', ADMIN_PASSWORD)
  const adminAuth = await authService.resolveAuthUserByToken(adminSession.token)
  const operator = await userService.create({
    username: 'negative-operator', displayName: '负向操作员', password: OPERATOR_PASSWORD,
    role: 'operator', status: 'enabled',
  }, adminAuth)
  const operatorSession = await passwordSession(operator.username, OPERATOR_PASSWORD)
  const adminAuthenticator = new TestWebauthnAuthenticator()
  const adminKey = await register(adminSession, ADMIN_PASSWORD, adminAuthenticator, '管理员密钥')
  const adminBeforeCrossAccount = await credentialState(adminKey.id)

  const foreignRename = await call('PATCH', `/api/auth/webauthn/credentials/${adminKey.id}`, { name: '越权改名' }, operatorSession.headers)
  assert.equal(foreignRename.status, 404, 'B 会话不得按 A 的记录 ID 改名')
  const foreignDelete = await call('DELETE', `/api/auth/webauthn/credentials/${adminKey.id}`, {
    currentPassword: OPERATOR_PASSWORD,
  }, operatorSession.headers)
  assert.equal(foreignDelete.status, 404, 'B 会话不得按 A 的记录 ID 删除')
  assert.deepEqual(await credentialState(adminKey.id), adminBeforeCrossAccount, 'A 凭据必须保持原状')
  assert.equal((await call('GET', '/api/auth/me', undefined, operatorSession.headers)).status, 200)
  console.log('[admin-webauthn-negative-verify] PASS 1/5 跨账号记录 ID 改名和删除拒绝，原记录与会话保持')

  for (const [session, password, label] of [
    [adminSession, ADMIN_PASSWORD, '同账号'], [operatorSession, OPERATOR_PASSWORD, '异账号'],
  ] as const) {
    const options = await registerOptions(session, password, `${label}重复密钥`)
    const duplicate = await completeRegistration(session, options, adminAuthenticator.registration(options.options.challenge, ORIGIN, 'localhost'))
    assert.equal(duplicate.status, 409, `${label}相同原始 ID 必须拒绝`)
  }
  const originalId = adminAuthenticator.credentialId.toString('base64url')
  const caseIndex = [...originalId].findIndex((char, index) => index < originalId.length - 1 && /[A-Za-z]/.test(char))
  assert.ok(caseIndex >= 0)
  const oppositeCase = originalId.slice(0, caseIndex)
    + (originalId[caseIndex] === originalId[caseIndex].toLowerCase() ? originalId[caseIndex].toUpperCase() : originalId[caseIndex].toLowerCase())
    + originalId.slice(caseIndex + 1)
  assert.notEqual(oppositeCase, originalId)
  assert.equal(oppositeCase.toLowerCase(), originalId.toLowerCase())
  const caseAuthenticator = new TestWebauthnAuthenticator()
  caseAuthenticator.credentialId.set(Buffer.from(oppositeCase, 'base64url'))
  assert.equal(caseAuthenticator.credentialId.toString('base64url'), oppositeCase)
  const operatorKey = await register(operatorSession, OPERATOR_PASSWORD, caseAuthenticator, '大小写不同原始字节密钥')
  assert.notEqual(operatorKey.id, adminKey.id)
  assert.equal(await AppDataSource.getRepository(SysUserWebauthnCredential).count(), 2)
  console.log('[admin-webauthn-negative-verify] PASS 2/5 同/异账号重复原始 ID 拒绝，大小写不同的真实字节允许')

  const badCborOptions = await registerOptions(adminSession, ADMIN_PASSWORD, '无效 CBOR')
  const badCbor = adminAuthenticator.registration(badCborOptions.options.challenge, ORIGIN, 'localhost')
  badCbor.response.attestationObject = Buffer.from([0xff]).toString('base64url')
  assert.equal((await completeRegistration(adminSession, badCborOptions, badCbor)).status, 400)
  const mismatchedIdOptions = await registerOptions(adminSession, ADMIN_PASSWORD, '凭据 ID 篡改')
  const mismatchedIdFixture = new TestWebauthnAuthenticator()
  const mismatchedId = mismatchedIdFixture.registration(mismatchedIdOptions.options.challenge, ORIGIN, 'localhost')
  mismatchedId.rawId = adminAuthenticator.credentialId.toString('base64url')
  assert.equal((await completeRegistration(adminSession, mismatchedIdOptions, mismatchedId)).status, 400)
  for (const [label, origin, rpId] of [
    ['错误 Origin', 'https://evil.example', 'localhost'],
    ['错误 RP', ORIGIN, 'evil.example'],
  ] as const) {
    const options = await registerOptions(adminSession, ADMIN_PASSWORD, label)
    const forged = new TestWebauthnAuthenticator()
    const response = await completeRegistration(adminSession, options, forged.registration(options.options.challenge, origin, rpId))
    assert.equal(response.status, 400, `none attestation 的 ${label} 必须拒绝`)
  }
  await expectRejectedKey(adminAuthenticator, adminKey.handle, 'signature')
  await expectRejectedKey(adminAuthenticator, adminKey.handle, 'rp')
  await expectRejectedKey(adminAuthenticator, adminKey.handle, 'origin')

  const wrongSessionOptions = await registerOptions(adminSession, ADMIN_PASSWORD, '跨会话挑战')
  const wrongSessionResponse = adminAuthenticator.registration(wrongSessionOptions.options.challenge, ORIGIN, 'localhost')
  assert.equal((await completeRegistration(secondAdminSession, wrongSessionOptions, wrongSessionResponse)).status, 401)
  const wrongAccountOptions = await registerOptions(adminSession, ADMIN_PASSWORD, '跨账号挑战')
  const wrongAccountResponse = adminAuthenticator.registration(wrongAccountOptions.options.challenge, ORIGIN, 'localhost')
  assert.equal((await completeRegistration(operatorSession, wrongAccountOptions, wrongAccountResponse)).status, 401)
  const loginForPurpose = await keyTicket()
  const purposeRegistration = adminAuthenticator.registration(loginForPurpose.options.challenge, ORIGIN, 'localhost')
  assert.equal((await call('POST', '/api/auth/webauthn/register/verify', {
    challengeId: loginForPurpose.challengeId, response: purposeRegistration,
  }, adminSession.headers)).status, 401, '登录票据不得作为注册票据')
  const registerForPurpose = await registerOptions(adminSession, ADMIN_PASSWORD, '跨用途挑战')
  const purposeAuthentication = adminAuthenticator.authentication(registerForPurpose.options.challenge, ORIGIN, 'localhost', adminKey.handle, 1)
  const wrongPurpose = await call('POST', '/api/auth/webauthn/login/verify', {
    challengeId: registerForPurpose.challengeId, response: purposeAuthentication,
  }, { Origin: ORIGIN, Cookie: `y_link_webauthn_nonce=${loginForPurpose.nonce}` })
  assert.equal(wrongPurpose.status, 401, '注册票据不得作为登录票据')
  noAdminCookie(wrongPurpose)
  const expiredRegistration = await registerOptions(adminSession, ADMIN_PASSWORD, '过期注册挑战')
  const expiredRegResponse = adminAuthenticator.registration(expiredRegistration.options.challenge, ORIGIN, 'localhost')
  const expiredLogin = await keyTicket()
  const expiredAuthResponse = adminAuthenticator.authentication(expiredLogin.options.challenge, ORIGIN, 'localhost', adminKey.handle, 1)
  const actualNow = Date.now
  let expiredRegStatus: number
  let expiredLoginResponse: Response
  try {
    Date.now = () => actualNow() + 301_000
    expiredRegStatus = (await completeRegistration(adminSession, expiredRegistration, expiredRegResponse)).status
    expiredLoginResponse = await keyVerify(expiredLogin, expiredAuthResponse)
  } finally {
    Date.now = actualNow
  }
  assert.equal(expiredRegStatus, 401, '注册票据超时必须拒绝')
  assert.equal(expiredLoginResponse.status, 401, '登录票据超时必须拒绝')
  noAdminCookie(expiredLoginResponse)
  assert.equal((await credentialState(adminKey.id)).counter, adminBeforeCrossAccount.counter)
  console.log('[admin-webauthn-negative-verify] PASS 3/5 none CBOR/Origin/RP、ES256 签名/Origin/RP、过期及跨用途/会话挑战拒绝')

  const beforeRollback = await credentialState(adminKey.id)
  const sessionsBeforeRollback = await AppDataSource.getRepository(SysUserSession).count({ where: { userId: adminAuth.userId } })
  const auditsBeforeRollback = await AppDataSource.getRepository(SysAuditLog).count({
    where: { actionType: 'auth.login', actorUserId: adminAuth.userId, resultStatus: 'success' },
  })
  const rollbackTicket = await keyTicket()
  // 故障只注入脚本自建 SQLite；真实业务审计服务、事务与 SDK 均保持原状。
  await AppDataSource.query(`CREATE TRIGGER test_fail_success_login_audit
    BEFORE INSERT ON sys_audit_log
    WHEN NEW.action_type = 'auth.login' AND NEW.result_status = 'success'
    BEGIN SELECT RAISE(ABORT, 'injected_audit_write_failure'); END`)
  let rollbackResponse: Response
  try {
    rollbackResponse = await keyVerify(rollbackTicket, adminAuthenticator.authentication(
      rollbackTicket.options.challenge, ORIGIN, 'localhost', adminKey.handle, 1,
    ))
  } finally {
    await AppDataSource.query('DROP TRIGGER test_fail_success_login_audit')
  }
  assert.equal(rollbackResponse.status, 500, '成功审计写入故障必须回滚登录事务')
  noAdminCookie(rollbackResponse)
  assert.deepEqual(await credentialState(adminKey.id), beforeRollback, '计数器与最后使用时间必须回滚')
  assert.equal(await AppDataSource.getRepository(SysUserSession).count({ where: { userId: adminAuth.userId } }), sessionsBeforeRollback)
  assert.equal(await AppDataSource.getRepository(SysAuditLog).count({
    where: { actionType: 'auth.login', actorUserId: adminAuth.userId, resultStatus: 'success' },
  }), auditsBeforeRollback)
  const afterRollbackTicket = await keyTicket()
  const afterRollbackLogin = await keyVerify(afterRollbackTicket, adminAuthenticator.authentication(
    afterRollbackTicket.options.challenge, ORIGIN, 'localhost', adminKey.handle, 1,
  ))
  assert.equal(afterRollbackLogin.status, 200, '同一非零计数器在事务回滚后须可重新成功登录')
  assert.equal(Number((await credentialState(adminKey.id)).counter), 1)
  console.log('[admin-webauthn-negative-verify] PASS 4/5 审计故障使计数器、lastUsed、会话与成功审计原子回滚')

  const reset = await call('POST', `/api/users/${operator.id}/reset-password`, {
    newPassword: OPERATOR_NEW_PASSWORD,
  }, adminSession.headers)
  assert.equal(reset.status, 200, '管理员重置目标密码应成功')
  assert.equal(await AppDataSource.getRepository(SysUserWebauthnCredential).count({ where: { userId: operator.id } }), 1, '重置密码须保留密钥')
  assert.equal((await call('GET', '/api/auth/me', undefined, operatorSession.headers)).status, 401, '目标旧会话必须失效')
  const operatorTicket = await keyTicket()
  const operatorKeyLogin = await keyVerify(operatorTicket, caseAuthenticator.authentication(
    operatorTicket.options.challenge, ORIGIN, 'localhost', operatorKey.handle, 0,
  ))
  assert.equal(operatorKeyLogin.status, 200, '原密钥经新挑战仍可登录改密后的同一账号')
  assert.ok(operatorKeyLogin.headers.getSetCookie().some((line) => line.startsWith('y_link_admin_session=')))
  const disabled = await call('PATCH', `/api/users/${operator.id}/status`, { status: 'disabled' }, adminSession.headers)
  assert.equal(disabled.status, 200)
  const adminReset = await call('POST', `/api/users/${operator.id}/webauthn/reset`, {
    currentPassword: ADMIN_PASSWORD, reason: '停用账号密钥回收验证',
  }, adminSession.headers)
  assert.equal(adminReset.status, 200, '管理员应可撤销已停用目标密钥')
  assert.equal((await adminReset.json() as { data?: { revokedCount?: number } }).data?.revokedCount, 1)
  assert.equal((await AppDataSource.getRepository(SysUser).findOneByOrFail({ id: operator.id })).status, 'disabled')
  assert.equal((await call('GET', '/api/auth/me', undefined, adminSession.headers)).status, 200, '操作者自身会话应保留')
  console.log('[admin-webauthn-negative-verify] PASS 5/5 重置密码保留密钥并吊销旧会话；停用目标可撤销且操作者会话保留')
} finally {
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()))
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
  const parent = fs.realpathSync(path.dirname(tempRoot))
  const child = fs.realpathSync(tempRoot)
  assert.equal(parent, fs.realpathSync(testDataRoot), '清理父目录必须是本任务 test-data')
  assert.equal(path.dirname(child), parent, '只能清理本次创建的临时库目录')
  assert.match(path.basename(child), /^run-negative-\d+-[A-Za-z0-9]+$/)
  fs.rmSync(child, { recursive: true, force: false })
  console.log('[admin-webauthn-negative-verify] 自有临时 SQLite 与数据目录已清理')
}
