/**
 * 模块说明：backend/src/utils/request-meta.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import type { Request } from 'express'

export interface RequestMeta {
  ipAddress: string | null
  userAgent: string | null
}

/**
 * 提取请求侧元信息：
 * - 默认不信任 x-forwarded-for，防止客户端伪造来源 IP；
 * - 仅在应用显式启用可信代理（trust proxy）时，才读取 x-forwarded-for 首个 IP；
 * - 否则回退使用 Express 提供的 req.ip，保障审计链路安全一致。
 */
export function extractRequestMeta(req: Request): RequestMeta {
  // Express 默认 trust proxy=false；只有显式配置可信代理后才允许信任代理头。
  const trustProxySetting = req.app.get('trust proxy')
  const isTrustedProxyEnabled =
    trustProxySetting !== false &&
    trustProxySetting !== undefined &&
    trustProxySetting !== null &&
    trustProxySetting !== 0 &&
    trustProxySetting !== '0' &&
    trustProxySetting !== ''

  let forwardedIp: string | undefined
  if (isTrustedProxyEnabled) {
    const forwardedFor = req.headers['x-forwarded-for']
    if (typeof forwardedFor === 'string') {
      forwardedIp = forwardedFor.split(',')[0]?.trim()
    } else if (Array.isArray(forwardedFor)) {
      forwardedIp = forwardedFor[0]?.split(',')[0]?.trim()
    }
  }

  return {
    ipAddress: forwardedIp || req.ip || null,
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
  }
}
