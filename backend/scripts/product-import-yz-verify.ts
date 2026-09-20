/**
 * 文件说明：YZ 通用 SKU 编码体系「Excel 建库导入」验收脚本。
 * PR #109 第四轮评审 P2 修复：原脚本把 Excel 与基准 JSON 的路径写死在某台开发机的 Windows 临时目录，
 * 这两个文件未提交进仓库，其他开发机与 CI 执行本脚本必然在用例开始前失败。现在默认使用仓库内的脱敏
 * 夹具（backend/scripts/fixtures/product-import-yz-fixture.ts 现场生成 Excel + 同目录
 * product-import-yz-baseline.json 提供基准），不依赖任何外部文件、不设置任何环境变量也能独立跑通；
 * 同时支持 YZ_IMPORT_FIXTURE_XLSX / YZ_IMPORT_BASELINE_JSON 两个环境变量覆盖为真实数据做全量比对
 * （两者必须同时提供，缺一视为配置错误直接报错，不做静默降级）。
 * 用例说明：
 * 1. 全量比对——预览应零错误，且命中夹具设计好的待确认项（脱敏夹具为 2 条：TB-1 多商品名 +
 *    TB-2 轴歧义；真实数据模式沿用评审原始口径：123 行、46 组、3 条待确认项）；
 * 2. 未确认拒绝——不传 resolutions 直接确认导入应抛 400；
 * 3. 全量导入比对——传入 resolutions 后确认导入，落库数量与基准一致，逐条与基准 JSON 的 skuCode/
 *    productCode 完全一致（双向比对）；
 * 4. 导入后续号——导入后对涉及的系列标签调用 allocateSeriesSeq 应得到基准数据之外的下一个序号；
 * 5. 重复导入被拒——同一份夹具再次确认导入应因序号已占用而报错；
 * 6. 缺系列编码报错——清空某标签的 seriesCode 后预览，对应行应报错且文案包含"系列编码"；
 * 7. 规格取值超长报错（P2-D）——「款式/颜色」「尺码」单元格超过 64 字符时预览阶段即报错，与所选夹具
 *    模式无关，用 ExcelJS 在内存里现造一份最小夹具；
 * 8. 系列内序号永久占用（P1，PR #109 第四轮评审）——建一个 YZ 商品后用现有删除接口物理删除，
 *    再对同一系列同一序号发起导入预览，该行应报行级错误且文案带出历史编码，证明预览阶段就能拦住，
 *    不需要等到确认导入才在事务里失败。
 */

import 'reflect-metadata'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ExcelJS from 'exceljs'
import type { AuthUserContext } from '../src/types/auth.js'
import { buildProductImportYzFixtureWorkbook, FIXTURE_SERIES_TAGS } from './fixtures/product-import-yz-fixture.js'

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

const DEFAULT_BASELINE_PATH = path.resolve(backendRoot, 'scripts', 'fixtures', 'product-import-yz-baseline.json')
const ENV_EXCEL_PATH = process.env.YZ_IMPORT_FIXTURE_XLSX
const ENV_BASELINE_PATH = process.env.YZ_IMPORT_BASELINE_JSON

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
  // 两个环境变量必须同时提供才走"真实数据全量比对"模式，缺一律视为配置错误直接报错，
  // 不静默降级到脱敏夹具——避免误以为跑了真实数据，实际却悄悄换成了合成夹具。
  if (Boolean(ENV_EXCEL_PATH) !== Boolean(ENV_BASELINE_PATH)) {
    throw new Error('YZ_IMPORT_FIXTURE_XLSX 与 YZ_IMPORT_BASELINE_JSON 必须同时设置才能启用真实数据全量比对，请两者都设置或两者都不设置')
  }
  const usingExternalFixture = Boolean(ENV_EXCEL_PATH && ENV_BASELINE_PATH)

  let excelBuffer: Buffer
  let baseline: BaselineRow[]
  let seriesTags: Array<{ tagName: string; seriesCode: string }>

  if (usingExternalFixture) {
    if (!fs.existsSync(ENV_EXCEL_PATH as string)) {
      throw new Error(`YZ_IMPORT_FIXTURE_XLSX 指向的文件不存在：${ENV_EXCEL_PATH}`)
    }
    if (!fs.existsSync(ENV_BASELINE_PATH as string)) {
      throw new Error(`YZ_IMPORT_BASELINE_JSON 指向的文件不存在：${ENV_BASELINE_PATH}`)
    }
    excelBuffer = fs.readFileSync(ENV_EXCEL_PATH as string)
    baseline = JSON.parse(fs.readFileSync(ENV_BASELINE_PATH as string, 'utf8')) as BaselineRow[]
    seriesTags = [...new Set(baseline.map((item) => item.seriesCode))].map((seriesCode) => ({
      tagName: baseline.find((item) => item.seriesCode === seriesCode)!.series,
      seriesCode,
    }))
  } else {
    if (!fs.existsSync(DEFAULT_BASELINE_PATH)) {
      throw new Error(`未找到仓库内脱敏基准 JSON：${DEFAULT_BASELINE_PATH}，本脚本不允许跳过该用例`)
    }
    excelBuffer = await buildProductImportYzFixtureWorkbook()
    baseline = JSON.parse(fs.readFileSync(DEFAULT_BASELINE_PATH, 'utf8')) as BaselineRow[]
    seriesTags = FIXTURE_SERIES_TAGS
  }

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
  const { productService } = await import('../src/services/product.service.js')
  const { allocateSeriesSeq, getProductCodePrefix } = await import('../src/services/product-code.service.js')
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

    const tagByName = new Map<string, InstanceType<typeof BaseTag>>()
    for (const item of seriesTags) {
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

    const prefix = await runInTransaction((manager) => getProductCodePrefix(manager))

    // ============ 用例 1：预览全量比对 ============
    const preview = await productImportYzService.preview(excelBuffer)
    assert.equal(preview.rows.length, baseline.length, `预览应解析出 ${baseline.length} 行，实际 ${preview.rows.length}`)
    const expectedGroupCount = new Set(baseline.map((item) => `${item.seriesCode}|${item.seriesSeq}`)).size
    assert.equal(preview.groups.length, expectedGroupCount, `预览应分出 ${expectedGroupCount} 组，实际 ${preview.groups.length}`)
    assert.equal(preview.errorCount, 0, `预览应零错误，实际 ${preview.errorCount}；首个错误：${preview.rows.find((row) => row.errors.length)?.errors.join('；') ?? '无'}`)

    let resolutions: Array<{ groupKey: string; kind: 'multi_product_name' | 'axis_ambiguous'; value: string }>
    if (usingExternalFixture) {
      // 真实数据模式沿用评审原始给定口径：品宣 11、品宣 20 两条多商品名 + 海右 9 一条轴歧义。
      assert.equal(preview.pendingConfirmCount, 3, `预览应命中 3 条待确认项，实际 ${preview.pendingConfirmCount}`)
      const px11 = preview.groups.find((group) => group.seriesCode === 'PX' && group.seriesSeq === 11)
      const px20 = preview.groups.find((group) => group.seriesCode === 'PX' && group.seriesSeq === 20)
      const hy9 = preview.groups.find((group) => group.seriesCode === 'HY' && group.seriesSeq === 9)
      assert.ok(px11 && px11.pendingConfirms.some((item) => item.kind === 'multi_product_name'), '品宣 11 应命中多商品名待确认项')
      assert.ok(px20 && px20.pendingConfirms.some((item) => item.kind === 'multi_product_name'), '品宣 20 应命中多商品名待确认项')
      assert.ok(hy9 && hy9.pendingConfirms.some((item) => item.kind === 'axis_ambiguous'), '海右 9 应命中轴歧义待确认项')
      resolutions = [
        { groupKey: 'PX|11', kind: 'multi_product_name', value: px11!.productNames[0] },
        { groupKey: 'PX|20', kind: 'multi_product_name', value: px20!.productNames[0] },
        { groupKey: 'HY|9', kind: 'axis_ambiguous', value: 'variant' },
      ]
    } else {
      // 脱敏夹具口径：TB-1 同序号多商品名 + TB-2 轴错位，共 2 条待确认项。
      assert.equal(preview.pendingConfirmCount, 2, `预览应命中 2 条待确认项，实际 ${preview.pendingConfirmCount}`)
      const tb1 = preview.groups.find((group) => group.seriesCode === 'TB' && group.seriesSeq === 1)
      const tb2 = preview.groups.find((group) => group.seriesCode === 'TB' && group.seriesSeq === 2)
      assert.ok(tb1 && tb1.pendingConfirms.some((item) => item.kind === 'multi_product_name'), 'TB-1 应命中多商品名待确认项')
      assert.ok(tb2 && tb2.pendingConfirms.some((item) => item.kind === 'axis_ambiguous'), 'TB-2 应命中轴歧义待确认项')
      resolutions = [
        { groupKey: 'TB|1', kind: 'multi_product_name', value: '测试乙款埃菲尔挂件' },
        { groupKey: 'TB|2', kind: 'axis_ambiguous', value: 'variant' },
      ]
    }
    pass(`预览全量比对：rows=${preview.rows.length}、groups=${preview.groups.length}、errorCount=0、pendingConfirmCount=${preview.pendingConfirmCount}，待确认项精确落在预期分组`)

    // ============ 用例 2：未确认拒绝 ============
    await assert.rejects(
      productImportYzService.importProducts(excelBuffer, [], actor),
      (error: unknown) => error instanceof BizError && error.statusCode === 400,
      '不传 resolutions 直接确认导入应抛 400',
    )
    pass('未确认拒绝：不传 resolutions 直接确认导入抛 400')

    // ============ 用例 3：全量导入比对 ============
    const importResult = await productImportYzService.importProducts(excelBuffer, resolutions, actor)
    const expectedProductCount = expectedGroupCount
    assert.equal(importResult.productCount, expectedProductCount, `应落库 ${expectedProductCount} 个商品，实际 ${importResult.productCount}`)
    assert.equal(importResult.skuCount, baseline.length, `应落库 ${baseline.length} 条 SKU，实际 ${importResult.skuCount}`)

    const allSkus = await skuRepo.find()
    const allProducts = await productRepo.find()
    const skuCodeSet = new Set(allSkus.map((sku) => sku.skuCode))
    assert.equal(skuCodeSet.size, baseline.length, `库内应有 ${baseline.length} 个互不重复的 SKU 编码，实际 ${skuCodeSet.size}`)

    for (const expected of baseline) {
      assert.ok(skuCodeSet.has(expected.skuCode), `基准 SKU 编码 ${expected.skuCode}（第 ${expected.row} 行，${expected.productName}）应存在于库内`)
    }
    const baselineCodeSet = new Set(baseline.map((item) => item.skuCode))
    for (const sku of allSkus) {
      assert.ok(baselineCodeSet.has(sku.skuCode), `库内 SKU 编码 ${sku.skuCode} 不在基准 JSON 中`)
    }
    // 商品级编码同样逐一比对，不止比对 SKU 编码。
    const baselineProductCodeSet = new Set(baseline.map((item) => item.productCode))
    for (const product of allProducts) {
      assert.ok(baselineProductCodeSet.has(product.productCode), `库内产品编码 ${product.productCode} 不在基准 JSON 中`)
    }
    pass(`全量导入比对：落库 ${importResult.productCount} 个商品、${importResult.skuCount} 条 SKU，逐条 skuCode/productCode 与基准 JSON 完全一致（双向比对）`)

    // ============ 用例 4：导入后续号 ============
    const maxSeqByTag = new Map<string, number>()
    for (const item of baseline) {
      maxSeqByTag.set(item.seriesCode, Math.max(maxSeqByTag.get(item.seriesCode) ?? 0, item.seriesSeq))
    }
    for (const [seriesCode, maxSeq] of maxSeqByTag) {
      const tag = [...tagByName.values()].find((candidate) => candidate.seriesCode === seriesCode)!
      const nextSeq = await runInTransaction((manager) => allocateSeriesSeq(manager, tag.id, seriesCode, prefix))
      assert.equal(nextSeq, maxSeq + 1, `系列「${seriesCode}」导入后下一个序号应为 ${maxSeq + 1}，实际 ${nextSeq}`)
    }
    pass('导入后续号：每个涉及系列的 allocateSeriesSeq 均从基准最大序号之后继续分配')

    // ============ 用例 5：重复导入被拒 ============
    await assert.rejects(
      productImportYzService.importProducts(excelBuffer, resolutions, actor),
      (error: unknown) => error instanceof BizError,
      '同一文件重复确认导入应因序号已占用而报错',
    )
    pass('重复导入被拒：再次确认导入同一文件因序号已占用而报错')

    // ============ 用例 6：缺系列编码报错 ============
    const firstTagName = seriesTags[0].tagName
    const firstTag = tagByName.get(firstTagName)!
    await tagRepo.update({ id: firstTag.id }, { seriesCode: null })
    const previewMissingSeriesCode = await productImportYzService.preview(excelBuffer)
    const affectedRows = previewMissingSeriesCode.rows.filter((row) => row.category === firstTagName)
    assert.ok(affectedRows.length > 0, `品类「${firstTagName}」应仍有对应行`)
    assert.ok(affectedRows.every((row) => row.errors.some((message) => message.includes('系列编码'))), `品类「${firstTagName}」清空系列编码后，对应行应报错且文案包含"系列编码"`)
    assert.ok(previewMissingSeriesCode.errorCount > 0, '清空系列编码后预览应出现错误行')
    pass(`缺系列编码报错：清空「${firstTagName}」标签的系列编码后，对应行报错且文案包含"系列编码"`)

    // ============ 用例 7：规格取值超长报错（P2-D） ============
    const overlongWorkbook = new ExcelJS.Workbook()
    const overlongSheet = overlongWorkbook.addWorksheet('导入')
    overlongSheet.addRow(['品类', '序号', '商品', '款式/颜色', '尺码', '价格'])
    overlongSheet.addRow(['规格超长测试品类', 90, '超长规格测试商品A', 'A'.repeat(65), '均码', 10])
    overlongSheet.addRow(['规格超长测试品类', 91, '超长规格测试商品B', '均码', 'B'.repeat(65), 10])
    const overlongBuffer = Buffer.from(await overlongWorkbook.xlsx.writeBuffer())

    const overlongPreview = await productImportYzService.preview(overlongBuffer)
    assert.equal(overlongPreview.rows.length, 2, `超长规格夹具应解析出 2 行，实际 ${overlongPreview.rows.length}`)
    const overlongVariantRow = overlongPreview.rows.find((row) => row.productName === '超长规格测试商品A')
    const overlongSizeRow = overlongPreview.rows.find((row) => row.productName === '超长规格测试商品B')
    assert.ok(overlongVariantRow, '应能找到款式/颜色超长的那一行')
    assert.ok(overlongSizeRow, '应能找到尺码超长的那一行')
    assert.ok(
      overlongVariantRow!.errors.some((message) => message.includes('款式/颜色') && message.includes('64') && message.includes('65')),
      `款式/颜色超长行应报错且文案包含长度提示，实际错误：${overlongVariantRow!.errors.join('；') || '无'}`,
    )
    assert.ok(
      overlongSizeRow!.errors.some((message) => message.includes('尺码') && message.includes('64') && message.includes('65')),
      `尺码超长行应报错且文案包含长度提示，实际错误：${overlongSizeRow!.errors.join('；') || '无'}`,
    )
    assert.ok(overlongPreview.errorCount > 0, '超长规格夹具预览应出现错误行')
    pass('规格取值超长报错：「款式/颜色」「尺码」超过 64 字符时预览阶段即报错，且文案包含长度提示')

    // ============ 用例 8：系列内序号永久占用（P1，PR #109 第四轮评审） ============
    // 建一个独立的品类/标签，避免与上面几条用例的落库数据互相干扰。
    const p1TagName = '测试P1复测类'
    const p1Tag = await tagRepo.save(tagRepo.create({ tagName: p1TagName, tagCode: null, seriesCode: 'ZP' }))
    const p1Workbook = new ExcelJS.Workbook()
    const p1Sheet = p1Workbook.addWorksheet('导入')
    p1Sheet.addRow(['品类', '序号', '商品', '款式/颜色', '尺码', '价格'])
    p1Sheet.addRow([p1TagName, 5, 'P1 复测商品', '', '', 1])
    const p1Buffer = Buffer.from(await p1Workbook.xlsx.writeBuffer())

    const p1ImportResult = await productImportYzService.importProducts(p1Buffer, [], actor)
    assert.equal(p1ImportResult.productCount, 1, 'P1 用例应先成功导入 1 个商品')
    const p1Product = p1ImportResult.products[0]
    assert.equal(p1Product.productCode, 'YZZP05', `P1 用例商品编码应为 YZZP05，实际 ${p1Product.productCode}`)

    // 用现有删除接口物理删除该商品——这正是 P1 修复要拦住的场景。
    await productService.delete(p1Product.id, actor)
    const deletedStillExists = await productRepo.existsBy({ id: p1Product.id })
    assert.equal(deletedStillExists, false, 'P1 用例商品应已被物理删除')

    // 再次预览同一系列同一序号：即使商品已删除，该序号也必须被永久占用登记表拦住，报行级错误。
    const p1PreviewAfterDelete = await productImportYzService.preview(p1Buffer)
    const p1Row = p1PreviewAfterDelete.rows[0]
    assert.ok(p1Row, 'P1 复测预览应能解析出一行')
    assert.ok(
      p1Row.errors.some((message) => message.includes('历史编码') && message.includes('YZZP05')),
      `商品删除后同一系列同一序号再次预览应报行级错误且带出历史编码，实际错误：${p1Row.errors.join('；') || '无'}`,
    )
    assert.equal(p1Row.predictedSkuCode, null, '存在行级错误时预测编码应为 null')
    assert.ok(p1PreviewAfterDelete.errorCount > 0, '商品删除后再次预览同一序号应出现错误行')

    // allocateSeriesSeq 顺序分配也必须跳过该已删除商品占用过的序号。
    const p1NextSeq = await runInTransaction((manager) => allocateSeriesSeq(manager, p1Tag.id, 'ZP', prefix))
    assert.equal(p1NextSeq, 6, `已删除商品占用过序号 5，allocateSeriesSeq 应跳到序号 6，实际 ${p1NextSeq}`)
    pass('系列内序号永久占用（P1）：商品被物理删除后，导入预览阶段对同一系列同一序号给出行级错误（带历史编码），allocateSeriesSeq 自动跳过该序号')

    // ============ 用例 9：真实遍历上界（P2-C，PR #109 第七轮评审） ============
    // ExcelJS 在工作表仅有格式、没有数据的靠后行上，会给出很小的 actualRowCount 但极大的 rowCount。
    // 构造一个只在第 1,000,000 行设置过行高（不写任何单元格值）的工作簿：修复前的行数上限检查用
    // actualRowCount 校验，循环却用 Math.max(actualRowCount, rowCount) 撑大上界，导致每次预览/导入
    // 都要执行近百万次 getRow，绕开行数限制并长时间占用服务进程。改用
    // sheet.eachRow({ includeEmpty: false }, ...) 后应该只遍历真正带值的行。
    const hugeRowCountWorkbook = new ExcelJS.Workbook()
    const hugeRowCountSheet = hugeRowCountWorkbook.addWorksheet('导入')
    hugeRowCountSheet.addRow(['品类', '序号', '商品', '款式/颜色', '尺码', '价格'])
    hugeRowCountSheet.addRow(['P2C 复测类', 1, 'P2C 复测商品', '', '', 1])
    // 只设置行高，不写任何单元格值——制造 actualRowCount 很小但 rowCount 极大的场景，复现缺陷前提。
    hugeRowCountSheet.getRow(1_000_000).height = 20
    const hugeRowCountBuffer = Buffer.from(await hugeRowCountWorkbook.xlsx.writeBuffer())

    // 独立探测一遍，确认这份夹具确实复现了 actualRowCount 很小、rowCount 极大的失真元数据，
    // 而不是巧合通过下面的耗时断言。
    const probeWorkbook = new ExcelJS.Workbook()
    await probeWorkbook.xlsx.load(hugeRowCountBuffer as unknown as Parameters<typeof probeWorkbook.xlsx.load>[0])
    const probeSheet = probeWorkbook.worksheets[0]
    assert.ok(probeSheet, '探测工作簿应能读出工作表')
    assert.equal(probeSheet!.actualRowCount, 2, `夹具应只有 2 行带值（表头 + 1 行数据），实际 actualRowCount=${probeSheet!.actualRowCount}`)
    assert.ok(probeSheet!.rowCount >= 1_000_000, `夹具应因为设置过行高而把 rowCount 撑到百万级，实际 rowCount=${probeSheet!.rowCount}`)

    const hugeRowCountStart = Date.now()
    const hugeRowCountPreview = await productImportYzService.preview(hugeRowCountBuffer)
    const hugeRowCountElapsedMs = Date.now() - hugeRowCountStart
    assert.ok(
      hugeRowCountElapsedMs < 5000,
      `P2-C：actualRowCount 很小、rowCount 极大的工作簿，预览必须在合理时间内返回（实际耗时 ${hugeRowCountElapsedMs}ms），不能被拖到近百万次 getRow`,
    )
    assert.equal(hugeRowCountPreview.rows.length, 1, `P2-C：预览应只解析出真正带值的 1 行数据，实际 ${hugeRowCountPreview.rows.length}`)
    pass(`P2-C：真实遍历上界——actualRowCount 很小但 rowCount 达百万级的工作簿，预览在 ${hugeRowCountElapsedMs}ms 内返回且仅解析出真实的 1 行数据`)

    // 行数上限检查必须作用在真实上界上：构造一份真正超过上限（2000 行）的夹具，预览应明确拒绝，
    // 而不是被某个失真的计数值放过。
    const overLimitWorkbook = new ExcelJS.Workbook()
    const overLimitSheet = overLimitWorkbook.addWorksheet('导入')
    overLimitSheet.addRow(['品类', '序号', '商品', '款式/颜色', '尺码', '价格'])
    for (let i = 0; i < 2001; i += 1) {
      overLimitSheet.addRow(['P2C 超限类', (i % 99) + 1, `P2C 超限商品${i}`, '', '', 1])
    }
    const overLimitBuffer = Buffer.from(await overLimitWorkbook.xlsx.writeBuffer())
    await assert.rejects(
      productImportYzService.preview(overLimitBuffer),
      (error: unknown) => error instanceof BizError && error.statusCode === 400,
      'P2-C：真实数据行数超过上限时预览应拒绝（上限检查作用在真实遍历到的行数上）',
    )
    pass('P2-C：行数上限检查作用在真实遍历上界——超过上限的真实数据行数会被拒绝')
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
