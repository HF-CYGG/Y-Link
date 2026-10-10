/** 管理端第二因素旧库升级验证：仅操作本脚本创建的隔离 SQLite 文件。 */
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const inherited = [
  'ENV_FILE', 'APP_PROFILE', 'DB_TYPE', 'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD',
  'DB_NAME', 'SQLITE_DB_PATH', 'Y_LINK_DATA_DIR', 'Y_LINK_DATA_ENCRYPTION_KEY',
].filter((key) => process.env[key] !== undefined)
assert.deepEqual(inherited, [], '隔离验证拒绝继承数据库、密钥或 env 配置')
const backendRoot = path.resolve(process.cwd())
assert.equal(fs.existsSync(path.join(backendRoot, '.env')), false)
assert.equal(fs.existsSync(path.join(backendRoot, '.env.webauthn-compat-db-verify')), false)
const fixtureRoot = path.resolve(backendRoot, '../tmp/webauthn-compat-db')
fs.mkdirSync(fixtureRoot, { recursive: true })
const runRoot = fs.mkdtempSync(path.join(fixtureRoot, 'run-'))
process.env.NODE_ENV = 'test'
process.env.APP_PROFILE = 'webauthn-compat-db-verify'
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'false'
process.env.SQLITE_DB_PATH = path.join(runRoot, 'legacy.sqlite')
process.env.Y_LINK_DATA_DIR = path.join(runRoot, 'app-data')
process.env.Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE = 'true'

const { DataSource } = await import('typeorm')
const { prepareSqliteAdminMfaCompatibility } = await import('../src/config/database-bootstrap.js')
const { runDataEncryptionPreflight, DataEncryptionKeyMissingError } = await import('../src/runtime/data-encryption-preflight.js')
const db = new DataSource({ type: 'sqlite', database: process.env.SQLITE_DB_PATH, entities: [], synchronize: false })
const rollbackDb = new DataSource({ type: 'sqlite', database: path.join(runRoot, 'rollback.sqlite'), entities: [], synchronize: false })
const partialDb = new DataSource({ type: 'sqlite', database: path.join(runRoot, 'partial.sqlite'), entities: [], synchronize: false })
const emptyDb = new DataSource({ type: 'sqlite', database: path.join(runRoot, 'empty.sqlite'), entities: [], synchronize: false })
try {
  await db.initialize()
  await db.query('PRAGMA foreign_keys = ON')
  await db.query('CREATE TABLE "sys_user" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL)')
  await db.query('INSERT INTO "sys_user" ("id") VALUES (7)')
  await db.query(`CREATE TABLE "sys_user_mfa" (
    "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    "user_id" integer NOT NULL,
    "totp_secret_sealed" varchar(255) NOT NULL,
    "recovery_codes_json" text NOT NULL,
    "enabled_at" datetime NOT NULL,
    "last_used_step" integer,
    "created_at" datetime NOT NULL,
    "updated_at" datetime NOT NULL,
    CONSTRAINT "FK_mfa_user" FOREIGN KEY ("user_id") REFERENCES "sys_user" ("id") ON DELETE RESTRICT
  )`)
  await db.query('CREATE UNIQUE INDEX "uk_sys_user_mfa_user_id" ON "sys_user_mfa" ("user_id")')
  await db.query('CREATE TRIGGER "trg_mfa_touch" AFTER UPDATE OF "enabled_at" ON "sys_user_mfa" BEGIN SELECT 1; END')
  const recovery = JSON.stringify({ v: 1, kid: 'deadbeef', codes: ['a'.repeat(64)] })
  await db.query(`INSERT INTO "sys_user_mfa"
    ("id", "user_id", "totp_secret_sealed", "recovery_codes_json", "enabled_at", "last_used_step", "created_at", "updated_at")
    VALUES (?, ?, ?, ?, '2026-01-01', ?, '2026-01-01', '2026-01-01')`, [4, 7, 'ylenc:v1:deadbeef:test', recovery, 33])
  await db.query('UPDATE sqlite_sequence SET seq = 50 WHERE name = ?', ['sys_user_mfa'])
  await db.query(`CREATE TABLE "sys_user_webauthn_credential" (
    "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "user_id" integer NOT NULL, "name" varchar(64) NOT NULL,
    CONSTRAINT "FK_credential_user" FOREIGN KEY ("user_id") REFERENCES "sys_user" ("id") ON DELETE RESTRICT
  )`)
  await db.query('INSERT INTO "sys_user_webauthn_credential" ("user_id", "name") VALUES (7, ?)', ['旧凭据'])

  const snapshot = await db.query('SELECT id, user_id, totp_secret_sealed, recovery_codes_json, enabled_at, last_used_step, created_at, updated_at FROM sys_user_mfa')
  await prepareSqliteAdminMfaCompatibility(db)
  assert.deepEqual(await db.query('SELECT id, user_id, totp_secret_sealed, recovery_codes_json, enabled_at, last_used_step, created_at, updated_at FROM sys_user_mfa'), snapshot)
  const mfaColumns = await db.query('PRAGMA table_info("sys_user_mfa")') as Array<{ name: string; notnull: number }>
  assert.equal(mfaColumns.find((column) => column.name === 'totp_secret_sealed')?.notnull, 0)
  assert.equal(mfaColumns.find((column) => column.name === 'factor_revision')?.notnull, 1)
  assert.deepEqual(await db.query('SELECT factor_revision FROM sys_user_mfa'), [{ factor_revision: 1 }])
  assert.deepEqual(await db.query('SELECT usage FROM sys_user_webauthn_credential'), [{ usage: 'passwordless' }])
  assert.equal((await db.query('PRAGMA foreign_key_check')).length, 0)
  assert.equal((await db.query('PRAGMA index_list("sys_user_mfa")') as Array<{ name: string }>).some((index) => index.name === 'uk_sys_user_mfa_user_id'), true)
  assert.equal((await db.query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_mfa_touch'") as unknown[]).length, 1)
  await prepareSqliteAdminMfaCompatibility(db)
  assert.deepEqual(await db.query('SELECT id, user_id, totp_secret_sealed, recovery_codes_json, enabled_at, last_used_step, created_at, updated_at FROM sys_user_mfa'), snapshot)
  assert.equal((await db.query('SELECT seq FROM sqlite_sequence WHERE name = ?', ['sys_user_mfa']) as Array<{ seq: number }>)[0]?.seq, 50)

  await db.query('UPDATE sys_user_mfa SET totp_secret_sealed = NULL WHERE id = 4')
  await assert.rejects(runDataEncryptionPreflight(db), (error: unknown) => {
    assert.ok(error instanceof DataEncryptionKeyMissingError)
    assert.equal(error.message, 'DATA_ENCRYPTION_KEY_MISSING')
    return true
  })
  await db.query('UPDATE sys_user_mfa SET recovery_codes_json = ? WHERE id = 4', [JSON.stringify({ v: 1, codes: ['a'.repeat(64)] })])
  await assert.rejects(runDataEncryptionPreflight(db), DataEncryptionKeyMissingError, '活跃摘要缺少 kid 时也不能生成新密钥')
  assert.equal(fs.existsSync(path.join(runRoot, 'app-data/secrets/data-encryption.key')), false, '预检不能自动生成替代密钥')
  await db.query('UPDATE sys_user_mfa SET recovery_codes_json = ? WHERE id = 4', [recovery])
  const key = randomBytes(32)
  process.env.Y_LINK_DATA_ENCRYPTION_KEY = key.toString('hex')
  const mismatch = await runDataEncryptionPreflight(db)
  assert.ok(mismatch?.mismatchedKeyIds.includes('deadbeef'))
  const keyId = createHash('sha256').update('y-link.data-key-id.v1').update(Buffer.from([0])).update(key).digest('hex').slice(0, 8)
  await db.query('UPDATE sys_user_mfa SET recovery_codes_json = ? WHERE id = 4', [JSON.stringify({ v: 1, kid: keyId, codes: ['a'.repeat(64)] })])
  const match = await runDataEncryptionPreflight(db)
  assert.deepEqual(match?.mismatchedKeyIds, [])
  assert.ok(match?.databaseKeyIds.includes(keyId))

  await db.query('PRAGMA foreign_keys = OFF')
  await db.query('INSERT INTO sys_user_mfa (user_id, totp_secret_sealed, recovery_codes_json, enabled_at, created_at, updated_at) VALUES (999, ?, ?, ?, ?, ?)', ['legacy', '{}', '2026-01-01', '2026-01-01', '2026-01-01'])
  const [newRow] = await db.query('SELECT id FROM sys_user_mfa WHERE user_id = 999') as Array<{ id: number }>
  assert.ok(newRow.id > 50, '旧自增高位必须保留')
  await db.query('DELETE FROM sys_user_mfa WHERE user_id = 999')
  await db.query('PRAGMA foreign_keys = ON')
  console.log('[webauthn-compat-db-verify] 旧行/恢复码/FK/唯一索引/触发器/自增/重复升级及 key-only 预检通过')

  await rollbackDb.initialize()
  await rollbackDb.query('CREATE TABLE "sys_user" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL)')
  await rollbackDb.query(`CREATE TABLE "sys_user_mfa" (
    "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "user_id" integer NOT NULL,
    "totp_secret_sealed" varchar(255) NOT NULL, "recovery_codes_json" text NOT NULL,
    CONSTRAINT "FK_mfa_user" FOREIGN KEY ("user_id") REFERENCES "sys_user" ("id") ON DELETE RESTRICT
  )`)
  await rollbackDb.query('CREATE UNIQUE INDEX "uk_sys_user_mfa_user_id" ON "sys_user_mfa" ("user_id")')
  await rollbackDb.query('PRAGMA foreign_keys = OFF')
  await rollbackDb.query('INSERT INTO sys_user_mfa (user_id, totp_secret_sealed, recovery_codes_json) VALUES (999, ?, ?)', ['legacy', '{}'])
  await rollbackDb.query('PRAGMA foreign_keys = ON')
  const rollbackSnapshot = await rollbackDb.query('SELECT * FROM sys_user_mfa')
  await assert.rejects(prepareSqliteAdminMfaCompatibility(rollbackDb))
  assert.deepEqual(await rollbackDb.query('SELECT * FROM sys_user_mfa'), rollbackSnapshot, '外键错误必须回滚并保留原行')
  const rollbackColumns = await rollbackDb.query('PRAGMA table_info("sys_user_mfa")') as Array<{ name: string; notnull: number }>
  assert.equal(rollbackColumns.find((column) => column.name === 'totp_secret_sealed')?.notnull, 1)
  assert.equal((await rollbackDb.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sys_user_mfa__compat_rebuild'") as unknown[]).length, 0)
  console.log('[webauthn-compat-db-verify] 无效外键触发事务回滚、原表与原行保留')

  await partialDb.initialize()
  await partialDb.query('CREATE TABLE "sys_user" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL)')
  await partialDb.query('INSERT INTO sys_user (id) VALUES (7)')
  await partialDb.query(`CREATE TABLE "sys_user_mfa" (
    "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "user_id" integer NOT NULL,
    "totp_secret_sealed" varchar(255) NOT NULL, "recovery_codes_json" text NOT NULL,
    "factor_revision" integer NOT NULL DEFAULT (1),
    CONSTRAINT "FK_mfa_user" FOREIGN KEY ("user_id") REFERENCES "sys_user" ("id") ON DELETE RESTRICT
  )`)
  await partialDb.query('INSERT INTO sys_user_mfa (user_id, totp_secret_sealed, recovery_codes_json) VALUES (7, ?, ?)', ['legacy', '{}'])
  await prepareSqliteAdminMfaCompatibility(partialDb)
  await prepareSqliteAdminMfaCompatibility(partialDb)
  assert.deepEqual(await partialDb.query('SELECT user_id, totp_secret_sealed, factor_revision FROM sys_user_mfa'), [
    { user_id: 7, totp_secret_sealed: 'legacy', factor_revision: 1 },
  ])
  console.log('[webauthn-compat-db-verify] 已补 factor_revision 的半完成旧库可继续升级并重复执行')

  await emptyDb.initialize()
  await emptyDb.query(`CREATE TABLE "sys_user_mfa" (
    "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "user_id" integer NOT NULL,
    "totp_secret_sealed" varchar(255) NOT NULL, "recovery_codes_json" text NOT NULL
  )`)
  const deletedHighWater = '9007199254740993'
  await emptyDb.query(
    'INSERT INTO sys_user_mfa (id, user_id, totp_secret_sealed, recovery_codes_json) VALUES (9007199254740993, 1, ?, ?)',
    ['legacy', '{}'],
  )
  await emptyDb.query('DELETE FROM sys_user_mfa WHERE id = 9007199254740993')
  assert.deepEqual(await emptyDb.query('SELECT CAST(seq AS TEXT) AS seq FROM sqlite_sequence WHERE name = ?', ['sys_user_mfa']), [
    { seq: deletedHighWater },
  ])
  await prepareSqliteAdminMfaCompatibility(emptyDb)
  assert.deepEqual(await emptyDb.query('SELECT CAST(seq AS TEXT) AS seq FROM sqlite_sequence WHERE name = ?', ['sys_user_mfa']), [
    { seq: deletedHighWater },
  ])
  await emptyDb.query('INSERT INTO sys_user_mfa (user_id, totp_secret_sealed, recovery_codes_json) VALUES (2, NULL, ?)', ['{}'])
  assert.deepEqual(await emptyDb.query('SELECT CAST(id AS TEXT) AS id FROM sys_user_mfa WHERE user_id = 2'), [
    { id: '9007199254740994' },
  ])
  console.log('[webauthn-compat-db-verify] 空旧表保留超过 2^53 的历史自增高位与下一主键')
} finally {
  if (db.isInitialized) await db.destroy()
  if (rollbackDb.isInitialized) await rollbackDb.destroy()
  if (partialDb.isInitialized) await partialDb.destroy()
  if (emptyDb.isInitialized) await emptyDb.destroy()
  const resolvedRunRoot = fs.realpathSync(runRoot)
  assert.equal(path.dirname(resolvedRunRoot), fs.realpathSync(fixtureRoot))
  assert.match(path.basename(resolvedRunRoot), /^run-[A-Za-z0-9]+$/)
  fs.rmSync(resolvedRunRoot, { recursive: true, force: false })
}
