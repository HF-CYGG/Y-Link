/**
 * 模块说明：backend/src/routes/inbound.routes.ts
 * 文件职责：定义送货单提交、详情查询与核销入库接口，并在路由层收口权限与参数校验。
 * 维护说明：新增入库接口时请保持路由权限、服务层角色兜底与响应结构一致。
 */

import { Router } from 'express'
import { z } from 'zod'
import { requirePermission, requireRole } from '../middleware/auth.middleware.js'
import { inboundService } from '../services/inbound.service.js'
import { asyncHandler } from '../utils/async-handler.js'
import type { AuthenticatedRequest } from '../types/auth.js'

export const inboundRouter = Router()

// ----------------------------------------------------------------------
// 供货方接口
// ----------------------------------------------------------------------

// 供货方：提交送货单
const submitInboundSchema = z.object({
  remark: z.string().max(255).optional(),
  items: z.array(
    z.object({
      productId: z.string().min(1),
      qty: z.number().int().positive(),
    }),
  ).min(1, '至少选择一个商品'),
})

inboundRouter.post(
  '/supplier/submit',
  requirePermission('inbound:create'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const input = submitInboundSchema.parse(req.body)
    const result = await inboundService.submitSupplierDelivery(authReq.auth, input)
    res.json({
      code: 0,
      message: 'ok',
      data: result,
    })
  }),
)

// 供货方：查看历史送货单
inboundRouter.get(
  '/supplier/list',
  requirePermission('inbound:view'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const result = await inboundService.listSupplierDeliveries(authReq.auth)
    res.json({
      code: 0,
      message: 'ok',
      data: result,
    })
  }),
)

// 供货方/管理端：通过 showNo 查看详情（人工输入单号时兜底）
inboundRouter.get(
  '/detail/show-no/:showNo',
  requirePermission('inbound:view'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    // 服务层二次兜底：supplier 仅可查询本人单据，防止参数探测导致越权读取。
    const result = await inboundService.detailByShowNo(req.params.showNo, authReq.auth)
    res.json({
      code: 0,
      message: 'ok',
      data: result,
    })
  }),
)

// 供货方/管理端：通过 verifyCode 查看详情 (扫码后查询或供货方自己查看二维码详情)
inboundRouter.get(
  '/detail/:verifyCode',
  requirePermission('inbound:view'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    // 即使具备 inbound:view，也需在服务层按角色做可见范围控制。
    const result = await inboundService.detailByVerifyCode(req.params.verifyCode, authReq.auth)
    res.json({
      code: 0,
      message: 'ok',
      data: result,
    })
  }),
)

// ----------------------------------------------------------------------
// 库管员接口
// ----------------------------------------------------------------------

// 库管员：核销入库
inboundRouter.post(
  '/admin/verify',
  requirePermission('inbound:verify'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const input = z.object({ verifyCode: z.string().min(1) }).parse(req.body)
    const result = await inboundService.verifyInbound(input.verifyCode, authReq.auth)
    res.json({
      code: 0,
      message: '核销入库成功',
      data: result,
    })
  }),
)

// 库管员：查看所有送货单/入库单
inboundRouter.get(
  '/admin/list',
  requirePermission('inbound:view'),
  // admin/list 明确禁止 supplier 角色访问，避免“同权限不同职责”造成横向越权。
  requireRole('admin', 'operator'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const status = typeof req.query.status === 'string' ? req.query.status : undefined
    const limit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 50
    // 服务层会继续按角色收口数据范围，这里传入 actor 用于二次校验。
    const result = await inboundService.listAllInboundOrders(authReq.auth, { status, limit })
    res.json({
      code: 0,
      message: 'ok',
      data: result,
    })
  }),
)
