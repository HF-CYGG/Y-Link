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
            password: 'Abcd@1234',
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
    assert.ok(operatorDeniedLogs.length >= 3, '操作员越权拦截审计日志数量不足，期望至少 3 条')

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
      fs.rmSync(sqlitePath, { force: true })
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
