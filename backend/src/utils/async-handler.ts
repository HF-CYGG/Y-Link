/**
 * 模块说明：backend/src/utils/async-handler.ts
 * 文件职责：异步路由包装器，统一把 Promise 异常交给 Express 错误中间件。
 * 实现逻辑：
 * - 包装 async 路由处理函数；
 * - 捕获 rejected 异常并调用 next(error)；
 * - 避免在每个路由手写 try/catch。
 * 维护说明：
 * - 新增路由默认应使用该包装器，确保异常路径可观测。
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express'

// 统一包装 async 路由，确保异常可进入全局错误处理中间件。
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(handler(req, res, next)).catch(next)
  }
}
