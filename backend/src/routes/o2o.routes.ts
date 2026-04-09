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

export const o2oRouter = Router()

o2oRouter.get(
  '/mall/products',
  asyncHandler(async (_req, res) => {
    const data = await o2oPreorderService.listMallProducts()
    res.json({ code: 0, message: 'ok', data })
  }),
)

o2oRouter.post(
  '/mall/preorders',
  requireClientAuth,
  asyncHandler(async (req, res) => {
    const authReq = req as ClientAuthenticatedRequest
    const data = await o2oPreorderService.submit(authReq.clientAuth, submitPreorderSchema.parse(req.body))
    res.json({ code: 0, message: 'ok', data })
  }),
)

o2oRouter.get(
  '/mall/preorders',
  requireClientAuth,
  asyncHandler(async (req, res) => {
    const authReq = req as ClientAuthenticatedRequest
    const data = await o2oPreorderService.listMyOrders(authReq.clientAuth)
    res.json({ code: 0, message: 'ok', data })
  }),
)

o2oRouter.get(
  '/mall/preorders/:id',
  requireClientAuth,
  asyncHandler(async (req, res) => {
    const data = await o2oPreorderService.detailById(req.params.id)
    res.json({ code: 0, message: 'ok', data })
  }),
)

o2oRouter.get(
  '/verify/:verifyCode',
  requireAuth,
  requirePermission('orders:view'),
  asyncHandler(async (req, res) => {
    const data = await o2oPreorderService.getVerifyDetail(req.params.verifyCode)
    res.json({ code: 0, message: 'ok', data })
  }),
)

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

o2oRouter.post(
  '/cron/cancel-timeout',
  requireAuth,
  requirePermission('system_configs:update'),
  asyncHandler(async (_req, res) => {
    const data = await o2oPreorderService.cancelTimeoutOrders()
    res.json({ code: 0, message: 'ok', data })
  }),
)

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
