/**
 * 文件说明：YZ 通用 SKU 编码体系专用的 Excel 建库导入服务。
 * 文件职责：解析「品类/序号/商品/款式颜色/尺码/价格」六列宽表，按「系列+序号」把多行合并为一个商品的多条
 *          SKU，预览只读校验通过后再在单个事务内批量建档，产品编码与 SKU 编码全部走 product-code.service
 *          的 YZ 编码体系生成。
 * 实现逻辑：
 * - 与现有 product-excel.service（一行一 SKU、规格写成单列文本）完全并行、互不影响：现有导入按「商品名称」
 *   分组、规格自由文本；YZ 导入按「系列+序号」分组、规格固定拆成变体/尺码两条轴，两套分组与编码算法不兼容，
 *   因此不复用其 parseWorkbook/validate，只复用 productService.createWithManager 承接最终建档；
 * - 品类/序号/商品三列按合并单元格与真空白两种写法做 forward-fill，款式/颜色、尺码、价格三列不填充；
 * - 「系列+序号」分组后，一级变体轴写入 specValues['颜色/款式']、尺码轴写入 specValues.尺码（B8 批次改名后
 *   的新 key，与 product.service.ts 的 VARIANT_AXIS_SPEC_KEY/SIZE_AXIS_SPEC_KEY 保持一致；旧数据的双读
 *   兼容由 product.service.ts 的 normalizeSpecValuesKeys 负责，本服务只负责新写入用新 key）；
 * - 序号必须原样保留：createWithManager 内部固定调用 allocateSeriesSeq（游标 +1），要让它精确吐出 Excel 原
 *   序号，因此把 Excel 原序号通过 CreateProductInput.seriesSeq 直接交给建档接口精确占用（内部走
 *   reserveSeriesSeq），不依赖分组的处理顺序；创建后仍校验实际 seriesSeq 与目标一致，不一致视为内部错误；
 * - 预览阶段只做只读模拟：复用 product-code.service 导出的候选池（VARIANT_CODE_POOL/SIZE_CODE_POOL）在内存
 *   按行序模拟分配，不调用 resolveVariantCode/resolveSizeCode（那会真的写登记表）；
 * - 两类待确认项（同序号多商品名、疑似轴错位）都不允许自动采信：resolutions 未覆盖到的待确认项一律视为未解决，
 *   确认导入接口在事务内重新解析并重新校验，只信任 resolutions，不信任前端回传的预览结果。
 * 维护重点：
 * - 六列表头与两条轴的语义调整需要同步前端说明文案与模板“填写说明”页；
 * - 容量上限（变体 9、尺码 5）与轴错位识别正则改动需要同步这里与前端展示；
 * - 本文件只新建商品，不支持按导入覆盖已有商品，也不写库存流水（Excel 无库存列）。
 */

import ExcelJS from 'exceljs'
import { In, type EntityManager } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import { runInTransaction } from '../config/transaction-runner.js'
import { BaseProduct } from '../entities/base-product.entity.js'
import { BaseTag } from '../entities/base-tag.entity.js'
import type { AuthUserContext } from '../types/auth.js'
import { BizError } from '../utils/errors.js'
import type { RequestMeta } from '../utils/request-meta.js'
import { assertXlsxArchiveWithinLimits } from '../utils/xlsx-archive-guard.js'
import { lockActiveSysAccountForBusiness } from './account-business-guard.service.js'
import { auditService } from './audit.service.js'
import { invalidateMallCatalogReadCache } from './mall-catalog-revision.service.js'
import {
  formatProductCode,
  formatSkuCode,
  getProductCodePrefix,
  reserveSeriesSeq,
  SIZE_CODE_POOL,
  VARIANT_CODE_POOL,
} from './product-code.service.js'
import { productService, type CreateProductInput, type ProductView } from './product.service.js'

const MAX_IMPORT_ROWS = 2000
/** 解压体积预检上限：六列宽表，2000 行远小于 1MB，留足余量给少量嵌入图片。 */
const IMPORT_ARCHIVE_LIMITS = { maxEntries: 2000, maxTotalUncompressedBytes: 20 * 1024 * 1024 }
const MAX_VARIANT_VALUES = VARIANT_CODE_POOL.length
const MAX_SIZE_VALUES = SIZE_CODE_POOL.length
/** 疑似轴错位识别：两位数字、可选“码”字，典型码数写法，如 39、39码。 */
const AXIS_AMBIGUOUS_PATTERN = /^\d{2}码?$/
// B8 批次改名：与 product.service.ts 的新 key 保持一致，新写入直接用新 key，不再写旧 key。
const VARIANT_AXIS_SPEC_KEY = '颜色/款式'
const SIZE_AXIS_SPEC_KEY = '尺码'

const TEMPLATE_HEADERS = ['品类', '序号', '商品', '款式/颜色', '尺码', '价格'] as const

export interface YzImportRowView {
  rowNumber: number
  category: string
  seriesSeq: number | null
  productName: string
  variantAxisValue: string
  sizeAxisValue: string
  price: string
  /** 预测编码，待确认项未决或该行/该分组存在其他错误时为 null。 */
  predictedSkuCode: string | null
  errors: string[]
}

export interface YzImportPendingConfirm {
  kind: 'multi_product_name' | 'axis_ambiguous'
  groupKey: string
  description: string
  options: Array<{ value: string; label: string }>
  suggestion: string | null
  resolved: string | null
}

export interface YzImportGroupView {
  groupKey: string
  seriesCode: string
  seriesSeq: number
  productNames: string[]
  chosenProductName: string | null
  variantValues: string[]
  sizeValues: string[]
  skuCount: number
  pendingConfirms: YzImportPendingConfirm[]
}

export interface YzImportPreview {
  rows: YzImportRowView[]
  groups: YzImportGroupView[]
  productCount: number
  skuCount: number
  errorCount: number
  pendingConfirmCount: number
}

export interface YzImportResolution {
  groupKey: string
  kind: 'multi_product_name' | 'axis_ambiguous'
  value: string
}

export interface YzImportResult {
  productCount: number
  skuCount: number
  products: Array<{ id: string; productCode: string; productName: string; skuCount: number }>
}

interface ParsedYzRow {
  rowNumber: number
  category: string
  seriesSeq: number | null
  productName: string
  variantAxisValue: string
  sizeAxisValue: string
  priceRaw: string
  price: number | null
  errors: string[]
  /** 预测 SKU 编码：组内无错误、无未决确认项时才填充，其余情况一律为 null。 */
  predictedSkuCode: string | null
}

interface YzGroup {
  groupKey: string
  seriesCode: string
  seriesSeq: number
  tagId: string
  rows: ParsedYzRow[]
  productNames: string[]
}

const cellText = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    if ('result' in record) return cellText(record.result)
    if ('text' in record) return cellText(record.text)
    if (Array.isArray(record.richText)) return record.richText.map((part) => cellText((part as { text?: unknown }).text)).join('')
    if (value instanceof Date) return value.toISOString()
  }
  return String(value).trim()
}

const normalizeHeader = (value: string) => value.replace(/[\s（）()/]/g, '')

export class ProductImportYzService {
  async buildTemplate(): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('YZ建库导入')
    sheet.columns = [
      { header: '品类', key: 'category', width: 12 },
      { header: '序号', key: 'seriesSeq', width: 8 },
      { header: '商品', key: 'productName', width: 22 },
      { header: '款式/颜色', key: 'variant', width: 14 },
      { header: '尺码', key: 'size', width: 10 },
      { header: '价格', key: 'price', width: 10 },
    ]
    sheet.getRow(1).font = { bold: true }
    sheet.getColumn('seriesSeq').numFmt = '0'

    sheet.addRow({ category: '大汶口', seriesSeq: 1, productName: '联名冰箱贴', variant: '', size: '', price: 40 })
    sheet.addRow({ category: '大汶口', seriesSeq: 2, productName: '联名书签', variant: '明心书院', size: '', price: 23 })
    sheet.addRow({ category: '', seriesSeq: '', productName: '', variant: '校门', size: '', price: 23 })
    sheet.addRow({ category: '', seriesSeq: '', productName: '', variant: '岳动馆', size: '', price: 23 })
    sheet.addRow({ category: '大汶口', seriesSeq: 3, productName: '分体半袖', variant: '白色', size: 'S', price: 39 })
    sheet.addRow({ category: '', seriesSeq: '', productName: '', variant: '白色', size: 'M', price: 39 })
    sheet.mergeCells('A2:A7')
    sheet.mergeCells('B3:B4')
    sheet.mergeCells('C3:C4')
    sheet.mergeCells('B6:B7')
    sheet.mergeCells('C6:C7')
    sheet.mergeCells('D6:D7')

    const guide = workbook.addWorksheet('填写说明')
    guide.columns = [{ header: '说明', key: 'text', width: 96 }]
    ;[
      '1. 六列固定为：品类 / 序号 / 商品 / 款式/颜色 / 尺码 / 价格，表头文字不能改。',
      '2. 品类必须先在“标签管理”页为对应标签设置两位大写字母的系列编码，否则该品类下所有行都会校验失败。',
      '3. 序号是该品类内商品的编号（1-99），同一商品的多行必须使用相同序号；序号会原样保留，不会被系统重新分配。',
      '4. 品类、序号、商品三列如果同一商品有多行，可以用合并单元格表示“沿用上一行”，也可以留空表示沿用上一行的值（两种写法都支持）。',
      '5. 款式/颜色列是“一级变体轴”，同一商品下最多 9 个不同取值；只有一种取值时留空即可。',
      '6. 尺码列是“尺码轴”，同一商品下最多 5 个不同取值（如 S/M/L/XL/2XL）；没有尺码维度时留空。',
      '7. 价格是该行 SKU 的售价，必须是不小于 0 的数字，每行都要填写，不会沿用上一行。',
      '8. 同一序号下出现多个不同商品名称，或款式/颜色列整列都写成“39码”这类疑似尺码的写法时，导入预览页会要求人工确认，不会自动判断。',
      '9. 任何一行校验失败，或还有待确认项未处理，整批都不会导入，请按预览提示修正后重新上传。',
    ].forEach((text) => guide.addRow({ text }))
    return Buffer.from(await workbook.xlsx.writeBuffer())
  }

  async preview(buffer: Buffer): Promise<YzImportPreview> {
    const rows = await this.parseWorkbook(buffer)
    const { preview } = await this.validateAndGroup(rows, AppDataSource.manager, [])
    return preview
  }

  async importProducts(
    fileBuffer: Buffer,
    resolutions: YzImportResolution[],
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<YzImportResult> {
    const result = await runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, actor.userId)
      // 事务内重新解析 + 重新校验：不信任前端回传的预览结果，只信任 resolutions。
      const parsedRows = await this.parseWorkbook(fileBuffer)
      const { rows, groups, preview } = await this.validateAndGroup(parsedRows, manager, resolutions ?? [])
      if (preview.pendingConfirmCount > 0) {
        throw new BizError('存在未确认的规格轴归属或商品名归属，请在预览页逐项确认', 400)
      }
      if (preview.errorCount > 0) {
        throw new BizError(`有 ${preview.errorCount} 行未通过校验，请先修正后再导入`, 400, { preview })
      }

      const orderedGroups = [...groups.values()].sort((left, right) => (
        left.seriesCode === right.seriesCode ? left.seriesSeq - right.seriesSeq : left.seriesCode.localeCompare(right.seriesCode)
      ))

      const resolutionMap = this.buildResolutionMap(resolutions ?? [])
      const created: Array<{ id: string; productCode: string; productName: string; skuCount: number }> = []

      for (const group of orderedGroups) {
        const chosenProductName = this.resolveChosenProductName(group, resolutionMap)
        if (!chosenProductName) {
          // 前面的 pendingConfirmCount/errorCount 校验已经应当拦住这种情况，这里只是防御性兜底。
          throw new BizError(`系列「${group.seriesCode}」序号 ${group.seriesSeq} 未能确定商品名称，导入已中止`, 500)
        }
        const axisResolution = this.resolveAxisResolution(group, resolutionMap)
        const skuPlans = this.buildSkuPlans(group, axisResolution)

        const input: CreateProductInput = {
          productName: chosenProductName,
          defaultPrice: group.rows[0]?.price ?? 0,
          isActive: true,
          thumbnail: null,
          currentStock: 0,
          primarySeriesTagId: group.tagId,
          // 直接把 Excel 原序号交给建档接口精确占用，不依赖"分组按序号升序处理"这种调用顺序前提。
          seriesSeq: group.seriesSeq,
          specGroups: this.buildSpecGroups(skuPlans),
          skus: skuPlans.map((plan, index) => ({
            specValues: { [VARIANT_AXIS_SPEC_KEY]: plan.variantValue, [SIZE_AXIS_SPEC_KEY]: plan.sizeValue },
            defaultPrice: plan.row.price ?? 0,
            currentStock: 0,
            isActive: true,
            sortOrder: index,
          })),
        }

        let view: ProductView
        try {
          view = await productService.createWithManager(input, manager, actor)
        } catch (error) {
          if (error instanceof BizError) {
            throw new BizError(`系列「${group.seriesCode}」序号 ${group.seriesSeq}（第 ${group.rows.map((row) => row.rowNumber).join('、')} 行）导入失败：${error.message}`, error.statusCode)
          }
          throw error
        }
        if (view.seriesSeq !== group.seriesSeq) {
          throw new BizError('系列内序号分配异常，导入已中止，请重试', 500)
        }
        created.push({ id: view.id, productCode: view.productCode, productName: view.productName, skuCount: view.skus.length })
      }

      await auditService.record({
        actionType: 'product.import_yz',
        actionLabel: 'YZ 建库 Excel 批量导入商品',
        targetType: 'product_import',
        targetCode: `${created.length} 个商品 / ${rows.length} 个规格`,
        actor,
        requestMeta,
        detail: {
          productCount: created.length,
          skuCount: rows.length,
          products: created.slice(0, 50).map((item) => `${item.productCode} ${item.productName}`),
        },
      }, manager)

      return { productCount: created.length, skuCount: rows.length, products: created }
    })
    invalidateMallCatalogReadCache()
    return result
  }

  // ------------------------------------------------------------------------------------------
  // 解析
  // ------------------------------------------------------------------------------------------

  private async parseWorkbook(buffer: Buffer): Promise<ParsedYzRow[]> {
    assertXlsxArchiveWithinLimits(buffer, IMPORT_ARCHIVE_LIMITS)
    const workbook = new ExcelJS.Workbook()
    try {
      const workbookBuffer = Buffer.from(buffer) as unknown as Parameters<typeof workbook.xlsx.load>[0]
      await workbook.xlsx.load(workbookBuffer)
    } catch {
      throw new BizError('Excel 文件内容无法识别，请确认文件未损坏后重试', 400)
    }
    const sheet = workbook.worksheets[0]
    if (!sheet) throw new BizError('Excel 文件中没有可读取的工作表', 400)
    if (sheet.actualRowCount - 1 > MAX_IMPORT_ROWS) throw new BizError(`单次最多导入 ${MAX_IMPORT_ROWS} 行`, 400)

    const headerValues = (sheet.getRow(1).values as unknown[]).map((value) => normalizeHeader(cellText(value)))
    const columnIndex = new Map<string, number>()
    for (const header of TEMPLATE_HEADERS) {
      const index = headerValues.findIndex((value) => value === normalizeHeader(header))
      if (index > 0) columnIndex.set(header, index)
    }
    const missingHeaders = TEMPLATE_HEADERS.filter((header) => !columnIndex.has(header))
    if (missingHeaders.length) {
      throw new BizError(`未找到「${missingHeaders.join('、')}」列，请使用「YZ 建库导入」最新模板`, 400)
    }

    const rows: ParsedYzRow[] = []
    let lastCategory = ''
    let lastSeriesSeqText = ''
    let lastProductName = ''
    const actualRowCount = Math.max(sheet.actualRowCount, sheet.rowCount)
    for (let rowNumber = 2; rowNumber <= actualRowCount; rowNumber += 1) {
      const row = sheet.getRow(rowNumber)
      const read = (header: (typeof TEMPLATE_HEADERS)[number]) => {
        const index = columnIndex.get(header) as number
        return cellText(row.getCell(index).value)
      }
      const categoryRaw = read('品类')
      const seriesSeqRaw = read('序号')
      const productNameRaw = read('商品')
      const variantAxisValue = read('款式/颜色')
      const sizeAxisValue = read('尺码')
      const priceRaw = read('价格')

      if (![categoryRaw, seriesSeqRaw, productNameRaw, variantAxisValue, sizeAxisValue, priceRaw].some(Boolean)) {
        continue
      }

      const category = categoryRaw || lastCategory
      const seriesSeqText = seriesSeqRaw || lastSeriesSeqText
      const productName = productNameRaw || lastProductName
      lastCategory = category
      lastSeriesSeqText = seriesSeqText
      lastProductName = productName

      const errors: string[] = []
      if (!category) errors.push('品类不能为空')
      if (category.length > 64) errors.push('品类不能超过 64 个字符')

      let seriesSeq: number | null = null
      if (!seriesSeqText) {
        errors.push('序号不能为空')
      } else {
        const numeric = Number(seriesSeqText)
        if (!Number.isInteger(numeric) || numeric < 1 || numeric > 99) {
          errors.push('序号必须是 1 到 99 之间的整数')
        } else {
          seriesSeq = numeric
        }
      }

      if (!productName) errors.push('商品名称不能为空')
      else if (productName.length > 128) errors.push('商品名称不能超过 128 个字符')

      let price: number | null = null
      if (!priceRaw) {
        errors.push('价格不能为空')
      } else {
        const numeric = Number(priceRaw)
        if (!Number.isFinite(numeric) || numeric < 0 || numeric > 9999999999.99) {
          errors.push('价格必须是合法的非负数')
        } else {
          price = numeric
        }
      }

      rows.push({
        rowNumber,
        category,
        seriesSeq,
        productName,
        variantAxisValue,
        sizeAxisValue,
        priceRaw,
        price,
        errors,
        predictedSkuCode: null,
      })
    }
    if (!rows.length) throw new BizError('Excel 中没有可导入的数据行', 400)
    return rows
  }

  private async validateAndGroup(
    rows: ParsedYzRow[],
    manager: EntityManager,
    resolutions: YzImportResolution[],
  ): Promise<{ rows: ParsedYzRow[]; groups: Map<string, YzGroup>; preview: YzImportPreview }> {
    const categoryNames = [...new Set(rows.map((row) => row.category).filter(Boolean))]
    const tags = categoryNames.length
      ? await manager.getRepository(BaseTag).find({ where: { tagName: In(categoryNames) } })
      : []
    const tagByName = new Map(tags.map((tag) => [tag.tagName, tag]))

    // 分组：按「系列码+序号」聚合，只有品类能解析出合法系列码、且序号合法的行才能入组。
    const groups = new Map<string, YzGroup>()
    for (const row of rows) {
      const tag = tagByName.get(row.category)
      const seriesCodeValid = Boolean(tag?.seriesCode) && /^[A-Z]{2}$/.test(tag?.seriesCode ?? '')
      if (row.category && !seriesCodeValid) {
        row.errors.push(`品类「${row.category}」未匹配到已设置系列编码的标签，请先在标签管理页为该标签设置两位系列编码`)
      }
      if (!seriesCodeValid || row.seriesSeq === null) continue

      const seriesCode = tag!.seriesCode as string
      const groupKey = `${seriesCode}|${row.seriesSeq}`
      let group = groups.get(groupKey)
      if (!group) {
        group = { groupKey, seriesCode, seriesSeq: row.seriesSeq, tagId: tag!.id, rows: [], productNames: [] }
        groups.set(groupKey, group)
      }
      group.rows.push(row)
      if (row.productName && !group.productNames.includes(row.productName)) {
        group.productNames.push(row.productName)
      }
    }

    // 系列+序号是否已被库内现有商品占用。
    const tagIdsInUse = [...new Set([...groups.values()].map((group) => group.tagId))]
    if (tagIdsInUse.length) {
      const seqsByTag = new Map<string, number[]>()
      for (const group of groups.values()) {
        const seqs = seqsByTag.get(group.tagId) ?? []
        seqs.push(group.seriesSeq)
        seqsByTag.set(group.tagId, seqs)
      }
      const occupiedRows = await Promise.all(
        [...seqsByTag.entries()].map(([tagId, seqs]) => manager.getRepository(BaseProduct)
          .createQueryBuilder('product')
          .select(['product.id', 'product.productName', 'product.primarySeriesTagId', 'product.seriesSeq'])
          .where('product.primarySeriesTagId = :tagId AND product.seriesSeq IN (:...seqs)', { tagId, seqs })
          .getMany()),
      )
      const occupiedMap = new Map<string, string>()
      for (const list of occupiedRows) {
        for (const product of list) {
          occupiedMap.set(`${product.primarySeriesTagId}|${product.seriesSeq}`, product.productName)
        }
      }
      for (const group of groups.values()) {
        const existingName = occupiedMap.get(`${group.tagId}|${group.seriesSeq}`)
        if (existingName) {
          const message = `系列「${group.seriesCode}」序号 ${group.seriesSeq} 已被商品「${existingName}」占用`
          group.rows.forEach((row) => row.errors.push(message))
        }
      }
    }

    // 组内校验：容量上限、规格组合重复、待确认项。
    const resolutionMap = this.buildResolutionMap(resolutions)
    const prefix = await getProductCodePrefix(manager)
    const groupViews: YzImportGroupView[] = []
    let pendingConfirmCount = 0

    for (const group of [...groups.values()].sort((left, right) => (
      left.seriesCode === right.seriesCode ? left.seriesSeq - right.seriesSeq : left.seriesCode.localeCompare(right.seriesCode)
    ))) {
      const axisAmbiguous = this.isAxisAmbiguousGroup(group)
      const pendingConfirms: YzImportPendingConfirm[] = []

      if (group.productNames.length > 1) {
        const resolvedName = resolutionMap.get(`${group.groupKey}:multi_product_name`)
        pendingConfirms.push({
          kind: 'multi_product_name',
          groupKey: group.groupKey,
          description: `系列「${group.seriesCode}」序号 ${group.seriesSeq} 下出现了 ${group.productNames.length} 个不同商品名称，请选择本商品最终使用的主商品名`,
          options: group.productNames.map((name) => ({ value: name, label: name })),
          suggestion: null,
          resolved: resolvedName && group.productNames.includes(resolvedName) ? resolvedName : null,
        })
      }
      if (axisAmbiguous) {
        const resolvedAxis = resolutionMap.get(`${group.groupKey}:axis_ambiguous`)
        pendingConfirms.push({
          kind: 'axis_ambiguous',
          groupKey: group.groupKey,
          description: `系列「${group.seriesCode}」序号 ${group.seriesSeq} 的「款式/颜色」列取值疑似均为尺码写法（如 39码），请确认该列应作为一级变体轴还是尺码轴`,
          options: [
            { value: 'variant', label: '当作一级变体轴' },
            { value: 'size', label: '当作尺码轴' },
          ],
          suggestion: 'size',
          resolved: resolvedAxis === 'variant' || resolvedAxis === 'size' ? resolvedAxis : null,
        })
      }
      pendingConfirmCount += pendingConfirms.filter((item) => item.resolved === null).length

      const axisResolution = this.resolveAxisResolution(group, resolutionMap)
      const skuPlans = this.buildSkuPlans(group, axisResolution)

      // 容量上限：同组变体值 > 9 或尺码值 > 5。
      const distinctVariants = [...new Set(skuPlans.map((plan) => plan.variantValue).filter(Boolean))]
      const distinctSizes = [...new Set(skuPlans.map((plan) => plan.sizeValue).filter(Boolean))]
      if (distinctVariants.length > MAX_VARIANT_VALUES) {
        const message = `该商品分组一级变体规格数量 ${distinctVariants.length} 超过 ${MAX_VARIANT_VALUES} 个上限`
        group.rows.forEach((row) => row.errors.push(message))
      }
      if (distinctSizes.length > MAX_SIZE_VALUES) {
        const message = `该商品分组尺码规格数量 ${distinctSizes.length} 超过 ${MAX_SIZE_VALUES} 个上限`
        group.rows.forEach((row) => row.errors.push(message))
      }

      // 规格组合重复：同一组内两行的（变体值,尺码值）组合相同会生成重复的 SKU 编码。
      const seenCombos = new Map<string, number>()
      skuPlans.forEach((plan) => {
        const comboKey = `${plan.variantValue}\u001f${plan.sizeValue}`
        const previousRow = seenCombos.get(comboKey)
        if (previousRow !== undefined) {
          const label = `${plan.variantValue || '无变体'}${plan.sizeValue ? ` / ${plan.sizeValue}` : ''}`
          plan.row.errors.push(`规格组合「${label}」与第 ${previousRow} 行重复，会生成重复的 SKU 编码`)
        } else {
          seenCombos.set(comboKey, plan.row.rowNumber)
        }
      })

      const groupHasError = group.rows.some((row) => row.errors.length > 0)
      const groupHasUnresolvedPending = pendingConfirms.some((item) => item.resolved === null)

      // 预测编码：组内无错误、无未决确认项时按候选池模拟分配（只读，不写登记表）。
      // distinctVariants/distinctSizes 已经是按行序去重后的首次出现顺序，直接按下标对应候选池即可，
      // 与 resolveVariantCode/resolveSizeCode 在真正建档时的分配顺序完全一致。
      if (!groupHasError && !groupHasUnresolvedPending) {
        const productCode = formatProductCode(prefix, group.seriesCode, group.seriesSeq)
        const variantCodeByValue = new Map(distinctVariants.map((value, index) => [value, VARIANT_CODE_POOL[index]]))
        const sizeCodeByValue = new Map(distinctSizes.map((value, index) => [value, SIZE_CODE_POOL[index]]))
        skuPlans.forEach((plan) => {
          const variantCode = plan.variantValue ? (variantCodeByValue.get(plan.variantValue) as string) : '0'
          const sizeCode = plan.sizeValue ? (sizeCodeByValue.get(plan.sizeValue) as string) : null
          plan.row.predictedSkuCode = formatSkuCode(productCode, variantCode, sizeCode)
        })
      } else {
        group.rows.forEach((row) => { row.predictedSkuCode = null })
      }

      groupViews.push({
        groupKey: group.groupKey,
        seriesCode: group.seriesCode,
        seriesSeq: group.seriesSeq,
        productNames: group.productNames,
        chosenProductName: this.resolveChosenProductName(group, resolutionMap),
        variantValues: distinctVariants,
        sizeValues: distinctSizes,
        skuCount: group.rows.length,
        pendingConfirms,
      })
    }

    const rowViews: YzImportRowView[] = rows.map((row) => ({
      rowNumber: row.rowNumber,
      category: row.category,
      seriesSeq: row.seriesSeq,
      productName: row.productName,
      variantAxisValue: row.variantAxisValue,
      sizeAxisValue: row.sizeAxisValue,
      price: row.priceRaw,
      predictedSkuCode: row.predictedSkuCode ?? null,
      errors: row.errors,
    }))

    const preview: YzImportPreview = {
      rows: rowViews,
      groups: groupViews,
      productCount: groups.size,
      skuCount: rows.length,
      errorCount: rows.filter((row) => row.errors.length > 0).length,
      pendingConfirmCount,
    }

    return { rows, groups, preview }
  }

  private buildResolutionMap(resolutions: YzImportResolution[]): Map<string, string> {
    const map = new Map<string, string>()
    for (const resolution of resolutions) {
      if (!resolution || !resolution.groupKey || !resolution.kind || typeof resolution.value !== 'string') continue
      map.set(`${resolution.groupKey}:${resolution.kind}`, resolution.value)
    }
    return map
  }

  private resolveChosenProductName(group: YzGroup, resolutionMap: Map<string, string>): string | null {
    if (group.productNames.length <= 1) return group.productNames[0] ?? null
    const resolved = resolutionMap.get(`${group.groupKey}:multi_product_name`)
    return resolved && group.productNames.includes(resolved) ? resolved : null
  }

  private resolveAxisResolution(group: YzGroup, resolutionMap: Map<string, string>): 'variant' | 'size' {
    const resolved = resolutionMap.get(`${group.groupKey}:axis_ambiguous`)
    return resolved === 'size' ? 'size' : 'variant'
  }

  private buildSkuPlans(group: YzGroup, axisResolution: 'variant' | 'size') {
    return group.rows.map((row) => {
      const swapped = this.isAxisAmbiguousGroup(group) && axisResolution === 'size'
      return {
        row,
        variantValue: swapped ? '' : row.variantAxisValue,
        sizeValue: swapped ? row.variantAxisValue : row.sizeAxisValue,
      }
    })
  }

  private isAxisAmbiguousGroup(group: YzGroup): boolean {
    const values = group.rows.map((row) => row.variantAxisValue.trim()).filter(Boolean)
    return values.length > 0 && values.every((value) => AXIS_AMBIGUOUS_PATTERN.test(value))
  }

  private buildSpecGroups(skuPlans: Array<{ variantValue: string; sizeValue: string }>) {
    const variantValues: string[] = []
    const sizeValues: string[] = []
    for (const plan of skuPlans) {
      if (plan.variantValue && !variantValues.includes(plan.variantValue)) variantValues.push(plan.variantValue)
      if (plan.sizeValue && !sizeValues.includes(plan.sizeValue)) sizeValues.push(plan.sizeValue)
    }
    return [
      ...(variantValues.length ? [{ name: VARIANT_AXIS_SPEC_KEY, values: variantValues }] : []),
      ...(sizeValues.length ? [{ name: SIZE_AXIS_SPEC_KEY, values: sizeValues }] : []),
    ]
  }

}

export const productImportYzService = new ProductImportYzService()
