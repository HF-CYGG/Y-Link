/**
 * 商城公开目录的进程内修订号。
 *
 * 商品、库存或门店展示配置成功提交后只需递增修订号；公开读缓存会在下一次请求时
 * 发现版本变化并立即重建。配置 Redis 后，修订号递增会经 Redis 总线广播，其他实例同步递增，
 * 多实例间的公开目录缓存即时失效；未配置或广播丢失时仍由很短的 HTTP/L1 TTL 保证最终刷新，
 * 结算与下单则始终回源数据库重新校验库存。
 */
import { publishRedisBus, subscribeRedisBus } from '../redis/redis-bus.js'

const MALL_CATALOG_BUS_TOPIC = 'cache:mall-catalog'

let currentRevision = 1

export function readMallCatalogRevision(): number {
  return currentRevision
}

const bumpLocalRevision = () => {
  currentRevision = currentRevision >= Number.MAX_SAFE_INTEGER ? 1 : currentRevision + 1
  return currentRevision
}

export function invalidateMallCatalogReadCache(): number {
  const revision = bumpLocalRevision()
  void publishRedisBus(MALL_CATALOG_BUS_TOPIC, null)
  return revision
}

// 其他实例的写入只需让本实例缓存失效，不再二次广播。
subscribeRedisBus(MALL_CATALOG_BUS_TOPIC, () => {
  bumpLocalRevision()
})
