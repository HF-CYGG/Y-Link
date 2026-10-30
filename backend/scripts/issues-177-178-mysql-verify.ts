/** 仅针对明确确认的 loopback 临时 MySQL 实例，自建随机库验证 062 重放和真实服务竞争。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import mysql, { type RowDataPacket } from 'mysql2/promise'
assert.equal(process.env.YLINK_ISSUES_MYSQL_CONFIRM_TEST_SERVER, 'true', '必须明确指定隔离测试实例，不能连接业务库')
const port = Number(process.env.YLINK_ISSUES_MYSQL_PORT)
assert.ok(Number.isInteger(port) && port >= 10000 && port <= 65535, '须显式提供独占隔离实例端口')
const database = `ylink_i177_${randomBytes(8).toString('hex')}`
const connection = await mysql.createConnection({ host: '127.0.0.1', port, user: process.env.YLINK_ISSUES_MYSQL_USER ?? 'root', password: process.env.YLINK_ISSUES_MYSQL_PASSWORD ?? '', multipleStatements: true })
try {
  await connection.query('CREATE DATABASE ' + database + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci')
  await connection.query('USE ' + database)
  await connection.query("CREATE TABLE o2o_preorder (id BIGINT UNSIGNED PRIMARY KEY, show_no VARCHAR(48), status VARCHAR(16)); INSERT INTO o2o_preorder VALUES (1, 'PRE-D-999999', 'verified')")
  const migration = fs.readFileSync(path.resolve('sql/062_o2o_preorder_kingdee_registration.sql'), 'utf8')
  await connection.query(migration); await connection.query(migration)
  const [rows] = await connection.query<RowDataPacket[]>('SELECT * FROM o2o_preorder')
  assert.equal(rows[0]!.show_no, 'PRE-D-999999'); assert.equal(rows[0]!.status, 'verified')
  assert.equal(rows[0]!.kingdee_voucher_no, null); assert.equal(rows[0]!.kingdee_version, 0)
  await connection.query("UPDATE o2o_preorder SET kingdee_voucher_no = '001-AbC', kingdee_version = 2 WHERE id = 1")
  await connection.query(migration)
  const [repeat] = await connection.query<RowDataPacket[]>('SELECT * FROM o2o_preorder')
  assert.equal(repeat[0]!.kingdee_voucher_no, '001-AbC'); assert.equal(repeat[0]!.kingdee_version, 2)
  // 仅清理本脚本刚创建、名称已验证的随机隔离库，再交给真实实体建表测试。
  assert.match(database, /^ylink_i177_[a-f0-9]{16}$/)
  await connection.query('DROP DATABASE ' + database)
  await connection.query('CREATE DATABASE ' + database + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci')
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/issues-177-178-verify.ts'], { cwd: process.cwd(), stdio: 'inherit', env: { ...process.env, DB_TYPE: 'mysql', DB_HOST: '127.0.0.1', DB_PORT: String(port), DB_USER: process.env.YLINK_ISSUES_MYSQL_USER ?? 'root', DB_PASSWORD: process.env.YLINK_ISSUES_MYSQL_PASSWORD ?? '', DB_NAME: database, YLINK_ISSUES_VERIFY_MYSQL_DATABASE: database } })
    child.once('error', reject); child.once('exit', (code) => resolve(code ?? 1))
  })
  assert.equal(exitCode, 0, '真实 MySQL 服务场景失败')
} finally {
  assert.match(database, /^ylink_i177_[a-f0-9]{16}$/)
  await connection.query('DROP DATABASE IF EXISTS ' + database)
  await connection.end()
}
