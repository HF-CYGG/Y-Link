/**
 * 文件说明：backend/scripts/task4-verify.ts
 * 文件职责：为数据库迁移助手补齐 Task4 专项验收脚本，重点覆盖 SQLite/MySQL 状态识别、待重启提示、步骤解锁、按钮阻断与快捷入口链路。
 * 实现逻辑：
 * 1. 通过静态源码断言，验证数据库迁移页面的步骤解锁顺序、阻断文案与关键按钮禁用条件没有回退。
 * 2. 通过运行时覆盖文件与后端状态摘要服务，验证“当前仍在 SQLite”“已写入覆盖等待重启”的动态状态口径。
 * 3. 通过临时模拟当前进程已运行在 MySQL 的上下文，验证页面/脚本依赖的公共摘要逻辑能正确给出 MySQL 已生效结论。
 * 4. 通过系统配置页与路由静态断言，验证数据库迁移助手的快捷入口仍可从统一入口直达。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DATABASE_MIGRATION_ASSISTANT_NAME,
  DATABASE_MIGRATION_RESTART_EFFECT_TEXT,
  DATABASE_MIGRATION_SWITCH_REASON_DEFAULT,
} from '../src/constants/database-migration-copy.js'
import {
  clearDatabaseRuntimeOverride,
  readDatabaseRuntimeOverride,
  writeDatabaseRuntimeOverride,
} from '../src/config/database-runtime-override.js'
import { env, envLoadContext } from '../src/config/env.js'
import { databaseMigrationService } from '../src/services/database-migration.service.js'
import {
  buildBeginnerGuide,
  buildEffectiveDatabaseSummary,
  buildRuntimeOverrideStatusSummary,
} from '../src/utils/effective-database.js'

function pass(title: string) {
  console.log(`✅ ${title}`)
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

const currentFilePath = fileURLToPath(import.meta.url)
const backendRoot = path.resolve(path.dirname(currentFilePath), '..')
const frontendRoot = path.resolve(backendRoot, '..')

const databaseMigrationViewFilePath = path.resolve(frontendRoot, 'src/views/system/DatabaseMigrationView.vue')
const systemConfigViewFilePath = path.resolve(frontendRoot, 'src/views/system/SystemConfigView.vue')
const routeFilePath = path.resolve(frontendRoot, 'src/router/routes.ts')

function readSource(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8')
}

/**
 * 校验快捷入口与统一入口：
 * - 路由层要保留工作台快捷入口；
 * - 系统配置页要保留一键直达入口；
 * - 避免数据库迁移助手重新被隐藏到深层菜单中。
 */
function verifyQuickEntrySources() {
  const routeSource = readSource(routeFilePath)
  const systemConfigViewSource = readSource(systemConfigViewFilePath)

  assert.match(
    routeSource,
    /path:\s*'db-migration'[\s\S]*?shortcut:\s*\{[\s\S]*?title:\s*'数据库迁移'[\s\S]*?path:\s*'\/system\/db-migration'/,
  )
  assert.match(routeSource, /collectFromRecords\(record\.children, fullPath\)/)
  assert.match(systemConfigViewSource, /DATABASE_MIGRATION_ENTRY_LABEL/)
  assert.match(systemConfigViewSource, /DATABASE_MIGRATION_ENTRY_DESCRIPTION/)
  assert.match(systemConfigViewSource, /router\.push\('\/system\/db-migration'\)/)
  pass('数据库迁移助手的工作台快捷入口与系统配置页快捷入口保持可达')
}

/**
 * 校验数据库迁移页面的交互阻断：
 * - 未通过预检前，不解锁后续步骤；
 * - 预检存在 error 时，禁止继续创建任务；
 * - 没有成功任务时，禁止切换到 MySQL。
 */
function verifyStepUnlockAndButtonBlockingSources() {
  const databaseMigrationViewSource = readSource(databaseMigrationViewFilePath)

  assert.match(databaseMigrationViewSource, /const hasPrecheckPassed = computed\(\(\) =>/)
  assert.match(databaseMigrationViewSource, /const hasCreatedTask = computed\(\(\) =>/)
  assert.match(databaseMigrationViewSource, /const hasSucceededTask = computed\(\(\) =>/)
  assert.match(databaseMigrationViewSource, /key:\s*'create'[\s\S]*?unlocked:\s*hasPrecheckPassed\.value/)
  assert.match(databaseMigrationViewSource, /key:\s*'run'[\s\S]*?unlocked:\s*hasCreatedTask\.value/)
  assert.match(databaseMigrationViewSource, /key:\s*'switch'[\s\S]*?unlocked:\s*hasSucceededTask\.value/)
  assert.match(databaseMigrationViewSource, /const handleOpenStep = \(stepKey: MigrationStepKey, unlocked: boolean\) => \{/)
  assert.match(databaseMigrationViewSource, /if \(!unlocked\) \{\s*return\s*\}/)
  assert.match(databaseMigrationViewSource, /const hasPrecheckBlockingError = computed\(\(\) =>/)
  assert.match(databaseMigrationViewSource, /issue\.level === 'error'/)
  assert.match(databaseMigrationViewSource, /当前预检存在阻断错误，请修复后再创建迁移任务/)
  assert.match(databaseMigrationViewSource, /:disabled="!canOperateMigration \|\| row\.status === 'running' \|\| row\.status === 'succeeded'"/)
  assert.match(databaseMigrationViewSource, /:disabled="!canOperateMigration \|\| !selectedSucceededTask"/)
  assert.match(databaseMigrationViewSource, /请先在第 3 步选中一条成功任务/)
  pass('数据库迁移页面已具备步骤解锁顺序与关键按钮阻断保护')
}

/**
 * 在真实后端服务摘要上验证 SQLite 当前态：
 * - 当没有运行时覆盖文件时，当前系统应被识别为 SQLite；
 * - 同时不能错误提示“等待重启”。
 */
async function verifySqliteRuntimeState() {
  const originalOverride = readDatabaseRuntimeOverride()

  try {
    await clearDatabaseRuntimeOverride()
    const runtimeState = await databaseMigrationService.getRuntimeOverrideState()

    assert.equal(runtimeState.effectiveDatabase.dbType, 'sqlite')
    assert.equal(runtimeState.effectiveDatabase.displayName, 'SQLite')
    assert.equal(runtimeState.runtimeOverrideStatus.pendingRestart, false)
    assert.match(runtimeState.runtimeOverrideStatus.statusLabel, /未启用运行时覆盖/)
    assert.match(runtimeState.beginnerGuide.headline, /当前系统仍在使用 SQLite/)
    assert.match(runtimeState.beginnerGuide.recommendedAction, /执行预检/)
    pass('无覆盖文件时，运行时状态会明确展示当前仍运行在 SQLite')
  } finally {
    if (originalOverride) {
      await writeDatabaseRuntimeOverride(originalOverride)
    } else {
      await clearDatabaseRuntimeOverride()
    }
  }
}

/**
 * 在真实后端服务摘要上验证“已写入覆盖但尚未重启”的过渡态：
 * - 当前仍应显示 SQLite 为实际生效数据库；
 * - 同时要明确提示等待重启，不得误报为已经切到 MySQL。
 */
async function verifyPendingRestartRuntimeState() {
  const originalOverride = readDatabaseRuntimeOverride()
  const verifyPassword = ['task4', 'verify', 'password'].join('_')

  try {
    await writeDatabaseRuntimeOverride({
      version: 1,
      updatedAt: new Date().toISOString(),
      reason: DATABASE_MIGRATION_SWITCH_REASON_DEFAULT,
      sourceTaskId: 'task4-verify-pending-restart',
      updatedBy: null,
      config: {
        DB_TYPE: 'mysql',
        DB_HOST: '127.0.0.1',
        DB_PORT: 3306,
        DB_USER: 'task4_verify',
        DB_PASSWORD: verifyPassword,
        DB_NAME: 'task4_verify',
        DB_SYNC: false,
      },
      rollbackConfig: {
        DB_TYPE: 'sqlite',
        SQLITE_DB_PATH: './data/task4-verify.sqlite',
        DB_SYNC: false,
      },
    })

    const runtimeState = await databaseMigrationService.getRuntimeOverrideState()
    assert.equal(runtimeState.effectiveDatabase.dbType, 'sqlite')
    assert.equal(runtimeState.runtimeOverrideStatus.pendingRestart, true)
    assert.match(runtimeState.runtimeOverrideStatus.statusLabel, /等待重启/)
    assert.match(runtimeState.runtimeOverrideStatus.description, /覆盖文件已经落盘/)
    assert.match(runtimeState.effectiveDatabase.description, /当前仍实际运行在 SQLite/)
    assert.match(runtimeState.beginnerGuide.recommendedAction, new RegExp(escapeRegExp(DATABASE_MIGRATION_ASSISTANT_NAME)))
    assert.match(runtimeState.beginnerGuide.riskTip, new RegExp(escapeRegExp(DATABASE_MIGRATION_RESTART_EFFECT_TEXT)))
    pass('已写入 MySQL 覆盖但未重启时，状态摘要会明确提示等待重启且当前仍是 SQLite')
  } finally {
    if (originalOverride) {
      await writeDatabaseRuntimeOverride(originalOverride)
    } else {
      await clearDatabaseRuntimeOverride()
    }
  }
}

/**
 * 通过临时模拟“当前进程已按运行时覆盖加载 MySQL”，验证公共摘要逻辑：
 * - 避免脚本只能校验 SQLite 当前态，无法覆盖 MySQL 已生效态；
 * - 该模拟只改动当前进程内存中的上下文，不会污染真实配置文件。
 */
function verifyMysqlEffectiveGuidance() {
  const envMutable = env as Record<string, unknown>
  const envLoadContextMutable = envLoadContext as Record<string, unknown>
  const originalEnvSnapshot = {
    DB_TYPE: env.DB_TYPE,
    DB_HOST: env.DB_HOST,
    DB_PORT: env.DB_PORT,
    DB_NAME: env.DB_NAME,
  }
  const originalEnvLoadContextSnapshot = {
    runtimeDatabaseOverrideLoaded: envLoadContext.runtimeDatabaseOverrideLoaded,
    runtimeDatabaseOverride: envLoadContext.runtimeDatabaseOverride,
  }
  const simulatedUpdatedAt = '2026-04-29T12:00:00.000Z'

  try {
    envMutable.DB_TYPE = 'mysql'
    envMutable.DB_HOST = '127.0.0.1'
    envMutable.DB_PORT = 3307
    envMutable.DB_NAME = 'task4_effective_mysql'
    envLoadContextMutable.runtimeDatabaseOverrideLoaded = true
    envLoadContextMutable.runtimeDatabaseOverride = {
      filePath: 'memory://task4-effective',
      updatedAt: simulatedUpdatedAt,
      dbType: 'mysql',
    }

    const activeOverride = {
      updatedAt: simulatedUpdatedAt,
      config: {
        DB_TYPE: 'mysql' as const,
      },
    }
    const effectiveDatabase = buildEffectiveDatabaseSummary(activeOverride)
    const runtimeOverrideStatus = buildRuntimeOverrideStatusSummary(activeOverride)
    const beginnerGuide = buildBeginnerGuide(effectiveDatabase, runtimeOverrideStatus)

    assert.equal(effectiveDatabase.dbType, 'mysql')
    assert.equal(effectiveDatabase.displayName, 'MySQL')
    assert.equal(effectiveDatabase.source, 'runtime_override')
    assert.match(effectiveDatabase.summary, /127\.0\.0\.1:3307\/task4_effective_mysql/)
    assert.equal(runtimeOverrideStatus.pendingRestart, false)
    assert.match(runtimeOverrideStatus.statusLabel, /运行时覆盖已生效/)
    assert.match(beginnerGuide.headline, /当前系统已经运行在 MySQL/)
    assert.match(beginnerGuide.recommendedAction, /无需重复执行 SQLite -> MySQL 迁移/)
    pass('当前进程已运行在 MySQL 时，公共摘要逻辑会明确给出 MySQL 已生效结论')
  } finally {
    envMutable.DB_TYPE = originalEnvSnapshot.DB_TYPE
    envMutable.DB_HOST = originalEnvSnapshot.DB_HOST
    envMutable.DB_PORT = originalEnvSnapshot.DB_PORT
    envMutable.DB_NAME = originalEnvSnapshot.DB_NAME
    envLoadContextMutable.runtimeDatabaseOverrideLoaded = originalEnvLoadContextSnapshot.runtimeDatabaseOverrideLoaded
    envLoadContextMutable.runtimeDatabaseOverride = originalEnvLoadContextSnapshot.runtimeDatabaseOverride
  }
}

async function main() {
  verifyQuickEntrySources()
  verifyStepUnlockAndButtonBlockingSources()
  await verifySqliteRuntimeState()
  await verifyPendingRestartRuntimeState()
  verifyMysqlEffectiveGuidance()
}

try {
  await main()
  console.log('\nTask4 自动化验证全部通过。')
} catch (error) {
  console.error('\nTask4 自动化验证失败：', error)
  process.exit(1)
}
