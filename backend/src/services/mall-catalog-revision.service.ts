/**
 * 商城公开目录的进程内修订号。
 *
 * 商品、库存或门店展示配置成功提交后只需递增修订号；公开读缓存会在下一次请求时
 * 发现版本变化并立即重建。该机制不承担跨实例广播，MySQL 多实例部署仍由很短的
 * HTTP/L1 TTL 保证最终刷新，结算与下单则始终回源数据库重新校验库存。
 */
let currentRevision = 1

export function readMallCatalogRevision(): number {
  return currentRevision
}

export function invalidateMallCatalogReadCache(): number {
  currentRevision = currentRevision >= Number.MAX_SAFE_INTEGER ? 1 : currentRevision + 1
  return currentRevision
}
