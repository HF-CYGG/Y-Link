/**
 * 文件说明：出库订单路由，负责后台订单创建、查询、详情查看、删除以及相关业务校验入口。
 * 实现逻辑：通过权限中间件限制操作范围，在路由层校验订单头和明细参数后，把幂等校验、库存变更和审计留痕交给服务层执行。
 * 维护重点：修改订单提交流程时，需要同步关注幂等键规则、库存扣减逻辑以及删除订单的二次确认约束。
 */

import { Router } from 'express'
import { z } from 'zod'
import { requirePermission, requireRole } from '../middleware/auth.middleware.js'
import { orderService } from '../services/order.service.js'
import type { AuthenticatedRequest } from '../types/auth.js'
import { asyncHandler } from '../utils/async-handler.js'
import { BizError } from '../utils/errors.js'
import { assertPermanentDeletePassword } from '../utils/permanent-delete-password.js'
import { extractRequestMeta } from '../utils/request-meta.js'

const submitOrderSchema = z.object({
  idempotencyKey: z.string().min(8, 'idempotencyKey 长度至少为 8'),
  orderType: z.enum(['department', 'walkin']).optional(),
  hasCustomerOrder: z.boolean().optional(),
  isSystemApplied: z.boolean().optional(),
  issuerName: z.string().max(64, '出单人长度不能超过64').optional(),
  customerDepartmentName: z.string().max(271, '客户部门名称长度不能超过271').optional(),
  // 选自系统部门配置时携带节点 ID，服务端只读解析出规范完整路径；手动录入时省略。
  customerDepartmentNodeId: z.string().trim().min(1).max(128, '客户部门节点ID长度不能超过128').optional(),
  customerName: z.string().optional(),
  remark: z.string().optional(),
  items: z
    .array(
      z.object({
        productId: z.union([z.string().min(1), z.number()]),
        skuId: z.union([z.string().trim().min(1), z.number()]).nullable().optional(),
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

const softDeleteOrderSchema = deleteOrderSchema.extend({
  // 仅手工库存单可选择删除时回补库存；缺省视为不回补，保持旧调用方语义不变。
  releaseInventory: z.boolean().optional(),
})

const purgeOrderSchema = deleteOrderSchema.extend({
  permanentDeletePassword: z.string().optional(),
})

const updateComplianceFlagsSchema = z
  .object({
    editVersion: z.number().int().positive(),
    hasCustomerOrder: z.boolean().optional(),
    isSystemApplied: z.boolean().optional(),
  })
  .refine((payload) => payload.hasCustomerOrder !== undefined || payload.isSystemApplied !== undefined, {
    message: '至少传入一个可更新字段',
  })

const orderAmendmentSchema = z.object({
  orderId: z.union([z.string().trim().min(1), z.number()]).transform(String),
  editVersion: z.number().int().positive(),
  // 业务号格式与长度统一交由服务层返回 409，避免 Zod 提前转换成普通 400。
  businessNo: z.string().trim().optional(),
  orderType: z.enum(['department', 'walkin']).optional(),
  customerDepartmentName: z.string().max(271).nullable().optional(),
  customerName: z.string().max(128).nullable().optional(),
  issuerName: z.string().max(64).nullable().optional(),
  hasCustomerOrder: z.boolean().optional(),
  isSystemApplied: z.boolean().optional(),
  remark: z.string().max(500).nullable().optional(),
  reason: z.string().max(500).optional(),
  reclaimBusinessNo: z.boolean().optional(),
})

const orderAmendmentBatchSchema = z.object({
  amendments: z.array(orderAmendmentSchema).min(1).max(100),
})

const orderAmendmentCommitSchema = orderAmendmentSchema.extend({
  reason: z.string().trim().min(1, '请填写修订原因').max(500),
})

const orderAmendmentCommitBatchSchema = z.object({
  amendments: z.array(orderAmendmentCommitSchema).min(1).max(100),
})

const orderBusinessNoReclaimSchema = z.object({
  amendment: orderAmendmentCommitSchema.extend({
    reclaimBusinessNo: z.literal(true),
  }),
  permanentDeletePassword: z.string().min(1, '请输入永久删除密码').max(256, '永久删除密码长度非法'),
})

const amendmentBusinessNoSuggestionSchema = z.object({
  orderType: z.enum(['department', 'walkin']),
  count: z.coerce.number().int().min(1).max(100).default(1),
  // 同批其他草稿已填写的业务号，逗号分隔；只用于建议时避让，不参与占号。
  exclude: z.string().max(4000).optional()
    .transform((value) => (value ?? '').split(',').map((item) => item.trim()).filter(Boolean).slice(0, 100)),
})

const updateOrderContentSchema = z.object({
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(1, '请填写修改原因').max(500),
  businessNo: z.string().trim().optional(),
  items: z.array(z.object({
    productId: z.union([z.string().trim().min(1), z.number()]).transform(String),
    skuId: z.union([z.string().trim().min(1), z.number()]).nullable().optional().transform((value) => value == null ? null : String(value)),
    qty: z.number().positive(),
    unitPrice: z.number().positive(),
    remark: z.string().max(200).nullable().optional(),
  })).min(1).max(200),
})

const orderMergeParticipantSchema = z.object({
  orderId: z.union([z.string().trim().min(1), z.number()]).transform(String),
  editVersion: z.number().int().positive(),
})

const orderMergePreviewSchema = z.object({
  target: orderMergeParticipantSchema,
  sources: z.array(orderMergeParticipantSchema).min(1).max(100),
  reason: z.string().trim().min(1, '请填写合并原因').max(500),
})

const orderMergeCommitSchema = orderMergePreviewSchema.extend({
  idempotencyKey: z.string().trim().min(8).max(128),
})

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
export const orderRouter = Router()

orderRouter.get(
  '/',
  // 订单列表属于业务数据查询，需要具备 orders:view 权限才可访问。
  requirePermission('orders:view'),
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
  '/department-options',
  // 开单页的客户部门下拉只对具备开单权限的账号开放，不依赖系统配置查看权限；
  // 必须注册在 `/:id` 之前，避免被详情路由吞掉。
  requirePermission('orders:create'),
  asyncHandler(async (_req, res) => {
    const data = await orderService.listDepartmentOptions()
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

orderRouter.get(
  '/show-no/:showNo',
  // 通过业务单号查询明细同样属于订单查看能力，统一纳入 orders:view 控制。
  requirePermission('orders:view'),
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
  '/amendments/business-no-suggestions',
  // 修订弹窗切换订单类型时按目标命名空间游标顺延建议业务号；只读，不占号、不推进游标。
  requirePermission('orders:update'),
  asyncHandler(async (req, res) => {
    const query = amendmentBusinessNoSuggestionSchema.parse(req.query ?? {})
    const data = await orderService.suggestAmendmentBusinessNos(query)
    res.json({ code: 0, message: 'ok', data })
  }),
)

orderRouter.post(
  '/amendments/preview',
  requirePermission('orders:update'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = orderAmendmentBatchSchema.parse(req.body ?? {})
    const data = await orderService.previewAmendments(payload, authReq.auth)
    res.json({ code: 0, message: 'ok', data })
  }),
)

orderRouter.post(
  '/merges/preview',
  requirePermission('orders:merge'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = orderMergePreviewSchema.parse(req.body ?? {})
    const data = await orderService.previewMerge(payload, authReq.auth)
    res.json({ code: 0, message: 'ok', data })
  }),
)

orderRouter.post(
  '/merges',
  requirePermission('orders:merge'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = orderMergeCommitSchema.parse(req.body ?? {})
    const data = await orderService.commitMerge(payload, authReq.auth, extractRequestMeta(req))
    res.json({ code: 0, message: 'ok', data })
  }),
)

orderRouter.get(
  '/:id/revisions',
  requirePermission('orders:view'),
  asyncHandler(async (req, res) => {
    const data = await orderService.listRevisions(req.params.id)
    res.json({ code: 0, message: 'ok', data })
  }),
)

orderRouter.patch(
  '/:id/content',
  requirePermission('orders:edit'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = updateOrderContentSchema.parse(req.body ?? {})
    const data = await orderService.updateContent(req.params.id, payload, authReq.auth, extractRequestMeta(req))
    res.json({ code: 0, message: 'ok', data })
  }),
)

orderRouter.post(
  '/amendments',
  requirePermission('orders:update'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = orderAmendmentCommitBatchSchema.parse(req.body ?? {})
    const data = await orderService.commitAmendments(payload, authReq.auth, extractRequestMeta(req))
    res.json({ code: 0, message: 'ok', data })
  }),
)

orderRouter.post(
  '/amendments/reclaim-business-no',
  requirePermission('orders:update'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = orderBusinessNoReclaimSchema.parse(req.body ?? {})
    assertPermanentDeletePassword(payload.permanentDeletePassword)
    const data = await orderService.reclaimBusinessNo(
      { amendment: payload.amendment },
      authReq.auth,
      extractRequestMeta(req),
    )
    res.json({ code: 0, message: 'ok', data })
  }),
)

orderRouter.get(
  '/:id',
  // 通过主键查询明细也必须满足订单查看权限，避免越权探测订单数据。
  requirePermission('orders:view'),
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
  // 创建订单是写操作，必须具备 orders:create 权限。
  requirePermission('orders:create'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payloadRaw = req.body as Record<string, unknown> | null | undefined
    if (
      payloadRaw
      && typeof payloadRaw === 'object'
      && ('showNo' in payloadRaw || 'orderNo' in payloadRaw || 'businessNo' in payloadRaw || 'editVersion' in payloadRaw)
    ) {
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
    const payload = softDeleteOrderSchema.parse(req.body ?? {})
    const data = await orderService.softDeleteById(
      req.params.id,
      authReq.auth,
      payload.confirmShowNo,
      extractRequestMeta(req),
      { releaseInventory: payload.releaseInventory === true },
    )
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

orderRouter.delete(
  '/:id/purge',
  requirePermission('orders:delete'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = purgeOrderSchema.parse(req.body ?? {})
    assertPermanentDeletePassword(payload.permanentDeletePassword)
    const data = await orderService.purgeById(req.params.id, authReq.auth, payload.confirmShowNo, extractRequestMeta(req))
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

orderRouter.patch(
  '/:id/compliance-flags',
  requirePermission('orders:update'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = updateComplianceFlagsSchema.parse(req.body ?? {})
    const data = await orderService.updateComplianceFlags({
      orderId: req.params.id,
      editVersion: payload.editVersion,
      hasCustomerOrder: payload.hasCustomerOrder,
      isSystemApplied: payload.isSystemApplied,
    }, authReq.auth, extractRequestMeta(req))
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)
