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
]

const SQLITE_REQUIRED_ORDER_COLUMNS = ['creator_user_id', 'creator_username', 'creator_display_name']

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
  return SQLITE_REQUIRED_ORDER_COLUMNS.some((column) => !orderColumnSet.has(column))
}

export async function initializeDatabaseSchemaIfNeeded(dataSource: DataSource): Promise<void> {
  // DB_SYNC=true 时直接走 TypeORM 同步，便于本地快速调试实体结构。
  if (env.DB_SYNC === true) {
    await dataSource.synchronize()
    return
  }

  if (env.DB_TYPE !== 'sqlite') {
    return
  }

  const needSynchronize = await shouldSynchronizeSqliteSchema(dataSource)
  if (!needSynchronize) {
    return
  }

  // SQLite 现有本地库在认证系统接入后，需要自动补齐新表与开单留痕字段。
  await dataSource.synchronize()
}
