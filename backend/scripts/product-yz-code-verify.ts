import 'reflect-metadata'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AuthUserContext } from '../src/types/auth.js'
import { isDatabaseFlagEnabled } from '../src/utils/product-inventory-summary.js'

const currentFilePath = fileURLToPath(import.meta.url)
const backendRoot = path.resolve(path.dirname(currentFilePath), '..')
const sqliteRoot = path.resolve(backendRoot, 'data', 'local-dev')
const verifySeed = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const sqlitePath = path.resolve(sqliteRoot, `product-yz-code-${verifySeed}.sqlite`)

process.env.APP_PROFILE = `product-yz-code-${verifySeed}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'false'
process.env.SQLITE_DB_PATH = sqlitePath
process.env.INIT_ADMIN_PASSWORD = `Admin_${verifySeed}_Aa1!`

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
    console.warn(`[product-yz-code-verify] temporary SQLite cleanup skipped: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function main() {
  fs.mkdirSync(sqliteRoot, { recursive: true })

  const { AppDataSource } = await import('../src/config/data-source.js')
  const { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime } = await import('../src/config/database-bootstrap.js')
  const { runInTransaction } = await import('../src/config/transaction-runner.js')
  const { systemConfigService } = await import('../src/services/system-config.service.js')
  const { BizError } = await import('../src/utils/errors.js')
  const { BaseTag } = await import('../src/entities/base-tag.entity.js')
  const { BaseProduct } = await import('../src/entities/base-product.entity.js')
  const { BaseProductSku } = await import('../src/entities/base-product-sku.entity.js')
  const { BaseProductVariantCodeRegistry } = await import('../src/entities/base-product-variant-code-registry.entity.js')
  const {
    allocateSeriesSeq,
    reserveSeriesSeq,
    resolveVariantCode,
    resolveSizeCode,
    renameRegistryValue,
    formatProductCode,
    formatSkuCode,
    buildProductCodePattern,
    buildSkuCodePattern,
    assertSeriesCode,
    getProductCodePrefix,
    buildSeriesCodeMutexKey,
  } = await import('../src/services/product-code.service.js')
  const { acquireSequenceMutex } = await import('../src/services/inventory-sequence.service.js')

  prepareDatabaseRuntime()
  await AppDataSource.initialize()
  try {
    await initializeDatabaseSchemaIfNeeded(AppDataSource)
    await systemConfigService.ensureDefaultConfigs()

    const tagRepo = AppDataSource.getRepository(BaseTag)
    const productRepo = AppDataSource.getRepository(BaseProduct)
    const skuRepo = AppDataSource.getRepository(BaseProductSku)
    const registryRepo = AppDataSource.getRepository(BaseProductVariantCodeRegistry)

    let productCodeCounter = 0
    const nextProductCode = () => {
      productCodeCounter += 1
      return `YZTEST${productCodeCounter}-${verifySeed}`
    }

    const createSeriesTag = async (seriesCode: string) => tagRepo.save(tagRepo.create({
      tagName: `series-${seriesCode}-${verifySeed}`,
      tagCode: null,
      seriesCode,
    }))

    const createProduct = async (seriesTagId: string | null, seriesSeq: number | null) => {
      const code = nextProductCode()
      return productRepo.save(productRepo.create({
        productCode: code,
        productName: `product-${code}`,
        pinyinAbbr: 'PT',
        defaultPrice: '10.00',
        discountRate: '10.0',
        isActive: true,
        o2oStatus: 'unlisted',
        o2oRecommended: false,
        thumbnail: null,
        detailContent: null,
        limitPerUser: 5,
        currentStock: 0,
        categoryId: null,
        preOrderedStock: 0,
        primarySeriesTagId: seriesTagId,
        seriesSeq,
        codeScheme: 'yz',
      }))
    }

    const assertBizErrorWithStatus = (error: unknown, statusCode: number) =>
      error instanceof BizError && error.statusCode === statusCode

    // 用例 1：并发分配系列内序号不撞码。
    const concurrentTag = await createSeriesTag('CC')
    const concurrentResults = await Promise.all(
      Array.from({ length: 8 }, () => runInTransaction((manager) => allocateSeriesSeq(manager, concurrentTag.id))),
    )
    assert.deepEqual([...concurrentResults].sort((left, right) => left - right), [1, 2, 3, 4, 5, 6, 7, 8])
    pass('并发 8 次 allocateSeriesSeq 得到互不重复且构成 1..8 的序号')

    // 用例 2：变体码不回收——SKU 退役不影响已登记的变体码，新取值继续从下一个码分配。
    const variantTag = await createSeriesTag('VA')
    const variantProduct = await createProduct(variantTag.id, 1)
    const beigeCode = await runInTransaction((manager) => resolveVariantCode(manager, variantProduct.id, '米色'))
    assert.equal(beigeCode, '1')
    const beigeSku = await skuRepo.save(skuRepo.create({
      productId: variantProduct.id,
      skuCode: `${variantProduct.productCode}1`,
      specValuesJson: JSON.stringify({ Color: '米色' }),
      specText: '米色',
      defaultPrice: '10.00',
      discountRate: '10.0',
      isActive: true,
      isCurrent: true,
      o2oRecommended: false,
      sortOrder: 0,
      variantCode: '1',
      sizeCode: null,
    }))
    beigeSku.isCurrent = false
    beigeSku.isActive = false
    await skuRepo.save(beigeSku)
    const beigeCodeAfterRetire = await runInTransaction((manager) => resolveVariantCode(manager, variantProduct.id, '米色'))
    assert.equal(beigeCodeAfterRetire, '1')
    const blueCode = await runInTransaction((manager) => resolveVariantCode(manager, variantProduct.id, '蓝色'))
    assert.equal(blueCode, '2')
    pass('SKU 退役后已登记的变体码不回收，新规格取值从下一个未占用码分配')

    // 用例 3：序号预占——reserveSeriesSeq 依次占用 1..26 后，allocateSeriesSeq 从 27 继续。
    const reserveTag = await createSeriesTag('RS')
    for (let seq = 1; seq <= 26; seq += 1) {
      await runInTransaction((manager) => reserveSeriesSeq(manager, reserveTag.id, seq))
    }
    const nextAllocatedSeq = await runInTransaction((manager) => allocateSeriesSeq(manager, reserveTag.id))
    assert.equal(nextAllocatedSeq, 27)
    pass('reserveSeriesSeq 预占 1..26 后 allocateSeriesSeq 返回 27')

    // 用例 4：容量超限——变体码 9 个上限、尺码码 5 个上限（A-E）。
    const capacityTag = await createSeriesTag('CP')
    const capacityProduct = await createProduct(capacityTag.id, 1)
    await runInTransaction(async (manager) => {
      for (let index = 1; index <= 9; index += 1) {
        const code = await resolveVariantCode(manager, capacityProduct.id, `变体${index}`)
        assert.equal(code, String(index))
      }
    })
    await assert.rejects(
      runInTransaction((manager) => resolveVariantCode(manager, capacityProduct.id, '变体10')),
      (error: unknown) => assertBizErrorWithStatus(error, 409),
      '第 10 个一级变体应当抛 409',
    )
    pass('一级变体码登记满 9 个后第 10 个抛 409')

    const sizeLetters = ['A', 'B', 'C', 'D', 'E']
    await runInTransaction(async (manager) => {
      for (let index = 0; index < sizeLetters.length; index += 1) {
        const code = await resolveSizeCode(manager, capacityProduct.id, `尺码${index + 1}`)
        assert.equal(code, sizeLetters[index])
      }
    })
    await assert.rejects(
      runInTransaction((manager) => resolveSizeCode(manager, capacityProduct.id, '尺码6')),
      (error: unknown) => assertBizErrorWithStatus(error, 409),
      '第 6 个尺码取值应当抛 409',
    )
    pass('尺码码登记满 5 个（A-E）后第 6 个抛 409')

    // 用例 5：0 号继承——商品无变体时固定为 '0' 且不写登记表；'0' 只能被继承一次。
    const zeroTag = await createSeriesTag('ZC')
    const zeroProduct = await createProduct(zeroTag.id, 1)
    const noVariantCode = await runInTransaction((manager) => resolveVariantCode(manager, zeroProduct.id, null))
    assert.equal(noVariantCode, '0')
    const rowsAfterNull = await registryRepo.findBy({ productId: zeroProduct.id, axis: 'variant' })
    assert.equal(rowsAfterNull.length, 0)

    const redInheritCode = await runInTransaction((manager) =>
      resolveVariantCode(manager, zeroProduct.id, '红色', { inheritZeroCode: true }))
    assert.equal(redInheritCode, '0')
    const rowsAfterRed = await registryRepo.findBy({ productId: zeroProduct.id, axis: 'variant' })
    assert.equal(rowsAfterRed.length, 1)

    const blueNormalCode = await runInTransaction((manager) => resolveVariantCode(manager, zeroProduct.id, '蓝色'))
    assert.equal(blueNormalCode, '1')

    await assert.rejects(
      runInTransaction((manager) => resolveVariantCode(manager, zeroProduct.id, '绿色', { inheritZeroCode: true })),
      (error: unknown) => assertBizErrorWithStatus(error, 409),
      '0 号已被继承时再次继承应当抛 409',
    )
    pass('0 号继承只能发生一次，且不影响后续常规变体码分配顺序')

    // 用例 6：重命名规格取值保留原编码。
    const renameTag = await createSeriesTag('RN')
    const renameProduct = await createProduct(renameTag.id, 1)
    const originalCode = await runInTransaction((manager) => resolveVariantCode(manager, renameProduct.id, '米色'))
    assert.equal(originalCode, '1')
    await runInTransaction((manager) => renameRegistryValue(manager, renameProduct.id, 'variant', '米色', '浅米色'))
    const codeAfterRename = await runInTransaction((manager) => resolveVariantCode(manager, renameProduct.id, '浅米色'))
    assert.equal(codeAfterRename, '1')
    const rowsAfterRename = await registryRepo.findBy({ productId: renameProduct.id, axis: 'variant' })
    assert.equal(rowsAfterRename.length, 1)
    assert.equal(rowsAfterRename.some((row) => row.specValue === '米色'), false)
    pass('renameRegistryValue 改名后旧取值不存在，新取值复用原编码')

    // 用例 7：编码拼接、正则匹配与前缀/系列码校验。
    assert.equal(formatSkuCode('YZPX18', '1', 'A'), 'YZPX181A')
    assert.equal(formatSkuCode('YZDW01', '0', null), 'YZDW010')
    const skuPattern = buildSkuCodePattern('YZ')
    assert.ok(skuPattern.test('YZPX181A'))
    assert.ok(skuPattern.test('YZDW010'))
    assert.ok(!skuPattern.test('YZPX181F'))
    assert.ok(!skuPattern.test('YZPX1810'))
    assert.equal(formatProductCode('YZ', 'PX', 18), 'YZPX18')
    assert.ok(buildProductCodePattern('YZ').test('YZPX18'))
    assert.ok(!buildProductCodePattern('YZ').test('YZPX1'))
    assert.equal(assertSeriesCode('PX'), 'PX')
    assert.throws(() => assertSeriesCode('px'), BizError)
    const prefix = await runInTransaction((manager) => getProductCodePrefix(manager))
    assert.equal(prefix, 'YZ')
    pass('formatSkuCode / buildSkuCodePattern / formatProductCode / assertSeriesCode / getProductCodePrefix 均符合预期')

    // ============ 第 3 批：product.service.ts 接入用例（全部走 productService 公开方法的真实链路） ============
    const { productService } = await import('../src/services/product.service.js')
    const { tagService } = await import('../src/services/tag.service.js')
    const { SysUser } = await import('../src/entities/sys-user.entity.js')

    const userRepo = AppDataSource.getRepository(SysUser)
    const admin = await userRepo.save(userRepo.create({
      username: `product-yz-admin-${verifySeed}`,
      passwordHash: 'verify-only',
      displayName: 'YZ 编码商品服务验证管理员',
      email: null,
      role: 'admin',
      status: 'enabled',
      lastLoginAt: null,
    }))
    const actor: AuthUserContext = {
      userId: String(admin.id), username: admin.username, displayName: admin.displayName,
      role: 'admin', permissions: [], status: 'enabled',
      sessionToken: 'product-yz-code-verify', authSource: 'bearer',
    }

    // 用例 8：legacy 隔离——不传 primarySeriesTagId 创建商品，完全走原有 legacy 路径，不写变体码登记表。
    const legacyProduct = await productService.create({
      productName: `legacy-product-${verifySeed}`,
      pinyinAbbr: 'LP',
      defaultPrice: 10,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'unlisted',
      currentStock: 0,
      limitPerUser: 5,
    } as Parameters<typeof productService.create>[0], actor)
    assert.equal(legacyProduct.codeScheme, 'legacy')
    assert.ok(/^P-\d{6}-\d{4}$/.test(legacyProduct.productCode), `legacy productCode 应匹配 P-YYMMDD-NNNN，实际 ${legacyProduct.productCode}`)
    assert.equal(legacyProduct.seriesSeq, null)
    assert.equal(legacyProduct.primarySeriesTagId, null)

    const legacyProductWithNewSpec = await productService.update(legacyProduct.id, {
      specGroups: [{ name: '颜色', values: ['米色'] }],
      skus: [
        { specValues: { 颜色: '米色' }, defaultPrice: 10, currentStock: 0, isActive: true, sortOrder: 0 },
      ],
    } as Parameters<typeof productService.update>[1], actor)
    const legacyNewSku = legacyProductWithNewSpec.skus.find((sku) => sku.specValues['颜色'] === '米色')
    assert.ok(legacyNewSku, 'legacy 商品应生成新规格 SKU')
    assert.ok(
      /^WC\d{2}\d{3,}$/.test(legacyNewSku!.skuCode)
        || legacyNewSku!.skuCode === `${legacyProduct.productCode}-DEFAULT`
        || legacyNewSku!.skuCode === `${legacyProduct.productCode}-SKU-1`,
      `legacy 新 SKU 码应为 WC 编码或默认矩阵/流水编码，实际 ${legacyNewSku!.skuCode}`,
    )
    assert.equal(legacyNewSku!.variantCode, null)
    assert.equal(legacyNewSku!.sizeCode, null)
    const legacyRegistryRows = await registryRepo.findBy({ productId: legacyProduct.id })
    assert.equal(legacyRegistryRows.length, 0, 'legacy 商品不应写入变体码登记表')
    pass('legacy 商品不传 primarySeriesTagId 时完全走原有编码路径，新 SKU 的 variantCode/sizeCode 均为 null 且登记表无该商品的行')

    // 用例 9：YZ 建档——3 色 × 2 款矩阵，productCode 与 6 条 SKU 码符合预期格式。
    const pxTag = await createSeriesTag('PX')
    const yzProduct = await productService.create({
      productName: `yz-product-${verifySeed}`,
      pinyinAbbr: 'YZ',
      defaultPrice: 20,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'unlisted',
      currentStock: 0,
      limitPerUser: 5,
      primarySeriesTagId: pxTag.id,
      specGroups: [
        { name: '颜色', values: ['米色', '蓝色', '黑色'] },
        { name: '款式', values: ['S', 'M'] },
      ],
      skus: [
        { specValues: { 颜色: '米色', 款式: 'S' }, defaultPrice: 20, currentStock: 0, isActive: true, sortOrder: 0 },
        { specValues: { 颜色: '米色', 款式: 'M' }, defaultPrice: 20, currentStock: 0, isActive: true, sortOrder: 1 },
        { specValues: { 颜色: '蓝色', 款式: 'S' }, defaultPrice: 20, currentStock: 0, isActive: true, sortOrder: 2 },
        { specValues: { 颜色: '蓝色', 款式: 'M' }, defaultPrice: 20, currentStock: 0, isActive: true, sortOrder: 3 },
        { specValues: { 颜色: '黑色', 款式: 'S' }, defaultPrice: 20, currentStock: 0, isActive: true, sortOrder: 4 },
        { specValues: { 颜色: '黑色', 款式: 'M' }, defaultPrice: 20, currentStock: 0, isActive: true, sortOrder: 5 },
      ],
    } as Parameters<typeof productService.create>[0], actor)
    assert.equal(yzProduct.codeScheme, 'yz')
    assert.equal(yzProduct.productCode, 'YZPX01')
    assert.equal(yzProduct.seriesCode, 'PX')
    assert.equal(yzProduct.seriesSeq, 1)
    assert.ok(yzProduct.tagIds.includes(String(pxTag.id)), '主系列标签应自动补进标签关联')
    const expectedInitialSkuCodes = ['YZPX011A', 'YZPX011B', 'YZPX012A', 'YZPX012B', 'YZPX013A', 'YZPX013B']
    assert.deepEqual(
      [...yzProduct.skus.map((sku) => sku.skuCode)].sort(),
      [...expectedInitialSkuCodes].sort(),
    )
    pass('YZ 建档：3 色 × 2 款矩阵生成 productCode=YZPX01，6 条 SKU 码为 011A/011B/012A/012B/013A/013B')

    // 用例 10：编辑不改码——规格顺序打乱后再保存，6 条 SKU 的 skuCode 与建档时完全相同。
    const toUpdateSkuInput = (sku: (typeof yzProduct.skus)[number]) => ({
      id: sku.id,
      specValues: sku.specValues,
      defaultPrice: Number(sku.defaultPrice),
      currentStock: sku.currentStock,
      isActive: sku.isActive,
      sortOrder: sku.sortOrder,
    })
    const shuffledSkuInputs = [...yzProduct.skus].sort(() => Math.random() - 0.5).map(toUpdateSkuInput)
    const yzProductResaved = await productService.update(yzProduct.id, {
      specGroups: [
        { name: '款式', values: ['M', 'S'] },
        { name: '颜色', values: ['黑色', '米色', '蓝色'] },
      ],
      skus: shuffledSkuInputs,
    } as Parameters<typeof productService.update>[1], actor)
    const originalSkuCodeById = new Map(yzProduct.skus.map((sku) => [sku.id, sku.skuCode]))
    yzProductResaved.skus.forEach((sku) => {
      assert.equal(sku.skuCode, originalSkuCodeById.get(sku.id), `SKU ${sku.id} 编码在重新保存后应保持不变`)
    })
    pass('YZ 商品重新保存（规格顺序打乱）后 6 条 SKU 的 skuCode 与建档时完全相同')

    // 用例 11：新增变体续号——第 4 个颜色（灰色）取变体码 4，不是插队。
    const withFourthColor = await productService.update(yzProduct.id, {
      specGroups: [
        { name: '颜色', values: ['米色', '蓝色', '黑色', '灰色'] },
        { name: '款式', values: ['S', 'M'] },
      ],
      skus: [
        ...yzProductResaved.skus.map(toUpdateSkuInput),
        { specValues: { 颜色: '灰色', 款式: 'S' }, defaultPrice: 20, currentStock: 0, isActive: true, sortOrder: 6 },
        { specValues: { 颜色: '灰色', 款式: 'M' }, defaultPrice: 20, currentStock: 0, isActive: true, sortOrder: 7 },
      ],
    } as Parameters<typeof productService.update>[1], actor)
    const graySkus = withFourthColor.skus.filter((sku) => sku.specValues['颜色'] === '灰色')
    assert.equal(graySkus.length, 2)
    assert.deepEqual([...graySkus.map((sku) => sku.skuCode)].sort(), ['YZPX014A', 'YZPX014B'])
    graySkus.forEach((sku) => assert.equal(sku.variantCode, '4'))
    pass('新增第 4 个颜色续号取变体码 4，SKU 码为 YZPX014A/014B，不是插队复用已退役的码')

    // 用例 12：退役不回收——移除第 2 个颜色（蓝色）规格触发退役后再加回同名颜色，变体码仍是 2。
    const withoutBlue = await productService.update(yzProduct.id, {
      specGroups: [
        { name: '颜色', values: ['米色', '黑色', '灰色'] },
        { name: '款式', values: ['S', 'M'] },
      ],
      skus: withFourthColor.skus
        .filter((sku) => sku.specValues['颜色'] !== '蓝色')
        .map(toUpdateSkuInput),
    } as Parameters<typeof productService.update>[1], actor)
    assert.ok(!withoutBlue.skus.some((sku) => sku.specValues['颜色'] === '蓝色'), '蓝色规格应已从当前矩阵移除')
    const blueRegistryRow = await registryRepo.findOneBy({ productId: yzProduct.id, axis: 'variant', specValue: '蓝色' })
    assert.equal(blueRegistryRow?.code, '2', '蓝色退役后登记表中的变体码仍应保留为 2，不能被清理')

    const blueBack = await productService.update(yzProduct.id, {
      specGroups: [
        { name: '颜色', values: ['米色', '黑色', '灰色', '蓝色'] },
        { name: '款式', values: ['S', 'M'] },
      ],
      skus: [
        ...withoutBlue.skus.map(toUpdateSkuInput),
        { specValues: { 颜色: '蓝色', 款式: 'S' }, defaultPrice: 20, currentStock: 0, isActive: true, sortOrder: 8 },
        { specValues: { 颜色: '蓝色', 款式: 'M' }, defaultPrice: 20, currentStock: 0, isActive: true, sortOrder: 9 },
      ],
    } as Parameters<typeof productService.update>[1], actor)
    const yzSkuPattern = buildSkuCodePattern('YZ')
    const blueBackSkus = blueBack.skus.filter((sku) => sku.specValues['颜色'] === '蓝色')
    assert.equal(blueBackSkus.length, 2)
    blueBackSkus.forEach((sku) => assert.equal(sku.variantCode, '2'))
    // skuCode 必须原样复用退役前的 YZPX012A/012B，不允许出现 "-2" 之类的去重后缀：
    // YZ 商品在匹配不到当前有效行时会复活同规格的退役行（复用其 id 与 skuCode），
    // 而不是新建一行去撞退役行的唯一索引，否则会产出不符合 YZ 定长规则的编码。
    assert.deepEqual([...blueBackSkus.map((sku) => sku.skuCode)].sort(), ['YZPX012A', 'YZPX012B'])
    blueBackSkus.forEach((sku) => assert.ok(
      yzSkuPattern.test(sku.skuCode),
      `复活后的 skuCode ${sku.skuCode} 必须仍符合 YZ 编码正则`,
    ))
    // 复活的行必须重新可售，不能沿用退役时写入的 isActive=false。
    blueBackSkus.forEach((sku) => assert.equal(sku.isActive, true, '复活的 SKU 必须重新启用'))
    pass('退役不回收：移除蓝色规格再加回同名颜色，复活原行且 skuCode 原样保持 YZPX012A/012B')

    // 用例 13：手填编码被拒——YZ 路径下传 productCode 应当抛 400。
    await assert.rejects(
      () => productService.create({
        productCode: 'YZ-MANUAL-CODE',
        productName: `yz-manual-code-${verifySeed}`,
        pinyinAbbr: 'MC',
        defaultPrice: 10,
        discountRate: 10,
        isActive: true,
        o2oStatus: 'unlisted',
        currentStock: 0,
        limitPerUser: 5,
        primarySeriesTagId: pxTag.id,
      } as Parameters<typeof productService.create>[0], actor),
      (error: unknown) => assertBizErrorWithStatus(error, 400),
      'YZ 路径手填 productCode 应当抛 400',
    )
    pass('YZ 编码商品手填 productCode 会被拒绝（400）')

    // 用例 14：改码被拒——更新 YZ 商品时传不同的 productCode 应当抛 400。
    await assert.rejects(
      () => productService.update(yzProduct.id, {
        productCode: `${yzProduct.productCode}X`,
      } as Parameters<typeof productService.update>[1], actor),
      (error: unknown) => assertBizErrorWithStatus(error, 400),
      'YZ 商品修改 productCode 应当抛 400',
    )
    pass('更新 YZ 编码商品时修改 productCode 会被拒绝（400）')

    // ============ 第 3.5 批：存量商品手动升级到 YZ 编码（product.service.ts 新增公开方法）============
    const upgradeTag = await createSeriesTag('UP')

    // 建 legacy 商品：2 色（白/黑）× 2 款（S/M）+ 1 个待退役规格（红色-S），第 1 条（白色-S）设原厂条码。
    // 显式指定 productCode（而非依赖按天递增的 generateProductCode）：升级会把旧 productCode 从
    // base_product 表里换走，若靠自动生成，同一测试进程内后续新建的 legacy 商品可能重新拿到这个
    // 空出来的编码，其自动生成的 SKU 码就可能撞上本商品升级时回填进 barcode 的旧 skuCode。
    const legacyToUpgrade = await productService.create({
      productCode: nextProductCode(),
      productName: `legacy-upgrade-${verifySeed}`,
      pinyinAbbr: 'LU',
      defaultPrice: 30,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'unlisted',
      currentStock: 0,
      limitPerUser: 5,
      specGroups: [
        { name: '颜色', values: ['白色', '黑色', '红色'] },
        { name: '款式', values: ['S', 'M'] },
      ],
      skus: [
        { specValues: { 颜色: '白色', 款式: 'S' }, defaultPrice: 30, currentStock: 0, isActive: true, sortOrder: 0, barcode: `ORIG-${verifySeed}` },
        { specValues: { 颜色: '白色', 款式: 'M' }, defaultPrice: 30, currentStock: 0, isActive: true, sortOrder: 1 },
        { specValues: { 颜色: '黑色', 款式: 'S' }, defaultPrice: 30, currentStock: 0, isActive: true, sortOrder: 2 },
        { specValues: { 颜色: '黑色', 款式: 'M' }, defaultPrice: 30, currentStock: 0, isActive: true, sortOrder: 3 },
        { specValues: { 颜色: '红色', 款式: 'S' }, defaultPrice: 30, currentStock: 0, isActive: true, sortOrder: 4 },
      ],
    } as Parameters<typeof productService.create>[0], actor)
    assert.equal(legacyToUpgrade.codeScheme, 'legacy')
    assert.equal(legacyToUpgrade.skus.length, 5)

    // 升级前先退役红色-S：只重新提交 4 个规格，触发既有的退役逻辑（用例 12 已验证过该链路）。
    const redSSku = legacyToUpgrade.skus.find((sku) => sku.specValues['颜色'] === '红色')
    assert.ok(redSSku, '应存在待退役的红色-S SKU')
    const beforeUpgrade = await productService.update(legacyToUpgrade.id, {
      specGroups: [
        { name: '颜色', values: ['白色', '黑色'] },
        { name: '款式', values: ['S', 'M'] },
      ],
      skus: legacyToUpgrade.skus
        .filter((sku) => sku.specValues['颜色'] !== '红色')
        .map((sku) => ({
          id: sku.id,
          specValues: sku.specValues,
          defaultPrice: Number(sku.defaultPrice),
          currentStock: sku.currentStock,
          isActive: sku.isActive,
          sortOrder: sku.sortOrder,
          barcode: sku.barcode,
        })),
    } as Parameters<typeof productService.update>[1], actor)
    assert.equal(beforeUpgrade.skus.length, 4, '提交 4 个规格后当前有效 SKU 应为 4 条')
    const retiredRowBeforeUpgrade = await skuRepo.findOneBy({ id: redSSku!.id })
    assert.ok(retiredRowBeforeUpgrade, '退役行应仍存在于数据库')
    assert.equal(isDatabaseFlagEnabled(retiredRowBeforeUpgrade!.isCurrent), false, '红色-S 应已退役（isCurrent=false）')
    const retiredSkuCodeBeforeUpgrade = retiredRowBeforeUpgrade!.skuCode

    // 用例 6：预检只读——调用两次，newProductCode 相同（没有真的消耗序号），登记表行数在预检前后没有变化。
    const registryCountBeforePreview = await registryRepo.count()
    const previewOne = await productService.previewProductYzUpgrade(legacyToUpgrade.id, upgradeTag.id)
    const previewTwo = await productService.previewProductYzUpgrade(legacyToUpgrade.id, upgradeTag.id)
    assert.equal(previewOne.newProductCode, previewTwo.newProductCode, '两次预检的 newProductCode 应相同')
    assert.equal(previewOne.newProductCode, 'YZUP01')
    assert.equal(previewOne.blockingReason, null)
    assert.equal(previewOne.retiredSkuCount, 1, '预检应统计出 1 条退役 SKU')
    assert.equal(previewOne.skuChanges.length, 4, '预检应给出 4 条当前有效 SKU 的编码变化')
    const registryCountAfterPreview = await registryRepo.count()
    assert.equal(registryCountAfterPreview, registryCountBeforePreview, '预检不应写入登记表')
    pass('预检只读：两次调用 newProductCode 相同，且未消耗序号、未写入登记表')

    // 用例 1：升级全流程。
    const upgraded = await productService.upgradeProductToYzCode(
      legacyToUpgrade.id,
      { primarySeriesTagId: upgradeTag.id },
      actor,
    )
    assert.equal(upgraded.codeScheme, 'yz')
    assert.equal(upgraded.productCode, 'YZUP01')
    assert.equal(upgraded.seriesCode, 'UP')
    assert.equal(upgraded.seriesSeq, 1)
    assert.equal(upgraded.skus.length, 4)
    upgraded.skus.forEach((sku) => {
      assert.ok(yzSkuPattern.test(sku.skuCode), `升级后的 SKU 码 ${sku.skuCode} 必须匹配 YZ 正则`)
    })
    assert.deepEqual(
      [...upgraded.skus.map((sku) => sku.skuCode)].sort(),
      ['YZUP011A', 'YZUP011B', 'YZUP012A', 'YZUP012B'],
    )
    pass('升级全流程：2 色 × 2 款 legacy 商品升级为 productCode=YZUP01，4 条 SKU 码为 011A/011B/012A/012B')

    // 用例 2（B9 批次修正）：旧编码不再回填进 barcode，改为无条件写入 legacySkuCode；barcode 只保留真实原厂条码。
    const preUpgradeSkuCodeById = new Map(beforeUpgrade.skus.map((sku) => [sku.id, sku.skuCode]))
    upgraded.skus.forEach((sku) => {
      const oldCode = preUpgradeSkuCodeById.get(sku.id)
      assert.ok(oldCode, `应找到 SKU ${sku.id} 升级前的编码`)
      assert.equal(sku.legacySkuCode, oldCode, '每条当前 SKU 的 legacySkuCode 应等于其升级前的 skuCode')
      if (sku.specValues['颜色'] === '白色' && sku.specValues['款式'] === 'S') {
        assert.equal(sku.barcode, `ORIG-${verifySeed}`, '原本有原厂条码的 SKU 条码应保持不变')
      } else {
        assert.equal(sku.barcode, null, '原本条码为空的 SKU 升级后 barcode 仍应为 null，不再回填旧编码')
      }
    })
    pass('旧编码落位：4 条当前 SKU 的 legacySkuCode 均等于升级前 skuCode；原厂条码保持不变，其余 SKU 的 barcode 仍为 null（不再污染条码）')

    // 用例 3：退役行不动。
    const retiredRowAfterUpgrade = await skuRepo.findOneBy({ id: redSSku!.id })
    assert.ok(retiredRowAfterUpgrade, '退役行升级后应仍存在')
    assert.equal(retiredRowAfterUpgrade!.skuCode, retiredSkuCodeBeforeUpgrade, '退役行的 skuCode 不应被升级改动')
    assert.equal(isDatabaseFlagEnabled(retiredRowAfterUpgrade!.isCurrent), false, '退役行应仍保持 isCurrent=false')
    assert.equal(retiredRowAfterUpgrade!.variantCode, null, '退役行不应被回填 variantCode')
    assert.equal(retiredRowAfterUpgrade!.sizeCode, null, '退役行不应被回填 sizeCode')
    pass('退役行不动：升级前已退役的红色-S 行 skuCode 与 isCurrent 均未改变')

    // 用例 4：容量阻断——一级变体（颜色）超过 9 个的 legacy 商品升级应抛 409，预检也应给出 blockingReason。
    const capacityUpgradeTag = await createSeriesTag('CU')
    const manyColors = Array.from({ length: 10 }, (_, index) => `色号${index + 1}`)
    const overCapacityProduct = await productService.create({
      productCode: nextProductCode(),
      productName: `legacy-overcap-${verifySeed}`,
      pinyinAbbr: 'OC',
      defaultPrice: 10,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'unlisted',
      currentStock: 0,
      limitPerUser: 5,
      specGroups: [{ name: '颜色', values: manyColors }],
      skus: manyColors.map((color, index) => ({
        specValues: { 颜色: color }, defaultPrice: 10, currentStock: 0, isActive: true, sortOrder: index,
      })),
    } as Parameters<typeof productService.create>[0], actor)
    assert.equal(overCapacityProduct.skus.length, 10)
    await assert.rejects(
      productService.upgradeProductToYzCode(overCapacityProduct.id, { primarySeriesTagId: capacityUpgradeTag.id }, actor),
      (error: unknown) => assertBizErrorWithStatus(error, 409),
      '一级变体超过 9 个的商品升级应抛 409',
    )
    const overCapacityPreview = await productService.previewProductYzUpgrade(overCapacityProduct.id, capacityUpgradeTag.id)
    assert.ok(overCapacityPreview.blockingReason, '预检也应给出容量阻断原因')
    pass('容量阻断：一级变体数量超过 9 个上限的 legacy 商品升级抛 409，预检同样给出 blockingReason')

    // 用例 5：重复升级被拒——已是 YZ 编码的商品再次调用升级接口应抛 400。
    await assert.rejects(
      productService.upgradeProductToYzCode(legacyToUpgrade.id, { primarySeriesTagId: upgradeTag.id }, actor),
      (error: unknown) => assertBizErrorWithStatus(error, 400),
      '已升级商品再次升级应抛 400',
    )
    pass('重复升级被拒：已是 YZ 编码的商品再次调用升级接口抛 400')

    // 用例 7：legacy update 防护——普通编辑接口传非空 primarySeriesTagId 应抛 400。
    const legacyGuardProduct = await productService.create({
      productCode: nextProductCode(),
      productName: `legacy-guard-${verifySeed}`,
      pinyinAbbr: 'LG',
      defaultPrice: 10,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'unlisted',
      currentStock: 0,
      limitPerUser: 5,
    } as Parameters<typeof productService.create>[0], actor)
    await assert.rejects(
      productService.update(
        legacyGuardProduct.id,
        { primarySeriesTagId: upgradeTag.id } as Parameters<typeof productService.update>[1],
        actor,
      ),
      (error: unknown) => assertBizErrorWithStatus(error, 400),
      'legacy 商品在普通编辑接口传 primarySeriesTagId 应抛 400',
    )
    pass('legacy update 防护：普通编辑接口传非空 primarySeriesTagId 会被拒绝（400）')

    // 用例 23（P1-A 修复后回退）：升级腾出的日期流水号被当天新建商品重新取到时，新商品的默认 SKU 码
    // 必须避开被占用的历史编码——不是因为会撞唯一索引（legacySkuCode 本就不受唯一约束），而是防止扫码
    // 歧义：那张已打印的旧标签本该扫出升级前的商品 A，若新商品 B 直接复用同一字符串当 skuCode，扫码反而
    // 会跳到 B。B9 批次曾把这条断言改成“可以直接复用”，只顾了建档不因撞唯一索引失败，忽略了扫码歧义，
    // 这里改回来。
    // 复现路径：legacy 商品自动生成 P-YYMMDD-NNNN 且为当日最大 → 升级到 YZ（旧 skuCode 写入不受唯一约束
    // 限制的 legacySkuCode，旧 productCode 写入 legacyProductCode）→ 当天再建一个 legacy 商品。
    const recycleTag = await createSeriesTag('RC')
    const recycleProduct = await productService.create({
      productName: `yz-recycle-${verifySeed}`,
      pinyinAbbr: 'RC',
      defaultPrice: 10,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'unlisted',
      currentStock: 0,
      limitPerUser: 5,
    } as Parameters<typeof productService.create>[0], actor)
    const recycledProductCode = recycleProduct.productCode
    assert.ok(/^P-\d{6}-\d{4}$/.test(recycledProductCode), 'legacy 商品应走 P-YYMMDD-NNNN 自动编码')
    const recycledSkuCode = recycleProduct.skus[0].skuCode

    await productService.upgradeProductToYzCode(
      recycleProduct.id,
      { primarySeriesTagId: recycleTag.id },
      actor,
    )
    const legacyCodeRow = await skuRepo.findOneBy({ legacySkuCode: recycledSkuCode })
    assert.ok(legacyCodeRow, '升级后旧 skuCode 应已写入 legacySkuCode')
    assert.equal(legacyCodeRow!.barcode, null, '该 SKU 原厂条码为空，升级后 barcode 不应被回填')

    // P1-A 同时修复了 generateProductCode：查当日最大值时同时考虑 legacy_product_code 列，自动生成不应
    // 再自然复现“重新取到腾出的号”这一幕。先验证这层保护确实生效。
    const autoNextAfterRecycle = await productService.create({
      productName: `yz-recycle-auto-next-${verifySeed}`,
      pinyinAbbr: 'AN',
      defaultPrice: 10,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'unlisted',
      currentStock: 0,
      limitPerUser: 5,
    } as Parameters<typeof productService.create>[0], actor)
    assert.notEqual(
      autoNextAfterRecycle.productCode,
      recycledProductCode,
      'generateProductCode 修复后应避开已被占用的历史产品编码（legacy_product_code），自动生成不应再自然撞回腾出的号',
    )
    pass('generateProductCode 已避开 legacy_product_code：自动生成不再自然复现流水号被重新取到的场景')

    // 但手工填写 productCode（例如数据修复脚本、导入场景直接指定编号）仍可能绕开 generateProductCode
    // 这层保护，精确复现“新商品 B 与 A 升级前的旧编码相同”——这才是 replaceProductSkus 兜底要防的场景，
    // 与 generateProductCode 的修复互为补充，不是互相替代。
    const afterRecycle = await productService.create({
      productName: `yz-recycle-next-${verifySeed}`,
      pinyinAbbr: 'RN',
      productCode: recycledProductCode,
      defaultPrice: 10,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'unlisted',
      currentStock: 0,
      limitPerUser: 5,
    } as Parameters<typeof productService.create>[0], actor)
    assert.equal(
      afterRecycle.productCode,
      recycledProductCode,
      '当日流水号（历史编码）确实被新商品复用，场景真实复现',
    )
    assert.notEqual(
      afterRecycle.skus[0].skuCode,
      recycledSkuCode,
      '新商品的默认 SKU 码必须避开被占用的历史编码，防止扫码歧义',
    )
    const recycleScan = await productService.lookupByCode(recycledSkuCode)
    assert.equal(recycleScan.matchedBy, 'legacy_sku_code', '扫描该历史编码应命中 legacy_sku_code 路径')
    assert.equal(
      String(recycleScan.product.id),
      String(recycleProduct.id),
      '扫码应命中历史编码所属的升级前商品 A，而不是复用了同一产品编码的新商品 B',
    )
    pass('升级腾出的日期流水号被新商品复用产品编码时，新商品默认 SKU 码会自动避开历史编码；扫描旧标签仍准确命中升级前的商品')

    // 用例 24：Excel 导入可乱序精确占用系列内序号，不依赖“分组必须按序号升序处理”的调用顺序前提。
    // 早期实现是“把序列游标垫高到目标序号 - 1 再让内部 +1”，一旦分组顺序被打乱就会分配出错误的 productCode；
    // 现在 CreateProductInput.seriesSeq 直接走 reserveSeriesSeq 精确占用，乱序也必须正确。
    const outOfOrderTag = await createSeriesTag('OO')
    const buildSeqProduct = (seq: number | null, name: string) => ({
      productName: `${name}-${verifySeed}`,
      pinyinAbbr: 'OO',
      defaultPrice: 10,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'unlisted',
      currentStock: 0,
      limitPerUser: 5,
      primarySeriesTagId: outOfOrderTag.id,
      ...(seq === null ? {} : { seriesSeq: seq }),
    }) as Parameters<typeof productService.create>[0]

    // 先占大号，再占小号——顺序与升序假设完全相反。
    const seqTen = await productService.create(buildSeqProduct(10, 'yz-oo-ten'), actor)
    assert.equal(seqTen.productCode, 'YZOO10', '指定序号 10 应生成 YZOO10')
    assert.equal(seqTen.seriesSeq, 10)
    const seqThree = await productService.create(buildSeqProduct(3, 'yz-oo-three'), actor)
    assert.equal(seqThree.productCode, 'YZOO03', '倒序指定较小序号 3 仍应生成 YZOO03')
    assert.equal(seqThree.seriesSeq, 3)
    // 不指定序号的普通新建，应从已占用的最大号之后继续，而不是回退到 4。
    const seqAuto = await productService.create(buildSeqProduct(null, 'yz-oo-auto'), actor)
    assert.equal(seqAuto.seriesSeq, 11, '普通新建应续到 11，证明游标被精确占用抬高过')
    assert.equal(seqAuto.productCode, 'YZOO11')
    // 重复占用同一个序号必须被唯一索引拦下。
    await assert.rejects(
      productService.create(buildSeqProduct(10, 'yz-oo-dup'), actor),
      '.重复占用同一系列内序号应当失败',
    )
    pass('导入指定序号可乱序精确占用（10 → 3 → 自动 11），不依赖分组处理顺序，重复占用被拒')

    // ============ 第 4 批：B8 收尾——规格 key 改名双读兼容 + 规格取值重命名 + 0 号规格演进 ============

    // 用例 25：旧 key 兼容——历史 SKU 的 specValuesJson 直接写成旧格式 {"颜色":"米色","款式":"S"}，
    // 编辑时提交新 key（颜色/款式、尺码）的同一规格组合，必须原地复用该 SKU，不能退役旧行、新建一行。
    const legacyKeyTag = await createSeriesTag('LK')
    const legacyKeyProduct = await productService.create({
      productName: `legacy-key-product-${verifySeed}`,
      pinyinAbbr: 'LK',
      defaultPrice: 10,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'unlisted',
      currentStock: 0,
      limitPerUser: 5,
      primarySeriesTagId: legacyKeyTag.id,
      specGroups: [
        { name: '颜色/款式', values: ['米色'] },
        { name: '尺码', values: ['S'] },
      ],
      skus: [
        { specValues: { '颜色/款式': '米色', 尺码: 'S' }, defaultPrice: 10, currentStock: 0, isActive: true, sortOrder: 0 },
      ],
    } as Parameters<typeof productService.create>[0], actor)
    assert.equal(legacyKeyProduct.skus.length, 1)
    const legacyKeySkuId = legacyKeyProduct.skus[0].id
    const legacyKeySkuCode = legacyKeyProduct.skus[0].skuCode
    // 直接改库：把该 SKU 的 specValuesJson 改写成旧命名格式，模拟历史数据。
    await skuRepo.update({ id: legacyKeySkuId }, {
      specValuesJson: JSON.stringify({ 颜色: '米色', 款式: 'S' }),
    })
    const legacyKeyResaved = await productService.update(legacyKeyProduct.id, {
      specGroups: [
        { name: '颜色/款式', values: ['米色'] },
        { name: '尺码', values: ['S'] },
      ],
      skus: [
        { id: legacyKeySkuId, specValues: { '颜色/款式': '米色', 尺码: 'S' }, defaultPrice: 10, currentStock: 0, isActive: true, sortOrder: 0 },
      ],
    } as Parameters<typeof productService.update>[1], actor)
    assert.equal(legacyKeyResaved.skus.length, 1, '不应新建 SKU')
    assert.equal(legacyKeyResaved.skus[0].id, legacyKeySkuId, '应复用同一条 SKU（id 不变）')
    assert.equal(legacyKeyResaved.skus[0].skuCode, legacyKeySkuCode, 'skuCode 不应改变')
    assert.equal(legacyKeyResaved.skus[0].isCurrent, true, '不应把旧 key 的 SKU 判为退役')
    const legacyKeyRegistryRows = await registryRepo.findBy({ productId: legacyKeyProduct.id, axis: 'variant' })
    assert.equal(legacyKeyRegistryRows.length, 1, '不应因 key 不一致而重复分配变体码')
    pass('旧 key（颜色/款式）与新 key（一级变体轴="颜色/款式"、尺码轴="尺码"）提交的同一规格组合，正确匹配为同一条 SKU，不会误判退役+新建')

    // 用例 26：新写入用新 key——新建商品后直接读库，specValuesJson 的 key 必须是新命名。
    const newKeyTag = await createSeriesTag('NK')
    const newKeyProduct = await productService.create({
      productName: `new-key-product-${verifySeed}`,
      pinyinAbbr: 'NK',
      defaultPrice: 10,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'unlisted',
      currentStock: 0,
      limitPerUser: 5,
      primarySeriesTagId: newKeyTag.id,
      specGroups: [
        { name: '颜色/款式', values: ['藏青'] },
        { name: '尺码', values: ['M'] },
      ],
      skus: [
        { specValues: { '颜色/款式': '藏青', 尺码: 'M' }, defaultPrice: 10, currentStock: 0, isActive: true, sortOrder: 0 },
      ],
    } as Parameters<typeof productService.create>[0], actor)
    const newKeySkuRow = await skuRepo.findOneBy({ id: newKeyProduct.skus[0].id })
    const newKeySpecValues = JSON.parse(newKeySkuRow!.specValuesJson) as Record<string, string>
    assert.deepEqual([...Object.keys(newKeySpecValues)].sort(), ['尺码', '颜色/款式'])
    assert.equal(newKeySpecValues['颜色/款式'], '藏青')
    assert.equal(newKeySpecValues['尺码'], 'M')
    pass('新建商品的 specValuesJson 落库 key 为新命名「颜色/款式」与「尺码」')

    // 用例 27：规格组反推不重复——新旧 key 混合的商品调 detail，specGroups 维度名不应同时出现新旧四个维度。
    const dedupeTag = await createSeriesTag('DD')
    const dedupeProduct = await productService.create({
      productName: `dedupe-key-product-${verifySeed}`,
      pinyinAbbr: 'DD',
      defaultPrice: 10,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'unlisted',
      currentStock: 0,
      limitPerUser: 5,
      primarySeriesTagId: dedupeTag.id,
      specGroups: [
        { name: '颜色/款式', values: ['白色', '黑色'] },
        { name: '尺码', values: ['L'] },
      ],
      skus: [
        { specValues: { '颜色/款式': '白色', 尺码: 'L' }, defaultPrice: 10, currentStock: 0, isActive: true, sortOrder: 0 },
        { specValues: { '颜色/款式': '黑色', 尺码: 'L' }, defaultPrice: 10, currentStock: 0, isActive: true, sortOrder: 1 },
      ],
    } as Parameters<typeof productService.create>[0], actor)
    // 直接改库：把第一条 SKU 的 specValuesJson 改写成旧命名，另一条保持新 key，模拟新旧混杂的历史数据。
    await skuRepo.update({ id: dedupeProduct.skus[0].id }, {
      specValuesJson: JSON.stringify({ 颜色: '白色', 款式: 'L' }),
    })
    const dedupeDetail = await productService.detail(dedupeProduct.id)
    const dedupeDimensionNames = [...dedupeDetail.specGroups.map((group) => group.name)].sort()
    assert.deepEqual(dedupeDimensionNames, ['尺码', '颜色/款式'], '不应同时出现「颜色/款式」与「颜色」、「尺码」与「款式」四个维度')
    pass('规格组反推：新旧 key 混合的商品调 detail，specGroups 维度名只有新命名两个，不重复')

    // 用例 28：重命名端到端——「米色」改名「浅米色」，skuCode 与 variantCode 均不变，specValues/specText 更新。
    const specRenameTag = await createSeriesTag('SR')
    const specRenameProduct = await productService.create({
      productName: `spec-rename-product-${verifySeed}`,
      pinyinAbbr: 'SR',
      defaultPrice: 10,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'unlisted',
      currentStock: 0,
      limitPerUser: 5,
      primarySeriesTagId: specRenameTag.id,
      specGroups: [{ name: '颜色/款式', values: ['米色'] }],
      skus: [
        { specValues: { '颜色/款式': '米色' }, defaultPrice: 10, currentStock: 0, isActive: true, sortOrder: 0 },
      ],
    } as Parameters<typeof productService.create>[0], actor)
    const specRenameSku = specRenameProduct.skus[0]
    assert.equal(specRenameSku.variantCode, '1')
    const specRenamed = await productService.renameProductSpecValue(
      specRenameProduct.id,
      { axis: 'variant', oldValue: '米色', newValue: '浅米色' },
      actor,
    )
    const specRenamedSku = specRenamed.skus.find((sku) => sku.id === specRenameSku.id)
    assert.ok(specRenamedSku, '重命名后应仍能找到同一条 SKU')
    assert.equal(specRenamedSku!.skuCode, specRenameSku.skuCode, 'skuCode 不应改变')
    assert.equal(specRenamedSku!.variantCode, specRenameSku.variantCode, 'variantCode 不应改变')
    assert.equal(specRenamedSku!.specValues['颜色/款式'], '浅米色', 'specValues 应更新为新名称')
    assert.ok(specRenamedSku!.specText.includes('浅米色'), 'specText 应包含新名称')
    pass('重命名规格取值：skuCode 与 variantCode 均不变，specValues/specText 更新为新名称')

    // 用例 29：legacy 商品拒绝重命名 / 0 号规格演进——两个新接口都要求 codeScheme === 'yz'。
    await assert.rejects(
      () => productService.renameProductSpecValue(
        legacyProduct.id,
        { axis: 'variant', oldValue: '米色', newValue: '浅米色' },
        actor,
      ),
      (error) => assertBizErrorWithStatus(error, 400),
    )
    await assert.rejects(
      () => productService.evolveProductZeroSpec(
        legacyProduct.id,
        { axis: 'variant', mode: 'inherit', inheritValue: '红色' },
        actor,
      ),
      (error) => assertBizErrorWithStatus(error, 400),
    )
    pass('legacy 商品调用规格取值重命名 / 0 号规格演进均抛 400')

    // 用例 30：0 号继承端到端——无变体商品继承颜色/款式取值，skuCode 与库存完全不变，登记表 code='0'；
    // 随后再新增「蓝色」应走常规分配路径，取得 code='1'。
    const inheritTag = await createSeriesTag('IH')
    const inheritProduct = await productService.create({
      productName: `inherit-product-${verifySeed}`,
      pinyinAbbr: 'IH',
      defaultPrice: 10,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'unlisted',
      currentStock: 5,
      limitPerUser: 5,
      primarySeriesTagId: inheritTag.id,
    } as Parameters<typeof productService.create>[0], actor)
    assert.equal(inheritProduct.skus.length, 1)
    const inheritSkuBefore = inheritProduct.skus[0]
    assert.equal(inheritSkuBefore.variantCode, '0')
    assert.equal(inheritSkuBefore.sizeCode, null)
    assert.ok(
      /^YZ[A-Z]{2}\d{2}0$/.test(inheritSkuBefore.skuCode),
      `无变体商品 skuCode 应形如 YZxx010，实际 ${inheritSkuBefore.skuCode}`,
    )
    const inherited = await productService.evolveProductZeroSpec(
      inheritProduct.id,
      { axis: 'variant', mode: 'inherit', inheritValue: '红色' },
      actor,
    )
    const inheritedSku = inherited.skus.find((sku) => sku.id === inheritSkuBefore.id)
    assert.ok(inheritedSku, '继承后应仍能找到同一条 SKU')
    assert.equal(inheritedSku!.skuCode, inheritSkuBefore.skuCode, 'skuCode 应完全不变')
    assert.equal(inheritedSku!.currentStock, inheritSkuBefore.currentStock, '库存不应改变')
    assert.equal(inheritedSku!.specValues['颜色/款式'], '红色', 'specValues 应多了颜色值')
    const redRegistryRow = await registryRepo.findOneBy({ productId: inheritProduct.id, axis: 'variant', specValue: '红色' })
    assert.equal(redRegistryRow?.code, '0', '登记表里红色的 code 应是 0')
    const withBlueAfterInherit = await productService.update(inheritProduct.id, {
      specGroups: [{ name: '颜色/款式', values: ['红色', '蓝色'] }],
      skus: [
        {
          id: inheritedSku!.id,
          specValues: { '颜色/款式': '红色' },
          defaultPrice: 10,
          currentStock: inheritedSku!.currentStock,
          isActive: true,
          sortOrder: 0,
        },
        { specValues: { '颜色/款式': '蓝色' }, defaultPrice: 10, currentStock: 0, isActive: true, sortOrder: 1 },
      ],
    } as Parameters<typeof productService.update>[1], actor)
    const blueSkuAfterInherit = withBlueAfterInherit.skus.find((sku) => sku.specValues['颜色/款式'] === '蓝色')
    assert.ok(blueSkuAfterInherit, '应能新增蓝色规格')
    assert.equal(blueSkuAfterInherit!.variantCode, '1', '0 号继承后新增蓝色应取得变体码 1')
    pass('0 号继承：skuCode 与库存不变，登记表红色 code=0；随后新增蓝色取得变体码 1')

    // 用例 31：0 号保留端到端——原 SKU 退役但行保留、skuCode 不变；随后新增「红色」取得变体码 1。
    const retainTag = await createSeriesTag('RT')
    const retainProduct = await productService.create({
      productName: `retain-product-${verifySeed}`,
      pinyinAbbr: 'RT',
      defaultPrice: 10,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'unlisted',
      currentStock: 3,
      limitPerUser: 5,
      primarySeriesTagId: retainTag.id,
    } as Parameters<typeof productService.create>[0], actor)
    const retainSkuBefore = retainProduct.skus[0]
    assert.equal(retainSkuBefore.variantCode, '0')
    const retained = await productService.evolveProductZeroSpec(
      retainProduct.id,
      { axis: 'variant', mode: 'retain' },
      actor,
    )
    assert.ok(
      !retained.skus.some((sku) => sku.id === retainSkuBefore.id),
      '退役后的 SKU 不应出现在当前有效矩阵里',
    )
    const retiredRow = await skuRepo.findOneBy({ id: retainSkuBefore.id })
    assert.ok(retiredRow, '退役行必须仍在库里，不能被删除')
    assert.equal(isDatabaseFlagEnabled(retiredRow!.isCurrent), false, '退役行 isCurrent 应为 false')
    assert.equal(retiredRow!.skuCode, retainSkuBefore.skuCode, 'skuCode 不应改变')
    const afterRetain = await productService.update(retainProduct.id, {
      specGroups: [{ name: '颜色/款式', values: ['红色'] }],
      skus: [
        { specValues: { '颜色/款式': '红色' }, defaultPrice: 10, currentStock: 0, isActive: true, sortOrder: 0 },
      ],
    } as Parameters<typeof productService.update>[1], actor)
    const afterRetainSku = afterRetain.skus.find((sku) => sku.specValues['颜色/款式'] === '红色')
    assert.ok(afterRetainSku, '应能新增红色规格')
    assert.equal(afterRetainSku!.variantCode, '1', '0 号保留后新增红色应取得变体码 1')
    pass('0 号保留：原 SKU 退役但行保留、skuCode 不变；随后新增红色取得变体码 1')

    // 用例 32：原样回传当前文创系列时，编辑其它字段必须放行。
    // 回归场景：前端编辑弹窗里系列选择器虽然禁用，但仍会把当前 primarySeriesTagId 一起提交；
    // 早期实现把入参归一化成字符串后直接与实体字段比较，而 SQLite 下主键读出来是 number，
    // "5" !== 5 恒成立，于是只改商品名也会被「YZ 编码商品的文创系列不可修改」拦下。
    const keepSeriesTag = await createSeriesTag('KS')
    const keepSeriesProduct = await productService.create({
      productName: `yz-keep-series-${verifySeed}`,
      pinyinAbbr: 'KS',
      defaultPrice: 20,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'unlisted',
      currentStock: 0,
      limitPerUser: 5,
      primarySeriesTagId: keepSeriesTag.id,
    } as Parameters<typeof productService.create>[0], actor)
    const keptProductCode = keepSeriesProduct.productCode

    // 原样回传当前系列（模拟前端提交禁用字段），只改商品名。
    const renamedProduct = await productService.update(
      keepSeriesProduct.id,
      {
        productName: `yz-keep-series-renamed-${verifySeed}`,
        primarySeriesTagId: keepSeriesProduct.primarySeriesTagId,
      } as Parameters<typeof productService.update>[1],
      actor,
    )
    assert.equal(renamedProduct.productName, `yz-keep-series-renamed-${verifySeed}`, '原样回传当前系列时应放行改名')
    assert.equal(renamedProduct.productCode, keptProductCode, '编码不应因编辑而变化')

    // 用数字形态的同一个系列 ID 再提交一次，覆盖主键类型差异。
    const numericSeriesId = Number(keepSeriesProduct.primarySeriesTagId)
    if (Number.isFinite(numericSeriesId)) {
      const renamedAgain = await productService.update(
        keepSeriesProduct.id,
        {
          productName: `yz-keep-series-numeric-${verifySeed}`,
          primarySeriesTagId: numericSeriesId,
        } as unknown as Parameters<typeof productService.update>[1],
        actor,
      )
      assert.equal(renamedAgain.productName, `yz-keep-series-numeric-${verifySeed}`, '数字形态的同一系列 ID 同样应放行')
    }

    // 真正切换到另一个系列仍必须被拒绝。
    const otherSeriesTag = await createSeriesTag('OS')
    await assert.rejects(
      productService.update(
        keepSeriesProduct.id,
        { primarySeriesTagId: otherSeriesTag.id } as Parameters<typeof productService.update>[1],
        actor,
      ),
      (error: unknown) => assertBizErrorWithStatus(error, 400),
      '切换到其它文创系列应当仍被拒绝',
    )
    pass('原样回传当前文创系列（含数字形态主键）可正常编辑其它字段，真正切换系列仍被拒绝')

    // ============ 第 5 批：B9 —— 历史编码字段落位、扫码兼容与优先级 ============

    // 用例 33：升级写历史编码——legacyProductCode 等于升级前 productCode，每条当前 SKU 的 legacySkuCode
    // 等于其升级前 skuCode；同时验证不再污染条码：原本为空的 barcode 升级后仍为 null，原本有真实原厂
    // 条码的 SKU 保持原值不变。
    const legacyCodeTag = await createSeriesTag('LC')
    const legacyCodeProduct = await productService.create({
      productCode: nextProductCode(),
      productName: `legacy-code-${verifySeed}`,
      pinyinAbbr: 'LC',
      defaultPrice: 20,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'unlisted',
      currentStock: 0,
      limitPerUser: 5,
      skus: [
        { specValues: { 颜色: '蓝色' }, defaultPrice: 20, currentStock: 0, isActive: true, sortOrder: 0, barcode: `FACT-${verifySeed}` },
        { specValues: { 颜色: '绿色' }, defaultPrice: 20, currentStock: 0, isActive: true, sortOrder: 1 },
      ],
    } as Parameters<typeof productService.create>[0], actor)
    const oldLegacyCodeProductCode = legacyCodeProduct.productCode
    const oldLegacyCodeSkuCodeById = new Map(legacyCodeProduct.skus.map((sku) => [sku.id, sku.skuCode]))
    const legacyCodeUpgraded = await productService.upgradeProductToYzCode(
      legacyCodeProduct.id,
      { primarySeriesTagId: legacyCodeTag.id },
      actor,
    )
    assert.equal(legacyCodeUpgraded.legacyProductCode, oldLegacyCodeProductCode, 'legacyProductCode 应等于升级前 productCode')
    assert.equal(legacyCodeUpgraded.skus.length, 2)
    legacyCodeUpgraded.skus.forEach((sku) => {
      const oldCode = oldLegacyCodeSkuCodeById.get(sku.id)
      assert.ok(oldCode, `应找到 SKU ${sku.id} 升级前的编码`)
      assert.equal(sku.legacySkuCode, oldCode, '每条当前 SKU 的 legacySkuCode 应等于其升级前的 skuCode')
      if (sku.specValues['颜色'] === '蓝色') {
        assert.equal(sku.barcode, `FACT-${verifySeed}`, '原本有真实原厂条码的 SKU 升级后 barcode 应保持原值不变')
      } else {
        assert.equal(sku.barcode, null, '原本条码为空的 SKU 升级后 barcode 仍应为 null')
      }
    })
    pass('升级写历史编码：legacyProductCode 等于升级前 productCode，各当前 SKU 的 legacySkuCode 等于其升级前 skuCode，barcode 不受污染')

    // 用例 34：旧码可扫——用升级前的旧 skuCode 调 lookupByCode，应命中该 SKU 且 matchedBy 为 legacy_sku_code。
    const legacyCodeGreenSku = legacyCodeUpgraded.skus.find((sku) => sku.specValues['颜色'] === '绿色')
    assert.ok(legacyCodeGreenSku, '应存在绿色 SKU')
    const oldGreenSkuCode = oldLegacyCodeSkuCodeById.get(legacyCodeGreenSku!.id)
    assert.ok(oldGreenSkuCode, '应找到绿色 SKU 升级前的编码')
    const legacyLookup = await productService.lookupByCode(oldGreenSkuCode!)
    assert.equal(legacyLookup.matchedBy, 'legacy_sku_code', '用升级前的旧 skuCode 扫码应命中历史编码路径')
    assert.equal(legacyLookup.sku.id, legacyCodeGreenSku!.id, '应命中对应的 SKU')
    pass('旧码可扫：用升级前的旧 skuCode 调 lookupByCode 能命中该 SKU，matchedBy 为 legacy_sku_code')

    // 用例 35：优先级正确——构造「A 商品的 skuCode」恰好等于「B 商品的 legacySkuCode」的场景，
    // 断言 lookupByCode 优先返回 A（SKU 编码命中优先于历史编码命中）。这里复用用例 33 里蓝色 SKU
    // 升级前的旧编码：升级后它只活在 legacyCodeUpgraded 蓝色 SKU 的 legacySkuCode 里（不受唯一约束），
    // 因此可以把同一个字符串显式指定为另一个新商品 B 的真实 skuCode。
    const oldBlueSkuCode = oldLegacyCodeSkuCodeById.get(
      legacyCodeUpgraded.skus.find((sku) => sku.specValues['颜色'] === '蓝色')!.id,
    )
    assert.ok(oldBlueSkuCode, '应找到蓝色 SKU 升级前的编码')
    const priorityProduct = await productService.create({
      productCode: nextProductCode(),
      productName: `legacy-priority-${verifySeed}`,
      pinyinAbbr: 'PR',
      defaultPrice: 15,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'unlisted',
      currentStock: 0,
      limitPerUser: 5,
      skus: [
        { defaultPrice: 15, currentStock: 0, isActive: true, sortOrder: 0, skuCode: oldBlueSkuCode },
      ],
    } as Parameters<typeof productService.create>[0], actor)
    const priorityLookup = await productService.lookupByCode(oldBlueSkuCode!)
    assert.equal(priorityLookup.matchedBy, 'sku_code', 'SKU 编码命中应优先于历史编码命中')
    assert.equal(priorityLookup.product.id, priorityProduct.id, '应返回当前 SKU 编码命中的商品 A，而不是历史编码命中的商品 B')
    assert.equal(priorityLookup.sku.id, priorityProduct.skus[0].id, '应返回 A 商品的 SKU，而不是 B 商品退役的历史编码')
    pass('优先级正确：A 商品当前 skuCode 恰好等于 B 商品的 legacySkuCode 时，lookupByCode 优先返回 A（SKU 编码命中优先于历史编码命中）')

    // ============ 第 6 批：PR #109 评审修复（P1-1 / P1-2 / P1-3）============

    // 用例 36（P1-1）：拒绝把 0 号规格继承给已登记的取值。
    // 商品同时有一条"无一级变体"的 SKU（variantCode='0'）和一条已登记的「红色」SKU（variantCode='1'），
    // 对 0 号 SKU 以 inherit 模式传已登记的「红色」必须被拒绝；传全新取值「紫色」则应正常继承、编码仍为 0。
    const dupInheritTag = await createSeriesTag('DI')
    const dupInheritProduct = await productService.create({
      productName: `dup-inherit-${verifySeed}`,
      pinyinAbbr: 'DI',
      defaultPrice: 10,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'unlisted',
      currentStock: 0,
      limitPerUser: 5,
      primarySeriesTagId: dupInheritTag.id,
      specGroups: [{ name: '颜色/款式', values: ['红色'] }],
      skus: [
        { specValues: {}, defaultPrice: 10, currentStock: 5, isActive: true, sortOrder: 0 },
        { specValues: { '颜色/款式': '红色' }, defaultPrice: 10, currentStock: 0, isActive: true, sortOrder: 1 },
      ],
    } as Parameters<typeof productService.create>[0], actor)
    assert.equal(dupInheritProduct.skus.length, 2)
    const dupZeroSku = dupInheritProduct.skus.find((sku) => sku.variantCode === '0')
    const dupRedSku = dupInheritProduct.skus.find((sku) => sku.variantCode === '1')
    assert.ok(dupZeroSku, '应存在一条无一级变体（0 号）的 SKU')
    assert.ok(dupRedSku, '应存在一条已登记为红色（变体码 1）的 SKU')
    await assert.rejects(
      () => productService.evolveProductZeroSpec(
        dupInheritProduct.id,
        { axis: 'variant', mode: 'inherit', inheritValue: '红色' },
        actor,
      ),
      (error) => assertBizErrorWithStatus(error, 400),
      '继承已登记过的取值「红色」应抛 400',
    )
    const dupInheritedOk = await productService.evolveProductZeroSpec(
      dupInheritProduct.id,
      { axis: 'variant', mode: 'inherit', inheritValue: '紫色' },
      actor,
    )
    const dupZeroSkuAfter = dupInheritedOk.skus.find((sku) => sku.id === dupZeroSku!.id)
    assert.ok(dupZeroSkuAfter, '继承成功后应仍能找到同一条 SKU')
    assert.equal(dupZeroSkuAfter!.variantCode, '0', '继承一个全新取值后编码应仍为 0')
    assert.equal(dupZeroSkuAfter!.specValues['颜色/款式'], '紫色', 'specValues 应更新为紫色')
    pass('拒绝把 0 号规格继承给已登记的取值（红色→400），全新取值（紫色）正常继承且编码为 0')

    // 用例 37（P1-2）：升级前校验新编码与全局条码的冲突。
    // 先对商品 B 预检拿到升级后会生成的 skuCode，再建商品 A 并把某个 SKU 的原厂条码手工设成这个字符串，
    // 之后 B 的预检应给出 blockingReason，正式升级应抛 409。
    const conflictSeriesTag = await createSeriesTag('CX')
    const conflictUpgradeProductB = await productService.create({
      productCode: nextProductCode(),
      productName: `conflict-upgrade-b-${verifySeed}`,
      pinyinAbbr: 'CB',
      defaultPrice: 10,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'unlisted',
      currentStock: 0,
      limitPerUser: 5,
    } as Parameters<typeof productService.create>[0], actor)
    const previewBeforeConflict = await productService.previewProductYzUpgrade(conflictUpgradeProductB.id, conflictSeriesTag.id)
    assert.equal(previewBeforeConflict.blockingReason, null, '未产生冲突前预检不应有 blockingReason')
    const predictedConflictSkuCode = previewBeforeConflict.skuChanges[0]?.newSkuCode
    assert.ok(predictedConflictSkuCode, '预检应能给出升级后的 skuCode')

    const conflictOwnerProductA = await productService.create({
      productCode: nextProductCode(),
      productName: `conflict-upgrade-a-${verifySeed}`,
      pinyinAbbr: 'CA',
      defaultPrice: 10,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'unlisted',
      currentStock: 0,
      limitPerUser: 5,
      skus: [
        { defaultPrice: 10, currentStock: 0, isActive: true, sortOrder: 0, barcode: predictedConflictSkuCode },
      ],
    } as Parameters<typeof productService.create>[0], actor)
    assert.equal(conflictOwnerProductA.skus[0].barcode, predictedConflictSkuCode, 'A 商品 SKU 的原厂条码应等于 B 升级后会生成的编码')

    const previewAfterConflict = await productService.previewProductYzUpgrade(conflictUpgradeProductB.id, conflictSeriesTag.id)
    assert.ok(previewAfterConflict.blockingReason, '预检应识别出跨列冲突并给出 blockingReason')
    assert.ok(
      previewAfterConflict.blockingReason!.includes(predictedConflictSkuCode!),
      'blockingReason 应指明具体冲突的编码',
    )

    await assert.rejects(
      () => productService.upgradeProductToYzCode(
        conflictUpgradeProductB.id,
        { primarySeriesTagId: conflictSeriesTag.id },
        actor,
      ),
      (error) => assertBizErrorWithStatus(error, 409),
      '新编码与其他商品 SKU 原厂条码冲突时正式升级应抛 409',
    )
    pass('升级前校验新编码与全局条码的冲突：预检给出 blockingReason，正式升级抛 409')

    // 用例 38（P1-3）：禁止修改已被 YZ 商品使用的系列编码。
    const guardedSeriesTag = await tagService.create(
      { tagName: `guarded-series-${verifySeed}`, seriesCode: 'TG' },
      actor,
    )
    await productService.create({
      productName: `guarded-series-product-${verifySeed}`,
      pinyinAbbr: 'TG',
      defaultPrice: 10,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'unlisted',
      currentStock: 0,
      limitPerUser: 5,
      primarySeriesTagId: guardedSeriesTag.id,
    } as Parameters<typeof productService.create>[0], actor)

    await assert.rejects(
      () => tagService.update(guardedSeriesTag.id, { seriesCode: 'ZZ' }, actor),
      (error) => assertBizErrorWithStatus(error, 409),
      '已被 YZ 商品使用的标签修改 seriesCode 应抛 409',
    )
    const guardedRenamed = await tagService.update(
      guardedSeriesTag.id,
      { tagName: `guarded-series-renamed-${verifySeed}` },
      actor,
    )
    assert.equal(guardedRenamed.tagName, `guarded-series-renamed-${verifySeed}`, '只改标签名不动 seriesCode 应放行')
    assert.equal(guardedRenamed.seriesCode, 'TG', 'seriesCode 应保持不变')

    const freeSeriesTag = await tagService.create(
      { tagName: `free-series-${verifySeed}`, seriesCode: 'UZ' },
      actor,
    )
    const freeSeriesUpdated = await tagService.update(freeSeriesTag.id, { seriesCode: 'UY' }, actor)
    assert.equal(freeSeriesUpdated.seriesCode, 'UY', '未被任何商品使用的标签修改 seriesCode 应放行')

    // 顺带确认标签删除同样被拦：即使 RelProductTag 关联被移除，primarySeriesTagId 仍指向该标签时也不能删。
    await assert.rejects(
      () => tagService.delete(guardedSeriesTag.id, actor),
      (error) => assertBizErrorWithStatus(error, 409),
      '已被 YZ 商品用作主系列的标签应拒绝删除',
    )
    pass('禁止修改已被 YZ 商品使用的系列编码：改 seriesCode 抛 409，只改名放行，未使用的标签可正常修改 seriesCode；删除同样被拦')

    // 用例 39（P1-B）：retain 模式退役 0 号 SKU 时，若它没有预订占用但仍有物理库存，移出商品汇总导致的
    // currentStock 变化必须能在库存流水里找到对应记录——方案一：复用商品编辑路径已有的
    // captureProductStockSnapshot / recordManualStockAdjustments，退役前拍快照、退役落库后按快照与
    // 落库结果的差异自动生成流水，口径与普通商品编辑停用/退役 SKU 完全一致。
    const { InventoryLog } = await import('../src/entities/inventory-log.entity.js')
    const inventoryLogRepo = AppDataSource.getRepository(InventoryLog)
    const stockRetainTag = await createSeriesTag('SK')
    const stockRetainProduct = await productService.create({
      productName: `yz-stock-retain-${verifySeed}`,
      pinyinAbbr: 'SK',
      defaultPrice: 10,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'unlisted',
      currentStock: 6,
      limitPerUser: 5,
      primarySeriesTagId: stockRetainTag.id,
    } as Parameters<typeof productService.create>[0], actor)
    const stockRetainSkuBefore = stockRetainProduct.skus[0]
    assert.equal(stockRetainSkuBefore.variantCode, '0', '退役前应是 0 号一级变体')
    assert.equal(stockRetainSkuBefore.currentStock, 6, '退役前 0 号 SKU 应携带商品级初始物理库存')
    assert.equal(stockRetainProduct.currentStock, 6, '商品汇总库存应等于该唯一 SKU 的物理库存')

    const stockRetained = await productService.evolveProductZeroSpec(
      stockRetainProduct.id,
      { axis: 'variant', mode: 'retain' },
      actor,
    )
    assert.equal(stockRetained.currentStock, 0, '唯一有库存的 0 号 SKU 退役后，商品汇总库存应归零')

    const retainLogs = await inventoryLogRepo.find({
      where: { productId: stockRetainProduct.id },
      order: { id: 'ASC' },
    })
    // 建档时已经写过一条初始库存流水（changeQty=+6），这里要找的是退役这一步新产生的那条
    // （changeQty=-6，SKU 从计入汇总变为不计入汇总），按 skuId 命中的第一条会是创建时的旧记录，必须
    // 用符号区分开。
    assert.ok(retainLogs.length > 1, '退役有物理库存的 0 号 SKU 必须在建档流水之外再写入一条库存流水，不能只改汇总不留痕迹')
    const retireLog = retainLogs.find((log) => String(log.skuId) === String(stockRetainSkuBefore.id) && Number(log.changeQty) < 0)
    assert.ok(retireLog, '应能找到该 SKU 对应的退役流水（changeQty 为负）')
    assert.equal(Number(retireLog!.changeQty), -6, '退役流水的变化量应等于该 SKU 被移出汇总前的物理库存')
    assert.equal(Number(retireLog!.beforeCurrentStock), 6, '流水记录的退役前商品汇总库存应为 6')
    assert.equal(Number(retireLog!.afterCurrentStock), 0, '流水记录的退役后商品汇总库存应为 0')
    const productAfterStockRetain = await productRepo.findOneBy({ id: stockRetainProduct.id })
    assert.equal(Number(productAfterStockRetain!.currentStock), 0, '数据库里的商品汇总库存应与流水记录的退役后库存一致')
    pass('retain 模式退役有物理库存的 0 号 SKU：写入库存流水，流水记录的前后汇总与落库汇总一致（复用 recordManualStockAdjustments）')

    // 用例 40（P2-C）：编辑 YZ 商品时，即使 primarySeriesTagId 没变，只要请求里的 tagIds 不含当前主系列
    // 标签，也必须强制把它并入后再执行标签关联替换，保证“主系列标签必须存在于标签关联”这一不变量
    // 在创建、升级、编辑三条路径下始终成立。
    const dropSeriesTag = await createSeriesTag('DS')
    const otherTag = await tagService.create({ tagName: `other-tag-${verifySeed}` }, actor)
    const dropSeriesProduct = await productService.create({
      productName: `yz-drop-series-tag-${verifySeed}`,
      pinyinAbbr: 'DS',
      defaultPrice: 10,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'unlisted',
      currentStock: 0,
      limitPerUser: 5,
      primarySeriesTagId: dropSeriesTag.id,
    } as Parameters<typeof productService.create>[0], actor)
    const relRepoModule = await import('../src/entities/rel-product-tag.entity.js')
    const relTagRepo = AppDataSource.getRepository(relRepoModule.RelProductTag)
    const relsBeforeDrop = await relTagRepo.find({ where: { productId: dropSeriesProduct.id } })
    assert.ok(
      relsBeforeDrop.some((rel) => String(rel.tagId) === String(dropSeriesTag.id)),
      '创建时主系列标签应已自动出现在标签关联里',
    )

    // 提交的 tagIds 只带一个不相关的标签，刻意不带主系列标签——模拟用户在独立的“关联标签”选择器里把它移除。
    const afterDropSeriesTag = await productService.update(dropSeriesProduct.id, {
      tagIds: [otherTag.id],
    } as Parameters<typeof productService.update>[1], actor)
    assert.equal(String(afterDropSeriesTag.primarySeriesTagId), String(dropSeriesTag.id), 'primarySeriesTagId 不应被改动')
    const relsAfterDrop = await relTagRepo.find({ where: { productId: dropSeriesProduct.id } })
    assert.ok(
      relsAfterDrop.some((rel) => String(rel.tagId) === String(dropSeriesTag.id)),
      '即使提交的 tagIds 不含主系列标签，保存后该商品的标签关联里仍必须包含主系列标签',
    )
    assert.ok(
      relsAfterDrop.some((rel) => String(rel.tagId) === String(otherTag.id)),
      '用户显式提交的其它标签也应正常保留',
    )
    assert.equal(
      relsAfterDrop.filter((rel) => String(rel.tagId) === String(dropSeriesTag.id)).length,
      1,
      '强制并入主系列标签必须幂等，不能产生重复关联行',
    )

    // 再提交一次已经包含主系列标签的 tagIds，确认幂等，不会因为“已包含”而报错或产生第二条重复行。
    const afterKeepSeriesTag = await productService.update(dropSeriesProduct.id, {
      tagIds: [otherTag.id, dropSeriesTag.id],
    } as Parameters<typeof productService.update>[1], actor)
    assert.equal(String(afterKeepSeriesTag.primarySeriesTagId), String(dropSeriesTag.id), 'primarySeriesTagId 不应被改动')
    const relsAfterKeep = await relTagRepo.find({ where: { productId: dropSeriesProduct.id } })
    assert.equal(
      relsAfterKeep.filter((rel) => String(rel.tagId) === String(dropSeriesTag.id)).length,
      1,
      '显式带上主系列标签时同样不能产生重复关联行',
    )
    pass('YZ 商品编辑：即使提交的 tagIds 不含主系列标签，保存后仍强制保留该关联，且强制并入具备幂等性')

    // ============ 第 8 批：PR #109 第三轮评审修复（P1-A / P1-B / P2-D）============

    // 用例 42（P1-A）：YZ 商品更新时禁止自定义 skuCode——派生值不一致必须拒绝，原样回传当前 skuCode 必须放行。
    const p1aTag = await createSeriesTag('MA')
    const p1aProduct = await productService.create({
      productName: `p1a-sku-code-${verifySeed}`,
      pinyinAbbr: 'MA',
      defaultPrice: 10,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'unlisted',
      currentStock: 0,
      limitPerUser: 5,
      primarySeriesTagId: p1aTag.id,
      specGroups: [{ name: '颜色/款式', values: ['红色'] }],
      skus: [
        { specValues: { '颜色/款式': '红色' }, defaultPrice: 10, currentStock: 0, isActive: true, sortOrder: 0 },
      ],
    } as Parameters<typeof productService.create>[0], actor)
    const p1aSku = p1aProduct.skus[0]
    assert.ok(yzSkuPattern.test(p1aSku.skuCode), `P1-A 测试商品的 SKU 码应符合 YZ 正则，实际 ${p1aSku.skuCode}`)

    await assert.rejects(
      () => productService.update(p1aProduct.id, {
        specGroups: [{ name: '颜色/款式', values: ['红色'] }],
        skus: [
          {
            id: p1aSku.id,
            specValues: { '颜色/款式': '红色' },
            defaultPrice: 10,
            currentStock: 0,
            isActive: true,
            sortOrder: 0,
            skuCode: `${p1aSku.skuCode}-FAKE`,
          },
        ],
      } as Parameters<typeof productService.update>[1], actor),
      (error: unknown) => assertBizErrorWithStatus(error, 400),
      'YZ 商品更新时传入与派生值不同的自定义 skuCode 应抛 400',
    )

    const p1aResaved = await productService.update(p1aProduct.id, {
      specGroups: [{ name: '颜色/款式', values: ['红色'] }],
      skus: [
        {
          id: p1aSku.id,
          specValues: { '颜色/款式': '红色' },
          defaultPrice: 10,
          currentStock: 0,
          isActive: true,
          sortOrder: 0,
          skuCode: p1aSku.skuCode,
        },
      ],
    } as Parameters<typeof productService.update>[1], actor)
    assert.equal(p1aResaved.skus[0].skuCode, p1aSku.skuCode, '原样回传当前 skuCode 应放行，编码保持不变')
    pass('P1-A：YZ 商品更新时传入与派生值不同的自定义 skuCode 抛 400；原样回传当前 skuCode 正常放行')

    // 用例 43（P1-B）：0 号一级变体继承给具体取值后，空规格不能再占用该 0 号；未继承过的商品清空规格轴仍正常返回 0。
    const p1bTag = await createSeriesTag('ZB')
    const p1bProduct = await createProduct(p1bTag.id, 1)
    const p1bInheritedCode = await runInTransaction((manager) =>
      resolveVariantCode(manager, p1bProduct.id, '红色', { inheritZeroCode: true }))
    assert.equal(p1bInheritedCode, '0', '0 号继承给红色应成功且编码为 0')
    await assert.rejects(
      runInTransaction((manager) => resolveVariantCode(manager, p1bProduct.id, null)),
      (error: unknown) => assertBizErrorWithStatus(error, 409),
      '0 号已继承给具体取值后，空一级变体轴不能再占用 0 号',
    )
    const p1bFreshTag = await createSeriesTag('ZF')
    const p1bFreshProduct = await createProduct(p1bFreshTag.id, 1)
    const p1bFreshZeroCode = await runInTransaction((manager) => resolveVariantCode(manager, p1bFreshProduct.id, null))
    assert.equal(p1bFreshZeroCode, '0', '未发生过 0 号继承的商品，空一级变体轴应正常返回 0，不能矫枉过正')
    pass('P1-B（一级变体轴）：0 号继承给红色后，空规格再解析抛 409；未继承过的商品空规格仍正常返回 0')

    // 尺码轴同理：空尺码位继承给「均码」后，空尺码不能再占用该位；未继承过的商品空尺码仍正常返回 null。
    const p1bSizeTag = await createSeriesTag('ZS')
    const p1bSizeProduct = await createProduct(p1bSizeTag.id, 1)
    const p1bInheritedSizeCode = await runInTransaction((manager) =>
      resolveSizeCode(manager, p1bSizeProduct.id, '均码', { inheritEmptySize: true }))
    assert.equal(p1bInheritedSizeCode, null, '空尺码位继承给均码应成功且返回 null（不占用 A-E 候选池）')
    await assert.rejects(
      runInTransaction((manager) => resolveSizeCode(manager, p1bSizeProduct.id, null)),
      (error: unknown) => assertBizErrorWithStatus(error, 409),
      '空尺码位已继承给具体取值后，空尺码轴不能再占用该位',
    )
    const p1bSizeFreshTag = await createSeriesTag('ZT')
    const p1bSizeFreshProduct = await createProduct(p1bSizeFreshTag.id, 1)
    const p1bFreshSizeCode = await runInTransaction((manager) => resolveSizeCode(manager, p1bSizeFreshProduct.id, null))
    assert.equal(p1bFreshSizeCode, null, '未发生过空尺码位继承的商品，空尺码轴应正常返回 null，不能矫枉过正')
    pass('P1-B（尺码轴）：空尺码位继承给均码后，空尺码再解析抛 409；未继承过的商品空尺码仍正常返回 null')

    // 用例 44（P2-D）：renameProductSpecValue 传超长 newValue 应抛 400 且文案包含长度提示。
    const p2dTag = await createSeriesTag('SL')
    const p2dProduct = await productService.create({
      productName: `p2d-spec-length-${verifySeed}`,
      pinyinAbbr: 'SL',
      defaultPrice: 10,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'unlisted',
      currentStock: 0,
      limitPerUser: 5,
      primarySeriesTagId: p2dTag.id,
      specGroups: [{ name: '颜色/款式', values: ['米色'] }],
      skus: [
        { specValues: { '颜色/款式': '米色' }, defaultPrice: 10, currentStock: 0, isActive: true, sortOrder: 0 },
      ],
    } as Parameters<typeof productService.create>[0], actor)
    const overLongValue = '长'.repeat(65)
    await assert.rejects(
      () => productService.renameProductSpecValue(
        p2dProduct.id,
        { axis: 'variant', oldValue: '米色', newValue: overLongValue },
        actor,
      ),
      (error: unknown) => error instanceof BizError
        && error.statusCode === 400
        && error.message.includes('64')
        && error.message.includes('65'),
      '规格取值重命名传入 65 字符的 newValue 应抛 400 且文案含长度提示',
    )
    pass('P2-D：renameProductSpecValue 传入超过 64 字符的 newValue 抛 400，文案含上限与当前字符数')

    // ============ P2-C 说明 ============
    // 系列码变更与 YZ 建档/升级读取系列码现在共用 buildSeriesCodeMutexKey(tagId) 这把互斥锁
    // （tag.service.ts 的 update() 与 product.service.ts 的 loadAndLockSeriesTagForYzScheme）。
    // 真正的并发竞态（改系列码事务与建档事务同时进行）依赖数据库行锁在多个数据库连接间生效，只有
    // MySQL 才有意义；单进程、单连接的 SQLite 验证脚本无法可靠构造两个真正并发的数据库事务，勉强模拟
    // 出来的"竞态"要么因为写事务队列串行化而必然不竞态、要么是脆弱的时序巧合，因此这里不构造不可靠的
    // 竞态测试。改为验证加锁本身可用：同一把互斥键在同一事务内可以重复获取而不抛错、不死锁，作为
    // acquireSequenceMutex(manager, buildSeriesCodeMutexKey(tagId)) 这条调用链未被破坏的回归信号；
    // 真正的跨连接并发序列化需要另外在 MySQL 环境下做端到端验证，本次未做，详见任务回报。
    const mutexSmokeTag = await createSeriesTag('MX')
    await runInTransaction(async (manager) => {
      await acquireSequenceMutex(manager, buildSeriesCodeMutexKey(mutexSmokeTag.id))
      await acquireSequenceMutex(manager, buildSeriesCodeMutexKey(mutexSmokeTag.id))
    })
    pass('P2-C：改用 buildSeriesCodeMutexKey(tagId) 互斥键串行化（tag.service.ts 改系列码 / product.service.ts 建档与升级共用），同键同事务内可重复获取不报错；真正的跨连接并发竞态未做端到端验证，原因见回报说明')
  } finally {
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy()
    }
    cleanupSqliteFile()
  }
}

main().catch((error) => {
  console.error(`[product-yz-code-verify] verification failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
})
