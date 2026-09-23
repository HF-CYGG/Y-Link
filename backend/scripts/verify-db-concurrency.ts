/**
 * 文件说明：backend/scripts/verify-db-concurrency.ts
 * 文件职责：在固定 MySQL 临时库中验证数据库并发场景，重点覆盖订单流水号在 MySQL 行锁下的唯一性、连续性与类型隔离。
 * 实现逻辑：
 * 1. 优先读取 `VERIFY_DB_CONCURRENCY_MYSQL_*` 专用连接参数，缺失时回退到当前 MySQL 连接参数，但始终忽略业务库名。
 * 2. 脚本只会创建并使用固定临时库 `y_link_verify_db_concurrency`，执行前清空、结束后销毁，避免污染正式业务库。
 * 3. 运行时强制切到 MySQL + `DB_SYNC=true`，动态导入服务后在临时库中初始化表结构与默认配置。
 * 4. 并发生成两类订单流水号，校验“无重复、不串号、流水连续、当前值正确推进”，失败时输出清晰阻断提示。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createConnection } from 'mysql2/promise'

const VERIFY_TEMP_DATABASE_NAME = 'y_link_verify_db_concurrency'
const VERIFY_APP_PROFILE = 'verify-db-concurrency'
const CONCURRENCY_SIZE = 12
const VERIFY_RUNTIME_ROOT = path.resolve(
  process.cwd(),
  'data',
  'local-dev',
  `verify-db-concurrency-runtime-${process.pid}-${randomUUID().slice(0, 8)}`,
)

interface VerifyMysqlRuntimeConfig {
  host: string
  port: number
  user: string
  password: string
  sourceLabel: string
}

function pass(message: string) {
  console.log(`✅ ${message}`)
}

function readTextValue(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') {
      continue
    }
    const normalized = value.trim()
    if (normalized) {
      return normalized
    }
  }
  return undefined
}

function readOptionalPortValue(...values: Array<string | undefined>): number | undefined {
  const rawValue = readTextValue(...values)
  if (!rawValue) {
    return undefined
  }

  const parsedPort = Number.parseInt(rawValue, 10)
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    throw new Error(
      [
        'verify:db:concurrency 已阻断：MySQL 端口不合法。',
        '请将 `VERIFY_DB_CONCURRENCY_MYSQL_PORT` 或 `DB_PORT` 设置为 1 到 65535 的整数。',
        `当前读取到的端口值：${rawValue}`,
      ].join('\n'),
    )
  }

  return parsedPort
}

/**
 * 读取本次验收所需的 MySQL 服务连接信息：
 * - 优先使用专用变量，避免误读当前应用进程的数据库配置；
 * - 允许回退到通用 DB_*，方便本地已有 MySQL 调试配置时直接复用；
 * - 无论来源如何，最终都不会复用现有业务库名，而是强制切到固定临时库。
 */
function readVerifyMysqlRuntimeConfig(): VerifyMysqlRuntimeConfig {
  const hostFromVerifyEnv = readTextValue(process.env.VERIFY_DB_CONCURRENCY_MYSQL_HOST)
  const portFromVerifyEnv = readOptionalPortValue(process.env.VERIFY_DB_CONCURRENCY_MYSQL_PORT)
  const userFromVerifyEnv = readTextValue(process.env.VERIFY_DB_CONCURRENCY_MYSQL_USER)
  const passwordFromVerifyEnv = process.env.VERIFY_DB_CONCURRENCY_MYSQL_PASSWORD

  const host = hostFromVerifyEnv ?? readTextValue(process.env.DB_HOST)
  const port = portFromVerifyEnv ?? readOptionalPortValue(process.env.DB_PORT) ?? 3306
  const user = userFromVerifyEnv ?? readTextValue(process.env.DB_USER)
  const password = passwordFromVerifyEnv ?? process.env.DB_PASSWORD ?? ''
  const hasDedicatedVerifyConfig = Boolean(hostFromVerifyEnv || portFromVerifyEnv || userFromVerifyEnv || passwordFromVerifyEnv !== undefined)

  if (!host || !user) {
    throw new Error(
      [
        'verify:db:concurrency 已阻断：缺少 MySQL 临时库验收环境连接信息。',
        `本命令只会连接固定临时库 \`${VERIFY_TEMP_DATABASE_NAME}\`，不会复用当前业务库。`,
        '如果你从项目根目录执行 `npm run verify:db:concurrency`，系统会优先自动准备 Docker MySQL 临时环境。',
        '如果当前机器或 CI 无法使用 Docker，请显式提供 `VERIFY_DB_CONCURRENCY_MYSQL_*`，或设置 `VERIFY_DB_CONCURRENCY_AUTO_PREPARE=off` 后再复用 `DB_*`。',
        '请至少提供以下连接参数：',
        '- `VERIFY_DB_CONCURRENCY_MYSQL_HOST`',
        '- `VERIFY_DB_CONCURRENCY_MYSQL_PORT`',
        '- `VERIFY_DB_CONCURRENCY_MYSQL_USER`',
        '- `VERIFY_DB_CONCURRENCY_MYSQL_PASSWORD`',
        '如果你已经通过 `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` 配好了本地 MySQL，也可以直接复用这些连接参数。',
      ].join('\n'),
    )
  }

  return {
    host,
    port,
    user,
    password,
    sourceLabel: hasDedicatedVerifyConfig ? 'VERIFY_DB_CONCURRENCY_MYSQL_*' : 'DB_*',
  }
}

function escapeMySqlIdentifier(identifier: string): string {
  return `\`${identifier.replaceAll('`', '``')}\``
}

function configureRuntimeEnv(config: VerifyMysqlRuntimeConfig) {
  process.env.APP_PROFILE = VERIFY_APP_PROFILE
  process.env.DB_TYPE = 'mysql'
  process.env.DB_HOST = config.host
  process.env.DB_PORT = String(config.port)
  process.env.DB_USER = config.user
  process.env.DB_PASSWORD = config.password
  process.env.DB_NAME = VERIFY_TEMP_DATABASE_NAME
  process.env.DB_SYNC = 'true'
  process.env.DB_AUTO_MIGRATE = 'true'
  process.env.Y_LINK_DATA_DIR = VERIFY_RUNTIME_ROOT
}

function parseSerial(showNo: string, prefix: string): number {
  return Number.parseInt(showNo.slice(prefix.length), 10)
}

function expectContinuousSequence(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right)
  const start = sorted[0] ?? 0
  sorted.forEach((value, index) => {
    assert.equal(value, start + index)
  })
}

async function recreateVerifyDatabase(config: VerifyMysqlRuntimeConfig) {
  const adminConnection = await createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    multipleStatements: false,
  })

  try {
    const escapedDatabaseName = escapeMySqlIdentifier(VERIFY_TEMP_DATABASE_NAME)
    await adminConnection.query(`DROP DATABASE IF EXISTS ${escapedDatabaseName}`)
    await adminConnection.query(
      `CREATE DATABASE ${escapedDatabaseName} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    )
  } catch (error) {
    throw new Error(
      [
        `verify:db:concurrency 已阻断：无法创建固定 MySQL 临时库 \`${VERIFY_TEMP_DATABASE_NAME}\`。`,
        '请确认当前连接账号具备 CREATE/DROP DATABASE 权限，且连接目标是可用于本地验收的 MySQL 服务。',
        `原始错误：${error instanceof Error ? error.message : String(error)}`,
      ].join('\n'),
    )
  } finally {
    await adminConnection.end()
  }
}

async function dropVerifyDatabase(config: VerifyMysqlRuntimeConfig) {
  const adminConnection = await createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    multipleStatements: false,
  })

  try {
    const escapedDatabaseName = escapeMySqlIdentifier(VERIFY_TEMP_DATABASE_NAME)
    await adminConnection.query(`DROP DATABASE IF EXISTS ${escapedDatabaseName}`)
  } finally {
    await adminConnection.end()
  }
}

async function verifyOrderSerialConcurrency(mysqlConfig: VerifyMysqlRuntimeConfig) {
  const [
    { AppDataSource },
    { initializeDatabaseInfrastructure },
    { systemConfigService },
    { orderSerialService },
    { o2oPreorderService },
    { productService },
    { ClientUser },
    { ClientStaffDirectory },
    { SysAuditLog },
    { SysUser },
    { O2oPreorder },
    { O2oPreorderItem },
    { O2oReturnRequest },
    { O2oReturnRequestItem },
    { BizOutboundOrder },
    { BizOutboundOrderItem },
    { InventoryLog },
    { NotificationEvent },
    { NotificationDispatch },
    { NotificationInbox },
    { OrderRevision },
    { clientUserManageService },
    { orderService },
    { initializeDatabaseSchemaIfNeeded, migrateClientUserDepartmentGovernance },
    { assertMysqlRequiredSchemaExists, runMysqlSchemaMigrations },
    { env },
    { appDataPaths },
    { parseAndVerifyOrderBusinessNoRetirementBundle },
  ] = await Promise.all([
    import('../src/config/data-source.js'),
    import('../src/database/database-strategy.js'),
    import('../src/services/system-config.service.js'),
    import('../src/services/order-serial.service.js'),
    import('../src/services/o2o-preorder.service.js'),
    import('../src/services/product.service.js'),
    import('../src/entities/client-user.entity.js'),
    import('../src/entities/client-staff-directory.entity.js'),
    import('../src/entities/sys-audit-log.entity.js'),
    import('../src/entities/sys-user.entity.js'),
    import('../src/entities/o2o-preorder.entity.js'),
    import('../src/entities/o2o-preorder-item.entity.js'),
    import('../src/entities/o2o-return-request.entity.js'),
    import('../src/entities/o2o-return-request-item.entity.js'),
    import('../src/entities/biz-outbound-order.entity.js'),
    import('../src/entities/biz-outbound-order-item.entity.js'),
    import('../src/entities/inventory-log.entity.js'),
    import('../src/entities/notification-event.entity.js'),
    import('../src/entities/notification-dispatch.entity.js'),
    import('../src/entities/notification-inbox.entity.js'),
    import('../src/entities/order-revision.entity.js'),
    import('../src/services/client-user-manage.service.js'),
    import('../src/services/order.service.js'),
    import('../src/config/database-bootstrap.js'),
    import('../src/config/mysql-migration-runner.js'),
    import('../src/config/env.js'),
    import('../src/config/app-data-paths.js'),
    import('../src/config/order-business-no-retirement-backup.js'),
  ])

  const createLegacyBusinessNoTables = async (serial: number | string) => {
    const serialText = String(serial)
    const businessNo = `hyyzjd${serialText.padStart(6, '0')}`
    const uuidSuffix = serialText.slice(-12).padStart(12, '0')
    const fromOrderUuid = `00000000-0000-4000-8000-${uuidSuffix}`
    const toOrderUuid = `10000000-0000-4000-8000-${uuidSuffix}`
    await AppDataSource.query(`
      CREATE TABLE order_business_no_occupancy (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        business_namespace VARCHAR(16) NOT NULL,
        serial_value BIGINT UNSIGNED NOT NULL,
        business_no VARCHAR(32) NOT NULL,
        order_uuid CHAR(36) NOT NULL,
        assigned_reason VARCHAR(128) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        last_assigned_order_uuid CHAR(36) NOT NULL,
        last_assigned_at DATETIME(6) NOT NULL,
        reuse_count INT NOT NULL DEFAULT 0,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    await AppDataSource.query(`
      CREATE TABLE order_business_no_reuse_event (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        business_namespace VARCHAR(16) NOT NULL,
        serial_value BIGINT UNSIGNED NOT NULL,
        business_no VARCHAR(32) NOT NULL,
        from_order_uuid CHAR(36) NOT NULL,
        to_order_uuid CHAR(36) NOT NULL,
        target_order_id_snapshot VARCHAR(64) NOT NULL,
        target_show_no_snapshot VARCHAR(64) NOT NULL,
        reuse_count INT NOT NULL,
        reason VARCHAR(500) NOT NULL,
        actor_user_id VARCHAR(64) NULL,
        actor_username VARCHAR(64) NOT NULL,
        actor_display_name VARCHAR(64) NOT NULL,
        ip_address VARCHAR(64) NULL,
        user_agent VARCHAR(255) NULL,
        decimal_snapshot DECIMAL(30,6) NULL,
        binary_snapshot VARBINARY(8) NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    await AppDataSource.query(
      `INSERT INTO order_business_no_occupancy
        (business_namespace, serial_value, business_no, order_uuid, assigned_reason, created_at,
         last_assigned_order_uuid, last_assigned_at, reuse_count)
       VALUES ('hyyzjd', ?, ?, ?, '历史首次分配', '2026-09-21 01:02:03.123456', ?,
               '2026-09-22 04:05:06.654321', 2)`,
      [serial, businessNo, fromOrderUuid, toOrderUuid],
    )
    await AppDataSource.query(
      `INSERT INTO order_business_no_reuse_event
        (business_namespace, serial_value, business_no, from_order_uuid, to_order_uuid,
         target_order_id_snapshot, target_show_no_snapshot, reuse_count, reason, actor_user_id,
         actor_username, actor_display_name, ip_address, user_agent, decimal_snapshot, binary_snapshot, created_at)
       VALUES ('hyyzjd', ?, ?, ?, ?, '29', 'OUT-D-000029', 2, '历史回收原因', '1',
               'admin', '系统管理员', '127.0.0.1', 'verify-agent',
               '12345678901234567890.123456', UNHEX('0001FF'), '2026-09-22 04:05:06.654321')`,
      [serial, businessNo, fromOrderUuid, toOrderUuid],
    )
    await AppDataSource.query("CREATE TRIGGER trg_order_business_no_reuse_event_no_update BEFORE UPDATE ON order_business_no_reuse_event FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'VERIFY_APPEND_ONLY'")
    await AppDataSource.query("CREATE TRIGGER trg_order_business_no_reuse_event_no_delete BEFORE DELETE ON order_business_no_reuse_event FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'VERIFY_APPEND_ONLY'")
    return { businessNo, fromOrderUuid, toOrderUuid }
  }

  await AppDataSource.initialize()
  try {
    await initializeDatabaseInfrastructure(AppDataSource)
    await AppDataSource.synchronize()
    await systemConfigService.ensureDefaultConfigs()
    pass('固定 MySQL 临时库已完成建表与默认配置初始化')

    await AppDataSource.query('ALTER TABLE client_user DROP INDEX uk_client_user_department_node_id')
    await AppDataSource.query('ALTER TABLE client_user DROP COLUMN department_node_id')
    await AppDataSource.query('ALTER TABLE o2o_preorder DROP COLUMN department_name_snapshot')
    await AppDataSource.query('ALTER TABLE o2o_preorder DROP COLUMN client_order_type')
    await AppDataSource.query(
      "ALTER TABLE client_feedback_conversation MODIFY COLUMN department_name_snapshot VARCHAR(128) NOT NULL DEFAULT ''",
    )
    await AppDataSource.query(
      'ALTER TABLE biz_outbound_order MODIFY COLUMN customer_department_name VARCHAR(128) NULL',
    )
    const migrationResult = await runMysqlSchemaMigrations(AppDataSource)
    assert.ok(
      migrationResult.appliedFiles.includes('037_department_account_node_binding.sql'),
      '真实 MySQL 临时库应执行 037 补回部门节点字段与唯一索引',
    )
    assert.ok(
      migrationResult.appliedFiles.includes('038_department_path_capacity.sql'),
      '真实 MySQL 临时库应执行 038 扩展部门路径快照容量',
    )
    await assertMysqlRequiredSchemaExists(AppDataSource)
    const freshDatabaseBackupNames = fs.readdirSync(appDataPaths.migrationBackupDir)
      .filter((name) => name.endsWith('.json'))
    assert.equal(freshDatabaseBackupNames.length, 1, 'fresh DB 经 042 建空旧表后也必须先备份 schema 再清退')
    const freshDatabaseBundle = parseAndVerifyOrderBusinessNoRetirementBundle(
      fs.readFileSync(path.join(appDataPaths.migrationBackupDir, freshDatabaseBackupNames[0]!), 'utf8'),
    )
    assert.deepEqual(freshDatabaseBundle.tables.map((table) => ({
      name: table.name,
      rowCount: table.rowCount,
    })), [{ name: 'order_business_no_occupancy', rowCount: 0 }])
    await AppDataSource.query(
      'DELETE FROM schema_migrations WHERE CAST(LEFT(filename, 3) AS UNSIGNED) > 42',
    )
    const firstLegacySnapshot = await createLegacyBusinessNoTables('9007199254740995')
    const mutableEnv = env as unknown as { DB_SYNC: boolean }
    mutableEnv.DB_SYNC = true
    const syncStartup = await initializeDatabaseSchemaIfNeeded(AppDataSource)
    assert.equal(syncStartup.reason, 'forced_by_db_sync')
    const obsoleteTableRowsAfterSync = await AppDataSource.query(`
      SELECT TABLE_NAME
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN ('order_business_no_occupancy', 'order_business_no_reuse_event')
    `) as Array<{ TABLE_NAME: string }>
    assert.deepEqual(obsoleteTableRowsAfterSync, [], 'DB_SYNC=true 启动必须幂等清退已停用业务号表')
    const firstRetirementBackupNames = fs.readdirSync(appDataPaths.migrationBackupDir)
      .filter((name) => name.endsWith('.json'))
    assert.equal(firstRetirementBackupNames.length, 2, 'DB_SYNC=true 定向清退必须新增一个 MySQL bundle')
    const firstRetirementBackupName = firstRetirementBackupNames.find(
      (name) => !freshDatabaseBackupNames.includes(name),
    )
    assert.ok(firstRetirementBackupName)
    const firstRetirementBundle = parseAndVerifyOrderBusinessNoRetirementBundle(
      fs.readFileSync(path.join(appDataPaths.migrationBackupDir, firstRetirementBackupName), 'utf8'),
    )
    assert.equal(firstRetirementBundle.dialect, 'mysql')
    assert.deepEqual(firstRetirementBundle.tables.map((table) => ({
      name: table.name,
      rowCount: table.rowCount,
    })), [
      { name: 'order_business_no_occupancy', rowCount: 1 },
      { name: 'order_business_no_reuse_event', rowCount: 1 },
    ])
    assert.match(firstRetirementBundle.tables[0]?.createSql ?? '', /^CREATE TABLE `order_business_no_occupancy`/i)
    const firstRetirementRaw = JSON.stringify(firstRetirementBundle)
    assert.equal(firstRetirementRaw.includes(firstLegacySnapshot.businessNo), true)
    assert.equal(firstRetirementRaw.includes(firstLegacySnapshot.fromOrderUuid), true)
    assert.equal(firstRetirementRaw.includes(firstLegacySnapshot.toOrderUuid), true)
    const firstOccupancyRow = firstRetirementBundle.tables
      .find((table) => table.name === 'order_business_no_occupancy')?.rows[0]
    const firstReuseRow = firstRetirementBundle.tables
      .find((table) => table.name === 'order_business_no_reuse_event')?.rows[0]
    assert.equal(firstOccupancyRow?.serial_value, '9007199254740995', 'BIGINT 必须按十进制字符串无损备份')
    assert.equal(firstOccupancyRow?.created_at, '2026-09-21 01:02:03.123456', 'DATETIME(6) 必须保留微秒')
    assert.equal(firstOccupancyRow?.last_assigned_at, '2026-09-22 04:05:06.654321', 'DATETIME(6) 必须保留微秒')
    assert.equal(firstReuseRow?.created_at, '2026-09-22 04:05:06.654321', '复用事件时间必须保留微秒')
    assert.equal(firstReuseRow?.decimal_snapshot, '12345678901234567890.123456', 'DECIMAL 必须按十进制字符串无损备份')
    assert.deepEqual(firstReuseRow?.binary_snapshot, {
      $ylinkType: 'buffer',
      encoding: 'base64',
      value: 'AAH/',
    }, 'VARBINARY 必须按 typed base64 无损备份')
    mutableEnv.DB_SYNC = false
    const externalStartup = await initializeDatabaseSchemaIfNeeded(AppDataSource)
    assert.equal(externalStartup.reason, 'mysql_external')
    assert.equal(externalStartup.action, 'synchronized', 'DB_SYNC=false 必须继续执行 043~055 的待处理迁移')
    const retirementTrackingRows = await AppDataSource.query(
      `SELECT filename, checksum
       FROM schema_migrations
       WHERE filename IN (
         '054_order_business_no_reuse.sql',
         '055_order_identifier_namespaces.sql',
         '056_disable_order_business_no_permanent_occupancy.sql'
       )
       ORDER BY filename`,
    ) as Array<{ filename: string; checksum: string }>
    const migrationChecksum = (filename: string) => createHash('sha256')
      .update(fs.readFileSync(new URL(`../sql/${filename}`, import.meta.url), 'utf8'))
      .digest('hex')
    assert.deepEqual(
      retirementTrackingRows,
      [
        {
          filename: '055_order_identifier_namespaces.sql',
          checksum: migrationChecksum('055_order_identifier_namespaces.sql'),
        },
        {
          filename: '056_disable_order_business_no_permanent_occupancy.sql',
          checksum: migrationChecksum('056_disable_order_business_no_permanent_occupancy.sql'),
        },
      ],
      '056 必须以真实 checksum 记录并显式 supersede 054，同时不得跳过 055',
    )
    const obsoleteTableRowsAfterExternal = await AppDataSource.query(`
      SELECT TABLE_NAME
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN ('order_business_no_occupancy', 'order_business_no_reuse_event')
    `) as Array<{ TABLE_NAME: string }>
    assert.deepEqual(obsoleteTableRowsAfterExternal, [], 'DB_SYNC=false 重启不得重新出现已停用业务号表')
    assert.equal(
      fs.readdirSync(appDataPaths.migrationBackupDir).filter((name) => name.endsWith('.json')).length,
      2,
      '表已完全清退时 DB_SYNC=false 重启不得生成空备份',
    )

    // 常规 auto-migrate 必须在 pending loop 的 054 边界执行 retirement preflight，不能先重放 054。
    await AppDataSource.query(
      `DELETE FROM schema_migrations
       WHERE filename IN (
         '054_order_business_no_reuse.sql',
         '055_order_identifier_namespaces.sql',
         '056_disable_order_business_no_permanent_occupancy.sql'
       )`,
    )
    const secondLegacySnapshot = await createLegacyBusinessNoTables('9007199254740997')
    const directAutoMigration = await runMysqlSchemaMigrations(AppDataSource)
    assert.equal(directAutoMigration.appliedFiles.includes('056_disable_order_business_no_permanent_occupancy.sql'), true)
    assert.equal(directAutoMigration.appliedFiles.includes('055_order_identifier_namespaces.sql'), true)
    assert.equal(directAutoMigration.appliedFiles.includes('054_order_business_no_reuse.sql'), false)
    const directBackupNames = fs.readdirSync(appDataPaths.migrationBackupDir).filter((name) => name.endsWith('.json'))
    assert.equal(directBackupNames.length, 3, '常规 auto-migrate retirement preflight 必须新增一次当前内容备份')
    const secondBundleName = directBackupNames.find((name) => !firstRetirementBackupNames.includes(name))
    assert.ok(secondBundleName)
    const secondBundle = parseAndVerifyOrderBusinessNoRetirementBundle(
      fs.readFileSync(path.join(appDataPaths.migrationBackupDir, secondBundleName), 'utf8'),
    )
    assert.equal(JSON.stringify(secondBundle).includes(secondLegacySnapshot.businessNo), true)

    const assertMysqlRetirementFailureState = async (
      label: string,
      backupDir: string,
      expectedResidualFinalFiles = 0,
    ) => {
      const retainedTables = await AppDataSource.query(`
        SELECT TABLE_NAME
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME IN ('order_business_no_occupancy', 'order_business_no_reuse_event')
        ORDER BY TABLE_NAME
      `) as Array<{ TABLE_NAME: string }>
      assert.deepEqual(retainedTables.map((row) => row.TABLE_NAME), [
        'order_business_no_occupancy',
        'order_business_no_reuse_event',
      ], `${label}不得删除旧表`)
      const retainedTriggers = await AppDataSource.query(`
        SELECT TRIGGER_NAME
        FROM information_schema.TRIGGERS
        WHERE TRIGGER_SCHEMA = DATABASE()
          AND TRIGGER_NAME IN (
            'trg_order_business_no_reuse_event_no_update',
            'trg_order_business_no_reuse_event_no_delete'
          )
      `) as Array<{ TRIGGER_NAME: string }>
      assert.equal(retainedTriggers.length, 2, `${label}不得删除旧触发器`)
      const trackingRows = await AppDataSource.query(
        `SELECT COUNT(1) AS total FROM schema_migrations
         WHERE filename = '056_disable_order_business_no_permanent_occupancy.sql'`,
      ) as Array<{ total: number | string }>
      assert.equal(Number(trackingRows[0]?.total), 0, `${label}不得写入 056 tracking`)
      const residualFinalFiles = fs.existsSync(backupDir)
        ? fs.readdirSync(backupDir).filter((name) => name.endsWith('.json'))
        : []
      assert.equal(
        residualFinalFiles.length,
        expectedResidualFinalFiles,
        expectedResidualFinalFiles === 0
          ? `${label}不得留下正式备份文件`
          : `${label}必须把无法清理/隔离的正式文件作为人工处置对象保留`,
      )
    }

    const cleanupLegacyBusinessNoTables = async () => {
      await AppDataSource.query('DROP TRIGGER IF EXISTS trg_order_business_no_reuse_event_no_update')
      await AppDataSource.query('DROP TRIGGER IF EXISTS trg_order_business_no_reuse_event_no_delete')
      await AppDataSource.query('DROP TABLE IF EXISTS order_business_no_reuse_event')
      await AppDataSource.query('DROP TABLE IF EXISTS order_business_no_occupancy')
    }

    const publicationFailures = [
      {
        label: 'hard link 发布后 chmod 失败',
        serial: '9007199254741001',
        createFileSystem: (_backupDir: string) => ({
          ...fsPromises,
          chmod: async (target: Parameters<typeof fsPromises.chmod>[0], mode: number) => {
            if (String(target).endsWith('.json')) {
              const error = new Error('injected chmod failure') as NodeJS.ErrnoException
              error.code = 'EIO'
              throw error
            }
            await fsPromises.chmod(target, mode)
          },
        }),
      },
      {
        label: 'hard link 发布后 finalPath 回读损坏',
        serial: '9007199254741003',
        createFileSystem: (_backupDir: string) => {
          let readCount = 0
          return {
            ...fsPromises,
            readFile: (async (...args: Parameters<typeof fsPromises.readFile>) => {
              readCount += 1
              if (readCount === 2) return '{}'
              return fsPromises.readFile(...args)
            }) as typeof fsPromises.readFile,
          }
        },
      },
      {
        label: 'hard link 发布后目录 fsync 失败',
        serial: '9007199254741005',
        createFileSystem: (backupDir: string) => ({
          ...fsPromises,
          open: (async (
            target: Parameters<typeof fsPromises.open>[0],
            flags: Parameters<typeof fsPromises.open>[1],
            mode?: number,
          ) => {
            if (path.resolve(String(target)) === path.resolve(backupDir) && flags === 'r') {
              return {
                sync: async () => {
                  const error = new Error('injected directory fsync failure') as NodeJS.ErrnoException
                  error.code = 'EIO'
                  throw error
                },
                close: async () => undefined,
              } as Awaited<ReturnType<typeof fsPromises.open>>
            }
            return fsPromises.open(target, flags, mode)
          }) as typeof fsPromises.open,
        }),
      },
      {
        label: 'hard link 发布后失败且 rm/quarantine 双失败',
        serial: '9007199254741007',
        expectsManualCleanup: true,
        createFileSystem: (_backupDir: string) => ({
          ...fsPromises,
          chmod: async (target: Parameters<typeof fsPromises.chmod>[0], mode: number) => {
            if (String(target).endsWith('.json')) {
              const error = new Error('injected chmod failure') as NodeJS.ErrnoException
              error.code = 'EIO'
              throw error
            }
            await fsPromises.chmod(target, mode)
          },
          rm: async (target: Parameters<typeof fsPromises.rm>[0], options?: Parameters<typeof fsPromises.rm>[1]) => {
            if (String(target).endsWith('.json')) {
              const error = new Error('injected final rm failure') as NodeJS.ErrnoException
              error.code = 'EBUSY'
              throw error
            }
            await fsPromises.rm(target, options)
          },
          rename: async (
            oldPath: Parameters<typeof fsPromises.rename>[0],
            newPath: Parameters<typeof fsPromises.rename>[1],
          ) => {
            if (String(oldPath).endsWith('.json')) {
              const error = new Error('injected quarantine rename failure') as NodeJS.ErrnoException
              error.code = 'EACCES'
              throw error
            }
            await fsPromises.rename(oldPath, newPath)
          },
        }),
      },
    ]

    for (const failure of publicationFailures) {
      await AppDataSource.query(
        `DELETE FROM schema_migrations
         WHERE filename IN ('054_order_business_no_reuse.sql', '056_disable_order_business_no_permanent_occupancy.sql')`,
      )
      await createLegacyBusinessNoTables(failure.serial)
      const failureBackupDir = path.join(VERIFY_RUNTIME_ROOT, `publication-failure-${failure.serial}`)
      await assert.rejects(
        () => runMysqlSchemaMigrations(AppDataSource, {
          retirementBackup: {
            backupDir: failureBackupDir,
            fileSystem: failure.createFileSystem(failureBackupDir),
          },
        }),
        (error: unknown) => {
          const message = String(error)
          if (failure.expectsManualCleanup) {
            assert.match(message, /YLINK_RETIREMENT_BACKUP_CLEANUP_REQUIRED/)
            assert.match(message, /removeCode=EBUSY/)
            assert.match(message, /quarantineCode=EACCES/)
            assert.equal(message.includes(failureBackupDir), false, '人工处置错误不得泄露备份绝对路径')
          }
          return true
        },
      )
      await assertMysqlRetirementFailureState(
        failure.label,
        failureBackupDir,
        failure.expectsManualCleanup ? 1 : 0,
      )
      await cleanupLegacyBusinessNoTables()
      fs.rmSync(failureBackupDir, { recursive: true, force: true })
    }

    // 备份目录故障必须在任何 DROP 和 056 tracking 之前阻断。
    await AppDataSource.query(
      `DELETE FROM schema_migrations
       WHERE filename IN ('054_order_business_no_reuse.sql', '056_disable_order_business_no_permanent_occupancy.sql')`,
    )
    await createLegacyBusinessNoTables('9007199254740999')
    const preservedBackupDir = `${appDataPaths.migrationBackupDir}.preserved`
    fs.renameSync(appDataPaths.migrationBackupDir, preservedBackupDir)
    fs.writeFileSync(appDataPaths.migrationBackupDir, 'blocked', 'utf8')
    await assert.rejects(() => runMysqlSchemaMigrations(AppDataSource))
    const retainedOnBackupFailure = await AppDataSource.query(`
      SELECT TABLE_NAME
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN ('order_business_no_occupancy', 'order_business_no_reuse_event')
      ORDER BY TABLE_NAME
    `) as Array<{ TABLE_NAME: string }>
    assert.deepEqual(retainedOnBackupFailure.map((row) => row.TABLE_NAME), [
      'order_business_no_occupancy',
      'order_business_no_reuse_event',
    ])
    const trackingAfterBackupFailure = await AppDataSource.query(
      `SELECT COUNT(1) AS total FROM schema_migrations
       WHERE filename = '056_disable_order_business_no_permanent_occupancy.sql'`,
    ) as Array<{ total: number | string }>
    assert.equal(Number(trackingAfterBackupFailure[0]?.total), 0, '备份失败不得写入 056 tracking')
    fs.rmSync(appDataPaths.migrationBackupDir, { force: true })
    fs.renameSync(preservedBackupDir, appDataPaths.migrationBackupDir)
    const retryAfterBackupFailure = await runMysqlSchemaMigrations(AppDataSource)
    assert.equal(retryAfterBackupFailure.appliedFiles.includes('056_disable_order_business_no_permanent_occupancy.sql'), true)
    mutableEnv.DB_SYNC = true
    pass('真实 MySQL 两条 056 路径均先备份，故障时保留旧表，且 preflight 跳过 054 并保留 055/056 tracking')
    const restoredDepartmentNodeIndexes = await AppDataSource.query(
      `SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'client_user'
         AND INDEX_NAME = 'uk_client_user_department_node_id'`,
    ) as Array<{ INDEX_NAME: string; COLUMN_NAME: string; NON_UNIQUE: number }>
    assert.deepEqual(
      restoredDepartmentNodeIndexes.map((index) => ({
        ...index,
        NON_UNIQUE: Number(index.NON_UNIQUE),
      })),
      [{
        INDEX_NAME: 'uk_client_user_department_node_id',
        COLUMN_NAME: 'department_node_id',
        NON_UNIQUE: 0,
      }],
    )
    const departmentPathCapacityRows = await AppDataSource.query(
      `SELECT TABLE_NAME, COLUMN_NAME, CHARACTER_MAXIMUM_LENGTH
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND (
           (TABLE_NAME = 'o2o_preorder' AND COLUMN_NAME = 'department_name_snapshot')
           OR (TABLE_NAME = 'client_feedback_conversation' AND COLUMN_NAME = 'department_name_snapshot')
           OR (TABLE_NAME = 'biz_outbound_order' AND COLUMN_NAME = 'customer_department_name')
         )`,
    ) as Array<{ TABLE_NAME: string; COLUMN_NAME: string; CHARACTER_MAXIMUM_LENGTH: number | string }>
    assert.equal(departmentPathCapacityRows.length, 3)
    assert.equal(
      departmentPathCapacityRows.every((column) => Number(column.CHARACTER_MAXIMUM_LENGTH) >= 271),
      true,
      '038 必须把部门路径的三个下游快照列统一扩展至至少 271 字符',
    )
    // 上面的 DB_SYNC=true 启动会按实体补回该列；这里恢复原有 038 重放夹具的“先缺列、再人工补齐”前置状态。
    await AppDataSource.query('ALTER TABLE o2o_preorder DROP COLUMN client_order_type')
    await AppDataSource.query(
      "ALTER TABLE o2o_preorder ADD COLUMN client_order_type VARCHAR(16) NOT NULL DEFAULT 'walkin'",
    )
    await AppDataSource.query(
      "DELETE FROM schema_migrations WHERE filename = '038_department_path_capacity.sql'",
    )
    const replayedPathCapacityMigration = await runMysqlSchemaMigrations(AppDataSource)
    assert.deepEqual(
      replayedPathCapacityMigration.appliedFiles,
      ['038_department_path_capacity.sql'],
      '038 安全重放时应仅重新记录该幂等迁移',
    )
    await assertMysqlRequiredSchemaExists(AppDataSource)
    pass('真实 MySQL 临时库已执行 037/038，恢复部门节点唯一约束与路径快照容量')

    const persistedAdmin = await AppDataSource.getRepository(SysUser).save(AppDataSource.getRepository(SysUser).create({
      username: `verify-admin-${Date.now()}`,
      passwordHash: 'verify-only',
      displayName: '并发验收管理员',
      email: null,
      role: 'admin',
      status: 'enabled',
      lastLoginAt: null,
    }))
    const concurrencyActor = {
      userId: String(persistedAdmin.id),
      username: persistedAdmin.username,
      displayName: persistedAdmin.displayName,
      role: 'admin',
      permissions: ['system_configs:update'],
      status: 'enabled',
      sessionToken: 'verify-db-concurrency-admin',
      authSource: 'bearer',
    } as const
    await systemConfigService.updateClientDepartmentConfigs({
      tree: [
        { id: 'dept_mysql_batch', label: 'MySQL 批量并发部门', children: [] },
        { id: 'dept_mysql_single', label: 'MySQL 单个并发部门', children: [] },
        { id: 'dept_mysql_cross', label: 'MySQL 跨入口并发部门', children: [] },
        { id: 'dept_mysql_bound', label: 'MySQL 已绑定部门', children: [] },
      ],
    }, concurrencyActor)
    const departmentPassword = `Department_${Date.now()}_Aa1!`
    const [firstBatch, secondBatch] = await Promise.all([
      clientUserManageService.createDepartmentAccountsBatch({
        status: 'enabled',
        items: [{ departmentNodeId: 'dept_mysql_batch', account: 'DEPT-0B0C0D0E0F', initialPassword: departmentPassword }],
      }, concurrencyActor),
      clientUserManageService.createDepartmentAccountsBatch({
        status: 'enabled',
        items: [{ departmentNodeId: 'dept_mysql_batch', account: 'DEPT-1B1C1D1E1F', initialPassword: departmentPassword }],
      }, concurrencyActor),
    ])
    assert.equal(firstBatch.created.length + secondBatch.created.length, 1, '同部门并发批量开户最多只能创建一个账号')
    assert.equal(firstBatch.skipped.length + secondBatch.skipped.length, 1, '同部门并发批量开户的另一请求必须受控跳过')

    const singleCreateResults = await Promise.allSettled([
      clientUserManageService.createProfile({
        profileKind: 'department',
        username: 'MySQL 单个并发账号甲',
        departmentNodeId: 'dept_mysql_single',
        password: departmentPassword,
        status: 'enabled',
      }, concurrencyActor),
      clientUserManageService.createProfile({
        profileKind: 'department',
        username: 'MySQL 单个并发账号乙',
        departmentNodeId: 'dept_mysql_single',
        password: departmentPassword,
        status: 'enabled',
      }, concurrencyActor),
    ])
    assert.equal(singleCreateResults.filter((result) => result.status === 'fulfilled').length, 1, '同部门并发单个开户最多只能创建一个账号')
    const singleCreateConflict = singleCreateResults.find((result) => result.status === 'rejected')
    assert.ok(singleCreateConflict && singleCreateConflict.status === 'rejected', '同部门并发单个开户应有一个受控冲突')
    assert.equal((singleCreateConflict.reason as { statusCode?: number }).statusCode, 409, '并发单个开户冲突必须映射为 409')

    const concurrentDepartmentUsers = await AppDataSource.getRepository(ClientUser)
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.departmentNodeId IN (:...departmentNodeIds)', {
        departmentNodeIds: ['dept_mysql_batch', 'dept_mysql_single'],
      })
      .getMany()
    assert.equal(concurrentDepartmentUsers.length, 2, '批量与单个竞争场景各只能保留一个部门账号')
    assert.equal(concurrentDepartmentUsers.every((user) => user.passwordHash !== departmentPassword), true, '数据库不得保存部门初始密码明文')
    const concurrentCreateAudits = await AppDataSource.getRepository(SysAuditLog).find({
      where: { actionType: 'client_user.create', targetType: 'client_user' },
    })
    const concurrentUserIds = new Set(concurrentDepartmentUsers.map((user) => user.id))
    const concurrentUserCreateAudits = concurrentCreateAudits.filter((audit) => concurrentUserIds.has(audit.targetId ?? ''))
    assert.equal(concurrentUserCreateAudits.length, 2, '每个真实创建的账号只能有一条创建审计')
    assert.equal(new Set(concurrentUserCreateAudits.map((audit) => audit.targetId)).size, 2, '并发失败或跳过不得制造重复创建审计')
    assert.equal(concurrentUserCreateAudits.every((audit) => !audit.detailJson?.includes(departmentPassword)), true, '部门初始密码不得写入审计详情')
    pass('真实 MySQL Promise.all 竞争下部门账号唯一、冲突受控且审计不重复不含明文')

    const crossEntryResults = await Promise.allSettled([
      clientUserManageService.createDepartmentAccountsBatch({
        status: 'enabled',
        items: [{ departmentNodeId: 'dept_mysql_cross', account: 'DEPT-2B2C2D2E2F', initialPassword: departmentPassword }],
      }, concurrencyActor),
      clientUserManageService.createProfile({
        profileKind: 'department',
        username: 'MySQL 跨入口单建账号',
        departmentNodeId: 'dept_mysql_cross',
        password: departmentPassword,
        status: 'enabled',
      }, concurrencyActor),
    ])
    const crossEntryUsers = await AppDataSource.getRepository(ClientUser)
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.departmentNodeId = :departmentNodeId', { departmentNodeId: 'dept_mysql_cross' })
      .getMany()
    assert.equal(crossEntryUsers.length, 1, '批量与单建抢占同一部门时只能创建一个账号')
    assert.notEqual(crossEntryUsers[0]!.passwordHash, departmentPassword, '跨入口并发创建不得保存初始密码明文')
    const batchCrossResult = crossEntryResults[0]
    const singleCrossResult = crossEntryResults[1]
    assert.equal(batchCrossResult.status, 'fulfilled', '跨入口竞争中的批量请求应受控创建或跳过')
    if (batchCrossResult.status === 'fulfilled' && batchCrossResult.value.created.length === 1) {
      assert.equal(singleCrossResult.status, 'rejected', '批量请求先创建时单建请求必须受控冲突')
      assert.equal((singleCrossResult as PromiseRejectedResult).reason.statusCode, 409)
    } else {
      assert.equal(batchCrossResult.status === 'fulfilled' ? batchCrossResult.value.skipped.length : 0, 1)
      assert.equal(singleCrossResult.status, 'fulfilled', '单建请求先创建时批量请求必须受控跳过')
    }
    const crossEntryAudits = await AppDataSource.getRepository(SysAuditLog).find({
      where: { actionType: 'client_user.create', targetType: 'client_user', targetId: crossEntryUsers[0]!.id },
    })
    assert.equal(crossEntryAudits.length, 1, '跨入口竞争最终账号只能产生一条创建审计')
    assert.equal(crossEntryAudits.every((audit) => !audit.detailJson?.includes(departmentPassword)), true)
    pass('真实 MySQL 批量与单建跨入口竞争同一节点时唯一约束、跳过或 409 与审计均正确')

    const legacyDepartmentUser = await AppDataSource.getRepository(ClientUser).save(
      AppDataSource.getRepository(ClientUser).create({
        realName: 'MySQL 存量旧部门账号',
        mobile: '13800009991',
        email: null,
        passwordHash: 'verify-only',
        departmentName: 'MySQL 教职工部门',
        departmentNodeId: null,
        accountType: 'department',
        staffNo: 'MYSQL-LEGACY-0001',
        staffVerified: true,
        status: 'enabled',
        lastLoginAt: null,
      }),
    )
    const boundDepartmentUser = await AppDataSource.getRepository(ClientUser).save(
      AppDataSource.getRepository(ClientUser).create({
        realName: 'MySQL 已绑定部门账号',
        mobile: '13800009992',
        email: null,
        passwordHash: 'verify-only',
        departmentName: 'MySQL 已绑定部门',
        departmentNodeId: 'dept_mysql_bound',
        accountType: 'department',
        staffNo: 'MYSQL-BOUND-0001',
        staffVerified: true,
        status: 'enabled',
        lastLoginAt: null,
      }),
    )
    await AppDataSource.getRepository(ClientStaffDirectory).save([
      { staffNo: 'MYSQL-LEGACY-0001', realName: 'MySQL 旧教师', departmentName: 'MySQL 教职工部门', status: 'active' },
      { staffNo: 'MYSQL-BOUND-0001', realName: 'MySQL 不应覆盖教师', departmentName: 'MySQL 教职工部门', status: 'active' },
    ])
    const legacyMigrationResult = await migrateClientUserDepartmentGovernance(AppDataSource)
    assert.equal(legacyMigrationResult.migratedCount, 1, '真实 MySQL 启动迁移只能转换未绑定旧部门账号')
    const migratedLegacyDepartmentUser = await AppDataSource.getRepository(ClientUser).findOneByOrFail({ id: legacyDepartmentUser.id })
    const unchangedBoundDepartmentUser = await AppDataSource.getRepository(ClientUser).findOneByOrFail({ id: boundDepartmentUser.id })
    assert.equal(migratedLegacyDepartmentUser.accountType, 'personal')
    assert.equal(migratedLegacyDepartmentUser.departmentNodeId, null)
    assert.equal(unchangedBoundDepartmentUser.accountType, 'department')
    assert.equal(unchangedBoundDepartmentUser.departmentNodeId, 'dept_mysql_bound')
    assert.equal(unchangedBoundDepartmentUser.realName, 'MySQL 已绑定部门账号')
    pass('真实 MySQL 启动迁移保留已绑定部门账号，仅转换未绑定存量账号')

    const walkinTasks = Array.from({ length: CONCURRENCY_SIZE }, () => orderSerialService.generateSystemNo('walkin'))
    const departmentTasks = Array.from({ length: CONCURRENCY_SIZE }, () => orderSerialService.generateSystemNo('department'))
    const [walkinSystemNos, departmentSystemNos] = await Promise.all([
      Promise.all(walkinTasks),
      Promise.all(departmentTasks),
    ])

    assert.equal(new Set(walkinSystemNos).size, walkinSystemNos.length)
    assert.equal(new Set(departmentSystemNos).size, departmentSystemNos.length)
    assert.equal(walkinSystemNos.every((systemNo) => /^OUT-W-\d{6}$/.test(systemNo)), true)
    assert.equal(departmentSystemNos.every((systemNo) => /^OUT-D-\d{6}$/.test(systemNo)), true)

    const walkinSerials = walkinSystemNos.map((systemNo) => parseSerial(systemNo, 'OUT-W-'))
    const departmentSerials = departmentSystemNos.map((systemNo) => parseSerial(systemNo, 'OUT-D-'))
    expectContinuousSequence(walkinSerials)
    expectContinuousSequence(departmentSerials)
    pass('并发流水号校验通过：同类无重复、双类型不串号且流水连续')

    const serialConfigs = await systemConfigService.getOrderIdentifierConfigs()
    const walkinConfig = serialConfigs.system.walkin
    const departmentConfig = serialConfigs.system.department
    assert.equal(walkinConfig.current, Math.max(...walkinSerials))
    assert.equal(departmentConfig.current, Math.max(...departmentSerials))
    pass('并发写入后的 current 值与最终流水一致，没有发生回退或跳号')

    const clientUserRepo = AppDataSource.getRepository(ClientUser)
    const clientUser = await clientUserRepo.save(clientUserRepo.create({
      mobile: `1${Date.now().toString().slice(-10)}`,
      email: null,
      mobileVerifiedAt: new Date(),
      emailVerifiedAt: null,
      passwordHash: 'verify-only',
      realName: '事务详情读取验证用户',
      departmentName: '测试部门',
      accountType: 'department',
      staffNo: `VERIFY-${Date.now()}`,
      staffVerified: true,
      status: 'enabled',
      lastLoginAt: null,
    }))
    const preorderRepo = AppDataSource.getRepository(O2oPreorder)
    const preorder = await preorderRepo.save(preorderRepo.create({
      preorderNo: `PRE-D-${String(Date.now()).slice(-6)}`,
      clientUserId: String(clientUser.id),
      verifyCode: randomUUID(),
      status: 'pending',
      clientOrderType: 'department',
      departmentNameSnapshot: '测试部门',
      staffNoSnapshot: clientUser.staffNo,
      isSystemApplied: false,
      hasCustomerOrder: false,
      pickupContact: '事务验证',
      totalQty: 0,
      remark: null,
      timeoutAt: new Date(Date.now() + 30 * 60 * 1000),
    }))
    const updatedDetail = await o2oPreorderService.updateComplianceFlagsByAdmin({
      orderId: String(preorder.id),
      hasCustomerOrder: true,
      isSystemApplied: true,
    }, concurrencyActor)
    assert.equal(updatedDetail.order.hasCustomerOrder, true)
    assert.equal(updatedDetail.order.isSystemApplied, true)
    pass('事务内详情读取复现通过：返回值使用同一 manager，可见未提交的最新写入')

    const returnProduct = await productService.create({
      productName: `MySQL 退货详情验证商品-${Date.now()}`,
      pinyinAbbr: 'MYSQLTH',
      defaultPrice: 10,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'listed',
      currentStock: 50,
      limitPerUser: 5,
    } as Parameters<typeof productService.create>[0], concurrencyActor)
    const returnSkuId = returnProduct.skus[0]?.id
    assert.ok(returnSkuId)

    let outboundFixtureIndex = 0
    const submitOutboundFixture = async (label: string) => {
      outboundFixtureIndex += 1
      return orderService.submit({
        idempotencyKey: `db-concurrency-business-no-${label}-${outboundFixtureIndex}`,
        orderType: 'walkin',
        customerName: `MySQL 业务号并发-${label}`,
        items: [{ productId: returnProduct.id, skuId: returnSkuId, qty: 1, unitPrice: 10 }],
      }, concurrencyActor)
    }
    const releasedSource = await submitOutboundFixture('source')
    const releasedTargetA = await submitOutboundFixture('target-a')
    const releasedTargetB = await submitOutboundFixture('target-b')
    const releasedSourceEntity = await AppDataSource.getRepository(BizOutboundOrder)
      .findOneByOrFail({ id: String(releasedSource.order.id) })
    const releasedTargetAEntity = await AppDataSource.getRepository(BizOutboundOrder)
      .findOneByOrFail({ id: String(releasedTargetA.order.id) })
    const releasedTargetBEntity = await AppDataSource.getRepository(BizOutboundOrder)
      .findOneByOrFail({ id: String(releasedTargetB.order.id) })
    await orderService.softDeleteById(
      String(releasedSourceEntity.id),
      concurrencyActor,
      releasedSourceEntity.businessNo,
      undefined,
      { releaseInventory: true },
    )
    const deletedReleasedSource = await AppDataSource.getRepository(BizOutboundOrder)
      .findOneByOrFail({ id: String(releasedSourceEntity.id) })
    deletedReleasedSource.inventoryMode = 'legacy_none'
    await AppDataSource.getRepository(BizOutboundOrder).save(deletedReleasedSource)
    await orderService.purgeById(String(deletedReleasedSource.id), concurrencyActor, deletedReleasedSource.businessNo)
    const releasedBusinessNo = releasedSourceEntity.businessNo
    const releasedBusinessNoResults = await Promise.allSettled([
      orderService.commitAmendments({ amendments: [{
        orderId: String(releasedTargetAEntity.id),
        editVersion: Number(releasedTargetAEntity.editVersion),
        businessNo: releasedBusinessNo,
        reason: '真实 MySQL 并发复用 A',
      }] }, concurrencyActor),
      orderService.commitAmendments({ amendments: [{
        orderId: String(releasedTargetBEntity.id),
        editVersion: Number(releasedTargetBEntity.editVersion),
        businessNo: releasedBusinessNo,
        reason: '真实 MySQL 并发复用 B',
      }] }, concurrencyActor),
    ])
    assert.equal(
      releasedBusinessNoResults.filter((result) => result.status === 'fulfilled').length,
      1,
      '真实 MySQL 同一已释放 businessNo 并发复用只能成功一笔',
    )
    const releasedBusinessNoFailure = releasedBusinessNoResults.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    assert.equal(
      (releasedBusinessNoFailure?.reason as { statusCode?: number } | undefined)?.statusCode,
      409,
      '真实 MySQL 同号并发失败方必须返回 409',
    )
    pass('真实 MySQL 同一已释放 businessNo 双事务竞争仅一笔成功，另一笔受控返回 409')

    const clientAuth = {
      userId: String(clientUser.id),
      account: clientUser.mobile ?? clientUser.staffNo ?? '',
      mobile: clientUser.mobile ?? '',
      email: clientUser.email ?? '',
      realName: clientUser.realName,
      accountType: clientUser.accountType,
      staffNo: clientUser.staffNo,
      sessionToken: 'verify-db-concurrency-client',
    }
    const pickupAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()
    const returnOrder = await o2oPreorderService.submit(clientAuth, {
      clientRequestId: 'db-concurrency-return-0001',
      items: [{ productId: returnProduct.id, skuId: returnSkuId, qty: 1 }],
      remark: 'MySQL 事务内退货详情验证',
      pickupContact: '并发验收',
      pickupAt,
      isSystemApplied: false,
    })
    await o2oPreorderService.verifyByCode(returnOrder.order.verifyCode, concurrencyActor)
    const returnRequest = await o2oPreorderService.createReturnRequest(clientAuth, returnOrder.order.id, {
      reason: 'MySQL 事务内退货详情验证',
      items: [{ productId: returnProduct.id, skuId: returnSkuId, qty: 1 }],
    })
    assert.equal(returnRequest.items.length, 1)
    assert.equal(returnRequest.items[0]?.skuId, returnSkuId)
    pass('事务内退货详情读取复现通过：新建明细在提交前即可由同一 manager 返回')

    const linkedReturnOutbound = await AppDataSource.getRepository(BizOutboundOrder).findOneByOrFail({
      sourceDocType: 'o2o_preorder',
      sourceDocId: String(returnOrder.order.id),
    })
    await orderService.commitAmendments({ amendments: [{
      orderId: String(linkedReturnOutbound.id),
      editVersion: Number(linkedReturnOutbound.editVersion),
      remark: '真实 MySQL O2O 整链删除 revision 夹具',
      reason: '构造 O2O 整链删除 revision',
    }] }, concurrencyActor)
    assert.equal(
      await AppDataSource.getRepository(OrderRevision).countBy({ orderUuid: linkedReturnOutbound.orderUuid }),
      1,
      'O2O 整链删除前必须存在 revision 夹具',
    )

    const inventoryFixtureRows = await AppDataSource.getRepository(InventoryLog).save([
      {
        productId: String(returnProduct.id), skuId: String(returnSkuId), changeType: 'verify_o2o_outbound_purge', changeQty: -1,
        beforeCurrentStock: 50, afterCurrentStock: 49, beforePreorderedStock: 0, afterPreorderedStock: 0,
        beforeSkuCurrentStock: 50, afterSkuCurrentStock: 49, beforeSkuPreorderedStock: 0, afterSkuPreorderedStock: 0,
        operatorType: 'admin', operatorId: concurrencyActor.userId, operatorName: concurrencyActor.displayName,
        refType: 'outbound_order', refId: String(linkedReturnOutbound.id), remark: `关联正式单 ${linkedReturnOutbound.businessNo}`,
      },
      {
        productId: String(returnProduct.id), skuId: String(returnSkuId), changeType: 'verify_o2o_preorder_purge', changeQty: 0,
        beforeCurrentStock: 49, afterCurrentStock: 49, beforePreorderedStock: 0, afterPreorderedStock: 0,
        beforeSkuCurrentStock: 49, afterSkuCurrentStock: 49, beforeSkuPreorderedStock: 0, afterSkuPreorderedStock: 0,
        operatorType: 'client', operatorId: clientAuth.userId, operatorName: clientAuth.realName,
        refType: 'o2o_preorder', refId: String(returnOrder.order.id), remark: `预订单 ${returnOrder.order.preorderNo}`,
      },
      {
        productId: String(returnProduct.id), skuId: String(returnSkuId), changeType: 'verify_o2o_return_purge', changeQty: 1,
        beforeCurrentStock: 49, afterCurrentStock: 50, beforePreorderedStock: 0, afterPreorderedStock: 0,
        beforeSkuCurrentStock: 49, afterSkuCurrentStock: 50, beforeSkuPreorderedStock: 0, afterSkuPreorderedStock: 0,
        operatorType: 'client', operatorId: clientAuth.userId, operatorName: clientAuth.realName,
        refType: 'o2o_return_request', refId: String(returnRequest.id), remark: `退货申请 ${returnRequest.returnNo}`,
      },
    ])
    const notificationEvent = await AppDataSource.getRepository(NotificationEvent).save({
      eventType: 'verify.o2o.purge',
      sourceType: 'o2o_preorder',
      sourceId: String(returnOrder.order.id),
      payloadJson: JSON.stringify({ preorderNo: returnOrder.order.preorderNo }),
      status: 'pending',
      attemptCount: 0,
      nextAttemptAt: null,
      processingStartedAt: null,
      processingOwner: null,
      processedAt: null,
      errorMessage: null,
    })
    const notificationDispatch = await AppDataSource.getRepository(NotificationDispatch).save({
      eventId: String(notificationEvent.id),
      channel: 'email',
      target: 'verify-o2o-purge@example.invalid',
      dedupeKey: null,
      status: 'pending',
      attemptCount: 0,
      errorMessage: null,
      responseCode: null,
      sentAt: null,
      lastAttemptAt: null,
    })
    const notificationInbox = await AppDataSource.getRepository(NotificationInbox).save({
      eventId: String(notificationEvent.id),
      userId: String(persistedAdmin.id),
      eventType: 'verify.o2o.purge',
      title: 'O2O 删除验证通知',
      content: `预订单 ${returnOrder.order.preorderNo}`,
      payloadJson: JSON.stringify({ preorderNo: returnOrder.order.preorderNo }),
      isRead: 0,
      readAt: null,
    })

    await AppDataSource.query(
      "CREATE TRIGGER trg_verify_o2o_delete_rollback BEFORE DELETE ON o2o_preorder FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'VERIFY_O2O_DELETE_ROLLBACK'",
    )
    try {
      await assert.rejects(
        () => o2oPreorderService.deleteConsoleOrder({
          orderId: String(returnOrder.order.id),
          confirmPreorderNo: returnOrder.order.preorderNo,
        }, concurrencyActor),
        /VERIFY_O2O_DELETE_ROLLBACK/,
        'O2O 主单删除失败时整链清理必须回滚',
      )
    } finally {
      await AppDataSource.query('DROP TRIGGER IF EXISTS trg_verify_o2o_delete_rollback')
    }
    assert.equal(await AppDataSource.getRepository(O2oPreorder).existsBy({ id: String(returnOrder.order.id) }), true)
    assert.equal(await AppDataSource.getRepository(BizOutboundOrder).existsBy({ id: String(linkedReturnOutbound.id) }), true)
    assert.equal(await AppDataSource.getRepository(O2oReturnRequest).existsBy({ id: String(returnRequest.id) }), true)
    assert.equal(await AppDataSource.getRepository(NotificationEvent).existsBy({ id: String(notificationEvent.id) }), true)
    assert.equal(await AppDataSource.getRepository(OrderRevision).countBy({ orderUuid: linkedReturnOutbound.orderUuid }), 1)
    for (const fixture of inventoryFixtureRows) {
      const persisted = await AppDataSource.getRepository(InventoryLog).findOneByOrFail({ id: String(fixture.id) })
      assert.notEqual(persisted.refType, null, '失败回滚不得提前匿名化库存流水')
    }

    await o2oPreorderService.deleteConsoleOrder({
      orderId: String(returnOrder.order.id),
      confirmPreorderNo: returnOrder.order.preorderNo,
    }, concurrencyActor)
    assert.equal(await AppDataSource.getRepository(O2oPreorder).existsBy({ id: String(returnOrder.order.id) }), false)
    assert.equal(await AppDataSource.getRepository(O2oPreorderItem).countBy({ orderId: String(returnOrder.order.id) }), 0)
    assert.equal(await AppDataSource.getRepository(BizOutboundOrder).existsBy({ id: String(linkedReturnOutbound.id) }), false)
    assert.equal(await AppDataSource.getRepository(BizOutboundOrderItem).countBy({ orderId: String(linkedReturnOutbound.id) }), 0)
    assert.equal(await AppDataSource.getRepository(O2oReturnRequest).existsBy({ id: String(returnRequest.id) }), false)
    assert.equal(await AppDataSource.getRepository(O2oReturnRequestItem).countBy({ returnRequestId: String(returnRequest.id) }), 0)
    assert.equal(await AppDataSource.getRepository(OrderRevision).countBy({ orderUuid: linkedReturnOutbound.orderUuid }), 0)
    assert.equal(await AppDataSource.getRepository(NotificationEvent).existsBy({ id: String(notificationEvent.id) }), false)
    assert.equal(await AppDataSource.getRepository(NotificationDispatch).existsBy({ id: String(notificationDispatch.id) }), false)
    assert.equal(await AppDataSource.getRepository(NotificationInbox).existsBy({ id: String(notificationInbox.id) }), false)
    for (const fixture of inventoryFixtureRows) {
      const anonymized = await AppDataSource.getRepository(InventoryLog).findOneByOrFail({ id: String(fixture.id) })
      assert.equal(anonymized.operatorType, 'anonymized')
      assert.equal(anonymized.operatorId, null)
      assert.equal(anonymized.operatorName, null)
      assert.equal(anonymized.refType, null)
      assert.equal(anonymized.refId, null)
      assert.equal(anonymized.remark, null)
    }
    const residualChainAudits = await AppDataSource.getRepository(SysAuditLog)
      .createQueryBuilder('audit')
      .where('(audit.targetType = :orderType AND audit.targetId IN (:...orderIds))', {
        orderType: 'order',
        orderIds: [String(linkedReturnOutbound.id), linkedReturnOutbound.orderUuid],
      })
      .orWhere('(audit.targetType = :preorderType AND audit.targetId = :preorderId)', {
        preorderType: 'o2o_order',
        preorderId: String(returnOrder.order.id),
      })
      .orWhere('(audit.targetType = :returnType AND audit.targetId = :returnId)', {
        returnType: 'o2o_return_request',
        returnId: String(returnRequest.id),
      })
      .getCount()
    assert.equal(residualChainAudits, 0, 'O2O 整链旧审计必须按 target_type + target_id 精确清理')
    const deleteAudits = await AppDataSource.getRepository(SysAuditLog).findBy({ actionType: 'o2o.preorder.delete' })
    assert.equal(deleteAudits.length, 1, 'O2O 整链永久删除只能保留一条最小审计')
    assert.equal(deleteAudits[0]?.targetId, null)
    assert.match(deleteAudits[0]?.targetCode ?? '', /^o2o:deleted:[0-9a-f-]{36}$/)
    assert.deepEqual(Object.keys(JSON.parse(deleteAudits[0]?.detailJson ?? '{}')), ['redactedTarget'])
    for (const sensitiveValue of [
      returnOrder.order.preorderNo,
      linkedReturnOutbound.businessNo,
      linkedReturnOutbound.systemNo,
      returnRequest.returnNo,
    ]) {
      assert.doesNotMatch(`${deleteAudits[0]?.targetCode ?? ''}${deleteAudits[0]?.detailJson ?? ''}`, new RegExp(sensitiveValue, 'i'))
    }
    pass('真实 MySQL O2O 整链删除成功/失败回滚、库存匿名化与单条最小审计均通过')

    // TypeORM synchronize 用于本临时库快速建表，但 MySQL 驱动不会保留实体 @Check。
    // 删除 045 tracking 后按生产迁移路径重放，确保下面的行为断言验证真实部署结构而非同步器近似结构。
    await AppDataSource.query("DELETE FROM schema_migrations WHERE filename = '045_order_merge_governance.sql'")
    const replayedOrderMergeMigration = await runMysqlSchemaMigrations(AppDataSource)
    assert.deepEqual(replayedOrderMergeMigration.appliedFiles, ['045_order_merge_governance.sql'])
    await assertMysqlRequiredSchemaExists(AppDataSource)

    const createMergeCandidate = async (suffix: string) => {
      const preorderResult = await o2oPreorderService.submit(clientAuth, {
        clientRequestId: `db-concurrency-order-merge-${suffix}`,
        items: [{ productId: returnProduct.id, skuId: returnSkuId, qty: 1 }],
        remark: `MySQL 合并与退货竞争-${suffix}`,
        pickupContact: '并发验收',
        pickupAt,
        isSystemApplied: false,
      })
      await o2oPreorderService.verifyByCode(preorderResult.order.verifyCode, concurrencyActor)
      const outbound = await AppDataSource.getRepository(BizOutboundOrder).findOneOrFail({
        where: { sourceDocType: 'o2o_preorder', sourceDocId: preorderResult.order.id },
      })
      return { preorder: preorderResult.order, outbound }
    }
    const mergeTarget = await createMergeCandidate('target')
    const mergeSource = await createMergeCandidate('source')
    const mergeInput = {
      target: { orderId: String(mergeTarget.outbound.id), editVersion: Number(mergeTarget.outbound.editVersion) },
      sources: [{ orderId: String(mergeSource.outbound.id), editVersion: Number(mergeSource.outbound.editVersion) }],
      reason: 'MySQL 合并与退货申请锁竞争验证',
      idempotencyKey: 'db-concurrency-order-merge-lock-v1',
    }
    const blockerConnection = await createConnection({
      host: mysqlConfig.host,
      port: mysqlConfig.port,
      user: mysqlConfig.user,
      password: mysqlConfig.password,
      database: VERIFY_TEMP_DATABASE_NAME,
    })
    try {
      await blockerConnection.beginTransaction()
      await blockerConnection.execute(
        'SELECT id FROM o2o_preorder WHERE id = ? FOR UPDATE',
        [mergeSource.preorder.id],
      )
      let mergeSettled = false
      const mergePromise = orderService.commitMerge(mergeInput, concurrencyActor)
        .then((value) => ({ status: 'fulfilled' as const, value }))
        .catch((reason: unknown) => ({ status: 'rejected' as const, reason }))
        .finally(() => {
          mergeSettled = true
        })
      await new Promise((resolve) => setTimeout(resolve, 300))
      assert.equal(
        mergeSettled,
        false,
        '合并事务必须等待来源原预订单行锁，不能在 pending 退货插入窗口中穿透提交',
      )
      await blockerConnection.execute(
        `INSERT INTO o2o_return_request
          (return_no, order_id, client_user_id, verify_code, status, source_order_status, reason, total_qty)
         VALUES (?, ?, ?, ?, 'pending', 'verified', ?, 1)`,
        [
          `TH-MYSQL-MERGE-${Date.now()}`,
          mergeSource.preorder.id,
          clientUser.id,
          randomUUID(),
          'MySQL 合并锁等待期间创建退货申请',
        ],
      )
      await blockerConnection.commit()
      const mergeOutcome = await mergePromise
      assert.equal(mergeOutcome.status, 'rejected', '锁释放后合并必须重查并拒绝 pending 退货')
      if (mergeOutcome.status === 'rejected') {
        assert.equal((mergeOutcome.reason as { statusCode?: number }).statusCode, 409)
      }
      assert.equal((await AppDataSource.getRepository(BizOutboundOrder).findOneByOrFail({
        id: mergeSource.outbound.id,
      })).status, 'active')
      await blockerConnection.execute(
        "DELETE FROM o2o_return_request WHERE order_id = ? AND status = 'pending'",
        [mergeSource.preorder.id],
      )

      const mergedResult = await orderService.commitMerge(mergeInput, concurrencyActor)
      await assert.rejects(
        () => blockerConnection.execute(
          `INSERT INTO order_merge_relation
            (operation_id, parent_order_id, parent_order_uuid, parent_business_no_snapshot,
             source_order_id, source_order_uuid, source_business_no_snapshot)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            mergedResult.operationId,
            mergeTarget.outbound.id,
            mergeTarget.outbound.orderUuid,
            mergeTarget.outbound.businessNo,
            mergeTarget.outbound.id,
            mergeTarget.outbound.orderUuid,
            mergeTarget.outbound.businessNo,
          ],
        ),
        (error: unknown) => (error as { code?: string }).code === 'ER_CHECK_CONSTRAINT_VIOLATED',
        'MySQL CHECK 必须拒绝 parent_order_id = source_order_id',
      )
      const alternateParent = await AppDataSource.getRepository(BizOutboundOrder).findOneByOrFail({
        id: String(releasedTargetAEntity.id),
      })
      await assert.rejects(
        () => blockerConnection.execute(
          `INSERT INTO order_merge_relation
            (operation_id, parent_order_id, parent_order_uuid, parent_business_no_snapshot,
             source_order_id, source_order_uuid, source_business_no_snapshot)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            mergedResult.operationId,
            alternateParent.id,
            alternateParent.orderUuid,
            alternateParent.businessNo,
            mergeSource.outbound.id,
            mergeSource.outbound.orderUuid,
            mergeSource.outbound.businessNo,
          ],
        ),
        (error: unknown) => (error as { code?: string }).code === 'ER_DUP_ENTRY',
        'MySQL UNIQUE 必须拒绝来源订单重复归并',
      )
      await assert.rejects(
        () => blockerConnection.execute('DELETE FROM biz_outbound_order WHERE id = ?', [mergeSource.outbound.id]),
        (error: unknown) => (error as { code?: string }).code === 'ER_ROW_IS_REFERENCED_2',
        'MySQL RESTRICT 必须保护合并来源订单不被物理删除',
      )
      pass('真实 MySQL 双连接验证通过：preorder 行锁阻断 pending 退货穿透，CHECK/UNIQUE/RESTRICT 均生效')
    } finally {
      try {
        await blockerConnection.rollback()
      } catch {
        // 已提交或连接结束时无需二次处理。
      }
      await blockerConnection.end()
    }
  } finally {
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy()
    }
  }
}

async function main() {
  const mysqlConfig = readVerifyMysqlRuntimeConfig()
  console.log(
    [
      '[verify:db:concurrency] 已锁定 MySQL 临时库验收环境',
      `- 连接来源：${mysqlConfig.sourceLabel}`,
      `- MySQL 服务：${mysqlConfig.host}:${mysqlConfig.port}`,
      `- 临时库：${VERIFY_TEMP_DATABASE_NAME}`,
      '- 运行策略：每次执行前清空临时库，执行后自动销毁，不复用业务库名',
    ].join('\n'),
  )

  configureRuntimeEnv(mysqlConfig)
  await recreateVerifyDatabase(mysqlConfig)
  pass('固定 MySQL 临时库已重建，可开始并发验收')

  try {
    await verifyOrderSerialConcurrency(mysqlConfig)
  } finally {
    await dropVerifyDatabase(mysqlConfig)
    fs.rmSync(VERIFY_RUNTIME_ROOT, { recursive: true, force: true })
    pass('固定 MySQL 临时库已清理完成')
  }
}

try {
  await main()
  console.log('\nverify:db:concurrency 自动化验证通过。')
} catch (error) {
  console.error(
    '\nverify:db:concurrency 自动化验证失败：\n',
    error instanceof Error ? error.message : String(error),
  )
  process.exit(1)
}
