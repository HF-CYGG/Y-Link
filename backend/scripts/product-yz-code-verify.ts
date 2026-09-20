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
  const { BaseYzSeriesSeqReservation } = await import('../src/entities/base-yz-series-seq-reservation.entity.js')
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
    const reservationRepo = AppDataSource.getRepository(BaseYzSeriesSeqReservation)

    let productCodeCounter = 0
    const nextProductCode = () => {
      productCodeCounter += 1
      return `YZTEST${productCodeCounter}-${verifySeed}`
    }

    // allocateSeriesSeq/reserveSeriesSeq 现在需要 seriesCode + prefix 用于写永久占用登记（P1 修复），
    // 本脚本内除专门验证自定义前缀的用例外都复用这份默认前缀。
    const defaultPrefix = await runInTransaction((manager) => getProductCodePrefix(manager))

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
      Array.from({ length: 8 }, () => runInTransaction((manager) => allocateSeriesSeq(manager, concurrentTag.id, 'CC', defaultPrefix))),
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
      await runInTransaction((manager) => reserveSeriesSeq(manager, reserveTag.id, seq, 'RS', defaultPrefix))
    }
    const nextAllocatedSeq = await runInTransaction((manager) => allocateSeriesSeq(manager, reserveTag.id, 'RS', defaultPrefix))
    assert.equal(nextAllocatedSeq, 27)
    pass('reserveSeriesSeq 预占 1..26 后 allocateSeriesSeq 返回 27')

    // 用例 3.5（P1 修复，PR #109 第四轮评审）：商品被物理删除后，系列内序号仍被永久占用登记表拦住，
    // 不会被重新分配给新商品——否则已打印的旧标签会悄悄指向新商品。
    const deletedTag = await createSeriesTag('DL')
    const deletedSeq = await runInTransaction((manager) => allocateSeriesSeq(manager, deletedTag.id, 'DL', defaultPrefix))
    assert.equal(deletedSeq, 1, '首次分配应得到序号 1')
    const deletedHistoryProductCode = formatProductCode(defaultPrefix, 'DL', deletedSeq)
    const deletedProduct = await createProduct(deletedTag.id, deletedSeq)
    await productRepo.delete({ id: deletedProduct.id })
    await assert.rejects(
      runInTransaction((manager) => reserveSeriesSeq(manager, deletedTag.id, deletedSeq, 'DL', defaultPrefix)),
      (error: unknown) => assertBizErrorWithStatus(error, 409) && (error as InstanceType<typeof BizError>).message.includes(deletedHistoryProductCode),
      '已删除商品占用过的序号，reserveSeriesSeq 应拒绝复用并抛 409，且文案带出历史编码',
    )
    const nextSeqAfterDeletion = await runInTransaction((manager) => allocateSeriesSeq(manager, deletedTag.id, 'DL', defaultPrefix))
    assert.equal(nextSeqAfterDeletion, 2, 'allocateSeriesSeq 应跳过已删除商品占用过的序号 1，直接取下一个序号 2')
    pass('P1 修复：商品被物理删除后，其系列内序号仍被永久占用——reserveSeriesSeq 抛 409（文案带历史编码），allocateSeriesSeq 自动跳号')

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
    // 升级前的旧编码：升级后它只活在 legacyCodeUpgraded 蓝色 SKU 的 legacySkuCode 里（不受唯一约束）。
    // 第六轮评审 P1-A 修复后，assertSkuRelationsValid 会拒绝任何普通写入把 skuCode/barcode 显式设成
    // 其他商品的 legacySkuCode——这正是本轮要堵住的口子，因此不能再像之前那样直接经 productService.create
    // 传入冲突的 skuCode 来构造场景（会被正确拒绝，语义变化是预期内的）。这里改为绕过服务层直接改写
    // 底层行，模拟"服务层校验之外已经存在的歧义数据"（例如本修复上线前的历史数据、或未来某条尚未纳入
    // 校验的写入路径遗留下来的数据）：lookupByCode 的优先级兜底就是为这类场景准备的最后一道防线，
    // 依然需要覆盖，用例本身要验证的不变量没有变化，只是构造手段必须换成服务层校验拦不住的路径。
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
    } as Parameters<typeof productService.create>[0], actor)
    await skuRepo.update({ id: priorityProduct.skus[0].id }, { skuCode: oldBlueSkuCode! })
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

    // ============ 第 9 批：PR #109 第五轮评审修复（P1-A / P1-B / P1-C）============

    // 用例 48（P1-A）：YZ 编码冲突必须拒绝，不能用 legacy 的后缀兜底——库里先有一条 barcode 恰好等于某
    // YZ 商品即将派生出的编码，建档应直接抛 409，且不能产生任何带 `-2` 后缀的非法 SKU 编码。
    const p5aTag = await createSeriesTag('QA')
    const p5aConflictCode = formatSkuCode(formatProductCode(defaultPrefix, 'QA', 1), '0', null)
    const p5aBarcodeOwner = await productService.create({
      productName: `p5a-barcode-owner-${verifySeed}`,
      pinyinAbbr: 'QA',
      defaultPrice: 10,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'unlisted',
      currentStock: 0,
      limitPerUser: 5,
      skus: [
        { defaultPrice: 10, currentStock: 0, isActive: true, sortOrder: 0, barcode: p5aConflictCode },
      ],
    } as Parameters<typeof productService.create>[0], actor)
    assert.equal(p5aBarcodeOwner.skus[0].barcode, p5aConflictCode, '占位商品的条码应等于稍后 YZ 建档会派生出的编码')

    await assert.rejects(
      () => productService.create({
        productName: `p5a-yz-conflict-${verifySeed}`,
        pinyinAbbr: 'QA',
        defaultPrice: 10,
        discountRate: 10,
        isActive: true,
        o2oStatus: 'unlisted',
        currentStock: 0,
        limitPerUser: 5,
        primarySeriesTagId: p5aTag.id,
      } as Parameters<typeof productService.create>[0], actor),
      (error: unknown) => assertBizErrorWithStatus(error, 409) && (error as InstanceType<typeof BizError>).message.includes(p5aConflictCode),
      'YZ 建档派生出的 skuCode 撞上其他商品条码时应直接抛 409，而不是静默改写成带后缀的编码',
    )
    const suffixedAfterBarcodeConflict = await skuRepo.count({ where: { skuCode: `${p5aConflictCode}-2` } })
    assert.equal(suffixedAfterBarcodeConflict, 0, '条码冲突时不能产生带 -2 后缀的非法 SKU 编码')

    // 同一 YZ 分支对 legacySkuCode 冲突做同样断言。legacySkuCode 不经普通建档/编辑接口写入，
    // 这里直接构造一条历史行模拟"另一商品升级后遗留的历史编码"恰好等于目标编码的场景。
    const p6aTag = await createSeriesTag('QB')
    const p6aConflictCode = formatSkuCode(formatProductCode(defaultPrefix, 'QB', 1), '0', null)
    const p6aLegacyOwner = await createProduct(null, null)
    await skuRepo.save(skuRepo.create({
      productId: p6aLegacyOwner.id,
      skuCode: `${p6aLegacyOwner.productCode}-LEGACY-SRC`,
      legacySkuCode: p6aConflictCode,
      specValuesJson: JSON.stringify({}),
      specText: '默认规格',
      defaultPrice: '10.00',
      discountRate: '10.0',
      isActive: true,
      isCurrent: true,
      o2oRecommended: false,
      sortOrder: 0,
      variantCode: null,
      sizeCode: null,
    }))

    await assert.rejects(
      () => productService.create({
        productName: `p6a-yz-conflict-${verifySeed}`,
        pinyinAbbr: 'QB',
        defaultPrice: 10,
        discountRate: 10,
        isActive: true,
        o2oStatus: 'unlisted',
        currentStock: 0,
        limitPerUser: 5,
        primarySeriesTagId: p6aTag.id,
      } as Parameters<typeof productService.create>[0], actor),
      (error: unknown) => assertBizErrorWithStatus(error, 409) && (error as InstanceType<typeof BizError>).message.includes(p6aConflictCode),
      'YZ 建档派生出的 skuCode 撞上其他商品历史编码（legacySkuCode）时应直接抛 409',
    )
    const suffixedAfterLegacyConflict = await skuRepo.count({ where: { skuCode: `${p6aConflictCode}-2` } })
    assert.equal(suffixedAfterLegacyConflict, 0, '历史编码冲突时同样不能产生带 -2 后缀的非法 SKU 编码')
    pass('P1-A：YZ 建档编码撞上其他商品条码 / 历史编码（legacySkuCode）均直接抛 409，且都不产生 -2 后缀的非法编码')

    // 用例 49（P1-B）：升级冲突检查必须纳入其他商品的历史编码（legacySkuCode）——A 商品升级后的历史
    // 编码恰好等于 B 商品升级将生成的编码时，B 的正式升级应抛 409，预检应给出 blockingReason。
    const p7SeriesTagB = await createSeriesTag('QC')
    const p7UpgradeProductB = await productService.create({
      productCode: nextProductCode(),
      productName: `p7-upgrade-b-${verifySeed}`,
      pinyinAbbr: 'QC',
      defaultPrice: 10,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'unlisted',
      currentStock: 0,
      limitPerUser: 5,
    } as Parameters<typeof productService.create>[0], actor)
    const p7PreviewBeforeConflict = await productService.previewProductYzUpgrade(p7UpgradeProductB.id, p7SeriesTagB.id)
    assert.equal(p7PreviewBeforeConflict.blockingReason, null, '未产生冲突前预检不应有 blockingReason')
    const p7PredictedSkuCode = p7PreviewBeforeConflict.skuChanges[0]?.newSkuCode
    assert.ok(p7PredictedSkuCode, '预检应能给出升级后的 skuCode')

    // 商品 A：先用一个显式 skuCode（等于 B 升级后会生成的编码）建一个 legacy 商品，再把它升级到 YZ——
    // 升级会把这个旧 skuCode 无条件写入 legacySkuCode（B9 批次的落位规则），从而制造出目标冲突。
    const p7SeriesTagA = await createSeriesTag('QD')
    const p7OwnerProductA = await productService.create({
      productCode: nextProductCode(),
      productName: `p7-upgrade-a-${verifySeed}`,
      pinyinAbbr: 'QC',
      defaultPrice: 10,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'unlisted',
      currentStock: 0,
      limitPerUser: 5,
      skus: [
        { defaultPrice: 10, currentStock: 0, isActive: true, sortOrder: 0, skuCode: p7PredictedSkuCode },
      ],
    } as Parameters<typeof productService.create>[0], actor)
    assert.equal(p7OwnerProductA.skus[0].skuCode, p7PredictedSkuCode, 'A 商品的初始 skuCode 应等于 B 升级后会生成的编码')
    const p7UpgradedA = await productService.upgradeProductToYzCode(p7OwnerProductA.id, { primarySeriesTagId: p7SeriesTagA.id }, actor)
    assert.equal(p7UpgradedA.skus[0].legacySkuCode, p7PredictedSkuCode, 'A 商品升级后历史编码应等于其升级前的 skuCode')

    const p7PreviewAfterConflict = await productService.previewProductYzUpgrade(p7UpgradeProductB.id, p7SeriesTagB.id)
    assert.ok(p7PreviewAfterConflict.blockingReason, '预检应识别出与其他商品历史编码的冲突并给出 blockingReason')
    assert.ok(
      p7PreviewAfterConflict.blockingReason!.includes(p7PredictedSkuCode!),
      'blockingReason 应指明具体冲突的编码',
    )

    await assert.rejects(
      () => productService.upgradeProductToYzCode(p7UpgradeProductB.id, { primarySeriesTagId: p7SeriesTagB.id }, actor),
      (error) => assertBizErrorWithStatus(error, 409),
      '新编码与其他商品历史编码（legacySkuCode）冲突时正式升级应抛 409',
    )
    pass('P1-B：升级冲突检查纳入其他商品历史编码（legacySkuCode）——预检给出 blockingReason，正式升级抛 409')

    // 用例 50（P1-C）：序号永久占用按系列码建命名空间，并禁止删除仍有占用记录的标签。
    const p9SeriesTag = await createSeriesTag('QE')
    const p9Product = await productService.create({
      productName: `p9-namespace-${verifySeed}`,
      pinyinAbbr: 'QE',
      defaultPrice: 10,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'unlisted',
      currentStock: 0,
      limitPerUser: 5,
      primarySeriesTagId: p9SeriesTag.id,
    } as Parameters<typeof productService.create>[0], actor)
    assert.equal(p9Product.seriesSeq, 1, '首个 P9 系列商品应分配到序号 1')
    const p9HistoryProductCode = p9Product.productCode

    await productRepo.delete({ id: p9Product.id })

    // 商品被物理删除后，主系列引用计数归零，但该系列编码下已分配过序号，删除标签应被拒绝。
    await assert.rejects(
      () => tagService.delete(p9SeriesTag.id, actor),
      (error: unknown) => assertBizErrorWithStatus(error, 409),
      'P1-C：系列编码下已分配过商品序号时，即使引用计数归零，删除标签也应被拒绝',
    )

    // 绕开服务层的删除防护（模拟历史数据或非常规操作），实际制造出"同 seriesCode、不同 tagId"的场景，
    // 验证真正兜底的是 allocateSeriesSeq 按系列码维度的占用判定，而不是依赖标签删除防护这一道闸门。
    await tagRepo.delete({ id: p9SeriesTag.id })
    const p9NewTag = await createSeriesTag('QE')
    assert.notEqual(String(p9NewTag.id), String(p9SeriesTag.id), '新标签应拿到与旧标签不同的 tagId')
    const p9NextSeq = await runInTransaction((manager) => allocateSeriesSeq(manager, p9NewTag.id, 'QE', defaultPrefix))
    assert.equal(p9NextSeq, 2, '新标签（不同 tagId、相同 seriesCode）分配序号时应跳过已被占用的 01，直接取 02')
    const p9NextProductCode = formatProductCode(defaultPrefix, 'QE', p9NextSeq)
    assert.notEqual(p9NextProductCode, p9HistoryProductCode, '新分配的产品编码不应与旧标签生成过的历史编码重复')
    pass('P1-C：系列最后一个商品被删除后删除标签被拒绝（409）；绕过防护后新建同 seriesCode 不同 tagId 的标签，分配序号仍跳过历史已占用的 01，不产生重复编码')

    // ============ 第 10 批：PR #109 第六轮评审修复（P1-A）============

    // 用例 51（P1-A）：普通编辑路径（assertSkuRelationsValid）必须纳入 legacySkuCode 冲突校验。
    // A 商品升级后留下历史编码 L；B 商品是完全不相关的 legacy 商品，通过"普通编辑"（不经过任何 YZ
    // 专用校验）把某 SKU 的原厂条码/SKU 编码设成 L，两个方向都必须被拒绝；且用 L 扫码全程只命中 A。
    const p10SeriesTagA = await createSeriesTag('RA')
    const p10LegacyCode = `P10-LEGACY-${verifySeed}`
    const p10OwnerProductA = await productService.create({
      productCode: nextProductCode(),
      productName: `p10-owner-a-${verifySeed}`,
      pinyinAbbr: 'RA',
      defaultPrice: 10,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'unlisted',
      currentStock: 0,
      limitPerUser: 5,
      skus: [
        { defaultPrice: 10, currentStock: 0, isActive: true, sortOrder: 0, skuCode: p10LegacyCode },
      ],
    } as Parameters<typeof productService.create>[0], actor)
    assert.equal(p10OwnerProductA.skus[0].skuCode, p10LegacyCode, 'A 商品升级前的 skuCode 应等于显式指定值（本用例的历史编码 L）')
    const p10UpgradedA = await productService.upgradeProductToYzCode(p10OwnerProductA.id, { primarySeriesTagId: p10SeriesTagA.id }, actor)
    assert.equal(p10UpgradedA.skus[0].legacySkuCode, p10LegacyCode, 'A 商品升级后应把升级前的 skuCode 落到 legacySkuCode（即 L）')

    const p10ProductB = await productService.create({
      productName: `p10-product-b-${verifySeed}`,
      pinyinAbbr: 'RB',
      defaultPrice: 10,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'unlisted',
      currentStock: 0,
      limitPerUser: 5,
    } as Parameters<typeof productService.create>[0], actor)
    const p10SkuB = p10ProductB.skus[0]

    // 正向之一：B 通过默认 SKU 编辑（applyDefaultSkuExtras，多规格商品之外的编辑入口）把原厂条码设为 L。
    await assert.rejects(
      () => productService.update(p10ProductB.id, { defaultSku: { barcode: p10LegacyCode } } as Parameters<typeof productService.update>[1], actor),
      (error: unknown) => assertBizErrorWithStatus(error, 409) && (error as InstanceType<typeof BizError>).message.includes(p10LegacyCode),
      'P1-A：普通编辑（默认 SKU 编辑）把原厂条码设为其他商品的历史编码（legacySkuCode）应抛 409',
    )

    // 正向之二：B 通过多规格 SKU 编辑入口（replaceProductSkus）直接把 skuCode 设为 L。
    await assert.rejects(
      () => productService.update(p10ProductB.id, {
        skus: [
          { id: p10SkuB.id, specValues: {}, defaultPrice: 10, currentStock: 0, isActive: true, sortOrder: 0, skuCode: p10LegacyCode },
        ],
      } as Parameters<typeof productService.update>[1], actor),
      (error: unknown) => assertBizErrorWithStatus(error, 409) && (error as InstanceType<typeof BizError>).message.includes(p10LegacyCode),
      'P1-A：普通编辑把 SKU 编码直接设为其他商品的历史编码（legacySkuCode）应抛 409',
    )

    // 两次失败写入都不应残留任何影响：B 的条码/编码保持原样，扫描 L 全程只命中 A。
    const p10BAfterRejects = await productService.detail(p10ProductB.id)
    assert.equal(p10BAfterRejects.skus[0].barcode, null, 'B 的原厂条码应保持未设置，未被拒绝的写入污染')
    assert.equal(p10BAfterRejects.skus[0].skuCode, p10SkuB.skuCode, 'B 的 SKU 编码应保持原样，未被拒绝的写入污染')
    const p10Scan = await productService.lookupByCode(p10LegacyCode)
    assert.equal(p10Scan.matchedBy, 'legacy_sku_code', '扫描历史编码 L 应命中 legacy_sku_code 路径')
    assert.equal(String(p10Scan.product.id), String(p10UpgradedA.id), '扫描历史编码 L 应且只应命中 A 商品，不能被 B 抢占')
    pass('P1-A：assertSkuRelationsValid 已纳入 legacySkuCode 冲突校验——普通编辑（默认 SKU 编辑/多规格编辑）把条码或编码设为其他商品的历史编码均抛 409，且扫码结果不受影响')

    // ============ 第 11 批：PR #109 第六轮评审修复（P1-B）============

    // 用例 52（P1-B）：模拟"占用表为空但已有存活 YZ 商品"的状态——直接用 repository 删除该商品的占用行，
    // 重新跑一次结构初始化（会触发 database-bootstrap.ts 新增的存活商品回填逻辑）后，断言登记已补齐；
    // 该商品被删除后，同序号导入仍应被拒绝，证明补齐的登记确实生效为永久占用，不是摆设。
    const p11Tag = await createSeriesTag('RB')
    const p11Product = await productService.create({
      productName: `p11-backfill-${verifySeed}`,
      pinyinAbbr: 'RB',
      defaultPrice: 10,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'unlisted',
      currentStock: 0,
      limitPerUser: 5,
      primarySeriesTagId: p11Tag.id,
    } as Parameters<typeof productService.create>[0], actor)
    assert.equal(p11Product.seriesSeq, 1, '首个 P11 系列商品应分配到序号 1')

    const p11ReservationBeforeDelete = await reservationRepo.findOneBy({ seriesTagId: p11Tag.id, seriesSeq: 1 })
    assert.ok(p11ReservationBeforeDelete, '正常建档流程应已写入占用登记')
    await reservationRepo.delete({ id: p11ReservationBeforeDelete!.id })
    const p11ReservationAfterManualDelete = await reservationRepo.findOneBy({ seriesTagId: p11Tag.id, seriesSeq: 1 })
    assert.equal(p11ReservationAfterManualDelete, null, '模拟"占用表为空但已有存活 YZ 商品"：登记行已被删除')

    // 重新跑一次结构初始化，触发 prepareSqliteYzReservationSeriesCodeColumns 里新增的存活商品回填。
    await initializeDatabaseSchemaIfNeeded(AppDataSource)
    const p11ReservationAfterBackfill = await reservationRepo.findOneBy({ seriesTagId: p11Tag.id, seriesSeq: 1 })
    assert.ok(p11ReservationAfterBackfill, 'P1-B：回填逻辑应为仍存活的 YZ 商品补齐占用登记')
    assert.equal(p11ReservationAfterBackfill!.productCode, p11Product.productCode, '回填的 productCode 应等于该商品当前的 productCode')
    assert.equal(p11ReservationAfterBackfill!.seriesCode, 'RB', '回填的 seriesCode 应等于该商品所属系列的系列码')

    // 该商品被删除后，同序号导入仍应被拒绝——证明补齐的登记确实生效为永久占用。
    await productRepo.delete({ id: p11Product.id })
    await assert.rejects(
      () => runInTransaction((manager) => reserveSeriesSeq(manager, p11Tag.id, 1, 'RB', defaultPrefix)),
      (error: unknown) => assertBizErrorWithStatus(error, 409),
      'P1-B：回填登记后，该商品被删除，同序号导入仍应被永久占用拒绝',
    )
    pass('P1-B：模拟占用表为空但已有存活 YZ 商品——重新跑结构初始化后回填登记已补齐；商品删除后同序号导入仍被拒绝')

    // ============ 第 12 批：PR #109 第七轮评审修复（P1-A）============

    // 用例 53（P1-A）：升级冲突检查的排除粒度从"整件商品"收窄到"候选编码所属的那条 SKU"——同一商品
    // 内 SKU A 的旧编码恰好等于 SKU B 升级后将生成的新编码时必须被拒绝。此前用 Not(productId) 排除
    // 整件商品自身，是为了放行"SKU 自己的新编码等于自己的旧编码"，但连带放过了同商品内部、不同 SKU
    // 之间的真实碰撞。
    const p12IntraTag = await createSeriesTag('SU')
    const p12IntraProduct = await productService.create({
      productName: `p12-intra-conflict-${verifySeed}`,
      pinyinAbbr: 'SU',
      defaultPrice: 10,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'unlisted',
      currentStock: 0,
      limitPerUser: 5,
      specGroups: [{ name: '颜色', values: ['红色', '蓝色'] }],
      skus: [
        { specValues: { 颜色: '红色' }, defaultPrice: 10, currentStock: 0, isActive: true, sortOrder: 0 },
        { specValues: { 颜色: '蓝色' }, defaultPrice: 10, currentStock: 0, isActive: true, sortOrder: 1 },
      ],
    } as Parameters<typeof productService.create>[0], actor)
    assert.equal(p12IntraProduct.skus.length, 2)
    const p12SkuRed = p12IntraProduct.skus.find((sku) => sku.specValues['颜色'] === '红色')
    const p12SkuBlue = p12IntraProduct.skus.find((sku) => sku.specValues['颜色'] === '蓝色')
    assert.ok(p12SkuRed && p12SkuBlue, '应存在红色/蓝色两条 SKU')

    const p12PreviewBefore = await productService.previewProductYzUpgrade(p12IntraProduct.id, p12IntraTag.id)
    assert.equal(p12PreviewBefore.blockingReason, null, '设置冲突前预检不应有 blockingReason')
    const p12BlueChange = p12PreviewBefore.skuChanges.find((change) => change.skuId === String(p12SkuBlue!.id))
    assert.ok(p12BlueChange, '预检应包含蓝色 SKU 的编码变化')
    const p12PredictedBlueCode = p12BlueChange!.newSkuCode

    // 把红色 SKU 当前的 skuCode 显式改成"蓝色 SKU 升级后将生成的新编码"，制造"SKU A 的旧编码恰好
    // 等于 SKU B 升级后新编码"的场景。此时这个编码字符串还不属于任何一条现存 SKU（蓝色还没升级），
    // 普通保存应能放行（两条不同商品也没有其它 SKU 占用它）。
    const p12AfterSetRedCode = await productService.update(p12IntraProduct.id, {
      specGroups: [{ name: '颜色', values: ['红色', '蓝色'] }],
      skus: [
        { id: p12SkuRed!.id, specValues: { 颜色: '红色' }, defaultPrice: 10, currentStock: 0, isActive: true, sortOrder: 0, skuCode: p12PredictedBlueCode },
        { id: p12SkuBlue!.id, specValues: { 颜色: '蓝色' }, defaultPrice: 10, currentStock: 0, isActive: true, sortOrder: 1 },
      ],
    } as Parameters<typeof productService.update>[1], actor)
    const p12RedAfterSet = p12AfterSetRedCode.skus.find((sku) => sku.id === p12SkuRed!.id)
    assert.equal(p12RedAfterSet!.skuCode, p12PredictedBlueCode, '红色 SKU 的当前 skuCode 应已改为蓝色 SKU 升级后将生成的编码')

    const p12PreviewAfter = await productService.previewProductYzUpgrade(p12IntraProduct.id, p12IntraTag.id)
    assert.ok(p12PreviewAfter.blockingReason, 'P1-A：本商品内 SKU A 的旧编码等于 SKU B 升级后新编码时，预检应给出 blockingReason')
    assert.ok(
      p12PreviewAfter.blockingReason!.includes(p12PredictedBlueCode),
      'blockingReason 应指明具体冲突的编码',
    )

    await assert.rejects(
      () => productService.upgradeProductToYzCode(p12IntraProduct.id, { primarySeriesTagId: p12IntraTag.id }, actor),
      (error: unknown) => assertBizErrorWithStatus(error, 409),
      'P1-A：本商品内 SKU 之间的旧编码/新编码碰撞，正式升级应抛 409（排除粒度已收窄到候选编码所属的 SKU，不能再用 Not(productId) 放过同商品内部碰撞）',
    )
    pass('P1-A：升级冲突排除粒度收窄到"候选编码所属的那条 SKU"——同商品内 SKU A 旧编码=SKU B 新编码时，预检给出 blockingReason，正式升级抛 409')

    // 用例 54（P1-A 自证）：合法情形仍须放行——某条 SKU 自己的新编码恰好等于它自己升级前的旧编码时
    // 不应被拦截，证明收窄后的排除逻辑仍保留了这唯一合法的豁免。
    const p12SelfTag = await createSeriesTag('SV')
    const p12SelfProduct = await productService.create({
      productName: `p12-self-exempt-${verifySeed}`,
      pinyinAbbr: 'SV',
      defaultPrice: 10,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'unlisted',
      currentStock: 0,
      limitPerUser: 5,
    } as Parameters<typeof productService.create>[0], actor)
    const p12SelfPreview = await productService.previewProductYzUpgrade(p12SelfProduct.id, p12SelfTag.id)
    const p12SelfPredictedCode = p12SelfPreview.skuChanges[0]?.newSkuCode
    assert.ok(p12SelfPredictedCode, '预检应能给出升级后的 skuCode')

    const p12SelfSku = p12SelfProduct.skus[0]
    await productService.update(p12SelfProduct.id, {
      skus: [
        { id: p12SelfSku.id, specValues: {}, defaultPrice: 10, currentStock: 0, isActive: true, sortOrder: 0, skuCode: p12SelfPredictedCode },
      ],
    } as Parameters<typeof productService.update>[1], actor)

    const p12SelfPreviewAfter = await productService.previewProductYzUpgrade(p12SelfProduct.id, p12SelfTag.id)
    assert.equal(
      p12SelfPreviewAfter.blockingReason,
      null,
      'P1-A：某条 SKU 自己的新编码等于自己升级前的旧编码，属于唯一合法豁免，不应被拦截',
    )
    const p12SelfUpgraded = await productService.upgradeProductToYzCode(p12SelfProduct.id, { primarySeriesTagId: p12SelfTag.id }, actor)
    assert.equal(p12SelfUpgraded.skus[0].skuCode, p12SelfPredictedCode, '升级后 skuCode 应等于预测值')
    assert.equal(p12SelfUpgraded.skus[0].legacySkuCode, p12SelfPredictedCode, '升级后 legacySkuCode 应等于升级前的旧编码（与新编码相同）')
    pass('P1-A 自证：某条 SKU 自己的新编码等于自己的旧编码属于唯一合法豁免，预检不拦截，正式升级成功')

    // 用例 55（P1-A）：普通保存路径（assertSkuRelationsValid）同样要纳入"本商品内其它 SKU 的历史编码"
    // ——此前只查跨商品（Not(product.id)），批内 seen Map 又只覆盖 skuCode/barcode 两列，本商品内某条
    // SKU 的 skuCode 等于本商品另一条 SKU 的 legacySkuCode 时两边都漏判。
    const p12SiblingLegacyCode = `P12-SIBLING-LEGACY-${verifySeed}`
    const p12OrdinaryProduct = await productService.create({
      productName: `p12-ordinary-intra-${verifySeed}`,
      pinyinAbbr: 'SW',
      defaultPrice: 10,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'unlisted',
      currentStock: 0,
      limitPerUser: 5,
      specGroups: [{ name: '颜色', values: ['紫色', '橙色'] }],
      skus: [
        { specValues: { 颜色: '紫色' }, defaultPrice: 10, currentStock: 0, isActive: true, sortOrder: 0 },
        { specValues: { 颜色: '橙色' }, defaultPrice: 10, currentStock: 0, isActive: true, sortOrder: 1 },
      ],
    } as Parameters<typeof productService.create>[0], actor)
    const p12SkuPurple = p12OrdinaryProduct.skus.find((sku) => sku.specValues['颜色'] === '紫色')
    const p12SkuOrange = p12OrdinaryProduct.skus.find((sku) => sku.specValues['颜色'] === '橙色')
    assert.ok(p12SkuPurple && p12SkuOrange, '应存在紫色/橙色两条 SKU')

    // legacySkuCode 不经普通建档/编辑接口写入，这里沿用文件里已有的直接写库惯例，模拟"橙色 SKU 曾经历
    // 过一次编码搬迁，留下了历史编码"。
    await skuRepo.update({ id: p12SkuOrange!.id }, { legacySkuCode: p12SiblingLegacyCode })

    await assert.rejects(
      () => productService.update(p12OrdinaryProduct.id, {
        specGroups: [{ name: '颜色', values: ['紫色', '橙色'] }],
        skus: [
          { id: p12SkuPurple!.id, specValues: { 颜色: '紫色' }, defaultPrice: 10, currentStock: 0, isActive: true, sortOrder: 0, skuCode: p12SiblingLegacyCode },
          { id: p12SkuOrange!.id, specValues: { 颜色: '橙色' }, defaultPrice: 10, currentStock: 0, isActive: true, sortOrder: 1 },
        ],
      } as Parameters<typeof productService.update>[1], actor),
      (error: unknown) => assertBizErrorWithStatus(error, 409) && (error as InstanceType<typeof BizError>).message.includes(p12SiblingLegacyCode),
      'P1-A：本商品内某条 SKU 的 skuCode 等于另一条 SKU 的历史编码（legacySkuCode）时，普通保存路径应抛 409',
    )

    const p12PurpleUnchanged = await skuRepo.findOneBy({ id: p12SkuPurple!.id })
    assert.equal(p12PurpleUnchanged!.skuCode, p12SkuPurple!.skuCode, '被拒绝的写入不应残留，紫色 SKU 的 skuCode 应保持原样')
    pass('P1-A：assertSkuRelationsValid 已纳入本商品内其它 SKU 的 legacySkuCode 冲突检查——普通保存路径同样抛 409，且不残留写入')
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
