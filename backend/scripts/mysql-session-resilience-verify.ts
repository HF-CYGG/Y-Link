/**
 * 模块说明：backend/scripts/mysql-session-resilience-verify.ts
 * 文件职责：在真实 MySQL 上验证连接会话的抗死锁与抗失联参数。
 * 验证内容：
 * - 每条池连接交付前都带上 UTC 时区、锁等待上限与空闲上限；
 * - 有事务持锁时，等待方在锁等待上限后失败，且错误被识别为“可重放的锁冲突”；
 * - 连接池空闲连接会按 DB_IDLE_TIMEOUT_MS 被应用主动回收（mysql2 只有 maxIdle < connectionLimit 时才回收）；
 * - 持锁事务的客户端不再发任何语句（模拟应用容器意外停止或网络中断）时，MySQL 在空闲上限后回滚该事务并释放行锁。
 * 运行方式：npm --prefix backend run mysql:session-resilience:verify
 * 依赖：本机 Docker（自动拉起并删除临时 mysql:8.4 容器），或通过 VERIFY_MYSQL_HOST/PORT/USER/PASSWORD 指向可丢弃的库；严禁指向生产库。
 * 耗时：约 1.5 分钟，其中约 65 秒用于等待服务端回收失联事务。
 */

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const findFreePort = () => new Promise<number>((resolve, reject) => {
  const server = net.createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as net.AddressInfo
    server.close(() => resolve(port))
  })
})

async function startDockerMysql(password: string): Promise<{ port: number; stop: () => void }> {
  const port = await findFreePort()
  const name = `ylink-mysql-session-verify-${process.pid}`
  execFileSync('docker', [
    'run', '-d', '--rm', '--name', name, '-e', `MYSQL_ROOT_PASSWORD=${password}`, '-e', 'MYSQL_DATABASE=y_link',
    '-p', `127.0.0.1:${port}:3306`, 'mysql:8.4', '--default-time-zone=+00:00',
  ], { stdio: 'pipe' })
  const stop = () => {
    try {
      execFileSync('docker', ['rm', '-f', name], { stdio: 'pipe' })
    } catch {
      // 容器可能已随 --rm 退出。
    }
  }
  process.once('exit', stop)
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const probe = spawnSync('docker', ['exec', name, 'mysql', '-uroot', `-p${password}`, '-e', 'SELECT 1', 'y_link'], { encoding: 'utf8' })
    if (probe.status === 0) return { port, stop }
    await delay(1000)
  }
  stop()
  throw new Error('临时 MySQL 容器未能在 2 分钟内就绪')
}

async function main() {
  const tempRoot = path.join(backendRoot, 'data', `mysql-session-verify-${process.pid}`)
  fs.mkdirSync(tempRoot, { recursive: true })
  let docker: { port: number; stop: () => void } | null = null
  try {
    const password = process.env.VERIFY_MYSQL_PASSWORD ?? `My${randomBytes(8).toString('hex')}!`
    if (!process.env.VERIFY_MYSQL_HOST) docker = await startDockerMysql(password)
    delete process.env.ENV_FILE
    Object.assign(process.env, {
      NODE_ENV: 'test',
      APP_PROFILE: `mysql-session-verify-${process.pid}`,
      DB_TYPE: 'mysql',
      DB_HOST: process.env.VERIFY_MYSQL_HOST ?? '127.0.0.1',
      DB_PORT: String(process.env.VERIFY_MYSQL_PORT ?? docker?.port),
      DB_USER: process.env.VERIFY_MYSQL_USER ?? 'root',
      DB_PASSWORD: password,
      DB_NAME: process.env.VERIFY_MYSQL_DATABASE ?? 'y_link',
      DB_POOL_SIZE: '4',
      DB_IDLE_TIMEOUT_MS: '1000',
      DB_LOCK_WAIT_TIMEOUT_SECONDS: '2',
      DB_SESSION_WAIT_TIMEOUT_SECONDS: '60',
      Y_LINK_DATA_DIR: path.join(tempRoot, 'data'),
      Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE: 'true',
    })

    const { AppDataSource } = await import('../src/config/data-source.js')
    const { initializeDatabaseInfrastructure } = await import('../src/database/database-strategy.js')
    const { isRetryableMysqlTransactionError } = await import('../src/utils/database-errors.js')
    await AppDataSource.initialize()
    await initializeDatabaseInfrastructure(AppDataSource)
    try {
      // 1. 会话参数：空闲上限取 max(配置 60, 池空闲回收 1 秒 + 60) = 61。
      const [session] = await AppDataSource.query(
        'SELECT @@session.time_zone AS tz, @@session.innodb_lock_wait_timeout AS lockWait, @@session.wait_timeout AS waitTimeout',
      ) as Array<{ tz: string; lockWait: number | string; waitTimeout: number | string }>
      assert.equal(session.tz, '+00:00')
      assert.equal(Number(session.lockWait), 2, '池连接必须带上配置的锁等待上限')
      assert.equal(Number(session.waitTimeout), 61, '池连接必须带上空闲上限，且不小于池空闲回收时间 + 60 秒')
      console.log('[mysql-session-verify] 会话参数：UTC、锁等待 2 秒、空闲上限 61 秒 通过')

      await AppDataSource.query('CREATE TABLE IF NOT EXISTS verify_lock_row (id INT PRIMARY KEY, val INT NOT NULL)')
      await AppDataSource.query('REPLACE INTO verify_lock_row (id, val) VALUES (1, 0)')

      // 2. 锁等待上限：持锁事务不提交时，等待方约 2 秒后失败，且错误可被幂等事务识别并重放。
      const holder = AppDataSource.createQueryRunner()
      await holder.connect()
      await holder.startTransaction()
      await holder.query('SELECT * FROM verify_lock_row WHERE id = 1 FOR UPDATE')
      const waitStartedAt = Date.now()
      const waitError = await AppDataSource.transaction(async (manager) => {
        await manager.query('SELECT * FROM verify_lock_row WHERE id = 1 FOR UPDATE')
      }).then(() => null, (error: unknown) => error)
      const waitedMs = Date.now() - waitStartedAt
      assert.ok(waitError, '持锁期间等待方必须失败')
      assert.equal(isRetryableMysqlTransactionError(waitError), true, '锁等待超时必须被识别为可重放的锁冲突')
      assert.ok(waitedMs >= 1500 && waitedMs < 10_000, `等待方应在约 2 秒后失败，实际 ${waitedMs}ms`)
      await holder.rollbackTransaction()
      await holder.release()
      console.log(`[mysql-session-verify] 锁等待上限：等待方 ${waitedMs}ms 后以可重放错误失败 通过`)

      // 3. 池空闲回收：空闲超过 1 秒的连接被应用主动关闭。
      const pool = (AppDataSource.driver as unknown as { pool: { _freeConnections: { length: number }; _allConnections: { length: number } } }).pool
      await Promise.all([1, 2, 3].map(() => AppDataSource.query('SELECT SLEEP(0.1)')))
      assert.ok(pool._allConnections.length >= 2, '并发查询应创建多条池连接')
      await delay(3500)
      assert.equal(pool._allConnections.length, 0, `空闲连接必须被回收，实际仍有 ${pool._allConnections.length} 条`)
      console.log('[mysql-session-verify] 连接池空闲回收生效 通过')

      // 4. 失联事务回收：持锁连接不再发送任何语句，模拟应用容器意外停止或网络中断。
      const vanished = AppDataSource.createQueryRunner()
      await vanished.connect()
      await vanished.startTransaction()
      await vanished.query('UPDATE verify_lock_row SET val = 99 WHERE id = 1')
      const vanishedAt = Date.now()
      let acquiredAfterMs = -1
      while (Date.now() - vanishedAt < 120_000) {
        try {
          await AppDataSource.transaction(async (manager) => {
            await manager.query('SELECT * FROM verify_lock_row WHERE id = 1 FOR UPDATE')
          })
          acquiredAfterMs = Date.now() - vanishedAt
          break
        } catch (error) {
          if (!isRetryableMysqlTransactionError(error)) throw error
        }
      }
      assert.ok(acquiredAfterMs > 0, '失联事务必须在空闲上限后被服务端回滚并释放行锁')
      const [row] = await AppDataSource.query('SELECT val FROM verify_lock_row WHERE id = 1') as Array<{ val: number }>
      assert.equal(Number(row.val), 0, '失联事务未提交的修改必须被回滚')
      await vanished.release().catch(() => undefined)
      console.log(`[mysql-session-verify] 失联事务：${Math.round(acquiredAfterMs / 1000)} 秒后被回滚、行锁释放 通过`)
    } finally {
      await AppDataSource.destroy().catch(() => undefined)
    }
    console.log('MySQL 会话抗死锁与抗失联验证通过')
  } finally {
    docker?.stop()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error)
  process.exit(1)
})
