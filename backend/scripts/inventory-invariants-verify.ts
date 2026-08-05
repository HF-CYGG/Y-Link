/**
 * 文件说明：以可复现的随机入库序列验证 SKU/商品汇总库存与 InventoryLog 差量不变式。
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
const sqlitePath = path.resolve(sqliteRoot, `inventory-invariants-${verifySeed}.sqlite`)

process.env.APP_PROFILE = `inventory-invariants-${verifySeed}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'false'
process.env.SQLITE_DB_PATH = sqlitePath
process.env.INIT_ADMIN_PASSWORD = `Admin_${verifySeed}_Aa1!`

let randomState = 0x51a7c0de
const nextRandom = () => {
  randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0
  return randomState
}

function cleanup() {
  if (fs.existsSync(sqlitePath)) fs.rmSync(sqlitePath, { force: true })
}

async function main() {
  fs.mkdirSync(sqliteRoot, { recursive: true })
  const { AppDataSource } = await import('../src/config/data-source.js')
  const { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime } = await import('../src/config/database-bootstrap.js')
  const { BaseProduct } = await import('../src/entities/base-product.entity.js')
  const { BaseProductSku } = await import('../src/entities/base-product-sku.entity.js')
  const { InventoryLog } = await import('../src/entities/inventory-log.entity.js')
  const { SysUser } = await import('../src/entities/sys-user.entity.js')
  const { inboundService } = await import('../src/services/inbound.service.js')
  const { o2oPreorderService } = await import('../src/services/o2o-preorder.service.js')
  const { productService } = await import('../src/services/product.service.js')

  prepareDatabaseRuntime()
  await AppDataSource.initialize()
  try {
    await initializeDatabaseSchemaIfNeeded(AppDataSource)
    const userRepo = AppDataSource.getRepository(SysUser)
    const supplier = await userRepo.save(userRepo.create({
      username: `supplier-${verifySeed}`,
      passwordHash: 'verify-only',
      displayName: '库存不变式供货方',
      email: null,
      role: 'supplier',
      status: 'enabled',
      lastLoginAt: null,
    }))
    const supplierActor: AuthUserContext = {
      userId: String(supplier.id),
      username: supplier.username,
      displayName: supplier.displayName,
      role: 'supplier',
      permissions: [],
      status: 'enabled',
      sessionToken: 'inventory-invariant-supplier',
      authSource: 'bearer',
    }
    const adminActor: AuthUserContext = {
      ...supplierActor,
      userId: '999999',
      username: 'inventory-invariant-admin',
      displayName: '库存不变式库管',
      role: 'admin',
      sessionToken: 'inventory-invariant-admin',
    }

    const product = await productService.create({
      productName: `库存不变式商品-${verifySeed}`,
      pinyinAbbr: 'KCBBS',
      defaultPrice: 10,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'listed',
      limitPerUser: 100,
      specGroups: [{ name: '规格', values: ['A', 'B'] }],
      skus: [
        { skuCode: `INV-A-${verifySeed}`, specValues: { 规格: 'A' }, defaultPrice: 10, currentStock: 7, isActive: true },
        { skuCode: `INV-B-${verifySeed}`, specValues: { 规格: 'B' }, defaultPrice: 10, currentStock: 11, isActive: true },
      ],
    } as Parameters<typeof productService.create>[0])
    const skuIds = product.skus.map((sku) => String(sku.id))
    assert.equal(skuIds.length, 2)

    const assertAggregateInvariant = async () => {
      const productRow = await AppDataSource.getRepository(BaseProduct).findOneByOrFail({ id: product.id })
      const skuRows = (await AppDataSource.getRepository(BaseProductSku).find({ where: { productId: product.id } }))
        .filter((sku) => sku.isActive !== false && sku.isCurrent !== false)
      assert.equal(Number(productRow.currentStock), skuRows.reduce((sum, sku) => sum + Number(sku.currentStock), 0))
      assert.equal(Number(productRow.preOrderedStock), skuRows.reduce((sum, sku) => sum + Number(sku.preOrderedStock), 0))
    }

    await assertAggregateInvariant()
    for (let index = 0; index < 16; index += 1) {
      const skuId = skuIds[nextRandom() % skuIds.length]
      const qty = 1 + (nextRandom() % 5)
      assert.ok(skuId)
      const delivery = await inboundService.submitSupplierDelivery(supplierActor, {
        remark: `property-step-${index}`,
        items: [{ productId: product.id, skuId, qty }],
      })
      await inboundService.verifyInbound(delivery.order.verifyCode, adminActor)
      await assertAggregateInvariant()

      const log = await AppDataSource.getRepository(InventoryLog).findOne({
        where: { refType: 'biz_inbound_order', refId: String(delivery.order.id), changeType: 'inbound_sys' },
      })
      assert.ok(log)
      assert.equal(Number(log.afterCurrentStock) - Number(log.beforeCurrentStock), Number(log.changeQty))
      assert.equal(Number(log.afterPreorderedStock) - Number(log.beforePreorderedStock), 0)
      await assert.rejects(() => inboundService.verifyInbound(delivery.order.verifyCode, adminActor), /已入库/)
      await assertAggregateInvariant()
    }

    const manualSkuId = skuIds[0]
    assert.ok(manualSkuId)
    await o2oPreorderService.inboundStock(product.id, 3, adminActor, 'property-manual-inbound', manualSkuId)
    await assertAggregateInvariant()
    const manualLog = await AppDataSource.getRepository(InventoryLog).findOne({
      where: { refType: 'manual_inbound', refId: product.id, changeType: 'inbound' },
      order: { id: 'DESC' },
    })
    assert.ok(manualLog)
    assert.equal(Number(manualLog.afterCurrentStock) - Number(manualLog.beforeCurrentStock), Number(manualLog.changeQty))

    console.log('inventory invariants verify: passed (16 generated inbound lifecycles + manual inbound)')
  } finally {
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
    cleanup()
  }
}

main().catch((error) => {
  console.error(`[inventory-invariants-verify] failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
})
