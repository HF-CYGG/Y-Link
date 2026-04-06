import { Router } from 'express'
import { z } from 'zod'
import type { AuthenticatedRequest } from '../types/auth.js'
import { requireAuth } from '../middleware/auth.middleware.js'
import { asyncHandler } from '../utils/async-handler.js'
import { extractRequestMeta } from '../utils/request-meta.js'
import { authService } from '../services/auth.service.js'

const loginSchema = z.object({
  username: z.string().min(1, '账号不能为空'),
  password: z.string().min(1, '密码不能为空'),
})

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, '当前密码不能为空'),
  newPassword: z.string().min(6, '新密码长度至少为 6 位').max(50, '新密码长度不能超过 50 位'),
})

export const authRouter = Router()

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const payload = loginSchema.parse(req.body)
    const data = await authService.login(payload, extractRequestMeta(req))
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

authRouter.post(
  '/logout',
  requireAuth,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    await authService.logout(authReq.auth, extractRequestMeta(req))
    res.json({
      code: 0,
      message: 'ok',
      data: true,
    })
  }),
)

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const data = await authService.me(authReq.auth)
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

authRouter.post(
  '/change-password',
  requireAuth,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = changePasswordSchema.parse(req.body)
    await authService.changeOwnPassword(authReq.auth, payload, extractRequestMeta(req))
    res.json({
      code: 0,
      message: 'ok',
      data: true,
    })
  }),
)
