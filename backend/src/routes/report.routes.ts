/**
 * 模块说明：backend/src/routes/report.routes.ts
 * 文件职责：提供报表中心的分页预览与 Excel 导出接口。
 * 实现逻辑：路由层统一解析报表类型、时间段、标签和字段参数，再由报表服务按白名单生成数据或文件。
 * 维护说明：新增报表接口时必须继续保留 reports:view / reports:export 权限边界，避免经营数据被低权限账号直接读取。
 */

import { Router } from 'express'
import { requirePermission } from '../middleware/auth.middleware.js'
import { reportService, REPORT_TYPES, type ReportQueryInput, type ReportType } from '../services/report.service.js'
import { asyncHandler } from '../utils/async-handler.js'
import { BizError } from '../utils/errors.js'

export const reportRouter = Router()

const parseStringListQuery = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap((item) => parseStringListQuery(item))
  }
  if (typeof value !== 'string') {
    return []
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

const parseReportType = (value: string): ReportType => {
  if (!REPORT_TYPES.includes(value as ReportType)) {
    throw new BizError('报表类型不存在', 404)
  }
  return value as ReportType
}

const buildReportQuery = (query: Record<string, unknown>): ReportQueryInput => ({
  page: typeof query.page === 'string' ? Number(query.page) : undefined,
  pageSize: typeof query.pageSize === 'string' ? Number(query.pageSize) : undefined,
  startDate: typeof query.startDate === 'string' ? query.startDate : undefined,
  endDate: typeof query.endDate === 'string' ? query.endDate : undefined,
  tagIds: parseStringListQuery(query.tagIds),
  fields: parseStringListQuery(query.fields),
})

const handleReportQuery = (type: ReportType) => [
  requirePermission('reports:view'),
  asyncHandler(async (req, res) => {
    const data = await reportService.query(type, buildReportQuery(req.query as Record<string, unknown>))
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
]

reportRouter.get('/inventory', ...handleReportQuery('inventory'))
reportRouter.get('/tag-sales', ...handleReportQuery('tag-sales'))
reportRouter.get('/kingdee', ...handleReportQuery('kingdee'))
reportRouter.get('/walkin', ...handleReportQuery('walkin'))
reportRouter.get('/outbound-flow', ...handleReportQuery('outbound-flow'))

reportRouter.get(
  '/:type/export',
  requirePermission('reports:export'),
  asyncHandler(async (req, res) => {
    const type = parseReportType(req.params.type)
    const result = await reportService.exportExcel(type, buildReportQuery(req.query as Record<string, unknown>))
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${result.fileName}"`)
    res.send(result.buffer)
  }),
)
