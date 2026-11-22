/** 原生门禁的直接回归：内存实值、真实文件打开顺序、驱动身份缓存及失败重试。 */
import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import source from '../src/database/pinned-sqlite-source.json' with { type: 'json' }
import { ensureVerifiedSqliteDriver } from '../src/database/verified-sqlite-driver.js'
import { VerifiedDataSource } from '../src/database/verified-data-source.js'

function fixture() {
  const events: string[] = []
  const state = { version: source.version, sourceId: source.sourceId, failQuery: false, failClose: false }
  class Database {
    constructor(file: string, ...args: unknown[]) {
      events.push('open:' + file)
      const ready = args.at(-1) as (error: Error | null) => void
      queueMicrotask(() => ready(file === ':memory:' ? null : new Error('REAL_FILE_OPEN_BOUNDARY')))
    }
    all(sql: string, callback: (error: Error | null, rows: unknown[]) => void) {
      events.push(sql.startsWith('SELECT') ? 'engine-query' : 'compile-options')
      queueMicrotask(() => callback(state.failQuery ? new Error('QUERY_FAILED') : null,
        sql.startsWith('SELECT') ? [{ version: state.version, sourceId: state.sourceId }]
          : source.requiredOptions.map(compile_options => ({ compile_options }))))
    }
    close(callback: (error: Error | null) => void) {
      events.push('memory-close')
      queueMicrotask(() => callback(state.failClose ? new Error('CLOSE_FAILED') : null))
    }
  }
  const driver = { Database, VERSION: source.version, SOURCE_ID: source.sourceId, verbose() { return this } }
  return { driver, state, events }
}

test('头宏匹配但实际旧引擎必须在真实文件open前拒绝', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ylink-native-guard-'))
  try {
    const f = fixture()
    f.state.version = '3.44.2'
    const target = path.join(root, 'sentinel.sqlite')
    const ds = new VerifiedDataSource({ type: 'sqlite', database: target, driver: f.driver })
    await assert.rejects(ds.initialize(), /SQLITE_ENGINE_UNVERIFIED/)
    assert.deepEqual(f.events, ['open::memory:', 'engine-query', 'memory-close'])
    assert.equal(fs.existsSync(target), false)
    assert.equal(ds.isInitialized, false)
  } finally { fs.rmSync(root, { recursive: true }) }
})

test('同驱动并发共享成功结果，不同对象或构造器必须重新验证', async () => {
  const f = fixture()
  await Promise.all([ensureVerifiedSqliteDriver(f.driver), ensureVerifiedSqliteDriver(f.driver)])
  await ensureVerifiedSqliteDriver(f.driver)
  assert.equal(f.events.filter(event => event === 'open::memory:').length, 1)
  await ensureVerifiedSqliteDriver({ ...f.driver })
  assert.equal(f.events.filter(event => event === 'open::memory:').length, 2)
  const replacement = fixture()
  f.driver.Database = replacement.driver.Database
  await ensureVerifiedSqliteDriver(f.driver)
  assert.equal(replacement.events[0], 'open::memory:')
})

test('版本/查询/关闭失败不能缓存成功，下一次允许合法恢复', async () => {
  for (const failure of ['version', 'query', 'close'] as const) {
    const f = fixture()
    if (failure === 'version') f.state.sourceId = 'wrong-source'
    if (failure === 'query') f.state.failQuery = true
    if (failure === 'close') f.state.failClose = true
    await assert.rejects(ensureVerifiedSqliteDriver(f.driver), /SQLITE_ENGINE_UNVERIFIED/)
    f.state.sourceId = source.sourceId
    f.state.failQuery = false
    f.state.failClose = false
    await ensureVerifiedSqliteDriver(f.driver)
    assert.equal(f.events.filter(event => event === 'open::memory:').length, 2)
  }
})

test('校验在途更换构造器不得继承旧证明', async () => {
  const original = fixture()
  const replacement = fixture()
  const pending = ensureVerifiedSqliteDriver(original.driver)
  original.driver.Database = replacement.driver.Database
  await assert.rejects(pending, /SQLITE_ENGINE_UNVERIFIED/)
  await ensureVerifiedSqliteDriver(original.driver)
  assert.equal(replacement.events[0], 'open::memory:')
})

test('通过内存校验并关闭之后才进入TypeORM真实文件连接边界', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ylink-native-order-'))
  try {
    const f = fixture()
    const target = path.join(root, 'allowed.sqlite')
    const ds = new VerifiedDataSource({ type: 'sqlite', database: target, driver: f.driver })
    await assert.rejects(ds.initialize(), /REAL_FILE_OPEN_BOUNDARY/)
    assert.deepEqual(f.events.slice(0, 4), ['open::memory:', 'engine-query', 'compile-options', 'memory-close'])
    assert.equal(f.events[4], 'open:' + target)
  } finally { fs.rmSync(root, { recursive: true }) }
})

test('MySQL初始化不加载可选sqlite3，仍沿原MySQL驱动连接边界', async () => {
  const registry = Module as unknown as { _load: (name: string, ...args: unknown[]) => unknown }
  const load = registry._load
  let sqliteLoads = 0
  registry._load = function (name, ...args) {
    if (name === 'sqlite3') { sqliteLoads++; throw new Error('SQLITE_NOT_INSTALLED') }
    return load.call(this, name, ...args)
  }
  try {
    const ds = new VerifiedDataSource({ type: 'mysql', host: '127.0.0.1', database: 'unconnected_fixture',
      username: 'fixture', driver: { createPool() { throw new Error('MYSQL_CONNECT_BOUNDARY') } } })
    await assert.rejects(ds.initialize(), /MYSQL_CONNECT_BOUNDARY/)
    assert.equal(sqliteLoads, 0)
  } finally { registry._load = load }
})
