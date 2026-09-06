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
const { verificationCodeService } = await import('../src/services/verification-code.service.js')
const { ClientUser } = await import('../src/entities/client-user.entity.js')
const password = 'VerifyRegister_2026!'
const captcha = async () => {
  const value = await clientAuthService.createCaptcha()
  return { captchaId: value.captchaId, captchaCode: value.captchaSvg.replaceAll(/<[^>]*>/g, '').replaceAll(/\s+/g, '').slice(0, 6) }
}
// 仅替换进程内第三方验证码边界，不发送邮件/短信；保留真实注册、重名检查与数据库写入。
const originalProviders = systemConfigService.getVerificationProviderConfigs.bind(systemConfigService)
const originalVerifyCode = verificationCodeService.verifyCode.bind(verificationCodeService)
const pendingTargets = new Set<string>()
let emailEnabled = true
systemConfigService.getVerificationProviderConfigs = async () => {
  const configs = await originalProviders()
  return { ...configs, email: { ...configs.email, enabled: emailEnabled, ready: emailEnabled } }
}
verificationCodeService.verifyCode = async (input) => {
  assert.equal(input.channel, 'email')
  assert.equal(input.scene, 'register')
  assert.equal(input.code, '123456')
  assert.ok(pendingTargets.delete(input.target), '核验应绑定本次目标且只能使用一次')
}
let sequence = 0
const register = async (username: string, account = `policy${++sequence}@example.com`) => {
  pendingTargets.add(account)
  return clientAuthService.register({ accountType: 'personal', account, username, password, verificationCode: '123456' })
}
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
  const nfkc = await register('Ｂｏｂ')
  assert.equal(nfkc.user.username, 'Bob', '全角兼容字母应在 NFKC 规范化后保存')
  const englishAuth = await clientAuthService.resolveClientByToken(english.token)
  const unchanged = await clientAuthService.updateProfile(englishAuth, { username: 'Alice', email: english.user.email, currentPassword: password })
  assert.equal(unchanged.username, 'Alice', '英文用户名不变时应能正常保存资料')
  await assert.rejects(clientAuthService.updateProfile(englishAuth, { username: 'Alice123', email: english.user.email, currentPassword: password }), /特殊字符/)
  for (const username of ['', '张', '中'.repeat(21), 'José', '张123', '123456', '张·测试', '张 测试', '张\t测试', '张\u200B测试', '张\u0000测试', '张。测试', '张😀测试', ' 张测试', '张测试 ']) {
    await assert.rejects(register(username), (error: Error) => /用户名.*特殊字符/.test(error.message), `禁止特殊字符：${JSON.stringify(username)}`)
  }
  const genericFailure = '当前注册信息无法使用，请确认联系方式已完成验证后重试'
  const isGenericFailure = (error: Error) => error.message === genericFailure
  await assert.rejects(register('张测试'), isGenericFailure)
  await assert.rejects(register('alice'), isGenericFailure)
  await assert.rejects(register('新姓名', first.user.email), isGenericFailure, '重名与联系方式重复必须返回同一提示')
  await assert.rejects(clientAuthService.register({ accountType: 'personal', account: 'unverified@example.com', username: '张测试', password }), /邮箱验证码/, '核验前不得泄露重名状态')
  emailEnabled = false
  await assert.rejects(register('新用户'), isGenericFailure, '通道关闭不得降级为图形验证码注册')
  emailEnabled = true
  assert.equal(await AppDataSource.getRepository(ClientUser).count(), 4, '非法及重名请求不得落库')
  // 模拟既有带间隔点的姓名，不迁移、不删除，登录仍兼容。
  await AppDataSource.getRepository(ClientUser).update(first.user.id, { realName: '张·测试' })
  const login = await clientAuthService.login({ account: '张·测试', password, ...await captcha() })
  assert.equal(login.user.id, first.user.id)
  const legacyAuth = await clientAuthService.resolveClientByToken(login.token)
  const legacyProfile = await clientAuthService.updateProfile(legacyAuth, { username: '张·测试', email: first.user.email, currentPassword: password })
  assert.equal(legacyProfile.username, '张·测试', '旧姓名不变时保持资料维护兼容')
  // 历史姓名可能包含新规则禁止的字符或首尾空格；展示层会裁剪首尾空格，
  // 仅修改联系方式时仍必须识别为未改名，且不能静默迁移数据库原值。
  const spacedLegacyUsername = ' 旧_用户名 '
  await AppDataSource.getRepository(ClientUser).update(first.user.id, { realName: spacedLegacyUsername })
  const spacedLegacyAuth = await clientAuthService.resolveClientByToken(login.token)
  const spacedLegacyProfile = await clientAuthService.updateProfile(spacedLegacyAuth, {
    username: spacedLegacyUsername.trim(),
    email: first.user.email,
    currentPassword: password,
  })
  assert.equal(spacedLegacyProfile.username, spacedLegacyUsername.trim(), '展示层裁剪后的旧姓名应允许更新其他资料')
  const spacedLegacyPersisted = await AppDataSource.getRepository(ClientUser).findOneByOrFail({ id: first.user.id })
  assert.equal(spacedLegacyPersisted.realName, spacedLegacyUsername, '未主动改名时不得迁移历史姓名原值')
  console.log('OK 注册合法姓名、特殊字符拒绝、统一重名错误、联系方式验证门禁、历史姓名登录兼容')
} finally {
  systemConfigService.getVerificationProviderConfigs = originalProviders
  verificationCodeService.verifyCode = originalVerifyCode
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
  rmSync(directory, { recursive: true, force: true })
}
