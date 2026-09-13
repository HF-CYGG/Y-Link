/**
 * 文件说明：backend/scripts/account-lifecycle-mysql-verify.ts
 * 文件职责：在显式确认的本机 MySQL 8.0.44 隔离实例上验证 044 迁移幂等性、账号外键 RESTRICT 与生命周期事件不可变性。
 * 实现逻辑：
 * 1. 只接受 ACCOUNT_LIFECYCLE_MYSQL_* 专用参数，并在连接前拒绝非本机、高风险端口或非 8.0.44 实例；
 * 2. 创建不可复用的随机临时库和带 CASCADE 的迁移前夹具，连续执行两次 044；
 * 3. 查询 information_schema 并执行真实写入，确认十一处账号外键均为 RESTRICT，事件 UPDATE/DELETE 均被触发器拒绝；
 * 4. 无论成功失败都在 finally 删除本轮临时库并回查不存在，不读取通用 DB_* 或 runtime override。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConnection, type Connection } from 'mysql2/promise'

const DATABASE_PREFIX = 'y_link_account_lifecycle_'
const migrationPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../sql/044_account_lifecycle_governance.sql')
const databaseName = `${DATABASE_PREFIX}${randomUUID().replaceAll('-', '')}`

delete process.env.ENV_FILE
process.env.Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE = 'true'

const host = process.env.ACCOUNT_LIFECYCLE_MYSQL_HOST?.trim()
const port = Number(process.env.ACCOUNT_LIFECYCLE_MYSQL_PORT)
const user = process.env.ACCOUNT_LIFECYCLE_MYSQL_USER?.trim()
const password = process.env.ACCOUNT_LIFECYCLE_MYSQL_PASSWORD ?? ''

assert.equal(process.env.ACCOUNT_LIFECYCLE_MYSQL_CONFIRM_TEST_SERVER, 'true', '必须显式确认本机 MySQL 8.0.44 测试实例')
assert.equal(host, '127.0.0.1', '账号生命周期 MySQL 验证只允许连接 127.0.0.1')
assert.ok(Number.isInteger(port) && port >= 10_000 && port <= 65_535, '账号生命周期 MySQL 验证必须使用隔离高位端口')
assert.ok(user, '必须显式提供 ACCOUNT_LIFECYCLE_MYSQL_USER')
assert.match(databaseName, /^y_link_account_lifecycle_[a-f0-9]{32}$/, '临时库名不在受控命名空间')
assert.equal(process.env.Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE, 'true')
assert.equal(process.env.ENV_FILE, undefined)

function pass(message: string) {
  // eslint-disable-next-line no-console
  console.log(`✅ ${message}`)
}

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let inSingleQuote = false
  let inLineComment = false
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]
    const next = sql[index + 1]
    if (inLineComment) {
      current += char
      if (char === '\n') inLineComment = false
      continue
    }
    if (inSingleQuote) {
      current += char
      if (char === '\'' && next === '\'') {
        current += next
        index += 1
      } else if (char === '\'') {
        inSingleQuote = false
      }
      continue
    }
    if (char === '-' && next === '-') {
      inLineComment = true
      current += char
      continue
    }
    if (char === '\'') {
      inSingleQuote = true
      current += char
      continue
    }
    if (char === ';') {
      if (current.trim()) statements.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  if (current.trim()) statements.push(current.trim())
  return statements
}

const fixtureStatements = [
  'CREATE TABLE `sys_user` (`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, `username` VARCHAR(64) NOT NULL, PRIMARY KEY (`id`), UNIQUE KEY (`username`)) ENGINE=InnoDB',
  'CREATE TABLE `client_user` (`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, `username` VARCHAR(64) NOT NULL, PRIMARY KEY (`id`), UNIQUE KEY (`username`)) ENGINE=InnoDB',
  'CREATE TABLE `sys_user_session` (`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, `user_id` BIGINT UNSIGNED NOT NULL, PRIMARY KEY (`id`), CONSTRAINT `old_sys_session_cascade` FOREIGN KEY (`user_id`) REFERENCES `sys_user` (`id`) ON DELETE CASCADE) ENGINE=InnoDB',
  'CREATE TABLE `client_user_session` (`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, `user_id` BIGINT UNSIGNED NOT NULL, PRIMARY KEY (`id`), CONSTRAINT `old_client_session_cascade` FOREIGN KEY (`user_id`) REFERENCES `client_user` (`id`) ON DELETE CASCADE) ENGINE=InnoDB',
  'CREATE TABLE `client_mobile_session` (`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, `client_user_id` BIGINT UNSIGNED NOT NULL, PRIMARY KEY (`id`), CONSTRAINT `old_mobile_session_cascade` FOREIGN KEY (`client_user_id`) REFERENCES `client_user` (`id`) ON DELETE CASCADE) ENGINE=InnoDB',
  'CREATE TABLE `notification_inbox` (`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, `user_id` BIGINT UNSIGNED NOT NULL, PRIMARY KEY (`id`), CONSTRAINT `old_inbox_cascade` FOREIGN KEY (`user_id`) REFERENCES `sys_user` (`id`) ON DELETE CASCADE) ENGINE=InnoDB',
  'CREATE TABLE `biz_inbound_order` (`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, `supplier_id` BIGINT UNSIGNED NULL, PRIMARY KEY (`id`), CONSTRAINT `old_inbound_cascade` FOREIGN KEY (`supplier_id`) REFERENCES `sys_user` (`id`) ON DELETE CASCADE) ENGINE=InnoDB',
  'CREATE TABLE `o2o_preorder` (`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, `client_user_id` BIGINT UNSIGNED NOT NULL, PRIMARY KEY (`id`), CONSTRAINT `old_preorder_cascade` FOREIGN KEY (`client_user_id`) REFERENCES `client_user` (`id`) ON DELETE CASCADE) ENGINE=InnoDB',
  'CREATE TABLE `o2o_return_request` (`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, `client_user_id` BIGINT UNSIGNED NOT NULL, PRIMARY KEY (`id`), CONSTRAINT `old_return_cascade` FOREIGN KEY (`client_user_id`) REFERENCES `client_user` (`id`) ON DELETE CASCADE) ENGINE=InnoDB',
  'CREATE TABLE `client_feedback_conversation` (`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, `client_user_id` BIGINT UNSIGNED NOT NULL, `assigned_user_id` BIGINT UNSIGNED NULL, `internal_remark_by_user_id` BIGINT UNSIGNED NULL, PRIMARY KEY (`id`), CONSTRAINT `old_feedback_client_cascade` FOREIGN KEY (`client_user_id`) REFERENCES `client_user` (`id`) ON DELETE CASCADE, CONSTRAINT `old_feedback_assigned_cascade` FOREIGN KEY (`assigned_user_id`) REFERENCES `sys_user` (`id`) ON DELETE CASCADE, CONSTRAINT `old_feedback_remark_cascade` FOREIGN KEY (`internal_remark_by_user_id`) REFERENCES `sys_user` (`id`) ON DELETE CASCADE) ENGINE=InnoDB',
  'CREATE TABLE `client_feedback_attachment` (`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, `owner_client_user_id` BIGINT UNSIGNED NOT NULL, PRIMARY KEY (`id`), CONSTRAINT `old_attachment_cascade` FOREIGN KEY (`owner_client_user_id`) REFERENCES `client_user` (`id`) ON DELETE CASCADE) ENGINE=InnoDB',
]

const expectedForeignKeys = [
  ['sys_user_session', 'user_id', 'sys_user'],
  ['client_user_session', 'user_id', 'client_user'],
  ['client_mobile_session', 'client_user_id', 'client_user'],
  ['notification_inbox', 'user_id', 'sys_user'],
  ['biz_inbound_order', 'supplier_id', 'sys_user'],
  ['o2o_preorder', 'client_user_id', 'client_user'],
  ['o2o_return_request', 'client_user_id', 'client_user'],
  ['client_feedback_conversation', 'client_user_id', 'client_user'],
  ['client_feedback_conversation', 'assigned_user_id', 'sys_user'],
  ['client_feedback_conversation', 'internal_remark_by_user_id', 'sys_user'],
  ['client_feedback_attachment', 'owner_client_user_id', 'client_user'],
] as const

async function expectRejected(operation: () => Promise<unknown>, expected: RegExp, scene: string) {
  await assert.rejects(operation, expected, scene)
}

async function executeMigration(connection: Connection) {
  const sql = fs.readFileSync(migrationPath, 'utf8')
  for (const statement of splitSqlStatements(sql)) {
    await connection.query(statement)
  }
}

async function verifyMigratedSchema(connection: Connection) {
  const [columnRows] = await connection.query(
    "SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('sys_user', 'client_user') AND COLUMN_NAME IN ('deactivated_at', 'deactivation_reason', 'restored_at')",
    [databaseName],
  )
  assert.ok(Array.isArray(columnRows))
  assert.equal(columnRows.length, 6, '双账号域生命周期列未完整创建')

  const [fkRows] = await connection.query(
    `SELECT kcu.TABLE_NAME, kcu.COLUMN_NAME, kcu.REFERENCED_TABLE_NAME, rc.DELETE_RULE
       FROM information_schema.KEY_COLUMN_USAGE kcu
       JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
         ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
        AND rc.TABLE_NAME = kcu.TABLE_NAME
        AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
      WHERE kcu.CONSTRAINT_SCHEMA = ? AND kcu.REFERENCED_TABLE_NAME IN ('sys_user', 'client_user')`,
    [databaseName],
  )
  assert.ok(Array.isArray(fkRows))
  const actualKeys = new Set((fkRows as Array<Record<string, unknown>>).map((row) =>
    `${row.TABLE_NAME}.${row.COLUMN_NAME}->${row.REFERENCED_TABLE_NAME}:${row.DELETE_RULE}`))
  for (const [table, column, target] of expectedForeignKeys) {
    assert.ok(actualKeys.has(`${table}.${column}->${target}:RESTRICT`), `${table}.${column} 必须为 RESTRICT`)
  }
  assert.equal((fkRows as Array<Record<string, unknown>>).some((row) => row.DELETE_RULE !== 'RESTRICT'), false, '不得残留 CASCADE/SET NULL 账号外键')

  const [triggerRows] = await connection.query(
    'SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? AND EVENT_OBJECT_TABLE = ? ORDER BY TRIGGER_NAME',
    [databaseName, 'account_lifecycle_event'],
  )
  assert.ok(Array.isArray(triggerRows))
  assert.deepEqual((triggerRows as Array<{ TRIGGER_NAME: string }>).map((row) => row.TRIGGER_NAME), [
    'trg_account_lifecycle_event_no_delete',
    'trg_account_lifecycle_event_no_update',
  ])
}

async function verifyRuntimeGuards(connection: Connection) {
  await connection.query("INSERT INTO sys_user (username) VALUES ('sys-lifecycle-target')")
  await connection.query("INSERT INTO client_user (username) VALUES ('client-lifecycle-target')")
  await connection.query('INSERT INTO sys_user_session (user_id) VALUES (1)')
  await connection.query('INSERT INTO client_user_session (user_id) VALUES (1)')
  await connection.query('INSERT INTO client_mobile_session (client_user_id) VALUES (1)')
  await connection.query('INSERT INTO notification_inbox (user_id) VALUES (1)')
  await connection.query('INSERT INTO biz_inbound_order (supplier_id) VALUES (1)')
  await connection.query('INSERT INTO o2o_preorder (client_user_id) VALUES (1)')
  await connection.query('INSERT INTO o2o_return_request (client_user_id) VALUES (1)')
  await connection.query('INSERT INTO client_feedback_conversation (client_user_id, assigned_user_id, internal_remark_by_user_id) VALUES (1, 1, 1)')
  await connection.query('INSERT INTO client_feedback_attachment (owner_client_user_id) VALUES (1)')

  await expectRejected(() => connection.query('DELETE FROM sys_user WHERE id = 1'), /foreign key constraint fails/i, '系统账号被历史关联时必须拒绝物理删除')
  await expectRejected(() => connection.query('DELETE FROM client_user WHERE id = 1'), /foreign key constraint fails/i, '客户端账号被历史关联时必须拒绝物理删除')

  await connection.query(
    `INSERT INTO account_lifecycle_event
      (account_domain, account_id_snapshot, account_masked_snapshot, event_type, reason,
       actor_user_id_snapshot, actor_username_snapshot, actor_display_name_snapshot,
       reference_summary_json, event_summary_json)
     VALUES ('sys_user', '1', 'sy***et', 'deactivated', '测试注销原因', '2', 'operator', '操作员', '{"sessions":1}', '{"revoked":1}')`,
  )
  await expectRejected(
    () => connection.query("UPDATE account_lifecycle_event SET reason = '篡改' WHERE id = 1"),
    /ACCOUNT_LIFECYCLE_EVENT_APPEND_ONLY/,
    '生命周期事件 UPDATE 必须被数据库触发器拒绝',
  )
  await expectRejected(
    () => connection.query('DELETE FROM account_lifecycle_event WHERE id = 1'),
    /ACCOUNT_LIFECYCLE_EVENT_APPEND_ONLY/,
    '生命周期事件 DELETE 必须被数据库触发器拒绝',
  )
  const [eventRows] = await connection.query('SELECT account_masked_snapshot, reason, event_summary_json FROM account_lifecycle_event WHERE id = 1')
  assert.ok(Array.isArray(eventRows) && eventRows.length === 1, '不可变生命周期事件必须保留')
  assert.equal(JSON.stringify(eventRows).includes('password'), false, '事件摘要不得包含密码字段')
}

let databaseCreated = false

async function main() {
  const admin = await createConnection({ host, port, user, password, multipleStatements: false })
  try {
    const [versionRows] = await admin.query('SELECT VERSION() AS version')
    assert.ok(Array.isArray(versionRows))
    const version = String((versionRows[0] as { version?: unknown } | undefined)?.version ?? '')
    assert.match(version, /^8\.0\.44(?:[-+].*)?$/, `必须使用合同指定的 MySQL 8.0.44，实际 ${version || 'unknown'}`)
    const [existingRows] = await admin.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [databaseName])
    assert.ok(Array.isArray(existingRows))
    assert.equal(existingRows.length, 0, '随机临时库意外已存在，已拒绝覆盖')
    await admin.query(`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`)
    databaseCreated = true
    pass(`已创建受控临时库 ${databaseName}（MySQL ${version}）`)

    const connection = await createConnection({ host, port, user, password, database: databaseName, multipleStatements: false })
    try {
      for (const statement of fixtureStatements) await connection.query(statement)
      await executeMigration(connection)
      pass('044_account_lifecycle_governance.sql 第一次执行通过')
      await executeMigration(connection)
      pass('044_account_lifecycle_governance.sql 第二次执行通过')
      await verifyMigratedSchema(connection)
      pass('十一处账号外键均为 RESTRICT，且未残留 CASCADE/SET NULL')
      await verifyRuntimeGuards(connection)
      pass('真实父表删除受阻，生命周期事件 UPDATE/DELETE 均被 append-only 触发器拒绝')
    } finally {
      await connection.end()
    }
  } finally {
    if (databaseCreated) {
      await admin.query(`DROP DATABASE \`${databaseName}\``)
      const [remainingRows] = await admin.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [databaseName])
      assert.ok(Array.isArray(remainingRows))
      assert.equal(remainingRows.length, 0, '临时库清理后仍存在')
      databaseCreated = false
      pass(`受控临时库已清理并回查不存在：${databaseName}`)
    }
    await admin.end()
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error)
  process.exitCode = 1
})
