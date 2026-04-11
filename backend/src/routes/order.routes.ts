/**
 * 模块说明：backend/src/routes/order.routes.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { Router } from 'express'
import { z } from 'zod'
import { requirePermission } from '../middleware/auth.middleware.js'
import { orderService } from '../services/order.service.js'
import type { AuthenticatedRequest } from '../types/auth.js'
import { asyncHandler } from '../utils/async-handler.js'
import { BizError } from '../utils/errors.js'
import { extractRequestMeta } from '../utils/request-meta.js'

const submitOrderSchema = z.object({
  idempotencyKey: z.string().min(8, 'idempotencyKey 长度至少为 8'),
  orderType: z.enum(['department', 'walkin']).optional(),
  hasCustomerOrder: z.boolean().optional(),
  isSystemApplied: z.boolean().optional(),
  issuerName: z.string().max(64, '出单人长度不能超过64').optional(),
  customerDepartmentName: z.string().max(128, '客户部门名称长度不能超过128').optional(),
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

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
export const orderRouter = Router()

orderRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const page = Number(req.query.page ?? 1)
    const pageSize = Number(req.query.pageSize ?? 20)
    const keyword = typeof req.query.keyword === 'string' ? req.query.keyword : undefined
    const showNo = typeof req.query.showNo === 'string' ? req.query.showNo : undefined
    const orderType = typeof req.query.orderType === 'string' ? req.query.orderType : undefined
    const startDate = typeof req.query.startDate === 'string' ? req.query.startDate : undefined
    const endDate = typeof req.query.endDate === 'string' ? req.query.endDate : undefined
    const includeDeleted = req.query.includeDeleted === 'true'
    const onlyDeleted = req.query.onlyDeleted === 'true'

    const data = await orderService.list({
      page: Number.isFinite(page) && page > 0 ? page : 1,
      pageSize: Number.isFinite(pageSize) && pageSize > 0 ? Math.min(pageSize, 100) : 20,
      keyword,
      showNo,
      orderType,
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
    const payloadRaw = req.body as Record<string, unknown> | null | undefined
    if (payloadRaw && typeof payloadRaw === 'object' && ('showNo' in payloadRaw || 'orderNo' in payloadRaw)) {
      throw new BizError('禁止指定业务单号，请由系统自动生成', 400)
    }
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
