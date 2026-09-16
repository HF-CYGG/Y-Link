/**
 * 模块说明：backend/scripts/inbound-admin-pool-verify.ts
 * 文件职责：使用隔离 SQLite 验证 Issue #95 的送货单池与预计送达时间约束。
 * 实现逻辑：
 * - 手工构造供货方与库管账号、商品与多张送货单，覆盖待入库、已入库与已撤销三种状态；
 * - 调用真实 InboundService 校验分栏计数、分页收敛、排序口径与新单提醒基准；
 * - 覆盖预计送达时间必填、超范围拒绝、改单可改，以及供货方访问送货单池被拒绝。
 * 维护说明：
 * - 期望值必须手工给出，不能从被测方法自身反推；
 * - 脚本只能连接本次唯一临时 SQLite，禁止读取或修改业务数据库。
 */

import 'reflect-metadata'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AuthUserContext } from '../src/types/auth.js'

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sqliteRoot = path.resolve(backendRoot, 'data', 'local-dev')
const verifySeed = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const sqlitePath = path.resolve(sqliteRoot, `inbound-admin-pool-${verifySeed}.sqlite`)

process.env.APP_PROFILE = `inbound-admin-pool-${verifySeed}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'false'
process.env.SQLITE_DB_PATH = sqlitePath
process.env.INIT_ADMIN_PASSWORD = `Admin_${verifySeed}_Aa1!`

const hoursLater = (hours: number) => new Date(Date.now() + hours * 60 * 60 * 1000).toISOString()

function cleanupSqliteFile() {
  for (const suffix of ['', '-shm', '-wal']) {
    const target = `${sqlitePath}${suffix}`
    if (fs.existsSync(target)) {
      fs.rmSync(target, { force: true })
    }
  }
}

async function main() {
  fs.mkdirSync(sqliteRoot, { recursive: true })
  const { AppDataSource } = await import('../src/config/data-source.js')
  const { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime } = await import('../src/config/database-bootstrap.js')
  const { SysUser } = await import('../src/entities/sys-user.entity.js')
  const { inboundService } = await import('../src/services/inbound.service.js')
  const { productService } = await import('../src/services/product.service.js')
  const { systemConfigService } = await import('../src/services/system-config.service.js')

  prepareDatabaseRuntime()
  await AppDataSource.initialize()
  try {
    await initializeDatabaseSchemaIfNeeded(AppDataSource)
    await systemConfigService.ensureDefaultConfigs()

    const userRepo = AppDataSource.getRepository(SysUser)
    const admin = await userRepo.save(userRepo.create({
      username: `inbound-pool-admin-${verifySeed}`,
      passwordHash: 'verify-only',
      displayName: '送货单池验证管理员',
      email: null,
      role: 'admin',
      status: 'enabled',
      lastLoginAt: null,
    }))
    const supplier = await userRepo.save(userRepo.create({
      username: `inbound-pool-supplier-${verifySeed}`,
      passwordHash: 'verify-only',
      displayName: '送货单池验证供货方',
      email: null,
      role: 'supplier',
      status: 'enabled',
      lastLoginAt: null,
    }))
    const buildActor = (user: typeof admin, role: AuthUserContext['role']): AuthUserContext => ({
      userId: String(user.id),
      username: user.username,
      displayName: user.displayName,
      role,
      permissions: [],
      status: 'enabled',
      sessionToken: `inbound-pool-${role}-session`,
      authSource: 'bearer',
    })
    const adminActor = buildActor(admin, 'admin')
    const supplierActor = buildActor(supplier, 'supplier')

    const product = await productService.create({
      productCode: `INBOUND-POOL-${verifySeed}`,
      productName: `送货单池验证商品-${verifySeed}`,
      pinyinAbbr: 'SHDCYZ',
      defaultPrice: 10,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'unlisted',
      currentStock: 0,
      limitPerUser: 20,
    }, adminActor)
    const sku = product.skus[0]
    assert.ok(sku, '验证商品必须生成默认 SKU')

    const submitDelivery = async (expectedArrivalAt: string, qty: number) => inboundService.submitSupplierDelivery(supplierActor, {
      remark: '送货单池验证',
      expectedArrivalAt,
      items: [{ productId: String(product.id), skuId: String(sku.id), qty }],
    })

    // 预计送达时间必填与范围校验：失败时不得生成送货单。
    await assert.rejects(
      () => inboundService.submitSupplierDelivery(supplierActor, {
        remark: '缺少预计送达时间',
        items: [{ productId: String(product.id), skuId: String(sku.id), qty: 1 }],
      }),
      /请选择预计送达时间/,
      '缺少预计送达时间必须被拒绝',
    )
    await assert.rejects(
      () => submitDelivery(new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), 1),
      /预计送达时间不能早于今天/,
      '早于今天的预计送达时间必须被拒绝',
    )
    await assert.rejects(
      () => submitDelivery(hoursLater(91 * 24), 1),
      /预计送达时间不能晚于/,
      '超过 90 天的预计送达时间必须被拒绝',
    )
    const emptyPool = await inboundService.listInboundOrderPool(adminActor, {})
    assert.deepEqual(emptyPool.poolCounts, { all: 0, pending: 0, verified: 0 }, '被拒绝的提交不得留下任何送货单')

    // 三张待入库 + 一张已入库 + 一张已撤销，撤销单不应出现在送货单池。
    const laterDelivery = await submitDelivery(hoursLater(48), 2)
    const soonerDelivery = await submitDelivery(hoursLater(6), 3)
    const middleDelivery = await submitDelivery(hoursLater(24), 4)
    const verifiedDelivery = await submitDelivery(hoursLater(12), 5)
    await inboundService.verifyInbound(verifiedDelivery.order.verifyCode, adminActor)
    const cancelledDelivery = await submitDelivery(hoursLater(30), 6)
    await inboundService.cancelSupplierDelivery(supplierActor, cancelledDelivery.order.id, '送货单池验证撤销')

    const allPool = await inboundService.listInboundOrderPool(adminActor, { pool: 'all', pageSize: 50 })
    assert.deepEqual(allPool.poolCounts, { all: 4, pending: 3, verified: 1 }, '分栏计数必须排除已撤销单据')
    assert.equal(allPool.total, 4)
    assert.equal(
      allPool.records.some((order) => order.id === cancelledDelivery.order.id),
      false,
      '已撤销送货单不得出现在送货单池',
    )
    assert.equal(
      allPool.records.find((order) => order.id === verifiedDelivery.order.id)?.expectedArrivalAt !== null,
      true,
      '送货单池必须返回预计送达时间',
    )

    const pendingPool = await inboundService.listInboundOrderPool(adminActor, { pool: 'pending', pageSize: 50 })
    assert.equal(pendingPool.total, 3)
    assert.deepEqual(
      pendingPool.records.map((order) => order.id),
      [soonerDelivery.order.id, middleDelivery.order.id, laterDelivery.order.id],
      '待入库必须按预计送达时间由近到远排序',
    )

    const firstPage = await inboundService.listInboundOrderPool(adminActor, { pool: 'pending', page: 1, pageSize: 2 })
    assert.equal(firstPage.records.length, 2, '分页必须按 pageSize 截断')
    const outOfRangePage = await inboundService.listInboundOrderPool(adminActor, { pool: 'pending', page: 99, pageSize: 2 })
    assert.equal(outOfRangePage.page, 2, '越界页码必须收敛到最后一页')
    assert.equal(outOfRangePage.records.length, 1)

    const verifiedPool = await inboundService.listInboundOrderPool(adminActor, { pool: 'verified', pageSize: 50 })
    assert.deepEqual(verifiedPool.records.map((order) => order.id), [verifiedDelivery.order.id], '已入库分栏只返回已入库单据')

    const keywordPool = await inboundService.listInboundOrderPool(adminActor, { keyword: soonerDelivery.order.showNo, pageSize: 50 })
    assert.deepEqual(keywordPool.records.map((order) => order.id), [soonerDelivery.order.id], '关键词必须按送货单号命中')

    // 新单提醒：以上一轮返回的 latestOrderId 为基准统计新增待入库单据。
    const baselineOrderId = allPool.latestOrderId
    assert.ok(baselineOrderId, '送货单池必须返回新单提醒基准')
    const newDelivery = await submitDelivery(hoursLater(10), 1)
    const afterNewOrder = await inboundService.listInboundOrderPool(adminActor, { sinceOrderId: baselineOrderId!, pageSize: 50 })
    assert.equal(afterNewOrder.newOrderCount, 1, '基准之后新增的待入库单据必须计入新单提醒')
    assert.equal(afterNewOrder.latestOrderId, String(newDelivery.order.id), '最新基准必须随新单推进')

    // 改单可调整预计送达时间，其余字段保持既有语义。
    const updatedArrivalAt = hoursLater(72)
    await inboundService.updateSupplierDelivery(supplierActor, newDelivery.order.id, {
      remark: '改单调整预计送达时间',
      expectedArrivalAt: updatedArrivalAt,
      items: [{ productId: String(product.id), skuId: String(sku.id), qty: 2 }],
    })
    const updatedDetail = await inboundService.detailById(newDelivery.order.id)
    assert.equal(
      updatedDetail.order.expectedArrivalAt?.toISOString(),
      new Date(updatedArrivalAt).toISOString(),
      '改单必须写入新的预计送达时间',
    )
    await inboundService.updateSupplierDelivery(supplierActor, newDelivery.order.id, {
      remark: '改单不传预计送达时间',
      items: [{ productId: String(product.id), skuId: String(sku.id), qty: 3 }],
    })
    const keptDetail = await inboundService.detailById(newDelivery.order.id)
    assert.equal(
      keptDetail.order.expectedArrivalAt?.toISOString(),
      new Date(updatedArrivalAt).toISOString(),
      '改单未传预计送达时间时必须保持原值',
    )

    // 管理端现场改单与供货方改单共用同一套入参：既然 schema 接受预计送达时间，就必须真正写入，
    // 否则接口返回成功而排班时间原封不动。
    const adminUpdatedArrivalAt = hoursLater(96)
    await inboundService.updateInboundOrderForAdmin(adminActor, newDelivery.order.id, {
      remark: '现场改单调整预计送达时间',
      expectedArrivalAt: adminUpdatedArrivalAt,
      items: [{ productId: String(product.id), skuId: String(sku.id), qty: 4 }],
    })
    const adminUpdatedDetail = await inboundService.detailById(newDelivery.order.id)
    assert.equal(
      adminUpdatedDetail.order.expectedArrivalAt?.toISOString(),
      new Date(adminUpdatedArrivalAt).toISOString(),
      '管理端现场改单必须写入新的预计送达时间',
    )
    await inboundService.updateInboundOrderForAdmin(adminActor, newDelivery.order.id, {
      remark: '现场改单不传预计送达时间',
      items: [{ productId: String(product.id), skuId: String(sku.id), qty: 5 }],
    })
    const adminKeptDetail = await inboundService.detailById(newDelivery.order.id)
    assert.equal(
      adminKeptDetail.order.expectedArrivalAt?.toISOString(),
      new Date(adminUpdatedArrivalAt).toISOString(),
      '管理端现场改单未传预计送达时间时必须保持原值',
    )
    await assert.rejects(
      () => inboundService.updateInboundOrderForAdmin(adminActor, newDelivery.order.id, {
        remark: '现场改单传入超范围时间',
        expectedArrivalAt: hoursLater(24 * 120),
        items: [{ productId: String(product.id), skuId: String(sku.id), qty: 5 }],
      }),
      /预计送达时间不能晚于 90 天后/,
      '管理端现场改单必须沿用与提交一致的范围校验',
    )

    // 权限边界：供货方即便持有 inbound:view，也不能访问管理端送货单池。
    await assert.rejects(
      () => inboundService.listInboundOrderPool(supplierActor, {}),
      /仅后台库管人员可查看送货单池/,
      '供货方访问送货单池必须被拒绝',
    )

    console.log('送货单池专项验证通过：分栏计数、排序、分页收敛、关键词、新单提醒、预计送达时间约束、现场改单写入与权限边界均符合预期')
  } finally {
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy()
    }
    cleanupSqliteFile()
  }
}

main().catch((error) => {
  console.error(`[inbound-admin-pool-verify] 验证失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  cleanupSqliteFile()
  process.exitCode = 1
})
