/**
 * O2O 专项验证隔离启动器：在加载应用模块前将数据源固定到临时 SQLite，避免读取或迁移本地业务库。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const runtimeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ylink-o2o-verify-')))
const ownedEnvFile = path.join(runtimeDir, 'isolated.env')
fs.writeFileSync(ownedEnvFile, '', { flag: 'wx', mode: 0o600 })
process.env.NODE_ENV = 'test'
process.env.APP_PROFILE = `o2o-preorder-verify-${process.pid}-${Date.now()}`
process.env.ENV_FILE = ownedEnvFile
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'true'
process.env.SQLITE_DB_PATH = path.join(runtimeDir, 'verification.sqlite')
process.env.Y_LINK_DATA_DIR = runtimeDir
process.env.Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE = 'true'
process.env.DB_AUTO_MIGRATE = 'false'
process.env.REDIS_URL = ''
process.env.ALIYUN_DYPNS_MNS_ENABLED = 'false'
process.env.INIT_ADMIN_PASSWORD ||= 'O2oVerify_Admin_Aa1!'

try {
  // 在任何数据库初始化之前核对最终解析结果，防止继承的 ENV_FILE/profile 把临时库切回真实数据。
  const { AppDataSource } = await import('../src/config/data-source.js')
  const { appDataPaths } = await import('../src/config/app-data-paths.js')
  const { env, envLoadContext } = await import('../src/config/env.js')
  assert.equal(AppDataSource.isInitialized, false)
  assert.equal(AppDataSource.options.type, 'sqlite')
  assert.equal(path.resolve(String(AppDataSource.options.database)), process.env.SQLITE_DB_PATH)
  assert.equal(path.resolve(appDataPaths.rootDir), runtimeDir)
  assert.equal(env.ENV_FILE, ownedEnvFile)
  assert.equal(envLoadContext.requestedProfile, process.env.APP_PROFILE)
  assert.equal(envLoadContext.runtimeDatabaseOverrideLoaded, false)
  for (const value of Object.values(appDataPaths)) {
    const relative = path.relative(runtimeDir, value)
    assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), '隔离持久化路径不能逃逸临时目录')
  }
  console.log('O2O 隔离已核对：独占空 ENV_FILE、临时 SQLite 与数据目录，运行时覆盖关闭')
  await import('./o2o-preorder-verify.js')
} finally {
  fs.rmSync(runtimeDir, { recursive: true, force: true })
}
