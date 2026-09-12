/** 账号生命周期由服务端统一计算，status 仍只表示启用或停用。 */
export const ACCOUNT_STATES = ['enabled', 'disabled', 'deactivated'] as const
export type AccountState = (typeof ACCOUNT_STATES)[number]

export const ACCOUNT_LIFECYCLE_DOMAINS = ['sys_user', 'client_user'] as const
export type AccountLifecycleDomain = (typeof ACCOUNT_LIFECYCLE_DOMAINS)[number]

export const ACCOUNT_LIFECYCLE_ACTIONS = ['deactivate', 'restore', 'permanent_delete'] as const
export type AccountLifecycleAction = (typeof ACCOUNT_LIFECYCLE_ACTIONS)[number]

export interface AccountLifecycleFields {
  accountState: AccountState
  deactivatedAt: string | null
  deactivationReason: string | null
  deactivatedByUsername: string | null
  deactivatedByDisplayName: string | null
  restoredAt: string | null
  restoredByUsername: string | null
  restoredByDisplayName: string | null
}

export interface AccountLifecycleBlocker {
  code: string
  message: string
  count: number
}

export interface AccountLifecyclePreview {
  domain: AccountLifecycleDomain
  accountId: string
  account: string
  accountState: AccountState
  canDeactivate: boolean
  canRestore: boolean
  canPermanentDelete: boolean
  blockers: AccountLifecycleBlocker[]
  referenceSummary: Record<string, number>
}

export interface AccountLifecycleReasonPayload {
  reason: string
}

export interface AccountPermanentDeletePayload extends AccountLifecycleReasonPayload {
  confirmAccount: string
  permanentDeletePassword: string
}

export interface AccountPermanentDeleteResult {
  deleted: true
  accountId: string
  accountMasked: string
}
