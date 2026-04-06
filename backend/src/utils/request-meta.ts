import type { Request } from 'express'

export interface RequestMeta {
  ipAddress: string | null
  userAgent: string | null
}

/**
 * 提取请求侧元信息：
 * - 优先读取反向代理透传的 x-forwarded-for 首个 IP；
 * - 兜底使用 Express 提供的 req.ip，便于审计日志记录访问来源。
 */
export function extractRequestMeta(req: Request): RequestMeta {
  const forwardedFor = req.headers['x-forwarded-for']
  const forwardedIp =
    typeof forwardedFor === 'string'
      ? forwardedFor.split(',')[0]?.trim()
      : Array.isArray(forwardedFor)
        ? forwardedFor[0]?.split(',')[0]?.trim()
        : undefined

  return {
    ipAddress: forwardedIp || req.ip || null,
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
  }
}
