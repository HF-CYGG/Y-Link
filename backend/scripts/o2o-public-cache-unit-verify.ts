/** 无数据库依赖的公开商城缓存/HTTP 条件请求验收，便于在缺少本地 sqlite3 驱动的 CI 环境运行。 */
import assert from 'node:assert/strict'
import { setImmediate as nextTurn } from 'node:timers/promises'

process.env.NODE_ENV = 'test'
process.env.APP_PROFILE = 'o2o-public-cache-unit-verify'
process.env.DB_TYPE = 'mysql'
process.env.DB_HOST = '127.0.0.1'
process.env.DB_PORT = '3306'
process.env.DB_USER = 'catalog_verify'
process.env.DB_PASSWORD = ''
process.env.DB_NAME = 'catalog_verify'
process.env.DB_SYNC = 'false'

const [{ createApp }, { o2oPreorderService }, { invalidateMallCatalogReadCache }] = await Promise.all([
  import('../src/app.js'),
  import('../src/services/o2o-preorder.service.js'),
  import('../src/services/mall-catalog-revision.service.js'),
])

const mutableService = o2oPreorderService as unknown as {
  buildMallProductsUncached: () => Promise<unknown>
  loadMallStorefrontConfig: () => Promise<unknown>
}
let stock = 20
let catalogBuildCount = 0
mutableService.buildMallProductsUncached = async () => {
  catalogBuildCount += 1
  await new Promise((resolve) => setTimeout(resolve, 10))
  return {
    list: [{
      id: '1',
      productCode: 'CACHE-VERIFY-1',
      productName: '公开目录缓存验收',
      defaultPrice: '12.50',
      originalPrice: '12.50',
      discountRate: '10.0',
      discountedPrice: '12.50',
      o2oRecommended: false,
      tags: [],
      thumbnail: null,
      detailContent: '缓存验收',
      limitPerUser: 5,
      currentStock: stock,
      preOrderedStock: 0,
      availableStock: stock,
      soldQty: 0,
      skus: [],
    }],
    storefront: { businessHoursText: '10:00 - 22:00', mallAnnouncementText: '' },
  }
}
mutableService.loadMallStorefrontConfig = async () => ({
  businessHoursText: '10:00 - 22:00',
  mallAnnouncementText: '',
})

const coldSnapshots = await Promise.all(
  Array.from({ length: 100 }, () => o2oPreorderService.getMallProductsPublicSnapshot()),
)
assert.equal(catalogBuildCount, 1)
assert.equal(new Set(coldSnapshots.map((item) => item.generatedAt)).size, 1)
const firstEtag = coldSnapshots[0]?.etag
assert.ok(firstEtag)

stock = 21
invalidateMallCatalogReadCache()
const refreshedSnapshots = await Promise.all(
  Array.from({ length: 100 }, () => o2oPreorderService.getMallProductsPublicSnapshot()),
)
assert.equal(catalogBuildCount, 2)
assert.equal(new Set(refreshedSnapshots.map((item) => item.generatedAt)).size, 1)
assert.notEqual(refreshedSnapshots[0]?.etag, firstEtag)

const sales = o2oPreorderService as unknown as {
  resolveProductSoldQtyMap(ids: string[]): Promise<Map<string, number>>
  invalidateMallSoldQtyCache(): void
  queryProductSoldQty(ids: string[]): Promise<Map<string, number>>
}
const originalSalesQuery = sales.queryProductSoldQty
const pendingSalesReads: Array<(data: Map<string, number>) => void> = []
sales.queryProductSoldQty = () => new Promise((resolve) => pendingSalesReads.push(resolve))
try {
  sales.invalidateMallSoldQtyCache()
  const readSales = () => sales.resolveProductSoldQtyMap(['1'])
  const firstSalesRequests = Promise.all(Array.from({ length: 32 }, readSales))
  assert.equal(pendingSalesReads.length, 1)
  sales.invalidateMallSoldQtyCache()
  pendingSalesReads[0]!(new Map([['1', 4]]))
  await nextTurn()
  assert.equal(pendingSalesReads.length, 2, '同一换代后的等待者应共享第二次聚合')
  pendingSalesReads[1]!(new Map([['1', 8]]))
  assert.ok((await firstSalesRequests).every((result) => result.get('1') === 8))
  assert.equal((await readSales()).get('1'), 8)
  assert.equal(pendingSalesReads.length, 2)

  sales.invalidateMallSoldQtyCache()
  const repeatedInvalidation = Promise.allSettled(Array.from({ length: 32 }, readSales))
  assert.equal(pendingSalesReads.length, 3)
  sales.invalidateMallSoldQtyCache()
  pendingSalesReads[2]!(new Map([['1', 10]]))
  await nextTurn()
  assert.equal(pendingSalesReads.length, 4)
  sales.invalidateMallSoldQtyCache()
  pendingSalesReads[3]!(new Map([['1', 12]]))
  await nextTurn()
  assert.equal(pendingSalesReads.length, 4, '连续失效不得在同一请求内启动第三次聚合')
  assert.ok((await repeatedInvalidation).every((result) => result.status === 'rejected' && result.reason.statusCode === 503))

  const recovered = readSales()
  assert.equal(pendingSalesReads.length, 5, '任何失效结果都不得成为新修订的缓存')
  pendingSalesReads[4]!(new Map([['1', 16]]))
  assert.equal((await recovered).get('1'), 16)
} finally {
  sales.queryProductSoldQty = originalSalesQuery
  sales.invalidateMallSoldQtyCache()
}

const server = createApp().listen(0, '127.0.0.1')
await new Promise<void>((resolve, reject) => {
  server.once('listening', resolve)
  server.once('error', reject)
})
try {
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}/api/o2o/mall/products`
  const firstResponse = await fetch(url)
  assert.equal(firstResponse.status, 200)
  assert.match(firstResponse.headers.get('cache-control') ?? '', /^public, max-age=2/)
  const etag = firstResponse.headers.get('etag')
  assert.ok(etag)
  const conditionalResponse = await fetch(url, { headers: { 'If-None-Match': etag } })
  assert.equal(conditionalResponse.status, 304)
  assert.equal(conditionalResponse.headers.get('etag'), etag)
  assert.equal(await conditionalResponse.text(), '')
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

console.log('✅ 公开商城 singleflight、修订失效、ETag 与 If-None-Match 304 功能验收通过')
