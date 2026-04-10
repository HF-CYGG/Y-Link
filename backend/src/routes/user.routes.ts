/**
 * 模块说明：backend/src/routes/user.routes.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { Router } from 'express'
import { z } from 'zod'
import type { AuthenticatedRequest } from '../types/auth.js'
import { USER_ROLES, USER_STATUSES } from '../types/auth.js'
import { requirePermission } from '../middleware/auth.middleware.js'
import { userService } from '../services/user.service.js'
import { asyncHandler } from '../utils/async-handler.js'
import { extractRequestMeta } from '../utils/request-meta.js'

const createUserSchema = z.object({
  username: z.string().min(1, '账号不能为空').max(64, '账号长度不能超过 64'),
  password: z.string().min(6, '密码长度至少为 6 位').max(50, '密码长度不能超过 50 位'),
  displayName: z.string().min(1, '姓名不能为空').max(64, '姓名长度不能超过 64'),
  role: z.enum(USER_ROLES),
  status: z.enum(USER_STATUSES).optional(),
})

const updateUserSchema = z
  .object({
    displayName: z.string().min(1, '姓名不能为空').max(64, '姓名长度不能超过 64').optional(),
    password: z.string().min(6, '密码长度至少为 6 位').max(50, '密码长度不能超过 50 位').optional(),
    role: z.enum(USER_ROLES).optional(),
  })
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    message: '至少提供一项可更新字段',
  })

const updateUserStatusSchema = z.object({
  status: z.enum(USER_STATUSES),
})

const resetPasswordSchema = z.object({
  newPassword: z.string().min(6, '新密码长度至少为 6 位').max(50, '新密码长度不能超过 50 位'),
})

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
export const userRouter = Router()

userRouter.get(
  '/',
  requirePermission('users:view'),
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
    })

    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

userRouter.post(
  '/',
  requirePermission('users:create'),
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
