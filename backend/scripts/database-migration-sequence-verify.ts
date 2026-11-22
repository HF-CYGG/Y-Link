/** 自增状态不能只检查 MAX(id)：删除过的高位 ID 也不能在迁移后重新使用。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DataSource } from 'typeorm'
import { test } from 'node:test'
import { readMysqlGeneratedNextId } from '../src/utils/migration-autoincrement.js'

const database = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ylink-migration-sequence-')), 'fixture.sqlite')
const source = new DataSource({ type: 'sqlite', database, entities: [] })
await source.initialize()
try {
  await source.query('CREATE TABLE fixture (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT)')
  await source.query("INSERT INTO fixture(id, value) VALUES (1, '保留'), (9007199254740993, '删除的历史高位')")
  await source.query('DELETE FROM fixture WHERE id > 1')
  const { readSqliteGeneratedNextId } = await import('../src/utils/migration-autoincrement.js')
  assert.equal(await readSqliteGeneratedNextId(source, 'fixture', 'id'), 9007199254740994n)
  console.log('[migration-sequence] 删除高位 ID 及超过 Number 精度的自增状态通过')
} finally {
  await source.destroy()
}

function mysqlReaderFixture(options: { next?: string | null; fail?: string; cancel?: string } = {}) {
  const events: string[] = [], queryError = new Error('FIXTURE_SEQUENCE_QUERY_FAILURE'), restoreError = new Error('FIXTURE_SESSION_RESTORE_FAILURE')
  let expiry = '86400', released = false, destroyed = false, cancelled = false, connected = false, settingsReads = 0
  const runner = {
    async connect() { assert.equal(connected, false); connected = true; events.push('connect'); return { destroy() { destroyed = true; events.push('destroy') } } },
    async query(sql: string, parameters?: unknown[]) {
      assert.equal(connected, true); assert.equal(released, false); assert.equal(destroyed, false)
      if (sql.startsWith('SELECT CAST(@@session')) {
        events.push('read-expiry')
        if (++settingsReads > 1 && options.fail === 'restore-read') throw restoreError
        return [{ expiry: settingsReads > 1 && options.fail === 'restore-mismatch' ? '0' : expiry }]
      }
      if (sql === 'SET SESSION information_schema_stats_expiry = 0') {
        events.push('set-zero'); expiry = '0'
        if (options.cancel === 'after-set') cancelled = true
        if (options.fail === 'set') throw queryError
        return []
      }
      if (sql === 'SET SESSION information_schema_stats_expiry = ?') {
        events.push('restore')
        assert.equal(typeof parameters![0], 'number', 'MySQL整数系统变量不能以字符串类型恢复')
        if (options.fail === 'restore' || options.fail === 'query-and-restore') throw restoreError
        expiry = String(parameters![0]); return []
      }
      events.push('metadata'); assert.equal(expiry, '0')
      assert.deepEqual(parameters, ['fixture', 'sequence_fixture'])
      if (options.cancel === 'during-query') cancelled = true
      if (options.fail === 'query' || options.fail === 'query-and-restore') throw queryError
      return [{ nextId: options.next === undefined ? '9007199254740994' : options.next }]
    },
    async release() {
      events.push('release'); assert.ok(expiry === '86400' || destroyed, '改过的session不能归还连接池')
      released = true
    },
  }
  const target = { options: { type: 'mysql', database: 'fixture' }, createQueryRunner(mode: string) {
    assert.equal(mode, 'master'); return runner
  }, query() { throw new Error('POOL_SIZE_ONE_SECOND_CONNECTION_REQUEST') } } as unknown as DataSource
  const active = () => { if (cancelled) throw new Error('FIXTURE_MIGRATION_CANCELLED') }
  return { target, active, events, queryError, restoreError, state: () => ({ expiry, released, destroyed }) }
}
await test('MySQL序列读取保持单连接/精确大整数，恢复后才释放', async () => {
  const fixture = mysqlReaderFixture()
  assert.equal(await readMysqlGeneratedNextId(fixture.target, 'sequence_fixture', fixture.active), 9007199254740994n)
  assert.deepEqual(fixture.events, ['connect', 'read-expiry', 'set-zero', 'metadata', 'restore', 'read-expiry', 'release'])
  assert.deepEqual(fixture.state(), { expiry: '86400', released: true, destroyed: false })
})
await test('MySQL空表未分配序列为1；不能用MAX(id)替代已删除高水位', async () => {
  assert.equal(await readMysqlGeneratedNextId(mysqlReaderFixture({ next: null }).target, 'sequence_fixture'), 1n)
  assert.equal(await readMysqlGeneratedNextId(mysqlReaderFixture({ next: '9007199254740994' }).target, 'sequence_fixture'), 9007199254740994n)
})
for (const fail of ['query', 'set']) await test(`${fail}失败仍在同连接恢复，保留原异常`, async () => {
  const fixture = mysqlReaderFixture({ fail })
  await assert.rejects(readMysqlGeneratedNextId(fixture.target, 'sequence_fixture'), error => error === fixture.queryError)
  assert.deepEqual(fixture.state(), { expiry: '86400', released: true, destroyed: false })
})
for (const fail of ['restore', 'restore-read', 'restore-mismatch', 'query-and-restore']) await test(`${fail}失败销毁连接，不把不可信session放回池`, async () => {
  const fixture = mysqlReaderFixture({ fail })
  await assert.rejects(readMysqlGeneratedNextId(fixture.target, 'sequence_fixture'), (error: unknown) => {
    assert.ok(error instanceof AggregateError)
    if (fail === 'query-and-restore') assert.deepEqual(error.errors, [fixture.queryError, fixture.restoreError])
    return true
  })
  assert.equal(fixture.state().destroyed, true)
  assert.ok(fixture.events.indexOf('destroy') < fixture.events.indexOf('release'))
})
for (const cancel of ['after-set', 'during-query']) await test(`${cancel}取消不跳过恢复且不能返回成功序列`, async () => {
  const fixture = mysqlReaderFixture({ cancel })
  await assert.rejects(readMysqlGeneratedNextId(fixture.target, 'sequence_fixture', fixture.active), /FIXTURE_MIGRATION_CANCELLED/)
  assert.deepEqual(fixture.state(), { expiry: '86400', released: true, destroyed: false })
})

if (process.env.Y_LINK_VERIFY_MYSQL_SEQUENCE === 'true') {
  await test('真实独占MySQL最小连接池1：缓存预热、空表、删除高位和session恢复', async () => {
  const { readOwnedMysqlContext } = await import('./owned-mysql-fixture.mjs')
  const { createOwnedVerificationDatabase, verificationDatabaseName } = await import('./owned-verification-database.js')
  const config = readOwnedMysqlContext(), owned = await createOwnedVerificationDatabase(config, verificationDatabaseName('sequence_read'))
  const mysql = new DataSource({ type: 'mysql', host: config.host, port: config.port, username: config.user, password: config.password,
    database: owned.database, entities: [], extra: { connectionLimit: 1, supportBigNumbers: true, bigNumberStrings: true } })
  try {
    await owned.assertEmpty(); await mysql.initialize()
    const [version] = await mysql.query('SELECT VERSION() AS version')
    await mysql.query('CREATE TABLE sequence_fixture (id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY) ENGINE=InnoDB')
    assert.equal(await readMysqlGeneratedNextId(mysql, 'sequence_fixture'), 1n)
    await mysql.query('INSERT INTO sequence_fixture (id) VALUES (1)')
    const cached = await mysql.query("SELECT CAST(AUTO_INCREMENT AS CHAR) AS value FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sequence_fixture'")
    assert.equal(cached[0].value, '2')
    await mysql.query('DELETE FROM sequence_fixture'); await mysql.query('INSERT INTO sequence_fixture (id) VALUES (1),(2)')
    await mysql.query('ALTER TABLE sequence_fixture AUTO_INCREMENT=3')
    assert.equal(await readMysqlGeneratedNextId(mysql, 'sequence_fixture'), 3n, '缓存预热后必须读取引擎新序列')
    await mysql.query('INSERT INTO sequence_fixture (id) VALUES (9007199254740993)'); await mysql.query('DELETE FROM sequence_fixture WHERE id>1')
    assert.equal(await readMysqlGeneratedNextId(mysql, 'sequence_fixture'), 9007199254740994n)
    await mysql.query('DELETE FROM sequence_fixture')
    assert.equal(await readMysqlGeneratedNextId(mysql, 'sequence_fixture'), 9007199254740994n, '删空表也不能重用历史高位')
    const settings = await mysql.query('SELECT @@session.information_schema_stats_expiry AS expiry')
    assert.equal(Number(settings[0].expiry), 86400)
    console.log(JSON.stringify({ mysqlSequenceReader: { version: version.version, poolSize: 1, cachedRead: cached[0].value,
      freshRead: '3', deletedHighWater: '9007199254740994', restoredExpiry: settings[0].expiry } }))
  } finally { if (mysql.isInitialized) await mysql.destroy(); await owned.cleanup() }
  })
}
