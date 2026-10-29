/**
 * 商城公开目录的进程内修订号。
 *
 * 商品、库存或门店展示配置成功提交后只需递增修订号；公开读缓存会在下一次请求时
 * 发现版本变化并立即重建。配置 Redis 后，修订号递增会经 Redis 总线广播，其他实例同步递增，
 * 多实例间的公开目录缓存即时失效；未配置或广播丢失时仍由很短的 HTTP/L1 TTL 保证最终刷新，
 * 结算与下单则始终回源数据库重新校验库存。
 *
 * 集群修订号：Redis 就绪时另在 Redis 中维护一个全局递增的修订号，作为跨实例共享快照（二级缓存）的键名组成部分。
 * 写入提交后先 INCR 再广播，同一连接上命令按序执行，其他实例收到广播后读到的一定是新修订号；
 * 在旧修订号下构建的快照只会写进旧键，提交后的读取永远不会命中提交前的快照。
 */
import { publishRedisBus, subscribeRedisBus } from '../redis/redis-bus.js'
import { getRedisClient, isRedisReady, recordRedisDegrade, redisKey } from '../redis/redis-client.js'
import { bumpSharedCacheGenerationInBackground } from '../redis/redis-cache.js'
import { BUSINESS_DATA_CACHE_GENERATION } from '../middleware/business-data-cache.middleware.js'

const MALL_CATALOG_BUS_TOPIC = 'cache:mall-catalog'
const clusterRevisionKey = () => redisKey('cache', 'mall-catalog', 'revision')

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
  const client = isRedisReady() ? getRedisClient() : null
  // 不等待结果：命令立即进入连接的发送队列，排在随后的广播之前；失败时共享快照仍受短 TTL 约束。
  client?.incr(clusterRevisionKey()).catch((error: unknown) => recordRedisDegrade('商城目录集群修订号', error))
  void publishRedisBus(MALL_CATALOG_BUS_TOPIC, null)
  // 商品、库存与订单变化同样影响报表和工作台：后台任务（如超时回收）不经过 HTTP 写入中间件，在此一并递增业务数据缓存代际。
  bumpSharedCacheGenerationInBackground(BUSINESS_DATA_CACHE_GENERATION)
  return revision
}

/**
 * 读取集群修订号，用于拼接共享快照键名；返回 null 表示 Redis 不可用，调用方应跳过二级缓存。
 * 从未失效过时键不存在，按 0 处理。
 */
export async function readMallCatalogClusterRevision(): Promise<string | null> {
  const client = isRedisReady() ? getRedisClient() : null
  if (!client) return null
  try {
    return (await client.get(clusterRevisionKey())) ?? '0'
  } catch (error) {
    recordRedisDegrade('商城目录集群修订号', error)
    return null
  }
}

// 其他实例的写入只需让本实例缓存失效，不再二次广播。
subscribeRedisBus(MALL_CATALOG_BUS_TOPIC, () => {
  bumpLocalRevision()
})
