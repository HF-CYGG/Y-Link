/**
 * 文件说明：异步路由包装工具，用于把 Express 异步处理函数中的异常统一转交给全局错误处理中间件。
 * 实现逻辑：把传入的异步处理器包装成标准 RequestHandler，并在 Promise 链尾统一调用 next 捕获异常。
 * 维护重点：若替换 Express 版本或调整错误处理中间件链路，需要同步验证这里的异常透传行为仍然成立。
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
