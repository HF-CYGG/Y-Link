/**
 * 改密事务回归：观察真实 scrypt 调用，确认新密码派生发生在写事务外，旧密码最终校验仍在锁内。
 * 使用独立临时 SQLite 库，覆盖 Web/Mobile 成功与错误旧密码路径。
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ylink-password-transaction-'))
Object.assign(process.env, {
  NODE_ENV: 'test', DB_TYPE: 'sqlite', DB_SYNC: 'true',
  APP_PROFILE: 'password-transaction-verify', Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE: 'true',
  SQLITE_DB_PATH: path.join(temporaryRoot, 'verification.sqlite'),
})
const oldPassword = 'VerifyOld123!'
const newPassword = 'VerifyNew456!'
const wrongPassword = 'VerifyWrong789!'
let transactionActive = () => false
let observing = false
const observations: Array<{ kind: string; locked: boolean }> = []
const originalScrypt = crypto.scrypt
crypto.scrypt = ((...args: unknown[]) => {
  if (observing) observations.push({
    kind: args[0] === newPassword ? 'new' : args[0] === oldPassword ? 'old' : 'wrong',
    locked: transactionActive(),
  })
  return Reflect.apply(originalScrypt, crypto, args)
}) as typeof crypto.scrypt
syncBuiltinESMExports()

const { AppDataSource } = await import('../src/config/data-source.js')
const { initializeDatabaseInfrastructure } = await import('../src/database/database-strategy.js')
const { initializeDatabaseSchemaIfNeeded } = await import('../src/config/database-bootstrap.js')
const { getCurrentTransactionManager } = await import('../src/database/transaction-coordinator.js')
const { ClientUser } = await import('../src/entities/client-user.entity.js')
const { clientAuthService } = await import('../src/services/client-auth.service.js')
const { mobileAuthService } = await import('../src/services/mobile-auth.service.js')
const { mobileSessionService } = await import('../src/services/mobile-session.service.js')
const { hashPassword, verifyPassword } = await import('../src/utils/password.js')
const { BizError } = await import('../src/utils/errors.js')
transactionActive = () => Boolean(getCurrentTransactionManager(AppDataSource))
const failures: string[] = []
try {
  await AppDataSource.initialize()
  await initializeDatabaseInfrastructure(AppDataSource)
  await initializeDatabaseSchemaIfNeeded(AppDataSource)
  for (const mobile of [false, true]) {
    for (const wrong of [false, true]) {
      const label = (mobile ? 'Mobile' : 'Web') + (wrong ? '错误旧密码' : '成功改密')
      const user = await AppDataSource.getRepository(ClientUser).save({
        realName: '改密验证', email: 'password-' + crypto.randomUUID() + '@example.test',
        passwordHash: await hashPassword(oldPassword), accountType: 'personal' as const,
        departmentName: '', status: 'enabled' as const, staffVerified: false,
      })
      const device = { deviceId: crypto.randomUUID(), platform: 'android' as const }
      const credentials = await mobileSessionService.createForUser(user, device)
      const auth = await mobileSessionService.resolveAccess(credentials.accessToken)
      observations.length = 0
      observing = true
      try {
        const input = { currentPassword: wrong ? wrongPassword : oldPassword, newPassword, device }
        const action = mobile
          ? mobileAuthService.changePassword(auth, input)
          : clientAuthService.changePassword({
            userId: user.id, account: user.email!, email: user.email!, mobile: '',
            realName: user.realName, accountType: 'personal', staffNo: null,
            sessionToken: '', authSource: 'bearer',
          }, input)
        if (wrong) await assert.rejects(action, (error: unknown) => error instanceof BizError && error.message === '原密码错误')
        else await action
      } finally { observing = false }
      try {
        assert.equal(observations.filter(item => item.kind === 'new').length, 1, '新密码仅派生一次')
        assert.ok(observations.filter(item => item.kind === 'new').every(item => !item.locked), '新密码派生不得占用写事务')
        assert.ok(observations.some(item => item.kind !== 'new' && item.locked), '旧密码最终验证必须位于事务中')
        const saved = await AppDataSource.getRepository(ClientUser).createQueryBuilder('user')
          .addSelect('user.passwordHash').where('user.id = :id', { id: user.id }).getOneOrFail()
        assert.equal(await verifyPassword(wrong ? oldPassword : newPassword, saved.passwordHash), true)
        if (wrong) await mobileSessionService.resolveAccess(credentials.accessToken)
        else await assert.rejects(mobileSessionService.resolveAccess(credentials.accessToken))
        console.log('PASS ' + label)
      } catch (error) { failures.push(label + ': ' + (error instanceof Error ? error.message : '断言失败')) }
    }
  }
  assert.deepEqual(failures, [])
} catch (error) {
  if (error instanceof Error && error.name === 'QueryFailedError') throw new Error('隔离数据库查询失败，已隐藏 SQL 参数')
  throw error
} finally {
  observing = false
  crypto.scrypt = originalScrypt
  syncBuiltinESMExports()
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
  fs.rmSync(temporaryRoot, { recursive: true, force: true })
}
