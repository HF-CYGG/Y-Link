import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { AppDataSource } from '../config/data-source.js'
import type { AuthenticatedRequest } from '../types/auth.js'
import { USER_ROLES, USER_STATUSES } from '../types/auth.js'
import { requirePermission, requireRole } from '../middleware/auth.middleware.js'
import { userService } from '../services/user.service.js'
import { auditService } from '../services/audit.service.js'
import { DatabaseRateLimitStore } from '../services/persistent-risk-state.service.js'
import { asyncHandler } from '../utils/async-handler.js'
import { extractRequestMeta } from '../utils/request-meta.js'
import { createPermanentDeletePasswordGuard } from '../utils/permanent-delete-guard.js'
import { adminWebauthnService } from '../services/admin-webauthn.service.js'
import { existingPasswordInput } from '../constants/auth-input-limits.js'

const createUserSchema = z.object({
  username: z.string().min(1, '账号不能为空').max(64, '账号长度不能超过 64'),
  password: z.string().min(8, '密码至少 8 位').max(64, '密码长度不能超过 64 位'),
  displayName: z.string().min(1, '姓名不能为空').max(64, '姓名长度不能超过 64'),
  email: z.string().trim().max(128, '邮箱长度不能超过 128').optional(),
  role: z.enum(USER_ROLES),
  status: z.enum(USER_STATUSES).optional(),
})

const updateUserSchema = z
  .object({
    displayName: z.string().min(1, '姓名不能为空').max(64, '姓名长度不能超过 64').optional(),
    email: z.string().trim().max(128, '邮箱长度不能超过 128').optional(),
    password: z.string().min(8, '密码至少 8 位').max(64, '密码长度不能超过 64 位').optional(),
    role: z.enum(USER_ROLES).optional(),
  })
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    message: '至少提供一项可更新字段',
  })

const updateUserStatusSchema = z.object({
  status: z.enum(USER_STATUSES),
})

const resetPasswordSchema = z.object({
  newPassword: z.string().min(8, '新密码至少 8 位').max(64, '新密码长度不能超过 64 位'),
})

const resetWebauthnSchema = z.object({
  currentPassword: existingPasswordInput('当前密码'),
  code: z.string().trim().max(16).optional(),
  recoveryCode: z.string().trim().max(32).optional(),
  stepUpProof: z.string().trim().min(1).max(128).optional(),
  reason: z.string().trim().min(1, '请输入撤销原因').max(500, '撤销原因不能超过 500 字'),
})
const resetMfaSchema = resetWebauthnSchema.omit({ reason: true })

const accountLifecycleReasonSchema = z.object({
  reason: z.string().trim().min(2, '原因至少 2 个字符').max(500, '原因不能超过 500 个字符'),
})

const accountPermanentDeleteSchema = accountLifecycleReasonSchema.extend({
  confirmAccount: z.string().min(1, '请输入目标账号').max(128, '确认账号长度不能超过 128 个字符'),
  permanentDeletePassword: z.string().min(1, '请输入永久删除密码').max(256, '永久删除密码长度非法'),
})

const permanentDeleteLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => `sys-user:${(req as AuthenticatedRequest).auth.userId ?? 'unknown'}:${String(req.params.id ?? '')}`,
  ...(AppDataSource.options.type === 'mysql'
    ? { store: new DatabaseRateLimitStore('express-sys-user-permanent-delete') }
    : {}),
  handler: async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const targetId = String(req.params.id ?? '').trim().slice(0, 64)
    await auditService.safeRecord({
      actionType: 'user.permanent_delete',
      actionLabel: '永久删除管理端用户（频控拦截）',
      targetType: 'user',
      targetId: targetId || null,
      actor: authReq.auth,
      requestMeta: extractRequestMeta(req),
      resultStatus: 'failed',
      detail: { reason: 'rate_limited' },
    })
    res.status(429).json({ code: 429, message: '永久删除请求过于频繁，请稍后再试', data: null })
  },
})

// 永久删除口令为全局口令：再接入所有入口共享的口令失败桶，避免轮换入口叠加试错额度。
const permanentDeletePasswordGuard = createPermanentDeletePasswordGuard({
  actionType: 'user.permanent_delete',
  actionLabel: '永久删除管理端用户',
  targetType: 'user',
})

export const userRouter = Router()

userRouter.get(
  '/',
  requirePermission('users:view'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const page = Number(req.query.page ?? 1)
    const pageSize = Number(req.query.pageSize ?? 20)
    const data = await userService.list({
      page: Number.isFinite(page) && page > 0 ? page : 1,
      pageSize: Number.isFinite(pageSize) && pageSize > 0 ? Math.min(pageSize, 100) : 20,
      keyword: typeof req.query.keyword === 'string' ? req.query.keyword : undefined,
      role: typeof req.query.role === 'string' && USER_ROLES.includes(req.query.role as (typeof USER_ROLES)[number])
        ? (req.query.role as (typeof USER_ROLES)[number])
        : undefined,
      status:
        typeof req.query.status === 'string' && USER_STATUSES.includes(req.query.status as (typeof USER_STATUSES)[number])
          ? (req.query.status as (typeof USER_STATUSES)[number])
          : undefined,
      accountState:
        typeof req.query.accountState === 'string'
        && ['enabled', 'disabled', 'deactivated'].includes(req.query.accountState)
          ? (req.query.accountState as 'enabled' | 'disabled' | 'deactivated')
          : undefined,
    })

    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

userRouter.get(
  '/:id/deactivation-preview',
  requirePermission('users:deactivate'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const data = await userService.previewDeactivation(req.params.id, authReq.auth)
    res.json({ code: 0, message: 'ok', data })
  }),
)

userRouter.post(
  '/:id/deactivate',
  requirePermission('users:deactivate'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = accountLifecycleReasonSchema.parse(req.body)
    const data = await userService.deactivate(req.params.id, payload, authReq.auth, extractRequestMeta(req))
    res.json({ code: 0, message: 'ok', data })
  }),
)

userRouter.post(
  '/:id/restore',
  requirePermission('users:deactivate'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = accountLifecycleReasonSchema.parse(req.body)
    const data = await userService.restore(req.params.id, payload, authReq.auth, extractRequestMeta(req))
    res.json({ code: 0, message: 'ok', data })
  }),
)

userRouter.delete(
  '/:id/permanent',
  requirePermission('users:permanent_delete'),
  requireRole('admin'),
  permanentDeleteLimiter,
  permanentDeletePasswordGuard,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = accountPermanentDeleteSchema.parse(req.body)
    const data = await userService.permanentDelete(req.params.id, payload, authReq.auth, extractRequestMeta(req))
    res.json({ code: 0, message: 'ok', data })
  }),
)

userRouter.post(
  '/',
  requirePermission('users:create'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = createUserSchema.parse(req.body)
    const data = await userService.create(payload, authReq.auth, extractRequestMeta(req))
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

userRouter.put(
  '/:id',
  requirePermission('users:update'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = updateUserSchema.parse(req.body)
    const data = await userService.update(req.params.id, payload, authReq.auth, extractRequestMeta(req))
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

userRouter.patch(
  '/:id/status',
  requirePermission('users:status'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = updateUserStatusSchema.parse(req.body)
    const data = await userService.updateStatus(req.params.id, payload.status, authReq.auth, extractRequestMeta(req))
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

userRouter.post(
  '/:id/reset-password',
  requirePermission('users:reset_password'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = resetPasswordSchema.parse(req.body)
    const data = await userService.resetPassword(req.params.id, payload, authReq.auth, extractRequestMeta(req))
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

// 重置他人两步验证：与重置密码同一权限点，仅管理员可用。
userRouter.post(
  '/:id/mfa/reset',
  requirePermission('users:reset_password'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = resetMfaSchema.parse(req.body)
    const data = await userService.resetMfa(req.params.id, authReq.auth, payload, extractRequestMeta(req))
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

userRouter.post('/:id/webauthn/reset', requirePermission('users:reset_password'), requireRole('admin'), asyncHandler(async (req, res) => {
  const authReq = req as AuthenticatedRequest
  const payload = resetWebauthnSchema.parse(req.body)
  const data = await adminWebauthnService.resetUserCredentials(req.params.id, authReq.auth, payload, extractRequestMeta(req))
  res.setHeader('Cache-Control', 'no-store')
  res.json({ code: 0, message: 'ok', data })
}))
