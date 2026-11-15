/**
 * 文件职责：真实服务验证撤单、打印和评价的账号先行锁序；仅自有SQLite或已核对所有权的MySQL。
 * 实现逻辑：生命周期先提交则拒绝旧请求且无业务副作用；业务先持锁则完成后再注销，不死锁。
 * 维护说明：不使用业务ENV_FILE/数据根，不连接普通DB_*目标，不启动外发或后台任务。
 */
import 'reflect-metadata'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { AuthUserContext } from '../src/types/auth.js'

const mysqlMode = process.env.Y_LINK_ACCOUNT_WRITE_MYSQL === 'true'
const mysql = mysqlMode ? (await import('./owned-mysql-fixture.mjs')).readOwnedMysqlContext() : null
const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'ylink-account-write-'))
const previousCwd = process.cwd(), sqlite = path.join(root, 'fixture.sqlite'), envFile = path.join(root, 'empty.env')
fs.writeFileSync(envFile, '', { flag: 'wx', mode: 0o600 })
fs.copyFileSync(fileURLToPath(new URL('../tsconfig.json', import.meta.url)), path.join(root, 'tsconfig.json'))
Object.assign(process.env, { ENV_FILE: envFile, APP_PROFILE: 'account-write-' + randomBytes(12).toString('hex'),
  Y_LINK_DATA_DIR: path.join(root, 'data'), Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE: 'true', REDIS_URL: '',
  Y_LINK_MULTI_INSTANCE: 'false', ALIYUN_DYPNS_MNS_ENABLED: 'false', Y_LINK_DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  DB_TYPE: mysql ? 'mysql' : 'sqlite', DB_SYNC: 'false', DB_AUTO_MIGRATE: 'false', SQLITE_DB_PATH: sqlite,
  ...(mysql ? { DB_HOST: mysql.host, DB_PORT: String(mysql.port), DB_USER: mysql.user, DB_PASSWORD: mysql.password, DB_NAME: mysql.database } : {}),
})
process.chdir(root)
const { AppDataSource: source } = await import('../src/config/data-source.js')
const { appDataPaths } = await import('../src/config/app-data-paths.js')
assert.equal(source.options.type, mysql ? 'mysql' : 'sqlite')
assert.equal(appDataPaths.rootDir, path.join(root, 'data'))
assert.equal(path.resolve('uploads'), path.join(root, 'uploads'))
if (mysql) {
  const options = source.options as { host: string; port: number; username: string; database: string; password: string }
  assert.equal(options.host, mysql.host); assert.equal(options.port, mysql.port)
  assert.equal(options.username, mysql.user); assert.equal(options.database, mysql.database)
  assert.equal(options.password, mysql.password)
} else assert.equal(path.resolve(String(source.options.database)), sqlite)

const [{ ClientUser }, { SysUser }, { ClientUserSession }, { O2oPreorder }, { O2oPreorderItem }, { BaseProduct }, { BaseProductSku },
  { ClientFeedbackConversation }, { InventoryLog }, { SysAuditLog }, { o2oPreorderService: orders }, { clientFeedbackService: feedback },
  { clientUserManageService: clients }, { clientAuthService }, { hashSessionToken }, { systemConfigService }, { BizOutboundOrder }] = await Promise.all([
  import('../src/entities/client-user.entity.js'), import('../src/entities/sys-user.entity.js'), import('../src/entities/client-user-session.entity.js'),
  import('../src/entities/o2o-preorder.entity.js'), import('../src/entities/o2o-preorder-item.entity.js'), import('../src/entities/base-product.entity.js'),
  import('../src/entities/base-product-sku.entity.js'), import('../src/entities/client-feedback-conversation.entity.js'), import('../src/entities/inventory-log.entity.js'),
  import('../src/entities/sys-audit-log.entity.js'), import('../src/services/o2o-preorder.service.js'), import('../src/services/client-feedback.service.js'),
  import('../src/services/client-user-manage.service.js'), import('../src/services/client-auth.service.js'), import('../src/utils/session-token.js'),
  import('../src/services/system-config.service.js'),
  import('../src/entities/biz-outbound-order.entity.js'),
])
type Kind = 'cancel' | 'printed' | 'satisfaction'
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(ok => { resolve = ok }); return { promise, resolve } }
const deadline = async <T>(work: Promise<T>) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('账号/业务锁序在20秒内未完成')), 20_000) })]) }
  finally { if (timer) clearTimeout(timer) }
}

try {
  await source.initialize()
  if (mysql) {
    const tables = await source.query('SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()') as Array<{ n: number }>
    assert.equal(Number(tables[0]!.n), 0, '独占MySQL目标必须为空，不能同步调用者已有库')
  }
  await source.synchronize()
  await systemConfigService.ensureDefaultConfigs()
  const userRepo = source.getRepository(ClientUser), sysRepo = source.getRepository(SysUser)
  const orderRepo = source.getRepository(O2oPreorder), conversationRepo = source.getRepository(ClientFeedbackConversation)
  const productRepo = source.getRepository(BaseProduct), skuRepo = source.getRepository(BaseProductSku), auditRepo = source.getRepository(SysAuditLog)
  const admin = await sysRepo.save(sysRepo.create({ username: 'account_write_admin', displayName: '隔离治理管理员', role: 'admin', status: 'enabled', passwordHash: 'fixture-only' }))
  const actor: AuthUserContext = { userId: admin.id, username: admin.username, displayName: admin.displayName,
    role: 'admin', status: 'enabled', permissions: [], sessionToken: 'fixture-admin', authSource: 'bearer' }
  let index = 0
  const fixture = async (kind: Kind, deactivated = false) => {
    const id = ++index, token = randomBytes(32).toString('hex')
    const user = await userRepo.save(userRepo.create({ realName: `账号写入夹具${id}`, email: `account-write-${id}@example.test`, mobile: null,
      passwordHash: 'fixture-only', departmentName: '隔离部门', accountType: kind === 'printed' ? 'department' : 'personal', status: 'enabled' }))
    await source.getRepository(ClientUserSession).save({ userId: user.id, sessionToken: hashSessionToken(token), expiresAt: new Date(Date.now() + 3600_000), lastAccessAt: new Date() })
    const auth = await clientAuthService.resolveClientByToken(token)
    // 先合法注销，再补只属于夹具的历史记录，覆盖旧数据仍指向注销账号时的防御，不伪称正常业务能产生该状态。
    if (deactivated) await clients.deactivate(user.id, { reason: '隔离验证已注销账号旧请求' }, actor)
    const product = await productRepo.save(productRepo.create({ productCode: `WRITE-${id}`, productName: `锁序商品${id}`, isActive: true, currentStock: 10, preOrderedStock: 2 }))
    const sku = await skuRepo.save(skuRepo.create({ productId: product.id, skuCode: `WRITE-${id}-DEFAULT`, specValuesJson: '{}', specText: '默认规格', currentStock: 10, preOrderedStock: 2 }))
    const order = await orderRepo.save(orderRepo.create({ preorderNo: `PRE-W-WRITE-${id}`, verifyCode: `WRITE-VERIFY-${id}`, clientUserId: user.id,
      clientOrderType: kind === 'printed' ? 'department' : 'walkin', status: kind === 'printed' ? 'verified' : 'pending',
      totalQty: 1, timeoutAt: new Date(Date.now() + 24 * 3600_000) }))
    await source.getRepository(O2oPreorderItem).save({ orderId: order.id, productId: product.id, skuId: sku.id, qty: 1 })
    const outbound = kind === 'printed' ? await source.getRepository(BizOutboundOrder).save({ orderUuid: randomUUID(),
      systemNo: `OUT-D-WRITE-${id}`, businessNo: `hyyz-write-${id}`, orderType: 'department', idempotencyKey: `write-${id}`,
      sourceDocType: 'o2o_preorder', sourceDocId: order.id, sourceDocNo: order.preorderNo, totalQty: '1', hasCustomerOrder: false }) : null
    const conversation = await conversationRepo.save(conversationRepo.create({ conversationNo: `FB-WRITE-${id}`, clientUserId: user.id,
      clientUsername: user.realName, clientAccount: user.email!, subject: '隔离评价锁序', status: 'closed', tagJson: '[]', lastMessageAt: new Date() }))
    // 评价场景不应被无关pending订单阻断注销；打印单本来已核销。
    if (kind === 'satisfaction') await orderRepo.update(order.id, { status: 'cancelled' })
    const action = () => kind === 'cancel' ? orders.cancelMyOrder(auth, order.id)
      : kind === 'printed' ? orders.markCustomerOrderPrintedByClient(auth, order.id)
        : feedback.submitConversationSatisfactionByClient(conversation.id, { level: 'satisfied', comment: '隔离评价' }, auth)
    const snapshot = async () => {
      const [currentOrder, currentConversation, currentProduct, currentSku] = await Promise.all([
        orderRepo.findOneByOrFail({ id: order.id }), conversationRepo.findOneByOrFail({ id: conversation.id }),
        productRepo.findOneByOrFail({ id: product.id }), skuRepo.findOneByOrFail({ id: sku.id }),
      ])
      return { orderStatus: currentOrder.status, printed: currentOrder.hasCustomerOrder,
        outboundPrinted: outbound ? (await source.getRepository(BizOutboundOrder).findOneByOrFail({ id: outbound.id })).hasCustomerOrder : null,
        satisfaction: currentConversation.clientSatisfactionLevel, ratedAt: currentConversation.clientSatisfactionRatedAt?.toISOString() ?? null,
        productStock: currentProduct.currentStock, productReserved: currentProduct.preOrderedStock,
        skuStock: currentSku.currentStock, skuReserved: currentSku.preOrderedStock,
        logs: await source.getRepository(InventoryLog).count(), audit: await auditRepo.count() }
    }
    return { kind, user, auth, order, conversation, action, snapshot }
  }
  for (const state of ['disabled', 'deactivated'] as const) for (const kind of ['cancel', 'printed', 'satisfaction'] as const) {
    const f = await fixture(kind, state === 'deactivated')
    if (state === 'disabled') await clients.updateStatus(f.user.id, 'disabled', actor)
    const before = await f.snapshot()
    await assert.rejects(f.action, /客户端账号已停用或已注销/)
    assert.deepEqual(await f.snapshot(), before, `${state}/${kind}：不能改变订单、库存、合规、评价、流水或审计`)
    console.log(`PASS lifecycle-first ${state}/${kind}`)
  }
  for (const kind of ['cancel', 'printed', 'satisfaction'] as const) {
    const f = await fixture(kind), reached = deferred(), release = deferred()
    const service = (kind === 'satisfaction' ? feedback : orders) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
    const method = kind === 'cancel' ? 'cancelOrderInManager' : kind === 'printed' ? 'lockLinkedOutboundOrderGroupInManager' : 'requireOwnedConversation'
    const original = service[method]!
    service[method] = async function (...args) { reached.resolve(); await release.promise; return original.apply(this, args) }
    try {
      const business = f.action()
      await deadline(Promise.race([reached.promise, business.then(() => { throw new Error('业务未经过预期账号锁后的屏障') })]))
      let settled = false
      const lifecycle = clients.deactivate(f.user.id, { reason: '业务持锁后合法注销' }, actor)
      void lifecycle.then(() => { settled = true }, () => { settled = true })
      await new Promise(resolve => setTimeout(resolve, 25))
      assert.equal(settled, false, `${kind}：生命周期应等待账号业务锁`)
      release.resolve()
      await deadline(Promise.all([business, lifecycle]))
      const after = await f.snapshot()
      if (kind === 'cancel') { assert.equal(after.orderStatus, 'cancelled'); assert.equal(after.productReserved, 1); assert.equal(after.skuReserved, 1) }
      // 显式integer列在SQLite读回1；MySQL布尔转换可能读回true，两者均须精确表示已打印。
      if (kind === 'printed') { assert.equal(Number(after.printed), 1); assert.equal(Number(after.outboundPrinted), 1) }
      if (kind === 'satisfaction') assert.equal(after.satisfaction, 'satisfied')
      assert.equal((await userRepo.findOneByOrFail({ id: f.user.id })).status, 'disabled')
      console.log(`PASS business-first ${kind}`)
    } finally { release.resolve(); service[method] = original }
  }
  console.log(`客户端账号业务边界通过：${source.options.type} 生命周期先行拒写、业务先行合法完成及锁序无死锁`)
} finally {
  if (source.isInitialized) await source.destroy()
  process.chdir(previousCwd)
  const resolved = fs.realpathSync(root)
  assert.equal(path.dirname(resolved), parent); assert.ok(path.basename(resolved).startsWith('ylink-account-write-'))
  fs.rmSync(resolved, { recursive: true, force: true })
}
