/**
 * 模块说明：backend/src/config/database-bootstrap.ts
 * 文件职责：负责数据库启动准备、SQLite 自举补齐与统一数据库路径解析。
 * 维护说明：迁移服务与主应用都依赖这里的 SQLite 路径解析规则，修改时必须保持两侧口径一致。
 */

import fs from 'node:fs'
import path from 'node:path'
import type { DataSource, EntityManager } from 'typeorm'
import { env } from './env.js'
import { initializeDatabaseInfrastructure } from '../database/database-strategy.js'
import { ClientStaffDirectory } from '../entities/client-staff-directory.entity.js'
import { ClientUser } from '../entities/client-user.entity.js'
import { ClientFeedbackAttachment } from '../entities/client-feedback-attachment.entity.js'
import { ClientFeedbackConversation } from '../entities/client-feedback-conversation.entity.js'
import { ClientFeedbackMessage, type ClientFeedbackMessageAttachment } from '../entities/client-feedback-message.entity.js'
import { assertMysqlRequiredSchemaExists, runMysqlSchemaMigrations } from './mysql-migration-runner.js'
import { BizError } from '../utils/errors.js'

const SQLITE_REQUIRED_TABLES = [
  'base_product',
  'base_product_sku',
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
  'client_mobile_session',
  'client_staff_directory',
  'o2o_preorder',
  'o2o_preorder_item',
  'o2o_return_request',
  'o2o_return_request_item',
  'inventory_log',
  'biz_inbound_order',
  'biz_inbound_order_item',
  'client_feedback_conversation',
  'client_feedback_message',
  'client_feedback_attachment',
  'notification_rule',
  'notification_event',
  'notification_inbox',
  'notification_dispatch',
  'auth_risk_state',
  'business_sequence',
  'sms_verification_record',
  'order_business_no_occupancy',
  'order_revision',
  'account_lifecycle_event',
  'order_merge_operation',
  'order_merge_relation',
]

/**
 * Mobile Auth 表包含 refresh 血缘与安全索引，不能依赖 TypeORM synchronize 在存量 SQLite
 * 上隐式猜测迁移。这里用固定、幂等 DDL 先补表和索引，再进入既有结构检查。
 */
async function ensureSqliteMobileSessionSchema(dataSource: DataSource): Promise<void> {
  await dataSource.query(`
    CREATE TABLE IF NOT EXISTS client_mobile_session (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      client_user_id INTEGER NOT NULL,
      device_id varchar(64) NOT NULL,
      device_name varchar(64),
      platform varchar(16) NOT NULL,
      app_version varchar(32),
      access_token_hash varchar(64) NOT NULL,
      access_expires_at datetime NOT NULL,
      refresh_token_hash varchar(64) NOT NULL,
      refresh_expires_at datetime NOT NULL,
      previous_refresh_token_hash varchar(64),
      previous_refresh_grace_until datetime,
      refresh_generation integer NOT NULL DEFAULT (0),
      absolute_expires_at datetime NOT NULL,
      last_ip varchar(64),
      last_access_at datetime NOT NULL,
      created_at datetime NOT NULL DEFAULT (datetime('now')),
      revoked_at datetime,
      revoke_reason varchar(64),
      CONSTRAINT fk_client_mobile_session_user
        FOREIGN KEY (client_user_id) REFERENCES client_user (id) ON DELETE RESTRICT
    )
  `)
  await dataSource.query('CREATE UNIQUE INDEX IF NOT EXISTS uk_client_mobile_session_access_hash ON client_mobile_session (access_token_hash)')
  await dataSource.query('CREATE UNIQUE INDEX IF NOT EXISTS uk_client_mobile_session_refresh_hash ON client_mobile_session (refresh_token_hash)')
  await dataSource.query('CREATE INDEX IF NOT EXISTS idx_client_mobile_session_previous_refresh_hash ON client_mobile_session (previous_refresh_token_hash)')
  await dataSource.query('CREATE INDEX IF NOT EXISTS idx_client_mobile_session_user_active ON client_mobile_session (client_user_id, revoked_at, last_access_at)')
  await dataSource.query('CREATE INDEX IF NOT EXISTS idx_client_mobile_session_user_device ON client_mobile_session (client_user_id, device_id)')
  await dataSource.query('CREATE INDEX IF NOT EXISTS idx_client_mobile_session_cleanup ON client_mobile_session (revoked_at, absolute_expires_at, id)')
  await dataSource.query('CREATE INDEX IF NOT EXISTS idx_client_mobile_session_refresh_expiry ON client_mobile_session (revoked_at, refresh_expires_at, id)')
}

/**
 * 生命周期事件必须只能追加。TypeORM 只能声明字段/索引约束，不能表达“整表禁止
 * UPDATE/DELETE”，因此在 SQLite 启动自举阶段幂等安装数据库触发器作为最终防线。
 */
async function ensureSqliteAccountLifecycleAppendOnly(dataSource: DataSource): Promise<void> {
  await dataSource.query(`
    CREATE TRIGGER IF NOT EXISTS trg_account_lifecycle_event_no_update
    BEFORE UPDATE ON account_lifecycle_event
    BEGIN
      SELECT RAISE(ABORT, 'ACCOUNT_LIFECYCLE_EVENT_APPEND_ONLY');
    END
  `)
  await dataSource.query(`
    CREATE TRIGGER IF NOT EXISTS trg_account_lifecycle_event_no_delete
    BEFORE DELETE ON account_lifecycle_event
    BEGIN
      SELECT RAISE(ABORT, 'ACCOUNT_LIFECYCLE_EVENT_APPEND_ONLY');
    END
  `)
}

async function migrateLegacyFeedbackAttachments(dataSource: DataSource) {
  if (env.DB_TYPE !== 'sqlite') return
  await dataSource.transaction(async (manager) => {
    const messageRepo = manager.getRepository(ClientFeedbackMessage)
    const conversationRepo = manager.getRepository(ClientFeedbackConversation)
    const attachmentRepo = manager.getRepository(ClientFeedbackAttachment)
    const messages = await messageRepo.createQueryBuilder('message')
      .where("message.attachmentJson IS NOT NULL AND message.attachmentJson <> '[]'")
      .getMany()
    for (const message of messages) {
      let items: ClientFeedbackMessageAttachment[]
      try {
        const parsed = JSON.parse(message.attachmentJson) as unknown
        items = Array.isArray(parsed) ? parsed as ClientFeedbackMessageAttachment[] : []
      } catch {
        items = []
      }
      if (!items.length || items.every((item) => item.url?.startsWith('/api/client-feedback/attachments/'))) continue
      const conversation = await conversationRepo.findOne({ where: { id: message.conversationId } })
      if (!conversation) {
        message.attachmentJson = '[]'
        await messageRepo.save(message)
        continue
      }
      const migrated: ClientFeedbackMessageAttachment[] = []
      for (const item of items) {
        if (item.url?.startsWith('/api/client-feedback/attachments/')) {
          migrated.push(item)
          continue
        }
        const match = /^\/uploads\/client-feedback\/([^/?#]+)$/.exec(item.url?.trim() || '')
        if (!match?.[1]) continue
        const storageName = path.basename(match[1])
        const record = await attachmentRepo.save(attachmentRepo.create({
          ownerClientUserId: conversation.clientUserId,
          conversationId: conversation.id,
          messageId: message.id,
          storageName,
          originalName: item.name?.trim().slice(0, 255) || storageName,
          mimeType: item.mimeType?.trim().slice(0, 128) || null,
          sizeBytes: typeof item.size === 'number' ? item.size : null,
          expiresAt: null,
        }))
        migrated.push({ ...item, url: `/api/client-feedback/attachments/${record.id}` })
      }
      message.attachmentJson = JSON.stringify(migrated)
      await messageRepo.save(message)
    }
  })
}

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
  'business_no',
  'edit_version',
  'inventory_mode',
  'status',
  'source_doc_type',
  'source_doc_id',
  'source_doc_no',
]

const SQLITE_REQUIRED_ORDER_ITEM_COLUMNS = [
  'unit_price',
  'line_amount',
  'sku_id',
  'sku_code_snapshot',
  'spec_text_snapshot',
  'source_order_id',
  'source_order_uuid',
  'source_order_item_id',
]
const SQLITE_REQUIRED_ORDER_MERGE_OPERATION_COLUMNS = ['result_json']
const SQLITE_REQUIRED_INVENTORY_LOG_COLUMNS = [
  'sku_id',
  'before_sku_current_stock',
  'after_sku_current_stock',
  'before_sku_preordered_stock',
  'after_sku_preordered_stock',
]
// 历史 SQLite 本地库缺少金额字段时，先用极小正数兜底补齐结构，避免 synchronize 重建临时表时被 NOT NULL / CHECK 约束直接拦截。
const SQLITE_LEGACY_OUTBOUND_ITEM_FALLBACK_UNIT_PRICE = 0.01
const SQLITE_LEGACY_OUTBOUND_ITEM_FALLBACK_LINE_AMOUNT = 0
const SQLITE_REQUIRED_PRODUCT_COLUMNS = [
  'discount_rate',
  'o2o_status',
  'o2o_recommended',
  'thumbnail',
  'detail_content',
  'limit_per_user',
  'current_stock',
  'pre_ordered_stock',
]
const SQLITE_REQUIRED_PRODUCT_SKU_COLUMNS = ['o2o_recommended', 'is_current']
const SQLITE_REQUIRED_O2O_PREORDER_ITEM_COLUMNS = [
  'original_price',
  'discount_rate',
  'unit_price',
  'line_amount',
  'sku_id',
  'sku_code_snapshot',
  'spec_text_snapshot',
  'sku_image_snapshot',
]

const SQLITE_REQUIRED_CLIENT_USER_COLUMNS = [
  'mobile',
  'email',
  'real_name',
  'department_name',
  'department_node_id',
  'account_type',
  'staff_no',
  'staff_verified',
  'status',
  'last_login_at',
  'mobile_verified_at',
  'email_verified_at',
  'deactivated_at',
  'deactivation_reason',
  'deactivated_by_user_id',
  'deactivated_by_username',
  'deactivated_by_display_name',
  'restored_at',
  'restored_by_user_id',
  'restored_by_username',
  'restored_by_display_name',
]
const SQLITE_REQUIRED_CLIENT_STAFF_DIRECTORY_COLUMNS = [
  'staff_no', 'real_name', 'department_name', 'status',
  'invite_code_digest', 'invite_issued_at', 'invite_expires_at', 'invite_used_at',
  'invite_failed_attempts', 'invite_locked_until',
]
const SQLITE_REQUIRED_SYS_USER_COLUMNS = [
  'email',
  'deactivated_at',
  'deactivation_reason',
  'deactivated_by_user_id',
  'deactivated_by_username',
  'deactivated_by_display_name',
  'restored_at',
  'restored_by_user_id',
  'restored_by_username',
  'restored_by_display_name',
]
const SQLITE_REQUIRED_CLIENT_FEEDBACK_CONVERSATION_COLUMNS = [
  'client_account_type',
  'staff_no_snapshot',
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
  'client_request_id',
  'client_request_hash',
  'cancel_reason',
  'cancellation_source',
  'cancellation_remark',
  'cancelled_at',
  'business_status',
  'merchant_message',
  'client_order_type',
  'department_name_snapshot',
  'staff_no_snapshot',
  'is_system_applied',
  'has_customer_order',
  'pickup_contact',
  'pickup_at',
  'update_count',
  'is_deleted',
  'deleted_at',
  'deleted_by_user_id',
  'deleted_by_username',
  'deleted_by_display_name',
]
const SQLITE_REQUIRED_O2O_RETURN_REQUEST_COLUMNS = ['handled_at', 'handled_by', 'rejected_reason']
const SQLITE_REQUIRED_O2O_RETURN_REQUEST_ITEM_COLUMNS = [
  'sku_id',
  'sku_code_snapshot',
  'spec_text_snapshot',
]
const SQLITE_REQUIRED_BIZ_INBOUND_ORDER_COLUMNS = [
  'expected_arrival_at',
  'cancel_reason',
  'cancelled_at',
  'cancelled_by_user_id',
  'cancelled_by_username',
  'cancelled_by_display_name',
  'is_deleted',
  'deleted_at',
  'deleted_by_user_id',
  'deleted_by_username',
  'deleted_by_display_name',
]
const SQLITE_REQUIRED_BIZ_INBOUND_ORDER_ITEM_COLUMNS = ['sku_id']
const SQLITE_REQUIRED_NOTIFICATION_RULE_COLUMNS = [
  'email_recipient_admin_user_ids_json',
  'email_recipient_supplier_user_ids_json',
  'feishu_sign_secret',
]
const SQLITE_REQUIRED_NOTIFICATION_EVENT_COLUMNS = [
  'attempt_count',
  'next_attempt_at',
  'processing_started_at',
  'processing_owner',
  'processed_at',
]
const SQLITE_REQUIRED_NOTIFICATION_DISPATCH_COLUMNS = ['dedupe_key', 'last_attempt_at']

async function listSqliteTableColumns(dataSource: DataSource, tableName: string): Promise<Set<string>> {
  const columns: Array<{ name: string }> = await dataSource.query(`PRAGMA table_info('${tableName}')`)
  return new Set(columns.map((column) => column.name))
}

async function hasSqliteNotNullColumn(
  dataSource: DataSource,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  const columns: Array<{ name: string; notnull: number }> = await dataSource.query(
    `PRAGMA table_info('${tableName}')`,
  )
  const column = columns.find((item) => item.name === columnName)
  return Boolean(column && Number(column.notnull) === 1)
}

async function listSqliteUniqueIndexes(dataSource: DataSource, tableName: string): Promise<Set<string>> {
  const indexes: Array<{ name: string; unique: number }> = await dataSource.query(`PRAGMA index_list('${tableName}')`)
  return new Set(indexes.filter((index) => Number(index.unique) === 1).map((index) => index.name))
}

/**
 * SQLite 不能只按索引名判断结构已就绪：同名索引可能在历史手工维护时被建到了错误列上。
 * 这里同时校验 unique 标记和 `PRAGMA index_info` 返回的有序列定义。
 */
async function hasSqliteUniqueIndexShape(
  dataSource: DataSource,
  tableName: string,
  indexName: string,
  expectedColumns: string[],
): Promise<boolean> {
  const indexes: Array<{ name: string; unique: number }> = await dataSource.query(`PRAGMA index_list('${tableName}')`)
  const target = indexes.find((index) => index.name === indexName)
  if (!target || Number(target.unique) !== 1) {
    return false
  }
  const columns: Array<{ seqno: number; name: string }> = await dataSource.query(`PRAGMA index_info('${indexName}')`)
  const actualColumns = columns
    .sort((left, right) => Number(left.seqno) - Number(right.seqno))
    .map((column) => column.name)
  return actualColumns.length === expectedColumns.length
    && actualColumns.every((column, index) => column === expectedColumns[index])
}

/**
 * SQLite 的 ALTER TABLE ADD COLUMN 不会补外键；因此存量库即使列和索引齐全，仍要按实际 FK 形状触发一次
 * TypeORM 的临时表复制升级。该同步路径会按同名列复制历史数据，不做 SKU 回填或删除。
 */
async function hasSqliteForeignKeyShape(
  dataSource: DataSource,
  tableName: string,
  expected: {
    from: string
    referencedTable: string
    referencedColumn: string
    onDelete: string
  },
): Promise<boolean> {
  const foreignKeys: Array<{
    table: string
    from: string
    to: string
    on_delete: string
  }> = await dataSource.query(`PRAGMA foreign_key_list('${tableName}')`)
  return foreignKeys.some((foreignKey) => (
    foreignKey.from === expected.from
    && foreignKey.table === expected.referencedTable
    && foreignKey.to === expected.referencedColumn
    && foreignKey.on_delete.toUpperCase() === expected.onDelete.toUpperCase()
  ))
}

async function listSqliteIndexes(dataSource: DataSource, tableName: string): Promise<Set<string>> {
  const indexes: Array<{ name: string }> = await dataSource.query(`PRAGMA index_list('${tableName}')`)
  return new Set(indexes.map((index) => index.name))
}

async function ensureSqliteIndex(
  dataSource: DataSource,
  tableName: string,
  indexName: string,
  createIndexSql: string,
): Promise<void> {
  const tableColumnSet = await listSqliteTableColumns(dataSource, tableName)
  if (tableColumnSet.size === 0) {
    return
  }
  const indexSet = await listSqliteIndexes(dataSource, tableName)
  if (!indexSet.has(indexName)) {
    await dataSource.query(createIndexSql)
  }
}

/**
 * TypeORM 无法在含历史行的 SQLite 表上直接添加“非空 + 唯一”的 business_no。
 * 同步前先以可空列完成 show_no 原值回填，随后 synchronize 只负责收紧列和索引形状。
 */
async function prepareSqliteOrderAmendmentColumns(dataSource: DataSource): Promise<void> {
  const orderColumns = await listSqliteTableColumns(dataSource, 'biz_outbound_order')
  if (orderColumns.size === 0) return
  if (!orderColumns.has('business_no')) {
    await dataSource.query('ALTER TABLE "biz_outbound_order" ADD COLUMN "business_no" varchar(32) NULL')
  }
  if (!orderColumns.has('edit_version')) {
    await dataSource.query('ALTER TABLE "biz_outbound_order" ADD COLUMN "edit_version" integer NOT NULL DEFAULT (1)')
  }
  await dataSource.query(`
    UPDATE "biz_outbound_order"
    SET "business_no" = "show_no"
    WHERE "business_no" IS NULL OR LENGTH(TRIM("business_no")) = 0
  `)
  await dataSource.query(`
    UPDATE "biz_outbound_order"
    SET "edit_version" = 1
    WHERE "edit_version" IS NULL OR "edit_version" < 1
  `)
}

/**
 * #73 历史库存模式推断：旧手工单不追溯库存，O2O 核销正式单沿用预扣库存语义。
 * 新建手工单由服务层显式写 manual_applied，本函数不会覆盖任何合法的新模式。
 */
async function prepareSqliteOrderContentInventoryColumns(dataSource: DataSource): Promise<void> {
  const orderColumns = await listSqliteTableColumns(dataSource, 'biz_outbound_order')
  if (orderColumns.size === 0) return
  if (!orderColumns.has('inventory_mode')) {
    await dataSource.query('ALTER TABLE "biz_outbound_order" ADD COLUMN "inventory_mode" varchar(24) NULL')
  }
  await dataSource.query(`
    UPDATE "biz_outbound_order"
    SET "inventory_mode" = CASE
      WHEN "idempotency_key" LIKE 'o2o-preorder-verify:%' THEN 'o2o_preapplied'
      ELSE 'legacy_none'
    END
    WHERE "inventory_mode" IS NULL
       OR "inventory_mode" NOT IN ('legacy_none', 'manual_applied', 'o2o_preapplied')
       OR ("inventory_mode" = 'legacy_none' AND "idempotency_key" LIKE 'o2o-preorder-verify:%')
  `)
}

/**
 * #70 出库单来源快照列：存量 SQLite 先以可空列补齐，并显式建组合索引。
 * 列提前补齐后 shouldSynchronizeSqliteSchema 可能判定无需同步，索引不能依赖 synchronize 自动创建。
 */
async function prepareSqliteOrderSourceDocColumns(dataSource: DataSource): Promise<void> {
  const orderColumns = await listSqliteTableColumns(dataSource, 'biz_outbound_order')
  if (orderColumns.size === 0) return
  if (!orderColumns.has('source_doc_type')) {
    await dataSource.query('ALTER TABLE "biz_outbound_order" ADD COLUMN "source_doc_type" varchar(32) NULL')
  }
  if (!orderColumns.has('source_doc_id')) {
    await dataSource.query('ALTER TABLE "biz_outbound_order" ADD COLUMN "source_doc_id" integer NULL')
  }
  if (!orderColumns.has('source_doc_no')) {
    await dataSource.query('ALTER TABLE "biz_outbound_order" ADD COLUMN "source_doc_no" varchar(64) NULL')
  }
  await dataSource.query(
    'CREATE INDEX IF NOT EXISTS "idx_biz_outbound_source_doc" ON "biz_outbound_order" ("source_doc_type", "source_doc_id")',
  )
}

/**
 * #70 历史线上预订核销出库单回填：
 * - 以幂等键 `o2o-preorder-verify:<预订单ID>` 关联预订单，主键相等且字符串全等才视为可确认来源，防止 `12abc` 之类误匹配；
 * - 先清理明细再回填主单：明细仅在血缘主单（自身所属主单或合并复制来源主单）尚未回填、且备注与自动文案逐字节一致时置空；
 * - 主单回填来源快照，并仅清理逐字节等于自动文案的主单备注；人工备注与无法关联来源的单据一律保留；
 * - 只处理 source_doc_type 为空的主单，重复执行不会清理之后人工写回的同样文案。
 */
export async function backfillSqliteOrderSourceDocs(dataSource: DataSource): Promise<{ clearedItemRemarks: number; backfilledOrders: number }> {
  const [orderColumns, preorderColumns, itemColumns] = await Promise.all([
    listSqliteTableColumns(dataSource, 'biz_outbound_order'),
    listSqliteTableColumns(dataSource, 'o2o_preorder'),
    listSqliteTableColumns(dataSource, 'biz_outbound_order_item'),
  ])
  if (
    !orderColumns.has('source_doc_type')
    || !orderColumns.has('idempotency_key')
    || !preorderColumns.has('id')
    || !preorderColumns.has('show_no')
  ) {
    return { clearedItemRemarks: 0, backfilledOrders: 0 }
  }
  const matchedPreorderCondition = `
    p."id" = CAST(substr("biz_outbound_order"."idempotency_key", 21) AS INTEGER)
    AND "biz_outbound_order"."idempotency_key" = 'o2o-preorder-verify:' || p."id"
  `
  // 专项回填脚本会传入隔离 DataSource；先幂等安装协调器，确保随后开启的 SQLite 事务同样受单写者队列保护。
  await initializeDatabaseInfrastructure(dataSource)
  return dataSource.transaction(async (manager) => {
    let clearedItemRemarks = 0
    if (itemColumns.has('remark') && itemColumns.has('order_id') && itemColumns.has('source_order_id')) {
      await manager.query(`
        UPDATE "biz_outbound_order_item"
        SET "remark" = NULL
        WHERE "remark" IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM "biz_outbound_order" AS lineage
            INNER JOIN "o2o_preorder" AS p
              ON p."id" = CAST(substr(lineage."idempotency_key", 21) AS INTEGER)
             AND lineage."idempotency_key" = 'o2o-preorder-verify:' || p."id"
            WHERE lineage."id" = COALESCE("biz_outbound_order_item"."source_order_id", "biz_outbound_order_item"."order_id")
              AND lineage."source_doc_type" IS NULL
              AND lineage."idempotency_key" LIKE 'o2o-preorder-verify:%'
              AND "biz_outbound_order_item"."remark" = '线上预订核销，预订单号：' || p."show_no"
          )
      `)
      const [row] = await manager.query('SELECT changes() AS "changed"') as Array<{ changed: number }>
      clearedItemRemarks = Number(row?.changed ?? 0)
    }
    await manager.query(`
      UPDATE "biz_outbound_order"
      SET
        "remark" = CASE
          WHEN "remark" = (SELECT '线上预订核销出库，预订单号：' || p."show_no" FROM "o2o_preorder" AS p WHERE ${matchedPreorderCondition})
          THEN NULL
          ELSE "remark"
        END,
        "source_doc_type" = 'o2o_preorder',
        "source_doc_id" = (SELECT p."id" FROM "o2o_preorder" AS p WHERE ${matchedPreorderCondition}),
        "source_doc_no" = (SELECT p."show_no" FROM "o2o_preorder" AS p WHERE ${matchedPreorderCondition})
      WHERE "source_doc_type" IS NULL
        AND "idempotency_key" LIKE 'o2o-preorder-verify:%'
        AND EXISTS (SELECT 1 FROM "o2o_preorder" AS p WHERE ${matchedPreorderCondition})
    `)
    const [orderRow] = await manager.query('SELECT changes() AS "changed"') as Array<{ changed: number }>
    const backfilledOrders = Number(orderRow?.changed ?? 0)
    if (clearedItemRemarks > 0 || backfilledOrders > 0) {
      console.log(`[y-link-backend] 已回填线上预订核销出库单来源快照：主单 ${backfilledOrders} 条，清理自动明细备注 ${clearedItemRemarks} 条`)
    }
    return { clearedItemRemarks, backfilledOrders }
  })
}

/**
 * 合并操作结果快照在实体层为 NOT NULL。存量 SQLite 若已由早期开发版本建过表，
 * 先以可空列补齐并写入占位 JSON，再交给 synchronize 收紧列定义，避免临时表复制失败。
 */
async function prepareSqliteOrderMergeOperationResultSnapshot(dataSource: DataSource): Promise<void> {
  const columns = await listSqliteTableColumns(dataSource, 'order_merge_operation')
  if (columns.size === 0) return
  if (!columns.has('result_json')) {
    await dataSource.query('ALTER TABLE "order_merge_operation" ADD COLUMN "result_json" text NULL')
  }
  await dataSource.query(`
    UPDATE "order_merge_operation"
    SET "result_json" = '{}'
    WHERE "result_json" IS NULL OR LENGTH(TRIM("result_json")) = 0
  `)
}

/**
 * 幂等领养历史订单：businessNo 初始值固定等于 showNo，永久占用和双命名空间游标只在缺失时补齐。
 * 已存在的游标绝不按历史最大值重写，避免覆盖管理员手工重编后确认的游标位置。
 */
export async function backfillSqliteOrderAmendmentData(dataSource: DataSource): Promise<void> {
  // 专项升级脚本会把隔离 DataSource 直接传入本函数；先幂等安装协调器，确保随后开启的
  // SQLite 事务同样受单写者队列保护，而不是依赖主应用已经完成的启动顺序。
  await initializeDatabaseInfrastructure(dataSource)
  await dataSource.transaction(async (manager) => {
    const orders = await manager.query(`
      SELECT "order_uuid" AS "orderUuid", "business_no" AS "businessNo", "order_type" AS "orderType",
             "created_at" AS "createdAt"
      FROM "biz_outbound_order"
    `) as Array<{ orderUuid: string; businessNo: string; orderType: string; createdAt: string }>
    for (const order of orders) {
      const namespace = order.orderType === 'department' ? 'hyyzjd' : order.orderType === 'walkin' ? 'hyyz' : null
      const pattern = namespace === 'hyyzjd' ? /^hyyzjd(\d+)$/ : /^hyyz(\d+)$/
      const match = namespace ? pattern.exec(String(order.businessNo ?? '').trim().toLowerCase()) : null
      if (!namespace || !match) {
        throw new BizError(`历史出库单 ${order.orderUuid} 的订单类型或业务号不符合 #72 命名空间规则`, 409)
      }
      const serialValue = Number.parseInt(match[1], 10)
      if (!Number.isSafeInteger(serialValue) || serialValue <= 0) {
        throw new BizError(`历史出库单 ${order.orderUuid} 的业务号流水非法`, 409)
      }
      await manager.query(
        `INSERT OR IGNORE INTO "order_business_no_occupancy"
         ("business_namespace", "serial_value", "business_no", "order_uuid", "assigned_reason", "created_at")
         VALUES (?, ?, ?, ?, 'history_backfill', ?)`,
        [namespace, serialValue, order.businessNo, order.orderUuid, order.createdAt],
      )
    }

    const unmatchedRows = await manager.query(`
      SELECT "order"."order_uuid" AS "orderUuid"
      FROM "biz_outbound_order" "order"
      LEFT JOIN "order_business_no_occupancy" "occupancy"
        ON "occupancy"."business_no" = "order"."business_no"
       AND "occupancy"."order_uuid" = "order"."order_uuid"
       AND "occupancy"."business_namespace" = CASE
             WHEN "order"."order_type" = 'department' THEN 'hyyzjd'
             WHEN "order"."order_type" = 'walkin' THEN 'hyyz'
           END
       AND "occupancy"."serial_value" = CAST(SUBSTR(
             "order"."business_no",
             CASE WHEN "order"."order_type" = 'department' THEN 7 ELSE 5 END
           ) AS INTEGER)
      WHERE "occupancy"."id" IS NULL
      LIMIT 1
    `) as Array<{ orderUuid: string }>
    if (unmatchedRows.length > 0) {
      throw new BizError(`历史出库单 ${unmatchedRows[0].orderUuid} 的业务号永久占用存在冲突`, 409)
    }

    for (const [sequenceKey, namespace] of [
      ['order.business.department', 'hyyzjd'],
      ['order.business.walkin', 'hyyz'],
    ] as const) {
      const orderType = namespace === 'hyyzjd' ? 'department' : 'walkin'
      const startRows = await manager.query(
        'SELECT "config_value" AS "configValue" FROM "system_configs" WHERE "config_key" = ? LIMIT 1',
        [`order.serial.${orderType}.start`],
      ) as Array<{ configValue: string }>
      const configuredStart = Number.parseInt(String(startRows[0]?.configValue ?? '1'), 10)
      const initialCursor = Number.isSafeInteger(configuredStart) && configuredStart > 0 ? configuredStart - 1 : 0
      const maximumRows = await manager.query(
        `SELECT COALESCE(MAX("serial_value"), 0) AS "maximum"
         FROM "order_business_no_occupancy" WHERE "business_namespace" = ?`,
        [namespace],
      ) as Array<{ maximum: number | string }>
      const currentValue = Math.max(initialCursor, Number(maximumRows[0]?.maximum ?? 0))
      await manager.query(
        `INSERT OR IGNORE INTO "business_sequence" ("sequence_key", "current_value", "created_at", "updated_at")
         VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [sequenceKey, currentValue],
      )
    }
  })
}

async function normalizeSqliteNotificationOutbox(dataSource: DataSource): Promise<void> {
  const inboxColumns = await listSqliteTableColumns(dataSource, 'notification_inbox')
  const inboxUniqueIndexes = inboxColumns.size
    ? await listSqliteUniqueIndexes(dataSource, 'notification_inbox')
    : new Set<string>()
  if (
    inboxColumns.has('event_id')
    && inboxColumns.has('user_id')
    && !inboxUniqueIndexes.has('uk_notification_inbox_event_user')
  ) {
    // 历史同步实现可能为同一事件/账号写入重复收件箱；合并已读状态后保留最早一条。
    await dataSource.query(`
      UPDATE "notification_inbox"
      SET
        "is_read" = (
          SELECT MAX("duplicate"."is_read")
          FROM "notification_inbox" AS "duplicate"
          WHERE "duplicate"."event_id" = "notification_inbox"."event_id"
            AND "duplicate"."user_id" = "notification_inbox"."user_id"
        ),
        "read_at" = (
          SELECT MAX("duplicate"."read_at")
          FROM "notification_inbox" AS "duplicate"
          WHERE "duplicate"."event_id" = "notification_inbox"."event_id"
            AND "duplicate"."user_id" = "notification_inbox"."user_id"
        )
      WHERE "id" IN (
        SELECT MIN("id")
        FROM "notification_inbox"
        GROUP BY "event_id", "user_id"
        HAVING COUNT(*) > 1
      )
    `)
    await dataSource.query(`
      DELETE FROM "notification_inbox"
      WHERE EXISTS (
        SELECT 1
        FROM "notification_inbox" AS "older"
        WHERE "older"."event_id" = "notification_inbox"."event_id"
          AND "older"."user_id" = "notification_inbox"."user_id"
          AND "older"."id" < "notification_inbox"."id"
      )
    `)
    await ensureSqliteIndex(
      dataSource,
      'notification_inbox',
      'uk_notification_inbox_event_user',
      `CREATE UNIQUE INDEX IF NOT EXISTS "uk_notification_inbox_event_user" ON "notification_inbox" ("event_id", "user_id")`,
    )
  }

  const dispatchColumns = await listSqliteTableColumns(dataSource, 'notification_dispatch')
  const dispatchUniqueIndexes = dispatchColumns.size
    ? await listSqliteUniqueIndexes(dataSource, 'notification_dispatch')
    : new Set<string>()
  if (
    dispatchColumns.has('dedupe_key')
    && !dispatchUniqueIndexes.has('uk_notification_dispatch_event_channel_target')
  ) {
    await dataSource.query(`
      DELETE FROM "notification_dispatch"
      WHERE "dedupe_key" IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM "notification_dispatch" AS "keeper"
          WHERE "keeper"."event_id" = "notification_dispatch"."event_id"
            AND "keeper"."channel" = "notification_dispatch"."channel"
            AND "keeper"."dedupe_key" = "notification_dispatch"."dedupe_key"
            AND (
              CASE WHEN "keeper"."status" = 'sent' THEN 0 ELSE 1 END
                < CASE WHEN "notification_dispatch"."status" = 'sent' THEN 0 ELSE 1 END
              OR (
                CASE WHEN "keeper"."status" = 'sent' THEN 0 ELSE 1 END
                  = CASE WHEN "notification_dispatch"."status" = 'sent' THEN 0 ELSE 1 END
                AND "keeper"."id" < "notification_dispatch"."id"
              )
            )
        )
    `)
    await ensureSqliteIndex(
      dataSource,
      'notification_dispatch',
      'uk_notification_dispatch_event_channel_target',
      `CREATE UNIQUE INDEX IF NOT EXISTS "uk_notification_dispatch_event_channel_target" ON "notification_dispatch" ("event_id", "channel", "dedupe_key")`,
    )
  }
}

async function ensureSqliteMallCatalogIndexes(dataSource: DataSource): Promise<void> {
  await ensureSqliteIndex(
    dataSource,
    'base_product',
    'idx_base_product_mall_list',
    `CREATE INDEX IF NOT EXISTS "idx_base_product_mall_list" ON "base_product" ("is_active", "o2o_status", "id")`,
  )
  await ensureSqliteIndex(
    dataSource,
    'base_product_sku',
    'idx_base_product_sku_mall_list',
    `CREATE INDEX IF NOT EXISTS "idx_base_product_sku_mall_list" ON "base_product_sku" ("product_id", "is_active", "sort_order", "id")`,
  )
  await ensureSqliteIndex(
    dataSource,
    'base_product_sku',
    'idx_base_product_sku_current_mall_list',
    `CREATE INDEX IF NOT EXISTS "idx_base_product_sku_current_mall_list" ON "base_product_sku" ("product_id", "is_current", "is_active", "sort_order", "id")`,
  )
  await ensureSqliteIndex(
    dataSource,
    'o2o_preorder_item',
    'idx_o2o_preorder_item_product_order',
    `CREATE INDEX IF NOT EXISTS "idx_o2o_preorder_item_product_order" ON "o2o_preorder_item" ("product_id", "order_id")`,
  )
  await ensureSqliteIndex(
    dataSource,
    'o2o_preorder_item',
    'idx_o2o_preorder_item_sku_order',
    `CREATE INDEX IF NOT EXISTS "idx_o2o_preorder_item_sku_order" ON "o2o_preorder_item" ("sku_id", "order_id")`,
  )
  await ensureSqliteIndex(
    dataSource,
    'o2o_preorder',
    'idx_o2o_preorder_client_deleted_id',
    `CREATE INDEX IF NOT EXISTS "idx_o2o_preorder_client_deleted_id" ON "o2o_preorder" ("client_user_id", "is_deleted", "id")`,
  )
  await ensureSqliteIndex(
    dataSource,
    'o2o_preorder',
    'idx_o2o_preorder_client_deleted_status_id',
    `CREATE INDEX IF NOT EXISTS "idx_o2o_preorder_client_deleted_status_id" ON "o2o_preorder" ("client_user_id", "is_deleted", "status", "id")`,
  )
  await ensureSqliteIndex(
    dataSource,
    'o2o_preorder',
    'idx_o2o_preorder_pending_timeout_partial',
    `CREATE INDEX IF NOT EXISTS "idx_o2o_preorder_pending_timeout_partial" ON "o2o_preorder" ("timeout_at", "id") WHERE "status" = 'pending' AND "is_deleted" = 0`,
  )
  await ensureSqliteIndex(
    dataSource,
    'inventory_log',
    'idx_inventory_log_ref_lookup',
    `CREATE INDEX IF NOT EXISTS "idx_inventory_log_ref_lookup" ON "inventory_log" ("ref_type", "ref_id", "change_type", "id")`,
  )
  await ensureSqliteIndex(
    dataSource,
    'inventory_log',
    'idx_inventory_log_product_created',
    `CREATE INDEX IF NOT EXISTS "idx_inventory_log_product_created" ON "inventory_log" ("product_id", "created_at", "id")`,
  )
  await ensureSqliteIndex(
    dataSource,
    'notification_inbox',
    'idx_notification_inbox_user_unread_id',
    `CREATE INDEX IF NOT EXISTS "idx_notification_inbox_user_unread_id" ON "notification_inbox" ("user_id", "is_read", "id")`,
  )
  await ensureSqliteIndex(
    dataSource,
    'client_user_session',
    'idx_client_user_session_expires_id',
    `CREATE INDEX IF NOT EXISTS "idx_client_user_session_expires_id" ON "client_user_session" ("expires_at", "id")`,
  )
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

  refreshedColumnSet = await listSqliteTableColumns(dataSource, 'biz_outbound_order_item')
  if (!refreshedColumnSet.has('sku_id')) {
    await dataSource.query(`ALTER TABLE "biz_outbound_order_item" ADD COLUMN "sku_id" integer NULL`)
  }
  if (!refreshedColumnSet.has('sku_code_snapshot')) {
    await dataSource.query(`ALTER TABLE "biz_outbound_order_item" ADD COLUMN "sku_code_snapshot" varchar(96) NULL`)
  }
  if (!refreshedColumnSet.has('spec_text_snapshot')) {
    await dataSource.query(`ALTER TABLE "biz_outbound_order_item" ADD COLUMN "spec_text_snapshot" varchar(255) NULL`)
  }
  await ensureSqliteIndex(
    dataSource,
    'biz_outbound_order_item',
    'idx_biz_outbound_item_sku_id',
    `CREATE INDEX IF NOT EXISTS "idx_biz_outbound_item_sku_id" ON "biz_outbound_order_item" ("sku_id")`,
  )

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

async function normalizeSqliteO2oDiscountColumns(dataSource: DataSource): Promise<void> {
  const productColumnSet = await listSqliteTableColumns(dataSource, 'base_product')
  if (productColumnSet.size > 0 && !productColumnSet.has('discount_rate')) {
    await dataSource.query(`ALTER TABLE "base_product" ADD COLUMN "discount_rate" decimal(3, 1) NOT NULL DEFAULT 10.0`)
  }
  if (productColumnSet.size > 0 && !productColumnSet.has('o2o_recommended')) {
    await dataSource.query(`ALTER TABLE "base_product" ADD COLUMN "o2o_recommended" tinyint NOT NULL DEFAULT 0`)
  }

  const itemColumnSet = await listSqliteTableColumns(dataSource, 'o2o_preorder_item')
  if (itemColumnSet.size === 0) {
    return
  }
  if (!itemColumnSet.has('original_price')) {
    await dataSource.query(`ALTER TABLE "o2o_preorder_item" ADD COLUMN "original_price" decimal(12, 2) NOT NULL DEFAULT 0.00`)
  }
  if (!itemColumnSet.has('discount_rate')) {
    await dataSource.query(`ALTER TABLE "o2o_preorder_item" ADD COLUMN "discount_rate" decimal(3, 1) NOT NULL DEFAULT 10.0`)
  }
  if (!itemColumnSet.has('unit_price')) {
    await dataSource.query(`ALTER TABLE "o2o_preorder_item" ADD COLUMN "unit_price" decimal(12, 2) NOT NULL DEFAULT 0.00`)
  }
  if (!itemColumnSet.has('line_amount')) {
    await dataSource.query(`ALTER TABLE "o2o_preorder_item" ADD COLUMN "line_amount" decimal(14, 2) NOT NULL DEFAULT 0.00`)
  }
  if (!itemColumnSet.has('sku_id')) {
    await dataSource.query(`ALTER TABLE "o2o_preorder_item" ADD COLUMN "sku_id" integer NULL`)
  }
  if (!itemColumnSet.has('sku_code_snapshot')) {
    await dataSource.query(`ALTER TABLE "o2o_preorder_item" ADD COLUMN "sku_code_snapshot" varchar(96) NULL`)
  }
  if (!itemColumnSet.has('spec_text_snapshot')) {
    await dataSource.query(`ALTER TABLE "o2o_preorder_item" ADD COLUMN "spec_text_snapshot" varchar(255) NULL`)
  }
  if (!itemColumnSet.has('sku_image_snapshot')) {
    await dataSource.query(`ALTER TABLE "o2o_preorder_item" ADD COLUMN "sku_image_snapshot" varchar(255) NULL`)
  }

  const skuTableColumnSet = await listSqliteTableColumns(dataSource, 'base_product_sku')
  if (skuTableColumnSet.size > 0) {
    if (!skuTableColumnSet.has('o2o_recommended')) {
      await dataSource.query(`ALTER TABLE "base_product_sku" ADD COLUMN "o2o_recommended" tinyint NOT NULL DEFAULT 0`)
    }
    if (!skuTableColumnSet.has('is_current')) {
      await dataSource.query(`ALTER TABLE "base_product_sku" ADD COLUMN "is_current" tinyint NOT NULL DEFAULT 1`)
      await dataSource.query(`
        UPDATE "base_product_sku"
        SET "is_current" = 0,
            "o2o_recommended" = 0
        WHERE "is_active" = 0
      `)
    }
    await dataSource.query(`
      INSERT INTO "base_product_sku" (
        "product_id",
        "sku_code",
        "spec_values_json",
        "spec_text",
        "default_price",
        "discount_rate",
        "current_stock",
        "pre_ordered_stock",
        "is_active",
        "is_current",
        "o2o_recommended",
        "thumbnail",
        "sort_order"
      )
      SELECT
        "base_product"."id",
        'SKU-' || "base_product"."id",
        '{}',
        '默认规格',
        "base_product"."default_price",
        "base_product"."discount_rate",
        "base_product"."current_stock",
        "base_product"."pre_ordered_stock",
        "base_product"."is_active",
        1,
        0,
        "base_product"."thumbnail",
        0
      FROM "base_product"
      WHERE NOT EXISTS (
        SELECT 1
        FROM "base_product_sku"
        WHERE "base_product_sku"."product_id" = "base_product"."id"
      )
    `)
  }

  const returnItemColumnSet = await listSqliteTableColumns(dataSource, 'o2o_return_request_item')
  if (returnItemColumnSet.size > 0 && !returnItemColumnSet.has('sku_id')) {
    await dataSource.query(`ALTER TABLE "o2o_return_request_item" ADD COLUMN "sku_id" integer NULL`)
  }
  if (returnItemColumnSet.size > 0 && !returnItemColumnSet.has('sku_code_snapshot')) {
    await dataSource.query(`ALTER TABLE "o2o_return_request_item" ADD COLUMN "sku_code_snapshot" varchar(96) NULL`)
  }
  if (returnItemColumnSet.size > 0 && !returnItemColumnSet.has('spec_text_snapshot')) {
    await dataSource.query(`ALTER TABLE "o2o_return_request_item" ADD COLUMN "spec_text_snapshot" varchar(255) NULL`)
  }

  if (skuTableColumnSet.size > 0) {
    await dataSource.query(`
      UPDATE "o2o_preorder_item"
      SET
        "sku_id" = (
          SELECT "id"
          FROM "base_product_sku"
          WHERE "base_product_sku"."product_id" = "o2o_preorder_item"."product_id"
          ORDER BY "sort_order" ASC, "id" ASC
          LIMIT 1
        ),
        "sku_code_snapshot" = COALESCE("sku_code_snapshot", (
          SELECT "sku_code"
          FROM "base_product_sku"
          WHERE "base_product_sku"."product_id" = "o2o_preorder_item"."product_id"
          ORDER BY "sort_order" ASC, "id" ASC
          LIMIT 1
        )),
        "spec_text_snapshot" = COALESCE("spec_text_snapshot", (
          SELECT "spec_text"
          FROM "base_product_sku"
          WHERE "base_product_sku"."product_id" = "o2o_preorder_item"."product_id"
          ORDER BY "sort_order" ASC, "id" ASC
          LIMIT 1
        )),
        "sku_image_snapshot" = COALESCE("sku_image_snapshot", (
          SELECT "thumbnail"
          FROM "base_product_sku"
          WHERE "base_product_sku"."product_id" = "o2o_preorder_item"."product_id"
          ORDER BY "sort_order" ASC, "id" ASC
          LIMIT 1
        ))
      WHERE "sku_id" IS NULL
        AND EXISTS (
          SELECT 1
          FROM "base_product_sku"
          WHERE "base_product_sku"."product_id" = "o2o_preorder_item"."product_id"
        )
    `)

    if (returnItemColumnSet.size > 0) {
      await dataSource.query(`
        UPDATE "o2o_return_request_item"
        SET
          "sku_id" = (
            SELECT "id"
            FROM "base_product_sku"
            WHERE "base_product_sku"."product_id" = "o2o_return_request_item"."product_id"
            ORDER BY "sort_order" ASC, "id" ASC
            LIMIT 1
          ),
          "sku_code_snapshot" = COALESCE("sku_code_snapshot", (
            SELECT "sku_code"
            FROM "base_product_sku"
            WHERE "base_product_sku"."product_id" = "o2o_return_request_item"."product_id"
            ORDER BY "sort_order" ASC, "id" ASC
            LIMIT 1
          )),
          "spec_text_snapshot" = COALESCE("spec_text_snapshot", (
            SELECT "spec_text"
            FROM "base_product_sku"
            WHERE "base_product_sku"."product_id" = "o2o_return_request_item"."product_id"
            ORDER BY "sort_order" ASC, "id" ASC
            LIMIT 1
          ))
        WHERE "sku_id" IS NULL
          AND EXISTS (
            SELECT 1
            FROM "base_product_sku"
            WHERE "base_product_sku"."product_id" = "o2o_return_request_item"."product_id"
          )
      `)
    }
  }

  await dataSource.query(`
    UPDATE "o2o_preorder_item"
    SET
      "original_price" = printf('%.2f', CAST(COALESCE((
        SELECT "default_price"
        FROM "base_product"
        WHERE "base_product"."id" = "o2o_preorder_item"."product_id"
      ), 0) AS REAL)),
      "discount_rate" = printf('%.1f', CAST(COALESCE((
        SELECT "discount_rate"
        FROM "base_product"
        WHERE "base_product"."id" = "o2o_preorder_item"."product_id"
      ), 10.0) AS REAL))
    WHERE CAST(COALESCE("original_price", 0) AS REAL) <= 0
  `)

  await dataSource.query(`
    UPDATE "o2o_preorder_item"
    SET
      "unit_price" = printf('%.2f', ROUND(CAST(COALESCE("original_price", 0) AS REAL) * CAST(COALESCE("discount_rate", 10.0) AS REAL) / 10.0, 2)),
      "line_amount" = printf('%.2f', ROUND(CAST(COALESCE("qty", 0) AS REAL) * ROUND(CAST(COALESCE("original_price", 0) AS REAL) * CAST(COALESCE("discount_rate", 10.0) AS REAL) / 10.0, 2), 2))
    WHERE CAST(COALESCE("unit_price", 0) AS REAL) <= 0 OR CAST(COALESCE("line_amount", 0) AS REAL) <= 0
  `)
}

async function normalizeSqliteInboundSkuColumn(dataSource: DataSource): Promise<void> {
  const itemColumnSet = await listSqliteTableColumns(dataSource, 'biz_inbound_order_item')
  if (itemColumnSet.size === 0) {
    return
  }
  if (!itemColumnSet.has('sku_id')) {
    await dataSource.query(`ALTER TABLE "biz_inbound_order_item" ADD COLUMN "sku_id" integer NULL`)
  }

  const skuColumnSet = await listSqliteTableColumns(dataSource, 'base_product_sku')
  const requiredSkuColumns = [
    'id',
    'product_id',
    'is_active',
    'is_current',
    'spec_text',
    'spec_values_json',
    'sort_order',
  ]
  if (requiredSkuColumns.some((column) => !skuColumnSet.has(column))) {
    // 009 时代的旧库可能已有入库明细，却尚未引入 SKU 表。先补 sku_id 让
    // synchronize 能升级结构，待 SKU 表创建完成后再执行下面的历史回填。
    return
  }

  // 历史入库明细没有 SKU 维度；迁移时优先绑定“默认规格”，其次绑定排序最前的当前启用 SKU。
  await dataSource.query(`
    UPDATE "biz_inbound_order_item"
    SET "sku_id" = (
      SELECT "sku"."id"
      FROM "base_product_sku" AS "sku"
      WHERE "sku"."product_id" = "biz_inbound_order_item"."product_id"
        AND "sku"."is_active" = 1
        AND "sku"."is_current" = 1
      ORDER BY
        CASE WHEN "sku"."spec_text" = '默认规格' OR "sku"."spec_values_json" = '{}' THEN 0 ELSE 1 END,
        "sku"."sort_order" ASC,
        "sku"."id" ASC
      LIMIT 1
    )
    WHERE "sku_id" IS NULL
  `)
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

export async function migrateLegacyDepartmentAccountsToTeacherProfiles(
  dataSource: DataSource,
): Promise<{ migratedCount: number }> {
  const { runInTransaction } = await import('./transaction-runner.js')
  return runInTransaction(async (manager) => {
    const migrations = await collectLegacyDepartmentTeacherMigrations(manager)
    if (migrations.length === 0) {
      return { migratedCount: 0 }
    }
    const userRepo = manager.getRepository(ClientUser)
    for (const migration of migrations) {
      const user = await userRepo.findOneByOrFail({ id: migration.userId })
      user.accountType = 'personal'
      user.realName = migration.realName
      user.departmentName = migration.departmentName
      user.departmentNodeId = null
      user.staffVerified = true
      await userRepo.save(user)
    }
    return { migratedCount: migrations.length }
  })
}

interface LegacyDepartmentTeacherMigration {
  userId: string
  realName: string
  departmentName: string
}

async function collectLegacyDepartmentTeacherMigrations(
  manager: EntityManager,
): Promise<LegacyDepartmentTeacherMigration[]> {
  const usePessimisticLock = manager.connection.options.type === 'mysql'
  const legacyUsersQuery = manager.getRepository(ClientUser)
    .createQueryBuilder('user')
    .where('user.accountType = :accountType', { accountType: 'department' })
    .andWhere('user.departmentNodeId IS NULL')
    .andWhere("user.staffNo IS NOT NULL AND user.staffNo <> ''")
  if (usePessimisticLock) {
    legacyUsersQuery.setLock('pessimistic_write')
  }
  const legacyUsers = await legacyUsersQuery.getMany()
  if (legacyUsers.length === 0) {
    return []
  }

  const staffNos = [...new Set(legacyUsers.map((user) => user.staffNo?.trim()).filter((item): item is string => Boolean(item)))]
  if (staffNos.length === 0) {
    return []
  }

  const activeStaffQuery = manager.getRepository(ClientStaffDirectory)
    .createQueryBuilder('directory')
    .where('directory.status = :status', { status: 'active' })
    .andWhere('directory.staffNo IN (:...staffNos)', { staffNos })
  if (usePessimisticLock) {
    activeStaffQuery.setLock('pessimistic_write')
  }
  const activeStaffList = await activeStaffQuery.getMany()
  const activeStaffMap = new Map(activeStaffList.map((item) => [item.staffNo, item]))
  const migrations: LegacyDepartmentTeacherMigration[] = []

  for (const user of legacyUsers) {
    const staffNo = user.staffNo?.trim() ?? ''
    const matchedStaff = activeStaffMap.get(staffNo)
    if (!matchedStaff) {
      continue
    }
    migrations.push({
      userId: user.id,
      realName: matchedStaff.realName,
      departmentName: matchedStaff.departmentName,
    })
  }
  return migrations
}

/**
 * 将存量部门共享账号绑定到部门树的稳定节点：
 * - 先完整预检，任一空部门、无法定位、重复映射或重复节点ID都不写入；
 * - 个人/教师账号始终清空节点绑定，避免历史部门账号转教师后占用部门唯一键；
 * - 不修改账号状态、密码或历史订单快照。
 */
export async function migrateDepartmentAccountNodeBindings(
  dataSource: DataSource,
): Promise<{ migratedCount: number }> {
  return migrateClientUserDepartmentGovernance(dataSource)
}

/**
 * 统一完成旧部门账号转教师、非部门节点清理与剩余部门账号节点回填。
 * 预检阶段不写库；只有所有迁移目标均可解析且没有重复绑定时，才通过一次事务提交全部变化。
 */
export async function migrateClientUserDepartmentGovernance(
  dataSource: DataSource,
): Promise<{ migratedCount: number }> {
  // 不能在模块顶层静态引入 systemConfigService：其依赖 AppDataSource，而本文件会在数据源装配期被读取。
  // 仅在数据源已初始化且确实需要回填时加载，避免启动依赖环；不得在事务外读取配置或账号计划。
  const { systemConfigService } = await import('../services/system-config.service.js')
  // 与业务写入一致走统一事务闸门，避免 SQLite 单连接下绕过串行协调器。
  // 动态加载是为了避免 bootstrap -> transaction-runner -> data-source 的模块初始化环。
  const { runInTransaction } = await import('./transaction-runner.js')
  return runInTransaction(async (manager) => {
    const usePessimisticLock = manager.connection.options.type === 'mysql'
    await systemConfigService.ensureDefaultConfigs(manager)
    // 所有输入读取、迁移计划和校验都必须在同一事务快照中完成；校验失败时回调抛错，零写入提交。
    const config = await systemConfigService.getClientDepartmentConfigs(manager, { lockForUpdate: true })
    const nodeIdSet = new Set<string>()
    const collectNodeIds = (nodes: typeof config.tree) => {
      for (const node of nodes) {
        if (!node.id?.trim() || node.id.length > 128) {
          throw new BizError('部门共享账号节点回填已阻止：部门树存在无效节点ID，请先修复部门配置', 409)
        }
        if (nodeIdSet.has(node.id)) {
          throw new BizError('部门共享账号节点回填已阻止：部门树存在重复节点ID，请先修复部门配置', 409)
        }
        nodeIdSet.add(node.id)
        collectNodeIds(node.children)
      }
    }
    collectNodeIds(config.tree)

    const teacherMigrations = await collectLegacyDepartmentTeacherMigrations(manager)
    const teacherMigrationUserIds = new Set(teacherMigrations.map((item) => item.userId))
    const departmentUsersQuery = manager.getRepository(ClientUser)
      .createQueryBuilder('user')
      .where('user.accountType = :accountType', { accountType: 'department' })
    if (usePessimisticLock) {
      departmentUsersQuery.setLock('pessimistic_write')
    }
    const departmentUsers = await departmentUsersQuery.getMany()
    // 已有稳定节点绑定的账号属于新部门共享账号，启动迁移不能因其 staffNo
    // 恰好命中目录而转教师或按显示路径重新映射。
    const remainingDepartmentUsers = departmentUsers.filter(
      (user) => !teacherMigrationUserIds.has(user.id) && !user.departmentNodeId,
    )
    const mappings: Array<{ user: ClientUser; departmentNodeId: string }> = []
    let emptyDepartmentCount = 0
    let unresolvedDepartmentCount = 0
    for (const user of remainingDepartmentUsers) {
      if (!user.departmentName?.trim()) {
        emptyDepartmentCount += 1
        continue
      }
      try {
        const resolved = await systemConfigService.resolveClientDepartmentReference(
          { departmentName: user.departmentName },
          manager,
          config,
        )
        mappings.push({ user, departmentNodeId: resolved.departmentNodeId })
      } catch {
        unresolvedDepartmentCount += 1
      }
    }
    const duplicateNodeCount = mappings.length - new Set(mappings.map((item) => item.departmentNodeId)).size
    if (emptyDepartmentCount > 0 || unresolvedDepartmentCount > 0 || duplicateNodeCount > 0) {
      throw new BizError(
        `部门共享账号节点回填已阻止：空部门 ${emptyDepartmentCount} 条、无法映射 ${unresolvedDepartmentCount} 条、节点重复 ${duplicateNodeCount} 条；未改写任何账号数据`,
        409,
      )
    }

    const userRepo = manager.getRepository(ClientUser)
    await userRepo
      .createQueryBuilder()
      .update(ClientUser)
      .set({ departmentNodeId: null })
      .where('account_type <> :accountType AND department_node_id IS NOT NULL', { accountType: 'department' })
      .execute()
    for (const migration of teacherMigrations) {
      const user = await userRepo.findOneByOrFail({ id: migration.userId })
      user.accountType = 'personal'
      user.realName = migration.realName
      user.departmentName = migration.departmentName
      user.departmentNodeId = null
      user.staffVerified = true
      await userRepo.save(user)
    }
    for (const mapping of mappings) {
      const user = await userRepo.findOneByOrFail({ id: mapping.user.id })
      user.departmentNodeId = mapping.departmentNodeId
      await userRepo.save(user)
    }
    return { migratedCount: teacherMigrations.length + mappings.length }
  })
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
  if (!await hasSqliteForeignKeyShape(dataSource, 'biz_outbound_order_item', {
    from: 'sku_id',
    referencedTable: 'base_product_sku',
    referencedColumn: 'id',
    onDelete: 'SET NULL',
  })) {
    return true
  }

  const orderMergeOperationColumnSet = await listSqliteTableColumns(dataSource, 'order_merge_operation')
  if (SQLITE_REQUIRED_ORDER_MERGE_OPERATION_COLUMNS.some((column) => !orderMergeOperationColumnSet.has(column))) {
    return true
  }
  if (!await hasSqliteNotNullColumn(dataSource, 'order_merge_operation', 'result_json')) {
    return true
  }

  const inventoryLogColumnSet = await listSqliteTableColumns(dataSource, 'inventory_log')
  if (SQLITE_REQUIRED_INVENTORY_LOG_COLUMNS.some((column) => !inventoryLogColumnSet.has(column))) {
    return true
  }
  if (!await hasSqliteForeignKeyShape(dataSource, 'inventory_log', {
    from: 'sku_id',
    referencedTable: 'base_product_sku',
    referencedColumn: 'id',
    onDelete: 'SET NULL',
  })) {
    return true
  }

  const productColumnSet = await listSqliteTableColumns(dataSource, 'base_product')
  if (SQLITE_REQUIRED_PRODUCT_COLUMNS.some((column) => !productColumnSet.has(column))) {
    return true
  }

  const productSkuColumnSet = await listSqliteTableColumns(dataSource, 'base_product_sku')
  if (SQLITE_REQUIRED_PRODUCT_SKU_COLUMNS.some((column) => !productSkuColumnSet.has(column))) {
    return true
  }

  const clientUserColumnSet = await listSqliteTableColumns(dataSource, 'client_user')
  if (SQLITE_REQUIRED_CLIENT_USER_COLUMNS.some((column) => !clientUserColumnSet.has(column))) {
    return true
  }
  const clientUserUniqueIndexSet = await listSqliteUniqueIndexes(dataSource, 'client_user')
  if (
    !clientUserUniqueIndexSet.has('uk_client_user_staff_no')
    || !await hasSqliteUniqueIndexShape(
      dataSource,
      'client_user',
      'uk_client_user_department_node_id',
      ['department_node_id'],
    )
  ) {
    return true
  }

  const clientStaffDirectoryColumnSet = await listSqliteTableColumns(dataSource, 'client_staff_directory')
  if (SQLITE_REQUIRED_CLIENT_STAFF_DIRECTORY_COLUMNS.some((column) => !clientStaffDirectoryColumnSet.has(column))) {
    return true
  }

  const sysUserColumnSet = await listSqliteTableColumns(dataSource, 'sys_user')
  if (SQLITE_REQUIRED_SYS_USER_COLUMNS.some((column) => !sysUserColumnSet.has(column))) {
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
  const o2oPreorderUniqueIndexSet = await listSqliteUniqueIndexes(dataSource, 'o2o_preorder')
  if (!o2oPreorderUniqueIndexSet.has('uk_o2o_preorder_client_request')) {
    return true
  }

  const o2oPreorderItemColumnSet = await listSqliteTableColumns(dataSource, 'o2o_preorder_item')
  if (SQLITE_REQUIRED_O2O_PREORDER_ITEM_COLUMNS.some((column) => !o2oPreorderItemColumnSet.has(column))) {
    return true
  }

  const o2oReturnRequestColumnSet = await listSqliteTableColumns(dataSource, 'o2o_return_request')
  if (SQLITE_REQUIRED_O2O_RETURN_REQUEST_COLUMNS.some((column) => !o2oReturnRequestColumnSet.has(column))) {
    return true
  }

  const o2oReturnRequestItemColumnSet = await listSqliteTableColumns(dataSource, 'o2o_return_request_item')
  if (SQLITE_REQUIRED_O2O_RETURN_REQUEST_ITEM_COLUMNS.some((column) => !o2oReturnRequestItemColumnSet.has(column))) {
    return true
  }

  const inboundOrderColumnSet = await listSqliteTableColumns(dataSource, 'biz_inbound_order')
  if (SQLITE_REQUIRED_BIZ_INBOUND_ORDER_COLUMNS.some((column) => !inboundOrderColumnSet.has(column))) {
    return true
  }

  const inboundOrderItemColumnSet = await listSqliteTableColumns(dataSource, 'biz_inbound_order_item')
  if (SQLITE_REQUIRED_BIZ_INBOUND_ORDER_ITEM_COLUMNS.some((column) => !inboundOrderItemColumnSet.has(column))) {
    return true
  }

  const notificationRuleColumnSet = await listSqliteTableColumns(dataSource, 'notification_rule')
  if (SQLITE_REQUIRED_NOTIFICATION_RULE_COLUMNS.some((column) => !notificationRuleColumnSet.has(column))) {
    return true
  }

  const notificationEventColumnSet = await listSqliteTableColumns(dataSource, 'notification_event')
  if (SQLITE_REQUIRED_NOTIFICATION_EVENT_COLUMNS.some((column) => !notificationEventColumnSet.has(column))) {
    return true
  }

  const notificationDispatchColumnSet = await listSqliteTableColumns(dataSource, 'notification_dispatch')
  if (SQLITE_REQUIRED_NOTIFICATION_DISPATCH_COLUMNS.some((column) => !notificationDispatchColumnSet.has(column))) {
    return true
  }

  const notificationInboxUniqueIndexSet = await listSqliteUniqueIndexes(dataSource, 'notification_inbox')
  if (!notificationInboxUniqueIndexSet.has('uk_notification_inbox_event_user')) {
    return true
  }

  const notificationDispatchUniqueIndexSet = await listSqliteUniqueIndexes(dataSource, 'notification_dispatch')
  if (!notificationDispatchUniqueIndexSet.has('uk_notification_dispatch_event_channel_target')) {
    return true
  }
  const accountForeignKeys = [
    ['sys_user_session', 'user_id', 'sys_user'],
    ['client_user_session', 'user_id', 'client_user'],
    ['client_mobile_session', 'client_user_id', 'client_user'],
    ['biz_inbound_order', 'supplier_id', 'sys_user'],
    ['o2o_preorder', 'client_user_id', 'client_user'],
    ['o2o_return_request', 'client_user_id', 'client_user'],
    ['client_feedback_conversation', 'client_user_id', 'client_user'],
    ['client_feedback_conversation', 'assigned_user_id', 'sys_user'],
    ['client_feedback_conversation', 'internal_remark_by_user_id', 'sys_user'],
    ['client_feedback_attachment', 'owner_client_user_id', 'client_user'],
    ['notification_inbox', 'user_id', 'sys_user'],
  ] as const
  for (const [tableName, columnName, referencedTable] of accountForeignKeys) {
    if (!await hasSqliteForeignKeyShape(dataSource, tableName, {
      from: columnName,
      referencedTable,
      referencedColumn: 'id',
      onDelete: 'RESTRICT',
    })) {
      return true
    }
  }
  return false
}

export async function initializeDatabaseSchemaIfNeeded(dataSource: DataSource): Promise<DatabaseSchemaInitResult> {
  if (env.DB_TYPE === 'sqlite') {
    await ensureSqliteMobileSessionSchema(dataSource)
    await prepareSqliteOrderAmendmentColumns(dataSource)
    await prepareSqliteOrderContentInventoryColumns(dataSource)
    await prepareSqliteOrderSourceDocColumns(dataSource)
    await prepareSqliteOrderMergeOperationResultSnapshot(dataSource)
    await normalizeSqliteOutboundItemColumns(dataSource)
    await normalizeSqliteO2oDiscountColumns(dataSource)
    await normalizeSqliteInboundSkuColumn(dataSource)
    await normalizeSqliteNotificationOutbox(dataSource)
  }

  // DB_SYNC=true 时直接走 TypeORM 同步，便于本地快速调试实体结构。
  if (env.DB_SYNC === true) {
    await dataSource.synchronize()
    if (env.DB_TYPE === 'sqlite') {
      // synchronize 可能刚创建 SKU 表；先为历史商品补默认 SKU，再让入库明细绑定它。
      await normalizeSqliteO2oDiscountColumns(dataSource)
      await normalizeSqliteInboundSkuColumn(dataSource)
      // 索引可能依赖本次 synchronize 才补齐的列，必须在结构升级后创建。
      await ensureSqliteMallCatalogIndexes(dataSource)
      await backfillSqliteOrderAmendmentData(dataSource)
      await prepareSqliteOrderContentInventoryColumns(dataSource)
      await backfillSqliteOrderSourceDocs(dataSource)
    }
    await migrateClientUserDepartmentGovernance(dataSource)
    await migrateLegacyFeedbackAttachments(dataSource)
    if (env.DB_TYPE === 'sqlite') await ensureSqliteAccountLifecycleAppendOnly(dataSource)
    return {
      action: 'synchronized',
      reason: 'forced_by_db_sync',
    }
  }

  if (env.DB_TYPE !== 'sqlite') {
    // MySQL 结构此前被视为完全由运维外部管理，启动阶段不做任何校验；
    // 一旦运维忘记手动执行 backend/sql/ 下的增量脚本，缺表故障只会在业务接口报错时才暴露
    // （例如认证接口依赖的 auth_risk_state 表缺失会导致登录接口直接 500）。
    // 这里补上两层保障：按需自动执行迁移脚本，随后对关键表、列和索引做只读契约自检，
    // 任一必需结构缺失或索引形状不符都直接阻止启动。
    const migrationResult = await runMysqlSchemaMigrations(dataSource)
    if (migrationResult.appliedFiles.length > 0) {
      console.log(`[y-link-backend] MySQL 迁移脚本已自动执行：${migrationResult.appliedFiles.join(', ')}`)
    }
    await assertMysqlRequiredSchemaExists(dataSource)
    await migrateClientUserDepartmentGovernance(dataSource)
    return {
      action: migrationResult.appliedFiles.length > 0 ? 'synchronized' : 'skipped',
      reason: 'mysql_external',
    }
  }

  const needSynchronize = await shouldSynchronizeSqliteSchema(dataSource)
  if (!needSynchronize) {
    await ensureSqliteMallCatalogIndexes(dataSource)
    await backfillSqliteOrderAmendmentData(dataSource)
    await prepareSqliteOrderContentInventoryColumns(dataSource)
    await backfillSqliteOrderSourceDocs(dataSource)
    await migrateClientUserDepartmentGovernance(dataSource)
    await ensureSqliteAccountLifecycleAppendOnly(dataSource)
    await migrateLegacyFeedbackAttachments(dataSource)
    return {
      action: 'skipped',
      reason: 'sqlite_schema_ready',
    }
  }

  // SQLite 现有本地库在认证系统接入后，需要自动补齐新表与开单留痕字段。
  await dataSource.synchronize()
  await normalizeSqliteO2oDiscountColumns(dataSource)
  await normalizeSqliteInboundSkuColumn(dataSource)
  await ensureSqliteMallCatalogIndexes(dataSource)
  await backfillSqliteOrderAmendmentData(dataSource)
  await prepareSqliteOrderContentInventoryColumns(dataSource)
  await backfillSqliteOrderSourceDocs(dataSource)
  await migrateClientUserDepartmentGovernance(dataSource)
  await ensureSqliteAccountLifecycleAppendOnly(dataSource)
  await migrateLegacyFeedbackAttachments(dataSource)
  return {
    action: 'synchronized',
    reason: 'sqlite_schema_bootstrap',
  }
}
