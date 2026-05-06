/**
 * 文件说明：backend/scripts/permission-regression-verify.ts
 * 文件职责：执行“管理员正向、操作员反向、接口越权拦截”三类权限回归，并在失败时给出明确断言信息。
 * 实现逻辑：
 * 1) 使用独立 SQLite 数据库启动真实后端应用，避免污染开发数据库；
 * 2) 管理员登录后创建操作员，先验证管理员可访问关键治理接口（正向）；
 * 3) 使用操作员访问管理员专属接口，验证 403 拦截（反向）；
 * 4) 读取审计日志，验证越权拦截会写入 `security.access_denied` 记录（越权拦截链路）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const currentFilePath = fileURLToPath(import.meta.url)
const backendRoot = path.resolve(path.dirname(currentFilePath), '..')
const sqliteRoot = path.resolve(backendRoot, 'data', 'local-dev')

const verifySeed = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const sqlitePath = path.resolve(sqliteRoot, `permission-regression-${verifySeed}.sqlite`)
const adminPassword = process.env.Y_LINK_VERIFY_ADMIN_PASSWORD?.trim() || `Admin_${verifySeed}_Zz9!`
const operatorPassword = process.env.Y_LINK_VERIFY_OPERATOR_PASSWORD?.trim() || `Op_${verifySeed}_Aa1!`
const supplierPassword = process.env.Y_LINK_VERIFY_SUPPLIER_PASSWORD?.trim() || `Supplier_${verifySeed}_Cc3!`
const forbiddenUserPassword = process.env.Y_LINK_VERIFY_FORBIDDEN_PASSWORD?.trim() || `Forbidden_${verifySeed}_Bb2!`

process.env.APP_PROFILE = `permission-regression-${verifySeed}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'false'
process.env.SQLITE_DB_PATH = sqlitePath
process.env.INIT_ADMIN_PASSWORD = adminPassword

type JsonPayload = {
  code?: number
  message?: string
  data?: unknown
}

function pass(message: string) {
  // eslint-disable-next-line no-console
  console.log(`✅ ${message}`)
}

async function readJson(response: Response): Promise<JsonPayload> {
  const bodyText = await response.text()
  try {
    return JSON.parse(bodyText) as JsonPayload
  } catch (error) {
    throw new Error(
      `响应不是合法 JSON，status=${response.status} body=${bodyText}\n解析错误：${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

async function expectJsonOk<TData>(request: () => Promise<Response>, scene: string): Promise<TData> {
  const response = await request()
  const payload = await readJson(response)
  assert.equal(response.status, 200, `${scene} HTTP 状态码异常：${response.status}`)
  assert.equal(payload.code, 0, `${scene} 业务状态码异常：${JSON.stringify(payload)}`)
  return payload.data as TData
}

async function expectJsonForbidden(request: () => Promise<Response>, scene: string) {
  const response = await request()
  const payload = await readJson(response)
  assert.equal(response.status, 403, `${scene} 期望 403，实际 ${response.status}`)
  assert.equal(payload.code, 403, `${scene} 业务状态码应为 403`)
  assert.equal(payload.message, '当前账号无权执行该操作', `${scene} 拦截提示异常`)
  return payload
}

async function expectJsonStatus(request: () => Promise<Response>, scene: string, expectedStatus: number) {
  const response = await request()
  const payload = await readJson(response)
  assert.equal(response.status, expectedStatus, `${scene} 期望 ${expectedStatus}，实际 ${response.status}`)
  assert.equal(payload.code, expectedStatus, `${scene} 业务状态码应为 ${expectedStatus}`)
  return payload
}

const readCaptchaCode = (captchaSvg: string) => captchaSvg.replaceAll(/<[^>]*>/g, '').replaceAll(/\s+/g, '').slice(0, 6)

function cleanupSqliteFile() {
  if (!fs.existsSync(sqlitePath)) {
    return
  }
  try {
    fs.rmSync(sqlitePath, { force: true })
  } catch (error) {
    // Windows 上 sqlite 句柄释放偶发滞后，清理失败不能掩盖权限回归断言结果。
    console.warn(
      `[permission-regression] 临时 SQLite 清理失败，已忽略：${
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
        server.once('listening', () => resolve())
      })
    }

    const address = server.address()
    assert.ok(address && typeof address === 'object' && typeof address.port === 'number', '回归服务端口获取失败')
    const baseUrl = `http://127.0.0.1:${address.port}`

    await expectJsonStatus(
      () => fetch(`${baseUrl}/api/users?page=1&pageSize=20`),
      '未登录访问用户列表',
      401,
    )
    pass('未携带 token 访问治理接口会返回 401')

    await expectJsonStatus(
      () =>
        fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'admin',
            password: `${adminPassword}_wrong`,
          }),
        }),
      '管理员错误密码登录',
      401,
    )
    pass('管理端错误密码登录会进入失败计数')

    await expectJsonStatus(
      () =>
        fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'admin',
            password: adminPassword,
          }),
        }),
      '失败后未带验证码登录',
      428,
    )
    pass('管理端失败后再次登录要求图形验证码')

    const adminCaptcha = await expectJsonOk<{
      captchaId: string
      captchaSvg: string
    }>(() => fetch(`${baseUrl}/api/auth/captcha`), '获取管理端图形验证码')
    await expectJsonStatus(
      () =>
        fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'admin',
            password: adminPassword,
            captchaId: adminCaptcha.captchaId,
            captchaCode: 'WRONG',
          }),
        }),
      '错误图形验证码登录',
      400,
    )
    pass('错误图形验证码会被拒绝')

    await expectJsonStatus(
      () =>
        fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'admin',
            password: `${adminPassword}_wrong_again`,
            captchaId: adminCaptcha.captchaId,
            captchaCode: readCaptchaCode(adminCaptcha.captchaSvg),
          }),
        }),
      '正确验证码但错误密码登录',
      401,
    )
    pass('正确验证码不会绕过密码校验')

    const adminCaptchaForSuccess = await expectJsonOk<{
      captchaId: string
      captchaSvg: string
    }>(() => fetch(`${baseUrl}/api/auth/captcha`), '重新获取管理端图形验证码')
    const adminLogin = await expectJsonOk<{
      token: string
      user: { username: string; role: string }
    }>(
      () =>
        fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'admin',
            password: adminPassword,
            captchaId: adminCaptchaForSuccess.captchaId,
            captchaCode: readCaptchaCode(adminCaptchaForSuccess.captchaSvg),
          }),
        }),
      '管理员登录',
    )
    assert.equal(adminLogin.user.username, 'admin')
    assert.equal(adminLogin.user.role, 'admin')
    const adminToken = adminLogin.token
    pass('管理员登录成功')

    const createdOperator = await expectJsonOk<{
      id: string
      username: string
      role: string
      status: string
    }>(
      () =>
        fetch(`${baseUrl}/api/users`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            username: `permission_operator_${verifySeed}`,
            password: operatorPassword,
            displayName: '权限回归操作员',
            role: 'operator',
            status: 'enabled',
          }),
        }),
      '管理员创建操作员',
    )
    assert.equal(createdOperator.role, 'operator')
    pass('管理员可创建操作员（正向）')

    const createdSupplier = await expectJsonOk<{
      id: string
      username: string
      role: string
    }>(
      () =>
        fetch(`${baseUrl}/api/users`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            username: `permission_supplier_${verifySeed}`,
            password: supplierPassword,
            displayName: '权限回归供货方',
            role: 'supplier',
            status: 'enabled',
          }),
        }),
      '管理员创建供货方',
    )
    assert.equal(createdSupplier.role, 'supplier')
    pass('管理员可创建供货方（正向）')

    const adminUsers = await expectJsonOk<{
      list: Array<{ id: string }>
    }>(
      () =>
        fetch(`${baseUrl}/api/users?page=1&pageSize=20&keyword=permission_operator_`, {
          headers: { Authorization: `Bearer ${adminToken}` },
        }),
      '管理员读取用户列表',
    )
    assert.ok(adminUsers.list.some((item) => item.id === createdOperator.id), '管理员未查询到刚创建的操作员')
    pass('管理员可读取用户列表（正向）')

    const adminAuditLogs = await expectJsonOk<{
      list: Array<{ id: string }>
    }>(
      () =>
        fetch(`${baseUrl}/api/audit-logs?page=1&pageSize=10`, {
          headers: { Authorization: `Bearer ${adminToken}` },
        }),
      '管理员读取审计日志',
    )
    assert.ok(Array.isArray(adminAuditLogs.list), '管理员审计日志列表结构异常')
    pass('管理员可读取审计日志（正向）')

    const adminMigrationRuntime = await expectJsonOk<{
      effectiveDatabase: { dbType: string }
    }>(
      () =>
        fetch(`${baseUrl}/api/data-maintenance/db-migration/runtime-override`, {
          headers: { Authorization: `Bearer ${adminToken}` },
        }),
      '管理员读取数据库迁移运行时状态',
    )
    assert.equal(adminMigrationRuntime.effectiveDatabase.dbType, 'sqlite')
    pass('管理员可读取数据库迁移运行时状态（正向）')

    const operatorLogin = await expectJsonOk<{
      token: string
      user: { username: string; role: string }
    }>(
      () =>
        fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: createdOperator.username,
            password: operatorPassword,
          }),
        }),
      '操作员登录',
    )
    assert.equal(operatorLogin.user.role, 'operator')
    const operatorToken = operatorLogin.token
    pass('操作员登录成功')

    const supplierLogin = await expectJsonOk<{
      token: string
      user: { username: string; role: string }
    }>(
      () =>
        fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: createdSupplier.username,
            password: supplierPassword,
          }),
        }),
      '供货方登录',
    )
    assert.equal(supplierLogin.user.role, 'supplier')
    const supplierToken = supplierLogin.token
    pass('供货方登录成功')

    await expectJsonForbidden(
      () =>
        fetch(`${baseUrl}/api/users?page=1&pageSize=20`, {
          headers: { Authorization: `Bearer ${operatorToken}` },
        }),
      '操作员反向访问用户列表',
    )
    pass('操作员访问用户列表被拦截（反向）')

    await expectJsonForbidden(
      () =>
        fetch(`${baseUrl}/api/users`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${operatorToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            username: `forbidden_user_${verifySeed}`,
            password: forbiddenUserPassword,
            displayName: '越权用户',
            role: 'operator',
            status: 'enabled',
          }),
        }),
      '操作员越权新增用户',
    )
    pass('操作员越权新增用户被拦截')

    await expectJsonForbidden(
      () =>
        fetch(`${baseUrl}/api/audit-logs?page=1&pageSize=10`, {
          headers: { Authorization: `Bearer ${operatorToken}` },
        }),
      '操作员越权读取审计日志',
    )
    pass('操作员越权读取审计日志被拦截')

    await expectJsonForbidden(
      () =>
        fetch(`${baseUrl}/api/data-maintenance/db-migration/runtime-override`, {
          headers: { Authorization: `Bearer ${operatorToken}` },
        }),
      '操作员越权读取数据库迁移运行时状态',
    )
    pass('操作员越权读取数据库迁移运行时状态被拦截')

    await expectJsonForbidden(
      () =>
        fetch(`${baseUrl}/api/data-maintenance/backup/sqlite`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${operatorToken}` },
        }),
      '操作员越权创建 SQLite 备份',
    )
    pass('操作员越权创建 SQLite 备份被拦截')

    await expectJsonForbidden(
      () =>
        fetch(`${baseUrl}/api/system-configs/verification-providers/test-send`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${operatorToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            channel: 'mobile',
            target: '13800138000',
            config: {
              enabled: true,
              httpMethod: 'POST',
              apiUrl: 'https://example.com/send-sms',
              headersTemplate: '{"Content-Type":"application/json"}',
              bodyTemplate: '{"mobile":"{{target}}","code":"{{code}}","scene":"{{scene}}"}',
              successMatch: '',
            },
          }),
        }),
      '操作员越权测试验证码平台发送',
    )
    pass('操作员越权测试验证码平台发送被拦截')

    await expectJsonForbidden(
      () =>
        fetch(`${baseUrl}/api/inbound/admin/list`, {
          headers: { Authorization: `Bearer ${supplierToken}` },
        }),
      '供货方越权访问管理端入库列表',
    )
    pass('供货方访问管理端全量入库列表被拦截')

    const lockedUsername = `locked_admin_${verifySeed}`
    await expectJsonStatus(
      () =>
        fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: lockedUsername,
            password: 'WrongPassword1',
          }),
        }),
      '登录锁定首轮错误',
      401,
    )
    for (let index = 0; index < 4; index += 1) {
      const captcha = await expectJsonOk<{
        captchaId: string
        captchaSvg: string
      }>(() => fetch(`${baseUrl}/api/auth/captcha`), `登录锁定验证码 ${index + 1}`)
      await expectJsonStatus(
        () =>
          fetch(`${baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              username: lockedUsername,
              password: 'WrongPassword1',
              captchaId: captcha.captchaId,
              captchaCode: readCaptchaCode(captcha.captchaSvg),
            }),
          }),
        `登录锁定错误计数 ${index + 2}`,
        401,
      )
    }
    await expectJsonStatus(
      () =>
        fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: lockedUsername,
            password: 'WrongPassword1',
          }),
        }),
      '连续错误后临时锁定',
      429,
    )
    pass('管理端连续登录失败会触发 429 临时锁定')

    const deniedLogs = await expectJsonOk<{
      list: Array<{
        actionType: string
        actorUserId: string | null
        targetCode: string | null
      }>
    }>(
      () =>
        fetch(
          `${baseUrl}/api/audit-logs?page=1&pageSize=100&actionType=${encodeURIComponent('security.access_denied')}`,
          {
            headers: { Authorization: `Bearer ${adminToken}` },
          },
        ),
      '管理员查询越权拦截审计日志',
    )

    const operatorDeniedLogs = deniedLogs.list.filter((item) => item.actorUserId === createdOperator.id)
    assert.ok(operatorDeniedLogs.length >= 6, '操作员越权拦截审计日志数量不足，期望至少 6 条')

    const deniedTargets = operatorDeniedLogs.map((item) => item.targetCode ?? '')
    assert.ok(
      deniedTargets.some((target) => target.includes('GET /api/users')),
      '缺少操作员越权访问用户列表的审计记录',
    )
    assert.ok(
      deniedTargets.some((target) => target.includes('POST /api/users')),
      '缺少操作员越权新增用户的审计记录',
    )
    assert.ok(
      deniedTargets.some((target) => target.includes('GET /api/audit-logs')),
      '缺少操作员越权读取审计日志的审计记录',
    )
    assert.ok(
      deniedTargets.some((target) => target.includes('GET /api/data-maintenance/db-migration/runtime-override')),
      '缺少操作员越权读取数据库迁移运行时状态的审计记录',
    )
    assert.ok(
      deniedTargets.some((target) => target.includes('POST /api/data-maintenance/backup/sqlite')),
      '缺少操作员越权创建 SQLite 备份的审计记录',
    )
    assert.ok(
      deniedTargets.some((target) => target.includes('POST /api/system-configs/verification-providers/test-send')),
      '缺少操作员越权测试验证码平台发送的审计记录',
    )
    pass('接口越权拦截会写入审计日志（security.access_denied）')
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
    if (fs.existsSync(sqlitePath)) {
      cleanupSqliteFile()
    }
  }
}

try {
  await main()
  // eslint-disable-next-line no-console
  console.log('\n权限回归验证通过：管理员正向、操作员反向、接口越权拦截均符合预期')
} catch (error) {
  // eslint-disable-next-line no-console
  console.error('\n权限回归验证失败')
  // eslint-disable-next-line no-console
  console.error(error)
  process.exitCode = 1
}
