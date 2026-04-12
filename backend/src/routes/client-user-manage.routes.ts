/**
 * 模块说明：backend/src/routes/client-user-manage.routes.ts
 * 文件职责：提供管理端对客户端用户的治理接口。
 * 维护说明：
 * - 客户端用户属于系统治理域，因此仍复用现有 users:* 权限点；
 * - 若后续需要更细粒度控制，可再独立拆分 client_users:* 权限模型。
 */

import { Router } from 'express'
import { z } from 'zod'
import type { AuthenticatedRequest } from '../types/auth.js'
import { requirePermission } from '../middleware/auth.middleware.js'
import { asyncHandler } from '../utils/async-handler.js'
import { extractRequestMeta } from '../utils/request-meta.js'
import { CLIENT_USER_STATUSES } from '../entities/client-user.entity.js'
import { clientUserManageService } from '../services/client-user-manage.service.js'

const updateClientUserStatusSchema = z.object({
  status: z.enum(CLIENT_USER_STATUSES),
})

const updateClientUserSchema = z.object({
  username: z.string().trim().min(1).max(128),
  mobile: z.string().trim().max(20).optional(),
  email: z.string().trim().max(128).optional(),
  departmentName: z.string().trim().max(128).optional(),
  status: z.enum(CLIENT_USER_STATUSES),
})

const resetClientUserPasswordSchema = z.object({
  newPassword: z.string().min(6, '新密码长度至少为 6 位').max(50, '新密码长度不能超过 50 位'),
})

export const clientUserManageRouter = Router()

clientUserManageRouter.get(
  '/',
  requirePermission('users:view'),
  asyncHandler(async (req, res) => {
    const page = Number(req.query.page ?? 1)
    const pageSize = Number(req.query.pageSize ?? 20)
    const status =
      typeof req.query.status === 'string' && CLIENT_USER_STATUSES.includes(req.query.status as (typeof CLIENT_USER_STATUSES)[number])
        ? (req.query.status as (typeof CLIENT_USER_STATUSES)[number])
        : undefined
    const data = await clientUserManageService.list({
      page: Number.isFinite(page) && page > 0 ? page : 1,
      pageSize: Number.isFinite(pageSize) && pageSize > 0 ? Math.min(pageSize, 100) : 20,
      keyword: typeof req.query.keyword === 'string' ? req.query.keyword : undefined,
      status,
    })
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

clientUserManageRouter.patch(
  '/:id',
  requirePermission('users:update'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = updateClientUserSchema.parse(req.body)
    const data = await clientUserManageService.updateProfile(req.params.id, payload, authReq.auth, extractRequestMeta(req))
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

clientUserManageRouter.patch(
  '/:id/status',
  requirePermission('users:status'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = updateClientUserStatusSchema.parse(req.body)
    const data = await clientUserManageService.updateStatus(req.params.id, payload.status, authReq.auth, extractRequestMeta(req))
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

clientUserManageRouter.post(
  '/:id/reset-password',
  requirePermission('users:reset_password'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = resetClientUserPasswordSchema.parse(req.body)
    const data = await clientUserManageService.resetPassword(req.params.id, payload, authReq.auth, extractRequestMeta(req))
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)
