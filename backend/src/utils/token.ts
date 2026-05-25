/**
 * 模块说明：backend/src/utils/token.ts
 * 文件职责：令牌工具，负责随机令牌生成、过期时间计算与基础校验。
 * 实现逻辑：
 * - 生成会话/临时凭证所需随机字符串；
 * - 提供统一过期判定逻辑，避免各服务重复实现。
 * 维护说明：
 * - 调整令牌长度或时间策略时需同步回归登录与重置密码流程。
 */

import { randomBytes } from 'node:crypto'

/**
 * 生成会话令牌：
 * - 使用高强度随机字节，避免可预测令牌；
 * - Bearer Token 仅在服务端数据库中留存，可支持主动退出与会话失效。
 */
export function generateSessionToken(): string {
  return randomBytes(32).toString('hex')
}
