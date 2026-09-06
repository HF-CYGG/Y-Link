/**
 * 模块说明：src/rescue/rescue-api.ts
 * 文件职责：以原生同源 fetch 调用数据库救援 API，不接入普通应用的鉴权、Store 或请求拦截器。
 * 实现逻辑：
 * - 每个请求只携带用户输入或当前标签页暂存的一次性 Bearer 凭证；
 * - 显式省略 Cookie，避免独立救援页意外依赖普通登录态；
 * - 统一解析后端 envelope，并只返回稳定错误信息，不记录凭证或请求载荷。
 * 维护说明：此模块不能导入 src/api/http、任何 Store 或普通业务 API。
 */

export type RescueAction = 'prepare_rollback' | 'resume_rollback'

export interface RescueRecovery {
  phase: string
  operationId: string
  restartAttempts: number
}

export interface RescueStatus {
  taskId: string
  status: 'RESCUE'
  reason: string
  allowedActions: RescueAction[]
  recovery: RescueRecovery | null
}

export interface RescueRollbackPreparation {
  taskId: string
  nonce: string
  expiresAt: string
}

export interface RescueRollbackAcceptance {
  taskId: string
  operationId: string
  phase: string
}

type RescueEnvelope<T> = {
  code: number
  message?: string
  data: T | { reason?: string } | null
}

export class RescueApiError extends Error {
  readonly status: number
  readonly reason?: string

  constructor(message: string, status: number, reason?: string) {
    super(message)
    this.name = 'RescueApiError'
    this.status = status
    this.reason = reason
  }
}

const RESCUE_API_BASE = '/api/database-rescue'

const getErrorReason = (data: unknown) => {
  if (data && typeof data === 'object' && 'reason' in data && typeof data.reason === 'string') {
    return data.reason
  }
  return undefined
}

const rescueRequest = async <T>(
  path: string,
  credential: string,
  init: RequestInit = {},
): Promise<T> => {
  const response = await fetch(`${RESCUE_API_BASE}${path}`, {
    ...init,
    credentials: 'omit',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${credential}`,
      ...init.headers,
    },
  })
  const envelope = await response.json().catch(() => null) as RescueEnvelope<T> | null
  if (!response.ok || envelope?.code !== 0) {
    const reason = getErrorReason(envelope?.data)
    throw new RescueApiError(
      envelope?.message || '救援请求未完成，请查看状态后重试。',
      response.status,
      reason,
    )
  }
  return envelope.data as T
}

export const getRescueStatus = (credential: string) => rescueRequest<RescueStatus>('/status', credential)

export const prepareRescueRollback = (credential: string) =>
  rescueRequest<RescueRollbackPreparation>('/prepare-rollback', credential, { method: 'POST' })

export const beginRescueRollback = (credential: string, nonce: string, idempotencyKey: string) =>
  rescueRequest<RescueRollbackAcceptance>('/rollback-to-source-sqlite', credential, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({ nonce }),
  })
