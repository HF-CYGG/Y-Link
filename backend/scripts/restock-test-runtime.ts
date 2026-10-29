/** 补货验收专用隔离运行时；不会读取业务库连接，也不会覆盖 .env。 */
import 'reflect-metadata'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const taskRoot = path.resolve(backendRoot, '../.tmp-restock-implementation')

export async function createRestockTestRuntime(options: { mysql?: boolean; fixture?: boolean } = {}) {
  const seed = `${Date.now()}_${randomBytes(4).toString('hex')}`
  const runtimeDir = path.join(taskRoot, 'runtime', seed)
  fs.mkdirSync(runtimeDir, { recursive: true })
  const databaseName = `y_link_restock_${seed}`
  let mysqlAdmin: import('mysql2/promise').Connection | undefined
  process.env.Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE = 'true'
  process.env.Y_LINK_DATA_DIR = runtimeDir
  process.env.APP_PROFILE = `restock-verify-${seed}`
  process.env.DB_SYNC = 'true'
  process.env.DB_AUTO_MIGRATE = 'false'
  process.env.SQLITE_DB_PATH = path.join(runtimeDir, 'restock.sqlite')
  const password = `Rstk_${randomBytes(12).toString('hex')}_Aa7!`
  process.env.INIT_ADMIN_PASSWORD = password
  if (options.mysql) {
    const port = Number(process.env.RESTOCK_VERIFY_MYSQL_PORT)
    assert.ok(Number.isInteger(port) && port > 1024 && port < 65536, '真实 MySQL 验收必须显式提供独立容器端口 RESTOCK_VERIFY_MYSQL_PORT')
    const { createConnection } = await import('mysql2/promise')
    process.env.DB_TYPE = 'mysql'
    process.env.DB_HOST = '127.0.0.1'
    process.env.DB_PORT = String(port)
    process.env.DB_USER = process.env.RESTOCK_VERIFY_MYSQL_USER || 'root'
    process.env.DB_PASSWORD = process.env.RESTOCK_VERIFY_MYSQL_PASSWORD || ''
    process.env.DB_NAME = databaseName
    mysqlAdmin = await createConnection({ host: '127.0.0.1', port, user: process.env.DB_USER, password: process.env.DB_PASSWORD })
    assert.match(databaseName, /^y_link_restock_\d+_[a-f0-9]{8}$/)
    await mysqlAdmin.query(`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`)
  } else process.env.DB_TYPE = 'sqlite'

  const { AppDataSource } = await import('../src/config/data-source.js')
  const { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime } = await import('../src/config/database-bootstrap.js')
  const { authService } = await import('../src/services/auth.service.js')
  const { clientAuthService } = await import('../src/services/client-auth.service.js')
  const { systemConfigService } = await import('../src/services/system-config.service.js')
  const { productService } = await import('../src/services/product.service.js')
  const { hashPassword } = await import('../src/utils/password.js')
  const { SysUser } = await import('../src/entities/sys-user.entity.js')
  const { ClientUser } = await import('../src/entities/client-user.entity.js')
  const { BaseProduct } = await import('../src/entities/base-product.entity.js')
  const { BaseProductSku } = await import('../src/entities/base-product-sku.entity.js')
  const { ClientRestockRequest } = await import('../src/entities/client-restock-request.entity.js')
  const { ClientRestockRequestKey } = await import('../src/entities/client-restock-request-key.entity.js')
  const { ClientFeedbackMessage } = await import('../src/entities/client-feedback-message.entity.js')
  const { ClientFeedbackConversation } = await import('../src/entities/client-feedback-conversation.entity.js')
  const { SysAuditLog } = await import('../src/entities/sys-audit-log.entity.js')
  const { InventoryLog } = await import('../src/entities/inventory-log.entity.js')
  const { O2oPreorder } = await import('../src/entities/o2o-preorder.entity.js')
  const { NotificationEvent } = await import('../src/entities/notification-event.entity.js')
  const { clientFeedbackService } = await import('../src/services/client-feedback.service.js')
  const { dashboardService } = await import('../src/services/dashboard.service.js')
  const { createApp } = await import('../src/app.js')
  const { env } = await import('../src/config/env.js')
  assert.equal(env.DB_TYPE, options.mysql ? 'mysql' : 'sqlite')
  if (options.mysql) assert.equal(env.DB_NAME, databaseName)
  else assert.equal(path.resolve(env.SQLITE_DB_PATH!), path.join(runtimeDir, 'restock.sqlite'))
  prepareDatabaseRuntime()
  await AppDataSource.initialize()
  await initializeDatabaseSchemaIfNeeded(AppDataSource)
  await authService.ensureDefaultAdmin()
  await systemConfigService.ensureDefaultConfigs()
  const loginAdmin = async (username: string) => {
    const login = await authService.login({ username, password })
    assert.ok(!login.mfaRequired)
    return { token: login.token, auth: await authService.resolveAuthUserByToken(login.token) }
  }
  const admin = await loginAdmin('admin')
  const passwordHash = await hashPassword(password)
  const makeService = async (username: string, role: 'operator' | 'supplier') => {
    await AppDataSource.getRepository(SysUser).save({ username, passwordHash, displayName: `补货验收${username}`, role, status: 'enabled' })
    return loginAdmin(username)
  }
  const operator = await makeService('restock_cs', 'operator')
  const otherOperator = await makeService('restock_cs_other', 'operator')
  const supplier = await makeService('restock_supplier', 'supplier')
  const makeClient = async (mobile: string, realName: string) => {
    await AppDataSource.getRepository(ClientUser).save({ mobile, email: null, passwordHash, realName,
      accountType: 'personal', departmentName: '', departmentNodeId: null, staffNo: null, staffVerified: false, status: 'enabled' })
    const login = await clientAuthService.login({ account: mobile, password })
    return { token: login.token, auth: await clientAuthService.resolveClientByToken(login.token), account: mobile }
  }
  const client = await makeClient('13900000801', '补货验收客户甲')
  const otherClient = await makeClient('13900000802', '补货验收客户乙')
  const empty = await productService.create({ productName: '补货验收无货单规格', defaultPrice: 12, isActive: true, o2oStatus: 'listed', currentStock: 0, limitPerUser: 1 }, admin.auth)
  const stocked = await productService.create({ productName: '补货验收有货商品', defaultPrice: 13, isActive: true, o2oStatus: 'listed', currentStock: 5, limitPerUser: 1 }, admin.auth)
  const multi = await productService.create({ productName: '补货验收多规格商品', defaultPrice: 15, isActive: true, o2oStatus: 'listed', limitPerUser: 1,
    specGroups: [{ name: '颜色', values: ['红色', '蓝色'] }], skus: [
      { specValues: { 颜色: '红色' }, currentStock: 0, preOrderedStock: 0, isActive: true, defaultPrice: 15 },
      { specValues: { 颜色: '蓝色' }, currentStock: 4, preOrderedStock: 0, isActive: true, defaultPrice: 15 },
    ] }, admin.auth)
  const allEmpty = await productService.create({ productName: '补货验收三维全缺货商品', defaultPrice: 16, isActive: true, o2oStatus: 'listed', limitPerUser: 1,
    specGroups: [{ name: '颜色', values: ['红色', '蓝色'] }, { name: '材质', values: ['棉', '亚麻'] }, { name: '尺码', values: ['S', 'M'] }],
    skus: ['红色', '蓝色'].flatMap((颜色) => ['棉', '亚麻'].flatMap((材质) => ['S', 'M'].map((尺码) => ({ specValues: { 颜色, 材质, 尺码 }, currentStock: 0, preOrderedStock: 0, isActive: true, defaultPrice: 16 })))),
  }, admin.auth)
  const skuRepo = AppDataSource.getRepository(BaseProductSku)
  const emptySku = (await skuRepo.find({ where: { productId: empty.id, isCurrent: true } }))[0]!
  const stockedSku = (await skuRepo.find({ where: { productId: stocked.id, isCurrent: true } }))[0]!
  const multiSkus = await skuRepo.find({ where: { productId: multi.id, isCurrent: true }, order: { id: 'ASC' } })
  const multiEmptySku = multiSkus.find((sku) => sku.currentStock === 0)!
  const multiStockedSku = multiSkus.find((sku) => sku.currentStock > 0)!
  assert.ok(emptySku && stockedSku && multiEmptySku && multiStockedSku)
  const runtime = { AppDataSource, env, authService, clientAuthService, systemConfigService, productService, clientFeedbackService, dashboardService,
    entities: { SysUser, ClientUser, BaseProduct, BaseProductSku, ClientRestockRequest, ClientRestockRequestKey, ClientFeedbackConversation, ClientFeedbackMessage, SysAuditLog, InventoryLog, O2oPreorder, NotificationEvent },
    admin, operator, otherOperator, supplier, client, otherClient, createClient: makeClient, products: { empty, stocked, multi, allEmpty, emptySku, stockedSku, multiEmptySku, multiStockedSku },
    runtimeDir, databaseName: options.mysql ? databaseName : null,
    async listen(port = 0) {
      const server = createApp().listen(port, '127.0.0.1')
      if (!server.listening) await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
      const address = server.address()
      assert.ok(address && typeof address === 'object')
      return { server, baseUrl: `http://127.0.0.1:${address.port}` }
    },
    async close() {
      if (AppDataSource.isInitialized) await AppDataSource.destroy()
      if (mysqlAdmin) { await mysqlAdmin.query(`DROP DATABASE \`${databaseName}\``); await mysqlAdmin.end() }
    },
  }
  if (options.fixture) {
    assert.equal(options.mysql, undefined, 'UI fixture 只能使用任务独立 SQLite')
    // 商城真实虚拟分支阈值为products.length>100；仅UI夹具增加110条可区分的缺货商品。
    for (let index = 1; index <= 110; index += 1) {
      await productService.create({ productName: `补货虚拟验收${String(index).padStart(3, '0')}`, defaultPrice: 9,
        currentStock: 0, isActive: true, o2oStatus: 'listed', limitPerUser: 1 }, admin.auth)
    }
    const credentialsPath = path.join(taskRoot, 'ui-fixture.json')
    fs.writeFileSync(credentialsPath, JSON.stringify({ runtimeDir, sqlitePath: process.env.SQLITE_DB_PATH, backendUrl: `http://127.0.0.1:${process.env.RESTOCK_UI_BACKEND_PORT || '5417'}`, password,
      admin: { account: 'admin' }, operator: { account: 'restock_cs' }, client: { account: client.account },
      catalogFixture: { extraProductCount: 110, searchPrefix: '补货虚拟验收', virtualThreshold: 100 },
      otherClient: { account: otherClient.account }, products: Object.fromEntries(Object.entries(runtime.products).map(([key, value]) => [key, { id: String(value.id) }])),
    }, null, 2), { mode: 0o600 })
  }
  return runtime
}
