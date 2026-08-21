/**
 * 模块说明：backend/src/routes/mobile-auth.routes.ts
 * 文件职责：暴露 `/api/v1/mobile-auth` Native Bearer Auth HTTP Contract。
 * 实现逻辑：公开端点只解析 body 并复用现有认证能力；受保护端点统一经 requireMobileAuth，
 * 不读取 Cookie、不启用 CSRF，也不接受 URL query token。
 * 维护说明：路由只负责 schema/HTTP 映射；refresh 状态机与撤销事务必须留在服务层。
 */
import { Router } from 'express'
import { z } from 'zod'
import { readRequiredMobileBearer, requireMobileAuth } from '../middleware/mobile-auth.middleware.js'
import { authSecurityService } from '../services/auth-security.service.js'
import { clientAuthService } from '../services/client-auth.service.js'
import { mobileAuthService } from '../services/mobile-auth.service.js'
import { mobileSessionService, MOBILE_DEVICE_ID_PATTERN } from '../services/mobile-session.service.js'
import { verificationCodeService } from '../services/verification-code.service.js'
import type { MobileAuthenticatedRequest } from '../types/mobile-auth.js'
import { asyncHandler } from '../utils/async-handler.js'
import { normalizeClientVerificationTarget } from '../utils/client-auth-account.js'
import { BizError } from '../utils/errors.js'
import {
  CLIENT_PASSWORD_POLICY_MIN_LENGTH,
  getClientPasswordPolicyMessage,
  isClientPasswordPolicySatisfied,
} from '../utils/password.js'
import { extractRequestMeta } from '../utils/request-meta.js'

const passwordSchema = (label = '密码') => z.string()
  .min(CLIENT_PASSWORD_POLICY_MIN_LENGTH, getClientPasswordPolicyMessage(label))
  .refine(isClientPasswordPolicySatisfied, getClientPasswordPolicyMessage(label))

const deviceSchema = z.object({
  deviceId: z.string().trim().regex(MOBILE_DEVICE_ID_PATTERN, 'deviceId 格式不正确'),
  deviceName: z.string().trim().min(1).max(64).optional(),
  platform: z.enum(['android', 'ios']),
  appVersion: z.string().trim().min(1).max(32).optional(),
})

const refreshDeviceSchema = deviceSchema.pick({ deviceId: true, appVersion: true })

const loginSchema = z.object({
  account: z.string().trim().min(1).max(128),
  password: z.string().min(1),
  captchaId: z.string().trim().min(1).optional(),
  captchaCode: z.string().trim().min(1).optional(),
  device: deviceSchema,
})

const registerSchema = z.object({
  username: z.string().trim().max(128).optional(),
  account: z.string().trim().max(128).optional(),
  accountType: z.literal('personal'),
  staffNo: z.string().trim().max(64).optional(),
  inviteCode: z.string().trim().min(1).max(32).optional(),
  departmentName: z.string().trim().max(128).optional(),
  password: passwordSchema(),
  verificationCode: z.string().trim().min(4).max(8).optional(),
  captchaId: z.string().trim().min(1).optional(),
  captchaCode: z.string().trim().min(1).optional(),
  device: deviceSchema,
})

const refreshSchema = z.object({
  refreshToken: z.string().trim().min(1).max(128),
  device: refreshDeviceSchema,
})

const verificationCodeSchema = z.object({
  channel: z.enum(['mobile', 'email']),
  target: z.string().trim().min(1).max(128),
  scene: z.enum(['register', 'forgot_password']),
  captchaId: z.string().trim().min(1),
  captchaCode: z.string().trim().min(1),
})

const forgotVerifySchema = z.object({
  account: z.string().trim().min(1),
  verificationCode: z.string().trim().min(4).max(8).optional(),
  captchaId: z.string().trim().min(1).optional(),
  captchaCode: z.string().trim().min(1).optional(),
})

const resetSchema = z.object({
  account: z.string().trim().min(1),
  resetToken: z.string().trim().min(1),
  newPassword: passwordSchema('新密码'),
})

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema('新密码'),
  device: deviceSchema,
})

const profileSchema = z.object({
  username: z.string().trim().min(1).max(128),
  mobile: z.string().trim().max(20).optional(),
  email: z.string().trim().max(128).optional(),
  currentPassword: z.string().min(1),
  mobileVerificationCode: z.string().trim().min(4).max(8).optional(),
  emailVerificationCode: z.string().trim().min(4).max(8).optional(),
})

const logoutScopeSchema = z.enum(['all', 'others']).default('all')

export const mobileAuthRouter = Router()

mobileAuthRouter.get('/captcha', asyncHandler(async (req, res) => {
  const data = await clientAuthService.createCaptcha(extractRequestMeta(req))
  res.json({ code: 0, message: 'ok', data })
}))

mobileAuthRouter.get('/capabilities', asyncHandler(async (_req, res) => {
  const data = await clientAuthService.getCapabilities()
  res.json({ code: 0, message: 'ok', data })
}))

mobileAuthRouter.post('/verification-code', asyncHandler(async (req, res) => {
  const payload = verificationCodeSchema.parse(req.body)
  const requestMeta = extractRequestMeta(req)
  const target = normalizeClientVerificationTarget(payload.channel, payload.target)
  clientAuthService.verifyCaptchaBeforeVerificationSend(payload)
  if (payload.scene === 'forgot_password') {
    const capabilities = await clientAuthService.getCapabilities()
    if (!capabilities.forgotPasswordEnabled) {
      throw new BizError('当前系统暂不支持自助找回密码，请联系管理员', 400)
    }
  }
  await authSecurityService.guardVerificationCodeSendRequest(requestMeta, target, payload.channel)
  const data = await verificationCodeService.sendCode({
    channel: payload.channel,
    target,
    scene: payload.scene,
    requestMeta,
  })
  res.json({ code: 0, message: 'ok', data })
}))

mobileAuthRouter.post('/register', asyncHandler(async (req, res) => {
  const data = await mobileAuthService.register(registerSchema.parse(req.body), extractRequestMeta(req))
  res.json({ code: 0, message: 'ok', data })
}))

mobileAuthRouter.post('/login', asyncHandler(async (req, res) => {
  const data = await mobileAuthService.login(loginSchema.parse(req.body), extractRequestMeta(req))
  res.json({ code: 0, message: 'ok', data })
}))

mobileAuthRouter.post('/refresh', asyncHandler(async (req, res) => {
  const payload = refreshSchema.parse(req.body)
  const data = await mobileAuthService.refresh(payload.refreshToken, payload.device, extractRequestMeta(req))
  res.json({ code: 0, message: 'ok', data })
}))

mobileAuthRouter.post('/forgot-password/verify', asyncHandler(async (req, res) => {
  const data = await mobileAuthService.verifyForgotPassword(forgotVerifySchema.parse(req.body), extractRequestMeta(req))
  res.json({ code: 0, message: 'ok', data })
}))

mobileAuthRouter.post('/forgot-password/reset', asyncHandler(async (req, res) => {
  const data = await mobileAuthService.resetPassword(resetSchema.parse(req.body), extractRequestMeta(req))
  res.json({ code: 0, message: 'ok', data })
}))

mobileAuthRouter.post('/logout', asyncHandler(async (req, res) => {
  const data = await mobileSessionService.revokeByAccessToken(
    readRequiredMobileBearer(req),
    extractRequestMeta(req),
  )
  res.json({ code: 0, message: 'ok', data })
}))

mobileAuthRouter.post('/logout-all', requireMobileAuth, asyncHandler(async (req, res) => {
  const auth = (req as MobileAuthenticatedRequest).mobileAuth
  const scope = logoutScopeSchema.parse(req.query.scope)
  const data = await mobileSessionService.logoutAll(auth, scope, extractRequestMeta(req))
  res.json({ code: 0, message: 'ok', data })
}))

mobileAuthRouter.get('/me', requireMobileAuth, asyncHandler(async (req, res) => {
  const data = await mobileAuthService.me((req as MobileAuthenticatedRequest).mobileAuth)
  res.json({ code: 0, message: 'ok', data })
}))

mobileAuthRouter.get('/sessions', requireMobileAuth, asyncHandler(async (req, res) => {
  const data = await mobileSessionService.listSessions((req as MobileAuthenticatedRequest).mobileAuth)
  res.json({ code: 0, message: 'ok', data })
}))

mobileAuthRouter.delete('/sessions/:id', requireMobileAuth, asyncHandler(async (req, res) => {
  const sessionId = z.string().regex(/^\d+$/).parse(req.params.id)
  const data = await mobileSessionService.revokeOwnedSession(
    (req as MobileAuthenticatedRequest).mobileAuth,
    sessionId,
    extractRequestMeta(req),
  )
  res.json({ code: 0, message: 'ok', data })
}))

mobileAuthRouter.patch('/profile', requireMobileAuth, asyncHandler(async (req, res) => {
  const auth = (req as MobileAuthenticatedRequest).mobileAuth
  const requestMeta = extractRequestMeta(req)
  await authSecurityService.guardClientProfileUpdateRequest(requestMeta, auth.userId)
  const data = await mobileAuthService.updateProfile(auth, profileSchema.parse(req.body), requestMeta)
  res.json({ code: 0, message: 'ok', data })
}))

mobileAuthRouter.post('/change-password', requireMobileAuth, asyncHandler(async (req, res) => {
  const data = await mobileAuthService.changePassword(
    (req as MobileAuthenticatedRequest).mobileAuth,
    changePasswordSchema.parse(req.body),
    extractRequestMeta(req),
  )
  res.json({ code: 0, message: 'ok', data })
}))
