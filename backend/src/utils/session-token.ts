/**
 * 模块说明：backend/src/utils/session-token.ts
 * 文件职责：统一提供会话令牌哈希化与旧明文会话清理能力，避免数据库落地明文 token。
 * 实现逻辑：
 * - 新会话 token 入库前一律做 `sha256` 哈希并加固定前缀；
 * - 通过前缀判断可区分“新哈希值”和“历史明文值”；
 * - 升级阶段可批量清理历史明文会话，强制用户重新登录。
 * 维护说明：若后续切换哈希算法，需保留前缀版本策略，确保兼容多版本会话格式。
 */

import crypto from 'node:crypto'
import type { DataSource } from 'typeorm'

export const SESSION_TOKEN_HASH_PREFIX = 'sha256:'

// 会话 token 归一化后做单向哈希，数据库仅保存不可逆摘要值。
export function hashSessionToken(sessionToken: string): string {
  const normalizedToken = sessionToken.trim()
  const digest = crypto.createHash('sha256').update(normalizedToken).digest('hex')
  return `${SESSION_TOKEN_HASH_PREFIX}${digest}`
}

// 判断当前 session_token 列值是否已经完成哈希化升级。
export function isHashedSessionTokenValue(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(SESSION_TOKEN_HASH_PREFIX)
}

/**
 * 清理历史明文会话：
 * - 只删除不带哈希前缀的旧数据；
 * - 管理端与客户端会话表分开统计，便于上线报告核对清退规模。
 */
export async function revokeLegacyPlaintextSessions(dataSource: DataSource): Promise<{
  adminCleared: number
  clientCleared: number
}> {
  const pattern = `${SESSION_TOKEN_HASH_PREFIX}%`
  const adminResult = await dataSource
    .createQueryBuilder()
    .delete()
    .from('sys_user_session')
    .where('session_token NOT LIKE :pattern', { pattern })
    .execute()
  const clientResult = await dataSource
    .createQueryBuilder()
    .delete()
    .from('client_user_session')
    .where('session_token NOT LIKE :pattern', { pattern })
    .execute()

  return {
    adminCleared: adminResult.affected ?? 0,
    clientCleared: clientResult.affected ?? 0,
  }
}
