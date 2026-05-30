import { createHash } from 'node:crypto'

/**
 * 会话令牌哈希值（SHA-256 十六进制）：
 * - 数据库存储哈希，避免明文令牌落库；
 * - 请求鉴权时用同样算法把传入令牌转成哈希后匹配。
 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

