import { QueryFailedError } from 'typeorm'
import { BizError } from './errors.js'

interface DriverErrorShape {
  code?: string
  errno?: number
  message?: string
}

export interface UniqueConstraintMatcher {
  mysqlConstraint?: string
  sqliteColumns?: readonly string[]
}

function getDriverError(error: unknown): DriverErrorShape {
  if (!(error instanceof QueryFailedError)) {
    return {}
  }
  return (error.driverError ?? {}) as DriverErrorShape
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === 'string') {
    return error
  }
  return 'unknown'
}

export function isQueryFailedError(error: unknown): error is QueryFailedError {
  return error instanceof QueryFailedError
}

/**
 * 统一识别 MySQL / SQLite 的唯一键冲突。
 * - MySQL: 依赖 ER_DUP_ENTRY / errno 1062；
 * - SQLite: 依赖 UNIQUE constraint failed 关键字。
 */
export function isUniqueConstraintError(error: unknown, matcher?: UniqueConstraintMatcher): boolean {
  if (!isQueryFailedError(error)) {
    return false
  }

  const driverError = getDriverError(error)
  const message = `${driverError.message ?? ''} ${getErrorMessage(error)}`
  const isMySqlDuplicate = driverError.code === 'ER_DUP_ENTRY' || driverError.errno === 1062
  const isSqliteDuplicate = message.includes('SQLITE_CONSTRAINT') && message.includes('UNIQUE constraint failed')

  if (!isMySqlDuplicate && !isSqliteDuplicate) {
    return false
  }

  if (!matcher) {
    return true
  }

  if (matcher.mysqlConstraint && message.includes(matcher.mysqlConstraint)) {
    return true
  }

  if (matcher.sqliteColumns?.some((column) => message.includes(column))) {
    return true
  }

  return false
}

export function isRetryableSqliteLockError(error: unknown): boolean {
  if (!isQueryFailedError(error)) {
    return false
  }

  const driverError = getDriverError(error)
  return driverError.code === 'SQLITE_BUSY' || driverError.code === 'SQLITE_LOCKED'
}

/**
 * 面向接口层输出业务可理解的数据库错误，避免底层 SQL 文本直接泄露到前端。
 */
export function mapDatabaseErrorToBizError(error: unknown): BizError | null {
  if (isUniqueConstraintError(error)) {
    return new BizError('数据写入冲突，请刷新后重试', 409)
  }

  if (isQueryFailedError(error)) {
    return new BizError('数据库操作失败，请稍后重试', 500)
  }

  return null
}
