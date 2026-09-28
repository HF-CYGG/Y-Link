/**
 * 文件说明：错误日志脱敏工具，供兜底异常与后台任务记录错误时使用。
 * 实现逻辑：
 * - 普通 Error 只输出名称、消息与堆栈，不展开自有属性（body-parser 错误会带原始请求体，http 错误可能带响应内容）；
 * - QueryFailedError 的消息与 parameters 可能包含业务值、联系方式或令牌散列，只输出驱动错误码。
 */
import { isQueryFailedError } from './database-errors.js'

export function toSafeErrorLog(error: unknown): Record<string, unknown> {
  if (isQueryFailedError(error)) {
    const driverError = (error.driverError ?? {}) as { code?: unknown; errno?: unknown; sqlState?: unknown }
    return {
      name: 'QueryFailedError',
      code: typeof driverError.code === 'string' ? driverError.code.slice(0, 64) : null,
      errno: typeof driverError.errno === 'number' ? driverError.errno : null,
      sqlState: typeof driverError.sqlState === 'string' ? driverError.sqlState.slice(0, 16) : null,
    }
  }
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack }
  }
  return { name: typeof error, message: '非 Error 类型异常' }
}
