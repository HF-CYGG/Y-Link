/**
 * 文件说明：审计日志路由，提供后台操作日志的分页查询、业务类别筛选、导出，以及按事件聚合的通知事件查询。
 * 实现逻辑：
 * - 列表与导出共用 parseAuditFilterQuery 解析筛选参数，保证业务类别、操作类型、目标、时间口径完全一致；
 * - 业务类别与通知事件分类均由后端常量白名单校验，非法值直接返回 400；
 * - 通知事件接口沿用审计日志查看权限与管理员角色门禁，只读不改写任何通知或审计数据。
 * 维护重点：扩展审计查询条件时，需要同步核对服务层查询对象、导出字段以及管理员角色的访问边界。
 */

import { Router, type Request } from 'express'
import { requirePermission, requireRole } from '../middleware/auth.middleware.js'
import { asyncHandler } from '../utils/async-handler.js'
import { auditService, type AuditLogListQuery } from '../services/audit.service.js'
import { notificationEventLogService } from '../services/notification-event-log.service.js'
import { isAuditCategoryKey } from '../constants/audit-action-catalog.js'
import {
  isNotificationEventCategoryKey,
  isNotificationEventResultStatus,
} from '../constants/notification-event-catalog.js'
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

const readStringQuery = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)

const parsePageQuery = (req: Request) => {
  const page = Number(req.query.page ?? 1)
  const pageSize = Number(req.query.pageSize ?? 20)
  return {
    page: Number.isFinite(page) && page > 0 ? Math.floor(page) : 1,
    pageSize: Number.isFinite(pageSize) && pageSize > 0 ? Math.min(Math.floor(pageSize), 100) : 20,
  }
}

/**
 * 审计筛选参数解析：列表与导出共用，避免两处各自解析导致口径漂移。
 */
const parseAuditFilterQuery = (req: Request): AuditLogListQuery => {
  const category = readStringQuery(req.query.category)
  if (category !== undefined && !isAuditCategoryKey(category)) {
    throw new BizError('业务类别不正确', 400)
  }
  return {
    category,
    actionType: readStringQuery(req.query.actionType),
    targetType: readStringQuery(req.query.targetType),
    actorUserId: readStringQuery(req.query.actorUserId),
    targetId: readStringQuery(req.query.targetId),
    startAt: parseDateQuery(req.query.startAt, '开始时间'),
    endAt: parseDateQuery(req.query.endAt, '结束时间'),
  }
}

auditLogRouter.get(
  '/',
  requirePermission('audit_logs:view'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const data = await auditService.list({
      ...parsePageQuery(req),
      ...parseAuditFilterQuery(req),
    })

    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

// 审计筛选项：业务类别及类别下操作类型、目标对象中文名，以及通知事件页签的分类、处理结果与外发渠道。
auditLogRouter.get(
  '/filter-options',
  requirePermission('audit_logs:view'),
  requireRole('admin'),
  asyncHandler(async (_req, res) => {
    const auditOptions = await auditService.getFilterOptions()
    res.json({
      code: 0,
      message: 'ok',
      data: {
        ...auditOptions,
        notificationEvent: notificationEventLogService.getFilterOptions(),
      },
    })
  }),
)

auditLogRouter.get(
  '/export',
  requirePermission('audit_logs:export'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const csv = await auditService.exportCsv(parseAuditFilterQuery(req))

    const fileName = `audit-logs-${new Date().toISOString().slice(0, 19).replaceAll(/[:T]/g, '-')}.csv`
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
    // CSV 前置 UTF-8 BOM，保证 Excel 直接打开中文不乱码。
    res.send(String.fromCharCode(0xfeff) + csv)
  }),
)

// 通知事件主列表：同一 eventId 只展示一条主记录，外发结果以实际外发状态汇总。
auditLogRouter.get(
  '/notification-events',
  requirePermission('audit_logs:view'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const category = readStringQuery(req.query.category)
    if (category !== undefined && !isNotificationEventCategoryKey(category)) {
      throw new BizError('通知业务分类不正确', 400)
    }
    const resultStatus = readStringQuery(req.query.resultStatus)
    if (resultStatus !== undefined && !isNotificationEventResultStatus(resultStatus)) {
      throw new BizError('通知处理结果不正确', 400)
    }
    const channel = readStringQuery(req.query.channel)
    if (channel !== undefined && channel !== 'email' && channel !== 'feishu') {
      throw new BizError('外发渠道不正确', 400)
    }
    const eventId = readStringQuery(req.query.eventId)
    if (eventId !== undefined && !/^\d{1,20}$/.test(eventId)) {
      throw new BizError('通知事件 ID 格式不正确', 400)
    }
    const eventType = readStringQuery(req.query.eventType)
    if (eventType !== undefined && eventType.length > 64) {
      throw new BizError('通知事件类型不正确', 400)
    }

    const data = await notificationEventLogService.listEvents({
      ...parsePageQuery(req),
      category,
      eventType,
      resultStatus,
      channel,
      eventId,
      startAt: parseDateQuery(req.query.startAt, '开始时间'),
      endAt: parseDateQuery(req.query.endAt, '结束时间'),
    })
    res.json({ code: 0, message: 'ok', data })
  }),
)

// 通知事件详情：外发明细、按处理轮次分组的规则命中与外发执行记录、终态失败留痕。
auditLogRouter.get(
  '/notification-events/:id',
  requirePermission('audit_logs:view'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const eventId = String(req.params.id ?? '')
    if (!/^\d{1,20}$/.test(eventId)) {
      throw new BizError('通知事件 ID 格式不正确', 400)
    }
    const data = await notificationEventLogService.getEventDetail(eventId)
    res.json({ code: 0, message: 'ok', data })
  }),
)
