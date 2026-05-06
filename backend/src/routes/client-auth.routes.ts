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
import {
  normalizeClientAccount,
  normalizeClientVerificationTarget,
} from '../utils/client-auth-account.js'
import {
  CLIENT_PASSWORD_POLICY_MIN_LENGTH,
  getClientPasswordPolicyMessage,
  isClientPasswordPolicySatisfied,
} from '../utils/password.js'
import { extractRequestMeta } from '../utils/request-meta.js'
import { clientAuthService } from '../services/client-auth.service.js'
import { authSecurityService } from '../services/auth-security.service.js'
import { verificationCodeService } from '../services/verification-code.service.js'

/**
 * 客户端密码字段统一请求校验：
 * - 路由层先做基础拦截，尽早给出明确提示；
 * - 服务层仍会再次执行断言，防止绕过 HTTP 入口时失去约束。
 */
const clientPasswordSchema = (fieldLabel = '密码') =>
  z
    .string()
    .min(CLIENT_PASSWORD_POLICY_MIN_LENGTH, getClientPasswordPolicyMessage(fieldLabel))
    .refine((value) => isClientPasswordPolicySatisfied(value), getClientPasswordPolicyMessage(fieldLabel))

const registerSchema = z.object({
  username: z.string().trim().min(1).max(128),
  account: z.string().trim().min(1),
  password: clientPasswordSchema('密码'),
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
  newPassword: clientPasswordSchema('新密码'),
})

const verificationCodeSendSchema = z.object({
  channel: z.enum(['mobile', 'email']),
  target: z.string().trim().min(1),
  scene: z.enum(['register', 'forgot_password']),
  captchaId: z.string().trim().min(1),
  captchaCode: z.string().trim().min(1),
})

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: clientPasswordSchema('新密码'),
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
    const normalizedTarget = normalizeClientVerificationTarget(payload.channel, payload.target)
    // 发短信/邮箱验证码前先校验图形验证码，降低接口被批量滥用的风险。
    clientAuthService.verifyCaptchaBeforeVerificationSend(payload)
    if (payload.scene === 'forgot_password') {
      const capabilities = await clientAuthService.getCapabilities()
      if (!capabilities.forgotPasswordEnabled) {
        throw new BizError('当前系统未同时启用手机与邮箱验证码，暂不支持自助找回密码，请联系管理员手动修改密码', 400)
      }
    }
    // 发送频控与验证码落库统一使用归一化目标，避免邮箱大小写被拆成多个风控桶。
    await authSecurityService.guardVerificationCodeSendRequest(requestMeta, normalizedTarget, payload.channel)
    const data = await verificationCodeService.sendCode({
      channel: payload.channel,
      target: normalizedTarget,
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
    const normalizedAccount = normalizeClientAccount(payload.account, {
      allowUsername: false,
      fieldLabel: '账号',
    }).normalizedValue
    await authSecurityService.guardClientRegisterRequest(requestMeta, normalizedAccount)
    const data = await clientAuthService.register(payload, requestMeta)
    res.json({ code: 0, message: 'ok', data })
  }),
)

clientAuthRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const payload = loginSchema.parse(req.body)
    const requestMeta = extractRequestMeta(req)
    const normalizedAccount = normalizeClientAccount(payload.account, {
      allowUsername: true,
      fieldLabel: '账号',
    }).normalizedValue
    await authSecurityService.guardClientLoginRequest(requestMeta, normalizedAccount)
    const data = await clientAuthService.login(payload, requestMeta)
    res.json({ code: 0, message: 'ok', data })
  }),
)

clientAuthRouter.post(
  '/forgot-password/verify',
  asyncHandler(async (req, res) => {
    const payload = forgotVerifySchema.parse(req.body)
    const requestMeta = extractRequestMeta(req)
    const normalizedAccount = normalizeClientAccount(payload.account, {
      allowUsername: false,
      fieldLabel: '账号',
    }).normalizedValue
    await authSecurityService.guardClientForgotVerifyRequest(requestMeta, normalizedAccount)
    const data = await clientAuthService.verifyForgotPassword(payload, requestMeta)
    res.json({ code: 0, message: 'ok', data })
  }),
)

clientAuthRouter.post(
  '/forgot-password/reset',
  asyncHandler(async (req, res) => {
    const payload = resetPasswordSchema.parse(req.body)
    const requestMeta = extractRequestMeta(req)
    const normalizedAccount = normalizeClientAccount(payload.account, {
      allowUsername: false,
      fieldLabel: '账号',
    }).normalizedValue
    await authSecurityService.guardClientForgotResetRequest(requestMeta, normalizedAccount)
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
    const requestMeta = extractRequestMeta(req)
    await authSecurityService.guardClientChangePasswordRequest(requestMeta, authReq.clientAuth.userId)
    await clientAuthService.changePassword(authReq.clientAuth, changePasswordSchema.parse(req.body))
    res.json({ code: 0, message: 'ok', data: true })
  }),
)

clientAuthRouter.patch(
  '/profile',
  requireClientAuth,
  asyncHandler(async (req, res) => {
    const authReq = req as ClientAuthenticatedRequest
    const requestMeta = extractRequestMeta(req)
    await authSecurityService.guardClientProfileUpdateRequest(requestMeta, authReq.clientAuth.userId)
    const data = await clientAuthService.updateProfile(authReq.clientAuth, updateProfileSchema.parse(req.body))
    res.json({ code: 0, message: 'ok', data })
  }),
)
