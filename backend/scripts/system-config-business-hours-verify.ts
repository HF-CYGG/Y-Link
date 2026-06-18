/**
 * 文件说明：backend/scripts/system-config-business-hours-verify.ts
 * 文件职责：验证“商城营业时间”和“客服在线时间”可通过系统配置维护，并能正确透传到客户端消费接口。
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
    mallAnnouncementText: string
  }
}

type MallStorefrontPayload = {
  businessHoursText: string
  mallAnnouncementText: string
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
  const { systemConfigService } = await import('../src/services/system-config.service.js')

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
    pass('初始 O2O 店铺营业时间配置正确')

    const initialPortalConfig = await expectJsonOkResponse<CustomerServicePayload>(
      await fetch(`${baseUrl}/api/client-feedback/portal-config`),
      '读取客户端反馈入口配置',
    )
    assert.ok(initialPortalConfig.availability.workHoursText.includes('10:00-20:00'), '初始客服在线时段应包含 10:00-20:00')
    pass('初始客服在线时间已透传到客户端反馈入口配置')

    const updatedO2oRules = await expectJsonOkResponse<{ config: O2oRulesPayload; changed: boolean }>(
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
          mallAnnouncementText: '配置联动验证公告',
        }),
      }),
      '更新 O2O 店铺营业时间配置',
    )
    assert.equal(updatedO2oRules.config.storeBusinessHoursText, '09:30 - 21:30', '更新后店铺营业时间应立即返回新值')
    pass('管理员可更新 O2O 店铺营业时间配置')

    assert.equal(updatedO2oRules.config.mallAnnouncementText, '配置联动验证公告', '更新后商城公告应立即返回新值')

    const updatedMallConfig = await expectJsonOkResponse<MallProductsPayload>(
      await fetch(`${baseUrl}/api/o2o/mall/products`),
      '读取客户端商城商品与门店信息',
    )
    assert.equal(updatedMallConfig.storefront.businessHoursText, '09:30 - 21:30', '客户端商城应返回最新店铺营业时间')
    pass('客户端商城接口可透出最新店铺营业时间')

    assert.equal(updatedMallConfig.storefront.mallAnnouncementText, '配置联动验证公告', '客户端商城商品接口应返回最新商城公告')

    const updatedStorefrontConfig = await expectJsonOkResponse<MallStorefrontPayload>(
      await fetch(`${baseUrl}/api/o2o/mall/storefront`),
      '读取客户端商城门店展示配置',
    )
    assert.equal(updatedStorefrontConfig.businessHoursText, '09:30 - 21:30', '客户端商城门店配置接口应返回最新店铺营业时间')
    assert.equal(updatedStorefrontConfig.mallAnnouncementText, '配置联动验证公告', '客户端商城门店配置接口应返回最新商城公告')
    pass('客户端商城门店配置接口可轻量透出最新公告')

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
