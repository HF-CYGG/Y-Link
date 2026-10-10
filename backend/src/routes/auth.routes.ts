/**
 * 文件说明：管理端鉴权路由，负责后台用户登录、退出、获取当前会话信息、修改密码和验证码相关接口。
 * 实现逻辑：结合后台鉴权中间件、CSRF Cookie 工具与安全服务，在路由层完成参数校验后交由鉴权服务处理会话生命周期。
 * 维护重点：修改后台登录流程时，需要同步核对验证码校验、Cookie/CSRF 发放方式以及暴力破解防护阈值。
 */

import { Router } from 'express'
import { z } from 'zod'
import type { AuthenticatedRequest } from '../types/auth.js'
import { requireAdminCsrf, requireAuth } from '../middleware/auth.middleware.js'
import { asyncHandler } from '../utils/async-handler.js'
import { BizError } from '../utils/errors.js'
import {
  clearAdminAuthCookies,
  ensureAdminCsrfCookie,
  setAdminAuthCookies,
} from '../utils/admin-auth-cookie.js'
import { extractRequestMeta } from '../utils/request-meta.js'
import { authService } from '../services/auth.service.js'
import { adminMfaService } from '../services/admin-mfa.service.js'
import { authSecurityService } from '../services/auth-security.service.js'
import { captchaService } from '../services/captcha.service.js'
import { webauthnConfig } from '../config/webauthn.js'
import { adminWebauthnService, assertWebauthnOrigin, ADMIN_STEP_UP_ACTIONS } from '../services/admin-webauthn.service.js'
import { resolveSecureCookieFlag } from '../utils/http-security.js'
import {
  AUTH_ACCOUNT_INPUT_MAX_LENGTH,
  existingPasswordInput,
  optionalCaptchaCodeInput,
  optionalCaptchaIdInput,
} from '../constants/auth-input-limits.js'

const loginSchema = z.object({
  username: z.string().min(1, '账号不能为空').max(AUTH_ACCOUNT_INPUT_MAX_LENGTH, `账号长度不能超过 ${AUTH_ACCOUNT_INPUT_MAX_LENGTH} 位`),
  password: existingPasswordInput('密码'),
  captchaId: optionalCaptchaIdInput(),
  captchaCode: optionalCaptchaCodeInput(),
})

const totpCodeInput = () => z.string().trim().max(16, '动态码格式不正确')
const recoveryCodeInput = () => z.string().trim().max(32, '恢复码格式不正确')

// 两步验证第二步：动态码与恢复码二选一。
const mfaLoginSchema = z
  .object({
    mfaTicket: z.string().trim().min(1, '登录验证已过期，请重新登录').max(128, '登录验证已过期，请重新登录'),
    code: totpCodeInput().optional(),
    recoveryCode: recoveryCodeInput().optional(),
  })
  .refine((value) => Boolean(value.code) !== Boolean(value.recoveryCode), { message: '请输入 6 位动态码或恢复码' })

const mfaStepUpSchema = z.object({
  currentPassword: existingPasswordInput('当前密码'),
  code: totpCodeInput().optional(),
  recoveryCode: recoveryCodeInput().optional(),
  stepUpProof: z.string().trim().min(1).max(128).optional(),
})

const mfaConfirmSchema = z.object({
  code: totpCodeInput().min(1, '请输入 6 位动态码'),
})

const mfaDisableSchema = z
  .object({
    currentPassword: existingPasswordInput('当前密码'),
    code: totpCodeInput().optional(),
    recoveryCode: recoveryCodeInput().optional(),
    stepUpProof: z.string().trim().min(1).max(128).optional(),
  })
  .refine((value) => [value.code, value.recoveryCode, value.stepUpProof].filter(Boolean).length === 1,
    { message: '请选择一种两步验证方式' })

const mfaRegenerateSchema = z.object({
  currentPassword: existingPasswordInput('当前密码'),
  code: totpCodeInput().optional(),
  stepUpProof: z.string().trim().min(1).max(128).optional(),
}).refine((value) => Boolean(value.code) !== Boolean(value.stepUpProof), { message: '请选择动态码或安全密钥验证' })

const changePasswordSchema = z.object({
  currentPassword: existingPasswordInput('当前密码'),
  newPassword: z.string().min(8, '新密码至少 8 位').max(64, '新密码长度不能超过 64 位'),
})

/**
 * 管理端鉴权路由模块：
 * - 提供管理员与后台用户的登录、登出、改密等核心账号生命周期管理接口。
 * - 结合 Zod 进行输入参数结构化校验，配合 authSecurityService 阻挡暴力破解。
 */
export const authRouter = Router()

authRouter.get('/webauthn/capabilities', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.json({ code: 0, message: 'ok', data: webauthnConfig })
})

const webauthnLoginOptionsSchema = z.object({
  captchaId: optionalCaptchaIdInput(),
  code: optionalCaptchaCodeInput(),
})
const webauthnRegisterOptionsSchema = z.object({
  name: z.string().trim().min(1, '请输入密钥名称').max(64, '密钥名称不能超过 64 位'),
  kind: z.enum(['passkey', 'security_key']),
  usage: z.enum(['passwordless', 'second_factor']).optional(),
  currentPassword: existingPasswordInput('当前密码'),
  code: totpCodeInput().optional(),
  recoveryCode: recoveryCodeInput().optional(),
  stepUpProof: z.string().trim().min(1).max(128).optional(),
})
const webauthnRenameSchema = z.object({ name: z.string().trim().min(1).max(64) })
const webauthnDeleteSchema = z.object({
  currentPassword: existingPasswordInput('当前密码'),
  code: totpCodeInput().optional(),
  recoveryCode: recoveryCodeInput().optional(),
  stepUpProof: z.string().trim().min(1).max(128).optional(),
})
const webauthnCredentialIdSchema = z.string().regex(/^\d+$/, '密钥记录 ID 不正确')

authRouter.patch('/webauthn/credentials/:id', requireAuth, requireAdminCsrf, asyncHandler(async (req, res) => {
  const authReq = req as AuthenticatedRequest
  const id = webauthnCredentialIdSchema.parse(req.params.id)
  const payload = webauthnRenameSchema.parse(req.body)
  const data = await adminWebauthnService.renameCredential(authReq.auth, id, payload.name, extractRequestMeta(req))
  res.setHeader('Cache-Control', 'no-store')
  res.json({ code: 0, message: 'ok', data })
}))

authRouter.delete('/webauthn/credentials/:id', requireAuth, requireAdminCsrf, asyncHandler(async (req, res) => {
  const authReq = req as AuthenticatedRequest
  const id = webauthnCredentialIdSchema.parse(req.params.id)
  const payload = webauthnDeleteSchema.parse(req.body)
  const data = await adminWebauthnService.deleteCredential(authReq.auth, id, payload, extractRequestMeta(req))
  clearAdminAuthCookies(req, res)
  res.setHeader('Cache-Control', 'no-store')
  res.json({ code: 0, message: 'ok', data })
}))
const webauthnVerifySchema = z.object({
  challengeId: z.string().regex(/^[A-Za-z0-9_-]{43}$/, '挑战编号格式不正确'),
  response: z.object({
    id: z.string().min(1).max(2048), rawId: z.string().min(1).max(2048), type: z.literal('public-key'),
    response: z.object({
      clientDataJSON: z.string().min(1).max(8192),
      attestationObject: z.string().min(1).max(65536),
      transports: z.array(z.string().max(32)).max(16).optional(),
    }).passthrough(),
    clientExtensionResults: z.record(z.unknown()),
  }).passthrough(),
})
const webauthnLoginVerifySchema = z.object({
  challengeId: z.string().regex(/^[A-Za-z0-9_-]{43}$/, '挑战编号格式不正确'),
  response: z.object({
    id: z.string().min(1).max(2048), rawId: z.string().min(1).max(2048), type: z.literal('public-key'),
    response: z.object({
      clientDataJSON: z.string().min(1).max(8192),
      authenticatorData: z.string().min(1).max(8192),
      signature: z.string().min(1).max(8192),
      userHandle: z.string().min(1).max(2048).nullable().optional(),
    }).passthrough(),
    clientExtensionResults: z.record(z.unknown()),
  }).passthrough(),
})

const webauthnMfaOptionsSchema = z.object({ mfaTicket: z.string().trim().min(1).max(128) })
const webauthnMfaVerifySchema = webauthnLoginVerifySchema.extend({ mfaTicket: z.string().trim().min(1).max(128) })
const stepUpOptionsSchema = z.object({
  currentPassword: existingPasswordInput('当前密码'),
  action: z.enum(ADMIN_STEP_UP_ACTIONS),
  targetId: z.string().regex(/^\d+$/).optional(),
})
const nonceCookieName = (challengeId: string) => `y_link_webauthn_nonce_${challengeId}`
const mfaNonceCookieName = (challengeId: string) => `y_link_webauthn_mfa_nonce_${challengeId}`
const nonceCookieCount = (raw: string | undefined) => (raw ?? '').split(';').filter((part) =>
  /^\s*y_link_webauthn_nonce_[A-Za-z0-9_-]{43}=/.test(part)).length
const cookieValueByName = (raw: string | undefined, name: string) => {
  return (raw ?? '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1)
}
const nonceForChallenge = (raw: string | undefined, challengeId: string) => cookieValueByName(raw, nonceCookieName(challengeId))

authRouter.post('/login/mfa/webauthn/options', asyncHandler(async (req, res) => {
  const origin = assertWebauthnOrigin(req.headers.origin)
  const { mfaTicket } = webauthnMfaOptionsSchema.parse(req.body)
  if ((req.headers.cookie ?? '').split(';').filter((part) =>
    /^\s*y_link_webauthn_mfa_nonce_[A-Za-z0-9_-]{43}=/.test(part)).length >= 8) {
    throw new BizError('同时进行的密钥验证过多，请完成或关闭旧页面后重试', 429)
  }
  const { nonce, ...data } = await adminWebauthnService.beginMfaLogin(mfaTicket, origin, extractRequestMeta(req))
  res.cookie(mfaNonceCookieName(data.challengeId), nonce, { httpOnly: true, sameSite: 'strict',
    secure: resolveSecureCookieFlag(req), path: '/api/auth/login/mfa/webauthn', maxAge: data.expiresInSeconds * 1000 })
  res.setHeader('Cache-Control', 'no-store')
  res.json({ code: 0, message: 'ok', data })
}))

authRouter.post('/login/mfa/webauthn/verify', asyncHandler(async (req, res) => {
  const origin = assertWebauthnOrigin(req.headers.origin)
  const payload = webauthnMfaVerifySchema.parse(req.body)
  const name = mfaNonceCookieName(payload.challengeId)
  const nonce = cookieValueByName(req.headers.cookie, name)
  res.clearCookie(name, { httpOnly: true, sameSite: 'strict', secure: resolveSecureCookieFlag(req),
    path: '/api/auth/login/mfa/webauthn' })
  const data = await adminWebauthnService.completeMfaLogin(payload.mfaTicket, payload.challengeId,
    payload.response as Parameters<typeof adminWebauthnService.completeMfaLogin>[2], nonce, origin, extractRequestMeta(req))
  setAdminAuthCookies(req, res, { sessionToken: data.token, expiresAt: data.expiresAt })
  res.setHeader('Cache-Control', 'no-store')
  res.json({ code: 0, message: 'ok', data: { expiresAt: data.expiresAt, user: data.user } })
}))

authRouter.post('/webauthn/step-up/options', requireAuth, requireAdminCsrf, asyncHandler(async (req, res) => {
  const origin = assertWebauthnOrigin(req.headers.origin)
  const payload = stepUpOptionsSchema.parse(req.body)
  const authReq = req as AuthenticatedRequest
  const data = await adminWebauthnService.beginStepUp(authReq.auth, payload, origin, extractRequestMeta(req))
  res.setHeader('Cache-Control', 'no-store')
  res.json({ code: 0, message: 'ok', data })
}))

authRouter.post('/webauthn/step-up/verify', requireAuth, requireAdminCsrf, asyncHandler(async (req, res) => {
  const origin = assertWebauthnOrigin(req.headers.origin)
  const payload = webauthnLoginVerifySchema.parse(req.body)
  const authReq = req as AuthenticatedRequest
  const data = await adminWebauthnService.completeStepUp(authReq.auth, payload.challengeId,
    payload.response as Parameters<typeof adminWebauthnService.completeStepUp>[2], origin)
  res.setHeader('Cache-Control', 'no-store')
  res.json({ code: 0, message: 'ok', data })
}))

authRouter.post('/webauthn/login/verify', asyncHandler(async (req, res) => {
  const origin = assertWebauthnOrigin(req.headers.origin)
  const payload = webauthnLoginVerifySchema.parse(req.body)
  const nonce = nonceForChallenge(req.headers.cookie, payload.challengeId)
  res.clearCookie(nonceCookieName(payload.challengeId), {
    httpOnly: true, sameSite: 'strict', secure: resolveSecureCookieFlag(req), path: '/api/auth/webauthn/login',
  })
  const data = await adminWebauthnService.completeLogin(
    payload.challengeId, payload.response as Parameters<typeof adminWebauthnService.completeLogin>[1], nonce, origin, extractRequestMeta(req),
  )
  setAdminAuthCookies(req, res, { sessionToken: data.token, expiresAt: data.expiresAt })
  res.setHeader('Cache-Control', 'no-store')
  res.json({ code: 0, message: 'ok', data: { expiresAt: data.expiresAt, user: data.user } })
}))

authRouter.get('/webauthn/credentials', requireAuth, asyncHandler(async (req, res) => {
  const authReq = req as AuthenticatedRequest
  const data = await adminWebauthnService.listCredentials(authReq.auth.userId)
  res.setHeader('Cache-Control', 'no-store')
  res.json({ code: 0, message: 'ok', data })
}))

authRouter.post('/webauthn/register/options', requireAuth, requireAdminCsrf, asyncHandler(async (req, res) => {
  const origin = assertWebauthnOrigin(req.headers.origin)
  const payload = webauthnRegisterOptionsSchema.parse(req.body)
  const authReq = req as AuthenticatedRequest
  const data = await adminWebauthnService.beginRegistration(authReq.auth, payload, origin, extractRequestMeta(req))
  res.setHeader('Cache-Control', 'no-store')
  res.json({ code: 0, message: 'ok', data })
}))

authRouter.post('/webauthn/register/verify', requireAuth, requireAdminCsrf, asyncHandler(async (req, res) => {
  const origin = assertWebauthnOrigin(req.headers.origin)
  const payload = webauthnVerifySchema.parse(req.body)
  const authReq = req as AuthenticatedRequest
  const data = await adminWebauthnService.completeRegistration(
    authReq.auth, payload.challengeId, payload.response as Parameters<typeof adminWebauthnService.completeRegistration>[2], origin, extractRequestMeta(req),
  )
  res.setHeader('Cache-Control', 'no-store')
  res.json({ code: 0, message: 'ok', data })
}))

authRouter.post('/webauthn/login/options', asyncHandler(async (req, res) => {
  const origin = assertWebauthnOrigin(req.headers.origin)
  const payload = webauthnLoginOptionsSchema.parse(req.body)
  if (nonceCookieCount(req.headers.cookie) >= 8) throw new BizError('同时进行的密钥登录过多，请完成或关闭旧页面后重试', 429)
  const requestMeta = extractRequestMeta(req)
  const { captchaRequired } = await authSecurityService.guardAdminLoginRequest(requestMeta, 'webauthn-anonymous')
  if (captchaRequired) {
    if (!payload.captchaId?.trim() || !payload.code?.trim()) throw new BizError('当前登录环境需要图形验证码', 428)
    captchaService.verifyCaptcha('admin', payload.captchaId, payload.code)
  }
  const { nonce, ...data } = await adminWebauthnService.beginLogin(origin)
  res.cookie(nonceCookieName(data.challengeId), nonce, {
    httpOnly: true, sameSite: 'strict', secure: resolveSecureCookieFlag(req),
    path: '/api/auth/webauthn/login', maxAge: data.expiresInSeconds * 1000,
  })
  res.setHeader('Cache-Control', 'no-store')
  res.json({ code: 0, message: 'ok', data })
}))

authRouter.get(
  '/captcha',
  asyncHandler(async (req, res) => {
    await authSecurityService.guardAdminCaptchaRequest(extractRequestMeta(req))
    const data = await captchaService.createCaptcha('admin')
    res.setHeader('Cache-Control', 'no-store')
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const payload = loginSchema.parse(req.body)
    const requestMeta = extractRequestMeta(req)
    // 管理端登录先经过频控与锁定校验，再进入账号密码校验；锁定按规范用户名计数，防止大小写/重音/全角变体绕过。
    const { captchaRequired } = await authSecurityService.guardAdminLoginRequest(
      requestMeta,
      payload.username,
      () => authService.resolveLoginRiskSubject(payload.username),
    )
    if (captchaRequired) {
      if (!payload.captchaId?.trim() || !payload.captchaCode?.trim()) {
        throw new BizError('当前登录环境需要图形验证码', 428)
      }
      captchaService.verifyCaptcha('admin', payload.captchaId, payload.captchaCode)
    }
    const data = await authService.login(payload, requestMeta)
    res.setHeader('Cache-Control', 'no-store')
    // 已开启两步验证：不下发会话 Cookie，只返回第二步票据。
    if (data.mfaRequired) {
      res.json({
        code: 0,
        message: 'ok',
        data: {
          mfaRequired: true,
          mfaTicket: data.mfaTicket,
          expiresInSeconds: data.expiresInSeconds,
          availableMethods: data.availableMethods,
        },
      })
      return
    }
    // CSRF Cookie 由会话令牌派生（签名双提交），不再单独生成随机值。
    setAdminAuthCookies(req, res, {
      sessionToken: data.token,
      expiresAt: data.expiresAt,
    })
    res.json({
      code: 0,
      message: 'ok',
      data: {
        expiresAt: data.expiresAt,
        user: data.user,
        securityReminder: data.securityReminder,
      },
    })
  }),
)

/**
 * 两步验证登录第二步：匿名接口，凭第一步返回的短期票据提交动态码或恢复码。
 * 频控与账号锁定在服务层按票据中的规范用户名执行，路由层另有与登录共用的匿名认证限流。
 */
authRouter.post(
  '/login/mfa',
  asyncHandler(async (req, res) => {
    const payload = mfaLoginSchema.parse(req.body)
    const data = await authService.completeMfaLogin(payload, extractRequestMeta(req))
    setAdminAuthCookies(req, res, {
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
        recoveryCodesRemaining: data.recoveryCodesRemaining,
      },
    })
  }),
)

authRouter.post(
  '/logout',
  requireAuth,
  requireAdminCsrf,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    await authService.logout(authReq.auth, extractRequestMeta(req))
    clearAdminAuthCookies(req, res)
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
    // 缺失或仍是升级前随机值时按当前会话换发，已打开的页面刷新或重试后即可恢复写操作。
    ensureAdminCsrfCookie(req, res, authReq.auth.sessionToken)
    res.setHeader('Cache-Control', 'no-store')
    res.json({
      code: 0,
      message: 'ok',
      data,
    })
  }),
)

authRouter.post(
  '/presence/heartbeat',
  requireAuth,
  requireAdminCsrf,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    await authService.touchSessionActivity(authReq.auth.sessionToken, 1_000)
    res.json({
      code: 0,
      message: 'ok',
      data: true,
    })
  }),
)

authRouter.get(
  '/mfa/status',
  requireAuth,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const data = await adminMfaService.getStatus(authReq.auth.userId)
    res.setHeader('Cache-Control', 'no-store')
    res.json({ code: 0, message: 'ok', data })
  }),
)

// 发起绑定：先复核当前密码（与登录共用失败锁定），会话被劫持时攻击者无法替受害者绑定自己的认证器。
authRouter.post(
  '/mfa/enroll',
  requireAuth,
  requireAdminCsrf,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const requestMeta = extractRequestMeta(req)
    const payload = mfaStepUpSchema.parse(req.body)
    await authService.verifyStepUpPassword(authReq.auth, payload.currentPassword, requestMeta, 'auth.mfa.enroll')
    const data = await adminMfaService.beginEnrollment(authReq.auth, payload, requestMeta)
    res.setHeader('Cache-Control', 'no-store')
    res.json({ code: 0, message: 'ok', data })
  }),
)

authRouter.post(
  '/mfa/enroll/confirm',
  requireAuth,
  requireAdminCsrf,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const { code } = mfaConfirmSchema.parse(req.body)
    const data = await adminMfaService.confirmEnrollment(authReq.auth, code, extractRequestMeta(req))
    res.setHeader('Cache-Control', 'no-store')
    res.json({ code: 0, message: 'ok', data })
  }),
)

authRouter.post(
  '/mfa/disable',
  requireAuth,
  requireAdminCsrf,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const requestMeta = extractRequestMeta(req)
    const payload = mfaDisableSchema.parse(req.body)
    await authService.verifyStepUpPassword(authReq.auth, payload.currentPassword, requestMeta, 'auth.mfa.disable')
    await adminMfaService.disable(authReq.auth, payload, requestMeta)
    clearAdminAuthCookies(req, res)
    res.json({ code: 0, message: 'ok', data: true })
  }),
)

authRouter.post('/mfa/disable-all', requireAuth, requireAdminCsrf, asyncHandler(async (req, res) => {
  const authReq = req as AuthenticatedRequest
  const requestMeta = extractRequestMeta(req)
  const payload = mfaDisableSchema.parse(req.body)
  await authService.verifyStepUpPassword(authReq.auth, payload.currentPassword, requestMeta, 'auth.mfa.disable_all')
  await adminMfaService.disable(authReq.auth, payload, requestMeta)
  clearAdminAuthCookies(req, res)
  res.json({ code: 0, message: 'ok', data: true })
}))

authRouter.post('/mfa/totp/disable', requireAuth, requireAdminCsrf, asyncHandler(async (req, res) => {
  const authReq = req as AuthenticatedRequest
  const requestMeta = extractRequestMeta(req)
  const payload = mfaDisableSchema.parse(req.body)
  await authService.verifyStepUpPassword(authReq.auth, payload.currentPassword, requestMeta, 'auth.mfa.totp.disable')
  await adminMfaService.disableTotp(authReq.auth, payload, requestMeta)
  res.json({ code: 0, message: 'ok', data: true })
}))

authRouter.post('/mfa/webauthn/enable', requireAuth, requireAdminCsrf, asyncHandler(async (req, res) => {
  const authReq = req as AuthenticatedRequest
  const payload = z.object({ currentPassword: existingPasswordInput('当前密码'),
    stepUpProof: z.string().trim().min(1).max(128) }).parse(req.body)
  const data = await adminWebauthnService.enablePasswordMfa(authReq.auth, payload, extractRequestMeta(req))
  res.setHeader('Cache-Control', 'no-store')
  res.json({ code: 0, message: 'ok', data })
}))

authRouter.post(
  '/mfa/recovery-codes',
  requireAuth,
  requireAdminCsrf,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const requestMeta = extractRequestMeta(req)
    const payload = mfaRegenerateSchema.parse(req.body)
    await authService.verifyStepUpPassword(authReq.auth, payload.currentPassword, requestMeta, 'auth.mfa.recovery_codes')
    const data = await adminMfaService.regenerateRecoveryCodes(authReq.auth, payload, requestMeta)
    res.setHeader('Cache-Control', 'no-store')
    res.json({ code: 0, message: 'ok', data })
  }),
)

authRouter.post(
  '/change-password',
  requireAuth,
  requireAdminCsrf,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = changePasswordSchema.parse(req.body)
    await authService.changeOwnPassword(authReq.auth, payload, extractRequestMeta(req))
    clearAdminAuthCookies(req, res)
    res.json({
      code: 0,
      message: 'ok',
      data: true,
    })
  }),
)
