/**
 * 模块说明：backend/src/utils/async-handler.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
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
