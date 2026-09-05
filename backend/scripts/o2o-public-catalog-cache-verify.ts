/**
 * 公开商城读路径专项验收：
 * 1. 并发冷启动请求只生成一个目录快照（singleflight）；
 * 2. 商品提交后进程内修订号立即淘汰旧快照；
 * 3. HTTP 返回 public cache、强 ETag，并正确处理 If-None-Match 304。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ylink-mall-cache-verify-'))
process.env.NODE_ENV = 'test'
process.env.APP_PROFILE = 'o2o-public-catalog-cache-verify'
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'true'
process.env.SQLITE_DB_PATH = path.join(tempRoot, 'catalog.sqlite')
process.env.INIT_ADMIN_USERNAME = 'admin'
process.env.INIT_ADMIN_PASSWORD = 'CatalogCacheVerify_Aa1!'
process.env.INIT_ADMIN_DISPLAY_NAME = 'Catalog Cache Verify'

const run = async () => {
  const [{ AppDataSource }, { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime }, { createApp },
    { o2oPreorderService }, { productService }, { systemConfigService }] = await Promise.all([
    import('../src/config/data-source.js'),
    import('../src/config/database-bootstrap.js'),
    import('../src/app.js'),
    import('../src/services/o2o-preorder.service.js'),
    import('../src/services/product.service.js'),
    import('../src/services/system-config.service.js'),
  ])

  prepareDatabaseRuntime()
  await AppDataSource.initialize()
  await initializeDatabaseSchemaIfNeeded(AppDataSource)
  await systemConfigService.ensureDefaultConfigs()

  const product = await productService.create({
    productName: `公开目录缓存验收-${Date.now()}`,
    defaultPrice: 12.5,
    isActive: true,
    o2oStatus: 'listed',
    currentStock: 20,
    detailContent: '仅用于公开读路径专项验收',
  })

  const coldSnapshots = await Promise.all(
    Array.from({ length: 100 }, () => o2oPreorderService.getMallProductsPublicSnapshot()),
  )
  assert.equal(new Set(coldSnapshots.map((item) => item.generatedAt)).size, 1, '冷启动并发请求应共用 singleflight 快照')
  assert.equal(new Set(coldSnapshots.map((item) => item.etag)).size, 1, '同一目录快照 ETag 应稳定')
  const firstSnapshot = coldSnapshots[0]
  assert.ok(firstSnapshot)
  assert.ok(firstSnapshot.data.list.some((item) => item.id === product.id))

  await productService.update(product.id, { currentStock: 21 })
  const refreshedSnapshots = await Promise.all(
    Array.from({ length: 100 }, () => o2oPreorderService.getMallProductsPublicSnapshot()),
  )
  assert.equal(new Set(refreshedSnapshots.map((item) => item.generatedAt)).size, 1, '修订号变化后并发重建仍应合并')
  const refreshedSnapshot = refreshedSnapshots[0]
  assert.ok(refreshedSnapshot)
  assert.notEqual(refreshedSnapshot.etag, firstSnapshot.etag, '商品库存变化后 ETag 必须变化')
  assert.equal(
    refreshedSnapshot.data.list.find((item) => item.id === product.id)?.currentStock,
    21,
    '缓存失效后应读取已提交的新库存',
  )

  const server = createApp().listen(0, '127.0.0.1')
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}/api/o2o/mall/products`
  const firstResponse = await fetch(url)
  assert.equal(firstResponse.status, 200)
  assert.match(firstResponse.headers.get('cache-control') ?? '', /^public, max-age=2/)
  const etag = firstResponse.headers.get('etag')
  assert.ok(etag)
  const payload = await firstResponse.json() as { code: number; data: { list: unknown[] } }
  assert.equal(payload.code, 0)
  assert.ok(payload.data.list.length > 0)

  const conditionalResponse = await fetch(url, { headers: { 'If-None-Match': etag } })
  assert.equal(conditionalResponse.status, 304)
  assert.equal(await conditionalResponse.text(), '')
  assert.equal(conditionalResponse.headers.get('etag'), etag)

  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  await AppDataSource.destroy()
}

run()
  .then(() => {
    console.log('✅ 公开商城 L1/singleflight、提交后失效与 HTTP ETag/304 验收通过')
  })
  .finally(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
