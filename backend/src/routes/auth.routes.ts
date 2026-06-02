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
  generateAdminCsrfToken,
  setAdminAuthCookies,
} from '../utils/admin-auth-cookie.js'
import { extractRequestMeta } from '../utils/request-meta.js'
import { authService } from '../services/auth.service.js'
import { authSecurityService } from '../services/auth-security.service.js'
import { captchaService } from '../services/captcha.service.js'

const loginSchema = z.object({
  username: z.string().min(1, '账号不能为空'),
  password: z.string().min(1, '密码不能为空'),
  captchaId: z.string().trim().min(1).optional(),
  captchaCode: z.string().trim().min(1).optional(),
})

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, '当前密码不能为空'),
  newPassword: z.string().min(8, '新密码至少 8 位').max(50, '新密码长度不能超过 50 位'),
})

/**
 * 管理端鉴权路由模块：
 * - 提供管理员与后台用户的登录、登出、改密等核心账号生命周期管理接口。
 * - 结合 Zod 进行输入参数结构化校验，配合 authSecurityService 阻挡暴力破解。
 */
export const authRouter = Router()

authRouter.get(
  '/captcha',
  asyncHandler(async (req, res) => {
    await authSecurityService.guardAdminCaptchaRequest(extractRequestMeta(req))
    const data = captchaService.createCaptcha()
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
    // 管理端登录先经过频控与锁定校验，再进入账号密码校验。
    await authSecurityService.guardAdminLoginRequest(requestMeta, payload.username)
    if (authSecurityService.isAdminLoginCaptchaRequired(requestMeta, payload.username)) {
      if (!payload.captchaId?.trim() || !payload.captchaCode?.trim()) {
        throw new BizError('当前登录环境需要图形验证码', 428)
      }
      captchaService.verifyCaptcha(payload.captchaId, payload.captchaCode)
    }
    const data = await authService.login(payload, requestMeta)
    const csrfToken = generateAdminCsrfToken()
    setAdminAuthCookies(req, res, {
      sessionToken: data.token,
      csrfToken,
      expiresAt: data.expiresAt,
    })
    res.setHeader('Cache-Control', 'no-store')
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
    ensureAdminCsrfCookie(req, res)
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
