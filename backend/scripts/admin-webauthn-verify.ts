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
const tempRoot = path.resolve(backendRoot, `../tmp/webauthn-compat-auth/test-data/run-${process.pid}-${Date.now()}`)
assert.ok(tempRoot.startsWith(path.resolve(backendRoot, '../tmp/webauthn-compat-auth') + path.sep))
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
process.env.Y_LINK_TRUST_PROXY = '127.0.0.1/32,::1/128'
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
const { authSecurityService } = await import('../src/services/auth-security.service.js')
const { userService } = await import('../src/services/user.service.js')
const { adminWebauthnService } = await import('../src/services/admin-webauthn.service.js')
const { adminMfaService } = await import('../src/services/admin-mfa.service.js')
const { resolvePermissionsByRole } = await import('../src/constants/auth-permissions.js')
const { SysUser } = await import('../src/entities/sys-user.entity.js')
const { SysUserMfa } = await import('../src/entities/sys-user-mfa.entity.js')
const { SysUserSession } = await import('../src/entities/sys-user-session.entity.js')
const { SysAuditLog } = await import('../src/entities/sys-audit-log.entity.js')
const { SysUserWebauthnCredential } = await import('../src/entities/sys-user-webauthn-credential.entity.js')
const { hashSessionToken } = await import('../src/utils/session-token.js')
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
  const app = createApp({ publicAuthRateLimits: { admin: 1000 } })
  app.set('trust proxy', 'loopback') // 隔离夹具允许为不同虚拟浏览器提供独立来源风险桶。
  server = app.listen(0, 'localhost')
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
  if (enabled && !process.argv.includes('--compat')) {
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
    const nonceCookie = optionsResponse.headers.getSetCookie().find((value) =>
      value.startsWith(`y_link_webauthn_nonce_${optionsBody.data?.challengeId}=`))
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
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000', Cookie: `y_link_webauthn_nonce_${keyTicket.challengeId}=${keyTicket.nonce}` },
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
    const keepCredential = await keepVerified.json() as { data?: { id?: string } }
    const credentialRepository = AppDataSource.getRepository(SysUserWebauthnCredential)
    await credentialRepository.update({ id: reloginCredential.data!.id! }, { rpId: 'old.example' })
    await credentialRepository.update({ id: keepCredential.data!.id! }, { rpId: 'old.example' })
    const staleRpTotpDisable = await fetch(`http://localhost:${port}/api/auth/mfa/totp/disable`, {
      method: 'POST', headers: reloginHeaders,
      body: JSON.stringify({ currentPassword: targetPassword, recoveryCode: recoveryCodes[3] }),
    })
    assert.equal(staleRpTotpDisable.status, 409, '旧 RP 密钥不能充当停用最后一个当前可用 TOTP 的保底因素')
    await credentialRepository.update({ id: reloginCredential.data!.id! }, { rpId: 'localhost' })
    await credentialRepository.update({ id: keepCredential.data!.id! }, { rpId: 'localhost' })
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
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000', Cookie: `y_link_webauthn_nonce_${oldKeyTicket.challengeId}=${oldKeyTicket.nonce}` },
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
          Cookie: cookie ? `y_link_webauthn_nonce_${ticket.challengeId}=${ticket.nonce}` : '',
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
  if (enabled && process.argv.includes('--compat')) {
    const compatAdmin = await AppDataSource.getRepository(SysUser).findOneByOrFail({ username: 'admin' })
    const compatAdminLogin = await fetch(`http://localhost:${port}/api/auth/login`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: process.env.INIT_ADMIN_PASSWORD }) })
    assert.equal(compatAdminLogin.status, 200)
    const compatAdminCookies = compatAdminLogin.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ')
    const adminActor = { userId: compatAdmin.id, username: compatAdmin.username, displayName: compatAdmin.displayName,
      role: compatAdmin.role, status: compatAdmin.status, permissions: resolvePermissionsByRole(compatAdmin.role),
      sessionToken: /y_link_admin_session=([^;]+)/.exec(compatAdminCookies)?.[1] ?? '', authSource: 'cookie' as const }

    // 隔离账号覆盖用途隔离、密码后二步、key-only 管理、策略版本和 nonce 双标签页。
    const compatPassword = 'Webauthn-Verify#Compat2026'
    const compatUser = await userService.create({ username: 'compat-key-user', displayName: '兼容密钥用户',
      password: compatPassword, role: 'operator', status: 'enabled' }, adminActor)
    const compatLogin = await fetch(`http://localhost:${port}/api/auth/login`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.101' },
      body: JSON.stringify({ username: compatUser.username, password: compatPassword }) })
    assert.equal(compatLogin.status, 200)
    const compatCookies = compatLogin.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ')
    const compatCsrf = decodeURIComponent(/y_link_admin_csrf=([^;]+)/.exec(compatCookies)?.[1] ?? '')
    const compatHeaders = { 'Content-Type': 'application/json', Origin: 'http://localhost:3000',
      Cookie: compatCookies, 'x-csrf-token': compatCsrf }
    const compatPost = async (route: string, body: unknown, headers: Record<string, string> = compatHeaders) => {
      const response = await fetch(`http://localhost:${port}/api/auth${route}`, { method: 'POST',
        headers: { 'X-Forwarded-For': '198.51.100.101', ...headers }, body: JSON.stringify(body) })
      return { response, body: await response.json() as { data?: any; message?: string } }
    }
    // “安全密钥”选择也能注册为强用途；安全强度由用途与实际 UV 验签决定，不由名称决定。
    const strongKeyPassword = 'Webauthn-Verify#StrongKey2026'
    const strongKeyUser = await userService.create({ username: 'strong-security-key-user', displayName: '强安全密钥用户',
      password: strongKeyPassword, role: 'operator', status: 'enabled' }, adminActor)
    const strongKeyLogin = await compatPost('/login', { username: strongKeyUser.username, password: strongKeyPassword },
      { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.108' })
    assert.equal(strongKeyLogin.response.status, 200)
    const strongKeyCookies = strongKeyLogin.response.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ')
    const strongKeyCsrf = decodeURIComponent(/y_link_admin_csrf=([^;]+)/.exec(strongKeyCookies)?.[1] ?? '')
    const strongKeyHeaders = { ...compatHeaders, Cookie: strongKeyCookies, 'x-csrf-token': strongKeyCsrf,
      'X-Forwarded-For': '198.51.100.108' }
    const strongKey = new TestWebauthnAuthenticator()
    const unverifiedKeyOptions = await compatPost('/webauthn/register/options', { name: '未验证安全密钥',
      kind: 'security_key', usage: 'passwordless', currentPassword: strongKeyPassword }, strongKeyHeaders)
    assert.equal(unverifiedKeyOptions.response.status, 200)
    assert.equal(unverifiedKeyOptions.body.data?.options?.authenticatorSelection?.userVerification, 'required')
    const unverifiedKey = await compatPost('/webauthn/register/verify', {
      challengeId: unverifiedKeyOptions.body.data.challengeId,
      response: strongKey.registration(unverifiedKeyOptions.body.data.options.challenge,
        'http://localhost:3000', 'localhost', false),
    }, strongKeyHeaders)
    assert.equal(unverifiedKey.response.status, 400, '未完成 UV 的强用途安全密钥不得注册')
    assert.equal(await AppDataSource.getRepository(SysUserWebauthnCredential).countBy({ userId: strongKeyUser.id }), 0)
    const strongKeyOptions = await compatPost('/webauthn/register/options', { name: '已有强安全密钥',
      kind: 'security_key', usage: 'passwordless', currentPassword: strongKeyPassword }, strongKeyHeaders)
    assert.equal(strongKeyOptions.response.status, 200)
    const strongKeyRegistered = await compatPost('/webauthn/register/verify', {
      challengeId: strongKeyOptions.body.data.challengeId,
      response: strongKey.registration(strongKeyOptions.body.data.options.challenge,
        'http://localhost:3000', 'localhost', true, 'packed'),
    }, strongKeyHeaders)
    assert.equal(strongKeyRegistered.response.status, 200, 'UV 与签名合法的安全密钥可注册为强用途')
    assert.equal(strongKeyRegistered.body.data?.usage, 'passwordless')
    await AppDataSource.getRepository(SysUserWebauthnCredential)
      .update({ id: strongKeyRegistered.body.data.id }, { rpId: 'old.example' })
    const oldRpKeyOptions = await compatPost('/webauthn/step-up/options', {
      currentPassword: strongKeyPassword, action: 'mfa.webauthn.enable' }, strongKeyHeaders)
    assert.equal(oldRpKeyOptions.response.status, 409, '旧 RP 的强安全密钥不得用于当前站点复核')
    await AppDataSource.getRepository(SysUserWebauthnCredential)
      .update({ id: strongKeyRegistered.body.data.id }, { rpId: 'localhost' })
    const noUvKeyOptions = await compatPost('/webauthn/step-up/options', {
      currentPassword: strongKeyPassword, action: 'mfa.webauthn.enable' }, strongKeyHeaders)
    assert.equal(noUvKeyOptions.response.status, 200)
    assert.equal(noUvKeyOptions.body.data?.options?.userVerification, 'required')
    const noUvKeyProof = await compatPost('/webauthn/step-up/verify', {
      challengeId: noUvKeyOptions.body.data.challengeId,
      response: strongKey.authentication(noUvKeyOptions.body.data.options.challenge,
        'http://localhost:3000', 'localhost', null, 1, false),
    }, strongKeyHeaders)
    assert.equal(noUvKeyProof.response.status, 401, '强用途安全密钥复核仍必须完成 UV')
    const strongKeyStepOptions = await compatPost('/webauthn/step-up/options', {
      currentPassword: strongKeyPassword, action: 'mfa.webauthn.enable' }, strongKeyHeaders)
    assert.equal(strongKeyStepOptions.response.status, 200)
    const strongKeyProof = await compatPost('/webauthn/step-up/verify', {
      challengeId: strongKeyStepOptions.body.data.challengeId,
      response: strongKey.authentication(strongKeyStepOptions.body.data.options.challenge,
        'http://localhost:3000', 'localhost', null, 1, true),
    }, strongKeyHeaders)
    assert.equal(strongKeyProof.response.status, 200)
    const enabledWithStrongKey = await compatPost('/mfa/webauthn/enable', {
      currentPassword: strongKeyPassword, stepUpProof: strongKeyProof.body.data.stepUpProof }, strongKeyHeaders)
    assert.equal(enabledWithStrongKey.response.status, 200, '已有强用途安全密钥可开启密码两步验证')
    assert.equal(enabledWithStrongKey.body.data?.recoveryCodes?.length, 10)
    const strongKeyStatus = await fetch(`http://localhost:${port}/api/auth/mfa/status`, { headers: strongKeyHeaders })
    assert.equal((await strongKeyStatus.json() as { data?: { mfaRequired?: boolean } }).data?.mfaRequired, true)
    console.log('[admin-webauthn-verify] 已有强安全密钥开启密码 MFA、UV 与旧 RP 门禁通过')
    for (const format of ['unknown', 'packed_bad_signature'] as const) {
      const rejectedAuthenticator = new TestWebauthnAuthenticator()
      const rejectedOptions = await compatPost('/webauthn/register/options', { name: `无效证明-${format}`,
        kind: 'security_key', usage: 'second_factor', currentPassword: compatPassword })
      assert.equal(rejectedOptions.response.status, 200)
      const rejected = await compatPost('/webauthn/register/verify', { challengeId: rejectedOptions.body.data.challengeId,
        response: rejectedAuthenticator.registration(rejectedOptions.body.data.options.challenge,
          'http://localhost:3000', 'localhost', false, format) })
      assert.equal(rejected.response.status, 400, `${format} 证明不得注册成功`)
      assert.equal(await AppDataSource.getRepository(SysUserWebauthnCredential).countBy({ userId: compatUser.id }), 0,
        `${format} 证明失败后不能残留凭据`)
    }
    const securityKey = new TestWebauthnAuthenticator()
    const securityOptions = await compatPost('/webauthn/register/options', { name: '非驻留安全密钥',
      kind: 'security_key', usage: 'second_factor', currentPassword: compatPassword })
    assert.equal(securityOptions.response.status, 200)
    assert.equal(securityOptions.body.data?.options?.authenticatorSelection?.residentKey, 'discouraged')
    assert.equal(securityOptions.body.data?.options?.authenticatorSelection?.userVerification, 'discouraged')
    const securityRegistered = await compatPost('/webauthn/register/verify', {
      challengeId: securityOptions.body.data.challengeId,
      response: securityKey.registration(securityOptions.body.data.options.challenge, 'http://localhost:3000', 'localhost', false, 'packed'),
    })
    assert.equal(securityRegistered.response.status, 200, '有效 packed 自签名证明可注册为密码第二因素')
    assert.equal(securityRegistered.body.data?.usage, 'second_factor')
    assert.equal(typeof securityRegistered.body.data?.id, 'string', '安全凭据 ID 的 wire 类型必须稳定为字符串')
    assert.equal(securityRegistered.body.data?.recoveryCodes?.length, 10, '首次启用策略应仅一次返回恢复码')
    const compatRecovery = securityRegistered.body.data.recoveryCodes as string[]
    const weakEnableOptions = await compatPost('/webauthn/step-up/options', { currentPassword: compatPassword,
      action: 'mfa.webauthn.enable' })
    assert.equal(weakEnableOptions.response.status, 200)
    const weakEnableProof = await compatPost('/webauthn/step-up/verify', {
      challengeId: weakEnableOptions.body.data.challengeId,
      response: securityKey.authentication(weakEnableOptions.body.data.options.challenge,
        'http://localhost:3000', 'localhost', null, 1, false),
    })
    assert.equal(weakEnableProof.response.status, 200, '弱用途凭据可完成普通身份复核')
    const deniedWeakEnable = await compatPost('/mfa/webauthn/enable', { currentPassword: compatPassword,
      stepUpProof: weakEnableProof.body.data.stepUpProof })
    assert.equal(deniedWeakEnable.response.status, 403, 'second_factor 凭据证明不得开启强凭据 MFA')
    assert.match(deniedWeakEnable.body.message ?? '', /强凭据/)
    const status = await fetch(`http://localhost:${port}/api/auth/mfa/status`, { headers: compatHeaders })
    const statusBody = await status.json() as { data?: { enabled?: boolean; mfaRequired?: boolean; totpEnabled?: boolean; availableMethods?: string[] } }
    assert.equal(statusBody.data?.enabled, false, '旧 enabled 保持 TOTP 语义')
    assert.equal(statusBody.data?.mfaRequired, true)
    assert.equal(statusBody.data?.totpEnabled, false)
    assert.deepEqual(statusBody.data?.availableMethods, ['recovery_code', 'webauthn'])
    const anonymousOptions = await compatPost('/webauthn/login/options', {})
    const anonymousNonce = anonymousOptions.response.headers.getSetCookie().find((line) =>
      line.startsWith(`y_link_webauthn_nonce_${anonymousOptions.body.data.challengeId}=`))?.split(';')[0]
    const deniedAnonymous = await compatPost('/webauthn/login/verify', {
      challengeId: anonymousOptions.body.data.challengeId,
      response: securityKey.authentication(anonymousOptions.body.data.options.challenge, 'http://localhost:3000', 'localhost', null, 1, false),
    }, { 'Content-Type': 'application/json', Origin: 'http://localhost:3000', Cookie: anonymousNonce ?? '',
      'X-Forwarded-For': '198.51.100.102' })
    assert.equal(deniedAnonymous.response.status, 401, 'second_factor 凭据绝不能匿名直登')
    // 负例会按设计触发账号验证码；清理隔离夹具状态后继续覆盖合法密码后二步。
    await authSecurityService.clearAdminLoginFailures({ ipAddress: '198.51.100.102', userAgent: null,
      clientRiskBrowserId: null, clientRiskSessionId: null }, compatUser.username)
    const passwordFirst = await compatPost('/login', { username: compatUser.username, password: compatPassword },
      { 'Content-Type': 'application/json' })
    assert.equal(passwordFirst.response.status, 200, `密码第一步失败：${JSON.stringify(passwordFirst.body)}`)
    assert.equal(passwordFirst.body.data?.mfaRequired, true)
    assert.deepEqual(passwordFirst.body.data?.availableMethods, ['recovery_code', 'webauthn'])
    const mfaTicket = passwordFirst.body.data.mfaTicket as string
    const secondOptions = await compatPost('/login/mfa/webauthn/options', { mfaTicket })
    assert.equal(secondOptions.response.status, 200)
    assert.equal(secondOptions.body.data?.options?.allowCredentials?.length, 1)
    assert.equal(secondOptions.body.data?.options?.userVerification, 'preferred')
    const noNonce = await compatPost('/login/mfa/webauthn/verify', { mfaTicket,
      challengeId: secondOptions.body.data.challengeId,
      response: securityKey.authentication(secondOptions.body.data.options.challenge, 'http://localhost:3000', 'localhost', null, 1, false) })
    assert.equal(noNonce.response.status, 401, '密码后二步挑战移到别的浏览器且无 nonce 必须拒绝')
    const secondOptionsWithNonce = await compatPost('/login/mfa/webauthn/options', { mfaTicket })
    const secondNonce = secondOptionsWithNonce.response.headers.getSetCookie().find((line) =>
      line.startsWith(`y_link_webauthn_mfa_nonce_${secondOptionsWithNonce.body.data.challengeId}=`))?.split(';')[0]
    const noUp = await compatPost('/login/mfa/webauthn/verify', { mfaTicket, challengeId: secondOptionsWithNonce.body.data.challengeId,
      response: securityKey.authentication(secondOptionsWithNonce.body.data.options.challenge, 'http://localhost:3000', 'localhost', null, 1, false, false) },
      { ...compatHeaders, Cookie: `${compatCookies}; ${secondNonce}` })
    assert.equal(noUp.response.status, 401, '无 UP 的安全密钥必须拒绝')
    const secondOptions2 = await compatPost('/login/mfa/webauthn/options', { mfaTicket })
    const secondNonce2 = secondOptions2.response.headers.getSetCookie().find((line) =>
      line.startsWith(`y_link_webauthn_mfa_nonce_${secondOptions2.body.data.challengeId}=`))?.split(';')[0]
    const secondVerified = await compatPost('/login/mfa/webauthn/verify', { mfaTicket,
      challengeId: secondOptions2.body.data.challengeId,
      response: securityKey.authentication(secondOptions2.body.data.options.challenge, 'http://localhost:3000', 'localhost', null, 2, false) },
      { ...compatHeaders, Cookie: `${compatCookies}; ${secondNonce2}` })
    assert.equal(secondVerified.response.status, 200, '无 UV、有 UP 且无 userHandle 的非驻留密钥可作为密码第二因素')
    const competingRecovery = await compatPost('/login/mfa', { mfaTicket, recoveryCode: compatRecovery[0] })
    assert.equal(competingRecovery.response.status, 401, '同一密码票据被 WebAuthn 消费后恢复码不得重复成功')
    const mfaCookies = secondVerified.response.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ')
    const mfaCsrf = decodeURIComponent(/y_link_admin_csrf=([^;]+)/.exec(mfaCookies)?.[1] ?? '')
    const mfaHeaders = { ...compatHeaders, Cookie: mfaCookies, 'x-csrf-token': mfaCsrf }
    const beforeRevision = await compatPost('/login', { username: compatUser.username, password: compatPassword },
      { 'Content-Type': 'application/json' })
    const staleTicket = beforeRevision.body.data.mfaTicket as string
    const stepOptions = await compatPost('/webauthn/step-up/options', { currentPassword: compatPassword,
      action: 'mfa.recovery_codes' }, mfaHeaders)
    assert.equal(stepOptions.response.status, 200)
    const stepVerified = await compatPost('/webauthn/step-up/verify', { challengeId: stepOptions.body.data.challengeId,
      response: securityKey.authentication(stepOptions.body.data.options.challenge, 'http://localhost:3000', 'localhost', null, 3, false) }, mfaHeaders)
    assert.equal(stepVerified.response.status, 200)
    const proof = stepVerified.body.data.stepUpProof as string
    const simultaneousProofUses = await Promise.all([
      compatPost('/mfa/recovery-codes', { currentPassword: compatPassword, stepUpProof: proof }, mfaHeaders),
      compatPost('/mfa/recovery-codes', { currentPassword: compatPassword, stepUpProof: proof }, mfaHeaders),
    ])
    assert.deepEqual(simultaneousProofUses.map(({ response }) => response.status).sort(), [200, 409],
      '同一 step-up 证明的并发写入只能成功一次')
    assert.equal(simultaneousProofUses.find(({ response }) => response.status === 200)?.body.data?.recoveryCodes?.length, 10)
    const staleLogin = await compatPost('/login/mfa', { mfaTicket: staleTicket, recoveryCode: compatRecovery[1] })
    assert.equal(staleLogin.response.status, 401, '恢复码结构变化使旧密码票据作废')
    const deleteOptions = await compatPost('/webauthn/step-up/options', { currentPassword: compatPassword,
      action: 'webauthn.delete', targetId: String(securityRegistered.body.data.id) }, mfaHeaders)
    assert.equal(deleteOptions.response.status, 200, `删除复核挑战失败：${JSON.stringify(deleteOptions.body)}`)
    const deleteProof = await compatPost('/webauthn/step-up/verify', { challengeId: deleteOptions.body.data.challengeId,
      response: securityKey.authentication(deleteOptions.body.data.options.challenge, 'http://localhost:3000', 'localhost', null, 4, false) }, mfaHeaders)
    const deleteLast = await fetch(`http://localhost:${port}/api/auth/webauthn/credentials/${securityRegistered.body.data.id}`,
      { method: 'DELETE', headers: mfaHeaders, body: JSON.stringify({ currentPassword: compatPassword,
        stepUpProof: deleteProof.body.data.stepUpProof }) })
    assert.equal(deleteLast.status, 409, '普通删除不可移除最后一个常规因素')
    const allOptions = await compatPost('/webauthn/step-up/options', { currentPassword: compatPassword,
      action: 'mfa.disable_all' }, mfaHeaders)
    const allProof = await compatPost('/webauthn/step-up/verify', { challengeId: allOptions.body.data.challengeId,
      response: securityKey.authentication(allOptions.body.data.options.challenge, 'http://localhost:3000', 'localhost', null, 5, false) }, mfaHeaders)
    const disableAll = await compatPost('/mfa/disable-all', { currentPassword: compatPassword,
      stepUpProof: allProof.body.data.stepUpProof }, mfaHeaders)
    assert.equal(disableAll.response.status, 200, '显式全停应允许 key-only 用户恢复密码登录')
    assert.equal(await AppDataSource.getRepository(SysUserWebauthnCredential).countBy({ userId: compatUser.id }), 0)
    const postDisable = await compatPost('/login', { username: compatUser.username, password: compatPassword },
      { 'Content-Type': 'application/json' })
    assert.equal(postDisable.response.status, 200)
    assert.equal(postDisable.body.data?.mfaRequired, undefined)
    const plainCookies = postDisable.response.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ')
    const plainCsrf = decodeURIComponent(/y_link_admin_csrf=([^;]+)/.exec(plainCookies)?.[1] ?? '')
    const plainHeaders = { ...compatHeaders, Cookie: plainCookies, 'x-csrf-token': plainCsrf }
    const passkey = new TestWebauthnAuthenticator()
    const passkeyOptions = await compatPost('/webauthn/register/options', { name: '双标签页通行密钥',
      kind: 'passkey', currentPassword: compatPassword }, plainHeaders)
    assert.equal(passkeyOptions.response.status, 200)
    const passkeyVerified = await compatPost('/webauthn/register/verify', { challengeId: passkeyOptions.body.data.challengeId,
      response: passkey.registration(passkeyOptions.body.data.options.challenge, 'http://localhost:3000', 'localhost') }, plainHeaders)
    assert.equal(passkeyVerified.response.status, 200)
    assert.equal(passkeyVerified.body.data?.usage, 'passwordless', '旧注册默认仍可直接登录')
    const anonOptionsHeaders = { 'Content-Type': 'application/json', Origin: 'http://localhost:3000',
      'X-Forwarded-For': '198.51.100.103' }
    const challengeA = await compatPost('/webauthn/login/options', {}, anonOptionsHeaders)
    const challengeB = await compatPost('/webauthn/login/options', {}, anonOptionsHeaders)
    assert.equal(challengeA.response.status, 200, `挑战A失败：${JSON.stringify(challengeA.body)}`)
    assert.equal(challengeB.response.status, 200, `挑战B失败：${JSON.stringify(challengeB.body)}`)
    const cookieA = challengeA.response.headers.getSetCookie().find((line) =>
      line.startsWith(`y_link_webauthn_nonce_${challengeA.body.data.challengeId}=`))?.split(';')[0]
    const cookieB = challengeB.response.headers.getSetCookie().find((line) =>
      line.startsWith(`y_link_webauthn_nonce_${challengeB.body.data.challengeId}=`))?.split(';')[0]
    assert.ok(cookieA && cookieB && cookieA !== cookieB)
    const anonymousHeaders = { 'Content-Type': 'application/json', Origin: 'http://localhost:3000',
      Cookie: `${cookieA}; ${cookieB}`, 'X-Forwarded-For': '198.51.100.103' }
    const completeA = await compatPost('/webauthn/login/verify', { challengeId: challengeA.body.data.challengeId,
      response: passkey.authentication(challengeA.body.data.options.challenge, 'http://localhost:3000', 'localhost',
        passkeyOptions.body.data.options.user.id, 1) }, anonymousHeaders)
    assert.equal(completeA.response.status, 200, '标签页A的 nonce 应独立成功')
    assert.ok(!completeA.response.headers.getSetCookie().some((line) => line.startsWith(`y_link_webauthn_nonce_${challengeB.body.data.challengeId}=`)),
      '验证A不能清理标签页B的 nonce')
    const completeB = await compatPost('/webauthn/login/verify', { challengeId: challengeB.body.data.challengeId,
      response: passkey.authentication(challengeB.body.data.options.challenge, 'http://localhost:3000', 'localhost',
        passkeyOptions.body.data.options.user.id, 2) }, anonymousHeaders)
    assert.equal(completeB.response.status, 200, '标签页B不受A完成影响')
    const challengeC = await compatPost('/webauthn/login/options', {}, anonOptionsHeaders)
    const wrongCookie = await compatPost('/webauthn/login/verify', { challengeId: challengeC.body.data.challengeId,
      response: passkey.authentication(challengeC.body.data.options.challenge, 'http://localhost:3000', 'localhost',
        passkeyOptions.body.data.options.user.id, 3) }, { ...anonymousHeaders, Cookie: cookieB })
    assert.equal(wrongCookie.response.status, 401, '挑战不得使用另一个标签页的 nonce')
    const challengeD = await compatPost('/webauthn/login/options', {}, anonOptionsHeaders)
    const cookieD = challengeD.response.headers.getSetCookie().find((line) =>
      line.startsWith(`y_link_webauthn_nonce_${challengeD.body.data.challengeId}=`))?.split(';')[0]
    const missingAnonymousHandle = await compatPost('/webauthn/login/verify', { challengeId: challengeD.body.data.challengeId,
      response: passkey.authentication(challengeD.body.data.options.challenge, 'http://localhost:3000', 'localhost', null, 3) },
      { ...anonymousHeaders, Cookie: cookieD ?? '' })
    assert.equal(missingAnonymousHandle.response.status, 401, '匿名直登仍须有有效 userHandle')
    const counterHeaders = { ...anonOptionsHeaders, 'X-Forwarded-For': '198.51.100.107' }
    const counterChallenges = await Promise.all([
      compatPost('/webauthn/login/options', {}, counterHeaders),
      compatPost('/webauthn/login/options', {}, counterHeaders),
    ])
    assert.ok(counterChallenges.every(({ response }) => response.status === 200),
      `并发挑战签发失败：${JSON.stringify(counterChallenges.map(({ response, body }) => ({ status: response.status, message: body.message })))}`)
    const sessionsBeforeCounterRace = await AppDataSource.getRepository(SysUserSession).countBy({ userId: compatUser.id })
    const counterRace = await Promise.all(counterChallenges.map(({ response, body }) => {
      const nonce = response.headers.getSetCookie().find((line) =>
        line.startsWith(`y_link_webauthn_nonce_${body.data.challengeId}=`))?.split(';')[0]
      return compatPost('/webauthn/login/verify', { challengeId: body.data.challengeId,
        response: passkey.authentication(body.data.options.challenge, 'http://localhost:3000', 'localhost',
          passkeyOptions.body.data.options.user.id, 3) }, { ...counterHeaders, Cookie: nonce ?? '' })
    }))
    assert.deepEqual(counterRace.map(({ response }) => response.status).sort(), [200, 401],
      '同一密钥同一非零计数器的两个独立挑战只能签发一个会话')
    assert.equal(Number((await AppDataSource.getRepository(SysUserWebauthnCredential).findOneByOrFail({ id: passkeyVerified.body.data.id })).counter),
      3, '并发验签后计数器只推进一次')
    assert.equal(await AppDataSource.getRepository(SysUserSession).countBy({ userId: compatUser.id }),
      sessionsBeforeCounterRace + 1, '并发验签仅新增一个会话')

    // 管理员 key-only 策略复核与完整重置：目标 passwordless 凭据独立保留。
    const targetKey = new TestWebauthnAuthenticator()
    const targetOptions = await compatPost('/webauthn/register/options', { name: '重置目标第二因素', kind: 'security_key',
      usage: 'second_factor', currentPassword: compatPassword }, plainHeaders)
    assert.equal(targetOptions.response.status, 200)
    const targetRegistered = await compatPost('/webauthn/register/verify', { challengeId: targetOptions.body.data.challengeId,
      response: targetKey.registration(targetOptions.body.data.options.challenge, 'http://localhost:3000', 'localhost', false) }, plainHeaders)
    assert.equal(targetRegistered.response.status, 200)
    const credentialRepo = AppDataSource.getRepository(SysUserWebauthnCredential)
    await credentialRepo.update({ id: passkeyVerified.body.data.id }, { rpId: 'old.example' })
    await credentialRepo.update({ id: targetRegistered.body.data.id }, { rpId: 'old.example' })
    const staleRpStatus = await fetch(`http://localhost:${port}/api/auth/mfa/status`, { headers: plainHeaders })
    const staleRpStatusBody = await staleRpStatus.json() as { data?: { availableMethods?: string[] } }
    assert.deepEqual(staleRpStatusBody.data?.availableMethods, ['recovery_code'],
      '旧 RP 凭据仍可管理，但不得显示为当前站点可用的第二因素')
    await authSecurityService.clearAdminLoginFailures({ ipAddress: '198.51.100.106', userAgent: null,
      clientRiskBrowserId: null, clientRiskSessionId: null }, compatUser.username)
    const staleRpPassword = await compatPost('/login', { username: compatUser.username, password: compatPassword },
      { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.106' })
    assert.equal(staleRpPassword.response.status, 200, `旧 RP 密码第一步失败：${JSON.stringify(staleRpPassword.body)}`)
    assert.deepEqual(staleRpPassword.body.data?.availableMethods, ['recovery_code'],
      '密码第一步不得向旧 RP 凭据发布 WebAuthn 可用方法')
    await credentialRepo.update({ id: passkeyVerified.body.data.id }, { rpId: 'localhost' })
    const staleRpDeleteOptions = await compatPost('/webauthn/step-up/options', { currentPassword: compatPassword,
      action: 'webauthn.delete', targetId: String(passkeyVerified.body.data.id) }, plainHeaders)
    assert.equal(staleRpDeleteOptions.response.status, 200)
    const staleRpDeleteProof = await compatPost('/webauthn/step-up/verify', { challengeId: staleRpDeleteOptions.body.data.challengeId,
      response: passkey.authentication(staleRpDeleteOptions.body.data.options.challenge, 'http://localhost:3000', 'localhost',
        null, 4) }, plainHeaders)
    assert.equal(staleRpDeleteProof.response.status, 200)
    const staleRpDelete = await fetch(`http://localhost:${port}/api/auth/webauthn/credentials/${passkeyVerified.body.data.id}`,
      { method: 'DELETE', headers: plainHeaders, body: JSON.stringify({ currentPassword: compatPassword,
        stepUpProof: staleRpDeleteProof.body.data.stepUpProof }) })
    assert.equal(staleRpDelete.status, 409, '旧 RP 凭据不得掩盖删除当前 RP 最后一把可用密钥')
    const adminHeaders = { 'Content-Type': 'application/json', Origin: 'http://localhost:3000',
      Cookie: compatAdminCookies, 'x-csrf-token': decodeURIComponent(/y_link_admin_csrf=([^;]+)/.exec(compatAdminCookies)?.[1] ?? ''),
      'X-Forwarded-For': '198.51.100.104' }
    const keyOnlyList = await fetch(`http://localhost:${port}/api/users?page=1&pageSize=50`, { headers: adminHeaders })
    assert.equal(keyOnlyList.status, 200)
    const keyOnlyListBody = await keyOnlyList.json() as { data?: { list?: Array<{ username: string; mfaRequired?: boolean; mfaEnabled?: boolean }> } }
    const keyOnlyRow = keyOnlyListBody.data?.list?.find((row) => row.username === compatUser.username)
    assert.equal(keyOnlyRow?.mfaRequired, true, '用户列表须标记 key-only 策略已开启')
    assert.equal(keyOnlyRow?.mfaEnabled, false, '用户列表旧字段只表示 TOTP')
    const adminPasskey = new TestWebauthnAuthenticator()
    const adminOptions = await compatPost('/webauthn/register/options', { name: '管理员强通行密钥', kind: 'passkey',
      currentPassword: process.env.INIT_ADMIN_PASSWORD }, adminHeaders)
    assert.equal(adminOptions.response.status, 200)
    const adminRegistered = await compatPost('/webauthn/register/verify', { challengeId: adminOptions.body.data.challengeId,
      response: adminPasskey.registration(adminOptions.body.data.options.challenge, 'http://localhost:3000', 'localhost') }, adminHeaders)
    assert.equal(adminRegistered.response.status, 200)
    const adminEnableOptions = await compatPost('/webauthn/step-up/options', { currentPassword: process.env.INIT_ADMIN_PASSWORD,
      action: 'mfa.webauthn.enable' }, adminHeaders)
    assert.equal(adminEnableOptions.response.status, 200)
    const adminEnableProof = await compatPost('/webauthn/step-up/verify', { challengeId: adminEnableOptions.body.data.challengeId,
      response: adminPasskey.authentication(adminEnableOptions.body.data.options.challenge, 'http://localhost:3000', 'localhost',
        null, 1) }, adminHeaders)
    assert.equal(adminEnableProof.response.status, 200, '已绑定账号的强通行密钥在 step-up 中可不返回 userHandle')
    await credentialRepo.update({ id: adminRegistered.body.data.id }, { rpId: 'old.example' })
    const staleRpEnable = await compatPost('/mfa/webauthn/enable', { currentPassword: process.env.INIT_ADMIN_PASSWORD,
      stepUpProof: adminEnableProof.body.data.stepUpProof }, adminHeaders)
    assert.equal(staleRpEnable.response.status, 409, '旧 RP 通行密钥不得启用当前站点密码 MFA')
    await credentialRepo.update({ id: adminRegistered.body.data.id }, { rpId: 'localhost' })
    const currentEnableOptions = await compatPost('/webauthn/step-up/options', { currentPassword: process.env.INIT_ADMIN_PASSWORD,
      action: 'mfa.webauthn.enable' }, adminHeaders)
    assert.equal(currentEnableOptions.response.status, 200)
    const currentEnableProof = await compatPost('/webauthn/step-up/verify', { challengeId: currentEnableOptions.body.data.challengeId,
      response: adminPasskey.authentication(currentEnableOptions.body.data.options.challenge, 'http://localhost:3000', 'localhost',
        null, 2) }, adminHeaders)
    assert.equal(currentEnableProof.response.status, 200)
    const enabledAdmin = await compatPost('/mfa/webauthn/enable', { currentPassword: process.env.INIT_ADMIN_PASSWORD,
      stepUpProof: currentEnableProof.body.data.stepUpProof }, adminHeaders)
    assert.equal(enabledAdmin.response.status, 200)
    assert.equal(enabledAdmin.body.data?.recoveryCodes?.length, 10)
    const adminLoginHeaders = { 'Content-Type': 'application/json', Origin: 'http://localhost:3000',
      'X-Forwarded-For': '198.51.100.105' }
    const adminPasswordFirst = await compatPost('/login', { username: 'admin', password: process.env.INIT_ADMIN_PASSWORD }, adminLoginHeaders)
    assert.equal(adminPasswordFirst.body.data?.mfaRequired, true)
    const adminMfaTicket = adminPasswordFirst.body.data.mfaTicket as string
    const wrongHandleOptions = await compatPost('/login/mfa/webauthn/options', { mfaTicket: adminMfaTicket }, adminLoginHeaders)
    assert.equal(wrongHandleOptions.response.status, 200, `强二步挑战失败：${JSON.stringify(wrongHandleOptions.body)}`)
    const wrongHandleNonce = wrongHandleOptions.response.headers.getSetCookie().find((line) =>
      line.startsWith(`y_link_webauthn_mfa_nonce_${wrongHandleOptions.body.data.challengeId}=`))?.split(';')[0]
    const wrongBoundHandle = await compatPost('/login/mfa/webauthn/verify', { mfaTicket: adminMfaTicket,
      challengeId: wrongHandleOptions.body.data.challengeId,
      response: adminPasskey.authentication(wrongHandleOptions.body.data.options.challenge, 'http://localhost:3000', 'localhost',
        Buffer.alloc(32, 1).toString('base64url'), 3) },
      { ...adminLoginHeaders, Cookie: wrongHandleNonce ?? '' })
    assert.equal(wrongBoundHandle.response.status, 401, '账号绑定路径中提供错误 userHandle 仍须拒绝')
    const strongMfaOptions = await compatPost('/login/mfa/webauthn/options', { mfaTicket: adminMfaTicket }, adminLoginHeaders)
    const strongMfaNonce = strongMfaOptions.response.headers.getSetCookie().find((line) =>
      line.startsWith(`y_link_webauthn_mfa_nonce_${strongMfaOptions.body.data.challengeId}=`))?.split(';')[0]
    const strongMfaLogin = await compatPost('/login/mfa/webauthn/verify', { mfaTicket: adminMfaTicket,
      challengeId: strongMfaOptions.body.data.challengeId,
      response: adminPasskey.authentication(strongMfaOptions.body.data.options.challenge, 'http://localhost:3000', 'localhost',
        null, 3) }, { ...adminLoginHeaders, Cookie: strongMfaNonce ?? '' })
    assert.equal(strongMfaLogin.response.status, 200, '强通行密钥 UV=true 且无 userHandle 可作账号绑定二步')
    const adminResetPath = `/api/users/${compatUser.id}/mfa/reset`
    const incompleteReset = await fetch(`http://localhost:${port}${adminResetPath}`, { method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ currentPassword: process.env.INIT_ADMIN_PASSWORD }) })
    assert.equal(incompleteReset.status, 400, 'key-only 管理员不能只凭密码重置目标 MFA')
    const adminResetOptions = await compatPost('/webauthn/step-up/options', { currentPassword: process.env.INIT_ADMIN_PASSWORD,
      action: 'user.mfa.reset', targetId: String(compatUser.id) }, adminHeaders)
    assert.equal(adminResetOptions.response.status, 200)
    const adminResetProof = await compatPost('/webauthn/step-up/verify', { challengeId: adminResetOptions.body.data.challengeId,
      response: adminPasskey.authentication(adminResetOptions.body.data.options.challenge, 'http://localhost:3000', 'localhost',
        adminOptions.body.data.options.user.id, 4) }, adminHeaders)
    assert.equal(adminResetProof.response.status, 200)
    const completedReset = await fetch(`http://localhost:${port}${adminResetPath}`, { method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ currentPassword: process.env.INIT_ADMIN_PASSWORD,
        stepUpProof: adminResetProof.body.data.stepUpProof }) })
    assert.equal(completedReset.status, 200, 'key-only 管理员用密码+强密钥可重置他人 MFA')
    const targetRows = await AppDataSource.getRepository(SysUserWebauthnCredential).findBy({ userId: compatUser.id })
    assert.equal(targetRows.length, 1)
    assert.equal(targetRows[0].usage, 'passwordless', '管理员完整重置保留独立直接登录凭据')
    const staleTargetSession = await fetch(`http://localhost:${port}/api/auth/me`, { headers: plainHeaders })
    assert.equal(staleTargetSession.status, 401, '管理员完整重置吊销目标旧会话')
    const cliKeyStep = await compatPost('/webauthn/step-up/options', { currentPassword: process.env.INIT_ADMIN_PASSWORD,
      action: 'webauthn.register' }, adminHeaders)
    assert.equal(cliKeyStep.response.status, 200)
    const cliKeyProof = await compatPost('/webauthn/step-up/verify', { challengeId: cliKeyStep.body.data.challengeId,
      response: adminPasskey.authentication(cliKeyStep.body.data.options.challenge, 'http://localhost:3000', 'localhost',
        adminOptions.body.data.options.user.id, 5) }, adminHeaders)
    assert.equal(cliKeyProof.response.status, 200)
    const cliKeyOptions = await compatPost('/webauthn/register/options', { name: 'CLI待清理第二因素', kind: 'security_key',
      usage: 'second_factor', currentPassword: process.env.INIT_ADMIN_PASSWORD,
      stepUpProof: cliKeyProof.body.data.stepUpProof }, adminHeaders)
    assert.equal(cliKeyOptions.response.status, 200)
    const adminSecondKey = new TestWebauthnAuthenticator()
    const cliKeyRegistered = await compatPost('/webauthn/register/verify', { challengeId: cliKeyOptions.body.data.challengeId,
      response: adminSecondKey.registration(cliKeyOptions.body.data.options.challenge, 'http://localhost:3000', 'localhost', false) }, adminHeaders)
    assert.equal(cliKeyRegistered.response.status, 200)
    const cliReset = await adminMfaService.resetByUsernameFromCli('admin')
    assert.equal(cliReset.reset, true)
    const adminRows = await AppDataSource.getRepository(SysUserWebauthnCredential).findBy({ userId: compatAdmin.id })
    assert.deepEqual(adminRows.map((row) => row.usage), ['passwordless'], 'CLI完整重置仅保留直接登录凭据')
    const staleAdminSession = await fetch(`http://localhost:${port}/api/auth/me`, { headers: adminHeaders })
    assert.equal(staleAdminSession.status, 401, 'CLI完整重置同步吊销目标会话')
    const adminAfterCli = await authService.login({ username: 'admin', password: process.env.INIT_ADMIN_PASSWORD! })
    assert.ok('token' in adminAfterCli)
    const freshAdminActor = await authService.resolveAuthUserByToken(adminAfterCli.token)
    const makeResetActor = async (username: string, password: string) => {
      const created = await userService.create({ username, password, displayName: username, role: 'admin', status: 'enabled' }, freshAdminActor)
      const login = await authService.login({ username, password })
      assert.ok('token' in login)
      const auth = await authService.resolveAuthUserByToken(login.token)
      const enrollment = await adminMfaService.beginEnrollment(auth, { currentPassword: password })
      const code = computeHotp(decodeBase32(enrollment.secret), currentTotpStep())
      const confirmed = await adminMfaService.confirmEnrollment(auth, code)
      assert.equal(confirmed.recoveryCodes.length, 10)
      return { created, auth, password, recoveryCode: confirmed.recoveryCodes[0] }
    }
    const actorA = await makeResetActor('reset-race-admin-a', 'Webauthn-Verify#RaceA2026')
    const actorB = await makeResetActor('reset-race-admin-b', 'Webauthn-Verify#RaceB2026')
    const resetAuditsBefore = await AppDataSource.getRepository(SysAuditLog).countBy({ actionType: 'user.mfa.reset', resultStatus: 'success' })
    const reciprocalReset = await Promise.allSettled([
      userService.resetMfa(String(actorB.created.id), actorA.auth,
        { currentPassword: actorA.password, recoveryCode: actorA.recoveryCode }),
      userService.resetMfa(String(actorA.created.id), actorB.auth,
        { currentPassword: actorB.password, recoveryCode: actorB.recoveryCode }),
    ])
    assert.equal(reciprocalReset.filter((item) => item.status === 'fulfilled').length, 1,
      '双管理员相互重置必须有且仅有一个提交成功')
    assert.equal(reciprocalReset.filter((item) => item.status === 'rejected').length, 1)
    assert.equal((reciprocalReset.find((item) => item.status === 'rejected') as PromiseRejectedResult).reason?.statusCode,
      401, '被先重置者的旧会话不得在等待账号锁后继续落库')
    const aWon = reciprocalReset[0].status === 'fulfilled'
    assert.equal(await AppDataSource.getRepository(SysUserMfa).countBy({ userId: actorA.created.id }), aWon ? 1 : 0)
    assert.equal(await AppDataSource.getRepository(SysUserMfa).countBy({ userId: actorB.created.id }), aWon ? 0 : 1)
    assert.equal(await AppDataSource.getRepository(SysUserSession).countBy({ userId: actorA.created.id,
      sessionToken: hashSessionToken(actorA.auth.sessionToken) }), aWon ? 1 : 0)
    assert.equal(await AppDataSource.getRepository(SysUserSession).countBy({ userId: actorB.created.id,
      sessionToken: hashSessionToken(actorB.auth.sessionToken) }), aWon ? 0 : 1)
    assert.equal(await AppDataSource.getRepository(SysAuditLog).countBy({ actionType: 'user.mfa.reset', resultStatus: 'success' }),
      resetAuditsBefore + 1, '相互重置只能新增一条成功审计')
    console.log('[admin-webauthn-verify] 同钥非零计数器并发与双管理员相互重置锁顺序通过')
    console.log('[admin-webauthn-verify] 双标签页nonce独立、key-only管理员强复核与完整重置通过')
    console.log('[admin-webauthn-verify] 非驻留安全密钥用途隔离、UP/UV/handle、密码后二步、key-only恢复与策略版本通过')
  }
  console.log(`[admin-webauthn-verify] ${mysqlMode ? 'MySQL' : 'SQLite'} ${enabled ? '启用' : '关闭'}能力与匿名挑战通过`)
} finally {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
}
