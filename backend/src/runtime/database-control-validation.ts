/** 启动与数据库外救援共享控制文件语义校验，防止同一损坏文件被两条路径作不同解释。 */
const object = (value: unknown) => value && typeof value === 'object' ? value as Record<string, unknown> : null
const taskIdValid = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value)
const dateValid = (value: unknown) => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value))
const textValid = (value: unknown, max = 1000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\0')

export function validateCutoverControl(value: unknown): Record<string, unknown> | null {
  const item = object(value)
  return item?.version === 1 && taskIdValid(item.taskId) && textValid(item.sourceSqlitePath)
    && Number.isSafeInteger(item.attempts) && Number(item.attempts) >= 0 && dateValid(item.createdAt)
    && (item.lastError === null || textValid(item.lastError, 200))
    && ['mysql_pending', 'verifying', 'rollback_pending'].includes(String(item.status)) ? item : null
}
export function validateMigrationLock(value: unknown): Record<string, unknown> | null {
  const item = object(value)
  return item?.version === 1 && taskIdValid(item.taskId) && dateValid(item.acquiredAt)
    && Number.isSafeInteger(item.pid) && Number(item.pid) > 0 ? item : null
}
export function validateMaintenanceControl(value: unknown): Record<string, unknown> | null {
  const item = object(value)
  return item?.version === 1 && item.readOnly === true && taskIdValid(item.taskId)
    && textValid(item.phase) && textValid(item.message) && dateValid(item.startedAt) && dateValid(item.updatedAt) ? item : null
}
