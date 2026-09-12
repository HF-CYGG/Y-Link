/**
 * Issue #74 账号生命周期专项验证。
 *
 * 使用本轮唯一临时 SQLite 库验证两域服务事务、并发幂等、会话撤销、业务阻断、
 * RESTRICT 外键与 append-only 事件；同时静态锁定路由权限、频控和双库迁移契约。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { request as httpRequest, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AuthUserContext } from '../src/types/auth.js'

const backendRoot = path.resolve(process.cwd())
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ylink-account-lifecycle-'))
const sqlitePath = path.join(tempRoot, 'account-lifecycle.sqlite')
const permanentDeletePassword = 'Issue74-Only-Test-Password!'

const requestJson = (
  port: number,
  pathname: string,
  method: string,
  bearerToken: string,
  body?: Record<string, unknown>,
) => new Promise<{ status: number; payload: Record<string, unknown> }>((resolve, reject) => {
  const serialized = body ? JSON.stringify(body) : ''
  const request = httpRequest({
    host: '127.0.0.1',
    port,
    path: pathname,
    method,
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      ...(serialized ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(serialized) } : {}),
    },
  }, (response) => {
    const chunks: Buffer[] = []
    response.on('data', (chunk: Buffer) => chunks.push(chunk))
    response.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      try {
        resolve({ status: response.statusCode ?? 0, payload: text ? JSON.parse(text) as Record<string, unknown> : {} })
      } catch (error) {
        reject(new Error(`生命周期 HTTP 回归返回非法 JSON：${error instanceof Error ? error.message : String(error)}`))
      }
    })
  })
  request.once('error', reject)
  if (serialized) request.write(serialized)
  request.end()
})

delete process.env.ENV_FILE
process.env.NODE_ENV = 'test'
process.env.APP_PROFILE = 'account-lifecycle-verify'
process.env.DB_TYPE = 'sqlite'
process.env.SQLITE_DB_PATH = sqlitePath
process.env.DB_SYNC = 'true'
process.env.Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE = 'true'
process.env.PERMANENT_DELETE_PASSWORD = permanentDeletePassword

const readSource = (relativePath: string) => fs.readFileSync(path.join(backendRoot, relativePath), 'utf8')
const userRoutesSource = readSource('src/routes/user.routes.ts')
const clientRoutesSource = readSource('src/routes/client-user-manage.routes.ts')
const passwordSource = readSource('src/utils/permanent-delete-password.ts')
const mysqlMigrationSource = readSource('sql/044_account_lifecycle_governance.sql')

for (const [source, domain] of [[userRoutesSource, 'SysUser'], [clientRoutesSource, 'ClientUser']] as const) {
  assert.match(source, /\/:id\/deactivation-preview/, `${domain} 路由缺少注销预检`)
  assert.match(source, /\/:id\/deactivate/, `${domain} 路由缺少注销接口`)
  assert.match(source, /\/:id\/restore/, `${domain} 路由缺少恢复接口`)
  assert.match(source, /\/:id\/permanent/, `${domain} 路由缺少永久删除接口`)
  assert.match(source, /requirePermission\('users:deactivate'\)/, `${domain} 注销权限未隔离`)
  assert.match(source, /requirePermission\('users:permanent_delete'\)/, `${domain} 永久删除权限未隔离`)
  assert.match(source, /requireRole\('admin'\)/, `${domain} 生命周期接口必须 admin-only`)
  assert.match(source, /rateLimit\(/, `${domain} 永久删除缺少频控`)
}
assert.match(passwordSource, /timingSafeEqual\(expected, actual\)/, '永久删除密码必须恒定时间比较')
assert.equal((passwordSource.match(/createHash\('sha256'\)/g) ?? []).length, 2, '比较双方必须先归一为固定长度摘要')
assert.match(mysqlMigrationSource, /trg_account_lifecycle_event_no_update/, 'MySQL 缺少事件 UPDATE 阻断触发器')
assert.match(mysqlMigrationSource, /trg_account_lifecycle_event_no_delete/, 'MySQL 缺少事件 DELETE 阻断触发器')
assert.doesNotMatch(mysqlMigrationSource, /ON DELETE CASCADE[^\n]*(sys_user|client_user)/i, '账号关联外键不得继续 CASCADE')

let dataSource: Awaited<typeof import('../src/config/data-source.js')>['AppDataSource'] | undefined
let restoreDisconnect: (() => void) | undefined
let httpServer: Server | undefined

try {
  const [
    dataSourceModule,
    bootstrapModule,
    authServiceModule,
    clientAuthServiceModule,
    mobileSessionServiceModule,
    mobileTokenModule,
    sessionTokenModule,
    userServiceModule,
    clientServiceModule,
    realtimeModule,
    sysUserModule,
    sysSessionModule,
    clientUserModule,
    clientSessionModule,
    mobileSessionModule,
    inboundModule,
    preorderModule,
    returnRequestModule,
    feedbackModule,
    notificationInboxModule,
    lifecycleEventModule,
    auditModule,
  ] = await Promise.all([
    import('../src/config/data-source.js'),
    import('../src/config/database-bootstrap.js'),
    import('../src/services/auth.service.js'),
    import('../src/services/client-auth.service.js'),
    import('../src/services/mobile-session.service.js'),
    import('../src/utils/mobile-token.js'),
    import('../src/utils/session-token.js'),
    import('../src/services/user.service.js'),
    import('../src/services/client-user-manage.service.js'),
    import('../src/services/customer-service-realtime.service.js'),
    import('../src/entities/sys-user.entity.js'),
    import('../src/entities/sys-user-session.entity.js'),
    import('../src/entities/client-user.entity.js'),
    import('../src/entities/client-user-session.entity.js'),
    import('../src/entities/client-mobile-session.entity.js'),
    import('../src/entities/biz-inbound-order.entity.js'),
    import('../src/entities/o2o-preorder.entity.js'),
    import('../src/entities/o2o-return-request.entity.js'),
    import('../src/entities/client-feedback-conversation.entity.js'),
    import('../src/entities/notification-inbox.entity.js'),
    import('../src/entities/account-lifecycle-event.entity.js'),
    import('../src/entities/sys-audit-log.entity.js'),
  ])

  dataSource = dataSourceModule.AppDataSource
  assert.equal(path.resolve(String(dataSource.options.database)), path.resolve(sqlitePath), '专项验证必须使用本轮隔离 SQLite')
  await dataSource.initialize()
  await bootstrapModule.initializeDatabaseSchemaIfNeeded(dataSource)

  const sysRepo = dataSource.getRepository(sysUserModule.SysUser)
  const sysSessionRepo = dataSource.getRepository(sysSessionModule.SysUserSession)
  const clientRepo = dataSource.getRepository(clientUserModule.ClientUser)
  const clientSessionRepo = dataSource.getRepository(clientSessionModule.ClientUserSession)
  const mobileSessionRepo = dataSource.getRepository(mobileSessionModule.ClientMobileSession)
  const inboundRepo = dataSource.getRepository(inboundModule.BizInboundOrder)
  const preorderRepo = dataSource.getRepository(preorderModule.O2oPreorder)
  const returnRequestRepo = dataSource.getRepository(returnRequestModule.O2oReturnRequest)
  const feedbackRepo = dataSource.getRepository(feedbackModule.ClientFeedbackConversation)
  const notificationInboxRepo = dataSource.getRepository(notificationInboxModule.NotificationInbox)
  const eventRepo = dataSource.getRepository(lifecycleEventModule.AccountLifecycleEvent)
  const auditRepo = dataSource.getRepository(auditModule.SysAuditLog)

  const userService = userServiceModule.userService
  const clientService = clientServiceModule.clientUserManageService
  const authService = authServiceModule.authService
  const clientAuthService = clientAuthServiceModule.clientAuthService
  const mobileSessionService = mobileSessionServiceModule.mobileSessionService

  assert.equal(typeof userService.previewDeactivation, 'function', 'SysUser 注销预检尚未实现')
  assert.equal(typeof clientService.previewDeactivation, 'function', 'ClientUser 注销预检尚未实现')

  const createSysUser = async (username: string, overrides: Record<string, unknown> = {}) => sysRepo.save(sysRepo.create({
    username,
    passwordHash: 'test-only-password-hash',
    displayName: username,
    email: null,
    role: 'operator',
    status: 'enabled',
    ...overrides,
  } as never))
  const createClientUser = async (name: string, overrides: Record<string, unknown> = {}) => clientRepo.save(clientRepo.create({
    realName: name,
    mobile: null,
    email: `${name}@example.test`,
    passwordHash: 'test-only-password-hash',
    departmentName: '测试部门',
    departmentNodeId: null,
    accountType: 'personal',
    staffNo: null,
    staffVerified: false,
    status: 'enabled',
    ...overrides,
  } as never))
  const addSysSession = async (userId: string, token: string) => sysSessionRepo.save(sysSessionRepo.create({
    userId,
    sessionToken: sessionTokenModule.hashSessionToken(token),
    expiresAt: new Date(Date.now() + 60_000),
    lastAccessAt: new Date(),
  }))
  const addClientSessions = async (userId: string, suffix: string) => {
    const webToken = `client-web-${suffix}`
    const accessToken = mobileTokenModule.generateMobileAccessToken()
    const refreshToken = mobileTokenModule.generateMobileRefreshToken()
    const deviceId = 'abcdef0123456789abcdef0123456789'
    await clientSessionRepo.save(clientSessionRepo.create({
      userId,
      sessionToken: sessionTokenModule.hashSessionToken(webToken),
      expiresAt: new Date(Date.now() + 60_000),
      lastAccessAt: new Date(),
    }))
    await mobileSessionRepo.save(mobileSessionRepo.create({
      clientUserId: userId,
      deviceId: `device-${suffix}`,
      deviceName: '专项测试设备',
      platform: 'android',
      appVersion: '1.0.0-test',
      accessTokenHash: mobileTokenModule.hashMobileToken(accessToken),
      accessExpiresAt: new Date(Date.now() + 60_000),
      refreshTokenHash: mobileTokenModule.hashMobileToken(refreshToken),
      refreshExpiresAt: new Date(Date.now() + 120_000),
      previousRefreshTokenHash: null,
      previousRefreshGraceUntil: null,
      refreshGeneration: 0,
      absoluteExpiresAt: new Date(Date.now() + 180_000),
      lastIp: null,
      lastAccessAt: new Date(),
      revokedAt: null,
      revokeReason: null,
    }))
    return { webToken, accessToken, refreshToken, deviceId }
  }

  const actorEntity = await createSysUser('issue74-admin', { role: 'admin' })
  const actor: AuthUserContext = {
    userId: actorEntity.id,
    username: actorEntity.username,
    displayName: actorEntity.displayName,
    role: 'admin',
    permissions: ['users:view', 'users:deactivate', 'users:permanent_delete'],
    status: 'enabled',
    sessionToken: 'issue74-test-actor-session',
  }

  const disconnectCalls: Array<{ ownerType: string; ownerId: string }> = []
  const realtime = realtimeModule.customerServiceRealtimeService as unknown as {
    disconnectByOwner: (ownerType: 'client' | 'service', ownerId: string) => void
  }
  const originalDisconnect = realtime.disconnectByOwner.bind(realtime)
  realtime.disconnectByOwner = (ownerType, ownerId) => { disconnectCalls.push({ ownerType, ownerId }) }
  restoreDisconnect = () => { realtime.disconnectByOwner = originalDisconnect }

  const currentPreview = await userService.previewDeactivation(actor.userId, actor)
  assert.ok(currentPreview.blockers.some((item) => item.code === 'current_account'), '当前登录账号必须阻断注销')
  assert.ok(currentPreview.blockers.some((item) => item.code === 'last_enabled_admin'), '唯一启用管理员必须阻断注销')
  await createSysUser('issue74-admin-backup', { role: 'admin' })

  const sysUser = await createSysUser('issue74-sys-clean')
  const sysWebToken = 'issue74-sys-web-session'
  await addSysSession(sysUser.id, sysWebToken)
  assert.equal((await authService.resolveAuthUserByToken(sysWebToken)).userId, sysUser.id, '注销前 SysUser Web/Bearer 会话必须真实可用')
  const deactivatedSys = await userService.deactivate(sysUser.id, { reason: '人员离岗' }, actor)
  assert.equal(deactivatedSys.status, 'disabled', 'SysUser 注销必须强制 disabled')
  assert.equal(deactivatedSys.accountState, 'deactivated', 'SysUser 必须返回服务端计算的 accountState')
  assert.equal(await sysSessionRepo.count({ where: { userId: sysUser.id } }), 0, 'SysUser Web 会话必须撤销')
  await assert.rejects(authService.resolveAuthUserByToken(sysWebToken), /登录状态已失效/, '注销后 SysUser Web/Bearer token 必须立即失效')
  await userService.deactivate(sysUser.id, { reason: '并发重试' }, actor)
  assert.equal(await eventRepo.count({ where: { accountDomain: 'sys_user', accountIdSnapshot: sysUser.id, eventType: 'deactivated' } }), 1, 'SysUser 重复注销不得重复写事件')
  assert.equal(disconnectCalls.filter((item) => item.ownerType === 'service' && item.ownerId === sysUser.id).length, 1, 'SysUser SSE 只能在首次注销后断开')
  const restoredSys = await userService.restore(sysUser.id, { reason: '确认恢复' }, actor)
  assert.equal(restoredSys.status, 'disabled', 'SysUser 恢复后必须保持 disabled')
  assert.equal(restoredSys.accountState, 'disabled', 'SysUser 恢复后 accountState 必须为 disabled')
  await userService.restore(sysUser.id, { reason: '恢复重试' }, actor)
  assert.equal(await eventRepo.count({ where: { accountDomain: 'sys_user', accountIdSnapshot: sysUser.id, eventType: 'restored' } }), 1, 'SysUser 重复恢复不得重复写事件')

  const supplier = await createSysUser('issue74-supplier-history', { role: 'supplier' })
  const inbound = await inboundRepo.save(inboundRepo.create({
    showNo: 'IN-ISSUE74-001',
    verifyCode: 'IN-ISSUE74-VERIFY-001',
    supplierId: supplier.id,
    supplierName: supplier.displayName,
    status: 'pending',
    totalQty: '0.00',
    remark: null,
    isDeleted: false,
  }))
  const supplierPreview = await userService.previewDeactivation(supplier.id, actor)
  assert.ok(supplierPreview.blockers.some((item) => item.code === 'supplier_responsibility'), '待入库供应职责必须阻断注销')
  inbound.status = 'cancelled'
  await inboundRepo.save(inbound)
  await userService.deactivate(supplier.id, { reason: '供应职责已人工结束' }, actor)
  await assert.rejects(
    userService.permanentDelete(supplier.id, { reason: '尝试删除历史供应方', confirmAccount: supplier.username, permanentDeletePassword }, actor),
    /关键业务关联/,
    '历史供应单必须阻断永久删除',
  )

  const notificationHistoryUser = await createSysUser('issue74-notification-history')
  await notificationInboxRepo.save(notificationInboxRepo.create({
    eventId: '74001',
    userId: notificationHistoryUser.id,
    eventType: 'issue74.lifecycle',
    title: '生命周期专项通知',
    content: '仅验证通知历史保留',
    payloadJson: '{}',
    isRead: 1,
    readAt: new Date(),
  }))
  await userService.deactivate(notificationHistoryUser.id, { reason: '通知历史保留验证' }, actor)
  await assert.rejects(
    userService.permanentDelete(notificationHistoryUser.id, {
      reason: '尝试删除通知历史账号',
      confirmAccount: notificationHistoryUser.username,
      permanentDeletePassword,
    }, actor),
    /关键业务关联/,
    '通知收件箱历史必须阻断永久删除',
  )
  assert.equal(await notificationInboxRepo.count({ where: { userId: notificationHistoryUser.id } }), 1, '永久删除失败后必须保留通知历史')

  const sysPermanent = await createSysUser('issue74-sys-permanent')
  await userService.deactivate(sysPermanent.id, { reason: '准备永久删除' }, actor)
  await assert.rejects(
    userService.permanentDelete(sysPermanent.id, { reason: '逐字账号确认验证', confirmAccount: ` ${sysPermanent.username} `, permanentDeletePassword }, actor),
    /确认账号与目标账号不一致/,
    'SysUser 永久删除账号确认必须逐字匹配',
  )
  await assert.rejects(
    userService.permanentDelete(sysPermanent.id, { reason: '密码错误验证', confirmAccount: sysPermanent.username, permanentDeletePassword: 'wrong-password' }, actor),
    /永久删除密码不正确/,
  )
  const deletedSys = await userService.permanentDelete(sysPermanent.id, {
    reason: '测试永久删除', confirmAccount: sysPermanent.username, permanentDeletePassword,
  }, actor)
  assert.equal(deletedSys.deleted, true)
  assert.equal(await sysRepo.count({ where: { id: sysPermanent.id } }), 0, 'SysUser 应被物理删除')
  assert.equal(await eventRepo.count({ where: { accountDomain: 'sys_user', accountIdSnapshot: sysPermanent.id } }), 2, 'SysUser 永久删除后必须保留脱敏生命周期事件')
  const failedDeleteAudit = await auditRepo.findOne({ where: { actionType: 'user.permanent_delete', targetId: sysPermanent.id, resultStatus: 'failed' }, order: { id: 'DESC' } })
  assert.ok(failedDeleteAudit, '错误永久删除必须写失败审计')
  assert.doesNotMatch(failedDeleteAudit.detailJson ?? '', /wrong-password|Issue74-Only-Test-Password/, '失败审计不得记录密码')

  const teacher = await createClientUser('issue74-teacher', { staffNo: 'T-74001', staffVerified: false })
  const teacherList = await clientService.list({ page: 1, pageSize: 20, profileKind: 'teacher' })
  assert.ok(teacherList.list.some((item) => item.id === teacher.id && item.profileKind === 'teacher'), '教师类型必须以 staffNo 为真值')
  const teacherPreview = await clientService.previewDeactivation(teacher.id)
  assert.equal(teacherPreview.account, 'T-74001', '教师生命周期确认账号必须以 staffNo 为真值')
  await clientService.deactivate(teacher.id, { reason: '教师身份保留验证' }, actor)
  assert.equal((await clientRepo.findOneByOrFail({ id: teacher.id })).staffNo, 'T-74001', '教师注销期间必须保留 staffNo 唯一身份')
  await assert.rejects(
    createClientUser('issue74-teacher-duplicate', { staffNo: 'T-74001' }),
    /UNIQUE constraint failed|unique constraint/i,
    '教师注销期间不得释放 staffNo 唯一身份',
  )

  const clientUser = await createClientUser('issue74-client-clean')
  const clientTokens = await addClientSessions(clientUser.id, 'client-clean')
  assert.equal((await clientAuthService.resolveClientByToken(clientTokens.webToken)).userId, clientUser.id, '注销前 Client Web 会话必须真实可用')
  assert.equal((await mobileSessionService.resolveAccess(clientTokens.accessToken)).userId, clientUser.id, '注销前 Mobile access token 必须真实可用')
  const deactivatedClient = await clientService.deactivate(clientUser.id, { reason: '客户端账号注销' }, actor)
  assert.equal(deactivatedClient.status, 'disabled')
  assert.equal(deactivatedClient.accountState, 'deactivated')
  assert.equal(await clientSessionRepo.count({ where: { userId: clientUser.id } }), 0, 'Client Web 会话必须删除')
  await assert.rejects(clientAuthService.resolveClientByToken(clientTokens.webToken), /未登录或登录状态已失效/, '注销后 Client Web token 必须立即失效')
  const revokedMobile = await mobileSessionRepo.findOneByOrFail({ clientUserId: clientUser.id })
  assert.ok(revokedMobile.revokedAt, 'Mobile access/refresh 会话必须撤销')
  assert.equal(revokedMobile.revokeReason, 'account_disabled')
  await assert.rejects(mobileSessionService.resolveAccess(clientTokens.accessToken), /当前账号已停用|无效或已撤销/, '注销后 Mobile access token 必须立即失效')
  await assert.rejects(
    mobileSessionService.refresh(clientTokens.refreshToken, { deviceId: clientTokens.deviceId, appVersion: '1.0.0-test' }),
    /当前账号已停用|刷新凭证无效/,
    '注销后 Mobile refresh token 必须立即失效',
  )
  await clientService.deactivate(clientUser.id, { reason: '客户端注销重试' }, actor)
  assert.equal(await eventRepo.count({ where: { accountDomain: 'client_user', accountIdSnapshot: clientUser.id, eventType: 'deactivated' } }), 1, 'ClientUser 重复注销不得重复写事件')
  const restoredClient = await clientService.restore(clientUser.id, { reason: '客户端恢复' }, actor)
  assert.equal(restoredClient.status, 'disabled')
  assert.equal(restoredClient.accountState, 'disabled')

  const clientHistory = await createClientUser('issue74-client-history')
  const preorder = await preorderRepo.save(preorderRepo.create({
    showNo: 'O2O-ISSUE74-001',
    clientUserId: clientHistory.id,
    verifyCode: 'O2O-ISSUE74-VERIFY-001',
    status: 'pending',
  }))
  const feedback = await feedbackRepo.save(feedbackRepo.create({
    conversationNo: 'FB-ISSUE74-001',
    clientUserId: clientHistory.id,
    clientUsername: clientHistory.realName,
    clientAccount: clientHistory.email ?? clientHistory.realName,
    subject: '生命周期专项测试',
    status: 'open',
    lastMessageAt: new Date(),
  }))
  const returnRequest = await returnRequestRepo.save(returnRequestRepo.create({
    returnNo: 'RT-ISSUE74-001',
    orderId: preorder.id,
    clientUserId: clientHistory.id,
    verifyCode: 'RT-ISSUE74-VERIFY-001',
    status: 'pending',
    sourceOrderStatus: 'pending',
    reason: '生命周期专项退货',
    totalQty: 1,
    handledAt: null,
    handledBy: null,
    rejectedReason: null,
    verifiedAt: null,
    verifiedBy: null,
  }))
  const clientBlockedPreview = await clientService.previewDeactivation(clientHistory.id)
  assert.ok(clientBlockedPreview.blockers.some((item) => item.code === 'pending_preorder'))
  assert.ok(clientBlockedPreview.blockers.some((item) => item.code === 'pending_return'))
  assert.ok(clientBlockedPreview.blockers.some((item) => item.code === 'open_feedback'))
  preorder.status = 'cancelled'
  returnRequest.status = 'rejected'
  returnRequest.handledAt = new Date()
  returnRequest.handledBy = actor.username
  returnRequest.rejectedReason = '专项测试终态'
  feedback.status = 'closed'
  feedback.closedAt = new Date()
  await preorderRepo.save(preorder)
  await returnRequestRepo.save(returnRequest)
  await feedbackRepo.save(feedback)
  await clientService.deactivate(clientHistory.id, { reason: '业务已终态' }, actor)
  await assert.rejects(
    clientService.permanentDelete(clientHistory.id, { reason: '尝试删除历史客户', confirmAccount: clientHistory.realName, permanentDeletePassword }, actor),
    /关键业务关联/,
    '历史订单或客服会话必须阻断永久删除',
  )

  const clientPermanent = await createClientUser('issue74-client-permanent')
  await clientService.deactivate(clientPermanent.id, { reason: '准备永久删除' }, actor)
  await assert.rejects(
    clientService.permanentDelete(clientPermanent.id, {
      reason: '客户端逐字账号确认', confirmAccount: ` ${clientPermanent.realName} `, permanentDeletePassword,
    }, actor),
    /确认账号与目标账号不一致/,
    'ClientUser 永久删除账号确认必须逐字匹配',
  )
  await assert.rejects(
    clientService.permanentDelete(clientPermanent.id, {
      reason: '客户端错误密码验证', confirmAccount: clientPermanent.realName, permanentDeletePassword: 'wrong-client-password',
    }, actor),
    /永久删除密码不正确/,
  )
  const clientDeleted = await clientService.permanentDelete(clientPermanent.id, {
    reason: '测试永久删除', confirmAccount: clientPermanent.realName, permanentDeletePassword,
  }, actor)
  assert.equal(clientDeleted.deleted, true)
  assert.equal(await clientRepo.count({ where: { id: clientPermanent.id } }), 0)
  assert.equal(await eventRepo.count({ where: { accountDomain: 'client_user', accountIdSnapshot: clientPermanent.id } }), 2)
  const failedClientDeleteAudit = await auditRepo.findOne({ where: { actionType: 'client_user.permanent_delete', targetId: clientPermanent.id, resultStatus: 'failed' }, order: { id: 'DESC' } })
  assert.ok(failedClientDeleteAudit, '客户端错误永久删除必须写失败审计')
  assert.doesNotMatch(failedClientDeleteAudit.detailJson ?? '', /wrong-client-password|Issue74-Only-Test-Password/, '客户端失败审计不得记录密码')

  const concurrentDeactivate = await createClientUser('issue74-concurrent-deactivate')
  const concurrentDeactivateResults = await Promise.all([
    clientService.deactivate(concurrentDeactivate.id, { reason: '并发注销一' }, actor),
    clientService.deactivate(concurrentDeactivate.id, { reason: '并发注销二' }, actor),
  ])
  assert.ok(concurrentDeactivateResults.every((item) => item.accountState === 'deactivated'))
  assert.equal(await eventRepo.count({ where: { accountDomain: 'client_user', accountIdSnapshot: concurrentDeactivate.id, eventType: 'deactivated' } }), 1, '并发注销只能生成一个事件')

  const concurrentPermanent = await createSysUser('issue74-concurrent-permanent')
  await userService.deactivate(concurrentPermanent.id, { reason: '准备并发永久删除' }, actor)
  const concurrentDeleteResults = await Promise.allSettled([
    userService.permanentDelete(concurrentPermanent.id, { reason: '并发永久删除一', confirmAccount: concurrentPermanent.username, permanentDeletePassword }, actor),
    userService.permanentDelete(concurrentPermanent.id, { reason: '并发永久删除二', confirmAccount: concurrentPermanent.username, permanentDeletePassword }, actor),
  ])
  assert.equal(concurrentDeleteResults.filter((item) => item.status === 'fulfilled').length, 1, '并发永久删除只能成功一次')

  const rateLimitTarget = await createSysUser('issue74-rate-limit-target')
  await userService.deactivate(rateLimitTarget.id, { reason: '频控 HTTP 回归准备' }, actor)
  const httpBearer = 'issue74-admin-http-session'
  await addSysSession(actor.userId, httpBearer)
  const { createApp } = await import('../src/app.js')
  httpServer = createApp().listen(0, '127.0.0.1')
  if (!httpServer.listening) {
    await new Promise<void>((resolve, reject) => {
      httpServer!.once('listening', resolve)
      httpServer!.once('error', reject)
    })
  }
  const address = httpServer.address()
  assert.ok(address && typeof address === 'object', '生命周期 HTTP 回归无法获取监听地址')
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await requestJson(address.port, `/api/users/${rateLimitTarget.id}/permanent`, 'DELETE', httpBearer, {
      reason: '频控失败审计验证',
      confirmAccount: rateLimitTarget.username,
      permanentDeletePassword: 'wrong-http-password',
    })
    assert.equal(response.status, 403, `永久删除频控前第 ${attempt + 1} 次错误口令应由服务层拒绝`)
  }
  const limitedResponse = await requestJson(address.port, `/api/users/${rateLimitTarget.id}/permanent`, 'DELETE', httpBearer, {
    reason: '频控失败审计验证',
    confirmAccount: rateLimitTarget.username,
    permanentDeletePassword: 'wrong-http-password',
  })
  assert.equal(limitedResponse.status, 429, '永久删除第六次 HTTP 请求必须触发账号+目标维度频控')
  const rateLimitAudit = await auditRepo.findOne({
    where: { actionType: 'user.permanent_delete', targetId: rateLimitTarget.id, resultStatus: 'failed' },
    order: { id: 'DESC' },
  })
  assert.match(rateLimitAudit?.detailJson ?? '', /rate_limited/, '频控拒绝必须写脱敏失败审计')
  assert.doesNotMatch(rateLimitAudit?.detailJson ?? '', /wrong-http-password|Issue74-Only-Test-Password/, '频控审计不得记录密码')
  await new Promise<void>((resolve, reject) => httpServer!.close((error) => error ? reject(error) : resolve()))
  httpServer = undefined
  assert.equal(await eventRepo.count({ where: { accountDomain: 'sys_user', accountIdSnapshot: concurrentPermanent.id, eventType: 'permanently_deleted' } }), 1)

  const fkSysUser = await createSysUser('issue74-fk-sys')
  await addSysSession(fkSysUser.id, 'issue74-fk-sys-session')
  await assert.rejects(sysRepo.delete({ id: fkSysUser.id }), /FOREIGN KEY constraint failed/, 'SysUser FK 必须 RESTRICT')
  const fkClientUser = await createClientUser('issue74-fk-client')
  await clientSessionRepo.save(clientSessionRepo.create({
    userId: fkClientUser.id,
    sessionToken: 'issue74-fk-client-session',
    expiresAt: new Date(Date.now() + 60_000),
    lastAccessAt: new Date(),
  }))
  await assert.rejects(clientRepo.delete({ id: fkClientUser.id }), /FOREIGN KEY constraint failed/, 'ClientUser FK 必须 RESTRICT')

  const retainedEvent = await eventRepo.findOneByOrFail({ accountDomain: 'sys_user', accountIdSnapshot: sysPermanent.id, eventType: 'permanently_deleted' })
  await assert.rejects(
    dataSource.query('UPDATE account_lifecycle_event SET reason = ? WHERE id = ?', ['禁止改写', retainedEvent.id]),
    /ACCOUNT_LIFECYCLE_EVENT_APPEND_ONLY/,
    '生命周期事件禁止更新',
  )
  await assert.rejects(
    dataSource.query('DELETE FROM account_lifecycle_event WHERE id = ?', [retainedEvent.id]),
    /ACCOUNT_LIFECYCLE_EVENT_APPEND_ONLY/,
    '生命周期事件禁止删除',
  )

  assert.ok(disconnectCalls.some((item) => item.ownerType === 'client' && item.ownerId === clientUser.id), 'Client SSE 必须在注销后断开')
  console.log('account lifecycle verify: passed (dual-domain transactions, blockers, sessions, FK, append-only, concurrency)')
} finally {
  restoreDisconnect?.()
  if (httpServer) {
    await new Promise<void>((resolve) => httpServer!.close(() => resolve()))
  }
  if (dataSource?.isInitialized) await dataSource.destroy()
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
