/**
 * 文件说明：backend/scripts/inventory-http-permission-verify.ts
 * 文件职责：经过真实 Express 中间件回归库存管理接口的鉴权、权限点、CSRF、盲盘裁剪、成本价裁剪与上传校验。
 * 实现逻辑：
 * 1) 强制使用本轮唯一 SQLite 临时库，并在动态导入数据库配置前锁定环境；
 * 2) 管理员登录后建分类、库位、商品，再创建操作员与供货方账号并分别登录；
 * 3) 逐个接口验证 admin / operator / supplier 的正反向权限与数据裁剪；
 * 4) 无论成功失败都关闭服务并删除临时库。
 * 维护说明：新增库存接口时同步补充这里的越权用例；口令均为本轮随机生成，只用于临时库。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { request as httpRequest, type Server } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ExcelJS from 'exceljs'
import { requestLocalHttp } from './support/local-http-request.js'

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sqliteRoot = path.resolve(backendRoot, 'data', 'local-dev')
const verifySeed = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const sqlitePath = path.resolve(sqliteRoot, `inventory-http-permission-${verifySeed}.sqlite`)
const adminPassword = `Admin_${verifySeed}_Zz9!`
const operatorPassword = `Op_${verifySeed}_Aa1!`
const supplierPassword = `Supplier_${verifySeed}_Cc3!`

delete process.env.ENV_FILE
process.env.Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE = 'true'
process.env.APP_PROFILE = `inventory-http-permission-${verifySeed}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'false'
process.env.DB_AUTO_MIGRATE = 'false'
process.env.SQLITE_DB_PATH = sqlitePath
delete process.env.DB_NAME
process.env.INIT_ADMIN_PASSWORD = adminPassword

type JsonPayload = { code?: number; message?: string; data?: unknown }
type Session = { token: string; csrfToken: string }

const pass = (message: string) => {
  // eslint-disable-next-line no-console
  console.log(`✅ ${message}`)
}

async function readJson(response: Response): Promise<JsonPayload> {
  const text = await response.text()
  try {
    return JSON.parse(text) as JsonPayload
  } catch {
    throw new Error(`响应不是合法 JSON，status=${response.status} body=${text.slice(0, 200)}`)
  }
}

async function expectOk<T>(response: Promise<Response>, scene: string): Promise<T> {
  const res = await response
  const payload = await readJson(res)
  assert.equal(res.status, 200, `${scene} 期望 200，实际 ${res.status}：${JSON.stringify(payload)}`)
  assert.equal(payload.code, 0, `${scene} 业务码异常：${JSON.stringify(payload)}`)
  return payload.data as T
}

async function expectStatus(response: Promise<Response>, scene: string, status: number): Promise<JsonPayload> {
  const res = await response
  const payload = await readJson(res)
  assert.equal(res.status, status, `${scene} 期望 ${status}，实际 ${res.status}：${JSON.stringify(payload)}`)
  return payload
}

function readCookie(response: Response, name: string): string | null {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] }
  const raw = (headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? '']).join(',')
  const match = raw.match(new RegExp(`(?:^|,\\s*)${name}=([^;]+)`))
  return match?.[1] ? decodeURIComponent(match[1]) : null
}

/** 发送二进制请求体（multipart 上传），返回与 requestLocalHttp 一致的 Response。 */
function requestBinary(url: string, method: string, headers: Record<string, string>, body: Buffer): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(new URL(url), { method, headers: { ...headers, 'Content-Length': String(body.length) } }, (incoming) => {
      const chunks: Uint8Array[] = []
      incoming.on('data', (chunk: Uint8Array) => chunks.push(chunk))
      incoming.on('end', () => {
        const responseHeaders = new Headers()
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          responseHeaders.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!)
        }
        resolve(new Response(new Uint8Array(Buffer.concat(chunks)), { status: incoming.statusCode ?? 500, headers: responseHeaders }))
      })
    })
    // 服务端提前拒绝超大上传时可能直接断开连接，此时以已收到的响应为准。
    req.once('error', reject)
    req.end(body)
  })
}

function buildMultipart(fileName: string, content: Uint8Array, contentType: string) {
  const boundary = `----ylink${randomUUID().replaceAll('-', '')}`
  const encoder = new TextEncoder()
  const head = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  )
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`)
  return { body: Buffer.concat([head, content, tail]), contentType: `multipart/form-data; boundary=${boundary}` }
}

async function readXlsxHeaders(buffer: ArrayBuffer): Promise<string[]> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)
  const sheet = workbook.worksheets[0]
  assert.ok(sheet, '导出文件缺少工作表')
  const headers: string[] = []
  sheet.getRow(1).eachCell((cell) => headers.push(String(cell.value ?? '')))
  return headers
}

function cleanupSqliteFile() {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    fs.rmSync(`${sqlitePath}${suffix}`, { force: true })
  }
}

async function main() {
  fs.mkdirSync(sqliteRoot, { recursive: true })
  const { createApp } = await import('../src/app.js')
  const { AppDataSource } = await import('../src/config/data-source.js')
  const { env } = await import('../src/config/env.js')
  const { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime } = await import('../src/config/database-bootstrap.js')
  const { authService } = await import('../src/services/auth.service.js')
  const { systemConfigService } = await import('../src/services/system-config.service.js')
  const { SysAuditLog } = await import('../src/entities/sys-audit-log.entity.js')

  assert.equal(path.resolve(env.SQLITE_DB_PATH), sqlitePath, '必须连接本轮临时库')
  let server: Server | undefined
  try {
    prepareDatabaseRuntime()
    await AppDataSource.initialize()
    await initializeDatabaseSchemaIfNeeded(AppDataSource)
    await authService.ensureDefaultAdmin()
    await systemConfigService.ensureDefaultConfigs()
    server = createApp().listen(0, '127.0.0.1')
    if (!server.listening) await new Promise<void>((resolve) => server!.once('listening', () => resolve()))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const baseUrl = `http://127.0.0.1:${address.port}`

    const login = async (username: string, password: string): Promise<Session> => {
      const res = await requestLocalHttp(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const data = await expectOk<{ token?: string }>(Promise.resolve(res), `${username} 登录`)
      const token = data.token ?? readCookie(res, 'y_link_admin_session')
      const csrfToken = readCookie(res, 'y_link_admin_csrf')
      assert.ok(token && csrfToken, `${username} 登录未返回会话`)
      return { token, csrfToken }
    }
    const bearer = (session: Session, json = true): Record<string, string> => ({
      Authorization: `Bearer ${session.token}`,
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    })
    const get = (session: Session | null, url: string) =>
      requestLocalHttp(`${baseUrl}${url}`, { headers: session ? bearer(session, false) : {} })
    const send = (session: Session, method: string, url: string, body?: unknown) =>
      requestLocalHttp(`${baseUrl}${url}`, { method, headers: bearer(session), body: JSON.stringify(body ?? {}) })

    // ---- 未登录 ----
    for (const url of ['/api/inventory/stocks', '/api/inventory/stocktakes', '/api/products/lookup?code=x', '/api/inventory/categories']) {
      await expectStatus(get(null, url), `未登录访问 ${url}`, 401)
    }
    pass('未登录访问库存接口返回 401')

    const admin = await login('admin', adminPassword)
    const category = await expectOk<{ id: string }>(send(admin, 'POST', '/api/inventory/categories', { categoryCode: '05', categoryName: '文具' }), '管理员建分类')
    const location = await expectOk<{ id: string }>(send(admin, 'POST', '/api/inventory/locations', { locationCode: 'c-01', locationName: 'C 区' }), '管理员建库位')
    const product = await expectOk<{ id: string; skus: Array<{ id: string; skuCode: string; costPrice: string | null }> }>(
      send(admin, 'POST', '/api/products', {
        productName: `权限回归笔记本-${verifySeed}`,
        defaultPrice: 12,
        currentStock: 10,
        categoryId: category.id,
        defaultSku: { barcode: '6900000000017', costPrice: 3.5, locationId: location.id },
      }),
      '管理员建商品',
    )
    const sku = product.skus[0]!
    assert.match(sku.skuCode, /^WC05\d{3}$/, '有分类的新商品应生成 WC 编码')
    assert.equal(sku.costPrice, '3.50')
    pass('管理员可建分类、库位与带条码成本价的商品')

    const createUser = (role: 'operator' | 'supplier', password: string) =>
      expectOk<{ username: string }>(send(admin, 'POST', '/api/users', {
        username: `inv_${role}_${verifySeed}`.replaceAll('-', '_'),
        password,
        displayName: role === 'operator' ? '库存回归店员' : '库存回归供货方',
        role,
        status: 'enabled',
      }), `创建${role}`)
    const operator = await login((await createUser('operator', operatorPassword)).username, operatorPassword)
    const supplier = await login((await createUser('supplier', supplierPassword)).username, supplierPassword)

    // ---- 供货方：只能看商品，看不到成本价，也进不了库存与盘点 ----
    const supplierDetail = await expectOk<{ skus: Array<{ costPrice: string | null }> }>(get(supplier, `/api/products/${product.id}`), '供货方读商品详情')
    assert.equal(supplierDetail.skus[0]!.costPrice, null, '供货方不应看到成本价（详情）')
    const supplierList = await expectOk<Array<{ id: string; skus: Array<{ costPrice: string | null }> }>>(get(supplier, '/api/products'), '供货方读商品列表')
    assert.ok(supplierList.every((item) => item.skus.every((row) => row.costPrice === null)), '供货方不应看到成本价（列表）')
    const supplierPaged = await expectOk<{ list: Array<{ skus: Array<{ costPrice: string | null }> }> }>(get(supplier, '/api/products/paged?page=1&pageSize=20'), '供货方读商品分页')
    assert.ok(supplierPaged.list.every((item) => item.skus.every((row) => row.costPrice === null)), '供货方不应看到成本价（分页）')
    const supplierLookup = await expectOk<{ sku: { costPrice: string | null } }>(get(supplier, '/api/products/lookup?code=6900000000017'), '供货方扫码识别')
    assert.equal(supplierLookup.sku.costPrice, null, '供货方不应看到成本价（扫码识别）')
    const supplierExport = await get(supplier, '/api/products/export')
    assert.equal(supplierExport.status, 200)
    assert.ok(!(await readXlsxHeaders(await supplierExport.arrayBuffer())).includes('成本价'), '供货方导出不应包含成本价列')
    const adminExport = await get(admin, '/api/products/export')
    assert.ok((await readXlsxHeaders(await adminExport.arrayBuffer())).includes('成本价'), '管理员导出应包含成本价列')
    for (const url of ['/api/inventory/stocks', '/api/inventory/logs', '/api/inventory/logs/export', '/api/inventory/docs', '/api/inventory/stocktakes', '/api/products/import/template']) {
      await expectStatus(get(supplier, url), `供货方访问 ${url}`, 403)
    }
    await expectStatus(send(supplier, 'POST', '/api/inventory/docs', { docType: 'purchase_in', items: [{ skuId: sku.id, qty: 1 }] }), '供货方建库存单', 403)
    await expectStatus(send(supplier, 'POST', '/api/inventory/categories', { categoryCode: '06', categoryName: '越权' }), '供货方建分类', 403)
    await expectStatus(send(supplier, 'POST', '/api/inventory/stocktakes', { scopeType: 'all' }), '供货方建盘点单', 403)
    pass('供货方看不到成本价，库存、单据、盘点与导入接口全部 403')

    // ---- 店员：能看成本价（有商品维护权限），能建单，不能作废、不能审核盘点、不能导入 ----
    const operatorDetail = await expectOk<{ skus: Array<{ costPrice: string | null }> }>(get(operator, `/api/products/${product.id}`), '店员读商品详情')
    assert.equal(operatorDetail.skus[0]!.costPrice, '3.50')
    const requestId = randomUUID()
    const doc = await expectOk<{ id: string; docNo: string }>(
      send(operator, 'POST', '/api/inventory/docs', { docType: 'purchase_in', clientRequestId: requestId, items: [{ skuId: sku.id, qty: 5 }] }),
      '店员采购入库',
    )
    const replay = await expectOk<{ id: string }>(
      send(operator, 'POST', '/api/inventory/docs', { docType: 'purchase_in', clientRequestId: requestId, items: [{ skuId: sku.id, qty: 5 }] }),
      '店员重放同一请求',
    )
    assert.equal(replay.id, doc.id, '同一账号重放应返回原单')
    const mismatch = await expectStatus(
      send(operator, 'POST', '/api/inventory/docs', { docType: 'purchase_in', clientRequestId: requestId, items: [{ skuId: sku.id, qty: 6 }] }),
      '同一账号改了内容后重放',
      409,
    )
    assert.ok(String(mismatch.message).includes(doc.docNo), '内容不一致的重放应提示原单号')
    await expectStatus(
      send(operator, 'POST', '/api/inventory/docs', { docType: 'purchase_in', items: [{ skuId: sku.id, qty: 1 }, { skuId: sku.id, qty: 1 }] }),
      '同一规格重复行',
      400,
    )
    await expectStatus(
      send(admin, 'POST', '/api/inventory/docs', { docType: 'purchase_in', clientRequestId: requestId, items: [{ skuId: sku.id, qty: 5 }] }),
      '其他账号复用请求标识',
      409,
    )
    await expectStatus(send(operator, 'POST', `/api/inventory/docs/${doc.id}/void`, { reason: '越权作废' }), '店员作废单据', 403)
    await expectStatus(get(operator, '/api/products/import/template'), '店员下载导入模板', 403)
    const upload = buildMultipart('products.xlsx', new TextEncoder().encode('not-a-workbook'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    await expectStatus(requestBinary(`${baseUrl}/api/products/import/preview`, 'POST', { ...bearer(operator, false), 'Content-Type': upload.contentType }, upload.body), '店员预览导入', 403)
    await expectStatus(requestBinary(`${baseUrl}/api/products/import`, 'POST', { ...bearer(operator, false), 'Content-Type': upload.contentType }, upload.body), '店员执行导入', 403)
    pass('店员可建单且幂等重放只对本人生效；作废与导入被拒绝')

    // ---- 盲盘：店员计数看不到账面数与差异 ----
    const stocktake = await expectOk<{ id: string; canViewBook: boolean }>(
      send(operator, 'POST', '/api/inventory/stocktakes', { scopeType: 'sku', skuIds: [sku.id], blindMode: true }),
      '店员建盲盘单',
    )
    assert.equal(stocktake.canViewBook, false)
    const blindLookup = await expectOk<{ stockHidden: boolean; sku: { currentStock: number; availableStock: number } }>(
      get(operator, '/api/products/lookup?code=6900000000017&purpose=stocktake'),
      '店员盘点扫码',
    )
    assert.equal(blindLookup.stockHidden, true)
    assert.equal(blindLookup.sku.currentStock, 0)
    assert.equal(blindLookup.sku.availableStock, 0)
    const counted = await expectOk<Record<string, unknown>>(
      send(operator, 'POST', `/api/inventory/stocktakes/${stocktake.id}/count`, { skuId: sku.id, qty: 12, mode: 'set' }),
      '店员计数',
    )
    assert.ok(!JSON.stringify(counted).includes('"bookQty":15'), '计数响应不得包含账面数')
    const blindItems = await expectOk<{ list: Array<Record<string, unknown>> }>(get(operator, `/api/inventory/stocktakes/${stocktake.id}/items`), '店员读盘点明细')
    assert.equal(blindItems.list.length, 1)
    for (const field of ['bookQty', 'diffQty', 'diffReason', 'resolution', 'appliedQty']) {
      assert.equal(blindItems.list[0]![field], null, `盲盘明细不得下发 ${field}`)
    }
    const blindDetail = await expectOk<{ diffCount: number | null }>(get(operator, `/api/inventory/stocktakes/${stocktake.id}`), '店员读盘点单')
    assert.equal(blindDetail.diffCount, null, '盲盘单不得下发差异行数')
    await expectStatus(get(operator, `/api/inventory/stocktakes/${stocktake.id}/items?filter=diff`), '店员按差异筛选', 403)
    await expectOk(send(operator, 'POST', `/api/inventory/stocktakes/${stocktake.id}/submit`, {}), '店员提交盘点')
    const itemId = String(blindItems.list[0]!.id)
    await expectStatus(send(operator, 'PUT', `/api/inventory/stocktakes/${stocktake.id}/items/${itemId}/resolution`, { resolution: 'adjust', diffReason: 'lost' }), '店员处理差异', 403)
    for (const action of ['complete', 'reopen', 'cancel']) {
      await expectStatus(send(operator, 'POST', `/api/inventory/stocktakes/${stocktake.id}/${action}`, {}), `店员执行 ${action}`, 403)
    }
    pass('盲盘计数、明细、详情与扫码识别都不泄露账面数；差异处理与确认被拒绝')

    // ---- 管理员审核：可见差异并确认调账 ----
    const approverItems = await expectOk<{ list: Array<{ bookQty: number; diffQty: number }> }>(get(admin, `/api/inventory/stocktakes/${stocktake.id}/items?filter=diff`), '管理员读差异')
    assert.equal(approverItems.list[0]!.bookQty, 15)
    assert.equal(approverItems.list[0]!.diffQty, -3)
    await expectOk(send(admin, 'PUT', `/api/inventory/stocktakes/${stocktake.id}/items/${itemId}/resolution`, { resolution: 'adjust', diffReason: 'lost' }), '管理员处理差异')
    await expectOk(send(admin, 'POST', `/api/inventory/stocktakes/${stocktake.id}/complete`, {}), '管理员确认盘点')
    await expectStatus(send(admin, 'POST', `/api/inventory/stocktakes/${stocktake.id}/complete`, {}), '重复确认盘点', 409)
    const afterStocktake = await expectOk<{ skus: Array<{ currentStock: number }> }>(get(admin, `/api/products/${product.id}`), '确认后读库存')
    assert.equal(afterStocktake.skus[0]!.currentStock, 12)
    await expectOk(send(admin, 'POST', `/api/inventory/docs/${doc.id}/void`, { reason: '录入重复' }), '管理员作废入库单')
    await expectStatus(send(admin, 'POST', `/api/inventory/docs/${doc.id}/void`, { reason: '再次作废' }), '重复作废', 409)
    const afterVoid = await expectOk<{ skus: Array<{ currentStock: number }> }>(get(admin, `/api/products/${product.id}`), '作废后读库存')
    assert.equal(afterVoid.skus[0]!.currentStock, 7)
    pass('管理员可见差异、确认调账并作废单据；重复确认与重复作废返回 409')

    // ---- CSRF：Cookie 会话缺少 CSRF 头时拒绝写入 ----
    const cookieHeader = `y_link_admin_session=${encodeURIComponent(admin.token)}; y_link_admin_csrf=${encodeURIComponent(admin.csrfToken)}`
    await expectStatus(requestLocalHttp(`${baseUrl}/api/inventory/docs`, {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ docType: 'purchase_in', items: [{ skuId: sku.id, qty: 1 }] }),
    }), 'Cookie 会话缺少 CSRF 头', 403)
    await expectOk(requestLocalHttp(`${baseUrl}/api/inventory/docs`, {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'Content-Type': 'application/json', 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ docType: 'purchase_in', items: [{ skuId: sku.id, qty: 1 }] }),
    }), 'Cookie 会话携带 CSRF 头')
    pass('库存写接口受 Cookie 会话 CSRF 双提交校验保护')

    // ---- 上传校验与参数校验 ----
    const wrongExt = buildMultipart('products.csv', new TextEncoder().encode('a,b'), 'text/csv')
    await expectStatus(requestBinary(`${baseUrl}/api/products/import/preview`, 'POST', { ...bearer(admin, false), 'Content-Type': wrongExt.contentType }, wrongExt.body), '上传非 xlsx 文件', 400)
    const brokenXlsx = buildMultipart('products.xlsx', new TextEncoder().encode('not-a-workbook'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    await expectStatus(requestBinary(`${baseUrl}/api/products/import/preview`, 'POST', { ...bearer(admin, false), 'Content-Type': brokenXlsx.contentType }, brokenXlsx.body), '上传损坏的 xlsx', 400)
    const exportedWorkbook = new Uint8Array(await (await get(admin, '/api/products/export')).arrayBuffer())
    const realUpload = buildMultipart('products.xlsx', exportedWorkbook, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    await expectOk(requestBinary(`${baseUrl}/api/products/import/preview`, 'POST', { ...bearer(admin, false), 'Content-Type': realUpload.contentType }, realUpload.body), '上传真实 xlsx 预览')
    const oversized = buildMultipart('products.xlsx', new Uint8Array(5 * 1024 * 1024 + 16).fill(65), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    const oversizedRes = await requestBinary(`${baseUrl}/api/products/import/preview`, 'POST', { ...bearer(admin, false), 'Content-Type': oversized.contentType }, oversized.body)
    assert.ok(oversizedRes.status >= 400 && oversizedRes.status < 500, `超过 5MB 的上传应返回 4xx，实际 ${oversizedRes.status}`)
    await expectStatus(send(admin, 'POST', '/api/inventory/docs', { docType: 'purchase_in', items: [{ skuId: sku.id, qty: 1.5 }] }), '小数数量', 400)
    await expectStatus(send(admin, 'POST', '/api/inventory/docs', { docType: 'purchase_in', items: [{ skuId: sku.id, qty: 1e12 }] }), '超大数量', 400)
    await expectStatus(send(admin, 'POST', '/api/inventory/docs', { docType: 'other_out', reasonCode: 'gift', items: [{ skuId: sku.id, qty: 100000 }] }), '出库超过库存', 409)
    await expectStatus(send(admin, 'POST', '/api/inventory/docs', { docType: 'unknown', items: [{ skuId: sku.id, qty: 1 }] }), '未知单据类型', 400)
    await expectStatus(get(admin, '/api/inventory/logs?startDate=2026-9-1'), '非法日期', 400)
    const sortInjection = await expectOk<{ list: unknown[] }>(get(admin, `/api/inventory/stocks?keyword=${encodeURIComponent("%' OR 1=1 --")}`), '关键字注入')
    assert.equal(sortInjection.list.length, 0, '关键字应按参数绑定处理')
    pass('上传类型/损坏/超限、数量、单据类型、日期与关键字注入均被正确拒绝或隔离')

    const deniedLogs = await AppDataSource.getRepository(SysAuditLog).find({ where: { actionType: 'security.access_denied' } })
    assert.ok(deniedLogs.some((log) => String(log.targetCode ?? '').includes('/api/inventory/docs/')), '越权作废应写入审计')
    pass('越权访问写入 security.access_denied 审计')
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
  }
}

try {
  cleanupSqliteFile()
  await main()
  // eslint-disable-next-line no-console
  console.log('\n库存接口 HTTP 权限回归通过')
} catch (error) {
  // eslint-disable-next-line no-console
  console.error('\n库存接口 HTTP 权限回归失败')
  // eslint-disable-next-line no-console
  console.error(error)
  process.exitCode = 1
} finally {
  cleanupSqliteFile()
}
