/**
 * 文件说明：客户端账号鉴权路由，负责注册、登录、退出、短信验证码校验以及密码修改等自助账号操作。
 * 实现逻辑：路由层先完成账号格式、验证码和密码策略校验，再调用客户端鉴权服务维护会话并统一写入客户端登录 Cookie。
 * 维护重点：调整登录凭证、验证码渠道或密码规则时，需要同时检查 Cookie 写入方式、限流策略和账号规范化逻辑。
 */

import { Router } from 'express'
import { z } from 'zod'
import { requireClientAuth } from '../middleware/client-auth.middleware.js'
import type { ClientAuthenticatedRequest } from '../types/client-auth.js'
import type { MobileAuthenticatedRequest } from '../types/mobile-auth.js'
import { asyncHandler } from '../utils/async-handler.js'
import { BizError } from '../utils/errors.js'
import {
  CLIENT_PERSONAL_USERNAME_RULE_MESSAGE,
  normalizeClientAccount,
  normalizeClientVerificationTarget,
} from '../utils/client-auth-account.js'
import {
  CLIENT_PASSWORD_POLICY_MIN_LENGTH,
  getClientPasswordPolicyMessage,
  isClientPasswordPolicySatisfied,
  PASSWORD_POLICY_MAX_LENGTH,
} from '../utils/password.js'
import { extractRequestMeta } from '../utils/request-meta.js'
import { clientAuthService } from '../services/client-auth.service.js'
import { mobileSessionService } from '../services/mobile-session.service.js'
import { authSecurityService } from '../services/auth-security.service.js'
import { verificationCodeService } from '../services/verification-code.service.js'
import { clearClientAuthCookie, ensureClientCsrfCookie, setClientAuthCookie } from '../utils/client-auth-cookie.js'
import {
  AUTH_ACCOUNT_INPUT_MAX_LENGTH,
  CAPTCHA_CODE_INPUT_MAX_LENGTH,
  CAPTCHA_ID_INPUT_MAX_LENGTH,
  existingPasswordInput,
  optionalCaptchaCodeInput,
  optionalCaptchaIdInput,
  RESET_TOKEN_INPUT_MAX_LENGTH,
} from '../constants/auth-input-limits.js'

/**
 * 客户端密码字段统一请求校验：
 * - 路由层先做基础拦截，尽早给出明确提示；
 * - 服务层仍会再次执行断言，防止绕过 HTTP 入口时失去约束。
 */
const clientPasswordSchema = (fieldLabel = '密码') =>
  z
    .string()
    .min(CLIENT_PASSWORD_POLICY_MIN_LENGTH, getClientPasswordPolicyMessage(fieldLabel))
    .max(PASSWORD_POLICY_MAX_LENGTH, `${fieldLabel}长度不能超过 ${PASSWORD_POLICY_MAX_LENGTH} 位`)
    .refine((value) => isClientPasswordPolicySatisfied(value), getClientPasswordPolicyMessage(fieldLabel))

const registerSchema = z
  .object({
    // 不在路由层 trim：个人用户名的首尾空格也必须由权威规则拒绝。
    username: z.string().max(128, CLIENT_PERSONAL_USERNAME_RULE_MESSAGE).optional(),
    account: z.string().trim().max(128).optional(),
    accountType: z.enum(['personal', 'department']),
    staffNo: z.string().trim().max(64).optional(),
    inviteCode: z.string().trim().min(1).max(32).optional(),
    password: clientPasswordSchema('密码'),
    departmentName: z.string().optional(),
    verificationCode: z.string().trim().min(4).max(8).optional(),
    captchaId: optionalCaptchaIdInput(),
    captchaCode: optionalCaptchaCodeInput(),
  })
  .superRefine((payload, ctx) => {
    if (payload.accountType === 'personal') {
      const isTeacherRegister = Boolean(payload.staffNo?.trim())
      if (isTeacherRegister && !/^\d{8}$/.test(payload.inviteCode ?? '')) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['inviteCode'], message: '请输入 8 位数字教师统一邀请码' })
      }
      if (!isTeacherRegister && !payload.username) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['username'],
          message: CLIENT_PERSONAL_USERNAME_RULE_MESSAGE,
        })
      }
      if (!isTeacherRegister && !payload.account?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['account'],
          message: isTeacherRegister ? '教师注册必须填写手机号或邮箱' : '个人注册必须填写手机号或邮箱',
        })
      }
      return
    }
  })

const accountInput = () =>
  z.string().trim().min(1, '请输入账号').max(AUTH_ACCOUNT_INPUT_MAX_LENGTH, `账号长度不能超过 ${AUTH_ACCOUNT_INPUT_MAX_LENGTH} 位`)

const loginSchema = z.object({
  account: accountInput(),
  password: existingPasswordInput('密码'),
  captchaId: optionalCaptchaIdInput(),
  captchaCode: optionalCaptchaCodeInput(),
})

const forgotVerifySchema = z.object({
  account: accountInput(),
  verificationCode: z.string().trim().min(4).max(8).optional(),
  captchaId: optionalCaptchaIdInput(),
  captchaCode: optionalCaptchaCodeInput(),
})

const resetPasswordSchema = z.object({
  account: accountInput(),
  resetToken: z.string().trim().min(1).max(RESET_TOKEN_INPUT_MAX_LENGTH, '重置凭证无效，请重新验证'),
  newPassword: clientPasswordSchema('新密码'),
})

const verificationCodeSendSchema = z.object({
  channel: z.enum(['mobile', 'email']),
  target: z.string().trim().min(1, '请输入手机号或邮箱').max(AUTH_ACCOUNT_INPUT_MAX_LENGTH, `手机号或邮箱长度不能超过 ${AUTH_ACCOUNT_INPUT_MAX_LENGTH} 位`),
  scene: z.enum(['register', 'forgot_password']),
  captchaId: z.string().trim().min(1).max(CAPTCHA_ID_INPUT_MAX_LENGTH, '图形验证码已失效，请刷新后重试'),
  captchaCode: z.string().trim().min(1).max(CAPTCHA_CODE_INPUT_MAX_LENGTH, '图形验证码格式不正确'),
})

const changePasswordSchema = z.object({
  currentPassword: existingPasswordInput('当前密码'),
  newPassword: clientPasswordSchema('新密码'),
})

const updateProfileSchema = z.object({
  username: z.string()
    .min(1, CLIENT_PERSONAL_USERNAME_RULE_MESSAGE)
    .max(128, CLIENT_PERSONAL_USERNAME_RULE_MESSAGE),
  mobile: z.string().trim().max(20).optional(),
  email: z.string().trim().max(128).optional(),
  currentPassword: existingPasswordInput('当前密码'),
  mobileVerificationCode: z.string().trim().min(4).max(8).optional(),
  emailVerificationCode: z.string().trim().min(4).max(8).optional(),
})

const profileVerificationCodeSendSchema = z.object({
  channel: z.enum(['mobile', 'email']),
  target: z.string().trim().min(1).max(128),
})

// 补认证只声明通道：目标由服务端从当前账号资料读取，客户端无法指定任意号码或邮箱。
const savedContactVerificationSendSchema = z.object({
  channel: z.enum(['mobile', 'email']),
})

const savedContactVerificationConfirmSchema = z.object({
  channel: z.enum(['mobile', 'email']),
  code: z.string().trim().min(4).max(8),
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
        throw new BizError('当前系统未启用可用的手机或邮箱验证码，暂不支持自助找回密码，请联系管理员手动修改密码', 400)
      }
      if (!capabilities.channels[payload.channel]) {
        throw new BizError(`当前${payload.channel === 'email' ? '邮箱' : '手机'}验证码通道未启用，请联系管理员配置`, 400)
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
    const registerSourceKey = payload.account?.trim()
      ? normalizeClientAccount(payload.account, {
          allowUsername: false,
          fieldLabel: '账号',
        }).normalizedValue
      : payload.staffNo?.trim() ?? ''
    const registerGuardResult = await authSecurityService.guardClientRegisterSourceRequest(requestMeta, registerSourceKey)
    if (registerGuardResult.shouldWarnRemaining) {
      res.setHeader('X-YLink-Register-Remaining-Attempts', String(registerGuardResult.remainingAttempts))
      res.setHeader('X-YLink-Register-Max-Attempts', String(registerGuardResult.maxAttempts))
      res.setHeader('X-YLink-Register-Remaining-Source-Type', registerGuardResult.sourceType)
    }
    const data = await clientAuthService.register(payload, requestMeta)
    setClientAuthCookie(req, res, {
      sessionToken: data.token,
      expiresAt: data.expiresAt,
    })
    res.setHeader('Cache-Control', 'no-store')
    if (registerGuardResult.shouldWarnRemaining) {
      res.setHeader(
        'X-YLink-Register-Remaining-Message',
        `当前注册操作还可尝试 ${registerGuardResult.remainingAttempts} 次，请尽量避免重复提交。`,
      )
    }
    res.json({
      code: 0,
      message: 'ok',
      data: {
        expiresAt: data.expiresAt,
        user: data.user,
        verificationChannel: data.verificationChannel,
        authMode: 'cookie',
      },
    })
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
    // 锁定与验证码判定按账号主体（用户 ID）计数：手机号、邮箱、用户名、工号及其变体写法共用同一失败额度。
    const { captchaRequired } = await authSecurityService.guardClientLoginRequest(
      requestMeta,
      normalizedAccount,
      () => clientAuthService.resolveLoginRiskSubject(payload.account),
    )
    const data = await clientAuthService.login(payload, requestMeta, captchaRequired)
    setClientAuthCookie(req, res, {
      sessionToken: data.token,
      expiresAt: data.expiresAt,
    })
    res.setHeader('Cache-Control', 'no-store')
    res.json({
      code: 0,
      message: 'ok',
      data: {
        expiresAt: data.expiresAt,
        user: data.user,
        verificationChannel: data.verificationChannel,
        authMode: 'cookie',
      },
    })
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
    clearClientAuthCookie(req, res)
    res.json({ code: 0, message: 'ok', data: true })
  }),
)

clientAuthRouter.get(
  '/me',
  requireClientAuth,
  asyncHandler(async (req, res) => {
    const authReq = req as ClientAuthenticatedRequest
    const data = await clientAuthService.me(authReq.clientAuth)
    if (authReq.clientAuth.authSource === 'cookie') {
      ensureClientCsrfCookie(req, res, authReq.clientAuth.sessionToken)
    }
    res.setHeader('Cache-Control', 'no-store')
    res.json({ code: 0, message: 'ok', data })
  }),
)

clientAuthRouter.post(
  '/logout',
  requireClientAuth,
  asyncHandler(async (req, res) => {
    const authReq = req as ClientAuthenticatedRequest & Partial<MobileAuthenticatedRequest>
    if (authReq.mobileAuth) {
      await mobileSessionService.revokeCurrent(authReq.mobileAuth, extractRequestMeta(req))
    } else {
      await clientAuthService.logout(authReq.clientAuth)
      clearClientAuthCookie(req, res)
    }
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
    await clientAuthService.changePassword(authReq.clientAuth, changePasswordSchema.parse(req.body), requestMeta)
    clearClientAuthCookie(req, res)
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
    const data = await clientAuthService.updateProfile(
      authReq.clientAuth,
      updateProfileSchema.parse(req.body),
      undefined,
      requestMeta,
    )
    if (data.requiresRelogin) {
      clearClientAuthCookie(req, res)
    }
    res.json({ code: 0, message: 'ok', data })
  }),
)

clientAuthRouter.post(
  '/profile/verification-code/send',
  requireClientAuth,
  asyncHandler(async (req, res) => {
    const authReq = req as ClientAuthenticatedRequest
    const payload = profileVerificationCodeSendSchema.parse(req.body)
    const target = normalizeClientVerificationTarget(payload.channel, payload.target)
    const requestMeta = extractRequestMeta(req)
    // 此入口无图形验证码且目标号码由用户任填，必须先按账号封顶，再走按来源/号码的通用频控。
    await authSecurityService.guardClientProfileVerificationSend(requestMeta, authReq.clientAuth.userId)
    await authSecurityService.guardVerificationCodeSendRequest(requestMeta, target, payload.channel)
    const data = await verificationCodeService.sendCode({
      channel: payload.channel,
      target,
      scene: 'profile_update',
      requestMeta,
    })
    res.json({ code: 0, message: 'ok', data: { ...data, userId: authReq.clientAuth.userId } })
  }),
)

clientAuthRouter.post(
  '/profile/contact-verification/send',
  requireClientAuth,
  asyncHandler(async (req, res) => {
    const authReq = req as ClientAuthenticatedRequest
    const payload = savedContactVerificationSendSchema.parse(req.body)
    // 发送频控在服务层按已保存目标计桶，通道状态与已认证状态也在服务层统一复核。
    const data = await clientAuthService.sendSavedContactCode(
      authReq.clientAuth,
      payload.channel,
      extractRequestMeta(req),
    )
    res.json({ code: 0, message: 'ok', data })
  }),
)

clientAuthRouter.post(
  '/profile/contact-verification/confirm',
  requireClientAuth,
  asyncHandler(async (req, res) => {
    const authReq = req as ClientAuthenticatedRequest
    const requestMeta = extractRequestMeta(req)
    const payload = savedContactVerificationConfirmSchema.parse(req.body)
    // 验证码确认与资料更新共用同一频控桶，避免借补认证接口绕过资料修改限流。
    await authSecurityService.guardClientProfileUpdateRequest(requestMeta, authReq.clientAuth.userId)
    const data = await clientAuthService.confirmSavedContact(authReq.clientAuth, payload, requestMeta)
    res.setHeader('Cache-Control', 'no-store')
    res.json({ code: 0, message: 'ok', data })
  }),
)
