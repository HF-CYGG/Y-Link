/**
 * 文件说明：backend/scripts/system-config-business-hours-verify.ts
 * 文件职责：验证商城营业时间、自提地址和客服在线时间可由系统配置维护，并透传到客户端消费接口。
 * 实现逻辑：
 * - 使用独立 SQLite 数据库启动真实后端服务，避免污染本地开发库；
 * - 通过管理端系统配置接口更新 O2O 与客服中心时间配置，再读取客户端商城接口与反馈入口配置接口回查；
 * - 所有断言围绕“配置可保存、读取值正确、客户端可见值同步刷新”三步组织，避免只测单个接口字段存在。
 */
import 'reflect-metadata'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const currentFilePath = fileURLToPath(import.meta.url)
const backendRoot = path.resolve(path.dirname(currentFilePath), '..')
const sqliteRoot = path.resolve(backendRoot, 'data', 'local-dev')
const verifySeed = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const sqlitePath = path.resolve(sqliteRoot, `system-config-business-hours-${verifySeed}.sqlite`)
const adminPassword = `Admin_${verifySeed}_Aa1!`

process.env.APP_PROFILE = `system-config-business-hours-${verifySeed}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'false'
process.env.SQLITE_DB_PATH = sqlitePath
process.env.INIT_ADMIN_PASSWORD = adminPassword

type JsonPayload = {
  code?: number
  message?: string
  data?: unknown
}

type AdminLoginPayload = {
  user: {
    username: string
  }
}

type O2oRulesPayload = {
  autoCancelEnabled: boolean
  autoCancelHours: number
  limitEnabled: boolean
  limitQty: number
  clientPreorderUpdateLimit: number
  storeBusinessHoursText: string
  storePickupAddress: string
  mallAnnouncementText: string
}

type CustomerServicePayload = {
  enabled: boolean
  realtimeEnabled: boolean
  entryNotice: string
  workdayStart: string
  workdayEnd: string
  workdayWeekdays: number[]
  offlineNotice: string
  offlineFaqs: Array<{ question: string; answer: string }>
  sseKeepaliveSeconds: number
  availability: {
    workHoursText: string
  }
}

type MallProductsPayload = {
  list: Array<{
    id: string
    productName: string
  }>
  storefront: {
    businessHoursText: string
    pickupAddress: string
    mallAnnouncementText: string
  }
}

type MallStorefrontPayload = {
  businessHoursText: string
  pickupAddress: string
  mallAnnouncementText: string
  pickupWindowHours: number | null
}

function pass(message: string) {
  console.log(`OK ${message}`)
}

async function readJson(response: Response): Promise<JsonPayload> {
  const bodyText = await response.text()
  try {
    return JSON.parse(bodyText) as JsonPayload
  } catch (error) {
    throw new Error(
      `响应不是合法 JSON: status=${response.status} body=${bodyText}\n解析错误: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

async function expectJsonOkResponse<TData>(response: Response, scene: string): Promise<TData> {
  const payload = await readJson(response)
  assert.equal(response.status, 200, `${scene} HTTP 状态码异常: ${response.status} payload=${JSON.stringify(payload)}`)
  assert.equal(payload.code, 0, `${scene} 业务状态码异常: ${JSON.stringify(payload)}`)
  return payload.data as TData
}

function readCookieValueFromResponse(response: Response, cookieName: string): string | null {
  const headersWithSetCookie = response.headers as Headers & {
    getSetCookie?: () => string[]
    raw?: () => Record<string, string[]>
  }
  const setCookieValues = headersWithSetCookie.getSetCookie?.()
    ?? headersWithSetCookie.raw?.()['set-cookie']
    ?? [response.headers.get('set-cookie') ?? '']
  const rawSetCookie = setCookieValues.filter(Boolean).join(',')
  const match = rawSetCookie.match(new RegExp(`(?:^|,\\s*)${cookieName}=([^;]+)`))
  return match?.[1] ? decodeURIComponent(match[1]) : null
}

async function loginAdminSession(baseUrl: string) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      username: 'admin',
      password: adminPassword,
    }),
  })
  const data = await expectJsonOkResponse<AdminLoginPayload>(response, '管理员登录')
  const token = readCookieValueFromResponse(response, 'y_link_admin_session')
  assert.ok(token, '管理员登录后应返回管理端会话 Cookie')
  return {
    token,
    user: data.user,
  }
}

function cleanupSqliteFile() {
  if (!fs.existsSync(sqlitePath)) {
    return
  }
  try {
    fs.rmSync(sqlitePath, { force: true })
  } catch (error) {
    console.warn(
      `[system-config-business-hours-verify] 临时 SQLite 清理失败，已忽略: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

async function main() {
  fs.mkdirSync(sqliteRoot, { recursive: true })

  const { createApp } = await import('../src/app.js')
  const { AppDataSource } = await import('../src/config/data-source.js')
  const { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime } = await import('../src/config/database-bootstrap.js')
  const { authService } = await import('../src/services/auth.service.js')
  const { invalidateMallCatalogReadCache } = await import('../src/services/mall-catalog-revision.service.js')
  const { systemConfigService } = await import('../src/services/system-config.service.js')
  const { ClientUser } = await import('../src/entities/client-user.entity.js')
  const { SystemConfig } = await import('../src/entities/system-config.entity.js')
  const { SysAuditLog } = await import('../src/entities/sys-audit-log.entity.js')
  const { hashPassword } = await import('../src/utils/password.js')

  prepareDatabaseRuntime()
  await AppDataSource.initialize()

  const app = createApp()
  const server = app.listen(0, '127.0.0.1')

  try {
    await initializeDatabaseSchemaIfNeeded(AppDataSource)
    await authService.ensureDefaultAdmin()
    await systemConfigService.ensureDefaultConfigs()

    if (!server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.once('listening', resolve)
      })
    }

    const address = server.address()
    assert.ok(address && typeof address === 'object' && typeof address.port === 'number', '未能获取回归服务端口')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const adminLogin = await loginAdminSession(baseUrl)
    pass(`管理员登录成功：${adminLogin.user.username}`)

    const initialO2oRules = await expectJsonOkResponse<O2oRulesPayload>(
      await fetch(`${baseUrl}/api/system-configs/o2o-rules`, {
        headers: {
          Authorization: `Bearer ${adminLogin.token}`,
        },
      }),
      '读取初始 O2O 规则配置',
    )
    assert.equal(initialO2oRules.storeBusinessHoursText, '10:00 - 22:00', '默认店铺营业时间应为 10:00 - 22:00')
    assert.equal(initialO2oRules.storePickupAddress, '海右书院112房间')
    const storefrontUrl = `${baseUrl}/api/o2o/mall/storefront`
    const checkoutStorefrontUrl = `${storefrontUrl}/checkout`
    const productsUrl = `${baseUrl}/api/o2o/mall/products`
    const initialStorefrontResponse = await fetch(storefrontUrl)
    const initialStorefrontEtag = initialStorefrontResponse.headers.get('etag')
    assert.ok(initialStorefrontEtag)
    const initialStorefront = await expectJsonOkResponse<MallStorefrontPayload>(initialStorefrontResponse, '初始门店配置')
    assert.equal(initialStorefront.pickupAddress, '海右书院112房间')
    assert.equal((await expectJsonOkResponse<MallProductsPayload>(await fetch(productsUrl), '初始目录配置')).storefront.pickupAddress, '海右书院112房间')
    pass('初始 O2O 店铺营业时间配置正确')

    assert.equal((await fetch(checkoutStorefrontUrl)).status, 401, '结算重读必须使用客户端会话')
    assert.equal((await fetch(checkoutStorefrontUrl, { headers: { Authorization: `Bearer ${adminLogin.token}` } })).status, 401)
    const account = '13900000031'
    const password = `Client_${verifySeed}_Aa1!`
    await AppDataSource.getRepository(ClientUser).save({
      accountType: 'personal', mobile: account, mobileVerifiedAt: new Date(),
      realName: '结算专项', passwordHash: await hashPassword(password), status: 'enabled',
    })
    const clientLogin = await fetch(`${baseUrl}/api/client-auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: baseUrl },
      body: JSON.stringify({ account, password }),
    })
    await expectJsonOkResponse(clientLogin, '客户端密码登录')
    const clientToken = readCookieValueFromResponse(clientLogin, 'y_link_client_session')
    assert.ok(clientToken)
    const readCheckoutStorefront = async () => {
      const response = await fetch(checkoutStorefrontUrl, { headers: { Cookie: `y_link_client_session=${encodeURIComponent(clientToken)}` } })
      assert.equal(response.headers.get('cache-control'), 'private, no-store')
      return expectJsonOkResponse<MallStorefrontPayload>(response, '读取结算专用最新门店规则')
    }
    assert.deepEqual(await readCheckoutStorefront(), initialStorefront)

    const rulesRepo = AppDataSource.getRepository(SystemConfig)
    const pickupAddressKey = { configKey: 'o2o.store_pickup_address' }
    const verifyDelayedRulesRead = async <T>(change: () => Promise<T>, expectedAddress: string) => {
      systemConfigService.handleRemoteCacheInvalidation('o2o-rule')
      const find = rulesRepo.find
      let capture!: () => void
      let release!: () => void
      const captured = new Promise<void>((resolve) => { capture = resolve })
      const barrier = new Promise<void>((resolve) => { release = resolve })
      rulesRepo.find = async function (...args) {
        const rows = await find.apply(this, args)
        rulesRepo.find = find
        capture()
        await barrier
        return rows
      }
      const read = systemConfigService.getO2oRuleConfigs()
      try {
        await Promise.race([captured, read.then(() => { throw new Error('没有观察到规则数据库查询') })])
        const result = await change()
        release()
        assert.equal((await read).storePickupAddress, expectedAddress, '失效前查到的旧结果不能先完成后倒灌')
        assert.equal((await systemConfigService.getO2oRuleConfigs()).storePickupAddress, expectedAddress)
        return result
      } finally {
        rulesRepo.find = find
        release()
        await read.catch(() => undefined)
      }
    }
    const remoteAddress = '另一实例已提交的自提地址'
    await verifyDelayedRulesRead(async () => {
      // 在本实例尚未收到规则失效事件时模拟另一实例已提交，且原公共快照仍有效。
      await rulesRepo.update(pickupAddressKey, { configValue: remoteAddress })
      assert.deepEqual(await readCheckoutStorefront(), { ...initialStorefront, pickupAddress: remoteAddress })
      invalidateMallCatalogReadCache()
      const newCatalog = await expectJsonOkResponse<MallProductsPayload>(await fetch(productsUrl), '新修订目录回源')
      assert.equal(newCatalog.storefront.pickupAddress, remoteAddress)
      systemConfigService.handleRemoteCacheInvalidation('o2o-rule')
    }, remoteAddress)
    await rulesRepo.update(pickupAddressKey, { configValue: initialStorefront.pickupAddress })
    systemConfigService.handleRemoteCacheInvalidation('o2o-rule')
    invalidateMallCatalogReadCache()

    const initialPortalConfig = await expectJsonOkResponse<CustomerServicePayload>(
      await fetch(`${baseUrl}/api/client-feedback/portal-config`),
      '读取客户端反馈入口配置',
    )
    assert.ok(initialPortalConfig.availability.workHoursText.includes('10:00-20:00'), '初始客服在线时段应包含 10:00-20:00')
    pass('初始客服在线时间已透传到客户端反馈入口配置')

    const updatedO2oRules = await verifyDelayedRulesRead(async () => expectJsonOkResponse<{ config: O2oRulesPayload; changed: boolean }>(
      await fetch(`${baseUrl}/api/system-configs/o2o-rules`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${adminLogin.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          autoCancelEnabled: initialO2oRules.autoCancelEnabled,
          autoCancelHours: initialO2oRules.autoCancelHours,
          limitEnabled: initialO2oRules.limitEnabled,
          limitQty: initialO2oRules.limitQty,
          clientPreorderUpdateLimit: initialO2oRules.clientPreorderUpdateLimit,
          storeBusinessHoursText: '09:30 - 21:30',
          storePickupAddress: '  自提服务台  ',
          mallAnnouncementText: '配置联动验证公告',
        }),
      }),
      '更新 O2O 店铺营业时间配置',
    ), '自提服务台')
    assert.equal(updatedO2oRules.config.storeBusinessHoursText, '09:30 - 21:30', '更新后店铺营业时间应立即返回新值')
    assert.equal(updatedO2oRules.config.storePickupAddress, '自提服务台')
    pass('管理员可更新 O2O 店铺营业时间配置')

    assert.equal(updatedO2oRules.config.mallAnnouncementText, '配置联动验证公告', '更新后商城公告应立即返回新值')

    const updatedMallConfig = await expectJsonOkResponse<MallProductsPayload>(
      await fetch(`${baseUrl}/api/o2o/mall/products`),
      '读取客户端商城商品与门店信息',
    )
    assert.equal(updatedMallConfig.storefront.businessHoursText, '09:30 - 21:30', '客户端商城应返回最新店铺营业时间')
    assert.equal(updatedMallConfig.storefront.pickupAddress, '自提服务台')
    pass('客户端商城接口可透出最新店铺营业时间')

    assert.equal(updatedMallConfig.storefront.mallAnnouncementText, '配置联动验证公告', '客户端商城商品接口应返回最新商城公告')

    const updatedStorefrontResponse = await fetch(storefrontUrl, { headers: { 'If-None-Match': initialStorefrontEtag } })
    assert.notEqual(updatedStorefrontResponse.headers.get('etag'), initialStorefrontEtag)
    const updatedStorefrontConfig = await expectJsonOkResponse<MallStorefrontPayload>(
      updatedStorefrontResponse,
      '读取客户端商城门店展示配置',
    )
    assert.equal(updatedStorefrontConfig.businessHoursText, '09:30 - 21:30', '客户端商城门店配置接口应返回最新店铺营业时间')
    assert.equal(updatedStorefrontConfig.mallAnnouncementText, '配置联动验证公告', '客户端商城门店配置接口应返回最新商城公告')
    assert.equal(updatedStorefrontConfig.pickupAddress, '自提服务台')
    assert.deepEqual(await readCheckoutStorefront(), updatedStorefrontConfig)
    pass('客户端商城门店配置接口可轻量透出最新公告')

    const { storePickupAddress, ...legacyRulesPayload } = updatedO2oRules.config
    assert.equal(storePickupAddress, '自提服务台')
    const putRules = (data: typeof legacyRulesPayload & { storePickupAddress?: string }) =>
      fetch(`${baseUrl}/api/system-configs/o2o-rules`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${adminLogin.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
    const legacyRequest = { ...legacyRulesPayload, storeBusinessHoursText: '节假日请查看门店公告' }
    const legacy = await expectJsonOkResponse<{ config: O2oRulesPayload }>(
      await putRules(legacyRequest), '旧版请求省略自提地址',
    )
    assert.equal(legacy.config.storePickupAddress, '自提服务台')
    assert.equal(legacy.config.storeBusinessHoursText, '节假日请查看门店公告')
    assert.equal((await putRules({ ...legacyRequest, storePickupAddress: '长'.repeat(101) })).status, 400)
    const beforeReset = await fetch(storefrontUrl)
    const beforeResetEtag = beforeReset.headers.get('etag')
    assert.ok(beforeResetEtag)
    assert.equal((await expectJsonOkResponse<MallStorefrontPayload>(beforeReset, '清空前门店配置')).pickupAddress, '自提服务台')
    const reset = await expectJsonOkResponse<{ config: O2oRulesPayload }>(
      await putRules({ ...legacyRequest, storePickupAddress: '   ' }), '仅清空自提地址',
    )
    assert.equal(reset.config.storePickupAddress, '海右书院112房间')
    const resetStorefrontResponse = await fetch(storefrontUrl, { headers: { 'If-None-Match': beforeResetEtag } })
    assert.notEqual(resetStorefrontResponse.headers.get('etag'), beforeResetEtag)
    assert.equal((await expectJsonOkResponse<MallStorefrontPayload>(resetStorefrontResponse, '恢复后的公开门店配置')).pickupAddress, '海右书院112房间')
    assert.equal((await expectJsonOkResponse<MallProductsPayload>(await fetch(productsUrl), '恢复后的公开目录配置')).storefront.pickupAddress, '海右书院112房间')
    const auditRows = await AppDataSource.getRepository(SysAuditLog).find({
      where: { actionType: 'system_config.update_o2o_rules', targetCode: 'o2o_rules' }, order: { id: 'ASC' },
    })
    assert.deepEqual(auditRows.map(({ detailJson }) => {
      const detail = JSON.parse(detailJson ?? '{}') as { before: O2oRulesPayload; after: O2oRulesPayload }
      return [detail.before.storePickupAddress, detail.after.storePickupAddress]
    }), [['海右书院112房间', '自提服务台'], ['自提服务台', '自提服务台'], ['自提服务台', '海右书院112房间']])
    pass('自提地址支持默认、去空格、旧请求保留、清空恢复及公开缓存刷新')

    const currentCustomerService = await expectJsonOkResponse<CustomerServicePayload>(
      await fetch(`${baseUrl}/api/system-configs/customer-service`, {
        headers: {
          Authorization: `Bearer ${adminLogin.token}`,
        },
      }),
      '读取客服中心配置',
    )
    const updatedCustomerService = await expectJsonOkResponse<{ config: CustomerServicePayload; changed: boolean }>(
      await fetch(`${baseUrl}/api/system-configs/customer-service`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${adminLogin.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          enabled: currentCustomerService.enabled,
          realtimeEnabled: currentCustomerService.realtimeEnabled,
          entryNotice: currentCustomerService.entryNotice,
          workdayStart: '08:30',
          workdayEnd: '18:30',
          workdayWeekdays: [1, 2, 3, 4, 5, 6],
          offlineNotice: currentCustomerService.offlineNotice,
          offlineFaqs: currentCustomerService.offlineFaqs,
          sseKeepaliveSeconds: currentCustomerService.sseKeepaliveSeconds,
        }),
      }),
      '更新客服在线时间配置',
    )
    assert.equal(updatedCustomerService.config.workdayStart, '08:30', '客服开始时间应更新成功')
    assert.equal(updatedCustomerService.config.workdayEnd, '18:30', '客服结束时间应更新成功')
    assert.ok(updatedCustomerService.config.availability.workHoursText.includes('08:30-18:30'), '客服在线时间文案应同步更新')
    pass('管理员可更新客服在线时间配置')

    const updatedPortalConfig = await expectJsonOkResponse<CustomerServicePayload>(
      await fetch(`${baseUrl}/api/client-feedback/portal-config`),
      '回读客户端反馈入口配置',
    )
    assert.ok(updatedPortalConfig.availability.workHoursText.includes('08:30-18:30'), '客户端反馈入口应返回最新客服在线时间')
    pass('客户端反馈入口可透出最新客服在线时间')
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy()
    }
    cleanupSqliteFile()
  }
}

main().catch((error) => {
  console.error(
    `[system-config-business-hours-verify] 验证失败: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
  )
  process.exitCode = 1
})
