/** 文件职责：在隔离 SQLite 中验证新注册字符约束、重名拒绝及历史登录兼容。 */
import 'reflect-metadata'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const directory = mkdtempSync(join(tmpdir(), 'ylink-register-policy-'))
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'false'
process.env.SQLITE_DB_PATH = join(directory, 'verify.sqlite')
process.env.APP_PROFILE = 'registration-policy-verify'
const { AppDataSource } = await import('../src/config/data-source.js')
const { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime } = await import('../src/config/database-bootstrap.js')
const { clientAuthService } = await import('../src/services/client-auth.service.js')
const { systemConfigService } = await import('../src/services/system-config.service.js')
const { ClientUser } = await import('../src/entities/client-user.entity.js')
const password = 'VerifyRegister_2026!'
const captcha = async () => {
  const value = await clientAuthService.createCaptcha()
  return { captchaId: value.captchaId, captchaCode: value.captchaSvg.replaceAll(/<[^>]*>/g, '').replaceAll(/\s+/g, '').slice(0, 6) }
}
let sequence = 0
const register = async (username: string) => clientAuthService.register({
  accountType: 'personal', account: `policy${++sequence}@example.com`, username, password, ...await captcha(),
})
try {
  prepareDatabaseRuntime()
  await AppDataSource.initialize()
  await initializeDatabaseSchemaIfNeeded(AppDataSource)
  await systemConfigService.ensureDefaultConfigs()
  const first = await register('张测试')
  assert.equal(first.user.username, '张测试')
  const english = await register('Alice')
  assert.equal(english.user.username, 'Alice')
  const englishLogin = await clientAuthService.login({ account: 'alice', password, ...await captcha() })
  assert.equal(englishLogin.user.id, english.user.id, '英文用户名登录应兼容大小写')
  const mixed = await register('张Alice')
  assert.equal(mixed.user.username, '张Alice')
  const englishAuth = await clientAuthService.resolveClientByToken(english.token)
  const unchanged = await clientAuthService.updateProfile(englishAuth, { username: 'Alice', email: english.user.email, currentPassword: password })
  assert.equal(unchanged.username, 'Alice', '英文用户名不变时应能正常保存资料')
  await assert.rejects(clientAuthService.updateProfile(englishAuth, { username: 'Alice123', email: english.user.email, currentPassword: password }), /特殊字符/)
  for (const username of ['', '张', '中'.repeat(21), 'Ａlice', 'José', '张123', '123456', '张·测试', '张 测试', '张\t测试', '张\u200B测试', '张\u0000测试', '张。测试', '张😀测试', ' 张测试', '张测试 ']) {
    await assert.rejects(register(username), (error: Error) => /用户名.*特殊字符/.test(error.message), `禁止特殊字符：${JSON.stringify(username)}`)
  }
  await assert.rejects(register('张测试'), (error: Error) => /已被占用.*管理员/.test(error.message))
  await assert.rejects(register('alice'), (error: Error) => /已被占用.*管理员/.test(error.message))
  assert.equal(await AppDataSource.getRepository(ClientUser).count(), 3, '非法及重名请求不得落库')
  // 模拟既有带间隔点的姓名，不迁移、不删除，登录仍兼容。
  await AppDataSource.getRepository(ClientUser).update(first.user.id, { realName: '张·测试' })
  const login = await clientAuthService.login({ account: '张·测试', password, ...await captcha() })
  assert.equal(login.user.id, first.user.id)
  const legacyAuth = await clientAuthService.resolveClientByToken(login.token)
  const legacyProfile = await clientAuthService.updateProfile(legacyAuth, { username: '张·测试', email: first.user.email, currentPassword: password })
  assert.equal(legacyProfile.username, '张·测试', '旧姓名不变时保持资料维护兼容')
  console.log('OK 注册合法姓名、特殊字符拒绝、重名管理员提示、历史姓名登录兼容')
} finally {
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
  rmSync(directory, { recursive: true, force: true })
}
