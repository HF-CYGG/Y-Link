/**
 * 文件说明：backend/scripts/security-hardening-verify.ts
 * 文件职责：验证安全加固后的关键边界，覆盖会话哈希、URL token 禁用、外发 URL 拦截和匿名工号查询频控。
 * 实现逻辑：
 * - 使用独立 SQLite 临时库启动真实 Express 应用，避免污染本地开发数据；
 * - 通过服务层和接口同时验证管理端、客户端与通知外发的安全收口；
 * - 所有非法外发地址都在请求发出前被业务校验拦截，不触发真实网络访问。
 * 维护说明：
 * - 新增安全边界时优先补到本脚本，形成可重复执行的最小安全回归集；
 * - 脚本不得输出原始 token、Webhook 完整地址、密码或其他敏感配置值。
 */
import 'reflect-metadata'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UpdateNotificationRuleInput } from '../src/services/notification.service.js'

const currentFilePath = fileURLToPath(import.meta.url)
const backendRoot = path.resolve(path.dirname(currentFilePath), '..')
const sqliteRoot = path.resolve(backendRoot, 'data', 'local-dev')

const verifySeed = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const sqlitePath = path.resolve(sqliteRoot, `security-hardening-${verifySeed}.sqlite`)
const adminPassword = `Admin_${verifySeed}_Zz9!`
const clientPassword = `Client_${verifySeed}_Aa1!`

process.env.APP_PROFILE = `security-hardening-${verifySeed}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'false'
process.env.SQLITE_DB_PATH = sqlitePath
process.env.INIT_ADMIN_PASSWORD = adminPassword

type JsonPayload = {
  code?: number
  message?: string
  data?: unknown
}

type LoginResult = {
  token?: string
  user: {
    id: string
    username: string
    role: string
  }
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

async function expectJsonStatus(
  request: () => Promise<Response>,
  scene: string,
  expectedStatus: number,
): Promise<JsonPayload> {
  const response = await request()
  const payload = await readJson(response)
  assert.equal(response.status, expectedStatus, `${scene} 应返回 ${expectedStatus}，实际 ${response.status}`)
  assert.equal(payload.code, expectedStatus, `${scene} 业务状态码应为 ${expectedStatus}`)
  return payload
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
  const cookiePattern = new RegExp(String.raw`(?:^|,\s*)${cookieName}=([^;]+)`)
  const match = cookiePattern.exec(rawSetCookie)
  return match?.[1] ? decodeURIComponent(match[1]) : null
}

async function loginAdmin(baseUrl: string): Promise<{ token: string; user: LoginResult['user'] }> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: adminPassword }),
  })
  const data = await expectJsonOkResponse<LoginResult>(response, '管理员登录')
  const token = data.token ?? readCookieValueFromResponse(response, 'y_link_admin_session')
  assert.ok(token, '管理员登录未返回可用会话')
  return { token, user: data.user }
}

function cleanupSqliteFile() {
  if (!fs.existsSync(sqlitePath)) {
    return
  }
  try {
    fs.rmSync(sqlitePath, { force: true })
  } catch (error) {
    console.warn(
      `[security-hardening-verify] 临时 SQLite 清理失败，已忽略: ${
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
  const { SysUserSession } = await import('../src/entities/sys-user-session.entity.js')
  const { ClientUser } = await import('../src/entities/client-user.entity.js')
  const { ClientUserSession } = await import('../src/entities/client-user-session.entity.js')
  const { SystemConfig } = await import('../src/entities/system-config.entity.js')
  const { SysUser } = await import('../src/entities/sys-user.entity.js')
  const { authService } = await import('../src/services/auth.service.js')
  const { notificationService } = await import('../src/services/notification.service.js')
  const { systemConfigService } = await import('../src/services/system-config.service.js')
  const { hashPassword } = await import('../src/utils/password.js')
  const { generateSessionToken } = await import('../src/utils/token.js')
  const { hashSessionToken } = await import('../src/utils/session-token.js')

  prepareDatabaseRuntime()
  await AppDataSource.initialize()

  const app = createApp()
  const server = app.listen(0, '127.0.0.1')

  try {
    await initializeDatabaseSchemaIfNeeded(AppDataSource)
    await authService.ensureDefaultAdmin()
    await systemConfigService.ensureDefaultConfigs()
    await notificationService.ensureDefaultRules()

    if (!server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.once('listening', resolve)
      })
    }

    const address = server.address()
    assert.ok(address && typeof address === 'object' && typeof address.port === 'number', '未能获取验证服务端口')
    const baseUrl = `http://127.0.0.1:${address.port}`

    const adminLogin = await loginAdmin(baseUrl)
    const adminAuth = await authService.resolveAuthUserByToken(adminLogin.token)

    const adminSession = await AppDataSource.getRepository(SysUserSession).findOne({
      where: { userId: adminAuth.userId },
      order: { createdAt: 'DESC' },
    })
    assert.ok(adminSession, '管理员登录后应写入会话')
    assert.equal(adminSession.sessionToken, hashSessionToken(adminLogin.token), '管理端会话应以哈希入库')
    assert.notEqual(adminSession.sessionToken, adminLogin.token, '管理端会话不应明文入库')
    pass('管理端 session 已哈希存储')

    await expectJsonOkResponse(
      await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${adminLogin.token}` },
      }),
      '管理端 Bearer 鉴权',
    )
    await expectJsonStatus(
      () => fetch(`${baseUrl}/api/auth/me?access_token=${encodeURIComponent(adminLogin.token)}`),
      '管理端 query token 鉴权',
      401,
    )
    pass('管理端停止支持 query access_token，Bearer 仍可用')

    const clientToken = generateSessionToken()
    const clientUser = await AppDataSource.getRepository(ClientUser).save(
      AppDataSource.getRepository(ClientUser).create({
        mobile: `18${Math.random().toString().slice(2, 12)}`,
        email: null,
        passwordHash: await hashPassword(clientPassword),
        realName: '安全回归客户端',
        departmentName: '测试部门',
        accountType: 'personal',
        staffNo: null,
        staffVerified: false,
        status: 'enabled',
        lastLoginAt: new Date(),
      }),
    )
    await AppDataSource.getRepository(ClientUserSession).save(
      AppDataSource.getRepository(ClientUserSession).create({
        userId: clientUser.id,
        sessionToken: hashSessionToken(clientToken),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        lastAccessAt: new Date(),
      }),
    )
    await expectJsonOkResponse(
      await fetch(`${baseUrl}/api/client-auth/me`, {
        headers: { Authorization: `Bearer ${clientToken}` },
      }),
      '客户端 Bearer 鉴权',
    )
    await expectJsonStatus(
      () => fetch(`${baseUrl}/api/client-auth/me?access_token=${encodeURIComponent(clientToken)}`),
      '客户端 query token 鉴权',
      401,
    )
    pass('客户端停止支持 query access_token，Bearer 仍可用')

    const [rule] = await notificationService.listRules()
    assert.ok(rule, '应存在默认通知规则')
    const invalidFeishuDraft: UpdateNotificationRuleInput = {
      id: rule.id,
      enabled: true,
      recipientUserIds: [],
      emailRecipientAdminUserIds: [],
      emailRecipientSupplierUserIds: [],
      emailEnabled: false,
      feishuEnabled: true,
      externalTriggerMode: 'all_management_offline',
      watchedUserIds: [],
      feishuWebhookUrl: 'http://127.0.0.1/open-apis/bot/v2/hook/secret',
      feishuSignSecret: '',
      emailSubjectPrefix: '[Y-Link]',
    }
    await assert.rejects(
      () =>
        notificationService.testSendByRule({
          ruleId: rule.id,
          channel: 'feishu',
          draft: invalidFeishuDraft,
          actor: adminAuth,
        }),
      /飞书 Webhook/,
      '飞书 Webhook 应拒绝非官方 HTTPS 地址',
    )
    pass('飞书 Webhook 非法地址被前置拦截')

    await AppDataSource.getRepository(SysUser).update({ id: adminAuth.userId }, { email: 'admin-security@example.com' })
    const configRepo = AppDataSource.getRepository(SystemConfig)
    const unsafeEmailConfigs = new Map<string, string>([
      ['verification.email.enabled', '1'],
      ['verification.email.http_method', 'POST'],
      ['verification.email.api_url', 'http://127.0.0.1:9/send-mail'],
      ['verification.email.headers_template', '{}'],
      ['verification.email.body_template', '{"email":"{{target}}","content":"{{content}}"}'],
      ['verification.email.success_match', 'ok'],
    ])
    for (const [configKey, configValue] of unsafeEmailConfigs.entries()) {
      await configRepo.update({ configKey }, { configValue })
    }

    const emailDraft: UpdateNotificationRuleInput = {
      id: rule.id,
      enabled: true,
      recipientUserIds: [],
      emailRecipientAdminUserIds: [adminAuth.userId],
      emailRecipientSupplierUserIds: [],
      emailEnabled: true,
      feishuEnabled: false,
      externalTriggerMode: 'all_management_offline',
      watchedUserIds: [],
      feishuWebhookUrl: '',
      feishuSignSecret: '',
      emailSubjectPrefix: '[Y-Link]',
    }
    const emailResult = await notificationService.testSendByRule({
      ruleId: rule.id,
      channel: 'email',
      draft: emailDraft,
      actor: adminAuth,
    })
    assert.equal(emailResult.success, false, '内网邮件 provider URL 应发送失败')
    assert.ok(
      emailResult.failures.some((item) => item.reason.includes('禁止使用') || item.reason.includes('不安全')),
      `内网邮件 provider URL 应被安全拦截: ${JSON.stringify(emailResult.failures)}`,
    )
    pass('邮件通知 provider 内网地址被前置拦截')

    let limited = false
    for (let index = 0; index < 25; index += 1) {
      const response = await fetch(`${baseUrl}/api/client-auth/staff-directory/lookup?staffNo=SEC-${index}`, {
        headers: { 'x-forwarded-for': '203.0.113.10' },
      })
      if (response.status === 429) {
        const payload = await readJson(response)
        assert.equal(payload.code, 429, '工号目录限流业务码应为 429')
        limited = true
        break
      }
    }
    assert.equal(limited, true, '工号目录查询应触发匿名频控')
    pass('匿名工号目录查询已接入频控')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy()
    }
    cleanupSqliteFile()
  }
}

main().catch((error) => {
  console.error(error)
  cleanupSqliteFile()
  process.exitCode = 1
})
