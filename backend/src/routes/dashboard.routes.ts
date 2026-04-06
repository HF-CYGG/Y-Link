import { Router } from 'express'
import { asyncHandler } from '../utils/async-handler.js'
import { dashboardService } from '../services/dashboard.service.js'

export const dashboardRouter = Router()

dashboardRouter.get(
  '/stats',
  asyncHandler(async (_req, res) => {
    const data = await dashboardService.getStats()
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)
