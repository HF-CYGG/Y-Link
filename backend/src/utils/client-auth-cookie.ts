/**
 * 模块说明：backend/src/utils/client-auth-cookie.ts
 * 文件职责：统一管理客户端会话 Cookie 与 CSRF Cookie 的签发、读取、续期与清理。
 * 实现逻辑：
 * - 登录后同时下发 HttpOnly 会话 Cookie 与可读 CSRF Cookie；
 * - `/client-auth/me` 可复用补发 CSRF Cookie，保证刷新后写请求可继续通过校验；
 * - CSRF Header 固定读取 `x-csrf-token`，与中间件保持一致。
 * 维护说明：
 * - SameSite/Secure 策略如需调整，必须同时验证移动端 WebView 与反向代理 HTTPS 场景。
 */

import crypto from 'node:crypto'
import type { Request, Response } from 'express'
import { env } from '../config/env.js'
import { parseCookies } from './admin-auth-cookie.js'

export const CLIENT_SESSION_COOKIE_NAME = 'y_link_client_session'
export const CLIENT_CSRF_COOKIE_NAME = 'y_link_client_csrf'
const CLIENT_CSRF_HEADER_NAME = 'x-csrf-token'

interface CookieSerializeOptions {
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'Lax' | 'Strict' | 'None'
  path?: string
  maxAgeSeconds?: number
  expires?: Date
}

export function generateClientCsrfToken(): string {
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

function setCookie(res: Response, name: string, value: string, options: CookieSerializeOptions): void {
  appendSetCookieHeader(res, buildCookieValue(name, value, options))
}

function getCookieMaxAgeSeconds(expiresAt: Date): number {
  return Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000))
}

export function setClientAuthCookies(
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

  setCookie(res, CLIENT_SESSION_COOKIE_NAME, payload.sessionToken, {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/',
    maxAgeSeconds: cookieMaxAgeSeconds,
    expires: payload.expiresAt,
  })

  setCookie(res, CLIENT_CSRF_COOKIE_NAME, payload.csrfToken, {
    secure,
    sameSite: 'Lax',
    path: '/',
    maxAgeSeconds: cookieMaxAgeSeconds,
    expires: payload.expiresAt,
  })
}

export function clearClientAuthCookies(res: Response): void {
  const expiredAt = new Date(0)
  const secure = resolveSecureCookieFlag(res)

  setCookie(res, CLIENT_SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/',
    maxAgeSeconds: 0,
    expires: expiredAt,
  })
  setCookie(res, CLIENT_CSRF_COOKIE_NAME, '', {
    secure,
    sameSite: 'Lax',
    path: '/',
    maxAgeSeconds: 0,
    expires: expiredAt,
  })
}

export function ensureClientCsrfCookie(req: Request, res: Response): string {
  const existedCsrfToken = readClientCsrfTokenFromCookie(req)
  if (existedCsrfToken) {
    return existedCsrfToken
  }

  const csrfToken = generateClientCsrfToken()
  setCookie(res, CLIENT_CSRF_COOKIE_NAME, csrfToken, {
    secure: resolveSecureCookieFlag(res, req),
    sameSite: 'Lax',
    path: '/',
    maxAgeSeconds: env.AUTH_TOKEN_TTL_HOURS * 60 * 60,
  })
  return csrfToken
}

export function readClientSessionTokenFromCookie(req: Request): string | null {
  const cookieValue = parseCookies(req)[CLIENT_SESSION_COOKIE_NAME]
  return typeof cookieValue === 'string' && cookieValue.trim() ? cookieValue.trim() : null
}

export function readClientCsrfTokenFromCookie(req: Request): string | null {
  const cookieValue = parseCookies(req)[CLIENT_CSRF_COOKIE_NAME]
  return typeof cookieValue === 'string' && cookieValue.trim() ? cookieValue.trim() : null
}

export function resolveClientCsrfHeaderValue(req: Request): string | null {
  const headerValue = req.headers[CLIENT_CSRF_HEADER_NAME]
  if (typeof headerValue === 'string' && headerValue.trim()) {
    return headerValue.trim()
  }
  if (Array.isArray(headerValue) && headerValue[0]?.trim()) {
    return headerValue[0].trim()
  }
  return null
}
