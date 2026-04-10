/**
 * 模块说明：backend/src/routes/data-maintenance.routes.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

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

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
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
