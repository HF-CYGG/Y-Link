import { randomBytes } from 'node:crypto'

/**
 * 生成会话令牌：
 * - 使用高强度随机字节，避免可预测令牌；
 * - Bearer Token 仅在服务端数据库中留存，可支持主动退出与会话失效。
 */
export function generateSessionToken(): string {
  return randomBytes(32).toString('hex')
}
