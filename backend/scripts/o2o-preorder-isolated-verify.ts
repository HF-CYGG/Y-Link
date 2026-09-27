/**
 * O2O 专项验证隔离启动器：在加载应用模块前将数据源固定到临时 SQLite，避免读取或迁移本地业务库。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ylink-o2o-verify-'))
process.env.APP_PROFILE = 'o2o-preorder-verify'
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'true'
process.env.SQLITE_DB_PATH = path.join(runtimeDir, 'verification.sqlite')
process.env.Y_LINK_DATA_DIR = runtimeDir
process.env.Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE = 'true'
process.env.INIT_ADMIN_PASSWORD ||= 'O2oVerify_Admin_Aa1!'

try {
  await import('./o2o-preorder-verify.js')
} finally {
  fs.rmSync(runtimeDir, { recursive: true, force: true })
}
