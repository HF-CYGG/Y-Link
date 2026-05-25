/**
 * 模块说明：backend/src/types/client-auth.ts
 * 文件职责：客户端认证类型定义，描述客户端会话上下文与认证来源。
 * 实现逻辑：
 * - 统一声明客户端鉴权中间件注入的请求上下文；
 * - 区分 cookie/bearer 认证来源，供 CSRF 与降级逻辑判断。
 * 维护说明：
 * - 客户端认证模式调整时需同步维护该类型与相关中间件行为。
 */

import type { Request } from 'express'

export interface ClientAuthContext {
  userId: string
  account: string
  mobile: string
  email: string
  realName: string
  sessionToken: string
  authSource: 'cookie' | 'bearer'
}

export interface ClientAuthenticatedRequest extends Request {
  clientAuth: ClientAuthContext
}
