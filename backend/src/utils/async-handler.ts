import type { NextFunction, Request, RequestHandler, Response } from 'express'

// 统一包装 async 路由，确保异常可进入全局错误处理中间件。
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(handler(req, res, next)).catch(next)
  }
}
