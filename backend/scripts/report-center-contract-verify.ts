/**
 * 模块说明：backend/scripts/report-center-contract-verify.ts
 * 文件职责：静态验证报表中心权限、路由、字段白名单和 Excel 响应头契约。
 * 实现逻辑：
 * - 读取源码文件并断言关键字符串存在，避免报表功能被后续重构绕过权限或导出约定；
 * - 覆盖五类报表类型、reports:view/export 权限、字段白名单和 xlsx 响应头；
 * - 作为轻量契约脚本接入本地回归，不依赖当前数据库数据。
 * 维护说明：
 * - 新增报表类型或调整导出协议时，需要同步更新本脚本断言；
 * - 本脚本不替代接口级联调，只负责守住关键静态契约。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const backendRoot = path.resolve(__dirname, '..')
const projectRoot = path.resolve(backendRoot, '..')

const readSource = (relativePath: string) => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8')

const permissionSource = readSource('backend/src/constants/auth-permissions.ts')
const routeSource = readSource('backend/src/routes/report.routes.ts')
const serviceSource = readSource('backend/src/services/report.service.ts')
const appSource = readSource('backend/src/app.ts')
const frontendAuthSource = readSource('src/api/modules/auth.ts')
const frontendRouteSource = readSource('src/router/routes.ts')

for (const permission of ['reports:view', 'reports:export']) {
  assert.match(permissionSource, new RegExp(`'${permission}'`), `后端缺少权限点 ${permission}`)
  assert.match(frontendAuthSource, new RegExp(`'${permission}'`), `前端缺少权限点 ${permission}`)
}

assert.match(appSource, /app\.use\('\/api\/reports', reportRouter\)/, '后端未挂载 /api/reports 路由')
assert.match(frontendRouteSource, /path:\s*'reports'/, '前端未注册报表中心路由')
assert.match(routeSource, /requirePermission\('reports:view'\)/, '查询接口未要求 reports:view')
assert.match(routeSource, /requirePermission\('reports:export'\)/, '导出接口未要求 reports:export')
assert.match(routeSource, /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/, '导出接口未设置 xlsx Content-Type')
assert.match(routeSource, /Content-Disposition/, '导出接口未设置下载文件名')

for (const reportType of ['inventory', 'tag-sales', 'kingdee', 'walkin', 'outbound-flow']) {
  assert.match(serviceSource, new RegExp(reportType.replace('-', '\\-')), `缺少报表类型 ${reportType}`)
}

assert.match(serviceSource, /REPORT_FIELD_DEFINITIONS/, '缺少报表字段白名单定义')
assert.match(serviceSource, /导出字段不允许/, '字段白名单未拒绝非法字段')
assert.match(serviceSource, /parseDateOnly/, '时间范围缺少 YYYY-MM-DD 解析校验')
assert.match(serviceSource, /new ExcelJS\.Workbook/, '报表导出未使用 ExcelJS 工作簿')

console.log('报表中心静态契约验证通过')
