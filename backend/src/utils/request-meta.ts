/**
 * 模块说明：`backend/src/utils/request-meta.ts`
 * 文件职责：从 Express 请求对象中提取审计与风控所需的来源信息，统一输出 IP、UA 与客户端风险标识。
 * 实现逻辑：
 * 1. 先对风险标识请求头做裁剪与白名单校验，拦截非法格式值进入后续链路；
 * 2. 仅在应用显式启用可信代理时才信任 `x-forwarded-for`，避免伪造来源 IP；
 * 3. 最终返回审计服务可直接复用的请求元信息对象，减少各模块自行解析请求头。
 */

import type { Request } from 'express'

export interface RequestMeta {
  ipAddress: string | null
  userAgent: string | null
  clientRiskBrowserId: string | null
  clientRiskSessionId: string | null
}

const normalizeRiskHeader = (headerValue: unknown) => {
  let value = ''

  if (typeof headerValue === 'string') {
    value = headerValue.trim()
  } else if (Array.isArray(headerValue)) {
    value = headerValue[0]?.trim() || ''
  }

  if (!value) {
    return null
  }
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
    return null
  }
  return value
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
    clientRiskBrowserId: normalizeRiskHeader(req.headers['x-client-risk-browser-id']),
    clientRiskSessionId: normalizeRiskHeader(req.headers['x-client-risk-session-id']),
  }
}
