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
import { createHash, randomBytes } from 'node:crypto'
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
  process.env.Y_LINK_MULTI_INSTANCE = 'false'
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
  const { invalidateMallCatalogReadCache, readMallCatalogRevision, subscribeMallCatalogRemoteInvalidation } = await import('../src/services/mall-catalog-revision.service.js')

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

    const pendingTicket = { code: '1', secret: 's', expiresAt: Date.now() + 60_000 }
    const matchPending = (ticket: Ticket) => ticket.code === pendingTicket.code ? true : null
    await instanceA.set('reserved', pendingTicket)
    for (let index = 0; index < 4; index += 1) {
      assert.deepEqual(await instanceB.verifyAndReserve('reserved', 5, () => null), { status: 'mismatch', attemptsLeft: 4 - index })
    }
    const attempts = await Promise.all([instanceA, instanceB].map(store => store.verifyAndReserve('reserved', 5, matchPending)))
    const reservedAttempt = attempts.find(attempt => attempt.status === 'verified')
    assert.ok(reservedAttempt && attempts.filter(attempt => attempt.status === 'unavailable').length === 1)
    await reservedAttempt.value.finish(false)
    const retry = await instanceB.verifyAndReserve('reserved', 5, matchPending)
    assert.equal(retry.status, 'verified', '退回最后一次正确尝试后仍可重试同一票据')
    await reservedAttempt.value.finish(true)
    assert.ok(await instanceA.get('reserved'), '过期的保留句柄不得清除同一票据的新保留')
    await retry.value.finish(true)
    assert.equal(await instanceA.get('reserved'), undefined)

    await instanceA.set('reserved', pendingTicket)
    const previous = await instanceA.verifyAndReserve('reserved', 5, matchPending)
    assert.equal(previous.status, 'verified')
    const renewedTicket = { ...pendingTicket, secret: 'renewed' }
    assert.equal(await instanceB.setIfUnreserved('reserved', renewedTicket), false, '正在确认的旧签发必须拒绝重发')
    assert.equal((await instanceA.get('reserved'))?.secret, pendingTicket.secret)
    await previous.value.finish(false)
    assert.equal(await instanceB.setIfUnreserved('reserved', renewedTicket), true, '原确认未准入并退回后可重新签发')
    const replacement = await instanceB.verifyAndReserve('reserved', 5, matchPending)
    assert.equal(replacement.status, 'verified')
    await previous.value.finish(true)
    assert.equal((await instanceA.get('reserved'))?.secret, 'renewed', '旧签发清理不能删掉新签发')
    await replacement.value.finish(true)
    assert.equal(await instanceA.get('reserved'), undefined)

    // 旧 namespace 在滚动升级期间可能仍有票据；v2 不能读取或迁移这些未绑定密码状态的凭证。
    const oldReset = new RedisTicketStore<{ userId: string; accountKey: string; expireAt: number }>(
      'client-password-reset', (ticket) => ticket.expireAt,
    )
    const newReset = new RedisTicketStore<{ version: 2; passwordState: string; expireAt: number }>(
      'client-password-reset-v2', (ticket) => ticket.expireAt,
    )
    await oldReset.set('legacy-reset', { userId: '1', accountKey: 'email:fixture@example.test', expireAt: Date.now() + 60_000 })
    assert.equal(await newReset.take('legacy-reset'), undefined, 'v2 必须拒绝旧 namespace 票据')
    const { clientAuthService: resetAuthService } = await import('../src/services/client-auth.service.js')
    await assert.rejects(resetAuthService.resetPassword({
      account: 'fixture@example.test', resetToken: 'legacy-reset', newPassword: 'OrchidMountain927!',
    }), (error: unknown) => error instanceof Error && error.message === '重置凭证已失效')
    assert.ok(await oldReset.get('legacy-reset'), '业务拒绝不得消费旧 namespace 以外的数据')
    // 即使把旧结构放入新 namespace，也必须失败关闭。
    const malformedReset = new RedisTicketStore<{ userId: string; accountKey: string; expireAt: number }>(
      'client-password-reset-v2', (ticket) => ticket.expireAt,
    )
    await malformedReset.set('malformed-reset', { userId: '1', accountKey: 'email:fixture@example.test', expireAt: Date.now() + 60_000 })
    await assert.rejects(resetAuthService.resetPassword({
      account: 'fixture@example.test', resetToken: 'malformed-reset', newPassword: 'OrchidMountain927!',
    }), (error: unknown) => error instanceof Error && error.message === '重置凭证已失效')
    assert.equal(await malformedReset.take('malformed-reset'), undefined, '畸形票据拒绝后仍然只能消费一次')

    // 使用真实 Redis 与临时 SQLite 验证纠正、失败关门及并发只有一笔提交。
    const { AppDataSource } = await import('../src/config/data-source.js')
    const { initializeDatabaseInfrastructure } = await import('../src/database/database-strategy.js')
    const { initializeDatabaseSchemaIfNeeded } = await import('../src/config/database-bootstrap.js')
    const { getCurrentTransactionManager } = await import('../src/database/transaction-coordinator.js')
    const { ClientUser } = await import('../src/entities/client-user.entity.js')
    const { SysAuditLog } = await import('../src/entities/sys-audit-log.entity.js')
    const { hashPassword, verifyPassword } = await import('../src/utils/password.js')
    const { BizError } = await import('../src/utils/errors.js')
    try {
      await AppDataSource.initialize()
      await initializeDatabaseInfrastructure(AppDataSource)
      await initializeDatabaseSchemaIfNeeded(AppDataSource)
      const email = 'reset-redis@example.test', mobile = '13800138009'
      const originalHash = await hashPassword('PineCloud504!')
      const users = AppDataSource.getRepository(ClientUser)
      const audits = AppDataSource.getRepository(SysAuditLog)
      const user = await users.save({
        realName: '票据校验用户', email, emailVerifiedAt: new Date(), mobile,
        passwordHash: originalHash, accountType: 'personal', status: 'enabled', departmentName: '', staffVerified: false,
      })
      const resetToken = 'redis-reset-fixture'
      const reset = { account: email, resetToken, newPassword: 'OrchidMountain927!' }
      const ticket = {
        version: 2 as const, userId: user.id, accountKey: 'email:' + email, expireAt: Date.now() + 60_000,
        passwordState: createHash('sha256')
          .update(JSON.stringify(['client-password-reset-v2', BigInt(user.id).toString(), originalHash])).digest('hex'),
      }
      await newReset.set(resetToken, ticket)
      const key = prefix + 'ticket:client-password-reset-v2:' + createHash('sha256').update(resetToken).digest('hex')
      const originalCiphertext = await raw.get(key)
      const originalTtl = await raw.pttl(key)
      await assert.rejects(resetAuthService.resetPassword({ ...reset, newPassword: 'Alternate' + mobile + '!' }),
        (error: unknown) => error instanceof BizError && error.statusCode === 400 && /账号信息/.test(error.message))
      assert.ok(originalCiphertext && originalTtl > 0)
      assert.equal(await raw.get(key), originalCiphertext, '纠正前不得重新签发票据')
      assert.ok(await raw.pttl(key) <= originalTtl, '纠正前不得延长票据寿命')

      const commandClient = redisClient.getRedisClient()
      assert.ok(commandClient)
      const originalMulti = commandClient.multi
      let consumedInsideTransaction = false
      commandClient.multi = () => {
        consumedInsideTransaction = Boolean(getCurrentTransactionManager(AppDataSource))
        throw new Error('隔离夹具模拟消费命令未完成')
      }
      try {
        await assert.rejects(resetAuthService.resetPassword(reset),
          (error: unknown) => error instanceof BizError && error.statusCode === 503)
      } finally {
        commandClient.multi = originalMulti
      }
      assert.equal(consumedInsideTransaction, true, '原子消费必须在写事务中进行')
      assert.equal(await audits.countBy({ actionType: 'password_changed', targetId: user.id }), 0)
      const readPassword = async () => (await users.createQueryBuilder('user').addSelect('user.passwordHash')
        .where('user.id = :id', { id: user.id }).getOneOrFail()).passwordHash
      assert.equal(await readPassword(), originalHash)
      assert.equal(await raw.get(key), originalCiphertext)

      const settled = await Promise.allSettled([resetAuthService.resetPassword(reset), resetAuthService.resetPassword(reset)])
      assert.equal(settled.filter(result => result.status === 'fulfilled').length, 1)
      assert.ok(settled.some(result => result.status === 'rejected' && result.reason instanceof BizError
        && result.reason.statusCode === 400 && result.reason.message === '重置凭证已失效'))
      assert.equal(await raw.get(key), null, '成功消费后 Redis 中不再保留凭证')
      assert.equal(await audits.countBy({ actionType: 'password_changed', targetId: user.id }), 1)
      assert.equal(await verifyPassword(reset.newPassword, await readPassword()), true)
    } finally {
      if (AppDataSource.isInitialized) await AppDataSource.destroy()
    }

    // 伪造明文票据不能被接受
    await raw.set(ticketKeys[0], JSON.stringify({ code: '000000', secret: 'forged', expiresAt: Date.now() + 60_000 }))
    assert.equal(await instanceA.get('13800138000:register'), undefined, '未加密（伪造）的票据必须视为不存在')

    // 2. 验证码错误次数原子计数与并发正确答案只成功一次
    const codeStore = new VerificationCodeAttemptStore(new RedisTicketStore('verify-code', (ticket: { expiresAt: number }) => ticket.expiresAt))
    const codeTicket = { channel: 'mobile' as const, target: '13800138001', scene: 'register' as const, code: '123456', expiresAt: Date.now() + 60_000, failedAttempts: 0 }
    await codeStore.set('k1', codeTicket)
    const wrongResults = await Promise.all(Array.from({ length: 20 }, () => codeStore.consume('k1', '000000')))
    assert.equal(wrongResults.filter((item) => item === false).length, 5, '共享额度仅允许五次错码核验')
    assert.equal(wrongResults.filter((item) => item === null).length, 15, '超额请求不得再读取答案')
    assert.equal(await codeStore.consume('k1', '123456'), null, '并发错误五次后票据必须作废')
    await codeStore.set('k2', codeTicket)
    const rightResults = await Promise.all(Array.from({ length: 20 }, () => codeStore.consume('k2', '123456')))
    assert.equal(rightResults.filter((item) => item === true).length, 1, '并发提交正确答案只能成功一次')
    await codeStore.set('k3', codeTicket)
    for (let index = 0; index < 4; index += 1) assert.equal(await codeStore.consume('k3', '999999'), false)
    await codeStore.set('k3', codeTicket)
    for (let index = 0; index < 4; index += 1) assert.equal(await codeStore.consume('k3', '999999'), false)
    assert.equal(await codeStore.consume('k3', '123456'), true, '重新发送验证码后错误次数必须清零')

    const fixture = { code: 'fixture', secret: 'ticket-fixture', expiresAt: Date.now() + 60_000 }
    await instanceA.set('admitted', fixture)
    let laterAttempts: Promise<unknown[]> | undefined
    let comparisons = 0
    const admitted = await instanceA.verifyAndConsume('admitted', 5, (ticket) => {
      // 两个实例对象复用测试连接。先把其余预占命令送入 Redis，再发当前票据的消费命令。
      laterAttempts = Promise.all(Array.from({ length: 5 }, () => instanceB.verifyAndConsume('admitted', 5, () => {
        comparisons += 1
        return null
      })))
      return ticket.code
    })
    assert.deepEqual(await laterAttempts, [
      { status: 'mismatch', attemptsLeft: 3 },
      { status: 'mismatch', attemptsLeft: 2 },
      { status: 'mismatch', attemptsLeft: 1 },
      { status: 'mismatch', attemptsLeft: 0 },
      { status: 'unavailable' },
    ])
    assert.equal(comparisons, 4, '跨实例额度耗尽时不得再执行比对回调')
    assert.deepEqual(admitted, { status: 'verified', value: fixture.code }, '额度耗尽不影响已获准的正确请求')

    await instanceA.set('replacement', fixture)
    let reissued: Promise<void> | undefined
    const replaced = await instanceA.verifyAndConsume('replacement', 5, (ticket) => {
      reissued = instanceB.set('replacement', { ...ticket, code: 'replacement-fixture' })
      return true
    })
    await reissued
    assert.equal(replaced.status, 'unavailable', '旧票据不能核验通过或消费改发后的新票据')
    assert.deepEqual(await instanceB.verifyAndConsume('replacement', 5, (ticket) => ticket.code),
      { status: 'verified', value: 'replacement-fixture' })

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

    // 3b. 共享查询缓存：命中、同进程单飞、过期回源
    const { getOrLoadShared, sharedCacheKey } = await import('../src/redis/redis-cache.js')
    let loads = 0
    const cacheKey = sharedCacheKey('verify', 'report', 'q1')
    const loader = async () => {
      loads += 1
      await delay(30)
      return { rows: [{ id: 1, name: '报表行' }], total: 1 }
    }
    const concurrent = await Promise.all(Array.from({ length: 10 }, () => getOrLoadShared(cacheKey, 300, loader)))
    assert.equal(loads, 1, '同一键的并发未命中只回源一次')
    assert.deepEqual(concurrent[9], { rows: [{ id: 1, name: '报表行' }], total: 1 })
    await delay(20)
    assert.equal(JSON.parse(await raw.get(cacheKey) ?? 'null')?.total, 1, '结果应写入 Redis 供其他实例复用')
    await getOrLoadShared(cacheKey, 300, loader)
    assert.equal(loads, 1, '有效期内再次读取应命中共享缓存')
    await delay(350)
    await getOrLoadShared(cacheKey, 300, loader)
    assert.equal(loads, 2, '过期后必须回源数据库')

    // 3c. 业务提交失效、HTTP 与服务去重、单实例与多实例的响应时序。
    {
      const express = (await import('express')).default
      const { env } = await import('../src/config/env.js')
      const { businessDataCacheInvalidation, BUSINESS_DATA_CACHE_GENERATION, invalidateBusinessDataAfterCommit } = await import('../src/middleware/business-data-cache.middleware.js')
      const { bumpSharedCacheGeneration, getOrLoadSharedVersioned, readSharedCacheGeneration } = await import('../src/redis/redis-cache.js')
      const app = express()
      app.use(businessDataCacheInvalidation)
      const endedWithinHandler: boolean[] = []
      app.post('/api/orders/submit', (_req, res) => {
        invalidateMallCatalogReadCache()
        res.json({ code: 0 })
        endedWithinHandler.push(res.writableEnded)
      })
      app.post('/api/orders/1/restore', (_req, res) => {
        res.destroy()
        invalidateMallCatalogReadCache()
      })
      app.post('/api/o2o/mall/preorders/1/cancel', (_req, res) => {
        invalidateMallCatalogReadCache()
        res.status(409).json({ code: 409 })
      })
      app.post('/api/orders/invalid', (_req, res) => { res.status(400).json({ code: 400 }) })
      const unaffected = [
        '/api/auth/login', '/api/Client-Auth/Login/', '/api/v1/Mobile-Auth/Refresh/',
        '/api/Orders/Merges/Preview/', '/api/Products/Labels/', '/api/data-maintenance/export/json',
        '/api/client-feedback/conversations/1/messages', '/api/notifications/inbox/1/read', '/api/users/1/restore',
        '/api/inbound/supplier/submit', '/api/inventory/stocktakes/1/count',
      ]
      const relevant = ['/api/Client-Feedback/Restock-Requests/', '/api/Data-Maintenance/Import/Json/']
      app.post([...unaffected, ...relevant], (_req, res) => { res.json({ code: 0 }) })
      app.patch('/api/o2o/orders/1/kingdee-registration', (_req, res) => { res.json({ code: 0 }) })
      const printedOrders = new Set<string>()
      const endedPrintWithinHandler: boolean[] = []
      app.post('/api/o2o/mall/preorders/:id/customer-order-print', (req, res) => {
        if (!printedOrders.has(req.params.id)) {
          printedOrders.add(req.params.id)
          invalidateBusinessDataAfterCommit()
        }
        res.status(req.params.id === 'audit-failure' ? 500 : 200).json({ code: 0 })
        endedPrintWithinHandler.push(res.writableEnded)
      })
      const server = app.listen(0, '127.0.0.1')
      await new Promise((resolve) => server.once('listening', resolve))
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
      try {
        let reportLoads = 0
        const loadReport = () => getOrLoadSharedVersioned(BUSINESS_DATA_CACHE_GENERATION, sharedCacheKey('verify', 'report-versioned'), 60_000, async () => {
          reportLoads += 1
          return { loads: reportLoads }
        })
        await loadReport()
        await delay(20)
        await loadReport()
        assert.equal(reportLoads, 1, '代际未变时命中缓存')
        const before = Number(await readSharedCacheGeneration(BUSINESS_DATA_CACHE_GENERATION))
        await fetch(`${base}/api/orders/invalid`, { method: 'POST' })
        for (const route of unaffected) {
          const response = await fetch(base + route, { method: 'POST' })
          assert.equal(response.status, 200, route)
          await response.json()
        }
        assert.equal(Number(await readSharedCacheGeneration(BUSINESS_DATA_CACHE_GENERATION)), before, '失败、只读与无关写入不得递增代际')
        for (const route of relevant) assert.equal((await fetch(base + route, { method: 'POST' })).status, 200, route)
        assert.equal((await fetch(base + '/api/o2o/orders/1/kingdee-registration', { method: 'PATCH' })).status, 200)
        assert.equal(Number(await readSharedCacheGeneration(BUSINESS_DATA_CACHE_GENERATION)), before + 3, '补货、JSON 导入和金蝶登记必须失效')
        assert.equal((await fetch(base + '/api/orders/submit', { method: 'POST' })).status, 200)
        assert.deepEqual(endedWithinHandler, [true], '单实例响应不等待 Redis')
        assert.equal(Number(await readSharedCacheGeneration(BUSINESS_DATA_CACHE_GENERATION)), before + 4, 'HTTP 与商城服务重叠时只递增一次')
        assert.deepEqual(await loadReport(), { loads: 2 }, '写入后的查询必须回源')

        env.Y_LINK_MULTI_INSTANCE = true
        assert.equal((await fetch(base + '/api/orders/submit', { method: 'POST' })).status, 200)
        assert.deepEqual(endedWithinHandler, [true, false], '多实例必须延后结束响应以等待同一次递增')
        const generationKey = sharedCacheKey('generation', BUSINESS_DATA_CACHE_GENERATION)
        assert.equal(Number(await raw.get(generationKey)), before + 5, '收到写响应时独立 Redis 连接可读取新代际')
        assert.equal((await fetch(base + '/api/o2o/mall/preorders/1/cancel', { method: 'POST' })).status, 409)
        assert.equal(Number(await raw.get(generationKey)), before + 6, '返回 409 前已提交的变更不能丢失')
        await assert.rejects(() => fetch(base + '/api/orders/1/restore', { method: 'POST' }))
        assert.equal(Number(await readSharedCacheGeneration(BUSINESS_DATA_CACHE_GENERATION)), before + 7, '客户端断开后提交的变更不能丢失')
        invalidateMallCatalogReadCache({ affectsBusinessData: false })
        assert.equal(Number(await readSharedCacheGeneration(BUSINESS_DATA_CACHE_GENERATION)), before + 7, '仅商城展示更新不会使经营数据失效')
        invalidateMallCatalogReadCache()
        assert.equal(Number(await readSharedCacheGeneration(BUSINESS_DATA_CACHE_GENERATION)), before + 8, 'HTTP 外提交的变更也要使经营数据失效')

        await loadReport()
        const cachedLoads = reportLoads
        const commandClient = redisClient.getRedisClient()
        assert.ok(commandClient)
        const originalIncr = commandClient.incr
        try {
          commandClient.incr = (async () => { throw new Error('模拟递增失败') }) as typeof commandClient.incr
          await bumpSharedCacheGeneration(BUSINESS_DATA_CACHE_GENERATION)
        } finally {
          commandClient.incr = originalIncr
        }
        assert.deepEqual(await loadReport(), { loads: cachedLoads + 1 }, '递增失败的本实例继续回源，不能读旧 Redis 代际')
        assert.equal(Number(await readSharedCacheGeneration(BUSINESS_DATA_CACHE_GENERATION)), before + 9, 'Redis 恢复后必须补递增')

        const print = (id: string) => fetch(base + '/api/O2O/Mall/Preorders/' + id + '/Customer-Order-Print/', { method: 'POST' })
        assert.equal((await print('first')).status, 200)
        assert.equal(Number(await raw.get(generationKey)), before + 10, '首次打印修改正式出库单后，只更新一次经营缓存代际')
        assert.equal((await print('first')).status, 200)
        assert.equal(Number(await raw.get(generationKey)), before + 10, '重复打印未更改正式单，成功返回也不补增')
        assert.equal((await print('audit-failure')).status, 500)
        assert.equal(Number(await raw.get(generationKey)), before + 11, '打印已提交后，即使审计失败仍需失效')
        assert.deepEqual(endedPrintWithinHandler, [false, true, false], '多实例的打印响应只等待已有的失效操作')
      } finally {
        env.Y_LINK_MULTI_INSTANCE = false
        await new Promise((resolve) => server.close(resolve))
      }
    }

    // 4. 消息总线：本实例发出的消息其他实例能收到，本实例不回环；其他实例的消息能触发处理器
    // 订阅连接断开后重新就绪：重新订阅并触发补齐回调（Pub/Sub 不补发断开期间的消息）
    let resyncCount = 0
    const stopResync = redisBus.onRedisBusResync(() => { resyncCount += 1 })
    redisClient.getRedisSubscriber()?.emit('ready')
    for (let index = 0; index < 20 && resyncCount === 0; index += 1) await delay(50)
    stopResync()
    assert.equal(resyncCount, 1, '订阅连接重新就绪后必须触发总线补齐回调')
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
    const remoteRevisions: number[] = []
    const unsubscribeRemoteRevision = subscribeMallCatalogRemoteInvalidation(() => remoteRevisions.push(readMallCatalogRevision()))
    invalidateMallCatalogReadCache({ affectsBusinessData: false })
    await raw.publish(`${prefix}bus:cache:mall-catalog`, JSON.stringify({ o: 'other-instance', p: null }))
    await delay(300)
    unsubscribeRemoteRevision()
    assert.equal(readMallCatalogRevision(), revisionBefore + 2, '本地与远端商城写入均应刷新本地目录修订')
    assert.deepEqual(remoteRevisions, [revisionBefore + 2], '仅远端广播通知监听者，通知前修订已更新')

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
    await assert.rejects(async () => store.verifyAndConsume('k', 5, () => {
      assert.fail('Redis 不可用时不得执行票据比对')
    }), (error: unknown) => error instanceof BizError && error.statusCode === 503)

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
    await persistentRiskStateService.resetFailure(redisLockKey)
    assert.equal(await riskRepository.countBy({ bucketDigest: redisLockDigest }), 0, '清零失败状态必须同时删除数据库镜像，避免 Redis 再故障时旧计数复活')

    // 商城目录二级缓存：快照按集群修订号写入 Redis；目录失效后修订号递增，提交后的读取不会命中旧快照。
    const { o2oPreorderService } = await import('../src/services/o2o-preorder.service.js')
    const { invalidateMallCatalogReadCache, readMallCatalogClusterRevision } = await import('../src/services/mall-catalog-revision.service.js')
    const cacheClient = redisClient.getRedisClient()
    assert.ok(cacheClient)
    const revisionBefore = await readMallCatalogClusterRevision()
    assert.ok(revisionBefore !== null, 'Redis 就绪时应能读到集群修订号')
    const oldSnapshot = JSON.stringify({ code: 0, message: 'ok', data: { list: [], storefront: {
      businessHoursText: '10:00 - 22:00', mallAnnouncementText: '', pickupWindowHours: 24,
    } } })
    await cacheClient.set(redisClient.redisKey('cache', 'mall-products', revisionBefore), oldSnapshot, 'EX', 10)
    const firstSnapshot = await o2oPreorderService.getMallProductsPublicSnapshot()
    assert.equal(firstSnapshot.data.storefront.pickupAddress, '海右书院112房间', '共享缓存不能返回滚动升级前缺少地址的快照')
    await delay(50)
    const sharedKey = redisClient.redisKey('cache', 'mall-products-v2', revisionBefore)
    assert.equal(await cacheClient.get(sharedKey), firstSnapshot.responseBody, '目录快照应按集群修订号写入 Redis')
    invalidateMallCatalogReadCache()
    const revisionAfter = await readMallCatalogClusterRevision()
    assert.equal(Number(revisionAfter), Number(revisionBefore) + 1, '目录失效必须递增集群修订号')
    const secondSnapshot = await o2oPreorderService.getMallProductsPublicSnapshot()
    await delay(50)
    assert.equal(await cacheClient.get(redisClient.redisKey('cache', 'mall-products-v2', revisionAfter as string)), secondSnapshot.responseBody, '失效后应按新修订号重建并写入')
    assert.equal(secondSnapshot.etag, firstSnapshot.etag, '内容未变时各实例生成的 ETag 一致')
    console.log('[redis-verify] 恢复场景：登录锁定双向兜底、商城目录二级缓存与集群修订号 通过')
  } finally {
    await redisClient.closeRedis()
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------------------------
// 子场景：未配置 Redis → 有界进程内查询缓存与单实例退化策略
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
    const { bumpSharedCacheGeneration, getOrLoadShared, getOrLoadSharedVersioned, getSharedCacheSnapshot } = await import('../src/redis/redis-cache.js')
    let rawLoads = 0
    const loadRaw = () => getOrLoadShared('raw', 60_000, async () => ++rawLoads)
    assert.deepEqual(await Promise.all([loadRaw(), loadRaw()]), [1, 1], '无 Redis 时普通读穿仍合并并发回源')
    assert.equal(await loadRaw(), 2, '无代际的键只单飞，不持久缓存')

    const generation = 'verify-local'
    let loads = 0
    const load = (key: string) => getOrLoadSharedVersioned(generation, key, 60_000, async () => ({
      rows: [{ id: ++loads }],
    }))
    const [first, concurrent] = await Promise.all([load('dashboard:admin'), load('dashboard:admin')])
    assert.equal(loads, 1, '无 Redis 时同代际只执行一次加载')
    first.rows[0].id = 999
    assert.equal(concurrent.rows[0].id, 1, '同批响应对象互相隔离')
    assert.equal((await load('dashboard:admin')).rows[0].id, 1, '修改响应不得污染 L1')
    assert.equal((await load('dashboard:staff')).rows[0].id, 2, '不同视角的完整键不可混用')

    let releaseOld = () => {}
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve })
    const old = getOrLoadSharedVersioned(generation, 'report', 60_000, async () => {
      await oldGate
      return '写入前'
    })
    await bumpSharedCacheGeneration(generation)
    assert.equal(await getOrLoadSharedVersioned(generation, 'report', 60_000, async () => '写入后'), '写入后', '新读不能加入旧代单飞')
    releaseOld()
    assert.equal(await old, '写入前')
    assert.equal(await getOrLoadSharedVersioned(generation, 'report', 60_000, async () => '不应回源'), '写入后', '旧代完成后不能覆盖新代')
    assert.equal((await load('dashboard:admin')).rows[0].id, 3, '同一业务代际的既有键同步失效')

    const loadExpiring = () => getOrLoadSharedVersioned(generation, 'expires', 1, async () => ++loads)
    assert.equal(await loadExpiring(), 4)
    await delay(10)
    assert.equal(await loadExpiring(), 5, 'L1 过期后重新读取')
    for (let index = 0; index < 129; index += 1) {
      await getOrLoadSharedVersioned(generation, 'entry:' + index, 60_000, async () => index)
    }
    assert.equal(getSharedCacheSnapshot().localEntries, 128, 'L1 条数上限为 128')
    assert.equal(await getOrLoadSharedVersioned(generation, 'entry:0', 60_000, async () => -1), -1, '超过条数上限时淘汰旧条目')
    const bigValue = 'x'.repeat(3 * 1024 * 1024)
    for (let index = 0; index < 3; index += 1) {
      await getOrLoadSharedVersioned(generation, 'large:' + index, 60_000, async () => bigValue)
    }
    assert.ok(getSharedCacheSnapshot().localBytes <= 8 * 1024 * 1024, 'L1 同时受总字节约束')
    assert.equal(await getOrLoadSharedVersioned(generation, 'large:0', 60_000, async () => '已淘汰'), '已淘汰', '超过总字节上限时淘汰旧条目')
    console.log('[redis-verify] 未启用场景：单飞、L1 隔离、代际、过期和容量 通过')
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
