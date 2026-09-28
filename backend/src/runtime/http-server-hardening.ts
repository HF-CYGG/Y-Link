/**
 * 文件说明：Node HTTP 服务端的监听地址与超时硬化，业务服务与救援服务共用。
 * 实现逻辑：
 * - keepAliveTimeout 65 秒：大于 onebox Nginx 上游长连接空闲超时（50 秒），由 Nginx 先关闭空闲连接，
 *   避免 Nginx 复用一条刚被 Node 关闭的连接而返回 502；headersTimeout 66 秒必须大于 keepAliveTimeout；
 * - requestTimeout 120 秒：限制“接收完整请求”的总时长，抵御慢速请求头/请求体攻击（Slowloris 类），
 *   只约束客户端发送请求的阶段，不影响导出下载与 SSE 等长时间响应；
 * - maxHeadersCount 100：正常请求头远少于此，超出部分不再解析（Node 截断而非报错），避免超多请求头消耗解析开销；
 * - 监听地址取 `Y_LINK_LISTEN_HOST`（默认 0.0.0.0）；onebox 入口脚本设为 127.0.0.1，外部只能经 Nginx 访问，无法绕过边缘限流。
 *   不使用通用的 HOST 变量：部分 shell 会把它自动设为主机名，误读会导致服务无法启动。
 * 维护说明：本模块不得导入 env 或业务模块（救援服务在配置损坏时也要能启动）。
 */

import net from 'node:net'
import type { Server } from 'node:http'

export const HTTP_SERVER_TIMEOUTS = {
  keepAliveTimeoutMs: 65_000,
  headersTimeoutMs: 66_000,
  requestTimeoutMs: 120_000,
  maxHeadersCount: 100,
} as const

export function resolveListenHost(): string {
  const host = process.env.Y_LINK_LISTEN_HOST?.trim()
  if (!host) return '0.0.0.0'
  if (net.isIP(host) === 0 && host !== 'localhost') {
    throw new Error('Y_LINK_LISTEN_HOST 必须是 IP 地址或 localhost')
  }
  return host
}

export function applyHttpServerHardening(server: Server): void {
  server.keepAliveTimeout = HTTP_SERVER_TIMEOUTS.keepAliveTimeoutMs
  server.headersTimeout = HTTP_SERVER_TIMEOUTS.headersTimeoutMs
  server.requestTimeout = HTTP_SERVER_TIMEOUTS.requestTimeoutMs
  server.maxHeadersCount = HTTP_SERVER_TIMEOUTS.maxHeadersCount
}
