/**
 * 模块说明：backend/src/routes/system-config.routes.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { Router } from 'express'
import { z } from 'zod'
import { requirePermission, requireRole } from '../middleware/auth.middleware.js'
import type { AuthenticatedRequest } from '../types/auth.js'
import { systemConfigService } from '../services/system-config.service.js'
import type { UpdateClientDepartmentConfigsInput } from '../services/system-config.service.js'
import { verificationCodeService } from '../services/verification-code.service.js'
import { asyncHandler } from '../utils/async-handler.js'
import { extractRequestMeta } from '../utils/request-meta.js'

const orderSerialConfigValueSchema = z.object({
  start: z.number().int().positive(),
  current: z.number().int().nonnegative(),
  width: z.number().int().min(1).max(12),
})

const updateOrderSerialConfigsSchema = z.object({
  department: orderSerialConfigValueSchema,
  walkin: orderSerialConfigValueSchema,
})

const updateO2oRuleConfigsSchema = z.object({
  autoCancelEnabled: z.boolean(),
  autoCancelHours: z.number().int().min(1).max(168),
  limitEnabled: z.boolean(),
  limitQty: z.number().int().min(1).max(999),
  clientPreorderUpdateLimit: z.number().int().min(1).max(999).optional(),
})

const verificationProviderChannelSchema = z.object({
  enabled: z.boolean(),
  httpMethod: z.enum(['POST', 'GET']),
  apiUrl: z.string().max(500),
  headersTemplate: z.string().max(5000),
  bodyTemplate: z.string().max(10000),
  successMatch: z.string().max(500),
})

const updateVerificationProviderConfigsSchema = z.object({
  mobile: verificationProviderChannelSchema,
  email: verificationProviderChannelSchema,
})

const clientDepartmentTreeNodeSchema: z.ZodType<{
  id?: string
  label: string
  children?: Array<{ id?: string; label: string; children?: unknown[] }>
}> = z.lazy(() =>
  z.object({
    id: z.string().trim().max(128).optional(),
    label: z.string().trim().min(1).max(32),
    children: z.array(clientDepartmentTreeNodeSchema).max(50).optional(),
  }),
)

const updateClientDepartmentConfigsSchema = z
  .object({
    tree: z.array(clientDepartmentTreeNodeSchema).max(50).optional(),
    options: z.array(z.string().trim().min(1).max(32)).max(50).optional(),
  })
  .refine((value) => Array.isArray(value.tree) || Array.isArray(value.options), {
    message: '部门配置参数缺失',
  })

const normalizeClientDepartmentTreePayload = (
  tree: Array<{ id?: string; label: string; children?: unknown[] }>,
): NonNullable<UpdateClientDepartmentConfigsInput['tree']> => {
  return tree.map((node) => ({
    id: node.id?.trim() || '',
    label: node.label,
    children: Array.isArray(node.children)
      ? normalizeClientDepartmentTreePayload(node.children as Array<{ id?: string; label: string; children?: unknown[] }>)
      : [],
  }))
}

const testVerificationProviderSchema = z.object({
  channel: z.enum(['mobile', 'email']),
  target: z.string().trim().min(1).max(200),
  config: verificationProviderChannelSchema,
})

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
export const systemConfigRouter = Router()

systemConfigRouter.get(
  '/order-serial',
  requirePermission('system_configs:view'),
  asyncHandler(async (_req, res) => {
    const data = await systemConfigService.getOrderSerialConfigs()
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

systemConfigRouter.put(
  '/order-serial',
  requirePermission('system_configs:update'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = updateOrderSerialConfigsSchema.parse(req.body)
    const data = await systemConfigService.updateOrderSerialConfigs(payload, authReq.auth, extractRequestMeta(req))
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

systemConfigRouter.get(
  '/o2o-rules',
  requirePermission('system_configs:view'),
  asyncHandler(async (_req, res) => {
    const data = await systemConfigService.getO2oRuleConfigs()
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

systemConfigRouter.put(
  '/o2o-rules',
  requirePermission('system_configs:update'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = updateO2oRuleConfigsSchema.parse(req.body)
    const data = await systemConfigService.updateO2oRuleConfigs(payload, authReq.auth, extractRequestMeta(req))
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

systemConfigRouter.get(
  '/verification-providers',
  requirePermission('system_configs:view'),
  asyncHandler(async (_req, res) => {
    const data = await systemConfigService.getVerificationProviderConfigs()
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

systemConfigRouter.put(
  '/verification-providers',
  requirePermission('system_configs:update'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = updateVerificationProviderConfigsSchema.parse(req.body)
    const data = await systemConfigService.updateVerificationProviderConfigs(payload, authReq.auth, extractRequestMeta(req))
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

systemConfigRouter.post(
  '/verification-providers/test-send',
  requirePermission('verification_providers:test'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = testVerificationProviderSchema.parse(req.body)
    const data = await verificationCodeService.sendTest({
      channel: payload.channel,
      target: payload.target,
      config: payload.config,
      actor: authReq.auth,
      requestMeta: extractRequestMeta(req),
    })
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

systemConfigRouter.get(
  '/client-departments',
  requirePermission('system_configs:view'),
  asyncHandler(async (_req, res) => {
    const data = await systemConfigService.getClientDepartmentConfigs()
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

systemConfigRouter.put(
  '/client-departments',
  requirePermission('system_configs:update'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = updateClientDepartmentConfigsSchema.parse(req.body)
    const normalizedPayload: UpdateClientDepartmentConfigsInput = {
      options: payload.options,
      tree: payload.tree ? normalizeClientDepartmentTreePayload(payload.tree) : undefined,
    }
    const data = await systemConfigService.updateClientDepartmentConfigs(normalizedPayload, authReq.auth, extractRequestMeta(req))
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)
