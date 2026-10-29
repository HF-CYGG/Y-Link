/**
 * 文件说明：backend/scripts/redis-integration-verify.ts
 * 文件职责：回归“独立部署 Redis”接入的跨实例语义与降级语义，防止票据、限流、广播、租约在多实例下悄悄退化。
 * 实现逻辑：
 * - 未提供 REDIS_URL 时用本机 Docker 临时启动 redis:7-alpine（带密码、仅绑定回环地址），结束后删除容器；
 * - 主流程用两个独立的 Redis 票据存储/原生连接模拟两个实例，覆盖票据共享与原子消费、错误次数、密文落盘、
 *   滑动窗口与失败计数、总线收发与去回环、租约互斥与过期接管、集群名额、客服在线态合并与撤权广播；
 * - 降级、未启用、多实例前置校验三类场景需要不同的环境变量（env 在模块加载时读取），各自在子进程中运行；
 * - 每轮使用唯一的 REDIS_KEY_PREFIX 与 backend/data 下的临时 SQLite，结束后清理。
 * 维护说明：修改 redis/ 目录、票据存储、风控状态或客服实时服务时同步补充断言；不要为了通过而放宽断言。
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const backendRoot = path.resolve(process.cwd())
const mode = (process.argv.find((item) => item.startsWith('--mode=')) ?? '--mode=main').slice('--mode='.length)

const findFreePort = () => new Promise<number>((resolve, reject) => {
  const server = net.createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    server.close(() => resolve(port))
  })
})

/** 每个进程使用独立的临时数据目录与 SQLite，避免连到共享的 local-dev 库。 */
const prepareIsolatedEnv = (label: string) => {
  const tempRoot = path.join(backendRoot, 'data', `redis-verify-${label}-${process.pid}`)
  fs.mkdirSync(tempRoot, { recursive: true })
  delete process.env.ENV_FILE
  process.env.NODE_ENV = 'test'
  process.env.APP_PROFILE = `redis-verify-${label}-${process.pid}`
  process.env.DB_TYPE = 'sqlite'
  process.env.DB_SYNC = 'false'
  process.env.SQLITE_DB_PATH = path.join(tempRoot, 'verify.sqlite')
  process.env.Y_LINK_DATA_DIR = path.join(tempRoot, 'data')
  process.env.Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE = 'true'
  process.env.INIT_ADMIN_PASSWORD = 'Redis-Verify#Admin2026'
  process.env.Y_LINK_DATA_ENCRYPTION_KEY ??= randomBytes(32).toString('base64')
  return tempRoot
}

const runChild = (childMode: string, extraEnv: Record<string, string | undefined>) => {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/redis-integration-verify.ts', `--mode=${childMode}`], {
    cwd: backendRoot,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  })
  if (result.status !== 0) {
    throw new Error(`子场景 ${childMode} 失败（exit=${result.status}）\n${result.stdout}\n${result.stderr}`)
  }
  process.stdout.write(result.stdout)
}

async function startDockerRedis(password: string): Promise<{ url: string; stop: () => void }> {
  const port = await findFreePort()
  const name = `ylink-redis-verify-${process.pid}`
  execFileSync('docker', [
    'run', '-d', '--rm', '--name', name, '-p', `127.0.0.1:${port}:6379`,
    'redis:7-alpine', 'redis-server', '--requirepass', password, '--appendonly', 'no', '--maxmemory-policy', 'noeviction',
  ], { stdio: 'pipe' })
  const stop = () => {
    try {
      execFileSync('docker', ['rm', '-f', name], { stdio: 'pipe' })
    } catch {
      // 容器可能已随 --rm 退出。
    }
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const probe = spawnSync('docker', ['exec', '-e', `REDISCLI_AUTH=${password}`, name, 'redis-cli', 'ping'], { encoding: 'utf8' })
    if (probe.stdout?.trim() === 'PONG') return { url: `redis://127.0.0.1:${port}/0`, stop }
    await delay(200)
  }
  stop()
  throw new Error('临时 Redis 容器未能在 10 秒内就绪')
}

// ---------------------------------------------------------------------------------------------
// 主流程：Redis 可用时的跨实例语义
// ---------------------------------------------------------------------------------------------
async function runMainScenario() {
  const tempRoot = prepareIsolatedEnv('main')
  process.env.REDIS_KEY_PREFIX = `ylv${Date.now().toString(36)}:`
  const { Redis } = await import('ioredis')
  const redisClient = await import('../src/redis/redis-client.js')
  const redisBus = await import('../src/redis/redis-bus.js')
  const redisLease = await import('../src/redis/redis-lease.js')
  const { incrementApproxSlidingCounter } = await import('../src/redis/redis-scripts.js')
  const { RedisTicketStore, createTicketStore } = await import('../src/utils/ephemeral-ticket-store.js')
  const { VerificationCodeAttemptStore } = await import('../src/services/verification-code.service.js')
  const { persistentRiskStateService, shouldUseSharedRateLimitStore } = await import('../src/services/persistent-risk-state.service.js')
  const { customerServiceRealtimeService } = await import('../src/services/customer-service-realtime.service.js')
  const { readMallCatalogRevision } = await import('../src/services/mall-catalog-revision.service.js')

  await redisClient.connectRedis()
  redisBus.startRedisBus()
  assert.equal(redisClient.getRedisHealthStatus(), 'ready', 'Redis 应在启动期连接就绪')

  // 0. 就绪探测短暂失败（连接本身仍 ready、不会再触发 ready 事件）后必须自动重试恢复，不能永久停在 degraded
  {
    const probeClient = redisClient.getRedisClient()
    assert.ok(probeClient)
    const originalInfo = probeClient.info.bind(probeClient)
    let failOnce = true
    probeClient.info = (async (...args: Parameters<typeof originalInfo>) => {
      if (failOnce) {
        failOnce = false
        throw new Error('模拟 INFO 超时')
      }
      return originalInfo(...args)
    }) as typeof probeClient.info
    probeClient.emit('ready')
    await delay(50)
    assert.equal(redisClient.isRedisReady(), false, '探测失败后应进入降级')
    for (let index = 0; index < 80 && !redisClient.isRedisReady(); index += 1) await delay(100)
    probeClient.info = originalInfo as typeof probeClient.info
    assert.equal(redisClient.isRedisReady(), true, '探测失败后必须在重试周期内自动恢复 ready')
  }
  const prefix = process.env.REDIS_KEY_PREFIX as string
  const raw = new Redis(process.env.REDIS_URL as string, { password: process.env.REDIS_PASSWORD, lazyConnect: true })
  const rawSubscriber = new Redis(process.env.REDIS_URL as string, { password: process.env.REDIS_PASSWORD, lazyConnect: true })
  await raw.connect()
  await rawSubscriber.connect()

  try {
    // 1. 票据跨实例共享、原子消费、密文落盘、键名摘要
    type Ticket = { code: string; secret: string; expiresAt: number }
    const instanceA = new RedisTicketStore<Ticket>('verify-ticket', (ticket) => ticket.expiresAt)
    const instanceB = new RedisTicketStore<Ticket>('verify-ticket', (ticket) => ticket.expiresAt)
    assert.ok(createTicketStore({ namespace: 'x', maxSize: 1, resolveExpiresAt: () => 0 }) instanceof RedisTicketStore, '配置 Redis 后业务票据必须使用 Redis 实现')
    const plainSecret = 'JBSWY3DPEHPK3PXP-plain-secret'
    await instanceA.set('13800138000:register', { code: '654321', secret: plainSecret, expiresAt: Date.now() + 60_000 })
    assert.equal((await instanceB.get('13800138000:register'))?.secret, plainSecret, '实例 B 必须能读到实例 A 写入的票据')
    const ticketKeys = await raw.keys(`${prefix}ticket:verify-ticket:*`)
    assert.equal(ticketKeys.length, 1)
    assert.ok(!ticketKeys[0].includes('13800138000'), 'Redis 键名不得包含原始手机号')
    const storedValue = await raw.get(ticketKeys[0])
    assert.ok(storedValue?.startsWith('ylenc:v1:'), '票据值必须加密存储')
    assert.ok(!storedValue?.includes(plainSecret) && !storedValue?.includes('654321'), '票据密文中不得出现明文')
    const ttl = await raw.pttl(ticketKeys[0])
    assert.ok(ttl > 50_000 && ttl <= 60_000, `票据 TTL 应按过期时刻换算，实际 ${ttl}`)

    await instanceA.set('race', { code: '1', secret: 's', expiresAt: Date.now() + 60_000 })
    const takes = await Promise.all(Array.from({ length: 100 }, (_, index) => (index % 2 ? instanceA : instanceB).take('race')))
    assert.equal(takes.filter(Boolean).length, 1, '100 个并发 take 只能有一个拿到票据')

    // 伪造明文票据不能被接受
    await raw.set(ticketKeys[0], JSON.stringify({ code: '000000', secret: 'forged', expiresAt: Date.now() + 60_000 }))
    assert.equal(await instanceA.get('13800138000:register'), undefined, '未加密（伪造）的票据必须视为不存在')

    // 2. 验证码错误次数原子计数与并发正确答案只成功一次
    const codeStore = new VerificationCodeAttemptStore(new RedisTicketStore('verify-code', (ticket: { expiresAt: number }) => ticket.expiresAt))
    const codeTicket = { channel: 'mobile' as const, target: '13800138001', scene: 'register' as const, code: '123456', expiresAt: Date.now() + 60_000, failedAttempts: 0 }
    await codeStore.set('k1', codeTicket)
    const wrongResults = await Promise.all(Array.from({ length: 20 }, () => codeStore.consume('k1', '000000')))
    assert.ok(wrongResults.filter((item) => item === false).length >= 5, '错误答案至少前五次返回 false')
    assert.equal(await codeStore.consume('k1', '123456'), null, '并发错误五次后票据必须作废')
    await codeStore.set('k2', codeTicket)
    const rightResults = await Promise.all(Array.from({ length: 20 }, () => codeStore.consume('k2', '123456')))
    assert.equal(rightResults.filter((item) => item === true).length, 1, '并发提交正确答案只能成功一次')
    await codeStore.set('k3', codeTicket)
    for (let index = 0; index < 4; index += 1) assert.equal(await codeStore.consume('k3', '999999'), false)
    await codeStore.set('k3', codeTicket)
    for (let index = 0; index < 4; index += 1) assert.equal(await codeStore.consume('k3', '999999'), false)
    assert.equal(await codeStore.consume('k3', '123456'), true, '重新发送验证码后错误次数必须清零')

    // 2b. 全站撞库态势的近似滑动窗口计数不得在 1000 处封顶（阈值可配置到十万级以上）
    const counterWindowMs = 60_000
    const counterStart = Math.floor(Date.now() / counterWindowMs) * counterWindowMs
    const counterKey = redisClient.redisKey('verify-approx-counter')
    const redisCommand = redisClient.getRedisClient()
    assert.ok(redisCommand)
    let counted = 0
    for (let index = 0; index < 1500; index += 1) {
      counted = await incrementApproxSlidingCounter(redisCommand, counterKey, counterWindowMs, counterStart)
    }
    assert.equal(counted, 1500, '近似滑动窗口计数必须超过 1000 继续累加')
    assert.equal(
      await incrementApproxSlidingCounter(redisCommand, counterKey, counterWindowMs, counterStart + counterWindowMs * 1.5),
      751,
      '跨入下一窗口一半时，上一窗口计数按剩余比例折算（1 + 1500 × 0.5）',
    )

    // 3. 限流滑动窗口与失败计数走 Redis，且多“实例”共享
    assert.equal(shouldUseSharedRateLimitStore(), true, 'SQLite + Redis 也必须挂载共享限流 Store')
    const now = Date.now()
    const hits = []
    for (let index = 0; index < 5; index += 1) hits.push(await persistentRiskStateService.consumeWindow('verify-window', 60_000, now + index, 3))
    assert.deepEqual(hits.map((item) => item.totalHits), [1, 2, 3, 4, 4], '超限后不再写入，命中数停在 limit+1')
    assert.equal(hits[4].deniedFromCache, true, '超限结论应进入本实例负缓存')
    assert.equal((await persistentRiskStateService.readWindow('verify-window', 60_000, now + 10))?.totalHits, 3)
    await persistentRiskStateService.decrementWindow('verify-window', 60_000, now + 10)
    assert.equal((await persistentRiskStateService.readWindow('verify-window', 60_000, now + 10))?.totalHits, 2, '回退后腾出一个名额')
    assert.equal((await persistentRiskStateService.consumeWindow('verify-window', 60_000, now + 11, 3)).totalHits, 3)
    assert.equal((await persistentRiskStateService.readWindow('verify-window', 60_000, now + 60_001))?.totalHits, 1, '滑出窗口的命中不再计数')
    await persistentRiskStateService.resetWindow('verify-window')
    assert.equal(await persistentRiskStateService.readWindow('verify-window', 60_000, now + 12), undefined)
    const riskKeys = await raw.keys(`${prefix}risk:*`)
    assert.ok(riskKeys.every((key) => /risk:[0-9a-f]{64}$/.test(key)), '风控键名只能是 SHA-256 摘要')

    persistentRiskStateService.resetNegativeCacheForTesting()
    let failure = await persistentRiskStateService.recordFailure('verify-login', 15 * 60_000, 3, 5 * 60_000, now)
    failure = await persistentRiskStateService.recordFailure('verify-login', 15 * 60_000, 3, 5 * 60_000, now + 1)
    assert.equal(failure.count, 2)
    assert.equal(failure.lockedUntil, 0)
    failure = await persistentRiskStateService.recordFailure('verify-login', 15 * 60_000, 3, 5 * 60_000, now + 2)
    assert.equal(failure.lockedUntil, now + 2 + 5 * 60_000, '达到阈值后必须锁定')
    persistentRiskStateService.resetNegativeCacheForTesting()
    assert.equal((await persistentRiskStateService.readFailure('verify-login', 15 * 60_000, now + 3))?.count, 3, '其他实例应读到同一失败计数')
    await persistentRiskStateService.resetFailure('verify-login')
    assert.equal(await persistentRiskStateService.readFailure('verify-login', 15 * 60_000, now + 4), null)
    await persistentRiskStateService.recordFailure('verify-expire', 1000, 5, 1000, now)
    persistentRiskStateService.resetNegativeCacheForTesting()
    assert.equal(await persistentRiskStateService.readFailure('verify-expire', 1000, now + 1000), null, '超过重置窗口且未锁定时失败计数应清零')

    // 4. 消息总线：本实例发出的消息其他实例能收到，本实例不回环；其他实例的消息能触发处理器
    const received: unknown[] = []
    await rawSubscriber.subscribe(`${prefix}bus:verify-topic`, `${prefix}bus:cs:revoke`, `${prefix}bus:cs:conversation`, `${prefix}bus:cache:mall-catalog`)
    rawSubscriber.on('message', (channel, message) => {
      try {
        received.push({ channel, ...JSON.parse(message) })
      } catch {
        // 畸形消息由被测处理器负责丢弃，这里只记录可解析的消息。
      }
    })
    const localHandled: unknown[] = []
    redisBus.subscribeRedisBus('verify-topic', (payload) => localHandled.push(payload))
    await delay(200)
    assert.equal(await redisBus.publishRedisBus('verify-topic', { hello: 1 }), true)
    await delay(300)
    assert.ok(received.some((item) => (item as { channel: string }).channel.endsWith('verify-topic')), '其他实例必须收到广播')
    assert.equal(localHandled.length, 0, '发送实例不得处理自己发出的消息')
    await raw.publish(`${prefix}bus:verify-topic`, JSON.stringify({ o: 'other-instance', p: { from: 'other' } }))
    await raw.publish(`${prefix}bus:verify-topic`, 'not-json')
    await delay(300)
    assert.deepEqual(localHandled, [{ from: 'other' }], '其他实例的消息必须触发处理器，畸形消息被丢弃')

    const revisionBefore = readMallCatalogRevision()
    await raw.publish(`${prefix}bus:cache:mall-catalog`, JSON.stringify({ o: 'other-instance', p: null }))
    await delay(300)
    assert.equal(readMallCatalogRevision(), revisionBefore + 1, '其他实例的商城目录写入必须让本实例缓存失效')

    // 5. 客服实时：撤权与会话事件广播、集群在线态合并
    received.length = 0
    customerServiceRealtimeService.disconnectByOwner('service', 'agent-1')
    customerServiceRealtimeService.publishConversationEvent({
      eventType: 'message.created', conversationId: 'c1', clientUserId: 'u1', occurredAt: new Date().toISOString(), conversation: { id: 'c1' },
    })
    await delay(300)
    const revoke = received.find((item) => (item as { channel: string }).channel.endsWith('cs:revoke')) as { p: unknown } | undefined
    assert.deepEqual(revoke?.p, { kind: 'owner', scope: 'service', key: 'agent-1' }, '撤权必须广播给其他实例')
    const conversation = received.find((item) => (item as { channel: string }).channel.endsWith('cs:conversation')) as { p: { eventId: number; payload: { conversationId: string } } } | undefined
    assert.equal(conversation?.p.payload.conversationId, 'c1', '会话事件必须广播给其他实例')
    assert.equal(typeof conversation?.p.eventId, 'number')

    const presenceExpiresAt = Date.now() + 30_000
    await raw.zadd(`${prefix}cs:presence:service`, presenceExpiresAt, 'agent-remote|other-instance', Date.now() - 1, 'agent-stale|dead-instance')
    await raw.hset(`${prefix}cs:presence:clients`, 'other-instance', `7:${presenceExpiresAt}`, 'dead-instance', `9:${Date.now() - 1}`)
    customerServiceRealtimeService.startClusterPresenceSync()
    await delay(500)
    const snapshot = customerServiceRealtimeService.buildServiceSessionSnapshot()
    assert.equal(snapshot.serviceConnectionCount, 1, '在线客服应合并其他实例上报，且忽略已过期上报')
    assert.equal(snapshot.clientConnectionCount, 7, '客户端连接数应合并其他实例上报，且忽略已过期上报')
    assert.equal(await raw.hexists(`${prefix}cs:presence:clients`, 'dead-instance'), 0, '过期实例的上报应被清理')
    await customerServiceRealtimeService.stopClusterPresenceSync()
    assert.equal(customerServiceRealtimeService.buildServiceSessionSnapshot().serviceConnectionCount, 0, '停止同步后不再合并集群在线态')

    // 6. 租约互斥、过期接管与集群名额
    let concurrentRuns = 0
    const job = () => redisLease.runExclusive('verify-job', 5_000, async () => {
      concurrentRuns += 1
      await delay(300)
      return 'done'
    })
    const [first, second] = await Promise.all([job(), job()])
    assert.equal([first.ran, second.ran].filter(Boolean).length, 1, '同一租约同一时刻只能有一个执行者')
    assert.equal(concurrentRuns, 1)
    assert.equal((await job()).ran, true, '执行结束后租约应释放')
    await raw.set(`${prefix}lease:verify-crashed`, 'crashed-owner', 'PX', 300)
    assert.equal((await redisLease.runExclusive('verify-crashed', 5_000, async () => 1)).ran, false, '租约未过期时其他实例不能执行')
    await delay(400)
    assert.equal((await redisLease.runExclusive('verify-crashed', 5_000, async () => 1)).ran, true, '持有者崩溃后租约到期即可被接管')

    const slotA = await redisLease.acquireClusterSlot('verify-slot', 5_000)
    assert.ok(slotA && slotA !== 'local')
    assert.equal(await redisLease.acquireClusterSlot('verify-slot', 5_000), null, '名额被占用时必须拒绝')
    if (slotA && slotA !== 'local') slotA.release()
    await delay(200)
    const slotB = await redisLease.acquireClusterSlot('verify-slot', 5_000)
    assert.ok(slotB && slotB !== 'local', '释放后名额可被重新获取')
    if (slotB && slotB !== 'local') slotB.release()

    const startupOrder: string[] = []
    await Promise.all([
      redisLease.withStartupLock(async () => { startupOrder.push('a-start'); await delay(300); startupOrder.push('a-end') }),
      delay(50).then(() => redisLease.withStartupLock(async () => { startupOrder.push('b-start'); startupOrder.push('b-end') })),
    ])
    assert.deepEqual(startupOrder, ['a-start', 'a-end', 'b-start', 'b-end'], '启动期建表与补数必须串行')

    console.log('[redis-verify] 主流程：票据、限流、风控、总线、客服实时、租约全部通过')
  } finally {
    await rawSubscriber.quit().catch(() => undefined)
    const leftovers = await raw.keys(`${prefix}*`).catch(() => [] as string[])
    if (leftovers.length) await raw.del(...leftovers).catch(() => undefined)
    await raw.quit().catch(() => undefined)
    redisBus.stopRedisBus()
    await redisClient.closeRedis()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------------------------
// 子场景：Redis 已配置但不可用 → 票据 503、限流回落数据库、后台任务照常执行
// ---------------------------------------------------------------------------------------------
async function runDegradedScenario() {
  const tempRoot = prepareIsolatedEnv('degraded')
  const { AppDataSource } = await import('../src/config/data-source.js')
  const bootstrap = await import('../src/config/database-bootstrap.js')
  const redisClient = await import('../src/redis/redis-client.js')
  const { runExclusive } = await import('../src/redis/redis-lease.js')
  const { createTicketStore } = await import('../src/utils/ephemeral-ticket-store.js')
  const { persistentRiskStateService } = await import('../src/services/persistent-risk-state.service.js')
  const { AuthRiskState } = await import('../src/entities/auth-risk-state.entity.js')
  const { BizError } = await import('../src/utils/errors.js')
  try {
    bootstrap.prepareDatabaseRuntime()
    await AppDataSource.initialize()
    await bootstrap.initializeDatabaseSchemaIfNeeded(AppDataSource)
    await redisClient.connectRedis()
    assert.equal(redisClient.getRedisHealthStatus(), 'degraded', '单实例模式下 Redis 首连失败只降级，不阻断启动')

    const store = createTicketStore<{ expiresAt: number }>({ namespace: 'degraded', maxSize: 10, resolveExpiresAt: (ticket) => ticket.expiresAt })
    await assert.rejects(async () => store.set('k', { expiresAt: Date.now() + 60_000 }), (error: unknown) => error instanceof BizError && error.statusCode === 503, 'Redis 不可用时票据必须返回 503')
    await assert.rejects(async () => store.take('k'), (error: unknown) => error instanceof BizError && error.statusCode === 503)

    const now = Date.now()
    for (let index = 0; index < 3; index += 1) await persistentRiskStateService.consumeWindow('degraded-window', 60_000, now + index, 3)
    const denied = await persistentRiskStateService.consumeWindow('degraded-window', 60_000, now + 3, 3)
    assert.equal(denied.totalHits, 4, 'Redis 不可用时限流必须回落数据库并继续生效')
    assert.ok((await AppDataSource.getRepository(AuthRiskState).count()) > 0, '回落路径应写入数据库共享桶')

    assert.equal((await runExclusive('degraded-job', 1000, async () => 'ran')).value, 'ran', 'Redis 不可用时后台任务照常执行')
    assert.ok(redisClient.getRedisRuntimeSnapshot().degradeEvents > 0, '降级次数应被记录')
    console.log('[redis-verify] 降级场景：票据 503、限流回落数据库、后台任务照常执行 通过')
  } finally {
    await redisClient.closeRedis()
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------------------------
// 子场景：Redis 恢复后 → 降级期间写进数据库、尚未到期的登录锁定仍然生效
// ---------------------------------------------------------------------------------------------
async function runRecoveredScenario() {
  const tempRoot = prepareIsolatedEnv('recovered')
  const { AppDataSource } = await import('../src/config/data-source.js')
  const bootstrap = await import('../src/config/database-bootstrap.js')
  const redisClient = await import('../src/redis/redis-client.js')
  const { persistentRiskStateService } = await import('../src/services/persistent-risk-state.service.js')
  const { AuthRiskState } = await import('../src/entities/auth-risk-state.entity.js')
  const { createHash } = await import('node:crypto')
  try {
    bootstrap.prepareDatabaseRuntime()
    await AppDataSource.initialize()
    await bootstrap.initializeDatabaseSchemaIfNeeded(AppDataSource)
    await redisClient.connectRedis()
    assert.equal(redisClient.getRedisHealthStatus(), 'ready')

    // 模拟另一实例在 Redis 故障期间走数据库回落路径写下的锁定（本进程负缓存里没有它）。
    const now = Date.now()
    const bucketKey = `recovered-lock-${process.pid}`
    await AppDataSource.getRepository(AuthRiskState).save({
      bucketDigest: createHash('sha256').update(`login_failure:${bucketKey}`).digest('hex'),
      stateType: 'login_failure',
      requestTimestampsJson: null,
      failureCount: 5,
      firstFailedAt: new Date(now - 60_000),
      lastFailedAt: new Date(now - 1_000),
      lockedUntil: new Date(now + 10 * 60_000),
      expiresAt: new Date(now + 15 * 60_000),
    })
    const state = await persistentRiskStateService.readFailure(bucketKey, 15 * 60_000, now)
    assert.ok(state && state.lockedUntil > now, 'Redis 恢复后必须补读数据库中尚未到期的锁定，不能被切换实例绕过')
    assert.equal(state.count, 5)
    assert.equal(await persistentRiskStateService.readFailure(`recovered-none-${process.pid}`, 15 * 60_000, now), null, '无锁定时仍返回空状态')

    // 反方向：Redis 中触发的锁定必须镜像到数据库，Redis 随后故障时回落数据库的实例仍能看到；未触发锁定的失败不落库。
    const redisLockKey = `redis-lock-${process.pid}`
    const redisLockDigest = createHash('sha256').update(`login_failure:${redisLockKey}`).digest('hex')
    const riskRepository = AppDataSource.getRepository(AuthRiskState)
    for (let index = 0; index < 4; index += 1) {
      await persistentRiskStateService.recordFailure(redisLockKey, 15 * 60_000, 5, 10 * 60_000, now + index)
    }
    assert.equal(await riskRepository.countBy({ bucketDigest: redisLockDigest }), 0, '未达锁定阈值的失败计数不应写数据库')
    const locked = await persistentRiskStateService.recordFailure(redisLockKey, 15 * 60_000, 5, 10 * 60_000, now + 4)
    assert.ok(locked.lockedUntil > now)
    const mirrored = await riskRepository.findOneBy({ bucketDigest: redisLockDigest })
    assert.equal(mirrored?.lockedUntil?.getTime(), locked.lockedUntil, 'Redis 触发的锁定必须镜像到数据库')
    assert.equal(mirrored?.failureCount, 5)
    console.log('[redis-verify] 恢复场景：登录锁定在 Redis 与数据库间双向兜底 通过')
  } finally {
    await redisClient.closeRedis()
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------------------------
// 子场景：未配置 Redis → 行为与单实例现状一致
// ---------------------------------------------------------------------------------------------
async function runDisabledScenario() {
  const tempRoot = prepareIsolatedEnv('disabled')
  const redisClient = await import('../src/redis/redis-client.js')
  const { runExclusive, acquireClusterSlot, withStartupLock } = await import('../src/redis/redis-lease.js')
  const { publishRedisBus } = await import('../src/redis/redis-bus.js')
  const { createTicketStore, EphemeralTicketStore } = await import('../src/utils/ephemeral-ticket-store.js')
  const { shouldUseSharedRateLimitStore } = await import('../src/services/persistent-risk-state.service.js')
  try {
    await redisClient.connectRedis()
    assert.equal(redisClient.getRedisHealthStatus(), 'disabled')
    assert.ok(createTicketStore({ namespace: 'x', maxSize: 1, resolveExpiresAt: () => 0 }) instanceof EphemeralTicketStore, '未配置 Redis 时票据保持进程内存实现')
    assert.equal(shouldUseSharedRateLimitStore(), false, 'SQLite 且未配置 Redis 时保持内存限流桶')
    assert.equal((await runExclusive('job', 1000, async () => 1)).ran, true)
    assert.equal(await acquireClusterSlot('slot', 1000), 'local')
    assert.equal(await withStartupLock(async () => 'ok'), 'ok')
    assert.equal(await publishRedisBus('topic', {}), false)
    assert.equal(redisClient.getRedisRuntimeSnapshot().degradeEvents, 0, '未启用 Redis 不应产生降级记录')
    console.log('[redis-verify] 未启用场景：行为与单实例现状一致 通过')
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------------------------
// 子场景：多实例前置条件
// ---------------------------------------------------------------------------------------------
async function runMultiInstanceScenario() {
  const tempRoot = prepareIsolatedEnv('multi')
  const redisClient = await import('../src/redis/redis-client.js')
  try {
    assert.throws(() => redisClient.assertMultiInstancePrerequisites('sqlite'), /DB_TYPE 必须为 mysql/)
    assert.throws(() => redisClient.assertMultiInstancePrerequisites('mysql'), /必须配置 REDIS_URL/)
    console.log('[redis-verify] 多实例前置校验：缺少 MySQL 或 Redis 时拒绝启动 通过')
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

async function main() {
  if (mode === 'degraded') return runDegradedScenario()
  if (mode === 'recovered') return runRecoveredScenario()
  if (mode === 'disabled') return runDisabledScenario()
  if (mode === 'multi') return runMultiInstanceScenario()

  let dockerRedis: { url: string; stop: () => void } | null = null
  if (!process.env.REDIS_URL) {
    process.env.REDIS_PASSWORD = randomBytes(12).toString('hex')
    dockerRedis = await startDockerRedis(process.env.REDIS_PASSWORD)
    process.env.REDIS_URL = dockerRedis.url
    // 任何未捕获异常导致的退出都要删除临时容器，避免残留。
    const stopOnExit = dockerRedis.stop
    process.once('exit', stopOnExit)
  }
  try {
    await runMainScenario()
    const deadPort = await findFreePort()
    runChild('degraded', { REDIS_URL: `redis://127.0.0.1:${deadPort}/0`, REDIS_CONNECT_TIMEOUT_MS: '500', Y_LINK_MULTI_INSTANCE: undefined })
    runChild('recovered', { Y_LINK_MULTI_INSTANCE: undefined })
    runChild('disabled', { REDIS_URL: undefined, Y_LINK_MULTI_INSTANCE: undefined })
    runChild('multi', { REDIS_URL: undefined, Y_LINK_MULTI_INSTANCE: 'true' })
    console.log('Redis 接入回归验证通过')
  } finally {
    dockerRedis?.stop()
  }
}

main().then(() => {
  // ioredis 重连定时器等句柄可能残留，验证结束后显式退出。
  process.exit(0)
}).catch((error) => {
  console.error(error)
  process.exit(1)
})
