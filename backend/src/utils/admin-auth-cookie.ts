/**
 * 模块说明：backend/src/utils/admin-auth-cookie.ts
 * 文件职责：统一封装管理端安全 Cookie、CSRF Token 生成与请求侧解析逻辑。
 * 实现逻辑：
 * - 管理端会话使用 HttpOnly Cookie 持有数据库会话令牌，避免前端脚本直接读取；
 * - 管理端 CSRF 使用“双提交 Cookie”策略，前端从可读 Cookie 取值后放入自定义请求头；
 * - 所有 Cookie 序列化、写入、清理与读取规则都集中在这里，避免路由层散落字符串常量。
 * 维护说明：
 * - 若后续要接入独立域名部署，请优先在本文件扩展 domain / secure / sameSite 策略；
 * - 若管理端与客户端将来完全拆域，请继续保持管理端会话 Cookie 与客户端令牌链路隔离。
 */
import crypto from 'node:crypto'
import type { Request, Response } from 'express'
import { env } from '../config/env.js'

/**
 * 管理端 Cookie 常量：
 * - 会话 Cookie 只允许服务端读取，避免再次退回到 localStorage Bearer 模式；
 * - CSRF Cookie 允许前端脚本读取，用于在写操作时放入 `x-csrf-token` 请求头。
 */
export const ADMIN_SESSION_COOKIE_NAME = 'y_link_admin_session'
export const ADMIN_CSRF_COOKIE_NAME = 'y_link_admin_csrf'
const ADMIN_CSRF_HEADER_NAME = 'x-csrf-token'

interface CookieSerializeOptions {
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'Lax' | 'Strict' | 'None'
  path?: string
  maxAgeSeconds?: number
  expires?: Date
}

/**
 * 统一生成安全随机串：
 * - 会话 Cookie 使用数据库中的 sessionToken；
 * - CSRF Cookie 使用额外随机串，避免直接复用会话令牌。
 */
export function generateAdminCsrfToken(): string {
  return crypto.randomBytes(32).toString('base64url')
}

function shouldUseSecureCookie(): boolean {
  return env.NODE_ENV === 'production'
}

function buildCookieValue(name: string, value: string, options: CookieSerializeOptions): string {
  const segments = [`${name}=${encodeURIComponent(value)}`]
  segments.push(`Path=${options.path ?? '/'}`)

  if (typeof options.maxAgeSeconds === 'number') {
    segments.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`)
  }
  if (options.expires) {
    segments.push(`Expires=${options.expires.toUTCString()}`)
  }
  if (options.httpOnly) {
    segments.push('HttpOnly')
  }
  if (options.secure) {
    segments.push('Secure')
  }
  if (options.sameSite) {
    segments.push(`SameSite=${options.sameSite}`)
  }

  return segments.join('; ')
}

function appendSetCookieHeader(res: Response, cookieValue: string): void {
  const currentValue = res.getHeader('Set-Cookie')
  if (!currentValue) {
    res.setHeader('Set-Cookie', cookieValue)
    return
  }

  if (Array.isArray(currentValue)) {
    res.setHeader('Set-Cookie', [...currentValue, cookieValue])
    return
  }

  res.setHeader('Set-Cookie', [String(currentValue), cookieValue])
}

function getCookieMaxAgeSeconds(expiresAt: Date): number {
  return Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000))
}

function setCookie(res: Response, name: string, value: string, options: CookieSerializeOptions): void {
  appendSetCookieHeader(res, buildCookieValue(name, value, options))
}

export function setAdminAuthCookies(
  res: Response,
  payload: {
    sessionToken: string
    csrfToken: string
    expiresAt: Date
  },
): void {
  const cookieMaxAgeSeconds = getCookieMaxAgeSeconds(payload.expiresAt)
  const secure = shouldUseSecureCookie()

  /**
   * 管理端会话 Cookie 采用 HttpOnly：
   * - 浏览器会自动随同域请求发送；
   * - 前端脚本无法直接读取，降低 XSS 后令牌被直接窃取的风险。
   */
  setCookie(res, ADMIN_SESSION_COOKIE_NAME, payload.sessionToken, {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/',
    maxAgeSeconds: cookieMaxAgeSeconds,
    expires: payload.expiresAt,
  })

  /**
   * CSRF Cookie 则必须保持可读：
   * - 前端请求拦截器需要读取它并放入自定义请求头；
   * - 依靠“Cookie + 自定义头同时存在”的条件阻断跨站伪造提交。
   */
  setCookie(res, ADMIN_CSRF_COOKIE_NAME, payload.csrfToken, {
    secure,
    sameSite: 'Lax',
    path: '/',
    maxAgeSeconds: cookieMaxAgeSeconds,
    expires: payload.expiresAt,
  })
}

export function clearAdminAuthCookies(res: Response): void {
  const expiredAt = new Date(0)
  const secure = shouldUseSecureCookie()

  setCookie(res, ADMIN_SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/',
    maxAgeSeconds: 0,
    expires: expiredAt,
  })
  setCookie(res, ADMIN_CSRF_COOKIE_NAME, '', {
    secure,
    sameSite: 'Lax',
    path: '/',
    maxAgeSeconds: 0,
    expires: expiredAt,
  })
}

/**
 * 确保当前管理端会话拥有可读 CSRF Cookie：
 * - 用户刷新页面后，前端通常会先调用 `/auth/me` 恢复登录态；
 * - 若浏览器侧仅剩 HttpOnly 会话 Cookie、可读 CSRF Cookie 被清理，则在这里静默补发即可恢复写操作能力。
 */
export function ensureAdminCsrfCookie(req: Request, res: Response): string {
  const existedCsrfToken = readAdminCsrfTokenFromCookie(req)
  if (existedCsrfToken) {
    return existedCsrfToken
  }

  const csrfToken = generateAdminCsrfToken()
  setCookie(res, ADMIN_CSRF_COOKIE_NAME, csrfToken, {
    secure: shouldUseSecureCookie(),
    sameSite: 'Lax',
    path: '/',
    maxAgeSeconds: env.AUTH_TOKEN_TTL_HOURS * 60 * 60,
  })
  return csrfToken
}

export function parseCookies(req: Request): Record<string, string> {
  const rawCookie = req.headers.cookie
  if (!rawCookie) {
    return {}
  }

  return rawCookie
    .split(';')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((cookieMap, segment) => {
      const separatorIndex = segment.indexOf('=')
      if (separatorIndex <= 0) {
        return cookieMap
      }
      const key = segment.slice(0, separatorIndex).trim()
      const value = segment.slice(separatorIndex + 1).trim()
      if (!key) {
        return cookieMap
      }
      try {
        cookieMap[key] = decodeURIComponent(value)
      } catch {
        cookieMap[key] = value
      }
      return cookieMap
    }, {})
}

export function readAdminSessionTokenFromCookie(req: Request): string | null {
  const cookieValue = parseCookies(req)[ADMIN_SESSION_COOKIE_NAME]
  return typeof cookieValue === 'string' && cookieValue.trim() ? cookieValue.trim() : null
}

export function readAdminCsrfTokenFromCookie(req: Request): string | null {
  const cookieValue = parseCookies(req)[ADMIN_CSRF_COOKIE_NAME]
  return typeof cookieValue === 'string' && cookieValue.trim() ? cookieValue.trim() : null
}

export function resolveAdminCsrfHeaderValue(req: Request): string | null {
  const headerValue = req.headers[ADMIN_CSRF_HEADER_NAME]
  if (typeof headerValue === 'string' && headerValue.trim()) {
    return headerValue.trim()
  }
  if (Array.isArray(headerValue) && headerValue[0]?.trim()) {
    return headerValue[0].trim()
  }
  return null
}
