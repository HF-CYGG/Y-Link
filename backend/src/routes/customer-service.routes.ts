/**
 * 文件说明：管理端客服中心路由，覆盖反馈会话列表、详情、回复、状态流转与实时 SSE 订阅等客服处理能力。
 * 实现逻辑：统一复用后台鉴权与细粒度权限控制，把会话查询、消息回复和状态更新收口到客服服务层，并通过 SSE 推送实时变更。
 * 维护重点：扩展客服角色、转派能力或筛选维度时，需要同步核对权限矩阵、会话状态机和未读计数逻辑。
 */

import { Router } from 'express'
import { z } from 'zod'
import { requirePermission } from '../middleware/auth.middleware.js'
import type { AuthenticatedRequest } from '../types/auth.js'
import { asyncHandler } from '../utils/async-handler.js'
import { extractRequestMeta } from '../utils/request-meta.js'
import {
  CLIENT_FEEDBACK_CONVERSATION_STATUSES,
  CLIENT_FEEDBACK_ISSUE_TYPES,
  CLIENT_FEEDBACK_PRIORITIES,
} from '../entities/client-feedback-conversation.entity.js'
import {
  clientFeedbackService,
  CLIENT_FEEDBACK_ATTACHMENT_MIME_TYPE_MAX_LENGTH,
  CLIENT_FEEDBACK_ATTACHMENT_NAME_MAX_LENGTH,
  CLIENT_FEEDBACK_ATTACHMENT_URL_MAX_LENGTH,
  CLIENT_FEEDBACK_CONTACT_PREFERENCE_MAX_LENGTH,
  CLIENT_FEEDBACK_INTERNAL_REMARK_MAX_LENGTH,
  CLIENT_FEEDBACK_MAX_ATTACHMENTS_PER_MESSAGE,
  CLIENT_FEEDBACK_MAX_TAG_LENGTH,
  CLIENT_FEEDBACK_MAX_TAGS,
  CLIENT_FEEDBACK_MESSAGE_MAX_LENGTH,
  CLIENT_FEEDBACK_ORDER_REF_MAX_LENGTH,
  CLIENT_FEEDBACK_SOURCE_LABEL_MAX_LENGTH,
  CLIENT_FEEDBACK_SUBJECT_MAX_LENGTH,
} from '../services/client-feedback.service.js'

const listServiceConversationsSchema = z.object({
  status: z.enum(CLIENT_FEEDBACK_CONVERSATION_STATUSES).optional(),
  priority: z.enum(CLIENT_FEEDBACK_PRIORITIES).optional(),
  keyword: z.string().trim().max(64).optional(),
  assignedToMe: z
    .union([z.boolean(), z.string().trim().regex(/^(true|false|1|0)$/i)])
    .optional()
    .transform((value) => {
      if (typeof value === 'boolean') {
        return value
      }
      if (!value) {
        return undefined
      }
      return value === 'true' || value === '1'
    }),
  unreadOnly: z
    .union([z.boolean(), z.string().trim().regex(/^(true|false|1|0)$/i)])
    .optional()
    .transform((value) => {
      if (typeof value === 'boolean') {
        return value
      }
      if (!value) {
        return undefined
      }
      return value === 'true' || value === '1'
    }),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
})

const feedbackAttachmentSchema = z.object({
  name: z.string().trim().min(1).max(CLIENT_FEEDBACK_ATTACHMENT_NAME_MAX_LENGTH),
  url: z.string().trim().min(1).max(CLIENT_FEEDBACK_ATTACHMENT_URL_MAX_LENGTH),
  mimeType: z.string().trim().max(CLIENT_FEEDBACK_ATTACHMENT_MIME_TYPE_MAX_LENGTH).nullable().optional(),
  size: z.number().int().min(0).nullable().optional(),
}).transform((attachment) => ({
  name: attachment.name,
  url: attachment.url,
  mimeType: attachment.mimeType ?? null,
  size: attachment.size ?? null,
}))

const appendMessageSchema = z.object({
  content: z.string().trim().min(1).max(CLIENT_FEEDBACK_MESSAGE_MAX_LENGTH),
  attachments: z.array(feedbackAttachmentSchema).max(CLIENT_FEEDBACK_MAX_ATTACHMENTS_PER_MESSAGE).optional(),
})

const updateStatusSchema = z.object({
  status: z.enum(CLIENT_FEEDBACK_CONVERSATION_STATUSES),
})

/**
 * 显式负责人变更入参：
 * - 接单与转派统一复用同一接口；
 * - 由服务层根据当前负责人和目标负责人判断是接单、指派还是转派。
 */
const updateAssigneeSchema = z.object({
  assigneeUserId: z
    .union([z.string(), z.number()])
    .transform((value) => String(value).trim())
    .pipe(z.string().min(1).max(64)),
})

const updateIssueFieldsSchema = z.object({
  issueType: z.enum(CLIENT_FEEDBACK_ISSUE_TYPES).optional(),
  subject: z.string().trim().min(1).max(CLIENT_FEEDBACK_SUBJECT_MAX_LENGTH).optional(),
  category: z.string().trim().min(1).max(32).optional(),
  priority: z.enum(CLIENT_FEEDBACK_PRIORITIES).optional(),
  orderRef: z.string().trim().max(CLIENT_FEEDBACK_ORDER_REF_MAX_LENGTH).nullable().optional(),
  expectedResult: z.string().trim().max(CLIENT_FEEDBACK_MESSAGE_MAX_LENGTH).optional(),
  actualResult: z.string().trim().max(CLIENT_FEEDBACK_MESSAGE_MAX_LENGTH).optional(),
  reproductionSteps: z.string().trim().max(CLIENT_FEEDBACK_MESSAGE_MAX_LENGTH).nullable().optional(),
  contactPreference: z.string().trim().max(CLIENT_FEEDBACK_CONTACT_PREFERENCE_MAX_LENGTH).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(CLIENT_FEEDBACK_MAX_TAG_LENGTH)).max(CLIENT_FEEDBACK_MAX_TAGS).optional(),
  sourceLabel: z.string().trim().min(1).max(CLIENT_FEEDBACK_SOURCE_LABEL_MAX_LENGTH).optional(),
})

const updateInternalRemarkSchema = z.object({
  content: z.string().trim().max(CLIENT_FEEDBACK_INTERNAL_REMARK_MAX_LENGTH),
})

export const customerServiceRouter = Router()

customerServiceRouter.get(
  '/assignees',
  requirePermission('customer_service:view'),
  asyncHandler(async (_req, res) => {
    const data = await clientFeedbackService.listAssignableServiceUsers()
    res.json({ code: 0, message: 'ok', data })
  }),
)

customerServiceRouter.get(
  '/conversations',
  requirePermission('customer_service:view'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const query = listServiceConversationsSchema.parse(req.query)
    const data = await clientFeedbackService.listServiceConversations(
      {
        status: query.status,
        priority: query.priority,
        keyword: query.keyword,
        assignedToMe: query.assignedToMe,
        unreadOnly: query.unreadOnly,
        page: query.page ?? 1,
        pageSize: query.pageSize ?? 20,
      },
      authReq.auth,
    )
    res.json({ code: 0, message: 'ok', data })
  }),
)

customerServiceRouter.get(
  '/conversations/:id',
  requirePermission('customer_service:view'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const data = await clientFeedbackService.getServiceConversationDetail(req.params.id, authReq.auth)
    res.json({ code: 0, message: 'ok', data })
  }),
)

customerServiceRouter.post(
  '/conversations/:id/messages',
  requirePermission('customer_service:reply'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = appendMessageSchema.parse(req.body)
    const data = await clientFeedbackService.appendServiceMessage(
      req.params.id,
      payload,
      authReq.auth,
      extractRequestMeta(req),
    )
    res.json({ code: 0, message: 'ok', data })
  }),
)

customerServiceRouter.patch(
  '/conversations/:id/assignee',
  requirePermission('customer_service:reply'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = updateAssigneeSchema.parse(req.body)
    const data = await clientFeedbackService.updateConversationAssignee(
      req.params.id,
      payload,
      authReq.auth,
      extractRequestMeta(req),
    )
    res.json({ code: 0, message: 'ok', data })
  }),
)

customerServiceRouter.patch(
  '/conversations/:id/status',
  requirePermission('customer_service:reply'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = updateStatusSchema.parse(req.body)
    const data = await clientFeedbackService.updateConversationStatus(
      req.params.id,
      payload,
      authReq.auth,
      extractRequestMeta(req),
    )
    res.json({ code: 0, message: 'ok', data })
  }),
)

customerServiceRouter.patch(
  '/conversations/:id/fields',
  requirePermission('customer_service:reply'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = updateIssueFieldsSchema.parse(req.body)
    const data = await clientFeedbackService.updateConversationIssueFields(
      req.params.id,
      payload,
      authReq.auth,
      extractRequestMeta(req),
    )
    res.json({ code: 0, message: 'ok', data })
  }),
)

customerServiceRouter.put(
  '/conversations/:id/internal-remark',
  requirePermission('customer_service:reply'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = updateInternalRemarkSchema.parse(req.body)
    const data = await clientFeedbackService.updateConversationInternalRemark(
      req.params.id,
      payload,
      authReq.auth,
      extractRequestMeta(req),
    )
    res.json({ code: 0, message: 'ok', data })
  }),
)

customerServiceRouter.get(
  '/presence',
  requirePermission('customer_service:view'),
  asyncHandler(async (_req, res) => {
    const data = await clientFeedbackService.getServicePresence()
    res.json({ code: 0, message: 'ok', data })
  }),
)

customerServiceRouter.get(
  '/stream',
  requirePermission('customer_service:view'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    await clientFeedbackService.openServiceRealtimeChannel(authReq.auth, res)
  }),
)
