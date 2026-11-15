/**
 * 文件职责：Onebox 降权后只读预检实际持久路径，防止旧 root 私有卷在启动中途失效。
 * 实现逻辑：基础预检不求值业务 env；原启动控制恢复完成后再检查有效 SQLite/WAL。
 * 维护说明：不创建文件、改权限、重建密钥或访问数据库；权限失败必须中止整个后端。
 */
import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { appDataPaths } from '../config/app-data-paths.js'

function permissionInspector() {
  if (typeof process.getuid !== 'function' || process.getuid() === 0 || process.geteuid?.() === 0) throw new Error('ONEBOX_NON_ROOT_REQUIRED')
  const checked = new Set<string>()
  const directoryAccess = constants.R_OK | constants.W_OK | constants.X_OK
  const inspect = async (target: string, required: boolean, recursive = false, directory = false, writableFile = false): Promise<void> => {
    let stat
    try { stat = await fs.stat(target) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || required) throw new Error('ONEBOX_VOLUME_PERMISSION_DENIED')
      // 尚不存在的业务子目录可由已降权应用按原逻辑创建，必须先证明最近已存在父目录可写/遍历。
      await inspect(path.dirname(target), false, false, true)
      return
    }
    try {
      if (directory && !stat.isDirectory()) throw new Error('directory required')
      // 既有备份与密钥只需可读，目录可写用于原子替换/新增；活动数据库及 WAL/SHM 必须同时可写。
      await fs.access(target, stat.isDirectory() ? directoryAccess : constants.R_OK | (writableFile ? constants.W_OK : 0))
      if (!stat.isDirectory() && !stat.isFile()) throw new Error('unsupported file type')
      if (recursive && stat.isDirectory()) {
        const real = await fs.realpath(target)
        if (checked.has(real)) return
        checked.add(real)
        for (const entry of await fs.readdir(target)) await inspect(path.join(target, entry), true, true)
      }
    } catch { throw new Error('ONEBOX_VOLUME_PERMISSION_DENIED') }
  }
  return inspect
}

// 只读取 env-file-bootstrap 已装载的原始值，不触碰 runtime override 或冻结业务配置。
function baseSqlitePath() {
  const profile = (process.env.APP_PROFILE ?? 'default').replaceAll(/[^a-zA-Z0-9_-]/g, '-')
  return process.env.SQLITE_DB_PATH?.trim() || (profile === 'default' ? './data/y-link.sqlite' : `./data/local-dev/y-link.${profile}.sqlite`)
}

async function inspectSqlitePaths(databases: Iterable<string>) {
  const inspect = permissionInspector()
  for (const database of new Set(databases)) {
    const target = path.resolve(database)
    await inspect(target, false, false, false, true)
    await inspect(`${target}-wal`, false, false, false, true)
    await inspect(`${target}-shm`, false, false, false, true)
  }
}

export async function assertOneboxVolumePermissions() {
  const inspect = permissionInspector()
  await inspect(appDataPaths.rootDir, true, false, true)
  await inspect(path.resolve('uploads'), true, false, true)
  for (const child of ['products', 'client-feedback', '.tmp']) await inspect(path.resolve('uploads', child), false, false, true)
  for (const directory of [appDataPaths.runtimeDir, appDataPaths.databaseMigrationDir, appDataPaths.secretsDir, path.resolve('data', 'backup')]) {
    await inspect(directory, false, true, true)
  }
  await inspectSqlitePaths([baseSqlitePath()])
}

/** 只能由 index 在 inspectDatabaseStartup 完成后调用；PREPARED 重放可能刚改写有效目标。 */
export async function assertEffectiveOneboxSqlitePermissions() {
  const { readDatabaseRuntimeOverride } = await import('../config/database-runtime-override.js')
  const override = process.env.Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE === 'true' ? null : readDatabaseRuntimeOverride()
  const databases = [baseSqlitePath()]
  if (override?.config.DB_TYPE === 'sqlite' && override.config.SQLITE_DB_PATH) databases.push(override.config.SQLITE_DB_PATH)
  if (override?.rollbackConfig?.SQLITE_DB_PATH) databases.push(override.rollbackConfig.SQLITE_DB_PATH)
  await inspectSqlitePaths(databases)
}
