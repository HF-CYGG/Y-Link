/**
 * 模块说明：商品 Excel 导入导出服务。
 * 文件职责：导出当前全部 SKU 明细、提供导入模板，并按“预览逐行校验 → 事务导入”两步批量新建商品。
 * 实现逻辑：
 * - 一行一个 SKU；同一“商品名称”的多行合并为一个商品的多个规格，规格写成“颜色=红;尺寸=L”；
 * - 预览阶段完成格式、分类、库位、文件内重复、库内条码/编码冲突校验，导入阶段复用同一校验，任何一行有错整批拒绝；
 * - 实际建档复用 productService.createWithManager，初始库存随之写入流水，不另开写库存的旁路。
 * 维护重点：V1 只新建商品，不按导入覆盖已有商品；列顺序调整时同步 TEMPLATE_COLUMNS 与前端说明。
 */

import ExcelJS from 'exceljs'
import { In, type EntityManager } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import { runInTransaction } from '../config/transaction-runner.js'
import { BaseCategory } from '../entities/base-category.entity.js'
import { BaseProduct } from '../entities/base-product.entity.js'
import { BaseProductSku } from '../entities/base-product-sku.entity.js'
import { BaseStorageLocation } from '../entities/base-storage-location.entity.js'
import type { AuthUserContext } from '../types/auth.js'
import { BizError } from '../utils/errors.js'
import type { RequestMeta } from '../utils/request-meta.js'
import { assertXlsxArchiveWithinLimits } from '../utils/xlsx-archive-guard.js'
import { lockActiveSysAccountForBusiness } from './account-business-guard.service.js'
import { auditService } from './audit.service.js'
import { invalidateMallCatalogReadCache } from './mall-catalog-revision.service.js'
import { productService, type CreateProductInput } from './product.service.js'

const TEMPLATE_COLUMNS = [
  { key: 'productName', header: '商品名称*', width: 24 },
  { key: 'categoryCode', header: '分类编码', width: 10 },
  { key: 'specs', header: '规格（如 颜色=红;尺寸=L）', width: 28 },
  { key: 'skuCode', header: 'SKU编码（留空自动生成）', width: 22 },
  { key: 'barcode', header: '原厂条码', width: 18 },
  { key: 'costPrice', header: '成本价', width: 10 },
  { key: 'salePrice', header: '售价', width: 10 },
  { key: 'initialStock', header: '初始库存', width: 10 },
  { key: 'locationCode', header: '库位编码', width: 12 },
  { key: 'status', header: '商品状态（启用/停用）', width: 18 },
  { key: 'thumbnail', header: '图片地址', width: 30 },
] as const

type TemplateKey = (typeof TEMPLATE_COLUMNS)[number]['key']

const HEADER_ALIASES: Record<TemplateKey, string[]> = {
  productName: ['商品名称', '名称', '商品'],
  categoryCode: ['分类编码', '分类编号', '分类'],
  specs: ['规格', '规格/款式', '款式'],
  skuCode: ['sku编码', 'sku', 'sku编号'],
  barcode: ['原厂条码', '条码', '条形码'],
  costPrice: ['成本价', '成本'],
  salePrice: ['售价', '单价', '价格'],
  initialStock: ['初始库存', '库存', '当前库存'],
  locationCode: ['库位编码', '库位'],
  status: ['商品状态', '状态'],
  thumbnail: ['图片地址', '图片', '商品图片'],
}

const MAX_IMPORT_ROWS = 1000
/** 解压体积预检上限：1000 行模板解压后远小于 1MB，留足余量给少量嵌入图片。 */
const IMPORT_ARCHIVE_LIMITS = { maxEntries: 2000, maxTotalUncompressedBytes: 20 * 1024 * 1024 }
/** 条码与 SKU 编码按文本读取；被 Excel 存成数字时只接受安全整数，避免科学计数法或精度丢失被悄悄导入。 */
const TEXT_CODE_KEYS = ['skuCode', 'barcode'] as const
const BARCODE_PATTERN = /^[\x21-\x7E]{1,64}$/

export interface ProductImportRowView {
  rowNumber: number
  productName: string
  categoryCode: string
  specText: string
  skuCode: string
  barcode: string
  costPrice: string
  salePrice: string
  initialStock: number
  locationCode: string
  isActive: boolean
  errors: string[]
}

export interface ProductImportPreview {
  rows: ProductImportRowView[]
  productCount: number
  skuCount: number
  errorCount: number
}

interface ParsedRow extends ProductImportRowView {
  specValues: Record<string, string>
  thumbnail: string
}

const normalizeHeader = (value: string) => value.replace(/[\s*（）()]/g, '').toLowerCase()

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

const parseSpecs = (raw: string): { values: Record<string, string>; error: string | null } => {
  const values: Record<string, string> = {}
  if (!raw) return { values, error: null }
  for (const part of raw.split(/[;；\n]/).map((item) => item.trim()).filter(Boolean)) {
    const matched = /^([^=:：]+)[=:：](.+)$/.exec(part)
    if (!matched) return { values, error: `规格「${part}」格式应为 名称=取值` }
    const name = matched[1].trim()
    const value = matched[2].trim()
    if (name.length > 32 || value.length > 64) return { values, error: `规格「${part}」过长` }
    if (values[name] !== undefined) return { values, error: `规格名「${name}」重复` }
    values[name] = value
  }
  return { values, error: null }
}

const readMoney = (raw: string, label: string, errors: string[]): string => {
  if (!raw) return ''
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0 || value > 9999999999.99) {
    errors.push(`${label}必须是不小于 0 的数字`)
    return raw
  }
  return value.toFixed(2)
}

export class ProductExcelService {
  async buildTemplate(): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('商品导入')
    sheet.columns = TEMPLATE_COLUMNS.map((column) => ({ header: column.header, key: column.key, width: column.width }))
    sheet.getRow(1).font = { bold: true }
    // 条码与编码列设为文本格式，避免 Excel 把以 0 开头的条码或长数字转成数值。
    for (const key of TEXT_CODE_KEYS) sheet.getColumn(key).numFmt = '@'
    sheet.addRow({ productName: '星空贴纸', categoryCode: '02', specs: '', skuCode: '', barcode: '', costPrice: 2.5, salePrice: 6, initialStock: 25, locationCode: 'A-01-01', status: '启用' })
    sheet.addRow({ productName: '帆布包', categoryCode: '03', specs: '颜色=米白;尺寸=大', skuCode: '', barcode: '6901234567892', costPrice: 18, salePrice: 49, initialStock: 10, locationCode: 'B-02-01', status: '启用' })
    sheet.addRow({ productName: '帆布包', categoryCode: '03', specs: '颜色=黑色;尺寸=大', skuCode: '', barcode: '', costPrice: 18, salePrice: 49, initialStock: 8, locationCode: 'B-02-01', status: '启用' })
    const guide = workbook.addWorksheet('填写说明')
    guide.columns = [{ header: '说明', key: 'text', width: 90 }]
    ;[
      '1. 一行代表一个 SKU；商品名称相同的多行会合并为同一商品的多个规格。',
      '2. 分类编码为两位数字，需先在“分类与库位”中建好；填写后新 SKU 编码自动按 WC + 分类编码 + 流水号生成。',
      '3. 规格写成“名称=取值”，多个规格用分号分隔，例如：颜色=红;尺寸=L；只有一个默认规格时留空。',
      '4. 原厂条码可留空，留空时以 SKU 编码作为内部条码打印。',
      '5. 初始库存会生成“新建商品初始库存”流水；导入只新建商品，不会修改已有商品。',
      '6. 任何一行校验失败，整批都不会导入，请按预览提示修正后重新上传。',
      '7. 条码、SKU 编码列已设为文本格式；从其他表格粘贴时请保持文本格式，否则以 0 开头的条码会丢失前导 0。',
    ].forEach((text) => guide.addRow({ text }))
    return Buffer.from(await workbook.xlsx.writeBuffer())
  }

  /** 导出当前版本 SKU；没有商品维护权限的账号不导出成本价列。 */
  async exportProducts(options: { includeCostPrice: boolean } = { includeCostPrice: true }): Promise<Buffer> {
    const [products, skus, categories, locations] = await Promise.all([
      AppDataSource.getRepository(BaseProduct).find({ order: { id: 'ASC' } }),
      AppDataSource.getRepository(BaseProductSku).find({ where: { isCurrent: true }, order: { productId: 'ASC', sortOrder: 'ASC', id: 'ASC' } }),
      AppDataSource.getRepository(BaseCategory).find(),
      AppDataSource.getRepository(BaseStorageLocation).find(),
    ])
    const productMap = new Map(products.map((product) => [String(product.id), product]))
    const categoryMap = new Map(categories.map((category) => [String(category.id), category]))
    const locationMap = new Map(locations.map((location) => [String(location.id), location.locationCode]))
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('商品SKU')
    sheet.columns = [
      { header: '商品编码', key: 'productCode', width: 18 },
      { header: '商品名称', key: 'productName', width: 24 },
      { header: '分类编码', key: 'categoryCode', width: 10 },
      { header: '分类名称', key: 'categoryName', width: 14 },
      { header: '规格', key: 'specs', width: 26 },
      { header: 'SKU编码', key: 'skuCode', width: 22 },
      { header: '原厂条码', key: 'barcode', width: 18 },
      { header: '打印条码', key: 'effectiveBarcode', width: 18 },
      ...(options.includeCostPrice ? [{ header: '成本价', key: 'costPrice', width: 10 }] : []),
      { header: '售价', key: 'salePrice', width: 10 },
      { header: '当前库存', key: 'currentStock', width: 10 },
      { header: '已预订', key: 'preOrderedStock', width: 10 },
      { header: '库位编码', key: 'locationCode', width: 12 },
      { header: '商品状态', key: 'productStatus', width: 10 },
      { header: '规格状态', key: 'skuStatus', width: 10 },
      { header: '图片地址', key: 'thumbnail', width: 30 },
    ]
    sheet.getRow(1).font = { bold: true }
    for (const sku of skus) {
      const product = productMap.get(String(sku.productId))
      if (!product) continue
      const category = product.categoryId ? categoryMap.get(String(product.categoryId)) : undefined
      let specs = ''
      try {
        specs = Object.entries(JSON.parse(sku.specValuesJson || '{}') as Record<string, string>)
          .map(([name, value]) => `${name}=${value}`)
          .join(';')
      } catch {
        specs = ''
      }
      sheet.addRow({
        productCode: product.productCode,
        productName: product.productName,
        categoryCode: category?.categoryCode ?? '',
        categoryName: category?.categoryName ?? '',
        specs,
        skuCode: sku.skuCode,
        barcode: sku.barcode ?? '',
        effectiveBarcode: sku.barcode || sku.skuCode,
        ...(options.includeCostPrice ? { costPrice: sku.costPrice === null ? '' : Number(sku.costPrice) } : {}),
        salePrice: Number(sku.defaultPrice ?? 0),
        currentStock: Number(sku.currentStock ?? 0),
        preOrderedStock: Number(sku.preOrderedStock ?? 0),
        locationCode: sku.locationId ? locationMap.get(String(sku.locationId)) ?? '' : '',
        productStatus: product.isActive ? '启用' : '停用',
        skuStatus: sku.isActive ? '启用' : '停用',
        thumbnail: sku.thumbnail ?? product.thumbnail ?? '',
      })
    }
    return Buffer.from(await workbook.xlsx.writeBuffer())
  }

  async parseWorkbook(buffer: Buffer): Promise<ParsedRow[]> {
    // exceljs 会把整包解压进内存建模，先按真实解压体积做预检，防止压缩炸弹拖垮进程。
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
    const columnIndex = new Map<TemplateKey, number>()
    for (const column of TEMPLATE_COLUMNS) {
      const aliases = HEADER_ALIASES[column.key].map(normalizeHeader)
      const primary = aliases[0]
      const exactIndex = headerValues.findIndex((header) => header && (header === normalizeHeader(column.header) || aliases.includes(header)))
      const index = exactIndex > 0 ? exactIndex : headerValues.findIndex((header) => header && header.startsWith(primary))
      if (index > 0) columnIndex.set(column.key, index)
    }
    if (!columnIndex.has('productName')) throw new BizError('未找到“商品名称”列，请使用导入模板', 400)

    const rows: ParsedRow[] = []
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return
      const read = (key: TemplateKey) => {
        const index = columnIndex.get(key)
        return index ? cellText(row.getCell(index).value) : ''
      }
      const values = TEMPLATE_COLUMNS.map((column) => read(column.key))
      if (values.every((value) => !value)) return
      const errors: string[] = []
      for (const key of TEXT_CODE_KEYS) {
        const index = columnIndex.get(key)
        const rawValue = index ? row.getCell(index).value : null
        if (typeof rawValue === 'number' && !Number.isSafeInteger(rawValue)) {
          errors.push(`${key === 'barcode' ? '原厂条码' : 'SKU 编码'}被 Excel 存成了数字且已失真，请把该列设为文本格式后重新填写`)
        }
      }
      const productName = read('productName')
      if (!productName) errors.push('商品名称不能为空')
      else if (productName.length > 128) errors.push('商品名称不能超过 128 个字符')
      const categoryCode = read('categoryCode')
      if (categoryCode && !/^\d{2}$/.test(categoryCode)) errors.push('分类编码必须为两位数字')
      const specRaw = read('specs')
      const parsedSpecs = parseSpecs(specRaw)
      if (parsedSpecs.error) errors.push(parsedSpecs.error)
      const skuCode = read('skuCode')
      if (skuCode.length > 96) errors.push('SKU 编码不能超过 96 个字符')
      const barcode = read('barcode')
      if (barcode && !BARCODE_PATTERN.test(barcode)) errors.push('原厂条码只能包含 1 到 64 个半角字母、数字或符号')
      const costPrice = readMoney(read('costPrice'), '成本价', errors)
      const salePrice = readMoney(read('salePrice'), '售价', errors)
      const stockRaw = read('initialStock')
      const initialStock = stockRaw ? Number(stockRaw) : 0
      if (!Number.isInteger(initialStock) || initialStock < 0 || initialStock > 999999999) errors.push('初始库存必须是不小于 0 的整数')
      const statusRaw = read('status')
      if (statusRaw && !['启用', '停用', '上架', '下架'].includes(statusRaw)) errors.push('商品状态只能填写“启用”或“停用”')
      const thumbnail = read('thumbnail')
      if (thumbnail.length > 255) errors.push('图片地址不能超过 255 个字符')
      rows.push({
        rowNumber: rowNumber,
        productName,
        categoryCode,
        specText: Object.entries(parsedSpecs.values).map(([name, value]) => `${name}=${value}`).join(';'),
        specValues: parsedSpecs.values,
        skuCode,
        barcode,
        costPrice,
        salePrice,
        initialStock: Number.isInteger(initialStock) ? initialStock : 0,
        locationCode: read('locationCode').toUpperCase(),
        isActive: !(statusRaw === '停用' || statusRaw === '下架'),
        thumbnail,
        errors,
      })
    })
    if (!rows.length) throw new BizError('Excel 中没有可导入的数据行', 400)
    if (rows.length > MAX_IMPORT_ROWS) throw new BizError(`单次最多导入 ${MAX_IMPORT_ROWS} 行`, 400)
    return rows
  }

  async preview(buffer: Buffer): Promise<ProductImportPreview> {
    const { rows, groups } = await this.validate(await this.parseWorkbook(buffer))
    return this.toPreview(rows, groups.size)
  }

  async importProducts(buffer: Buffer, actor: AuthUserContext, requestMeta?: RequestMeta) {
    const parsedRows = await this.parseWorkbook(buffer)
    const result = await runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, actor.userId)
      const { rows, groups, categoryIdByCode, locationIdByCode } = await this.validate(parsedRows, manager)
      const preview = this.toPreview(rows, groups.size)
      if (preview.errorCount > 0) {
        throw new BizError(`有 ${preview.errorCount} 行未通过校验，请先修正后再导入`, 400, { preview })
      }
      const created: Array<{ id: string; productCode: string; productName: string; skuCount: number }> = []
      for (const groupRows of groups.values()) {
        const [first] = groupRows
        const hasSpecs = groupRows.some((row) => Object.keys(row.specValues).length > 0)
        const specGroups = new Map<string, string[]>()
        groupRows.forEach((row) => Object.entries(row.specValues).forEach(([name, value]) => {
          const values = specGroups.get(name) ?? []
          if (!values.includes(value)) values.push(value)
          specGroups.set(name, values)
        }))
        const input: CreateProductInput = {
          productName: first.productName,
          categoryId: first.categoryCode ? categoryIdByCode.get(first.categoryCode) ?? null : null,
          defaultPrice: first.salePrice ? Number(first.salePrice) : 0,
          isActive: first.isActive,
          thumbnail: first.thumbnail || null,
          currentStock: groupRows.reduce((sum, row) => sum + row.initialStock, 0),
          specGroups: hasSpecs ? [...specGroups.entries()].map(([name, values]) => ({ name, values })) : [],
          skus: groupRows.map((row, index) => ({
            skuCode: row.skuCode || undefined,
            specValues: row.specValues,
            defaultPrice: row.salePrice ? Number(row.salePrice) : undefined,
            currentStock: row.initialStock,
            barcode: row.barcode || null,
            costPrice: row.costPrice ? Number(row.costPrice) : null,
            locationId: row.locationCode ? locationIdByCode.get(row.locationCode) ?? null : null,
            thumbnail: row.thumbnail || undefined,
            sortOrder: index,
          })),
        }
        try {
          const view = await productService.createWithManager(input, manager, actor)
          created.push({ id: view.id, productCode: view.productCode, productName: view.productName, skuCount: view.skus.length })
        } catch (error) {
          if (error instanceof BizError) {
            throw new BizError(`第 ${groupRows.map((row) => row.rowNumber).join('、')} 行导入失败：${error.message}`, error.statusCode)
          }
          throw error
        }
      }
      await auditService.record({
        actionType: 'product.import',
        actionLabel: 'Excel 批量导入商品',
        targetType: 'product_import',
        targetCode: `${created.length} 个商品 / ${rows.length} 个规格`,
        actor,
        requestMeta,
        detail: {
          productCount: created.length,
          skuCount: rows.length,
          totalInitialStock: rows.reduce((sum, row) => sum + row.initialStock, 0),
          products: created.slice(0, 50).map((item) => `${item.productCode} ${item.productName}`),
        },
      }, manager)
      return { productCount: created.length, skuCount: rows.length, products: created }
    })
    invalidateMallCatalogReadCache()
    return result
  }

  private toPreview(rows: ParsedRow[], productCount: number): ProductImportPreview {
    return {
      rows: rows.map(({ specValues: _specValues, thumbnail: _thumbnail, ...row }) => row),
      productCount,
      skuCount: rows.length,
      errorCount: rows.filter((row) => row.errors.length > 0).length,
    }
  }

  private async validate(rows: ParsedRow[], manager: EntityManager = AppDataSource.manager) {
    const categoryCodes = [...new Set(rows.map((row) => row.categoryCode).filter(Boolean))]
    const locationCodes = [...new Set(rows.map((row) => row.locationCode).filter(Boolean))]
    const fileCodes = [...new Set(rows.flatMap((row) => [row.skuCode, row.barcode]).filter(Boolean))]
    const [categories, locations, conflictSkus] = await Promise.all([
      categoryCodes.length ? manager.getRepository(BaseCategory).find({ where: { categoryCode: In(categoryCodes) } }) : [],
      locationCodes.length ? manager.getRepository(BaseStorageLocation).find({ where: { locationCode: In(locationCodes) } }) : [],
      fileCodes.length
        ? manager.getRepository(BaseProductSku).createQueryBuilder('sku')
          .select(['sku.id', 'sku.skuCode', 'sku.barcode'])
          .where('sku.skuCode IN (:...fileCodes) OR sku.barcode IN (:...fileCodes)', { fileCodes })
          .getMany()
        : [],
    ])
    const categoryByCode = new Map(categories.map((category) => [category.categoryCode, category]))
    const locationByCode = new Map(locations.map((location) => [location.locationCode, location]))
    const usedInDb = new Set(conflictSkus.flatMap((sku) => [sku.skuCode, sku.barcode]).filter(Boolean) as string[])

    const seenCodes = new Map<string, number>()
    const groups = new Map<string, ParsedRow[]>()
    for (const row of rows) {
      if (row.categoryCode) {
        const category = categoryByCode.get(row.categoryCode)
        if (!category) row.errors.push(`分类编码 ${row.categoryCode} 不存在`)
        else if (!category.isActive) row.errors.push(`分类 ${row.categoryCode} 已停用`)
      }
      if (row.locationCode) {
        const location = locationByCode.get(row.locationCode)
        if (!location) row.errors.push(`库位 ${row.locationCode} 不存在`)
        else if (!location.isActive) row.errors.push(`库位 ${row.locationCode} 已停用`)
      }
      for (const code of [row.skuCode, row.barcode].filter(Boolean)) {
        const previousRow = seenCodes.get(code)
        if (previousRow !== undefined && previousRow !== row.rowNumber) row.errors.push(`编码或条码 ${code} 与第 ${previousRow} 行重复`)
        else seenCodes.set(code, row.rowNumber)
        if (usedInDb.has(code)) row.errors.push(`编码或条码 ${code} 已被系统中的商品使用`)
      }
      if (row.productName) {
        const groupRows = groups.get(row.productName) ?? []
        groupRows.push(row)
        groups.set(row.productName, groupRows)
      }
    }
    for (const groupRows of groups.values()) {
      const [first] = groupRows
      const specKeys = new Set<string>()
      for (const row of groupRows) {
        if (row.categoryCode !== first.categoryCode) row.errors.push(`同一商品的分类编码必须一致（第 ${first.rowNumber} 行为 ${first.categoryCode || '空'}）`)
        if (row.isActive !== first.isActive) row.errors.push(`同一商品的商品状态必须一致（以第 ${first.rowNumber} 行为准）`)
        if (groupRows.length > 1 && Object.keys(row.specValues).length === 0) row.errors.push('同一商品有多行时，每行都必须填写规格')
        const specKey = JSON.stringify(Object.entries(row.specValues).sort(([left], [right]) => left.localeCompare(right)))
        if (specKeys.has(specKey)) row.errors.push(`规格「${row.specText || '默认规格'}」在该商品中重复`)
        specKeys.add(specKey)
      }
    }
    return {
      rows,
      groups,
      categoryIdByCode: new Map(categories.map((category) => [category.categoryCode, String(category.id)])),
      locationIdByCode: new Map(locations.map((location) => [location.locationCode, String(location.id)])),
    }
  }
}

export const productExcelService = new ProductExcelService()
