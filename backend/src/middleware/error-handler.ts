/**
 * 模块说明：backend/src/middleware/error-handler.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import type { NextFunction, Request, Response } from 'express'
import { mapDatabaseErrorToBizError } from '../utils/database-errors.js'
import { BizError } from '../utils/errors.js'

/**
 * 全局 404 处理中间件：
 * - 拦截所有未匹配到的前端路由请求，返回标准化的错误响应，防止浏览器收到不可解析的 HTML 或超时。
 */
export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({
    code: 404,
    message: '接口不存在',
    data: null,
  })
}

/**
 * 全局异常处理中间件：
 * - 捕获控制器与服务层抛出的所有同步/异步异常。
 * - 优先处理已知的业务异常 (BizError)；
 * - 针对数据库级别的约束异常（如外键或唯一性冲突），通过映射器转换为对用户友好的错误提示，并掩盖底层 SQL 细节；
 * - 其他未知异常统一返回 500 状态码，并在控制台记录堆栈。
 */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof BizError) {
    res.status(err.statusCode).json({
      code: err.statusCode,
      message: err.message,
      data: null,
    })
    return
  }

  const mappedDatabaseError = mapDatabaseErrorToBizError(err)
  if (mappedDatabaseError) {
    console.error('[y-link-backend] database error:', err)
    res.status(mappedDatabaseError.statusCode).json({
      code: mappedDatabaseError.statusCode,
      message: mappedDatabaseError.message,
      data: null,
    })
    return
  }

  console.error('[y-link-backend] unexpected error:', err)
  res.status(500).json({
    code: 500,
    message: '服务端异常，请稍后重试',
    data: null,
  })
}
