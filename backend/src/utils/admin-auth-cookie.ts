/**
 * 文件说明：管理端鉴权 Cookie 工具，统一封装后台会话 Cookie、CSRF Token 的生成、写入、清理和解析逻辑。
 * 实现逻辑：采用 HttpOnly 会话 Cookie 加“会话绑定”的双提交 CSRF Cookie（签名双提交），把后台登录态与请求防伪策略集中维护在同一处。
 * 维护重点：若接入独立域名部署或调整 SameSite、Secure 策略，需要同步验证管理端登录链路与客户端 Cookie 隔离仍然成立。
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import type { Request, Response } from 'express'
import { env } from '../config/env.js'
import { resolveSecureCookieFlag } from './http-security.js'

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
 * 从高熵会话令牌派生管理端 CSRF 值（OWASP 推荐的签名双提交）：
 * - 纯随机双提交只要求 Cookie 与请求头相等，能向同站写 Cookie 的攻击者（兄弟子域、明文 HTTP 中间人）
 *   可以同时伪造两者；绑定会话后，不知道 HttpOnly 会话令牌就算不出正确值；
 * - SHA-256 不可逆，脚本读到 CSRF Cookie 也反推不出会话令牌；
 * - 域分离前缀与客户端 `y-link.client.csrf.v1` 不同，两端派生值互不通用。
 */
export function deriveAdminCsrfToken(sessionToken: string): string {
  return createHash('sha256')
    .update('y-link.admin.csrf.v1\u0000')
    .update(sessionToken)
    .digest('base64url')
}

function equalCsrfToken(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expected)
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
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
    expiresAt: Date
  },
): void {
  const cookieMaxAgeSeconds = getCookieMaxAgeSeconds(payload.expiresAt)
  const secure = resolveSecureCookieFlag(req)

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
  setCookie(res, ADMIN_CSRF_COOKIE_NAME, deriveAdminCsrfToken(payload.sessionToken), {
    secure,
    sameSite: 'Lax',
    path: '/',
    maxAgeSeconds: cookieMaxAgeSeconds,
    expires: payload.expiresAt,
  })
}

export function clearAdminAuthCookies(req: Request, res: Response): void {
  const expiredAt = new Date(0)
  const secure = resolveSecureCookieFlag(req)

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
 * 确保当前管理端会话拥有与之绑定的可读 CSRF Cookie：
 * - 用户刷新页面后，前端通常会先调用 `/auth/me` 恢复登录态；
 * - 可读 CSRF Cookie 被清理，或仍是升级前签发的随机值、与会话派生值不一致时，在这里静默换发即可恢复写操作能力。
 */
export function ensureAdminCsrfCookie(req: Request, res: Response, sessionToken: string): string {
  const csrfToken = deriveAdminCsrfToken(sessionToken)
  const existedCsrfToken = readAdminCsrfTokenFromCookie(req)
  if (existedCsrfToken && equalCsrfToken(existedCsrfToken, csrfToken)) {
    return csrfToken
  }

  setCookie(res, ADMIN_CSRF_COOKIE_NAME, csrfToken, {
    secure: resolveSecureCookieFlag(req),
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

/** 请求头与 Cookie 都必须等于当前会话的派生值，恒定时间比较。 */
export function isAdminCsrfTokenValid(sessionToken: string, cookieToken: string, headerToken: string): boolean {
  const expectedToken = deriveAdminCsrfToken(sessionToken)
  return equalCsrfToken(cookieToken, expectedToken) && equalCsrfToken(headerToken, expectedToken)
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
