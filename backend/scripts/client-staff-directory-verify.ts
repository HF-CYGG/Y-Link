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

type StaffDirectoryPreviewRow = {
  staffNo: string
  realName: string
  departmentName: string
  status: string
  action: 'create' | 'update' | 'skip'
}

type StaffDirectoryPreviewResult = {
  summary: {
    total: number
    creatable: number
    updatable: number
    skippable: number
    autoCreatedDepartments: string[]
  }
  rows: StaffDirectoryPreviewRow[]
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

async function expectJsonBadRequest(request: () => Promise<Response>, scene: string, messageIncludes: string) {
  const response = await request()
  const payload = await readJson(response)
  assert.equal(response.status, 400, `${scene} 应返回 400`)
  assert.equal(payload.code, 400, `${scene} 业务状态码应为 400`)
  assert.ok(
    String(payload.message ?? '').includes(messageIncludes),
    `${scene} 错误信息应包含“${messageIncludes}”: ${JSON.stringify(payload)}`,
  )
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

    await expectJsonBadRequest(
      () =>
        fetch(`${baseUrl}/api/system-configs/client-departments`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${adminLogin.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            tree: [
              {
                id: 'dept_duplicate_parent',
                label: '重复校验父级',
                children: [
                  { id: 'dept_duplicate_child_a', label: '办公室', children: [] },
                  { id: 'dept_duplicate_child_b', label: '办公室', children: [] },
                ],
              },
            ],
          }),
        }),
      '保存同一父级下重复名称的部门配置',
      '重复',
    )
    pass('部门配置会阻断同一父级下重复部门名称')

    const bulkImportDepartmentNodes = Array.from({ length: 12 }, (_, index) => ({
      id: `dept_bulk_${String(index + 1).padStart(2, '0')}`,
      label: `批量导入测试部门-${String(index + 1).padStart(2, '0')}`,
      children: [],
    }))
    const seededDepartmentTree = [
      {
        id: 'dept_book_college',
        label: '书院部',
        children: [
          { id: 'dept_haiyou_college', label: '海右书院', children: [] },
        ],
      },
      {
        id: 'dept_admin_org',
        label: '行政机构',
        children: [
          { id: 'dept_school_office', label: '学校办公室', children: [] },
          { id: 'dept_principal_office', label: '校长办公室', children: [] },
          { id: 'dept_asset_office', label: '资产管理处', children: [] },
          { id: 'dept_admin_office', label: '办公室', children: [] },
        ],
      },
      {
        id: 'dept_party_org',
        label: '党群机构',
        children: [
          { id: 'dept_party_office', label: '办公室', children: [] },
        ],
      },
      { id: 'dept_smart_manufacturing', label: '智能制造中心', children: [] },
      { id: 'dept_industrial_design', label: '工业设计中心', children: [] },
      { id: 'dept_training_center', label: '实验实训中心', children: [] },
      { id: 'dept_international_education', label: '国际教育学院', children: [] },
      ...bulkImportDepartmentNodes,
    ]
    const seededDepartmentUpdateResult = await expectJsonOkResponse<{
      config: {
        tree: Array<{ id?: string; label: string; children?: unknown[] }>
        options: string[]
      }
      changed: boolean
    }>(
      await fetch(`${baseUrl}/api/system-configs/client-departments`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${adminLogin.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ tree: seededDepartmentTree }),
      }),
      '写入教职工目录验证用客户端部门配置',
    )
    const seededDepartmentConfig = seededDepartmentUpdateResult.config
    assert.ok(seededDepartmentConfig.options.includes('书院部-海右书院'), '测试部门树应包含多级书院部门路径')
    assert.ok(seededDepartmentConfig.options.includes('行政机构-校长办公室'), '测试部门树应包含多级行政部门路径')
    const seededDepartmentConfigTreeJson = JSON.stringify(seededDepartmentConfig.tree)
    pass('教职工目录导入验证会先维护既有部门树')

    await expectJsonBadRequest(
      () =>
        fetch(`${baseUrl}/api/system-configs/client-staff-directory/import/preview`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${adminLogin.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            rows: [{ staffNo: 'HY1998', realName: '未匹配教师', departmentName: '测试部门A' }],
          }),
        }),
      '预览未维护部门的教职工目录导入',
      '不在当前部门配置中',
    )
    pass('未匹配部门会在预览阶段阻断且不会自动创建')

    await expectJsonBadRequest(
      () =>
        fetch(`${baseUrl}/api/system-configs/client-staff-directory/import/preview`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${adminLogin.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            rows: [{ staffNo: 'HY1999', realName: '同名教师', departmentName: '办公室' }],
          }),
        }),
      '预览同名叶子部门的教职工目录导入',
      '存在多个同名节点',
    )
    pass('同名叶子部门会要求填写完整部门路径')

    const fullPathPreviewResult = await expectJsonOkResponse<StaffDirectoryPreviewResult>(
      await fetch(`${baseUrl}/api/system-configs/client-staff-directory/import/preview`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminLogin.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          rows: [{ staffNo: 'HY1997', realName: '路径教师', departmentName: '行政机构-办公室' }],
        }),
      }),
      '预览完整部门路径的教职工目录导入',
    )
    assert.equal(fullPathPreviewResult.rows[0]?.departmentName, '行政机构-办公室')
    pass('完整部门路径可直接通过导入预览')

    const importPreviewResult = await expectJsonOkResponse<StaffDirectoryPreviewResult>(
      await fetch(`${baseUrl}/api/system-configs/client-staff-directory/import/preview`, {
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
      '预览导入教职工库',
    )
    assert.equal(importPreviewResult.summary.total, 2, '首次导入预览应识别 2 条记录')
    assert.equal(importPreviewResult.summary.creatable, 2, '首次导入预览应提示创建 2 条记录')
    assert.equal(importPreviewResult.rows[0]?.action, 'create', '首次导入预览应标记为创建')
    assert.equal(importPreviewResult.rows[0]?.departmentName, '书院部-海右书院', '唯一叶子部门应解析为完整部门路径')
    pass('管理员可预览教职工库导入结果')

    const listAfterPreview = await expectJsonOkResponse<{
      list: Array<{ id: string; staffNo: string }>
      total: number
    }>(
      await fetch(`${baseUrl}/api/system-configs/client-staff-directory?page=1&pageSize=20`, {
        headers: { Authorization: `Bearer ${adminLogin.token}` },
      }),
      '预览后再次查询空教职工库',
    )
    assert.equal(listAfterPreview.total, 0, '预览阶段不应提前写入教职工库')
    pass('预览教职工库导入结果不会提前入库')

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
        body: JSON.stringify({ rows: importPreviewResult.rows }),
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

    const txtPreviewForm = new FormData()
    txtPreviewForm.append(
      'file',
      new Blob([['孙老师\tHY1005\t工业设计中心', '周老师\tHY1006\t工业设计中心'].join('\n')], {
        type: 'text/plain',
      }),
      'staff-directory-import.txt',
    )
    const txtFilePreviewResult = await expectJsonOkResponse<StaffDirectoryPreviewResult>(
      await fetch(`${baseUrl}/api/system-configs/client-staff-directory/import/preview`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminLogin.token}`,
        },
        body: txtPreviewForm,
      }),
      '上传 txt 文件预览教职工库导入结果',
    )
    assert.equal(txtFilePreviewResult.summary.total, 2, '上传 txt 文件预览应识别 2 条记录')
    assert.equal(txtFilePreviewResult.summary.creatable, 2, '上传 txt 文件预览应提示创建 2 条记录')
    pass('支持上传 txt 文件自动识别并预览教职工库')

    const txtFileImportResult = await expectJsonOkResponse<{
      summary: { created: number; updated: number; skipped: number }
      list: Array<{ id: string; staffNo: string; realName: string; departmentName: string; status: string }>
    }>(
      await fetch(`${baseUrl}/api/system-configs/client-staff-directory/import`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminLogin.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ rows: txtFilePreviewResult.rows }),
      }),
      '上传 txt 文件导入教职工库',
    )
    assert.equal(txtFileImportResult.summary.created, 2, '上传 txt 文件导入应创建 2 条记录')
    pass('支持上传 txt 文件自动导入教职工库')

    const xlsxPreviewForm = new FormData()
    xlsxPreviewForm.append(
      'file',
      await createStaffDirectoryWorkbookBlob([
        ['姓名', '工号', '部门'],
        ['吴老师', 'HY1007', '实验实训中心'],
        ['郑老师', 'HY1008', '实验实训中心'],
      ]),
      'staff-directory-import.xlsx',
    )
    const xlsxFilePreviewResult = await expectJsonOkResponse<StaffDirectoryPreviewResult>(
      await fetch(`${baseUrl}/api/system-configs/client-staff-directory/import/preview`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminLogin.token}`,
        },
        body: xlsxPreviewForm,
      }),
      '上传 xlsx 文件预览教职工库导入结果',
    )
    assert.equal(xlsxFilePreviewResult.summary.total, 2, '上传 xlsx 文件预览应识别 2 条记录')
    assert.equal(xlsxFilePreviewResult.rows[0]?.action, 'create', '上传 xlsx 文件预览应标记为创建')
    pass('支持上传 xlsx 文件自动识别并预览教职工库')

    const xlsxFileImportResult = await expectJsonOkResponse<{
      summary: { created: number; updated: number; skipped: number }
      list: Array<{ id: string; staffNo: string; realName: string; departmentName: string; status: string }>
    }>(
      await fetch(`${baseUrl}/api/system-configs/client-staff-directory/import`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminLogin.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ rows: xlsxFilePreviewResult.rows }),
      }),
      '上传 xlsx 文件导入教职工库',
    )
    assert.equal(xlsxFileImportResult.summary.created, 2, '上传 xlsx 文件导入应创建 2 条记录')
    pass('支持上传 xlsx 文件自动导入教职工库')

    const orderedList = await expectJsonOkResponse<{
      list: Array<{ id: string; staffNo: string; status: string }>
      total: number
    }>(
      await fetch(`${baseUrl}/api/system-configs/client-staff-directory?page=1&pageSize=20`, {
        headers: { Authorization: `Bearer ${adminLogin.token}` },
      }),
      '按默认顺序查询教职工库',
    )
    assert.deepEqual(
      orderedList.list.slice(0, 8).map((item) => item.staffNo),
      ['HY1001', 'HY1002', 'HY1003', 'HY1004', 'HY1005', 'HY1006', 'HY1007', 'HY1008'],
      '教职工库列表默认应按录入正序展示',
    )
    pass('教职工库默认按录入正序展示')

    await expectJsonForbidden(
      () =>
        fetch(`${baseUrl}/api/system-configs/client-staff-directory`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${operatorLogin.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            ids: orderedList.list.slice(1, 3).map((item) => item.id),
          }),
        }),
      '操作员批量删除教职工库',
    )
    pass('非管理员无法批量删除教职工库')

    const batchDeleteResult = await expectJsonOkResponse<{
      summary: { deleted: number; linkedDepartmentAccounts: number }
    }>(
      await fetch(`${baseUrl}/api/system-configs/client-staff-directory`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${adminLogin.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ids: orderedList.list.slice(1, 3).map((item) => item.id),
        }),
      }),
      '批量删除教职工库',
    )
    assert.equal(batchDeleteResult.summary.deleted, 2, '批量删除应删除 2 条记录')
    pass('管理员可批量删除教职工库')

    const listAfterBatchDelete = await expectJsonOkResponse<{
      list: Array<{ id: string; staffNo: string; status: string }>
      total: number
    }>(
      await fetch(`${baseUrl}/api/system-configs/client-staff-directory?page=1&pageSize=20`, {
        headers: { Authorization: `Bearer ${adminLogin.token}` },
      }),
      '批量删除后查询教职工库',
    )
    assert.equal(listAfterBatchDelete.total, 6, '批量删除后总数应减少 2 条')
    assert.deepEqual(
      listAfterBatchDelete.list.slice(0, 6).map((item) => item.staffNo),
      ['HY1001', 'HY1004', 'HY1005', 'HY1006', 'HY1007', 'HY1008'],
      '批量删除后列表应保持正序并剔除已删除记录',
    )
    pass('批量删除后教职工库列表会移除所选记录')

    const rareHanNamePreviewResult = await expectJsonOkResponse<StaffDirectoryPreviewResult>(
      await fetch(`${baseUrl}/api/system-configs/client-staff-directory/import/preview`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminLogin.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          rows: [
            { staffNo: 'HY1010', realName: '𠮷文', departmentName: '学校办公室' },
          ],
        }),
      }),
      '预览包含扩展汉字姓名的教职工库导入结果',
    )
    assert.equal(rareHanNamePreviewResult.summary.total, 1, '扩展汉字姓名预览应识别 1 条记录')
    assert.equal(rareHanNamePreviewResult.rows[0]?.realName, '𠮷文', '扩展汉字姓名预览应保留原始姓名')
    pass('扩展汉字姓名可通过教职工库导入预览校验')

    const hiddenCharNamePreviewResult = await expectJsonOkResponse<StaffDirectoryPreviewResult>(
      await fetch(`${baseUrl}/api/system-configs/client-staff-directory/import/preview`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminLogin.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          rows: [
            { staffNo: 'HY1011', realName: '李\u200b文喜', departmentName: '校长办公室' },
          ],
        }),
      }),
      '预览包含零宽字符姓名的教职工库导入结果',
    )
    assert.equal(hiddenCharNamePreviewResult.summary.total, 1, '零宽字符姓名预览应识别 1 条记录')
    assert.equal(hiddenCharNamePreviewResult.rows[0]?.realName, '李文喜', '零宽字符姓名预览应自动清洗为标准姓名')
    pass('零宽字符姓名可通过教职工库导入预览校验')

    const separatorVariantNamePreviewResult = await expectJsonOkResponse<StaffDirectoryPreviewResult>(
      await fetch(`${baseUrl}/api/system-configs/client-staff-directory/import/preview`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminLogin.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          rows: [
            { staffNo: 'HY1012', realName: '阿依努尔•买买提', departmentName: '校长办公室' },
          ],
        }),
      }),
      '预览包含分隔点变体姓名的教职工库导入结果',
    )
    assert.equal(separatorVariantNamePreviewResult.summary.total, 1, '分隔点变体姓名预览应识别 1 条记录')
    assert.equal(separatorVariantNamePreviewResult.rows[0]?.realName, '阿依努尔·买买提', '分隔点变体姓名预览应统一归一为标准中点')
    pass('分隔点变体姓名可通过教职工库导入预览校验')

    const annotatedNamePreviewResult = await expectJsonOkResponse<StaffDirectoryPreviewResult>(
      await fetch(`${baseUrl}/api/system-configs/client-staff-directory/import/preview`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminLogin.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          rows: [
            { staffNo: 'HY1013', realName: '张伟（资）', departmentName: '资产管理处' },
          ],
        }),
      }),
      '预览包含括注姓名的教职工库导入结果',
    )
    assert.equal(annotatedNamePreviewResult.summary.total, 1, '括注姓名预览应识别 1 条记录')
    assert.equal(annotatedNamePreviewResult.rows[0]?.realName, '张伟(资)', '括注姓名预览应统一归一为半角括号')
    pass('括注姓名可通过教职工库导入预览校验')

    const englishNamePreviewResult = await expectJsonOkResponse<StaffDirectoryPreviewResult>(
      await fetch(`${baseUrl}/api/system-configs/client-staff-directory/import/preview`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminLogin.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          rows: [
            { staffNo: 'HY1014', realName: 'MATTHEW BRUNGER', departmentName: '国际教育学院' },
          ],
        }),
      }),
      '预览包含英文姓名的教职工库导入结果',
    )
    assert.equal(englishNamePreviewResult.summary.total, 1, '英文姓名预览应识别 1 条记录')
    assert.equal(englishNamePreviewResult.rows[0]?.realName, 'MATTHEW BRUNGER', '英文姓名预览应保留原始格式')
    pass('英文姓名可通过教职工库导入预览校验')

    const largeImportRows = Array.from({ length: 1200 }, (_, index) => ({
      realName: '批量教师',
      staffNo: `L${String(index + 1).padStart(7, '0')}`,
      departmentName: `批量导入测试部门-${String((index % 12) + 1).padStart(2, '0')}`,
      status: 'active' as const,
    }))
    const largeImportPreviewResult = await expectJsonOkResponse<StaffDirectoryPreviewResult>(
      await fetch(`${baseUrl}/api/system-configs/client-staff-directory/import/preview`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminLogin.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          rows: largeImportRows,
        }),
      }),
      '预览大批量教职工库导入结果',
    )
    assert.equal(largeImportPreviewResult.summary.total, 1200, '大批量导入预览应识别 1200 条记录')

    const largeImportResult = await expectJsonOkResponse<{
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
          rows: largeImportPreviewResult.rows.map((item) => ({
            staffNo: item.staffNo,
            realName: item.realName,
            departmentName: item.departmentName,
            status: item.status,
          })),
        }),
      }),
      '导入大批量教职工库',
    )
    assert.equal(largeImportResult.summary.created, 1200, '大批量导入应创建 1200 条记录')
    pass('大批量预览后确认导入教职工库应成功')

    const departmentConfigAfterImport = await expectJsonOkResponse<{
      tree: Array<{ id?: string; label: string; children?: unknown[] }>
      options: string[]
    }>(
      await fetch(`${baseUrl}/api/system-configs/client-departments`, {
        headers: { Authorization: `Bearer ${adminLogin.token}` },
      }),
      '读取导入后的客户端部门配置',
    )
    assert.equal(
      JSON.stringify(departmentConfigAfterImport.tree),
      seededDepartmentConfigTreeJson,
      '教职工目录导入不应修改客户端部门树',
    )
    assert.ok(departmentConfigAfterImport.options.includes('书院部-海右书院'), '导入后应保留已维护的完整部门路径')
    assert.ok(departmentConfigAfterImport.options.includes('智能制造中心'), '导入后应保留已维护的顶级部门')
    pass('导入教职工库只匹配已有部门配置，不会自动新增部门')

    const importedRecord = importResult.list.find((item) => item.staffNo === 'HY1001')
    assert.ok(importedRecord, '应能找到 HY1001 记录')

    const editableDepartmentName = importedRecord.departmentName

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
          departmentName: editableDepartmentName,
        }),
      }),
      '编辑教职工记录',
    )
    assert.equal(updateResult.record.realName, '张主任')
    assert.equal(updateResult.record.departmentName, editableDepartmentName)
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

try {
  await main()
} catch (error) {
  console.error(error)
  cleanupSqliteFile()
  process.exitCode = 1
}
