/**
 * 文件说明：按路径集合限制进程内同时处理中的请求数，超出直接返回 503 + Retry-After，不排队。
 * 实现逻辑：
 * - 复用有界并发闸门（排队上限 0）：请求进入时申请槽位，响应完成或连接关闭时释放，只释放一次；
 * - 只作用于调用方给定的路径集合（如匿名登录、注册、发码入口），其余请求直接放行；
 * - 挂在限流中间件之前：在途上限拦下的请求不再消耗限流存储（MySQL 模式下是数据库读写）。
 * 维护说明：路径集合按路由挂载点内的相对路径书写（与 express-rate-limit 的 skip 判断一致），新增匿名入口时同步登记。
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { BoundedConcurrencyGate } from '../utils/bounded-concurrency.js'

export function createInFlightLimitMiddleware(options: {
  gate: BoundedConcurrencyGate
  limitedPaths: ReadonlySet<string>
}): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!options.limitedPaths.has(req.path)) {
      next()
      return
    }
    options.gate
      .run(() => new Promise<void>((resolve) => {
        let released = false
        const release = () => {
          if (released) return
          released = true
          resolve()
        }
        res.once('finish', release)
        res.once('close', release)
        next()
      }))
      .catch(next)
  }
}
