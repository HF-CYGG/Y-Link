/**
 * 模块说明：backend/scripts/supplier-portal-verify.ts
 * 文件职责：使用隔离 SQLite 验证供货端的商品目录脱敏与送货单通知投递边界。
 * 实现逻辑：
 * - 通过真实 HTTP 以供货方 Cookie 会话读取商品列表、分页、详情，确认停用商品可按 isActive 过滤，
 *   售价、折扣、库存与成本价全部置零，导出与标签接口直接 403；库管账号读取仍保留真实售价；
 * - 驱动真实 InboundService 提交、核销、现场改单，再手动执行通知 Outbox，确认新送货单只进后台账号收件箱、
 *   状态变更只进该单所属供货方收件箱，其它供货方收不到；
 * - 校验未指定接收人的既有规则（新预订单）不再默认投递给供货方，以及收件箱按事件类型过滤与标记已读。
 * 维护说明：
 * - 期望值必须手工给出，不能从被测方法自身反推；
 * - 脚本只能连接本次唯一临时 SQLite，禁止读取或修改业务数据库。
 */

import 'reflect-metadata'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AuthUserContext } from '../src/types/auth.js'

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sqliteRoot = path.resolve(backendRoot, 'data', 'local-dev')
const verifySeed = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const sqlitePath = path.resolve(sqliteRoot, `supplier-portal-${verifySeed}.sqlite`)

process.env.APP_PROFILE = `supplier-portal-${verifySeed}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'false'
process.env.SQLITE_DB_PATH = sqlitePath
process.env.INIT_ADMIN_PASSWORD = `Admin_${verifySeed}_Aa1!`

type JsonPayload = { code?: number; message?: string; data?: unknown }
type CookieSession = { cookie: string; csrfToken: string }
type ProductPayload = {
  id: string
  isActive: boolean
  defaultPrice: string
  discountedPrice: string
  currentStock: number
  availableStock: number
  skus: Array<{ defaultPrice: string; discountedPrice: string; costPrice: string | null; currentStock: number; availableStock: number }>
}

const hoursLater = (hours: number) => new Date(Date.now() + hours * 60 * 60 * 1000).toISOString()

function cleanup() {
  for (const filePath of [sqlitePath, `${sqlitePath}-wal`, `${sqlitePath}-shm`]) {
    if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true })
  }
}

async function readJson(response: Response): Promise<JsonPayload> {
  const body = await response.text()
  try {
    return JSON.parse(body) as JsonPayload
  } catch {
    throw new Error(`响应不是 JSON：status=${response.status} body=${body.slice(0, 200)}`)
  }
}

async function expectStatus(request: () => Promise<Response>, status: number, scene: string): Promise<JsonPayload> {
  const response = await request()
  const payload = await readJson(response)
  assert.equal(response.status, status, `${scene}：期望 HTTP ${status}，实际 ${response.status} ${payload.message ?? ''}`)
  return payload
}

function getSetCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] }
  return (headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? '']).filter(Boolean)
}

async function loginCookieSession(baseUrl: string, username: string, password: string): Promise<CookieSession> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  const payload = await readJson(response)
  assert.equal(response.status, 200, `登录 ${username} 失败：${JSON.stringify(payload)}`)
  const cookies = getSetCookies(response)
  const cookie = cookies.map((item) => item.split(';')[0]).join('; ')
  const csrfCookie = cookies.find((item) => item.startsWith('y_link_admin_csrf='))
  const csrfToken = csrfCookie?.split(';')[0]?.slice('y_link_admin_csrf='.length)
  assert.ok(cookie.includes('y_link_admin_session='), `登录 ${username} 未取得会话 Cookie`)
  assert.ok(csrfToken, `登录 ${username} 未取得 CSRF Cookie`)
  return { cookie, csrfToken: decodeURIComponent(csrfToken) }
}

const readHeaders = (session: CookieSession): Record<string, string> => ({ Cookie: session.cookie })
const writeHeaders = (session: CookieSession): Record<string, string> => ({
  Cookie: session.cookie,
  'Content-Type': 'application/json',
  'x-csrf-token': session.csrfToken,
})

function assertSupplierMasked(product: ProductPayload, scene: string) {
  assert.equal(product.defaultPrice, '0.00', `${scene}：供货方不得看到商品售价`)
  assert.equal(product.discountedPrice, '0.00', `${scene}：供货方不得看到折后价`)
  assert.equal(product.currentStock, 0, `${scene}：供货方不得看到商品库存`)
  assert.equal(product.availableStock, 0, `${scene}：供货方不得看到可用库存`)
  for (const sku of product.skus) {
    assert.equal(sku.defaultPrice, '0.00', `${scene}：供货方不得看到规格售价`)
    assert.equal(sku.discountedPrice, '0.00', `${scene}：供货方不得看到规格折后价`)
    assert.equal(sku.costPrice, null, `${scene}：供货方不得看到成本价`)
    assert.equal(sku.currentStock, 0, `${scene}：供货方不得看到规格库存`)
    assert.equal(sku.availableStock, 0, `${scene}：供货方不得看到规格可用库存`)
  }
}

async function main() {
  fs.mkdirSync(sqliteRoot, { recursive: true })
  const [
    { createApp },
    { AppDataSource },
    { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime },
    { authService },
    { userService },
    { productService },
    { inboundService },
    { notificationService },
    { systemConfigService },
    { SysUser },
    { NotificationInbox },
  ] = await Promise.all([
    import('../src/app.js'),
    import('../src/config/data-source.js'),
    import('../src/config/database-bootstrap.js'),
    import('../src/services/auth.service.js'),
    import('../src/services/user.service.js'),
    import('../src/services/product.service.js'),
    import('../src/services/inbound.service.js'),
    import('../src/services/notification.service.js'),
    import('../src/services/system-config.service.js'),
    import('../src/entities/sys-user.entity.js'),
    import('../src/entities/notification-inbox.entity.js'),
  ])

  prepareDatabaseRuntime()
  await AppDataSource.initialize()
  try {
    await initializeDatabaseSchemaIfNeeded(AppDataSource)
    await systemConfigService.ensureDefaultConfigs()
    await notificationService.ensureDefaultRules()

    const bootstrapAdmin = await authService.ensureDefaultAdmin()
    const bootstrapAdminUser = await AppDataSource.getRepository(SysUser).findOneByOrFail({ username: bootstrapAdmin.username })
    const toActor = (user: { id: string | number; username: string; displayName: string }, role: AuthUserContext['role']): AuthUserContext => ({
      userId: String(user.id),
      username: user.username,
      displayName: user.displayName,
      role,
      permissions: [],
      status: 'enabled',
      sessionToken: `supplier-portal-${role}-${user.id}`,
      authSource: 'bearer',
    })
    const adminActor = toActor(bootstrapAdminUser, 'admin')

    const operatorPassword = 'OperatorPortal_2026A'
    const supplierPassword = 'SupplierPortal_2026A'
    const otherSupplierPassword = 'OtherSupplierPortal_2026A'
    const operator = await userService.create({
      username: `portal_operator_${verifySeed}`,
      password: operatorPassword,
      displayName: '供货端验证库管',
      role: 'operator',
    }, adminActor)
    const supplier = await userService.create({
      username: `portal_supplier_${verifySeed}`,
      password: supplierPassword,
      displayName: '供货端验证供货方',
      role: 'supplier',
    }, adminActor)
    const otherSupplier = await userService.create({
      username: `portal_other_${verifySeed}`,
      password: otherSupplierPassword,
      displayName: '供货端验证其它供货方',
      role: 'supplier',
    }, adminActor)
    const supplierActor = toActor(supplier, 'supplier')

    const activeProduct = await productService.create({
      productCode: `PORTAL-ON-${verifySeed}`,
      productName: `供货端启用商品-${verifySeed}`,
      pinyinAbbr: 'GHDQY',
      defaultPrice: 25,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'unlisted',
      currentStock: 7,
      limitPerUser: 20,
    }, adminActor)
    const inactiveProduct = await productService.create({
      productCode: `PORTAL-OFF-${verifySeed}`,
      productName: `供货端停用商品-${verifySeed}`,
      pinyinAbbr: 'GHDTY',
      defaultPrice: 30,
      discountRate: 10,
      isActive: false,
      o2oStatus: 'unlisted',
      currentStock: 0,
      limitPerUser: 20,
    }, adminActor)
    const activeSku = activeProduct.skus[0]
    assert.ok(activeSku, '启用商品必须生成默认 SKU')

    // ---------------- 商品目录脱敏（真实 HTTP） ----------------
    const server = createApp().listen(0, '127.0.0.1')
    try {
      if (!server.listening) await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.once('listening', resolve)
      })
      const address = server.address()
      assert.ok(address && typeof address === 'object' && typeof address.port === 'number')
      const baseUrl = `http://127.0.0.1:${address.port}`
      const [supplierSession, operatorSession] = await Promise.all([
        loginCookieSession(baseUrl, supplier.username, supplierPassword),
        loginCookieSession(baseUrl, operator.username, operatorPassword),
      ])

      const activeList = await expectStatus(() => fetch(`${baseUrl}/api/products?isActive=true`, { headers: readHeaders(supplierSession) }), 200, '供货方读取启用商品')
      const activeRecords = activeList.data as ProductPayload[]
      assert.ok(activeRecords.some((item) => String(item.id) === String(activeProduct.id)), '启用商品必须出现在供货方目录')
      assert.equal(activeRecords.some((item) => String(item.id) === String(inactiveProduct.id)), false, 'isActive=true 时不得返回停用商品')
      activeRecords.forEach((item) => assertSupplierMasked(item, '供货方商品列表'))

      const pagedPayload = await expectStatus(() => fetch(`${baseUrl}/api/products/paged?page=1&pageSize=20`, { headers: readHeaders(supplierSession) }), 200, '供货方读取分页商品')
      ;(pagedPayload.data as { list: ProductPayload[] }).list.forEach((item) => assertSupplierMasked(item, '供货方商品分页'))

      const detailPayload = await expectStatus(() => fetch(`${baseUrl}/api/products/${activeProduct.id}`, { headers: readHeaders(supplierSession) }), 200, '供货方读取商品详情')
      assertSupplierMasked(detailPayload.data as ProductPayload, '供货方商品详情')

      await expectStatus(() => fetch(`${baseUrl}/api/products/export`, { headers: readHeaders(supplierSession) }), 403, '供货方导出商品')
      // 标签打印沿用 #178 的 main_only 投影：供货方可打印，但不得带出库位数量与分布指纹。
      const supplierLabels = await expectStatus(() => fetch(`${baseUrl}/api/products/labels`, {
        method: 'POST',
        headers: writeHeaders(supplierSession),
        body: JSON.stringify({ skuIds: [String(activeSku.id)] }),
      }), 200, '供货方打印标签')
      const supplierLabel = (supplierLabels.data as Array<{ printLocations: { capability: string } }>)[0]!
      assert.equal(supplierLabel.printLocations.capability, 'main_only', '供货方标签只能拿到主库位投影')
      assert.ok(!JSON.stringify(supplierLabel.printLocations).includes('qty'), '供货方标签不得带出库位数量')

      const operatorList = await expectStatus(() => fetch(`${baseUrl}/api/products?isActive=true`, { headers: readHeaders(operatorSession) }), 200, '库管读取商品')
      const operatorProduct = (operatorList.data as ProductPayload[]).find((item) => String(item.id) === String(activeProduct.id))
      assert.ok(operatorProduct, '库管必须能读到启用商品')
      assert.equal(Number(operatorProduct.defaultPrice), 25, '库管读取商品必须保留真实售价')
      assert.equal(operatorProduct.currentStock, 7, '库管读取商品必须保留真实库存')

      // ---------------- 送货单通知投递边界 ----------------
      const drainOutbox = async () => {
        for (let round = 0; round < 20; round += 1) {
          if (await notificationService.runOutboxOnce() === 0) return
        }
        throw new Error('通知 Outbox 在 20 轮内未处理完')
      }
      const inboxRepo = AppDataSource.getRepository(NotificationInbox)
      const inboxOf = async (userId: string | number, eventType: string) => inboxRepo.find({ where: { userId: String(userId), eventType } })

      const submitDelivery = (qty: number) => inboundService.submitSupplierDelivery(supplierActor, {
        remark: '供货端通知验证',
        expectedArrivalAt: hoursLater(24),
        items: [{ productId: String(activeProduct.id), skuId: String(activeSku.id), qty }],
      })
      const firstDelivery = await submitDelivery(3)
      const secondDelivery = await submitDelivery(4)
      await drainOutbox()

      assert.equal((await inboxOf(bootstrapAdminUser.id, 'inbound_order_submitted')).length, 2, '管理员必须收到两条新送货单提醒')
      assert.equal((await inboxOf(operator.id, 'inbound_order_submitted')).length, 2, '库管必须收到两条新送货单提醒')
      assert.equal((await inboxOf(supplier.id, 'inbound_order_submitted')).length, 0, '新送货单提醒不得发给提交方供货方')
      assert.equal((await inboxOf(otherSupplier.id, 'inbound_order_submitted')).length, 0, '新送货单提醒不得发给其它供货方')
      const submittedTitles = (await inboxOf(operator.id, 'inbound_order_submitted')).map((item) => item.title).sort()
      assert.deepEqual(submittedTitles, [`新送货单 ${firstDelivery.order.showNo}`, `新送货单 ${secondDelivery.order.showNo}`].sort(), '新送货单提醒标题必须带单号')

      await inboundService.verifyInbound(firstDelivery.order.verifyCode, adminActor)
      await inboundService.updateInboundOrderForAdmin(adminActor, secondDelivery.order.id, {
        remark: '库管现场改单',
        items: [{ productId: String(activeProduct.id), skuId: String(activeSku.id), qty: 6 }],
      })
      await drainOutbox()

      const supplierStatusInbox = await inboxOf(supplier.id, 'inbound_order_status_changed')
      assert.deepEqual(
        supplierStatusInbox.map((item) => item.title).sort(),
        [`送货单 ${firstDelivery.order.showNo} 已入库`, `送货单 ${secondDelivery.order.showNo} 已被库管修改`].sort(),
        '所属供货方必须收到核验入库与现场改单两条提醒',
      )
      assert.ok(supplierStatusInbox.some((item) => item.content.includes('共 6 件')), '现场改单提醒必须带改单后的数量')
      assert.equal((await inboxOf(otherSupplier.id, 'inbound_order_status_changed')).length, 0, '状态变更不得发给其它供货方')
      assert.equal((await inboxOf(bootstrapAdminUser.id, 'inbound_order_status_changed')).length, 0, '状态变更不得发给管理员')
      assert.equal((await inboxOf(operator.id, 'inbound_order_status_changed')).length, 0, '状态变更不得发给库管')

      // 未指定接收人的既有规则默认只发后台账号，供货方不再收到预订单等无关通知。
      await notificationService.emitEvent({
        eventType: 'o2o_preorder_created',
        sourceType: 'o2o_preorder',
        sourceId: `verify-${verifySeed}`,
        payload: { preorderNo: `VERIFY-${verifySeed}` },
      })
      await drainOutbox()
      assert.equal((await inboxOf(operator.id, 'o2o_preorder_created')).length, 1, '库管必须收到新预订单提醒')
      assert.equal((await inboxOf(supplier.id, 'o2o_preorder_created')).length, 0, '供货方不得默认收到新预订单提醒')
      assert.equal((await inboxOf(otherSupplier.id, 'o2o_preorder_created')).length, 0, '其它供货方不得默认收到新预订单提醒')

      // 收件箱按事件类型过滤与标记已读（真实 HTTP，Cookie 写请求带 CSRF）。
      const filteredInbox = await expectStatus(() => fetch(
        `${baseUrl}/api/notifications/inbox?unreadOnly=1&eventType=inbound_order_status_changed&pageSize=5`,
        { headers: readHeaders(supplierSession) },
      ), 200, '供货方读取送货单状态提醒')
      const filteredList = (filteredInbox.data as { list: Array<{ id: string; eventType: string }> }).list
      assert.equal(filteredList.length, 2, '供货方必须读到两条未读状态提醒')
      assert.ok(filteredList.every((item) => item.eventType === 'inbound_order_status_changed'), '按事件类型过滤后不得混入其它事件')
      await expectStatus(() => fetch(`${baseUrl}/api/notifications/inbox/${filteredList[0]!.id}/read`, {
        method: 'POST',
        headers: writeHeaders(supplierSession),
      }), 200, '供货方标记提醒已读')
      const afterRead = await expectStatus(() => fetch(
        `${baseUrl}/api/notifications/inbox?unreadOnly=1&eventType=inbound_order_status_changed`,
        { headers: readHeaders(supplierSession) },
      ), 200, '供货方再次读取未读提醒')
      assert.equal((afterRead.data as { list: unknown[] }).list.length, 1, '标记已读后未读提醒必须减少一条')

      // 其它供货方不能把别人的提醒标记为已读。
      const otherSession = await loginCookieSession(baseUrl, otherSupplier.username, otherSupplierPassword)
      const otherRead = await fetch(`${baseUrl}/api/notifications/inbox/${filteredList[1]!.id}/read`, {
        method: 'POST',
        headers: writeHeaders(otherSession),
      })
      const otherReadPayload = await readJson(otherRead)
      assert.ok(
        otherRead.status === 404 || (otherRead.status === 200 && (otherReadPayload.data as { changed?: boolean })?.changed === false),
        `其它供货方不得标记他人提醒：status=${otherRead.status}`,
      )
      assert.equal((await inboxOf(supplier.id, 'inbound_order_status_changed')).filter((item) => !item.isRead).length, 1, '他人请求不得改变本人提醒的已读状态')

      // “全部知道了”：积压超过前端一页（5 条）时也必须一次全部已读，且只影响本人该事件类型。
      for (let index = 0; index < 6; index += 1) {
        await notificationService.emitEvent({
          eventType: 'inbound_order_status_changed',
          sourceType: 'biz_inbound_order',
          sourceId: `verify-bulk-${verifySeed}-${index}`,
          payload: { inboundShowNo: `VERIFY-BULK-${index}`, supplierUserId: String(supplier.id), inboundAction: 'verified', totalQty: 1 },
        })
      }
      await notificationService.emitEvent({
        eventType: 'inbound_order_status_changed',
        sourceType: 'biz_inbound_order',
        sourceId: `verify-bulk-other-${verifySeed}`,
        payload: { inboundShowNo: 'VERIFY-BULK-OTHER', supplierUserId: String(otherSupplier.id), inboundAction: 'verified', totalQty: 1 },
      })
      await notificationService.emitEvent({
        eventType: 'o2o_preorder_created',
        sourceType: 'o2o_preorder',
        sourceId: `verify-bulk-preorder-${verifySeed}`,
        payload: { preorderNo: `VERIFY-BULK-${verifySeed}` },
      })
      await drainOutbox()
      const unreadStatusOf = async (userId: string | number) =>
        (await inboxOf(userId, 'inbound_order_status_changed')).filter((item) => !item.isRead).length
      assert.equal(await unreadStatusOf(supplier.id), 7, '批量已读前供货方应有 7 条未读状态提醒（超过一页）')
      const operatorPreorderUnreadBefore = (await inboxOf(operator.id, 'o2o_preorder_created')).filter((item) => !item.isRead).length

      await expectStatus(() => fetch(`${baseUrl}/api/notifications/inbox/read-by-event-type`, {
        method: 'POST',
        headers: { ...writeHeaders(supplierSession), 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventType: 'not_a_real_event' }),
      }), 400, '未知事件类型必须拒绝')
      const bulkRead = await expectStatus(() => fetch(`${baseUrl}/api/notifications/inbox/read-by-event-type`, {
        method: 'POST',
        headers: { ...writeHeaders(supplierSession), 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventType: 'inbound_order_status_changed' }),
      }), 200, '供货方一次性标记全部状态提醒已读')
      assert.equal((bulkRead.data as { changed: number }).changed, 7, '批量已读必须覆盖全部 7 条，而不只是一页')
      assert.equal(await unreadStatusOf(supplier.id), 0, '批量已读后供货方不得再有未读状态提醒')
      assert.equal(await unreadStatusOf(otherSupplier.id), 1, '批量已读不得影响其它供货方')
      assert.equal(
        (await inboxOf(operator.id, 'o2o_preorder_created')).filter((item) => !item.isRead).length,
        operatorPreorderUnreadBefore,
        '批量已读不得影响其它账号的其它事件',
      )
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }

    console.log('供货端专项验证通过：商品目录对供货方脱敏、停用商品可过滤、导出拒绝供货方、标签仅主库位投影、送货单通知按角色定向投递、收件箱过滤、单条与按事件类型批量已读均符合预期')
  } finally {
    await notificationService.stopOutboxWorker().catch(() => undefined)
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
    cleanup()
  }
}

main().catch((error) => {
  console.error(error)
  cleanup()
  process.exit(1)
})
