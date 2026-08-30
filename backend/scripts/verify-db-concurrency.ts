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
import { randomUUID } from 'node:crypto'
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
  process.env.DB_AUTO_MIGRATE = 'true'
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
    { O2oPreorder },
    { clientUserManageService },
    { migrateClientUserDepartmentGovernance },
    { assertMysqlRequiredSchemaExists, runMysqlSchemaMigrations },
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
    import('../src/entities/o2o-preorder.entity.js'),
    import('../src/services/client-user-manage.service.js'),
    import('../src/config/database-bootstrap.js'),
    import('../src/config/mysql-migration-runner.js'),
  ])

  await AppDataSource.initialize()
  try {
    await initializeDatabaseInfrastructure(AppDataSource)
    await AppDataSource.synchronize()
    await systemConfigService.ensureDefaultConfigs()
    pass('固定 MySQL 临时库已完成建表与默认配置初始化')

    await AppDataSource.query('ALTER TABLE client_user DROP INDEX uk_client_user_department_node_id')
    await AppDataSource.query('ALTER TABLE client_user DROP COLUMN department_node_id')
    const migrationResult = await runMysqlSchemaMigrations(AppDataSource)
    assert.ok(
      migrationResult.appliedFiles.includes('037_department_account_node_binding.sql'),
      '真实 MySQL 临时库应执行 037 补回部门节点字段与唯一索引',
    )
    await assertMysqlRequiredSchemaExists(AppDataSource)
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
    pass('真实 MySQL 临时库已执行 037 并恢复部门节点唯一约束')

    const concurrencyActor = {
      userId: '1',
      username: 'verify-admin',
      displayName: '并发验收管理员',
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
      showNo: `TX-${Date.now()}`,
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
    })
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
      currentStock: 5,
      limitPerUser: 5,
    } as Parameters<typeof productService.create>[0])
    const returnSkuId = returnProduct.skus[0]?.id
    assert.ok(returnSkuId)
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
    const returnOrder = await o2oPreorderService.submit(clientAuth, {
      clientRequestId: 'db-concurrency-return-0001',
      items: [{ productId: returnProduct.id, skuId: returnSkuId, qty: 1 }],
      remark: 'MySQL 事务内退货详情验证',
      pickupContact: '并发验收',
      isSystemApplied: false,
    })
    await o2oPreorderService.verifyByCode(returnOrder.order.verifyCode, {
      userId: '1',
      username: 'verify-admin',
      displayName: '并发验收管理员',
      role: 'admin',
      permissions: ['orders:create'],
      status: 'enabled',
      sessionToken: 'verify-db-concurrency-admin',
      authSource: 'bearer',
    })
    const returnRequest = await o2oPreorderService.createReturnRequest(clientAuth, returnOrder.order.id, {
      reason: 'MySQL 事务内退货详情验证',
      items: [{ productId: returnProduct.id, skuId: returnSkuId, qty: 1 }],
    })
    assert.equal(returnRequest.items.length, 1)
    assert.equal(returnRequest.items[0]?.skuId, returnSkuId)
    pass('事务内退货详情读取复现通过：新建明细在提交前即可由同一 manager 返回')
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
