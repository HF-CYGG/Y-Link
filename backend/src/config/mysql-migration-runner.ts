/**
 * 模块说明：backend/src/config/mysql-migration-runner.ts
 * 文件职责：为 MySQL 部署提供启动期自检，以及对少数已核实幂等的增量迁移脚本的可选自动执行能力。
 * 实现逻辑：
 * - SQLite 一体化部署由 database-bootstrap.ts 里的 normalizeSqlite* 系列函数在启动期自动补齐结构；
 *   而 MySQL 一直被视为“外部管理”的数据库，此前启动阶段完全不校验 backend/sql/ 是否已执行，
 *   导致缺表故障只能在业务接口报错时才被发现（例如认证接口依赖的 auth_risk_state 表）。
 * - assertMysqlRequiredSchemaExists：只读校验一组关键表、列与索引定义，缺失或形状不符时直接抛错阻止服务启动，
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
 * - 新增强依赖的关键结构时，请同步补充 MYSQL_REQUIRED_TABLES / MYSQL_REQUIRED_COLUMNS /
 *   MYSQL_REQUIRED_INDEXES / MYSQL_REQUIRED_FOREIGN_KEYS 及其迁移脚本映射，
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
  'order_business_no_reuse_event',
  'order_revision',
  'account_lifecycle_event',
  'order_merge_operation',
  'order_merge_relation',
  'base_category',
  'base_storage_location',
  'inv_stock_doc',
  'inv_stock_doc_item',
  'inv_stocktake',
  'inv_stocktake_item',
  'base_product_variant_code_registry',
  'base_yz_series_seq_reservation',
]

// 每个必需表由哪个迁移脚本创建，用于在报错时给出精确指引，而不是笼统建议“从头跑一遍”。
// auth_risk_state 现同时存在于 001（供全新库一次建齐）与 033（供存量库补建），
// 这里指向 033，因为它是白名单中专门为存量库补建该表的自动迁移脚本。
const TABLE_INTRODUCING_SCRIPT: Record<string, string> = {
  base_product: '001_init_schema.sql',
  sys_user: '001_init_schema.sql',
  sys_user_session: '001_init_schema.sql',
  biz_inbound_order: '001_init_schema.sql',
  biz_inbound_order_item: '001_init_schema.sql',
  o2o_preorder: '006_o2o_preorder_schema.sql',
  o2o_preorder_item: '006_o2o_preorder_schema.sql',
  client_user: '006_o2o_preorder_schema.sql',
  client_user_session: '006_o2o_preorder_schema.sql',
  o2o_return_request: '006_o2o_preorder_schema.sql',
  client_feedback_attachment: '032_security_findings_remediation.sql',
  client_feedback_conversation: '019_client_feedback_and_customer_service.sql',
  biz_outbound_order: '001_init_schema.sql',
  biz_outbound_order_item: '001_init_schema.sql',
  inventory_log: '001_init_schema.sql',
  base_product_sku: '028_o2o_product_sku_selection.sql',
  notification_event: '020_notification_center_and_user_email.sql',
  notification_inbox: '020_notification_center_and_user_email.sql',
  notification_dispatch: '020_notification_center_and_user_email.sql',
  auth_risk_state: '033_inventory_security_invariants.sql',
  business_sequence: '035_o2o_idempotency_business_sequence.sql',
  client_mobile_session: '037_mobile_auth_session.sql',
  sms_verification_record: '039_aliyun_pnvs_sms_verification.sql',
  order_business_no_occupancy: '042_order_business_no_amendment.sql',
  order_business_no_reuse_event: '054_order_business_no_reuse.sql',
  order_revision: '042_order_business_no_amendment.sql',
  account_lifecycle_event: '044_account_lifecycle_governance.sql',
  order_merge_operation: '045_order_merge_governance.sql',
  order_merge_relation: '045_order_merge_governance.sql',
  base_category: '049_inventory_sku_barcode_stocktake.sql',
  base_storage_location: '049_inventory_sku_barcode_stocktake.sql',
  inv_stock_doc: '049_inventory_sku_barcode_stocktake.sql',
  inv_stock_doc_item: '049_inventory_sku_barcode_stocktake.sql',
  inv_stocktake: '049_inventory_sku_barcode_stocktake.sql',
  inv_stocktake_item: '049_inventory_sku_barcode_stocktake.sql',
  base_product_variant_code_registry: '050_product_yz_sku_code.sql',
  base_yz_series_seq_reservation: '052_yz_series_seq_reservation.sql',
}

interface MysqlRequiredColumn {
  tableName: string
  columnName: string
  introducingScript: string
  minCharacterMaximumLength?: number
  expectedCharacterMaximumLength?: number
  expectedDataType?: string
  expectedColumnType?: string
  expectedNullable?: boolean
}

interface MysqlRequiredIndex {
  tableName: string
  indexName: string
  columns: readonly string[]
  unique: boolean
  introducingScript: string
}

interface MysqlRequiredForeignKey {
  tableName: string
  columnName: string
  referencedTableName: string
  referencedColumnName: string
  deleteRule: string
  introducingScript: string
}

interface MysqlRequiredTrigger {
  triggerName: string
  eventManipulation: 'UPDATE' | 'DELETE'
  actionTiming: 'BEFORE'
  introducingScript: string
}

interface MysqlRequiredCheck {
  tableName: string
  constraintName: string
  introducingScript: string
}

// 只列会被当前业务代码直接读写、缺失后必然导致运行时失败的增量字段。
// 表不存在时由 MYSQL_REQUIRED_TABLES 先给出建表脚本，避免同一张缺表重复打印多条缺列提示。
const MYSQL_REQUIRED_COLUMNS: readonly MysqlRequiredColumn[] = [
  ...['deactivated_at', 'deactivation_reason', 'deactivated_by_user_id', 'deactivated_by_username', 'deactivated_by_display_name', 'restored_at', 'restored_by_user_id', 'restored_by_username', 'restored_by_display_name']
    .flatMap((columnName) => [
      { tableName: 'sys_user', columnName, introducingScript: '044_account_lifecycle_governance.sql' },
      { tableName: 'client_user', columnName, introducingScript: '044_account_lifecycle_governance.sql' },
    ]),
  ...['account_domain', 'account_id_snapshot', 'account_masked_snapshot', 'event_type', 'reason', 'actor_user_id_snapshot', 'actor_username_snapshot', 'actor_display_name_snapshot', 'reference_summary_json', 'event_summary_json', 'created_at']
    .map((columnName) => ({ tableName: 'account_lifecycle_event', columnName, introducingScript: '044_account_lifecycle_governance.sql' })),
  { tableName: 'client_mobile_session', columnName: 'client_user_id', introducingScript: '037_mobile_auth_session.sql' },
  { tableName: 'client_mobile_session', columnName: 'device_id', introducingScript: '037_mobile_auth_session.sql' },
  { tableName: 'client_mobile_session', columnName: 'device_name', introducingScript: '037_mobile_auth_session.sql' },
  { tableName: 'client_mobile_session', columnName: 'platform', introducingScript: '037_mobile_auth_session.sql' },
  { tableName: 'client_mobile_session', columnName: 'app_version', introducingScript: '037_mobile_auth_session.sql' },
  { tableName: 'client_mobile_session', columnName: 'access_token_hash', introducingScript: '037_mobile_auth_session.sql' },
  { tableName: 'client_mobile_session', columnName: 'access_expires_at', introducingScript: '037_mobile_auth_session.sql' },
  { tableName: 'client_mobile_session', columnName: 'refresh_token_hash', introducingScript: '037_mobile_auth_session.sql' },
  { tableName: 'client_mobile_session', columnName: 'refresh_expires_at', introducingScript: '037_mobile_auth_session.sql' },
  { tableName: 'client_mobile_session', columnName: 'previous_refresh_token_hash', introducingScript: '037_mobile_auth_session.sql' },
  { tableName: 'client_mobile_session', columnName: 'previous_refresh_grace_until', introducingScript: '037_mobile_auth_session.sql' },
  { tableName: 'client_mobile_session', columnName: 'refresh_generation', introducingScript: '037_mobile_auth_session.sql' },
  { tableName: 'client_mobile_session', columnName: 'absolute_expires_at', introducingScript: '037_mobile_auth_session.sql' },
  { tableName: 'client_mobile_session', columnName: 'last_ip', introducingScript: '037_mobile_auth_session.sql' },
  { tableName: 'client_mobile_session', columnName: 'last_access_at', introducingScript: '037_mobile_auth_session.sql' },
  { tableName: 'client_mobile_session', columnName: 'created_at', introducingScript: '037_mobile_auth_session.sql' },
  { tableName: 'client_mobile_session', columnName: 'revoked_at', introducingScript: '037_mobile_auth_session.sql' },
  { tableName: 'client_mobile_session', columnName: 'revoke_reason', introducingScript: '037_mobile_auth_session.sql' },
  { tableName: 'o2o_preorder', columnName: 'client_request_id', introducingScript: '035_o2o_idempotency_business_sequence.sql' },
  { tableName: 'o2o_preorder', columnName: 'client_request_hash', introducingScript: '035_o2o_idempotency_business_sequence.sql' },
  { tableName: 'o2o_preorder', columnName: 'cancellation_source', introducingScript: '040_o2o_preorder_governance.sql' },
  { tableName: 'o2o_preorder', columnName: 'cancellation_remark', introducingScript: '040_o2o_preorder_governance.sql' },
  { tableName: 'o2o_preorder', columnName: 'cancelled_at', introducingScript: '040_o2o_preorder_governance.sql' },
  { tableName: 'o2o_preorder', columnName: 'pickup_at', introducingScript: '047_o2o_preorder_pickup_at.sql', expectedNullable: true },
  { tableName: 'biz_inbound_order', columnName: 'expected_arrival_at', introducingScript: '048_inbound_order_expected_arrival.sql', expectedNullable: true },
  { tableName: 'base_product', columnName: 'category_id', introducingScript: '049_inventory_sku_barcode_stocktake.sql', expectedNullable: true },
  ...['barcode', 'cost_price', 'location_id']
    .map((columnName) => ({ tableName: 'base_product_sku', columnName, introducingScript: '049_inventory_sku_barcode_stocktake.sql', expectedNullable: true })),
  // 050：YZ 通用 SKU 编码体系新增字段，均由 050_product_yz_sku_code.sql 引入。
  { tableName: 'base_tag', columnName: 'series_code', introducingScript: '050_product_yz_sku_code.sql', expectedNullable: true },
  { tableName: 'base_product', columnName: 'primary_series_tag_id', introducingScript: '050_product_yz_sku_code.sql', expectedNullable: true },
  { tableName: 'base_product', columnName: 'series_seq', introducingScript: '050_product_yz_sku_code.sql', expectedNullable: true },
  {
    tableName: 'base_product',
    columnName: 'code_scheme',
    introducingScript: '050_product_yz_sku_code.sql',
    expectedDataType: 'varchar',
    expectedColumnType: 'varchar(8)',
    expectedCharacterMaximumLength: 8,
    expectedNullable: false,
  },
  ...['variant_code', 'size_code']
    .map((columnName) => ({ tableName: 'base_product_sku', columnName, introducingScript: '050_product_yz_sku_code.sql', expectedNullable: true })),
  // 051：历史编码字段（B9 批次），legacy 产品编码/SKU 编码追溯展示与扫码兼容匹配。
  { tableName: 'base_product', columnName: 'legacy_product_code', introducingScript: '051_product_legacy_code.sql', expectedNullable: true },
  { tableName: 'base_product_sku', columnName: 'legacy_sku_code', introducingScript: '051_product_legacy_code.sql', expectedNullable: true },
  {
    tableName: 'biz_outbound_order_item',
    columnName: 'sku_id',
    introducingScript: '041_manual_outbound_sku.sql',
    expectedDataType: 'bigint',
    expectedColumnType: 'bigint unsigned',
    expectedNullable: true,
  },
  {
    tableName: 'biz_outbound_order_item',
    columnName: 'sku_code_snapshot',
    introducingScript: '041_manual_outbound_sku.sql',
    expectedDataType: 'varchar',
    expectedColumnType: 'varchar(96)',
    expectedCharacterMaximumLength: 96,
    expectedNullable: true,
  },
  {
    tableName: 'biz_outbound_order_item',
    columnName: 'spec_text_snapshot',
    introducingScript: '041_manual_outbound_sku.sql',
    expectedDataType: 'varchar',
    expectedColumnType: 'varchar(255)',
    expectedCharacterMaximumLength: 255,
    expectedNullable: true,
  },
  { tableName: 'business_sequence', columnName: 'sequence_key', introducingScript: '035_o2o_idempotency_business_sequence.sql' },
  { tableName: 'business_sequence', columnName: 'current_value', introducingScript: '035_o2o_idempotency_business_sequence.sql' },
  { tableName: 'business_sequence', columnName: 'created_at', introducingScript: '035_o2o_idempotency_business_sequence.sql' },
  { tableName: 'business_sequence', columnName: 'updated_at', introducingScript: '035_o2o_idempotency_business_sequence.sql' },
  { tableName: 'notification_event', columnName: 'attempt_count', introducingScript: '036_notification_outbox.sql' },
  { tableName: 'notification_event', columnName: 'next_attempt_at', introducingScript: '036_notification_outbox.sql' },
  { tableName: 'notification_event', columnName: 'processing_started_at', introducingScript: '036_notification_outbox.sql' },
  { tableName: 'notification_event', columnName: 'processing_owner', introducingScript: '036_notification_outbox.sql' },
  { tableName: 'notification_event', columnName: 'processed_at', introducingScript: '036_notification_outbox.sql' },
  { tableName: 'notification_dispatch', columnName: 'dedupe_key', introducingScript: '036_notification_outbox.sql' },
  { tableName: 'notification_dispatch', columnName: 'last_attempt_at', introducingScript: '036_notification_outbox.sql' },
  { tableName: 'client_user', columnName: 'department_node_id', introducingScript: '037_department_account_node_binding.sql' },
  {
    tableName: 'o2o_preorder',
    columnName: 'department_name_snapshot',
    introducingScript: '038_department_path_capacity.sql',
    minCharacterMaximumLength: 271,
  },
  {
    tableName: 'client_feedback_conversation',
    columnName: 'department_name_snapshot',
    introducingScript: '038_department_path_capacity.sql',
    minCharacterMaximumLength: 271,
  },
  {
    tableName: 'biz_outbound_order',
    columnName: 'customer_department_name',
    introducingScript: '038_department_path_capacity.sql',
    minCharacterMaximumLength: 271,
  },
  { tableName: 'sms_verification_record', columnName: 'out_id', introducingScript: '039_aliyun_pnvs_sms_verification.sql' },
  {
    tableName: 'sms_verification_record',
    columnName: 'scheme_name',
    introducingScript: '039_aliyun_pnvs_sms_verification.sql',
    minCharacterMaximumLength: 20,
  },
  { tableName: 'sms_verification_record', columnName: 'target_digest', introducingScript: '039_aliyun_pnvs_sms_verification.sql' },
  { tableName: 'sms_verification_record', columnName: 'delivery_status', introducingScript: '039_aliyun_pnvs_sms_verification.sql' },
  {
    tableName: 'biz_outbound_order',
    columnName: 'business_no',
    introducingScript: '042_order_business_no_amendment.sql',
    expectedCharacterMaximumLength: 32,
    expectedDataType: 'varchar',
    expectedColumnType: 'varchar(32)',
    expectedNullable: false,
  },
  {
    tableName: 'biz_outbound_order',
    columnName: 'edit_version',
    introducingScript: '042_order_business_no_amendment.sql',
    expectedDataType: 'int',
    expectedColumnType: 'int',
    expectedNullable: false,
  },
  {
    tableName: 'biz_outbound_order',
    columnName: 'inventory_mode',
    introducingScript: '043_order_content_inventory_mode.sql',
    expectedDataType: 'varchar',
    expectedColumnType: 'varchar(24)',
    expectedCharacterMaximumLength: 24,
    expectedNullable: false,
  },
  {
    tableName: 'biz_outbound_order',
    columnName: 'status',
    introducingScript: '045_order_merge_governance.sql',
    expectedDataType: 'varchar',
    expectedColumnType: 'varchar(16)',
    expectedCharacterMaximumLength: 16,
    expectedNullable: false,
  },
  {
    tableName: 'biz_outbound_order_item',
    columnName: 'source_order_id',
    introducingScript: '045_order_merge_governance.sql',
    expectedDataType: 'bigint',
    expectedColumnType: 'bigint unsigned',
    expectedNullable: true,
  },
  {
    tableName: 'biz_outbound_order_item',
    columnName: 'source_order_uuid',
    introducingScript: '045_order_merge_governance.sql',
    expectedDataType: 'char',
    expectedColumnType: 'char(36)',
    expectedCharacterMaximumLength: 36,
    expectedNullable: true,
  },
  {
    tableName: 'biz_outbound_order_item',
    columnName: 'source_order_item_id',
    introducingScript: '045_order_merge_governance.sql',
    expectedDataType: 'bigint',
    expectedColumnType: 'bigint unsigned',
    expectedNullable: true,
  },
  {
    tableName: 'biz_outbound_order',
    columnName: 'source_doc_type',
    introducingScript: '046_outbound_order_source_doc.sql',
    expectedDataType: 'varchar',
    expectedColumnType: 'varchar(32)',
    expectedCharacterMaximumLength: 32,
    expectedNullable: true,
  },
  {
    tableName: 'biz_outbound_order',
    columnName: 'source_doc_id',
    introducingScript: '046_outbound_order_source_doc.sql',
    expectedDataType: 'bigint',
    expectedColumnType: 'bigint unsigned',
    expectedNullable: true,
  },
  {
    tableName: 'biz_outbound_order',
    columnName: 'source_doc_no',
    introducingScript: '046_outbound_order_source_doc.sql',
    expectedDataType: 'varchar',
    expectedColumnType: 'varchar(64)',
    expectedCharacterMaximumLength: 64,
    expectedNullable: true,
  },
  ...['operation_uuid', 'idempotency_key', 'request_hash', 'target_order_id', 'target_order_uuid', 'target_edit_version', 'merged_source_order_ids_json', 'reason', 'actor_user_id', 'actor_username', 'actor_display_name', 'created_at']
    .map((columnName) => ({ tableName: 'order_merge_operation', columnName, introducingScript: '045_order_merge_governance.sql' })),
  {
    tableName: 'order_merge_operation',
    columnName: 'result_json',
    introducingScript: '045_order_merge_governance.sql',
    expectedDataType: 'longtext',
    expectedColumnType: 'longtext',
    expectedNullable: false,
  },
  ...['operation_id', 'parent_order_id', 'parent_order_uuid', 'parent_business_no_snapshot', 'source_order_id', 'source_order_uuid', 'source_business_no_snapshot', 'created_at']
    .map((columnName) => ({ tableName: 'order_merge_relation', columnName, introducingScript: '045_order_merge_governance.sql' })),
  {
    tableName: 'inventory_log',
    columnName: 'sku_id',
    introducingScript: '043_order_content_inventory_mode.sql',
    expectedDataType: 'bigint',
    expectedColumnType: 'bigint unsigned',
    expectedNullable: true,
  },
  { tableName: 'inventory_log', columnName: 'before_sku_current_stock', introducingScript: '043_order_content_inventory_mode.sql', expectedDataType: 'int', expectedColumnType: 'int', expectedNullable: true },
  { tableName: 'inventory_log', columnName: 'after_sku_current_stock', introducingScript: '043_order_content_inventory_mode.sql', expectedDataType: 'int', expectedColumnType: 'int', expectedNullable: true },
  { tableName: 'inventory_log', columnName: 'before_sku_preordered_stock', introducingScript: '043_order_content_inventory_mode.sql', expectedDataType: 'int', expectedColumnType: 'int', expectedNullable: true },
  { tableName: 'inventory_log', columnName: 'after_sku_preordered_stock', introducingScript: '043_order_content_inventory_mode.sql', expectedDataType: 'int', expectedColumnType: 'int', expectedNullable: true },
  { tableName: 'order_business_no_occupancy', columnName: 'business_namespace', introducingScript: '042_order_business_no_amendment.sql' },
  { tableName: 'order_business_no_occupancy', columnName: 'serial_value', introducingScript: '042_order_business_no_amendment.sql' },
  { tableName: 'order_business_no_occupancy', columnName: 'business_no', introducingScript: '042_order_business_no_amendment.sql' },
  { tableName: 'order_business_no_occupancy', columnName: 'order_uuid', introducingScript: '042_order_business_no_amendment.sql' },
  { tableName: 'order_business_no_occupancy', columnName: 'assigned_reason', introducingScript: '042_order_business_no_amendment.sql' },
  { tableName: 'order_business_no_occupancy', columnName: 'created_at', introducingScript: '042_order_business_no_amendment.sql' },
  { tableName: 'order_business_no_occupancy', columnName: 'last_assigned_order_uuid', introducingScript: '054_order_business_no_reuse.sql', expectedDataType: 'char', expectedColumnType: 'char(36)', expectedCharacterMaximumLength: 36, expectedNullable: false },
  { tableName: 'order_business_no_occupancy', columnName: 'last_assigned_at', introducingScript: '054_order_business_no_reuse.sql', expectedDataType: 'datetime', expectedColumnType: 'datetime(6)', expectedNullable: false },
  { tableName: 'order_business_no_occupancy', columnName: 'reuse_count', introducingScript: '054_order_business_no_reuse.sql', expectedDataType: 'int', expectedColumnType: 'int', expectedNullable: false },
  ...['business_namespace', 'serial_value', 'business_no', 'from_order_uuid', 'to_order_uuid', 'target_order_id_snapshot', 'target_show_no_snapshot', 'reuse_count', 'reason', 'actor_user_id', 'actor_username', 'actor_display_name', 'ip_address', 'user_agent', 'created_at']
    .map((columnName) => ({ tableName: 'order_business_no_reuse_event', columnName, introducingScript: '054_order_business_no_reuse.sql' })),
  { tableName: 'order_revision', columnName: 'order_id_snapshot', introducingScript: '042_order_business_no_amendment.sql' },
  { tableName: 'order_revision', columnName: 'order_uuid', introducingScript: '042_order_business_no_amendment.sql' },
  { tableName: 'order_revision', columnName: 'revision_no', introducingScript: '042_order_business_no_amendment.sql' },
  { tableName: 'order_revision', columnName: 'before_snapshot_json', introducingScript: '042_order_business_no_amendment.sql' },
  { tableName: 'order_revision', columnName: 'after_snapshot_json', introducingScript: '042_order_business_no_amendment.sql' },
  { tableName: 'order_revision', columnName: 'reason', introducingScript: '042_order_business_no_amendment.sql' },
  { tableName: 'order_revision', columnName: 'actor_user_id', introducingScript: '042_order_business_no_amendment.sql' },
  { tableName: 'order_revision', columnName: 'actor_username', introducingScript: '042_order_business_no_amendment.sql' },
  { tableName: 'order_revision', columnName: 'actor_display_name', introducingScript: '042_order_business_no_amendment.sql' },
  { tableName: 'order_revision', columnName: 'ip_address', introducingScript: '042_order_business_no_amendment.sql' },
  { tableName: 'order_revision', columnName: 'user_agent', introducingScript: '042_order_business_no_amendment.sql' },
  { tableName: 'order_revision', columnName: 'created_at', introducingScript: '042_order_business_no_amendment.sql' },
  // 053：系列内序号永久占用登记表命名空间从 tagId 迁移到系列码维度（PR #109 第五轮评审 P1-C 修复）。
  {
    tableName: 'base_yz_series_seq_reservation',
    columnName: 'series_code',
    introducingScript: '053_yz_reservation_series_code.sql',
    expectedDataType: 'varchar',
    expectedColumnType: 'varchar(2)',
    expectedCharacterMaximumLength: 2,
    expectedNullable: false,
  },
  {
    tableName: 'base_yz_series_seq_reservation',
    columnName: 'code_prefix',
    introducingScript: '053_yz_reservation_series_code.sql',
    expectedDataType: 'varchar',
    expectedColumnType: 'varchar(4)',
    expectedCharacterMaximumLength: 4,
    expectedNullable: false,
  },
]

// 不只按索引名判断，还校验列顺序与唯一性，避免旧库中存在同名但错误的索引时误判为可启动。
const MYSQL_REQUIRED_INDEXES: readonly MysqlRequiredIndex[] = [
  {
    tableName: 'account_lifecycle_event',
    indexName: 'idx_account_lifecycle_event_account',
    columns: ['account_domain', 'account_id_snapshot', 'id'],
    unique: false,
    introducingScript: '044_account_lifecycle_governance.sql',
  },
  {
    tableName: 'account_lifecycle_event',
    indexName: 'idx_account_lifecycle_event_created_at',
    columns: ['created_at', 'id'],
    unique: false,
    introducingScript: '044_account_lifecycle_governance.sql',
  },
  {
    tableName: 'inventory_log',
    indexName: 'idx_inventory_log_sku_id',
    columns: ['sku_id'],
    unique: false,
    introducingScript: '043_order_content_inventory_mode.sql',
  },
  {
    tableName: 'biz_outbound_order_item',
    indexName: 'idx_biz_outbound_item_sku_id',
    columns: ['sku_id'],
    unique: false,
    introducingScript: '041_manual_outbound_sku.sql',
  },
  {
    tableName: 'client_mobile_session',
    indexName: 'uk_client_mobile_session_access_hash',
    columns: ['access_token_hash'],
    unique: true,
    introducingScript: '037_mobile_auth_session.sql',
  },
  {
    tableName: 'client_mobile_session',
    indexName: 'uk_client_mobile_session_refresh_hash',
    columns: ['refresh_token_hash'],
    unique: true,
    introducingScript: '037_mobile_auth_session.sql',
  },
  {
    tableName: 'client_mobile_session',
    indexName: 'idx_client_mobile_session_previous_refresh_hash',
    columns: ['previous_refresh_token_hash'],
    unique: false,
    introducingScript: '037_mobile_auth_session.sql',
  },
  {
    tableName: 'client_mobile_session',
    indexName: 'idx_client_mobile_session_user_active',
    columns: ['client_user_id', 'revoked_at', 'last_access_at'],
    unique: false,
    introducingScript: '037_mobile_auth_session.sql',
  },
  {
    tableName: 'client_mobile_session',
    indexName: 'idx_client_mobile_session_user_device',
    columns: ['client_user_id', 'device_id'],
    unique: false,
    introducingScript: '037_mobile_auth_session.sql',
  },
  {
    tableName: 'client_mobile_session',
    indexName: 'idx_client_mobile_session_cleanup',
    columns: ['revoked_at', 'absolute_expires_at', 'id'],
    unique: false,
    introducingScript: '037_mobile_auth_session.sql',
  },
  {
    tableName: 'client_mobile_session',
    indexName: 'idx_client_mobile_session_refresh_expiry',
    columns: ['revoked_at', 'refresh_expires_at', 'id'],
    unique: false,
    introducingScript: '037_mobile_auth_session.sql',
  },
  {
    tableName: 'o2o_preorder',
    indexName: 'uk_o2o_preorder_client_request',
    columns: ['client_user_id', 'client_request_id'],
    unique: true,
    introducingScript: '035_o2o_idempotency_business_sequence.sql',
  },
  {
    tableName: 'notification_event',
    indexName: 'idx_notification_event_pending_claim',
    columns: ['status', 'next_attempt_at', 'id'],
    unique: false,
    introducingScript: '036_notification_outbox.sql',
  },
  {
    tableName: 'notification_event',
    indexName: 'idx_notification_event_processing_recovery',
    columns: ['status', 'processing_started_at', 'id'],
    unique: false,
    introducingScript: '036_notification_outbox.sql',
  },
  {
    tableName: 'notification_inbox',
    indexName: 'uk_notification_inbox_event_user',
    columns: ['event_id', 'user_id'],
    unique: true,
    introducingScript: '036_notification_outbox.sql',
  },
  {
    tableName: 'notification_dispatch',
    indexName: 'uk_notification_dispatch_event_channel_target',
    columns: ['event_id', 'channel', 'dedupe_key'],
    unique: true,
    introducingScript: '036_notification_outbox.sql',
  },
  {
    tableName: 'client_user',
    indexName: 'uk_client_user_department_node_id',
    columns: ['department_node_id'],
    unique: true,
    introducingScript: '037_department_account_node_binding.sql',
  },
  {
    tableName: 'sms_verification_record',
    indexName: 'uk_sms_verification_record_out_id',
    columns: ['out_id'],
    unique: true,
    introducingScript: '039_aliyun_pnvs_sms_verification.sql',
  },
  {
    tableName: 'sms_verification_record',
    indexName: 'idx_sms_verification_record_lookup',
    columns: ['channel', 'scene', 'target_digest', 'expires_at'],
    unique: false,
    introducingScript: '039_aliyun_pnvs_sms_verification.sql',
  },
  {
    tableName: 'biz_outbound_order',
    indexName: 'uk_biz_outbound_business_no',
    columns: ['business_no'],
    unique: true,
    introducingScript: '042_order_business_no_amendment.sql',
  },
  {
    tableName: 'order_business_no_occupancy',
    indexName: 'uk_order_business_no_occupancy_business_no',
    columns: ['business_no'],
    unique: true,
    introducingScript: '042_order_business_no_amendment.sql',
  },
  {
    tableName: 'order_business_no_occupancy',
    indexName: 'idx_order_business_no_occupancy_last_assigned_order_uuid',
    columns: ['last_assigned_order_uuid'],
    unique: false,
    introducingScript: '054_order_business_no_reuse.sql',
  },
  {
    tableName: 'order_business_no_reuse_event',
    indexName: 'idx_order_business_no_reuse_event_business_no',
    columns: ['business_no'],
    unique: false,
    introducingScript: '054_order_business_no_reuse.sql',
  },
  {
    tableName: 'order_business_no_reuse_event',
    indexName: 'idx_order_business_no_reuse_event_to_order_uuid',
    columns: ['to_order_uuid'],
    unique: false,
    introducingScript: '054_order_business_no_reuse.sql',
  },
  {
    tableName: 'order_business_no_occupancy',
    indexName: 'uk_order_business_no_occupancy_namespace_serial',
    columns: ['business_namespace', 'serial_value'],
    unique: true,
    introducingScript: '042_order_business_no_amendment.sql',
  },
  {
    tableName: 'order_business_no_occupancy',
    indexName: 'idx_order_business_no_occupancy_order_uuid',
    columns: ['order_uuid'],
    unique: false,
    introducingScript: '042_order_business_no_amendment.sql',
  },
  {
    tableName: 'order_revision',
    indexName: 'uk_order_revision_uuid_version',
    columns: ['order_uuid', 'revision_no'],
    unique: true,
    introducingScript: '042_order_business_no_amendment.sql',
  },
  {
    tableName: 'order_revision',
    indexName: 'idx_order_revision_order_id_snapshot',
    columns: ['order_id_snapshot'],
    unique: false,
    introducingScript: '042_order_business_no_amendment.sql',
  },
  { tableName: 'biz_outbound_order', indexName: 'idx_biz_outbound_status', columns: ['status'], unique: false, introducingScript: '045_order_merge_governance.sql' },
  { tableName: 'biz_outbound_order', indexName: 'idx_biz_outbound_source_doc', columns: ['source_doc_type', 'source_doc_id'], unique: false, introducingScript: '046_outbound_order_source_doc.sql' },
  { tableName: 'biz_outbound_order_item', indexName: 'idx_biz_outbound_item_source_order_id', columns: ['source_order_id'], unique: false, introducingScript: '045_order_merge_governance.sql' },
  { tableName: 'biz_outbound_order_item', indexName: 'idx_biz_outbound_item_source_item_id', columns: ['source_order_item_id'], unique: false, introducingScript: '045_order_merge_governance.sql' },
  { tableName: 'order_merge_operation', indexName: 'uk_order_merge_operation_uuid', columns: ['operation_uuid'], unique: true, introducingScript: '045_order_merge_governance.sql' },
  { tableName: 'order_merge_operation', indexName: 'uk_order_merge_operation_idempotency_key', columns: ['idempotency_key'], unique: true, introducingScript: '045_order_merge_governance.sql' },
  { tableName: 'order_merge_operation', indexName: 'idx_order_merge_operation_target_order_id', columns: ['target_order_id'], unique: false, introducingScript: '045_order_merge_governance.sql' },
  { tableName: 'order_merge_relation', indexName: 'uk_order_merge_relation_source_order_id', columns: ['source_order_id'], unique: true, introducingScript: '045_order_merge_governance.sql' },
  { tableName: 'order_merge_relation', indexName: 'uk_order_merge_relation_parent_source', columns: ['parent_order_id', 'source_order_id'], unique: true, introducingScript: '045_order_merge_governance.sql' },
  { tableName: 'order_merge_relation', indexName: 'idx_order_merge_relation_operation_id', columns: ['operation_id'], unique: false, introducingScript: '045_order_merge_governance.sql' },
  { tableName: 'order_merge_relation', indexName: 'idx_order_merge_relation_parent_order_id', columns: ['parent_order_id'], unique: false, introducingScript: '045_order_merge_governance.sql' },
  // 049：库存域唯一键承担编码唯一、条码唯一、单据幂等与“同单同规格一行”约束，缺失时必须在启动期阻断。
  ...([
    ['base_category', 'uk_base_category_code', ['category_code']],
    ['base_category', 'uk_base_category_name', ['category_name']],
    ['base_storage_location', 'uk_base_storage_location_code', ['location_code']],
    ['base_product_sku', 'uk_base_product_sku_barcode', ['barcode']],
    ['inv_stock_doc', 'uk_inv_stock_doc_no', ['doc_no']],
    ['inv_stock_doc', 'uk_inv_stock_doc_request', ['client_request_id']],
    ['inv_stocktake', 'uk_inv_stocktake_no', ['stocktake_no']],
    ['inv_stocktake_item', 'uk_inv_stocktake_item_sku', ['stocktake_id', 'sku_id']],
  ] as const).map(([tableName, indexName, columns]) => ({
    tableName,
    indexName,
    columns: [...columns],
    unique: true,
    introducingScript: '049_inventory_sku_barcode_stocktake.sql',
  })),
  // 050：YZ 编码体系的系列码唯一、系列内序号唯一与变体码登记表唯一键，缺失时同样必须在启动期阻断。
  {
    tableName: 'base_product',
    indexName: 'idx_base_product_primary_series_tag_id',
    columns: ['primary_series_tag_id'],
    unique: false,
    introducingScript: '050_product_yz_sku_code.sql',
  },
  ...([
    ['base_tag', 'uk_base_tag_series_code', ['series_code']],
    ['base_product', 'uk_base_product_series_seq', ['primary_series_tag_id', 'series_seq']],
    ['base_product_variant_code_registry', 'uk_registry_lookup', ['product_id', 'axis', 'spec_value']],
    ['base_product_variant_code_registry', 'uk_registry_code', ['product_id', 'axis', 'code']],
  ] as const).map(([tableName, indexName, columns]) => ({
    tableName,
    indexName,
    columns: [...columns],
    unique: true,
    introducingScript: '050_product_yz_sku_code.sql',
  })),
  // 051：历史 SKU 编码要支持扫码按它查，普通索引，不加唯一约束（历史编码理论上可能重复）。
  {
    tableName: 'base_product_sku',
    indexName: 'idx_base_product_sku_legacy_code',
    columns: ['legacy_sku_code'],
    unique: false,
    introducingScript: '051_product_legacy_code.sql',
  },
  // 053：系列内序号永久占用登记表的权威唯一键改为 (code_prefix, series_code, series_seq)，缺失时同一
  // 序号可能被并发重复登记（PR #109 第五轮评审 P1-C 修复）。旧的按 tagId 的唯一索引已在 053 里降级并
  // 改名为普通索引 idx_yz_series_seq_reservation_tag，仅供追溯，不再纳入启动期必需校验。
  {
    tableName: 'base_yz_series_seq_reservation',
    indexName: 'uk_yz_series_seq_reservation_code',
    columns: ['code_prefix', 'series_code', 'series_seq'],
    unique: true,
    introducingScript: '053_yz_reservation_series_code.sql',
  },
]

const MYSQL_REQUIRED_FOREIGN_KEYS: readonly MysqlRequiredForeignKey[] = [
  ...[
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
  ].map(([tableName, columnName, referencedTableName]) => ({
    tableName,
    columnName,
    referencedTableName,
    referencedColumnName: 'id',
    deleteRule: 'RESTRICT',
    introducingScript: '044_account_lifecycle_governance.sql',
  })),
  {
    tableName: 'biz_outbound_order_item',
    columnName: 'sku_id',
    referencedTableName: 'base_product_sku',
    referencedColumnName: 'id',
    deleteRule: 'SET NULL',
    introducingScript: '041_manual_outbound_sku.sql',
  },
  {
    tableName: 'inventory_log',
    columnName: 'sku_id',
    referencedTableName: 'base_product_sku',
    referencedColumnName: 'id',
    deleteRule: 'SET NULL',
    introducingScript: '043_order_content_inventory_mode.sql',
  },
  ...[
    ['order_merge_operation', 'target_order_id', 'biz_outbound_order'],
    ['order_merge_relation', 'operation_id', 'order_merge_operation'],
    ['order_merge_relation', 'parent_order_id', 'biz_outbound_order'],
    ['order_merge_relation', 'source_order_id', 'biz_outbound_order'],
  ].map(([tableName, columnName, referencedTableName]) => ({
    tableName,
    columnName,
    referencedTableName,
    referencedColumnName: 'id',
    deleteRule: 'RESTRICT',
    introducingScript: '045_order_merge_governance.sql',
  })),
  ...[
    ['base_product', 'category_id', 'base_category', 'RESTRICT'],
    ['base_product_sku', 'location_id', 'base_storage_location', 'RESTRICT'],
    ['inv_stock_doc_item', 'doc_id', 'inv_stock_doc', 'CASCADE'],
    ['inv_stock_doc_item', 'product_id', 'base_product', 'RESTRICT'],
    ['inv_stock_doc_item', 'sku_id', 'base_product_sku', 'RESTRICT'],
    ['inv_stocktake_item', 'stocktake_id', 'inv_stocktake', 'CASCADE'],
    ['inv_stocktake_item', 'product_id', 'base_product', 'RESTRICT'],
    ['inv_stocktake_item', 'sku_id', 'base_product_sku', 'RESTRICT'],
  ].map(([tableName, columnName, referencedTableName, deleteRule]) => ({
    tableName,
    columnName,
    referencedTableName,
    referencedColumnName: 'id',
    deleteRule,
    introducingScript: '049_inventory_sku_barcode_stocktake.sql',
  })),
  ...[
    ['base_product', 'primary_series_tag_id', 'base_tag', 'RESTRICT'],
    ['base_product_variant_code_registry', 'product_id', 'base_product', 'CASCADE'],
  ].map(([tableName, columnName, referencedTableName, deleteRule]) => ({
    tableName,
    columnName,
    referencedTableName,
    referencedColumnName: 'id',
    deleteRule,
    introducingScript: '050_product_yz_sku_code.sql',
  })),
]

const MYSQL_REQUIRED_TRIGGERS: readonly MysqlRequiredTrigger[] = [
  {
    triggerName: 'trg_order_business_no_reuse_event_no_update',
    eventManipulation: 'UPDATE',
    actionTiming: 'BEFORE',
    introducingScript: '054_order_business_no_reuse.sql',
  },
  {
    triggerName: 'trg_order_business_no_reuse_event_no_delete',
    eventManipulation: 'DELETE',
    actionTiming: 'BEFORE',
    introducingScript: '054_order_business_no_reuse.sql',
  },
  {
    triggerName: 'trg_account_lifecycle_event_no_update',
    eventManipulation: 'UPDATE',
    actionTiming: 'BEFORE',
    introducingScript: '044_account_lifecycle_governance.sql',
  },
  {
    triggerName: 'trg_account_lifecycle_event_no_delete',
    eventManipulation: 'DELETE',
    actionTiming: 'BEFORE',
    introducingScript: '044_account_lifecycle_governance.sql',
  },
]

const MYSQL_REQUIRED_CHECKS: readonly MysqlRequiredCheck[] = [
  {
    tableName: 'order_business_no_reuse_event',
    constraintName: 'ck_order_business_no_reuse_event_namespace',
    introducingScript: '054_order_business_no_reuse.sql',
  },
  {
    tableName: 'order_merge_relation',
    constraintName: 'ck_order_merge_relation_distinct_orders',
    introducingScript: '045_order_merge_governance.sql',
  },
]

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
  '037_mobile_auth_session.sql',
  '037_department_account_node_binding.sql',
  '038_department_path_capacity.sql',
  '039_aliyun_pnvs_sms_verification.sql',
  '040_o2o_preorder_governance.sql',
  '041_manual_outbound_sku.sql',
  '042_order_business_no_amendment.sql',
  '043_order_content_inventory_mode.sql',
  '044_account_lifecycle_governance.sql',
  '045_order_merge_governance.sql',
  '046_outbound_order_source_doc.sql',
  '047_o2o_preorder_pickup_at.sql',
  '048_inbound_order_expected_arrival.sql',
  '049_inventory_sku_barcode_stocktake.sql',
  '050_product_yz_sku_code.sql',
  '051_product_legacy_code.sql',
  '052_yz_series_seq_reservation.sql',
  '053_yz_reservation_series_code.sql',
  '054_order_business_no_reuse.sql',
]

/**
 * 按 MySQL 语句边界拆分 SQL 文本：
 * - 忽略单引号字符串内部的分号（含 '' 转义引号）；
 * - 忽略 `--` 行注释内部的分号；
 * - 044 的触发器使用单条 SIGNAL 作为 trigger body，不需要 DELIMITER；
 * - 仍不处理含 BEGIN/END 的存储过程或复合触发器，一旦引入需同步升级本函数。
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

/**
 * 自动迁移脚本只有在其负责的关键列/索引/外键真实存在且形状正确后才允许写 tracking。
 * 这不会猜测性修复人工创建的部分表，而是避免 `CREATE TABLE IF NOT EXISTS`
 * 对异常同名表无操作后仍被误记为“已应用”。
 */
async function assertAutoMigrationResult(queryRunner: QueryRunner, filename: string): Promise<void> {
  const requiredColumns = MYSQL_REQUIRED_COLUMNS.filter((item) => item.introducingScript === filename)
  const requiredIndexes = MYSQL_REQUIRED_INDEXES.filter((item) => item.introducingScript === filename)
  const requiredForeignKeys = MYSQL_REQUIRED_FOREIGN_KEYS.filter((item) => item.introducingScript === filename)
  const requiredTriggers = MYSQL_REQUIRED_TRIGGERS.filter((item) => item.introducingScript === filename)
  const requiredChecks = MYSQL_REQUIRED_CHECKS.filter((item) => item.introducingScript === filename)
  if (requiredColumns.length === 0 && requiredIndexes.length === 0 && requiredForeignKeys.length === 0 && requiredTriggers.length === 0 && requiredChecks.length === 0) return

  const tableNames = [...new Set([
    ...requiredColumns.map((item) => item.tableName),
    ...requiredIndexes.map((item) => item.tableName),
    ...requiredForeignKeys.map((item) => item.tableName),
    ...requiredChecks.map((item) => item.tableName),
  ])]
  const columnNames = [...new Set(requiredColumns.map((item) => item.columnName))]
  const columnRows: MysqlColumnRow[] = requiredColumns.length > 0
    ? await queryRunner.query(
        `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME IN (${tableNames.map(() => '?').join(', ')})
           AND COLUMN_NAME IN (${columnNames.map(() => '?').join(', ')})`,
        [...tableNames, ...columnNames],
      )
    : []
  const existingColumns = new Set(columnRows.map((row) => schemaObjectKey(row.TABLE_NAME, row.COLUMN_NAME)))
  const missingColumns = requiredColumns.filter((item) => (
    !existingColumns.has(schemaObjectKey(item.tableName, item.columnName))
  ))
  const invalidColumnDefinitions = collectMysqlColumnDefinitionIssues(columnRows, requiredColumns)

  const indexNames = [...new Set(requiredIndexes.map((item) => item.indexName))]
  const indexRows: MysqlIndexRow[] = requiredIndexes.length > 0
    ? await queryRunner.query(
        `SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX, NON_UNIQUE
         FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME IN (${tableNames.map(() => '?').join(', ')})
           AND INDEX_NAME IN (${indexNames.map(() => '?').join(', ')})
         ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
        [...tableNames, ...indexNames],
      )
    : []
  const actualIndexes = new Map<string, { columns: string[]; unique: boolean }>()
  for (const row of indexRows) {
    const key = schemaObjectKey(row.TABLE_NAME, row.INDEX_NAME)
    const current = actualIndexes.get(key) ?? { columns: [], unique: Number(row.NON_UNIQUE) === 0 }
    current.columns[Number(row.SEQ_IN_INDEX) - 1] = row.COLUMN_NAME
    current.unique = current.unique && Number(row.NON_UNIQUE) === 0
    actualIndexes.set(key, current)
  }
  const invalidIndexes = requiredIndexes.filter((requirement) => {
    const actual = actualIndexes.get(schemaObjectKey(requirement.tableName, requirement.indexName))
    return !actual
      || actual.unique !== requirement.unique
      || actual.columns.length !== requirement.columns.length
      || requirement.columns.some((column, index) => actual.columns[index] !== column)
  })

  const foreignKeyRows: MysqlForeignKeyRow[] = requiredForeignKeys.length > 0
    ? await queryRunner.query(
        `SELECT kcu.TABLE_NAME, kcu.CONSTRAINT_NAME, kcu.COLUMN_NAME,
                kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME,
                kcu.ORDINAL_POSITION, rc.DELETE_RULE
         FROM information_schema.KEY_COLUMN_USAGE kcu
         INNER JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
           ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
          AND rc.TABLE_NAME = kcu.TABLE_NAME
          AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
         WHERE kcu.CONSTRAINT_SCHEMA = DATABASE()
           AND kcu.TABLE_NAME IN (${tableNames.map(() => '?').join(', ')})
           AND kcu.REFERENCED_TABLE_NAME IS NOT NULL`,
        tableNames,
      )
    : []
  const invalidForeignKeys = collectMysqlForeignKeyIssues(foreignKeyRows, requiredForeignKeys)
  const triggerRows: MysqlTriggerRow[] = requiredTriggers.length > 0
    ? await queryRunner.query(
        `SELECT TRIGGER_NAME, EVENT_MANIPULATION, ACTION_TIMING
         FROM information_schema.TRIGGERS
         WHERE TRIGGER_SCHEMA = DATABASE()
           AND TRIGGER_NAME IN (${requiredTriggers.map(() => '?').join(', ')})`,
        requiredTriggers.map((item) => item.triggerName),
      )
    : []
  const invalidTriggers = collectMysqlTriggerIssues(triggerRows, requiredTriggers)
  const checkRows: MysqlCheckRow[] = requiredChecks.length > 0
    ? await queryRunner.query(
        `SELECT TABLE_NAME, CONSTRAINT_NAME
         FROM information_schema.TABLE_CONSTRAINTS
         WHERE CONSTRAINT_SCHEMA = DATABASE()
           AND CONSTRAINT_TYPE = 'CHECK'
           AND TABLE_NAME IN (${tableNames.map(() => '?').join(', ')})`,
        tableNames,
      )
    : []
  const existingChecks = new Set(checkRows.map((row) => schemaObjectKey(row.TABLE_NAME, row.CONSTRAINT_NAME)))
  const missingChecks = requiredChecks.filter((item) => (
    !existingChecks.has(schemaObjectKey(item.tableName, item.constraintName))
  ))
  if (
    missingColumns.length === 0
    && invalidColumnDefinitions.length === 0
    && invalidIndexes.length === 0
    && invalidForeignKeys.length === 0
    && invalidTriggers.length === 0
    && missingChecks.length === 0
  ) return

  const missingLabels = [
    ...missingColumns.map((item) => `字段 ${item.tableName}.${item.columnName}`),
    ...invalidColumnDefinitions.map((item) => item.label),
    ...invalidIndexes.map((item) => `索引 ${item.tableName}.${item.indexName}`),
    ...invalidForeignKeys.map((item) => item.label),
    ...invalidTriggers.map((item) => item.label),
    ...missingChecks.map((item) => `检查约束 ${item.tableName}.${item.constraintName}`),
  ]
  throw new Error(
    `[启动失败] 自动迁移 ${filename} 执行后结构仍不完整，未写入迁移记录：${missingLabels.join('、')}。`
    + '请先人工核查并修复异常的部分表结构，再重启服务。',
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
      await assertAutoMigrationResult(queryRunner, filename)
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

interface MysqlTableRow {
  TABLE_NAME: string
}

interface MysqlColumnRow extends MysqlTableRow {
  COLUMN_NAME: string
  DATA_TYPE: string
  COLUMN_TYPE: string
  IS_NULLABLE: string
  CHARACTER_MAXIMUM_LENGTH: number | string | null
}

interface MysqlIndexRow extends MysqlTableRow {
  COLUMN_NAME: string
  INDEX_NAME: string
  SEQ_IN_INDEX: number | string
  NON_UNIQUE: number | string
}

interface MysqlForeignKeyRow extends MysqlTableRow {
  CONSTRAINT_NAME: string
  COLUMN_NAME: string
  REFERENCED_TABLE_NAME: string
  REFERENCED_COLUMN_NAME: string
  ORDINAL_POSITION: number | string
  DELETE_RULE: string
}

interface MysqlTriggerRow {
  TRIGGER_NAME: string
  EVENT_MANIPULATION: string
  ACTION_TIMING: string
}

interface MysqlCheckRow extends MysqlTableRow {
  CONSTRAINT_NAME: string
}

interface MysqlSchemaShapeIssue<TRequirement> {
  requirement: TRequirement
  label: string
}

const schemaObjectKey = (tableName: string, objectName: string) => `${tableName}.${objectName}`

const normalizeMysqlDefinition = (value: unknown): string => String(value ?? '').trim().toLowerCase().replaceAll(/\s+/g, ' ')

function collectMysqlColumnDefinitionIssues(
  rows: MysqlColumnRow[],
  requirements: readonly MysqlRequiredColumn[],
): Array<MysqlSchemaShapeIssue<MysqlRequiredColumn>> {
  const rowMap = new Map(rows.map((row) => [schemaObjectKey(row.TABLE_NAME, row.COLUMN_NAME), row]))
  return requirements.flatMap((requirement) => {
    const row = rowMap.get(schemaObjectKey(requirement.tableName, requirement.columnName))
    if (!row) return []
    const labels: string[] = []
    const expectedType = requirement.expectedColumnType ?? requirement.expectedDataType
    if (
      (requirement.expectedDataType
        && normalizeMysqlDefinition(row.DATA_TYPE) !== normalizeMysqlDefinition(requirement.expectedDataType))
      || (requirement.expectedColumnType
        && normalizeMysqlDefinition(row.COLUMN_TYPE) !== normalizeMysqlDefinition(requirement.expectedColumnType))
    ) {
      labels.push(`字段 ${requirement.tableName}.${requirement.columnName} 类型应为 ${expectedType}`)
    }
    if (
      requirement.expectedNullable !== undefined
      && (normalizeMysqlDefinition(row.IS_NULLABLE) === 'yes') !== requirement.expectedNullable
    ) {
      labels.push(
        requirement.expectedNullable
          ? `字段 ${requirement.tableName}.${requirement.columnName} 必须允许 NULL`
          : `字段 ${requirement.tableName}.${requirement.columnName} 必须为 NOT NULL`,
      )
    }
    if (
      requirement.expectedCharacterMaximumLength !== undefined
      && Number(row.CHARACTER_MAXIMUM_LENGTH) !== requirement.expectedCharacterMaximumLength
    ) {
      labels.push(
        `字段 ${requirement.tableName}.${requirement.columnName} 长度应为 ${requirement.expectedCharacterMaximumLength}`,
      )
    }
    return labels.map((label) => ({ requirement, label }))
  })
}

function collectMysqlForeignKeyIssues(
  rows: MysqlForeignKeyRow[],
  requirements: readonly MysqlRequiredForeignKey[],
): Array<MysqlSchemaShapeIssue<MysqlRequiredForeignKey>> {
  return requirements.flatMap((requirement) => {
    const sourceRows = rows.filter((row) => (
      row.TABLE_NAME === requirement.tableName && row.COLUMN_NAME === requirement.columnName
    ))
    if (
      sourceRows.length !== 1
      || sourceRows[0]?.REFERENCED_TABLE_NAME !== requirement.referencedTableName
      || sourceRows[0]?.REFERENCED_COLUMN_NAME !== requirement.referencedColumnName
    ) {
      return [{
        requirement,
        label: `外键 ${requirement.tableName}.${requirement.columnName} 目标应为 ${requirement.referencedTableName}.${requirement.referencedColumnName}`,
      }]
    }
    if (normalizeMysqlDefinition(sourceRows[0]?.DELETE_RULE) !== normalizeMysqlDefinition(requirement.deleteRule)) {
      return [{
        requirement,
        label: `外键 ${requirement.tableName}.${requirement.columnName} 必须使用 ON DELETE ${requirement.deleteRule}`,
      }]
    }
    return []
  })
}

function collectMysqlTriggerIssues(
  rows: MysqlTriggerRow[],
  requirements: readonly MysqlRequiredTrigger[],
): Array<MysqlSchemaShapeIssue<MysqlRequiredTrigger>> {
  const rowMap = new Map(rows.map((row) => [row.TRIGGER_NAME, row]))
  return requirements.flatMap((requirement) => {
    const row = rowMap.get(requirement.triggerName)
    if (
      row
      && normalizeMysqlDefinition(row.EVENT_MANIPULATION) === normalizeMysqlDefinition(requirement.eventManipulation)
      && normalizeMysqlDefinition(row.ACTION_TIMING) === normalizeMysqlDefinition(requirement.actionTiming)
    ) return []
    return [{ requirement, label: `触发器 ${requirement.triggerName} 必须为 ${requirement.actionTiming} ${requirement.eventManipulation}` }]
  })
}

/** 启动期只读自检：确认当前代码会直接依赖的 MySQL 表、字段与索引结构均已落地。 */
export async function assertMysqlRequiredSchemaExists(dataSource: DataSource): Promise<void> {
  if (env.DB_TYPE !== 'mysql') {
    return
  }

  const tableRows: MysqlTableRow[] = await dataSource.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${MYSQL_REQUIRED_TABLES.map(() => '?').join(', ')})`,
    MYSQL_REQUIRED_TABLES,
  )
  const existingTableSet = new Set(tableRows.map((row) => row.TABLE_NAME))
  const missingTables = MYSQL_REQUIRED_TABLES.filter((table) => !existingTableSet.has(table))

  const requiredColumnsOnExistingTables = MYSQL_REQUIRED_COLUMNS.filter((requirement) => (
    existingTableSet.has(requirement.tableName)
  ))
  const requiredColumnTables = [...new Set(requiredColumnsOnExistingTables.map((item) => item.tableName))]
  const requiredColumnNames = [...new Set(requiredColumnsOnExistingTables.map((item) => item.columnName))]
  const columnRows: MysqlColumnRow[] = requiredColumnsOnExistingTables.length > 0
    ? await dataSource.query(
        `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME IN (${requiredColumnTables.map(() => '?').join(', ')})
           AND COLUMN_NAME IN (${requiredColumnNames.map(() => '?').join(', ')})`,
        [...requiredColumnTables, ...requiredColumnNames],
      )
    : []
  const existingColumnSet = new Set(columnRows.map((row) => schemaObjectKey(row.TABLE_NAME, row.COLUMN_NAME)))
  const existingColumnMap = new Map(columnRows.map((row) => [schemaObjectKey(row.TABLE_NAME, row.COLUMN_NAME), row]))
  const missingColumns = requiredColumnsOnExistingTables.filter((requirement) => (
    !existingColumnSet.has(schemaObjectKey(requirement.tableName, requirement.columnName))
  ))
  const undersizedColumns = requiredColumnsOnExistingTables.filter((requirement) => {
    if (requirement.minCharacterMaximumLength === undefined) {
      return false
    }
    const row = existingColumnMap.get(schemaObjectKey(requirement.tableName, requirement.columnName))
    return Boolean(row) && Number(row?.CHARACTER_MAXIMUM_LENGTH ?? 0) < requirement.minCharacterMaximumLength
  })
  const invalidColumnDefinitions = collectMysqlColumnDefinitionIssues(
    columnRows,
    requiredColumnsOnExistingTables,
  )

  const requiredIndexesOnExistingTables = MYSQL_REQUIRED_INDEXES.filter((requirement) => (
    existingTableSet.has(requirement.tableName)
  ))
  const requiredIndexTables = [...new Set(requiredIndexesOnExistingTables.map((item) => item.tableName))]
  const requiredIndexNames = [...new Set(requiredIndexesOnExistingTables.map((item) => item.indexName))]
  const indexRows: MysqlIndexRow[] = requiredIndexesOnExistingTables.length > 0
    ? await dataSource.query(
        `SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX, NON_UNIQUE
         FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME IN (${requiredIndexTables.map(() => '?').join(', ')})
           AND INDEX_NAME IN (${requiredIndexNames.map(() => '?').join(', ')})
         ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
        [...requiredIndexTables, ...requiredIndexNames],
      )
    : []
  const actualIndexes = new Map<string, { columns: string[]; unique: boolean }>()
  for (const row of indexRows) {
    const key = schemaObjectKey(row.TABLE_NAME, row.INDEX_NAME)
    const current = actualIndexes.get(key) ?? { columns: [], unique: Number(row.NON_UNIQUE) === 0 }
    current.columns[Number(row.SEQ_IN_INDEX) - 1] = row.COLUMN_NAME
    current.unique = current.unique && Number(row.NON_UNIQUE) === 0
    actualIndexes.set(key, current)
  }
  const invalidIndexes = requiredIndexesOnExistingTables.filter((requirement) => {
    const actual = actualIndexes.get(schemaObjectKey(requirement.tableName, requirement.indexName))
    return !actual
      || actual.unique !== requirement.unique
      || actual.columns.length !== requirement.columns.length
      || requirement.columns.some((column, index) => actual.columns[index] !== column)
  })

  const requiredForeignKeysOnExistingTables = MYSQL_REQUIRED_FOREIGN_KEYS.filter((requirement) => (
    existingTableSet.has(requirement.tableName)
  ))
  const requiredForeignKeyTables = [...new Set(requiredForeignKeysOnExistingTables.map((item) => item.tableName))]
  const foreignKeyRows: MysqlForeignKeyRow[] = requiredForeignKeysOnExistingTables.length > 0
    ? await dataSource.query(
        `SELECT kcu.TABLE_NAME, kcu.CONSTRAINT_NAME, kcu.COLUMN_NAME,
                kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME,
                kcu.ORDINAL_POSITION, rc.DELETE_RULE
         FROM information_schema.KEY_COLUMN_USAGE kcu
         INNER JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
           ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
          AND rc.TABLE_NAME = kcu.TABLE_NAME
          AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
         WHERE kcu.CONSTRAINT_SCHEMA = DATABASE()
           AND kcu.TABLE_NAME IN (${requiredForeignKeyTables.map(() => '?').join(', ')})
           AND kcu.REFERENCED_TABLE_NAME IS NOT NULL`,
        requiredForeignKeyTables,
      )
    : []
  const invalidForeignKeys = collectMysqlForeignKeyIssues(foreignKeyRows, requiredForeignKeysOnExistingTables)
  const triggerRows: MysqlTriggerRow[] = await dataSource.query(
    `SELECT TRIGGER_NAME, EVENT_MANIPULATION, ACTION_TIMING
     FROM information_schema.TRIGGERS
     WHERE TRIGGER_SCHEMA = DATABASE()
       AND TRIGGER_NAME IN (${MYSQL_REQUIRED_TRIGGERS.map(() => '?').join(', ')})`,
    MYSQL_REQUIRED_TRIGGERS.map((item) => item.triggerName),
  )
  const invalidTriggers = collectMysqlTriggerIssues(triggerRows, MYSQL_REQUIRED_TRIGGERS)
  const requiredChecksOnExistingTables = MYSQL_REQUIRED_CHECKS.filter((requirement) => (
    existingTableSet.has(requirement.tableName)
  ))
  const requiredCheckTables = [...new Set(requiredChecksOnExistingTables.map((item) => item.tableName))]
  const checkRows: MysqlCheckRow[] = requiredChecksOnExistingTables.length > 0
    ? await dataSource.query(
        `SELECT TABLE_NAME, CONSTRAINT_NAME
         FROM information_schema.TABLE_CONSTRAINTS
         WHERE CONSTRAINT_SCHEMA = DATABASE()
           AND CONSTRAINT_TYPE = 'CHECK'
           AND TABLE_NAME IN (${requiredCheckTables.map(() => '?').join(', ')})`,
        requiredCheckTables,
      )
    : []
  const existingChecks = new Set(checkRows.map((row) => schemaObjectKey(row.TABLE_NAME, row.CONSTRAINT_NAME)))
  const missingChecks = requiredChecksOnExistingTables.filter((requirement) => (
    !existingChecks.has(schemaObjectKey(requirement.tableName, requirement.constraintName))
  ))

  if (
    missingTables.length === 0
    && missingColumns.length === 0
    && undersizedColumns.length === 0
    && invalidColumnDefinitions.length === 0
    && invalidIndexes.length === 0
    && invalidForeignKeys.length === 0
    && invalidTriggers.length === 0
    && missingChecks.length === 0
  ) {
    return
  }

  // 全新空库与存量库的恢复手段完全不同，必须分开给指引：
  // - 全新空库只能用 DB_SYNC=true 让 TypeORM 按实体建表。backend/sql/ 里的脚本虽已全部改造为
  //   幂等写法（原先 18 个脚本使用的 MariaDB 专有 ADD COLUMN IF NOT EXISTS 已清除），
  //   但该目录始终是按时间累积的增量记录，从未作为完整基线在真实 MySQL 8 空库上端到端验证过，
  //   因此不能建议"从 001 顺序执行到最新编号"；
  // - 存量库只缺个别结构对象时，则要精确指向维护该对象的脚本，绝不能笼统建议“从头重跑”。
  const isFreshDatabase = missingTables.length === MYSQL_REQUIRED_TABLES.length
  const missingObjectGuide = [
    ...missingTables.map((table) => ({
      label: `表 ${table}`,
      script: TABLE_INTRODUCING_SCRIPT[table]
        ?? '（未登记，请检查 mysql-migration-runner.ts 的 TABLE_INTRODUCING_SCRIPT）',
    })),
    ...missingColumns.map((requirement) => ({
      label: `字段 ${requirement.tableName}.${requirement.columnName}`,
      script: requirement.introducingScript,
    })),
    ...undersizedColumns.map((requirement) => ({
      label: `字段 ${requirement.tableName}.${requirement.columnName} 字符容量不足（至少 ${requirement.minCharacterMaximumLength}）`,
      script: requirement.introducingScript,
    })),
    ...invalidColumnDefinitions.map(({ requirement, label }) => ({
      label,
      script: requirement.introducingScript,
    })),
    ...invalidIndexes.map((requirement) => ({
      label: `索引 ${requirement.tableName}.${requirement.indexName}`,
      script: requirement.introducingScript,
    })),
    ...invalidForeignKeys.map(({ requirement, label }) => ({
      label,
      script: requirement.introducingScript,
    })),
    ...invalidTriggers.map(({ requirement, label }) => ({
      label,
      script: requirement.introducingScript,
    })),
    ...missingChecks.map((requirement) => ({
      label: `检查约束 ${requirement.tableName}.${requirement.constraintName}`,
      script: requirement.introducingScript,
    })),
  ]
    .map(({ label, script }) => `  - ${label} → backend/sql/${script}`)
    .join('\n')

  const problemSummary = [
    missingTables.length > 0 ? `缺少必需表：${missingTables.join(', ')}` : null,
    missingColumns.length > 0
      ? `缺少必需字段：${missingColumns.map((item) => `${item.tableName}.${item.columnName}`).join(', ')}`
      : null,
    undersizedColumns.length > 0
      ? `字符容量不足的必需字段：${undersizedColumns.map((item) => `${item.tableName}.${item.columnName}`).join(', ')}`
      : null,
    invalidColumnDefinitions.length > 0
      ? `定义不匹配的必需字段：${[...new Set(invalidColumnDefinitions.map((item) => `${item.requirement.tableName}.${item.requirement.columnName}`))].join(', ')}`
      : null,
    invalidIndexes.length > 0
      ? `缺少或定义不匹配的必需索引：${invalidIndexes.map((item) => `${item.tableName}.${item.indexName}`).join(', ')}`
      : null,
    invalidForeignKeys.length > 0
      ? `缺少或定义不匹配的必需外键：${invalidForeignKeys.map((item) => `${item.requirement.tableName}.${item.requirement.columnName}`).join(', ')}`
      : null,
    invalidTriggers.length > 0
      ? `缺少或定义不匹配的必需触发器：${invalidTriggers.map((item) => item.requirement.triggerName).join(', ')}`
      : null,
    missingChecks.length > 0
      ? `缺少必需检查约束：${missingChecks.map((item) => `${item.tableName}.${item.constraintName}`).join(', ')}`
      : null,
  ].filter((item): item is string => Boolean(item)).join('；')

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
    : '当前数据库已初始化，但缺少上面列出的后续增量结构：\n'
      + '请执行上面“结构对象 → 脚本”列表中列出的目标脚本。这些脚本已全部改造为幂等写法\n'
      + '（information_schema 判断 + PREPARE 动态 DDL / CREATE TABLE IF NOT EXISTS），\n'
      + '即使目标脚本是复合脚本、其中部分列或表已经存在，也只会补建真正缺失的对象，不会因重复报错。\n'
      + '\n'
      + '仍需人工判断、不要随流程执行的脚本：\n'
      + NON_IDEMPOTENT_HISTORICAL_SCRIPTS.map((item) => `  - ${item}`).join('\n')

  throw new Error(
    `[启动失败] MySQL 数据库结构不完整：${problemSummary}。\n`
    + '缺失或不匹配的结构分别由以下迁移脚本维护：\n'
    + `${missingObjectGuide}\n\n`
    + `${scenarioGuide}\n\n`
    + '若上面只涉及 033、037_mobile_auth_session、037_department_account_node_binding、038、039、040、041、042、043、044 或 045 维护的结构，可以设置环境变量 DB_AUTO_MIGRATE=true 后重启服务，'
    + '由服务自动执行白名单内已核实可在启动期运行的脚本。035/036 不会在启动期自动执行：'
    + '036 包含历史通知去重和唯一索引 DDL，必须按“备份 → 停止所有应用与通知 Worker → 执行脚本 → 启动新版本”完成。',
  )
}
