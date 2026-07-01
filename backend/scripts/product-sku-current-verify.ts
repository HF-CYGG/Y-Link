import 'reflect-metadata'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const currentFilePath = fileURLToPath(import.meta.url)
const backendRoot = path.resolve(path.dirname(currentFilePath), '..')
const sqliteRoot = path.resolve(backendRoot, 'data', 'local-dev')
const verifySeed = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const sqlitePath = path.resolve(sqliteRoot, `product-sku-current-${verifySeed}.sqlite`)

process.env.APP_PROFILE = `product-sku-current-${verifySeed}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'false'
process.env.SQLITE_DB_PATH = sqlitePath
process.env.INIT_ADMIN_PASSWORD = `Admin_${verifySeed}_Aa1!`

type ProductSkuViewLike = {
  id: string
  skuCode: string
  specText: string
  currentStock: number
  isActive: boolean
  isCurrent?: boolean
}

type RawSkuRow = {
  id: string
  skuCode: string
  specText: string
  currentStock: number
  preOrderedStock: number
  isActive: number
  isCurrent: number
  o2oRecommended: number
}

function pass(message: string) {
  console.log(`OK ${message}`)
}

function cleanupSqliteFile() {
  if (!fs.existsSync(sqlitePath)) {
    return
  }
  try {
    fs.rmSync(sqlitePath, { force: true })
  } catch (error) {
    console.warn(`[product-sku-current-verify] temporary SQLite cleanup skipped: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function readSkuRows(
  dataSource: typeof import('../src/config/data-source.js').AppDataSource,
  productId: string,
): Promise<RawSkuRow[]> {
  return dataSource.query(
    `
      SELECT
        "id",
        "sku_code" AS "skuCode",
        "spec_text" AS "specText",
        "current_stock" AS "currentStock",
        "pre_ordered_stock" AS "preOrderedStock",
        "is_active" AS "isActive",
        "is_current" AS "isCurrent",
        "o2o_recommended" AS "o2oRecommended"
      FROM "base_product_sku"
      WHERE "product_id" = ?
      ORDER BY "sort_order" ASC, "id" ASC
    `,
    [productId],
  ) as Promise<RawSkuRow[]>
}

function findSkuByText(skus: ProductSkuViewLike[], specText: string): ProductSkuViewLike {
  const sku = skus.find((item) => item.specText === specText)
  assert.ok(sku, `missing SKU ${specText}`)
  return sku
}

async function main() {
  fs.mkdirSync(sqliteRoot, { recursive: true })

  const { AppDataSource } = await import('../src/config/data-source.js')
  const { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime } = await import('../src/config/database-bootstrap.js')
  const { o2oPreorderService } = await import('../src/services/o2o-preorder.service.js')
  const { productService } = await import('../src/services/product.service.js')
  const { systemConfigService } = await import('../src/services/system-config.service.js')

  prepareDatabaseRuntime()
  await AppDataSource.initialize()
  try {
    await initializeDatabaseSchemaIfNeeded(AppDataSource)
    await systemConfigService.ensureDefaultConfigs()

    const stockProduct = await productService.create({
      productName: `current-stock-${verifySeed}`,
      pinyinAbbr: 'CS',
      defaultPrice: 10,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'listed',
      currentStock: 100,
      limitPerUser: 20,
      specGroups: [{ name: 'Color', values: ['Blue', 'Red'] }],
      skus: [
        {
          skuCode: `SKU-CURRENT-BLUE-${verifySeed}`,
          specValues: { Color: 'Blue' },
          defaultPrice: 10,
          currentStock: 7,
          isActive: true,
          o2oRecommended: true,
          sortOrder: 0,
        },
        {
          skuCode: `SKU-CURRENT-RED-${verifySeed}`,
          specValues: { Color: 'Red' },
          defaultPrice: 12,
          currentStock: 90,
          isActive: true,
          o2oRecommended: true,
          sortOrder: 1,
        },
      ],
    } as Parameters<typeof productService.create>[0])

    const blueSku = findSkuByText(stockProduct.skus, 'Blue')
    const redSku = findSkuByText(stockProduct.skus, 'Red')
    const stockProductAfterRemove = await productService.update(stockProduct.id, {
      specGroups: [{ name: 'Color', values: ['Blue'] }],
      skus: [
        {
          id: blueSku.id,
          skuCode: blueSku.skuCode,
          specValues: { Color: 'Blue' },
          defaultPrice: 10,
          currentStock: 7,
          isActive: true,
          o2oRecommended: true,
          sortOrder: 0,
        },
      ],
    } as Parameters<typeof productService.update>[1])

    assert.deepEqual(stockProductAfterRemove.skus.map((sku) => sku.specText), ['Blue'])
    assert.equal(stockProductAfterRemove.currentStock, 7)
    assert.equal(stockProductAfterRemove.preOrderedStock, 0)
    assert.equal(stockProductAfterRemove.availableStock, 7)
    const stockRows = await readSkuRows(AppDataSource, stockProduct.id)
    assert.equal(stockRows.find((sku) => String(sku.id) === blueSku.id)?.isCurrent, 1)
    assert.equal(stockRows.find((sku) => String(sku.id) === redSku.id)?.isCurrent, 0)
    assert.equal(stockRows.find((sku) => String(sku.id) === redSku.id)?.isActive, 0)
    assert.equal(stockRows.find((sku) => String(sku.id) === redSku.id)?.o2oRecommended, 0)
    const stockMallProduct = (await o2oPreorderService.listMallProducts()).list.find((item) => item.id === stockProduct.id)
    assert.ok(stockMallProduct)
    assert.equal(stockMallProduct.currentStock, 7)
    assert.deepEqual(stockMallProduct.skus?.map((sku) => sku.specText), ['Blue'])
    await assert.rejects(
      () => o2oPreorderService.submit(
        {
          userId: `missing-client-${verifySeed}`,
          account: 'verify-client',
          mobile: '',
          email: '',
          realName: 'Verify Client',
          accountType: 'personal',
          staffNo: null,
          sessionToken: 'verify-session',
        },
        {
          items: [{ productId: stockProduct.id, skuId: redSku.id, qty: 1 }],
          isSystemApplied: false,
          pickupContact: 'Verify Client',
        },
      ),
      (error: unknown) => typeof error === 'object'
        && error !== null
        && 'statusCode' in error
        && (error as { statusCode?: number }).statusCode === 409,
      'archived SKU should not be accepted by the preorder submit path',
    )
    pass('archived SKU is retained in database but excluded from product and mall stock')

    const identityProduct = await productService.create({
      productName: `current-identity-${verifySeed}`,
      pinyinAbbr: 'CI',
      defaultPrice: 5,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'listed',
      currentStock: 20,
      limitPerUser: 20,
      specGroups: [{ name: 'Color', values: ['Red', 'Blue'] }],
      skus: [
        { specValues: { Color: 'Red' }, defaultPrice: 5, currentStock: 11, isActive: true, sortOrder: 0 },
        { specValues: { Color: 'Blue' }, defaultPrice: 6, currentStock: 12, isActive: true, sortOrder: 1 },
      ],
    } as Parameters<typeof productService.create>[0])
    const originalRedSku = findSkuByText(identityProduct.skus, 'Red')
    const identityProductAfterChange = await productService.update(identityProduct.id, {
      specGroups: [{ name: 'Color', values: ['Green'] }],
      skus: [
        { specValues: { Color: 'Green' }, defaultPrice: 9, currentStock: 6, isActive: true, sortOrder: 0 },
      ],
    } as Parameters<typeof productService.update>[1])
    assert.deepEqual(identityProductAfterChange.skus.map((sku) => sku.specText), ['Green'])
    assert.notEqual(identityProductAfterChange.skus[0]?.id, originalRedSku.id)
    const identityRows = await readSkuRows(AppDataSource, identityProduct.id)
    const archivedRedRow = identityRows.find((sku) => String(sku.id) === originalRedSku.id)
    assert.equal(archivedRedRow?.specText, 'Red')
    assert.equal(archivedRedRow?.isCurrent, 0)
    assert.equal(new Set(identityRows.map((sku) => sku.skuCode)).size, identityRows.length)
    pass('changing a spec key does not mutate the historical SKU row or collide with archived skuCode')

    const defaultSwitchProduct = await productService.create({
      productName: `current-default-${verifySeed}`,
      pinyinAbbr: 'CD',
      defaultPrice: 9,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'listed',
      currentStock: 99,
      limitPerUser: 20,
      specGroups: [{ name: 'Color', values: ['Black', 'White'] }],
      skus: [
        {
          skuCode: `SKU-DEFAULT-BLACK-${verifySeed}`,
          specValues: { Color: 'Black' },
          defaultPrice: 9,
          currentStock: 11,
          isActive: true,
          sortOrder: 0,
        },
        {
          skuCode: `SKU-DEFAULT-WHITE-${verifySeed}`,
          specValues: { Color: 'White' },
          defaultPrice: 9,
          currentStock: 13,
          isActive: true,
          sortOrder: 1,
        },
      ],
    } as Parameters<typeof productService.create>[0])
    const defaultSwitchAfterUpdate = await productService.update(defaultSwitchProduct.id, {
      defaultPrice: 9,
      discountRate: 10,
      currentStock: 49,
      skus: [],
    } as Parameters<typeof productService.update>[1])
    assert.equal(defaultSwitchAfterUpdate.skus.length, 1)
    assert.equal(defaultSwitchAfterUpdate.skus[0]?.specText, '默认规格')
    assert.equal(defaultSwitchAfterUpdate.currentStock, 49)
    assert.equal(defaultSwitchAfterUpdate.availableStock, 49)
    const defaultSwitchRows = await readSkuRows(AppDataSource, defaultSwitchProduct.id)
    assert.equal(defaultSwitchRows.filter((sku) => sku.isCurrent === 1).length, 1)
    assert.equal(defaultSwitchRows.filter((sku) => sku.isCurrent === 0).length, 2)
    pass('switching a multi-SKU product back to default SKU does not keep old stock in totals')
  } finally {
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy()
    }
    cleanupSqliteFile()
  }
}

main().catch((error) => {
  console.error(`[product-sku-current-verify] verification failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
})
