import { Router } from 'express'
import { z } from 'zod'
import { requirePermission, requireRole } from '../middleware/auth.middleware.js'
import type { AuthenticatedRequest } from '../types/auth.js'
import {
  notificationService,
} from '../services/notification.service.js'
import { NOTIFICATION_EXTERNAL_TRIGGER_MODES } from '../entities/notification-rule.entity.js'
import { asyncHandler } from '../utils/async-handler.js'
import { extractRequestMeta } from '../utils/request-meta.js'

const updateNotificationRuleSchema = z.object({
  id: z.string().trim().min(1),
  enabled: z.boolean(),
  recipientUserIds: z.array(z.string().trim().min(1)).max(200),
  emailRecipientAdminUserIds: z.array(z.string().trim().min(1)).max(200),
  emailRecipientSupplierUserIds: z.array(z.string().trim().min(1)).max(200),
  emailEnabled: z.boolean(),
  feishuEnabled: z.boolean(),
  externalTriggerMode: z.enum(NOTIFICATION_EXTERNAL_TRIGGER_MODES),
  watchedUserIds: z.array(z.string().trim().min(1)).max(200),
  feishuWebhookUrl: z.string().trim().max(500),
  feishuSignSecret: z.string().trim().max(256),
  emailSubjectPrefix: z.string().trim().max(128),
})

const updateNotificationRulesSchema = z.object({
  rules: z.array(updateNotificationRuleSchema).min(1),
})
type UpdateNotificationRulesPayload = z.infer<typeof updateNotificationRulesSchema>

const testSendNotificationRuleSchema = z.object({
  ruleId: z.string().trim().min(1),
  channel: z.enum(['email', 'feishu']),
  draft: updateNotificationRuleSchema,
})

export const notificationRouter = Router()

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
    const data = await notificationService.updateRules(payload.rules, authReq.auth, extractRequestMeta(req))
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
    const data = await notificationService.listInbox(authReq.auth, {
      page: Number.isFinite(page) && page > 0 ? page : 1,
      pageSize: Number.isFinite(pageSize) && pageSize > 0 ? Math.min(pageSize, 100) : 20,
      unreadOnly,
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
