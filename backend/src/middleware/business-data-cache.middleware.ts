/**
 * 模块说明：backend/src/middleware/business-data-cache.middleware.ts
 * 文件职责：业务写请求成功后、响应发出前递增“业务数据缓存代际”，让报表与工作台的共享缓存在写入后立即失效。
 * 实现逻辑：
 * - 只拦截 POST/PUT/PATCH/DELETE 且未配置为排除的接口；登录、登出、令牌刷新等不改变业务数据的认证接口不参与；
 * - 包装 res.end：状态码小于 400 时先等待 Redis 确认递增（最长 200ms），再真正结束响应。
 *   因而调用方收到写入成功后，无论下一次查询落到哪个实例，读到的都是新代际下的数据；
 * - 未配置 Redis 时不挂任何包装，零开销；Redis 不可用时只记录降级，不阻塞响应。
 * 维护说明：
 * - 报表与工作台的缓存键必须通过 getOrLoadSharedVersioned(BUSINESS_DATA_CACHE_GENERATION, ...) 编入代际；
 * - 后台任务（例如超时回收）不经过 HTTP，需要在提交后自行调用 bumpSharedCacheGenerationInBackground。
 */

import type { NextFunction, Request, Response } from 'express'
import { bumpSharedCacheGeneration } from '../redis/redis-cache.js'
import { isRedisEnabled } from '../redis/redis-client.js'

/** 报表、工作台等业务统计缓存共用的代际名。 */
export const BUSINESS_DATA_CACHE_GENERATION = 'business-data'

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** 不改变业务数据、且可能被高频调用的接口前缀：认证与会话类接口。 */
const EXCLUDED_PATH_PREFIXES = ['/api/auth/', '/api/client-auth/', '/api/v1/mobile-auth/']

export function businessDataCacheInvalidation(req: Request, res: Response, next: NextFunction): void {
  if (!isRedisEnabled() || !MUTATING_METHODS.has(req.method) || EXCLUDED_PATH_PREFIXES.some((prefix) => req.path.startsWith(prefix))) {
    next()
    return
  }
  const originalEnd = res.end.bind(res) as (...args: unknown[]) => Response
  let settled = false
  res.end = ((...args: unknown[]) => {
    if (settled || res.statusCode >= 400) {
      return originalEnd(...args)
    }
    settled = true
    void bumpSharedCacheGeneration(BUSINESS_DATA_CACHE_GENERATION).finally(() => {
      originalEnd(...args)
    })
    return res
  }) as typeof res.end
  next()
}
