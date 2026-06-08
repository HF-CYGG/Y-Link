/**
 * 模块说明：backend/src/services/report.service.ts
 * 文件职责：统一生成报表中心的库存、标签销售、金蝶、散客与出库流水数据，并承接 Excel 导出。
 * 实现逻辑：
 * - 报表字段先按类型声明白名单，查询和导出都只能消费白名单字段；
 * - 库存表读取商品当前库存快照，销售类报表基于出库主单和明细联表生成；
 * - Excel 导出复用同一套行数据与字段定义，保证页面预览和导出文件口径一致。
 * 维护说明：
 * - 新增报表类型时必须先补字段定义，再补查询分支和导出标题；
 * - 财务类报表默认排除已软删除单据，出库流水表保留删除状态用于追溯。
 */

import ExcelJS from 'exceljs'
import { In } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import { BaseProduct } from '../entities/base-product.entity.js'
import { BizOutboundOrder } from '../entities/biz-outbound-order.entity.js'
import { BizOutboundOrderItem } from '../entities/biz-outbound-order-item.entity.js'
import { RelProductTag } from '../entities/rel-product-tag.entity.js'
import type { PaginationResult } from '../types/api.js'
import { BizError } from '../utils/errors.js'

export const REPORT_TYPES = ['inventory', 'tag-sales', 'kingdee', 'walkin', 'outbound-flow'] as const
export type ReportType = (typeof REPORT_TYPES)[number]

export interface ReportFieldDefinition {
  key: string
  label: string
  width: number
  numeric?: boolean
}

export type ReportRow = Record<string, string | number | null>

export interface ReportQueryInput {
  page?: number
  pageSize?: number
  startDate?: string
  endDate?: string
  tagIds?: string[]
  fields?: string[]
}

export interface ReportQueryResult extends PaginationResult<ReportRow> {
  type: ReportType
  title: string
  fields: ReportFieldDefinition[]
  availableFields: ReportFieldDefinition[]
}

export interface ReportExportResult {
  buffer: Buffer
  fileName: string
}

interface ResolvedReportQuery {
  page: number
  pageSize: number
  startAt?: Date
  endExclusive?: Date
  tagIds: string[]
  fields: ReportFieldDefinition[]
}

interface OrderItemReportRaw {
  createdAt: Date | string
  showNo: string | null
  orderType: string | null
  productId: string | number
  productName: string | null
  qty: string | number | null
  unitPrice: string | number | null
  amount: string | number | null
  departmentName: string | null
  receiverName: string | null
  hasCustomerOrder: boolean | number | string | null
  isSystemApplied: boolean | number | string | null
  operatorName: string | null
  isDeleted: boolean | number | string | null
}

interface OutboundFlowRaw {
  createdAt: Date | string
  showNo: string | null
  orderType: string | null
  totalAmount: string | number | null
  totalQty: string | number | null
  departmentName: string | null
  receiverName: string | null
  issuerName: string | null
  operatorName: string | null
  hasCustomerOrder: boolean | number | string | null
  isSystemApplied: boolean | number | string | null
  isDeleted: boolean | number | string | null
}

const DATE_MS = 24 * 60 * 60 * 1000
const MAX_PAGE_SIZE = 100

const REPORT_TITLE_MAP: Record<ReportType, string> = {
  inventory: '库存一览表',
  'tag-sales': '标签销售汇总表',
  kingdee: '金蝶汇总表',
  walkin: '散客汇总表',
  'outbound-flow': '出库单流水表',
}

const REPORT_FIELD_DEFINITIONS: Record<ReportType, ReportFieldDefinition[]> = {
  inventory: [
    { key: 'category', label: '品类', width: 18 },
    { key: 'productCode', label: '商品编码', width: 18 },
    { key: 'productName', label: '商品名称', width: 28 },
    { key: 'defaultPrice', label: '售价', width: 14, numeric: true },
    { key: 'currentStock', label: '当前库存', width: 14, numeric: true },
    { key: 'preOrderedStock', label: '预订库存', width: 14, numeric: true },
    { key: 'availableStock', label: '可用库存', width: 14, numeric: true },
    { key: 'status', label: '状态', width: 12 },
  ],
  'tag-sales': [
    { key: 'time', label: '时间', width: 20 },
    { key: 'tags', label: '标签', width: 20 },
    { key: 'productName', label: '商品名称', width: 28 },
    { key: 'qty', label: '数量', width: 12, numeric: true },
    { key: 'unitPrice', label: '单价', width: 12, numeric: true },
    { key: 'amount', label: '总价', width: 14, numeric: true },
    { key: 'departmentName', label: '部门', width: 22 },
    { key: 'receiverName', label: '领取人', width: 18 },
    { key: 'showNo', label: '单号', width: 20 },
    { key: 'operatorName', label: '订单操作记录人员', width: 20 },
  ],
  kingdee: [
    { key: 'time', label: '时间', width: 20 },
    { key: 'productName', label: '商品名称', width: 28 },
    { key: 'qty', label: '数量', width: 12, numeric: true },
    { key: 'unitPrice', label: '单价', width: 12, numeric: true },
    { key: 'amount', label: '金额', width: 14, numeric: true },
    { key: 'departmentName', label: '部门', width: 22 },
    { key: 'receiverName', label: '领取人', width: 18 },
    { key: 'hasCustomerOrder', label: '是否有出库单', width: 16 },
    { key: 'isSystemApplied', label: '是否系统申请', width: 16 },
    { key: 'operatorName', label: '订单操作记录人员', width: 20 },
  ],
  walkin: [
    { key: 'time', label: '时间', width: 20 },
    { key: 'productName', label: '商品名称', width: 28 },
    { key: 'qty', label: '数量', width: 12, numeric: true },
    { key: 'unitPrice', label: '单价', width: 12, numeric: true },
    { key: 'amount', label: '金额', width: 14, numeric: true },
    { key: 'receiverName', label: '领取人', width: 18 },
    { key: 'operatorName', label: '订单操作记录人员', width: 20 },
  ],
  'outbound-flow': [
    { key: 'time', label: '时间', width: 20 },
    { key: 'showNo', label: '单号', width: 20 },
    { key: 'orderType', label: '购买类型', width: 14 },
    { key: 'totalQty', label: '总数量', width: 12, numeric: true },
    { key: 'totalAmount', label: '金额', width: 14, numeric: true },
    { key: 'departmentName', label: '部门', width: 22 },
    { key: 'receiverName', label: '领取人', width: 18 },
    { key: 'issuerName', label: '值班人员', width: 18 },
    { key: 'operatorName', label: '操作人员', width: 20 },
    { key: 'hasCustomerOrder', label: '是否有出库单', width: 16 },
    { key: 'isSystemApplied', label: '是否系统申请', width: 16 },
    { key: 'recordStatus', label: '记录状态', width: 14 },
  ],
}

const normalizeText = (value: string | number | null | undefined, fallback = '-'): string => {
  const normalized = String(value ?? '').trim()
  return normalized || fallback
}

const normalizeAmount = (value: string | number | null | undefined): string => {
  const normalized = Number(value ?? 0)
  return Number.isFinite(normalized) ? normalized.toFixed(2) : '0.00'
}

const normalizeNumberText = (value: string | number | null | undefined): string => {
  const normalized = Number(value ?? 0)
  return Number.isFinite(normalized) ? normalized.toFixed(2) : '0.00'
}

const normalizeBoolean = (value: unknown): boolean => {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    return value !== 0
  }
  const normalized = String(value ?? '').trim().toLowerCase()
  return normalized === 'true' || normalized === '1' || normalized === 'yes'
}

const formatDateTime = (value: Date | string): string => {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    return normalizeText(String(value), '-')
  }
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day} ${hour}:${minute}`
}

const parseDateOnly = (value: string, label: string): Date => {
  const normalized = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new BizError(`${label}格式不正确，应为 YYYY-MM-DD`, 400)
  }
  const parsed = new Date(`${normalized}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) {
    throw new BizError(`${label}格式不正确，应为 YYYY-MM-DD`, 400)
  }
  return parsed
}

const getOrderTypeLabel = (value: string | null | undefined): string => {
  return String(value ?? '').trim() === 'department' ? '部门' : '个人'
}

const getFlagLabel = (value: unknown): string => {
  return normalizeBoolean(value) ? '是' : '否'
}

const projectSelectedRow = (row: ReportRow, fields: ReportFieldDefinition[]): ReportRow => {
  const nextRow: ReportRow = {}
  fields.forEach((field) => {
    nextRow[field.key] = row[field.key] ?? ''
  })
  return nextRow
}

export class ReportService {
  async query(type: ReportType, input: ReportQueryInput): Promise<ReportQueryResult> {
    const query = this.resolveQuery(type, input)
    if (type === 'inventory') {
      return this.queryInventory(type, query)
    }
    if (type === 'outbound-flow') {
      return this.queryOutboundFlow(type, query)
    }
    return this.queryOrderItemReport(type, query)
  }

  async exportExcel(type: ReportType, input: ReportQueryInput): Promise<ReportExportResult> {
    const query = this.resolveQuery(type, input)
    const allRowsQuery = {
      ...query,
      page: 1,
      pageSize: Number.MAX_SAFE_INTEGER,
    }
    const result =
      type === 'inventory'
        ? await this.queryInventory(type, allRowsQuery)
        : type === 'outbound-flow'
          ? await this.queryOutboundFlow(type, allRowsQuery)
          : await this.queryOrderItemReport(type, allRowsQuery)

    const workbook = new ExcelJS.Workbook()
    workbook.creator = 'Y-Link'
    workbook.created = new Date()
    const worksheet = workbook.addWorksheet(REPORT_TITLE_MAP[type])
    this.fillWorksheet(worksheet, result.title, result.fields, result.list, input)
    const buffer = await workbook.xlsx.writeBuffer()
    return {
      buffer: Buffer.from(buffer),
      fileName: `report-${type}-${new Date().toISOString().slice(0, 19).replaceAll(/[:T]/g, '-')}.xlsx`,
    }
  }

  getFieldDefinitions(type: ReportType): ReportFieldDefinition[] {
    return REPORT_FIELD_DEFINITIONS[type]
  }

  private resolveQuery(type: ReportType, input: ReportQueryInput): ResolvedReportQuery {
    const page = Math.max(1, Math.floor(Number(input.page || 1)))
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(input.pageSize || 20))))
    const normalizedStartDate = input.startDate?.trim() ?? ''
    const normalizedEndDate = input.endDate?.trim() ?? ''
    if ((normalizedStartDate && !normalizedEndDate) || (!normalizedStartDate && normalizedEndDate)) {
      throw new BizError('请同时提供开始日期与结束日期', 400)
    }

    let startAt: Date | undefined
    let endExclusive: Date | undefined
    if (normalizedStartDate && normalizedEndDate) {
      startAt = parseDateOnly(normalizedStartDate, '开始日期')
      const endAt = parseDateOnly(normalizedEndDate, '结束日期')
      if (startAt.getTime() > endAt.getTime()) {
        throw new BizError('开始日期不能晚于结束日期', 400)
      }
      endExclusive = new Date(endAt.getTime() + DATE_MS)
    }

    return {
      page,
      pageSize,
      startAt,
      endExclusive,
      tagIds: [...new Set((input.tagIds ?? []).map((item) => item.trim()).filter(Boolean))],
      fields: this.resolveFields(type, input.fields),
    }
  }

  private resolveFields(type: ReportType, fields: string[] | undefined): ReportFieldDefinition[] {
    const availableFields = REPORT_FIELD_DEFINITIONS[type]
    const availableFieldMap = new Map(availableFields.map((field) => [field.key, field]))
    if (!fields?.length) {
      return availableFields
    }

    const uniqueFields = [...new Set(fields.map((field) => field.trim()).filter(Boolean))]
    const invalidField = uniqueFields.find((field) => !availableFieldMap.has(field))
    if (invalidField) {
      throw new BizError(`导出字段不允许：${invalidField}`, 400)
    }
    return uniqueFields.map((field) => availableFieldMap.get(field) as ReportFieldDefinition)
  }

  private async queryInventory(type: ReportType, query: ResolvedReportQuery): Promise<ReportQueryResult> {
    const productRepo = AppDataSource.getRepository(BaseProduct)
    const relationRepo = AppDataSource.getRepository(RelProductTag)
    const productIdsByTags = await this.resolveProductIdsByTagIds(query.tagIds)
    if (query.tagIds.length > 0 && productIdsByTags.length === 0) {
      return this.buildResult(type, query, [], 0)
    }

    const qb = productRepo.createQueryBuilder('product')
    if (productIdsByTags.length > 0) {
      qb.andWhere('product.id IN (:...productIds)', { productIds: productIdsByTags })
    }
    const products = await qb.orderBy('product.id', 'DESC').getMany()
    const relations = products.length > 0
      ? await relationRepo.find({
          where: { productId: In(products.map((product) => String(product.id))) },
          relations: { tag: true },
          order: { id: 'ASC' },
        })
      : []
    const tagMap = this.buildProductTagMap(relations)
    const rows = products.map((product) => {
      const tags = tagMap.get(String(product.id)) ?? []
      const currentStock = Number(product.currentStock ?? 0)
      const preOrderedStock = Number(product.preOrderedStock ?? 0)
      return {
        category: tags.length > 0 ? tags.join('、') : '未分类',
        productCode: product.productCode,
        productName: product.productName,
        defaultPrice: normalizeAmount(product.defaultPrice),
        currentStock,
        preOrderedStock,
        availableStock: Math.max(0, currentStock - preOrderedStock),
        status: product.isActive ? '启用' : '停用',
      }
    })

    const pagedRows = rows.slice((query.page - 1) * query.pageSize, query.page * query.pageSize)
    return this.buildResult(type, query, pagedRows, rows.length)
  }

  private async queryOrderItemReport(type: ReportType, query: ResolvedReportQuery): Promise<ReportQueryResult> {
    const productIdsByTags = await this.resolveProductIdsByTagIds(query.tagIds)
    if (query.tagIds.length > 0 && productIdsByTags.length === 0) {
      return this.buildResult(type, query, [], 0)
    }

    const baseQb = AppDataSource.getRepository(BizOutboundOrderItem)
      .createQueryBuilder('item')
      .innerJoin(BizOutboundOrder, 'order', 'order.id = item.orderId')
      .select('order.createdAt', 'createdAt')
      .addSelect('order.showNo', 'showNo')
      .addSelect('order.orderType', 'orderType')
      .addSelect('item.productId', 'productId')
      .addSelect('item.productNameSnapshot', 'productName')
      .addSelect('item.qty', 'qty')
      .addSelect('item.unitPrice', 'unitPrice')
      .addSelect('item.lineAmount', 'amount')
      .addSelect('order.customerDepartmentName', 'departmentName')
      .addSelect('order.customerName', 'receiverName')
      .addSelect('order.hasCustomerOrder', 'hasCustomerOrder')
      .addSelect('order.isSystemApplied', 'isSystemApplied')
      .addSelect('order.creatorDisplayName', 'operatorName')
      .addSelect('order.isDeleted', 'isDeleted')
      .where('order.isDeleted = :isDeleted', { isDeleted: false })

    if (type === 'kingdee') {
      baseQb.andWhere('order.orderType = :orderType', { orderType: 'department' })
    }
    if (type === 'walkin') {
      baseQb.andWhere('order.orderType = :orderType', { orderType: 'walkin' })
    }
    if (query.startAt) {
      baseQb.andWhere('order.createdAt >= :startAt', { startAt: query.startAt })
    }
    if (query.endExclusive) {
      baseQb.andWhere('order.createdAt < :endExclusive', { endExclusive: query.endExclusive })
    }
    if (productIdsByTags.length > 0) {
      baseQb.andWhere('item.productId IN (:...productIds)', { productIds: productIdsByTags })
    }

    const total = await baseQb.clone().getCount()
    const rawRows = await baseQb
      .orderBy('order.createdAt', 'DESC')
      .addOrderBy('order.id', 'DESC')
      .addOrderBy('item.lineNo', 'ASC')
      .skip((query.page - 1) * query.pageSize)
      .take(query.pageSize)
      .getRawMany<OrderItemReportRaw>()
    const tagMap = await this.loadProductTagMap(rawRows.map((row) => String(row.productId ?? '').trim()).filter(Boolean))
    const rows = rawRows.map((row) => this.buildOrderItemReportRow(row, tagMap))
    return this.buildResult(type, query, rows, total)
  }

  private async queryOutboundFlow(type: ReportType, query: ResolvedReportQuery): Promise<ReportQueryResult> {
    const qb = AppDataSource.getRepository(BizOutboundOrder)
      .createQueryBuilder('order')
      .select('order.createdAt', 'createdAt')
      .addSelect('order.showNo', 'showNo')
      .addSelect('order.orderType', 'orderType')
      .addSelect('order.totalAmount', 'totalAmount')
      .addSelect('order.totalQty', 'totalQty')
      .addSelect('order.customerDepartmentName', 'departmentName')
      .addSelect('order.customerName', 'receiverName')
      .addSelect('order.issuerName', 'issuerName')
      .addSelect('order.creatorDisplayName', 'operatorName')
      .addSelect('order.hasCustomerOrder', 'hasCustomerOrder')
      .addSelect('order.isSystemApplied', 'isSystemApplied')
      .addSelect('order.isDeleted', 'isDeleted')
      .where('1=1')

    if (query.startAt) {
      qb.andWhere('order.createdAt >= :startAt', { startAt: query.startAt })
    }
    if (query.endExclusive) {
      qb.andWhere('order.createdAt < :endExclusive', { endExclusive: query.endExclusive })
    }

    const total = await qb.clone().getCount()
    const rawRows = await qb
      .orderBy('order.createdAt', 'DESC')
      .addOrderBy('order.id', 'DESC')
      .skip((query.page - 1) * query.pageSize)
      .take(query.pageSize)
      .getRawMany<OutboundFlowRaw>()
    const rows = rawRows.map((row) => ({
      time: formatDateTime(row.createdAt),
      showNo: normalizeText(row.showNo),
      orderType: getOrderTypeLabel(row.orderType),
      totalQty: normalizeNumberText(row.totalQty),
      totalAmount: normalizeAmount(row.totalAmount),
      departmentName: row.orderType === 'department' ? normalizeText(row.departmentName) : '不适用',
      receiverName: normalizeText(row.receiverName),
      issuerName: normalizeText(row.issuerName),
      operatorName: normalizeText(row.operatorName),
      hasCustomerOrder: row.orderType === 'department' ? getFlagLabel(row.hasCustomerOrder) : '不适用',
      isSystemApplied: row.orderType === 'department' ? getFlagLabel(row.isSystemApplied) : '不适用',
      recordStatus: normalizeBoolean(row.isDeleted) ? '已删除' : '正常',
    }))
    return this.buildResult(type, query, rows, total)
  }

  private buildOrderItemReportRow(raw: OrderItemReportRaw, tagMap: Map<string, string[]>): ReportRow {
    const productId = String(raw.productId ?? '').trim()
    const orderType = String(raw.orderType ?? '').trim()
    return {
      time: formatDateTime(raw.createdAt),
      tags: (tagMap.get(productId) ?? []).join('、') || '未分类',
      productName: normalizeText(raw.productName),
      qty: normalizeNumberText(raw.qty),
      unitPrice: normalizeAmount(raw.unitPrice),
      amount: normalizeAmount(raw.amount),
      departmentName: orderType === 'department' ? normalizeText(raw.departmentName) : '不适用',
      receiverName: normalizeText(raw.receiverName),
      showNo: normalizeText(raw.showNo),
      hasCustomerOrder: orderType === 'department' ? getFlagLabel(raw.hasCustomerOrder) : '不适用',
      isSystemApplied: orderType === 'department' ? getFlagLabel(raw.isSystemApplied) : '不适用',
      operatorName: normalizeText(raw.operatorName),
    }
  }

  private buildResult(type: ReportType, query: ResolvedReportQuery, rows: ReportRow[], total: number): ReportQueryResult {
    return {
      type,
      title: REPORT_TITLE_MAP[type],
      page: query.page,
      pageSize: query.pageSize,
      total,
      fields: query.fields,
      availableFields: this.getFieldDefinitions(type),
      list: rows.map((row) => projectSelectedRow(row, query.fields)),
    }
  }

  private async resolveProductIdsByTagIds(tagIds: string[]): Promise<string[]> {
    if (!tagIds.length) {
      return []
    }
    const relations = await AppDataSource.getRepository(RelProductTag).find({
      where: { tagId: In(tagIds) },
      select: ['productId'],
    })
    return [...new Set(relations.map((relation) => String(relation.productId)).filter(Boolean))]
  }

  private async loadProductTagMap(productIds: string[]): Promise<Map<string, string[]>> {
    const uniqueProductIds = [...new Set(productIds)]
    if (!uniqueProductIds.length) {
      return new Map()
    }
    const relations = await AppDataSource.getRepository(RelProductTag).find({
      where: { productId: In(uniqueProductIds) },
      relations: { tag: true },
      order: { id: 'ASC' },
    })
    return this.buildProductTagMap(relations)
  }

  private buildProductTagMap(relations: RelProductTag[]): Map<string, string[]> {
    const tagMap = new Map<string, string[]>()
    relations.forEach((relation) => {
      const productId = String(relation.productId).trim()
      const tagName = relation.tag?.tagName?.trim()
      if (!productId || !tagName) {
        return
      }
      const currentTags = tagMap.get(productId) ?? []
      currentTags.push(tagName)
      tagMap.set(productId, currentTags)
    })
    return tagMap
  }

  private fillWorksheet(
    worksheet: ExcelJS.Worksheet,
    title: string,
    fields: ReportFieldDefinition[],
    rows: ReportRow[],
    query: ReportQueryInput,
  ) {
    const columnCount = Math.max(fields.length, 1)
    worksheet.mergeCells(1, 1, 1, columnCount)
    worksheet.getCell(1, 1).value = title
    worksheet.getCell(1, 1).font = { bold: true, size: 16, color: { argb: 'FF0F172A' } }
    worksheet.getCell(1, 1).alignment = { vertical: 'middle', horizontal: 'center' }
    worksheet.getRow(1).height = 28

    worksheet.mergeCells(2, 1, 2, columnCount)
    const rangeText = query.startDate && query.endDate ? `${query.startDate} 至 ${query.endDate}` : '全部时间'
    worksheet.getCell(2, 1).value = `筛选条件：${rangeText}`
    worksheet.getCell(2, 1).font = { color: { argb: 'FF475569' } }
    worksheet.mergeCells(3, 1, 3, columnCount)
    worksheet.getCell(3, 1).value = `导出时间：${formatDateTime(new Date())}`
    worksheet.getCell(3, 1).font = { color: { argb: 'FF64748B' } }

    worksheet.columns = fields.map((field) => ({
      key: field.key,
      width: field.width,
    }))
    const headerRow = worksheet.getRow(5)
    fields.forEach((field, index) => {
      const cell = headerRow.getCell(index + 1)
      cell.value = field.label
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F766E' } }
      cell.alignment = { vertical: 'middle', horizontal: 'center' }
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      }
    })

    rows.forEach((row) => {
      const values = fields.map((field) => row[field.key] ?? '')
      const nextRow = worksheet.addRow(values)
      fields.forEach((field, index) => {
        const cell = nextRow.getCell(index + 1)
        cell.alignment = { vertical: 'middle', horizontal: field.numeric ? 'right' : 'left' }
        cell.border = {
          bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        }
      })
    })

    worksheet.views = [{ state: 'frozen', ySplit: 5 }]
    worksheet.autoFilter = {
      from: { row: 5, column: 1 },
      to: { row: Math.max(5, rows.length + 5), column: columnCount },
    }
  }
}

export const reportService = new ReportService()
