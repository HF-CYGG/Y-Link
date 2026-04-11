/**
 * 模块说明：backend/src/routes/o2o.routes.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { Router } from 'express'
import { z } from 'zod'
import { requireClientAuth } from '../middleware/client-auth.middleware.js'
import { requireAuth, requirePermission } from '../middleware/auth.middleware.js'
import type { AuthenticatedRequest } from '../types/auth.js'
import type { ClientAuthenticatedRequest } from '../types/client-auth.js'
import { asyncHandler } from '../utils/async-handler.js'
import { o2oPreorderService } from '../services/o2o-preorder.service.js'

const submitPreorderSchema = z.object({
  remark: z.string().max(255).optional(),
  items: z.array(z.object({ productId: z.union([z.string(), z.number()]), qty: z.number().int().positive() })).min(1),
})

const inboundSchema = z.object({
  productId: z.string().trim().min(1),
  qty: z.number().int().positive(),
  remark: z.string().max(255).optional(),
})

const verifySchema = z.object({
  verifyCode: z.string().trim().min(1),
})

const consoleOrderQuerySchema = z.object({
  status: z.enum(['pending', 'verified', 'cancelled']).optional(),
  keyword: z.string().trim().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

export const o2oRouter = Router()

// 商城商品列表：客户端免登录可访问，用于展示当前上架商品与可预订库存。
o2oRouter.get(
  '/mall/products',
  asyncHandler(async (_req, res) => {
    const data = await o2oPreorderService.listMallProducts()
    res.json({ code: 0, message: 'ok', data })
  }),
)

// 提交预订单：必须走客户端独立鉴权，避免与后台管理鉴权体系混用。
o2oRouter.post(
  '/mall/preorders',
  requireClientAuth,
  asyncHandler(async (req, res) => {
    const authReq = req as ClientAuthenticatedRequest
    const data = await o2oPreorderService.submit(authReq.clientAuth, submitPreorderSchema.parse(req.body))
    res.json({ code: 0, message: 'ok', data })
  }),
)

// 我的订单列表：只返回当前客户端用户自己的预订单。
o2oRouter.get(
  '/mall/preorders',
  requireClientAuth,
  asyncHandler(async (req, res) => {
    const authReq = req as ClientAuthenticatedRequest
    const data = await o2oPreorderService.listMyOrders(authReq.clientAuth)
    res.json({ code: 0, message: 'ok', data })
  }),
)

// 订单详情：客户端查看自己的核销码、商品明细与状态。
o2oRouter.get(
  '/mall/preorders/:id',
  requireClientAuth,
  asyncHandler(async (req, res) => {
    const data = await o2oPreorderService.detailById(req.params.id)
    res.json({ code: 0, message: 'ok', data })
  }),
)

// 管理端扫码前可先读取核销详情，便于展示订单内容与状态确认。
o2oRouter.get(
  '/verify/show-no/:showNo',
  requireAuth,
  requirePermission('orders:view'),
  asyncHandler(async (req, res) => {
    const data = await o2oPreorderService.getVerifyDetailByShowNo(req.params.showNo)
    res.json({ code: 0, message: 'ok', data })
  }),
)

// 管理端订单查询：支持按状态分类与关键字查询，供“订单查询”页面展示。
o2oRouter.get(
  '/orders',
  requireAuth,
  requirePermission('orders:view'),
  asyncHandler(async (req, res) => {
    const query = consoleOrderQuerySchema.parse(req.query)
    const data = await o2oPreorderService.listConsoleOrders(query)
    res.json({ code: 0, message: 'ok', data })
  }),
)

// 管理端订单详情：用于查询页右侧展示订单状态报告与进度。
o2oRouter.get(
  '/orders/:id',
  requireAuth,
  requirePermission('orders:view'),
  asyncHandler(async (req, res) => {
    const data = await o2oPreorderService.detailById(req.params.id)
    res.json({ code: 0, message: 'ok', data })
  }),
)

// 管理端扫码前可先读取核销详情，便于展示订单内容与状态确认。
o2oRouter.get(
  '/verify/:verifyCode',
  requireAuth,
  requirePermission('orders:view'),
  asyncHandler(async (req, res) => {
    const data = await o2oPreorderService.getVerifyDetail(req.params.verifyCode)
    res.json({ code: 0, message: 'ok', data })
  }),
)

// 核销动作属于后台“出库确认”，因此要求后台登录 + 订单创建权限。
o2oRouter.post(
  '/verify',
  requireAuth,
  requirePermission('orders:create'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = verifySchema.parse(req.body)
    const data = await o2oPreorderService.verifyByCode(payload.verifyCode, authReq.auth)
    res.json({ code: 0, message: 'ok', data })
  }),
)

// 入库动作由后台工作人员执行，用于补货与库存修正。
o2oRouter.post(
  '/inbound',
  requireAuth,
  requirePermission('products:manage'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = inboundSchema.parse(req.body)
    const data = await o2oPreorderService.inboundStock(payload.productId, payload.qty, authReq.auth, payload.remark)
    res.json({ code: 0, message: 'ok', data })
  }),
)

// 超时取消入口保留给后台或定时任务触发，统一回收超时订单的预订占用库存。
o2oRouter.post(
  '/cron/cancel-timeout',
  requireAuth,
  requirePermission('system_configs:update'),
  asyncHandler(async (_req, res) => {
    const data = await o2oPreorderService.cancelTimeoutOrders()
    res.json({ code: 0, message: 'ok', data })
  }),
)

// 库存日志用于后台追踪预订占用、核销出库、手工入库与超时释放等变化记录。
o2oRouter.get(
  '/inventory/logs',
  requireAuth,
  requirePermission('orders:view'),
  asyncHandler(async (req, res) => {
    const limit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 100
    const data = await o2oPreorderService.listInventoryLogs(limit)
    res.json({ code: 0, message: 'ok', data })
  }),
)
