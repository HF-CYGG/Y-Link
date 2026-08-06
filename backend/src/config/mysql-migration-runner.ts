/**
 * 模块说明：backend/src/config/mysql-migration-runner.ts
 * 文件职责：为 MySQL 部署提供启动期自检，以及对少数已核实幂等的增量迁移脚本的可选自动执行能力。
 * 实现逻辑：
 * - SQLite 一体化部署由 database-bootstrap.ts 里的 normalizeSqlite* 系列函数在启动期自动补齐结构；
 *   而 MySQL 一直被视为“外部管理”的数据库，此前启动阶段完全不校验 backend/sql/ 是否已执行，
 *   导致缺表故障只能在业务接口报错时才被发现（例如认证接口依赖的 auth_risk_state 表）。
 * - assertMysqlRequiredTablesExist：只读校验一组关键表是否存在，缺失则直接抛错阻止服务启动，
 *   把“运行时才 500”变成“启动即失败 + 明确的修复指引”。这一层无副作用、始终执行。
 *   报错文案会区分“全新空库”（缺全部必需表，从 001 顺序执行到最新编号是安全的）与
 *   “已执行过部分迁移的存量库”（只缺少数表，绝不能笼统建议“从头重跑”，因为部分历史脚本非幂等），
 *   并按 TABLE_INTRODUCING_SCRIPT 给出每张缺失表对应的具体脚本，而不是让运维自己猜。
 * - runMysqlSchemaMigrations：仅当环境变量 DB_AUTO_MIGRATE=true 时才会执行，默认关闭。
 *   **重要边界**：backend/sql/ 目录下 33 个历史脚本的幂等性并不一致——
 *   部分早期脚本（006/008/014/015/016，见 NON_IDEMPOTENT_HISTORICAL_SCRIPTS）用裸
 *   `ALTER TABLE ADD COLUMN` 未加 `IF NOT EXISTS`/`information_schema` 判断，重复执行会直接报错；
 *   005 更是一个只应人工触发的破坏性回滚脚本（会删除 004 生成的备份表）。
 *   因此这里不做“扫描目录、执行全部未记录文件”的通用回放，而是维护一份人工审计过的
 *   AUTO_MIGRATABLE_FILES 白名单，只有确认幂等安全的文件才会被自动执行；
 *   其余脚本仍需按 README 指引由运维人工执行一次。
 * 维护说明：
 * - 新增迁移文件若要加入自动执行范围，必须先人工确认其为幂等写法
 *   （CREATE TABLE IF NOT EXISTS / information_schema 判断 + PREPARE-EXECUTE 动态 DDL /
 *   ADD COLUMN IF NOT EXISTS），再追加到 AUTO_MIGRATABLE_FILES；
 * - 新增强依赖的关键表时，请同步补充 MYSQL_REQUIRED_TABLES 与 TABLE_INTRODUCING_SCRIPT，
 *   并保持与 database-bootstrap.ts 的 SQLITE_REQUIRED_TABLES 口径一致；
 * - 若发现新的非幂等历史脚本，请同步补充 NON_IDEMPOTENT_HISTORICAL_SCRIPTS，
 *   避免报错文案继续误导运维“可以安全重放”。
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

// 每个必需表由哪个迁移脚本创建，用于在报错时给出精确指引，而不是笼统建议“从头跑一遍”。
// auth_risk_state 现同时存在于 001（供全新库一次建齐）与 033（供存量库补建），
// 这里指向 033，因为它也是 AUTO_MIGRATABLE_FILES 白名单里唯一可自动执行的脚本。
const TABLE_INTRODUCING_SCRIPT: Record<string, string> = {
  base_product: '001_init_schema.sql',
  sys_user: '001_init_schema.sql',
  sys_user_session: '001_init_schema.sql',
  biz_inbound_order: '001_init_schema.sql',
  biz_inbound_order_item: '001_init_schema.sql',
  o2o_preorder: '006_o2o_preorder_schema.sql',
  o2o_preorder_item: '006_o2o_preorder_schema.sql',
  base_product_sku: '028_o2o_product_sku_selection.sql',
  auth_risk_state: '033_inventory_security_invariants.sql',
}

// 已人工审计确认为非幂等（裸 ALTER TABLE ADD COLUMN，未做 information_schema/IF NOT EXISTS 判断）的
// 历史脚本：对已经执行过一次的数据库重复执行会直接报“字段已存在”错误，绝不能在报错指引里笼统建议
// “从 001 到最新编号顺序重跑一遍”。005 是只应人工触发的破坏性回滚脚本，同样排除在“可重放”建议之外。
const NON_IDEMPOTENT_HISTORICAL_SCRIPTS = [
  '005_task8_history_order_type_mapping_rollback.sql（人工回滚脚本，正常部署不要执行）',
  '006_o2o_preorder_schema.sql',
  '008_o2o_preorder_business_status.sql',
  '014_o2o_preorder_client_order_type.sql',
  '015_o2o_preorder_is_system_applied.sql',
  '016_o2o_preorder_has_customer_order.sql',
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

  // 全新空库：一张必需表都不存在，说明这个数据库从未跑过任何迁移，从 001 顺序执行到最新编号是安全的
  // （每个脚本对这个库而言都是“第一次执行”，不会撞上非幂等脚本的“字段已存在”报错）。
  // 存量库：只是缺少上面列出的少数表，说明这个库已经执行过部分迁移——此时绝不能笼统建议“从头重跑”，
  // 因为 006/008/014/015/016 等脚本是裸 ADD COLUMN，对已执行过的库重放会直接报错，延长故障恢复时间。
  const isFreshDatabase = missingTables.length === MYSQL_REQUIRED_TABLES.length
  const missingTableGuide = missingTables
    .map((table) => `  - ${table} → backend/sql/${TABLE_INTRODUCING_SCRIPT[table] ?? '（未登记，请检查 mysql-migration-runner.ts 的 TABLE_INTRODUCING_SCRIPT）'}`)
    .join('\n')

  const scenarioGuide = isFreshDatabase
    ? '当前数据库缺少全部必需表，属于全新空库（从未执行过任何迁移）：\n'
      + '可以从 001 开始按文件名数字前缀顺序执行到最新编号，例如：\n'
      + '  mysql -h<host> -u<user> -p <database> < backend/sql/001_init_schema.sql\n'
      + '  ...（按顺序执行到最新编号，跳过 *_rollback.sql 这类需人工判断是否执行的回滚脚本）\n'
      + '  mysql -h<host> -u<user> -p <database> < backend/sql/033_inventory_security_invariants.sql'
    : '当前数据库只缺少上面列出的少数表，属于已执行过部分迁移的存量库：\n'
      + '不要无差别地从 001 重新执行一遍——backend/sql/ 目录内脚本的幂等性并不一致，以下脚本使用裸\n'
      + 'ALTER TABLE ADD COLUMN，对已执行过的库重复执行会直接报“字段已存在”错误：\n'
      + NON_IDEMPOTENT_HISTORICAL_SCRIPTS.map((item) => `  - ${item}`).join('\n') + '\n'
      + '请只执行上面“缺失表 → 脚本”列表中列出的目标脚本本身；如果对当前库到底执行到哪个版本没有把握，\n'
      + '建议先用 SHOW TABLES / information_schema.COLUMNS 核对现状，或联系熟悉该库迁移历史的同事，\n'
      + '确认从哪个脚本继续，避免中途因重复列报错扩大故障范围。'

  throw new Error(
    `[启动失败] MySQL 数据库缺少必需表：${missingTables.join(', ')}。\n`
    + '这些表分别由以下迁移脚本创建：\n'
    + `${missingTableGuide}\n\n`
    + `${scenarioGuide}\n\n`
    + '也可以设置环境变量 DB_AUTO_MIGRATE=true 后重启服务，由服务自动执行白名单内已核实幂等的脚本'
    + '（当前仅 033_inventory_security_invariants.sql）；不在白名单内的脚本仍需按上述方式人工判断执行。',
  )
}
