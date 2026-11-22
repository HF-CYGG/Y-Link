/**
 * 模块说明：库存查询服务（当前库存与通用库存流水）。
 * 文件职责：按 SKU 维度查询当前库存，按多条件分页查询与导出 inventory_log。
 * 实现逻辑：库存与流水都以 SKU 为主，联查商品、分类、库位名称；流水类型中文名取自统一字典。
 * - 同一规格可分放多个库位：locationId / locationCode 为主库位，otherLocations 为主库位以外的拆分库位与件数；
 *   按库位筛选时命中“主库位在此或在此拆有件数”的规格。
 * 维护重点：只读服务，不参与任何写库存流程。
 */

import type { Writable } from 'node:stream'
import { AppDataSource } from '../config/data-source.js'
import { INVENTORY_CHANGE_TYPE_LABELS } from '../constants/inventory-change-types.js'
import { BaseProductSku } from '../entities/base-product-sku.entity.js'
import { InvSkuLocationStock } from '../entities/inv-sku-location-stock.entity.js'
import { InventoryLog } from '../entities/inventory-log.entity.js'
import type { PaginationResult } from '../types/api.js'
import { calculateDiscountedPrice } from '../utils/discount-price.js'
import { BizError } from '../utils/errors.js'
import { loadSkuLocationDistributions, type SkuLocationQty } from './sku-location-stock.service.js'
import { buildSqlLikeContains } from '../utils/sql-like.js'
import { assertXlsxOutputOpen, bufferXlsxExport, writeStreamingXlsx } from '../utils/xlsx-export.js'

export interface StockQuery {
  page?: number
  pageSize?: number
  keyword?: string
  categoryId?: string
  locationId?: string
  maxStock?: number
  includeInactive?: boolean
}

export interface StockRowView {
  skuId: string
  skuCode: string
  barcode: string | null
  effectiveBarcode: string
  specText: string
  productId: string
  productCode: string
  productName: string
  thumbnail: string | null
  categoryId: string | null
  categoryName: string | null
  /** 主库位。 */
  locationId: string | null
  locationCode: string | null
  /** 主库位件数（总库存减去其他库位件数）。 */
  mainLocationQty: number
  /** 主库位以外的拆分库位与件数。 */
  otherLocations: SkuLocationQty[]
  costPrice: string | null
  salePrice: string
  currentStock: number
  preOrderedStock: number
  availableStock: number
  isActive: boolean
}

export interface InventoryLogQuery {
  page?: number
  pageSize?: number
  keyword?: string
  changeTypes?: string[]
  skuId?: string
  productId?: string
  refType?: string
  refId?: string
  startDate?: string
  endDate?: string
}

export interface InventoryLogRowView {
  id: string
  createdAt: string
  productId: string
  productName: string
  skuId: string | null
  skuCode: string | null
  specText: string | null
  changeType: string
  changeTypeLabel: string
  changeQty: number
  /** 带符号的实际库存变化（afterStock − beforeStock）；预订占用类流水为 0。 */
  stockDelta: number
  beforeStock: number
  afterStock: number
  beforeProductStock: number
  afterProductStock: number
  operatorName: string | null
  refType: string | null
  refId: string | null
  remark: string | null
}

type InventoryLogStock = Pick<InventoryLog,
  'skuId' | 'beforeCurrentStock' | 'afterCurrentStock' | 'beforeSkuCurrentStock' | 'afterSkuCurrentStock'>

type InventoryLogExportRow = InventoryLogStock & Pick<InventoryLog,
  'id' | 'changeType' | 'changeQty' | 'operatorName' | 'refType' | 'refId' | 'remark'> & {
  createdAt: Date | string
  productName: string | null
  skuCode: string | null
  specText: string | null
}

const LOG_EXPORT_LIMIT = 20000
const LOG_EXPORT_BATCH_SIZE = 500

const isEnabled = (value: unknown) => value !== false && value !== 0 && value !== '0'

function resolveLogStock(row: InventoryLogStock) {
  const hasSku = row.skuId !== null && row.skuId !== undefined && row.beforeSkuCurrentStock !== null
  const beforeStock = Number(hasSku ? row.beforeSkuCurrentStock : row.beforeCurrentStock)
  const afterStock = Number(hasSku ? row.afterSkuCurrentStock : row.afterCurrentStock)
  return { beforeStock, afterStock, stockDelta: afterStock - beforeStock }
}

export class InventoryQueryService {
  async listStocks(query: StockQuery): Promise<PaginationResult<StockRowView> & { totalQty: number }> {
    const page = Math.max(1, Math.floor(Number(query.page || 1)))
    const pageSize = Math.min(200, Math.max(10, Math.floor(Number(query.pageSize || 20))))
    const qb = AppDataSource.getRepository(BaseProductSku)
      .createQueryBuilder('sku')
      .innerJoin('base_product', 'p', 'p.id = sku.product_id')
      .leftJoin('base_category', 'c', 'c.id = p.category_id')
      .leftJoin('base_storage_location', 'l', 'l.id = sku.location_id')
      .where('sku.isCurrent = :isCurrent', { isCurrent: true })
    if (!query.includeInactive) {
      qb.andWhere('sku.isActive = :isActive', { isActive: true }).andWhere('p.is_active = :productActive', { productActive: 1 })
    }
    if (query.keyword?.trim()) {
      qb.andWhere("(p.product_name LIKE :keyword ESCAPE '!' OR p.pinyin_abbr LIKE :keyword ESCAPE '!' OR sku.skuCode LIKE :keyword ESCAPE '!' OR sku.barcode LIKE :keyword ESCAPE '!' OR sku.specText LIKE :keyword ESCAPE '!')", {
        keyword: buildSqlLikeContains(query.keyword.trim()),
      })
    }
    if (query.categoryId) qb.andWhere('p.category_id = :categoryId', { categoryId: query.categoryId })
    if (query.locationId === 'none') qb.andWhere('sku.locationId IS NULL')
    else if (query.locationId) {
      const stockedHere = qb.subQuery()
        .select('1')
        .from(InvSkuLocationStock, 'stock')
        .where('stock.skuId = sku.id')
        .andWhere('stock.locationId = :locationId')
        .getQuery()
      qb.andWhere(`(sku.locationId = :locationId OR EXISTS ${stockedHere})`, { locationId: query.locationId })
    }
    if (typeof query.maxStock === 'number' && Number.isFinite(query.maxStock)) {
      qb.andWhere('sku.currentStock <= :maxStock', { maxStock: Math.floor(query.maxStock) })
    }

    const totals = await qb.clone()
      .select('COUNT(*)', 'total')
      .addSelect('COALESCE(SUM(sku.current_stock), 0)', 'totalQty')
      .getRawOne<{ total: string; totalQty: string }>()
    const rows = await qb
      .select('sku.id', 'skuId')
      .addSelect('sku.sku_code', 'skuCode')
      .addSelect('sku.barcode', 'barcode')
      .addSelect('sku.spec_text', 'specText')
      .addSelect('sku.default_price', 'defaultPrice')
      .addSelect('sku.discount_rate', 'discountRate')
      .addSelect('sku.cost_price', 'costPrice')
      .addSelect('sku.current_stock', 'currentStock')
      .addSelect('sku.pre_ordered_stock', 'preOrderedStock')
      .addSelect('sku.is_active', 'skuActive')
      .addSelect('sku.location_id', 'locationId')
      .addSelect('sku.thumbnail', 'skuThumbnail')
      .addSelect('p.id', 'productId')
      .addSelect('p.product_code', 'productCode')
      .addSelect('p.product_name', 'productName')
      .addSelect('p.thumbnail', 'productThumbnail')
      .addSelect('p.is_active', 'productActive')
      .addSelect('p.category_id', 'categoryId')
      .addSelect('c.category_name', 'categoryName')
      .addSelect('l.location_code', 'locationCode')
      .orderBy('p.product_name', 'ASC')
      .addOrderBy('sku.sort_order', 'ASC')
      .addOrderBy('sku.id', 'ASC')
      .offset((page - 1) * pageSize)
      .limit(pageSize)
      .getRawMany<Record<string, string | number | null>>()
    const distributions = await loadSkuLocationDistributions(AppDataSource.manager, rows.map((row) => ({
      id: String(row.skuId),
      locationId: row.locationId ? String(row.locationId) : null,
      currentStock: Number(row.currentStock ?? 0),
    })))

    return {
      page,
      pageSize,
      total: Number(totals?.total ?? 0),
      totalQty: Number(totals?.totalQty ?? 0),
      list: rows.map((row) => {
        const currentStock = Number(row.currentStock ?? 0)
        const preOrderedStock = Number(row.preOrderedStock ?? 0)
        return {
          skuId: String(row.skuId),
          skuCode: String(row.skuCode),
          barcode: row.barcode ? String(row.barcode) : null,
          effectiveBarcode: String(row.barcode || row.skuCode),
          specText: String(row.specText || '默认规格'),
          productId: String(row.productId),
          productCode: String(row.productCode),
          productName: String(row.productName),
          thumbnail: (row.skuThumbnail || row.productThumbnail || null) as string | null,
          categoryId: row.categoryId ? String(row.categoryId) : null,
          categoryName: row.categoryName ? String(row.categoryName) : null,
          locationId: row.locationId ? String(row.locationId) : null,
          locationCode: row.locationCode ? String(row.locationCode) : null,
          mainLocationQty: distributions.get(String(row.skuId))?.mainQty ?? currentStock,
          otherLocations: distributions.get(String(row.skuId))?.others ?? [],
          costPrice: row.costPrice === null || row.costPrice === undefined ? null : Number(row.costPrice).toFixed(2),
          salePrice: calculateDiscountedPrice(String(row.defaultPrice ?? 0), String(row.discountRate ?? 10)),
          currentStock,
          preOrderedStock,
          availableStock: Math.max(0, currentStock - preOrderedStock),
          isActive: isEnabled(row.skuActive) && isEnabled(row.productActive),
        }
      }),
    }
  }

  async listLogs(query: InventoryLogQuery): Promise<PaginationResult<InventoryLogRowView>> {
    const page = Math.max(1, Math.floor(Number(query.page || 1)))
    const pageSize = Math.min(100, Math.max(10, Math.floor(Number(query.pageSize || 20))))
    const qb = this.buildLogQuery(query)
    const total = await qb.getCount()
    const rows = await qb.orderBy('log.id', 'DESC').skip((page - 1) * pageSize).take(pageSize).getMany()
    return { page, pageSize, total, list: rows.map((row) => this.buildLogView(row)) }
  }

  async exportLogs(query: InventoryLogQuery): Promise<Buffer> {
    return (await this.exportLogsWithSummary(query)).buffer
  }

  async exportLogsWithSummary(query: InventoryLogQuery): Promise<{ buffer: Buffer; rowCount: number }> {
    return bufferXlsxExport((output) => this.exportLogsToStream(query, output))
  }

  /** 以流水主键倒序读取并流式导出，返回实际写出的行数。 */
  async exportLogsToStream(query: InventoryLogQuery, output: Writable, onReady?: () => void): Promise<{ rowCount: number }> {
    assertXlsxOutputOpen(output)
    const qb = this.buildLogQuery(query)
    const sqlite = AppDataSource.options.type === 'sqlite'
    const idType = sqlite ? 'TEXT' : 'CHAR'
    const idParameterType = sqlite ? 'INTEGER' : 'UNSIGNED'
    const createdAtColumn = AppDataSource.getMetadata(InventoryLog).findColumnWithPropertyName('createdAt')!
    const totals = await qb.clone()
      .select('COUNT(*)', 'total')
      .addSelect(`CAST(MAX(log.id) AS ${idType})`, 'maxId')
      .getRawOne<{ total: number | string; maxId: string | null }>()
    const total = Number(totals?.total ?? 0)
    if (total > LOG_EXPORT_LIMIT) throw new BizError(`导出结果 ${total} 条，超过 ${LOG_EXPORT_LIMIT} 条上限，请缩小时间范围`, 400)
    const fetchBatch = (limit: number, cursor?: string) => {
      assertXlsxOutputOpen(output)
      const batch = qb.clone()
        // 用文本承接大整数游标，避免 SQLite 数字精度丢失使相邻流水合并或跨批跳过。
        .select(`CAST(log.id AS ${idType})`, 'id')
        .addSelect('log.createdAt', 'createdAt')
        .addSelect(`CAST(log.skuId AS ${idType})`, 'skuId')
        .addSelect('log.changeType', 'changeType')
        .addSelect('log.changeQty', 'changeQty')
        .addSelect('log.beforeCurrentStock', 'beforeCurrentStock')
        .addSelect('log.afterCurrentStock', 'afterCurrentStock')
        .addSelect('log.beforeSkuCurrentStock', 'beforeSkuCurrentStock')
        .addSelect('log.afterSkuCurrentStock', 'afterSkuCurrentStock')
        .addSelect('log.operatorName', 'operatorName')
        .addSelect('log.refType', 'refType')
        .addSelect('log.refId', 'refId')
        .addSelect('log.remark', 'remark')
        .addSelect('product.productName', 'productName')
        .addSelect('sku.skuCode', 'skuCode')
        .addSelect('sku.specText', 'specText')
        .andWhere(`log.id <= CAST(:maxId AS ${idParameterType})`, { maxId: totals?.maxId })
        .orderBy('log.id', 'DESC')
        .limit(limit)
      if (cursor !== undefined) batch.andWhere(`log.id < CAST(:cursor AS ${idParameterType})`, { cursor })
      return batch.getRawMany<InventoryLogExportRow>()
    }
    let rows = total > 0 ? await fetchBatch(LOG_EXPORT_BATCH_SIZE) : []

    return writeStreamingXlsx(output, onReady, async (workbook, waitForRows) => {
      const sheet = workbook.addWorksheet('库存流水')
      sheet.columns = [
        { header: '时间', key: 'createdAt', width: 20 },
        { header: '商品', key: 'productName', width: 24 },
        { header: 'SKU编码', key: 'skuCode', width: 20 },
        { header: '规格', key: 'specText', width: 18 },
        { header: '操作类型', key: 'changeTypeLabel', width: 16 },
        // 销售出库等历史流水的 changeQty 以出库为正，单列保留原始数量。
        { header: '库存变化', key: 'stockDelta', width: 10 },
        { header: '记录数量', key: 'changeQty', width: 10 },
        { header: '操作前库存', key: 'beforeStock', width: 12 },
        { header: '操作后库存', key: 'afterStock', width: 12 },
        { header: '操作人', key: 'operatorName', width: 14 },
        { header: '关联单据', key: 'ref', width: 22 },
        { header: '备注', key: 'remark', width: 40 },
      ]
      sheet.getRow(1).font = { bold: true }
      sheet.getRow(1).commit()
      let rowCount = 0
      while (rows.length) {
        await waitForRows()
        for (const row of rows) {
          // 沿用实体的驱动时间转换，特别是 SQLite 无时区 DATETIME 的 UTC 解释。
          const createdAt = AppDataSource.driver.prepareHydratedValue(row.createdAt, createdAtColumn) as Date
          sheet.addRow({
            createdAt: createdAt.toLocaleString('zh-CN', { hour12: false }),
            productName: row.productName ?? '',
            skuCode: row.skuCode,
            specText: row.specText,
            changeTypeLabel: INVENTORY_CHANGE_TYPE_LABELS[row.changeType] ?? row.changeType,
            changeQty: Number(row.changeQty),
            ...resolveLogStock(row),
            operatorName: row.operatorName,
            ref: row.refType ? `${row.refType}#${row.refId ?? ''}` : '',
            remark: row.remark,
          }).commit()
        }
        rowCount += rows.length
        await waitForRows()
        if (rows.length < LOG_EXPORT_BATCH_SIZE || rowCount >= LOG_EXPORT_LIMIT) break
        rows = await fetchBatch(Math.min(LOG_EXPORT_BATCH_SIZE, LOG_EXPORT_LIMIT - rowCount), rows[rows.length - 1].id)
      }
      sheet.commit()
      return { rowCount }
    })
  }

  private buildLogQuery(query: InventoryLogQuery) {
    const qb = AppDataSource.getRepository(InventoryLog)
      .createQueryBuilder('log')
      .leftJoinAndSelect('log.product', 'product')
      .leftJoinAndSelect('log.sku', 'sku')
    const changeTypes = (query.changeTypes ?? []).map((item) => item.trim()).filter(Boolean)
    if (changeTypes.length) qb.andWhere('log.changeType IN (:...changeTypes)', { changeTypes })
    if (query.skuId) qb.andWhere('log.skuId = :skuId', { skuId: query.skuId })
    if (query.productId) qb.andWhere('log.productId = :productId', { productId: query.productId })
    if (query.refType) qb.andWhere('log.refType = :refType', { refType: query.refType })
    if (query.refId) qb.andWhere('log.refId = :refId', { refId: query.refId })
    if (query.keyword?.trim()) {
      qb.andWhere("(product.productName LIKE :keyword ESCAPE '!' OR sku.skuCode LIKE :keyword ESCAPE '!' OR sku.barcode LIKE :keyword ESCAPE '!' OR log.operatorName LIKE :keyword ESCAPE '!' OR log.remark LIKE :keyword ESCAPE '!')", {
        keyword: buildSqlLikeContains(query.keyword.trim()),
      })
    }
    if (query.startDate) qb.andWhere('log.createdAt >= :startDate', { startDate: new Date(`${query.startDate}T00:00:00`) })
    if (query.endDate) qb.andWhere('log.createdAt < :endDate', { endDate: new Date(new Date(`${query.endDate}T00:00:00`).getTime() + 86400000) })
    return qb
  }

  private buildLogView(row: InventoryLog): InventoryLogRowView {
    return {
      id: String(row.id),
      createdAt: new Date(row.createdAt).toISOString(),
      productId: String(row.productId),
      productName: row.product?.productName ?? '',
      skuId: row.skuId ? String(row.skuId) : null,
      skuCode: row.sku?.skuCode ?? null,
      specText: row.sku?.specText ?? null,
      changeType: row.changeType,
      changeTypeLabel: INVENTORY_CHANGE_TYPE_LABELS[row.changeType] ?? row.changeType,
      changeQty: Number(row.changeQty),
      ...resolveLogStock(row),
      beforeProductStock: Number(row.beforeCurrentStock),
      afterProductStock: Number(row.afterCurrentStock),
      operatorName: row.operatorName ?? null,
      refType: row.refType ?? null,
      refId: row.refId ?? null,
      remark: row.remark ?? null,
    }
  }
}

export const inventoryQueryService = new InventoryQueryService()
