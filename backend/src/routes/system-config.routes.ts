import { Router } from 'express'
import { z } from 'zod'
import { requirePermission } from '../middleware/auth.middleware.js'
import type { AuthenticatedRequest } from '../types/auth.js'
import { systemConfigService } from '../services/system-config.service.js'
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
