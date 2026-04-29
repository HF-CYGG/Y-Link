/**
 * 文件说明：Task3 数据库迁移体验验证脚本。
 * 文件职责：自动验证数据库迁移快捷入口、统一提示文案以及运行时覆盖写入后的状态提示是否符合 Task3 目标，减少人工逐页排查成本。
 * 实现逻辑：
 * 1. 静态校验前端路由与系统配置页是否已经补上数据库迁移快捷入口。
 * 2. 静态校验前后端是否都改为复用统一的数据库迁移提示文案常量。
 * 3. 动态调用数据库运行时覆盖写入逻辑，确认状态摘要会明确提示“等待重启”与“返回数据库迁移助手确认当前实际生效数据库”。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const currentFilePath = fileURLToPath(import.meta.url)
const backendRoot = path.resolve(path.dirname(currentFilePath), '..')
const frontendRoot = path.resolve(backendRoot, '..')

const routeFilePath = path.resolve(frontendRoot, 'src/router/routes.ts')
const systemConfigViewFilePath = path.resolve(frontendRoot, 'src/views/system/SystemConfigView.vue')
const databaseMigrationViewFilePath = path.resolve(frontendRoot, 'src/views/system/DatabaseMigrationView.vue')
const frontendCopyFilePath = path.resolve(frontendRoot, 'src/views/system/database-migration-copy.ts')
const backendCopyFilePath = path.resolve(backendRoot, 'src/constants/database-migration-copy.ts')
const backendServiceFilePath = path.resolve(backendRoot, 'src/services/database-migration.service.ts')
const backendGuideFilePath = path.resolve(backendRoot, 'src/utils/effective-database.ts')

function readSource(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8')
}

function verifyFrontendQuickEntrySources() {
  const routeSource = readSource(routeFilePath)
  const systemConfigViewSource = readSource(systemConfigViewFilePath)
  const databaseMigrationViewSource = readSource(databaseMigrationViewFilePath)
  const frontendCopySource = readSource(frontendCopyFilePath)

  assert.match(
    routeSource,
    /path:\s*'db-migration'[\s\S]*?shortcut:\s*\{[\s\S]*?title:\s*'数据库迁移'[\s\S]*?path:\s*'\/system\/db-migration'/,
  )
  assert.match(routeSource, /const collectFromRecords = \(sourceRecords: AppRouteRecord\[], currentParentPath: string\)/)
  assert.match(systemConfigViewSource, /DATABASE_MIGRATION_ENTRY_LABEL/)
  assert.match(systemConfigViewSource, /DATABASE_MIGRATION_ENTRY_DESCRIPTION/)
  assert.match(systemConfigViewSource, /router\.push\('\/system\/db-migration'\)/)
  assert.match(databaseMigrationViewSource, /DATABASE_MIGRATION_PAGE_DESCRIPTION/)
  assert.match(databaseMigrationViewSource, /DATABASE_MIGRATION_RECOMMENDED_FLOW_TEXT/)
  assert.match(databaseMigrationViewSource, /DATABASE_MIGRATION_RESTART_EFFECT_TEXT/)
  assert.match(frontendCopySource, /DATABASE_MIGRATION_ENTRY_LABEL = '进入数据库迁移助手'/)
  pass('前端已补充数据库迁移快捷入口，并统一复用迁移助手提示文案')
}

function verifyBackendCopySources() {
  const backendCopySource = readSource(backendCopyFilePath)
  const backendServiceSource = readSource(backendServiceFilePath)
  const backendGuideSource = readSource(backendGuideFilePath)

  assert.match(backendCopySource, /DATABASE_MIGRATION_SWITCH_REASON_DEFAULT = '数据库迁移助手写入 MySQL 运行时覆盖'/)
  assert.match(
    backendCopySource,
    new RegExp(`DATABASE_MIGRATION_RECOMMENDED_FLOW_TEXT =\\s*'${escapeRegExp(DATABASE_MIGRATION_RECOMMENDED_FLOW_TEXT)}'`),
  )
  assert.match(backendServiceSource, /DATABASE_MIGRATION_SUCCESS_STAGE_WITH_SWITCH/)
  assert.match(backendServiceSource, /DATABASE_MIGRATION_SWITCH_REASON_DEFAULT/)
  assert.match(backendGuideSource, /DATABASE_MIGRATION_ASSISTANT_NAME/)
  assert.match(backendGuideSource, /DATABASE_MIGRATION_RECOMMENDED_FLOW_TEXT/)
  pass('后端服务、状态摘要与脚本验证共用同一套数据库迁移提示口径')
}

async function verifyRuntimeOverrideGuidance() {
  const originalOverride = readDatabaseRuntimeOverride()

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
        DB_PASSWORD: 'task3_verify_password',
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
  verifyFrontendQuickEntrySources()
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
