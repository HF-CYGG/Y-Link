import crypto from 'node:crypto'
import type { DataSource } from 'typeorm'

export const SESSION_TOKEN_HASH_PREFIX = 'sha256:'

export function hashSessionToken(sessionToken: string): string {
  const normalizedToken = sessionToken.trim()
  const digest = crypto.createHash('sha256').update(normalizedToken).digest('hex')
  return `${SESSION_TOKEN_HASH_PREFIX}${digest}`
}

export function isHashedSessionTokenValue(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(SESSION_TOKEN_HASH_PREFIX)
}

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
