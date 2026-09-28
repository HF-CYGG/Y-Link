/**
 * 文件说明：backend/scripts/admin-mfa-verify.ts
 * 文件职责：回归管理端 TOTP 两步验证的完整闭环，防止绑定、两段登录、防重放、恢复码、重置与联动删除悄悄退化。
 * 实现逻辑：
 * - 使用本轮唯一临时 SQLite 库与数据目录启动真实应用，经 HTTP 走绑定、两段登录、停用、重生成恢复码、管理员重置；
 * - 动态码由脚本按绑定时返回的秘钥自行计算；需要连续使用多个动态码时，直接回拨 `last_used_step` 模拟时间推进；
 * - 每个阶段前清空风控状态表，避免上一阶段的失败计数触发图形验证码或频控，干扰本阶段断言；
 * - 另外覆盖数据加密密钥不匹配时的降级、账号永久删除联动清理、命令行应急重置与审计不落明文。
 * 维护说明：修改登录流程、两步验证服务或相关路由时同步补充断言；不要为了让脚本通过而放宽断言。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { AuthUserContext } from '../src/types/auth.js'

const backendRoot = path.resolve(process.cwd())
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ylink-admin-mfa-'))
const ADMIN_PASSWORD = 'Mfa-Verify#Admin2026'
const OPERATOR_PASSWORD = 'Opx7-Verify#Staff2026'
const PERMANENT_DELETE_PASSWORD = 'Mfa-Verify-Permanent-Delete!9'

delete process.env.ENV_FILE
delete process.env.Y_LINK_DATA_ENCRYPTION_KEY
process.env.NODE_ENV = 'test'
process.env.APP_PROFILE = `admin-mfa-verify-${process.pid}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'false'
process.env.SQLITE_DB_PATH = path.join(tempRoot, 'admin-mfa.sqlite')
process.env.Y_LINK_DATA_DIR = path.join(tempRoot, 'data')
process.env.Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE = 'true'
process.env.INIT_ADMIN_PASSWORD = ADMIN_PASSWORD
process.env.PERMANENT_DELETE_PASSWORD = PERMANENT_DELETE_PASSWORD
// 本脚本会刻意制造多次失败，全局撞库态势阈值调到上限，避免触发全员验证码干扰断言。
process.env.YLINK_ADMIN_GLOBAL_FAILURE_THRESHOLD = '100000'

const { AppDataSource } = await import('../src/config/data-source.js')
const bootstrap = await import('../src/config/database-bootstrap.js')
const { authService } = await import('../src/services/auth.service.js')
const { systemConfigService } = await import('../src/services/system-config.service.js')
const { notificationService } = await import('../src/services/notification.service.js')
const { userService } = await import('../src/services/user.service.js')
const { adminMfaService } = await import('../src/services/admin-mfa.service.js')
const { createApp } = await import('../src/app.js')
const { computeHotp, currentTotpStep, decodeBase32, normalizeRecoveryCode } = await import('../src/utils/totp.js')
const { resetDataEncryptionKeyCacheForTesting } = await import('../src/utils/data-encryption.js')
const { resolvePermissionsByRole } = await import('../src/constants/auth-permissions.js')
const { SysUser } = await import('../src/entities/sys-user.entity.js')
const { SysUserMfa } = await import('../src/entities/sys-user-mfa.entity.js')
const { SysAuditLog } = await import('../src/entities/sys-audit-log.entity.js')
const { AuthRiskState } = await import('../src/entities/auth-risk-state.entity.js')
const { persistentRiskStateService } = await import('../src/services/persistent-risk-state.service.js')

interface ApiResponse {
  status: number
  body: { code: number; message: string; data: Record<string, unknown> | null }
  cookies: Record<string, string>
}

interface HttpSession {
  cookie: string
  csrf: string
}

let server: Server | undefined
let baseUrl = ''
const plaintextSecrets: string[] = []

const readSetCookies = (response: Response) => {
  const cookies: Record<string, string> = {}
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(';')
    const index = pair.indexOf('=')
    cookies[pair.slice(0, index)] = decodeURIComponent(pair.slice(index + 1))
  }
  return cookies
}

async function call(method: string, pathname: string, body?: unknown, session?: HttpSession): Promise<ApiResponse> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (session) {
    headers.Cookie = session.cookie
    headers['x-csrf-token'] = session.csrf
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return {
    status: response.status,
    body: await response.json() as ApiResponse['body'],
    cookies: readSetCookies(response),
  }
}

function sessionFrom(response: ApiResponse): HttpSession {
  const token = response.cookies.y_link_admin_session
  const csrf = response.cookies.y_link_admin_csrf
  assert.ok(token && csrf, `登录成功必须下发会话与 CSRF Cookie：${JSON.stringify(response.body)}`)
  return {
    cookie: `y_link_admin_session=${encodeURIComponent(token)}; y_link_admin_csrf=${encodeURIComponent(csrf)}`,
    csrf,
  }
}

/** 清空风控状态：上一阶段的失败会让本机来源需要图形验证码，阶段之间必须归零（含进程内负缓存）。 */
const resetRiskState = async () => {
  await AppDataSource.getRepository(AuthRiskState).clear()
  persistentRiskStateService.resetNegativeCacheForTesting()
}

const codeAt = (secret: string, step: number) => computeHotp(decodeBase32(secret), step)

/** 模拟时间推进：把防重放游标回拨到当前步之前，下一次即可使用当前时间步的动态码。 */
async function rewindLastUsedStep(userId: string | number) {
  await AppDataSource.getRepository(SysUserMfa).update({ userId: String(userId) }, { lastUsedStep: currentTotpStep() - 2 })
}

function wrongCodeFor(secret: string) {
  const step = currentTotpStep()
  const valid = new Set([step - 1, step, step + 1].map((candidate) => codeAt(secret, candidate)))
  for (let value = 0; value < 1_000_000; value += 1) {
    const candidate = String(value).padStart(6, '0')
    if (!valid.has(candidate)) return candidate
  }
  throw new Error('无法构造错误动态码')
}

async function contextOf(username: string): Promise<AuthUserContext> {
  const user = await AppDataSource.getRepository(SysUser).findOneByOrFail({ username })
  return {
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    permissions: resolvePermissionsByRole(user.role),
    status: user.status,
    sessionToken: `verify-${username}`,
    authSource: 'bearer',
  }
}

/** 通过服务层为指定账号开启两步验证，返回秘钥与恢复码。 */
async function enableMfaViaService(username: string) {
  const auth = await contextOf(username)
  const enrollment = await adminMfaService.beginEnrollment(auth)
  plaintextSecrets.push(enrollment.secret)
  const confirmed = await adminMfaService.confirmEnrollment(auth, codeAt(enrollment.secret, currentTotpStep()))
  plaintextSecrets.push(...confirmed.recoveryCodes)
  return { auth, secret: enrollment.secret, recoveryCodes: confirmed.recoveryCodes }
}

async function loginStepOne(username: string, password: string) {
  const response = await call('POST', '/api/auth/login', { username, password })
  assert.equal(response.status, 200, `第一步登录失败：${JSON.stringify(response.body)}`)
  return response
}

async function verifyEnrollmentAndLogin() {
  await resetRiskState()
  const adminLogin = await loginStepOne('admin', ADMIN_PASSWORD)
  let adminSession = sessionFrom(adminLogin)

  const initialStatus = await call('GET', '/api/auth/mfa/status', undefined, adminSession)
  assert.equal(initialStatus.status, 200)
  assert.equal(initialStatus.body.data?.enabled, false, '默认不开启两步验证')

  const missingPassword = await call('POST', '/api/auth/mfa/enroll', {}, adminSession)
  assert.equal(missingPassword.status, 400, '发起绑定必须提交当前密码')
  const wrongPassword = await call('POST', '/api/auth/mfa/enroll', { currentPassword: 'Wrong-Password-9' }, adminSession)
  assert.equal(wrongPassword.status, 400, '当前密码错误不得发起绑定')
  await resetRiskState()

  const enroll = await call('POST', '/api/auth/mfa/enroll', { currentPassword: ADMIN_PASSWORD }, adminSession)
  assert.equal(enroll.status, 200, JSON.stringify(enroll.body))
  const secret = String(enroll.body.data?.secret ?? '')
  plaintextSecrets.push(secret)
  assert.equal(secret.length, 32, '秘钥为 20 字节 Base32')
  assert.ok(String(enroll.body.data?.otpauthUri).startsWith(`otpauth://totp/Y-Link:admin?secret=${secret}&issuer=Y-Link`))

  const wrongConfirm = await call('POST', '/api/auth/mfa/enroll/confirm', { code: wrongCodeFor(secret) }, adminSession)
  assert.equal(wrongConfirm.status, 400, '错误动态码不得完成绑定')
  assert.equal(await AppDataSource.getRepository(SysUserMfa).count(), 0, '确认前不得落库')

  const confirmStep = currentTotpStep()
  const confirm = await call('POST', '/api/auth/mfa/enroll/confirm', { code: codeAt(secret, confirmStep) }, adminSession)
  assert.equal(confirm.status, 200, JSON.stringify(confirm.body))
  const recoveryCodes = confirm.body.data?.recoveryCodes as string[]
  plaintextSecrets.push(...recoveryCodes)
  assert.equal(recoveryCodes.length, 10, '开启时生成 10 个恢复码')
  recoveryCodes.forEach((code) => assert.match(code, /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/))

  const stored = await AppDataSource.getRepository(SysUserMfa)
    .createQueryBuilder('mfa')
    .addSelect(['mfa.totpSecretSealed', 'mfa.recoveryCodesJson'])
    .getOneOrFail()
  assert.ok(stored.totpSecretSealed.startsWith('ylenc:v1:'), '秘钥必须加密落库')
  assert.ok(!stored.totpSecretSealed.includes(secret), '密文中不得包含秘钥明文')
  const storedDigests = (JSON.parse(stored.recoveryCodesJson) as { codes: string[] }).codes
  assert.equal(storedDigests.length, 10)
  storedDigests.forEach((digest) => assert.match(digest, /^[0-9a-f]{64}$/))
  recoveryCodes.forEach((code) => assert.ok(!stored.recoveryCodesJson.includes(normalizeRecoveryCode(code)), '恢复码不得明文落库'))

  const enabledStatus = await call('GET', '/api/auth/mfa/status', undefined, adminSession)
  assert.equal(enabledStatus.body.data?.enabled, true)
  assert.equal(enabledStatus.body.data?.recoveryCodesRemaining, 10)
  const enrollAgain = await call('POST', '/api/auth/mfa/enroll', { currentPassword: ADMIN_PASSWORD }, adminSession)
  assert.equal(enrollAgain.status, 409, '已开启时不能重复绑定')

  // 两段登录：第一步只返回票据、不下发会话 Cookie。
  await call('POST', '/api/auth/logout', {}, adminSession)
  await resetRiskState()
  const stepOne = await loginStepOne('admin', ADMIN_PASSWORD)
  assert.equal(stepOne.body.data?.mfaRequired, true, '已开启两步验证时第一步必须要求第二因素')
  assert.equal(stepOne.cookies.y_link_admin_session, undefined, '第一步不得下发会话 Cookie')
  const ticket = String(stepOne.body.data?.mfaTicket)

  const wrongCode = await call('POST', '/api/auth/login/mfa', { mfaTicket: ticket, code: wrongCodeFor(secret) })
  assert.equal(wrongCode.status, 401)
  assert.equal(wrongCode.body.data?.reason, 'ADMIN_MFA_CODE_INVALID')
  const replay = await call('POST', '/api/auth/login/mfa', { mfaTicket: ticket, code: codeAt(secret, confirmStep) })
  assert.equal(replay.status, 401, '绑定时用过的动态码不得再次用于登录（防重放）')
  const bothFactors = await call('POST', '/api/auth/login/mfa', { mfaTicket: ticket, code: '123456', recoveryCode: recoveryCodes[0] })
  assert.equal(bothFactors.status, 400, '动态码与恢复码只能二选一')

  const success = await call('POST', '/api/auth/login/mfa', { mfaTicket: ticket, code: codeAt(secret, confirmStep + 1) })
  assert.equal(success.status, 200, JSON.stringify(success.body))
  adminSession = sessionFrom(success)
  assert.equal((await call('GET', '/api/auth/me', undefined, adminSession)).status, 200, '第二步成功后会话可用')
  const reuseTicket = await call('POST', '/api/auth/login/mfa', { mfaTicket: ticket, code: codeAt(secret, confirmStep + 1) })
  assert.equal(reuseTicket.body.data?.reason, 'ADMIN_MFA_TICKET_EXPIRED', '票据登录成功后即作废')

  const loginAudit = await AppDataSource.getRepository(SysAuditLog).findOne({
    where: { actionType: 'auth.login', resultStatus: 'success' },
    order: { id: 'DESC' },
  })
  assert.match(loginAudit?.detailJson ?? '', /"mfaMethod":"totp"/, '登录审计记录第二因素方式')
  assert.ok(await AppDataSource.getRepository(SysAuditLog).count({ where: { actionType: 'auth.mfa.challenge' } }) >= 1)

  return { adminSession, secret, recoveryCodes }
}

async function verifyRecoveryCodeAndTicketLimits(secret: string, recoveryCodes: string[]) {
  await resetRiskState()
  const stepOne = await loginStepOne('admin', ADMIN_PASSWORD)
  const messyInput = recoveryCodes[0].toLowerCase().replace(/-/g, ' ')
  const recovery = await call('POST', '/api/auth/login/mfa', { mfaTicket: stepOne.body.data?.mfaTicket, recoveryCode: messyInput })
  assert.equal(recovery.status, 200, `恢复码忽略大小写与分隔符：${JSON.stringify(recovery.body)}`)
  assert.equal(recovery.body.data?.recoveryCodesRemaining, 9, '恢复码登录返回剩余数量')

  await resetRiskState()
  const again = await loginStepOne('admin', ADMIN_PASSWORD)
  const reused = await call('POST', '/api/auth/login/mfa', { mfaTicket: again.body.data?.mfaTicket, recoveryCode: recoveryCodes[0] })
  assert.equal(reused.status, 401, '恢复码只能使用一次')

  // 票据最多 5 次尝试，错误同时计入账号登录失败锁定（阈值 5）。
  await resetRiskState()
  const limited = await loginStepOne('admin', ADMIN_PASSWORD)
  const limitedTicket = limited.body.data?.mfaTicket
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await call('POST', '/api/auth/login/mfa', { mfaTicket: limitedTicket, code: wrongCodeFor(secret) })
    assert.equal(response.body.data?.reason, 'ADMIN_MFA_CODE_INVALID', `第 ${attempt} 次错误仍可继续尝试`)
    assert.equal(response.body.data?.attemptsLeft, 5 - attempt)
  }
  const exhausted = await call('POST', '/api/auth/login/mfa', { mfaTicket: limitedTicket, code: wrongCodeFor(secret) })
  assert.equal(exhausted.body.data?.reason, 'ADMIN_MFA_TICKET_EXPIRED', '错误次数用尽后票据作废')
  const locked = await call('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PASSWORD })
  assert.equal(locked.status, 429, '第二因素错误计入账号锁定，锁定期内第一步同样被拒绝')

  // 同一票据并发提交：只能有一个成功。
  await resetRiskState()
  await rewindLastUsedStep((await contextOf('admin')).userId)
  const concurrent = await loginStepOne('admin', ADMIN_PASSWORD)
  const concurrentCode = codeAt(secret, currentTotpStep())
  const results = await Promise.all([1, 2].map(() => call('POST', '/api/auth/login/mfa', { mfaTicket: concurrent.body.data?.mfaTicket, code: concurrentCode })))
  assert.equal(results.filter((result) => result.status === 200).length, 1, '同一票据并发提交只能成功一次')
}

async function verifySelfServiceManagement(adminSession: HttpSession, secret: string, recoveryCodes: string[]) {
  const adminId = (await contextOf('admin')).userId
  await resetRiskState()
  await rewindLastUsedStep(adminId)
  const withRecovery = await call('POST', '/api/auth/mfa/recovery-codes', { currentPassword: ADMIN_PASSWORD, recoveryCode: recoveryCodes[1] }, adminSession)
  assert.equal(withRecovery.status, 400, '重新生成恢复码必须使用动态码')
  const regenerated = await call('POST', '/api/auth/mfa/recovery-codes', { currentPassword: ADMIN_PASSWORD, code: codeAt(secret, currentTotpStep()) }, adminSession)
  assert.equal(regenerated.status, 200, JSON.stringify(regenerated.body))
  const newCodes = regenerated.body.data?.recoveryCodes as string[]
  plaintextSecrets.push(...newCodes)
  assert.equal(newCodes.length, 10)

  await resetRiskState()
  const oldCodeLogin = await loginStepOne('admin', ADMIN_PASSWORD)
  const oldCode = await call('POST', '/api/auth/login/mfa', { mfaTicket: oldCodeLogin.body.data?.mfaTicket, recoveryCode: recoveryCodes[1] })
  assert.equal(oldCode.status, 401, '重新生成后旧恢复码全部失效')

  await resetRiskState()
  const wrongDisable = await call('POST', '/api/auth/mfa/disable', { currentPassword: ADMIN_PASSWORD, code: wrongCodeFor(secret) }, adminSession)
  assert.equal(wrongDisable.status, 400, '停用必须提供正确的第二因素')
  const wrongPasswordDisable = await call('POST', '/api/auth/mfa/disable', { currentPassword: 'Wrong-Password-9', recoveryCode: newCodes[0] }, adminSession)
  assert.equal(wrongPasswordDisable.status, 400, '停用必须复核当前密码')
  await resetRiskState()
  const disabled = await call('POST', '/api/auth/mfa/disable', { currentPassword: ADMIN_PASSWORD, recoveryCode: newCodes[0] }, adminSession)
  assert.equal(disabled.status, 200, JSON.stringify(disabled.body))
  assert.equal((await call('GET', '/api/auth/mfa/status', undefined, adminSession)).body.data?.enabled, false)
  assert.ok(await AppDataSource.getRepository(SysAuditLog).count({ where: { actionType: 'auth.mfa.disable', resultStatus: 'success' } }) >= 1)

  await resetRiskState()
  const plainLogin = await loginStepOne('admin', ADMIN_PASSWORD)
  assert.equal(plainLogin.body.data?.mfaRequired, undefined, '停用后恢复单因素登录')
  return sessionFrom(plainLogin)
}

async function verifyAdminResetAndUserList(adminSession: HttpSession) {
  const adminActor = await contextOf('admin')
  await userService.create({ username: 'mfa-operator', password: OPERATOR_PASSWORD, displayName: '两步验证操作员', role: 'operator', status: 'enabled' }, adminActor)
  const operator = await enableMfaViaService('mfa-operator')

  const list = await call('GET', '/api/users?page=1&pageSize=50', undefined, adminSession)
  assert.equal(list.status, 200)
  const rows = (list.body.data?.list ?? []) as Array<{ username: string; mfaEnabled?: boolean }>
  assert.equal(rows.find((row) => row.username === 'mfa-operator')?.mfaEnabled, true, '用户列表标注两步验证状态')
  assert.equal(rows.find((row) => row.username === 'admin')?.mfaEnabled, false)

  // 第一步之后被管理员重置：旧票据失效，必须重新输入账号密码。
  await resetRiskState()
  const operatorStepOne = await loginStepOne('mfa-operator', OPERATOR_PASSWORD)
  assert.equal(operatorStepOne.body.data?.mfaRequired, true)
  const selfReset = await call('POST', `/api/users/${adminActor.userId}/mfa/reset`, {}, adminSession)
  assert.equal(selfReset.status, 400, '不能在用户管理里重置自己的两步验证')
  const reset = await call('POST', `/api/users/${operator.auth.userId}/mfa/reset`, {}, adminSession)
  assert.equal(reset.status, 200, JSON.stringify(reset.body))
  const resetAgain = await call('POST', `/api/users/${operator.auth.userId}/mfa/reset`, {}, adminSession)
  assert.equal(resetAgain.status, 409, '未开启时重置返回 409')
  const staleTicket = await call('POST', '/api/auth/login/mfa', { mfaTicket: operatorStepOne.body.data?.mfaTicket, code: codeAt(operator.secret, currentTotpStep() + 1) })
  assert.equal(staleTicket.body.data?.reason, 'ADMIN_MFA_TICKET_EXPIRED', '两步验证被重置后旧票据必须作废')
  const resetAudit = await AppDataSource.getRepository(SysAuditLog).findOne({ where: { actionType: 'user.mfa.reset' }, order: { id: 'DESC' } })
  assert.equal(String(resetAudit?.targetId), String(operator.auth.userId))

  await resetRiskState()
  const operatorLogin = await loginStepOne('mfa-operator', OPERATOR_PASSWORD)
  assert.equal(operatorLogin.body.data?.mfaRequired, undefined, '重置后对方只需账号密码即可登录')
  const operatorSession = sessionFrom(operatorLogin)
  const forbidden = await call('POST', `/api/users/${adminActor.userId}/mfa/reset`, {}, operatorSession)
  assert.equal(forbidden.status, 403, '非管理员不能重置他人两步验证')
}

async function verifyKeyMismatchFallback() {
  const admin = await enableMfaViaService('admin')
  await resetRiskState()
  process.env.Y_LINK_DATA_ENCRYPTION_KEY = 'ab'.repeat(32)
  resetDataEncryptionKeyCacheForTesting()
  try {
    const stepOne = await loginStepOne('admin', ADMIN_PASSWORD)
    const unreadable = await call('POST', '/api/auth/login/mfa', { mfaTicket: stepOne.body.data?.mfaTicket, code: codeAt(admin.secret, currentTotpStep() + 1) })
    assert.equal(unreadable.status, 409, '密钥不匹配时明确报错，不能退化为跳过第二因素')
    assert.match(unreadable.body.message, /无法解密/)
    await resetRiskState()
    const recoveryStepOne = await loginStepOne('admin', ADMIN_PASSWORD)
    const recoveryUnreadable = await call('POST', '/api/auth/login/mfa', { mfaTicket: recoveryStepOne.body.data?.mfaTicket, recoveryCode: admin.recoveryCodes[0] })
    assert.equal(recoveryUnreadable.status, 409, '密钥不匹配时恢复码同样无法校验')
  } finally {
    delete process.env.Y_LINK_DATA_ENCRYPTION_KEY
    resetDataEncryptionKeyCacheForTesting()
  }
  await resetRiskState()
  await rewindLastUsedStep(admin.auth.userId)
  const restored = await loginStepOne('admin', ADMIN_PASSWORD)
  const ok = await call('POST', '/api/auth/login/mfa', { mfaTicket: restored.body.data?.mfaTicket, code: codeAt(admin.secret, currentTotpStep()) })
  assert.equal(ok.status, 200, '恢复原密钥后可正常完成两步验证')
}

async function verifyPermanentDeleteAndCli() {
  const adminActor = await contextOf('admin')
  await userService.create({ username: 'mfa-delete-target', password: OPERATOR_PASSWORD, displayName: '待删除账号', role: 'operator', status: 'enabled' }, adminActor)
  const deleteTarget = await enableMfaViaService('mfa-delete-target')
  await userService.deactivate(deleteTarget.auth.userId, { reason: '两步验证联动删除回归' }, adminActor)
  await userService.permanentDelete(deleteTarget.auth.userId, {
    reason: '两步验证联动删除回归',
    confirmAccount: 'mfa-delete-target',
    permanentDeletePassword: PERMANENT_DELETE_PASSWORD,
  }, adminActor)
  assert.equal(await AppDataSource.getRepository(SysUserMfa).count({ where: { userId: String(deleteTarget.auth.userId) } }), 0, '永久删除账号时同事务清理两步验证记录')

  await userService.create({ username: 'mfa-cli-target', password: OPERATOR_PASSWORD, displayName: '命令行重置账号', role: 'operator', status: 'enabled' }, adminActor)
  const cliTarget = await enableMfaViaService('mfa-cli-target')
  const cliScript = path.join(backendRoot, 'src/runtime/admin-mfa-reset-cli.ts')
  const usage = spawnSync(process.execPath, ['--import', 'tsx', cliScript], { cwd: backendRoot, env: process.env, encoding: 'utf8' })
  assert.equal(usage.status, 2, '缺少用户名时返回用法错误')
  const cli = spawnSync(process.execPath, ['--import', 'tsx', cliScript, 'mfa-cli-target'], { cwd: backendRoot, env: process.env, encoding: 'utf8' })
  assert.equal(cli.status, 0, `命令行重置失败：${cli.stderr}`)
  assert.match(cli.stdout, /已重置账号 mfa-cli-target/)
  assert.equal(await AppDataSource.getRepository(SysUserMfa).count({ where: { userId: String(cliTarget.auth.userId) } }), 0)
  const cliAudit = await AppDataSource.getRepository(SysAuditLog).findOne({ where: { actionType: 'user.mfa.reset', targetCode: 'mfa-cli-target' } })
  assert.match(cliAudit?.detailJson ?? '', /"via":"cli"/, '命令行重置写审计并标明来源')
}

async function verifyAuditNeverStoresSecrets() {
  const logs = await AppDataSource.getRepository(SysAuditLog).find()
  const serialized = logs.map((log) => `${log.targetCode ?? ''}|${log.detailJson ?? ''}`).join('\n').toUpperCase()
  for (const secret of plaintextSecrets) {
    assert.ok(!serialized.includes(normalizeRecoveryCode(secret)), '审计中不得出现秘钥或恢复码明文')
    assert.ok(!serialized.includes(secret.toUpperCase()), '审计中不得出现秘钥或恢复码明文')
  }
}

try {
  bootstrap.prepareDatabaseRuntime()
  await AppDataSource.initialize()
  await bootstrap.initializeDatabaseSchemaIfNeeded(AppDataSource)
  await authService.ensureDefaultAdmin()
  await systemConfigService.ensureDefaultConfigs()
  await notificationService.ensureDefaultRules()
  server = createApp().listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server!.once('listening', () => resolve()))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const { adminSession, secret, recoveryCodes } = await verifyEnrollmentAndLogin()
  await verifyRecoveryCodeAndTicketLimits(secret, recoveryCodes)
  const plainAdminSession = await verifySelfServiceManagement(adminSession, secret, recoveryCodes)
  await verifyAdminResetAndUserList(plainAdminSession)
  await verifyKeyMismatchFallback()
  await verifyPermanentDeleteAndCli()
  await verifyAuditNeverStoresSecrets()
  console.log('[admin-mfa-verify] 管理端两步验证回归通过：绑定与落库加密、两段登录、防重放、恢复码一次性、票据次数与账号锁定、并发单次成功、停用与重生成、管理员重置与旧票据作废、用户列表状态、密钥不匹配降级、永久删除联动、命令行重置、审计不落明文')
} finally {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()))
  }
  if (AppDataSource.isInitialized) {
    await AppDataSource.destroy()
  }
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
