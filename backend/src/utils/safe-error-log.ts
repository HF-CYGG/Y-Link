/**
 * 文件说明：错误日志脱敏工具，供兜底异常与后台任务记录错误时使用。
 * 实现逻辑：
 * - 普通 Error 只输出名称、消息与堆栈，不展开自有属性（body-parser 错误会带原始请求体，http 错误可能带响应内容）；
 * - QueryFailedError 的消息与 parameters 可能包含业务值、联系方式或令牌散列，只输出驱动错误码；
 * - 启动失败另有更严格的口径：带字符串 code 的驱动/系统异常（连接拒绝、账号拒绝、文件缺失）消息里常含账号、主机或路径，只输出错误码；
 *   其余异常（自检、迁移等自有错误）保留消息与有限堆栈帧，并抹掉连接串中的账号口令，保证救援模式下仍能定位根因。
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

const STARTUP_ERROR_MESSAGE_MAX_LENGTH = 2_000
const STARTUP_ERROR_STACK_MAX_FRAMES = 8

/** 连接串形如 scheme://user:pass@host，日志中只保留协议与主机。 */
function redactUrlCredentials(text: string): string {
  return text.replaceAll(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@')
}

export function toSafeStartupErrorLog(error: unknown): Record<string, unknown> {
  if (isQueryFailedError(error)) return toSafeErrorLog(error)
  if (!(error instanceof Error)) return toSafeErrorLog(error)
  const errorWithCode = error as Error & { code?: unknown; errno?: unknown; sqlState?: unknown; syscall?: unknown }
  if (typeof errorWithCode.code === 'string') {
    return {
      name: error.name,
      code: errorWithCode.code.slice(0, 64),
      errno: typeof errorWithCode.errno === 'number' ? errorWithCode.errno : null,
      sqlState: typeof errorWithCode.sqlState === 'string' ? errorWithCode.sqlState.slice(0, 16) : null,
      syscall: typeof errorWithCode.syscall === 'string' ? errorWithCode.syscall.slice(0, 32) : null,
    }
  }
  // 堆栈首行会重复消息，只取 "at ..." 帧，避免未脱敏的消息绕过截断与连接串处理。
  const frames = (error.stack ?? '')
    .split('\n')
    .filter((line) => line.trimStart().startsWith('at '))
    .slice(0, STARTUP_ERROR_STACK_MAX_FRAMES)
    .map((line) => redactUrlCredentials(line.trim()))
  return {
    name: error.name,
    message: redactUrlCredentials(error.message.slice(0, STARTUP_ERROR_MESSAGE_MAX_LENGTH)),
    frames,
  }
}
