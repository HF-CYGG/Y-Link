/** 纯控制协议判定：手动模式必须显式采用持续冻结协议，不能借用automatic身份绕过启动/救援门禁。 */
export const CONTINUOUS_MIGRATION_PROTOCOL = 'continuous-freeze-v1' as const
export type ManualMigrationControlPhase = 'freezing' | 'copying' | 'awaiting_switch' | 'restart_pending' | 'validated' | 'accepted' | 'cancelled' | 'failed' | 'failed_cleanup' | 'failed_recovered'
export interface MigrationProtocolRecord {
  mode?: unknown
  controlProtocol?: unknown
  controlPhase?: unknown
  status?: unknown
}
export const isControlledManualMigration = (task: MigrationProtocolRecord) => task.mode === 'manual' && task.controlProtocol === CONTINUOUS_MIGRATION_PROTOCOL
export const isManagedMigration = (task: MigrationProtocolRecord) => task.mode === 'automatic' || isControlledManualMigration(task)
export const isMigrationRecoveryWindowClosed = (task: MigrationProtocolRecord) => task.status === 'rolled_back'
  || (isControlledManualMigration(task) ? ['accepted', 'cancelled', 'failed_recovered'].includes(String(task.controlPhase)) : task.status === 'succeeded')
