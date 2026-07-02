/**
 * 文件说明：客户端用户管理路由，提供后台对客户端账号的查询、状态治理和资料维护接口。
 * 实现逻辑：沿用后台鉴权与 users:* 权限体系，在路由层校验客户端用户状态等参数后调用治理服务完成操作。
 * 维护重点：若后续拆分独立的客户端用户权限模型，需要同步调整本路由的权限点映射和前端管理入口。
 */

import { Router } from 'express'
import { z } from 'zod'
import type { AuthenticatedRequest } from '../types/auth.js'
import { requirePermission, requireRole } from '../middleware/auth.middleware.js'
import { asyncHandler } from '../utils/async-handler.js'
import { extractRequestMeta } from '../utils/request-meta.js'
import { CLIENT_USER_ACCOUNT_TYPES, CLIENT_USER_STATUSES } from '../entities/client-user.entity.js'
import { CLIENT_USER_PROFILE_KINDS, clientUserManageService } from '../services/client-user-manage.service.js'

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

const createClientUserSchema = z.object({
  profileKind: z.enum(CLIENT_USER_PROFILE_KINDS).optional(),
  username: z.string().trim().max(128).optional(),
  mobile: z.string().trim().max(20).optional(),
  email: z.string().trim().max(128).optional(),
  departmentName: z.string().trim().max(128).optional(),
  staffNo: z.string().trim().max(64).optional(),
  password: z.string().min(8, '登录密码至少 8 位').max(50, '登录密码长度不能超过 50 位'),
  status: z.enum(CLIENT_USER_STATUSES),
})

const resetClientUserPasswordSchema = z.object({
  newPassword: z.string().min(8, '新密码至少 8 位').max(50, '新密码长度不能超过 50 位'),
})

export const clientUserManageRouter = Router()

clientUserManageRouter.get(
  '/',
  requirePermission('users:view'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const page = Number(req.query.page ?? 1)
    const pageSize = Number(req.query.pageSize ?? 20)
    const status =
      typeof req.query.status === 'string' && CLIENT_USER_STATUSES.includes(req.query.status as (typeof CLIENT_USER_STATUSES)[number])
        ? (req.query.status as (typeof CLIENT_USER_STATUSES)[number])
        : undefined
    const accountType =
      typeof req.query.accountType === 'string'
      && CLIENT_USER_ACCOUNT_TYPES.includes(req.query.accountType as (typeof CLIENT_USER_ACCOUNT_TYPES)[number])
        ? (req.query.accountType as (typeof CLIENT_USER_ACCOUNT_TYPES)[number])
        : undefined
    const profileKind =
      typeof req.query.profileKind === 'string'
      && CLIENT_USER_PROFILE_KINDS.includes(req.query.profileKind as (typeof CLIENT_USER_PROFILE_KINDS)[number])
        ? (req.query.profileKind as (typeof CLIENT_USER_PROFILE_KINDS)[number])
        : undefined
    const data = await clientUserManageService.list({
      page: Number.isFinite(page) && page > 0 ? page : 1,
      pageSize: Number.isFinite(pageSize) && pageSize > 0 ? Math.min(pageSize, 100) : 20,
      keyword: typeof req.query.keyword === 'string' ? req.query.keyword : undefined,
      status,
      accountType,
      profileKind,
      departmentName: typeof req.query.departmentName === 'string' ? req.query.departmentName : undefined,
      staffNo: typeof req.query.staffNo === 'string' ? req.query.staffNo : undefined,
    })
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

clientUserManageRouter.post(
  '/',
  requirePermission('users:create'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = createClientUserSchema.parse(req.body)
    const data = await clientUserManageService.createProfile(payload, authReq.auth, extractRequestMeta(req))
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
  requireRole('admin'),
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
  requireRole('admin'),
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
  requireRole('admin'),
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
