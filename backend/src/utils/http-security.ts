/**
 * 模块说明：HTTP 代理、协议和安全响应头的公共边界。
 * 实现逻辑：只信任显式配置的代理地址；配置和辅助函数不依赖业务数据库，供正常应用和救援入口复用。
 */
import { isIP } from 'node:net'
import type { Express, Request } from 'express'

export interface HttpSecurityConfig {
  trustedProxies: false | string[]
  production: boolean
  hstsMaxAge: number
}

export function readHttpSecurityConfig(source: NodeJS.ProcessEnv = process.env): HttpSecurityConfig {
  const raw = source.Y_LINK_TRUST_PROXY?.trim() ?? ''
  const proxies = raw ? raw.split(',').map(value => value.trim()) : []
  for (const proxy of proxies) {
    const [address, mask, extra] = proxy.split('/')
    const family = isIP(address ?? '')
    if (!family || extra !== undefined || (mask !== undefined && (
      !/^\d+$/.test(mask) || Number(mask) < 1 || Number(mask) > (family === 4 ? 32 : 128)
    ))) {
      throw new Error('Y_LINK_TRUST_PROXY 必须是逗号分隔的明确 IP/CIDR，不接受全网、布尔或跳数配置')
    }
  }
  if (source.Y_LINK_FORCE_SECURE_COOKIES !== undefined
    && !['true', 'false'].includes(source.Y_LINK_FORCE_SECURE_COOKIES)) {
    throw new Error('Y_LINK_FORCE_SECURE_COOKIES 必须是 true 或 false')
  }
  const hstsMaxAge = Number(source.Y_LINK_HSTS_MAX_AGE_SECONDS ?? 15_552_000)
  if (!Number.isInteger(hstsMaxAge) || hstsMaxAge < 0 || hstsMaxAge > 63_072_000) {
    throw new Error('Y_LINK_HSTS_MAX_AGE_SECONDS 必须是 0 至 63072000 的整数')
  }
  return { trustedProxies: proxies.length ? proxies : false, production: source.NODE_ENV === 'production', hstsMaxAge }
}

export function resolveSecureCookieFlag(req: Pick<Request, 'secure'>): boolean {
  return req.secure || process.env.Y_LINK_FORCE_SECURE_COOKIES === 'true'
}

export function isSecureOrDirectLoopback(req: Request): boolean {
  if (req.secure) return true
  // 经 Nginx 转发的外部 HTTP 请求也可能来自 127.0.0.1，不能将其误判为本机救援。
  const peer = req.socket.remoteAddress
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer ?? '')
    && !req.headers.forwarded
    && !req.headers['x-forwarded-for']
    && !req.headers['x-forwarded-proto']
    && !req.headers['x-real-ip']
}

export function configureHttpSecurity(app: Express, config = readHttpSecurityConfig()): void {
  app.set('trust proxy', config.trustedProxies)
  app.disable('x-powered-by')
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    if (!req.path.startsWith('/uploads')) {
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
    }
    if (config.production && req.secure && config.hstsMaxAge > 0) {
      res.setHeader('Strict-Transport-Security', `max-age=${config.hstsMaxAge}`)
    }
    if (/^\/api\/(?:auth|client-auth|client-feedback|customer-service|data-maintenance|database-rescue)(?:\/|$)/.test(req.path)
      || req.path === '/health') {
      res.setHeader('Cache-Control', 'no-store')
    }
    next()
  })
}
