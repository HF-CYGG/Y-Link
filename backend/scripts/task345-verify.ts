/**
 * 文件说明：backend/scripts/task345-verify.ts
 * 文件职责：在独占临时 SQLite 中验证商品自动编码、批量启停、订单价格快照以及看板统计下钻。
 * 维护说明：若调整商品管理、订单提交流程或前端静态实现约束，请同步更新本脚本断言。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareOrderSubmission } from '../../src/views/order-entry/composables/prepare-order-submission.ts'
import type { AuthUserContext } from '../src/types/auth.js'
import { createVerificationIsolation } from './verification-isolation.js'

function pass(title: string) {
  console.log(`✅ ${title}`)
}

const currentFilePath = fileURLToPath(import.meta.url)
const backendRoot = path.resolve(path.dirname(currentFilePath), '..')
const frontendRoot = path.resolve(backendRoot, '..')
const orderEntryFile = path.resolve(frontendRoot, 'src/views/order-entry/composables/useOrderEntryForm.ts')
const prepareSubmissionFile = path.resolve(frontendRoot, 'src/views/order-entry/composables/prepare-order-submission.ts')
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

function verifyFrontendSources() {
  const orderEntrySource = fs.readFileSync(orderEntryFile, 'utf8')
  const prepareSubmissionSource = fs.readFileSync(prepareSubmissionFile, 'utf8')
  const productManagerSource = fs.readFileSync(productManagerFile, 'utf8')
  const productRouteSource = fs.readFileSync(productRouteFile, 'utf8')

  for (const source of [orderEntrySource, prepareSubmissionSource]) {
    assert.doesNotMatch(source, /\bcreateProduct\s*\(/, '出库开单不得隐式创建商品')
  }
  assert.match(orderEntrySource, /getAdminProductOptions\(\{\s*isActive:\s*true\s*\}/, '开单候选必须从启用商品中获取')
  assert.match(orderEntrySource, /load:\s*\(\)\s*=>\s*import\('\.\/prepare-order-submission'\)/, '开单必须使用实际提交准备模块')
  assert.match(
    orderEntrySource,
    /await loadOrderEntrySubmission\(\)[\s\S]{0,180}prepareOrderSubmission\(headerForm, itemRows\.value, products\.value\)[\s\S]{0,100}if\s*\(!prepared\.payload\)\s*\{[\s\S]{0,100}return[\s\S]{0,1000}orderApi\.submitOrder\(/,
    '开单必须先校验当前明细，失败时不调用订单提交接口',
  )

  // 编辑弹窗必须走详情接口回填，并且详情请求要透传 useStableRequest 下发的 signal：
  // 少了 signal，连点不同行时旧详情会覆盖新选择（见 src/composables/useStableRequest.ts 的 runLatest）。
  // 断言口径与 scripts/verify-enterprise-core-paths.mjs 中其他详情请求保持一致。
  assert.match(
    productManagerSource,
    /executor: \(signal\) => getProductDetail\(row\.id, \{ signal \}\)/,
    '产品编辑弹窗未走详情接口回填或未透传 signal',
  )
  assert.match(productManagerSource, /batchUpdateProducts/)
  assert.match(productManagerSource, /留空则自动生成统一编码/)
  assert.match(productRouteSource, /productRouter\.post\(\s*'\/batch'/)
  pass('出库开单接入提交准备模块，产品中心保留编辑详情回填与批量改状态入口')
}

async function main(isolation: ReturnType<typeof createVerificationIsolation>) {
  isolation.seal({ type: 'sqlite', database: path.join(isolation.rootDir, 'task345.sqlite') })
  process.env.DB_SYNC = 'false'
  const { AppDataSource } = await import('../src/config/data-source.js')
  await isolation.assertTarget(AppDataSource)
  const [
    { initializeDatabaseSchemaIfNeeded }, { SysUser }, { dashboardService }, { orderService },
    { productService }, { systemConfigService }, { tagService },
  ] = await Promise.all([
    import('../src/config/database-bootstrap.js'), import('../src/entities/sys-user.entity.js'),
    import('../src/services/dashboard.service.js'), import('../src/services/order.service.js'),
    import('../src/services/product.service.js'), import('../src/services/system-config.service.js'),
    import('../src/services/tag.service.js'),
  ])

  try {
    await AppDataSource.initialize()
    await initializeDatabaseSchemaIfNeeded(AppDataSource)
    await systemConfigService.ensureDefaultConfigs()

    const persistedActor = await AppDataSource.getRepository(SysUser).save({
      username: mockActor.username,
      passwordHash: 'test-only-password-hash',
      displayName: mockActor.displayName,
      email: null,
      role: mockActor.role,
      status: mockActor.status,
      lastLoginAt: null,
      deactivatedAt: null,
      deactivationReason: null,
      deactivatedByUserId: null,
      deactivatedByUsername: null,
      deactivatedByDisplayName: null,
      restoredAt: null,
      restoredByUserId: null,
      restoredByUsername: null,
      restoredByDisplayName: null,
    })
    mockActor.userId = persistedActor.id

    const analyticsTag = await tagService.create({
      tagName: 'Task345统计标签',
      tagCode: 'T345-STAT',
    }, mockActor)

    const firstProduct = await productService.create({
      productName: '自动编码产品一号',
      defaultPrice: 10,
      currentStock: 20,
      isActive: true,
      tagIds: [analyticsTag.id],
    }, mockActor)
    const secondProduct = await productService.create({
      productName: '自动编码产品二号',
      defaultPrice: 12,
      currentStock: 20,
      isActive: true,
    }, mockActor)

    assert.match(firstProduct.productCode, /^P-\d{6}-0001$/)
    assert.match(secondProduct.productCode, /^P-\d{6}-0002$/)
    assert.notEqual(firstProduct.productCode, secondProduct.productCode)
    pass('新增产品留空编码时会按统一规则生成简洁且唯一的产品编码')

    const batchUpdatedProducts = await productService.batchUpdate({
      ids: [firstProduct.id, secondProduct.id],
      isActive: false,
    }, mockActor)
    assert.equal(batchUpdatedProducts.length, 2)
    assert.equal(batchUpdatedProducts.every((item) => item.isActive === false), true)
    assert.equal((await productService.detail(firstProduct.id)).isActive, false)
    pass('批量改状态可同时回写产品真实启停状态')

    await assert.rejects(
      () =>
        productService.update(firstProduct.id, {
          currentStock: 1,
        }, mockActor),
      /缺少打开编辑时的库存基线/,
    )
    await productService.update(firstProduct.id, { preOrderedStock: 2 }, mockActor)
    assert.equal((await productService.detail(firstProduct.id)).preOrderedStock, 0)
    pass('商品编辑改库存必须携带基线，且不得改写由 O2O 生命周期记账的预订库存')

    await productService.update(firstProduct.id, {
      isActive: true,
      defaultPrice: 10,
    }, mockActor)

    const activeProducts = await productService.list({ isActive: true })
    assert.deepEqual(activeProducts.map((product) => product.id), [firstProduct.id])
    for (const productId of ['未建档的旧草稿商品', secondProduct.id]) {
      const prepared = prepareOrderSubmission({
        orderType: 'walkin', hasCustomerOrder: false, isSystemApplied: false,
        issuerName: mockActor.displayName, customerDepartmentName: '', customerDepartmentNodeId: '',
        customerName: '', remark: '',
      }, [{ uid: 'draft-row', productId, skuId: secondProduct.skus[0]?.id ?? '', qty: 1, unitPrice: 12, remark: '' }], activeProducts)
      assert.equal(prepared.error, '存在未建档、已停用或暂无可用规格的商品，请重新选择', `应拒绝草稿商品 ${productId}`)
      assert.equal(prepared.payload, undefined, '无效商品不得产生出库载荷')
    }
    pass('真实提交准备拒绝旧草稿中的未知和已停用商品')

    await productService.update(secondProduct.id, {
      isActive: true,
      defaultPrice: 12,
    }, mockActor)

    const submitResult = await orderService.submit(
      {
        idempotencyKey: `task345-${Date.now()}`,
        orderType: 'walkin',
        customerName: 'Task345客户',
        remark: '验证成交价快照',
        items: [
          {
            productId: firstProduct.id,
            qty: 2,
            unitPrice: 18.8,
            remark: '成交价快照测试',
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
      /同一规格|重复/,
    )
    pass('订单服务会阻断同一规格重复出现在多条明细中的脏单据')

    const productAfterSubmit = await productService.detail(firstProduct.id)
    const orderDetail = await orderService.detailById(submitResult.order.id)
    assert.equal(productAfterSubmit.defaultPrice, '10.00')
    assert.equal(productAfterSubmit.skus[0]?.defaultPrice, '10.00')
    assert.equal(productAfterSubmit.currentStock, firstProduct.currentStock - 2)
    assert.equal(orderDetail.items[0]?.unitPrice, '18.80')
    pass('出库单保留成交单价并扣减库存，商品与规格默认价保持原值')

    const today = new Date()
    const todayText = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

    const productDrilldown = await dashboardService.getProductRankDrilldown({
      productId: firstProduct.id,
      startDate: todayText,
      endDate: todayText,
      orderType: 'walkin',
    }, mockActor)
    assert.equal(productDrilldown.productId, firstProduct.id)
    assert.equal(productDrilldown.records.length >= 1, true)
    assert.equal(Number(productDrilldown.totalQty) > 0, true)

    const customerDrilldown = await dashboardService.getCustomerRankDrilldown({
      customerName: '行政部',
      startDate: todayText,
      endDate: todayText,
      orderType: 'department',
    }, mockActor)
    assert.equal(customerDrilldown.records.length >= 1, true)
    assert.equal(customerDrilldown.records[0]?.orderType, 'department')

    const tagAggregate = await dashboardService.getTagAggregate({
      tagId: analyticsTag.id,
      startDate: todayText,
      endDate: todayText,
      orderType: 'walkin',
    }, mockActor)
    assert.equal(tagAggregate.tagId, analyticsTag.id)
    assert.equal(Number(tagAggregate.totalQuantity) > 0, true)
    assert.equal(Number(tagAggregate.totalAmount) > 0, true)

    const pieData = await dashboardService.getDashboardPieData({
      startDate: todayText,
      endDate: todayText,
    }, mockActor)
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
  verifyFrontendSources()
  const isolation = createVerificationIsolation('task345')
  try {
    await main(isolation)
  } finally {
    isolation.cleanup()
  }
  console.log('\nTask3/4/5 自动化验证全部通过。')
} catch (error) {
  console.error('\nTask3/4/5 自动化验证失败：', error)
  process.exitCode = 1
}
