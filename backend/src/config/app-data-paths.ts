/**
 * 模块说明：backend/src/config/app-data-paths.ts
 * 文件职责：集中解析 Y-Link 可持久化应用数据目录，统一数据库迁移、运行时覆盖和维护状态的落盘位置。
 * 实现逻辑：
 * - onebox 通过 Y_LINK_DATA_DIR=/app/data 显式指向持久化卷；
 * - 本地开发未配置时回退到 backend/data，保持现有使用习惯；
 * - 只返回确定的绝对路径，不在解析阶段创建目录或写入文件。
 * 维护说明：
 * - 新增迁移持久化文件时必须从本模块派生路径，禁止再次使用当前工作目录拼接；
 * - 路径结果可包含内部目录信息，不得直接原样暴露给匿名健康检查。
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface AppDataPaths {
  rootDir: string
  runtimeDir: string
  maintenanceStateFile: string
  runtimeOverrideFile: string
  databaseMigrationDir: string
  migrationTaskDir: string
  migrationBackupDir: string
  migrationSnapshotDir: string
  migrationJsonDir: string
  migrationSecretDir: string
  migrationLockFile: string
  migrationCutoverFile: string
}

const backendRootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

export function resolveAppDataPaths(rootOverride?: string): AppDataPaths {
  const configuredRoot = rootOverride?.trim() || process.env.Y_LINK_DATA_DIR?.trim()
  const rootDir = path.resolve(configuredRoot || path.join(backendRootDir, 'data'))
  const runtimeDir = path.join(rootDir, 'runtime')
  const databaseMigrationDir = path.join(rootDir, 'database-migration')

  return {
    rootDir,
    runtimeDir,
    maintenanceStateFile: path.join(runtimeDir, 'maintenance-state.json'),
    runtimeOverrideFile: path.join(runtimeDir, 'database-runtime-override.json'),
    databaseMigrationDir,
    migrationTaskDir: path.join(databaseMigrationDir, 'tasks'),
    migrationBackupDir: path.join(databaseMigrationDir, 'backup'),
    migrationSnapshotDir: path.join(databaseMigrationDir, 'snapshots'),
    migrationJsonDir: path.join(databaseMigrationDir, 'json'),
    migrationSecretDir: path.join(databaseMigrationDir, 'secrets'),
    migrationLockFile: path.join(databaseMigrationDir, 'automatic-migration.lock'),
    migrationCutoverFile: path.join(runtimeDir, 'database-migration-cutover.json'),
  }
}

export const appDataPaths = resolveAppDataPaths()
