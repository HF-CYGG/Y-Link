/**
 * 文件说明：backend/scripts/o2o-customer-order-show-no-verify.ts
 * 文件职责：验证客户端 O2O 订单详情在核销后会返回与管理端一致的正式出库单号。
 * 实现逻辑：
 * 1. 初始化数据库、系统配置、管理员与客户端账号，准备最小可核销环境；
 * 2. 创建一个部门订预订单并由管理端完成核销，确保后台正式出库单已真实生成；
 * 3. 对比客户端详情返回的正式出库单号与后台沉淀出的出库单号，防止客户端继续错误展示预订单号。
 * 维护说明：若 O2O 详情结构或核销后落单规则变更，请同步更新本脚本。
 */

import assert from 'node:assert/strict'
import { AppDataSource } from '../src/config/data-source.js'
import { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime } from '../src/config/database-bootstrap.js'
import { BaseProduct } from '../src/entities/base-product.entity.js'
import { BizOutboundOrder } from '../src/entities/biz-outbound-order.entity.js'
import { ClientUser } from '../src/entities/client-user.entity.js'
import { authService } from '../src/services/auth.service.js'
import { clientAuthService } from '../src/services/client-auth.service.js'
import { o2oPreorderService, type O2oPreorderDetailView } from '../src/services/o2o-preorder.service.js'
import { productService } from '../src/services/product.service.js'
import { systemConfigService } from '../src/services/system-config.service.js'
import type { AuthUserContext } from '../src/types/auth.js'
import type { ClientAuthContext } from '../src/types/client-auth.js'

const readCaptchaCode = (captchaSvg: string) => captchaSvg.replaceAll(/<[^>]*>/g, '').replaceAll(/\s+/g, '').slice(0, 6)

const ensureReady = async () => {
  prepareDatabaseRuntime()
  if (!AppDataSource.isInitialized) {
    await AppDataSource.initialize()
  }
  await initializeDatabaseSchemaIfNeeded(AppDataSource)
  await systemConfigService.ensureDefaultConfigs()
  return authService.ensureDefaultAdmin()
}

const buildScriptAdminActor = (bootstrapAdmin: Awaited<ReturnType<typeof authService.ensureDefaultAdmin>>): AuthUserContext => {
  return {
    userId: 'o2o-show-no-verify-admin',
    username: bootstrapAdmin.username,
    displayName: bootstrapAdmin.displayName,
    role: 'admin',
    permissions: [],
    status: 'enabled',
    sessionToken: 'o2o-show-no-verify-session',
  }
}

const registerAndLoginClient = async (seed: number): Promise<ClientAuthContext> => {
  const registerCaptcha = await clientAuthService.createCaptcha()
  const account = `1${String(seed).slice(-10)}`
  const username = `show_no_test_${String(seed).slice(-6)}`
  const password = `Client@${String(seed).slice(-6)}`

  const registerResult = await clientAuthService.register({
    account,
    username,
    password,
    captchaId: registerCaptcha.captchaId,
    captchaCode: readCaptchaCode(registerCaptcha.captchaSvg),
  })

  await AppDataSource.getRepository(ClientUser).update({ id: registerResult.id }, { departmentName: '海右书院' })

  const loginCaptcha = await clientAuthService.createCaptcha()
  const loginResult = await clientAuthService.login({
    account: registerResult.mobile,
    password,
    captchaId: loginCaptcha.captchaId,
    captchaCode: readCaptchaCode(loginCaptcha.captchaSvg),
  })
  return clientAuthService.resolveClientByToken(loginResult.token)
}

const assertPreorderVerifyDetail = (detail: Awaited<ReturnType<typeof o2oPreorderService.verifyByCode>>) => {
  assert.equal(detail.verifyTargetType, 'preorder')
  return detail.detail as O2oPreorderDetailView
}

const run = async () => {
  const bootstrapAdmin = await ensureReady()
  const scriptAdminActor = buildScriptAdminActor(bootstrapAdmin)
  const clientAuth = await registerAndLoginClient(Date.now())

  const adminPassword = process.env.Y_LINK_VERIFY_ADMIN_PASSWORD?.trim()
  const adminLogin =
    adminPassword && adminPassword.length > 0
      ? await authService.login({ username: 'admin', password: adminPassword }).catch(() => null)
      : null
  const adminAuth = adminLogin ? await authService.resolveAuthUserByToken(adminLogin.token) : scriptAdminActor

  const product = await productService.create({
    productName: `正式出库单号验证商品-${Date.now()}`,
    pinyinAbbr: 'ZSCKD',
    defaultPrice: 12.5,
    isActive: true,
    o2oStatus: 'listed',
    currentStock: 20,
    limitPerUser: 5,
  })
  const productRepo = AppDataSource.getRepository(BaseProduct)
  const savedProduct = await productRepo.findOneByOrFail({ id: product.id })
  assert.equal(savedProduct.o2oStatus, 'listed')

  const preorder = await o2oPreorderService.submit(clientAuth, {
    items: [{ productId: product.id, qty: 1 }],
    remark: '正式出库单号校验',
    clientOrderType: 'department',
    isSystemApplied: false,
    pickupContact: '测试提货人',
  })

  const verifyResult = await o2oPreorderService.verifyByCode(preorder.order.verifyCode, adminAuth)
  const verifiedDetail = assertPreorderVerifyDetail(verifyResult)
  const outboundOrderRepo = AppDataSource.getRepository(BizOutboundOrder)
  const outboundOrder = await outboundOrderRepo.findOne({
    where: { idempotencyKey: `o2o-preorder-verify:${preorder.order.id}` },
  })

  assert.ok(outboundOrder, '核销后应存在后台正式出库单')

  const customerOrderShowNo = (
    verifiedDetail.order as O2oPreorderDetailView['order'] & { customerOrderShowNo?: string | null }
  ).customerOrderShowNo

  assert.equal(customerOrderShowNo, outboundOrder.showNo, '客户端详情应返回与管理端一致的正式出库单号')
  console.log('O2O 正式出库单号一致性校验通过')
}

try {
  await run()
} catch (error) {
  console.error('O2O 正式出库单号一致性校验失败')
  console.error(error)
  process.exit(1)
} finally {
  if (AppDataSource.isInitialized) {
    await AppDataSource.destroy()
  }
}
