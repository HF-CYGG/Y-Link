/**
 * Issue #74 账号生命周期专项验证。
 *
 * 使用本轮唯一临时 SQLite 库验证两域服务事务、并发幂等、会话撤销、业务阻断、
 * RESTRICT 外键与 append-only 事件；同时静态锁定路由权限、频控和双库迁移契约。
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { request as httpRequest, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AuthUserContext } from '../src/types/auth.js'

const backendRoot = path.resolve(process.cwd())
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ylink-account-lifecycle-'))
const sqlitePath = path.join(tempRoot, 'account-lifecycle.sqlite')
const permanentDeletePassword = 'Issue74-Only-Test-Password!'

class TestSseResponse extends EventEmitter {
  statusCode = 0
  writableEnded = false
  destroyed = false
  writableLength = 0
  readonly headers = new Map<string, string>()
  readonly writes: string[] = []

  status(code: number) {
    this.statusCode = code
    return this
  }

  setHeader(name: string, value: string) {
    this.headers.set(name.toLowerCase(), value)
    return this
  }

  flushHeaders() {}

  write(chunk: string) {
    this.writes.push(chunk)
    return true
  }

  end() {
    this.writableEnded = true
    return this
  }
}

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
const o2oPreorderServiceSource = readSource('src/services/o2o-preorder.service.ts')
const inboundServiceSource = readSource('src/services/inbound.service.ts')
const feedbackServiceSource = readSource('src/services/client-feedback.service.ts')
const notificationServiceSource = readSource('src/services/notification.service.ts')
const businessGuardSource = readSource('src/services/account-business-guard.service.ts')
const userServiceSource = readSource('src/services/user.service.ts')
const clientUserManageServiceSource = readSource('src/services/client-user-manage.service.ts')
const realtimeServiceSource = readSource('src/services/customer-service-realtime.service.ts')
const authServiceSource = readSource('src/services/auth.service.ts')
const clientAuthServiceSource = readSource('src/services/client-auth.service.ts')
const mobileSessionServiceSource = readSource('src/services/mobile-session.service.ts')

const sliceMethod = (source: string, start: string, next: string) => {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(next, startIndex + start.length)
  assert.ok(startIndex >= 0 && endIndex > startIndex, `无法定位专项契约片段：${start}`)
  return source.slice(startIndex, endIndex)
}

const o2oSubmitSource = sliceMethod(o2oPreorderServiceSource, '  async submit(', '  async listMyOrders(')
const o2oReturnSource = sliceMethod(o2oPreorderServiceSource, '  async createReturnRequest(', '  async listConsoleOrders(')
const inboundSubmitSource = sliceMethod(inboundServiceSource, '  async submitSupplierDelivery(', '  async updateSupplierDelivery(')
const feedbackCreateSource = sliceMethod(feedbackServiceSource, '  async createConversation(', '  async listMyConversations(')
const feedbackClientMessageSource = sliceMethod(feedbackServiceSource, '  async appendClientMessage(', '  async appendServiceMessage(')
const feedbackReplySource = sliceMethod(feedbackServiceSource, '  async appendServiceMessage(', '  async updateConversationStatus(')
const feedbackStatusSource = sliceMethod(feedbackServiceSource, '  async updateConversationStatus(', '  async updateConversationAssignee(')
const feedbackAssigneeSource = sliceMethod(feedbackServiceSource, '  async updateConversationAssignee(', '  async updateConversationIssueFields(')
const feedbackIssueSource = sliceMethod(feedbackServiceSource, '  async updateConversationIssueFields(', '  async updateConversationInternalRemark(')
const feedbackRemarkSource = sliceMethod(feedbackServiceSource, '  async updateConversationInternalRemark(', '  async getServicePresence(')
const notificationRulesSource = sliceMethod(notificationServiceSource, '  async updateRules(', '  async getPresenceSnapshot(')
const clientRealtimeSource = sliceMethod(feedbackServiceSource, '  async openClientRealtimeChannel(', '  async openServiceRealtimeChannel(')
const serviceRealtimeSource = sliceMethod(feedbackServiceSource, '  async openServiceRealtimeChannel(', '  async createConversation(')

for (const [source, guard, label] of [
  [o2oSubmitSource, 'lockActiveClientAccountForBusiness', 'O2O pending 预订单'],
  [o2oReturnSource, 'lockActiveClientAccountForBusiness', 'O2O pending 退货'],
  [inboundSubmitSource, 'lockActiveSysAccountForBusiness', '供应方 pending 送货单'],
  [feedbackCreateSource, 'lockActiveClientAccountForBusiness', '客户端 open 反馈'],
  [feedbackClientMessageSource, 'lockActiveClientAccountForBusiness', '客户端客服消息'],
  [feedbackReplySource, 'lockActiveSysAccountForBusiness', '客服消息历史'],
  [feedbackStatusSource, 'lockActiveSysAccountForBusiness', '客服状态更新'],
  [feedbackAssigneeSource, 'lockActiveSysAccountsForBusiness', '客服指派职责'],
  [feedbackIssueSource, 'lockActiveSysAccountForBusiness', '客服问题字段更新'],
  [feedbackRemarkSource, 'lockActiveSysAccountForBusiness', '客服内部备注职责'],
  [notificationRulesSource, 'lockActiveSysAccountsForBusiness', '通知规则职责'],
] as const) {
  assert.ok(source.indexOf(guard) >= 0, `${label}写入口缺少事务账号 guard`)
}
assert.ok(inboundSubmitSource.indexOf('lockActiveSysAccountForBusiness') < inboundSubmitSource.indexOf('loadActiveProductsByIds'), '供应送货单必须先锁账号再锁商品')
assert.ok(o2oReturnSource.indexOf('lockActiveClientAccountForBusiness') < o2oReturnSource.indexOf('getRepository(O2oPreorder)'), '退货申请必须先锁账号再锁订单')
assert.match(businessGuardSource, /orderBy\('account\.id', 'ASC'\)/, '多系统账号必须按 ID 升序锁定')
assert.match(businessGuardSource, /options\.type === 'mysql'\) query\.setLock\('pessimistic_write'\)/, 'MySQL 账号 guard 必须获取写锁')
assert.match(notificationRulesSource, /lockActiveSysAccountsForBusiness\(manager, \[actor\.userId, \.\.\.responsibilityUserIds\]\)/, '通知规则必须同时锁后复核操作者与职责账号')
for (const [serviceSource, helper, domain, permanentNext] of [
  [userServiceSource, 'lockLifecycleActorAndTarget', 'SysUser', '  async list('],
  [clientUserManageServiceSource, 'lockLifecycleActorAndClient', 'ClientUser', '  private async findUserByAnyIdentifier('],
] as const) {
  for (const [start, next, operation, permission] of [
    ['  async deactivate(', '  async restore(', '注销', 'users:deactivate'],
    ['  async restore(', '  async permanentDelete(', '恢复', 'users:deactivate'],
    ['  async permanentDelete(', permanentNext, '永久删除', 'users:permanent_delete'],
  ] as const) {
    const lifecycleSource = sliceMethod(serviceSource, start, next)
    assert.match(lifecycleSource, new RegExp(`${helper}\\(manager, id, actor, '${permission}'\\)`), `${domain} ${operation}必须在事务锁内复核 actor`)
  }
}
assert.match(businessGuardSource, /lockSysAccountsInStableOrder[\s\S]*orderBy\('account\.id', 'ASC'\)/, '生命周期 actor 与 Sys target 必须按稳定 ID 顺序锁定')
assert.match(realtimeServiceSource, /sessionGenerations/, 'SSE 注册屏障必须包含 session generation')
assert.match(realtimeServiceSource, /ticket\.sessionGeneration !== currentSessionGeneration/, 'SSE 同步注册必须比较 session generation')
assert.match(realtimeServiceSource, /disconnectBySessionHash[\s\S]*sessionGenerations\.set[\s\S]*closeSubscriber/, 'session 撤销必须先推进 generation 再关闭订阅')
assert.match(sliceMethod(authServiceSource, '  async logout(', '  async me('), /disconnectBySessionHash\('service'/, 'Sys Web logout 必须只推进当前 session 屏障')
assert.match(sliceMethod(clientAuthServiceSource, '  async logout(', '  async preparePasswordChange('), /disconnectBySessionHash\('client'/, 'Client Web logout 必须只推进当前 session 屏障')
for (const [start, next, label] of [
  ['  async revokeCurrent(', '  /** Logout 专用解析', 'Mobile 当前会话撤销'],
  ['  async revokeByAccessToken(', '  async revokeSessionsForUser(', 'Mobile access token 撤销'],
  ['  async revokeOwnedSession(', '  async cleanupExpiredBatch(', 'Mobile 指定会话撤销'],
] as const) {
  assert.match(sliceMethod(mobileSessionServiceSource, start, next), /disconnectBySessionHash\('client'/, `${label}必须推进 session 屏障`)
}
const mobileLogoutAllSource = sliceMethod(mobileSessionServiceSource, '  async logoutAll(', '  async listSessions(')
assert.match(mobileLogoutAllSource, /scope === 'all'\) customerServiceRealtimeService\.disconnectByOwner/, 'Mobile logoutAll(all) 必须推进 owner 屏障')
assert.match(mobileLogoutAllSource, /disconnectBySessionHash\('client'/, 'Mobile logoutAll(others) 必须仅推进被撤销 session 屏障')
assert.match(sliceMethod(mobileSessionServiceSource, '  async refresh(', '  async resolveAccess('), /disconnectBySessionHash\('client', rotated\.invalidatedAccessHash\)/, 'Mobile token 轮换必须推进旧 access session 屏障')
for (const [source, domain, openMarker] of [
  [clientRealtimeSource, 'ClientUser', 'openClientStream'],
  [serviceRealtimeSource, 'SysUser', 'openServiceStream'],
] as const) {
  assert.ok(source.indexOf('captureOwnerGeneration') < source.indexOf('getPortalConfigs'), `${domain} SSE 必须在首个异步操作前捕获 generation`)
  assert.ok(source.indexOf('assertOwnerCanRegister') < source.indexOf(openMarker), `${domain} SSE 必须在注册前执行最终数据库复核`)
}

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
    productServiceModule,
    o2oPreorderServiceModule,
    inboundServiceModule,
    notificationServiceModule,
    clientFeedbackServiceModule,
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
    import('../src/services/product.service.js'),
    import('../src/services/o2o-preorder.service.js'),
    import('../src/services/inbound.service.js'),
    import('../src/services/notification.service.js'),
    import('../src/services/client-feedback.service.js'),
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
  const productService = productServiceModule.productService
  const o2oPreorderService = o2oPreorderServiceModule.o2oPreorderService
  const inboundService = inboundServiceModule.inboundService
  const notificationService = notificationServiceModule.notificationService
  const clientFeedbackService = clientFeedbackServiceModule.clientFeedbackService

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

  const realtime = realtimeModule.customerServiceRealtimeService

  const currentPreview = await userService.previewDeactivation(actor.userId, actor)
  assert.ok(currentPreview.blockers.some((item) => item.code === 'current_account'), '当前登录账号必须阻断注销')
  assert.ok(currentPreview.blockers.some((item) => item.code === 'last_enabled_admin'), '唯一启用管理员必须阻断注销')
  await createSysUser('issue74-admin-backup', { role: 'admin' })

  const staleLifecycleActorEntity = await createSysUser('issue74-stale-lifecycle-admin', { role: 'admin' })
  const staleLifecycleActor: AuthUserContext = {
    userId: staleLifecycleActorEntity.id,
    username: staleLifecycleActorEntity.username,
    displayName: staleLifecycleActorEntity.displayName,
    role: 'admin',
    permissions: ['users:deactivate', 'users:permanent_delete'],
    status: 'enabled',
    sessionToken: 'issue74-stale-lifecycle-session',
  }
  const staleActorSysTarget = await createSysUser('issue74-stale-actor-sys-target')
  const staleActorClientTarget = await createClientUser('issue74-stale-actor-client-target')
  await userService.deactivate(staleLifecycleActorEntity.id, { reason: '撤销旧管理员治理资格' }, actor)
  await assert.rejects(
    userService.deactivate(staleActorSysTarget.id, { reason: '旧管理员请求必须拒绝' }, staleLifecycleActor),
    /管理员账号已失效或权限不足/,
    'SysUser 注销必须在锁后拒绝已被注销的旧管理员请求',
  )
  await assert.rejects(
    clientService.deactivate(staleActorClientTarget.id, { reason: '旧管理员请求必须拒绝' }, staleLifecycleActor),
    /管理员账号已失效或权限不足/,
    'ClientUser 注销必须在锁后拒绝已被注销的旧管理员请求',
  )
  assert.equal((await sysRepo.findOneByOrFail({ id: staleActorSysTarget.id })).status, 'enabled', '旧管理员不得改变 Sys target')
  assert.equal((await clientRepo.findOneByOrFail({ id: staleActorClientTarget.id })).status, 'enabled', '旧管理员不得改变 Client target')

  const staleActorSysRestore = await createSysUser('issue74-stale-actor-sys-restore')
  const staleActorClientRestore = await createClientUser('issue74-stale-actor-client-restore')
  await userService.deactivate(staleActorSysRestore.id, { reason: '准备验证旧管理员恢复拒绝' }, actor)
  await clientService.deactivate(staleActorClientRestore.id, { reason: '准备验证旧管理员恢复拒绝' }, actor)
  await assert.rejects(userService.restore(staleActorSysRestore.id, { reason: '旧管理员恢复必须拒绝' }, staleLifecycleActor), /管理员账号已失效或权限不足/)
  await assert.rejects(clientService.restore(staleActorClientRestore.id, { reason: '旧管理员恢复必须拒绝' }, staleLifecycleActor), /管理员账号已失效或权限不足/)

  const staleActorSysDelete = await createSysUser('issue74-stale-actor-sys-delete')
  const staleActorClientDelete = await createClientUser('issue74-stale-actor-client-delete')
  await userService.deactivate(staleActorSysDelete.id, { reason: '准备验证旧管理员永久删除拒绝' }, actor)
  await clientService.deactivate(staleActorClientDelete.id, { reason: '准备验证旧管理员永久删除拒绝' }, actor)
  await assert.rejects(userService.permanentDelete(staleActorSysDelete.id, {
    reason: '旧管理员永久删除必须拒绝',
    confirmAccount: staleActorSysDelete.username,
    permanentDeletePassword,
  }, staleLifecycleActor), /管理员账号已失效或权限不足/)
  await assert.rejects(clientService.permanentDelete(staleActorClientDelete.id, {
    reason: '旧管理员永久删除必须拒绝',
    confirmAccount: staleActorClientDelete.email ?? '',
    permanentDeletePassword,
  }, staleLifecycleActor), /管理员账号已失效或权限不足/)
  assert.equal(await sysRepo.count({ where: { id: staleActorSysDelete.id } }), 1, '旧管理员不得永久删除 Sys target')
  assert.equal(await clientRepo.count({ where: { id: staleActorClientDelete.id } }), 1, '旧管理员不得永久删除 Client target')

  const demotedLifecycleActor = await createSysUser('issue74-demoted-lifecycle-admin', { role: 'admin' })
  const staleAdminSnapshot: AuthUserContext = {
    userId: demotedLifecycleActor.id,
    username: demotedLifecycleActor.username,
    displayName: demotedLifecycleActor.displayName,
    role: 'admin',
    permissions: ['users:deactivate'],
    status: 'enabled',
    sessionToken: 'issue74-demoted-lifecycle-session',
  }
  await sysRepo.update(demotedLifecycleActor.id, { role: 'operator' })
  await assert.rejects(
    userService.deactivate(staleActorSysTarget.id, { reason: '旧管理员角色快照必须拒绝' }, staleAdminSnapshot),
    /管理员账号已失效或权限不足/,
    '生命周期治理必须以锁后数据库角色与权限为准',
  )

  const generationClient = await createClientUser('issue74-generation-client')
  const generationClientTokens = await addClientSessions(generationClient.id, 'generation-client')
  const staleClientTicket = realtime.captureOwnerGeneration('client', generationClient.id, generationClientTokens.webToken)
  await realtime.assertOwnerCanRegister(staleClientTicket, generationClientTokens.webToken)
  realtime.disconnectByOwner('client', generationClient.id)
  assert.throws(
    () => realtime.openClientStream(generationClient.id, generationClientTokens.webToken, new TestSseResponse() as never, 60, staleClientTicket),
    /授权状态已变化/,
    'ClientUser 无订阅断开也必须推进 generation 并拒绝旧请求注册',
  )
  const currentClientTicket = realtime.captureOwnerGeneration('client', generationClient.id, generationClientTokens.webToken)
  await realtime.assertOwnerCanRegister(currentClientTicket, generationClientTokens.webToken)
  const renewedClientResponse = new TestSseResponse()
  realtime.openClientStream(generationClient.id, generationClientTokens.webToken, renewedClientResponse as never, 60, currentClientTicket)
  realtime.disconnectByOwner('client', generationClient.id)
  assert.equal(renewedClientResponse.writableEnded, true, 'ClientUser 新 generation 注册后必须能被后续断开看见')

  const generationService = await createSysUser('issue74-generation-service')
  const generationServiceToken = 'issue74-generation-service-session'
  await addSysSession(generationService.id, generationServiceToken)
  const staleServiceTicket = realtime.captureOwnerGeneration('service', generationService.id, generationServiceToken)
  await realtime.assertOwnerCanRegister(staleServiceTicket, generationServiceToken)
  realtime.disconnectByOwner('service', generationService.id)
  assert.throws(
    () => realtime.openServiceStream(generationService.id, generationServiceToken, new TestSseResponse() as never, 60, staleServiceTicket),
    /授权状态已变化/,
    'SysUser 无订阅断开也必须推进 generation 并拒绝旧请求注册',
  )
  const currentServiceTicket = realtime.captureOwnerGeneration('service', generationService.id, generationServiceToken)
  await realtime.assertOwnerCanRegister(currentServiceTicket, generationServiceToken)
  const renewedServiceResponse = new TestSseResponse()
  realtime.openServiceStream(generationService.id, generationServiceToken, renewedServiceResponse as never, 60, currentServiceTicket)
  realtime.disconnectByOwner('service', generationService.id)
  assert.equal(renewedServiceResponse.writableEnded, true, 'SysUser 新 generation 注册后必须能被后续断开看见')

  const sessionBarrierService = await createSysUser('issue74-session-barrier-service')
  const serviceSessionA = 'issue74-service-session-a'
  const serviceSessionB = 'issue74-service-session-b'
  await addSysSession(sessionBarrierService.id, serviceSessionA)
  await addSysSession(sessionBarrierService.id, serviceSessionB)
  const staleServiceSessionTicket = realtime.captureOwnerGeneration('service', sessionBarrierService.id, serviceSessionA)
  await realtime.assertOwnerCanRegister(staleServiceSessionTicket, serviceSessionA)
  const serviceSessionBResponse = new TestSseResponse()
  const serviceSessionBTicket = realtime.captureOwnerGeneration('service', sessionBarrierService.id, serviceSessionB)
  await realtime.assertOwnerCanRegister(serviceSessionBTicket, serviceSessionB)
  realtime.openServiceStream(sessionBarrierService.id, serviceSessionB, serviceSessionBResponse as never, 60, serviceSessionBTicket)
  await authService.logout({
    userId: sessionBarrierService.id,
    username: sessionBarrierService.username,
    displayName: sessionBarrierService.displayName,
    role: sessionBarrierService.role,
    permissions: [],
    status: 'enabled',
    sessionToken: serviceSessionA,
  }, undefined)
  assert.throws(
    () => realtime.openServiceStream(sessionBarrierService.id, serviceSessionA, new TestSseResponse() as never, 60, staleServiceSessionTicket),
    /授权状态已变化/,
    'Web 单会话登出提交后必须拒绝已完成最终数据库复核的旧 ticket',
  )
  assert.equal(serviceSessionBResponse.writableEnded, false, 'Web 单会话登出不得关闭同账号其他有效 SSE')
  realtime.disconnectByOwner('service', sessionBarrierService.id)

  const sessionBarrierClient = await createClientUser('issue74-session-barrier-client')
  const clientSessionA = await addClientSessions(sessionBarrierClient.id, 'session-a')
  const clientSessionB = await addClientSessions(sessionBarrierClient.id, 'session-b')
  const staleClientSessionTicket = realtime.captureOwnerGeneration('client', sessionBarrierClient.id, clientSessionA.webToken)
  await realtime.assertOwnerCanRegister(staleClientSessionTicket, clientSessionA.webToken)
  const clientSessionBResponse = new TestSseResponse()
  const clientSessionBTicket = realtime.captureOwnerGeneration('client', sessionBarrierClient.id, clientSessionB.accessToken)
  await realtime.assertOwnerCanRegister(clientSessionBTicket, clientSessionB.accessToken)
  realtime.openClientStream(sessionBarrierClient.id, clientSessionB.accessToken, clientSessionBResponse as never, 60, clientSessionBTicket)
  const clientSessionAAuth = await clientAuthService.resolveClientByToken(clientSessionA.webToken)
  await clientAuthService.logout(clientSessionAAuth)
  assert.throws(
    () => realtime.openClientStream(sessionBarrierClient.id, clientSessionA.webToken, new TestSseResponse() as never, 60, staleClientSessionTicket),
    /授权状态已变化/,
    'Client Web 单会话登出提交后必须拒绝已完成最终数据库复核的旧 ticket',
  )
  assert.equal(clientSessionBResponse.writableEnded, false, 'Client Web 单会话登出不得关闭同账号其他有效 Mobile SSE')

  const staleMobileSessionTicket = realtime.captureOwnerGeneration('client', sessionBarrierClient.id, clientSessionA.accessToken)
  await realtime.assertOwnerCanRegister(staleMobileSessionTicket, clientSessionA.accessToken)
  await mobileSessionService.revokeByAccessToken(clientSessionA.accessToken)
  assert.throws(
    () => realtime.openClientStream(sessionBarrierClient.id, clientSessionA.accessToken, new TestSseResponse() as never, 60, staleMobileSessionTicket),
    /授权状态已变化/,
    'Mobile 单会话撤销提交后必须拒绝已完成最终数据库复核的旧 ticket',
  )
  assert.equal(clientSessionBResponse.writableEnded, false, 'Mobile 单会话撤销不得关闭同账号其他有效 SSE')

  const clientSessionC = await addClientSessions(sessionBarrierClient.id, 'session-c')
  const staleOtherSessionTicket = realtime.captureOwnerGeneration('client', sessionBarrierClient.id, clientSessionC.accessToken)
  await realtime.assertOwnerCanRegister(staleOtherSessionTicket, clientSessionC.accessToken)
  const clientSessionBAuth = await mobileSessionService.resolveAccess(clientSessionB.accessToken)
  await mobileSessionService.logoutAll(clientSessionBAuth, 'others')
  assert.throws(
    () => realtime.openClientStream(sessionBarrierClient.id, clientSessionC.accessToken, new TestSseResponse() as never, 60, staleOtherSessionTicket),
    /授权状态已变化/,
    'Mobile logoutAll(others) 必须使被撤销 sibling ticket 失效',
  )
  assert.equal(clientSessionBResponse.writableEnded, false, 'Mobile logoutAll(others) 不得关闭当前有效 session SSE')
  const staleCurrentSessionTicket = realtime.captureOwnerGeneration('client', sessionBarrierClient.id, clientSessionB.accessToken)
  await realtime.assertOwnerCanRegister(staleCurrentSessionTicket, clientSessionB.accessToken)
  await mobileSessionService.logoutAll(clientSessionBAuth, 'all')
  assert.throws(
    () => realtime.openClientStream(sessionBarrierClient.id, clientSessionB.accessToken, new TestSseResponse() as never, 60, staleCurrentSessionTicket),
    /授权状态已变化/,
    'Mobile logoutAll(all) 必须使 owner 的旧 ticket 失效',
  )
  assert.equal(clientSessionBResponse.writableEnded, true, 'Mobile logoutAll(all) 必须关闭 owner 的现有 SSE')

  const rotationClient = await createClientUser('issue74-session-rotation-client')
  const rotationTokens = await addClientSessions(rotationClient.id, 'rotation')
  const staleRotationTicket = realtime.captureOwnerGeneration('client', rotationClient.id, rotationTokens.accessToken)
  await realtime.assertOwnerCanRegister(staleRotationTicket, rotationTokens.accessToken)
  await mobileSessionService.refresh(rotationTokens.refreshToken, { deviceId: rotationTokens.deviceId, appVersion: '1.0.1-test' })
  assert.throws(
    () => realtime.openClientStream(rotationClient.id, rotationTokens.accessToken, new TestSseResponse() as never, 60, staleRotationTicket),
    /授权状态已变化/,
    'Mobile Access Token 轮换提交后必须使旧 ticket 失效',
  )

  const lifecycleRaceProduct = await productService.create({
    productName: '生命周期竞态专项商品',
    pinyinAbbr: 'SMZQJT',
    defaultPrice: 10,
    discountRate: 10,
    isActive: true,
    o2oStatus: 'listed',
    currentStock: 20,
    limitPerUser: 20,
  })
  const lifecycleRaceSku = lifecycleRaceProduct.skus[0]
  assert.ok(lifecycleRaceSku, '生命周期竞态专项商品必须生成默认 SKU')

  const staleClientUser = await createClientUser('issue74-stale-client')
  const staleClientAuth = {
    userId: staleClientUser.id,
    account: staleClientUser.email ?? staleClientUser.realName,
    mobile: staleClientUser.mobile ?? '',
    email: staleClientUser.email ?? '',
    realName: staleClientUser.realName,
    accountType: staleClientUser.accountType,
    staffNo: staleClientUser.staffNo,
    sessionToken: 'issue74-stale-client-session',
    authSource: 'bearer' as const,
  }
  await clientService.deactivate(staleClientUser.id, { reason: '验证旧请求在注销提交后被拒绝' }, actor)
  await assert.rejects(
    o2oPreorderService.submit(staleClientAuth, {
      clientRequestId: 'issue74-stale-client-submit-0001',
      items: [{ productId: lifecycleRaceProduct.id, skuId: lifecycleRaceSku.id, qty: 1 }],
      pickupContact: '生命周期竞态验证',
      isSystemApplied: false,
    }),
    /账号已停用或已注销/,
    '旧客户端请求在注销先提交后不得创建 pending 预订单',
  )
  assert.equal(await preorderRepo.count({ where: { clientUserId: staleClientUser.id, status: 'pending' } }), 0)

  const staleSupplier = await createSysUser('issue74-stale-supplier', { role: 'supplier' })
  const staleSupplierActor: AuthUserContext = {
    userId: staleSupplier.id,
    username: staleSupplier.username,
    displayName: staleSupplier.displayName,
    role: 'supplier',
    permissions: [],
    status: 'enabled',
    sessionToken: 'issue74-stale-supplier-session',
  }
  await userService.deactivate(staleSupplier.id, { reason: '验证旧供货方请求在注销提交后被拒绝' }, actor)
  await assert.rejects(
    inboundService.submitSupplierDelivery(staleSupplierActor, {
      remark: '生命周期竞态验证',
      items: [{ productId: lifecycleRaceProduct.id, skuId: lifecycleRaceSku.id, qty: 1 }],
    }),
    /账号已停用或已注销/,
    '旧供货方请求在注销先提交后不得创建 pending 送货单',
  )
  assert.equal(await inboundRepo.count({ where: { supplierId: staleSupplier.id, status: 'pending' } }), 0)

  const staleNotificationActor = await createSysUser('issue74-stale-notification-admin', { role: 'admin' })
  const staleNotificationActorContext: AuthUserContext = {
    userId: staleNotificationActor.id,
    username: staleNotificationActor.username,
    displayName: staleNotificationActor.displayName,
    role: 'admin',
    permissions: [],
    status: 'enabled',
    sessionToken: 'issue74-stale-notification-session',
  }
  await userService.deactivate(staleNotificationActor.id, { reason: '验证旧通知规则请求被拒绝' }, actor)
  await assert.rejects(
    notificationService.updateRules([], 121, staleNotificationActorContext),
    /账号已停用或已注销/,
    '旧 SysUser 请求在注销先提交后不得更新通知规则配置',
  )

  const businessFirstClient = await createClientUser('issue74-business-first-client')
  const businessFirstClientAuth = {
    userId: businessFirstClient.id,
    account: businessFirstClient.email ?? businessFirstClient.realName,
    mobile: businessFirstClient.mobile ?? '',
    email: businessFirstClient.email ?? '',
    realName: businessFirstClient.realName,
    accountType: businessFirstClient.accountType,
    staffNo: businessFirstClient.staffNo,
    sessionToken: 'issue74-business-first-client-session',
    authSource: 'bearer' as const,
  }
  const o2oInterlock = o2oPreorderService as unknown as {
    loadPendingProductQtyMap: (...args: unknown[]) => Promise<unknown>
  }
  const originalLoadPendingProductQtyMap = o2oInterlock.loadPendingProductQtyMap.bind(o2oPreorderService)
  let releaseClientBusiness!: () => void
  let signalClientGuardReached!: () => void
  const clientBusinessGate = new Promise<void>((resolve) => { releaseClientBusiness = resolve })
  const clientGuardReached = new Promise<void>((resolve) => { signalClientGuardReached = resolve })
  o2oInterlock.loadPendingProductQtyMap = async (...args) => {
    signalClientGuardReached()
    await clientBusinessGate
    return originalLoadPendingProductQtyMap(...args)
  }
  try {
    const submitPromise = o2oPreorderService.submit(businessFirstClientAuth, {
      clientRequestId: 'issue74-business-first-client-0001',
      items: [{ productId: lifecycleRaceProduct.id, skuId: lifecycleRaceSku.id, qty: 1 }],
      pickupContact: '生命周期业务先提交验证',
      isSystemApplied: false,
    })
    await clientGuardReached
    const deactivateAssertion = assert.rejects(
      clientService.deactivate(businessFirstClient.id, { reason: '业务事务持锁后尝试注销' }, actor),
      /预订单/,
      'ClientUser 业务事务先提交时，后续注销必须看到 pending 预订单并阻断',
    )
    releaseClientBusiness()
    await submitPromise
    await deactivateAssertion
  } finally {
    o2oInterlock.loadPendingProductQtyMap = originalLoadPendingProductQtyMap
    releaseClientBusiness()
  }

  const businessFirstSupplier = await createSysUser('issue74-business-first-supplier', { role: 'supplier' })
  const businessFirstSupplierActor: AuthUserContext = {
    userId: businessFirstSupplier.id,
    username: businessFirstSupplier.username,
    displayName: businessFirstSupplier.displayName,
    role: 'supplier',
    permissions: [],
    status: 'enabled',
    sessionToken: 'issue74-business-first-supplier-session',
  }
  const inboundInterlock = inboundService as unknown as {
    loadActiveProductsByIds: (...args: unknown[]) => Promise<unknown>
  }
  const originalLoadActiveProductsByIds = inboundInterlock.loadActiveProductsByIds.bind(inboundService)
  let releaseSupplierBusiness!: () => void
  let signalSupplierGuardReached!: () => void
  const supplierBusinessGate = new Promise<void>((resolve) => { releaseSupplierBusiness = resolve })
  const supplierGuardReached = new Promise<void>((resolve) => { signalSupplierGuardReached = resolve })
  inboundInterlock.loadActiveProductsByIds = async (...args) => {
    signalSupplierGuardReached()
    await supplierBusinessGate
    return originalLoadActiveProductsByIds(...args)
  }
  try {
    const submitPromise = inboundService.submitSupplierDelivery(businessFirstSupplierActor, {
      remark: '生命周期业务先提交验证',
      items: [{ productId: lifecycleRaceProduct.id, skuId: lifecycleRaceSku.id, qty: 1 }],
    })
    await supplierGuardReached
    const deactivateAssertion = assert.rejects(
      userService.deactivate(businessFirstSupplier.id, { reason: '业务事务持锁后尝试注销' }, actor),
      /送货单/,
      'SysUser 业务事务先提交时，后续注销必须看到 pending 送货单并阻断',
    )
    releaseSupplierBusiness()
    await submitPromise
    await deactivateAssertion
  } finally {
    inboundInterlock.loadActiveProductsByIds = originalLoadActiveProductsByIds
    releaseSupplierBusiness()
  }

  const feedbackGuardClient = await createClientUser('issue74-feedback-guard-client')
  const feedbackGuardClientTokens = await addClientSessions(feedbackGuardClient.id, 'feedback-guard')
  const staleFeedbackClientAuth = await clientAuthService.resolveClientByToken(feedbackGuardClientTokens.webToken)
  const feedbackGuardConversation = await feedbackRepo.save(feedbackRepo.create({
    conversationNo: 'FB-ISSUE74-GUARD-CLIENT',
    clientUserId: feedbackGuardClient.id,
    clientUsername: feedbackGuardClient.realName,
    clientAccount: feedbackGuardClient.email ?? feedbackGuardClient.realName,
    subject: '客户端消息 guard 专项',
    status: 'open',
    lastMessageAt: new Date(),
  }))
  await clientService.updateStatus(feedbackGuardClient.id, 'disabled', actor)
  await assert.rejects(
    clientFeedbackService.appendClientMessage(feedbackGuardConversation.id, { content: '旧客户端消息不得写入', attachmentIds: [] }, staleFeedbackClientAuth),
    /客户端账号已停用或已注销/,
    'appendClientMessage 必须在事务锁后拒绝已停用客户端',
  )

  const feedbackGuardService = await createSysUser('issue74-feedback-guard-service')
  const staleFeedbackServiceActor: AuthUserContext = {
    userId: feedbackGuardService.id,
    username: feedbackGuardService.username,
    displayName: feedbackGuardService.displayName,
    role: feedbackGuardService.role,
    permissions: ['customer_service:view', 'customer_service:reply'],
    status: 'enabled',
    sessionToken: 'issue74-feedback-guard-service-session',
  }
  const feedbackGuardSysConversation = await feedbackRepo.save(feedbackRepo.create({
    conversationNo: 'FB-ISSUE74-GUARD-SYS',
    clientUserId: feedbackGuardClient.id,
    clientUsername: feedbackGuardClient.realName,
    clientAccount: feedbackGuardClient.email ?? feedbackGuardClient.realName,
    subject: '客服写操作 guard 专项',
    status: 'open',
    assignedUserId: feedbackGuardService.id,
    assignedUsername: feedbackGuardService.username,
    assignedDisplayName: feedbackGuardService.displayName,
    lastMessageAt: new Date(),
  }))
  await userService.updateStatus(feedbackGuardService.id, 'disabled', actor)
  await assert.rejects(
    clientFeedbackService.updateConversationStatus(feedbackGuardSysConversation.id, { status: 'resolved' }, staleFeedbackServiceActor),
    /系统账号已停用或已注销/,
    'updateConversationStatus 必须在事务锁后拒绝已停用客服',
  )
  await assert.rejects(
    clientFeedbackService.updateConversationIssueFields(feedbackGuardSysConversation.id, { subject: '旧客服不得更新' }, staleFeedbackServiceActor),
    /系统账号已停用或已注销/,
    'updateConversationIssueFields 必须在事务锁后拒绝已停用客服',
  )

  const sysUser = await createSysUser('issue74-sys-clean')
  const sysWebToken = 'issue74-sys-web-session'
  await addSysSession(sysUser.id, sysWebToken)
  assert.equal((await authService.resolveAuthUserByToken(sysWebToken)).userId, sysUser.id, '注销前 SysUser Web/Bearer 会话必须真实可用')
  const sysSseResponse = new TestSseResponse()
  const sysSseTicket = realtime.captureOwnerGeneration('service', sysUser.id, sysWebToken)
  await realtime.assertOwnerCanRegister(sysSseTicket, sysWebToken)
  realtime.openServiceStream(sysUser.id, sysWebToken, sysSseResponse as never, 60, sysSseTicket)
  assert.equal(realtime.buildServiceSessionSnapshot().serviceConnectionCount, 1, 'SysUser 真实 SSE 必须完成注册')
  const deactivatedSys = await userService.deactivate(sysUser.id, { reason: '人员离岗' }, actor)
  assert.equal(deactivatedSys.status, 'disabled', 'SysUser 注销必须强制 disabled')
  assert.equal(deactivatedSys.accountState, 'deactivated', 'SysUser 必须返回服务端计算的 accountState')
  assert.equal(await sysSessionRepo.count({ where: { userId: sysUser.id } }), 0, 'SysUser Web 会话必须撤销')
  await assert.rejects(authService.resolveAuthUserByToken(sysWebToken), /登录状态已失效/, '注销后 SysUser Web/Bearer token 必须立即失效')
  await assert.rejects(
    realtime.assertOwnerCanRegister(realtime.captureOwnerGeneration('service', sysUser.id, sysWebToken), sysWebToken),
    /登录状态已失效/,
    'SysUser SSE 注册前最终复核必须拒绝已注销账号或已撤销会话',
  )
  await userService.deactivate(sysUser.id, { reason: '并发重试' }, actor)
  assert.equal(await eventRepo.count({ where: { accountDomain: 'sys_user', accountIdSnapshot: sysUser.id, eventType: 'deactivated' } }), 1, 'SysUser 重复注销不得重复写事件')
  assert.equal(sysSseResponse.writableEnded, true, 'SysUser 注销必须真实关闭已注册 SSE')
  assert.equal(realtime.buildServiceSessionSnapshot().serviceConnectionCount, 0, 'SysUser 注销后不得残留 SSE 订阅')
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
  const clientSseResponse = new TestSseResponse()
  const clientSseTicket = realtime.captureOwnerGeneration('client', clientUser.id, clientTokens.webToken)
  await realtime.assertOwnerCanRegister(clientSseTicket, clientTokens.webToken)
  realtime.openClientStream(clientUser.id, clientTokens.webToken, clientSseResponse as never, 60, clientSseTicket)
  assert.equal(realtime.buildServiceSessionSnapshot().clientConnectionCount, 1, 'ClientUser 真实 SSE 必须完成注册')
  const deactivatedClient = await clientService.deactivate(clientUser.id, { reason: '客户端账号注销' }, actor)
  assert.equal(deactivatedClient.status, 'disabled')
  assert.equal(deactivatedClient.accountState, 'deactivated')
  assert.equal(await clientSessionRepo.count({ where: { userId: clientUser.id } }), 0, 'Client Web 会话必须删除')
  await assert.rejects(clientAuthService.resolveClientByToken(clientTokens.webToken), /未登录或登录状态已失效/, '注销后 Client Web token 必须立即失效')
  await assert.rejects(
    realtime.assertOwnerCanRegister(realtime.captureOwnerGeneration('client', clientUser.id, clientTokens.webToken), clientTokens.webToken),
    /登录状态已失效/,
    'ClientUser SSE 注册前最终复核必须拒绝已注销账号或已撤销会话',
  )
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
  assert.equal(clientSseResponse.writableEnded, true, 'ClientUser 注销必须真实关闭已注册 SSE')
  assert.equal(realtime.buildServiceSessionSnapshot().clientConnectionCount, 0, 'ClientUser 注销后不得残留 SSE 订阅')
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

  console.log('account lifecycle verify: passed (dual-domain transactions, blockers, sessions, FK, append-only, concurrency)')
} finally {
  if (httpServer) {
    await new Promise<void>((resolve) => httpServer!.close(() => resolve()))
  }
  if (dataSource?.isInitialized) await dataSource.destroy()
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
