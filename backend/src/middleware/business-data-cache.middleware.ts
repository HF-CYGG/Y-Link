/**
 * 模块说明：backend/src/middleware/business-data-cache.middleware.ts
 * 文件职责：在经营数据变更后更新报表与工作台缓存代际。
 * 实现逻辑：
 * - 仅为会影响经营聚合的写接口包装 res.end，复用服务在事务提交后已经发出的失效。
 * - 立即更新进程内代际。多实例等待同一次 Redis 递增，单实例先发送响应。
 * 维护说明：
 * - 报表与工作台的缓存键必须通过 getOrLoadSharedVersioned(BUSINESS_DATA_CACHE_GENERATION, ...) 编入代际；
 * - 后台任务和提交后可能返回错误的路径须在提交后主动调用 invalidateBusinessDataAfterCommit。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { NextFunction, Request, Response } from 'express'
import { env } from '../config/env.js'
import { bumpSharedCacheGeneration } from '../redis/redis-cache.js'
import { staticPathKey } from '../utils/static-path-key.js'

/** 报表、工作台等业务统计缓存共用的代际名。 */
export const BUSINESS_DATA_CACHE_GENERATION = 'business-data'

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

// 这些域的主要写入口修改订单、商品、规格、标签或预订库存。更窄的入口按实际数据依赖逐项匹配。
const BUSINESS_WRITE_PREFIXES = ['/api/orders', '/api/products', '/api/tags', '/api/o2o']
const READ_ONLY_ACTION = /\/(?:preview|labels|suggest-business-nos|export)$/
const MALL_DISPLAY_ONLY = /^\/api\/products\/(?:online-display\/batch|[^/]+\/online-display)$/
const O2O_DISPLAY_ONLY = /^\/api\/o2o\/orders\/[^/]+\/(?:business-status|merchant-message)$/
const CUSTOMER_ORDER_PRINT = /^\/api\/o2o\/mall\/preorders\/[^/]+\/customer-order-print$/

function affectsBusinessData(method: string, path: string): boolean {
  if (READ_ONLY_ACTION.test(path) || MALL_DISPLAY_ONLY.test(path) || O2O_DISPLAY_ONLY.test(path)) return false
  if (BUSINESS_WRITE_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix + '/'))) return true
  return (method === 'POST' && (
    path === '/api/client-feedback/restock-requests'
    || path === '/api/data-maintenance/import/json'
    || path === '/api/inbound/admin/verify'
    || path === '/api/inventory/docs'
    || /^\/api\/inventory\/(?:docs\/[^/]+\/void|stocktakes\/[^/]+\/complete)$/.test(path)
  )) || (method === 'DELETE' && /^\/api\/inbound\/supplier\/[^/]+\/verified$/.test(path))
}

const businessWrite = new AsyncLocalStorage<{ invalidation?: Promise<void> }>()

/** 提交后立即失效，即使客户端断连，或同一请求随后返回冲突、回读失败。 */
export function invalidateBusinessDataAfterCommit(): void {
  const scope = businessWrite.getStore()
  const invalidation = bumpSharedCacheGeneration(BUSINESS_DATA_CACHE_GENERATION, scope && env.Y_LINK_MULTI_INSTANCE ? 200 : 1_000)
  if (scope) scope.invalidation = invalidation
}

export function businessDataCacheInvalidation(req: Request, res: Response, next: NextFunction): void {
  if (!MUTATING_METHODS.has(req.method)) {
    next()
    return
  }
  const path = staticPathKey(req.path)
  const customerOrderPrint = CUSTOMER_ORDER_PRINT.test(path)
  // 客户打印只有实际提交了正式单字段变更时才失效，重复打印仅沿用响应约定。
  const invalidateOnSuccess = !customerOrderPrint && affectsBusinessData(req.method, path)
  if (!invalidateOnSuccess && !(customerOrderPrint && req.method === 'POST')) {
    next()
    return
  }
  const scope: { invalidation?: Promise<void> } = {}
  const originalEnd = res.end.bind(res) as (...args: unknown[]) => Response
  let settled = false
  res.end = ((...args: unknown[]) => {
    if (settled) return res
    settled = true
    if (invalidateOnSuccess && !scope.invalidation && res.statusCode >= 200 && res.statusCode < 300) {
      scope.invalidation = bumpSharedCacheGeneration(BUSINESS_DATA_CACHE_GENERATION, env.Y_LINK_MULTI_INSTANCE ? 200 : 1_000)
    }
    if (!env.Y_LINK_MULTI_INSTANCE || !scope.invalidation) return originalEnd(...args)
    void scope.invalidation.finally(() => {
      originalEnd(...args)
    })
    return res
  }) as typeof res.end
  businessWrite.run(scope, next)
}
