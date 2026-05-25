/**
 * 模块说明：backend/src/routes/client-feedback.routes.ts
 * 文件职责：提供客户端反馈中心接口，覆盖入口配置读取、会话列表、详情、留言、附件上传、满意度评价与实时 SSE 订阅。
 * 实现逻辑：
 * - 所有接口都走客户端鉴权，确保客户端只能访问自己的反馈会话；
 * - 反馈入口配置单独暴露为轻量接口，便于客户端页面按配置决定是否展示入口与提示语；
 * - 附件上传与满意度评价都继续收口在同一路由域下，减少客户端跨模块鉴权差异；
 * - 实时通道采用 SSE，便于浏览器直接接入且不额外引入复杂协议栈。
 * 维护说明：
 * - 若后续需要扩展更多附件类型，请同步调整 multer 白名单、前端上传提示与服务层附件校验；
 * - 若客户端需要按未读状态筛选，可继续在 query schema 中补字段并下沉到服务层。
 */

import { Router } from 'express'
import { z } from 'zod'
import { requireClientAuth } from '../middleware/client-auth.middleware.js'
import type { ClientAuthenticatedRequest } from '../types/client-auth.js'
import { asyncHandler } from '../utils/async-handler.js'
import { extractRequestMeta } from '../utils/request-meta.js'
import {
  CLIENT_FEEDBACK_CONVERSATION_STATUSES,
  CLIENT_FEEDBACK_ISSUE_TYPES,
  CLIENT_FEEDBACK_PRIORITIES,
  CLIENT_FEEDBACK_SATISFACTION_LEVELS,
} from '../entities/client-feedback-conversation.entity.js'
import {
  clientFeedbackService,
  CLIENT_FEEDBACK_ATTACHMENT_MIME_TYPE_MAX_LENGTH,
  CLIENT_FEEDBACK_ATTACHMENT_NAME_MAX_LENGTH,
  CLIENT_FEEDBACK_ATTACHMENT_URL_MAX_LENGTH,
  CLIENT_FEEDBACK_CONTACT_PREFERENCE_MAX_LENGTH,
  CLIENT_FEEDBACK_MAX_ATTACHMENTS_PER_MESSAGE,
  CLIENT_FEEDBACK_CATEGORY_MAX_LENGTH,
  CLIENT_FEEDBACK_MESSAGE_MAX_LENGTH,
  CLIENT_FEEDBACK_MAX_TAG_LENGTH,
  CLIENT_FEEDBACK_MAX_TAGS,
  CLIENT_FEEDBACK_ORDER_REF_MAX_LENGTH,
  CLIENT_FEEDBACK_SATISFACTION_COMMENT_MAX_LENGTH,
  CLIENT_FEEDBACK_SOURCE_LABEL_MAX_LENGTH,
  CLIENT_FEEDBACK_SUBJECT_MAX_LENGTH,
} from '../services/client-feedback.service.js'
import { BizError } from '../utils/errors.js'
import {
  buildUploadPublicUrl,
  createCategorizedImageUpload,
  finalizeUploadedImageFile,
} from '../utils/upload-storage.js'

/**
 * 客户端会话列表分页上限：
 * - 需与前端共享反馈 API 使用的 pageSize 保持一致；
 * - 统一放宽到 100 条，避免客户端首页加载历史会话时被路由层 400 拦截。
 */
const CLIENT_FEEDBACK_LIST_PAGE_SIZE_MAX = 100

const listMyConversationsSchema = z.object({
  status: z.enum(CLIENT_FEEDBACK_CONVERSATION_STATUSES).optional(),
  keyword: z.string().trim().max(64).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(CLIENT_FEEDBACK_LIST_PAGE_SIZE_MAX).optional(),
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

const createConversationSchema = z.object({
  issueType: z.enum(CLIENT_FEEDBACK_ISSUE_TYPES).optional(),
  category: z.string().trim().min(1).max(CLIENT_FEEDBACK_CATEGORY_MAX_LENGTH).optional(),
  subject: z.string().trim().min(1).max(CLIENT_FEEDBACK_SUBJECT_MAX_LENGTH),
  priority: z.enum(CLIENT_FEEDBACK_PRIORITIES).optional(),
  content: z.string().trim().min(1).max(CLIENT_FEEDBACK_MESSAGE_MAX_LENGTH),
  orderRef: z.string().trim().max(CLIENT_FEEDBACK_ORDER_REF_MAX_LENGTH).optional(),
  expectedResult: z.string().trim().max(CLIENT_FEEDBACK_MESSAGE_MAX_LENGTH).optional(),
  actualResult: z.string().trim().max(CLIENT_FEEDBACK_MESSAGE_MAX_LENGTH).optional(),
  reproductionSteps: z.string().trim().max(CLIENT_FEEDBACK_MESSAGE_MAX_LENGTH).optional(),
  contactPreference: z.string().trim().max(CLIENT_FEEDBACK_CONTACT_PREFERENCE_MAX_LENGTH).optional(),
  tags: z.array(z.string().trim().min(1).max(CLIENT_FEEDBACK_MAX_TAG_LENGTH)).max(CLIENT_FEEDBACK_MAX_TAGS).optional(),
  sourceLabel: z.string().trim().min(1).max(CLIENT_FEEDBACK_SOURCE_LABEL_MAX_LENGTH).optional(),
  attachments: z.array(feedbackAttachmentSchema).max(CLIENT_FEEDBACK_MAX_ATTACHMENTS_PER_MESSAGE).optional(),
})

const appendMessageSchema = z.object({
  content: z.string().trim().min(1).max(CLIENT_FEEDBACK_MESSAGE_MAX_LENGTH),
  attachments: z.array(feedbackAttachmentSchema).max(CLIENT_FEEDBACK_MAX_ATTACHMENTS_PER_MESSAGE).optional(),
})

const submitSatisfactionSchema = z.object({
  level: z.enum(CLIENT_FEEDBACK_SATISFACTION_LEVELS),
  comment: z.string().trim().max(CLIENT_FEEDBACK_SATISFACTION_COMMENT_MAX_LENGTH).optional(),
})

/**
 * 客户端反馈附件仍沿用本地磁盘 + 静态资源 URL 方案：
 * - 先满足截图、界面异常凭证等高频图片证据场景；
 * - 反馈截图单独落在 `uploads/client-feedback`，避免和商品图片混放。
 */
const feedbackAttachmentUpload = createCategorizedImageUpload('client-feedback')

export const clientFeedbackRouter = Router()
const authenticatedClientFeedbackRouter = Router()

clientFeedbackRouter.get(
  '/portal-config',
  asyncHandler(async (_req, res) => {
    const data = await clientFeedbackService.getPortalConfigs()
    res.json({ code: 0, message: 'ok', data })
  }),
)

authenticatedClientFeedbackRouter.use(requireClientAuth)

authenticatedClientFeedbackRouter.get(
  '/conversations',
  asyncHandler(async (req, res) => {
    const authReq = req as ClientAuthenticatedRequest
    const query = listMyConversationsSchema.parse(req.query)
    const data = await clientFeedbackService.listMyConversations(authReq.clientAuth, {
      status: query.status,
      keyword: query.keyword,
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 20,
    })
    res.json({ code: 0, message: 'ok', data })
  }),
)

authenticatedClientFeedbackRouter.post(
  '/attachments',
  feedbackAttachmentUpload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      throw new BizError('文件上传失败', 400)
    }
    // 反馈附件同样需要先经过真实图片内容校验，再生成可回填数据库的正式 URL。
    const finalizedFile = await finalizeUploadedImageFile('client-feedback', req.file)
    res.json({
      code: 0,
      message: 'ok',
      data: {
        attachment: {
          name: req.file.originalname,
          url: buildUploadPublicUrl('client-feedback', finalizedFile.fileName),
          mimeType: finalizedFile.mimeType || null,
          size: typeof finalizedFile.size === 'number' ? finalizedFile.size : null,
        },
      },
    })
  }),
)

authenticatedClientFeedbackRouter.post(
  '/conversations',
  asyncHandler(async (req, res) => {
    const authReq = req as ClientAuthenticatedRequest
    const payload = createConversationSchema.parse(req.body)
    const data = await clientFeedbackService.createConversation(payload, authReq.clientAuth, extractRequestMeta(req))
    res.json({ code: 0, message: 'ok', data })
  }),
)

authenticatedClientFeedbackRouter.get(
  '/conversations/:id',
  asyncHandler(async (req, res) => {
    const authReq = req as ClientAuthenticatedRequest
    const data = await clientFeedbackService.getMyConversationDetail(authReq.clientAuth, req.params.id)
    res.json({ code: 0, message: 'ok', data })
  }),
)

authenticatedClientFeedbackRouter.post(
  '/conversations/:id/messages',
  asyncHandler(async (req, res) => {
    const authReq = req as ClientAuthenticatedRequest
    const payload = appendMessageSchema.parse(req.body)
    const data = await clientFeedbackService.appendClientMessage(
      req.params.id,
      payload,
      authReq.clientAuth,
      extractRequestMeta(req),
    )
    res.json({ code: 0, message: 'ok', data })
  }),
)

authenticatedClientFeedbackRouter.patch(
  '/conversations/:id/confirm-resolved',
  asyncHandler(async (req, res) => {
    const authReq = req as ClientAuthenticatedRequest
    const data = await clientFeedbackService.confirmConversationResolvedByClient(
      req.params.id,
      authReq.clientAuth,
      extractRequestMeta(req),
    )
    res.json({ code: 0, message: 'ok', data })
  }),
)

authenticatedClientFeedbackRouter.post(
  '/conversations/:id/satisfaction',
  asyncHandler(async (req, res) => {
    const authReq = req as ClientAuthenticatedRequest
    const payload = submitSatisfactionSchema.parse(req.body)
    const data = await clientFeedbackService.submitConversationSatisfactionByClient(
      req.params.id,
      payload,
      authReq.clientAuth,
      extractRequestMeta(req),
    )
    res.json({ code: 0, message: 'ok', data })
  }),
)

authenticatedClientFeedbackRouter.get(
  '/stream',
  asyncHandler(async (req, res) => {
    const authReq = req as ClientAuthenticatedRequest
    await clientFeedbackService.openClientRealtimeChannel(authReq.clientAuth, res)
  }),
)

clientFeedbackRouter.use(authenticatedClientFeedbackRouter)
