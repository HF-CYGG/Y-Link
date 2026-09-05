/**
 * 文件说明：backend/scripts/client-staff-invite-code-verify.ts
 * 文件职责：在隔离 SQLite 中验证教师统一邀请码的管理接口、注册规则、审计脱敏和并发边界。
 * 实现逻辑：通过真实 Express 路由覆盖权限与 CSRF，通过服务层覆盖注册锁定与并发；SQLite 事务队列与生产启动保持一致。
 * 维护说明：统一邀请码是长期可重复配置，不得把旧教职工目录上的个人邀请码字段重新纳入注册判断。
 */
import 'reflect-metadata'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sqliteRoot = path.resolve(backendRoot, 'data', 'local-dev')
const verifySeed = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const sqlitePath = path.resolve(sqliteRoot, `client-staff-invite-code-${verifySeed}.sqlite`)
const adminPassword = `Admin_${verifySeed}_Aa1!`
const operatorPassword = `Operator_${verifySeed}_Bb2!`

process.env.APP_PROFILE = `client-staff-invite-code-${verifySeed}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'false'
process.env.SQLITE_DB_PATH = sqlitePath
process.env.INIT_ADMIN_PASSWORD = adminPassword
process.env.INVITE_CODE_PEPPER ||= `invite-code-verify-${verifySeed}-minimum-32-bytes`

type JsonPayload = { code?: number; message?: string; data?: unknown }
type InviteConfigView = { status: 'not_set' | 'enabled' | 'disabled'; updatedAt: string | null }
type RegisterPrecheckMethod = (...args: unknown[]) => Promise<void>
type ClientAuthWithRegisterPrecheck = {
  assertRegisterIdentifiersAvailable: RegisterPrecheckMethod
  register: (input: Record<string, unknown>) => Promise<unknown>
}

function pass(message: string) {
  console.log(`OK ${message}`)
}

function cleanupSqliteFile() {
  if (!fs.existsSync(sqlitePath)) return
  try {
    fs.rmSync(sqlitePath, { force: true })
  } catch (error) {
    console.warn(`[client-staff-invite-code-verify] 临时 SQLite 清理失败，已忽略: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function readJson(response: Response): Promise<JsonPayload> {
  const body = await response.text()
  try {
    return JSON.parse(body) as JsonPayload
  } catch {
    throw new Error(`响应不是合法 JSON: status=${response.status} body=${body}`)
  }
}

async function expectOk<T>(response: Response, scene: string): Promise<T> {
  const payload = await readJson(response)
  assert.equal(response.status, 200, `${scene} HTTP 状态码异常: ${response.status} payload=${JSON.stringify(payload)}`)
  assert.equal(payload.code, 0, `${scene} 业务状态码异常: ${JSON.stringify(payload)}`)
  return payload.data as T
}

async function expectStatus(request: () => Promise<Response>, scene: string, expected: number): Promise<JsonPayload> {
  const response = await request()
  const payload = await readJson(response)
  assert.equal(response.status, expected, `${scene} 应返回 ${expected}: ${JSON.stringify(payload)}`)
  assert.equal(payload.code, expected, `${scene} 业务状态码应为 ${expected}: ${JSON.stringify(payload)}`)
  return payload
}

async function expectBizError(action: () => Promise<unknown>, scene: string, status: number, message: string) {
  try {
    await action()
  } catch (error) {
    assert.ok(error instanceof Error, `${scene} 应抛出 Error`)
    assert.equal((error as Error & { statusCode?: number }).statusCode, status, `${scene} 状态码不符合预期`)
    assert.ok(error.message.includes(message), `${scene} 错误信息异常: ${error.message}`)
    return
  }
  assert.fail(`${scene} 应失败但实际成功`)
}

async function pauseRegisterAfterIdentifierPrecheck(
  clientAuthService: unknown,
  input: Record<string, unknown>,
): Promise<{ registration: Promise<unknown>; release: () => void }> {
  const internals = clientAuthService as ClientAuthWithRegisterPrecheck
  const original = internals.assertRegisterIdentifiersAvailable
  let firstPrecheck = true
  let reachedPrecheck!: () => void
  let releasePrecheck!: () => void
  const reached = new Promise<void>((resolve) => { reachedPrecheck = resolve })
  const released = new Promise<void>((resolve) => { releasePrecheck = resolve })
  internals.assertRegisterIdentifiersAvailable = async (...args) => {
    await original.apply(clientAuthService, args)
    if (!firstPrecheck) return
    firstPrecheck = false
    reachedPrecheck()
    await released
  }
  const registration = internals.register(input)
  await reached
  return {
    registration,
    release: () => {
      internals.assertRegisterIdentifiersAvailable = original
      releasePrecheck()
    },
  }
}

function readCookieValue(response: Response, name: string): string | null {
  const headers = response.headers as Headers & { getSetCookie?: () => string[]; raw?: () => Record<string, string[]> }
  const values = headers.getSetCookie?.() ?? headers.raw?.()['set-cookie'] ?? [response.headers.get('set-cookie') ?? '']
  const match = new RegExp(String.raw`(?:^|,\s*)${name}=([^;]+)`).exec(values.filter(Boolean).join(','))
  return match?.[1] ? decodeURIComponent(match[1]) : null
}

async function login(baseUrl: string, username: string, password: string) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  const data = await expectOk<{ token?: string }>(response, `登录 ${username}`)
  const sessionCookie = readCookieValue(response, 'y_link_admin_session')
  const csrfCookie = readCookieValue(response, 'y_link_admin_csrf')
  const token = data.token ?? sessionCookie
  assert.ok(token, `${username} 未返回会话令牌`)
  return { token, sessionCookie, csrfCookie }
}

async function main() {
  fs.mkdirSync(sqliteRoot, { recursive: true })
  const { createApp } = await import('../src/app.js')
  const { AppDataSource } = await import('../src/config/data-source.js')
  const { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime } = await import('../src/config/database-bootstrap.js')
  const { SystemConfig } = await import('../src/entities/system-config.entity.js')
  const { SysAuditLog } = await import('../src/entities/sys-audit-log.entity.js')
  const { ClientStaffDirectory } = await import('../src/entities/client-staff-directory.entity.js')
  const { ClientUser } = await import('../src/entities/client-user.entity.js')
  const { authService } = await import('../src/services/auth.service.js')
  const { clientAuthService } = await import('../src/services/client-auth.service.js')
  const { clientStaffDirectoryService } = await import('../src/services/client-staff-directory.service.js')
  const { clientStaffInviteCodeService } = await import('../src/services/client-staff-invite-code.service.js')
  const { systemConfigService } = await import('../src/services/system-config.service.js')
  const { userService } = await import('../src/services/user.service.js')
  const { installSqliteTransactionQueue } = await import('../src/utils/sqlite-transaction-queue.js')

  prepareDatabaseRuntime()
  await AppDataSource.initialize()
  await installSqliteTransactionQueue(AppDataSource)
  const app = createApp()
  const server = app.listen(0, '127.0.0.1')

  try {
    await initializeDatabaseSchemaIfNeeded(AppDataSource)
    await authService.ensureDefaultAdmin()
    await systemConfigService.ensureDefaultConfigs()
    if (!server.listening) await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.once('listening', resolve)
    })
    const address = server.address()
    assert.ok(address && typeof address === 'object' && typeof address.port === 'number', '未能获取验证服务端口')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const admin = await login(baseUrl, 'admin', adminPassword)
    const adminAuth = await authService.resolveAuthUserByToken(admin.token)
    const operator = await userService.create({
      username: `inviteoperator${verifySeed.replaceAll('-', '').slice(-8)}`,
      password: operatorPassword,
      displayName: '邀请码回归操作员',
      role: 'operator',
    }, adminAuth)
    const operatorLogin = await login(baseUrl, operator.username, operatorPassword)

    await systemConfigService.updateClientDepartmentConfigs({ options: ['信息中心'] }, adminAuth)
    const directoryRecords = await Promise.all([
      clientStaffDirectoryService.create({ staffNo: 'I1001', realName: '赵老师', departmentName: '信息中心', status: 'active' }, adminAuth),
      clientStaffDirectoryService.create({ staffNo: 'I1002', realName: '钱老师', departmentName: '信息中心', status: 'active' }, adminAuth),
      clientStaffDirectoryService.create({ staffNo: 'I1003', realName: '孙老师', departmentName: '信息中心', status: 'active' }, adminAuth),
      clientStaffDirectoryService.create({ staffNo: 'I1004', realName: '李老师', departmentName: '信息中心', status: 'active' }, adminAuth),
      clientStaffDirectoryService.create({ staffNo: 'I1005', realName: '周老师', departmentName: '信息中心', status: 'active' }, adminAuth),
      clientStaffDirectoryService.create({ staffNo: 'I1006', realName: '吴老师', departmentName: '信息中心', status: 'active' }, adminAuth),
      clientStaffDirectoryService.create({ staffNo: 'I1007', realName: '郑老师', departmentName: '信息中心', status: 'active' }, adminAuth),
      clientStaffDirectoryService.create({ staffNo: 'I1008', realName: '王老师', departmentName: '信息中心', status: 'active' }, adminAuth),
      clientStaffDirectoryService.create({ staffNo: 'I1009', realName: '冯老师', departmentName: '信息中心', status: 'active' }, adminAuth),
      clientStaffDirectoryService.create({ staffNo: 'I1010', realName: '陈老师', departmentName: '信息中心', status: 'active' }, adminAuth),
    ])
    const recordByStaffNo = new Map(directoryRecords.map((item) => [item.record.staffNo, item.record]))

    const initial = await expectOk<InviteConfigView>(
      await fetch(`${baseUrl}/api/system-configs/client-staff-invite-code`, { headers: { Authorization: `Bearer ${admin.token}` } }),
      '管理员读取未设置的教师统一邀请码',
    )
    assert.deepEqual(initial, { status: 'not_set', updatedAt: null })
    await expectStatus(
      () => fetch(`${baseUrl}/api/system-configs/client-staff-invite-code`),
      '未登录读取教师统一邀请码',
      401,
    )
    const operatorRead = await expectOk<InviteConfigView>(
      await fetch(`${baseUrl}/api/system-configs/client-staff-invite-code`, { headers: { Authorization: `Bearer ${operatorLogin.token}` } }),
      '具备 system_configs:view 的操作员读取教师统一邀请码',
    )
    assert.equal(operatorRead.status, 'not_set')
    pass('教师统一邀请码读取接口要求登录和 system_configs:view，写入另行要求管理员')

    await expectBizError(
      () => clientAuthService.register({ accountType: 'personal', staffNo: 'I1001', inviteCode: '00001234', password: 'Teacher_Invite_Aa1!' }),
      '未设置统一邀请码时教师注册',
      503,
      '教师统一邀请码未设置',
    )
    const unconfiguredDirectory = await AppDataSource.getRepository(ClientStaffDirectory).findOneByOrFail({ staffNo: 'I1001' })
    assert.equal(unconfiguredDirectory.inviteFailedAttempts, 0, '未设置统一邀请码不得消耗工号失败计数')

    const cookieHeader = `y_link_admin_session=${encodeURIComponent(admin.sessionCookie ?? '')}; y_link_admin_csrf=${encodeURIComponent(admin.csrfCookie ?? '')}`
    await expectStatus(
      () => fetch(`${baseUrl}/api/system-configs/client-staff-invite-code`, {
        method: 'PUT', headers: { Cookie: cookieHeader, 'Content-Type': 'application/json' }, body: JSON.stringify({ inviteCode: '00001234' }),
      }),
      'Cookie 管理端写统一邀请码缺少 CSRF',
      403,
    )
    await expectStatus(
      () => fetch(`${baseUrl}/api/system-configs/client-staff-invite-code`, {
        method: 'PUT', headers: { Authorization: `Bearer ${operatorLogin.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ inviteCode: '00001234' }),
      }),
      '非管理员设置教师统一邀请码',
      403,
    )
    for (const invalidInviteCode of ['', '1234567', '123456789', '12ab5678']) {
      await expectStatus(
        () => fetch(`${baseUrl}/api/system-configs/client-staff-invite-code`, {
          method: 'PUT', headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ inviteCode: invalidInviteCode }),
        }),
        `统一邀请码拒绝非法格式 ${JSON.stringify(invalidInviteCode)}`,
        400,
      )
    }
    const enabled = await expectOk<InviteConfigView>(
      await fetch(`${baseUrl}/api/system-configs/client-staff-invite-code`, {
        method: 'PUT',
        headers: { Cookie: cookieHeader, 'Content-Type': 'application/json', 'x-csrf-token': admin.csrfCookie ?? '' },
        body: JSON.stringify({ inviteCode: '00001234' }),
      }),
      '管理员设置前导零教师统一邀请码',
    )
    assert.equal(enabled.status, 'enabled')
    assert.ok(enabled.updatedAt)
    const configAfterSet = await AppDataSource.getRepository(SystemConfig).findOneByOrFail({ configKey: 'client.staff_invite_code' })
    assert.equal(configAfterSet.configGroup, 'client_auth')
    assert.deepEqual(Object.keys(JSON.parse(configAfterSet.configValue)).sort(), ['digest', 'enabled'])
    assert.equal(JSON.parse(configAfterSet.configValue).digest.length, 64)
    assert.doesNotMatch(configAfterSet.configValue, /00001234/)
    pass('统一邀请码接受前导零、拒绝长度 0/7/9 和非数字格式，保存固定 HMAC 摘要，并执行管理员 CSRF 与角色门禁')

    const legacyDirectory = await AppDataSource.getRepository(ClientStaffDirectory).findOneByOrFail({ id: recordByStaffNo.get('I1002')?.id })
    legacyDirectory.inviteCodeDigest = 'a'.repeat(64)
    legacyDirectory.inviteExpiresAt = new Date(Date.now() - 24 * 60 * 60 * 1000)
    await AppDataSource.getRepository(ClientStaffDirectory).save(legacyDirectory)
    await clientAuthService.register({ accountType: 'personal', staffNo: 'I1001', inviteCode: '00001234', password: 'Teacher_Invite_Aa1!' })
    await clientAuthService.register({ accountType: 'personal', staffNo: 'I1002', inviteCode: '00001234', password: 'Teacher_Invite_Bb2!' })
    assert.equal(await AppDataSource.getRepository(ClientUser).countBy({ staffNo: 'I1001' }), 1)
    assert.equal(await AppDataSource.getRepository(ClientUser).countBy({ staffNo: 'I1002' }), 1)
    pass('两个有效工号可重复使用同一长期统一邀请码，旧个人码和 24 小时到期字段不影响注册')

    const legacyBefore = await AppDataSource.getRepository(ClientStaffDirectory).createQueryBuilder('directory')
      .addSelect('directory.inviteCodeDigest')
      .where('directory.id = :id', { id: recordByStaffNo.get('I1003')?.id })
      .getOneOrFail()
    const legacySnapshot = {
      digest: legacyBefore.inviteCodeDigest,
      issuedAt: legacyBefore.inviteIssuedAt?.toISOString() ?? null,
      expiresAt: legacyBefore.inviteExpiresAt?.toISOString() ?? null,
      usedAt: legacyBefore.inviteUsedAt?.toISOString() ?? null,
      failures: legacyBefore.inviteFailedAttempts,
      lockedUntil: legacyBefore.inviteLockedUntil?.toISOString() ?? null,
    }
    await expectStatus(
      () => fetch(`${baseUrl}/api/system-configs/client-staff-directory/${recordByStaffNo.get('I1003')?.id}/invite-code`, {
        method: 'PUT', headers: { Authorization: `Bearer ${operatorLogin.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ inviteCode: '99999999' }),
      }),
      '非管理员调用旧逐人设置邀请码端点',
      403,
    )
    await expectStatus(
      () => fetch(`${baseUrl}/api/system-configs/client-staff-directory/${recordByStaffNo.get('I1003')?.id}/invite-code/reset`, {
        method: 'POST', headers: { Authorization: `Bearer ${operatorLogin.token}` },
      }),
      '非管理员调用旧逐人重置邀请码端点',
      403,
    )
    await expectStatus(
      () => fetch(`${baseUrl}/api/system-configs/client-staff-directory/${recordByStaffNo.get('I1003')?.id}/invite-code`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${operatorLogin.token}` },
      }),
      '非管理员调用旧逐人禁用邀请码端点',
      403,
    )
    const legacyAfterForbidden = await AppDataSource.getRepository(ClientStaffDirectory).createQueryBuilder('directory')
      .addSelect('directory.inviteCodeDigest')
      .where('directory.id = :id', { id: recordByStaffNo.get('I1003')?.id })
      .getOneOrFail()
    assert.deepEqual({
      digest: legacyAfterForbidden.inviteCodeDigest,
      issuedAt: legacyAfterForbidden.inviteIssuedAt?.toISOString() ?? null,
      expiresAt: legacyAfterForbidden.inviteExpiresAt?.toISOString() ?? null,
      usedAt: legacyAfterForbidden.inviteUsedAt?.toISOString() ?? null,
      failures: legacyAfterForbidden.inviteFailedAttempts,
      lockedUntil: legacyAfterForbidden.inviteLockedUntil?.toISOString() ?? null,
    }, legacySnapshot, '越权旧端点不得改变历史个人邀请码字段')
    await expectStatus(
      () => fetch(`${baseUrl}/api/system-configs/client-staff-directory/${recordByStaffNo.get('I1003')?.id}/invite-code`, {
        method: 'PUT', headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ inviteCode: '99999999' }),
      }),
      '旧逐人设置邀请码端点',
      410,
    )
    await expectStatus(
      () => fetch(`${baseUrl}/api/system-configs/client-staff-directory/${recordByStaffNo.get('I1003')?.id}/invite-code/reset`, {
        method: 'POST', headers: { Authorization: `Bearer ${admin.token}` },
      }),
      '旧逐人重置邀请码端点',
      410,
    )
    await expectStatus(
      () => fetch(`${baseUrl}/api/system-configs/client-staff-directory/${recordByStaffNo.get('I1003')?.id}/invite-code`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${admin.token}` },
      }),
      '旧逐人禁用邀请码端点',
      410,
    )
    pass('旧逐人邀请码端点先拒绝越权且不改历史字段，管理员访问仍保持 410 门禁')

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expectBizError(
        () => clientAuthService.register({ accountType: 'personal', staffNo: 'I1003', inviteCode: '11111111', password: 'Teacher_Invite_Cc3!' }),
        `错误统一邀请码第 ${attempt + 1} 次`,
        400,
        '工号或邀请码无效',
      )
    }
    const lockedDirectory = await AppDataSource.getRepository(ClientStaffDirectory).findOneByOrFail({ staffNo: 'I1003' })
    assert.equal(lockedDirectory.inviteFailedAttempts, 0)
    assert.ok(lockedDirectory.inviteLockedUntil && lockedDirectory.inviteLockedUntil > new Date())
    const lockedUntilBeforeCorrectCode = lockedDirectory.inviteLockedUntil.toISOString()
    await expectBizError(
      () => clientAuthService.register({ accountType: 'personal', staffNo: 'I1003', inviteCode: '00001234', password: 'Teacher_Invite_Cc3!' }),
      '锁定尚未到期时正确统一邀请码注册',
      400,
      '工号或邀请码无效',
    )
    const lockedAfterCorrectCode = await AppDataSource.getRepository(ClientStaffDirectory).findOneByOrFail({ staffNo: 'I1003' })
    assert.equal(lockedAfterCorrectCode.inviteLockedUntil?.toISOString(), lockedUntilBeforeCorrectCode, '锁定期间正确码不得续期锁定')
    lockedDirectory.inviteLockedUntil = new Date(Date.now() - 1)
    await AppDataSource.getRepository(ClientStaffDirectory).save(lockedDirectory)
    await clientAuthService.register({ accountType: 'personal', staffNo: 'I1003', inviteCode: '00001234', password: 'Teacher_Invite_Cc3!' })
    pass('每工号连续五次失败锁定 30 分钟，锁定期间正确码不续期，到期后可用统一邀请码注册')

    await expectOk<InviteConfigView>(
      await fetch(`${baseUrl}/api/system-configs/client-staff-invite-code`, {
        method: 'PUT', headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ inviteCode: '87654321' }),
      }),
      '轮换教师统一邀请码',
    )
    await expectBizError(
      () => clientAuthService.register({ accountType: 'personal', staffNo: 'I1004', inviteCode: '00001234', password: 'Teacher_Invite_Dd4!' }),
      '轮换后旧统一邀请码注册',
      400,
      '工号或邀请码无效',
    )
    await clientAuthService.register({ accountType: 'personal', staffNo: 'I1004', inviteCode: '87654321', password: 'Teacher_Invite_Dd4!' })
    pass('轮换后旧统一邀请码立即失效，新邀请码可继续注册')

    await expectOk<InviteConfigView>(
      await fetch(`${baseUrl}/api/system-configs/client-staff-invite-code`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${admin.token}` },
      }),
      '禁用教师统一邀请码',
    )
    const disabledConfig = await AppDataSource.getRepository(SystemConfig).findOneByOrFail({ configKey: 'client.staff_invite_code' })
    assert.equal(JSON.parse(disabledConfig.configValue).enabled, false)
    assert.equal(JSON.parse(disabledConfig.configValue).digest.length, 64, '禁用统一邀请码必须保留摘要')
    await expectBizError(
      () => clientAuthService.register({ accountType: 'personal', staffNo: 'I1005', inviteCode: '87654321', password: 'Teacher_Invite_Ee5!' }),
      '禁用统一邀请码时教师注册',
      503,
      '教师统一邀请码已禁用',
    )
    const disabledDirectory = await AppDataSource.getRepository(ClientStaffDirectory).findOneByOrFail({ staffNo: 'I1005' })
    assert.equal(disabledDirectory.inviteFailedAttempts, 0, '禁用统一邀请码不得消耗工号失败计数')
    pass('禁用统一邀请码保留摘要并拒绝注册，且不消耗工号失败计数')

    const concurrentRotationRequests = [
      fetch(`${baseUrl}/api/system-configs/client-staff-invite-code`, { method: 'PUT', headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ inviteCode: '11111111' }) }),
      fetch(`${baseUrl}/api/system-configs/client-staff-invite-code`, { method: 'PUT', headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ inviteCode: '22222222' }) }),
    ]
    await Promise.all(concurrentRotationRequests.map(async (request) => {
      await expectOk<InviteConfigView>(await request, '并发轮换教师统一邀请码')
    }))
    await expectOk<InviteConfigView>(
      await fetch(`${baseUrl}/api/system-configs/client-staff-invite-code`, { method: 'PUT', headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ inviteCode: '33333333' }) }),
      '并发轮换后设置确定邀请码',
    )
    const concurrentRegisterResults = await Promise.allSettled([
      clientAuthService.register({ accountType: 'personal', staffNo: 'I1006', inviteCode: '33333333', password: 'Teacher_Invite_Ff6!' }),
      clientAuthService.register({ accountType: 'personal', staffNo: 'I1006', inviteCode: '33333333', password: 'Teacher_Invite_Gg7!' }),
    ])
    assert.equal(concurrentRegisterResults.filter((result) => result.status === 'fulfilled').length, 1, '并发同工号注册只能成功一次')
    const rejectedConcurrentRegistration = concurrentRegisterResults.find((result) => result.status === 'rejected')
    assert.ok(rejectedConcurrentRegistration && rejectedConcurrentRegistration.status === 'rejected', '并发同工号注册必须有一个业务拒绝结果')
    assert.ok(rejectedConcurrentRegistration.reason instanceof Error, '并发同工号注册拒绝应为业务 Error')
    assert.ok(
      [400, 409].includes((rejectedConcurrentRegistration.reason as Error & { statusCode?: number }).statusCode ?? 0),
      `并发同工号注册拒绝应为 400/409，实际: ${rejectedConcurrentRegistration.reason.message}`,
    )
    assert.equal(await AppDataSource.getRepository(ClientUser).countBy({ staffNo: 'I1006' }), 1, '并发同工号注册不得创建重复用户')
    pass('SQLite 队列下并发轮换可完成，并发同工号注册仍由唯一约束保证仅创建一个用户')

    const staleUpdatedAt = new Date(Date.now() - 48 * 60 * 60 * 1000)
    await AppDataSource.query(
      'UPDATE system_configs SET updated_at = ? WHERE config_key = ?',
      [staleUpdatedAt.toISOString(), 'client.staff_invite_code'],
    )
    const staleConfig = await AppDataSource.getRepository(SystemConfig).findOneByOrFail({ configKey: 'client.staff_invite_code' })
    assert.ok(staleConfig.updatedAt <= staleUpdatedAt, '测试前提：统一邀请码配置更新时间应回拨至少 48 小时')
    await clientAuthService.register({ accountType: 'personal', staffNo: 'I1009', inviteCode: '33333333', password: 'Teacher_Invite_Ii9!' })
    pass('统一邀请码配置更新时间超过 48 小时仍可注册，不引入个人码的 24 小时到期语义')

    const historicalPersonalInviteCode = '44444444'
    const historicalDigest = createHmac('sha256', process.env.INVITE_CODE_PEPPER ?? '')
      .update(`I1010\0${historicalPersonalInviteCode}`)
      .digest('hex')
    const historicalDirectory = await AppDataSource.getRepository(ClientStaffDirectory).findOneByOrFail({ staffNo: 'I1010' })
    historicalDirectory.inviteCodeDigest = historicalDigest
    historicalDirectory.inviteIssuedAt = new Date()
    historicalDirectory.inviteExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
    historicalDirectory.inviteUsedAt = null
    await AppDataSource.getRepository(ClientStaffDirectory).save(historicalDirectory)
    await expectBizError(
      () => clientAuthService.register({ accountType: 'personal', staffNo: 'I1010', inviteCode: historicalPersonalInviteCode, password: 'Teacher_Invite_Jj0!' }),
      '真实历史个人邀请码不得替代统一邀请码',
      400,
      '工号或邀请码无效',
    )
    await clientAuthService.register({ accountType: 'personal', staffNo: 'I1010', inviteCode: '33333333', password: 'Teacher_Invite_Jj0!' })
    pass('真实历史工号绑定 HMAC 个人邀请码不会被统一邀请码注册链路接受')

    const rotationGate = await pauseRegisterAfterIdentifierPrecheck(clientAuthService, {
      accountType: 'personal', staffNo: 'I1007', inviteCode: '33333333', password: 'Teacher_Invite_Gg7!',
    })
    try {
      await clientStaffInviteCodeService.setInviteCode('55555555', adminAuth)
    } finally {
      rotationGate.release()
    }
    await expectBizError(
      () => rotationGate.registration,
      '预校验后轮换统一邀请码的注册',
      400,
      '工号或邀请码无效',
    )
    assert.equal(await AppDataSource.getRepository(ClientUser).countBy({ staffNo: 'I1007' }), 0, '轮换统一邀请码后被暂停的注册不得落库')

    const disableGate = await pauseRegisterAfterIdentifierPrecheck(clientAuthService, {
      accountType: 'personal', staffNo: 'I1008', inviteCode: '55555555', password: 'Teacher_Invite_Hh8!',
    })
    try {
      await clientStaffInviteCodeService.disableInviteCode(adminAuth)
    } finally {
      disableGate.release()
    }
    await expectBizError(
      () => disableGate.registration,
      '预校验后禁用统一邀请码的注册',
      503,
      '教师统一邀请码已禁用',
    )
    assert.equal(await AppDataSource.getRepository(ClientUser).countBy({ staffNo: 'I1008' }), 0, '禁用统一邀请码后被暂停的注册不得落库')
    pass('注册预校验完成后轮换或禁用统一邀请码，最终创建事务仍会二次校验并拒绝落库')

    const auditText = (await AppDataSource.getRepository(SysAuditLog).find()).map((item) => `${item.actionType}\n${item.targetCode}\n${item.detailJson ?? ''}`).join('\n')
    for (const code of ['00001234', '87654321', '11111111', '22222222', '33333333']) {
      assert.doesNotMatch(auditText, new RegExp(code), `审计日志不得回显统一邀请码 ${code}`)
    }
    assert.doesNotMatch(auditText, new RegExp(historicalDigest), '审计日志不得回显历史个人邀请码摘要')
    assert.doesNotMatch(auditText, new RegExp(JSON.parse(staleConfig.configValue).digest), '审计日志不得回显统一邀请码摘要')
    pass('统一邀请码配置和审计记录均未回显明文邀请码或摘要')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
    cleanupSqliteFile()
  }
}

try {
  await main()
} catch (error) {
  console.error(error)
  cleanupSqliteFile()
  process.exitCode = 1
}
