/**
 * 文件说明：管理端会话空闲超时判定。
 * 实现逻辑：以会话 `lastAccessAt` 为最近活跃时间，超过 `AUTH_SESSION_IDLE_TIMEOUT_MINUTES` 视为空闲过期；
 * 配置为 0 或历史会话缺少活跃时间时不判定，仅依赖 `expiresAt` 绝对时效。
 * 维护说明：HTTP 鉴权与客服 SSE 复核必须共用本判定，避免 API 已失效而后台实时推送仍继续。
 */
import { env } from '../config/env.js'

export function resolveAdminSessionIdleTimeoutMs(): number {
  return Math.max(0, env.AUTH_SESSION_IDLE_TIMEOUT_MINUTES) * 60 * 1000
}

export function isAdminSessionIdleExpired(
  session: { lastAccessAt?: Date | null },
  now: Date = new Date(),
  idleTimeoutMs: number = resolveAdminSessionIdleTimeoutMs(),
): boolean {
  if (idleTimeoutMs <= 0 || !session.lastAccessAt) {
    return false
  }
  return now.getTime() - new Date(session.lastAccessAt).getTime() > idleTimeoutMs
}
