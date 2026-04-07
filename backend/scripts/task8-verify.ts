import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { AppDataSource } from '../src/config/data-source.js'
import { BizOutboundOrder } from '../src/entities/biz-outbound-order.entity.js'
import { dashboardService } from '../src/services/dashboard.service.js'
import { orderService } from '../src/services/order.service.js'
import { productService } from '../src/services/product.service.js'
import { systemConfigService } from '../src/services/system-config.service.js'
import { tagService } from '../src/services/tag.service.js'
import type { AuthUserContext } from '../src/types/auth.js'

const runtimeRoot = path.resolve(process.cwd(), 'data/local-dev')
const sqlitePath = path.resolve(runtimeRoot, `y-link.task8-verify.${Date.now()}.sqlite`)
const sqlRoot = path.resolve(process.cwd(), 'sql')
const frontendRoot = path.resolve(process.cwd(), '../src/views/order-list')

process.env.APP_PROFILE = `task8-verify-${Date.now()}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'true'
process.env.SQLITE_DB_PATH = sqlitePath

const mockActor: AuthUserContext = {
  userId: '9008',
  username: 'task8',
  displayName: 'Task8验证员',
  role: 'admin',
  status: 'enabled',
  sessionToken: 'task8-verify-session',
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

  assert.match(migrationSource, /ADD COLUMN IF NOT EXISTS `order_type`/)
  assert.match(migrationSource, /idx_biz_outbound_order_type_created_at/)
  assert.match(migrationSource, /order\.serial\.department\.start/)
  assert.match(mappingSource, /task8_order_type_mapping_backup/)
  assert.match(mappingSource, /CASE/)
  assert.match(mappingSource, /TRIM\(customer_department_name\)/)
  assert.match(rollbackSource, /UPDATE `biz_outbound_order` AS o/)
  assert.match(rollbackSource, /DROP TABLE `task8_order_type_mapping_backup`/)
  pass('Task8 迁移与历史映射脚本已补齐且包含关键语句')
}

const verifyVoucherFlowByStaticCheck = () => {
  const orderListSource = fs.readFileSync(path.resolve(frontendRoot, 'OrderListView.vue'), 'utf8')
  const voucherTemplateSource = fs.readFileSync(path.resolve(frontendRoot, 'components/OrderVoucherTemplate.vue'), 'utf8')

  assert.match(orderListSource, /window\.print\(\)/)
  assert.match(orderListSource, /handleOpenVoucherDialog/)
  assert.match(orderListSource, /OrderVoucherTemplate/)
  assert.match(voucherTemplateSource, /海右野辙文创店购物凭证/)
  assert.match(voucherTemplateSource, /业务单号/)
  assert.match(voucherTemplateSource, /总金额/)
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
