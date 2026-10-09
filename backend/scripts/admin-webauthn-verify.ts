/**
 * 管理端 WebAuthn 回归：只连接脚本自建的 ASCII 路径 SQLite 库，拒绝继承外部数据库配置。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

const inherited = ['ENV_FILE', 'APP_PROFILE', 'DB_TYPE', 'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'SQLITE_DB_PATH']
  .filter((key) => process.env[key] !== undefined)
assert.equal(inherited.length, 0, `隔离验证拒绝继承数据库或 env 配置：${inherited.join(', ')}`)
const mysqlMode = process.argv.includes('--mysql')
const backendRoot = path.resolve(process.cwd())
assert.equal(fs.existsSync(path.join(backendRoot, '.env')), false, '隔离验证拒绝读取真实 backend/.env')
const tempRoot = path.resolve(backendRoot, `../tmp/admin-webauthn-20261009-backend/test-data/run-${process.pid}-${Date.now()}`)
assert.ok(tempRoot.startsWith(path.resolve(backendRoot, '../tmp/admin-webauthn-20261009-backend') + path.sep))
fs.mkdirSync(tempRoot, { recursive: true })
const sqlitePath = path.join(tempRoot, 'webauthn-test.sqlite')
assert.equal(fs.existsSync(sqlitePath), false, '隔离验证拒绝复用已有测试库')
process.env.NODE_ENV = 'test'
process.env.APP_PROFILE = 'admin-webauthn-verify'
if (mysqlMode) {
  const mysqlPort = Number(process.env.WEBAUTHN_VERIFY_MYSQL_PORT)
  const mysqlName = process.env.WEBAUTHN_VERIFY_MYSQL_NAME ?? ''
  assert.equal(process.env.WEBAUTHN_VERIFY_MYSQL_CONFIRM, 'true', 'MySQL 实例必须由本任务隔离启动器确认')
  assert.ok(Number.isInteger(mysqlPort) && mysqlPort >= 10_000 && mysqlPort <= 65_535)
  assert.match(mysqlName, /^ylink_webauthn_[a-f0-9]{16}$/)
  process.env.DB_TYPE = 'mysql'
  process.env.DB_HOST = '127.0.0.1'
  process.env.DB_PORT = String(mysqlPort)
  process.env.DB_USER = 'root'
  process.env.DB_PASSWORD = ''
  process.env.DB_NAME = mysqlName
  process.env.DB_SYNC = 'true'
} else {
  process.env.DB_TYPE = 'sqlite'
  process.env.DB_SYNC = 'false'
  process.env.SQLITE_DB_PATH = sqlitePath
}
process.env.Y_LINK_DATA_DIR = path.join(tempRoot, 'app-data')
process.env.Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE = 'true'
process.env.INIT_ADMIN_PASSWORD = 'Webauthn-Verify#Admin2026'
process.env.PERMANENT_DELETE_PASSWORD = 'Webauthn-Verify#Permanent2026'
const enabled = process.argv.includes('--enabled')
process.env.AUTH_WEBAUTHN_ENABLED = enabled ? 'true' : 'false'
if (enabled) {
  process.env.AUTH_WEBAUTHN_RP_ID = 'localhost'
  process.env.AUTH_WEBAUTHN_RP_NAME = 'Y-Link 验证'
  process.env.AUTH_WEBAUTHN_ORIGINS = '["http://localhost:3000"]'
}

const { AppDataSource } = await import('../src/config/data-source.js')
const bootstrap = await import('../src/config/database-bootstrap.js')
const { authService } = await import('../src/services/auth.service.js')
const { userService } = await import('../src/services/user.service.js')
const { adminWebauthnService } = await import('../src/services/admin-webauthn.service.js')
const { resolvePermissionsByRole } = await import('../src/constants/auth-permissions.js')
const { SysUser } = await import('../src/entities/sys-user.entity.js')
const { SysUserWebauthnCredential } = await import('../src/entities/sys-user-webauthn-credential.entity.js')
const { createApp } = await import('../src/app.js')
const { TestWebauthnAuthenticator } = await import('./admin-webauthn-fixture.js')
const { computeHotp, currentTotpStep, decodeBase32 } = await import('../src/utils/totp.js')
let server: Server | undefined
try {
  bootstrap.prepareDatabaseRuntime()
  await AppDataSource.initialize()
  await bootstrap.initializeDatabaseSchemaIfNeeded(AppDataSource)
  await authService.ensureDefaultAdmin()
  const userColumns = await AppDataSource.query(mysqlMode
    ? 'SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'sys_user\''
    : 'PRAGMA table_info(sys_user)') as Array<{ name: string }>
  assert.ok(userColumns.some((column) => column.name === 'webauthn_user_handle'), '旧 SQLite 自举必须补用户句柄列')
  const credentialColumns = await AppDataSource.query(mysqlMode
    ? 'SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'sys_user_webauthn_credential\''
    : 'PRAGMA table_info(sys_user_webauthn_credential)') as Array<{ name: string }>
  for (const column of ['user_id', 'rp_id', 'credential_id_sha256', 'credential_id', 'public_key', 'counter', 'name', 'device_type', 'backed_up']) {
    assert.ok(credentialColumns.some((item) => item.name === column), `凭据表缺 ${column}`)
  }
  server = createApp().listen(0, 'localhost')
  await new Promise<void>((resolve) => server!.once('listening', resolve))
  const port = (server.address() as AddressInfo).port
  const response = await fetch(`http://localhost:${port}/api/auth/webauthn/capabilities`)
  const body = await response.json() as { code: number; data?: { enabled?: boolean } }
  assert.equal(response.status, 200, '关闭功能时也应提供能力查询')
  assert.equal(body.code, 0)
  assert.equal(body.data?.enabled, enabled)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  if (!enabled) {
    const login = await fetch(`http://localhost:${port}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: process.env.INIT_ADMIN_PASSWORD }),
    })
    assert.equal(login.status, 200)
    const cookies = login.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ')
    const csrf = decodeURIComponent(/y_link_admin_csrf=([^;]+)/.exec(cookies)?.[1] ?? '')
    const headers = { 'Content-Type': 'application/json', Cookie: cookies, 'x-csrf-token': csrf }
    const user = await AppDataSource.getRepository(SysUser).findOneByOrFail({ username: 'admin' })
    const fakeRawId = Buffer.alloc(32, 7)
    const { createHash } = await import('node:crypto')
    const repo = AppDataSource.getRepository(SysUserWebauthnCredential)
    const fixture = await repo.save(repo.create({
      userId: user.id, rpId: 'localhost', credentialIdSha256: createHash('sha256').update(fakeRawId).digest('hex'),
      credentialId: fakeRawId, publicKey: Buffer.alloc(77, 1), counter: '0', transportsJson: null,
      deviceType: 'singleDevice', backedUp: false, name: '关闭前已绑定', lastUsedAt: null,
    }))
    const listed = await fetch(`http://localhost:${port}/api/auth/webauthn/credentials`, { headers })
    assert.equal(listed.status, 200, '关闭功能时仍可查询现有密钥')
    assert.equal((await listed.json() as { data?: unknown[] }).data?.length, 1)
    const renamed = await fetch(`http://localhost:${port}/api/auth/webauthn/credentials/${fixture.id}`, {
      method: 'PATCH', headers, body: JSON.stringify({ name: '关闭后改名' }),
    })
    assert.equal(renamed.status, 200, '关闭功能且未配置 Origin 时仍可改名')
    const deleted = await fetch(`http://localhost:${port}/api/auth/webauthn/credentials/${fixture.id}`, {
      method: 'DELETE', headers, body: JSON.stringify({ currentPassword: process.env.INIT_ADMIN_PASSWORD }),
    })
    assert.equal(deleted.status, 200, '关闭功能且未配置 Origin 时仍可删除')
    assert.equal(await repo.count({ where: { userId: user.id } }), 0)
    console.log('[admin-webauthn-verify] 关闭开关且无 RP/Origin 配置时，本人列表、改名、删除与会话吊销通过')
  }
  if (enabled) {
    const missingOrigin = await fetch(`http://localhost:${port}/api/auth/webauthn/login/options`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    })
    assert.equal(missingOrigin.status, 403, '匿名挑战缺少 Origin 必须拒绝')
    const optionsResponse = await fetch(`http://localhost:${port}/api/auth/webauthn/login/options`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' }, body: '{}',
    })
    const optionsBody = await optionsResponse.json() as { data?: { challengeId?: string; options?: { challenge?: string; rpId?: string; userVerification?: string; allowCredentials?: unknown[] }; expiresInSeconds?: number } }
    assert.equal(optionsResponse.status, 200, '无需用户名获取发现式登录挑战')
    assert.ok(optionsBody.data?.challengeId)
    assert.ok(optionsBody.data?.options?.challenge)
    assert.equal(optionsBody.data?.options?.rpId, 'localhost')
    assert.equal(optionsBody.data?.options?.userVerification, 'required')
    assert.equal(optionsBody.data?.options?.allowCredentials, undefined)
    assert.equal(optionsBody.data?.expiresInSeconds, 300)
    const nonceCookie = optionsResponse.headers.getSetCookie().find((value) => value.startsWith('y_link_webauthn_nonce='))
    assert.match(nonceCookie ?? '', /HttpOnly; SameSite=Strict/)
    assert.match(nonceCookie ?? '', /Path=\/api\/auth\/webauthn\/login/)

    const login = await fetch(`http://localhost:${port}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: process.env.INIT_ADMIN_PASSWORD }),
    })
    assert.equal(login.status, 200)
    const authCookies = login.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ')
    const csrf = decodeURIComponent(/y_link_admin_csrf=([^;]+)/.exec(authCookies)?.[1] ?? '')
    assert.ok(csrf)
    const sessionHeaders = { 'Content-Type': 'application/json', Origin: 'http://localhost:3000', Cookie: authCookies, 'x-csrf-token': csrf }
    const list = await fetch(`http://localhost:${port}/api/auth/webauthn/credentials`, { headers: sessionHeaders })
    assert.equal(list.status, 200, '本人可读取安全凭据列表')
    assert.deepEqual((await list.json() as { data: unknown }).data, [])
    const noCsrfRegister = await fetch(`http://localhost:${port}/api/auth/webauthn/register/options`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000', Cookie: authCookies },
      body: JSON.stringify({ name: '拒绝跨站绑定', kind: 'passkey', currentPassword: process.env.INIT_ADMIN_PASSWORD }),
    })
    assert.equal(noCsrfRegister.status, 403, 'Cookie 会话注册必须具备 CSRF 证明')
    const wrongOriginRegister = await fetch(`http://localhost:${port}/api/auth/webauthn/register/options`, {
      method: 'POST', headers: { ...sessionHeaders, Origin: 'https://evil.example' },
      body: JSON.stringify({ name: '拒绝错误来源', kind: 'passkey', currentPassword: process.env.INIT_ADMIN_PASSWORD }),
    })
    assert.equal(wrongOriginRegister.status, 403, '注册来源必须精确匹配白名单')
    const badUvOptionsResponse = await fetch(`http://localhost:${port}/api/auth/webauthn/register/options`, {
      method: 'POST', headers: sessionHeaders,
      body: JSON.stringify({ name: 'UV 失败样本', kind: 'passkey', currentPassword: process.env.INIT_ADMIN_PASSWORD }),
    })
    assert.equal(badUvOptionsResponse.status, 200)
    const badUvOptions = await badUvOptionsResponse.json() as { data?: { challengeId?: string; options?: { challenge?: string } } }
    const badUvAuthenticator = new TestWebauthnAuthenticator()
    const badUvVerify = await fetch(`http://localhost:${port}/api/auth/webauthn/register/verify`, {
      method: 'POST', headers: sessionHeaders,
      body: JSON.stringify({ challengeId: badUvOptions.data?.challengeId,
        response: badUvAuthenticator.registration(badUvOptions.data!.options!.challenge!, 'http://localhost:3000', 'localhost', false) }),
    })
    assert.equal(badUvVerify.status, 400, '注册 attestation 缺少 UV 必须拒绝')
    const badOriginOptionsResponse = await fetch(`http://localhost:${port}/api/auth/webauthn/register/options`, {
      method: 'POST', headers: sessionHeaders,
      body: JSON.stringify({ name: 'Origin 失败样本', kind: 'passkey', currentPassword: process.env.INIT_ADMIN_PASSWORD }),
    })
    assert.equal(badOriginOptionsResponse.status, 200)
    const badOriginOptions = await badOriginOptionsResponse.json() as { data?: { challengeId?: string; options?: { challenge?: string } } }
    const badOriginAuthenticator = new TestWebauthnAuthenticator()
    const badOriginVerify = await fetch(`http://localhost:${port}/api/auth/webauthn/register/verify`, {
      method: 'POST', headers: sessionHeaders,
      body: JSON.stringify({ challengeId: badOriginOptions.data?.challengeId,
        response: badOriginAuthenticator.registration(badOriginOptions.data!.options!.challenge!, 'https://evil.example', 'localhost') }),
    })
    assert.equal(badOriginVerify.status, 400, '客户端数据中的 Origin 也必须经 SDK 验证')
    console.log('[admin-webauthn-verify] 注册 CSRF、Origin 和 attestation UV 负例通过')
    const register = await fetch(`http://localhost:${port}/api/auth/webauthn/register/options`, {
      method: 'POST', headers: sessionHeaders,
      body: JSON.stringify({ name: ' 主认证器 ', kind: 'passkey', currentPassword: process.env.INIT_ADMIN_PASSWORD }),
    })
    const registerBody = await register.json() as { data?: { challengeId?: string; options?: { challenge?: string; user?: { id?: string }; authenticatorSelection?: { residentKey?: string; userVerification?: string }; attestation?: string } } }
    assert.equal(register.status, 200, `本人可获取注册挑战：${JSON.stringify(registerBody)}`)
    assert.ok(registerBody.data?.challengeId)
    assert.ok(registerBody.data?.options?.challenge)
    assert.match(registerBody.data?.options?.user?.id ?? '', /^[A-Za-z0-9_-]{43}$/)
    assert.equal(registerBody.data?.options?.authenticatorSelection?.residentKey, 'required')
    assert.equal(registerBody.data?.options?.authenticatorSelection?.userVerification, 'required')
    assert.equal(registerBody.data?.options?.attestation, 'none')
    const authenticator = new TestWebauthnAuthenticator()
    const registrationResponse = authenticator.registration(registerBody.data!.options!.challenge!, 'http://localhost:3000', 'localhost')
    const registered = await fetch(`http://localhost:${port}/api/auth/webauthn/register/verify`, {
      method: 'POST', headers: sessionHeaders,
      body: JSON.stringify({ challengeId: registerBody.data?.challengeId, response: registrationResponse }),
    })
    const registeredBody = await registered.json() as { data?: { id?: string; name?: string; deviceType?: string; backedUp?: boolean } }
    assert.equal(registered.status, 200, `真实 attestation 应完成注册：${JSON.stringify(registeredBody)}`)
    assert.ok(registeredBody.data?.id)
    assert.equal(registeredBody.data?.name, '主认证器')
    assert.equal(JSON.stringify(registeredBody).includes(authenticator.credentialId.toString('base64url')), false, '不得返回原始 credential ID')
    const storedList = await fetch(`http://localhost:${port}/api/auth/webauthn/credentials`, { headers: sessionHeaders })
    assert.equal((await storedList.json() as { data: unknown[] }).data.length, 1)
    const usersResponse = await fetch(`http://localhost:${port}/api/users`, { headers: sessionHeaders })
    const usersBody = await usersResponse.json() as { data?: { list?: Array<{ username: string; webauthnCredentialsCount?: number }> } }
    assert.equal(usersBody.data?.list?.find((item) => item.username === 'admin')?.webauthnCredentialsCount, 1, '用户列表给管理员显示可撤销的密钥数量')
    const meResponse = await fetch(`http://localhost:${port}/api/auth/me`, { headers: sessionHeaders })
    const meBody = await meResponse.json() as { data?: { webauthnCredentialsCount?: number } }
    assert.equal(meBody.data?.webauthnCredentialsCount, 1, '个人资料显示已绑定数量')

    const assertion = authenticator.authentication(
      optionsBody.data!.options!.challenge!, 'http://localhost:3000', 'localhost', registerBody.data!.options!.user!.id!, 0,
    )
    const verifyRequest = { challengeId: optionsBody.data!.challengeId, response: assertion }
    const loginByKey = await fetch(`http://localhost:${port}/api/auth/webauthn/login/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000', Cookie: nonceCookie!.split(';')[0] },
      body: JSON.stringify(verifyRequest),
    })
    const keyLoginBody = await loginByKey.json() as { data?: { user?: { username?: string } } }
    assert.equal(loginByKey.status, 200, `真实签名应完成发现式登录：${JSON.stringify(keyLoginBody)}`)
    assert.equal(keyLoginBody.data?.user?.username, 'admin')
    assert.ok(loginByKey.headers.getSetCookie().some((line) => line.startsWith('y_link_admin_session=')))
    const replay = await fetch(`http://localhost:${port}/api/auth/webauthn/login/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000', Cookie: nonceCookie!.split(';')[0] },
      body: JSON.stringify(verifyRequest),
    })
    assert.equal(replay.status, 401, '同一挑战重放必须失败')
    console.log('[admin-webauthn-verify] 真实 attestation 与发现式 ES256 登录、挑战重放通过')
    const adminUser = await AppDataSource.getRepository(SysUser).findOneByOrFail({ username: 'admin' })
    const targetPassword = 'Webauthn-Verify#Operator2026'
    const operator = await userService.create({
      username: 'key-operator', displayName: '密钥操作员', password: targetPassword, role: 'operator', status: 'enabled',
    }, {
      userId: adminUser.id, username: adminUser.username, displayName: adminUser.displayName,
      role: adminUser.role, status: adminUser.status, permissions: resolvePermissionsByRole(adminUser.role),
      sessionToken: /y_link_admin_session=([^;]+)/.exec(authCookies)?.[1] ?? '', authSource: 'cookie',
    })
    const operatorLogin = await fetch(`http://localhost:${port}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: operator.username, password: targetPassword }),
    })
    assert.equal(operatorLogin.status, 200)
    const operatorCookies = operatorLogin.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ')
    const operatorCsrf = decodeURIComponent(/y_link_admin_csrf=([^;]+)/.exec(operatorCookies)?.[1] ?? '')
    const operatorHeaders = { 'Content-Type': 'application/json', Origin: 'http://localhost:3000', Cookie: operatorCookies, 'x-csrf-token': operatorCsrf }
    const operatorRegister = await fetch(`http://localhost:${port}/api/auth/webauthn/register/options`, {
      method: 'POST', headers: operatorHeaders,
      body: JSON.stringify({ name: '操作员密钥', kind: 'security_key', currentPassword: targetPassword }),
    })
    const operatorOptions = await operatorRegister.json() as { data?: { challengeId?: string; options?: { challenge?: string } } }
    assert.equal(operatorRegister.status, 200)
    const operatorAuthenticator = new TestWebauthnAuthenticator()
    const operatorVerified = await fetch(`http://localhost:${port}/api/auth/webauthn/register/verify`, {
      method: 'POST', headers: operatorHeaders,
      body: JSON.stringify({ challengeId: operatorOptions.data?.challengeId, response: operatorAuthenticator.registration(operatorOptions.data!.options!.challenge!, 'http://localhost:3000', 'localhost') }),
    })
    assert.equal(operatorVerified.status, 200, '另一角色也可自愿绑定')
    const pendingOperatorRegister = await fetch(`http://localhost:${port}/api/auth/webauthn/register/options`, {
      method: 'POST', headers: operatorHeaders,
      body: JSON.stringify({ name: '撤销前的在途注册', kind: 'passkey', currentPassword: targetPassword }),
    })
    assert.equal(pendingOperatorRegister.status, 200)
    const pendingOperatorOptions = await pendingOperatorRegister.json() as { data?: { challengeId?: string; options?: { challenge?: string } } }
    const pendingAuthenticator = new TestWebauthnAuthenticator()
    const selfReset = await fetch(`http://localhost:${port}/api/users/${adminUser.id}/webauthn/reset`, {
      method: 'POST', headers: sessionHeaders,
      body: JSON.stringify({ currentPassword: process.env.INIT_ADMIN_PASSWORD, reason: '测试撤销' }),
    })
    assert.equal(selfReset.status, 400, '管理员不能从治理入口撤销自己')
    const operatorReset = await fetch(`http://localhost:${port}/api/users/${adminUser.id}/webauthn/reset`, {
      method: 'POST', headers: operatorHeaders,
      body: JSON.stringify({ currentPassword: targetPassword, reason: '测试越权' }),
    })
    assert.equal(operatorReset.status, 403, 'operator 不能撤销其他账号密钥')
    let reachedService!: () => void
    let releaseService!: () => void
    const serviceEntered = new Promise<void>((resolve) => { reachedService = resolve })
    const releaseGate = new Promise<void>((resolve) => { releaseService = resolve })
    const originalCompleteRegistration = adminWebauthnService.completeRegistration
    adminWebauthnService.completeRegistration = async (...args) => {
      reachedService()
      await releaseGate
      return originalCompleteRegistration.apply(adminWebauthnService, args)
    }
    let pendingVerify: Promise<Response> | undefined
    try {
      pendingVerify = fetch(`http://localhost:${port}/api/auth/webauthn/register/verify`, {
        method: 'POST', headers: operatorHeaders,
        body: JSON.stringify({
          challengeId: pendingOperatorOptions.data?.challengeId,
          response: pendingAuthenticator.registration(pendingOperatorOptions.data!.options!.challenge!, 'http://localhost:3000', 'localhost'),
        }),
      })
      await Promise.race([
        serviceEntered,
        pendingVerify.then(() => { throw new Error('在途注册未通过 HTTP 鉴权进入服务层') }),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('在途注册 barrier 超时')), 5000)),
      ])
      const reset = await fetch(`http://localhost:${port}/api/users/${operator.id}/webauthn/reset`, {
        method: 'POST', headers: sessionHeaders,
        body: JSON.stringify({ currentPassword: process.env.INIT_ADMIN_PASSWORD, reason: '遗失设备需撤销' }),
      })
      const resetBody = await reset.json() as { data?: { revokedCount?: number } }
      assert.equal(reset.status, 200, `管理员可撤销目标密钥：${JSON.stringify(resetBody)}`)
      assert.equal(resetBody.data?.revokedCount, 1)
      releaseService()
      const staleOperatorRegistration = await pendingVerify
      assert.equal(staleOperatorRegistration.status, 401, '旧请求通过 HTTP 鉴权后才被撤销，服务层账号锁内会话复核必须拒绝落库')
    } finally {
      releaseService()
      adminWebauthnService.completeRegistration = originalCompleteRegistration
      if (pendingVerify) await pendingVerify.catch(() => undefined)
    }
    assert.equal((await fetch(`http://localhost:${port}/api/auth/me`, { headers: operatorHeaders })).status, 401, '管理员撤销同时吊销目标会话')
    assert.equal(await AppDataSource.getRepository(SysUserWebauthnCredential).count({ where: { userId: operator.id } }), 0)
    console.log('[admin-webauthn-verify] 双操作者 HTTP 鉴权后 barrier、管理员撤销会话与在途注册拒绝通过')

    const operatorRelogin = await fetch(`http://localhost:${port}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: operator.username, password: targetPassword }),
    })
    assert.equal(operatorRelogin.status, 200, '独立的密码重新登录仍可绑定新密钥')
    const reloginCookies = operatorRelogin.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ')
    const reloginCsrf = decodeURIComponent(/y_link_admin_csrf=([^;]+)/.exec(reloginCookies)?.[1] ?? '')
    const reloginHeaders = { 'Content-Type': 'application/json', Origin: 'http://localhost:3000', Cookie: reloginCookies, 'x-csrf-token': reloginCsrf }
    const mfaEnrollment = await fetch(`http://localhost:${port}/api/auth/mfa/enroll`, {
      method: 'POST', headers: reloginHeaders, body: JSON.stringify({ currentPassword: targetPassword }),
    })
    assert.equal(mfaEnrollment.status, 200)
    const mfaEnrollmentBody = await mfaEnrollment.json() as { data?: { secret?: string } }
    const mfaCode = computeHotp(decodeBase32(mfaEnrollmentBody.data!.secret!), currentTotpStep())
    const mfaConfirmed = await fetch(`http://localhost:${port}/api/auth/mfa/enroll/confirm`, {
      method: 'POST', headers: reloginHeaders, body: JSON.stringify({ code: mfaCode }),
    })
    assert.equal(mfaConfirmed.status, 200)
    const mfaConfirmedBody = await mfaConfirmed.json() as { data?: { recoveryCodes?: string[] } }
    const recoveryCodes = mfaConfirmedBody.data!.recoveryCodes!
    assert.equal(recoveryCodes.length, 10)
    const noFactorRegister = await fetch(`http://localhost:${port}/api/auth/webauthn/register/options`, {
      method: 'POST', headers: reloginHeaders,
      body: JSON.stringify({ name: '缺少第二因素', kind: 'passkey', currentPassword: targetPassword }),
    })
    assert.equal(noFactorRegister.status, 400, '已开启 TOTP 时注册必须复核第二因素')
    const reloginRegister = await fetch(`http://localhost:${port}/api/auth/webauthn/register/options`, {
      method: 'POST', headers: reloginHeaders,
      body: JSON.stringify({ name: '重新绑定', kind: 'passkey', currentPassword: targetPassword, recoveryCode: recoveryCodes[0] }),
    })
    assert.equal(reloginRegister.status, 200)
    const reloginOptions = await reloginRegister.json() as { data?: { challengeId?: string; options?: { challenge?: string; user?: { id?: string } } } }
    const reloginAuthenticator = new TestWebauthnAuthenticator()
    const reloginVerified = await fetch(`http://localhost:${port}/api/auth/webauthn/register/verify`, {
      method: 'POST', headers: reloginHeaders,
      body: JSON.stringify({ challengeId: reloginOptions.data?.challengeId, response: reloginAuthenticator.registration(reloginOptions.data!.options!.challenge!, 'http://localhost:3000', 'localhost') }),
    })
    assert.equal(reloginVerified.status, 200)
    const reloginCredential = await reloginVerified.json() as { data?: { id?: string } }
    const mfaPasswordLogin = await fetch(`http://localhost:${port}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: operator.username, password: targetPassword }),
    })
    const mfaPasswordBody = await mfaPasswordLogin.json() as { data?: { mfaRequired?: boolean; token?: string } }
    assert.equal(mfaPasswordLogin.status, 200)
    assert.equal(mfaPasswordBody.data?.mfaRequired, true, '原密码路径仍须第二步 TOTP')
    assert.equal(mfaPasswordBody.data?.token, undefined)
    const keyTicket = await adminWebauthnService.beginLogin('http://localhost:3000')
    const mfaKeyLogin = await fetch(`http://localhost:${port}/api/auth/webauthn/login/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000', Cookie: `y_link_webauthn_nonce=${keyTicket.nonce}` },
      body: JSON.stringify({ challengeId: keyTicket.challengeId,
        response: reloginAuthenticator.authentication(keyTicket.options.challenge, 'http://localhost:3000', 'localhost', reloginOptions.data!.options!.user!.id!, 0) }),
    })
    const mfaKeyBody = await mfaKeyLogin.json() as { data?: { user?: { username?: string }; mfaRequired?: boolean } }
    assert.equal(mfaKeyLogin.status, 200, '开启 TOTP 后已验证密钥直接签发同一会话')
    assert.equal(mfaKeyBody.data?.user?.username, operator.username)
    assert.equal(mfaKeyBody.data?.mfaRequired, undefined)
    const keepRegister = await fetch(`http://localhost:${port}/api/auth/webauthn/register/options`, {
      method: 'POST', headers: reloginHeaders,
      body: JSON.stringify({ name: '保留至永久删除', kind: 'security_key', currentPassword: targetPassword, recoveryCode: recoveryCodes[1] }),
    })
    assert.equal(keepRegister.status, 200)
    const keepOptions = await keepRegister.json() as { data?: { challengeId?: string; options?: { challenge?: string } } }
    const keepAuthenticator = new TestWebauthnAuthenticator()
    const keepVerified = await fetch(`http://localhost:${port}/api/auth/webauthn/register/verify`, {
      method: 'POST', headers: reloginHeaders,
      body: JSON.stringify({ challengeId: keepOptions.data?.challengeId,
        response: keepAuthenticator.registration(keepOptions.data!.options!.challenge!, 'http://localhost:3000', 'localhost') }),
    })
    assert.equal(keepVerified.status, 200)
    const noFactorDelete = await fetch(`http://localhost:${port}/api/auth/webauthn/credentials/${reloginCredential.data?.id}`, {
      method: 'DELETE', headers: reloginHeaders, body: JSON.stringify({ currentPassword: targetPassword }),
    })
    assert.equal(noFactorDelete.status, 400, '已开启 TOTP 时删除必须复核第二因素')
    const withFactorDelete = await fetch(`http://localhost:${port}/api/auth/webauthn/credentials/${reloginCredential.data?.id}`, {
      method: 'DELETE', headers: reloginHeaders,
      body: JSON.stringify({ currentPassword: targetPassword, recoveryCode: recoveryCodes[2] }),
    })
    assert.equal(withFactorDelete.status, 200, '恢复码可完成密钥删除复核')
    assert.equal(await AppDataSource.getRepository(SysUserWebauthnCredential).count({ where: { userId: operator.id } }), 1)
    console.log('[admin-webauthn-verify] TOTP 开启后注册/删除恢复码复核、密码 MFA 与密钥直接登录通过')
    const adminActor = {
      userId: adminUser.id, username: adminUser.username, displayName: adminUser.displayName,
      role: adminUser.role, status: adminUser.status, permissions: resolvePermissionsByRole(adminUser.role),
      sessionToken: /y_link_admin_session=([^;]+)/.exec(authCookies)?.[1] ?? '', authSource: 'cookie' as const,
    }
    await userService.deactivate(operator.id, { reason: '验证永久删除清理' }, adminActor)
    assert.equal((await fetch(`http://localhost:${port}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: operator.username, password: targetPassword }),
    })).status, 403, '注销账号禁止密码登录')
    await userService.permanentDelete(operator.id, {
      reason: '隔离验证永久删除', confirmAccount: operator.username,
      permanentDeletePassword: process.env.PERMANENT_DELETE_PASSWORD,
    }, adminActor)
    assert.equal(await AppDataSource.getRepository(SysUserWebauthnCredential).count({ where: { userId: operator.id } }), 0, '永久删除须同事务清理凭据')
    const recreated = await userService.create({
      username: operator.username, displayName: '重建同名账号', password: targetPassword, role: 'operator', status: 'enabled',
    }, adminActor)
    assert.notEqual(recreated.id, operator.id, '重建同名账号必须有新用户 ID')
    const oldKeyTicket = await adminWebauthnService.beginLogin('http://localhost:3000')
    const oldKeyLogin = await fetch(`http://localhost:${port}/api/auth/webauthn/login/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000', Cookie: `y_link_webauthn_nonce=${oldKeyTicket.nonce}` },
      body: JSON.stringify({ challengeId: oldKeyTicket.challengeId,
        response: keepAuthenticator.authentication(oldKeyTicket.options.challenge, 'http://localhost:3000', 'localhost', reloginOptions.data!.options!.user!.id!, 1) }),
    })
    assert.equal(oldKeyLogin.status, 401, '旧账号密钥不能登录同名重建的新账号')
    const { createHash } = await import('node:crypto')
    const disabledRawId = Buffer.alloc(32, 9)
    await AppDataSource.getRepository(SysUserWebauthnCredential).save({
      userId: recreated.id, rpId: 'localhost', credentialIdSha256: createHash('sha256').update(disabledRawId).digest('hex'),
      credentialId: disabledRawId, publicKey: Buffer.alloc(77, 2), counter: '0', transportsJson: null,
      deviceType: 'singleDevice', backedUp: false, name: '待管理员撤销', lastUsedAt: null,
    })
    await userService.deactivate(recreated.id, { reason: '验证已注销目标仍可撤销密钥' }, adminActor)
    const disabledReset = await fetch(`http://localhost:${port}/api/users/${recreated.id}/webauthn/reset`, {
      method: 'POST', headers: sessionHeaders,
      body: JSON.stringify({ currentPassword: process.env.INIT_ADMIN_PASSWORD, reason: '已注销账号凭据回收' }),
    })
    const disabledResetBody = await disabledReset.json() as { data?: { revokedCount?: number } }
    assert.equal(disabledReset.status, 200, '管理员可撤销已注销目标的凭据')
    assert.equal(disabledResetBody.data?.revokedCount, 1)
    assert.equal(await AppDataSource.getRepository(SysUserWebauthnCredential).count({ where: { userId: recreated.id } }), 0)
    console.log('[admin-webauthn-verify] 注销禁登、永久删除凭据与同名重建隔离通过')

    const renamed = await fetch(`http://localhost:${port}/api/auth/webauthn/credentials/${registeredBody.data?.id}`, {
      method: 'PATCH', headers: sessionHeaders, body: JSON.stringify({ name: '  备用密钥  ' }),
    })
    const renamedBody = await renamed.json() as { data?: { name?: string } }
    assert.equal(renamed.status, 200, `本人可改名：${JSON.stringify(renamedBody)}`)
    assert.equal(renamedBody.data?.name, '备用密钥')
    const noPasswordDelete = await fetch(`http://localhost:${port}/api/auth/webauthn/credentials/${registeredBody.data?.id}`, {
      method: 'DELETE', headers: sessionHeaders, body: '{}',
    })
    assert.equal(noPasswordDelete.status, 400, '删除必须复核当前密码')
    const remainingRegister = await fetch(`http://localhost:${port}/api/auth/webauthn/register/options`, {
      method: 'POST', headers: sessionHeaders,
      body: JSON.stringify({ name: '待保留密钥', kind: 'passkey', currentPassword: process.env.INIT_ADMIN_PASSWORD }),
    })
    assert.equal(remainingRegister.status, 200)
    const remainingOptions = await remainingRegister.json() as { data?: { challengeId?: string; options?: { challenge?: string } } }
    const remainingAuthenticator = new TestWebauthnAuthenticator()
    const remainingVerify = await fetch(`http://localhost:${port}/api/auth/webauthn/register/verify`, {
      method: 'POST', headers: sessionHeaders,
      body: JSON.stringify({
        challengeId: remainingOptions.data?.challengeId,
        response: remainingAuthenticator.registration(remainingOptions.data!.options!.challenge!, 'http://localhost:3000', 'localhost'),
      }),
    })
    assert.equal(remainingVerify.status, 200)
    const remainingCredential = await remainingVerify.json() as { data?: { id?: string } }
    const deleted = await fetch(`http://localhost:${port}/api/auth/webauthn/credentials/${registeredBody.data?.id}`, {
      method: 'DELETE', headers: sessionHeaders,
      body: JSON.stringify({ currentPassword: process.env.INIT_ADMIN_PASSWORD }),
    })
    assert.equal(deleted.status, 200, '本人可删除密钥')
    assert.ok(deleted.headers.getSetCookie().some((line) => line.startsWith('y_link_admin_session=')), '删除应清理会话 Cookie')
    const oldSession = await fetch(`http://localhost:${port}/api/auth/me`, { headers: sessionHeaders })
    assert.equal(oldSession.status, 401, '删除任一密钥吊销全部本人会话')
    await assert.rejects(
      adminWebauthnService.renameCredential(adminActor, remainingCredential.data!.id!, '失效会话不得改名'),
      /登录状态已失效/,
      '删除另一密钥后，已通过旧 HTTP 鉴权的在途改名也必须在账号锁内失败',
    )
    const attemptKeyLogin = async (userHandle: string, counter: number, uv = true, cookie = true) => {
      const ticket = await adminWebauthnService.beginLogin('http://localhost:3000')
      return fetch(`http://localhost:${port}/api/auth/webauthn/login/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json', Origin: 'http://localhost:3000',
          Cookie: cookie ? `y_link_webauthn_nonce=${ticket.nonce}` : '',
        },
        body: JSON.stringify({
          challengeId: ticket.challengeId,
          response: remainingAuthenticator.authentication(ticket.options.challenge, 'http://localhost:3000', 'localhost', userHandle, counter, uv),
        }),
      })
    }
    assert.equal((await attemptKeyLogin(Buffer.alloc(32, 1).toString('base64url'), 1)).status, 401, '错误 userHandle 不得登录')
    assert.equal((await attemptKeyLogin(registerBody.data!.options!.user!.id!, 1, false)).status, 401, 'UV 未通过不得登录')
    assert.equal((await attemptKeyLogin(registerBody.data!.options!.user!.id!, 1, true, false)).status, 401, '缺少短期 nonce Cookie 不得登录')
    const keyAfterDelete = await attemptKeyLogin(registerBody.data!.options!.user!.id!, 1)
    assert.equal(keyAfterDelete.status, 200, '删除另一把密钥后，剩余密钥的非零计数器真实签名仍可登录')
    assert.equal((await attemptKeyLogin(registerBody.data!.options!.user!.id!, 1)).status, 401, '计数器回退不得登录')
    const adminCredential = await AppDataSource.getRepository(SysUserWebauthnCredential).findOneByOrFail({ id: remainingCredential.data!.id! })
    assert.equal(Number(adminCredential.counter), 1, '失败断言不得提交计数器更新')
    console.log('[admin-webauthn-verify] 失效会话改名拒绝、userHandle/UV/nonce/计数器负例通过')
    const freshCookies = keyAfterDelete.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ')
    const freshCsrf = decodeURIComponent(/y_link_admin_csrf=([^;]+)/.exec(freshCookies)?.[1] ?? '')
    const freshHeaders = { 'Content-Type': 'application/json', Origin: 'http://localhost:3000', Cookie: freshCookies, 'x-csrf-token': freshCsrf }
    const registerAnother = async (name: string) => {
      const optionsResponse = await fetch(`http://localhost:${port}/api/auth/webauthn/register/options`, {
        method: 'POST', headers: freshHeaders,
        body: JSON.stringify({ name, kind: 'passkey', currentPassword: process.env.INIT_ADMIN_PASSWORD }),
      })
      assert.equal(optionsResponse.status, 200, `未达到十把上限时可签发挑战：${name}`)
      const options = await optionsResponse.json() as { data?: { challengeId?: string; options?: { challenge?: string } } }
      const device = new TestWebauthnAuthenticator()
      return { options, device }
    }
    for (let index = 0; index < 8; index += 1) {
      const { options, device } = await registerAnother(`上限夹具 ${index + 1}`)
      const verified = await fetch(`http://localhost:${port}/api/auth/webauthn/register/verify`, {
        method: 'POST', headers: freshHeaders,
        body: JSON.stringify({ challengeId: options.data?.challengeId,
          response: device.registration(options.data!.options!.challenge!, 'http://localhost:3000', 'localhost') }),
      })
      assert.equal(verified.status, 200)
    }
    const raceA = await registerAnother('并发上限 A')
    const raceB = await registerAnother('并发上限 B')
    const raceResults = await Promise.all([raceA, raceB].map(async ({ options, device }) => {
      const verified = await fetch(`http://localhost:${port}/api/auth/webauthn/register/verify`, {
        method: 'POST', headers: freshHeaders,
        body: JSON.stringify({ challengeId: options.data?.challengeId,
          response: device.registration(options.data!.options!.challenge!, 'http://localhost:3000', 'localhost') }),
      })
      return verified.status
    }))
    assert.deepEqual(raceResults.sort(), [200, 409], '两把并发跨越上限只能有一把成功')
    assert.equal(await AppDataSource.getRepository(SysUserWebauthnCredential).count({ where: { userId: adminUser.id } }), 10)
    const overLimit = await fetch(`http://localhost:${port}/api/auth/webauthn/register/options`, {
      method: 'POST', headers: freshHeaders,
      body: JSON.stringify({ name: '第十一把', kind: 'passkey', currentPassword: process.env.INIT_ADMIN_PASSWORD }),
    })
    assert.equal(overLimit.status, 409, '第十一把密钥不能签发注册挑战')
    console.log('[admin-webauthn-verify] 十把密钥上限与并发竞争只能成功一把通过')
  }
  console.log(`[admin-webauthn-verify] ${mysqlMode ? 'MySQL 8.0' : 'SQLite'} ${enabled ? '启用' : '关闭'}能力与匿名挑战通过`)
} finally {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
}
