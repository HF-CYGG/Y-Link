import { Router } from 'express'
import { z } from 'zod'
import { requirePermission, requireRole } from '../middleware/auth.middleware.js'
import type { AuthenticatedRequest } from '../types/auth.js'
import {
  NOTIFICATION_EVENT_TYPES,
  notificationService,
  type NotificationEventType,
} from '../services/notification.service.js'
import { NOTIFICATION_EXTERNAL_TRIGGER_MODES } from '../entities/notification-rule.entity.js'
import { asyncHandler } from '../utils/async-handler.js'
import { extractRequestMeta } from '../utils/request-meta.js'
import { notificationChannelConfigService } from '../services/notification-channel-config.service.js'

const idValueSchema = z.union([z.string(), z.number()])
  .transform((value) => String(value).trim())
  .pipe(z.string().min(1))

const looseTextSchema = (max: number) =>
  // 缺省由外层 optional 处理，避免 Zod 4 把省略字段送入 transform 后变为空字符串。
  z.union([z.string(), z.number(), z.null()])
    .transform((value) => String(value ?? '').trim())
    .pipe(z.string().max(max))

const updateNotificationRuleSchema = z.object({
  id: idValueSchema,
  enabled: z.boolean(),
  recipientUserIds: z.array(idValueSchema).max(200).optional().default([]),
  emailRecipientAdminUserIds: z.array(idValueSchema).max(200).optional().default([]),
  emailRecipientSupplierUserIds: z.array(idValueSchema).max(200).optional().default([]),
  emailEnabled: z.boolean().optional().default(false),
  feishuEnabled: z.boolean().optional().default(false),
  useSharedFeishu: z.boolean().optional(),
  externalTriggerMode: z.enum(NOTIFICATION_EXTERNAL_TRIGGER_MODES).optional().default('all_management_offline'),
  watchedUserIds: z.array(idValueSchema).max(200).optional().default([]),
  feishuWebhookUrl: looseTextSchema(500).optional(),
  clearFeishuWebhook: z.boolean().optional(),
  clearFeishuSignSecret: z.boolean().optional(),
  feishuSignSecret: looseTextSchema(256).optional(),
  emailSubjectPrefix: looseTextSchema(128).optional(),
})

const updateNotificationRulesSchema = z.object({
  offlineWindowSeconds: z.coerce.number().int().min(30).max(3600).optional().default(120),
  rules: z.array(updateNotificationRuleSchema).min(1),
})
type UpdateNotificationRulesPayload = z.infer<typeof updateNotificationRulesSchema>

const testSendNotificationRuleSchema = z.object({
  ruleId: idValueSchema,
  channel: z.enum(['email', 'feishu']),
  draft: updateNotificationRuleSchema,
})

export const notificationRouter = Router()

notificationRouter.get('/channels', requirePermission('system_configs:view'), asyncHandler(async (_req, res) => {
  res.json({ code: 0, message: 'ok', data: await notificationChannelConfigService.getChannels() })
}))

const updateChannelsSchema = z.object({
  feishuWebhookUrl: z.string().trim().max(500).optional(),
  feishuSignSecret: z.string().trim().max(256).optional(),
  clearFeishuWebhook: z.boolean().optional(),
  clearFeishuSignSecret: z.boolean().optional(),
  emailSubjectPrefix: z.string().trim().max(128).optional(),
})

notificationRouter.put('/channels', requirePermission('system_configs:update'), requireRole('admin'), asyncHandler(async (req, res) => {
  const authReq = req as AuthenticatedRequest
  const data = await notificationChannelConfigService.updateChannels(updateChannelsSchema.parse(req.body), authReq.auth, extractRequestMeta(req))
  res.json({ code: 0, message: 'ok', data })
}))

notificationRouter.get(
  '/rules',
  requirePermission('system_configs:view'),
  asyncHandler(async (_req, res) => {
    const list = await notificationService.listRules()
    res.json({
      code: 0,
      message: 'ok',
      data: { list },
    })
  }),
)

notificationRouter.put(
  '/rules',
  requirePermission('system_configs:update'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = updateNotificationRulesSchema.parse(req.body) as UpdateNotificationRulesPayload
    const data = await notificationService.updateRules(
      payload.rules,
      payload.offlineWindowSeconds,
      authReq.auth,
      extractRequestMeta(req),
    )
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

notificationRouter.get(
  '/presence-snapshot',
  requirePermission('system_configs:view'),
  asyncHandler(async (_req, res) => {
    const data = await notificationService.getPresenceSnapshot()
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

notificationRouter.post(
  '/rules/test-send',
  requirePermission('system_configs:update'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = testSendNotificationRuleSchema.parse(req.body)
    const data = await notificationService.testSendByRule({
      ruleId: payload.ruleId,
      channel: payload.channel,
      draft: payload.draft,
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

notificationRouter.get(
  '/inbox',
  requirePermission('products:view'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const page = Number(req.query.page ?? 1)
    const pageSize = Number(req.query.pageSize ?? 20)
    const unreadOnly = String(req.query.unreadOnly ?? '') === '1'
    // 可选按事件类型过滤：供货方历史页只拉送货单状态变更提醒，不受其它事件干扰。
    const eventType = typeof req.query.eventType === 'string' && NOTIFICATION_EVENT_TYPES.includes(req.query.eventType as NotificationEventType)
      ? req.query.eventType
      : undefined
    const data = await notificationService.listInbox(authReq.auth, {
      page: Number.isFinite(page) && page > 0 ? page : 1,
      pageSize: Number.isFinite(pageSize) && pageSize > 0 ? Math.min(pageSize, 100) : 20,
      unreadOnly,
      eventType,
    })
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

notificationRouter.get(
  '/unread-count',
  requirePermission('products:view'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const count = await notificationService.getUnreadCount(authReq.auth)
    res.json({
      code: 0,
      message: 'ok',
      data: { count },
    })
  }),
)

// 按事件类型批量已读：只作用于当前登录账号，事件类型必须在白名单内。
const markInboxReadByEventTypeSchema = z.object({
  eventType: z.enum(NOTIFICATION_EVENT_TYPES),
})

notificationRouter.post(
  '/inbox/read-by-event-type',
  requirePermission('products:view'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = markInboxReadByEventTypeSchema.parse(req.body)
    const changed = await notificationService.markInboxReadByEventType(payload.eventType, authReq.auth)
    res.json({
      code: 0,
      message: 'ok',
      data: { changed },
    })
  }),
)

notificationRouter.post(
  '/inbox/:id/read',
  requirePermission('products:view'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const changed = await notificationService.markInboxRead(req.params.id, authReq.auth)
    res.json({
      code: 0,
      message: 'ok',
      data: { changed },
    })
  }),
)
