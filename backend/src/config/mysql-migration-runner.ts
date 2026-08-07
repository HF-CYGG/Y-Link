/**
 * 模块说明：backend/src/config/mysql-migration-runner.ts
 * 文件职责：为 MySQL 部署提供启动期自检，以及对少数已核实幂等的增量迁移脚本的可选自动执行能力。
 * 实现逻辑：
 * - SQLite 一体化部署由 database-bootstrap.ts 里的 normalizeSqlite* 系列函数在启动期自动补齐结构；
 *   而 MySQL 一直被视为“外部管理”的数据库，此前启动阶段完全不校验 backend/sql/ 是否已执行，
 *   导致缺表故障只能在业务接口报错时才被发现（例如认证接口依赖的 auth_risk_state 表）。
 * - assertMysqlRequiredTablesExist：只读校验一组关键表是否存在，缺失则直接抛错阻止服务启动，
 *   把“运行时才 500”变成“启动即失败 + 明确的修复指引”。这一层无副作用、始终执行。
 *   报错文案会区分“全新空库”（缺全部必需表，只能走 DB_SYNC=true 实体同步）与
 *   “已执行过部分迁移的存量库”（只缺少数表，按 TABLE_INTRODUCING_SCRIPT 精确执行那一个脚本），
 *   而不是让运维自己猜。backend/sql/ 下的脚本已全部改造为幂等写法、可安全单独重放，
 *   但该目录仍是增量历史而非经过验证的全量基线，因此任何场景都不建议“从 001 顺序跑到最新编号”。
 * - runMysqlSchemaMigrations：仅当环境变量 DB_AUTO_MIGRATE=true 时才会执行，默认关闭。
 *   整段"读已应用记录 + 执行脚本 + 写入记录"由 MySQL advisory lock 串行化，
 *   保证多个实例同时以 DB_AUTO_MIGRATE=true 启动时不会并发执行同一个脚本。
 *   **重要边界**：这里不做"扫描目录、执行全部未记录文件"的通用回放，而是维护一份
 *   人工审计过的 AUTO_MIGRATABLE_FILES 白名单，只有确认幂等安全的文件才会被自动执行；
 *   005 是只应人工触发的破坏性回滚脚本（会删除 004 生成的备份表），始终排除在外。
 * 维护说明：
 * - 新增迁移文件若要加入自动执行范围，必须先人工确认其为幂等写法
 *   （CREATE TABLE IF NOT EXISTS / information_schema 判断 + PREPARE-EXECUTE 动态 DDL），
 *   再追加到 AUTO_MIGRATABLE_FILES；不要使用 MariaDB 专有的 ADD COLUMN IF NOT EXISTS；
 * - 新增强依赖的关键表时，请同步补充 MYSQL_REQUIRED_TABLES 与 TABLE_INTRODUCING_SCRIPT，
 *   并保持与 database-bootstrap.ts 的 SQLITE_REQUIRED_TABLES 口径一致；
 * - 若引入新的不可重放脚本，请同步补充 NON_IDEMPOTENT_HISTORICAL_SCRIPTS，
 *   避免报错文案误导运维"可以安全重放"。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { DataSource, QueryRunner } from 'typeorm'
import { env } from './env.js'

const SQL_DIR = path.resolve(process.cwd(), 'sql')
const MIGRATION_TABLE = 'schema_migrations'
// GET_LOCK 的锁名在同一 MySQL 服务端是全局的（不区分 database），
// 因此必须把库名拼进锁名，否则同一实例上部署的多套 Y-Link 库会互相阻塞迁移。
const buildMigrationAdvisoryLockName = (databaseName: string) => `y_link:schema_migration:${databaseName}`
// 等待锁的上限：迁移本身很快，等待超过这个时长通常意味着另一实例卡住或存在长事务，
// 此时宁可 fail-fast 让运维介入，也不要无限期挂起启动流程。
const MIGRATION_ADVISORY_LOCK_TIMEOUT_SECONDS = 60

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

// 不可重复执行的历史脚本。
// 原先 006/008/014/015/016 因裸 ALTER TABLE ADD COLUMN 也在此列，已改造为
// information_schema 判断 + PREPARE 动态 DDL，可安全重放，因此不再列入。
// 005 是只应人工触发的破坏性回滚脚本（会删除 004 生成的备份表），必须始终排除在"可重放"建议之外。
const NON_IDEMPOTENT_HISTORICAL_SCRIPTS = [
  '005_task8_history_order_type_mapping_rollback.sql（人工回滚脚本，正常部署不要执行）',
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
 * 用 MySQL advisory lock（GET_LOCK）串行化"检查 + 执行"整段流程。
 *
 * 多实例同时以 DB_AUTO_MIGRATE=true 启动时，两边都可能读到某个脚本尚未应用并同时执行它。
 * 即使脚本内部用 information_schema 判断做了幂等，"判断"与"ALTER TABLE"仍是两条独立语句，
 * 两个实例可能都通过了判断、各自生成同一条 ADD COLUMN，后执行者因重复列而启动失败。
 * 因此互斥必须覆盖整段流程，而不是依赖脚本自身的幂等判断。
 *
 * 使用 GET_LOCK 而非迁移记录抢占，是因为它由 MySQL 服务端统一仲裁、连接断开即自动释放，
 * 不会因某个实例中途崩溃而留下需要人工清理的死锁记录。
 */
async function withMysqlAdvisoryLock<T>(
  dataSource: DataSource,
  lockName: string,
  timeoutSeconds: number,
  operation: (queryRunner: QueryRunner) => Promise<T>,
): Promise<T> {
  // GET_LOCK 与 RELEASE_LOCK 必须落在同一条连接上，否则释放不掉；
  // 这里显式取一个 queryRunner 独占整段流程，并把它交给 operation，
  // 让"读已应用记录 / 执行脚本 / 写入记录"都走这条持锁连接，避免连接池分派带来的歧义。
  const queryRunner = dataSource.createQueryRunner()
  await queryRunner.connect()
  try {
    const acquiredRows = await queryRunner.query('SELECT GET_LOCK(?, ?) AS acquired', [lockName, timeoutSeconds])
    const acquired = Number(acquiredRows?.[0]?.acquired ?? 0)
    if (acquired !== 1) {
      throw new Error(
        `[启动失败] 等待 MySQL 迁移互斥锁 ${lockName} 超时（${timeoutSeconds} 秒）。`
        + '通常意味着另一个实例正在执行自动迁移；请等待其完成后重启本实例。'
        + '若确认没有其它实例在迁移，请检查是否有长事务占用该锁。',
      )
    }

    try {
      return await operation(queryRunner)
    } finally {
      await queryRunner.query('SELECT RELEASE_LOCK(?)', [lockName])
    }
  } finally {
    await queryRunner.release()
  }
}

/**
 * 执行 AUTO_MIGRATABLE_FILES 白名单中尚未记录为已应用的迁移脚本：
 * - 默认关闭（见 env.DB_AUTO_MIGRATE），需要运维显式开启；
 * - 只处理白名单内的文件，不扫描整个 sql/ 目录，避免误执行非幂等或破坏性历史脚本；
 * - 整段"检查已应用记录 + 执行脚本 + 写入记录"由 advisory lock 串行化，支持多实例同时启动；
 * - 每个文件内的语句顺序执行，全部成功后才写入执行记录；
 * - 单个文件内某条语句失败会中止本次启动，日志会指出具体文件名，避免带着不完整结构继续运行。
 */
export async function runMysqlSchemaMigrations(dataSource: DataSource): Promise<{ appliedFiles: string[] }> {
  if (env.DB_TYPE !== 'mysql' || !env.DB_AUTO_MIGRATE) {
    return { appliedFiles: [] }
  }

  await ensureMigrationTrackingTable(dataSource)

  return withMysqlAdvisoryLock(
    dataSource,
    buildMigrationAdvisoryLockName(env.DB_NAME),
    MIGRATION_ADVISORY_LOCK_TIMEOUT_SECONDS,
    (queryRunner) => applyPendingMigrations(queryRunner),
  )
}

/** 实际的迁移执行体；必须在 withMysqlAdvisoryLock 内调用，保证跨实例互斥。 */
async function applyPendingMigrations(queryRunner: QueryRunner): Promise<{ appliedFiles: string[] }> {
  // 已应用记录必须在持锁之后再读：若在锁外读取，另一个实例可能在我们拿到锁之前刚写入记录，
  // 我们仍会拿着过期的快照重复执行脚本。
  const appliedRows: Array<{ filename: string }> = await queryRunner.query(
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
        await queryRunner.query(statement)
      }
    } catch (error) {
      throw new Error(
        `[启动失败] 自动执行 MySQL 迁移脚本 ${filename} 失败，服务已阻止启动，请人工核查该脚本执行状态后重启：${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }

    await queryRunner.query(
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

  // 全新空库与存量库的恢复手段完全不同，必须分开给指引：
  // - 全新空库只能用 DB_SYNC=true 让 TypeORM 按实体建表。backend/sql/ 里的脚本虽已全部改造为
  //   幂等写法（原先 18 个脚本使用的 MariaDB 专有 ADD COLUMN IF NOT EXISTS 已清除），
  //   但该目录始终是按时间累积的增量记录，从未作为完整基线在真实 MySQL 8 空库上端到端验证过，
  //   因此不能建议"从 001 顺序执行到最新编号"；
  // - 存量库只缺个别表时，则要精确指向补建该表的那一个脚本，绝不能笼统建议“从头重跑”。
  const isFreshDatabase = missingTables.length === MYSQL_REQUIRED_TABLES.length
  const missingTableGuide = missingTables
    .map((table) => `  - ${table} → backend/sql/${TABLE_INTRODUCING_SCRIPT[table] ?? '（未登记，请检查 mysql-migration-runner.ts 的 TABLE_INTRODUCING_SCRIPT）'}`)
    .join('\n')

  const scenarioGuide = isFreshDatabase
    ? '当前数据库缺少全部必需表，属于全新空库（从未初始化过）。\n'
      + '请使用 TypeORM 实体同步完成首次建表——这是目前唯一经过验证的全新 MySQL 初始化方式\n'
      + '（SQLite→MySQL 迁移向导与 verify:db:concurrency 流水线都走这条路径）：\n'
      + '  1) 为后端设置环境变量 DB_SYNC=true（compose 部署可在 .env.docker.mysql 中设置）；\n'
      + '  2) 启动一次后端服务，等待日志出现 action=synchronized reason=forced_by_db_sync；\n'
      + '  3) 建表完成后把 DB_SYNC 改回 false 并重启，避免后续每次启动都同步实体结构。\n'
      + '\n'
      + '请勿按编号顺序执行 backend/sql/ 下的脚本来初始化全新库：这些脚本是按时间累积的历史增量记录，\n'
      + '并非经过验证的全量基线。它们虽已全部改造为幂等写法（可安全单独重放以补建缺失对象），\n'
      + '但脚本间的顺序依赖、以及数据回填语句对历史数据的假设，都未在空库上端到端验证过。'
    : '当前数据库只缺少上面列出的少数表，属于已初始化过、但缺少后续增量的存量库：\n'
      + '请执行上面“缺失表 → 脚本”列表中列出的目标脚本。这些脚本已全部改造为幂等写法\n'
      + '（information_schema 判断 + PREPARE 动态 DDL / CREATE TABLE IF NOT EXISTS），\n'
      + '即使目标脚本是复合脚本、其中部分列或表已经存在，也只会补建真正缺失的对象，不会因重复报错。\n'
      + '\n'
      + '仍需人工判断、不要随流程执行的脚本：\n'
      + NON_IDEMPOTENT_HISTORICAL_SCRIPTS.map((item) => `  - ${item}`).join('\n')

  throw new Error(
    `[启动失败] MySQL 数据库缺少必需表：${missingTables.join(', ')}。\n`
    + '这些表分别由以下迁移脚本创建：\n'
    + `${missingTableGuide}\n\n`
    + `${scenarioGuide}\n\n`
    + '若缺失的仅是 auth_risk_state，也可以设置环境变量 DB_AUTO_MIGRATE=true 后重启服务，'
    + '由服务自动执行白名单内已核实幂等的脚本（当前仅 033_inventory_security_invariants.sql）。',
  )
}
