/**
 * 模块说明：backend/src/routes/audit-log.routes.ts
 * 文件职责：审计日志路由入口，提供日志检索、筛选与导出相关接口。
 * 实现逻辑：
 * - 路由层负责参数校验与权限检查；
 * - 查询与导出由 audit service 处理；
 * - 响应保持统一结构并与前端筛选字段对齐。
 * 维护说明：
 * - 新增审计查询维度时需同步更新导出字段与前端筛选项。
 */

import { Router } from 'express'
import { requirePermission, requireRole } from '../middleware/auth.middleware.js'
import { asyncHandler } from '../utils/async-handler.js'
import { auditService } from '../services/audit.service.js'
import { BizError } from '../utils/errors.js'

export const auditLogRouter = Router()

/**
 * 安全解析时间筛选入参：
 * - 未传值时返回 undefined，表示不参与筛选；
 * - 非法时间字符串由路由层直接拦截，避免服务层收到脏数据。
 */
const parseDateQuery = (value: unknown, label: string) => {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw new BizError(`${label}格式不正确`, 400)
  }

  return parsed
}

auditLogRouter.get(
  '/',
  requirePermission('audit_logs:view'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    // 列表与导出统一复用 startAt / endAt 字段，保持与服务层查询对象一致。
    const page = Number(req.query.page ?? 1)
    const pageSize = Number(req.query.pageSize ?? 20)
    const startAt = parseDateQuery(req.query.startAt, '开始时间')
    const endAt = parseDateQuery(req.query.endAt, '结束时间')
    const data = await auditService.list({
      page: Number.isFinite(page) && page > 0 ? page : 1,
      pageSize: Number.isFinite(pageSize) && pageSize > 0 ? Math.min(pageSize, 100) : 20,
      actionType: typeof req.query.actionType === 'string' ? req.query.actionType : undefined,
      targetType: typeof req.query.targetType === 'string' ? req.query.targetType : undefined,
      actorUserId: typeof req.query.actorUserId === 'string' ? req.query.actorUserId : undefined,
      targetId: typeof req.query.targetId === 'string' ? req.query.targetId : undefined,
      startAt,
      endAt,
    })

    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

auditLogRouter.get(
  '/export',
  requirePermission('audit_logs:export'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const startAt = parseDateQuery(req.query.startAt, '开始时间')
    const endAt = parseDateQuery(req.query.endAt, '结束时间')
    const csv = await auditService.exportCsv({
      actionType: typeof req.query.actionType === 'string' ? req.query.actionType : undefined,
      targetType: typeof req.query.targetType === 'string' ? req.query.targetType : undefined,
      actorUserId: typeof req.query.actorUserId === 'string' ? req.query.actorUserId : undefined,
      targetId: typeof req.query.targetId === 'string' ? req.query.targetId : undefined,
      startAt,
      endAt,
    })

    const fileName = `audit-logs-${new Date().toISOString().slice(0, 19).replaceAll(/[:T]/g, '-')}.csv`
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
    res.send(`\uFEFF${csv}`)
  }),
)
