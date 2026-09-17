/**
 * 文件说明：库存管理路由，涵盖分类与库位主数据、当前库存、库存流水、库存单据与盘点单。
 * 实现逻辑：路由层只做参数校验与权限拦截，业务规则与记账全部在对应服务中完成。
 * 维护重点：
 * - 读取接口需要 inventory:view / stocktake:view，写入需要 inventory:operate、inventory:void 或 stocktake:*；
 * - 盲盘单的账面数由服务层按 stocktake:approve 裁剪，路由不得额外返回库存字段。
 */

import { Router, type Response } from 'express'
import { z } from 'zod'
import { requireAnyPermission, requirePermission } from '../middleware/auth.middleware.js'
import { inventoryDocService } from '../services/inventory-doc.service.js'
import { inventoryMasterDataService } from '../services/inventory-master-data.service.js'
import { inventoryQueryService } from '../services/inventory-query.service.js'
import { stocktakeService } from '../services/stocktake.service.js'
import { asyncHandler } from '../utils/async-handler.js'
import { BizError } from '../utils/errors.js'
import { extractRequestMeta } from '../utils/request-meta.js'
import type { AuthenticatedRequest } from '../types/auth.js'

const idSchema = z.union([z.string().trim().min(1).max(32), z.number().int().positive()])
const optionalText = (max: number) => z.string().max(max).nullable().optional()

const categorySchema = z.object({
  categoryCode: z.string().trim().max(2).optional(),
  categoryName: z.string().trim().max(64).optional(),
  sortOrder: z.number().int().min(0).max(999999).optional(),
  isActive: z.boolean().optional(),
})

const locationSchema = z.object({
  locationCode: z.string().trim().max(32).optional(),
  locationName: optionalText(64),
  remark: optionalText(255),
  isActive: z.boolean().optional(),
})

const stockDocSchema = z.object({
  docType: z.string().trim().min(1).max(16),
  clientRequestId: z.string().trim().max(64).nullable().optional(),
  reasonCode: z.string().trim().max(32).nullable().optional(),
  remark: optionalText(255),
  items: z.array(z.object({ skuId: idSchema, qty: z.number().int() })).min(1, '请至少扫描一个商品').max(200),
})

const createStocktakeSchema = z.object({
  scopeType: z.enum(['all', 'category', 'location', 'sku']),
  categoryIds: z.array(idSchema).max(200).optional(),
  locationIds: z.array(idSchema).max(500).optional(),
  skuIds: z.array(idSchema).max(5000).optional(),
  blindMode: z.boolean().optional(),
  remark: optionalText(255),
})

const countSchema = z.object({
  skuId: idSchema,
  qty: z.number().int().nullable().optional(),
  mode: z.enum(['set', 'add', 'clear']),
})

const resolveSchema = z.object({
  diffReason: z.string().trim().max(32).nullable().optional(),
  resolution: z.string().trim().max(16).nullable().optional(),
  remark: optionalText(255),
})

const readString = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)
const readNumber = (value: unknown) => {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}
const readDate = (value: unknown) => {
  const text = readString(value)
  if (!text) return undefined
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new BizError('日期格式应为 YYYY-MM-DD', 400)
  return text
}

const buildLogQuery = (query: Record<string, unknown>) => ({
  page: readNumber(query.page),
  pageSize: readNumber(query.pageSize),
  keyword: readString(query.keyword),
  changeTypes: readString(query.changeTypes)?.split(',').slice(0, 30),
  skuId: readString(query.skuId),
  productId: readString(query.productId),
  refType: readString(query.refType),
  refId: readString(query.refId),
  startDate: readDate(query.startDate),
  endDate: readDate(query.endDate),
})

const ok = (res: Response, data: unknown) => res.json({ code: 0, message: 'ok', data })

export const inventoryRouter = Router()

// ---- 分类与库位 ----
inventoryRouter.get('/categories', requireAnyPermission('products:view', 'inventory:view', 'stocktake:view'), asyncHandler(async (_req, res) => {
  ok(res, await inventoryMasterDataService.listCategories())
}))

inventoryRouter.post('/categories', requirePermission('products:manage'), asyncHandler(async (req, res) => {
  const authReq = req as AuthenticatedRequest
  ok(res, await inventoryMasterDataService.createCategory(categorySchema.parse(req.body), authReq.auth, extractRequestMeta(req)))
}))

inventoryRouter.put('/categories/:id', requirePermission('products:manage'), asyncHandler(async (req, res) => {
  const authReq = req as AuthenticatedRequest
  ok(res, await inventoryMasterDataService.updateCategory(req.params.id, categorySchema.parse(req.body), authReq.auth, extractRequestMeta(req)))
}))

inventoryRouter.get('/locations', requireAnyPermission('products:view', 'inventory:view', 'stocktake:view'), asyncHandler(async (_req, res) => {
  ok(res, await inventoryMasterDataService.listLocations())
}))

inventoryRouter.post('/locations', requirePermission('products:manage'), asyncHandler(async (req, res) => {
  const authReq = req as AuthenticatedRequest
  ok(res, await inventoryMasterDataService.createLocation(locationSchema.parse(req.body), authReq.auth, extractRequestMeta(req)))
}))

inventoryRouter.put('/locations/:id', requirePermission('products:manage'), asyncHandler(async (req, res) => {
  const authReq = req as AuthenticatedRequest
  ok(res, await inventoryMasterDataService.updateLocation(req.params.id, locationSchema.parse(req.body), authReq.auth, extractRequestMeta(req)))
}))

// ---- 当前库存与流水 ----
inventoryRouter.get('/stocks', requirePermission('inventory:view'), asyncHandler(async (req, res) => {
  const query = req.query as Record<string, unknown>
  const data = await inventoryQueryService.listStocks({
    page: readNumber(query.page),
    pageSize: readNumber(query.pageSize),
    keyword: readString(query.keyword),
    categoryId: readString(query.categoryId),
    locationId: readString(query.locationId),
    maxStock: readNumber(query.maxStock),
    includeInactive: query.includeInactive === 'true' || query.includeInactive === '1',
  })
  // 成本价与商品接口同一口径：只有具备商品维护权限的账号可见。
  const canViewCostPrice = (req as AuthenticatedRequest).auth.permissions.includes('products:manage')
  ok(res, canViewCostPrice ? data : { ...data, list: data.list.map((row) => ({ ...row, costPrice: null })) })
}))

inventoryRouter.get('/logs', requirePermission('inventory:view'), asyncHandler(async (req, res) => {
  ok(res, await inventoryQueryService.listLogs(buildLogQuery(req.query as Record<string, unknown>)))
}))

inventoryRouter.get('/logs/export', requirePermission('inventory:view'), asyncHandler(async (req, res) => {
  const buffer = await inventoryQueryService.exportLogs(buildLogQuery(req.query as Record<string, unknown>))
  const fileName = `inventory-logs-${new Date().toISOString().slice(0, 19).replaceAll(/[:T]/g, '-')}.xlsx`
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
  res.send(buffer)
}))

// ---- 库存单据 ----
inventoryRouter.get('/docs', requirePermission('inventory:view'), asyncHandler(async (req, res) => {
  const query = req.query as Record<string, unknown>
  ok(res, await inventoryDocService.list({
    page: readNumber(query.page),
    pageSize: readNumber(query.pageSize),
    docType: readString(query.docType),
    status: readString(query.status),
    keyword: readString(query.keyword),
    startDate: readDate(query.startDate),
    endDate: readDate(query.endDate),
  }))
}))

inventoryRouter.get('/docs/:id', requirePermission('inventory:view'), asyncHandler(async (req, res) => {
  ok(res, await inventoryDocService.detail(req.params.id))
}))

inventoryRouter.post('/docs', requirePermission('inventory:operate'), asyncHandler(async (req, res) => {
  const authReq = req as AuthenticatedRequest
  ok(res, await inventoryDocService.create(stockDocSchema.parse(req.body), authReq.auth, extractRequestMeta(req)))
}))

inventoryRouter.post('/docs/:id/void', requirePermission('inventory:void'), asyncHandler(async (req, res) => {
  const authReq = req as AuthenticatedRequest
  const payload = z.object({ reason: z.string().max(255) }).parse(req.body)
  ok(res, await inventoryDocService.voidDoc(req.params.id, payload.reason, authReq.auth, extractRequestMeta(req)))
}))

// ---- 盘点 ----
inventoryRouter.get('/stocktakes', requirePermission('stocktake:view'), asyncHandler(async (req, res) => {
  const authReq = req as AuthenticatedRequest
  const query = req.query as Record<string, unknown>
  ok(res, await stocktakeService.list({
    page: readNumber(query.page),
    pageSize: readNumber(query.pageSize),
    status: readString(query.status),
    keyword: readString(query.keyword),
  }, authReq.auth))
}))

inventoryRouter.post('/stocktakes', requirePermission('stocktake:count'), asyncHandler(async (req, res) => {
  const authReq = req as AuthenticatedRequest
  ok(res, await stocktakeService.create(createStocktakeSchema.parse(req.body), authReq.auth, extractRequestMeta(req)))
}))

inventoryRouter.get('/stocktakes/:id', requirePermission('stocktake:view'), asyncHandler(async (req, res) => {
  const authReq = req as AuthenticatedRequest
  ok(res, await stocktakeService.detail(req.params.id, authReq.auth))
}))

inventoryRouter.get('/stocktakes/:id/items', requirePermission('stocktake:view'), asyncHandler(async (req, res) => {
  const authReq = req as AuthenticatedRequest
  const query = req.query as Record<string, unknown>
  const filter = readString(query.filter)
  ok(res, await stocktakeService.listItems(req.params.id, {
    page: readNumber(query.page),
    pageSize: readNumber(query.pageSize),
    keyword: readString(query.keyword),
    filter: filter === 'counted' || filter === 'uncounted' || filter === 'diff' ? filter : 'all',
  }, authReq.auth))
}))

inventoryRouter.post('/stocktakes/:id/count', requirePermission('stocktake:count'), asyncHandler(async (req, res) => {
  const authReq = req as AuthenticatedRequest
  ok(res, await stocktakeService.count(req.params.id, countSchema.parse(req.body), authReq.auth))
}))

inventoryRouter.post('/stocktakes/:id/submit', requirePermission('stocktake:count'), asyncHandler(async (req, res) => {
  const authReq = req as AuthenticatedRequest
  const payload = z.object({ treatUncountedAsZero: z.boolean().optional() }).parse(req.body ?? {})
  ok(res, await stocktakeService.submit(req.params.id, payload, authReq.auth, extractRequestMeta(req)))
}))

inventoryRouter.post('/stocktakes/:id/reopen', requirePermission('stocktake:approve'), asyncHandler(async (req, res) => {
  const authReq = req as AuthenticatedRequest
  ok(res, await stocktakeService.reopen(req.params.id, authReq.auth, extractRequestMeta(req)))
}))

inventoryRouter.put('/stocktakes/:id/items/:itemId/resolution', requirePermission('stocktake:approve'), asyncHandler(async (req, res) => {
  const authReq = req as AuthenticatedRequest
  ok(res, await stocktakeService.resolveItem(req.params.id, req.params.itemId, resolveSchema.parse(req.body), authReq.auth, extractRequestMeta(req)))
}))

inventoryRouter.post('/stocktakes/:id/complete', requirePermission('stocktake:approve'), asyncHandler(async (req, res) => {
  const authReq = req as AuthenticatedRequest
  ok(res, await stocktakeService.complete(req.params.id, authReq.auth, extractRequestMeta(req)))
}))

inventoryRouter.post('/stocktakes/:id/cancel', requirePermission('stocktake:approve'), asyncHandler(async (req, res) => {
  const authReq = req as AuthenticatedRequest
  ok(res, await stocktakeService.cancel(req.params.id, authReq.auth, extractRequestMeta(req)))
}))
