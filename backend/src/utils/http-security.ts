/**
 * 模块说明：HTTP 代理、协议和安全响应头的公共边界。
 * 实现逻辑：只信任显式配置的代理地址；接口默认禁止缓存，并按 Fetch Metadata 拒绝跨站接口请求；
 *   配置和辅助函数不依赖业务数据库，供正常应用和救援入口复用。
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

/** 跨站请求被资源隔离策略拒绝的原因，写审计时原样记录。 */
export type CrossSiteBlockReason = 'cross_site' | 'same_site_unsafe_method' | 'origin_mismatch'

export interface HttpSecurityHooks {
  /** 跨站请求被拒绝时回调；主应用注入去重审计，救援入口不依赖业务数据库因此不注入。 */
  onCrossSiteRequestBlocked?: (req: Request, reason: CrossSiteBlockReason) => void
}

const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

const readSingleHeader = (value: string | string[] | undefined): string | null => {
  const raw = Array.isArray(value) ? value[0] : value
  const normalized = raw?.trim()
  return normalized ? normalized : null
}

/**
 * Fetch Metadata 资源隔离策略（web.dev / OWASP CSRF 速查表）：
 * - `/api/*` 拒绝 `Sec-Fetch-Site: cross-site`，防 CSRF、XSSI 与跨站信息泄露；
 * - `same-site`（兄弟子域）只放行安全方法，前端与接口同源部署，写请求不应来自其它子域；
 * - 浏览器未发送该头时（旧浏览器）对写方法回退到 Origin 主机名比对，`null` 来源一律拒绝；
 * - 移动端、脚本等原生客户端不带这两个头，照常放行，由会话与 CSRF 令牌继续把关。
 */
export function resolveCrossSiteBlockReason(
  req: Pick<Request, 'method' | 'path' | 'headers' | 'hostname'>,
): CrossSiteBlockReason | null {
  if (!(req.path === '/api' || req.path.startsWith('/api/'))) return null
  const safeMethod = SAFE_HTTP_METHODS.has(req.method.toUpperCase())
  const fetchSite = readSingleHeader(req.headers['sec-fetch-site'])?.toLowerCase()
  if (fetchSite) {
    if (fetchSite === 'cross-site') return 'cross_site'
    if (fetchSite === 'same-site' && !safeMethod) return 'same_site_unsafe_method'
    return null
  }
  if (safeMethod) return null
  const origin = readSingleHeader(req.headers.origin)
  if (!origin) return null
  if (origin === 'null') return 'origin_mismatch'
  let originHostname: string
  try {
    originHostname = new URL(origin).hostname.toLowerCase()
  } catch {
    return 'origin_mismatch'
  }
  // 只比对主机名：Nginx 以 `$host` 透传 Host，不含对外端口，比对端口会误伤非 80/443 部署。
  return originHostname === (req.hostname ?? '').toLowerCase() ? null : 'origin_mismatch'
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

export function configureHttpSecurity(
  app: Express,
  config = readHttpSecurityConfig(),
  hooks: HttpSecurityHooks = {},
): void {
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
    // 接口响应默认禁止缓存（ASVS V14.3）：用户、订单、审计、配置等数据不得落入浏览器磁盘缓存或中间代理；
    // 公开商城目录、SSE 等确需其它缓存语义的接口在处理器内显式覆盖。
    if (req.path === '/api' || req.path.startsWith('/api/') || req.path === '/health') {
      res.setHeader('Cache-Control', 'no-store')
    }
    const crossSiteBlockReason = resolveCrossSiteBlockReason(req)
    if (crossSiteBlockReason) {
      hooks.onCrossSiteRequestBlocked?.(req, crossSiteBlockReason)
      res.status(403).json({ code: 403, message: '跨站请求已被拒绝', data: null })
      return
    }
    next()
  })
}
