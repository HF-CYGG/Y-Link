/**
 * 模块说明：backend/src/database/database-errors.ts
 * 文件职责：定义数据库基础设施可识别的业务化异常，避免把底层驱动错误直接暴露给接口调用方。
 */

import { BizError } from '../utils/errors.js'

/**
 * 数据库写队列或连接池已经饱和。
 *
 * 使用 503 而不是 500，明确告诉调用方这是可重试的瞬时过载，
 * 同时保持现有全局 BizError 处理链路兼容。
 */
export class DatabaseOverloadedError extends BizError {
  readonly reason: 'queue_full' | 'queue_timeout' | 'pool_timeout' | 'pool_queue_full'

  constructor(
    message = '数据库当前繁忙，请稍后重试',
    reason: DatabaseOverloadedError['reason'] = 'queue_full',
  ) {
    super(message, 503)
    this.name = 'DatabaseOverloadedError'
    this.reason = reason
  }
}
