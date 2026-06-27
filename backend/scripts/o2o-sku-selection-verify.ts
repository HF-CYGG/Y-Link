/**
 * 模块说明：backend/scripts/o2o-sku-selection-verify.ts
 * 文件职责：验证 O2O 商品规格 SKU 的创建、商城展示、下单快照、改单、撤回、核销与退货库存链路。
 * 实现逻辑：
 * - 使用独立 SQLite 数据库启动真实服务层，避免污染本地开发数据；
 * - 创建一个带颜色和款式 SKU 的商品，确认后台服务与商城接口都返回规格结构；
 * - 使用指定 skuId 下单、改单、撤回、核销和退货核销，确认库存始终落在 SKU 维度；
 * - 同时校验订单明细和退货明细都保留 SKU、规格文本与价格快照。
 * 维护说明：
 * - 如果后续调整 SKU 字段名或 O2O 状态流转，需要同步更新本脚本的断言；
 * - 本脚本覆盖 SKU 主链路，权限与完整 O2O 回归继续由既有验证脚本覆盖。
 */

import 'reflect-metadata'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const currentFilePath = fileURLToPath(import.meta.url)
const backendRoot = path.resolve(path.dirname(currentFilePath), '..')
const sqliteRoot = path.resolve(backendRoot, 'data', 'local-dev')
const verifySeed = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const sqlitePath = path.resolve(sqliteRoot, `o2o-sku-selection-${verifySeed}.sqlite`)

process.env.APP_PROFILE = `o2o-sku-selection-${verifySeed}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'false'
process.env.SQLITE_DB_PATH = sqlitePath
process.env.INIT_ADMIN_PASSWORD = `Admin_${verifySeed}_Aa1!`

import type { ClientAuthContext } from '../src/types/client-auth.js'
import type { AuthUserContext } from '../src/types/auth.js'

function pass(message: string) {
  console.log(`OK ${message}`)
}

function readCaptchaCode(captchaSvg: string) {
  return captchaSvg.replaceAll(/<[^>]*>/g, '').replaceAll(/\s+/g, '').slice(0, 6)
}

async function registerAndLoginClient(clientAuthService: typeof import('../src/services/client-auth.service.js').clientAuthService): Promise<ClientAuthContext> {
  const seed = String(Date.now()).slice(-10)
  const password = `Client@${seed.slice(-6)}`
  const registerCaptcha = await clientAuthService.createCaptcha()
  const registerResult = await clientAuthService.register({
    accountType: 'personal',
    account: `1${seed}`,
    username: '规格验证用户',
    password,
    captchaId: registerCaptcha.captchaId,
    captchaCode: readCaptchaCode(registerCaptcha.captchaSvg),
  })
  const loginCaptcha = await clientAuthService.createCaptcha()
  const loginResult = await clientAuthService.login({
    account: registerResult.user.mobile,
    password,
    captchaId: loginCaptcha.captchaId,
    captchaCode: readCaptchaCode(loginCaptcha.captchaSvg),
  })
  return clientAuthService.resolveClientByToken(loginResult.token)
}

function cleanupSqliteFile() {
  if (!fs.existsSync(sqlitePath)) {
    return
  }
  try {
    fs.rmSync(sqlitePath, { force: true })
  } catch (error) {
    console.warn(`[o2o-sku-selection-verify] 临时 SQLite 文件删除失败，已忽略：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function main() {
  fs.mkdirSync(sqliteRoot, { recursive: true })

  const { AppDataSource } = await import('../src/config/data-source.js')
  const { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime } = await import('../src/config/database-bootstrap.js')
  const { clientAuthService } = await import('../src/services/client-auth.service.js')
  const { o2oPreorderService } = await import('../src/services/o2o-preorder.service.js')
  const { productService } = await import('../src/services/product.service.js')
  const { systemConfigService } = await import('../src/services/system-config.service.js')

  prepareDatabaseRuntime()
  await AppDataSource.initialize()
  try {
    await initializeDatabaseSchemaIfNeeded(AppDataSource)
    await systemConfigService.ensureDefaultConfigs()

    const product = await productService.create({
      productName: `规格验证商品-${verifySeed}`,
      pinyinAbbr: 'GGYZ',
      defaultPrice: 10,
      discountRate: 9.5,
      isActive: true,
      o2oStatus: 'listed',
      currentStock: 18,
      limitPerUser: 8,
      specGroups: [
        { name: '颜色', values: ['冰川白', '天空蓝'] },
        { name: '款式', values: ['六寸-三层', '六寸-五层'] },
      ],
      skus: [
        {
          skuCode: `SKU-WHITE-3-${verifySeed}`,
          specValues: { 颜色: '冰川白', 款式: '六寸-三层' },
          defaultPrice: 12,
          currentStock: 5,
          isActive: true,
          sortOrder: 1,
        },
        {
          skuCode: `SKU-BLUE-5-${verifySeed}`,
          specValues: { 颜色: '天空蓝', 款式: '六寸-五层' },
          defaultPrice: 16,
          currentStock: 7,
          isActive: true,
          sortOrder: 2,
        },
      ],
    } as Parameters<typeof productService.create>[0])

    const createdSkus = (product as unknown as { skus?: Array<{ id: string; specText: string; availableStock: number }> }).skus ?? []
    assert.equal(createdSkus.length, 2)
    const targetSku = createdSkus.find((sku) => sku.specText === '天空蓝 / 六寸-五层')
    const otherSku = createdSkus.find((sku) => sku.specText === '冰川白 / 六寸-三层')
    assert.ok(targetSku)
    assert.ok(otherSku)
    assert.equal(targetSku.availableStock, 7)
    pass('商品服务返回规格组与 SKU 列表')

    const mallProducts = await o2oPreorderService.listMallProducts()
    const mallProduct = mallProducts.list.find((item) => item.id === product.id) as unknown as {
      skus?: Array<{ id: string; specText: string; discountedPrice: string; availableStock: number }>
    } | undefined
    assert.ok(mallProduct)
    assert.equal(mallProduct.skus?.length, 2)
    const mallSku = mallProduct.skus?.find((sku) => sku.id === targetSku.id)
    assert.ok(mallSku)
    assert.equal(mallSku.discountedPrice, '15.20')
    assert.equal(mallSku.availableStock, 7)
    pass('商城接口返回 SKU 价格与可售库存')

    const clientAuth = await registerAndLoginClient(clientAuthService)
    const preorder = await o2oPreorderService.submit(clientAuth, {
      items: [{ productId: product.id, skuId: targetSku.id, qty: 2 }],
      remark: '规格 SKU 下单验证',
      pickupContact: '规格验证提货人',
      isSystemApplied: false,
    })
    assert.equal(preorder.order.totalAmount, '30.40')
    assert.equal(preorder.items[0]?.productId, product.id)
    assert.equal(preorder.items[0]?.skuId, targetSku.id)
    assert.equal(preorder.items[0]?.specText, '天空蓝 / 六寸-五层')
    assert.equal(preorder.items[0]?.originalPrice, '16.00')
    assert.equal(preorder.items[0]?.discountRate, '9.5')
    assert.equal(preorder.items[0]?.unitPrice, '15.20')
    assert.equal(preorder.items[0]?.lineAmount, '30.40')
    pass('下单保存 SKU、规格文本和价格快照')

    const mallProductsAfterSubmit = await o2oPreorderService.listMallProducts()
    const mallProductAfterSubmit = mallProductsAfterSubmit.list.find((item) => item.id === product.id) as unknown as {
      skus?: Array<{ id: string; preOrderedStock: number; availableStock: number }>
    } | undefined
    assert.equal(mallProductAfterSubmit?.skus?.find((sku) => sku.id === targetSku.id)?.preOrderedStock, 2)
    assert.equal(mallProductAfterSubmit?.skus?.find((sku) => sku.id === targetSku.id)?.availableStock, 5)
    pass('下单后按 SKU 占用库存')

    await productService.update(product.id, {
      skus: [
        {
          id: targetSku.id,
          specValues: { 颜色: '天空蓝', 款式: '六寸-五层' },
          defaultPrice: 16,
          currentStock: 7,
          isActive: true,
        },
        {
          id: otherSku.id,
          specValues: { 颜色: '冰川白', 款式: '六寸-三层' },
          defaultPrice: 12,
          currentStock: 5,
          isActive: true,
        },
      ],
    } as Parameters<typeof productService.update>[1])
    const mallProductsAfterProductEdit = await o2oPreorderService.listMallProducts()
    const mallProductAfterProductEdit = mallProductsAfterProductEdit.list.find((item) => item.id === product.id) as unknown as {
      skus?: Array<{ id: string; preOrderedStock: number; availableStock: number }>
    } | undefined
    assert.equal(mallProductAfterProductEdit?.skus?.find((sku) => sku.id === targetSku.id)?.preOrderedStock, 2)
    assert.equal(mallProductAfterProductEdit?.skus?.find((sku) => sku.id === targetSku.id)?.availableStock, 5)
    pass('商品编辑不清空 SKU 占用库存')

    const defaultProduct = await productService.create({
      productName: `默认规格同步商品-${verifySeed}`,
      pinyinAbbr: 'MRGG',
      defaultPrice: 8,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'listed',
      currentStock: 4,
      limitPerUser: 4,
    } as Parameters<typeof productService.create>[0])
    const defaultSkuId = defaultProduct.skus[0]?.id
    assert.ok(defaultSkuId)
    await productService.update(defaultProduct.id, {
      defaultPrice: 9,
      discountRate: 8,
      currentStock: 6,
    } as Parameters<typeof productService.update>[1])
    const defaultProductAfterUpdate = await productService.detail(defaultProduct.id)
    assert.equal(defaultProductAfterUpdate.currentStock, 6)
    assert.equal(defaultProductAfterUpdate.availableStock, 6)
    assert.equal(defaultProductAfterUpdate.skus[0]?.id, defaultSkuId)
    assert.equal(defaultProductAfterUpdate.skus[0]?.defaultPrice, '9.00')
    assert.equal(defaultProductAfterUpdate.skus[0]?.discountRate, '8.0')
    assert.equal(defaultProductAfterUpdate.skus[0]?.availableStock, 6)
    pass('默认 SKU 商品主表单价格与库存同步到 SKU')

    const updatedPreorder = await o2oPreorderService.updateMyOrder(clientAuth, preorder.order.id, {
      items: [
        { productId: product.id, skuId: targetSku.id, qty: 3 },
        { productId: product.id, skuId: otherSku.id, qty: 1 },
      ],
      remark: '规格 SKU 改单验证',
    })
    assert.equal(updatedPreorder.items.length, 2)
    assert.deepEqual(
      updatedPreorder.items.map((item) => ({ skuId: item.skuId, qty: item.qty })).sort((left, right) => String(left.skuId).localeCompare(String(right.skuId))),
      [
        { skuId: otherSku.id, qty: 1 },
        { skuId: targetSku.id, qty: 3 },
      ].sort((left, right) => left.skuId.localeCompare(right.skuId)),
    )
    const mallProductsAfterUpdate = await o2oPreorderService.listMallProducts()
    const mallProductAfterUpdate = mallProductsAfterUpdate.list.find((item) => item.id === product.id) as unknown as {
      skus?: Array<{ id: string; preOrderedStock: number }>
    } | undefined
    assert.equal(mallProductAfterUpdate?.skus?.find((sku) => sku.id === targetSku.id)?.preOrderedStock, 3)
    assert.equal(mallProductAfterUpdate?.skus?.find((sku) => sku.id === otherSku.id)?.preOrderedStock, 1)
    pass('改单后按 SKU 维持独立占用')

    await productService.update(product.id, {
      skus: [
        {
          id: targetSku.id,
          specValues: { 颜色: '天空蓝', 款式: '六寸-五层' },
          defaultPrice: 16,
          currentStock: 7,
          isActive: true,
        },
      ],
    } as Parameters<typeof productService.update>[1])
    const productAfterRemovingOccupiedSku = await productService.detail(product.id)
    assert.equal(productAfterRemovingOccupiedSku.preOrderedStock, 4)
    assert.equal(productAfterRemovingOccupiedSku.skus.find((sku) => sku.id === otherSku.id)?.isActive, false)
    const mallProductsAfterRemovingOccupiedSku = await o2oPreorderService.listMallProducts()
    const mallProductAfterRemovingOccupiedSku = mallProductsAfterRemovingOccupiedSku.list.find((item) => item.id === product.id) as unknown as {
      availableStock: number
      skus?: Array<{ id: string; isActive: boolean; availableStock: number }>
    } | undefined
    assert.equal(mallProductAfterRemovingOccupiedSku?.availableStock, 4)
    assert.equal(mallProductAfterRemovingOccupiedSku?.skus?.find((sku) => sku.id === otherSku.id)?.isActive, false)
    pass('删除仍有占用的 SKU 后保留主商品占用汇总')

    const inactiveProduct = await productService.create({
      productName: `停用规格商品-${verifySeed}`,
      pinyinAbbr: 'TYGG',
      defaultPrice: 6,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'listed',
      currentStock: 3,
      limitPerUser: 3,
      specGroups: [{ name: '颜色', values: ['灰色'] }],
      skus: [{
        skuCode: `SKU-INACTIVE-${verifySeed}`,
        specValues: { 颜色: '灰色' },
        defaultPrice: 6,
        currentStock: 3,
        isActive: false,
      }],
    } as Parameters<typeof productService.create>[0])
    const mallProductsWithInactiveSku = await o2oPreorderService.listMallProducts()
    const inactiveMallProduct = mallProductsWithInactiveSku.list.find((item) => item.id === inactiveProduct.id) as unknown as {
      availableStock: number
      skus?: Array<{ isActive: boolean; availableStock: number }>
    } | undefined
    assert.equal(inactiveMallProduct?.availableStock, 0)
    assert.equal(inactiveMallProduct?.skus?.[0]?.isActive, false)
    pass('全停用 SKU 商品在商城不展示可售库存')

    const cancelPreorder = await o2oPreorderService.submit(clientAuth, {
      items: [{ productId: product.id, skuId: targetSku.id, qty: 1 }],
      remark: '规格 SKU 撤回验证',
      pickupContact: '规格验证提货人',
      isSystemApplied: false,
    })
    await o2oPreorderService.cancelMyOrder(clientAuth, cancelPreorder.order.id)
    const mallProductsAfterCancel = await o2oPreorderService.listMallProducts()
    const mallProductAfterCancel = mallProductsAfterCancel.list.find((item) => item.id === product.id) as unknown as {
      skus?: Array<{ id: string; preOrderedStock: number }>
    } | undefined
    assert.equal(mallProductAfterCancel?.skus?.find((sku) => sku.id === targetSku.id)?.preOrderedStock, 3)
    assert.equal(mallProductAfterCancel?.skus?.find((sku) => sku.id === otherSku.id)?.preOrderedStock, 1)
    pass('撤回后仅释放对应 SKU 占用')

    const adminActor = {
      userId: '1',
      username: 'admin',
      displayName: '验证管理员',
      roles: ['admin'],
      permissions: ['orders:verify'],
    } satisfies AuthUserContext

    await o2oPreorderService.verifyByCode(updatedPreorder.order.verifyCode, adminActor)
    const mallProductsAfterVerify = await o2oPreorderService.listMallProducts()
    const mallProductAfterVerify = mallProductsAfterVerify.list.find((item) => item.id === product.id) as unknown as {
      skus?: Array<{ id: string; currentStock: number; preOrderedStock: number }>
    } | undefined
    assert.equal(mallProductAfterVerify?.skus?.find((sku) => sku.id === targetSku.id)?.currentStock, 4)
    assert.equal(mallProductAfterVerify?.skus?.find((sku) => sku.id === targetSku.id)?.preOrderedStock, 0)
    assert.equal(mallProductAfterVerify?.skus?.find((sku) => sku.id === otherSku.id)?.currentStock, 4)
    assert.equal(mallProductAfterVerify?.skus?.find((sku) => sku.id === otherSku.id)?.preOrderedStock, 0)
    pass('核销后按 SKU 扣减现货与占用库存')

    const returnRequest = await o2oPreorderService.createReturnRequest(clientAuth, updatedPreorder.order.id, {
      reason: '规格 SKU 退货验证',
      items: [{ productId: product.id, skuId: targetSku.id, qty: 1 }],
    })
    assert.equal(returnRequest.items[0]?.skuId, targetSku.id)
    await o2oPreorderService.verifyByCode(returnRequest.verifyCode, adminActor)
    const mallProductsAfterReturn = await o2oPreorderService.listMallProducts()
    const mallProductAfterReturn = mallProductsAfterReturn.list.find((item) => item.id === product.id) as unknown as {
      skus?: Array<{ id: string; currentStock: number }>
    } | undefined
    assert.equal(mallProductAfterReturn?.skus?.find((sku) => sku.id === targetSku.id)?.currentStock, 5)
    assert.equal(mallProductAfterReturn?.skus?.find((sku) => sku.id === otherSku.id)?.currentStock, 4)
    pass('退货核销后仅回补对应 SKU 现货')
  } finally {
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy()
    }
    cleanupSqliteFile()
  }
}

main().catch((error) => {
  console.error(`[o2o-sku-selection-verify] 验证失败: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
})
