/**
 * 模块说明：backend/src/config/database-bootstrap.ts
 * 文件职责：负责数据库启动准备、SQLite 自举补齐与统一数据库路径解析。
 * 维护说明：迁移服务与主应用都依赖这里的 SQLite 路径解析规则，修改时必须保持两侧口径一致。
 */

import fs from 'node:fs'
import path from 'node:path'
import type { DataSource } from 'typeorm'
import { env } from './env.js'

const SQLITE_REQUIRED_TABLES = [
  'base_product',
  'base_tag',
  'rel_product_tag',
  'biz_outbound_order',
  'biz_outbound_order_item',
  'sys_user',
  'sys_user_session',
  'sys_audit_log',
  'system_configs',
  'client_user',
  'client_user_session',
  'o2o_preorder',
  'o2o_preorder_item',
  'o2o_return_request',
  'o2o_return_request_item',
  'inventory_log',
  'biz_inbound_order',
  'biz_inbound_order_item',
  'client_feedback_conversation',
  'client_feedback_message',
]

const SQLITE_REQUIRED_ORDER_COLUMNS = [
  'creator_user_id',
  'creator_username',
  'creator_display_name',
  'is_deleted',
  'deleted_at',
  'deleted_by_user_id',
  'deleted_by_username',
  'deleted_by_display_name',
  'order_type',
  'has_customer_order',
  'is_system_applied',
  'issuer_name',
  'customer_department_name',
]

const SQLITE_REQUIRED_ORDER_ITEM_COLUMNS = ['unit_price', 'line_amount']
// 历史 SQLite 本地库缺少金额字段时，先用极小正数兜底补齐结构，避免 synchronize 重建临时表时被 NOT NULL / CHECK 约束直接拦截。
const SQLITE_LEGACY_OUTBOUND_ITEM_FALLBACK_UNIT_PRICE = 0.01
const SQLITE_LEGACY_OUTBOUND_ITEM_FALLBACK_LINE_AMOUNT = 0
const SQLITE_REQUIRED_PRODUCT_COLUMNS = [
  'o2o_status',
  'thumbnail',
  'detail_content',
  'limit_per_user',
  'current_stock',
  'pre_ordered_stock',
]

const SQLITE_REQUIRED_CLIENT_USER_COLUMNS = ['mobile', 'email', 'real_name', 'department_name', 'status', 'last_login_at']
const SQLITE_REQUIRED_CLIENT_FEEDBACK_CONVERSATION_COLUMNS = [
  'issue_type',
  'source_code',
  'source_label',
  'order_ref',
  'expected_result',
  'actual_result',
  'reproduction_steps',
  'contact_preference',
  'tag_json',
  'internal_remark',
  'internal_remark_updated_at',
  'internal_remark_by_user_id',
  'internal_remark_by_username',
  'internal_remark_by_display_name',
  'client_satisfaction_level',
  'client_satisfaction_comment',
  'client_satisfaction_rated_at',
]
const SQLITE_REQUIRED_CLIENT_FEEDBACK_MESSAGE_COLUMNS = ['internal_only', 'attachment_json']
const SQLITE_REQUIRED_O2O_PREORDER_COLUMNS = [
  'cancel_reason',
  'business_status',
  'merchant_message',
  'client_order_type',
  'department_name_snapshot',
  'is_system_applied',
  'has_customer_order',
  'pickup_contact',
  'update_count',
]
const SQLITE_REQUIRED_O2O_RETURN_REQUEST_COLUMNS = ['handled_at', 'handled_by', 'rejected_reason']
const SQLITE_REQUIRED_BIZ_INBOUND_ORDER_COLUMNS = [
  'cancel_reason',
  'cancelled_at',
  'cancelled_by_user_id',
  'cancelled_by_username',
  'cancelled_by_display_name',
]

async function listSqliteTableColumns(dataSource: DataSource, tableName: string): Promise<Set<string>> {
  const columns: Array<{ name: string }> = await dataSource.query(`PRAGMA table_info('${tableName}')`)
  return new Set(columns.map((column) => column.name))
}

function serializeSqliteNumericLiteral(value: number, fractionDigits = 2): string {
  // SQLite DDL 的 DEFAULT 子句不能使用参数占位符，因此这里先把内部常量收敛为有限数字，再序列化成 SQL 数值字面量。
  if (!Number.isFinite(value)) {
    throw new TypeError(`SQLite 数值字面量非法: ${String(value)}`)
  }
  return value.toFixed(fractionDigits)
}

async function normalizeSqliteOutboundItemColumns(dataSource: DataSource): Promise<void> {
  const itemColumnSet = await listSqliteTableColumns(dataSource, 'biz_outbound_order_item')
  if (itemColumnSet.size === 0) {
    return
  }

  let hasCompatMutation = false
  const fallbackUnitPriceLiteral = serializeSqliteNumericLiteral(SQLITE_LEGACY_OUTBOUND_ITEM_FALLBACK_UNIT_PRICE)
  const fallbackLineAmountLiteral = serializeSqliteNumericLiteral(SQLITE_LEGACY_OUTBOUND_ITEM_FALLBACK_LINE_AMOUNT)

  if (itemColumnSet.has('unitPrice') && !itemColumnSet.has('unit_price')) {
    await dataSource.query(`ALTER TABLE "biz_outbound_order_item" RENAME COLUMN "unitPrice" TO "unit_price"`)
    hasCompatMutation = true
  }

  let refreshedColumnSet = await listSqliteTableColumns(dataSource, 'biz_outbound_order_item')
  if (refreshedColumnSet.has('lineAmount') && !refreshedColumnSet.has('line_amount')) {
    await dataSource.query(`ALTER TABLE "biz_outbound_order_item" RENAME COLUMN "lineAmount" TO "line_amount"`)
    hasCompatMutation = true
  }

  refreshedColumnSet = await listSqliteTableColumns(dataSource, 'biz_outbound_order_item')
  if (!refreshedColumnSet.has('unit_price')) {
    // 先以 NOT NULL + 默认值补列，确保旧库在 TypeORM 复制到 temporary_* 表之前就具备最基础的金额字段。
    await dataSource.query(
      `ALTER TABLE "biz_outbound_order_item" ADD COLUMN "unit_price" decimal(12, 2) NOT NULL DEFAULT ${fallbackUnitPriceLiteral}`,
    )
    hasCompatMutation = true
  }

  refreshedColumnSet = await listSqliteTableColumns(dataSource, 'biz_outbound_order_item')
  if (!refreshedColumnSet.has('line_amount')) {
    // 行金额允许先以 0 占位，随后统一按数量 * 单价回填，避免旧库启动阶段直接中断。
    await dataSource.query(
      `ALTER TABLE "biz_outbound_order_item" ADD COLUMN "line_amount" decimal(14, 2) NOT NULL DEFAULT ${fallbackLineAmountLiteral}`,
    )
    hasCompatMutation = true
  }

  // 兼容历史库中金额列缺失或无效的记录：
  // 1. 优先沿用既有 line_amount / qty 反推单价；
  // 2. 其次回退到主单总金额 / 总数量均价；
  // 3. 再退到当前商品默认单价；
  // 4. 最后使用极小正数兜底，只用于让本地旧库完成结构升级。
  await dataSource.query(`
    UPDATE "biz_outbound_order_item"
    SET "unit_price" = printf(
      '%.2f',
      ROUND(
        COALESCE(
          CASE
            WHEN CAST(COALESCE("line_amount", 0) AS REAL) > 0 AND CAST(COALESCE("qty", 0) AS REAL) > 0
              THEN CAST("line_amount" AS REAL) / CAST("qty" AS REAL)
          END,
          (
            SELECT CASE
              WHEN CAST(COALESCE("total_amount", 0) AS REAL) > 0 AND CAST(COALESCE("total_qty", 0) AS REAL) > 0
                THEN CAST("total_amount" AS REAL) / CAST("total_qty" AS REAL)
            END
            FROM "biz_outbound_order"
            WHERE "biz_outbound_order"."id" = "biz_outbound_order_item"."order_id"
          ),
          (
            SELECT CASE
              WHEN CAST(COALESCE("default_price", 0) AS REAL) > 0
                THEN CAST("default_price" AS REAL)
            END
            FROM "base_product"
            WHERE "base_product"."id" = "biz_outbound_order_item"."product_id"
          ),
          ${fallbackUnitPriceLiteral}
        ),
        2
      )
    )
    WHERE "unit_price" IS NULL OR CAST(COALESCE("unit_price", 0) AS REAL) <= 0
  `)

  // 对缺失或非法的行金额统一重算，保证后续同步和统计查询拿到的是可用数据。
  await dataSource.query(`
    UPDATE "biz_outbound_order_item"
    SET "line_amount" = printf(
      '%.2f',
      ROUND(
        CAST(COALESCE("qty", 0) AS REAL) * CAST(COALESCE("unit_price", ${fallbackUnitPriceLiteral}) AS REAL),
        2
      )
    )
    WHERE "line_amount" IS NULL OR CAST(COALESCE("line_amount", 0) AS REAL) < 0
  `)

  if (hasCompatMutation) {
    // 旧库刚补列时，默认值可能还残留在部分记录上；这里再次按规则回算，保证同步前数据状态尽量完整。
    await dataSource.query(`
      UPDATE "biz_outbound_order_item"
      SET "line_amount" = printf(
        '%.2f',
        ROUND(
          CAST(COALESCE("qty", 0) AS REAL) * CAST(COALESCE("unit_price", ${fallbackUnitPriceLiteral}) AS REAL),
          2
        )
      )
      WHERE CAST(COALESCE("line_amount", 0) AS REAL) <= 0
    `)
  }
}

export function resolveSqliteDatabasePath(sqliteDbPath = env.SQLITE_DB_PATH): string {
  return path.isAbsolute(sqliteDbPath)
    ? sqliteDbPath
    : path.resolve(process.cwd(), sqliteDbPath)
}

/**
 * SQLite 一体化模式启动策略：
 * 1) 启动前自动创建数据库目录；
 * 2) 首次启动或结构升级时自动执行 synchronize；
 * 3) 若显式开启 DB_SYNC=true，则每次启动都同步实体结构，便于本地调试。
 */
export function prepareDatabaseRuntime(): { mode: 'sqlite' | 'mysql'; summary: string } {
  if (env.DB_TYPE === 'mysql') {
    return {
      mode: 'mysql',
      summary: `${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME}`,
    }
  }

  const sqlitePath = resolveSqliteDatabasePath()
  const sqliteDir = path.dirname(sqlitePath)
  fs.mkdirSync(sqliteDir, { recursive: true })

  return {
    mode: 'sqlite',
    summary: sqlitePath,
  }
}

export interface DatabaseSchemaInitResult {
  action: 'synchronized' | 'skipped'
  reason: 'forced_by_db_sync' | 'mysql_external' | 'sqlite_schema_ready' | 'sqlite_schema_bootstrap'
}

async function shouldSynchronizeSqliteSchema(dataSource: DataSource): Promise<boolean> {
  const existingTables: Array<{ name: string }> = await dataSource.query(
    `
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name IN (${SQLITE_REQUIRED_TABLES.map(() => '?').join(', ')})
    `,
    SQLITE_REQUIRED_TABLES,
  )

  if (existingTables.length !== SQLITE_REQUIRED_TABLES.length) {
    return true
  }

  const orderColumnSet = await listSqliteTableColumns(dataSource, 'biz_outbound_order')
  if (SQLITE_REQUIRED_ORDER_COLUMNS.some((column) => !orderColumnSet.has(column))) {
    return true
  }

  const orderItemColumnSet = await listSqliteTableColumns(dataSource, 'biz_outbound_order_item')
  if (SQLITE_REQUIRED_ORDER_ITEM_COLUMNS.some((column) => !orderItemColumnSet.has(column))) {
    return true
  }

  const productColumnSet = await listSqliteTableColumns(dataSource, 'base_product')
  if (SQLITE_REQUIRED_PRODUCT_COLUMNS.some((column) => !productColumnSet.has(column))) {
    return true
  }

  const clientUserColumnSet = await listSqliteTableColumns(dataSource, 'client_user')
  if (SQLITE_REQUIRED_CLIENT_USER_COLUMNS.some((column) => !clientUserColumnSet.has(column))) {
    return true
  }

  const clientFeedbackConversationColumnSet = await listSqliteTableColumns(dataSource, 'client_feedback_conversation')
  if (SQLITE_REQUIRED_CLIENT_FEEDBACK_CONVERSATION_COLUMNS.some((column) => !clientFeedbackConversationColumnSet.has(column))) {
    return true
  }

  const clientFeedbackMessageColumnSet = await listSqliteTableColumns(dataSource, 'client_feedback_message')
  if (SQLITE_REQUIRED_CLIENT_FEEDBACK_MESSAGE_COLUMNS.some((column) => !clientFeedbackMessageColumnSet.has(column))) {
    return true
  }

  const o2oPreorderColumnSet = await listSqliteTableColumns(dataSource, 'o2o_preorder')
  if (SQLITE_REQUIRED_O2O_PREORDER_COLUMNS.some((column) => !o2oPreorderColumnSet.has(column))) {
    return true
  }

  const o2oReturnRequestColumnSet = await listSqliteTableColumns(dataSource, 'o2o_return_request')
  if (SQLITE_REQUIRED_O2O_RETURN_REQUEST_COLUMNS.some((column) => !o2oReturnRequestColumnSet.has(column))) {
    return true
  }

  const inboundOrderColumnSet = await listSqliteTableColumns(dataSource, 'biz_inbound_order')
  if (SQLITE_REQUIRED_BIZ_INBOUND_ORDER_COLUMNS.some((column) => !inboundOrderColumnSet.has(column))) {
    return true
  }
  return false
}

export async function initializeDatabaseSchemaIfNeeded(dataSource: DataSource): Promise<DatabaseSchemaInitResult> {
  if (env.DB_TYPE === 'sqlite') {
    await normalizeSqliteOutboundItemColumns(dataSource)
  }

  // DB_SYNC=true 时直接走 TypeORM 同步，便于本地快速调试实体结构。
  if (env.DB_SYNC === true) {
    await dataSource.synchronize()
    return {
      action: 'synchronized',
      reason: 'forced_by_db_sync',
    }
  }

  if (env.DB_TYPE !== 'sqlite') {
    return {
      action: 'skipped',
      reason: 'mysql_external',
    }
  }

  const needSynchronize = await shouldSynchronizeSqliteSchema(dataSource)
  if (!needSynchronize) {
    return {
      action: 'skipped',
      reason: 'sqlite_schema_ready',
    }
  }

  // SQLite 现有本地库在认证系统接入后，需要自动补齐新表与开单留痕字段。
  await dataSource.synchronize()
  return {
    action: 'synchronized',
    reason: 'sqlite_schema_bootstrap',
  }
}
