/**
 * 文件说明：YZ 通用 SKU 编码体系「Excel 建库导入」验收脚本。
 * 用例说明：
 * 1. 真实 Excel 全量比对——读取评审提供的 yz-source.xlsx（123 行、46 组），预览应零错误、命中 3 条待确认项
 *    （品宣 11、品宣 20 两条多商品名 + 海右 9 一条轴歧义）；
 * 2. 未确认拒绝——不传 resolutions 直接确认导入应抛 400；
 * 3. 全量导入比对——传入与基准 JSON 口径一致的 resolutions 后确认导入，落库 46 个商品、123 条 SKU，
 *    逐条与 yz-import-baseline.json 的 skuCode 完全一致；
 * 4. 导入后续号——导入后对品宣、海右标签调用 allocateSeriesSeq 应分别得到 27、11；
 * 5. 重复导入被拒——同一文件再次确认导入应因序号已占用而报错；
 * 6. 缺系列编码报错——清空某标签的 seriesCode 后预览，对应行应报错且文案包含“系列编码”。
 * 若找不到评审提供的 Excel/基准 JSON，直接报错退出，不跳过用例。
 */

import 'reflect-metadata'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AuthUserContext } from '../src/types/auth.js'

const currentFilePath = fileURLToPath(import.meta.url)
const backendRoot = path.resolve(path.dirname(currentFilePath), '..')
const sqliteRoot = path.resolve(backendRoot, 'data', 'local-dev')
const verifySeed = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const sqlitePath = path.resolve(sqliteRoot, `product-import-yz-${verifySeed}.sqlite`)

process.env.APP_PROFILE = `product-import-yz-${verifySeed}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'false'
process.env.SQLITE_DB_PATH = sqlitePath
process.env.INIT_ADMIN_PASSWORD = `Admin_${verifySeed}_Aa1!`

const SCRATCHPAD_DIR = 'C:/Users/闫奕衡/AppData/Local/Temp/claude/F--Y-Link/fec18325-2de2-4b16-92c4-aa8a19e4a78d/scratchpad'
const EXCEL_PATH = path.join(SCRATCHPAD_DIR, 'yz-source.xlsx')
const BASELINE_PATH = path.join(SCRATCHPAD_DIR, 'yz-import-baseline.json')

interface BaselineRow {
  row: number
  series: string
  seriesCode: string
  seriesSeq: number
  productName: string
  productCode: string
  variantValue: string | null
  variantCode: string
  sizeValue: string | null
  sizeCode: string | null
  skuCode: string
  price: string
}

function pass(message: string) {
  console.log(`OK ${message}`)
}

function cleanupSqliteFile() {
  if (!fs.existsSync(sqlitePath)) return
  try {
    fs.rmSync(sqlitePath, { force: true })
  } catch (error) {
    console.warn(`[product-import-yz-verify] temporary SQLite cleanup skipped: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function main() {
  if (!fs.existsSync(EXCEL_PATH)) {
    throw new Error(`未找到评审提供的 Excel 文件：${EXCEL_PATH}，本脚本不允许跳过该用例，请确认文件存在后重跑`)
  }
  if (!fs.existsSync(BASELINE_PATH)) {
    throw new Error(`未找到评审提供的基准 JSON：${BASELINE_PATH}，本脚本不允许跳过该用例，请确认文件存在后重跑`)
  }
  const excelBuffer = fs.readFileSync(EXCEL_PATH)
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as BaselineRow[]
  assert.equal(baseline.length, 123, `基准 JSON 应有 123 条，实际 ${baseline.length}`)

  fs.mkdirSync(sqliteRoot, { recursive: true })

  const { AppDataSource } = await import('../src/config/data-source.js')
  const { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime } = await import('../src/config/database-bootstrap.js')
  const { systemConfigService } = await import('../src/services/system-config.service.js')
  const { BizError } = await import('../src/utils/errors.js')
  const { BaseTag } = await import('../src/entities/base-tag.entity.js')
  const { BaseProduct } = await import('../src/entities/base-product.entity.js')
  const { BaseProductSku } = await import('../src/entities/base-product-sku.entity.js')
  const { SysUser } = await import('../src/entities/sys-user.entity.js')
  const { productImportYzService } = await import('../src/services/product-import-yz.service.js')
  const { allocateSeriesSeq } = await import('../src/services/product-code.service.js')
  const { runInTransaction } = await import('../src/config/transaction-runner.js')

  prepareDatabaseRuntime()
  await AppDataSource.initialize()
  try {
    await initializeDatabaseSchemaIfNeeded(AppDataSource)
    await systemConfigService.ensureDefaultConfigs()

    const tagRepo = AppDataSource.getRepository(BaseTag)
    const productRepo = AppDataSource.getRepository(BaseProduct)
    const skuRepo = AppDataSource.getRepository(BaseProductSku)
    const userRepo = AppDataSource.getRepository(SysUser)

    const SERIES_TAGS: Array<{ tagName: string; seriesCode: string }> = [
      { tagName: '大汶口', seriesCode: 'DW' },
      { tagName: '品宣', seriesCode: 'PX' },
      { tagName: '海右', seriesCode: 'HY' },
      { tagName: '非遗', seriesCode: 'FY' },
    ]
    const tagByName = new Map<string, InstanceType<typeof BaseTag>>()
    for (const item of SERIES_TAGS) {
      const tag = await tagRepo.save(tagRepo.create({ tagName: item.tagName, tagCode: null, seriesCode: item.seriesCode }))
      tagByName.set(item.tagName, tag)
    }

    const admin = await userRepo.save(userRepo.create({
      username: `import-yz-admin-${verifySeed}`,
      passwordHash: 'verify-only',
      displayName: 'YZ 建库导入验证管理员',
      email: null,
      role: 'admin',
      status: 'enabled',
      lastLoginAt: null,
    }))
    const actor: AuthUserContext = {
      userId: String(admin.id), username: admin.username, displayName: admin.displayName,
      role: 'admin', permissions: [], status: 'enabled',
      sessionToken: 'product-import-yz-verify', authSource: 'bearer',
    }

    // ============ 用例 1：真实 Excel 全量比对 ============
    const preview = await productImportYzService.preview(excelBuffer)
    assert.equal(preview.rows.length, 123, `预览应解析出 123 行，实际 ${preview.rows.length}`)
    assert.equal(preview.groups.length, 46, `预览应分出 46 组，实际 ${preview.groups.length}`)
    assert.equal(preview.errorCount, 0, `预览应零错误，实际 ${preview.errorCount}；首个错误：${preview.rows.find((row) => row.errors.length)?.errors.join('；') ?? '无'}`)
    assert.equal(preview.pendingConfirmCount, 3, `预览应命中 3 条待确认项，实际 ${preview.pendingConfirmCount}`)

    const px11 = preview.groups.find((group) => group.seriesCode === 'PX' && group.seriesSeq === 11)
    const px20 = preview.groups.find((group) => group.seriesCode === 'PX' && group.seriesSeq === 20)
    const hy9 = preview.groups.find((group) => group.seriesCode === 'HY' && group.seriesSeq === 9)
    assert.ok(px11 && px11.pendingConfirms.some((item) => item.kind === 'multi_product_name'), '品宣 11 应命中多商品名待确认项')
    assert.ok(px20 && px20.pendingConfirms.some((item) => item.kind === 'multi_product_name'), '品宣 20 应命中多商品名待确认项')
    assert.ok(hy9 && hy9.pendingConfirms.some((item) => item.kind === 'axis_ambiguous'), '海右 9 应命中轴歧义待确认项')
    pass('真实 Excel 全量比对：rows=123、groups=46、errorCount=0、pendingConfirmCount=3，且待确认项精确落在品宣 11/20、海右 9')

    // ============ 用例 2：未确认拒绝 ============
    await assert.rejects(
      productImportYzService.importProducts(excelBuffer, [], actor),
      (error: unknown) => error instanceof BizError && error.statusCode === 400,
      '不传 resolutions 直接确认导入应抛 400',
    )
    pass('未确认拒绝：不传 resolutions 直接确认导入抛 400')

    // ============ 用例 3：全量导入比对 ============
    const resolutions = [
      { groupKey: `PX|11`, kind: 'multi_product_name' as const, value: px11!.productNames[0] },
      { groupKey: `PX|20`, kind: 'multi_product_name' as const, value: px20!.productNames[0] },
      { groupKey: `HY|9`, kind: 'axis_ambiguous' as const, value: 'variant' },
    ]
    const importResult = await productImportYzService.importProducts(excelBuffer, resolutions, actor)
    assert.equal(importResult.productCount, 46, `应落库 46 个商品，实际 ${importResult.productCount}`)
    assert.equal(importResult.skuCount, 123, `应落库 123 条 SKU，实际 ${importResult.skuCount}`)

    const allSkus = await skuRepo.find()
    const allProducts = await productRepo.find()
    const productById = new Map(allProducts.map((product) => [product.id, product]))
    const skuCodeSet = new Set(allSkus.map((sku) => sku.skuCode))
    assert.equal(skuCodeSet.size, 123, `库内应有 123 个互不重复的 SKU 编码，实际 ${skuCodeSet.size}`)

    for (const expected of baseline) {
      assert.ok(skuCodeSet.has(expected.skuCode), `基准 SKU 编码 ${expected.skuCode}（第 ${expected.row} 行，${expected.productName}）应存在于库内`)
    }
    // 反向比对：库内每条 SKU 也必须能在基准中找到（数量已相等，逐一存在即保证一一对应）。
    const baselineCodeSet = new Set(baseline.map((item) => item.skuCode))
    for (const sku of allSkus) {
      assert.ok(baselineCodeSet.has(sku.skuCode), `库内 SKU 编码 ${sku.skuCode} 不在基准 JSON 中，产品：${productById.get(sku.productId)?.productName ?? sku.productId}`)
    }
    pass('全量导入比对：落库 46 个商品、123 条 SKU，逐条 skuCode 与基准 JSON 完全一致（双向比对）')

    // ============ 用例 4：导入后续号 ============
    const pxNextSeq = await runInTransaction((manager) => allocateSeriesSeq(manager, tagByName.get('品宣')!.id))
    assert.equal(pxNextSeq, 27, `品宣系列导入后下一个序号应为 27，实际 ${pxNextSeq}`)
    const hyNextSeq = await runInTransaction((manager) => allocateSeriesSeq(manager, tagByName.get('海右')!.id))
    assert.equal(hyNextSeq, 11, `海右系列导入后下一个序号应为 11，实际 ${hyNextSeq}`)
    pass('导入后续号：品宣 allocateSeriesSeq=27，海右 allocateSeriesSeq=11')

    // ============ 用例 5：重复导入被拒 ============
    await assert.rejects(
      productImportYzService.importProducts(excelBuffer, resolutions, actor),
      (error: unknown) => error instanceof BizError,
      '同一文件重复确认导入应因序号已占用而报错',
    )
    pass('重复导入被拒：再次确认导入同一文件因序号已占用而报错')

    // ============ 用例 6：缺系列编码报错 ============
    const dwTag = tagByName.get('大汶口')!
    await tagRepo.update({ id: dwTag.id }, { seriesCode: null })
    const previewMissingSeriesCode = await productImportYzService.preview(excelBuffer)
    const dwRows = previewMissingSeriesCode.rows.filter((row) => row.category === '大汶口')
    assert.ok(dwRows.length > 0, '大汶口品类应仍有对应行')
    assert.ok(dwRows.every((row) => row.errors.some((message) => message.includes('系列编码'))), '大汶口品类清空系列编码后，对应行应报错且文案包含“系列编码”')
    assert.ok(previewMissingSeriesCode.errorCount > 0, '清空系列编码后预览应出现错误行')
    pass('缺系列编码报错：清空大汶口标签的系列编码后，对应行报错且文案包含“系列编码”')
  } finally {
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy()
    }
    cleanupSqliteFile()
  }
}

main().catch((error) => {
  console.error(`[product-import-yz-verify] verification failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  cleanupSqliteFile()
  process.exitCode = 1
})
