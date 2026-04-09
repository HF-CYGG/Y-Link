import { Router } from 'express'
import { z } from 'zod'
import { requirePermission } from '../middleware/auth.middleware.js'
import { dataMaintenanceService } from '../services/data-maintenance.service.js'
import { asyncHandler } from '../utils/async-handler.js'

const importPayloadSchema = z.object({
  exportedAt: z.string(),
  version: z.string(),
  tables: z.object({
    systemConfigs: z.array(z.record(z.any())).default([]),
    products: z.array(z.record(z.any())).default([]),
    clientUsers: z.array(z.record(z.any())).default([]),
    preorders: z.array(z.record(z.any())).default([]),
    preorderItems: z.array(z.record(z.any())).default([]),
    inventoryLogs: z.array(z.record(z.any())).default([]),
  }),
})

export const dataMaintenanceRouter = Router()

dataMaintenanceRouter.post(
  '/backup/sqlite',
  requirePermission('system_configs:update'),
  asyncHandler(async (_req, res) => {
    const data = await dataMaintenanceService.createSqliteBackup()
    res.json({ code: 0, message: 'ok', data })
  }),
)

dataMaintenanceRouter.get(
  '/export/json',
  requirePermission('system_configs:view'),
  asyncHandler(async (_req, res) => {
    const data = await dataMaintenanceService.exportJson()
    res.json({ code: 0, message: 'ok', data })
  }),
)

dataMaintenanceRouter.post(
  '/import/json',
  requirePermission('system_configs:update'),
  asyncHandler(async (req, res) => {
    const payload = importPayloadSchema.parse(req.body)
    const data = await dataMaintenanceService.importJson(payload as any)
    res.json({ code: 0, message: 'ok', data })
  }),
)
