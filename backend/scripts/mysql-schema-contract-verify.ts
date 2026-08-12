/**
 * 文件说明：MySQL 启动结构契约回归验证。
 * 实现逻辑：使用只读 DataSource 替身模拟完整库、漏执行 035、漏执行 036 及同名错误索引，
 * 确认服务会在对外启动前阻断，并给出精确的增量脚本指引。
 */

import assert from 'node:assert/strict'
import type { DataSource } from 'typeorm'

process.env.Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE = 'true'
process.env.DB_TYPE = 'mysql'
process.env.DB_AUTO_MIGRATE = 'false'

const { assertMysqlRequiredSchemaExists } = await import('../src/config/mysql-migration-runner.js')

const REQUIRED_TABLES = [
  'base_product',
  'base_product_sku',
  'sys_user',
  'sys_user_session',
  'o2o_preorder',
  'o2o_preorder_item',
  'biz_inbound_order',
  'biz_inbound_order_item',
  'notification_event',
  'notification_inbox',
  'notification_dispatch',
  'auth_risk_state',
  'business_sequence',
] as const

const REQUIRED_COLUMNS = [
  ['o2o_preorder', 'client_request_id'],
  ['o2o_preorder', 'client_request_hash'],
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
] as const

interface IndexFixture {
  tableName: string
  indexName: string
  columns: string[]
  unique: boolean
}

const REQUIRED_INDEXES: readonly IndexFixture[] = [
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
]

interface SchemaFixture {
  tables: Set<string>
  columns: Set<string>
  indexes: Map<string, IndexFixture>
}

const objectKey = (tableName: string, objectName: string) => `${tableName}.${objectName}`

function createCompleteFixture(): SchemaFixture {
  return {
    tables: new Set(REQUIRED_TABLES),
    columns: new Set(REQUIRED_COLUMNS.map(([tableName, columnName]) => objectKey(tableName, columnName))),
    indexes: new Map(REQUIRED_INDEXES.map((index) => [objectKey(index.tableName, index.indexName), {
      ...index,
      columns: [...index.columns],
    }])),
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
            return {
              TABLE_NAME: key.slice(0, separatorIndex),
              COLUMN_NAME: key.slice(separatorIndex + 1),
            }
          })
          .filter((row) => fixture.tables.has(row.TABLE_NAME))
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

const missingIdempotencyColumn = createCompleteFixture()
missingIdempotencyColumn.columns.delete(objectKey('o2o_preorder', 'client_request_hash'))
await expectSchemaFailure(missingIdempotencyColumn, [
  '字段 o2o_preorder.client_request_hash',
  '035_o2o_idempotency_business_sequence.sql',
])

const missingOutboxColumn = createCompleteFixture()
missingOutboxColumn.columns.delete(objectKey('notification_event', 'next_attempt_at'))
await expectSchemaFailure(missingOutboxColumn, [
  '字段 notification_event.next_attempt_at',
  '036_notification_outbox.sql',
  '停止所有应用与通知 Worker',
])

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

console.log('[mysql-schema-contract-verify] MySQL 启动结构契约验证通过')
