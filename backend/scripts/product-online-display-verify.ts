/**
 * 商品线上展示接口隔离回归：真实 HTTP 权限、参数与 CSRF，SQLite 事务、推荐基线、字段隔离和审计。
 */
import 'reflect-metadata'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Server } from 'node:http'
import { requestLocalHttp } from './support/local-http-request.js'

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sqliteRoot = path.resolve(backendRoot, 'data', 'local-dev')
const seed = `${process.pid}-${Date.now()}`
const sqlitePath = path.join(sqliteRoot, `product-online-display-${seed}.sqlite`)
const adminPassword = `Admin_${seed}_Aa1!`
const supplierPassword = `Supplier_${seed}_Cc3!`

delete process.env.ENV_FILE
process.env.Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE = 'true'
process.env.APP_PROFILE = `product-online-display-${seed}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'false'
process.env.DB_AUTO_MIGRATE = 'false'
process.env.SQLITE_DB_PATH = sqlitePath
process.env.INIT_ADMIN_PASSWORD = adminPassword

type ApiPayload<T> = { code: number; message: string; data: T }
type Product = {
  id: string
  o2oStatus: string
  o2oRecommended: boolean
  detailContent: string | null
  limitPerUser: number
  skus: Array<{ id: string; isCurrent: boolean; isActive: boolean; o2oRecommended: boolean }>
}

async function json<T>(response: Response, expectedStatus: number): Promise<ApiPayload<T>> {
  const payload = await response.json() as ApiPayload<T>
  assert.equal(response.status, expectedStatus, `HTTP ${response.status}: ${JSON.stringify(payload)}`)
  return payload
}

function cleanup(): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(`${sqlitePath}${suffix}`, { force: true })
}

async function main(): Promise<void> {
  fs.mkdirSync(sqliteRoot, { recursive: true })
  const { AppDataSource } = await import('../src/config/data-source.js')
  const { env } = await import('../src/config/env.js')
  const { prepareDatabaseRuntime, initializeDatabaseSchemaIfNeeded } = await import('../src/config/database-bootstrap.js')
  const { authService } = await import('../src/services/auth.service.js')
  const { systemConfigService } = await import('../src/services/system-config.service.js')
  const { createApp } = await import('../src/app.js')
  const { BaseProduct } = await import('../src/entities/base-product.entity.js')
  const { BaseProductSku } = await import('../src/entities/base-product-sku.entity.js')
  const { SysAuditLog } = await import('../src/entities/sys-audit-log.entity.js')
  const { readMallCatalogRevision } = await import('../src/services/mall-catalog-revision.service.js')
  assert.equal(path.resolve(env.SQLITE_DB_PATH), sqlitePath, '必须使用本轮隔离 SQLite')
  let server: Server | undefined
  try {
    prepareDatabaseRuntime()
    await AppDataSource.initialize()
    await initializeDatabaseSchemaIfNeeded(AppDataSource)
    await authService.ensureDefaultAdmin()
    await systemConfigService.ensureDefaultConfigs()
    server = createApp().listen(0, '127.0.0.1')
    if (!server.listening) await new Promise<void>((resolve) => server!.once('listening', resolve))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`
    const send = (token: string | null, method: string, url: string, body: unknown, extraHeaders: Record<string, string> = {}) =>
      requestLocalHttp(`${base}${url}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...extraHeaders,
        },
        body: JSON.stringify(body),
      })
    const login = async (username: string, password: string): Promise<string> => {
      const response = await send(null, 'POST', '/api/auth/login', { username, password })
      const payload = await json<{ token?: string }>(response, 200)
      const cookies = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.()
        ?? [response.headers.get('set-cookie') ?? '']
      const token = payload.data.token ?? cookies.join(',').match(/(?:^|,\s*)y_link_admin_session=([^;]+)/)?.[1]
      assert.ok(token)
      return decodeURIComponent(token)
    }
    const admin = await login('admin', adminPassword)
    const category = (await json<{ id: string }>(await send(admin, 'POST', '/api/inventory/categories', {
      categoryCode: '88', categoryName: '线上展示验证分类',
    }), 200)).data
    const location = (await json<{ id: string }>(await send(admin, 'POST', '/api/inventory/locations', {
      locationCode: 'od-01', locationName: '线上展示验证库位',
    }), 200)).data
    const created = (await json<Product>(await send(admin, 'POST', '/api/products', {
      productName: `线上展示验证商品-${seed}`,
      categoryId: category.id,
      defaultPrice: 25,
      currentStock: 20,
      thumbnail: '/uploads/products/fixture.png',
      detailContent: '旧详情',
      specGroups: [{ name: '颜色', values: ['红', '蓝'] }],
      skus: [
        { skuCode: `OD-RED-${seed}`, specValues: { 颜色: '红' }, defaultPrice: 25, currentStock: 8,
          barcode: `ODRED${seed}`, locationId: location.id, thumbnail: '/uploads/products/red.png', isActive: true },
        { skuCode: `OD-BLUE-${seed}`, specValues: { 颜色: '蓝' }, defaultPrice: 30, currentStock: 12,
          barcode: `ODBLUE${seed}`, locationId: location.id, thumbnail: '/uploads/products/blue.png', isActive: true },
      ],
    }), 200)).data
    const [red, blue] = created.skus
    assert.ok(red && blue)
    const extra = (await json<Product>(await send(admin, 'POST', '/api/products', {
      productName: `线上展示批量商品-${seed}`, defaultPrice: 10, currentStock: 1,
    }), 200)).data
    const inactive = (await json<Product>(await send(admin, 'POST', '/api/products', {
      productName: `线上展示停用商品-${seed}`, defaultPrice: 10, currentStock: 1, isActive: false,
    }), 200)).data
    const supplier = (await json<{ username: string }>(await send(admin, 'POST', '/api/users', {
      username: `online_supplier_${seed.replaceAll('-', '_')}`,
      password: supplierPassword,
      displayName: '线上展示越权验证供货方',
      role: 'supplier', status: 'enabled',
    }), 200)).data
    const supplierToken = await login(supplier.username, supplierPassword)
    const itemUrl = `/api/products/${created.id}/online-display`
    const batchUrl = '/api/products/online-display/batch'

    await json(await send(null, 'PATCH', itemUrl, { o2oStatus: 'listed' }), 401)
    await json(await send(supplierToken, 'PATCH', itemUrl, { o2oStatus: 'listed' }), 403)
    await json(await send(supplierToken, 'PATCH', batchUrl, { ids: [created.id], o2oStatus: 'listed' }), 403)
    await json(await requestLocalHttp(`${base}${itemUrl}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: `y_link_admin_session=${encodeURIComponent(admin)}` },
      body: JSON.stringify({ o2oStatus: 'listed' }),
    }), 403)
    await json(await requestLocalHttp(`${base}${itemUrl}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: 'y_link_admin_session=invalid' },
      body: JSON.stringify({ o2oStatus: 'listed' }),
    }), 401)
    for (const body of [{}, { defaultPrice: 1 }, { recommendation: { mode: 'selected', skuIds: [], expectedSkuIds: [] } },
      { recommendation: { mode: 'all', skuIds: [red.id], expectedSkuIds: [] } }]) {
      await json(await send(admin, 'PATCH', itemUrl, body), 400)
    }
    await json(await send(admin, 'PATCH', batchUrl, { ids: [], o2oStatus: 'listed' }), 400)

    const productRepo = AppDataSource.getRepository(BaseProduct)
    const skuRepo = AppDataSource.getRepository(BaseProductSku)
    const protectedProductFields = async () => {
      const row = await productRepo.findOneByOrFail({ id: created.id })
      return { defaultPrice: row.defaultPrice, discountRate: row.discountRate, currentStock: row.currentStock,
        preOrderedStock: row.preOrderedStock, thumbnail: row.thumbnail, isActive: row.isActive }
    }
    const protectedSkuFields = async () => (await skuRepo.find({ where: { productId: created.id }, order: { id: 'ASC' } }))
      .map((row) => ({ id: row.id, isCurrent: row.isCurrent, isActive: row.isActive, defaultPrice: row.defaultPrice,
        currentStock: row.currentStock, preOrderedStock: row.preOrderedStock, barcode: row.barcode,
        locationId: row.locationId, thumbnail: row.thumbnail, skuCode: row.skuCode }))
    const productBefore = await protectedProductFields()
    const skuBefore = await protectedSkuFields()
    const baseline = created.skus.map((sku) => sku.id)
    const revisionBefore = readMallCatalogRevision()
    const selected = (await json<Product>(await send(admin, 'PATCH', itemUrl, {
      o2oStatus: 'listed', detailContent: '新详情', limitPerUser: 7,
      recommendation: { mode: 'selected', skuIds: [red.id], expectedSkuIds: baseline },
    }), 200)).data
    assert.equal(selected.o2oStatus, 'listed')
    assert.equal(selected.detailContent, '新详情')
    assert.equal(selected.limitPerUser, 7)
    assert.equal(selected.o2oRecommended, false)
    assert.equal(selected.skus.find((sku) => sku.id === red.id)?.o2oRecommended, true)
    assert.equal(selected.skus.find((sku) => sku.id === blue.id)?.o2oRecommended, false)
    assert.ok(readMallCatalogRevision() > revisionBefore)
    assert.deepEqual(await protectedProductFields(), productBefore)
    assert.deepEqual(await protectedSkuFields(), skuBefore)
    const actionRepo = AppDataSource.getRepository(SysAuditLog)
    assert.equal(await actionRepo.countBy({ actionType: 'product.online_display.update', targetId: created.id }), 1)

    const staleRevision = readMallCatalogRevision()
    await json(await send(admin, 'PATCH', itemUrl, {
      recommendation: { mode: 'selected', skuIds: ['missing'], expectedSkuIds: baseline },
    }), 409)
    assert.equal(readMallCatalogRevision(), staleRevision)
    const all = (await json<Product>(await send(admin, 'PATCH', itemUrl, {
      recommendation: { mode: 'all', expectedSkuIds: baseline },
    }), 200)).data
    assert.equal(all.o2oRecommended, true)
    assert.ok(all.skus.every((sku) => !sku.o2oRecommended))
    const none = (await json<Product>(await send(admin, 'PATCH', itemUrl, {
      recommendation: { mode: 'none', expectedSkuIds: baseline },
    }), 200)).data
    assert.equal(none.o2oRecommended, false)

    await json(await send(admin, 'PATCH', `/api/products/${inactive.id}/online-display`, { o2oStatus: 'listed' }), 409)
    await json(await send(admin, 'PATCH', batchUrl, { ids: [extra.id, inactive.id], o2oStatus: 'listed' }), 409)
    assert.equal((await productRepo.findOneByOrFail({ id: extra.id })).o2oStatus, 'unlisted', '批量上架必须原子回滚')
    await json(await send(admin, 'PATCH', batchUrl, { ids: [extra.id, 'missing'], o2oStatus: 'listed' }), 404)
    assert.equal((await productRepo.findOneByOrFail({ id: extra.id })).o2oStatus, 'unlisted')
    const batch = (await json<{ ids: string[]; updatedCount: number }>(await send(admin, 'PATCH', batchUrl, {
      ids: [extra.id, created.id, extra.id], o2oStatus: 'unlisted',
    }), 200)).data
    assert.deepEqual(batch.ids, [created.id, extra.id].sort((left, right) => left.localeCompare(right)))
    assert.equal(batch.updatedCount, 1)
    assert.equal((await productRepo.findOneByOrFail({ id: created.id })).o2oStatus, 'unlisted')
    assert.equal(await actionRepo.countBy({ actionType: 'product.online_display.batch_status', targetId: created.id }), 1)

    // 打开弹窗后的规格集合变化：新增当前 SKU 后，旧基线必须在任何展示字段落库前 409。
    const replacement = (await json<Product>(await send(admin, 'PUT', `/api/products/${created.id}`, {
      specGroups: [{ name: '颜色', values: ['红', '蓝', '绿'] }],
      skus: [
        { id: red.id, skuCode: `OD-RED-${seed}`, specValues: { 颜色: '红' }, defaultPrice: 25, currentStock: 8,
          barcode: `ODRED${seed}`, locationId: location.id, thumbnail: '/uploads/products/red.png', isActive: true },
        { id: blue.id, skuCode: `OD-BLUE-${seed}`, specValues: { 颜色: '蓝' }, defaultPrice: 30, currentStock: 12,
          barcode: `ODBLUE${seed}`, locationId: location.id, thumbnail: '/uploads/products/blue.png', isActive: true },
        { skuCode: `OD-GREEN-${seed}`, specValues: { 颜色: '绿' }, defaultPrice: 15, currentStock: 0, isActive: true },
      ],
    }), 200)).data
    assert.equal(replacement.skus.length, 3)
    await json(await send(admin, 'PATCH', itemUrl, {
      detailContent: '不能落库', recommendation: { mode: 'selected', skuIds: [red.id], expectedSkuIds: baseline },
    }), 409)
    assert.equal((await productRepo.findOneByOrFail({ id: created.id })).detailContent, '新详情')
    const green = replacement.skus.find((sku) => sku.id !== red.id && sku.id !== blue.id)
    assert.ok(green)
    await json<Product>(await send(admin, 'PUT', `/api/products/${created.id}`, {
      specGroups: [{ name: '颜色', values: ['红', '绿'] }],
      skus: [
        { id: red.id, skuCode: `OD-RED-${seed}`, specValues: { 颜色: '红' }, defaultPrice: 25, currentStock: 8,
          barcode: `ODRED${seed}`, locationId: location.id, thumbnail: '/uploads/products/red.png', isActive: true },
        { id: green.id, skuCode: `OD-GREEN-${seed}`, specValues: { 颜色: '绿' }, defaultPrice: 15,
          currentStock: 0, isActive: false },
      ],
    }), 200)
    const retiredBefore = await skuRepo.findOneByOrFail({ id: blue.id })
    assert.equal(Boolean(retiredBefore.isCurrent), false)
    await json(await send(admin, 'PATCH', itemUrl, {
      recommendation: { mode: 'selected', skuIds: [green.id], expectedSkuIds: [red.id, green.id] },
    }), 409)
    await json<Product>(await send(admin, 'PATCH', itemUrl, {
      recommendation: { mode: 'all', expectedSkuIds: [red.id, green.id] },
    }), 200)
    assert.deepEqual(await skuRepo.findOneByOrFail({ id: blue.id }), retiredBefore, '退役 SKU 不得被展示更新改写')
    assert.equal(await actionRepo.countBy({ actionType: 'product.online_display.update', targetId: created.id }), 4)
    console.log('商品线上展示隔离回归通过：权限、参数、字段隔离、推荐基线、批量原子性、缓存和审计')
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
  }
}

try {
  cleanup()
  await main()
} catch (error) {
  console.error('商品线上展示隔离回归失败', error)
  process.exitCode = 1
} finally {
  cleanup()
}
