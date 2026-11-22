/** 验证脚本专用MySQL资源：随机后缀永不截断，创建不复用已有库，清理须重证服务器与持久所有权。 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'

export interface VerificationMysqlConfig {
  host: string; port: number; user: string; password: string
  collation?: 'utf8mb4_unicode_ci' | 'utf8mb4_0900_ai_ci'
}
interface ConnectionLike { query(sql: string, values?: unknown[]): Promise<unknown>; end(): Promise<unknown> }
type Open = (config: VerificationMysqlConfig) => Promise<ConnectionLike>
const quote = (value: string) => `\`${value.replaceAll('`', '``')}\``

export function verificationDatabaseName(base: string, nonce = randomBytes(12).toString('hex')) {
  assert.match(nonce, /^[a-f0-9]{24}$/)
  const suffix = `_verify_${nonce}`
  return (base.replaceAll(/\W/g, '_') || 'ylink').slice(0, 60 - suffix.length) + suffix
}

export async function createOwnedVerificationDatabase(config: VerificationMysqlConfig, database: string,
  open: Open = async value => (await import('mysql2/promise')).createConnection({ ...value, connectTimeout: 3000, multipleStatements: false })) {
  assert.match(database, /^[a-zA-Z0-9_]{1,60}$/)
  const collation = config.collation ?? 'utf8mb4_unicode_ci'
  assert.ok(collation === 'utf8mb4_unicode_ci' || collation === 'utf8mb4_0900_ai_ci')
  const captured = Object.freeze({ host: config.host, port: config.port, user: config.user, password: config.password })
  // 控制标记在独占伴随库，被测业务库必须保持真正为空，不能放宽迁移/结构校验以迁就fixture。
  const token = randomBytes(24).toString('hex'), ownerDatabase = `ylink_verify_owner_${randomBytes(12).toString('hex')}`
  const table = `${quote(ownerDatabase)}.${quote('__ylink_verification_owner')}`
  const connection = await open(captured)
  let created = false, targetDropped = false, serverId = ''
  try {
    const [server] = await connection.query('SELECT @@server_uuid AS serverId') as [Array<{ serverId: string }>]
    serverId = server[0]!.serverId
    assert.ok(serverId, '无法证明测试MySQL服务器身份')
    // 绝不能使用IF NOT EXISTS，也不能在创建前DROP一个“固定测试名”。
    await connection.query(`CREATE DATABASE ${quote(database)} CHARACTER SET utf8mb4 COLLATE ${collation}`)
    created = true
    await connection.query(`CREATE DATABASE ${quote(ownerDatabase)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    await connection.query(`CREATE TABLE ${table} (token CHAR(48) NOT NULL PRIMARY KEY, target_database VARCHAR(64) NOT NULL)`)
    await connection.query(`INSERT INTO ${table} (token, target_database) VALUES (?, ?)`, [token, database])
    await connection.query('COMMIT')
  } catch {
    // 所有权标记未持久化时不猜测、不清理该名字，原错误作为真实失败返回。
    throw new Error(created ? 'MYSQL_VERIFICATION_OWNER_MARKER_FAILED' : 'MYSQL_VERIFICATION_CREATE_FAILED')
  } finally { await connection.end() }
  const assertOwned = async (connection: ConnectionLike) => {
    const [server] = await connection.query('SELECT @@server_uuid AS serverId') as [Array<{ serverId: string }>]
    const [owners] = await connection.query(`SELECT token, target_database AS targetDatabase FROM ${table}`) as [Array<{ token: string; targetDatabase: string }>]
    if (!created || server[0]?.serverId !== serverId || owners.length !== 1 || owners[0]?.token !== token || owners[0]?.targetDatabase !== database) throw new Error('MYSQL_VERIFICATION_OWNERSHIP_LOST')
  }
  const assertEmpty = async () => {
    const connection = await open(captured)
    try {
      await assertOwned(connection)
      const [tables] = await connection.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? LIMIT 1', [database]) as [unknown[]]
      if (tables.length !== 0) throw new Error('MYSQL_VERIFICATION_TARGET_NOT_EMPTY')
    } finally { await connection.end() }
  }
  const cleanup = async () => {
    if (!created) return
    const cleanupConnection = await open(captured)
    try {
      await assertOwned(cleanupConnection)
      if (!targetDropped) { await cleanupConnection.query(`DROP DATABASE ${quote(database)}`); targetDropped = true }
      await cleanupConnection.query(`DROP DATABASE ${quote(ownerDatabase)}`)
      created = false
    } finally { await cleanupConnection.end() }
  }
  return { database, ownerDatabase, serverId, assertEmpty, cleanup }
}
