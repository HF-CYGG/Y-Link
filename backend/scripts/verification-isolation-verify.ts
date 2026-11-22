/**
 * 文件职责：验证15个独立raw入口及schema worker不受ENV_FILE/runtime override污染，MySQL创建/清理须有独占所有权。
 * 实现逻辑：只使用专造哨兵SQLite和MySQL替身；子进程在首次真实连接前由探针停止，网络调用一律拒绝。
 * 维护说明：这是隔离门禁回归，不代替各入口的完整业务验收；禁止以连接替身声称MySQL业务已通过。
 */
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import sqlite3 from 'sqlite3'
import { createOwnedVerificationDatabase, verificationDatabaseName } from './owned-verification-database.js'

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const probe = path.join(backendRoot, 'scripts/fixtures/verification-isolation-probe.cjs')
const cli = path.join(backendRoot, 'node_modules/tsx/dist/cli.mjs')
const sentinelName = 's'.repeat(60)
const config = { host: '127.0.0.1', port: 22001, user: 'fixture', password: randomBytes(24).toString('hex') }

// 真实npm/驱动形状的替身，只替代远端服务器，不替代待验证的所有权算法。
function fakeServer() {
  const queries: string[] = [], opened: typeof config[] = []
  let serverId = 'server-a', owner = '', targetDatabase = '', failure = '', connections = 0, ended = 0, nonEmpty = false
  return {
    queries, opened,
    setFailure: (value: string) => { failure = value },
    setServer: (value: string) => { serverId = value },
    setOwner: (value: string) => { owner = value },
    setNonEmpty: (value: boolean) => { nonEmpty = value },
    get connections() { return connections }, get ended() { return ended },
    open: async (connection: typeof config) => {
      opened.push({ ...connection }); connections++
      return {
        async query(sql: string, values?: unknown[]) {
          queries.push(sql)
          if (sql.startsWith('SELECT @@server_uuid')) return [[{ serverId }], []]
          if (failure && sql.startsWith(failure)) throw new Error('专造失败')
          if (sql.startsWith('INSERT INTO')) { owner = String(values?.[0]); targetDatabase = String(values?.[1]) }
          if (sql.startsWith('SELECT token,')) return [[{ token: owner, targetDatabase }], []]
          if (sql.startsWith('SELECT TABLE_NAME FROM information_schema.TABLES')) return [nonEmpty ? [{ TABLE_NAME: 'sentinel' }] : [], []]
          return [[], []]
        },
        async end() { ended++ },
      }
    },
  }
}

await test('60字符源库名必须为完整随机后缀预留空间，不能与源或另一轮碰撞', () => {
  const first = verificationDatabaseName(sentinelName, '1'.repeat(24))
  const second = verificationDatabaseName(sentinelName, '2'.repeat(24))
  assert.equal(first.length, 60); assert.notEqual(first, sentinelName); assert.notEqual(first, second)
  assert.ok(first.endsWith('_verify_' + '1'.repeat(24)))
})
for (const failure of ['CREATE DATABASE', 'CREATE TABLE', 'INSERT INTO', 'COMMIT']) {
  await test(`${failure}失败不得尝试DROP或报告成功`, async () => {
    const fake = fakeServer(); fake.setFailure(failure)
    await assert.rejects(createOwnedVerificationDatabase(config, verificationDatabaseName('fixture'), fake.open), /MYSQL_VERIFICATION_(CREATE|OWNER_MARKER)_FAILED/)
    assert.equal(fake.queries.some(sql => sql.startsWith('DROP')), false)
    assert.equal(fake.connections, fake.ended)
  })
}
await test('同步前必须重新证明所有权及真实空库，非空或归属改变均拒绝', async () => {
  const fake = fakeServer(), owned = await createOwnedVerificationDatabase(config, verificationDatabaseName('auth_fixture'), fake.open)
  await owned.assertEmpty()
  fake.setNonEmpty(true)
  await assert.rejects(owned.assertEmpty(), /MYSQL_VERIFICATION_TARGET_NOT_EMPTY/)
  fake.setNonEmpty(false); fake.setServer('other-server')
  await assert.rejects(owned.assertEmpty(), /MYSQL_VERIFICATION_OWNERSHIP_LOST/)
  assert.equal(fake.queries.some(sql => /ALTER|DROP|synchronize/i.test(sql)), false)
})
for (const changed of ['server', 'owner']) {
  await test(`清理时${changed}已变更，必须保留目标且真实失败`, async () => {
    const fake = fakeServer(), owned = await createOwnedVerificationDatabase(config, verificationDatabaseName('fixture'), fake.open)
    if (changed === 'server') fake.setServer('other-server'); else fake.setOwner('other-owner')
    await assert.rejects(owned.cleanup(), /MYSQL_VERIFICATION_OWNERSHIP_LOST/)
    assert.equal(fake.queries.some(sql => sql.startsWith('DROP')), false)
    assert.equal(fake.connections, fake.ended)
  })
}
await test('异常后的合法清理只删除自身目标一次，使用创建时连接身份', async () => {
  const fake = fakeServer(), mutableConfig = { ...config }, name = verificationDatabaseName('fixture')
  const owned = await createOwnedVerificationDatabase(mutableConfig, name, fake.open)
  mutableConfig.host = 'must-not-connect.invalid'
  try { throw new Error('业务验收失败') } catch { await owned.cleanup() }
  await owned.cleanup()
  assert.equal(fake.queries.filter(sql => sql === `DROP DATABASE \`${name}\``).length, 1)
  assert.equal(fake.queries.some(sql => /IF NOT EXISTS|DROP DATABASE IF EXISTS/.test(sql)), false)
  assert.ok(fake.opened.every(value => value.host === config.host))
  assert.equal(fake.connections, fake.ended)
})
await test('DROP失败仍真实失败，重试必须重新核对所有权', async () => {
  const fake = fakeServer(), owned = await createOwnedVerificationDatabase(config, verificationDatabaseName('fixture'), fake.open)
  fake.setFailure('DROP DATABASE')
  await assert.rejects(owned.cleanup(), /专造失败/)
  fake.setFailure(''); fake.setOwner('other-owner')
  await assert.rejects(owned.cleanup(), /MYSQL_VERIFICATION_OWNERSHIP_LOST/)
  assert.equal(fake.queries.filter(sql => sql.startsWith('DROP DATABASE')).length, 1)
  assert.equal(fake.connections, fake.ended)
})
await test('发布回归保留原0900排序规则，不因资源所有权保护改变建库语义', async () => {
  const fake = fakeServer()
  const owned = await createOwnedVerificationDatabase({ ...config, collation: 'utf8mb4_0900_ai_ci' }, verificationDatabaseName('release'), fake.open)
  assert.ok(fake.queries.some(sql => sql.startsWith('CREATE DATABASE') && sql.endsWith('COLLATE utf8mb4_0900_ai_ci')))
  await owned.cleanup()
})
await test('所有权元数据只在伴随控制库，被测目标仍可接受原空库/结构强校验', async () => {
  const fake = fakeServer(), name = verificationDatabaseName('business')
  const owned = await createOwnedVerificationDatabase(config, name, fake.open)
  assert.notEqual(owned.ownerDatabase, name)
  assert.equal(fake.queries.some(sql => sql.startsWith(`CREATE TABLE \`${name}\`.`)), false)
  assert.ok(fake.queries.some(sql => sql.startsWith(`CREATE TABLE \`${owned.ownerDatabase}\`.`)))
  await owned.cleanup()
})

const entries = [
  'auth-sse-final-regression-verify', 'inbound-verified-delete-verify', 'inventory-stock-management-verify',
  'report-inventory-verify', 'product-yz-code-verify', 'order-content-edit-verify', 'order-merge-verify',
  'order-merge-o2o-verify', 'manual-order-sku-verify', 'database-concurrency-target-verify', 'verify-db-concurrency',
  'order-identifier-review-fixes-verify', 'task6-client-core-flow-verify', 'verification-aliyun-verify', 'release-full-regression-verify',
] as const
const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'ylink-isolation-sentinel-'))
const sentinel = path.join(root, 'sentinel.sqlite'), dataRoot = path.join(root, 'sentinel-data'), hostileEnv = path.join(root, 'sentinel.env')
const snapshot = (target: string): unknown => fs.statSync(target).isDirectory()
  ? fs.readdirSync(target).sort().map(name => [name, snapshot(path.join(target, name))])
  : createHash('sha256').update(fs.readFileSync(target)).digest('hex')

try {
  // 唯一实际数据库是本测试刚创建的哨兵，内容/文件集合必须逐字保持。
  await new Promise<void>((resolve, reject) => {
    const database = new sqlite3.Database(sentinel, error => {
      if (error) { reject(error); return }
      database.exec('CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES (\'不得初始化或删除\')', error => {
        database.close(closeError => error || closeError ? reject(error || closeError) : resolve())
      })
    })
  })
  fs.mkdirSync(path.join(dataRoot, 'runtime'), { recursive: true })
  fs.writeFileSync(path.join(dataRoot, 'runtime/database-runtime-override.json'), JSON.stringify({ version: 1,
    config: { DB_TYPE: 'sqlite', SQLITE_DB_PATH: sentinel, DB_SYNC: true }, updatedAt: new Date().toISOString() }))
  fs.writeFileSync(hostileEnv, ['DB_TYPE=sqlite', `SQLITE_DB_PATH=${sentinel.replaceAll('\\', '/')}`,
    `Y_LINK_DATA_DIR=${dataRoot.replaceAll('\\', '/')}`, 'Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE=false',
    'APP_PROFILE=sentinel-business', 'REDIS_URL=redis://127.0.0.1:1/0'].join('\n'))
  const before = snapshot(dataRoot), databaseBefore = snapshot(sentinel)
  let sequence = 0
  function run(entry: string, extra: NodeJS.ProcessEnv = {}, args: string[] = []) {
    const output = path.join(root, `probe-${++sequence}.jsonl`)
    const env: NodeJS.ProcessEnv = { ...process.env,
      ENV_FILE: hostileEnv, APP_PROFILE: 'sentinel-business', DB_TYPE: 'sqlite', SQLITE_DB_PATH: sentinel,
      DB_NAME: sentinelName, DB_HOST: config.host, DB_PORT: String(config.port), DB_USER: config.user, DB_PASSWORD: config.password,
      Y_LINK_DATA_DIR: dataRoot, Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE: 'false', REDIS_URL: 'redis://127.0.0.1:1/0',
      // 只继承这一个可审阅探针；不能带宿主其它NODE_OPTIONS预加载应用。
      NODE_OPTIONS: `--require "${probe.replaceAll('\\', '/')}"`, Y_LINK_ISOLATION_PROBE_FILE: output,
      TSX_TSCONFIG_PATH: path.join(backendRoot, 'tsconfig.json'),
      Y_LINK_DB_CONCURRENCY_REPORT_PATH: path.join(root, `report-${sequence}.json`),
      VERIFY_DB_CONCURRENCY_MYSQL_HOST: config.host, VERIFY_DB_CONCURRENCY_MYSQL_PORT: String(config.port),
      VERIFY_DB_CONCURRENCY_MYSQL_USER: config.user, VERIFY_DB_CONCURRENCY_MYSQL_PASSWORD: config.password,
      ...extra,
    }
    // 直接Node注册TS加载器，避免tsx CLI额外创建IPC socket；探针仍禁止所有Socket.connect。
    const result = spawnSync(process.execPath, ['--import', 'tsx',
      path.join(backendRoot, 'scripts', entry + '.ts'), ...args], {
      cwd: backendRoot, env, encoding: 'utf8', windowsHide: true, timeout: 45_000,
    })
    const records = fs.existsSync(output) ? fs.readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
    assert.deepEqual(snapshot(dataRoot), before, `${entry}不得修改哨兵数据目录`)
    assert.deepEqual(snapshot(sentinel), databaseBefore, `${entry}不得修改哨兵数据库`)
    assert.equal(fs.existsSync(sentinel + '-wal') || fs.existsSync(sentinel + '-shm'), false)
    return { result, records, report: env.Y_LINK_DB_CONCURRENCY_REPORT_PATH! }
  }
  function assertConnectionProbe(runResult: ReturnType<typeof run>, mysql: boolean, worker = false) {
    assert.equal(runResult.result.status, 86, `入口必须到达受控连接探针；错误输出：${(runResult.result.stderr ?? '').slice(-2000)}`)
    const probes = runResult.records.filter(value => value.event === 'before-connect')
    assert.equal(probes.filter(value => !value.worker).length, 1)
    if (worker) assert.ok(probes.some(value => value.worker), '必须覆盖真实schema worker')
    for (const value of probes) {
      assert.ok(value.context, '每个raw入口都必须提供实际目标证明')
      assert.notEqual(value.context.rootDir, dataRoot)
      assert.equal(value.context.envFile, value.envFile); assert.notEqual(value.envFile, hostileEnv)
      assert.equal(value.skip, 'true'); assert.equal(value.redis, '')
      assert.equal(value.profile, value.context.profile); assert.equal(value.cwd, value.context.rootDir)
      assert.ok(Object.values(value.appDataPaths).every(target => {
        const relative = path.relative(value.context.rootDir, String(target))
        return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)
      }))
      assert.equal(value.options.type, mysql ? 'mysql' : 'sqlite')
      assert.equal(value.options.database, value.context.target.database)
      if (mysql) {
        assert.equal(value.options.host, config.host); assert.equal(Number(value.options.port), config.port)
        assert.notEqual(value.options.database, sentinelName)
      } else assert.notEqual(path.resolve(value.options.database), sentinel)
    }
    const sql = runResult.records.filter(value => value.event === 'sql').map(value => value.sql as string)
    for (const opened of runResult.records.filter(value => value.event === 'admin-open')) {
      assert.equal(opened.host, config.host); assert.equal(opened.port, config.port)
      assert.notEqual(opened.database, sentinelName)
    }
    assert.equal(sql.some(value => value.includes('`' + sentinelName + '`')), false, '不能操作60字符哨兵库')
    assert.equal(sql.some(value => /CREATE DATABASE IF NOT EXISTS/.test(value)), false)
  }
  for (const entry of entries) {
    await test(`raw入口${entry}：污染配置不能初始化/删除哨兵`, () => {
      const mysql = entry === 'verify-db-concurrency'
      assertConnectionProbe(run(entry, {}, entry === 'auth-sse-final-regression-verify' ? ['--case=admin-race'] : []), mysql)
    })
  }
  for (const entry of ['database-concurrency-target-verify', 'release-full-regression-verify', 'auth-sse-final-regression-verify']) {
    const extra = entry === 'database-concurrency-target-verify' ? { Y_LINK_DB_CONCURRENCY_TARGET: 'mysql' }
      : entry === 'release-full-regression-verify' ? { RELEASE_REGRESSION_MYSQL_PORT: String(config.port), RELEASE_REGRESSION_MYSQL_USER: config.user,
        RELEASE_REGRESSION_MYSQL_PASSWORD: config.password, RELEASE_REGRESSION_MYSQL_CONFIRM_TEST_SERVER: 'true' }
        : { AUTH_SSE_VERIFY_MYSQL_HOST: config.host, AUTH_SSE_VERIFY_MYSQL_PORT: String(config.port), AUTH_SSE_VERIFY_MYSQL_USERNAME: config.user,
          AUTH_SSE_VERIFY_MYSQL_PASSWORD: config.password, AUTH_SSE_VERIFY_MYSQL_DATABASE: 'ylink_probe_owned', AUTH_SSE_VERIFY_MYSQL_CONFIRM_TEST_SERVER: 'true' }
    await test(`${entry}：合法隔离MySQL最终目标/子进程同样受保护`, () => {
      assertConnectionProbe(run(entry, extra, entry.startsWith('auth-') ? ['--case=mysql-owner-lock'] : []), true, entry.startsWith('release-'))
    })
    await test(`${entry}：已存在/创建失败不DROP，必须非零失败`, () => {
      const failed = run(entry, { ...extra, Y_LINK_ISOLATION_PROBE_CREATE_FAILURE: 'true' })
      assert.notEqual(failed.result.status, 0); assert.notEqual(failed.result.status, 86)
      assert.equal(failed.records.some(value => value.event === 'sql' && value.sql.startsWith('DROP')), false)
      assert.equal(failed.records.some(value => value.event === 'before-connect'), false)
      if (entry.startsWith('database-')) assert.equal(JSON.parse(fs.readFileSync(failed.report, 'utf8')).status, 'failed')
    })
  }
  await test('显式已存在SQLite验收目标不得覆盖或删除', () => {
    const failed = run('database-concurrency-target-verify', { Y_LINK_DB_CONCURRENCY_SQLITE_PATH: sentinel })
    assert.equal(failed.result.status, 1)
    assert.equal(failed.records.some(value => value.event === 'before-connect'), false)
    assert.equal(JSON.parse(fs.readFileSync(failed.report, 'utf8')).status, 'failed')
  })
  await test('verify-db-concurrency原始入口创建失败不得DROP或报成功', () => {
    const failed = run('verify-db-concurrency', { Y_LINK_ISOLATION_PROBE_CREATE_FAILURE: 'true' })
    assert.equal(failed.result.status, 1)
    assert.equal(failed.records.some(value => value.event === 'sql' && value.sql.startsWith('DROP')), false)
    assert.equal(failed.records.some(value => value.event === 'before-connect'), false)
  })
  await test('schema worker缺少父进程独占证明时不能单独连接/初始化', () => {
    const failed = run('verification-schema-worker', { Y_LINK_VERIFICATION_CONTEXT: '' })
    assert.notEqual(failed.result.status, 0)
    assert.equal(failed.records.some(value => value.event === 'before-connect'), false)
  })
  await test('已固化目标被篡改时guard必须在任何prepare/连接前失败', () => {
    const helper = new URL('./verification-isolation.js', import.meta.url).href
    const source = new URL('../src/config/data-source.js', import.meta.url).href
    const code = `(async()=>{const assert=(await import('node:assert/strict')).default; const path=await import('node:path');
      const {createVerificationIsolation}=await import(${JSON.stringify(helper)});
      const isolation=createVerificationIsolation('negative-target');
      isolation.seal({type:'sqlite',database:path.join(isolation.rootDir,'safe.sqlite')});
      const {AppDataSource}=await import(${JSON.stringify(source)});
      AppDataSource.options.database=${JSON.stringify(sentinel)};
      await assert.rejects(isolation.assertTarget(AppDataSource),/VERIFICATION_TARGET_MISMATCH/);
      isolation.cleanup();})().catch(error=>{console.error(error);process.exitCode=1})`
    const result = spawnSync(process.execPath, [cli, '--tsconfig', path.join(backendRoot, 'tsconfig.json'), '--eval', code], {
      cwd: backendRoot, env: { ...process.env, NODE_OPTIONS: '', ENV_FILE: hostileEnv, Y_LINK_DATA_DIR: dataRoot },
      encoding: 'utf8', windowsHide: true, timeout: 45_000,
    })
    assert.equal(result.status, 0, result.stderr.slice(-2000))
    assert.deepEqual(snapshot(dataRoot), before); assert.deepEqual(snapshot(sentinel), databaseBefore)
  })
} finally {
  const resolved = fs.realpathSync(root)
  assert.equal(path.dirname(resolved), parent)
  assert.ok(path.basename(resolved).startsWith('ylink-isolation-sentinel-'))
  fs.rmSync(resolved, { recursive: true, force: true })
}
