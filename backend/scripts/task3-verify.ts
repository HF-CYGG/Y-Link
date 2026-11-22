/**
 * 文件说明：Task3 数据库迁移体验验证脚本。
 * 文件职责：验证数据库迁移侧栏入口、统一提示文案和运行时覆盖写入后的状态提示。
 * 实现逻辑：
 * 1. 校验系统侧栏的实际菜单派生、独立路由权限，以及系统配置页的迁移说明。
 * 2. 静态校验前后端是否都改为复用统一的数据库迁移提示文案常量。
 * 3. 动态调用数据库运行时覆盖写入逻辑，确认状态摘要会明确提示“等待重启”与“返回数据库迁移助手确认当前实际生效数据库”。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import {
  DATABASE_MIGRATION_ASSISTANT_NAME,
  DATABASE_MIGRATION_RECOMMENDED_FLOW_TEXT,
  DATABASE_MIGRATION_RESTART_EFFECT_TEXT,
  DATABASE_MIGRATION_SWITCH_REASON_DEFAULT,
} from '../src/constants/database-migration-copy.js'
import {
  clearDatabaseRuntimeOverride,
  readDatabaseRuntimeOverride,
  writeDatabaseRuntimeOverride,
} from '../src/config/database-runtime-override.js'
import { databaseMigrationService } from '../src/services/database-migration.service.js'

function pass(title: string) {
  console.log(`✅ ${title}`)
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

const currentFilePath = fileURLToPath(import.meta.url)
const backendRoot = path.resolve(path.dirname(currentFilePath), '..')
const frontendRoot = path.resolve(backendRoot, '..')

const routeFilePath = path.resolve(frontendRoot, 'src/router/routes.ts')
const systemConfigViewFilePath = path.resolve(frontendRoot, 'src/views/system/SystemConfigView.vue')
const appLayoutFilePath = path.resolve(frontendRoot, 'src/layout/AppLayout.vue')
const appSidebarFilePath = path.resolve(frontendRoot, 'src/layout/components/AppSidebar.vue')
const routerFilePath = path.resolve(frontendRoot, 'src/router/index.ts')
const routeLoadersFilePath = path.resolve(frontendRoot, 'src/router/route-performance.ts')
const databaseMigrationViewFilePath = path.resolve(frontendRoot, 'src/views/system/DatabaseMigrationView.vue')
const frontendCopyFilePath = path.resolve(frontendRoot, 'src/views/system/database-migration-copy.ts')
const backendCopyFilePath = path.resolve(backendRoot, 'src/constants/database-migration-copy.ts')
const backendServiceFilePath = path.resolve(backendRoot, 'src/services/database-migration.service.ts')
const backendGuideFilePath = path.resolve(backendRoot, 'src/utils/effective-database.ts')

function readSource(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8')
}

function verifyFrontendMigrationEntry() {
  const routeSource = readSource(routeFilePath)
  const systemConfigViewSource = readSource(systemConfigViewFilePath)
  const databaseMigrationViewSource = readSource(databaseMigrationViewFilePath)
  const frontendCopySource = readSource(frontendCopyFilePath)

  const loadDatabaseMigrationView = () => {}
  const routeCode = ts.transpileModule(routeSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const { routes, buildAppMenuItems, canAccessRoute } = new Function('require', 'exports', routeCode + '\nreturn exports')(
    (specifier: string) => {
      assert.equal(specifier, '@/router/route-performance')
      return { routeViewLoaders: { 'system-db-migration': loadDatabaseMigrationView } }
    },
    {},
  )
  const app = routes.find((record: { path: string }) => record.path === '/')
  const group = app?.children.find((record: { path: string }) => record.path === 'system')
  const migration = group?.children.find((record: { path: string }) => record.path === 'db-migration')
  assert.ok(migration, '系统治理必须定义独立数据库迁移路由')
  assert.equal(migration.name, 'system-db-migration')
  assert.equal(migration.component, loadDatabaseMigrationView)
  assert.deepEqual(migration.meta.requiredPermissions, ['db_migration:view'])
  const authorized = { role: 'operator', permissions: ['db_migration:view'] }
  const missingPermission = { role: 'operator', permissions: ['system_configs:view'] }
  assert.ok(app.meta.requiresAuth && [app, group, migration].every((record) => canAccessRoute(record.meta, authorized)))
  assert.equal(canAccessRoute(migration.meta, missingPermission), false)
  const getMigrationMenu = (user: typeof authorized) => buildAppMenuItems(user)
    .find((item: { title: string }) => item.title === '系统治理')?.children
    .find((item: { path: string }) => item.path === '/system/db-migration')
  assert.equal(getMigrationMenu(authorized)?.title, '数据库迁移助手')
  assert.equal(getMigrationMenu(missingPermission), undefined)
  const layoutSource = readSource(appLayoutFilePath)
  const sidebarSource = readSource(appSidebarFilePath)
  assert.match(layoutSource, /menuItems = computed\(\(\) => buildAppMenuItems\(authStore\.currentUser\)\)/)
  assert.match(layoutSource, /<AppSidebar :menu-items="menuItems"/)
  assert.match(sidebarSource, /<el-menu\b[^>]*\srouter\s/)
  assert.match(sidebarSource, /<el-menu-item v-for="child in menu\.children"[^>]*:index="child\.path"/)
  assert.match(readSource(routerFilePath), /to\.matched\.find\(\(record\) => !canAccessRoute\(record\.meta, authStore\.currentUser\)\)/)
  assert.match(readSource(routeLoadersFilePath), /'system-db-migration': \(\) => import\('@\/views\/system\/DatabaseMigrationView\.vue'\)/)
  assert.match(systemConfigViewSource, /:description="[^"]*\bDATABASE_MIGRATION_ASSISTANT_NAME\b[^"]*\bDATABASE_MIGRATION_RECOMMENDED_FLOW_TEXT\b[^"]*"/)
  assert.match(databaseMigrationViewSource, /DATABASE_MIGRATION_PAGE_DESCRIPTION/)
  assert.match(databaseMigrationViewSource, /DATABASE_MIGRATION_RECOMMENDED_FLOW_TEXT/)
  assert.match(databaseMigrationViewSource, /DATABASE_MIGRATION_RESTART_EFFECT_TEXT/)
  assert.match(frontendCopySource, /DATABASE_MIGRATION_ASSISTANT_NAME = '数据库迁移助手'/)
  pass('数据库迁移侧栏与独立路由按权限可达，系统配置与迁移页复用引导文案')
}

function verifyBackendCopySources() {
  const backendCopySource = readSource(backendCopyFilePath)
  const backendServiceSource = readSource(backendServiceFilePath)
  const backendGuideSource = readSource(backendGuideFilePath)

  assert.match(backendCopySource, /DATABASE_MIGRATION_SWITCH_REASON_DEFAULT = '数据库迁移助手写入 MySQL 运行时覆盖'/)
  assert.match(
    backendCopySource,
    new RegExp(String.raw`DATABASE_MIGRATION_RECOMMENDED_FLOW_TEXT =\s*'${escapeRegExp(DATABASE_MIGRATION_RECOMMENDED_FLOW_TEXT)}'`),
  )
  assert.match(backendServiceSource, /DATABASE_MIGRATION_SUCCESS_STAGE_WITH_SWITCH/)
  assert.match(backendServiceSource, /DATABASE_MIGRATION_SWITCH_REASON_DEFAULT/)
  assert.match(backendGuideSource, /DATABASE_MIGRATION_ASSISTANT_NAME/)
  assert.match(backendGuideSource, /DATABASE_MIGRATION_RECOMMENDED_FLOW_TEXT/)
  pass('后端服务、状态摘要与脚本验证共用同一套数据库迁移提示口径')
}

async function verifyRuntimeOverrideGuidance() {
  const originalOverride = readDatabaseRuntimeOverride()
  const verifyPassword = ['task3', 'verify', 'password'].join('_')

  try {
    await writeDatabaseRuntimeOverride({
      version: 1,
      updatedAt: new Date().toISOString(),
      reason: DATABASE_MIGRATION_SWITCH_REASON_DEFAULT,
      sourceTaskId: 'task3-verify',
      updatedBy: null,
      config: {
        DB_TYPE: 'mysql',
        DB_HOST: '127.0.0.1',
        DB_PORT: 3306,
        DB_USER: 'task3_verify',
        DB_PASSWORD: verifyPassword,
        DB_NAME: 'task3_verify',
        DB_SYNC: false,
      },
      rollbackConfig: {
        DB_TYPE: 'sqlite',
        SQLITE_DB_PATH: './data/task3-verify.sqlite',
        DB_SYNC: false,
      },
    })

    const runtimeState = await databaseMigrationService.getRuntimeOverrideState()
    assert.equal(runtimeState.activeOverride?.reason, DATABASE_MIGRATION_SWITCH_REASON_DEFAULT)
    assert.equal(runtimeState.activeOverride?.config?.DB_TYPE, 'mysql')
    assert.equal(runtimeState.runtimeOverrideStatus.pendingRestart, true)
    assert.match(runtimeState.runtimeOverrideStatus.statusLabel, /等待重启/)
    assert.match(runtimeState.beginnerGuide.recommendedAction, new RegExp(escapeRegExp(DATABASE_MIGRATION_ASSISTANT_NAME)))
    assert.match(runtimeState.beginnerGuide.recommendedAction, /重启后端/)
    assert.match(runtimeState.beginnerGuide.riskTip, new RegExp(escapeRegExp(DATABASE_MIGRATION_RESTART_EFFECT_TEXT)))
    pass('写入运行时覆盖后，状态摘要会明确提示等待重启并回到数据库迁移助手复核')
  } finally {
    if (originalOverride) {
      await writeDatabaseRuntimeOverride(originalOverride)
    } else {
      await clearDatabaseRuntimeOverride()
    }
  }
}

async function main() {
  verifyFrontendMigrationEntry()
  verifyBackendCopySources()
  await verifyRuntimeOverrideGuidance()
}

try {
  await main()
  console.log('\nTask3 自动化验证全部通过。')
} catch (error) {
  console.error('\nTask3 自动化验证失败：', error)
  process.exit(1)
}
