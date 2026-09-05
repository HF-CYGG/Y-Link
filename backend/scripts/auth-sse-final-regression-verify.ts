/**
 * 文件说明：认证撤销并发与 SSE 资源/可见性最终专项回归。
 * 实现逻辑：使用独立 SQLite 复现登录校验与账号变更交错，并以受控 Response 替身验证 SSE 私有事件和硬资源预算。
 * 维护重点：每个 case 独立进程运行，环境变量必须在动态导入生产服务前设置，避免单例策略常量串扰。
 */

import 'reflect-metadata'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const currentFilePath = fileURLToPath(import.meta.url)
const backendRoot = path.resolve(path.dirname(currentFilePath), '..')
const sqliteRoot = path.resolve(backendRoot, 'data', 'local-dev')
const verifySeed = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const sqlitePath = path.resolve(sqliteRoot, `auth-sse-final-regression-${verifySeed}.sqlite`)
const adminPassword = `Admin_${verifySeed}_Aa1!`
const clientPassword = `Client_${verifySeed}_Bb2!`
const selectedCase = process.argv.find((item) => item.startsWith('--case='))?.slice('--case='.length) ?? 'all'
const mysqlHost = process.env.AUTH_SSE_VERIFY_MYSQL_HOST?.trim()

process.env.APP_PROFILE = `auth-sse-final-regression-${verifySeed}`
if (mysqlHost) {
  process.env.DB_TYPE = 'mysql'
  process.env.DB_SYNC = 'true'
  process.env.DB_HOST = mysqlHost
  process.env.DB_PORT = process.env.AUTH_SSE_VERIFY_MYSQL_PORT ?? '3306'
  process.env.DB_USERNAME = process.env.AUTH_SSE_VERIFY_MYSQL_USERNAME ?? 'root'
  process.env.DB_PASSWORD = process.env.AUTH_SSE_VERIFY_MYSQL_PASSWORD ?? ''
  process.env.DB_NAME = process.env.AUTH_SSE_VERIFY_MYSQL_DATABASE ?? ''
} else {
  process.env.DB_TYPE = 'sqlite'
  process.env.DB_SYNC = 'false'
  process.env.SQLITE_DB_PATH = sqlitePath
}
process.env.INIT_ADMIN_USERNAME = 'admin'
process.env.INIT_ADMIN_PASSWORD = adminPassword
process.env.INVITE_CODE_PEPPER ||= `auth-sse-final-regression-${verifySeed}-minimum-32-bytes`
process.env.YLINK_SSE_MAX_PENDING_MESSAGES = '2'
process.env.YLINK_SSE_MAX_PENDING_BYTES = String(1024 * 1024)
process.env.YLINK_SSE_CONNECT_RATE_MAX_ENTRIES = '2'
process.env.YLINK_SSE_CONNECT_WINDOW_MS = '10000'

class ControlledSseResponse extends EventEmitter {
  writableEnded = false
  destroyed = false
  writableLength = 0
  readonly writes: string[] = []
  readonly headers = new Map<string, string>()
  statusCode = 0

  status(code: number) {
    this.statusCode = code
    return this
  }

  setHeader(name: string, value: string) {
    this.headers.set(name.toLowerCase(), value)
    return this
  }

  flushHeaders() {}

  write(payload: string) {
    this.writes.push(payload)
    return true
  }

  end() {
    if (this.writableEnded) return this
    this.writableEnded = true
    this.emit('close')
    return this
  }
}

function createBarrier() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(message)
}

async function withDatabase<T>(run: (context: Awaited<ReturnType<typeof prepareDatabaseContext>>) => Promise<T>) {
  fs.mkdirSync(sqliteRoot, { recursive: true })
  const context = await prepareDatabaseContext()
  try {
    return await run(context)
  } finally {
    if (context.AppDataSource.isInitialized) {
      await context.AppDataSource.destroy()
    }
    fs.rmSync(sqlitePath, { force: true })
  }
}

async function prepareDatabaseContext() {
  const { AppDataSource } = await import('../src/config/data-source.js')
  const { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime } = await import('../src/config/database-bootstrap.js')
  const { authService } = await import('../src/services/auth.service.js')
  const { clientAuthService } = await import('../src/services/client-auth.service.js')
  const { customerServiceRealtimeService } = await import('../src/services/customer-service-realtime.service.js')
  const { ClientUser } = await import('../src/entities/client-user.entity.js')
  const { ClientUserSession } = await import('../src/entities/client-user-session.entity.js')
  const { SysUser } = await import('../src/entities/sys-user.entity.js')
  const { SysUserSession } = await import('../src/entities/sys-user-session.entity.js')
  const { hashPassword } = await import('../src/utils/password.js')
  const { runInTransaction } = await import('../src/config/transaction-runner.js')

  prepareDatabaseRuntime()
  try {
    await AppDataSource.initialize()
    await initializeDatabaseSchemaIfNeeded(AppDataSource)
    await authService.ensureDefaultAdmin()
  } catch (error) {
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
    throw error
  }

  return {
    AppDataSource,
    authService,
    clientAuthService,
    customerServiceRealtimeService,
    ClientUser,
    ClientUserSession,
    SysUser,
    SysUserSession,
    hashPassword,
    runInTransaction,
  }
}

async function verifyAdminLoginCannotSurviveConcurrentRevocation() {
  await withDatabase(async ({ AppDataSource, authService, SysUser, SysUserSession, hashPassword, runInTransaction }) => {
    const internals = authService as unknown as {
      findUserWithPasswordByUsername: (username: string) => Promise<InstanceType<typeof SysUser> | null>
    }
    const originalFind = internals.findUserWithPasswordByUsername.bind(authService)
    const queryReached = createBarrier()
    const allowLoginToContinue = createBarrier()
    internals.findUserWithPasswordByUsername = async (username) => {
      const user = await originalFind(username)
      queryReached.release()
      await allowLoginToContinue.promise
      return user
    }

    try {
      const lateLogin = authService.login({ username: 'admin', password: adminPassword })
      await queryReached.promise
      await runInTransaction(async (manager) => {
        const userRepo = manager.getRepository(SysUser)
        const sessionRepo = manager.getRepository(SysUserSession)
        const user = await userRepo.createQueryBuilder('user')
          .addSelect('user.passwordHash')
          .where('user.username = :username', { username: 'admin' })
          .getOneOrFail()
        user.passwordHash = await hashPassword(`${adminPassword}_rotated`)
        await userRepo.save(user)
        await sessionRepo.delete({ userId: user.id })
      })
      allowLoginToContinue.release()
      await assert.rejects(lateLogin, /账号或密码错误|状态已发生变化|信息已发生变化/, '撤销提交后不得接受事务外完成的旧管理端认证结果')
      assert.equal(await AppDataSource.getRepository(SysUserSession).count(), 0, '晚到登录不得留下管理端会话')
      const currentLogin = await authService.login({ username: 'admin', password: `${adminPassword}_rotated` })
      assert.ok(currentLogin.token, '变更后的当前管理端凭据仍应正常签发会话')
    } finally {
      internals.findUserWithPasswordByUsername = originalFind
      allowLoginToContinue.release()
    }
  })
}

async function verifyClientLoginCannotSurviveConcurrentRevocation() {
  await withDatabase(async ({ AppDataSource, clientAuthService, ClientUser, ClientUserSession, hashPassword, runInTransaction }) => {
    const client = await AppDataSource.getRepository(ClientUser).save(AppDataSource.getRepository(ClientUser).create({
      mobile: '13800138000',
      email: null,
      mobileVerifiedAt: new Date(),
      emailVerifiedAt: null,
      passwordHash: await hashPassword(clientPassword),
      realName: '并发客户端',
      departmentName: '',
      departmentNodeId: null,
      accountType: 'personal',
      staffNo: null,
      staffVerified: false,
      status: 'enabled',
      lastLoginAt: null,
    }))
    const internals = clientAuthService as unknown as {
      findUserWithPasswordByAccount: (account: unknown) => Promise<InstanceType<typeof ClientUser> | null>
    }
    const originalFind = internals.findUserWithPasswordByAccount.bind(clientAuthService)
    const queryReached = createBarrier()
    const allowLoginToContinue = createBarrier()
    internals.findUserWithPasswordByAccount = async (account) => {
      const user = await originalFind(account)
      queryReached.release()
      await allowLoginToContinue.promise
      return user
    }

    try {
      const lateLogin = clientAuthService.login({ account: client.mobile!, password: clientPassword })
      await queryReached.promise
      await runInTransaction(async (manager) => {
        const userRepo = manager.getRepository(ClientUser)
        const sessionRepo = manager.getRepository(ClientUserSession)
        const user = await userRepo.createQueryBuilder('user')
          .addSelect('user.passwordHash')
          .where('user.id = :id', { id: client.id })
          .getOneOrFail()
        user.status = 'disabled'
        await userRepo.save(user)
        await sessionRepo.delete({ userId: user.id })
      })
      allowLoginToContinue.release()
      await assert.rejects(lateLogin, /用户名或密码错误|状态已发生变化|信息已发生变化/, '停用提交后不得接受事务外完成的旧客户端认证结果')
      assert.equal(await AppDataSource.getRepository(ClientUserSession).count({ where: { userId: client.id } }), 0, '晚到登录不得留下客户端会话')
      await runInTransaction(async (manager) => {
        await manager.getRepository(ClientUser).update({ id: client.id }, { status: 'enabled' })
      })
      const currentLogin = await clientAuthService.login({ account: client.mobile!, password: clientPassword })
      assert.ok(currentLogin.token, '账号重新启用后的当前客户端凭据仍应正常签发会话')
    } finally {
      internals.findUserWithPasswordByAccount = originalFind
      allowLoginToContinue.release()
    }
  })
}

async function verifyRegistrationSessionCannotSurviveConcurrentStatusChange() {
  await withDatabase(async ({ AppDataSource, clientAuthService, ClientUser, ClientUserSession, hashPassword, runInTransaction }) => {
    const registeredUserSnapshot = await AppDataSource.getRepository(ClientUser).save(AppDataSource.getRepository(ClientUser).create({
      mobile: '13700137000',
      email: null,
      mobileVerifiedAt: new Date(),
      emailVerifiedAt: null,
      passwordHash: await hashPassword(clientPassword),
      realName: '注册并发客户端',
      departmentName: '',
      departmentNodeId: null,
      accountType: 'personal',
      staffNo: null,
      staffVerified: false,
      status: 'enabled',
      lastLoginAt: null,
    }))
    await runInTransaction(async (manager) => {
      await manager.getRepository(ClientUser).update({ id: registeredUserSnapshot.id }, { status: 'disabled' })
      await manager.getRepository(ClientUserSession).delete({ userId: registeredUserSnapshot.id })
    })
    const internals = clientAuthService as unknown as {
      createSessionForUser: (user: InstanceType<typeof ClientUser>) => Promise<unknown>
    }
    await assert.rejects(
      () => internals.createSessionForUser(registeredUserSnapshot),
      /用户名或密码错误|状态已发生变化|信息已发生变化/,
      '注册落库后若账号状态先发生变化，共享签发边界不得复用注册时的旧快照创建会话',
    )
    assert.equal(
      await AppDataSource.getRepository(ClientUserSession).count({ where: { userId: registeredUserSnapshot.id } }),
      0,
      '注册晚到签发不得留下客户端会话',
    )
  })
}

async function verifyMySqlOwnerLockOrdersSessionIssuanceBeforeRevocation() {
  assert.ok(mysqlHost, 'mysql-owner-lock case 只允许使用 AUTH_SSE_VERIFY_MYSQL_* 指定的隔离临时库')
  await withDatabase(async ({ AppDataSource, authService, SysUser, SysUserSession, hashPassword, runInTransaction }) => {
    const internals = authService as unknown as {
      lockUserForSession: (manager: unknown, userId: string) => Promise<InstanceType<typeof SysUser> | null>
    }
    const originalLock = internals.lockUserForSession.bind(authService)
    const loginHasOwnerLock = createBarrier()
    const allowSessionInsert = createBarrier()
    internals.lockUserForSession = async (manager, userId) => {
      const user = await originalLock(manager, userId)
      loginHasOwnerLock.release()
      await allowSessionInsert.promise
      return user
    }

    try {
      const login = authService.login({ username: 'admin', password: adminPassword })
      await loginHasOwnerLock.promise
      let revocationSettled = false
      const revocation = runInTransaction(async (manager) => {
        const userRepo = manager.getRepository(SysUser)
        const sessionRepo = manager.getRepository(SysUserSession)
        const user = await userRepo.createQueryBuilder('user')
          .addSelect('user.passwordHash')
          .where('user.username = :username', { username: 'admin' })
          .setLock('pessimistic_write')
          .getOneOrFail()
        user.passwordHash = await hashPassword(`${adminPassword}_revoked`)
        await userRepo.save(user)
        await sessionRepo.delete({ userId: user.id })
      }).finally(() => {
        revocationSettled = true
      })
      await new Promise((resolve) => setTimeout(resolve, 150))
      assert.equal(revocationSettled, false, '登录事务持有 owner 行锁时，撤销事务必须等待')
      allowSessionInsert.release()
      const issued = await login
      assert.ok(issued.token, '先获得 owner 行锁的登录事务应能按明确顺序完成签发')
      await revocation
      assert.equal(await AppDataSource.getRepository(SysUserSession).count(), 0, '随后获得 owner 行锁的撤销事务必须删除刚签发会话')
    } finally {
      internals.lockUserForSession = originalLock
      allowSessionInsert.release()
    }
  })
}

async function verifyMySqlClientOwnerLockOrdersSessionIssuanceBeforeRevocation() {
  assert.ok(mysqlHost, 'mysql-client-owner-lock case 只允许使用 AUTH_SSE_VERIFY_MYSQL_* 指定的隔离临时库')
  await withDatabase(async ({ AppDataSource, clientAuthService, ClientUser, ClientUserSession, hashPassword, runInTransaction }) => {
    const client = await AppDataSource.getRepository(ClientUser).save(AppDataSource.getRepository(ClientUser).create({
      mobile: '13600136000',
      email: null,
      mobileVerifiedAt: new Date(),
      emailVerifiedAt: null,
      passwordHash: await hashPassword(clientPassword),
      realName: 'MySQL 并发客户端',
      departmentName: '',
      departmentNodeId: null,
      accountType: 'personal',
      staffNo: null,
      staffVerified: false,
      status: 'enabled',
      lastLoginAt: null,
    }))
    const internals = clientAuthService as unknown as {
      lockUserForSession: (manager: unknown, userId: string) => Promise<InstanceType<typeof ClientUser> | null>
    }
    const originalLock = internals.lockUserForSession.bind(clientAuthService)
    const loginHasOwnerLock = createBarrier()
    const allowSessionInsert = createBarrier()
    internals.lockUserForSession = async (manager, userId) => {
      const user = await originalLock(manager, userId)
      loginHasOwnerLock.release()
      await allowSessionInsert.promise
      return user
    }

    try {
      const login = clientAuthService.login({ account: client.mobile!, password: clientPassword })
      await loginHasOwnerLock.promise
      let revocationSettled = false
      const revocation = runInTransaction(async (manager) => {
        const userRepo = manager.getRepository(ClientUser)
        const sessionRepo = manager.getRepository(ClientUserSession)
        const lockedClient = await userRepo.createQueryBuilder('user')
          .addSelect('user.passwordHash')
          .where('user.id = :id', { id: client.id })
          .setLock('pessimistic_write')
          .getOneOrFail()
        lockedClient.status = 'disabled'
        await userRepo.save(lockedClient)
        await sessionRepo.delete({ userId: lockedClient.id })
      }).finally(() => {
        revocationSettled = true
      })
      await new Promise((resolve) => setTimeout(resolve, 150))
      assert.equal(revocationSettled, false, '客户端登录事务持有 owner 行锁时，撤销事务必须等待')
      allowSessionInsert.release()
      const issued = await login
      assert.ok(issued.token, '先获得 owner 行锁的客户端登录事务应能按明确顺序完成签发')
      await revocation
      assert.equal(
        await AppDataSource.getRepository(ClientUserSession).count({ where: { userId: client.id } }),
        0,
        '随后获得 owner 行锁的客户端撤销事务必须删除刚签发会话',
      )
    } finally {
      internals.lockUserForSession = originalLock
      allowSessionInsert.release()
    }
  })
}

async function seedRealtimePrincipals(context: Awaited<ReturnType<typeof prepareDatabaseContext>>) {
  const adminLogin = await context.authService.login({ username: 'admin', password: adminPassword })
  const client = await context.AppDataSource.getRepository(context.ClientUser).save(context.AppDataSource.getRepository(context.ClientUser).create({
    mobile: '13900139000',
    email: null,
    mobileVerifiedAt: new Date(),
    emailVerifiedAt: null,
    passwordHash: await context.hashPassword(clientPassword),
    realName: '实时客户端',
    departmentName: '',
    departmentNodeId: null,
    accountType: 'personal',
    staffNo: null,
    staffVerified: false,
    status: 'enabled',
    lastLoginAt: null,
  }))
  const clientLogin = await context.clientAuthService.login({ account: client.mobile!, password: clientPassword })
  return { adminLogin, client, clientLogin }
}

async function verifyServiceOnlyEventDoesNotReachClient() {
  const feedbackServiceSource = fs.readFileSync(path.resolve(backendRoot, 'src', 'services', 'client-feedback.service.ts'), 'utf8')
  const internalRemarkPublishBlock = feedbackServiceSource.match(
    /publishConversationEvent\(\{\s*[\s\S]*?buildRealtimePayload\('conversation_internal_remark_updated'[\s\S]*?\n\s*\}\)/,
  )?.[0] ?? ''
  assert.match(internalRemarkPublishBlock, /audience:\s*'service'/, '生产内部备注事件必须显式标记为客服可见')
  await withDatabase(async (context) => {
    const { adminLogin, client, clientLogin } = await seedRealtimePrincipals(context)
    const clientResponse = new ControlledSseResponse()
    const serviceResponse = new ControlledSseResponse()
    context.customerServiceRealtimeService.openClientStream(client.id, clientLogin.token, clientResponse as never, 60)
    const admin = await context.AppDataSource.getRepository(context.SysUser).findOneByOrFail({ username: 'admin' })
    context.customerServiceRealtimeService.openServiceStream(admin.id, adminLogin.token, serviceResponse as never, 60)

    context.customerServiceRealtimeService.publishConversationEvent({
      eventType: 'conversation_internal_remark_updated',
      conversationId: 'conversation-private-event',
      clientUserId: client.id,
      occurredAt: new Date().toISOString(),
      conversation: { id: 'conversation-private-event' },
      detail: { updatedBy: admin.id },
      audience: 'service',
    } as never)

    await waitFor(
      () => serviceResponse.writes.some((payload) => payload.includes('event: conversation')),
      '客服订阅应收到内部备注事件',
    )
    const serviceConversationEvent = serviceResponse.writes.find((payload) => payload.includes('event: conversation')) ?? ''
    assert.equal(serviceConversationEvent.includes('"audience"'), false, '内部 audience 路由字段不得进入公开 SSE 负载')
    assert.equal(
      clientResponse.writes.some((payload) => payload.includes('event: conversation')),
      false,
      '内部备注事件不得进入客户端 SSE',
    )
    clientResponse.end()
    serviceResponse.end()
  })
}

async function verifyRevokedSessionReceivesNoBusinessEvent() {
  await withDatabase(async (context) => {
    const { client, clientLogin } = await seedRealtimePrincipals(context)
    const clientResponse = new ControlledSseResponse()
    context.customerServiceRealtimeService.openClientStream(client.id, clientLogin.token, clientResponse as never, 60)
    await context.runInTransaction(async (manager) => {
      await manager.getRepository(context.ClientUserSession).delete({ userId: client.id })
    })

    context.customerServiceRealtimeService.publishConversationEvent({
      eventType: 'message_created',
      conversationId: 'revoked-session-conversation',
      clientUserId: client.id,
      occurredAt: new Date().toISOString(),
      conversation: { id: 'revoked-session-conversation' },
    })

    await waitFor(() => clientResponse.writableEnded, '会话失效后下一次业务事件复核必须关闭客户端订阅')
    assert.equal(
      clientResponse.writes.some((payload) => payload.includes('event: conversation')),
      false,
      '会话失效后的客户端订阅不得收到任何业务事件',
    )
  })
}

async function verifyDeliveryQueueHasHardBudget() {
  const { customerServiceRealtimeService } = await import('../src/services/customer-service-realtime.service.js')
  const response = new ControlledSseResponse()
  customerServiceRealtimeService.openClientStream('queue-client', 'queue-session', response as never, 60)
  for (let index = 0; index < 3; index += 1) {
    customerServiceRealtimeService.publishConversationEvent({
      eventType: 'message_created',
      conversationId: `queue-conversation-${index}`,
      clientUserId: 'queue-client',
      occurredAt: new Date().toISOString(),
      conversation: { index },
    })
  }
  assert.equal(response.writableEnded, true, '发布队列超过两条硬预算时必须关闭受影响订阅，促使前端重连拉取')
}

async function verifyDeliveryQueueHasByteBudget() {
  const { customerServiceRealtimeService } = await import('../src/services/customer-service-realtime.service.js')
  const response = new ControlledSseResponse()
  customerServiceRealtimeService.openClientStream('queue-byte-client', 'queue-byte-session', response as never, 60)
  customerServiceRealtimeService.publishConversationEvent({
    eventType: 'message_created',
    conversationId: 'queue-byte-conversation',
    clientUserId: 'queue-byte-client',
    occurredAt: new Date().toISOString(),
    conversation: { oversized: 'x'.repeat(1024 * 1024) },
  })
  assert.equal(response.writableEnded, true, '单条事件超过字节预算时必须关闭受影响订阅，不能进入发布队列')
}

async function verifyConnectRateStoreHasHardCapacity() {
  const { customerServiceRealtimeService } = await import('../src/services/customer-service-realtime.service.js')
  const first = new ControlledSseResponse()
  const second = new ControlledSseResponse()
  customerServiceRealtimeService.openClientStream('rate-owner-1', 'rate-session-1', first as never, 60)
  customerServiceRealtimeService.openClientStream('rate-owner-2', 'rate-session-2', second as never, 60)
  first.end()
  second.end()
  const originalNow = Date.now
  let now = originalNow()
  Date.now = () => now
  try {
    assert.throws(
      () => customerServiceRealtimeService.openClientStream('rate-owner-3', 'rate-session-3', new ControlledSseResponse() as never, 60),
      /连接请求过于频繁|频控容量|稍后再试/,
      '建连频控容器达到两条硬上限后不得继续接纳新会话键',
    )
    now += 10_001
    const admittedAfterExpiry = new ControlledSseResponse()
    customerServiceRealtimeService.openClientStream('rate-owner-3', 'rate-session-3', admittedAfterExpiry as never, 60)
    assert.equal(admittedAfterExpiry.statusCode, 200, '过期频控窗口必须先清理，再接纳新会话键')
    admittedAfterExpiry.end()
  } finally {
    Date.now = originalNow
  }
}

const cases: Record<string, () => Promise<void>> = {
  'admin-race': verifyAdminLoginCannotSurviveConcurrentRevocation,
  'client-race': verifyClientLoginCannotSurviveConcurrentRevocation,
  'register-race': verifyRegistrationSessionCannotSurviveConcurrentStatusChange,
  'mysql-owner-lock': verifyMySqlOwnerLockOrdersSessionIssuanceBeforeRevocation,
  'mysql-client-owner-lock': verifyMySqlClientOwnerLockOrdersSessionIssuanceBeforeRevocation,
  'sse-private': verifyServiceOnlyEventDoesNotReachClient,
  'sse-revoked-session': verifyRevokedSessionReceivesNoBusinessEvent,
  'sse-queue': verifyDeliveryQueueHasHardBudget,
  'sse-queue-bytes': verifyDeliveryQueueHasByteBudget,
  'sse-rate': verifyConnectRateStoreHasHardCapacity,
}

async function main() {
  if (selectedCase === 'all') {
    const tsxCliPath = path.resolve(backendRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
    for (const name of Object.keys(cases).filter((caseName) => !caseName.startsWith('mysql-'))) {
      const child = spawnSync(process.execPath, [tsxCliPath, currentFilePath, `--case=${name}`], {
        cwd: backendRoot,
        encoding: 'utf8',
        stdio: 'pipe',
      })
      if (child.stdout) process.stdout.write(child.stdout)
      if (child.stderr) process.stderr.write(child.stderr)
      assert.equal(child.status, 0, `${name} 子进程验证失败`)
    }
    console.log('认证撤销并发与 SSE 最终专项回归通过')
    return
  }
  const selected = [[selectedCase, cases[selectedCase]] as const]
  for (const [name, verify] of selected) {
    assert.equal(typeof verify, 'function', `未知 case：${name}`)
    await verify!()
    console.log(`OK ${name}`)
  }
  console.log('认证撤销并发与 SSE 最终专项回归通过')
}

main().catch((error) => {
  console.error('[auth-sse-final-regression] 验证失败:', error)
  if (fs.existsSync(sqlitePath)) {
    try {
      fs.rmSync(sqlitePath, { force: true })
    } catch {
      // 数据源初始化失败时 Windows 可能仍短暂持有文件句柄；子进程退出后由后续清理处理。
    }
  }
  process.exitCode = 1
})
