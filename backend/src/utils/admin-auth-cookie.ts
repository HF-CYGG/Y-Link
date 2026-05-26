/**
 * 模块说明：backend/src/utils/admin-auth-cookie.ts
 * 文件职责：统一封装管理端会话 Cookie 与 CSRF Cookie 的签发、读取与清理逻辑。
 * 实现逻辑：
 * - 管理端会话令牌写入 HttpOnly Cookie，避免前端脚本直接读取；
 * - 写操作使用双提交 CSRF（Cookie + Header）进行校验；
 * - Cookie 序列化、续期、删除和请求侧解析都在本文件收口。
 * 维护说明：
 * - 若后续拆分多域名部署，优先在本文件扩展 sameSite/domain/secure 策略；
 * - 认证链路调整时，需同步检查 auth.middleware.ts 的 CSRF 校验逻辑。
 */

import crypto from 'node:crypto'
import type { Request, Response } from 'express'
import { env } from '../config/env.js'

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
 * 生成高熵 CSRF token。
 */
export function generateAdminCsrfToken(): string {
  return crypto.randomBytes(32).toString('base64url')
}

function isHttpsRequest(req: Request | undefined): boolean {
  if (!req) {
    return false
  }
  if (req.secure) {
    return true
  }

  const forwardedProto = req.headers['x-forwarded-proto']
  if (typeof forwardedProto === 'string') {
    return forwardedProto
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .includes('https')
  }
  if (Array.isArray(forwardedProto)) {
    return forwardedProto.some((item) => item.trim().toLowerCase() === 'https')
  }
  return false
}

/**
 * Cookie Secure 位按请求协议自适应：
 * - 识别到 HTTPS（含反代透传 X-Forwarded-Proto=https）时强制 Secure；
 * - 明文 HTTP 链路保留兼容，不强制 Secure，避免历史部署立即失效。
 */
function resolveSecureCookieFlag(res: Response, req?: Request): boolean {
  const resolvedRequest = req ?? (res.req as Request | undefined)
  return isHttpsRequest(resolvedRequest)
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
  req: Request,
  payload: {
    sessionToken: string
    csrfToken: string
    expiresAt: Date
  },
): void {
  const cookieMaxAgeSeconds = getCookieMaxAgeSeconds(payload.expiresAt)
  const secure = resolveSecureCookieFlag(res, req)

  setCookie(res, ADMIN_SESSION_COOKIE_NAME, payload.sessionToken, {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/',
    maxAgeSeconds: cookieMaxAgeSeconds,
    expires: payload.expiresAt,
  })

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
  const secure = resolveSecureCookieFlag(res)

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

export function ensureAdminCsrfCookie(req: Request, res: Response): string {
  const existedCsrfToken = readAdminCsrfTokenFromCookie(req)
  if (existedCsrfToken) {
    return existedCsrfToken
  }

  const csrfToken = generateAdminCsrfToken()
  setCookie(res, ADMIN_CSRF_COOKIE_NAME, csrfToken, {
    secure: resolveSecureCookieFlag(res, req),
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
