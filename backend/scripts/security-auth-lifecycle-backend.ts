/**
 * 认证生命周期回归：仅在不含 .env、真实 data/uploads 的任务副本中统一验收。
 * SQLite 使用独立临时库；MySQL 仅连接显式配置的本机测试实例并创建随机专用库。
 * 并发交错使用可释放屏障，不靠 sleep；不为生产代码增加测试旁路。
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ClientAuthContext } from '../src/types/client-auth.js'

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
assert.ok(!fs.readdirSync(backendRoot).some(name => name === '.env' || name.startsWith('.env.')),
  '必须在不含任何后端 env 文件的任务副本执行')
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ylink-auth-lifecycle-'))
const mysql = process.env.SECURITY_AUTH_VERIFY_DB === 'mysql'
const databaseName = `auth_lifecycle_${crypto.randomBytes(8).toString('hex')}`
Object.assign(process.env, {
  NODE_ENV: 'test', APP_PROFILE: 'security-auth-lifecycle', ENV_FILE: '',
  DB_TYPE: mysql ? 'mysql' : 'sqlite', DB_SYNC: 'true',
  SQLITE_DB_PATH: path.join(temporaryRoot, 'verification.sqlite'),
  Y_LINK_DATA_DIR: temporaryRoot, Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE: 'true',
  REDIS_URL: '', Y_LINK_DATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
})
let dropDatabase: (() => Promise<void>) | undefined
if (mysql) {
  assert.equal(process.env.SECURITY_AUTH_MYSQL_HOST, '127.0.0.1', '只允许显式本机测试实例')
  assert.ok(process.env.SECURITY_AUTH_MYSQL_PORT && process.env.SECURITY_AUTH_MYSQL_USER)
  const { createConnection } = await import('mysql2/promise')
  const config = {
    host: '127.0.0.1', port: Number(process.env.SECURITY_AUTH_MYSQL_PORT),
    user: process.env.SECURITY_AUTH_MYSQL_USER, password: process.env.SECURITY_AUTH_MYSQL_PASSWORD ?? '',
  }
  const connection = await createConnection(config)
  try { await connection.query(`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4`) }
  finally { await connection.end() }
  dropDatabase = async () => {
    const cleanup = await createConnection(config)
    try { await cleanup.query(`DROP DATABASE \`${databaseName}\``) } finally { await cleanup.end() }
  }
  Object.assign(process.env, {
    DB_HOST: config.host, DB_PORT: String(config.port), DB_USER: config.user,
    DB_PASSWORD: config.password, DB_NAME: databaseName,
  })
}

let scryptCount = 0
const originalScrypt = crypto.scrypt
crypto.scrypt = ((...args: unknown[]) => {
  scryptCount += 1
  return Reflect.apply(originalScrypt, crypto, args)
}) as typeof crypto.scrypt
syncBuiltinESMExports()
const { AppDataSource } = await import('../src/config/data-source.js')
const { initializeDatabaseInfrastructure } = await import('../src/database/database-strategy.js')
const { initializeDatabaseSchemaIfNeeded } = await import('../src/config/database-bootstrap.js')
const { getCurrentTransactionManager } = await import('../src/database/transaction-coordinator.js')
const { runInTransaction } = await import('../src/config/transaction-runner.js')
const { ClientUser } = await import('../src/entities/client-user.entity.js')
const { ClientUserSession } = await import('../src/entities/client-user-session.entity.js')
const { ClientMobileSession } = await import('../src/entities/client-mobile-session.entity.js')
const { SysAuditLog } = await import('../src/entities/sys-audit-log.entity.js')
const { SysUser } = await import('../src/entities/sys-user.entity.js')
const { SysUserSession } = await import('../src/entities/sys-user-session.entity.js')
const { SystemConfig } = await import('../src/entities/system-config.entity.js')
const { clientAuthService } = await import('../src/services/client-auth.service.js')
const { mobileAuthService } = await import('../src/services/mobile-auth.service.js')
const { mobileSessionService } = await import('../src/services/mobile-session.service.js')
const { systemConfigService } = await import('../src/services/system-config.service.js')
const { verificationCodeService, VerificationCodeService } = await import('../src/services/verification-code.service.js')
const { authSecurityService } = await import('../src/services/auth-security.service.js')
const { authService } = await import('../src/services/auth.service.js')
const { clientUserManageService } = await import('../src/services/client-user-manage.service.js')
const { persistentRiskStateService } = await import('../src/services/persistent-risk-state.service.js')
const { hashPassword } = await import('../src/utils/password.js')
const { hashSessionToken } = await import('../src/utils/session-token.js')
const { BizError } = await import('../src/utils/errors.js')
const { EphemeralTicketStore } = await import('../src/utils/ephemeral-ticket-store.js')
const originalSet = EphemeralTicketStore.prototype.set
let issuedTicket: Record<string, unknown> | undefined
EphemeralTicketStore.prototype.set = function (key, ticket) {
  if ((ticket as { version?: number }).version === 2) issuedTicket = { ...(ticket as Record<string, unknown>) }
  return originalSet.call(this, key, ticket)
}
const oldPassword = 'LifecycleOld123!'
const newPassword = 'LifecycleNext456!'
const meta = (id: string) => ({ ipAddress: `fixture-${id}`, userAgent: 'security-auth-lifecycle' })
const isStatus = (status: number) => (error: unknown) => error instanceof BizError && error.statusCode === status
const barrier = () => {
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  return { entered, release, wait: async () => { enter(); await released } }
}
const withTimeout = <T>(action: Promise<T>) => new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('受控屏障超时')), 15_000)
  action.then(resolve, reject).finally(() => clearTimeout(timer))
})
try {
  await AppDataSource.initialize()
  await initializeDatabaseInfrastructure(AppDataSource)
  await initializeDatabaseSchemaIfNeeded(AppDataSource)
  await systemConfigService.ensureDefaultConfigs()
  const admin = await AppDataSource.getRepository(SysUser).save({
    username: 'lifecycle-admin', displayName: '隔离验收管理员', role: 'admin' as const,
    status: 'enabled' as const, passwordHash: await hashPassword(oldPassword),
  })
  const adminToken = crypto.randomBytes(32).toString('hex')
  await AppDataSource.getRepository(SysUserSession).save({
    userId: admin.id, sessionToken: hashSessionToken(adminToken),
    expiresAt: new Date(Date.now() + 60_000), lastAccessAt: new Date(),
  })
  const adminAuth = await authService.resolveAuthUserByToken(adminToken)
  for (const [configKey, configValue] of [
    ['verification.email.enabled', '1'], ['verification.email.api_url', 'https://verification.example.test/email'],
  ]) await AppDataSource.getRepository(SystemConfig).update({ configKey }, { configValue })
  const users = AppDataSource.getRepository(ClientUser)
  const audits = AppDataSource.getRepository(SysAuditLog)
  const fakeSender = new VerificationCodeService(async () => ({ statusCode: 200, headers: {}, body: Buffer.from('ok') }))
  ;(fakeSender as unknown as { buildCode: () => string }).buildCode = () => '123456'
  const createFixture = async () => {
    const user = await users.save({
      realName: '生命周期验证', email: `${crypto.randomUUID()}@example.test`, mobile: null,
      emailVerifiedAt: new Date(), passwordHash: await hashPassword(oldPassword),
      accountType: 'personal' as const, status: 'enabled' as const, departmentName: '', staffVerified: false,
    })
    const token = crypto.randomBytes(32).toString('hex')
    await AppDataSource.getRepository(ClientUserSession).save({
      userId: user.id, sessionToken: hashSessionToken(token),
      expiresAt: new Date(Date.now() + 60_000), lastAccessAt: new Date(),
    })
    const web = await clientAuthService.resolveClientByToken(token)
    const device = { deviceId: crypto.randomUUID(), platform: 'android' as const }
    const credentials = await mobileSessionService.createForUser(user, device)
    const mobile = await mobileSessionService.resolveAccess(credentials.accessToken)
    const bearer: ClientAuthContext = { ...web, sessionToken: credentials.accessToken, authSource: 'bearer' }
    return { user, web, device, mobile, bearer }
  }
  const issue = async (user: InstanceType<typeof ClientUser>) => {
    await fakeSender.sendCode({ channel: 'email', target: user.email!, scene: 'forgot_password' })
    const result = await clientAuthService.verifyForgotPassword({ account: user.email!, verificationCode: '123456' })
    assert.ok(issuedTicket)
    assert.equal(issuedTicket.version, 2)
    assert.equal(issuedTicket.passwordState, crypto.createHash('sha256')
      .update(JSON.stringify(['client-password-reset-v2', BigInt(user.id).toString(), user.passwordHash])).digest('hex'))
    assert.equal('passwordHash' in issuedTicket, false)
    assert.ok(!JSON.stringify(issuedTicket).includes(user.passwordHash), '票据不得保存原始密码哈希')
    return result
  }
  const bucket = (id: string) => persistentRiskStateService.readFailure(`client-login:account:uid:${id}`, 15 * 60_000)
  const profileInput = (f: Awaited<ReturnType<typeof createFixture>>) => ({
    username: f.user.realName, email: f.user.email!, currentPassword: oldPassword,
  })

  for (const entry of ['web-change', 'mobile-change', 'web-reset', 'mobile-reset', 'admin-reset', 'rehash'] as const) {
    const f = await createFixture()
    const first = await issue(f.user), stale = await issue(f.user)
    const reset = { account: f.user.email!, resetToken: first.resetToken, newPassword }
    if (entry === 'web-change') await clientAuthService.changePassword(f.web, { currentPassword: oldPassword, newPassword }, meta(f.user.id))
    if (entry === 'mobile-change') await mobileAuthService.changePassword(f.mobile, { currentPassword: oldPassword, newPassword, device: f.device }, meta(f.user.id))
    if (entry === 'web-reset') await clientAuthService.resetPassword(reset)
    if (entry === 'mobile-reset') await mobileAuthService.resetPassword(reset, meta(f.user.id))
    if (entry === 'admin-reset') await clientUserManageService.resetPassword(f.user.id, { newPassword }, adminAuth)
    if (entry === 'rehash') {
      const rehashed = await hashPassword(oldPassword)
      await runInTransaction(manager => manager.getRepository(ClientUser).update(f.user.id, { passwordHash: rehashed }))
    }
    await assert.rejects(clientAuthService.resetPassword({ ...reset, resetToken: stale.resetToken }), isStatus(400))
    console.log(`PASS 双票据随 ${entry} 密码状态改变失效`)
  }
  {
    const f = await createFixture(), ticket = await issue(f.user)
    const reset = () => clientAuthService.resetPassword({ account: f.user.email!, resetToken: ticket.resetToken, newPassword })
    const results = await Promise.allSettled([reset(), reset()])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(await audits.countBy({ actionType: 'password_changed', targetId: f.user.id }), 1)
    console.log('PASS 同一票据原子消费仅提交一次')
  }
  // 两张不同票据都通过事务外准备后竞争同一账号；只能一个提交。
  {
    const f = await createFixture(), a = await issue(f.user), b = await issue(f.user)
    const original = crypto.scrypt
    const gate = barrier()
    let calls = 0
    crypto.scrypt = ((...args: unknown[]) => {
      if (args[0] === newPassword) {
        calls += 1
        if (calls === 1) { void gate.wait().then(() => Reflect.apply(original, crypto, args)); return }
      }
      return Reflect.apply(original, crypto, args)
    }) as typeof crypto.scrypt
    syncBuiltinESMExports()
    const reset = (resetToken: string) => clientAuthService.resetPassword({ account: f.user.email!, resetToken, newPassword })
    const first = reset(a.resetToken)
    try {
      await withTimeout(gate.entered)
      await reset(b.resetToken)
      gate.release()
      await assert.rejects(first, isStatus(400))
      assert.equal(await audits.countBy({ actionType: 'password_changed', targetId: f.user.id }), 1)
    } finally { gate.release(); await first.catch(() => undefined); crypto.scrypt = original; syncBuiltinESMExports() }
    console.log('PASS 两张不同票据的受控并发仅提交一次')
  }

  const internals = clientAuthService as unknown as { ensureProfileIdentifiersUnique: (...args: unknown[]) => Promise<void> }
  for (const kind of ['password', 'password-change', 'revoked', 'disabled', 'snapshot', 'web-expired', 'mobile-revoked', 'mobile-access-expired', 'mobile-absolute-expired', 'verified-at'] as const) {
    const f = await createFixture(), gate = barrier()
    const input = { ...profileInput(f), username: '生命周期改名' }
    const original = internals.ensureProfileIdentifiersUnique
    internals.ensureProfileIdentifiersUnique = async (...args) => { await original.apply(clientAuthService, args); await gate.wait() }
    const auth = kind.startsWith('mobile-') ? f.bearer : f.web
    const action = clientAuthService.updateProfile(auth, input, undefined, meta(f.user.id))
    try {
      await withTimeout(gate.entered)
      if (kind === 'password-change') {
        await clientAuthService.changePassword(f.web, { currentPassword: oldPassword, newPassword }, meta(f.user.id))
      }
      await runInTransaction(async manager => {
        if (kind === 'password') await manager.getRepository(ClientUser).update(f.user.id, { passwordHash: await hashPassword(newPassword) })
        if (kind === 'revoked') await manager.getRepository(ClientUserSession).delete({ userId: f.user.id })
        if (kind === 'disabled') await manager.getRepository(ClientUser).update(f.user.id, { status: 'disabled' })
        if (kind === 'snapshot') await manager.getRepository(ClientUser).update(f.user.id, { realName: '并发身份' })
        if (kind === 'web-expired') await manager.getRepository(ClientUserSession).update({ userId: f.user.id }, { expiresAt: new Date(0) })
        if (kind === 'mobile-revoked') await manager.getRepository(ClientMobileSession).update(f.mobile.sessionId, { revokedAt: new Date() })
        if (kind === 'mobile-access-expired') await manager.getRepository(ClientMobileSession).update(f.mobile.sessionId, { accessExpiresAt: new Date(0) })
        if (kind === 'mobile-absolute-expired') await manager.getRepository(ClientMobileSession).update(f.mobile.sessionId, { absoluteExpiresAt: new Date(0) })
        if (kind === 'verified-at') await manager.getRepository(ClientUser).update(f.user.id, { emailVerifiedAt: new Date('2026-01-02T03:04:05Z') })
      })
      const before = scryptCount
      gate.release()
      if (kind === 'verified-at') {
        const result = await action
        assert.equal(result.emailVerifiedAt?.toISOString(), '2026-01-02T03:04:05.000Z')
      } else {
        await assert.rejects(action, isStatus(kind === 'password' || kind === 'snapshot' ? 409 : 401))
        assert.equal(await audits.countBy({ actionType: 'client_user.update_profile', targetId: f.user.id }), 0)
        assert.notEqual((await users.findOneByOrFail({ id: f.user.id })).realName, input.username)
      }
      assert.equal(scryptCount, before, '最终事务不得二次校验旧密码')
      assert.equal(await bucket(f.user.id), null, '过期/冲突不得计入密码失败桶')
    } finally { gate.release(); await action.catch(() => undefined); internals.ensureProfileIdentifiersUnique = original }
    console.log(`PASS profile 并发 ${kind}`)
  }
  // 冲突发生于验证码消费后：409 不恢复验证码、不重试、不写成功审计。
  {
    const f = await createFixture(), gate = barrier(), email = `${crypto.randomUUID()}@example.test`
    await fakeSender.sendCode({ channel: 'email', target: email, scene: 'profile_update' })
    const original = verificationCodeService.verifyCode
    verificationCodeService.verifyCode = async input => { await original.call(verificationCodeService, input); await gate.wait() }
    const action = clientAuthService.updateProfile(f.web, { ...profileInput(f), email, emailVerificationCode: '123456' })
    try {
      await withTimeout(gate.entered)
      await runInTransaction(manager => manager.getRepository(ClientUser).update(f.user.id, { realName: '验证码后并发' }))
      gate.release()
      await assert.rejects(action, (error: unknown) => isStatus(409)(error)
        && error instanceof Error && error.message.includes('重新获取验证码'))
      await assert.rejects(original.call(verificationCodeService, { channel: 'email', target: email, scene: 'profile_update', code: '123456' }), isStatus(400))
      assert.equal((await users.findOneByOrFail({ id: f.user.id })).email, f.user.email)
      assert.equal(await audits.countBy({ actionType: 'client_user.update_profile', targetId: f.user.id }), 0)
      assert.equal(await bucket(f.user.id), null)
    } finally { gate.release(); await action.catch(() => undefined); verificationCodeService.verifyCode = original }
  }
  // Web 路由兼容的 Mobile bearer 合法保存必须成功。
  {
    const f = await createFixture()
    const result = await clientAuthService.updateProfile(f.bearer, profileInput(f))
    assert.equal(result.id, f.user.id)
  }
  // Web/Mobile 资料与改密、登录共享 uid 桶；回滚后每次只记一次脱敏复核审计。
  {
    const f = await createFixture(), requestMeta = meta(f.user.id)
    const original = clientAuthService.recordCurrentPasswordFailure
    let recorded = 0
    clientAuthService.recordCurrentPasswordFailure = async (...args) => {
      assert.equal(Boolean(getCurrentTransactionManager(AppDataSource)), false, '失败记账必须在回滚之后')
      recorded += 1
      return original.apply(clientAuthService, args)
    }
    try {
      for (let index = 0; index < 8; index += 1) {
        const input = { currentPassword: 'WrongPassword789!', newPassword }
        const action = index === 0 ? clientAuthService.authenticateCredentials({ account: f.user.email!, password: input.currentPassword }, requestMeta)
          : index % 4 === 0 ? mobileAuthService.updateProfile(f.mobile, { ...profileInput(f), currentPassword: input.currentPassword }, requestMeta)
          : index % 4 === 1 ? mobileAuthService.changePassword(f.mobile, { ...input, device: f.device }, requestMeta)
          : index % 4 === 2 ? clientAuthService.updateProfile(f.web, { ...profileInput(f), currentPassword: input.currentPassword }, undefined, requestMeta)
          : clientAuthService.changePassword(f.web, input, requestMeta)
        await assert.rejects(action, isStatus(index === 0 ? 401 : 400))
        assert.equal((await bucket(f.user.id))?.count, index + 1)
        if (index === 3) {
          await mobileAuthService.updateProfile(f.mobile, profileInput(f), requestMeta)
          assert.equal((await bucket(f.user.id))?.count, 4, '成功复核不新增清桶行为')
        }
      }
      assert.equal(recorded, 7)
      const failures = await audits.findBy({ actionType: 'client.auth.reauth_failed', targetId: f.user.id })
      assert.equal(failures.length, 7)
      assert.ok(failures.every(log => !JSON.stringify(log).includes('WrongPassword789!')))
      const before = scryptCount
      await assert.rejects(mobileAuthService.updateProfile(f.mobile, profileInput(f), requestMeta), isStatus(429))
      await assert.rejects(mobileAuthService.changePassword(f.mobile, { currentPassword: oldPassword, newPassword, device: f.device }, requestMeta), isStatus(429))
      await assert.rejects(authSecurityService.guardClientLoginRequest(requestMeta, f.user.email!, async () => `uid:${f.user.id}`), isStatus(429))
      assert.equal(scryptCount, before, '锁定账号在 scrypt 前拒绝')
      assert.equal(recorded, 7)
      assert.equal(await audits.countBy({ actionType: 'password_changed', targetId: f.user.id }), 0)
    } finally { clientAuthService.recordCurrentPasswordFailure = original }
  }
  console.log(`PASS 认证生命周期 ${mysql ? 'MySQL' : 'SQLite'} 统一回归`)
} catch (error) {
  if (error instanceof Error && error.name === 'QueryFailedError') throw new Error('隔离数据库查询失败，已隐藏 SQL 参数')
  throw error
} finally {
  crypto.scrypt = originalScrypt
  EphemeralTicketStore.prototype.set = originalSet
  syncBuiltinESMExports()
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
  await dropDatabase?.()
  fs.rmSync(temporaryRoot, { recursive: true, force: true })
}
