/**
 * 文件说明：管理端鉴权 Cookie 工具，统一封装后台会话 Cookie、CSRF Token 的生成、写入、清理和解析逻辑。
 * 实现逻辑：采用 HttpOnly 会话 Cookie 加双提交 CSRF Cookie 的组合方案，把后台登录态与请求防伪策略集中维护在同一处。
 * 维护重点：若接入独立域名部署或调整 SameSite、Secure 策略，需要同步验证管理端登录链路与客户端 Cookie 隔离仍然成立。
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

function parseForwardedProto(headerValue: string | string[] | undefined): string | null {
  if (typeof headerValue === 'string') {
    const proto = headerValue.split(',')[0]?.trim().toLowerCase()
    return proto || null
  }
  if (Array.isArray(headerValue)) {
    for (const item of headerValue) {
      const proto = item.split(',')[0]?.trim().toLowerCase()
      if (proto) {
        return proto
      }
    }
  }
  return null
}

function shouldUseSecureCookieByRequest(req: Request): boolean {
  const forwardedProto = parseForwardedProto(req.headers['x-forwarded-proto'])
  if (forwardedProto === 'https') {
    return true
  }
  if (forwardedProto === 'http') {
    return false
  }
  if (req.secure) {
    return true
  }
  return shouldUseSecureCookie()
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
  req: Request,
  res: Response,
  payload: {
    sessionToken: string
    csrfToken: string
    expiresAt: Date
  },
): void {
  const cookieMaxAgeSeconds = getCookieMaxAgeSeconds(payload.expiresAt)
  const secure = shouldUseSecureCookieByRequest(req)

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

export function clearAdminAuthCookies(req: Request, res: Response): void {
  const expiredAt = new Date(0)
  const secure = shouldUseSecureCookieByRequest(req)

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
    secure: shouldUseSecureCookieByRequest(req),
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
