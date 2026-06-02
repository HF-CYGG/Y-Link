/**
 * 模块说明：`backend/src/utils/token.ts`
 * 文件职责：提供后端会话体系使用的高强度随机令牌生成能力。
 * 实现逻辑：
 * 1. 基于 Node.js `crypto.randomBytes` 生成足够长度的安全随机字节；
 * 2. 将随机字节转成十六进制字符串，便于写入数据库与 Cookie / Header 传输；
 * 3. 保持单一职责，让管理端与客户端会话都能复用同一套令牌生成规则。
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
