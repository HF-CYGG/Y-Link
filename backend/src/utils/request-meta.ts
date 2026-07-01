/**
 * 模块说明：`backend/src/utils/request-meta.ts`
 * 文件职责：从 Express 请求对象中提取审计与风控所需的来源信息，统一输出 IP、UA 与客户端风险标识。
 * 实现逻辑：
 * 1. 先对风险标识请求头做裁剪与白名单校验，拦截非法格式值进入后续链路；
 * 2. 来源 IP 统一使用 Express 基于 trust proxy 计算后的 req.ip，不直接解析可伪造的 x-forwarded-for；
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
 * - 不直接读取 x-forwarded-for 首个值，防止客户端预置伪造 IP 后被风控信任；
 * - 来源 IP 统一交给 Express 的 trust proxy 规则计算，未配置可信代理时 req.ip 会回退到直连地址；
 * - 保障审计与频控使用同一套不可由匿名请求任意指定的来源口径。
 */
export function extractRequestMeta(req: Request): RequestMeta {
  return {
    ipAddress: req.ip || null,
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
    clientRiskBrowserId: normalizeRiskHeader(req.headers['x-client-risk-browser-id']),
    clientRiskSessionId: normalizeRiskHeader(req.headers['x-client-risk-session-id']),
  }
}
