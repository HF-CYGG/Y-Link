/**
 * 文件说明：backend/scripts/data-leak-ddos-verify.ts
 * 文件职责：回归“敏感数据防泄露 + 抗 DDoS / 爆破”加固的各项机制，防止接口缓存头、跨站资源隔离、CSRF 会话绑定、
 *   密钥类配置落库加密、JSON 全量导出管控、导出留痕与上限、审计脱敏、MySQL TLS、密码哈希与策略、风控来源聚合与负缓存、
 *   全局撞库态势、认证入参上限、各类并发闸门、事务外密码派生、过载削峰、会话速率保险丝、服务端硬化与鉴权单查询悄悄退化。
 * 实现逻辑：
 * - 闸门并发、在途上限、全局撞库阈值等在模块加载时从环境变量读取，同一进程内无法切换；
 *   因此不带参数运行时主进程只做调度，按阶段逐个起子进程，每个子进程使用独立的临时 SQLite、数据目录与工作目录
 *   （上传、备份目录按工作目录解析，切到临时目录可避免写入工作树）；
 * - core 阶段使用默认阈值：先做纯单元与静态断言，再经真实 HTTP 与服务层断言，最后另起一个真实服务进程验证回环监听与过载采样；
 * - gates 阶段把密码派生、验证码渲染、商品图处理闸门调到 1 并发并调小会话保险丝，验证满载时快速拒绝且不留副作用；
 *   in-flight 阶段验证匿名认证在途上限；global-captcha 阶段调低全局撞库阈值，验证分布式撞库时全员强制图形验证码；
 * - 本机来源需要再次登录前清零风控状态（含进程内负缓存），避免前一段刻意制造的失败触发验证码或锁定、干扰后一段断言；
 * - 测试应用放宽 express 层匿名认证限流，只验证本轮新增的防护，不与既有限流脚本重复。
 * 维护说明：
 * - 修改上述机制时同步补充断言，不要为了让脚本通过而放宽断言；两步验证由 admin-mfa-verify.ts 单独回归，
 *   Nginx 边缘限流由 scripts/verify-web-edge-security.mjs 做静态断言；
 * - 单独调试某一阶段可运行 `node --import tsx scripts/data-leak-ddos-verify.ts <阶段名>`。
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import crypto, { randomBytes, scryptSync } from 'node:crypto'
import fs from 'node:fs'
import http, { type Server } from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { Writable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import type { AuthUserContext } from '../src/types/auth.js'
import type { ClientAuthContext } from '../src/types/client-auth.js'
import type { RequestMeta } from '../src/utils/request-meta.js'

const scriptPath = fileURLToPath(import.meta.url)
const backendRoot = path.resolve(path.dirname(scriptPath), '..')
const repoRoot = path.resolve(backendRoot, '..')
const ADMIN_PASSWORD = 'Leak-Ddos#Verify2026'
const PERMANENT_DELETE_PASSWORD = 'Leak-Ddos-Permanent-Delete!9'
const PHASES = ['core', 'gates', 'in-flight', 'global-captcha'] as const
type Phase = (typeof PHASES)[number]

/** 各阶段专属阈值；其余 YLINK_ 变量一律清除，保证结果不受开发者本机环境影响。 */
const PHASE_ENV: Record<Phase, Record<string, string>> = {
  core: {},
  gates: {
    YLINK_PASSWORD_HASH_CONCURRENCY: '1',
    YLINK_PASSWORD_HASH_QUEUE: '1',
    YLINK_CAPTCHA_RENDER_CONCURRENCY: '1',
    YLINK_CAPTCHA_RENDER_QUEUE: '0',
    YLINK_PRODUCT_IMAGE_CONCURRENCY: '1',
    YLINK_PRODUCT_IMAGE_QUEUE: '0',
    YLINK_SESSION_RATE_BURST: '10',
    YLINK_SESSION_RATE_PER_SECOND: '2',
  },
  'in-flight': {
    YLINK_ANONYMOUS_AUTH_MAX_IN_FLIGHT: '4',
  },
  'global-captcha': {
    YLINK_ADMIN_GLOBAL_FAILURE_THRESHOLD: '5',
    YLINK_CLIENT_GLOBAL_FAILURE_THRESHOLD: '10',
  },
}

interface ApiResponse {
  status: number
  headers: Headers
  text: string
  body: { code?: number; message?: string; data?: Record<string, unknown> | null } | null
  cookies: Record<string, string>
}

interface AdminSession {
  token: string
  csrf: string
  cookie: string
}

interface AuditRow {
  id: number
  actionType: string
  resultStatus: string
  targetCode: string | null
  detailJson: string | null
}

type Modules = Awaited<ReturnType<typeof loadModules>>

let m!: Modules
let server: Server | undefined
let baseUrl = ''
let tempRoot = ''

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// 阶段装配
// ---------------------------------------------------------------------------

async function loadModules() {
  const { AppDataSource, resolveMysqlSslOptions } = await import('../src/config/data-source.js')
  const bootstrap = await import('../src/config/database-bootstrap.js')
  const { env } = await import('../src/config/env.js')
  const { createApp } = await import('../src/app.js')
  const { authService } = await import('../src/services/auth.service.js')
  const { authSecurityService } = await import('../src/services/auth-security.service.js')
  const { persistentRiskStateService } = await import('../src/services/persistent-risk-state.service.js')
  const { systemConfigService } = await import('../src/services/system-config.service.js')
  const { notificationService, FEISHU_SIGN_SECRET_PLACEHOLDER } = await import('../src/services/notification.service.js')
  const { userService } = await import('../src/services/user.service.js')
  const { clientAuthService } = await import('../src/services/client-auth.service.js')
  const { clientUserManageService } = await import('../src/services/client-user-manage.service.js')
  const { auditService } = await import('../src/services/audit.service.js')
  const captchaModule = await import('../src/services/captcha.service.js')
  const { resolvePermissionsByRole } = await import('../src/constants/auth-permissions.js')
  const password = await import('../src/utils/password.js')
  const encryption = await import('../src/utils/data-encryption.js')
  const { BoundedConcurrencyGate, listConcurrencyGateSnapshots } = await import('../src/utils/bounded-concurrency.js')
  const { BizError } = await import('../src/utils/errors.js')
  const { ExportLeasePool, dataExportLeasePool, holdExportLeaseUntilResponseEnds } = await import('../src/utils/export-lease-pool.js')
  const { maskLoginInputForAudit, describeClientRiskSubjectForAudit } = await import('../src/utils/audit-subject-mask.js')
  const { toRiskSourceKey } = await import('../src/utils/ip-subnet.js')
  const { OverloadMonitor } = await import('../src/utils/overload-monitor.js')
  const { overloadMonitor, classifyOverloadShed } = await import('../src/middleware/overload-shedding.middleware.js')
  const { SessionRateFuse } = await import('../src/utils/session-rate-fuse.js')
  const { applyHttpServerHardening, resolveListenHost, HTTP_SERVER_TIMEOUTS } = await import('../src/runtime/http-server-hardening.js')
  const { EphemeralTicketStore } = await import('../src/utils/ephemeral-ticket-store.js')
  const { deriveAdminCsrfToken } = await import('../src/utils/admin-auth-cookie.js')
  const { hashSessionToken } = await import('../src/utils/session-token.js')
  const { getCurrentTransactionManager } = await import('../src/database/transaction-coordinator.js')
  const { SysUser } = await import('../src/entities/sys-user.entity.js')
  const { SysUserSession } = await import('../src/entities/sys-user-session.entity.js')
  const { AuthRiskState } = await import('../src/entities/auth-risk-state.entity.js')
  const { ClientUser } = await import('../src/entities/client-user.entity.js')
  const { NotificationRule } = await import('../src/entities/notification-rule.entity.js')
  return {
    AppDataSource,
    resolveMysqlSslOptions,
    bootstrap,
    env,
    createApp,
    authService,
    authSecurityService,
    persistentRiskStateService,
    systemConfigService,
    notificationService,
    FEISHU_SIGN_SECRET_PLACEHOLDER,
    userService,
    clientAuthService,
    clientUserManageService,
    auditService,
    captchaModule,
    resolvePermissionsByRole,
    password,
    encryption,
    BoundedConcurrencyGate,
    listConcurrencyGateSnapshots,
    BizError,
    ExportLeasePool,
    dataExportLeasePool,
    holdExportLeaseUntilResponseEnds,
    maskLoginInputForAudit,
    describeClientRiskSubjectForAudit,
    toRiskSourceKey,
    OverloadMonitor,
    overloadMonitor,
    classifyOverloadShed,
    SessionRateFuse,
    applyHttpServerHardening,
    resolveListenHost,
    HTTP_SERVER_TIMEOUTS,
    EphemeralTicketStore,
    deriveAdminCsrfToken,
    hashSessionToken,
    getCurrentTransactionManager,
    SysUser,
    SysUserSession,
    AuthRiskState,
    ClientUser,
    NotificationRule,
  }
}

async function bootPhase(phase: Phase) {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ylink-data-leak-ddos-${phase}-`))
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('YLINK_')) delete process.env[key]
  }
  for (const key of ['ENV_FILE', 'Y_LINK_DATA_ENCRYPTION_KEY', 'Y_LINK_JSON_DATA_TRANSFER_ENABLED', 'Y_LINK_LISTEN_HOST', 'DB_SSL_MODE', 'DB_SSL_CA']) {
    delete process.env[key]
  }
  Object.assign(process.env, {
    NODE_ENV: 'test',
    APP_PROFILE: `data-leak-ddos-${phase}-${process.pid}`,
    DB_TYPE: 'sqlite',
    DB_SYNC: 'false',
    SQLITE_DB_PATH: path.join(tempRoot, 'verify.sqlite'),
    Y_LINK_DATA_DIR: path.join(tempRoot, 'data'),
    Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE: 'true',
    INIT_ADMIN_PASSWORD: ADMIN_PASSWORD,
    PERMANENT_DELETE_PASSWORD,
    // 本脚本会刻意制造大量登录失败，默认把全局撞库阈值调到上限，只在 global-captcha 阶段调低。
    YLINK_ADMIN_GLOBAL_FAILURE_THRESHOLD: '100000',
    YLINK_CLIENT_GLOBAL_FAILURE_THRESHOLD: '1000000',
    ...PHASE_ENV[phase],
  })
  const workDir = path.join(tempRoot, 'work')
  fs.mkdirSync(workDir, { recursive: true })
  process.chdir(workDir)

  m = await loadModules()
  m.bootstrap.prepareDatabaseRuntime()
  await m.AppDataSource.initialize()
  await m.bootstrap.initializeDatabaseSchemaIfNeeded(m.AppDataSource)
  await m.authService.ensureDefaultAdmin()
  await m.systemConfigService.ensureDefaultConfigs()
  await m.notificationService.ensureDefaultRules()
  server = m.createApp({ publicAuthRateLimits: { admin: 100_000, client: 100_000 } }).listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server!.once('listening', () => resolve()))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function shutdownPhase() {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()))
  }
  if (m && m.AppDataSource.isInitialized) {
    await m.AppDataSource.destroy()
  }
  // Windows 下无法删除仍是当前工作目录的目录。
  process.chdir(backendRoot)
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

function readSetCookies(response: Response): Record<string, string> {
  const cookies: Record<string, string> = {}
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(';')
    const index = pair.indexOf('=')
    cookies[pair.slice(0, index)] = decodeURIComponent(pair.slice(index + 1))
  }
  return cookies
}

async function call(
  method: string,
  pathname: string,
  options: { body?: unknown; session?: AdminSession; headers?: Record<string, string> } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) }
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  if (options.session) {
    headers.Cookie = options.session.cookie
    headers['x-csrf-token'] = options.session.csrf
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const text = await response.text()
  const isJson = (response.headers.get('content-type') ?? '').includes('application/json')
  return {
    status: response.status,
    headers: response.headers,
    text,
    body: isJson && text ? JSON.parse(text) as ApiResponse['body'] : null,
    cookies: readSetCookies(response),
  }
}

/** 清空风控状态：前一段刻意制造的失败会让本机来源需要图形验证码或被锁定，再次登录前必须归零（含进程内负缓存）。 */
async function resetRiskState() {
  await m.AppDataSource.getRepository(m.AuthRiskState).clear()
  m.persistentRiskStateService.resetNegativeCacheForTesting()
}

async function loginAdmin(username = 'admin', password = ADMIN_PASSWORD): Promise<AdminSession> {
  await resetRiskState()
  const response = await call('POST', '/api/auth/login', { body: { username, password } })
  assert.equal(response.status, 200, `管理端登录失败：${response.text}`)
  const token = response.cookies.y_link_admin_session
  const csrf = response.cookies.y_link_admin_csrf
  assert.ok(token && csrf, '登录成功必须下发会话与 CSRF Cookie')
  return {
    token,
    csrf,
    cookie: `y_link_admin_session=${encodeURIComponent(token)}; y_link_admin_csrf=${encodeURIComponent(csrf)}`,
  }
}

async function contextOf(username: string): Promise<AuthUserContext> {
  const user = await m.AppDataSource.getRepository(m.SysUser).findOneByOrFail({ username })
  return {
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    permissions: m.resolvePermissionsByRole(user.role),
    status: user.status,
    sessionToken: `verify-${username}`,
    authSource: 'bearer',
  }
}

const requestMetaOf = (ipAddress: string): RequestMeta => ({
  ipAddress,
  userAgent: 'data-leak-ddos-verify',
  clientRiskBrowserId: null,
  clientRiskSessionId: null,
})

async function auditMarker(): Promise<number> {
  const rows = await m.AppDataSource.query('SELECT MAX(id) AS maxId FROM sys_audit_log') as Array<{ maxId: number | null }>
  return Number(rows[0]?.maxId ?? 0)
}

async function auditRowsSince(marker: number, actionTypes?: string[]): Promise<AuditRow[]> {
  const filter = actionTypes?.length ? ` AND action_type IN (${actionTypes.map(() => '?').join(', ')})` : ''
  return await m.AppDataSource.query(
    `SELECT id, action_type AS actionType, result_status AS resultStatus, target_code AS targetCode, detail_json AS detailJson
       FROM sys_audit_log WHERE id > ?${filter} ORDER BY id`,
    [marker, ...(actionTypes ?? [])],
  ) as AuditRow[]
}

/** 部分审计在响应后异步写入：等到至少 minCount 条后再多等一小段，确认不会有多余的重复记录。 */
async function settledAuditRows(marker: number, actionTypes: string[], minCount: number): Promise<AuditRow[]> {
  const deadline = Date.now() + 5_000
  while ((await auditRowsSince(marker, actionTypes)).length < minCount && Date.now() < deadline) {
    await sleep(50)
  }
  await sleep(200)
  return await auditRowsSince(marker, actionTypes)
}

function legacyHashOf(plainPassword: string, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(plainPassword, salt, 64).toString('hex')}`
}

async function readSysUserHash(userId: string | number): Promise<string> {
  const user = await m.AppDataSource.getRepository(m.SysUser).createQueryBuilder('user')
    .addSelect('user.passwordHash')
    .where('user.id = :id', { id: userId })
    .getOneOrFail()
  return user.passwordHash
}

async function readClientUserHash(userId: string | number): Promise<string> {
  const user = await m.AppDataSource.getRepository(m.ClientUser).createQueryBuilder('user')
    .addSelect('user.passwordHash')
    .where('user.id = :id', { id: userId })
    .getOneOrFail()
  return user.passwordHash
}

/**
 * 临时替换 crypto.scrypt 观察每次派生：password.ts 以具名导入持有 scrypt，
 * 需要 syncBuiltinESMExports 同步内置模块的 ESM 绑定；结束后必须还原。
 */
async function withScryptProbe<T>(
  intercept: (salt: string) => Error | null,
  work: (calls: Array<{ salt: string; inTransaction: boolean }>) => Promise<T>,
): Promise<T> {
  const original = crypto.scrypt
  const calls: Array<{ salt: string; inTransaction: boolean }> = []
  ;(crypto as { scrypt: unknown }).scrypt = function (this: unknown, ...args: unknown[]) {
    const salt = String(args[1])
    calls.push({ salt, inTransaction: m.getCurrentTransactionManager(m.AppDataSource) !== undefined })
    const injected = intercept(salt)
    if (injected) {
      process.nextTick(args[args.length - 1] as (error: Error) => void, injected)
      return
    }
    return (original as (...inner: unknown[]) => unknown).apply(this, args)
  }
  syncBuiltinESMExports()
  try {
    return await work(calls)
  } finally {
    ;(crypto as { scrypt: unknown }).scrypt = original
    syncBuiltinESMExports()
  }
}

const isBizErrorWithStatus = (statusCode: number) => (error: unknown) => (
  error instanceof m.BizError && error.statusCode === statusCode
)

// ---------------------------------------------------------------------------
// core：纯单元与静态断言
// ---------------------------------------------------------------------------

/** 第 12 项：风控来源键把 IPv4 映射地址还原为 IPv4，IPv6 聚合为 /64。 */
function verifyRiskSourceKeyPrimitives() {
  const cases: Array<[string | null | undefined, string | null]> = [
    ['203.0.113.9', '203.0.113.9'],
    [' 203.0.113.9 ', '203.0.113.9'],
    ['::ffff:127.0.0.1', '127.0.0.1'],
    ['::FFFF:7f00:1', '127.0.0.1'],
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:0db8:0001:0002:ffff:ffff:ffff:ffff', '2001:db8:1:2::/64'],
    ['2001:db8:1:2::', '2001:db8:1:2::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
    ['64:ff9b::1.2.3.4', '64:ff9b:0:0::/64'],
    ['1:2:3:4:5:6:7::', '1:2:3:4::/64'],
    ['', null],
    [null, null],
    [undefined, null],
    ['not-an-ip', null],
    ['1:2:3:4:5:6:7:8:9', null],
    ['12345::1', null],
  ]
  for (const [input, expected] of cases) {
    assert.equal(m.toRiskSourceKey(input), expected, `风控来源键：${String(input)}`)
  }
  assert.equal(m.toRiskSourceKey('2001:db8:aa:bb::1'), m.toRiskSourceKey('2001:db8:aa:bb:dead:beef:0:1'), '同一 /64 内轮换地址落入同一桶')
  assert.notEqual(m.toRiskSourceKey('2001:db8:aa:bb::1'), m.toRiskSourceKey('2001:db8:aa:bc::1'), '相邻 /64 分开计数')
}

/** 第 4 项：AES-256-GCM 密文格式、AAD 绑定、篡改检测、幂等与自动生成的密钥文件。 */
function verifyEncryptionPrimitives() {
  const { sealSensitiveValue, openSensitiveValue, describeDataEncryptionKey } = m.encryption
  const sealed = sealSensitiveValue('verify.context.a', 'hello-secret')
  const parts = sealed.split(':')
  assert.ok(sealed.startsWith('ylenc:v1:') && parts.length === 4, `密文格式应为 ylenc:v1:<密钥ID>:<载荷>：${sealed}`)
  assert.ok(!sealed.includes('hello-secret'))
  assert.notEqual(sealSensitiveValue('verify.context.a', 'hello-secret'), sealed, '随机 IV：相同明文两次加密结果不同')
  assert.deepEqual(openSensitiveValue('verify.context.a', sealed), { value: 'hello-secret', state: 'sealed' })
  assert.equal(openSensitiveValue('verify.context.b', sealed).state, 'unreadable', 'AAD 绑定字段身份：密文挪到其他字段无法解密')
  for (const offset of [12, -1]) {
    const payload = Buffer.from(parts[3], 'base64url')
    const index = offset < 0 ? payload.length + offset : offset
    payload[index] ^= 0x01
    const tampered = [...parts.slice(0, 3), payload.toString('base64url')].join(':')
    assert.equal(openSensitiveValue('verify.context.a', tampered).state, 'unreadable', '篡改密文或认证标签必须解密失败')
  }
  assert.equal(sealSensitiveValue('verify.context.a', ''), '')
  assert.deepEqual(openSensitiveValue('verify.context.a', 'legacy-plain'), { value: 'legacy-plain', state: 'plain' })
  assert.equal(sealSensitiveValue('verify.context.a', sealed), sealed, '已是密文不得重复加密')
  const key = describeDataEncryptionKey()
  assert.equal(key?.source, 'file', '未配置环境变量时使用数据目录中的密钥文件')
  const keyFile = path.join(process.env.Y_LINK_DATA_DIR!, 'secrets', 'data-encryption.key')
  assert.equal(path.resolve(key?.filePath ?? ''), path.resolve(keyFile))
  assert.equal(Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64').length, 32, '自动生成 256 位密钥')
  assert.equal(parts[2], key?.keyId, '密文记录生成它的密钥 ID')
  verifyKeyFileDurability()
}

/**
 * 首次生成密钥文件：硬链接落位后必须先同步所在目录及本次新建目录的父目录，再删除临时文件，
 * 否则主机崩溃重启后正式链接可能丢失、服务另生成新密钥，已落库密文全部无法解密。
 * Windows 无法对目录句柄 fsync（打开即失败并被忽略），因此以“打开目录”作为同步尝试的观测点。
 */
function verifyKeyFileDurability() {
  const baseDir = path.resolve(tempRoot, 'key-durability')
  fs.mkdirSync(baseDir)
  const secretsDir = path.join(baseDir, 'nested', 'secrets')
  const keyFile = path.join(secretsDir, 'data-encryption.key')
  const events: string[] = []
  const directoryFds = new Map<number, string>()
  const original = { linkSync: fs.linkSync, openSync: fs.openSync, fsyncSync: fs.fsyncSync, rmSync: fs.rmSync }
  const writable = fs as unknown as Record<string, unknown>
  writable.linkSync = (from: fs.PathLike, to: fs.PathLike) => {
    original.linkSync(from, to)
    events.push(`link:${path.resolve(String(to))}`)
  }
  writable.openSync = (target: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode | null) => {
    const resolved = path.resolve(String(target))
    const isDirectory = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
    if (isDirectory) events.push(`open-dir:${resolved}`)
    const fd = original.openSync(target, flags, mode)
    if (isDirectory) directoryFds.set(fd, resolved)
    return fd
  }
  writable.fsyncSync = (fd: number) => {
    original.fsyncSync(fd)
    const directory = directoryFds.get(fd)
    if (directory) events.push(`fsync-dir:${directory}`)
  }
  writable.rmSync = (target: fs.PathLike, options?: fs.RmOptions) => {
    events.push(`rm:${path.basename(String(target))}`)
    original.rmSync(target, options)
  }
  let first: { key: Buffer; generated: boolean }
  let second: { key: Buffer; generated: boolean }
  try {
    first = m.encryption.createDataEncryptionKeyFile(keyFile)
    second = m.encryption.createDataEncryptionKeyFile(keyFile)
  } finally {
    Object.assign(writable, original)
  }
  assert.equal(first.generated, true)
  assert.equal(second.generated, false, '正式文件已存在时改为读取，不另生成密钥')
  assert.ok(second.key.equals(first.key))
  const linkIndex = events.indexOf(`link:${path.resolve(keyFile)}`)
  const removeIndex = events.findIndex((event) => event.startsWith('rm:.data-encryption.key.'))
  assert.ok(linkIndex >= 0 && removeIndex > linkIndex, `落盘顺序异常：${events.join(' | ')}`)
  const expectedDirectories = [secretsDir, path.join(baseDir, 'nested'), baseDir].map((item) => path.resolve(item))
  for (const directory of expectedDirectories) {
    const opened = events.indexOf(`open-dir:${directory}`)
    assert.ok(opened > linkIndex && opened < removeIndex, `删除临时文件前必须同步目录 ${directory}：${events.join(' | ')}`)
    if (process.platform !== 'win32') {
      const synced = events.indexOf(`fsync-dir:${directory}`)
      assert.ok(synced > linkIndex && synced < removeIndex, `目录 ${directory} 必须 fsync：${events.join(' | ')}`)
    }
  }
  assert.ok(!events.includes(`open-dir:${path.dirname(baseDir)}`), '只同步本次新建目录的父目录，不向上越界')
  assert.deepEqual(fs.readdirSync(secretsDir), ['data-encryption.key'], '临时文件已清理')
}

/** 第 6 项：导出租约按账号与进程限流，数字与字符串主键视为同一账号，重复归还不多减。 */
function verifyExportLeasePoolPrimitives() {
  const pool = new m.ExportLeasePool({ maxPerActor: 1, maxPerProcess: 2 })
  assert.throws(() => pool.acquire(''), /身份缺失/)
  const leaseA = pool.acquire('a')
  assert.throws(() => pool.acquire(' a '), /已有导出任务/)
  const leaseB = pool.acquire(2)
  assert.throws(() => pool.acquire('2'), /已有导出任务/, 'SQLite 数字主键与字符串主键视为同一账号')
  assert.throws(() => pool.acquire('c'), /导出任务较多/)
  leaseA.release()
  leaseA.release()
  assert.equal(pool.activeExports, 1, '重复归还不得多减')
  leaseB.release()
  assert.equal(pool.activeExports, 0)

  // 一次性发送 Buffer 的导出：租约持有到响应 finish / close，而不是文件生成完就归还。
  const response = new EventEmitter()
  m.holdExportLeaseUntilResponseEnds(pool.acquire('slow-client'), response)
  assert.equal(pool.activeExports, 1, '响应未发完前仍占用导出租约')
  assert.throws(() => pool.acquire('slow-client'), /已有导出任务/)
  response.emit('finish')
  response.emit('close')
  assert.equal(pool.activeExports, 0, '响应结束后归还且不重复扣减')
}

/** 第 7 项：登录输入改记为“掩码 + 密钥指纹”。 */
function verifyAuditMaskPrimitives() {
  assert.match(m.maskLoginInputForAudit('13812345678'), /^138\*\*\*\*5678#[0-9a-f]{10}$/)
  assert.match(m.maskLoginInputForAudit('alice@example.com'), /^a\*\*\*@example\.com#[0-9a-f]{10}$/)
  assert.match(m.maskLoginInputForAudit('MySecretPassw0rd!'), /^My\*\*\*\(17\)#[0-9a-f]{10}$/)
  assert.equal(
    m.maskLoginInputForAudit('Same-Input').split('#')[1],
    m.maskLoginInputForAudit('same-input').split('#')[1],
    '指纹按小写计算，大小写变体可关联',
  )
  assert.equal(m.describeClientRiskSubjectForAudit('uid:42'), 'uid:42', '已解析的规范主体原样记录')
}

/** 第 8 项：MySQL 连接 TLS 选项。 */
function verifyMysqlSslOptions() {
  assert.deepEqual(m.resolveMysqlSslOptions('disabled', undefined), {})
  assert.deepEqual(m.resolveMysqlSslOptions('required', undefined), { ssl: { rejectUnauthorized: false } })
  assert.deepEqual(m.resolveMysqlSslOptions('verify-full', undefined), { ssl: { rejectUnauthorized: true } })
  const caFile = path.join(tempRoot, 'verify-ca.pem')
  fs.writeFileSync(caFile, 'VERIFY-CA-PEM')
  assert.deepEqual(m.resolveMysqlSslOptions('verify-full', caFile), { ssl: { rejectUnauthorized: true, ca: 'VERIFY-CA-PEM' } })
  assert.throws(() => m.resolveMysqlSslOptions('verify-full', path.join(tempRoot, 'missing-ca.pem')), /DB_SSL_CA/)
}

/** 第 9 项：新哈希参数、旧格式兼容与升级标记、参数区间校验，以及三种情况的耗时一致。 */
async function verifyPasswordHashPrimitives() {
  const { hashPassword, verifyPasswordDetailed, verifyPassword, verifyPasswordForNonexistentAccount } = m.password
  const current = await hashPassword('Hello1234x')
  assert.match(current, /^s2\$16384\$8\$5\$[0-9a-f]{32}\$[0-9a-f]{128}$/, '新哈希使用 OWASP 基线参数且参数随哈希保存')
  assert.deepEqual(await verifyPasswordDetailed('Hello1234x', current), { matched: true, needsRehash: false })
  assert.deepEqual(await verifyPasswordDetailed('wrong-pass1', current), { matched: false, needsRehash: false })
  const legacy = legacyHashOf('Hello1234x')
  assert.deepEqual(await verifyPasswordDetailed('Hello1234x', legacy), { matched: true, needsRehash: true })
  assert.deepEqual(await verifyPasswordDetailed('wrong-pass1', legacy), { matched: false, needsRehash: false })
  const weakSalt = randomBytes(16).toString('hex')
  const weakCurrent = `s2$16384$8$1$${weakSalt}$${scryptSync('Hello1234x', weakSalt, 64, { N: 16384, r: 8, p: 1 }).toString('hex')}`
  assert.deepEqual(await verifyPasswordDetailed('Hello1234x', weakCurrent), { matched: true, needsRehash: true }, '低于当前参数的新格式同样升级')
  assert.equal(await verifyPassword('x', 's2$4194304$8$1$aa$bb'), false, '超出安全区间的参数必须拒绝')
  assert.equal(await verifyPassword('x', 'garbage'), false)

  // 交替计时，减少机器负载漂移；旧格式若不补等量计算只需约 1/5 耗时，0.6 的容差足以发现退化。
  await verifyPasswordForNonexistentAccount('warm-up-1')
  const totals = { current: 0, legacy: 0, missing: 0 }
  const timeOnce = async (work: () => Promise<unknown>) => {
    const startedAt = performance.now()
    await work()
    return performance.now() - startedAt
  }
  for (let round = 0; round < 5; round += 1) {
    totals.current += await timeOnce(() => verifyPassword('wrong-pass1', current))
    totals.legacy += await timeOnce(() => verifyPassword('wrong-pass1', legacy))
    totals.missing += await timeOnce(() => verifyPasswordForNonexistentAccount('wrong-pass1'))
  }
  const describe = `current=${totals.current.toFixed(0)}ms legacy=${totals.legacy.toFixed(0)}ms missing=${totals.missing.toFixed(0)}ms`
  assert.ok(Math.abs(totals.legacy - totals.current) / totals.current < 0.6, `旧格式补齐后耗时应与新格式相近：${describe}`)
  assert.ok(Math.abs(totals.missing - totals.current) / totals.current < 0.6, `账号不存在时耗时应与新格式相近：${describe}`)
}

/** 第 10 项：弱口令黑名单、禁止包含账号信息与系统名、最大长度 64。 */
function verifyPasswordPolicyPrimitives() {
  const { assertClientPasswordPolicy, assertAdminPasswordPolicy, assertPasswordAvoidsAccountIdentifiers } = m.password
  assert.throws(() => assertClientPasswordPolicy('Password123'), /常见弱口令/)
  assert.throws(() => assertClientPasswordPolicy('woaini1314'), /常见弱口令/)
  assert.throws(() => assertClientPasswordPolicy('aaaa1111'), /过于简单/)
  assert.throws(() => assertClientPasswordPolicy('MyYlinkAcct9'), /系统名称/)
  assert.throws(() => assertClientPasswordPolicy('x13812345678k', '密码', { identifiers: ['13812345678'] }), /账号信息/)
  assert.throws(() => assertClientPasswordPolicy('Alice2026xyz', '密码', { identifiers: ['alice@example.com'] }), /账号信息/)
  assert.throws(() => assertAdminPasswordPolicy(`Ab1${'x'.repeat(62)}`), /不能超过 64 位/)
  assert.equal(assertAdminPasswordPolicy('Tq7!mZ2#vR9p', '密码', { identifiers: ['admin'] }), 'Tq7!mZ2#vR9p')
  assert.doesNotThrow(() => assertPasswordAvoidsAccountIdentifiers('Tq7mZ2vR9p', '密码', ['abc', null, '']), '过短或空的标识不参与比对')
}

/** 第 15 项：有界并发闸门的排队、FIFO 移交、超时与异常释放。 */
async function verifyConcurrencyGatePrimitives() {
  const gate = new m.BoundedConcurrencyGate({ name: 'verify-gate-fifo', maxConcurrent: 1, maxQueue: 1, queueTimeoutMs: 1000, busyMessage: '忙', retryAfterSeconds: 3 })
  const order: string[] = []
  const first = gate.run(async () => { order.push('first-start'); await sleep(100); order.push('first-end'); return 1 })
  const second = gate.run(async () => { order.push('second-start'); return 2 })
  await assert.rejects(gate.run(async () => 3), (error: unknown) => isBizErrorWithStatus(503)(error) && (error as { retryAfterSeconds?: number }).retryAfterSeconds === 3, '队满立即返回 503 并携带 Retry-After')
  assert.deepEqual(await Promise.all([first, second]), [1, 2])
  assert.deepEqual(order, ['first-start', 'first-end', 'second-start'], '槽位按 FIFO 移交')
  const snapshot = gate.snapshot()
  assert.equal(snapshot.active, 0)
  assert.equal(snapshot.queued, 0)
  assert.equal(snapshot.rejectedQueueFull, 1)
  assert.equal(snapshot.completed, 2)
  assert.equal(snapshot.peakQueued, 1)

  const timeoutGate = new m.BoundedConcurrencyGate({ name: 'verify-gate-timeout', maxConcurrent: 1, maxQueue: 5, queueTimeoutMs: 50, busyMessage: '忙' })
  const slow = timeoutGate.run(async () => { await sleep(200); return 'slow' })
  await assert.rejects(timeoutGate.run(async () => 'late'), isBizErrorWithStatus(503), '排队超时返回 503')
  assert.equal(await slow, 'slow')
  assert.equal(timeoutGate.snapshot().active, 0, '超时的等待者不得占用槽位')
  assert.equal(timeoutGate.snapshot().rejectedTimeout, 1)
  assert.equal(await timeoutGate.run(async () => 'after'), 'after')

  const errorGate = new m.BoundedConcurrencyGate({ name: 'verify-gate-error', maxConcurrent: 1, maxQueue: 0, queueTimeoutMs: 10, busyMessage: '忙' })
  await assert.rejects(errorGate.run(async () => { throw new Error('boom') }), /boom/)
  assert.equal(await errorGate.run(async () => 'ok'), 'ok', '任务抛错也要释放槽位')
  assert.throws(() => new m.BoundedConcurrencyGate({ name: 'verify-gate-error', maxConcurrent: 1, maxQueue: 0, queueTimeoutMs: 10, busyMessage: '忙' }), /重复创建/)
}

/** 第 20 项：过载等级迟滞状态机与削峰分类。 */
function verifyOverloadPrimitives() {
  const policy = { enabled: true, sampleIntervalMs: 1000, elevatedLoopDelayMs: 500, criticalLoopDelayMs: 1000, elevatedWriteQueueRatio: 0.9, enterSamples: 3, recoverSamples: 5 }
  const monitor = new m.OverloadMonitor(policy)
  const feed = (loop: number, queue: number | null, times: number) => {
    for (let index = 0; index < times; index += 1) monitor.evaluate({ eventLoopDelayP99Ms: loop, writeQueueOccupancy: queue })
  }
  feed(600, null, 2)
  assert.equal(monitor.getLevel(), 'normal', '一两次抖动不升级')
  feed(600, null, 1)
  assert.equal(monitor.getLevel(), 'elevated')
  feed(300, null, 10)
  assert.equal(monitor.getLevel(), 'elevated', '处于迟滞区间（阈值一半以上）不降级')
  feed(100, 0.1, 5)
  assert.equal(monitor.getLevel(), 'normal')
  feed(10, 0.95, 3)
  assert.equal(monitor.getLevel(), 'elevated', '写队列拥堵可升到 elevated')
  feed(10, 0.99, 10)
  assert.equal(monitor.getLevel(), 'elevated', '写队列拥堵不会触发 critical')
  feed(1500, 0.99, 3)
  assert.equal(monitor.getLevel(), 'critical')
  feed(400, 0.99, 5)
  assert.equal(monitor.getLevel(), 'elevated', 'critical 回落先回到 elevated')
  const disabled = new m.OverloadMonitor({ ...policy, enabled: false })
  for (let index = 0; index < 5; index += 1) disabled.evaluate({ eventLoopDelayP99Ms: 5000, writeQueueOccupancy: 1 })
  assert.equal(disabled.getLevel(), 'normal', '关闭开关后等级恒为 normal')

  const classify = m.classifyOverloadShed
  assert.equal(classify('POST', '/api/auth/login', 'normal'), null)
  assert.equal(classify('POST', '/api/auth/login', 'elevated'), 'anonymousAuth')
  assert.equal(classify('GET', '/api/customer-service/stream', 'elevated'), 'realtime')
  assert.equal(classify('GET', '/api/reports/sales/export', 'elevated'), 'export')
  assert.equal(classify('POST', '/api/data-maintenance/export/json', 'elevated'), 'export')
  assert.equal(classify('GET', '/api/users', 'elevated'), null, 'elevated 不拒绝已登录读请求')
  assert.equal(classify('GET', '/api/users', 'critical'), 'read')
  assert.equal(classify('GET', '/api/auth/me', 'critical'), null)
  assert.equal(classify('POST', '/api/orders', 'critical'), null, '写请求永不削峰')
  assert.equal(classify('POST', '/api/v1/mobile-auth/login', 'critical'), null, '移动端不纳入')
  assert.equal(classify('GET', '/health', 'critical'), null)
  assert.equal(classify('GET', '/api/database-rescue/status', 'critical'), null, '救援面不纳入')
}

/** 第 21 项：会话令牌桶（突发、补充、有界淘汰）。 */
function verifySessionRateFusePrimitives() {
  const fuse = new m.SessionRateFuse({ capacity: 3, refillPerSecond: 1, maxSessions: 2 })
  const t0 = 1_000_000
  assert.ok(fuse.consume('a', t0).allowed && fuse.consume('a', t0).allowed && fuse.consume('a', t0).allowed)
  const denied = fuse.consume('a', t0)
  assert.equal(denied.allowed, false)
  assert.equal(denied.retryAfterSeconds, 1)
  assert.ok(fuse.consume('a', t0 + 1000).allowed, '1 秒后补充 1 个令牌')
  fuse.consume('b', t0)
  fuse.consume('c', t0)
  assert.equal(fuse.size, 2, '超出容量时淘汰最久未活动的会话（只会更宽松）')
}

/** 第 22 项：服务端超时与请求头数量、监听地址解析。 */
function verifyServerHardeningPrimitives() {
  const probe = http.createServer((_req, res) => res.end('ok'))
  m.applyHttpServerHardening(probe)
  assert.equal(probe.keepAliveTimeout, 65_000)
  assert.equal(probe.headersTimeout, 66_000)
  assert.ok(probe.headersTimeout > probe.keepAliveTimeout, 'headersTimeout 必须大于 keepAliveTimeout')
  assert.equal(probe.requestTimeout, 120_000)
  assert.equal(probe.maxHeadersCount, 100)
  assert.equal(m.HTTP_SERVER_TIMEOUTS.keepAliveTimeoutMs, 65_000)
  const previous = process.env.Y_LINK_LISTEN_HOST
  try {
    delete process.env.Y_LINK_LISTEN_HOST
    assert.equal(m.resolveListenHost(), '0.0.0.0', '默认监听全部网卡，兼容分体部署')
    process.env.Y_LINK_LISTEN_HOST = 'my-laptop.local'
    assert.throws(() => m.resolveListenHost(), /必须是 IP 地址/)
    process.env.Y_LINK_LISTEN_HOST = '127.0.0.1'
    assert.equal(m.resolveListenHost(), '127.0.0.1')
  } finally {
    if (previous === undefined) delete process.env.Y_LINK_LISTEN_HOST
    else process.env.Y_LINK_LISTEN_HOST = previous
  }
}

/** 第 25 项：短期票据按插入顺序增量清理、覆盖写入移到队尾、一次性读取。 */
function verifyTicketStorePrimitives() {
  type Ticket = { expiresAt: number; value: string }
  const store = new m.EphemeralTicketStore<Ticket>({ maxSize: 5, resolveExpiresAt: (ticket) => ticket.expiresAt })
  const now = Date.now() + 1_000_000
  store.set('a', { expiresAt: now + 100, value: 'a' })
  store.set('b', { expiresAt: now + 200, value: 'b' })
  store.set('c', { expiresAt: now + 300, value: 'c' })
  assert.equal(store.get('a', now + 150), undefined, '过期票据读取即失效')
  assert.equal(store.get('b', now + 150)?.value, 'b')
  store.set('b', { expiresAt: now + 1000, value: 'b2' })
  for (const key of ['d', 'e', 'f', 'g']) store.set(key, { expiresAt: now + 1000, value: key })
  assert.equal(store.get('b', now)?.value, 'b2', '覆盖写入的票据移到队尾，不会被当作最旧票据淘汰')
  assert.equal(store.get('c', now), undefined, '容量满时淘汰最早写入的票据')
  assert.equal(store.take('g', now)?.value, 'g')
  assert.equal(store.take('g', now), undefined, 'take 必须一次性')

  const big = new m.EphemeralTicketStore<Ticket>({ maxSize: 100_000, resolveExpiresAt: (ticket) => ticket.expiresAt })
  for (let index = 0; index < 10_000; index += 1) big.set(`k${index}`, { expiresAt: now + 10, value: String(index) })
  big.set('live', { expiresAt: now + 60_000, value: 'live' })
  assert.equal(big.sweepExpired(now + 100), 10_001 - 64, '单次最多清理 64 条')
  const startedAt = performance.now()
  for (let index = 0; index < 200; index += 1) big.get('live', now + 100)
  assert.ok(performance.now() - startedAt < 200, '读写摊销成本应为常数级')
  assert.equal(big.size(now + 100), 1, 'size 做完整清理后只剩有效票据')
}

/** 第 15、22 项的部署默认值：镜像扩容 libuv 线程池，onebox 后端只监听回环地址。 */
function verifyDeploymentDefaults() {
  const read = (relativePath: string) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
  for (const file of ['backend/Dockerfile', 'backend/Dockerfile.mysql']) {
    assert.match(read(file), /UV_THREADPOOL_SIZE=8/, `${file} 必须默认扩容 libuv 线程池`)
  }
  const entrypoint = read('docker/onebox/entrypoint.sh')
  assert.match(entrypoint, /export Y_LINK_LISTEN_HOST="\$\{Y_LINK_LISTEN_HOST:-127\.0\.0\.1\}"/, 'onebox 后端默认只监听回环地址，外部流量必须经过 Nginx')
  assert.match(entrypoint, /export UV_THREADPOOL_SIZE="\$\{UV_THREADPOOL_SIZE:-8\}"/)
}

// ---------------------------------------------------------------------------
// core：经真实 HTTP 与服务层
// ---------------------------------------------------------------------------

/** 第 1 项：接口默认 no-store，公开商城目录保留公开缓存语义（含 304 分支）。 */
async function verifyResponseCacheHeaders() {
  const health = await call('GET', '/health')
  assert.equal(health.headers.get('cache-control'), 'no-store', '/health 禁止缓存')
  const anonymousMe = await call('GET', '/api/auth/me')
  assert.equal(anonymousMe.status, 401)
  assert.equal(anonymousMe.headers.get('cache-control'), 'no-store', '错误响应同样禁止缓存')
  const session = await loginAdmin()
  const users = await call('GET', '/api/users?page=1&pageSize=10', { session })
  assert.equal(users.status, 200)
  assert.equal(users.headers.get('cache-control'), 'no-store', '业务数据禁止落入浏览器磁盘缓存')

  const products = await call('GET', '/api/o2o/mall/products')
  assert.equal(products.status, 200, products.text)
  assert.match(products.headers.get('cache-control') ?? '', /^public, max-age=2\b/, '公开商城目录保留公开缓存')
  const etag = products.headers.get('etag')
  assert.ok(etag, '公开商城目录应返回 ETag')
  const notModified = await call('GET', '/api/o2o/mall/products', { headers: { 'If-None-Match': etag } })
  assert.equal(notModified.status, 304)
  assert.match(notModified.headers.get('cache-control') ?? '', /^public, max-age=2\b/, '304 分支同样保留公开缓存头')
  const storefront = await call('GET', '/api/o2o/mall/storefront')
  assert.match(storefront.headers.get('cache-control') ?? '', /^public, max-age=5\b/)
}

/** 第 2 项：Fetch Metadata 资源隔离与去重审计。 */
async function verifyFetchMetadataIsolation() {
  const marker = await auditMarker()
  const blocked = async (method: string, pathname: string, headers: Record<string, string>, label: string, body?: unknown) => {
    const response = await call(method, pathname, { headers, body })
    assert.equal(response.status, 403, `${label}：${method} ${pathname} 应被拒绝`)
    assert.equal(response.body?.message, '跨站请求已被拒绝')
  }
  const passed = async (method: string, pathname: string, headers: Record<string, string>, label: string, body?: unknown) => {
    const response = await call(method, pathname, { headers, body })
    assert.notEqual(response.body?.message, '跨站请求已被拒绝', `${label} 不应被资源隔离策略拦截`)
    assert.ok(response.status < 500, `${label} 不应返回 5xx：${response.status}`)
  }
  await blocked('POST', '/api/auth/login', { 'Sec-Fetch-Site': 'cross-site' }, '跨站写请求', { username: 'admin', password: 'x' })
  await blocked('POST', '/api/auth/login', { 'Sec-Fetch-Site': 'cross-site' }, '重复的跨站写请求', { username: 'admin', password: 'x' })
  await blocked('GET', '/api/o2o/mall/products', { 'Sec-Fetch-Site': 'cross-site' }, '跨站读请求')
  await blocked('POST', '/api/auth/logout', { 'Sec-Fetch-Site': 'same-site' }, '兄弟子域写请求')
  await blocked('POST', '/api/client-auth/login', { Origin: 'http://evil.example' }, '无 Fetch Metadata 时 Origin 主机不一致', { account: 'x', password: 'y' })
  await blocked('POST', '/api/client-auth/register', { Origin: 'null' }, 'null 来源', {})
  await passed('GET', '/api/o2o/mall/products', { 'Sec-Fetch-Site': 'same-site' }, '兄弟子域读请求')
  await passed('POST', '/api/auth/login', { 'Sec-Fetch-Site': 'same-origin' }, '同源写请求', {})
  await passed('POST', '/api/auth/login', { 'Sec-Fetch-Site': 'none' }, '用户直接发起的请求', {})
  await passed('POST', '/api/auth/login', { Origin: baseUrl }, 'Origin 与主机一致', {})
  await passed('POST', '/api/auth/login', { Origin: 'http://127.0.0.1:1' }, 'Origin 只比对主机名（端口不同仍放行）', {})
  await passed('POST', '/api/auth/login', {}, '原生客户端（无 Fetch Metadata 与 Origin）', {})
  assert.equal((await call('GET', '/health', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 200, '非 /api 路径不受影响')

  const rows = await settledAuditRows(marker, ['security.cross_site_request_blocked'], 5)
  assert.equal(rows.length, 5, `同一来源与路由 10 分钟内只记一次审计：${rows.map((row) => row.targetCode).join(' | ')}`)
  const detailOf = (route: string) => {
    const row = rows.find((item) => item.targetCode === route)
    assert.ok(row, `缺少 ${route} 的跨站拦截审计`)
    return JSON.parse(row.detailJson ?? '{}') as { reason: string; secFetchSite: string | null; originHost: string | null }
  }
  assert.equal(detailOf('POST /api/auth/login').reason, 'cross_site')
  assert.equal(detailOf('POST /api/auth/login').secFetchSite, 'cross-site')
  assert.equal(detailOf('GET /api/o2o/mall/products').reason, 'cross_site')
  assert.equal(detailOf('POST /api/auth/logout').reason, 'same_site_unsafe_method')
  assert.deepEqual(detailOf('POST /api/client-auth/login'), { reason: 'origin_mismatch', secFetchSite: null, originHost: 'evil.example' })
  assert.equal(detailOf('POST /api/client-auth/register').reason, 'origin_mismatch')
}

/** 第 3 项：管理端 CSRF 令牌由会话派生（签名双提交），旧随机值自动换发。 */
async function verifyAdminCsrfBinding() {
  const session = await loginAdmin()
  assert.equal(session.csrf, m.deriveAdminCsrfToken(session.token), '登录下发的 CSRF 令牌必须由会话派生')
  const heartbeat = (cookieCsrf: string | null, headerCsrf: string | null) => call('POST', '/api/auth/presence/heartbeat', {
    headers: {
      Cookie: `y_link_admin_session=${encodeURIComponent(session.token)}${cookieCsrf ? `; y_link_admin_csrf=${encodeURIComponent(cookieCsrf)}` : ''}`,
      ...(headerCsrf ? { 'x-csrf-token': headerCsrf } : {}),
    },
  })
  assert.equal((await heartbeat(session.csrf, session.csrf)).status, 200, '派生值 Cookie + 请求头应放行')
  const legacy = 'legacy-random-token-value-1234567890'
  const mismatch = await heartbeat(legacy, legacy)
  assert.equal(mismatch.status, 403, '升级前的随机双提交值必须被拒绝')
  assert.equal(mismatch.body?.data?.reason, 'ADMIN_CSRF_MISMATCH')
  const missing = await heartbeat(session.csrf, null)
  assert.equal(missing.status, 403)
  assert.equal(missing.body?.data?.reason, 'ADMIN_CSRF_MISSING')
  const other = await loginAdmin()
  const borrowed = await heartbeat(other.csrf, other.csrf)
  assert.equal(borrowed.status, 403, '其他会话的派生令牌不能挪用')
  assert.equal(borrowed.body?.data?.reason, 'ADMIN_CSRF_MISMATCH')

  const reissue = await call('GET', '/api/auth/me', {
    headers: { Cookie: `y_link_admin_session=${encodeURIComponent(session.token)}; y_link_admin_csrf=${encodeURIComponent(legacy)}` },
  })
  assert.equal(reissue.status, 200)
  assert.equal(reissue.cookies.y_link_admin_csrf, session.csrf, '/auth/me 必须把旧随机值换发为派生值')
  const keep = await call('GET', '/api/auth/me', { headers: { Cookie: session.cookie } })
  assert.equal(keep.cookies.y_link_admin_csrf, undefined, '已是派生值时不重复下发')
}

const PROVIDER_SECRETS = ['SECRET-TOKEN-123', 'SECRET-HEADER-456', 'SECRET-BODY-789']
const FEISHU_WEBHOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/11111111-2222-3333-4444-555555555555'
const LEGACY_PLAINTEXTS = ['LEGACY-PLAIN-KEY', 'LEGACY-FEISHU-PLAIN']

/** 第 4 项：验证码网关与飞书密钥库内为密文、接口脱敏、发送时解密、存量补加密、密钥不匹配降级。 */
async function verifySensitiveConfigEncryption() {
  const session = await loginAdmin()
  const marker = await auditMarker()
  const providerPayload = {
    mobile: {
      enabled: true,
      httpMethod: 'POST',
      apiUrl: `https://sms.example.com/send?token=${PROVIDER_SECRETS[0]}`,
      headersTemplate: `{"Authorization":"Bearer ${PROVIDER_SECRETS[1]}","Content-Type":"application/json"}`,
      bodyTemplate: `{"to":"{{target}}","code":"{{code}}","key":"${PROVIDER_SECRETS[2]}"}`,
      successMatch: '',
      providerType: 'generic_http',
    },
    email: { enabled: false, httpMethod: 'POST', apiUrl: '', headersTemplate: '', bodyTemplate: '', successMatch: '' },
  }
  const saved = await call('PUT', '/api/system-configs/verification-providers', { session, body: providerPayload })
  assert.equal(saved.status, 200, saved.text)
  assert.ok(!saved.text.includes('SECRET-'), '保存响应必须脱敏')

  const readRaw = async (key: string) => (
    await m.AppDataSource.query('SELECT config_value AS value, updated_at AS updatedAt FROM system_configs WHERE config_key = ?', [key]) as Array<{ value: string; updatedAt: string }>
  )[0]
  for (const field of ['api_url', 'headers_template', 'body_template']) {
    const row = await readRaw(`verification.mobile.${field}`)
    assert.ok(row.value.startsWith('ylenc:v1:'), `${field} 库内必须是密文`)
    assert.ok(!row.value.includes('SECRET'), `${field} 库内不得出现明文`)
  }
  const plain = await m.systemConfigService.getVerificationProviderConfigs({ maskSensitiveValues: false })
  assert.equal(plain.mobile.apiUrl, providerPayload.mobile.apiUrl, '发送时读取到的是解密后的原值')
  assert.equal(plain.mobile.headersTemplate, providerPayload.mobile.headersTemplate)
  assert.equal(plain.mobile.ready, true)

  const view = await call('GET', '/api/system-configs/verification-providers', { session })
  assert.ok(!view.text.includes('SECRET-'), '查询接口必须脱敏')
  const viewMobile = (view.body?.data as { mobile: Record<string, string> }).mobile
  const keepMasked = {
    ...providerPayload,
    mobile: { ...providerPayload.mobile, apiUrl: viewMobile.apiUrl, headersTemplate: viewMobile.headersTemplate, bodyTemplate: viewMobile.bodyTemplate },
  }
  const resaved = await call('PUT', '/api/system-configs/verification-providers', { session, body: keepMasked })
  assert.equal(resaved.status, 200, resaved.text)
  const afterMaskedSave = await m.systemConfigService.getVerificationProviderConfigs({ maskSensitiveValues: false })
  assert.equal(afterMaskedSave.mobile.bodyTemplate, providerPayload.mobile.bodyTemplate, '用脱敏占位保存必须保留原值')

  // 模拟升级前的历史明文：补加密后可读、不刷新 updated_at，且幂等。
  await m.AppDataSource.query('UPDATE system_configs SET config_value = ? WHERE config_key = ?', [`https://mail.example.com/legacy?key=${LEGACY_PLAINTEXTS[0]}`, 'verification.email.api_url'])
  const beforeSeal = await readRaw('verification.email.api_url')
  assert.equal(await m.systemConfigService.sealLegacySensitiveVerificationConfigs(), 1)
  const afterSeal = await readRaw('verification.email.api_url')
  assert.ok(afterSeal.value.startsWith('ylenc:v1:'))
  assert.equal(String(afterSeal.updatedAt), String(beforeSeal.updatedAt), '补加密不得刷新 updated_at')
  assert.equal(await m.systemConfigService.sealLegacySensitiveVerificationConfigs(), 0, '补加密必须幂等')

  const rules = await call('GET', '/api/notifications/rules', { session })
  const ruleList = (rules.body?.data as { list: Array<Record<string, unknown>> }).list
  const targetRule = ruleList.find((item) => !String(item.id).startsWith('default:')) ?? ruleList[0]
  const rulePayload = {
    offlineWindowSeconds: 120,
    rules: [{
      id: targetRule.id,
      enabled: true,
      recipientUserIds: [],
      emailRecipientAdminUserIds: [],
      emailRecipientSupplierUserIds: [],
      emailEnabled: false,
      feishuEnabled: true,
      externalTriggerMode: 'all_management_offline',
      watchedUserIds: [],
      feishuWebhookUrl: FEISHU_WEBHOOK,
      feishuSignSecret: 'FEISHU-SIGN-SECRET-abc',
      emailSubjectPrefix: '[Y-Link]',
    }],
  }
  const savedRule = await call('PUT', '/api/notifications/rules', { session, body: rulePayload })
  assert.equal(savedRule.status, 200, savedRule.text)
  assert.ok(!savedRule.text.includes('FEISHU-SIGN-SECRET') && !savedRule.text.includes('11111111-2222'), '规则响应必须脱敏')
  const rawRule = (await m.AppDataSource.query('SELECT feishu_webhook_url AS webhook, feishu_sign_secret AS secret FROM notification_rule WHERE id = ?', [targetRule.id]) as Array<{ webhook: string; secret: string }>)[0]
  assert.ok(rawRule.webhook.startsWith('ylenc:v1:') && rawRule.secret.startsWith('ylenc:v1:'), '飞书配置库内必须是密文')
  const ruleRepo = m.AppDataSource.getRepository(m.NotificationRule)
  const readRawRuleSecrets = async (ruleId: unknown) => (
    await m.AppDataSource.query('SELECT feishu_webhook_url AS webhook, feishu_sign_secret AS secret FROM notification_rule WHERE id = ?', [ruleId]) as Array<{ webhook: string; secret: string }>
  )[0]
  const entity = await ruleRepo.findOneByOrFail({ id: String(targetRule.id) })
  assert.equal(entity.feishuWebhookUrl, FEISHU_WEBHOOK)
  assert.equal(entity.feishuSignSecret, 'FEISHU-SIGN-SECRET-abc')

  await m.AppDataSource.query('UPDATE notification_rule SET feishu_sign_secret = ? WHERE id = ?', [LEGACY_PLAINTEXTS[1], targetRule.id])
  assert.equal(await m.notificationService.sealLegacyFeishuSecrets(), 1)
  assert.equal((await ruleRepo.findOneByOrFail({ id: String(targetRule.id) })).feishuSignSecret, LEGACY_PLAINTEXTS[1])

  // 密钥更换或丢失：按“需重新录入”降级，不抛错也不影响启动。
  process.env.Y_LINK_DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
  m.encryption.resetDataEncryptionKeyCacheForTesting()
  try {
    const degraded = await m.systemConfigService.getVerificationProviderConfigs({ maskSensitiveValues: false })
    assert.equal(degraded.mobile.ready, false)
    assert.match(degraded.mobile.statusError ?? '', /无法解密/)
    assert.equal((await ruleRepo.findOneByOrFail({ id: String(targetRule.id) })).feishuWebhookUrl, '', '无法解密的飞书地址按未配置处理')

    // 密钥异常期间保存其它字段：未重新填写的飞书密文与验证码网关密文必须原样保留，不能被读出的空值覆盖。
    const rawRuleBefore = await readRawRuleSecrets(targetRule.id)
    const unrelatedSave = await call('PUT', '/api/notifications/rules', {
      session,
      body: { ...rulePayload, rules: [{ ...rulePayload.rules[0], feishuEnabled: false, feishuWebhookUrl: '', feishuSignSecret: '', emailSubjectPrefix: '[Y-Link-密钥异常]' }] },
    })
    assert.equal(unrelatedSave.status, 200, unrelatedSave.text)
    assert.deepEqual(await readRawRuleSecrets(targetRule.id), rawRuleBefore, '无法解密的飞书密文未重录时保留原密文')
    const enableWithoutWebhook = await call('PUT', '/api/notifications/rules', {
      session,
      body: { ...rulePayload, rules: [{ ...rulePayload.rules[0], feishuWebhookUrl: '', feishuSignSecret: '' }] },
    })
    assert.equal(enableWithoutWebhook.status, 409, '启用飞书但 Webhook 无法解密且未重录时明确拒绝')

    const sensitiveKeys = ['verification.mobile.api_url', 'verification.mobile.headers_template', 'verification.mobile.body_template', 'verification.email.api_url']
    const rawProvidersBefore = await Promise.all(sensitiveKeys.map(async (key) => (await readRaw(key)).value))
    const emptyChannel = { enabled: false, httpMethod: 'POST', apiUrl: '', headersTemplate: '', bodyTemplate: '', successMatch: '' }
    const providerSave = await call('PUT', '/api/system-configs/verification-providers', {
      session,
      body: { mobile: { ...emptyChannel, providerType: 'generic_http' }, email: emptyChannel },
    })
    assert.equal(providerSave.status, 200, providerSave.text)
    assert.deepEqual(await Promise.all(sensitiveKeys.map(async (key) => (await readRaw(key)).value)), rawProvidersBefore, '无法解密的验证码网关密文未重录也未显式清空时保留原密文')
  } finally {
    delete process.env.Y_LINK_DATA_ENCRYPTION_KEY
    m.encryption.resetDataEncryptionKeyCacheForTesting()
  }
  // 上一步为模拟“只改无关字段”关闭了短信通道与飞书外发，这里恢复，便于后续断言。
  await m.AppDataSource.query("UPDATE system_configs SET config_value = '1' WHERE config_key = 'verification.mobile.enabled'")
  // 前端对未修改的签名密钥回传占位符、Webhook 回传空串，服务端据此保留库内原值。
  const restoredRule = await call('PUT', '/api/notifications/rules', {
    session,
    body: { ...rulePayload, rules: [{ ...rulePayload.rules[0], feishuWebhookUrl: '', feishuSignSecret: m.FEISHU_SIGN_SECRET_PLACEHOLDER }] },
  })
  assert.equal(restoredRule.status, 200, restoredRule.text)
  const restoredEntity = await ruleRepo.findOneByOrFail({ id: String(targetRule.id) })
  assert.equal(restoredEntity.feishuWebhookUrl, FEISHU_WEBHOOK, '恢复原密钥后保留下来的飞书 Webhook 可继续使用')
  assert.equal(restoredEntity.feishuSignSecret, LEGACY_PLAINTEXTS[1])
  const restoredProviders = await m.systemConfigService.getVerificationProviderConfigs({ maskSensitiveValues: false })
  assert.equal(restoredProviders.mobile.apiUrl, providerPayload.mobile.apiUrl, '恢复原密钥后保留下来的网关配置可继续使用')
  assert.equal(restoredProviders.mobile.ready, true, '恢复原密钥后正常解密')

  const tooLong = await call('PUT', '/api/notifications/rules', {
    session,
    body: { ...rulePayload, rules: [{ ...rulePayload.rules[0], feishuSignSecret: 'x'.repeat(129) }] },
  })
  assert.equal(tooLong.status, 400, '明文长度上限保证密文不超过列宽')

  const auditText = JSON.stringify(await auditRowsSince(marker))
  for (const secret of [...PROVIDER_SECRETS, 'FEISHU-SIGN-SECRET-abc', '11111111-2222-3333-4444-555555555555']) {
    assert.ok(!auditText.includes(secret), `审计中不得出现敏感配置明文：${secret}`)
  }
}

/** 第 5 项：JSON 全量导出导入默认关闭；开启后导出改 POST、本人密码复核与登录共用锁定，并按账号限频。 */
async function verifyJsonDataTransferGate() {
  const session = await loginAdmin()
  const marker = await auditMarker()
  const mutableEnv = m.env as { Y_LINK_JSON_DATA_TRANSFER_ENABLED: boolean }
  const exportJson = (body: unknown) => call('POST', '/api/data-maintenance/export/json', { session, body })

  assert.equal((await call('GET', '/api/data-maintenance/export/json', { session })).status, 404, '旧的 GET 导出入口必须下线')
  assert.equal((await exportJson({ currentPassword: ADMIN_PASSWORD })).status, 403, 'JSON 全量导出默认关闭')
  assert.equal((await call('POST', '/api/data-maintenance/import/json', { session, body: {} })).status, 403, 'JSON 全量导入默认关闭')

  mutableEnv.Y_LINK_JSON_DATA_TRANSFER_ENABLED = true
  try {
    assert.equal((await exportJson({})).status, 400, '必须提交本人当前密码')
    const wrong = await exportJson({ currentPassword: 'Wrong-Password-1' })
    assert.equal(wrong.status, 400, '密码错误返回 400 而非 401，避免前端误判为登录失效')
    const exported = await exportJson({ currentPassword: ADMIN_PASSWORD })
    assert.equal(exported.status, 200, exported.text.slice(0, 300))
    assert.ok(Array.isArray((exported.body?.data as { tables: Record<string, unknown> }).tables.systemConfigs))
    assert.equal(exported.headers.get('cache-control'), 'no-store')
    for (const secret of [...PROVIDER_SECRETS, ...LEGACY_PLAINTEXTS, '11111111-2222-3333-4444-555555555555']) {
      assert.ok(!exported.text.includes(secret), `导出文件中的密钥类配置必须保持密文：${secret}`)
    }

    const audits = await auditRowsSince(marker, ['data_maintenance.export_json', 'data_maintenance.import_json', 'auth.step_up'])
    assert.deepEqual(audits.map((row) => `${row.actionType}:${row.resultStatus}`), [
      'data_maintenance.export_json:failed',
      'data_maintenance.import_json:failed',
      'auth.step_up:failed',
      'data_maintenance.export_json:success',
    ])

    for (let attempt = 2; attempt <= 5; attempt += 1) {
      await exportJson({ currentPassword: `Wrong-Password-${attempt}` })
    }
    const locked = await exportJson({ currentPassword: ADMIN_PASSWORD })
    assert.equal(locked.status, 429, '密码复核失败与登录共用账号锁定')
    await exportJson({ currentPassword: ADMIN_PASSWORD })
    const throttled = await exportJson({ currentPassword: ADMIN_PASSWORD })
    assert.equal(throttled.status, 429)
    assert.match(throttled.body?.message ?? '', /JSON 导出请求过于频繁/, '导出按账号 10 分钟 10 次限频')
    const auditText = JSON.stringify(await auditRowsSince(marker))
    assert.ok(!auditText.includes('Wrong-Password') && !auditText.includes(ADMIN_PASSWORD), '审计不得出现密码')
  } finally {
    mutableEnv.Y_LINK_JSON_DATA_TRANSFER_ENABLED = false
    await resetRiskState()
  }
}

/** 第 6 项：审计 CSV 流式导出与一次性导出一致、导出留痕、导出租约、分批游标与行数上限。 */
async function verifyExportGovernance() {
  const session = await loginAdmin()
  const adminId = (await contextOf('admin')).userId
  const marker = await auditMarker()
  const readCsv = async (query: string) => {
    const response = await fetch(`${baseUrl}/api/audit-logs/export${query}`, { headers: { Cookie: session.cookie } })
    const bytes = new Uint8Array(await response.arrayBuffer())
    return { response, bytes, text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes) }
  }

  const auth = await readCsv('?category=auth')
  assert.equal(auth.response.status, 200)
  assert.match(auth.response.headers.get('content-type') ?? '', /text\/csv/)
  assert.deepEqual([...auth.bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'CSV 必须带 UTF-8 BOM')
  const authLines = auth.text.slice(1).split('\n')
  assert.ok(authLines[0].includes('时间') && authLines[0].includes('动作编码'), authLines[0])
  assert.ok(authLines.some((line) => line.includes('auth.login')), '应包含登录审计')
  assert.equal(await m.auditService.exportCsv({ category: 'auth' }), auth.text.slice(1), '流式导出与一次性导出内容必须一致')

  for (const pathname of ['/api/products/export', '/api/inventory/logs/export', '/api/reports/inventory/export']) {
    const response = await fetch(`${baseUrl}${pathname}`, { headers: { Cookie: session.cookie } })
    assert.equal(response.status, 200, `${pathname} 导出失败（SQLite 数字账号 ID 下也必须成功）`)
    await response.arrayBuffer()
  }
  const exportRows = await settledAuditRows(marker, ['data_export.audit_logs', 'data_export.products', 'data_export.inventory_logs', 'data_export.report'], 4)
  assert.deepEqual(exportRows.map((row) => row.actionType).sort(), ['data_export.audit_logs', 'data_export.inventory_logs', 'data_export.products', 'data_export.report'])
  const auditExport = JSON.parse(exportRows.find((row) => row.actionType === 'data_export.audit_logs')!.detailJson!) as { rowCount: number; filters: { category: string } }
  assert.equal(auditExport.filters.category, 'auth', '导出留痕记录筛选条件')
  assert.equal(auditExport.rowCount, authLines.length - 1, '导出留痕记录行数')
  const productExport = JSON.parse(exportRows.find((row) => row.actionType === 'data_export.products')!.detailJson!) as { filters: { includeCostPrice: boolean } }
  assert.equal(productExport.filters.includeCostPrice, true)

  // 导出租约：同一账号已有导出进行中时，审计与商品导出都立即 429。
  const lease = m.dataExportLeasePool.acquire(String(adminId))
  try {
    const busyAudit = await call('GET', '/api/audit-logs/export?category=auth', { session })
    assert.equal(busyAudit.status, 429)
    assert.match(busyAudit.body?.message ?? '', /已有导出任务/)
    assert.equal((await call('GET', '/api/products/export', { session })).status, 429, '商品导出共用同一租约池')
  } finally {
    lease.release()
  }

  // 分批游标：超过单批 1000 行时按 id 游标续读，结果与一次性导出一致。
  const insertBulkRows = (count: number) => m.AppDataSource.query(
    `INSERT INTO sys_audit_log (action_type, action_label, target_type, target_code, result_status, created_at)
     WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?)
     SELECT 'verify.bulk_export', '导出上限回归', 'verify_bulk', 'bulk-' || n, 'success', datetime('now') FROM seq`,
    [count],
  )
  await insertBulkRows(2345)
  const bulk = await readCsv('?targetType=verify_bulk')
  assert.equal(bulk.response.status, 200)
  assert.equal(bulk.text.slice(1).split('\n').length - 1, 2345, '多批次流式导出不得漏行或重复')
  assert.equal(await m.auditService.exportCsv({ targetType: 'verify_bulk' }), bulk.text.slice(1))

  // 行数上限：超过 20 万行先计数拒绝，返回 JSON 错误而不是半截文件。
  await insertBulkRows(200_001 - 2345)
  const exportsBeforeCap = (await auditRowsSince(marker, ['data_export.audit_logs'])).length
  const capped = await call('GET', '/api/audit-logs/export?targetType=verify_bulk', { session })
  assert.equal(capped.status, 400)
  assert.match(capped.body?.message ?? '', /导出结果 200001 条，超过 200000 条上限/)
  await sleep(200)
  assert.equal((await auditRowsSince(marker, ['data_export.audit_logs'])).length, exportsBeforeCap, '被拒绝的导出不写导出留痕')
  await m.AppDataSource.query("DELETE FROM sys_audit_log WHERE target_type = 'verify_bulk'")
  assert.equal((await call('GET', '/api/audit-logs/export?category=auth', { session })).status, 200, '被拒绝后租约已归还')

  // 背压等待期间客户端断开：响应流只发 close 不再发 drain，导出必须立即失败而不是永久挂起。
  const stalled = new Writable({ highWaterMark: 1, write: () => { /* 模拟客户端不再读取，永不回调 */ } })
  const stalledExport = m.auditService.exportCsvToStream({ category: 'auth' }, stalled)
  await sleep(50)
  stalled.destroy()
  await assert.rejects(
    Promise.race([stalledExport, sleep(3000).then(() => { throw new Error('导出在连接关闭后仍在等待 drain') })]),
    /下载连接已关闭/,
  )
}

/** 第 7 项：账号不存在与频控/锁定审计只记录掩码与指纹。 */
async function verifyAuditSubjectMasking() {
  await resetRiskState()
  const marker = await auditMarker()
  const secret = 'MySecretPassw0rd!'
  assert.equal((await call('POST', '/api/auth/login', { body: { username: secret, password: 'whatever-1' } })).status, 401)
  // 首次失败后本机来源即需图形验证码，HTTP 无法继续累计失败；锁定路径直接调用服务层验证审计口径。
  const meta = requestMetaOf('10.9.8.7')
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await m.authSecurityService.recordAdminLoginFailure(meta, secret, { subjectResolved: false })
  }
  await assert.rejects(
    () => m.authSecurityService.guardAdminLoginRequest(meta, secret, async () => ({ subject: secret, resolved: false })),
    /已临时锁定/,
  )
  assert.equal((await call('POST', '/api/client-auth/login', { body: { account: '13912345678', password: 'whatever-1' } })).status, 401)

  const rows = await settledAuditRows(marker, ['auth.login', 'auth.guard.lock', 'auth.guard.locked', 'client.auth.login'], 4)
  const allText = JSON.stringify(await auditRowsSince(marker)).toLowerCase()
  assert.ok(!allText.includes(secret.toLowerCase()), '审计中不得出现误填到账号框的密码原文')
  assert.ok(!allText.includes('13912345678'), '审计中不得出现他人完整手机号')
  const masked = new Set([m.maskLoginInputForAudit(secret), m.maskLoginInputForAudit(secret.toLowerCase())])
  const maskedActions = rows.filter((row) => row.targetCode && masked.has(row.targetCode)).map((row) => row.actionType)
  for (const actionType of ['auth.login', 'auth.guard.lock', 'auth.guard.locked']) {
    assert.ok(maskedActions.includes(actionType), `${actionType} 应记录掩码：${JSON.stringify(rows)}`)
  }
  assert.ok(rows.some((row) => row.actionType === 'client.auth.login' && row.targetCode === m.maskLoginInputForAudit('13912345678')), '客户端账号不存在审计应记录掩码')
  await resetRiskState()
}

/** 第 9 项：旧格式哈希登录后透明升级；升级失败（如闸门满载）不影响本次登录。 */
async function verifyTransparentRehash() {
  const adminSalt = randomBytes(16).toString('hex')
  const legacyAdminHash = legacyHashOf(ADMIN_PASSWORD, adminSalt)
  await m.AppDataSource.query("UPDATE sys_user SET password_hash = ? WHERE username = 'admin'", [legacyAdminHash])
  const failUpgrade = (salt: string) => (
    salt !== adminSalt && salt !== 'y-link-legacy-scrypt-timing-pad' ? new Error('注入的派生失败') : null
  )
  await withScryptProbe(failUpgrade, async () => {
    await loginAdmin()
  })
  assert.equal(await readSysUserHash((await contextOf('admin')).userId), legacyAdminHash, '升级失败时保持旧哈希，登录照常成功')

  await loginAdmin()
  assert.match(await readSysUserHash((await contextOf('admin')).userId), /^s2\$/, '管理端旧哈希登录后应升级为新格式')
  const loginAudit = (await m.AppDataSource.query("SELECT detail_json AS detail FROM sys_audit_log WHERE action_type = 'auth.login' AND result_status = 'success' ORDER BY id DESC LIMIT 1") as Array<{ detail: string }>)[0]
  assert.equal((JSON.parse(loginAudit.detail) as { passwordHashUpgraded?: boolean }).passwordHashUpgraded, true)
  await loginAdmin()

  const clientRepo = m.AppDataSource.getRepository(m.ClientUser)
  const client = await clientRepo.save(clientRepo.create({
    mobile: '13700000001',
    mobileVerifiedAt: new Date(),
    realName: '升级验证',
    passwordHash: legacyHashOf('ClientPass9x'),
    accountType: 'personal',
    status: 'enabled',
  }))
  await resetRiskState()
  const clientLogin = await call('POST', '/api/client-auth/login', { body: { account: '13700000001', password: 'ClientPass9x' } })
  assert.equal(clientLogin.status, 200, clientLogin.text)
  assert.match(await readClientUserHash(client.id), /^s2\$/, '客户端旧哈希登录后应升级为新格式')
}

/** 第 10 项：改密、建号、重置入口执行弱口令与账号信息规则。 */
async function verifyPasswordPolicyEndpoints() {
  const session = await loginAdmin()
  const weakChange = await call('POST', '/api/auth/change-password', { session, body: { currentPassword: ADMIN_PASSWORD, newPassword: 'Qwerty123456' } })
  assert.equal(weakChange.status, 400)
  assert.match(weakChange.body?.message ?? '', /常见弱口令/)
  const withUsername = await call('POST', '/api/users', { session, body: { username: 'opuser9', password: 'Opuser9Pass1x', displayName: '操作员九', role: 'operator', status: 'enabled' } })
  assert.equal(withUsername.status, 400)
  assert.match(withUsername.body?.message ?? '', /账号信息/)
  const created = await call('POST', '/api/users', { session, body: { username: 'opuser9', password: 'Tq7mZ2vR9pLm', displayName: '操作员九', role: 'operator', status: 'enabled' } })
  assert.equal(created.status, 200, created.text)
  const createdId = (created.body?.data as { id: string | number }).id
  const resetWithUsername = await call('POST', `/api/users/${createdId}/reset-password`, { session, body: { newPassword: 'OPUSER9-new-2026' } })
  assert.equal(resetWithUsername.status, 400, '重置他人密码同样不得包含目标账号')
  const tooLong = await call('POST', `/api/users/${createdId}/reset-password`, { session, body: { newPassword: `Ab1${'x'.repeat(62)}` } })
  assert.equal(tooLong.status, 400, '新密码最长 64 位')
}

/** 第 12 项：服务层风控按 /64 与 IPv4 映射地址聚合来源。 */
async function verifyRiskSourceAggregation() {
  await resetRiskState()
  await m.authSecurityService.recordAdminLoginFailure(requestMetaOf('2001:db8:aa:bb::1'), 'ghost-a', { subjectResolved: false })
  assert.equal((await m.authSecurityService.guardAdminLoginRequest(requestMetaOf('2001:db8:aa:bb:dead:beef:0:9'), 'ghost-b')).captchaRequired, true, '同一 /64 轮换地址共用来源计数')
  assert.equal((await m.authSecurityService.guardAdminLoginRequest(requestMetaOf('2001:db8:aa:bc::1'), 'ghost-c')).captchaRequired, false, '相邻 /64 不受影响')
  await m.authSecurityService.recordAdminLoginFailure(requestMetaOf('::ffff:198.51.100.7'), 'ghost-d', { subjectResolved: false })
  assert.equal((await m.authSecurityService.guardAdminLoginRequest(requestMetaOf('198.51.100.7'), 'ghost-e')).captchaRequired, true, 'IPv4 映射地址与 IPv4 共用来源计数')
  await resetRiskState()
}

/** 第 13 项：认证入参长度上限（兼容历史长口令）。 */
async function verifyAuthInputLimits() {
  await resetRiskState()
  const post = (pathname: string, body: unknown) => call('POST', pathname, { body })
  const longAccount = 'a'.repeat(129)
  const adminLong = await post('/api/auth/login', { username: longAccount, password: 'x' })
  assert.equal(adminLong.status, 400)
  assert.match(adminLong.body?.message ?? '', /账号长度不能超过 128/)
  const adminLongPassword = await post('/api/auth/login', { username: 'admin', password: 'p'.repeat(257) })
  assert.equal(adminLongPassword.status, 400)
  assert.match(adminLongPassword.body?.message ?? '', /密码长度不能超过 256/)
  assert.equal((await post('/api/auth/login', { username: 'admin', password: 'x', captchaId: 'c'.repeat(65), captchaCode: '1234' })).status, 400)
  const clientLong = await post('/api/client-auth/login', { account: longAccount, password: 'x' })
  assert.equal(clientLong.status, 400)
  assert.match(clientLong.body?.message ?? '', /账号长度不能超过 128/)
  assert.equal((await post('/api/client-auth/login', { account: 'nobody-here', password: 'p'.repeat(200) })).status, 401, '200 位历史口令仍可进入登录校验')
  assert.equal((await post('/api/client-auth/forgot-password/verify', { account: longAccount })).status, 400)
  assert.equal((await post('/api/client-auth/forgot-password/reset', { account: 'x', resetToken: 't'.repeat(257), newPassword: 'Tq7mZ2vR9pLm' })).status, 400)
  const sendLong = await post('/api/client-auth/verification-code/send', { channel: 'mobile', target: '1'.repeat(129), scene: 'register', captchaId: 'id', captchaCode: '1234' })
  assert.equal(sendLong.status, 400)
  assert.match(sendLong.body?.message ?? '', /手机号或邮箱长度不能超过 128/)
  await resetRiskState()
}

/** 第 17 项：新密码派生在数据库事务外完成；本人改密的旧密码按契约在事务内持锁校验。 */
async function verifyHashOutsideTransactions() {
  const adminAuth = await contextOf('admin')
  await withScryptProbe(() => null, async (calls) => {
    await m.AppDataSource.transaction(async () => {
      await m.password.hashPassword('Probe-Positive#2026')
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].inTransaction, true, '探针必须能识别事务内的派生（阳性对照）')
    calls.length = 0

    const operator = await m.userService.create({ username: 'tx-operator', password: 'Tq7mZ2vR9pLm-a', displayName: '事务外派生', role: 'operator', status: 'enabled' }, adminAuth)
    await m.userService.update(operator.id, { password: 'Tq7mZ2vR9pLm-b' }, adminAuth)
    await m.userService.resetPassword(operator.id, { newPassword: 'Tq7mZ2vR9pLm-c' }, adminAuth)
    assert.ok(calls.length >= 3)
    assert.deepEqual(calls.filter((item) => item.inTransaction), [], '管理端建号、编辑改密、重置密码的新密码派生必须在事务外')

    calls.length = 0
    const client = await m.clientUserManageService.createProfile({
      profileKind: 'personal',
      username: '事务外客户',
      mobile: '13900001111',
      email: null,
      password: 'Cli9-Tx#Check2026',
      status: 'enabled',
      departmentName: undefined,
      staffNo: undefined,
    } as never, adminAuth)
    await m.clientUserManageService.resetPassword(String(client.id), { newPassword: 'Cli9-Tx#Reset2026' }, adminAuth)
    assert.ok(calls.length >= 2)
    assert.deepEqual(calls.filter((item) => item.inTransaction), [], '管理员建档与重置客户端密码的派生必须在事务外')

    const assertChangeSplit = (storedHash: string, label: string) => {
      const storedSalt = storedHash.split('$')[4]
      const derivations = calls.filter((item) => item.salt !== storedSalt)
      const verifications = calls.filter((item) => item.salt === storedSalt)
      assert.equal(derivations.length, 1, `${label}只派生一次新密码`)
      assert.equal(derivations[0].inTransaction, false, `${label}的新密码派生必须在事务外`)
      assert.equal(verifications.length, 1, `${label}只校验一次旧密码`)
      assert.equal(verifications[0].inTransaction, true, `${label}的旧密码按契约在事务内锁定账号后校验`)
    }
    const operatorHash = await readSysUserHash(operator.id)
    calls.length = 0
    await m.authService.changeOwnPassword(await contextOf('tx-operator'), { currentPassword: 'Tq7mZ2vR9pLm-c', newPassword: 'Tq7mZ2vR9pLm-d' })
    assertChangeSplit(operatorHash, '管理端本人改密')

    const clientHash = await readClientUserHash(client.id)
    const clientAuth: ClientAuthContext = {
      userId: String(client.id),
      account: '',
      mobile: '13900001111',
      email: '',
      realName: '事务外客户',
      accountType: 'personal',
      staffNo: null,
      sessionToken: 'verify-client-session',
      authSource: 'bearer',
    }
    calls.length = 0
    await m.clientAuthService.changePassword(clientAuth, { currentPassword: 'Cli9-Tx#Reset2026', newPassword: 'Cli9-Tx#Mine2026' })
    assertChangeSplit(clientHash, '客户端 Web 改密')
  })
  assert.ok(await m.password.verifyPassword('Tq7mZ2vR9pLm-d', await readSysUserHash((await contextOf('tx-operator')).userId)))
}

/** 第 18 项：风控负缓存（超限与锁定期内不读写数据库）与拒绝审计去重。 */
async function verifyRiskNegativeCache() {
  await resetRiskState()
  const service = m.persistentRiskStateService
  const riskRepo = m.AppDataSource.getRepository(m.AuthRiskState)
  const now = Date.now()
  assert.equal((await service.consumeWindow('verify:window-a', 60_000, now, 2)).totalHits, 1)
  assert.equal((await service.consumeWindow('verify:window-a', 60_000, now, 2)).totalHits, 2)
  const denied = await service.consumeWindow('verify:window-a', 60_000, now, 2)
  assert.equal(denied.totalHits, 3)
  assert.equal(denied.deniedFromCache, undefined, '首次超限走库判定')
  await riskRepo.clear()
  const cached = await service.consumeWindow('verify:window-a', 60_000, now + 10, 2)
  assert.equal(cached.deniedFromCache, true, '超限期内直接由负缓存拒绝')
  assert.equal(await riskRepo.count(), 0, '负缓存拒绝不写数据库')
  assert.equal((await service.consumeWindow('verify:window-a', 60_000, now + 60_001, 2)).totalHits, 1, '结论到期后恢复走库计数')
  await service.consumeWindow('verify:window-b', 60_000, now, 1)
  assert.equal((await service.consumeWindow('verify:window-b', 60_000, now, 1)).totalHits, 2)
  await service.resetWindow('verify:window-b')
  assert.equal((await service.consumeWindow('verify:window-b', 60_000, now, 1)).totalHits, 1, '重置后负缓存同步失效')

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await service.recordFailure('verify:lock', 15 * 60_000, 5, 15 * 60_000, now)
  }
  await riskRepo.clear()
  const lockState = await service.readFailure('verify:lock', 15 * 60_000, now + 1000)
  assert.ok(lockState && lockState.lockedUntil > now, '锁定期内由负缓存返回锁定状态')
  await service.resetFailure('verify:lock')
  assert.equal(await service.readFailure('verify:lock', 15 * 60_000, now + 1000), null)

  const marker = await auditMarker()
  let limited = 0
  for (let index = 0; index < 20; index += 1) {
    try {
      await m.authSecurityService.guardAdminLoginRequest(requestMetaOf('198.51.100.44'), `flood-${index}`)
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 429) limited += 1
    }
  }
  assert.equal(limited, 8, '管理端每 IP 5 分钟 12 次，其余 8 次被拒')
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await m.authSecurityService.recordAdminLoginFailure(requestMetaOf('198.51.100.45'), 'locked-user')
  }
  for (let index = 0; index < 5; index += 1) {
    await assert.rejects(
      m.authSecurityService.guardAdminLoginRequest(requestMetaOf(`198.51.100.${60 + index}`), 'locked-user'),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 429,
    )
  }
  const rows = await settledAuditRows(marker, ['auth.guard.admin_login', 'auth.guard.locked'], 2)
  assert.equal(rows.filter((row) => row.actionType === 'auth.guard.admin_login').length, 1, '频控拒绝只记首次')
  assert.equal(rows.filter((row) => row.actionType === 'auth.guard.locked').length, 1, '锁定拒绝同一主体每分钟只记一次')
  assert.ok(service.negativeCacheSnapshot().failureLocks >= 1)
  await resetRiskState()
}

/** 第 20 项：过载时按等级削峰，已登录写请求与健康检查不受影响。 */
async function verifyOverloadShedding() {
  const session = await loginAdmin()
  const monitor = m.overloadMonitor
  const feed = (loopDelayMs: number, times: number) => {
    for (let index = 0; index < times; index += 1) monitor.evaluate({ eventLoopDelayP99Ms: loopDelayMs, writeQueueOccupancy: null })
  }
  const before = { ...monitor.snapshot().shedCounts }
  try {
    feed(700, 3)
    assert.equal(monitor.getLevel(), 'elevated')
    const anonymousLogin = await call('POST', '/api/auth/login', { body: { username: 'admin', password: 'x' } })
    assert.equal(anonymousLogin.status, 503)
    assert.equal(anonymousLogin.headers.get('retry-after'), '5')
    assert.equal(anonymousLogin.body?.data?.reason, 'SERVER_OVERLOADED')
    assert.equal((await call('GET', '/api/client-auth/captcha')).status, 503)
    assert.equal((await call('GET', '/api/audit-logs/export', { session })).status, 503)
    assert.equal((await call('GET', '/api/customer-service/stream', { session })).status, 503)
    assert.equal((await call('GET', '/api/users?page=1&pageSize=10', { session })).status, 200, 'elevated 不拒绝已登录读请求')
    assert.equal((await call('POST', '/api/auth/presence/heartbeat', { session })).status, 200)
    assert.equal((await call('GET', '/health')).status, 200)

    feed(1500, 3)
    assert.equal(monitor.getLevel(), 'critical')
    assert.equal((await call('GET', '/api/users?page=1&pageSize=10', { session })).status, 503, 'critical 拒绝已登录读请求')
    assert.equal((await call('GET', '/api/auth/me', { session })).status, 200, 'critical 保留 /auth/me')
    assert.equal((await call('POST', '/api/auth/presence/heartbeat', { session })).status, 200, '写请求永不削峰')
    assert.equal((await call('GET', '/health')).status, 200)
  } finally {
    feed(100, 5)
    feed(100, 5)
  }
  assert.equal(monitor.getLevel(), 'normal')
  assert.equal((await call('GET', '/api/users?page=1&pageSize=10', { session })).status, 200)
  const after = monitor.snapshot()
  assert.ok(after.shedCounts.anonymousAuth - before.anonymousAuth >= 2, JSON.stringify(after.shedCounts))
  assert.ok(after.shedCounts.export - before.export >= 1 && after.shedCounts.realtime - before.realtime >= 1 && after.shedCounts.read - before.read >= 1)
  assert.equal(after.running, false, '直接 createApp 时不启动采样器')
}

/** 第 15、18、20 项：管理员性能接口附带闸门、负缓存与过载快照。 */
async function verifyPerformanceSnapshot() {
  const session = await loginAdmin()
  const response = await call('GET', '/api/data-maintenance/database/performance', { session })
  assert.equal(response.status, 200, response.text)
  const data = response.body?.data as {
    concurrencyGates: Array<{ name: string; completed: number }>
    riskNegativeCache: { rateLimitDenials: number; failureLocks: number; maxEntries: number }
    overload: { level: string; thresholds: Record<string, number> }
  }
  for (const name of ['password-hash', 'captcha-render', 'product-image-processing', 'anonymous-auth-in-flight']) {
    assert.ok(data.concurrencyGates.some((gate) => gate.name === name), `性能接口缺少闸门 ${name}`)
  }
  assert.ok(data.concurrencyGates.find((gate) => gate.name === 'password-hash')!.completed >= 1)
  assert.equal(data.riskNegativeCache.maxEntries, 20_000)
  assert.equal(data.overload.level, 'normal')
  assert.equal(data.overload.thresholds.elevatedLoopDelayMs, 500)
}

/** 第 24 项：管理端鉴权单次联表查询，且不取回密码哈希；过期、停用、无效会话语义不变。 */
async function verifySingleQueryAuthentication() {
  const session = await loginAdmin()
  type QueryRunnerLike = { query: (...args: unknown[]) => Promise<unknown> }
  const driver = m.AppDataSource.driver as unknown as { createQueryRunner: (...args: unknown[]) => QueryRunnerLike }
  const originalCreate = driver.createQueryRunner
  const queries: string[] = []
  const restorers: Array<() => void> = []
  const wrapped = new WeakSet<QueryRunnerLike>()
  driver.createQueryRunner = function (this: unknown, ...args: unknown[]) {
    const runner = originalCreate.apply(this, args)
    if (!wrapped.has(runner)) {
      wrapped.add(runner)
      const hadOwnQuery = Object.hasOwn(runner, 'query')
      const originalQuery = runner.query
      runner.query = function (this: unknown, ...queryArgs: unknown[]) {
        queries.push(String(queryArgs[0]))
        return originalQuery.apply(this, queryArgs)
      }
      restorers.push(() => {
        if (hadOwnQuery) runner.query = originalQuery
        else delete (runner as Partial<QueryRunnerLike>).query
      })
    }
    return runner
  }
  let username: string
  try {
    username = (await m.authService.resolveAuthUserByToken(session.token)).username
  } finally {
    driver.createQueryRunner = originalCreate
    restorers.forEach((restore) => restore())
  }
  assert.equal(username, 'admin')
  const selects = queries.filter((sql) => /^\s*SELECT/i.test(sql))
  assert.equal(selects.length, 1, `鉴权只应产生一次查询：${selects.join(' | ')}`)
  assert.match(selects[0], /JOIN\s+"?sys_user"?/i)
  assert.doesNotMatch(selects[0], /password_hash/i, '鉴权联表不得取回密码哈希')

  const second = await loginAdmin()
  const sessionRepo = m.AppDataSource.getRepository(m.SysUserSession)
  const secondHash = m.hashSessionToken(second.token)
  await sessionRepo.update({ sessionToken: secondHash }, { expiresAt: new Date(Date.now() - 1000) })
  assert.equal((await call('GET', '/api/auth/me', { headers: { Cookie: second.cookie } })).status, 401, '过期会话必须被拒')
  await sessionRepo.update({ sessionToken: secondHash }, { expiresAt: new Date(Date.now() + 60_000) })
  assert.equal((await call('GET', '/api/auth/me', { headers: { Cookie: second.cookie } })).status, 200, '未过期会话可用')
  const userRepo = m.AppDataSource.getRepository(m.SysUser)
  await userRepo.update({ username: 'admin' }, { status: 'disabled' })
  try {
    assert.equal((await call('GET', '/api/auth/me', { headers: { Cookie: session.cookie } })).status, 403)
    assert.equal((await call('GET', '/api/auth/me', { headers: { Cookie: session.cookie } })).status, 401, '停用后会话已删除')
  } finally {
    await userRepo.update({ username: 'admin' }, { status: 'enabled' })
  }
  assert.equal((await call('GET', '/api/auth/me', { headers: { Cookie: 'y_link_admin_session=invalid-token' } })).status, 401)
}

async function canListenOn(port: number): Promise<boolean> {
  const probe = http.createServer()
  return await new Promise<boolean>((resolve) => {
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

/**
 * 为真实服务子进程挑选端口：避开系统临时端口范围（Windows 默认 49152 起、Linux 默认 32768 起，
 * 也有机器被改为从 1024 起），否则父进程探测后释放的端口可能被随后的出站连接占用，子进程虽监听成功却无法接入。
 */
async function pickRuntimePort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = 20_000 + Math.floor(Math.random() * 10_000)
    if (await canListenOn(port)) return port
  }
  throw new Error('找不到可供真实服务进程监听的端口')
}

function spawnRuntime(dataRoot: string, port: number) {
  fs.mkdirSync(dataRoot, { recursive: true })
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), path.join(backendRoot, 'src', 'index.ts')], {
    cwd: dataRoot,
    env: {
      ...process.env,
      PORT: String(port),
      Y_LINK_LISTEN_HOST: '127.0.0.1',
      APP_PROFILE: `${process.env.APP_PROFILE}-runtime`,
      SQLITE_DB_PATH: path.join(dataRoot, 'runtime.sqlite'),
      Y_LINK_DATA_DIR: path.join(dataRoot, 'data'),
      LOG_COLOR: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout?.on('data', (chunk) => { output += String(chunk) })
  child.stderr?.on('data', (chunk) => { output += String(chunk) })
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
    child.once('error', () => resolve())
  })
  return { child, exited, output: () => output }
}

async function waitForRuntimeHealth(runtime: ReturnType<typeof spawnRuntime>, baseAddress: string): Promise<boolean> {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline && runtime.child.exitCode === null) {
    try {
      if ((await fetch(`${baseAddress}/health`, { signal: AbortSignal.timeout(2000) })).ok) return true
    } catch {
      // 服务尚未开始监听。
    }
    await sleep(250)
  }
  return false
}

/**
 * 第 20、22 项：真实服务进程只监听回环地址，并启动过载采样（SQLite 上报写队列占用）。
 * 真实启动流程在 Windows 下打不开含非 ASCII 字符路径中的 SQLite 文件（如中文用户名下的系统临时目录），
 * 因此该子进程的数据放在已被 .gitignore 忽略的 backend/data 下，结束后删除；端口偶发不可用时换端口重试。
 */
async function verifyRealRuntime() {
  const runtimeParent = path.join(backendRoot, 'data')
  fs.mkdirSync(runtimeParent, { recursive: true })
  const runtimeRoot = fs.mkdtempSync(path.join(runtimeParent, 'verify-data-leak-ddos-runtime-'))
  const failures: string[] = []
  try {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const port = await pickRuntimePort()
      const runtimeBase = `http://127.0.0.1:${port}`
      const runtime = spawnRuntime(path.join(runtimeRoot, `attempt-${attempt}`), port)
      try {
        if (!(await waitForRuntimeHealth(runtime, runtimeBase))) {
          failures.push(`第 ${attempt} 次（端口 ${port}）未就绪：\n${runtime.output().slice(-1500)}`)
          continue
        }
        await assertRuntimeBehaviour(runtimeBase, port)
        return
      } catch (error) {
        console.error(runtime.output().slice(-3000))
        throw error
      } finally {
        runtime.child.kill()
        await runtime.exited
      }
    }
    assert.fail(`真实服务进程三次均未能在回环地址上就绪：\n${failures.join('\n')}`)
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

async function assertRuntimeBehaviour(runtimeBase: string, port: number) {
  const lanAddress = Object.values(os.networkInterfaces()).flat()
    .find((item) => item && item.family === 'IPv4' && !item.internal)?.address
  if (lanAddress) {
    await assert.rejects(fetch(`http://${lanAddress}:${port}/health`, { signal: AbortSignal.timeout(3000) }), '回环监听时局域网地址不得直连 Node')
  }
  const login = await fetch(`${runtimeBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
  })
  assert.equal(login.status, 200, await login.text())
  const cookies = readSetCookies(login)
  await sleep(2500)
  const perf = await fetch(`${runtimeBase}/api/data-maintenance/database/performance`, {
    headers: { Cookie: `y_link_admin_session=${encodeURIComponent(cookies.y_link_admin_session)}` },
  })
  assert.equal(perf.status, 200)
  const overload = ((await perf.json()) as { data: { overload: { running: boolean; level: string; lastSignals: { eventLoopDelayP99Ms: number; writeQueueOccupancy: number | null } | null } } }).data.overload
  assert.equal(overload.running, true, '正式运行时应启动过载采样')
  assert.equal(overload.level, 'normal')
  assert.equal(typeof overload.lastSignals?.eventLoopDelayP99Ms, 'number')
  assert.equal(typeof overload.lastSignals?.writeQueueOccupancy, 'number', 'SQLite 模式应上报写队列占用率')
  console.log(`[data-leak-ddos-verify:core] 真实服务进程回环监听通过（${lanAddress ? `局域网地址 ${lanAddress} 已拒绝直连` : '本机无局域网 IPv4，跳过直连探测'}）`)
}

async function runCorePhase() {
  verifyRiskSourceKeyPrimitives()
  verifyEncryptionPrimitives()
  verifyExportLeasePoolPrimitives()
  verifyAuditMaskPrimitives()
  verifyMysqlSslOptions()
  await verifyPasswordHashPrimitives()
  verifyPasswordPolicyPrimitives()
  await verifyConcurrencyGatePrimitives()
  verifyOverloadPrimitives()
  verifySessionRateFusePrimitives()
  verifyServerHardeningPrimitives()
  verifyTicketStorePrimitives()
  verifyDeploymentDefaults()

  await verifyResponseCacheHeaders()
  await verifyFetchMetadataIsolation()
  await verifyAdminCsrfBinding()
  await verifySensitiveConfigEncryption()
  await verifyJsonDataTransferGate()
  await verifyExportGovernance()
  await verifyAuditSubjectMasking()
  await verifyTransparentRehash()
  await verifyPasswordPolicyEndpoints()
  await verifyRiskSourceAggregation()
  await verifyAuthInputLimits()
  await verifyHashOutsideTransactions()
  await verifyRiskNegativeCache()
  await verifyOverloadShedding()
  await verifyPerformanceSnapshot()
  // 会临时停用 admin，放在依赖 admin 的 HTTP 断言之后。
  await verifySingleQueryAuthentication()
  await verifyRealRuntime()
  console.log('[data-leak-ddos-verify:core] 缓存头、跨站隔离、CSRF 绑定、落库加密、JSON 导出管控、导出留痕与上限、审计脱敏、MySQL TLS、哈希升级与耗时一致、口令策略、来源聚合、入参上限、事务外派生、负缓存、削峰、闸门与保险丝单元、服务端硬化、鉴权单查询、回环监听与过载采样通过')
}

// ---------------------------------------------------------------------------
// gates：闸门调到 1 并发
// ---------------------------------------------------------------------------

/** 第 15 项：密码派生闸门满载快速 503；计时哈希失败不缓存；HTTP 下发 Retry-After。 */
async function verifyPasswordHashGate() {
  const { hashPassword, verifyPassword, verifyPasswordForNonexistentAccount } = m.password
  const hash = await hashPassword('Gate-Check-Pass9')

  // 计时哈希首次生成时闸门已满：本次 503，但失败不得被缓存，闸门空闲后恢复正常。
  const busyA = verifyPassword('Gate-Check-Pass9', hash)
  const busyB = verifyPassword('Gate-Check-Pass9', hash)
  await assert.rejects(verifyPasswordForNonexistentAccount('whatever-1'), isBizErrorWithStatus(503))
  assert.deepEqual(await Promise.all([busyA, busyB]), [true, true])
  await verifyPasswordForNonexistentAccount('whatever-1')

  const results = await Promise.allSettled([1, 2, 3].map(() => verifyPassword('Gate-Check-Pass9', hash)))
  assert.equal(results.filter((result) => result.status === 'fulfilled' && result.value === true).length, 2, '并发 1、排队 1：两个完成')
  const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult | undefined
  assert.ok(rejected && isBizErrorWithStatus(503)(rejected.reason), '超出排队上限的派生快速返回 503')
  assert.equal((rejected.reason as { retryAfterSeconds?: number }).retryAfterSeconds, 2)
  const snapshot = m.listConcurrencyGateSnapshots().find((gate) => gate.name === 'password-hash')
  assert.equal(snapshot?.maxConcurrent, 1)
  assert.equal(snapshot?.maxQueue, 1)
  assert.ok((snapshot?.rejectedQueueFull ?? 0) >= 2)

  await resetRiskState()
  const attempts = await Promise.all(Array.from({ length: 5 }, (_, index) => (
    call('POST', '/api/auth/login', { body: { username: `gate-probe-${index}`, password: 'Wrong-Pass-2026x' } })
  )))
  const statuses = attempts.map((attempt) => attempt.status).join(',')
  const busy = attempts.filter((attempt) => attempt.status === 503)
  assert.ok(busy.length >= 1, `并发登录超出派生闸门时应快速 503：${statuses}`)
  assert.equal(busy[0].body?.message, '当前登录与密码校验请求较多，请稍后重试')
  assert.equal(busy[0].headers.get('retry-after'), '2', '503 按闸门配置下发 Retry-After')
  assert.ok(attempts.some((attempt) => attempt.status === 401), `获得槽位的请求照常完成校验：${statuses}`)
  await resetRiskState()
}

/** 第 19 项：验证码渲染闸门满载快速拒绝。 */
async function verifyCaptchaRenderGate() {
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => m.captchaModule.captchaService.createCaptcha('client')))
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1, '并发 1、排队 0：只有一张完成渲染')
  for (const result of results) {
    if (result.status === 'rejected') {
      assert.ok(isBizErrorWithStatus(503)(result.reason))
      assert.match((result.reason as Error).message, /验证码服务繁忙/)
    }
  }
  const snapshot = m.listConcurrencyGateSnapshots().find((gate) => gate.name === 'captcha-render')
  assert.equal(snapshot?.maxConcurrent, 1)
  assert.ok((snapshot?.rejectedQueueFull ?? 0) >= 4)
  assert.equal((await call('GET', '/api/client-auth/captcha')).status, 200, '闸门空闲后恢复正常')
}

/** 第 16 项：商品图处理闸门满载时 503，且被拒绝的上传不遗留临时文件。 */
async function verifyProductImageGate() {
  const sharp = (await import('sharp')).default
  const width = 1800
  const height = 1800
  const noise = Buffer.alloc(width * height * 3)
  for (let index = 0; index < noise.length; index += 1) noise[index] = (index * 2654435761) & 0xff
  const png = await sharp(noise, { raw: { width, height, channels: 3 } }).png().toBuffer()
  const session = await loginAdmin()
  const upload = () => {
    const form = new FormData()
    form.append('file', new Blob([png], { type: 'image/png' }), 'noise.png')
    return fetch(`${baseUrl}/api/upload`, { method: 'POST', headers: { Cookie: session.cookie, 'x-csrf-token': session.csrf }, body: form })
  }
  const responses = await Promise.all([upload(), upload()])
  const statuses = responses.map((response) => response.status).sort()
  assert.deepEqual(statuses, [200, 503], `并发上传应一个成功一个被闸门拒绝：${statuses}`)
  const busy = responses.find((response) => response.status === 503)!
  assert.equal(busy.headers.get('retry-after'), '2')
  assert.match(((await busy.json()) as { message: string }).message, /商品图片处理繁忙/)
  await responses.find((response) => response.status === 200)!.arrayBuffer()
  const uploadsRoot = path.join(process.cwd(), 'uploads')
  const tmpDir = path.join(uploadsRoot, '.tmp')
  assert.deepEqual(fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : [], [], '被拒绝的上传必须清理临时文件')
  assert.equal(fs.readdirSync(path.join(uploadsRoot, 'products')).length, 1)
}

/** 第 21 项：同一会话突发后 429，其他会话不受影响，等待补充后恢复；客户端会话同样生效。 */
async function verifySessionRateFuse() {
  const sessionA = await loginAdmin()
  const statuses: number[] = []
  for (let index = 0; index < 14; index += 1) {
    statuses.push((await call('GET', '/api/auth/me', { headers: { Cookie: sessionA.cookie } })).status)
  }
  assert.ok(statuses.slice(0, 10).every((status) => status === 200), statuses.join(','))
  assert.ok(statuses.slice(10).some((status) => status === 429), statuses.join(','))
  const limited = await call('GET', '/api/auth/me', { headers: { Cookie: sessionA.cookie } })
  assert.equal(limited.status, 429)
  assert.ok(Number(limited.headers.get('retry-after')) >= 1)
  assert.equal(limited.body?.data?.reason, 'SESSION_RATE_LIMITED')
  const sessionB = await loginAdmin()
  assert.equal((await call('GET', '/api/auth/me', { headers: { Cookie: sessionB.cookie } })).status, 200, '按会话计数，其他会话不受影响')
  await sleep(1100)
  assert.equal((await call('GET', '/api/auth/me', { headers: { Cookie: sessionA.cookie } })).status, 200, '等待补充后恢复')

  await m.clientUserManageService.createProfile({
    profileKind: 'personal',
    username: '保险丝客户',
    mobile: '13900002222',
    email: null,
    password: 'Fuse7-Client#2026',
    status: 'enabled',
    departmentName: undefined,
    staffNo: undefined,
  } as never, await contextOf('admin'))
  await resetRiskState()
  const clientLogin = await call('POST', '/api/client-auth/login', { body: { account: '13900002222', password: 'Fuse7-Client#2026' } })
  assert.equal(clientLogin.status, 200, clientLogin.text)
  const clientCookie = `y_link_client_session=${encodeURIComponent(clientLogin.cookies.y_link_client_session)}`
  const clientStatuses: number[] = []
  for (let index = 0; index < 13; index += 1) {
    clientStatuses.push((await call('GET', '/api/client-auth/me', { headers: { Cookie: clientCookie } })).status)
  }
  assert.ok(clientStatuses.slice(0, 10).every((status) => status === 200), clientStatuses.join(','))
  assert.ok(clientStatuses.slice(10).some((status) => status === 429), `客户端会话同样受保险丝约束：${clientStatuses.join(',')}`)
}

async function runGatesPhase() {
  await verifyPasswordHashGate()
  await verifyCaptchaRenderGate()
  await verifyProductImageGate()
  await verifySessionRateFuse()
  console.log('[data-leak-ddos-verify:gates] 密码派生、验证码渲染、商品图处理闸门满载快速拒绝，计时哈希失败不缓存，会话保险丝通过')
}

// ---------------------------------------------------------------------------
// in-flight：匿名认证在途上限
// ---------------------------------------------------------------------------

/** 第 19 项：管理端与客户端匿名认证共用进程级在途上限，超出直接 503，响应结束即释放。 */
async function runInFlightPhase() {
  const attempts = await Promise.all(Array.from({ length: 12 }, (_, index) => (
    call('POST', '/api/auth/login', { body: { username: `in-flight-${index}`, password: 'Wrong-Pass-2026x' } })
  )))
  const statuses = attempts.map((attempt) => attempt.status).join(',')
  const busy = attempts.filter((attempt) => attempt.status === 503)
  assert.ok(busy.length >= 1, `在途上限应拒绝部分并发请求：${statuses}`)
  assert.equal(busy[0].body?.message, '当前登录与注册请求较多，请稍后重试')
  assert.equal(busy[0].headers.get('retry-after'), '2')
  assert.ok(attempts.some((attempt) => attempt.status === 401), `获得槽位的请求照常处理：${statuses}`)
  assert.equal((await call('GET', '/health')).status, 200, '非匿名认证路径不受在途上限影响')

  const deadline = Date.now() + 2_000
  let snapshot = m.listConcurrencyGateSnapshots().find((gate) => gate.name === 'anonymous-auth-in-flight')
  while (snapshot && snapshot.active > 0 && Date.now() < deadline) {
    await sleep(20)
    snapshot = m.listConcurrencyGateSnapshots().find((gate) => gate.name === 'anonymous-auth-in-flight')
  }
  assert.equal(snapshot?.maxConcurrent, 4)
  assert.equal(snapshot?.active, 0, '响应结束后释放全部槽位')
  assert.ok((snapshot?.rejectedQueueFull ?? 0) >= 1)

  await resetRiskState()
  const clientAttempts = await Promise.all(Array.from({ length: 12 }, (_, index) => (
    call('POST', '/api/client-auth/login', { body: { account: `1390000${String(index).padStart(4, '0')}`, password: 'Wrong-Pass-2026x' } })
  )))
  assert.ok(clientAttempts.some((attempt) => attempt.status === 503), `客户端匿名认证共用在途上限：${clientAttempts.map((attempt) => attempt.status).join(',')}`)
  await loginAdmin()
  console.log(`[data-leak-ddos-verify:in-flight] 匿名认证在途上限通过（管理端并发状态 ${statuses}）`)
}

// ---------------------------------------------------------------------------
// global-captcha：分布式撞库态势
// ---------------------------------------------------------------------------

/** 第 11 项：各来源、各账号都低于单桶阈值，但全局失败数超阈值后全员强制图形验证码，且只审计一次。 */
async function runGlobalCaptchaPhase() {
  const marker = await auditMarker()
  const security = m.authSecurityService
  const meta = (index: number) => requestMetaOf(`203.0.113.${index}`)
  for (let index = 1; index <= 4; index += 1) {
    await security.recordAdminLoginFailure(meta(index), `ghost${index}`, { subjectResolved: false })
  }
  assert.equal((await security.guardAdminLoginRequest(meta(100), 'fresh-user')).captchaRequired, false, '未达全局阈值时全新来源无需验证码')
  await security.recordAdminLoginFailure(meta(5), 'ghost5', { subjectResolved: false })
  assert.equal((await security.guardAdminLoginRequest(meta(101), 'fresh-user-2')).captchaRequired, true, '达到全局阈值后全新来源也要验证码')
  await security.recordAdminLoginFailure(meta(6), 'ghost6', { subjectResolved: false })

  const events = await settledAuditRows(marker, ['auth.guard.global_captcha'], 1)
  assert.equal(events.length, 1, '进入全局验证码状态只写一次审计')
  assert.equal(events[0].targetCode, 'admin-login')
  assert.equal((await security.guardClientLoginRequest(meta(102), 'client-fresh')).captchaRequired, false, '客户端独立计数，不受管理端态势影响')

  const adminLogin = await call('POST', '/api/auth/login', { body: { username: 'admin', password: ADMIN_PASSWORD } })
  assert.equal(adminLogin.status, 428, '本机来源从未失败，但全局态势要求先过图形验证码')
  const clientLogin = await call('POST', '/api/client-auth/login', { body: { account: '13800000000', password: 'Wrong-Pass-2026x' } })
  assert.equal(clientLogin.status, 401, '客户端登录不受管理端全局态势影响')
  console.log('[data-leak-ddos-verify:global-captcha] 分布式撞库全员强制验证码与一次性审计通过')
}

// ---------------------------------------------------------------------------
// 调度
// ---------------------------------------------------------------------------

async function runPhase(phase: Phase) {
  try {
    await bootPhase(phase)
    if (phase === 'core') await runCorePhase()
    else if (phase === 'gates') await runGatesPhase()
    else if (phase === 'in-flight') await runInFlightPhase()
    else await runGlobalCaptchaPhase()
  } finally {
    await shutdownPhase()
  }
}

function runAllPhases() {
  for (const phase of PHASES) {
    const startedAt = Date.now()
    const result = spawnSync(process.execPath, ['--import', 'tsx', scriptPath, phase], { cwd: backendRoot, env: process.env, stdio: 'inherit' })
    if (result.status !== 0) {
      console.error(`[data-leak-ddos-verify] 阶段 ${phase} 失败（退出码 ${result.status ?? result.signal}）`)
      process.exit(result.status || 1)
    }
    console.log(`[data-leak-ddos-verify] 阶段 ${phase} 通过（${((Date.now() - startedAt) / 1000).toFixed(1)}s）`)
  }
  console.log('[data-leak-ddos-verify] 敏感数据防泄露与抗 DDoS / 爆破回归全部通过')
}

const requestedPhase = process.argv[2]
if (requestedPhase === undefined) {
  runAllPhases()
} else if ((PHASES as readonly string[]).includes(requestedPhase)) {
  await runPhase(requestedPhase as Phase)
} else {
  console.error(`未知阶段：${requestedPhase}，可选 ${PHASES.join(' / ')}`)
  process.exit(2)
}
