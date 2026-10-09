/**
 * 管理端 WebAuthn 旧 SQLite 升级回归：仅使用本脚本创建的 ASCII 路径数据库。
 * 先构造含存量账号、TOTP 和会话的 pre-058 认证结构，再经真实启动自举升级并核对原数据与登录能力。
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const inherited = [
  'ENV_FILE', 'APP_PROFILE', 'DB_TYPE', 'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD',
  'DB_NAME', 'SQLITE_DB_PATH', 'Y_LINK_DATA_DIR', 'Y_LINK_DATA_ENCRYPTION_KEY',
].filter((key) => process.env[key] !== undefined)
assert.equal(inherited.length, 0, `隔离验证拒绝继承数据库、密钥或 env 配置：${inherited.join(', ')}`)
const backendRoot = path.resolve(process.cwd())
assert.equal(fs.existsSync(path.join(backendRoot, '.env')), false, '隔离验证拒绝读取 backend/.env')
const profile = 'admin-webauthn-legacy-upgrade-verify'
assert.equal(fs.existsSync(path.join(backendRoot, `.env.${profile}`)), false, '隔离验证拒绝读取 profile env')
const testDataRoot = path.resolve(backendRoot, '../tmp/admin-webauthn-20261009-backend/test-data')
assert.equal(path.basename(testDataRoot), 'test-data')
fs.mkdirSync(testDataRoot, { recursive: true })
const tempRoot = fs.mkdtempSync(path.join(testDataRoot, `run-legacy-${process.pid}-`))
const databasePath = path.join(tempRoot, 'pre-058.sqlite')
assert.equal(fs.existsSync(databasePath), false, '隔离验证不得复用数据库')
process.env.NODE_ENV = 'test'
process.env.APP_PROFILE = profile
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'false'
process.env.SQLITE_DB_PATH = databasePath
process.env.Y_LINK_DATA_DIR = path.join(tempRoot, 'app-data')
process.env.Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE = 'true'
process.env.Y_LINK_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.INIT_ADMIN_PASSWORD = 'Legacy-Verify#Admin2026'
process.env.PERMANENT_DELETE_PASSWORD = 'Legacy-Verify#Permanent2026'
process.env.AUTH_WEBAUTHN_ENABLED = 'false'

const { AppDataSource } = await import('../src/config/data-source.js')
const { prepareDatabaseRuntime, initializeDatabaseSchemaIfNeeded } = await import('../src/config/database-bootstrap.js')
const { authService } = await import('../src/services/auth.service.js')
const { adminMfaService } = await import('../src/services/admin-mfa.service.js')
const { SysUser } = await import('../src/entities/sys-user.entity.js')
const { SysUserMfa } = await import('../src/entities/sys-user-mfa.entity.js')
const { SysUserSession } = await import('../src/entities/sys-user-session.entity.js')
const { computeHotp, currentTotpStep, decodeBase32 } = await import('../src/utils/totp.js')

type UserSnapshot = { id: string | number; username: string; password_hash: string; role: string; status: string }
type MfaSnapshot = { id: string | number; user_id: string | number; totp_secret_sealed: string; recovery_codes_json: string; last_used_step: number | null }
type SessionSnapshot = { id: string | number; user_id: string | number; session_token: string; expires_at: string; last_access_at: string }
const columns = async (table: string) => AppDataSource.query(`PRAGMA table_info(${table})`) as Promise<Array<{ name: string }>>
const tableNames = async () => AppDataSource.query(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sys_user_webauthn_credential'",
) as Promise<Array<{ name: string }>>

try {
  prepareDatabaseRuntime()
  await AppDataSource.initialize()
  const initial = await initializeDatabaseSchemaIfNeeded(AppDataSource)
  assert.equal(initial.action, 'synchronized')
  await authService.ensureDefaultAdmin()
  const user = await AppDataSource.getRepository(SysUser).findOneByOrFail({ username: 'admin' })
  const originalLogin = await authService.login({ username: 'admin', password: process.env.INIT_ADMIN_PASSWORD! })
  assert.ok('token' in originalLogin, '历史会话必须由原密码登录创建')
  const originalToken = originalLogin.token
  const auth = await authService.resolveAuthUserByToken(originalToken)
  const enrollment = await adminMfaService.beginEnrollment(auth)
  const enrollmentCode = computeHotp(decodeBase32(enrollment.secret), currentTotpStep())
  await adminMfaService.confirmEnrollment(auth, enrollmentCode)
  await AppDataSource.getRepository(SysUserMfa).update({ userId: user.id }, { lastUsedStep: currentTotpStep() - 2 })

  const beforeUsers = await AppDataSource.query(
    'SELECT id, username, password_hash, role, status FROM sys_user WHERE id = ?', [user.id],
  ) as UserSnapshot[]
  const beforeMfa = await AppDataSource.query(
    'SELECT id, user_id, totp_secret_sealed, recovery_codes_json, last_used_step FROM sys_user_mfa WHERE user_id = ?', [user.id],
  ) as MfaSnapshot[]
  const beforeSessions = await AppDataSource.query(
    'SELECT id, user_id, session_token, expires_at, last_access_at FROM sys_user_session WHERE user_id = ? ORDER BY id', [user.id],
  ) as SessionSnapshot[]
  assert.equal(beforeUsers.length, 1)
  assert.equal(beforeMfa.length, 1)
  assert.equal(beforeSessions.length, 1)

  // 此隔离数据库中的其他结构保持当前版本，仅将认证表退回 058 上线前的精确增量形状。
  await AppDataSource.query('DROP TABLE sys_user_webauthn_credential')
  await AppDataSource.query('DROP INDEX uk_sys_user_webauthn_user_handle')
  await AppDataSource.query('ALTER TABLE sys_user DROP COLUMN webauthn_user_handle')
  assert.ok(!(await columns('sys_user')).some((column) => column.name === 'webauthn_user_handle'))
  assert.equal((await tableNames()).length, 0)
  assert.deepEqual(await AppDataSource.query(
    'SELECT id, username, password_hash, role, status FROM sys_user WHERE id = ?', [user.id],
  ), beforeUsers, '退回旧结构不得改变账号数据')
  assert.deepEqual(await AppDataSource.query(
    'SELECT id, user_id, totp_secret_sealed, recovery_codes_json, last_used_step FROM sys_user_mfa WHERE user_id = ?', [user.id],
  ), beforeMfa, '退回旧结构不得改变 MFA 数据')
  assert.deepEqual(await AppDataSource.query(
    'SELECT id, user_id, session_token, expires_at, last_access_at FROM sys_user_session WHERE user_id = ? ORDER BY id', [user.id],
  ), beforeSessions, '退回旧结构不得改变会话数据')
  console.log('[admin-webauthn-legacy-upgrade-verify] 存量账号、TOTP、会话和 pre-058 结构构造通过')

  const upgraded = await initializeDatabaseSchemaIfNeeded(AppDataSource)
  assert.equal(upgraded.action, 'synchronized', '旧认证结构应触发真实 SQLite 启动自举')
  assert.ok((await columns('sys_user')).some((column) => column.name === 'webauthn_user_handle'))
  assert.equal((await tableNames()).length, 1)
  const handleRows = await AppDataSource.query('SELECT webauthn_user_handle AS handle FROM sys_user WHERE id = ?', [user.id]) as Array<{ handle: string | null }>
  assert.equal(handleRows[0]?.handle, null, '历史账号的 WebAuthn 句柄初始必须为 NULL')
  assert.deepEqual(await AppDataSource.query(
    'SELECT id, username, password_hash, role, status FROM sys_user WHERE id = ?', [user.id],
  ), beforeUsers, '升级后账号和原密码哈希必须逐字节保留')
  assert.deepEqual(await AppDataSource.query(
    'SELECT id, user_id, totp_secret_sealed, recovery_codes_json, last_used_step FROM sys_user_mfa WHERE user_id = ?', [user.id],
  ), beforeMfa, '升级后 TOTP 密文、恢复码摘要和防重放游标必须保留')
  assert.deepEqual(await AppDataSource.query(
    'SELECT id, user_id, session_token, expires_at, last_access_at FROM sys_user_session WHERE user_id = ? ORDER BY id', [user.id],
  ), beforeSessions, '升级后原会话记录必须保留')

  const stillActive = await authService.resolveAuthUserByToken(originalToken)
  assert.equal(String(stillActive.userId), String(user.id), '升级前的存量会话必须仍可鉴权')
  const afterPassword = await authService.login({ username: 'admin', password: process.env.INIT_ADMIN_PASSWORD! })
  assert.ok('mfaRequired' in afterPassword && afterPassword.mfaRequired, '原密码登录必须仍进入 MFA 第二步')
  assert.ok(afterPassword.mfaTicket)
  const code = computeHotp(decodeBase32(enrollment.secret), currentTotpStep())
  const afterMfa = await authService.completeMfaLogin({ mfaTicket: afterPassword.mfaTicket, code })
  const newAuth = await authService.resolveAuthUserByToken(afterMfa.token)
  assert.equal(String(newAuth.userId), String(user.id), '原 TOTP 秘钥必须仍可完成登录')
  const second = await initializeDatabaseSchemaIfNeeded(AppDataSource)
  assert.equal(second.action, 'skipped', '升级后重复启动不应再重建认证结构')
  console.log('[admin-webauthn-legacy-upgrade-verify] 旧库升级、数据保留、原会话及密码+TOTP 登录通过')
} finally {
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
  const parent = fs.realpathSync(path.dirname(tempRoot))
  const child = fs.realpathSync(tempRoot)
  assert.equal(parent, fs.realpathSync(testDataRoot), '清理父目录必须是本任务 test-data')
  assert.equal(path.dirname(child), parent, '仅清理本次创建的临时库目录')
  assert.match(path.basename(child), /^run-legacy-\d+-[A-Za-z0-9]+$/)
  fs.rmSync(child, { recursive: true, force: false })
  console.log('[admin-webauthn-legacy-upgrade-verify] 自有临时 SQLite 与数据目录已清理')
}
