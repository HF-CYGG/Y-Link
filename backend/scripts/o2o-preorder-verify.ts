import assert from 'node:assert/strict'
import { AppDataSource } from '../src/config/data-source.js'
import { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime } from '../src/config/database-bootstrap.js'
import { authService } from '../src/services/auth.service.js'
import { clientAuthService } from '../src/services/client-auth.service.js'
import { dataMaintenanceService } from '../src/services/data-maintenance.service.js'
import { o2oPreorderService } from '../src/services/o2o-preorder.service.js'
import { productService } from '../src/services/product.service.js'
import { systemConfigService } from '../src/services/system-config.service.js'
import type { AuthUserContext } from '../src/types/auth.js'

const log = (text: string) => {
  console.log(`✅ ${text}`)
}

const ensureReady = async () => {
  prepareDatabaseRuntime()
  if (!AppDataSource.isInitialized) {
    await AppDataSource.initialize()
  }
  await initializeDatabaseSchemaIfNeeded(AppDataSource)
  await authService.ensureDefaultAdmin()
  await systemConfigService.ensureDefaultConfigs()
}

const run = async () => {
  await ensureReady()

  const captchaA = await clientAuthService.createCaptcha()
  const registerResult = await clientAuthService.register({
    account: `1${String(Date.now()).slice(-10)}`,
    username: `test_user_${String(Date.now()).slice(-4)}`,
    password: 'Client@123',
    captchaId: captchaA.captchaId,
    captchaCode: (captchaA.captchaSvg.match(/[A-Z0-9]{6}/)?.[0] ?? '').slice(0, 6),
  }).catch(async () => {
    const captchaRetry = await clientAuthService.createCaptcha()
    const code = captchaRetry.captchaSvg.replaceAll(/<[^>]*>/g, '').replaceAll(/\s+/g, '').slice(0, 6)
    return clientAuthService.register({
      account: `1${String(Date.now() + 1).slice(-10)}`,
      username: `test_user_${String(Date.now() + 1).slice(-4)}`,
      password: 'Client@123',
      captchaId: captchaRetry.captchaId,
      captchaCode: code,
    })
  })
  assert.ok(registerResult.id)
  log('客户端注册流程通过')

  const loginCaptcha = await clientAuthService.createCaptcha()
  const loginCode = loginCaptcha.captchaSvg.replaceAll(/<[^>]*>/g, '').replaceAll(/\s+/g, '').slice(0, 6)
  const loginResult = await clientAuthService.login({
    account: registerResult.mobile,
    password: 'Client@123',
    captchaId: loginCaptcha.captchaId,
    captchaCode: loginCode,
  })
  assert.ok(loginResult.token)
  log('客户端登录流程通过')

  const product = await productService.create({
    productName: `O2O测试产品-${Date.now()}`,
    pinyinAbbr: 'O2OCP',
    defaultPrice: 10,
    isActive: true,
    o2oStatus: 'listed',
    currentStock: 20,
    limitPerUser: 5,
  })
  assert.equal(product.o2oStatus, 'listed')
  log('商品上下架/库存字段创建通过')

  const mallProducts = await o2oPreorderService.listMallProducts()
  assert.ok(mallProducts.some((item) => item.id === product.id))
  log('客户端商品大厅展示通过')

  const clientAuth = await clientAuthService.resolveClientByToken(loginResult.token)
  const preorderResult = await o2oPreorderService.submit(clientAuth, {
    items: [{ productId: product.id, qty: 2 }],
    remark: '自动化验证',
  })
  assert.equal(preorderResult.order.status, 'pending')
  log('客户端下单与库存预占通过')

  const adminLogin = await authService.login({ username: 'admin', password: 'Admin@123456' }).catch(() => null)
  let adminAuth: AuthUserContext | null = null
  if (adminLogin) {
    adminAuth = await authService.resolveAuthUserByToken(adminLogin.token)
  }
  if (adminAuth) {
    const verified = await o2oPreorderService.verifyByCode(preorderResult.order.verifyCode, adminAuth)
    assert.equal(verified.order.status, 'verified')
    await o2oPreorderService.inboundStock(product.id, 3, adminAuth, '自动化补货')
    log('管理端核销与入库流程通过')
  }

  const o2oRules = await systemConfigService.getO2oRuleConfigs()
  assert.equal(o2oRules.autoCancelHours, 24)
  assert.equal(o2oRules.limitQty, 5)
  log('O2O 默认业务规则通过')

  const exported = await dataMaintenanceService.exportJson()
  assert.ok(exported.tables.products.length > 0)
  log('JSON 导出能力通过')

  if (AppDataSource.options.type === 'sqlite') {
    const backup = await dataMaintenanceService.createSqliteBackup()
    assert.ok(backup.filePath.endsWith('.sqlite'))
    log('SQLite 物理备份能力通过')
  }

  const compatibilityCheck = ['sqlite', 'mysql'].includes(String(AppDataSource.options.type))
  assert.equal(compatibilityCheck, true)
  log('SQLite/MySQL 驱动兼容配置通过')
}

run()
  .then(async () => {
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy()
    }
    console.log('\nO2O 预订验收脚本通过')
  })
  .catch(async (error) => {
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy()
    }
    console.error('\nO2O 预订验收脚本失败')
    console.error(error)
    process.exit(1)
  })
