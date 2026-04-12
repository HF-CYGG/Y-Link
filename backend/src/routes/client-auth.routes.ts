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
import { BizError } from '../utils/errors.js'
import { extractRequestMeta } from '../utils/request-meta.js'
import { clientAuthService } from '../services/client-auth.service.js'
import { authSecurityService } from '../services/auth-security.service.js'
import { verificationCodeService } from '../services/verification-code.service.js'

const registerSchema = z.object({
  account: z.string().trim().min(1),
  password: z.string().min(6),
  departmentName: z.string().optional(),
  verificationCode: z.string().trim().min(4).max(8).optional(),
  captchaId: z.string().trim().min(1).optional(),
  captchaCode: z.string().trim().min(1).optional(),
})

const loginSchema = z.object({
  account: z.string().trim().min(1),
  password: z.string().min(1),
  captchaId: z.string().trim().min(1).optional(),
  captchaCode: z.string().trim().min(1).optional(),
})

const forgotVerifySchema = z.object({
  account: z.string().trim().min(1),
  verificationCode: z.string().trim().min(4).max(8).optional(),
  captchaId: z.string().trim().min(1).optional(),
  captchaCode: z.string().trim().min(1).optional(),
})

const resetPasswordSchema = z.object({
  account: z.string().trim().min(1),
  resetToken: z.string().trim().min(1),
  newPassword: z.string().min(6),
})

const verificationCodeSendSchema = z.object({
  channel: z.enum(['mobile', 'email']),
  target: z.string().trim().min(1),
  scene: z.enum(['register', 'forgot_password']),
})

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6),
})

const updateProfileSchema = z.object({
  username: z.string().trim().min(1).max(128),
  mobile: z.string().trim().max(20).optional(),
  email: z.string().trim().max(128).optional(),
  departmentName: z.string().trim().max(128).optional(),
})

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
export const clientAuthRouter = Router()

clientAuthRouter.get(
  '/captcha',
  asyncHandler(async (req, res) => {
    const data = await clientAuthService.createCaptcha(extractRequestMeta(req))
    res.json({ code: 0, message: 'ok', data })
  }),
)

clientAuthRouter.get(
  '/capabilities',
  asyncHandler(async (_req, res) => {
    const data = await clientAuthService.getCapabilities()
    res.json({ code: 0, message: 'ok', data })
  }),
)

clientAuthRouter.post(
  '/verification-code/send',
  asyncHandler(async (req, res) => {
    const payload = verificationCodeSendSchema.parse(req.body)
    const requestMeta = extractRequestMeta(req)
    if (payload.scene === 'forgot_password') {
      const capabilities = await clientAuthService.getCapabilities()
      if (!capabilities.forgotPasswordEnabled) {
        throw new BizError('当前系统未同时启用手机与邮箱验证码，暂不支持自助找回密码，请联系管理员手动修改密码', 400)
      }
    }
    await authSecurityService.guardVerificationCodeSendRequest(requestMeta, payload.target, payload.channel)
    const data = await verificationCodeService.sendCode({
      channel: payload.channel,
      target: payload.target,
      scene: payload.scene,
      requestMeta,
    })
    res.json({ code: 0, message: 'ok', data })
  }),
)

clientAuthRouter.post(
  '/register',
  asyncHandler(async (req, res) => {
    const payload = registerSchema.parse(req.body)
    const requestMeta = extractRequestMeta(req)
    await authSecurityService.guardClientRegisterRequest(requestMeta, payload.account)
    const data = await clientAuthService.register(payload, requestMeta)
    res.json({ code: 0, message: 'ok', data })
  }),
)

clientAuthRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const payload = loginSchema.parse(req.body)
    const requestMeta = extractRequestMeta(req)
    await authSecurityService.guardClientLoginRequest(requestMeta, payload.account)
    const data = await clientAuthService.login(payload, requestMeta)
    res.json({ code: 0, message: 'ok', data })
  }),
)

clientAuthRouter.post(
  '/forgot-password/verify',
  asyncHandler(async (req, res) => {
    const payload = forgotVerifySchema.parse(req.body)
    const requestMeta = extractRequestMeta(req)
    await authSecurityService.guardClientForgotVerifyRequest(requestMeta, payload.account)
    const data = await clientAuthService.verifyForgotPassword(payload, requestMeta)
    res.json({ code: 0, message: 'ok', data })
  }),
)

clientAuthRouter.post(
  '/forgot-password/reset',
  asyncHandler(async (req, res) => {
    const payload = resetPasswordSchema.parse(req.body)
    const requestMeta = extractRequestMeta(req)
    await authSecurityService.guardClientForgotResetRequest(requestMeta, payload.account)
    await clientAuthService.resetPassword(payload, requestMeta)
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

clientAuthRouter.patch(
  '/profile',
  requireClientAuth,
  asyncHandler(async (req, res) => {
    const authReq = req as ClientAuthenticatedRequest
    const data = await clientAuthService.updateProfile(authReq.clientAuth, updateProfileSchema.parse(req.body))
    res.json({ code: 0, message: 'ok', data })
  }),
)
