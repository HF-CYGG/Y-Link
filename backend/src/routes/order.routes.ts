import { Router } from 'express'
import { z } from 'zod'
import { requirePermission } from '../middleware/auth.middleware.js'
import { orderService } from '../services/order.service.js'
import type { AuthenticatedRequest } from '../types/auth.js'
import { asyncHandler } from '../utils/async-handler.js'
import { extractRequestMeta } from '../utils/request-meta.js'

const submitOrderSchema = z.object({
  idempotencyKey: z.string().min(8, 'idempotencyKey 长度至少为 8'),
  customerName: z.string().optional(),
  remark: z.string().optional(),
  items: z
    .array(
      z.object({
        productId: z.union([z.string().min(1), z.number()]),
        qty: z.number().positive(),
        unitPrice: z.number().positive('单价必须大于 0'),
        remark: z.string().optional(),
      }),
    )
    .min(1, '至少一条明细'),
})

const deleteOrderSchema = z.object({
  confirmShowNo: z.string().trim().min(1, '请填写业务单号完成二次确认'),
})

export const orderRouter = Router()

orderRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const page = Number(req.query.page ?? 1)
    const pageSize = Number(req.query.pageSize ?? 20)
    const showNo = typeof req.query.showNo === 'string' ? req.query.showNo : undefined
    const startDate = typeof req.query.startDate === 'string' ? req.query.startDate : undefined
    const endDate = typeof req.query.endDate === 'string' ? req.query.endDate : undefined
    const includeDeleted = req.query.includeDeleted === 'true'
    const onlyDeleted = req.query.onlyDeleted === 'true'

    const data = await orderService.list({
      page: Number.isFinite(page) && page > 0 ? page : 1,
      pageSize: Number.isFinite(pageSize) && pageSize > 0 ? Math.min(pageSize, 100) : 20,
      showNo,
      startDate,
      endDate,
      includeDeleted,
      onlyDeleted,
    })

    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

orderRouter.get(
  '/show-no/:showNo',
  asyncHandler(async (req, res) => {
    const data = await orderService.detailByShowNo(req.params.showNo)
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

orderRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const data = await orderService.detailById(req.params.id)
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

orderRouter.post(
  '/submit',
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = submitOrderSchema.parse(req.body)
    const data = await orderService.submit(payload, authReq.auth, extractRequestMeta(req))
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

orderRouter.delete(
  '/:id',
  requirePermission('orders:delete'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = deleteOrderSchema.parse(req.body ?? {})
    const data = await orderService.softDeleteById(req.params.id, authReq.auth, payload.confirmShowNo, extractRequestMeta(req))
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

orderRouter.post(
  '/:id/restore',
  requirePermission('orders:delete'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const data = await orderService.restoreById(req.params.id, authReq.auth, extractRequestMeta(req))
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)
