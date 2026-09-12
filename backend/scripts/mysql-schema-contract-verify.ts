/**
 * 文件说明：MySQL 启动结构契约回归验证。
 * 实现逻辑：使用只读 DataSource 替身模拟完整库、漏执行 035/036/038/039/041、错误列形状、外键及同名错误索引，
 * 确认服务会在对外启动前阻断，并给出精确的增量脚本指引。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DataSource } from 'typeorm'

process.env.Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE = 'true'
process.env.DB_TYPE = 'mysql'
process.env.DB_AUTO_MIGRATE = 'false'

const { assertMysqlRequiredSchemaExists } = await import('../src/config/mysql-migration-runner.js')
const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const REQUIRED_TABLES = [
  'base_product',
  'base_product_sku',
  'sys_user',
  'sys_user_session',
  'client_user',
  'client_user_session',
  'client_feedback_conversation',
  'client_feedback_attachment',
  'o2o_preorder',
  'o2o_return_request',
  'o2o_preorder_item',
  'biz_outbound_order',
  'biz_outbound_order_item',
  'inventory_log',
  'biz_inbound_order',
  'biz_inbound_order_item',
  'notification_event',
  'notification_inbox',
  'notification_dispatch',
  'auth_risk_state',
  'business_sequence',
  'client_mobile_session',
  'sms_verification_record',
  'order_business_no_occupancy',
  'order_revision',
  'account_lifecycle_event',
] as const

const REQUIRED_COLUMNS = [
  ...['deactivated_at', 'deactivation_reason', 'deactivated_by_user_id', 'deactivated_by_username', 'deactivated_by_display_name', 'restored_at', 'restored_by_user_id', 'restored_by_username', 'restored_by_display_name']
    .flatMap((columnName) => [
      ['sys_user', columnName] as const,
      ['client_user', columnName] as const,
    ]),
  ...['account_domain', 'account_id_snapshot', 'account_masked_snapshot', 'event_type', 'reason', 'actor_user_id_snapshot', 'actor_username_snapshot', 'actor_display_name_snapshot', 'reference_summary_json', 'event_summary_json', 'created_at']
    .map((columnName) => ['account_lifecycle_event', columnName] as const),
  ['client_mobile_session', 'client_user_id'],
  ['client_mobile_session', 'device_id'],
  ['client_mobile_session', 'device_name'],
  ['client_mobile_session', 'platform'],
  ['client_mobile_session', 'app_version'],
  ['client_mobile_session', 'access_token_hash'],
  ['client_mobile_session', 'access_expires_at'],
  ['client_mobile_session', 'refresh_token_hash'],
  ['client_mobile_session', 'refresh_expires_at'],
  ['client_mobile_session', 'previous_refresh_token_hash'],
  ['client_mobile_session', 'previous_refresh_grace_until'],
  ['client_mobile_session', 'refresh_generation'],
  ['client_mobile_session', 'absolute_expires_at'],
  ['client_mobile_session', 'last_ip'],
  ['client_mobile_session', 'last_access_at'],
  ['client_mobile_session', 'created_at'],
  ['client_mobile_session', 'revoked_at'],
  ['client_mobile_session', 'revoke_reason'],
  ['o2o_preorder', 'client_request_id'],
  ['o2o_preorder', 'client_request_hash'],
  ['o2o_preorder', 'cancellation_source'],
  ['o2o_preorder', 'cancellation_remark'],
  ['o2o_preorder', 'cancelled_at'],
  ['biz_outbound_order_item', 'sku_id'],
  ['biz_outbound_order_item', 'sku_code_snapshot'],
  ['biz_outbound_order_item', 'spec_text_snapshot'],
  ['business_sequence', 'sequence_key'],
  ['business_sequence', 'current_value'],
  ['business_sequence', 'created_at'],
  ['business_sequence', 'updated_at'],
  ['notification_event', 'attempt_count'],
  ['notification_event', 'next_attempt_at'],
  ['notification_event', 'processing_started_at'],
  ['notification_event', 'processing_owner'],
  ['notification_event', 'processed_at'],
  ['notification_dispatch', 'dedupe_key'],
  ['notification_dispatch', 'last_attempt_at'],
  ['client_user', 'department_node_id'],
  ['o2o_preorder', 'department_name_snapshot'],
  ['client_feedback_conversation', 'department_name_snapshot'],
  ['biz_outbound_order', 'customer_department_name'],
  ['sms_verification_record', 'out_id'],
  ['sms_verification_record', 'scheme_name'],
  ['sms_verification_record', 'target_digest'],
  ['sms_verification_record', 'delivery_status'],
  ['biz_outbound_order', 'business_no'],
  ['biz_outbound_order', 'edit_version'],
  ['biz_outbound_order', 'inventory_mode'],
  ['inventory_log', 'sku_id'],
  ['inventory_log', 'before_sku_current_stock'],
  ['inventory_log', 'after_sku_current_stock'],
  ['inventory_log', 'before_sku_preordered_stock'],
  ['inventory_log', 'after_sku_preordered_stock'],
  ['order_business_no_occupancy', 'business_namespace'],
  ['order_business_no_occupancy', 'serial_value'],
  ['order_business_no_occupancy', 'business_no'],
  ['order_business_no_occupancy', 'order_uuid'],
  ['order_business_no_occupancy', 'assigned_reason'],
  ['order_business_no_occupancy', 'created_at'],
  ['order_revision', 'order_id_snapshot'],
  ['order_revision', 'order_uuid'],
  ['order_revision', 'revision_no'],
  ['order_revision', 'before_snapshot_json'],
  ['order_revision', 'after_snapshot_json'],
  ['order_revision', 'reason'],
  ['order_revision', 'actor_user_id'],
  ['order_revision', 'actor_username'],
  ['order_revision', 'actor_display_name'],
  ['order_revision', 'ip_address'],
  ['order_revision', 'user_agent'],
  ['order_revision', 'created_at'],
] as const

const REQUIRED_COLUMN_LENGTHS = new Map<string, number>([
  ['o2o_preorder.department_name_snapshot', 271],
  ['client_feedback_conversation.department_name_snapshot', 271],
  ['biz_outbound_order.customer_department_name', 271],
  ['sms_verification_record.scheme_name', 20],
])

interface ColumnFixture {
  dataType: string
  columnType: string
  isNullable: 'YES' | 'NO'
  characterMaximumLength: number | null
}

const REQUIRED_MANUAL_OUTBOUND_COLUMN_DEFINITIONS = new Map<string, ColumnFixture>([
  ['biz_outbound_order_item.sku_id', {
    dataType: 'bigint',
    columnType: 'bigint unsigned',
    isNullable: 'YES',
    characterMaximumLength: null,
  }],
  ['biz_outbound_order_item.sku_code_snapshot', {
    dataType: 'varchar',
    columnType: 'varchar(96)',
    isNullable: 'YES',
    characterMaximumLength: 96,
  }],
  ['biz_outbound_order_item.spec_text_snapshot', {
    dataType: 'varchar',
    columnType: 'varchar(255)',
    isNullable: 'YES',
    characterMaximumLength: 255,
  }],
  ['biz_outbound_order.business_no', {
    dataType: 'varchar',
    columnType: 'varchar(32)',
    isNullable: 'NO',
    characterMaximumLength: 32,
  }],
  ['biz_outbound_order.edit_version', {
    dataType: 'int',
    columnType: 'int',
    isNullable: 'NO',
    characterMaximumLength: null,
  }],
  ['biz_outbound_order.inventory_mode', {
    dataType: 'varchar',
    columnType: 'varchar(24)',
    isNullable: 'NO',
    characterMaximumLength: 24,
  }],
  ['inventory_log.sku_id', {
    dataType: 'bigint',
    columnType: 'bigint unsigned',
    isNullable: 'YES',
    characterMaximumLength: null,
  }],
  ['inventory_log.before_sku_current_stock', {
    dataType: 'int',
    columnType: 'int',
    isNullable: 'YES',
    characterMaximumLength: null,
  }],
  ['inventory_log.after_sku_current_stock', {
    dataType: 'int',
    columnType: 'int',
    isNullable: 'YES',
    characterMaximumLength: null,
  }],
  ['inventory_log.before_sku_preordered_stock', {
    dataType: 'int',
    columnType: 'int',
    isNullable: 'YES',
    characterMaximumLength: null,
  }],
  ['inventory_log.after_sku_preordered_stock', {
    dataType: 'int',
    columnType: 'int',
    isNullable: 'YES',
    characterMaximumLength: null,
  }],
])

interface IndexFixture {
  tableName: string
  indexName: string
  columns: string[]
  unique: boolean
}

interface ForeignKeyFixture {
  tableName: string
  constraintName: string
  columnName: string
  referencedTableName: string
  referencedColumnName: string
  ordinalPosition: number
  deleteRule: string
}

interface TriggerFixture {
  triggerName: string
  eventManipulation: 'UPDATE' | 'DELETE'
  actionTiming: 'BEFORE'
}

const REQUIRED_INDEXES: readonly IndexFixture[] = [
  {
    tableName: 'account_lifecycle_event',
    indexName: 'idx_account_lifecycle_event_account',
    columns: ['account_domain', 'account_id_snapshot', 'id'],
    unique: false,
  },
  {
    tableName: 'account_lifecycle_event',
    indexName: 'idx_account_lifecycle_event_created_at',
    columns: ['created_at', 'id'],
    unique: false,
  },
  {
    tableName: 'inventory_log',
    indexName: 'idx_inventory_log_sku_id',
    columns: ['sku_id'],
    unique: false,
  },
  {
    tableName: 'biz_outbound_order_item',
    indexName: 'idx_biz_outbound_item_sku_id',
    columns: ['sku_id'],
    unique: false,
  },
  {
    tableName: 'client_mobile_session',
    indexName: 'uk_client_mobile_session_access_hash',
    columns: ['access_token_hash'],
    unique: true,
  },
  {
    tableName: 'client_mobile_session',
    indexName: 'uk_client_mobile_session_refresh_hash',
    columns: ['refresh_token_hash'],
    unique: true,
  },
  {
    tableName: 'client_mobile_session',
    indexName: 'idx_client_mobile_session_previous_refresh_hash',
    columns: ['previous_refresh_token_hash'],
    unique: false,
  },
  {
    tableName: 'client_mobile_session',
    indexName: 'idx_client_mobile_session_user_active',
    columns: ['client_user_id', 'revoked_at', 'last_access_at'],
    unique: false,
  },
  {
    tableName: 'client_mobile_session',
    indexName: 'idx_client_mobile_session_user_device',
    columns: ['client_user_id', 'device_id'],
    unique: false,
  },
  {
    tableName: 'client_mobile_session',
    indexName: 'idx_client_mobile_session_cleanup',
    columns: ['revoked_at', 'absolute_expires_at', 'id'],
    unique: false,
  },
  {
    tableName: 'client_mobile_session',
    indexName: 'idx_client_mobile_session_refresh_expiry',
    columns: ['revoked_at', 'refresh_expires_at', 'id'],
    unique: false,
  },
  {
    tableName: 'o2o_preorder',
    indexName: 'uk_o2o_preorder_client_request',
    columns: ['client_user_id', 'client_request_id'],
    unique: true,
  },
  {
    tableName: 'notification_event',
    indexName: 'idx_notification_event_pending_claim',
    columns: ['status', 'next_attempt_at', 'id'],
    unique: false,
  },
  {
    tableName: 'notification_event',
    indexName: 'idx_notification_event_processing_recovery',
    columns: ['status', 'processing_started_at', 'id'],
    unique: false,
  },
  {
    tableName: 'notification_inbox',
    indexName: 'uk_notification_inbox_event_user',
    columns: ['event_id', 'user_id'],
    unique: true,
  },
  {
    tableName: 'notification_dispatch',
    indexName: 'uk_notification_dispatch_event_channel_target',
    columns: ['event_id', 'channel', 'dedupe_key'],
    unique: true,
  },
  {
    tableName: 'client_user',
    indexName: 'uk_client_user_department_node_id',
    columns: ['department_node_id'],
    unique: true,
  },
  {
    tableName: 'sms_verification_record',
    indexName: 'uk_sms_verification_record_out_id',
    columns: ['out_id'],
    unique: true,
  },
  {
    tableName: 'sms_verification_record',
    indexName: 'idx_sms_verification_record_lookup',
    columns: ['channel', 'scene', 'target_digest', 'expires_at'],
    unique: false,
  },
  {
    tableName: 'biz_outbound_order',
    indexName: 'uk_biz_outbound_business_no',
    columns: ['business_no'],
    unique: true,
  },
  {
    tableName: 'order_business_no_occupancy',
    indexName: 'uk_order_business_no_occupancy_business_no',
    columns: ['business_no'],
    unique: true,
  },
  {
    tableName: 'order_business_no_occupancy',
    indexName: 'uk_order_business_no_occupancy_namespace_serial',
    columns: ['business_namespace', 'serial_value'],
    unique: true,
  },
  {
    tableName: 'order_business_no_occupancy',
    indexName: 'idx_order_business_no_occupancy_order_uuid',
    columns: ['order_uuid'],
    unique: false,
  },
  {
    tableName: 'order_revision',
    indexName: 'uk_order_revision_uuid_version',
    columns: ['order_uuid', 'revision_no'],
    unique: true,
  },
  {
    tableName: 'order_revision',
    indexName: 'idx_order_revision_order_id_snapshot',
    columns: ['order_id_snapshot'],
    unique: false,
  },
]

const REQUIRED_FOREIGN_KEYS: readonly ForeignKeyFixture[] = [
  ...[
    ['sys_user_session', 'fk_sys_user_session_user_id', 'user_id', 'sys_user'],
    ['client_user_session', 'fk_client_user_session_user_id', 'user_id', 'client_user'],
    ['client_mobile_session', 'fk_client_mobile_session_user', 'client_user_id', 'client_user'],
    ['biz_inbound_order', 'fk_biz_inbound_supplier_user', 'supplier_id', 'sys_user'],
    ['o2o_preorder', 'fk_o2o_preorder_client_user', 'client_user_id', 'client_user'],
    ['o2o_return_request', 'fk_o2o_return_client_user', 'client_user_id', 'client_user'],
    ['client_feedback_conversation', 'fk_feedback_conversation_client_user', 'client_user_id', 'client_user'],
    ['client_feedback_conversation', 'fk_feedback_conversation_assigned_user', 'assigned_user_id', 'sys_user'],
    ['client_feedback_conversation', 'fk_feedback_conversation_remark_user', 'internal_remark_by_user_id', 'sys_user'],
    ['client_feedback_attachment', 'fk_feedback_attachment_owner', 'owner_client_user_id', 'client_user'],
    ['notification_inbox', 'fk_notification_inbox_user_id', 'user_id', 'sys_user'],
  ].map(([tableName, constraintName, columnName, referencedTableName]) => ({
    tableName,
    constraintName,
    columnName,
    referencedTableName,
    referencedColumnName: 'id',
    ordinalPosition: 1,
    deleteRule: 'RESTRICT',
  })),
  {
    tableName: 'biz_outbound_order_item',
    constraintName: 'fk_biz_outbound_item_sku_id',
    columnName: 'sku_id',
    referencedTableName: 'base_product_sku',
    referencedColumnName: 'id',
    ordinalPosition: 1,
    deleteRule: 'SET NULL',
  },
  {
    tableName: 'inventory_log',
    constraintName: 'fk_inventory_log_sku_id',
    columnName: 'sku_id',
    referencedTableName: 'base_product_sku',
    referencedColumnName: 'id',
    ordinalPosition: 1,
    deleteRule: 'SET NULL',
  },
]

const REQUIRED_TRIGGERS: readonly TriggerFixture[] = [
  { triggerName: 'trg_account_lifecycle_event_no_update', eventManipulation: 'UPDATE', actionTiming: 'BEFORE' },
  { triggerName: 'trg_account_lifecycle_event_no_delete', eventManipulation: 'DELETE', actionTiming: 'BEFORE' },
]

interface SchemaFixture {
  tables: Set<string>
  columns: Set<string>
  columnDefinitions: Map<string, ColumnFixture>
  indexes: Map<string, IndexFixture>
  foreignKeys: Map<string, ForeignKeyFixture>
  triggers: Map<string, TriggerFixture>
}

const objectKey = (tableName: string, objectName: string) => `${tableName}.${objectName}`

function createCompleteFixture(): SchemaFixture {
  return {
    tables: new Set(REQUIRED_TABLES),
    columns: new Set(REQUIRED_COLUMNS.map(([tableName, columnName]) => objectKey(tableName, columnName))),
    columnDefinitions: new Map(REQUIRED_COLUMNS.map(([tableName, columnName]) => {
      const key = objectKey(tableName, columnName)
      const definition = REQUIRED_MANUAL_OUTBOUND_COLUMN_DEFINITIONS.get(key) ?? {
        dataType: 'varchar',
        columnType: `varchar(${REQUIRED_COLUMN_LENGTHS.get(key) ?? 255})`,
        isNullable: 'YES',
        characterMaximumLength: REQUIRED_COLUMN_LENGTHS.get(key) ?? null,
      }
      return [key, { ...definition }]
    })),
    indexes: new Map(REQUIRED_INDEXES.map((index) => [objectKey(index.tableName, index.indexName), {
      ...index,
      columns: [...index.columns],
    }])),
    foreignKeys: new Map(REQUIRED_FOREIGN_KEYS.map((foreignKey) => [
      objectKey(foreignKey.tableName, foreignKey.constraintName),
      { ...foreignKey },
    ])),
    triggers: new Map(REQUIRED_TRIGGERS.map((trigger) => [trigger.triggerName, { ...trigger }])),
  }
}

function createDataSource(fixture: SchemaFixture): DataSource {
  return {
    query: async (sql: string) => {
      if (sql.includes('information_schema.TABLES')) {
        return [...fixture.tables].map((tableName) => ({ TABLE_NAME: tableName }))
      }
      if (sql.includes('information_schema.COLUMNS')) {
        return [...fixture.columns]
          .map((key) => {
            const separatorIndex = key.indexOf('.')
            const definition = fixture.columnDefinitions.get(key)
            return {
              TABLE_NAME: key.slice(0, separatorIndex),
              COLUMN_NAME: key.slice(separatorIndex + 1),
              DATA_TYPE: definition?.dataType ?? 'varchar',
              COLUMN_TYPE: definition?.columnType ?? 'varchar(255)',
              IS_NULLABLE: definition?.isNullable ?? 'YES',
              CHARACTER_MAXIMUM_LENGTH: definition?.characterMaximumLength ?? null,
            }
          })
          .filter((row) => fixture.tables.has(row.TABLE_NAME))
      }
      if (sql.includes('information_schema.KEY_COLUMN_USAGE')) {
        return [...fixture.foreignKeys.values()]
          .filter((foreignKey) => fixture.tables.has(foreignKey.tableName))
          .map((foreignKey) => ({
            TABLE_NAME: foreignKey.tableName,
            CONSTRAINT_NAME: foreignKey.constraintName,
            COLUMN_NAME: foreignKey.columnName,
            REFERENCED_TABLE_NAME: foreignKey.referencedTableName,
            REFERENCED_COLUMN_NAME: foreignKey.referencedColumnName,
            ORDINAL_POSITION: foreignKey.ordinalPosition,
            DELETE_RULE: foreignKey.deleteRule,
          }))
      }
      if (sql.includes('information_schema.STATISTICS')) {
        return [...fixture.indexes.values()]
          .filter((index) => fixture.tables.has(index.tableName))
          .flatMap((index) => index.columns.map((columnName, position) => ({
            TABLE_NAME: index.tableName,
            INDEX_NAME: index.indexName,
            COLUMN_NAME: columnName,
            SEQ_IN_INDEX: position + 1,
            NON_UNIQUE: index.unique ? 0 : 1,
          })))
      }
      if (sql.includes('information_schema.TRIGGERS')) {
        return [...fixture.triggers.values()].map((trigger) => ({
          TRIGGER_NAME: trigger.triggerName,
          EVENT_MANIPULATION: trigger.eventManipulation,
          ACTION_TIMING: trigger.actionTiming,
        }))
      }
      throw new Error(`测试替身收到未识别的 SQL：${sql}`)
    },
  } as unknown as DataSource
}

async function expectSchemaFailure(
  fixture: SchemaFixture,
  expectedFragments: readonly string[],
): Promise<void> {
  await assert.rejects(
    () => assertMysqlRequiredSchemaExists(createDataSource(fixture)),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      for (const fragment of expectedFragments) {
        assert.ok(error.message.includes(fragment), `启动阻断信息缺少：${fragment}\n${error.message}`)
      }
      return true
    },
  )
}

await assert.doesNotReject(() => assertMysqlRequiredSchemaExists(createDataSource(createCompleteFixture())))

const missingSequence = createCompleteFixture()
missingSequence.tables.delete('business_sequence')
await expectSchemaFailure(missingSequence, [
  '表 business_sequence',
  '035_o2o_idempotency_business_sequence.sql',
])

const missingMobileSession = createCompleteFixture()
missingMobileSession.tables.delete('client_mobile_session')
await expectSchemaFailure(missingMobileSession, [
  '表 client_mobile_session',
  '037_mobile_auth_session.sql',
])

const missingClientUser = createCompleteFixture()
missingClientUser.tables.delete('client_user')
await expectSchemaFailure(missingClientUser, [
  '表 client_user',
  '006_o2o_preorder_schema.sql',
])

const missingSmsVerificationRecord = createCompleteFixture()
missingSmsVerificationRecord.tables.delete('sms_verification_record')
await expectSchemaFailure(missingSmsVerificationRecord, [
  '表 sms_verification_record',
  '039_aliyun_pnvs_sms_verification.sql',
])

const missingOrderBusinessNoOccupancy = createCompleteFixture()
missingOrderBusinessNoOccupancy.tables.delete('order_business_no_occupancy')
await expectSchemaFailure(missingOrderBusinessNoOccupancy, [
  '表 order_business_no_occupancy',
  '042_order_business_no_amendment.sql',
])

const missingOrderBusinessNo = createCompleteFixture()
missingOrderBusinessNo.columns.delete(objectKey('biz_outbound_order', 'business_no'))
await expectSchemaFailure(missingOrderBusinessNo, [
  '字段 biz_outbound_order.business_no',
  '042_order_business_no_amendment.sql',
])

const missingInventoryMode = createCompleteFixture()
missingInventoryMode.columns.delete(objectKey('biz_outbound_order', 'inventory_mode'))
await expectSchemaFailure(missingInventoryMode, [
  '字段 biz_outbound_order.inventory_mode',
  '043_order_content_inventory_mode.sql',
])

const missingInventoryLogSku = createCompleteFixture()
missingInventoryLogSku.columns.delete(objectKey('inventory_log', 'sku_id'))
await expectSchemaFailure(missingInventoryLogSku, [
  '字段 inventory_log.sku_id',
  '043_order_content_inventory_mode.sql',
])

const missingIdempotencyColumn = createCompleteFixture()
missingIdempotencyColumn.columns.delete(objectKey('o2o_preorder', 'client_request_hash'))
await expectSchemaFailure(missingIdempotencyColumn, [
  '字段 o2o_preorder.client_request_hash',
  '035_o2o_idempotency_business_sequence.sql',
])

const missingCancellationSource = createCompleteFixture()
missingCancellationSource.columns.delete(objectKey('o2o_preorder', 'cancellation_source'))
await expectSchemaFailure(missingCancellationSource, [
  '字段 o2o_preorder.cancellation_source',
  '040_o2o_preorder_governance.sql',
])

const missingManualOutboundSkuColumn = createCompleteFixture()
missingManualOutboundSkuColumn.columns.delete(objectKey('biz_outbound_order_item', 'spec_text_snapshot'))
await expectSchemaFailure(missingManualOutboundSkuColumn, [
  '字段 biz_outbound_order_item.spec_text_snapshot',
  '041_manual_outbound_sku.sql',
])

const missingManualOutboundSkuIndex = createCompleteFixture()
missingManualOutboundSkuIndex.indexes.delete(objectKey('biz_outbound_order_item', 'idx_biz_outbound_item_sku_id'))
await expectSchemaFailure(missingManualOutboundSkuIndex, [
  '索引 biz_outbound_order_item.idx_biz_outbound_item_sku_id',
  '041_manual_outbound_sku.sql',
])

const nonNullableManualOutboundSkuId = createCompleteFixture()
nonNullableManualOutboundSkuId.columnDefinitions.get(objectKey('biz_outbound_order_item', 'sku_id'))!.isNullable = 'NO'
await expectSchemaFailure(nonNullableManualOutboundSkuId, [
  '字段 biz_outbound_order_item.sku_id 必须允许 NULL',
  '041_manual_outbound_sku.sql',
])

const signedManualOutboundSkuId = createCompleteFixture()
signedManualOutboundSkuId.columnDefinitions.get(objectKey('biz_outbound_order_item', 'sku_id'))!.columnType = 'bigint'
await expectSchemaFailure(signedManualOutboundSkuId, [
  '字段 biz_outbound_order_item.sku_id 类型应为 bigint unsigned',
  '041_manual_outbound_sku.sql',
])

const shortManualOutboundSkuCode = createCompleteFixture()
shortManualOutboundSkuCode.columnDefinitions.get(objectKey('biz_outbound_order_item', 'sku_code_snapshot'))!.characterMaximumLength = 95
shortManualOutboundSkuCode.columnDefinitions.get(objectKey('biz_outbound_order_item', 'sku_code_snapshot'))!.columnType = 'varchar(95)'
await expectSchemaFailure(shortManualOutboundSkuCode, [
  '字段 biz_outbound_order_item.sku_code_snapshot 长度应为 96',
  '041_manual_outbound_sku.sql',
])

const wrongManualOutboundSkuForeignTarget = createCompleteFixture()
wrongManualOutboundSkuForeignTarget.foreignKeys.get(objectKey('biz_outbound_order_item', 'fk_biz_outbound_item_sku_id'))!.referencedTableName = 'base_product'
await expectSchemaFailure(wrongManualOutboundSkuForeignTarget, [
  '外键 biz_outbound_order_item.sku_id',
  '目标应为 base_product_sku.id',
  '041_manual_outbound_sku.sql',
])

const wrongManualOutboundSkuDeleteRule = createCompleteFixture()
wrongManualOutboundSkuDeleteRule.foreignKeys.get(objectKey('biz_outbound_order_item', 'fk_biz_outbound_item_sku_id'))!.deleteRule = 'RESTRICT'
await expectSchemaFailure(wrongManualOutboundSkuDeleteRule, [
  '外键 biz_outbound_order_item.sku_id 必须使用 ON DELETE SET NULL',
  '041_manual_outbound_sku.sql',
])

const typeormNamedManualOutboundSkuForeignKey = createCompleteFixture()
const equivalentSkuForeignKey = typeormNamedManualOutboundSkuForeignKey.foreignKeys.get(
  objectKey('biz_outbound_order_item', 'fk_biz_outbound_item_sku_id'),
)!
typeormNamedManualOutboundSkuForeignKey.foreignKeys.delete(
  objectKey('biz_outbound_order_item', equivalentSkuForeignKey.constraintName),
)
equivalentSkuForeignKey.constraintName = 'FK_typeorm_generated'
typeormNamedManualOutboundSkuForeignKey.foreignKeys.set(
  objectKey('biz_outbound_order_item', equivalentSkuForeignKey.constraintName),
  equivalentSkuForeignKey,
)
await assert.doesNotReject(
  () => assertMysqlRequiredSchemaExists(createDataSource(typeormNamedManualOutboundSkuForeignKey)),
  '等价外键的名称不属于结构语义，schema contract 必须接受 TypeORM 生成的异名约束',
)

const manualOutboundSkuMigrationSource = fs.readFileSync(
  path.resolve(backendRoot, 'sql/041_manual_outbound_sku.sql'),
  'utf8',
)
assert.match(
  manualOutboundSkuMigrationSource,
  /information_schema\.KEY_COLUMN_USAGE/i,
  '041 必须按外键源列与引用目标识别等价约束，不能只查询固定约束名',
)
assert.match(manualOutboundSkuMigrationSource, /COLUMN_NAME\s*=\s*'sku_id'/i)
assert.match(manualOutboundSkuMigrationSource, /REFERENCED_TABLE_NAME\s*=\s*'base_product_sku'/i)
assert.match(manualOutboundSkuMigrationSource, /REFERENCED_COLUMN_NAME\s*=\s*'id'/i)
assert.match(manualOutboundSkuMigrationSource, /DELETE_RULE\s*=\s*'SET NULL'/i)
assert.doesNotMatch(
  manualOutboundSkuMigrationSource,
  /AND\s+(?:kcu\.)?CONSTRAINT_NAME\s*=\s*'fk_biz_outbound_item_sku_id'/i,
  '041 不得因等价外键名称不同而重复创建约束',
)

const missingOutboxColumn = createCompleteFixture()
missingOutboxColumn.columns.delete(objectKey('notification_event', 'next_attempt_at'))
await expectSchemaFailure(missingOutboxColumn, [
  '字段 notification_event.next_attempt_at',
  '036_notification_outbox.sql',
  '停止所有应用与通知 Worker',
])

const missingSmsSchemeColumn = createCompleteFixture()
missingSmsSchemeColumn.columns.delete(objectKey('sms_verification_record', 'scheme_name'))
await expectSchemaFailure(missingSmsSchemeColumn, [
  '字段 sms_verification_record.scheme_name',
  '039_aliyun_pnvs_sms_verification.sql',
])

for (const [columnKey] of REQUIRED_COLUMN_LENGTHS) {
  const shortRequiredColumn = createCompleteFixture()
  shortRequiredColumn.columnDefinitions.get(columnKey)!.characterMaximumLength = 1
  const introducingScript = columnKey === 'sms_verification_record.scheme_name'
    ? '039_aliyun_pnvs_sms_verification.sql'
    : '038_department_path_capacity.sql'
  await expectSchemaFailure(shortRequiredColumn, [
    `字段 ${columnKey}`,
    '字符容量不足',
    introducingScript,
  ])
}

const malformedOutboxIndex = createCompleteFixture()
malformedOutboxIndex.indexes.set(
  objectKey('notification_dispatch', 'uk_notification_dispatch_event_channel_target'),
  {
    tableName: 'notification_dispatch',
    indexName: 'uk_notification_dispatch_event_channel_target',
    columns: ['event_id', 'dedupe_key', 'channel'],
    unique: true,
  },
)
await expectSchemaFailure(malformedOutboxIndex, [
  '索引 notification_dispatch.uk_notification_dispatch_event_channel_target',
  '036_notification_outbox.sql',
])

const malformedSmsOutIdIndex = createCompleteFixture()
malformedSmsOutIdIndex.indexes.set(
  objectKey('sms_verification_record', 'uk_sms_verification_record_out_id'),
  {
    tableName: 'sms_verification_record',
    indexName: 'uk_sms_verification_record_out_id',
    columns: ['biz_id'],
    unique: true,
  },
)
await expectSchemaFailure(malformedSmsOutIdIndex, [
  '索引 sms_verification_record.uk_sms_verification_record_out_id',
  '039_aliyun_pnvs_sms_verification.sql',
])

const missingLifecycleEventTable = createCompleteFixture()
missingLifecycleEventTable.tables.delete('account_lifecycle_event')
await expectSchemaFailure(missingLifecycleEventTable, [
  '表 account_lifecycle_event',
  '044_account_lifecycle_governance.sql',
])

const missingSysDeactivationColumn = createCompleteFixture()
missingSysDeactivationColumn.columns.delete(objectKey('sys_user', 'deactivated_at'))
await expectSchemaFailure(missingSysDeactivationColumn, [
  '字段 sys_user.deactivated_at',
  '044_account_lifecycle_governance.sql',
])

const wrongClientSessionDeleteRule = createCompleteFixture()
wrongClientSessionDeleteRule.foreignKeys.get(objectKey('client_user_session', 'fk_client_user_session_user_id'))!.deleteRule = 'CASCADE'
await expectSchemaFailure(wrongClientSessionDeleteRule, [
  '外键 client_user_session.user_id 必须使用 ON DELETE RESTRICT',
  '044_account_lifecycle_governance.sql',
])

const missingLifecycleUpdateTrigger = createCompleteFixture()
missingLifecycleUpdateTrigger.triggers.delete('trg_account_lifecycle_event_no_update')
await expectSchemaFailure(missingLifecycleUpdateTrigger, [
  '触发器 trg_account_lifecycle_event_no_update',
  '044_account_lifecycle_governance.sql',
])

console.log('[mysql-schema-contract-verify] MySQL 启动结构契约验证通过')
