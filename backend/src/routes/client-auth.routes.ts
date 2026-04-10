/**
 * 模块说明：backend/src/routes/client-auth.routes.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { Router } from 'express'
import { z } from 'zod'
import { requireClientAuth } from '../middleware/client-auth.middleware.js'
import type { ClientAuthenticatedRequest } from '../types/client-auth.js'
import { asyncHandler } from '../utils/async-handler.js'
import { clientAuthService } from '../services/client-auth.service.js'

const registerSchema = z.object({
  mobile: z.string().trim().min(1),
  password: z.string().min(6),
  realName: z.string().trim().min(1),
  departmentName: z.string().optional(),
  captchaId: z.string().trim().min(1),
  captchaCode: z.string().trim().min(1),
})

const loginSchema = z.object({
  mobile: z.string().trim().min(1),
  password: z.string().min(1),
  captchaId: z.string().trim().min(1),
  captchaCode: z.string().trim().min(1),
})

const forgotVerifySchema = z.object({
  mobile: z.string().trim().min(1),
  captchaId: z.string().trim().min(1),
  captchaCode: z.string().trim().min(1),
})

const resetPasswordSchema = z.object({
  mobile: z.string().trim().min(1),
  resetToken: z.string().trim().min(1),
  newPassword: z.string().min(6),
})

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6),
})

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
export const clientAuthRouter = Router()

clientAuthRouter.get(
  '/captcha',
  asyncHandler(async (_req, res) => {
    const data = await clientAuthService.createCaptcha()
    res.json({ code: 0, message: 'ok', data })
  }),
)

clientAuthRouter.post(
  '/register',
  asyncHandler(async (req, res) => {
    const data = await clientAuthService.register(registerSchema.parse(req.body))
    res.json({ code: 0, message: 'ok', data })
  }),
)

clientAuthRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const data = await clientAuthService.login(loginSchema.parse(req.body))
    res.json({ code: 0, message: 'ok', data })
  }),
)

clientAuthRouter.post(
  '/forgot-password/verify',
  asyncHandler(async (req, res) => {
    const data = await clientAuthService.verifyForgotPassword(forgotVerifySchema.parse(req.body))
    res.json({ code: 0, message: 'ok', data })
  }),
)

clientAuthRouter.post(
  '/forgot-password/reset',
  asyncHandler(async (req, res) => {
    await clientAuthService.resetPassword(resetPasswordSchema.parse(req.body))
    res.json({ code: 0, message: 'ok', data: true })
  }),
)

clientAuthRouter.get(
  '/me',
  requireClientAuth,
  asyncHandler(async (req, res) => {
    const authReq = req as ClientAuthenticatedRequest
    const data = await clientAuthService.me(authReq.clientAuth)
    res.json({ code: 0, message: 'ok', data })
  }),
)

clientAuthRouter.post(
  '/logout',
  requireClientAuth,
  asyncHandler(async (req, res) => {
    const authReq = req as ClientAuthenticatedRequest
    await clientAuthService.logout(authReq.clientAuth)
    res.json({ code: 0, message: 'ok', data: true })
  }),
)

clientAuthRouter.post(
  '/change-password',
  requireClientAuth,
  asyncHandler(async (req, res) => {
    const authReq = req as ClientAuthenticatedRequest
    await clientAuthService.changePassword(authReq.clientAuth, changePasswordSchema.parse(req.body))
    res.json({ code: 0, message: 'ok', data: true })
  }),
)
