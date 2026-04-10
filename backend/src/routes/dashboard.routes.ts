/**
 * 模块说明：backend/src/routes/dashboard.routes.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { Router } from 'express'
import { z } from 'zod'
import { asyncHandler } from '../utils/async-handler.js'
import { dashboardService } from '../services/dashboard.service.js'
import { BizError } from '../utils/errors.js'

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
export const dashboardRouter = Router()

const dashboardFilterQuerySchema = z.object({
  dateRange: z.union([z.string(), z.array(z.string())]).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  orderType: z.enum(['department', 'walkin']).optional(),
})

const productDrilldownQuerySchema = dashboardFilterQuerySchema.extend({
  productId: z.string().trim().min(1, 'productId 不能为空'),
})

const customerDrilldownQuerySchema = dashboardFilterQuerySchema.extend({
  customerName: z.string().trim().min(1, 'customerName 不能为空'),
})

const tagAggregateQuerySchema = dashboardFilterQuerySchema.extend({
  tagId: z.string().trim().min(1, 'tagId 不能为空'),
})

const resolveDateRangeQuery = (query: z.infer<typeof dashboardFilterQuerySchema>) => {
  let startDate = typeof query.startDate === 'string' ? query.startDate.trim() : ''
  let endDate = typeof query.endDate === 'string' ? query.endDate.trim() : ''

  const rawDateRange = query.dateRange
  if (typeof rawDateRange === 'string' && rawDateRange.trim()) {
    const [start, end, ...rest] = rawDateRange.split(',').map((item) => item.trim())
    if (!start || !end || rest.length > 0) {
      throw new BizError('dateRange 参数格式错误，应为 startDate,endDate', 400)
    }
    startDate = start
    endDate = end
  }

  if (Array.isArray(rawDateRange) && rawDateRange.length > 0) {
    if (rawDateRange.length !== 2) {
      throw new BizError('dateRange 参数格式错误，应传入两个日期', 400)
    }
    const [start, end] = rawDateRange.map((item) => item.trim())
    if (!start || !end) {
      throw new BizError('dateRange 参数格式错误，应传入两个非空日期', 400)
    }
    startDate = start
    endDate = end
  }

  return {
    startDate: startDate || undefined,
    endDate: endDate || undefined,
    orderType: query.orderType,
  }
}

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

dashboardRouter.get(
  '/drilldown/products',
  asyncHandler(async (req, res) => {
    const query = productDrilldownQuerySchema.parse(req.query)
    const filter = resolveDateRangeQuery(query)
    const data = await dashboardService.getProductRankDrilldown({
      productId: query.productId,
      ...filter,
    })
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

dashboardRouter.get(
  '/drilldown/customers',
  asyncHandler(async (req, res) => {
    const query = customerDrilldownQuerySchema.parse(req.query)
    const filter = resolveDateRangeQuery(query)
    const data = await dashboardService.getCustomerRankDrilldown({
      customerName: query.customerName,
      ...filter,
    })
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

dashboardRouter.get(
  '/tags/aggregate',
  asyncHandler(async (req, res) => {
    const query = tagAggregateQuerySchema.parse(req.query)
    const filter = resolveDateRangeQuery(query)
    const data = await dashboardService.getTagAggregate({
      tagId: query.tagId,
      ...filter,
    })
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

dashboardRouter.get(
  '/pie',
  asyncHandler(async (req, res) => {
    const query = dashboardFilterQuerySchema.parse(req.query)
    const filter = resolveDateRangeQuery(query)
    const data = await dashboardService.getDashboardPieData(filter)
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)
