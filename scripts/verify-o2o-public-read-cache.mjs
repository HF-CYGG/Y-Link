import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relativePath) => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8')

const serviceSource = read('backend/src/services/o2o-preorder.service.ts')
const routeSource = read('backend/src/routes/o2o.routes.ts')
const revisionSource = read('backend/src/services/mall-catalog-revision.service.ts')

assert.match(serviceSource, /O2O_MALL_CATALOG_FRESH_TTL_MS = 2_000/)
assert.match(serviceSource, /O2O_MALL_CATALOG_STALE_TTL_MS = 30_000/)
assert.match(serviceSource, /mallProductsRefreshInFlight/)
assert.match(serviceSource, /mallProductsRefreshRevision/)
assert.match(serviceSource, /responseBody = JSON\.stringify\(\{ code: 0, message: 'ok', data \}\)/)
assert.match(serviceSource, /createHash\('sha256'\).*digest\('base64url'\)/)
assert.match(serviceSource, /O2O_MALL_SOLD_QTY_TTL_MS = 60_000/)
assert.match(serviceSource, /mallSoldQtyRefreshInFlight/)
assert.match(serviceSource, /invalidateMallReadCache\(\{ soldQtyChanged: true \}\)/)

assert.match(routeSource, /If-None-Match/i)
assert.match(routeSource, /res\.status\(304\)\.end\(\)/)
assert.match(routeSource, /public, max-age=2, stale-while-revalidate=30, stale-if-error=60/)
assert.match(routeSource, /public, max-age=5, stale-while-revalidate=60, stale-if-error=120/)
assert.match(routeSource, /sendPublicJsonSnapshot/)

assert.match(revisionSource, /Number\.MAX_SAFE_INTEGER/)
assert.match(revisionSource, /invalidateMallCatalogReadCache/)

for (const relativePath of [
  'backend/src/services/product.service.ts',
  'backend/src/services/tag.service.ts',
  'backend/src/services/inbound.service.ts',
  'backend/src/services/system-config.service.ts',
]) {
  assert.match(
    read(relativePath),
    /invalidateMallCatalogReadCache/,
    `${relativePath} 必须在公开目录相关写入提交后递增修订号`,
  )
}

console.log('✅ O2O 公开读缓存、singleflight、销量聚合缓存、写后失效与 ETag/304 静态契约通过')
