/**
 * 模块说明：backend/scripts/o2o-stock-consistency-verify.ts
 * 文件职责：以隔离 SQLite 服务层及独占 MySQL 真实 HTTP 验证 O2O 下单库存的全有或全无语义。
 * 实现逻辑：
 * - 每次运行创建唯一临时 SQLite，动态加载数据源、初始化 Schema 与默认系统配置，避免污染本地开发库；
 * - 在隔离库创建账号夹具，通过真实登录和商品服务调用下单，覆盖同账号旧页面、跨账号和混合商品请求；
 * - 对 SQLite 单写协调器下的并发竞争、同请求键重试分别断言不超卖和不重复占用库存；
 * - 所有拒绝路径同时校验 HTTP 409 业务错误、订单数量及商品/SKU 预占库存不变。
 * 维护说明：
 * - 若 O2O 下单库存字段、请求幂等键或默认 SKU 规则调整，需要同步更新本脚本的快照断言；
 * - 默认验证 SQLite；MySQL 仅接受本批容器所有权核对后的参数。两者均不替代客户端购物车或结算 UI 回归。
 */

import { resolveIssueVerificationRoot } from './issue-verification-paths.js'
import 'reflect-metadata'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AuthUserContext } from '../src/types/auth.js'
import type { ClientAuthContext } from '../src/types/client-auth.js'

const currentFilePath = fileURLToPath(import.meta.url)
const backendRoot = path.resolve(path.dirname(currentFilePath), '..')
const sqliteRoot = resolveIssueVerificationRoot(path.resolve(backendRoot, 'data', 'local-dev'))
const verifySeed = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const sqlitePath = path.resolve(sqliteRoot, `o2o-stock-consistency-${verifySeed}.sqlite`)
const mysqlMode = process.env.Y_LINK_STOCK_MYSQL_VERIFY === 'true'
if (mysqlMode) {
  const { readOwnedMysqlContext } = await import('./owned-mysql-fixture.mjs')
  readOwnedMysqlContext() // 连接前核对本批容器标签、回环随机端口和专属库名。
}

process.env.APP_PROFILE = `o2o-stock-consistency-${verifySeed}`
process.env.DB_TYPE = mysqlMode ? 'mysql' : 'sqlite'
process.env.DB_SYNC = mysqlMode ? 'true' : 'false'
process.env.SQLITE_DB_PATH = sqlitePath

const pass = (message: string) => {
  console.log(`OK ${message}`)
}

const captchaCode = 'ABC234'
const toChineseDigits = (value: string) => value.replaceAll(/\d/g, (digit) => '零一二三四五六七八九'[Number(digit)] ?? '')

const cleanupSqliteFile = () => {
  if (!fs.existsSync(sqlitePath)) {
    return
  }
  try {
    fs.rmSync(sqlitePath, { force: true })
  } catch (error) {
    console.warn(`[o2o-stock-consistency-verify] 临时 SQLite 文件删除失败，已忽略：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function main() {
  fs.mkdirSync(sqliteRoot, { recursive: true })

  const { AppDataSource } = await import('../src/config/data-source.js')
  const { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime } = await import('../src/config/database-bootstrap.js')
  const { BaseProduct } = await import('../src/entities/base-product.entity.js')
  const { BaseProductSku } = await import('../src/entities/base-product-sku.entity.js')
  const { O2oPreorder } = await import('../src/entities/o2o-preorder.entity.js')
  const { ClientUser } = await import('../src/entities/client-user.entity.js')
  const { SysUser } = await import('../src/entities/sys-user.entity.js')
  const { hashPassword } = await import('../src/utils/password.js')
  const { BizError } = await import('../src/utils/errors.js')
  const { clientAuthService } = await import('../src/services/client-auth.service.js')
  const { o2oPreorderService } = await import('../src/services/o2o-preorder.service.js')
  const { productService } = await import('../src/services/product.service.js')
  const { systemConfigService } = await import('../src/services/system-config.service.js')
  const { initializeDatabaseInfrastructure } = await import('../src/database/database-strategy.js')
  const { installCaptchaServiceForTesting } = await import('../src/services/captcha.service.js')
  // 答案由已有测试接口注入；仍走真实PNG渲染、HTTP发票据与一次性验证码校验。
  const restoreCaptcha = installCaptchaServiceForTesting({ createCode: () => captchaCode })
  let httpServer: import('node:http').Server | undefined
  let origin = ''
  const httpSessions = new Map<string, { cookie: string; csrf: string }>()

  const preorderRepo = AppDataSource.getRepository(O2oPreorder)
  const productRepo = AppDataSource.getRepository(BaseProduct)
  const skuRepo = AppDataSource.getRepository(BaseProductSku)

  const createAndLoginClient = async (index: number): Promise<ClientAuthContext> => {
    const account = `13${String((Date.now() + index) % 1_000_000_000).padStart(9, '0')}`
    const password = `Client_${verifySeed}_${index}_Aa1!`
    // 库存专项不调用外部验证码通道；注册门禁由独立注册专项覆盖。
    const clientRepo = AppDataSource.getRepository(ClientUser)
    await clientRepo.save(clientRepo.create({
      accountType: 'personal',
      mobile: account,
      mobileVerifiedAt: new Date(),
      realName: `库存验证${toChineseDigits(String(index))}`,
      passwordHash: await hashPassword(password),
      status: 'enabled',
    }))
    const loginCaptcha = mysqlMode
      ? (await (await fetch(origin + '/api/client-auth/captcha')).json()).data
      : await clientAuthService.createCaptcha()
    if (mysqlMode) {
      const response = await fetch(origin + '/api/client-auth/login', { method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ account, password, captchaId: loginCaptcha.captchaId, captchaCode }),
      })
      const payload = await response.json()
      assert.equal(response.status, 200); assert.equal(payload.code, 0)
      const cookies = new Map(response.headers.getSetCookie().map(value => { const first = value.split(';')[0]!; const index = first.indexOf('='); return [first.slice(0, index), first.slice(index + 1)] }))
      const token = decodeURIComponent(cookies.get('y_link_client_session') ?? '')
      const auth = await clientAuthService.resolveClientByToken(token)
      const session = { cookie: [...cookies].map(([key, value]) => key + '=' + value).join('; '), csrf: decodeURIComponent(cookies.get('y_link_client_csrf') ?? '') }
      assert.ok(session.csrf); httpSessions.set(auth.userId, session)
      const me = await fetch(origin + '/api/client-auth/me', { headers: { Cookie: session.cookie } })
      assert.equal(me.status, 200); assert.equal((await me.json()).code, 0)
      return auth
    }
    const loginResult = await clientAuthService.login({
      account,
      password,
      captchaId: loginCaptcha.captchaId,
      captchaCode,
    })
    return clientAuthService.resolveClientByToken(loginResult.token)
  }

  let productActor: AuthUserContext
  const createListedProduct = async (name: string, stock: number) => {
    const product = await productService.create({
      productName: `${name}-${verifySeed}`,
      pinyinAbbr: 'KCYZ',
      defaultPrice: 10,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'listed',
      currentStock: stock,
      limitPerUser: 10,
    }, productActor)
    const sku = product.skus[0]
    assert.ok(sku, `${name} 应自动创建默认 SKU`)
    return { product, sku }
  }

  const submitInput = async (auth: ClientAuthContext, input: Parameters<typeof o2oPreorderService.submit>[1]) => {
    if (!mysqlMode) return o2oPreorderService.submit(auth, input)
    const session = httpSessions.get(auth.userId); assert.ok(session)
    const response = await fetch(origin + '/api/o2o/mall/preorders', { method: 'POST', headers: {
      'Content-Type': 'application/json', Cookie: session.cookie, Origin: origin, 'x-client-csrf-token': session.csrf,
    }, body: JSON.stringify(input) })
    const payload = await response.json()
    if (!response.ok) throw new BizError(payload.message, response.status, payload.data)
    assert.equal(payload.code, 0)
    return payload.data as Awaited<ReturnType<typeof o2oPreorderService.submit>>
  }
  const submit = (auth: ClientAuthContext, productId: string, skuId: string, qty: number, clientRequestId: string) => (
    submitInput(auth, {
      clientRequestId,
      items: [{ productId, skuId, qty }],
      pickupContact: '库存验证提货人',
      isSystemApplied: false,
    })
  )

  const expectStockConflict = async (action: () => Promise<unknown>, scene: string) => {
    await assert.rejects(action, (error: unknown) => {
      assert.ok(error instanceof BizError, `${scene} 必须抛出 BizError`)
      assert.equal(error.statusCode, 409, `${scene} 必须返回 HTTP 409`)
      assert.match(error.message, /库存不足/, `${scene} 必须明确为库存不足`)
      return true
    })
  }

  const stockSnapshot = async (productId: string, skuId: string) => {
    const [product, sku] = await Promise.all([
      productRepo.findOneByOrFail({ id: productId }),
      skuRepo.findOneByOrFail({ id: skuId }),
    ])
    return {
      productPreOrderedStock: Number(product.preOrderedStock),
      skuPreOrderedStock: Number(sku.preOrderedStock),
    }
  }

  prepareDatabaseRuntime()
  await AppDataSource.initialize()

  try {
    await initializeDatabaseInfrastructure(AppDataSource)
    await initializeDatabaseSchemaIfNeeded(AppDataSource)
    await systemConfigService.ensureDefaultConfigs()
    if (mysqlMode) {
      const { createApp } = await import('../src/app.js')
      httpServer = createApp().listen(0, '127.0.0.1')
      await new Promise<void>((resolve, reject) => { httpServer!.once('listening', resolve); httpServer!.once('error', reject) })
      const address = httpServer.address(); assert.ok(address && typeof address !== 'string')
      origin = 'http://127.0.0.1:' + address.port
    }
    const userRepo = AppDataSource.getRepository(SysUser)
    const admin = await userRepo.save(userRepo.create({
      username: `stock-admin-${verifySeed}`,
      passwordHash: 'verify-only',
      displayName: '库存一致性验证管理员',
      email: null,
      role: 'admin',
      status: 'enabled',
      lastLoginAt: null,
    }))
    productActor = {
      userId: String(admin.id),
      username: admin.username,
      displayName: admin.displayName,
      role: 'admin',
      permissions: [],
      status: 'enabled',
      sessionToken: 'stock-consistency-verify',
      authSource: 'bearer',
    }

    const sameAccount = await createAndLoginClient(1)
    const otherAccount = await createAndLoginClient(2)
    const shared = await createListedProduct('同账号旧页面库存商品', 3)

    await submit(sameAccount, shared.product.id, shared.sku.id, 2, 'stock-same-page-first-0001')
    const sameAccountBefore = {
      orderCount: await preorderRepo.count({ where: { clientUserId: sameAccount.userId } }),
      stock: await stockSnapshot(shared.product.id, shared.sku.id),
    }
    await expectStockConflict(
      () => submit(sameAccount, shared.product.id, shared.sku.id, 2, 'stock-same-page-stale-0002'),
      '同账号两个页面中旧页面按原数量提交',
    )
    assert.equal(await preorderRepo.count({ where: { clientUserId: sameAccount.userId } }), sameAccountBefore.orderCount)
    assert.deepEqual(await stockSnapshot(shared.product.id, shared.sku.id), sameAccountBefore.stock)
    pass('同账号旧页面库存冲突返回 409，订单数和预占库存不变')

    const otherAccountBefore = {
      orderCount: await preorderRepo.count({ where: { clientUserId: otherAccount.userId } }),
      stock: await stockSnapshot(shared.product.id, shared.sku.id),
    }
    await expectStockConflict(
      () => submit(otherAccount, shared.product.id, shared.sku.id, 2, 'stock-other-account-stale-001'),
      '不同账号按原数量提交仅剩一件的商品',
    )
    assert.equal(await preorderRepo.count({ where: { clientUserId: otherAccount.userId } }), otherAccountBefore.orderCount)
    assert.deepEqual(await stockSnapshot(shared.product.id, shared.sku.id), otherAccountBefore.stock)
    pass('不同账号库存冲突返回 409，既有订单与预占库存不变')

    const mixedAccount = await createAndLoginClient(3)
    const mixedAvailable = await createListedProduct('混合订单可用商品', 2)
    const mixedInsufficient = await createListedProduct('混合订单不足商品', 1)
    await expectStockConflict(
      () => submitInput(mixedAccount, {
        clientRequestId: 'stock-mixed-atomic-000001',
        items: [
          { productId: mixedAvailable.product.id, skuId: mixedAvailable.sku.id, qty: 1 },
          { productId: mixedInsufficient.product.id, skuId: mixedInsufficient.sku.id, qty: 2 },
        ],
        pickupContact: '混合库存验证提货人',
        isSystemApplied: false,
      }),
      '混合有效和不足商品提交',
    )
    assert.equal(await preorderRepo.count({ where: { clientUserId: mixedAccount.userId } }), 0)
    assert.deepEqual(await stockSnapshot(mixedAvailable.product.id, mixedAvailable.sku.id), {
      productPreOrderedStock: 0,
      skuPreOrderedStock: 0,
    })
    assert.deepEqual(await stockSnapshot(mixedInsufficient.product.id, mixedInsufficient.sku.id), {
      productPreOrderedStock: 0,
      skuPreOrderedStock: 0,
    })
    pass('混合有效和不足商品整体拒绝，不产生部分订单或部分预占')

    const concurrentFirst = await createAndLoginClient(4)
    const concurrentSecond = await createAndLoginClient(5)
    const concurrentProduct = await createListedProduct('并发竞争库存商品', 1)
    const concurrentResults = await Promise.allSettled([
      submit(concurrentFirst, concurrentProduct.product.id, concurrentProduct.sku.id, 1, 'stock-concurrent-first-0001'),
      submit(concurrentSecond, concurrentProduct.product.id, concurrentProduct.sku.id, 1, 'stock-concurrent-second-001'),
    ])
    const concurrentSuccesses = concurrentResults.filter((result) => result.status === 'fulfilled')
    const concurrentFailures = concurrentResults.filter((result) => result.status === 'rejected')
    assert.equal(concurrentSuccesses.length, 1, '库存为 1 时并发下单必须恰有一个成功')
    assert.equal(concurrentFailures.length, 1, '库存为 1 时并发下单必须恰有一个失败')
    const concurrentFailure = concurrentFailures[0]
    assert.ok(concurrentFailure?.status === 'rejected')
    assert.ok(concurrentFailure.reason instanceof BizError, '并发失败必须是 BizError')
    assert.equal(concurrentFailure.reason.statusCode, 409, '并发库存失败必须返回 HTTP 409')
    assert.match(concurrentFailure.reason.message, /库存不足/, '并发库存失败必须明确为库存不足')
    assert.deepEqual(await stockSnapshot(concurrentProduct.product.id, concurrentProduct.sku.id), {
      productPreOrderedStock: 1,
      skuPreOrderedStock: 1,
    })
    assert.equal(
      (await Promise.all([
        preorderRepo.count({ where: { clientUserId: concurrentFirst.userId } }),
        preorderRepo.count({ where: { clientUserId: concurrentSecond.userId } }),
      ])).reduce((total, current) => total + current, 0),
      1,
      '并发竞争不得生成超出库存的订单',
    )
    pass('SQLite 并发下单不超卖，失败请求返回 409')

    const retryProduct = await createListedProduct('幂等重试库存商品', 3)
    const retryRequestId = 'stock-idempotent-retry-001'
    const firstRetryResult = await submit(sameAccount, retryProduct.product.id, retryProduct.sku.id, 2, retryRequestId)
    const retryBefore = {
      orderCount: await preorderRepo.count({ where: { clientUserId: sameAccount.userId } }),
      stock: await stockSnapshot(retryProduct.product.id, retryProduct.sku.id),
    }
    const repeatedRetryResult = await submit(sameAccount, retryProduct.product.id, retryProduct.sku.id, 2, retryRequestId)
    assert.equal(repeatedRetryResult.order.id, firstRetryResult.order.id, '同一请求键重试必须复用原订单')
    assert.equal(repeatedRetryResult.order.totalQty, 2, '同一请求键重试不得改变订单数量')
    assert.equal(await preorderRepo.count({ where: { clientUserId: sameAccount.userId } }), retryBefore.orderCount)
    assert.deepEqual(await stockSnapshot(retryProduct.product.id, retryProduct.sku.id), retryBefore.stock)
    assert.deepEqual(retryBefore.stock, { productPreOrderedStock: 2, skuPreOrderedStock: 2 })
    pass('同一请求键重试复用订单，数量和预占库存保持不变')
    await assert.rejects(() => submit(sameAccount, retryProduct.product.id, retryProduct.sku.id, 1, retryRequestId),
      (error: unknown) => error instanceof BizError && error.statusCode === 409, '同幂等键不同内容必须冲突')
    assert.deepEqual(await stockSnapshot(retryProduct.product.id, retryProduct.sku.id), retryBefore.stock)
  } finally {
    restoreCaptcha()
    if (httpServer) { httpServer.closeAllConnections(); await new Promise<void>(resolve => httpServer!.close(() => resolve())) }
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy()
    }
    cleanupSqliteFile()
  }
}

main().catch((error) => {
  console.error(`[o2o-stock-consistency-verify] 验证失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  cleanupSqliteFile()
  process.exitCode = 1
})
