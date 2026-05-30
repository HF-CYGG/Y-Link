import type { Request, Response } from 'express'
import { env } from '../config/env.js'
import { parseCookies } from './admin-auth-cookie.js'

export const CLIENT_SESSION_COOKIE_NAME = 'y_link_client_session'

interface CookieSerializeOptions {
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'Lax' | 'Strict' | 'None'
  path?: string
  maxAgeSeconds?: number
  expires?: Date
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

function shouldUseSecureCookie(req: Request): boolean {
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

export function setClientAuthCookie(
  req: Request,
  res: Response,
  payload: {
    sessionToken: string
    expiresAt: Date
  },
): void {
  const cookieMaxAgeSeconds = getCookieMaxAgeSeconds(payload.expiresAt)
  const secure = shouldUseSecureCookie(req)
  setCookie(res, CLIENT_SESSION_COOKIE_NAME, payload.sessionToken, {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/',
    maxAgeSeconds: cookieMaxAgeSeconds,
    expires: payload.expiresAt,
  })
}

export function clearClientAuthCookie(req: Request, res: Response): void {
  const secure = shouldUseSecureCookie(req)
  setCookie(res, CLIENT_SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/',
    maxAgeSeconds: 0,
    expires: new Date(0),
  })
}

export function readClientSessionTokenFromCookie(req: Request): string | null {
  const cookieValue = parseCookies(req)[CLIENT_SESSION_COOKIE_NAME]
  return typeof cookieValue === 'string' && cookieValue.trim() ? cookieValue.trim() : null
}

