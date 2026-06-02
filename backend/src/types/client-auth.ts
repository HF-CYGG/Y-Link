/**
 * 模块说明：`backend/src/types/client-auth.ts`
 * 文件职责：定义客户端用户登录态在服务端流转时使用的认证上下文与已鉴权请求类型。
 * 实现逻辑：
 * 1. `ClientAuthContext` 统一描述客户端会话解析后可被路由直接使用的用户身份快照；
 * 2. 类型中保留账号渠道、实名信息、账号类型与会话令牌，方便订单、反馈等场景复用；
 * 3. `ClientAuthenticatedRequest` 约束中间件注入的 `clientAuth` 字段，减少重复断言。
 */

import type { Request } from 'express'

export interface ClientAuthContext {
  userId: string
  account: string
  mobile: string
  email: string
  realName: string
  accountType: 'personal' | 'department'
  staffNo: string | null
  sessionToken: string
}

export interface ClientAuthenticatedRequest extends Request {
  clientAuth: ClientAuthContext
}
