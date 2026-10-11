/** PR #153 旧认证库兼容回归：所有 SQLite 文件只创建在本脚本独占的临时目录。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const inherited = [
  'ENV_FILE', 'APP_PROFILE', 'DB_TYPE', 'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD',
  'DB_NAME', 'SQLITE_DB_PATH', 'Y_LINK_DATA_DIR', 'Y_LINK_DATA_ENCRYPTION_KEY',
].filter((key) => process.env[key] !== undefined)
assert.deepEqual(inherited, [], '隔离测试拒绝继承数据库、密钥或 env 配置')

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const profile = 'pr153-upgrade-coverage-test'
assert.equal(fs.existsSync(path.join(backendRoot, '.env')), false, '隔离测试拒绝读取 backend/.env')
assert.equal(fs.existsSync(path.join(backendRoot, `.env.${profile}`)), false, '隔离测试拒绝读取 profile env')
const fixtureRoot = path.resolve(backendRoot, '../tmp/pr153-upgrade-coverage-20261011')
fs.mkdirSync(fixtureRoot, { recursive: true })
process.env.NODE_ENV = 'test'
process.env.APP_PROFILE = profile
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'false'
process.env.SQLITE_DB_PATH = path.join(fixtureRoot, 'unused.sqlite')
process.env.Y_LINK_DATA_DIR = path.join(fixtureRoot, 'unused-app-data')
process.env.Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE = 'true'

const { DataSource } = await import('typeorm')
const { prepareSqliteAdminMfaCompatibility } = await import('../src/config/database-bootstrap.js')
const { getTransactionCoordinator } = await import('../src/database/transaction-coordinator.js')

async function withSqlite(run) {
  const runRoot = fs.mkdtempSync(path.join(fixtureRoot, 'run-'))
  const db = new DataSource({
    type: 'sqlite', database: path.join(runRoot, 'legacy.sqlite'), entities: [], synchronize: false,
  })
  try {
    await db.initialize()
    await db.query('PRAGMA foreign_keys = ON')
    await run(db)
  } finally {
    if (db.isInitialized) await db.destroy()
    const resolvedRoot = fs.realpathSync(runRoot)
    assert.equal(path.dirname(resolvedRoot), fs.realpathSync(fixtureRoot))
    assert.match(path.basename(resolvedRoot), /^run-[A-Za-z0-9]+$/)
    fs.rmSync(resolvedRoot, { recursive: true, force: false })
  }
}

async function createLegacyMfa(db, extraColumns = '') {
  await db.query('CREATE TABLE "sys_user" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL)')
  await db.query('INSERT INTO "sys_user" ("id") VALUES (7), (8)')
  await db.query(`CREATE TABLE "sys_user_mfa" (
    "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    "user_id" integer NOT NULL,
    "totp_secret_sealed" varchar(255) NOT NULL,
    "recovery_codes_json" text NOT NULL,
    "last_used_step" integer,
    ${extraColumns}
    CONSTRAINT "fk_mfa_user" FOREIGN KEY ("user_id") REFERENCES "sys_user" ("id") ON DELETE RESTRICT
  )`)
  await db.query('CREATE UNIQUE INDEX "uk_sys_user_mfa_user_id" ON "sys_user_mfa" ("user_id")')
  await db.query('CREATE TRIGGER "trg_mfa_touch" AFTER UPDATE OF "recovery_codes_json" ON "sys_user_mfa" BEGIN SELECT 1; END')
}

test('旧 TOTP/MFA 与 WebAuthn 凭据升级保留历史数据、约束和自增水位，重复运行无副作用', async () => {
  await withSqlite(async (db) => {
    await createLegacyMfa(db, '"legacy_note" text NOT NULL,')
    await db.query('INSERT INTO "sys_user_mfa" ("id", "user_id", "totp_secret_sealed", "recovery_codes_json", "last_used_step", "legacy_note") VALUES (4, 7, ?, ?, 33, ?)', [
      'ylenc:v1:old:test', '{"codes":["stored-hash"]}', '保留旧扩展列',
    ])
    await db.query('UPDATE sqlite_sequence SET seq = 55 WHERE name = ?', ['sys_user_mfa'])
    await db.query('CREATE TABLE "sys_user_webauthn_credential" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "user_id" integer NOT NULL, "name" varchar(64) NOT NULL)')
    await db.query('INSERT INTO "sys_user_webauthn_credential" ("user_id", "name") VALUES (7, ?)', ['旧凭据'])

    const original = await db.query('SELECT id, user_id, totp_secret_sealed, recovery_codes_json, last_used_step, legacy_note FROM sys_user_mfa')
    await prepareSqliteAdminMfaCompatibility(db)
    assert.equal(getTransactionCoordinator(db)?.snapshot().serializeWrites, true, '表重建必须进入 SQLite 写事务协调器')
    assert.deepEqual(await db.query('SELECT id, user_id, totp_secret_sealed, recovery_codes_json, last_used_step, legacy_note FROM sys_user_mfa'), original)
    const columns = await db.query('PRAGMA table_info("sys_user_mfa")')
    assert.equal(columns.find((item) => item.name === 'totp_secret_sealed')?.notnull, 0)
    assert.equal(columns.find((item) => item.name === 'legacy_note')?.notnull, 1)
    assert.equal(columns.find((item) => item.name === 'factor_revision')?.notnull, 1)
    assert.deepEqual(await db.query('SELECT factor_revision FROM sys_user_mfa'), [{ factor_revision: 1 }])
    assert.deepEqual(await db.query('SELECT name, usage FROM sys_user_webauthn_credential'), [{ name: '旧凭据', usage: 'passwordless' }])
    assert.deepEqual(await db.query('SELECT CAST(seq AS TEXT) AS seq FROM sqlite_sequence WHERE name = ?', ['sys_user_mfa']), [{ seq: '55' }])
    assert.deepEqual(await db.query('PRAGMA foreign_key_check("sys_user_mfa")'), [])
    assert.equal((await db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'uk_sys_user_mfa_user_id'")).length, 1)
    assert.equal((await db.query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_mfa_touch'")).length, 1)
    await assert.rejects(db.query('INSERT INTO sys_user_mfa (user_id, totp_secret_sealed, recovery_codes_json, legacy_note) VALUES (7, NULL, ?, ?)', ['{}', '重复账号']), /UNIQUE/)
    await db.query('INSERT INTO sys_user_mfa (user_id, totp_secret_sealed, recovery_codes_json, legacy_note) VALUES (8, NULL, ?, ?)', ['{}', '仅通行密钥'])
    assert.deepEqual(await db.query('SELECT id, factor_revision FROM sys_user_mfa WHERE user_id = 8'), [{ id: 56, factor_revision: 1 }])

    const after = await db.query('SELECT id, user_id, totp_secret_sealed, recovery_codes_json, last_used_step, legacy_note, factor_revision FROM sys_user_mfa ORDER BY id')
    await prepareSqliteAdminMfaCompatibility(db)
    assert.deepEqual(await db.query('SELECT id, user_id, totp_secret_sealed, recovery_codes_json, last_used_step, legacy_note, factor_revision FROM sys_user_mfa ORDER BY id'), after)
    assert.deepEqual(await db.query('SELECT name, usage FROM sys_user_webauthn_credential'), [{ name: '旧凭据', usage: 'passwordless' }])
  })
})

test('残留重建表时拒绝升级，原表、数据、索引和残留表均不改动', async () => {
  await withSqlite(async (db) => {
    await createLegacyMfa(db)
    await db.query('INSERT INTO sys_user_mfa (user_id, totp_secret_sealed, recovery_codes_json) VALUES (7, ?, ?)', ['old-secret', '{}'])
    await db.query('CREATE TABLE "sys_user_mfa__compat_rebuild" ("id" integer PRIMARY KEY)')
    const before = await db.query('SELECT * FROM sys_user_mfa')
    await assert.rejects(prepareSqliteAdminMfaCompatibility(db), /SQLITE_MFA_COMPAT_SCHEMA_UNEXPECTED/)
    assert.deepEqual(await db.query('SELECT * FROM sys_user_mfa'), before)
    assert.equal((await db.query('PRAGMA table_info("sys_user_mfa")')).find((item) => item.name === 'totp_secret_sealed')?.notnull, 1)
    assert.equal((await db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'uk_sys_user_mfa_user_id'")).length, 1)
    assert.equal((await db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sys_user_mfa__compat_rebuild'")).length, 1)
  })
})

test('无法安全识别的旧列 DDL 拒绝重建，原数据不被修改', async () => {
  await withSqlite(async (db) => {
    await db.query('CREATE TABLE "sys_user_mfa" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "totp_secret_sealed" TEXT NOT NULL, "recovery_codes_json" text NOT NULL)')
    await db.query('INSERT INTO sys_user_mfa (totp_secret_sealed, recovery_codes_json) VALUES (?, ?)', ['old-secret', '{}'])
    const before = await db.query('SELECT * FROM sys_user_mfa')
    await assert.rejects(prepareSqliteAdminMfaCompatibility(db), /SQLITE_MFA_COMPAT_SCHEMA_UNEXPECTED/)
    assert.deepEqual(await db.query('SELECT * FROM sys_user_mfa'), before)
    assert.equal((await db.query('PRAGMA table_info("sys_user_mfa")')).find((item) => item.name === 'totp_secret_sealed')?.notnull, 1)
    assert.equal((await db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sys_user_mfa__compat_rebuild'")).length, 0)
  })
})

test('历史孤儿 MFA 行触发失败并回滚整笔表重建', async () => {
  await withSqlite(async (db) => {
    await createLegacyMfa(db)
    await db.query('PRAGMA foreign_keys = OFF')
    await db.query('INSERT INTO sys_user_mfa (user_id, totp_secret_sealed, recovery_codes_json) VALUES (999, ?, ?)', ['old-secret', '{}'])
    await db.query('PRAGMA foreign_keys = ON')
    const before = await db.query('SELECT * FROM sys_user_mfa')
    await assert.rejects(prepareSqliteAdminMfaCompatibility(db))
    assert.deepEqual(await db.query('SELECT * FROM sys_user_mfa'), before)
    assert.equal((await db.query('PRAGMA table_info("sys_user_mfa")')).find((item) => item.name === 'totp_secret_sealed')?.notnull, 1)
    assert.equal((await db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'uk_sys_user_mfa_user_id'")).length, 1)
    assert.equal((await db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sys_user_mfa__compat_rebuild'")).length, 0)
    assert.deepEqual(await db.query('PRAGMA foreign_keys'), [{ foreign_keys: 1 }])
    assert.equal(getTransactionCoordinator(db)?.snapshot().activeWrites, 0, '失败后不得留下写事务占用')
    await db.query('INSERT INTO sys_user_mfa (user_id, totp_secret_sealed, recovery_codes_json) VALUES (7, ?, ?)', ['still-writable', '{}'])
    assert.equal((await db.query('SELECT COUNT(*) AS total FROM sys_user_mfa'))[0]?.total, 2, '回滚后正常写入仍可继续')
  })
})
