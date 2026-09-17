/**
 * 模块说明：库存查询服务（当前库存与通用库存流水）。
 * 文件职责：按 SKU 维度查询当前库存，按多条件分页查询与导出 inventory_log。
 * 实现逻辑：库存与流水都以 SKU 为主，联查商品、分类、库位名称；流水类型中文名取自统一字典。
 * 维护重点：只读服务，不参与任何写库存流程。
 */

import ExcelJS from 'exceljs'
import { AppDataSource } from '../config/data-source.js'
import { INVENTORY_CHANGE_TYPE_LABELS } from '../constants/inventory-change-types.js'
import { BaseProductSku } from '../entities/base-product-sku.entity.js'
import { InventoryLog } from '../entities/inventory-log.entity.js'
import type { PaginationResult } from '../types/api.js'
import { calculateDiscountedPrice } from '../utils/discount-price.js'
import { BizError } from '../utils/errors.js'

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
  locationId: string | null
  locationCode: string | null
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

const LOG_EXPORT_LIMIT = 20000

const isEnabled = (value: unknown) => value !== false && value !== 0 && value !== '0'

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
      qb.andWhere('(p.product_name LIKE :keyword OR p.pinyin_abbr LIKE :keyword OR sku.skuCode LIKE :keyword OR sku.barcode LIKE :keyword OR sku.specText LIKE :keyword)', {
        keyword: `%${query.keyword.trim()}%`,
      })
    }
    if (query.categoryId) qb.andWhere('p.category_id = :categoryId', { categoryId: query.categoryId })
    if (query.locationId === 'none') qb.andWhere('sku.locationId IS NULL')
    else if (query.locationId) qb.andWhere('sku.locationId = :locationId', { locationId: query.locationId })
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
    const qb = this.buildLogQuery(query)
    const total = await qb.getCount()
    if (total > LOG_EXPORT_LIMIT) throw new BizError(`导出结果 ${total} 条，超过 ${LOG_EXPORT_LIMIT} 条上限，请缩小时间范围`, 400)
    const rows = await qb.orderBy('log.id', 'DESC').getMany()
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('库存流水')
    sheet.columns = [
      { header: '时间', key: 'createdAt', width: 20 },
      { header: '商品', key: 'productName', width: 24 },
      { header: 'SKU编码', key: 'skuCode', width: 20 },
      { header: '规格', key: 'specText', width: 18 },
      { header: '操作类型', key: 'changeTypeLabel', width: 16 },
      // 销售出库等历史流水的 changeQty 以出库为正，导出统一给出带符号的实际库存变化，原始数量单列保留。
      { header: '库存变化', key: 'stockDelta', width: 10 },
      { header: '记录数量', key: 'changeQty', width: 10 },
      { header: '操作前库存', key: 'beforeStock', width: 12 },
      { header: '操作后库存', key: 'afterStock', width: 12 },
      { header: '操作人', key: 'operatorName', width: 14 },
      { header: '关联单据', key: 'ref', width: 22 },
      { header: '备注', key: 'remark', width: 40 },
    ]
    sheet.getRow(1).font = { bold: true }
    for (const row of rows.map((item) => this.buildLogView(item))) {
      sheet.addRow({
        ...row,
        createdAt: new Date(row.createdAt).toLocaleString('zh-CN', { hour12: false }),
        ref: row.refType ? `${row.refType}#${row.refId ?? ''}` : '',
      })
    }
    return Buffer.from(await workbook.xlsx.writeBuffer())
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
      qb.andWhere('(product.productName LIKE :keyword OR sku.skuCode LIKE :keyword OR sku.barcode LIKE :keyword OR log.operatorName LIKE :keyword OR log.remark LIKE :keyword)', {
        keyword: `%${query.keyword.trim()}%`,
      })
    }
    if (query.startDate) qb.andWhere('log.createdAt >= :startDate', { startDate: new Date(`${query.startDate}T00:00:00`) })
    if (query.endDate) qb.andWhere('log.createdAt < :endDate', { endDate: new Date(new Date(`${query.endDate}T00:00:00`).getTime() + 86400000) })
    return qb
  }

  private buildLogView(row: InventoryLog): InventoryLogRowView {
    const hasSku = row.skuId !== null && row.skuId !== undefined && row.beforeSkuCurrentStock !== null
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
      stockDelta: Number(hasSku ? row.afterSkuCurrentStock : row.afterCurrentStock) - Number(hasSku ? row.beforeSkuCurrentStock : row.beforeCurrentStock),
      beforeStock: Number(hasSku ? row.beforeSkuCurrentStock : row.beforeCurrentStock),
      afterStock: Number(hasSku ? row.afterSkuCurrentStock : row.afterCurrentStock),
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
