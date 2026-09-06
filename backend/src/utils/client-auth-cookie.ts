import { createHash, timingSafeEqual } from 'node:crypto'
import type { Request, Response } from 'express'
import { env } from '../config/env.js'
import { parseCookies } from './admin-auth-cookie.js'
import { resolveSecureCookieFlag } from './http-security.js'

export const CLIENT_SESSION_COOKIE_NAME = 'y_link_client_session'
export const CLIENT_CSRF_COOKIE_NAME = 'y_link_client_csrf'
export const CLIENT_CSRF_HEADER_NAME = 'x-client-csrf-token'

interface CookieSerializeOptions {
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'Lax' | 'Strict' | 'None'
  path?: string
  maxAgeSeconds?: number
  expires?: Date
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

/**
 * 从高熵会话令牌派生客户端 CSRF 值，而不是让浏览器提交任意两个相等的外部值。
 * 域分离前缀避免未来其它用途的 SHA-256 摘要与此值混用。
 */
export function deriveClientCsrfToken(sessionToken: string): string {
  return createHash('sha256')
    .update('y-link.client.csrf.v1\u0000')
    .update(sessionToken)
    .digest('base64url')
}

function equalCsrfToken(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expected)
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
}

export function setClientAuthCookie(
  req: Request,
  res: Response,
  payload: {
    sessionToken: string
    expiresAt: Date
  },
): void {
  const cookieMaxAgeSeconds = getCookieMaxAgeSeconds(payload.expiresAt)
  const secure = resolveSecureCookieFlag(req)
  setCookie(res, CLIENT_SESSION_COOKIE_NAME, payload.sessionToken, {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/',
    maxAgeSeconds: cookieMaxAgeSeconds,
    expires: payload.expiresAt,
  })
  setCookie(res, CLIENT_CSRF_COOKIE_NAME, deriveClientCsrfToken(payload.sessionToken), {
    secure,
    sameSite: 'Lax',
    path: '/',
    maxAgeSeconds: cookieMaxAgeSeconds,
    expires: payload.expiresAt,
  })
}

export function clearClientAuthCookie(req: Request, res: Response): void {
  const secure = resolveSecureCookieFlag(req)
  setCookie(res, CLIENT_SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/',
    maxAgeSeconds: 0,
    expires: new Date(0),
  })
  setCookie(res, CLIENT_CSRF_COOKIE_NAME, '', {
    secure,
    sameSite: 'Lax',
    path: '/',
    maxAgeSeconds: 0,
    expires: new Date(0),
  })
}

/** 在会话探测成功后补发可读 CSRF Cookie，不重写 HttpOnly 会话 Cookie 的原始到期时间。 */
export function ensureClientCsrfCookie(req: Request, res: Response, sessionToken: string): void {
  const secure = resolveSecureCookieFlag(req)
  setCookie(res, CLIENT_CSRF_COOKIE_NAME, deriveClientCsrfToken(sessionToken), {
    secure,
    sameSite: 'Lax',
    path: '/',
    maxAgeSeconds: env.AUTH_TOKEN_TTL_HOURS * 60 * 60,
  })
}

export function readClientSessionTokenFromCookie(req: Request): string | null {
  const cookieValue = parseCookies(req)[CLIENT_SESSION_COOKIE_NAME]
  return typeof cookieValue === 'string' && cookieValue.trim() ? cookieValue.trim() : null
}

export function readClientCsrfTokenFromCookie(req: Request): string | null {
  const cookieValue = parseCookies(req)[CLIENT_CSRF_COOKIE_NAME]
  return typeof cookieValue === 'string' && cookieValue.trim() ? cookieValue.trim() : null
}

export function readClientCsrfHeaderToken(req: Request): string | null {
  const headerValue = req.headers[CLIENT_CSRF_HEADER_NAME]
  if (typeof headerValue === 'string') {
    return headerValue.trim() || null
  }
  return Array.isArray(headerValue) ? headerValue[0]?.trim() || null : null
}

export function isClientCsrfTokenValid(sessionToken: string, cookieToken: string, headerToken: string): boolean {
  const expectedToken = deriveClientCsrfToken(sessionToken)
  return equalCsrfToken(cookieToken, expectedToken) && equalCsrfToken(headerToken, expectedToken)
}
