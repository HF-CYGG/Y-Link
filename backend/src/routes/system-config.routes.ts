/**
 * 模块说明：backend/src/routes/system-config.routes.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { Router } from 'express'
import { z } from 'zod'
import { requirePermission } from '../middleware/auth.middleware.js'
import type { AuthenticatedRequest } from '../types/auth.js'
import { systemConfigService } from '../services/system-config.service.js'
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
  requirePermission('system_configs:update'),
  asyncHandler(async (req, res) => {
    const payload = testVerificationProviderSchema.parse(req.body)
    const data = await verificationCodeService.sendTest({
      channel: payload.channel,
      target: payload.target,
      config: payload.config,
      requestMeta: extractRequestMeta(req),
    })
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)
