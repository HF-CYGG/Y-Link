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
import { auditService } from '../services/audit.service.js'
import { asyncHandler } from '../utils/async-handler.js'
import {
  O2O_MERCHANT_MESSAGE_MAX_LENGTH,
  O2O_RETURN_REASON_MAX_LENGTH,
  o2oPreorderService,
} from '../services/o2o-preorder.service.js'
import { extractRequestMeta } from '../utils/request-meta.js'

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

const myOrderQuerySchema = z.object({
  status: z.enum(['pending', 'verified', 'cancelled']).optional(),
  keyword: z.string().trim().max(64).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(50).optional(),
})

const consoleOrderQuerySchema = z.object({
  status: z.enum(['pending', 'verified', 'cancelled']).optional(),
  keyword: z.string().trim().max(64).optional(),
  startTime: z.string().trim().max(32).optional(),
  endTime: z.string().trim().max(32).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

const businessStatusSchema = z.object({
  businessStatus: z
    .enum([
      'preparing',
      'ready',
      'awaiting_shipment',
      'shipped',
      'partially_shipped',
      'closed',
      'after_sale',
      'after_sale_done',
      'verifying',
      'verify_failed',
    ])
    .nullable(),
})

const merchantMessageSchema = z.object({
  merchantMessage: z.string().trim().max(O2O_MERCHANT_MESSAGE_MAX_LENGTH).nullable(),
})

const submitReturnRequestSchema = z.object({
  reason: z.string().trim().min(1).max(O2O_RETURN_REASON_MAX_LENGTH),
  items: z.array(z.object({ productId: z.union([z.string(), z.number()]), qty: z.number().int().positive() })).min(1),
})

const BUSINESS_STATUS_LABEL_MAP = {
  preparing: '备货中（已接单）',
  ready: '请取货（等待取货）',
  awaiting_shipment: '待发货（等待接单）',
  shipped: '已发货',
  partially_shipped: '部分发货',
  closed: '已关闭',
  after_sale: '其他（售后）',
  after_sale_done: '售后完成',
  verifying: '核销中',
  verify_failed: '核销失败',
} as const

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
    const query = myOrderQuerySchema.parse(req.query)
    const data = await o2oPreorderService.listMyOrders(authReq.clientAuth, query)
    res.json({ code: 0, message: 'ok', data })
  }),
)

// 订单详情：客户端查看自己的核销码、商品明细与状态。
o2oRouter.get(
  '/mall/preorders/:id',
  requireClientAuth,
  asyncHandler(async (req, res) => {
    const authReq = req as ClientAuthenticatedRequest
    const data = await o2oPreorderService.getMyOrderDetail(authReq.clientAuth, req.params.id)
    res.json({ code: 0, message: 'ok', data })
  }),
)

// 客户端主动撤回待核销订单：仅允许撤回本人订单，并在事务内释放预订库存。
o2oRouter.post(
  '/mall/preorders/:id/cancel',
  requireClientAuth,
  asyncHandler(async (req, res) => {
    const authReq = req as ClientAuthenticatedRequest
    const data = await o2oPreorderService.cancelMyOrder(authReq.clientAuth, req.params.id)
    res.json({ code: 0, message: 'ok', data })
  }),
)

// 客户端申请退货：支持同一订单多次申请、部分商品退货与退货原因留痕。
o2oRouter.post(
  '/mall/preorders/:id/returns',
  requireClientAuth,
  asyncHandler(async (req, res) => {
    const authReq = req as ClientAuthenticatedRequest
    const payload = submitReturnRequestSchema.parse(req.body)
    const data = await o2oPreorderService.createReturnRequest(authReq.clientAuth, req.params.id, payload)

    await auditService.safeRecord({
      actionType: 'o2o.return_request.create',
      actionLabel: '客户端提交退货申请',
      targetType: 'o2o_return_request',
      targetId: data.id,
      targetCode: data.returnNo,
      actor: {
        userId: authReq.clientAuth.userId,
        username: authReq.clientAuth.account,
        displayName: authReq.clientAuth.realName || authReq.clientAuth.mobile,
      },
      requestMeta: extractRequestMeta(req),
      detail: {
        orderId: req.params.id,
        totalQty: data.totalQty,
        reason: data.reason,
        itemCount: data.items.length,
      },
    })

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

// 管理端更新订单“商家特殊状态”，用于向用户同步特殊进度，不改变核心核销主状态。
o2oRouter.patch(
  '/orders/:id/business-status',
  requireAuth,
  requirePermission('orders:update'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = businessStatusSchema.parse(req.body)
    const previous = await o2oPreorderService.detailById(req.params.id)
    const data = await o2oPreorderService.updateBusinessStatus({
      orderId: req.params.id,
      businessStatus: payload.businessStatus,
    })

    const previousStatus = previous.order.businessStatus
    const nextStatus = data.order.businessStatus
    let actionType = 'o2o.order.business_status.change'
    let actionLabel = '变更订单商家特殊状态'
    if (!previousStatus && nextStatus) {
      actionType = 'o2o.order.business_status.set'
      actionLabel = '设置订单商家特殊状态'
    } else if (previousStatus && !nextStatus) {
      actionType = 'o2o.order.business_status.clear'
      actionLabel = '清除订单商家特殊状态'
    }

    await auditService.record({
      actionType,
      actionLabel,
      targetType: 'o2o_order',
      targetId: data.order.id,
      targetCode: data.order.showNo,
      actor: authReq.auth,
      requestMeta: extractRequestMeta(req),
      detail: {
        previousBusinessStatus: previousStatus,
        previousBusinessStatusLabel: previousStatus ? BUSINESS_STATUS_LABEL_MAP[previousStatus] : null,
        nextBusinessStatus: nextStatus,
        nextBusinessStatusLabel: nextStatus ? BUSINESS_STATUS_LABEL_MAP[nextStatus] : null,
      },
    })

    res.json({ code: 0, message: 'ok', data })
  }),
)

// 管理端更新订单“商家留言”，用于补充特殊场景说明并在客户端详情可见。
o2oRouter.patch(
  '/orders/:id/merchant-message',
  requireAuth,
  requirePermission('orders:update'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = merchantMessageSchema.parse(req.body)
    const previous = await o2oPreorderService.detailById(req.params.id)
    const data = await o2oPreorderService.updateMerchantMessage({
      orderId: req.params.id,
      merchantMessage: payload.merchantMessage,
    })

    const previousMessage = previous.order.merchantMessage ?? null
    const nextMessage = data.order.merchantMessage ?? null
    if (previousMessage !== nextMessage) {
      let actionType = 'o2o.order.merchant_message.change'
      let actionLabel = '修改订单商家留言'
      if (!previousMessage && nextMessage) {
        actionType = 'o2o.order.merchant_message.set'
        actionLabel = '设置订单商家留言'
      } else if (previousMessage && !nextMessage) {
        actionType = 'o2o.order.merchant_message.clear'
        actionLabel = '清空订单商家留言'
      }

      await auditService.record({
        actionType,
        actionLabel,
        targetType: 'o2o_order',
        targetId: data.order.id,
        targetCode: data.order.showNo,
        actor: authReq.auth,
        requestMeta: extractRequestMeta(req),
        detail: {
          previousMerchantMessage: previousMessage,
          nextMerchantMessage: nextMessage,
        },
      })
    }

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
    const isReturnVerify = data.operationType === 'return_verify'
    const targetDetail = data.detail
    // 核销结果详情存在“预订单详情”和“退货申请详情”两种结构：
    // - 退货申请详情的主键位于顶层 `id`
    // - 预订单详情的主键位于 `order.id`
    // 这里通过返回单号字段做类型守卫，统一提取审计日志所需的目标主键与展示编号。
    const targetId = 'returnNo' in targetDetail ? targetDetail.id : targetDetail.order.id
    const targetCode = 'returnNo' in targetDetail ? targetDetail.returnNo : targetDetail.order.showNo

    await auditService.record({
      actionType: isReturnVerify ? 'o2o.return_request.verify' : 'o2o.preorder.verify',
      actionLabel: isReturnVerify ? '核销退货申请并回库' : '核销预订单并出库',
      targetType: isReturnVerify ? 'o2o_return_request' : 'o2o_order',
      targetId,
      targetCode,
      actor: authReq.auth,
      requestMeta: extractRequestMeta(req),
      detail: {
        verifyCode: payload.verifyCode,
        operationType: data.operationType,
        verifyTargetType: data.verifyTargetType,
      },
    })

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
