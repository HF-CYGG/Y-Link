/**
 * 模块说明：backend/src/config/database-bootstrap.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
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

const SQLITE_REQUIRED_PRODUCT_COLUMNS = [
  'o2o_status',
  'thumbnail',
  'detail_content',
  'limit_per_user',
  'current_stock',
  'pre_ordered_stock',
]

const SQLITE_REQUIRED_CLIENT_USER_COLUMNS = ['mobile', 'email', 'real_name', 'department_name', 'status', 'last_login_at']
const SQLITE_REQUIRED_O2O_PREORDER_COLUMNS = ['cancel_reason', 'business_status', 'merchant_message']

export function resolveSqliteDatabasePath(): string {
  return path.isAbsolute(env.SQLITE_DB_PATH)
    ? env.SQLITE_DB_PATH
    : path.resolve(process.cwd(), env.SQLITE_DB_PATH)
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

  const orderColumns: Array<{ name: string }> = await dataSource.query(`PRAGMA table_info('biz_outbound_order')`)
  const orderColumnSet = new Set(orderColumns.map((column) => column.name))
  if (SQLITE_REQUIRED_ORDER_COLUMNS.some((column) => !orderColumnSet.has(column))) {
    return true
  }

  const productColumns: Array<{ name: string }> = await dataSource.query(`PRAGMA table_info('base_product')`)
  const productColumnSet = new Set(productColumns.map((column) => column.name))
  if (SQLITE_REQUIRED_PRODUCT_COLUMNS.some((column) => !productColumnSet.has(column))) {
    return true
  }

  const clientUserColumns: Array<{ name: string }> = await dataSource.query(`PRAGMA table_info('client_user')`)
  const clientUserColumnSet = new Set(clientUserColumns.map((column) => column.name))
  if (SQLITE_REQUIRED_CLIENT_USER_COLUMNS.some((column) => !clientUserColumnSet.has(column))) {
    return true
  }

  const o2oPreorderColumns: Array<{ name: string }> = await dataSource.query(`PRAGMA table_info('o2o_preorder')`)
  const o2oPreorderColumnSet = new Set(o2oPreorderColumns.map((column) => column.name))
  return SQLITE_REQUIRED_O2O_PREORDER_COLUMNS.some((column) => !o2oPreorderColumnSet.has(column))
}

export async function initializeDatabaseSchemaIfNeeded(dataSource: DataSource): Promise<DatabaseSchemaInitResult> {
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
