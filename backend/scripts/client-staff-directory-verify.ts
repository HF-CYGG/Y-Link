import 'reflect-metadata'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const currentFilePath = fileURLToPath(import.meta.url)
const backendRoot = path.resolve(path.dirname(currentFilePath), '..')
const sqliteRoot = path.resolve(backendRoot, 'data', 'local-dev')

const verifySeed = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const sqlitePath = path.resolve(sqliteRoot, `client-staff-directory-${verifySeed}.sqlite`)
const adminPassword = `Admin_${verifySeed}_Zz9!`
const operatorPassword = `Operator_${verifySeed}_Aa1!`

process.env.APP_PROFILE = `client-staff-directory-${verifySeed}`
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

async function expectJsonForbidden(request: () => Promise<Response>, scene: string) {
  const response = await request()
  const payload = await readJson(response)
  assert.equal(response.status, 403, `${scene} 应返回 403`)
  assert.equal(payload.code, 403, `${scene} 业务状态码应为 403`)
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

async function createStaffDirectoryWorkbookBlob(rows: string[][]) {
  const workbook = new ExcelJS.Workbook()
  const worksheet = workbook.addWorksheet('教职工工号库')
  for (const row of rows) {
    worksheet.addRow(row)
  }
  const buffer = await workbook.xlsx.writeBuffer()
  return new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
}

async function loginSession(
  baseUrl: string,
  body: Record<string, unknown>,
  scene: string,
): Promise<{ token: string; user: { username: string; role: string } }> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const loginData = await expectJsonOkResponse<{
    token?: string
    user: { username: string; role: string }
  }>(response, scene)
  const token = loginData.token ?? readCookieValueFromResponse(response, 'y_link_admin_session')
  assert.ok(token, `${scene} 未返回会话令牌`)
  return { token, user: loginData.user }
}

function cleanupSqliteFile() {
  if (!fs.existsSync(sqlitePath)) {
    return
  }
  try {
    fs.rmSync(sqlitePath, { force: true })
  } catch (error) {
    console.warn(
      `[client-staff-directory-verify] 临时 SQLite 清理失败，已忽略: ${
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
  const { userService } = await import('../src/services/user.service.js')
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

    const adminLogin = await loginSession(
      baseUrl,
      { username: 'admin', password: adminPassword },
      '管理员登录',
    )

    const adminAuth = await authService.resolveAuthUserByToken(adminLogin.token)
    const operator = await userService.create(
      {
        username: `operator${verifySeed.replaceAll('-', '')}`.slice(0, 20),
        password: operatorPassword,
        displayName: '回归操作员',
        role: 'operator',
      },
      adminAuth,
    )
    const operatorLogin = await loginSession(
      baseUrl,
      { username: operator.username, password: operatorPassword },
      '操作员登录',
    )

    const emptyList = await expectJsonOkResponse<{
      list: Array<{ id: string; staffNo: string }>
      total: number
    }>(
      await fetch(`${baseUrl}/api/system-configs/client-staff-directory?page=1&pageSize=20`, {
        headers: { Authorization: `Bearer ${adminLogin.token}` },
      }),
      '查询空教职工库',
    )
    assert.equal(emptyList.total, 0, '初始教职工库应为空')
    pass('管理员可查询空教职工库')

    await expectJsonForbidden(
      () =>
        fetch(`${baseUrl}/api/system-configs/client-staff-directory?page=1&pageSize=20`, {
          headers: { Authorization: `Bearer ${operatorLogin.token}` },
        }),
      '操作员查询教职工库',
    )
    pass('非管理员无法访问教职工库配置接口')

    const initialDepartmentConfig = await expectJsonOkResponse<{
      tree: Array<{ id?: string; label: string; children?: unknown[] }>
      options: string[]
    }>(
      await fetch(`${baseUrl}/api/system-configs/client-departments`, {
        headers: { Authorization: `Bearer ${adminLogin.token}` },
      }),
      '读取初始客户端部门配置',
    )
    assert.deepEqual(initialDepartmentConfig.options, [], '初始客户端部门选项应为空')
    pass('初始客户端部门配置为空')

    const importResult = await expectJsonOkResponse<{
      summary: { created: number; updated: number; skipped: number }
      list: Array<{ id: string; staffNo: string; realName: string; departmentName: string; status: string }>
    }>(
      await fetch(`${baseUrl}/api/system-configs/client-staff-directory/import`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminLogin.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          rows: [
            { staffNo: 'HY1001', realName: '张老师', departmentName: '海右书院' },
            { staffNo: 'HY1002', realName: '李老师', departmentName: '海右书院' },
          ],
        }),
      }),
      '导入教职工库',
    )
    assert.equal(importResult.summary.created, 2, '首次导入应创建 2 条记录')
    assert.equal(importResult.list.length, 2, '导入后应返回最新列表')
    pass('管理员可批量导入教职工库')

    const rawTextImportResult = await expectJsonOkResponse<{
      summary: { created: number; updated: number; skipped: number }
      list: Array<{ id: string; staffNo: string; realName: string; departmentName: string; status: string }>
    }>(
      await fetch(`${baseUrl}/api/system-configs/client-staff-directory/import`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminLogin.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          rawText: ['王老师\tHY1003\t智能制造中心', '赵老师\tHY1004\t智能制造中心'].join('\n'),
        }),
      }),
      '按姓名工号部门顺序导入教职工库',
    )
    assert.equal(rawTextImportResult.summary.created, 2, '姓名、工号、部门顺序导入应创建 2 条记录')
    pass('支持按姓名、工号、部门顺序导入教职工库')

    const txtUploadForm = new FormData()
    txtUploadForm.append(
      'file',
      new Blob([['孙老师\tHY1005\t工业设计中心', '周老师\tHY1006\t工业设计中心'].join('\n')], {
        type: 'text/plain',
      }),
      'staff-directory-import.txt',
    )
    const txtFileImportResult = await expectJsonOkResponse<{
      summary: { created: number; updated: number; skipped: number }
      list: Array<{ id: string; staffNo: string; realName: string; departmentName: string; status: string }>
    }>(
      await fetch(`${baseUrl}/api/system-configs/client-staff-directory/import`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminLogin.token}`,
        },
        body: txtUploadForm,
      }),
      '上传 txt 文件导入教职工库',
    )
    assert.equal(txtFileImportResult.summary.created, 2, '上传 txt 文件导入应创建 2 条记录')
    pass('支持上传 txt 文件自动导入教职工库')

    const xlsxUploadForm = new FormData()
    xlsxUploadForm.append(
      'file',
      await createStaffDirectoryWorkbookBlob([
        ['姓名', '工号', '部门'],
        ['吴老师', 'HY1007', '实验实训中心'],
        ['郑老师', 'HY1008', '实验实训中心'],
      ]),
      'staff-directory-import.xlsx',
    )
    const xlsxFileImportResult = await expectJsonOkResponse<{
      summary: { created: number; updated: number; skipped: number }
      list: Array<{ id: string; staffNo: string; realName: string; departmentName: string; status: string }>
    }>(
      await fetch(`${baseUrl}/api/system-configs/client-staff-directory/import`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminLogin.token}`,
        },
        body: xlsxUploadForm,
      }),
      '上传 xlsx 文件导入教职工库',
    )
    assert.equal(xlsxFileImportResult.summary.created, 2, '上传 xlsx 文件导入应创建 2 条记录')
    pass('支持上传 xlsx 文件自动导入教职工库')

    const departmentConfigAfterImport = await expectJsonOkResponse<{
      tree: Array<{ id?: string; label: string; children?: unknown[] }>
      options: string[]
    }>(
      await fetch(`${baseUrl}/api/system-configs/client-departments`, {
        headers: { Authorization: `Bearer ${adminLogin.token}` },
      }),
      '读取导入后的客户端部门配置',
    )
    assert.ok(departmentConfigAfterImport.options.includes('海右书院'), '导入后应自动补齐海右书院部门')
    assert.ok(departmentConfigAfterImport.options.includes('智能制造中心'), '导入后应自动补齐智能制造中心部门')
    pass('导入教职工库时会自动补齐缺失部门配置')

    const importedRecord = importResult.list.find((item) => item.staffNo === 'HY1001')
    assert.ok(importedRecord, '应能找到 HY1001 记录')

    const updateResult = await expectJsonOkResponse<{
      record: { id: string; staffNo: string; realName: string; departmentName: string; status: string }
    }>(
      await fetch(`${baseUrl}/api/system-configs/client-staff-directory/${importedRecord.id}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${adminLogin.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          staffNo: importedRecord.staffNo,
          realName: '张主任',
          departmentName: '海右书院测试部',
        }),
      }),
      '编辑教职工记录',
    )
    assert.equal(updateResult.record.realName, '张主任')
    assert.equal(updateResult.record.departmentName, '海右书院测试部')
    pass('管理员可编辑教职工库记录')

    const statusResult = await expectJsonOkResponse<{
      record: { id: string; staffNo: string; status: string }
    }>(
      await fetch(`${baseUrl}/api/system-configs/client-staff-directory/${importedRecord.id}/status`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminLogin.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          status: 'inactive',
        }),
      }),
      '停用教职工记录',
    )
    assert.equal(statusResult.record.status, 'inactive')
    pass('管理员可启停教职工库记录')

    const inactiveList = await expectJsonOkResponse<{
      list: Array<{ id: string; staffNo: string; status: string }>
      total: number
    }>(
      await fetch(`${baseUrl}/api/system-configs/client-staff-directory?page=1&pageSize=20&status=inactive`, {
        headers: { Authorization: `Bearer ${adminLogin.token}` },
      }),
      '按状态筛选教职工库',
    )
    assert.equal(inactiveList.total, 1, '按状态筛选应命中停用记录')
    assert.equal(inactiveList.list[0]?.staffNo, 'HY1001')
    pass('教职工库支持按状态筛选')
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
