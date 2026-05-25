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
import { createConnection } from 'mysql2/promise'

const VERIFY_TEMP_DATABASE_NAME = 'y_link_verify_db_concurrency'
const VERIFY_APP_PROFILE = 'verify-db-concurrency'
const CONCURRENCY_SIZE = 12

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

async function verifyOrderSerialConcurrency() {
  const [{ AppDataSource }, { systemConfigService }, { orderSerialService }] = await Promise.all([
    import('../src/config/data-source.js'),
    import('../src/services/system-config.service.js'),
    import('../src/services/order-serial.service.js'),
  ])

  await AppDataSource.initialize()
  try {
    await AppDataSource.synchronize()
    await systemConfigService.ensureDefaultConfigs()
    pass('固定 MySQL 临时库已完成建表与默认配置初始化')

    const walkinTasks = Array.from({ length: CONCURRENCY_SIZE }, () => orderSerialService.generateOrderNo('walkin'))
    const departmentTasks = Array.from({ length: CONCURRENCY_SIZE }, () => orderSerialService.generateOrderNo('department'))
    const [walkinShowNos, departmentShowNos] = await Promise.all([
      Promise.all(walkinTasks),
      Promise.all(departmentTasks),
    ])

    assert.equal(new Set(walkinShowNos).size, walkinShowNos.length)
    assert.equal(new Set(departmentShowNos).size, departmentShowNos.length)
    assert.equal(walkinShowNos.every((showNo) => /^hyyz\d{6}$/.test(showNo)), true)
    assert.equal(departmentShowNos.every((showNo) => /^hyyzjd\d{6}$/.test(showNo)), true)

    const walkinSerials = walkinShowNos.map((showNo) => parseSerial(showNo, 'hyyz'))
    const departmentSerials = departmentShowNos.map((showNo) => parseSerial(showNo, 'hyyzjd'))
    expectContinuousSequence(walkinSerials)
    expectContinuousSequence(departmentSerials)
    pass('并发流水号校验通过：同类无重复、双类型不串号且流水连续')

    const serialConfigs = await systemConfigService.getOrderSerialConfigs()
    const walkinConfig = serialConfigs.list.find((item) => item.orderType === 'walkin')
    const departmentConfig = serialConfigs.list.find((item) => item.orderType === 'department')
    assert.ok(walkinConfig)
    assert.ok(departmentConfig)
    assert.equal(walkinConfig.current, Math.max(...walkinSerials))
    assert.equal(departmentConfig.current, Math.max(...departmentSerials))
    pass('并发写入后的 current 值与最终流水一致，没有发生回退或跳号')
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
    await verifyOrderSerialConcurrency()
  } finally {
    await dropVerifyDatabase(mysqlConfig)
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
