/**
 * 文件说明：backend/scripts/task345-verify.ts
 * 文件职责：验证商品自动编码、批量启停、成交价回写以及看板统计下钻链路。
 * 维护说明：若调整商品管理、订单提交流程或前端静态实现约束，请同步更新本脚本断言。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { initializeDatabaseSchemaIfNeeded } from '../src/config/database-bootstrap.js'
import { AppDataSource } from '../src/config/data-source.js'
import { env } from '../src/config/env.js'
import { dashboardService } from '../src/services/dashboard.service.js'
import { orderService } from '../src/services/order.service.js'
import { productService } from '../src/services/product.service.js'
import { systemConfigService } from '../src/services/system-config.service.js'
import { tagService } from '../src/services/tag.service.js'
import type { AuthUserContext } from '../src/types/auth.js'

function pass(title: string) {
  console.log(`✅ ${title}`)
}

const currentFilePath = fileURLToPath(import.meta.url)
const backendRoot = path.resolve(path.dirname(currentFilePath), '..')
const frontendRoot = path.resolve(backendRoot, '..')
const orderEntryFile = path.resolve(frontendRoot, 'src/views/order-entry/composables/useOrderEntryForm.ts')
const productManagerFile = path.resolve(frontendRoot, 'src/views/base-data/components/ProductManager.vue')
const productRouteFile = path.resolve(backendRoot, 'src/routes/product.routes.ts')

const mockActor: AuthUserContext = {
  userId: '9001',
  username: 'task345',
  displayName: 'Task345验证用户',
  role: 'admin',
  status: 'enabled',
  sessionToken: 'task345-verify-session',
  permissions: [],
}

function resetVerifyDatabase() {
  if (env.DB_TYPE !== 'sqlite') {
    return
  }

  const verifyDatabasePath = path.resolve(backendRoot, env.SQLITE_DB_PATH)
  fs.mkdirSync(path.dirname(verifyDatabasePath), { recursive: true })
  if (fs.existsSync(verifyDatabasePath)) {
    fs.rmSync(verifyDatabasePath, { force: true })
  }
}

function verifyFrontendSources() {
  const orderEntrySource = fs.readFileSync(orderEntryFile, 'utf8')
  const productManagerSource = fs.readFileSync(productManagerFile, 'utf8')
  const productRouteSource = fs.readFileSync(productRouteFile, 'utf8')

  assert.match(orderEntrySource, /productApi\.createProduct\(\{/)
  assert.match(orderEntrySource, /productCode:\s*`Auto-\$\{globalThis\.crypto\.randomUUID\(\)\.slice\(0,\s*8\)\}`/)

  assert.match(productManagerSource, /getProductDetail\(row\.id\)/)
  assert.match(productManagerSource, /batchUpdateProducts/)
  assert.match(productManagerSource, /留空则自动生成统一编码/)
  assert.match(productRouteSource, /productRouter\.post\(\s*'\/batch'/)
  pass('前端已接入快捷创建商品、编辑详情回填与批量改状态入口')
}

async function main() {
  resetVerifyDatabase()
  verifyFrontendSources()

  await AppDataSource.initialize()
  await initializeDatabaseSchemaIfNeeded(AppDataSource)
  await systemConfigService.ensureDefaultConfigs()

  try {
    const analyticsTag = await tagService.create({
      tagName: 'Task345统计标签',
      tagCode: 'T345-STAT',
    })

    const firstProduct = await productService.create({
      productName: '自动编码产品一号',
      defaultPrice: 10,
      isActive: true,
      tagIds: [analyticsTag.id],
    })
    const secondProduct = await productService.create({
      productName: '自动编码产品二号',
      defaultPrice: 12,
      isActive: true,
    })

    assert.match(firstProduct.productCode, /^P-\d{6}-0001$/)
    assert.match(secondProduct.productCode, /^P-\d{6}-0002$/)
    assert.notEqual(firstProduct.productCode, secondProduct.productCode)
    pass('新增产品留空编码时会按统一规则生成简洁且唯一的产品编码')

    const batchUpdatedProducts = await productService.batchUpdate({
      ids: [firstProduct.id, secondProduct.id],
      isActive: false,
    })
    assert.equal(batchUpdatedProducts.length, 2)
    assert.equal(batchUpdatedProducts.every((item) => item.isActive === false), true)
    assert.equal((await productService.detail(firstProduct.id)).isActive, false)
    pass('批量改状态可同时回写产品真实启停状态')

    await assert.rejects(
      () =>
        productService.update(firstProduct.id, {
          currentStock: 1,
          preOrderedStock: 2,
        }),
      /预订库存不能超过物理库存/,
    )
    pass('商品服务会阻断预订库存大于物理库存的非法更新')

    await productService.update(firstProduct.id, {
      isActive: true,
      defaultPrice: 10,
    })
    await productService.update(secondProduct.id, {
      isActive: true,
      defaultPrice: 12,
    })

    const submitResult = await orderService.submit(
      {
        idempotencyKey: `task345-${Date.now()}`,
        orderType: 'walkin',
        customerName: 'Task345客户',
        remark: '验证默认售价回写',
        items: [
          {
            productId: firstProduct.id,
            qty: 2,
            unitPrice: 18.8,
            remark: '成交价回写测试',
          },
        ],
      },
      mockActor,
    )

    await orderService.submit(
      {
        idempotencyKey: `task345-dept-${Date.now()}`,
        orderType: 'department',
        customerName: 'Task345部门客户',
        customerDepartmentName: '行政部',
        issuerName: '张三',
        items: [
          {
            productId: secondProduct.id,
            qty: 3,
            unitPrice: 15.5,
            remark: '部门单统计验证',
          },
        ],
      },
      mockActor,
    )

    await assert.rejects(
      () =>
        orderService.submit(
          {
            idempotencyKey: `task345-duplicate-${Date.now()}`,
            orderType: 'walkin',
            customerName: 'Task345重复产品客户',
            items: [
              {
                productId: firstProduct.id,
                qty: 1,
                unitPrice: 9.9,
              },
              {
                productId: firstProduct.id,
                qty: 2,
                unitPrice: 9.9,
              },
            ],
          },
          mockActor,
        ),
      /重复/,
    )
    pass('订单服务会阻断同一产品重复出现在多条明细中的脏单据')

    const productAfterSubmit = await productService.detail(firstProduct.id)
    const orderDetail = await orderService.detailById(submitResult.order.id)
    assert.equal(productAfterSubmit.defaultPrice, '18.80')
    assert.equal(orderDetail.items[0]?.unitPrice, '18.80')
    pass('出库单提交后会将成交单价回写为产品默认售价')

    const today = new Date()
    const todayText = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

    const productDrilldown = await dashboardService.getProductRankDrilldown({
      productId: firstProduct.id,
      startDate: todayText,
      endDate: todayText,
      orderType: 'walkin',
    })
    assert.equal(productDrilldown.productId, firstProduct.id)
    assert.equal(productDrilldown.records.length >= 1, true)
    assert.equal(Number(productDrilldown.totalQty) > 0, true)

    const customerDrilldown = await dashboardService.getCustomerRankDrilldown({
      customerName: '散客',
      startDate: todayText,
      endDate: todayText,
      orderType: 'walkin',
    })
    assert.equal(customerDrilldown.records.length >= 1, true)
    assert.equal(customerDrilldown.records[0]?.orderType, 'walkin')

    const tagAggregate = await dashboardService.getTagAggregate({
      tagId: analyticsTag.id,
      startDate: todayText,
      endDate: todayText,
      orderType: 'walkin',
    })
    assert.equal(tagAggregate.tagId, analyticsTag.id)
    assert.equal(Number(tagAggregate.totalQuantity) > 0, true)
    assert.equal(Number(tagAggregate.totalAmount) > 0, true)

    const pieData = await dashboardService.getDashboardPieData({
      startDate: todayText,
      endDate: todayText,
    })
    assert.equal(pieData.productPie.length >= 1, true)
    assert.equal(pieData.customerPie.length >= 1, true)
    assert.equal(pieData.orderTypePie.some((item) => item.key === 'walkin'), true)
    assert.equal(pieData.orderTypePie.some((item) => item.key === 'department'), true)
    pass('Task3 统计下钻、标签聚合与三类饼图服务接口可正常返回')
  } finally {
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy()
    }
  }
}

try {
  await main()
  console.log('\nTask3/4/5 自动化验证全部通过。')
} catch (error) {
  console.error('\nTask3/4/5 自动化验证失败：', error)
  process.exit(1)
}
