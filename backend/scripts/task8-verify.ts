/**
 * 文件说明：backend/scripts/task8-verify.ts
 * 文件职责：验证双流水单号、历史迁移脚本、凭证打印关键实现与统计接口回归。
 * 维护说明：
 * - 若调整 Task8 迁移 SQL、单号前缀或前端凭证模板，请同步更新本脚本；
 * - 数据源相关模块必须用 `await import()` 动态加载：ESM 的静态 import 会在模块体执行前完成求值，
 *   若改回静态 import，下面这几行 process.env 赋值就会晚于 env.ts / data-source.ts 的初始化而完全失效，
 *   脚本会连到开发者的默认库 data/y-link.sqlite 上跑，既污染本地数据、又会因残留数据在重跑时报错。
 *
 * 已知未决问题：`verifyConcurrentSerialAndDrilldown` 目前在 SQLite 下无法通过。
 * TypeORM 的 sqlite 驱动只持有一条连接，16 个并发 `orderService.submit` 的写事务会在这条连接上重叠，
 * 先报 `cannot start a transaction within a transaction`、退避重试后又报 `no such savepoint`。
 * 这不是本脚本的问题，而是"SQLite 部署下并发写事务"这一production 缺陷的暴露：
 * 要真正修好需要把全部 80 处 `AppDataSource.transaction(...)` 收口到一个串行化入口，属于独立改造。
 */

import 'reflect-metadata'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AuthUserContext } from '../src/types/auth.js'

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtimeRoot = path.resolve(backendRoot, 'data', 'local-dev')
const verifySeed = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const sqlitePath = path.resolve(runtimeRoot, `y-link.task8-verify.${verifySeed}.sqlite`)
const sqlRoot = path.resolve(backendRoot, 'sql')
const frontendRoot = path.resolve(backendRoot, '../src/views/order-list')

process.env.APP_PROFILE = `task8-verify-${verifySeed}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'true'
process.env.SQLITE_DB_PATH = sqlitePath

type AppDataSourceRef = (typeof import('../src/config/data-source.js'))['AppDataSource']
type BizOutboundOrderRef = (typeof import('../src/entities/biz-outbound-order.entity.js'))['BizOutboundOrder']
type DashboardServiceRef = (typeof import('../src/services/dashboard.service.js'))['dashboardService']
type OrderServiceRef = (typeof import('../src/services/order.service.js'))['orderService']
type ProductServiceRef = (typeof import('../src/services/product.service.js'))['productService']
type SystemConfigServiceRef = (typeof import('../src/services/system-config.service.js'))['systemConfigService']
type TagServiceRef = (typeof import('../src/services/tag.service.js'))['tagService']

let AppDataSource: AppDataSourceRef
let BizOutboundOrder: BizOutboundOrderRef
let dashboardService: DashboardServiceRef
let orderService: OrderServiceRef
let productService: ProductServiceRef
let systemConfigService: SystemConfigServiceRef
let tagService: TagServiceRef

/** 必须在上面的 process.env 赋值之后调用，否则数据源会按默认配置初始化。 */
const loadRuntimeModules = async () => {
  AppDataSource = (await import('../src/config/data-source.js')).AppDataSource
  BizOutboundOrder = (await import('../src/entities/biz-outbound-order.entity.js')).BizOutboundOrder
  dashboardService = (await import('../src/services/dashboard.service.js')).dashboardService
  orderService = (await import('../src/services/order.service.js')).orderService
  productService = (await import('../src/services/product.service.js')).productService
  systemConfigService = (await import('../src/services/system-config.service.js')).systemConfigService
  tagService = (await import('../src/services/tag.service.js')).tagService
}

const mockActor: AuthUserContext = {
  userId: '9008',
  username: 'task8',
  displayName: 'Task8验证员',
  role: 'admin',
  status: 'enabled',
  sessionToken: 'task8-verify-session',
  authSource: 'bearer',
  permissions: [],
}

const pass = (title: string) => {
  console.log(`✅ ${title}`)
}

const getTodayText = () => {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

const parseSerial = (showNo: string, prefix: string) => {
  return Number.parseInt(showNo.replace(prefix, ''), 10)
}

const expectContinuousSequence = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const start = sorted[0] ?? 0
  sorted.forEach((value, index) => {
    assert.equal(value, start + index)
  })
}

const verifyMigrationScripts = () => {
  const migrationScriptPath = path.resolve(sqlRoot, '003_task8_dual_order_serial_migration.sql')
  const mappingScriptPath = path.resolve(sqlRoot, '004_task8_history_order_type_mapping.sql')
  const mappingRollbackScriptPath = path.resolve(sqlRoot, '005_task8_history_order_type_mapping_rollback.sql')

  assert.equal(fs.existsSync(migrationScriptPath), true)
  assert.equal(fs.existsSync(mappingScriptPath), true)
  assert.equal(fs.existsSync(mappingRollbackScriptPath), true)

  const migrationSource = fs.readFileSync(migrationScriptPath, 'utf8')
  const mappingSource = fs.readFileSync(mappingScriptPath, 'utf8')
  const rollbackSource = fs.readFileSync(mappingRollbackScriptPath, 'utf8')

  // 003 已从 MariaDB 专有的 ADD COLUMN IF NOT EXISTS 改造为
  // information_schema 判断 + PREPARE 动态 DDL（MySQL 8 兼容且可安全重放），
  // 因此这里断言"存在性判断"与"建列语句"两部分都在，而不是断言旧语法。
  assert.match(migrationSource, /COLUMN_NAME = 'order_type'\) = 0/)
  assert.match(migrationSource, /ADD COLUMN `order_type`/)
  assert.doesNotMatch(migrationSource, /ADD COLUMN IF NOT EXISTS/)
  assert.match(migrationSource, /idx_biz_outbound_order_type_created_at/)
  assert.match(migrationSource, /order\.serial\.department\.start/)
  assert.match(mappingSource, /task8_order_type_mapping_backup/)
  assert.match(mappingSource, /CASE/)
  // 004 里该列名带反引号（TRIM(`customer_department_name`)），断言需容忍反引号，
  // 否则这条守卫永远匹配失败——本脚本此前即因此在任何改动下都无法通过。
  assert.match(mappingSource, /TRIM\(`?customer_department_name`?\)/)
  assert.match(rollbackSource, /UPDATE `biz_outbound_order` AS o/)
  assert.match(rollbackSource, /DROP TABLE `task8_order_type_mapping_backup`/)
  pass('Task8 迁移与历史映射脚本已补齐且包含关键语句')
}

const verifyVoucherFlowByStaticCheck = () => {
  const orderListSource = fs.readFileSync(path.resolve(frontendRoot, 'OrderListView.vue'), 'utf8')
  const voucherWorkbenchSource = fs.readFileSync(
    path.resolve(frontendRoot, 'components/OrderVoucherWorkbenchDialog.vue'),
    'utf8',
  )
  const voucherTemplateSource = fs.readFileSync(path.resolve(frontendRoot, 'components/OrderVoucherTemplate.vue'), 'utf8')

  // 正式出库单是低频重能力，已从 OrderListView 拆到异步子组件 OrderVoucherWorkbenchDialog：
  // 列表页只保留入口与弹窗挂载，打印动作与凭证模板都落在子组件内，断言需按这个分层校验。
  assert.match(orderListSource, /handleOpenVoucherDialog/)
  assert.match(orderListSource, /OrderVoucherWorkbenchDialog/)
  assert.match(voucherWorkbenchSource, /(?:window|globalThis)\.print\(\)/)
  assert.match(voucherWorkbenchSource, /OrderVoucherTemplate/)
  // 模板已从早期“海右野辙文创店购物凭证”改版为单主表格的“野辙文创出库单”，
  // 金额汇总行标题也由“总金额”改为“总计”，这里按现行模板的锚点断言。
  assert.match(voucherTemplateSource, /野辙文创出库单/)
  assert.match(voucherTemplateSource, /业务单号/)
  assert.match(voucherTemplateSource, /总计/)
  pass('凭证预览与打印链路关键实现存在')
}

const verifySchemaByRuntime = async () => {
  const columns: Array<{ name: string }> = await AppDataSource.query(`PRAGMA table_info('biz_outbound_order')`)
  const columnSet = new Set(columns.map((column) => column.name))
  ;['order_type', 'has_customer_order', 'is_system_applied', 'issuer_name', 'customer_department_name'].forEach((name) => {
    assert.equal(columnSet.has(name), true)
  })

  const indexes: Array<{ name: string }> = await AppDataSource.query(`PRAGMA index_list('biz_outbound_order')`)
  const indexSet = new Set(indexes.map((index) => index.name))
  assert.equal(indexSet.has('idx_biz_outbound_order_type_created_at'), true)
  assert.equal(indexSet.has('uk_biz_outbound_show_no_is_deleted'), true)
  pass('运行态结构校验通过：字段与关键索引均已生效')
}

const verifyConcurrentSerialAndDrilldown = async () => {
  const analyticsTag = await tagService.create({
    tagName: 'Task8统计标签',
    tagCode: 'T8-STAT',
  })
  const productA = await productService.create({
    productName: 'Task8并发产品A',
    defaultPrice: 10,
    isActive: true,
    tagIds: [analyticsTag.id],
  })
  const productB = await productService.create({
    productName: 'Task8并发产品B',
    defaultPrice: 20,
    isActive: true,
  })

  const createWalkinOrders = Array.from({ length: 8 }, (_, index) =>
    orderService.submit(
      {
        idempotencyKey: `task8-walkin-${Date.now()}-${index}`,
        orderType: 'walkin',
        customerName: `散客${index + 1}`,
        hasCustomerOrder: index % 2 === 0,
        isSystemApplied: index % 3 === 0,
        items: [{ productId: productA.id, qty: 1 + index, unitPrice: 11.2 }],
      },
      mockActor,
    ),
  )
  const createDepartmentOrders = Array.from({ length: 8 }, (_, index) =>
    orderService.submit(
      {
        idempotencyKey: `task8-dept-${Date.now()}-${index}`,
        orderType: 'department',
        customerName: `部门客户${index + 1}`,
        customerDepartmentName: `后勤${index + 1}组`,
        issuerName: `值班员${index + 1}`,
        hasCustomerOrder: true,
        isSystemApplied: index % 2 === 0,
        items: [{ productId: productB.id, qty: 2 + index, unitPrice: 21.8 }],
      },
      mockActor,
    ),
  )

  const [walkinOrders, departmentOrders] = await Promise.all([
    Promise.all(createWalkinOrders),
    Promise.all(createDepartmentOrders),
  ])

  const walkinShowNos = walkinOrders.map((item) => item.order.showNo)
  const departmentShowNos = departmentOrders.map((item) => item.order.showNo)

  assert.equal(new Set(walkinShowNos).size, walkinShowNos.length)
  assert.equal(new Set(departmentShowNos).size, departmentShowNos.length)
  assert.equal(walkinShowNos.every((showNo) => /^hyyz\d{6}$/.test(showNo)), true)
  assert.equal(departmentShowNos.every((showNo) => /^hyyzjd\d{6}$/.test(showNo)), true)

  const walkinSerials = walkinShowNos.map((showNo) => parseSerial(showNo, 'hyyz'))
  const departmentSerials = departmentShowNos.map((showNo) => parseSerial(showNo, 'hyyzjd'))
  expectContinuousSequence(walkinSerials)
  expectContinuousSequence(departmentSerials)

  const savedOrders = await AppDataSource.getRepository(BizOutboundOrder).find({
    where: [...walkinOrders, ...departmentOrders].map((item) => ({ id: item.order.id })),
  })
  assert.equal(savedOrders.length, walkinOrders.length + departmentOrders.length)
  assert.equal(
    savedOrders.every((item) => (item.orderType === 'department' ? item.customerDepartmentName : true)),
    true,
  )
  pass('并发单号生成通过：同类无重复、双类型不串号且流水连续')

  const todayText = getTodayText()
  const productDrilldown = await dashboardService.getProductRankDrilldown({
    productId: productA.id,
    startDate: todayText,
    endDate: todayText,
    orderType: 'walkin',
  })
  assert.equal(productDrilldown.records.length >= 1, true)
  assert.equal(productDrilldown.records.every((record) => record.orderType === 'walkin'), true)

  const customerDrilldown = await dashboardService.getCustomerRankDrilldown({
    customerName: '散客1',
    startDate: todayText,
    endDate: todayText,
    orderType: 'walkin',
  })
  assert.equal(customerDrilldown.records.length >= 1, true)
  assert.equal(customerDrilldown.records[0]?.showNo.startsWith('hyyz'), true)

  const tagAggregate = await dashboardService.getTagAggregate({
    tagId: analyticsTag.id,
    startDate: todayText,
    endDate: todayText,
    orderType: 'walkin',
  })
  assert.equal(Number(tagAggregate.totalQuantity) > 0, true)
  assert.equal(Number(tagAggregate.totalAmount) > 0, true)
  pass('看板下钻与标签聚合回归通过')
}

async function main() {
  fs.mkdirSync(runtimeRoot, { recursive: true })
  fs.rmSync(sqlitePath, { force: true })

  verifyMigrationScripts()
  verifyVoucherFlowByStaticCheck()

  await loadRuntimeModules()
  await AppDataSource.initialize()
  try {
    await AppDataSource.synchronize()
    await systemConfigService.ensureDefaultConfigs()
    await verifySchemaByRuntime()
    await verifyConcurrentSerialAndDrilldown()
  } finally {
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy()
    }
    fs.rmSync(sqlitePath, { force: true })
  }
}

try {
  await main()
  console.log('\nTask8 自动化验证全部通过。')
} catch (error) {
  console.error('\nTask8 自动化验证失败：', error)
  process.exit(1)
}
