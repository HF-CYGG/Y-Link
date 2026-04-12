/**
 * 模块说明：backend/src/routes/auth.routes.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { Router } from 'express'
import { z } from 'zod'
import type { AuthenticatedRequest } from '../types/auth.js'
import { requireAuth } from '../middleware/auth.middleware.js'
import { asyncHandler } from '../utils/async-handler.js'
import { extractRequestMeta } from '../utils/request-meta.js'
import { authService } from '../services/auth.service.js'
import { authSecurityService } from '../services/auth-security.service.js'

const loginSchema = z.object({
  username: z.string().min(1, '账号不能为空'),
  password: z.string().min(1, '密码不能为空'),
})

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, '当前密码不能为空'),
  newPassword: z.string().min(6, '新密码长度至少为 6 位').max(50, '新密码长度不能超过 50 位'),
})

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
export const authRouter = Router()

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const payload = loginSchema.parse(req.body)
    const requestMeta = extractRequestMeta(req)
    // 管理端登录先经过频控与锁定校验，再进入账号密码校验。
    await authSecurityService.guardAdminLoginRequest(requestMeta, payload.username)
    const data = await authService.login(payload, requestMeta)
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
