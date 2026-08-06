/**
 * 模块说明：backend/src/config/mysql-migration-runner.ts
 * 文件职责：为 MySQL 部署提供启动期自检，以及对少数已核实幂等的增量迁移脚本的可选自动执行能力。
 * 实现逻辑：
 * - SQLite 一体化部署由 database-bootstrap.ts 里的 normalizeSqlite* 系列函数在启动期自动补齐结构；
 *   而 MySQL 一直被视为“外部管理”的数据库，此前启动阶段完全不校验 backend/sql/ 是否已执行，
 *   导致缺表故障只能在业务接口报错时才被发现（例如认证接口依赖的 auth_risk_state 表）。
 * - assertMysqlRequiredTablesExist：只读校验一组关键表是否存在，缺失则直接抛错阻止服务启动，
 *   把“运行时才 500”变成“启动即失败 + 明确的修复指引”。这一层无副作用、始终执行。
 * - runMysqlSchemaMigrations：仅当环境变量 DB_AUTO_MIGRATE=true 时才会执行，默认关闭。
 *   **重要边界**：backend/sql/ 目录下 33 个历史脚本的幂等性并不一致——
 *   部分早期脚本（如 006/008/014/015/016/017）用裸 `ALTER TABLE ADD COLUMN` 未加
 *   `IF NOT EXISTS`/`information_schema` 判断，重复执行会直接报错；
 *   005 更是一个只应人工触发的破坏性回滚脚本（会删除 004 生成的备份表）。
 *   因此这里不做“扫描目录、执行全部未记录文件”的通用回放，而是维护一份人工审计过的
 *   AUTO_MIGRATABLE_FILES 白名单，只有确认幂等安全的文件才会被自动执行；
 *   其余脚本仍需按 README 指引由运维人工执行一次。
 * 维护说明：
 * - 新增迁移文件若要加入自动执行范围，必须先人工确认其为幂等写法
 *   （CREATE TABLE IF NOT EXISTS / information_schema 判断 + PREPARE-EXECUTE 动态 DDL /
 *   ADD COLUMN IF NOT EXISTS），再追加到 AUTO_MIGRATABLE_FILES；
 * - 新增强依赖的关键表时，请同步补充 MYSQL_REQUIRED_TABLES，保持与 database-bootstrap.ts 的
 *   SQLITE_REQUIRED_TABLES 口径一致。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { DataSource } from 'typeorm'
import { env } from './env.js'

const SQL_DIR = path.resolve(process.cwd(), 'sql')
const MIGRATION_TABLE = 'schema_migrations'

// 启动自检覆盖的关键表：均为认证、核心库存与出入库主链路强依赖的表，
// 任一缺失都意味着对应业务接口会在运行时直接报错，因此选择在启动期就失败。
const MYSQL_REQUIRED_TABLES = [
  'base_product',
  'base_product_sku',
  'sys_user',
  'sys_user_session',
  'o2o_preorder',
  'o2o_preorder_item',
  'biz_inbound_order',
  'biz_inbound_order_item',
  'auth_risk_state',
]

// 已人工审计确认幂等、可安全自动执行的迁移文件白名单。
// 只在这里追加——不要把整个 sql/ 目录当成可自动回放的历史，见文件头说明。
const AUTO_MIGRATABLE_FILES = [
  '033_inventory_security_invariants.sql',
]

/**
 * 按 MySQL 语句边界拆分 SQL 文本：
 * - 忽略单引号字符串内部的分号（含 '' 转义引号）；
 * - 忽略 `--` 行注释内部的分号；
 * - 白名单内的文件目前不含存储过程/触发器等需要 DELIMITER 重定义的语句，
 *   因此不处理 DELIMITER，一旦引入需同步升级本函数。
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let inSingleQuote = false
  let inLineComment = false

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i]
    const nextChar = sql[i + 1]

    if (inLineComment) {
      current += char
      if (char === '\n') {
        inLineComment = false
      }
      continue
    }

    if (inSingleQuote) {
      current += char
      if (char === '\'' && nextChar === '\'') {
        current += nextChar
        i += 1
        continue
      }
      if (char === '\'') {
        inSingleQuote = false
      }
      continue
    }

    if (char === '-' && nextChar === '-') {
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
      const trimmed = current.trim()
      if (trimmed) {
        statements.push(trimmed)
      }
      current = ''
      continue
    }

    current += char
  }

  const tail = current.trim()
  if (tail) {
    statements.push(tail)
  }
  return statements
}

async function ensureMigrationTrackingTable(dataSource: DataSource): Promise<void> {
  await dataSource.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
      filename VARCHAR(255) NOT NULL COMMENT '已应用的迁移文件名',
      checksum VARCHAR(64) NOT NULL COMMENT '文件内容 SHA-256，用于发现漂移',
      applied_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      PRIMARY KEY (filename)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='MySQL 增量迁移脚本执行记录'
  `)
}

/**
 * 执行 AUTO_MIGRATABLE_FILES 白名单中尚未记录为已应用的迁移脚本：
 * - 默认关闭（见 env.DB_AUTO_MIGRATE），需要运维显式开启；
 * - 只处理白名单内的文件，不扫描整个 sql/ 目录，避免误执行非幂等或破坏性历史脚本；
 * - 每个文件内的语句顺序执行，全部成功后才写入执行记录；
 * - 单个文件内某条语句失败会中止本次启动，日志会指出具体文件名，避免带着不完整结构继续运行。
 */
export async function runMysqlSchemaMigrations(dataSource: DataSource): Promise<{ appliedFiles: string[] }> {
  if (env.DB_TYPE !== 'mysql' || !env.DB_AUTO_MIGRATE) {
    return { appliedFiles: [] }
  }

  await ensureMigrationTrackingTable(dataSource)
  const appliedRows: Array<{ filename: string }> = await dataSource.query(
    `SELECT filename FROM ${MIGRATION_TABLE}`,
  )
  const appliedSet = new Set(appliedRows.map((row) => row.filename))
  const appliedFiles: string[] = []

  for (const filename of AUTO_MIGRATABLE_FILES) {
    if (appliedSet.has(filename)) {
      continue
    }

    const filePath = path.join(SQL_DIR, filename)
    if (!fs.existsSync(filePath)) {
      continue
    }
    const content = fs.readFileSync(filePath, 'utf8')
    const checksum = createHash('sha256').update(content).digest('hex')
    const statements = splitSqlStatements(content)

    try {
      for (const statement of statements) {
        await dataSource.query(statement)
      }
    } catch (error) {
      throw new Error(
        `[启动失败] 自动执行 MySQL 迁移脚本 ${filename} 失败，服务已阻止启动，请人工核查该脚本执行状态后重启：${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }

    await dataSource.query(
      `INSERT INTO ${MIGRATION_TABLE} (filename, checksum) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE checksum = VALUES(checksum), applied_at = CURRENT_TIMESTAMP(6)`,
      [filename, checksum],
    )
    appliedFiles.push(filename)
  }

  return { appliedFiles }
}

/**
 * 启动期只读自检：确认核心业务表已存在。
 * - 缺表时直接抛错阻止服务对外提供服务，避免“认证接口运行时才 500”这种故障模式；
 * - 错误信息附带具体的修复命令，运维无需再去翻查文档定位缺哪张表；
 * - 无论 DB_AUTO_MIGRATE 是否开启都会执行，因为白名单只覆盖 033，
 *   若缺失的是白名单之外的表（例如运维从未执行过 001/019/028 等），自动迁移不会补齐，必须人工介入。
 */
export async function assertMysqlRequiredTablesExist(dataSource: DataSource): Promise<void> {
  if (env.DB_TYPE !== 'mysql') {
    return
  }

  const rows: Array<{ TABLE_NAME: string }> = await dataSource.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${MYSQL_REQUIRED_TABLES.map(() => '?').join(', ')})`,
    MYSQL_REQUIRED_TABLES,
  )
  const existingSet = new Set(rows.map((row) => row.TABLE_NAME))
  const missingTables = MYSQL_REQUIRED_TABLES.filter((table) => !existingSet.has(table))

  if (missingTables.length === 0) {
    return
  }

  throw new Error(
    `[启动失败] MySQL 数据库缺少必需表：${missingTables.join(', ')}。\n`
    + '请在目标数据库上按文件名数字前缀顺序执行 backend/sql/ 目录下的迁移脚本（脚本均为幂等设计，重复执行安全），例如：\n'
    + '  mysql -h<host> -u<user> -p <database> < backend/sql/001_init_schema.sql\n'
    + '  ...（按顺序执行到最新编号，注意跳过 *_rollback.sql 这类需人工判断是否执行的脚本）\n'
    + '  mysql -h<host> -u<user> -p <database> < backend/sql/033_inventory_security_invariants.sql\n'
    + '若缺失的仅是 auth_risk_state 表，也可以设置环境变量 DB_AUTO_MIGRATE=true 后重启服务，'
    + '由服务自动执行 033 号迁移脚本（其余历史脚本仍需人工执行）。',
  )
}
