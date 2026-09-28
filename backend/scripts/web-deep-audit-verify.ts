/**
 * 文件说明：backend/scripts/web-deep-audit-verify.ts
 * 文件职责：回归 2026-09 Web 端深度审计发现的问题，防止修复被后续改动悄悄退化。
 * 实现逻辑：
 * - 能以纯函数或内存 Express 实例复现的问题做真实行为断言（畸形 JSON、模板转义、验证码一次性、空闲超时判定）；
 * - 依赖数据库事务的入口做装配契约断言（永久删除限流与口令校验顺序、本人改密拦截、客户端写接口频控、onebox 上传直出范围）。
 * 维护说明：新增同类入口时同步补充断言；不要为了让脚本通过而放宽断言。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(backendRoot, '..')
const read = (relativePath: string) => fs.readFileSync(path.resolve(backendRoot, relativePath), 'utf8')
const readRepo = (relativePath: string) => fs.readFileSync(path.resolve(repoRoot, relativePath), 'utf8')

async function verifyMalformedJsonIsClientErrorWithoutBodyLog() {
  const { errorHandler } = await import('../src/middleware/error-handler.js')
  const app = express()
  app.use(express.json({ limit: '1kb' }))
  app.post('/probe', (_req, res) => {
    res.json({ ok: true })
  })
  app.use(errorHandler)

  const secret = 'PlainTextPassword-9f3c'
  const logged: string[] = []
  const originalConsoleError = console.error
  console.error = (...args: unknown[]) => {
    logged.push(args.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(' '))
  }
  const server = app.listen(0, '127.0.0.1')
  try {
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    const { port } = server.address() as AddressInfo
    const malformed = await fetch(`http://127.0.0.1:${port}/probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: `{"username":"admin","password":"${secret}"`,
    })
    assert.equal(malformed.status, 400, '畸形 JSON 必须返回 400 而不是 500')
    const tooLarge = await fetch(`http://127.0.0.1:${port}/probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(4096) }),
    })
    assert.equal(tooLarge.status, 413, '超限请求体必须返回 413')
  } finally {
    console.error = originalConsoleError
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  assert.ok(!logged.some((line) => line.includes(secret)), '错误日志不得包含原始请求体中的密码')

  const { toSafeErrorLog } = await import('../src/utils/safe-error-log.js')
  const withBody = Object.assign(new SyntaxError('Unexpected end of JSON input'), { body: `{"password":"${secret}"` })
  assert.ok(!JSON.stringify(toSafeErrorLog(withBody)).includes(secret), '兜底日志不得展开错误对象自有属性')
}

async function verifyProviderTemplateEscaping() {
  const { renderProviderTemplate, resolveProviderBodyFormat } = await import('../src/utils/provider-template.js')
  const injectedTarget = 'victim@a.b","cc":"attacker\\u0040evil.com'
  const jsonBody = renderProviderTemplate('{"to":"{{target}}","code":"{{ code }}"}', { target: injectedTarget, code: '123456' }, 'json')
  const parsed = JSON.parse(jsonBody) as Record<string, unknown>
  assert.deepEqual(Object.keys(parsed), ['to', 'code'], 'JSON 模板替换值不得闭合字符串注入新字段')
  assert.equal(parsed.to, injectedTarget, 'JSON 模板替换后原值必须保持不变')

  const multiLineContent = '第一行"引号"\n<a href="https://evil.example">点击</a>'
  const emailBody = JSON.parse(renderProviderTemplate('{"html":"{{content}}"}', { content: multiLineContent }, 'json')) as { html: string }
  assert.equal(emailBody.html, multiLineContent, '含引号与换行的客服摘要不得破坏邮件网关 JSON')

  assert.equal(
    renderProviderTemplate('to={{target}}&code={{code}}', { target: 'a@b.c&code=000000', code: '1' }, 'form'),
    'to=a%40b.c%26code%3D000000&code=1',
    '表单模板必须 URL 编码替换值',
  )
  assert.equal(
    renderProviderTemplate('{{content}}', { content: '{{code}}' , code: 'LEAK' }, 'text'),
    '{{code}}',
    '替换值不得被二次展开',
  )
  assert.equal(resolveProviderBodyFormat({ 'content-type': 'application/json; charset=utf-8' }, 'x'), 'json')
  assert.equal(resolveProviderBodyFormat({ 'Content-Type': 'application/x-www-form-urlencoded' }, '{}'), 'form')
  assert.equal(resolveProviderBodyFormat({}, ' {"a":1}'), 'json')

  const { normalizeClientVerificationTarget } = await import('../src/utils/client-auth-account.js')
  assert.throws(() => normalizeClientVerificationTarget('email', 'a"b@example.com'), /邮箱格式不正确/)
  assert.throws(() => normalizeClientVerificationTarget('email', 'a\\u0040b@example.com'), /邮箱格式不正确/)
  assert.equal(normalizeClientVerificationTarget('email', "O'Brien@Example.com"), "o'brien@example.com", '合法单引号邮箱必须保留')

  const verificationService = read('src/services/verification-code.service.ts')
  const notificationService = read('src/services/notification.service.ts')
  assert.match(verificationService, /renderProviderTemplate\(\s*config\.bodyTemplate/, '验证码请求体必须经上下文转义渲染')
  assert.doesNotMatch(notificationService, /bodyTemplate\s*\n?\s*\.replaceAll/, '通知邮件请求体不得再直接字符串替换')
}

async function verifyCaptchaOneShot() {
  const { CaptchaService } = await import('../src/services/captcha.service.js')
  const service = new CaptchaService({ createCode: () => 'ABCDEF', renderPng: async () => Buffer.from('png') })
  const ticket = await service.createCaptcha('admin')
  assert.throws(() => service.verifyCaptcha('admin', ticket.captchaId, 'WRONG1'), /错误/)
  assert.throws(() => service.verifyCaptcha('admin', ticket.captchaId, 'ABCDEF'), /失效/, '答错一次后原验证码必须作废')
  const loginView = readRepo('src/views/auth/LoginView.vue')
  assert.match(loginView, /captchaAlreadyVisible[\s\S]{0,160}refreshCaptcha\(\)/, '管理端登录页答错验证码后必须换新图')
}

async function verifyAdminSessionIdleTimeout() {
  const { isAdminSessionIdleExpired } = await import('../src/utils/admin-session-idle.js')
  const now = new Date('2026-09-26T12:00:00Z')
  const idleMs = 720 * 60 * 1000
  assert.equal(isAdminSessionIdleExpired({ lastAccessAt: new Date(now.getTime() - idleMs - 1) }, now, idleMs), true)
  assert.equal(isAdminSessionIdleExpired({ lastAccessAt: new Date(now.getTime() - idleMs + 1000) }, now, idleMs), false)
  assert.equal(isAdminSessionIdleExpired({ lastAccessAt: new Date(0) }, now, 0), false, '配置为 0 时不得启用空闲超时')
  assert.equal(isAdminSessionIdleExpired({ lastAccessAt: null }, now, idleMs), false, '缺少活跃时间的历史会话不判定')

  const authService = read('src/services/auth.service.ts')
  const realtimeService = read('src/services/customer-service-realtime.service.ts')
  assert.match(authService, /isAdminSessionIdleExpired\(session, now\)[\s\S]{0,200}sessionRepo\.delete/, '空闲过期会话必须被删除')
  assert.match(realtimeService, /isAdminSessionIdleExpired\(item, now\)/, '客服 SSE 复核必须共用空闲超时口径')
  assert.match(realtimeService, /isAdminSessionIdleExpired\(activeSession, now\)/, '客服 SSE 注册必须共用空闲超时口径')
  assert.match(read('src/config/env.ts'), /AUTH_SESSION_IDLE_TIMEOUT_MINUTES:[^\n]*default\(720\)/, '默认空闲超时必须为 12 小时')
}

function verifyPermanentDeleteGuards() {
  const inboundRoutes = read('src/routes/inbound.routes.ts')
  const o2oRoutes = read('src/routes/o2o.routes.ts')
  const orderRoutes = read('src/routes/order.routes.ts')
  const inboundService = read('src/services/inbound.service.ts')

  assert.match(inboundRoutes, /'\/supplier\/:id\/permanent',\s*requirePermission\('inbound:create'\),\s*supplierPurgeLimiter,/, '供货方永久删除必须按账号限流')
  assert.doesNotMatch(inboundRoutes, /assertPermanentDeletePassword\(/, '供货方路由不得先于归属校验核对全局口令')
  const purgeStart = inboundService.indexOf('  async purgeSupplierDelivery(')
  const purgeSource = inboundService.slice(purgeStart, inboundService.indexOf('  private async purgeSupplierDeliveryInManager(', purgeStart))
  const ownershipIndex = purgeSource.indexOf('findSupplierOwnedOrder')
  const showNoIndex = purgeSource.indexOf('确认单号不一致')
  const passwordIndex = purgeSource.indexOf('assertPermanentDeletePassword(permanentDeletePassword)')
  assert.ok(ownershipIndex > 0 && showNoIndex > ownershipIndex && passwordIndex > showNoIndex, '口令必须在归属与确认单号之后校验')
  assert.match(purgeSource, /reason: error\.statusCode === 400 \? 'password_missing' : 'password_rejected'/, '口令拒绝必须写脱敏失败审计')

  assert.match(o2oRoutes, /'\/orders\/batch-purge-cancelled',[\s\S]{0,120}o2oPermanentDeleteLimiter/, 'O2O 批量清理必须限流')
  assert.match(o2oRoutes, /o2oAdminRouter\.delete\(\s*'\/orders\/:id',[\s\S]{0,120}o2oPermanentDeleteLimiter/, 'O2O 订单删除必须限流')
  assert.match(orderRoutes, /'\/:id\/purge',[\s\S]{0,120}orderPurgeLimiter/, '出库单永久删除必须限流')
  assert.doesNotMatch(`${o2oRoutes}\n${orderRoutes}`, /(?<!ForRequest)assertPermanentDeletePassword\(/, '管理端永久删除口令必须走带审计的校验')

  const guard = read('src/utils/permanent-delete-guard.ts')
  assert.match(guard, /keyGenerator: \(req\) => `\$\{options\.storePrefix\}:\$\{\(req as AuthenticatedRequest\)\.auth\?\.userId/, '限流必须按账号而非目标计桶')
  // 共享口令桶：计数键只含账号，不含入口前缀或操作类型；沿用各自限流器的入口也必须接入。
  assert.match(guard, /keyGenerator: \(req\) => `account:\$\{\(req as AuthenticatedRequest\)\.auth\?\.userId/, '共享口令桶必须只按账号计数')
  assert.match(guard, /new DatabaseRateLimitStore\('express-permanent-delete-password'\)/, '共享口令桶在 MySQL 下必须使用唯一的持久化存储前缀')
  assert.match(read('src/routes/user.routes.ts'), /permanentDeleteLimiter,\s*permanentDeletePasswordGuard,/, '管理端账号永久删除必须接入共享口令桶')
  assert.match(read('src/routes/client-user-manage.routes.ts'), /permanentDeleteLimiter,\s*permanentDeletePasswordGuard,/, '客户端账号永久删除必须接入共享口令桶')
  assert.match(inboundRoutes, /verifiedSupplierDeleteLimiter,\s*verifiedSupplierDeletePasswordGuard,/, '供货方已入库删除必须接入共享口令桶')
  assert.match(read('src/routes/data-maintenance.routes.ts'), /const jsonExportLimiter = createAccountScopedLimiter\(/, 'JSON 导出不校验永久删除口令，不得占用共享口令桶')
}

/**
 * 永久删除口令是全局口令：同一账号在任何入口的失败尝试合并计数，轮换入口不能叠加额度；
 * 成功请求不占用共享额度，其它账号不受影响。
 */
async function verifyPermanentDeletePasswordSharedBucket() {
  const { env } = await import('../src/config/env.js')
  const { auditService } = await import('../src/services/audit.service.js')
  const { errorHandler } = await import('../src/middleware/error-handler.js')
  const guard = await import('../src/utils/permanent-delete-guard.js')
  const mutableEnv = env as { PERMANENT_DELETE_PASSWORD?: string }
  const originalPassword = mutableEnv.PERMANENT_DELETE_PASSWORD
  const audit = auditService as unknown as Record<string, unknown>
  const blockedAudits: Array<{ actionType: string; scope: string }> = []
  mutableEnv.PERMANENT_DELETE_PASSWORD = 'Verify-Shared-Pass-123'
  audit.safeRecord = async (input: { actionType: string; detail?: { reason?: string; scope?: string } }) => {
    if (input.detail?.reason === 'rate_limited') blockedAudits.push({ actionType: input.actionType, scope: String(input.detail.scope ?? '') })
  }

  const target = (name: string) => ({ actionType: `verify.${name}.purge`, actionLabel: `验证入口 ${name}`, targetType: 'verify' })
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    const userId = String(req.headers['x-verify-user'] ?? '')
    ;(req as unknown as { auth: Record<string, unknown> }).auth = {
      userId, username: userId, displayName: userId, role: 'admin', permissions: [], status: 'enabled', sessionToken: userId, authSource: 'bearer',
    }
    next()
  })
  const entries = ['order', 'o2o', 'supplier', 'import', 'account']
  for (const name of entries) {
    // account 入口模拟“沿用自有限流器、另挂共享口令桶”的系统账号/客户端账号删除。
    const limiter = name === 'account'
      ? guard.createPermanentDeletePasswordGuard(target(name))
      : guard.createPermanentDeleteLimiter({ ...target(name), storePrefix: `verify-shared-${name}` })
    app.post(`/${name}/:id`, limiter, (req, res, next) => {
      guard.assertPermanentDeletePasswordForRequest(req, (req.body as { password?: string }).password, target(name))
        .then(() => res.json({ code: 0 }))
        .catch(next)
    })
  }
  app.use(errorHandler)
  const server = app.listen(0, '127.0.0.1')
  try {
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    const { port } = server.address() as AddressInfo
    const attempt = async (user: string, entry: string, password: string) => {
      const response = await fetch(`http://127.0.0.1:${port}/${entry}/1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-verify-user': user },
        body: JSON.stringify({ password }),
      })
      return { status: response.status, body: await response.json() as { message?: string } }
    }

    // 每个入口只试一次，任何单入口的请求频控都不会触发；共享额度 5 次用完后，第 6 次无论走哪个入口都被拦截。
    for (const entry of entries) {
      assert.equal((await attempt('verify-attacker', entry, 'wrong-pass')).status, 403, `${entry} 入口口令错误应返回 403`)
    }
    const blocked = await attempt('verify-attacker', 'order', 'wrong-pass')
    assert.equal(blocked.status, 429, '轮换入口不得叠加口令试错额度')
    assert.match(blocked.body.message ?? '', /口令错误次数过多/)
    assert.equal((await attempt('verify-attacker', 'account', 'Verify-Shared-Pass-123')).status, 429, '额度用完后正确口令同样被拦截，直至窗口结束')
    assert.deepEqual(blockedAudits.at(-1), { actionType: 'verify.account.purge', scope: 'shared_password_failures' }, '拦截审计记录实际入口的操作类型')

    // 成功请求不占共享额度：另一账号连续成功后仍保有完整的失败额度，且不受攻击账号影响。
    for (const entry of [...entries, 'account', 'account']) {
      assert.equal((await attempt('verify-operator', entry, 'Verify-Shared-Pass-123')).status, 200, `${entry} 入口正确口令应放行`)
    }
    assert.equal((await attempt('verify-operator', 'account', 'wrong-pass')).status, 403, '成功请求不占用共享口令额度')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    mutableEnv.PERMANENT_DELETE_PASSWORD = originalPassword
    Reflect.deleteProperty(audit, 'safeRecord')
  }
}

function verifySelfPasswordAndClientWriteGuards() {
  const userService = read('src/services/user.service.ts')
  assert.match(userService, /normalizedPassword !== undefined && actor\.userId === id[\s\S]{0,80}请使用本人修改密码入口/, '编辑用户接口不得用于本人免旧密码改密')

  const feedbackRoutes = read('src/routes/client-feedback.routes.ts')
  const o2oRoutes = read('src/routes/o2o.routes.ts')
  for (const kind of ['feedback_conversation_create', 'feedback_message']) {
    assert.match(feedbackRoutes, new RegExp(`guardClientBusinessWrite\\([^;]{0,160}'${kind}'\\)`), `反馈写接口缺少 ${kind} 频控`)
  }
  for (const kind of ['preorder_submit', 'preorder_cancel']) {
    assert.match(o2oRoutes, new RegExp(`guardClientBusinessWrite\\([^;]{0,160}'${kind}'\\)`), `预订单写接口缺少 ${kind} 频控`)
  }
  assert.match(read('src/constants/audit-action-catalog.ts'), /'client\.auth\.guard\.business_write'/, '新增频控审计动作必须登记目录')

  const authSecurity = read('src/services/auth-security.service.ts')
  assert.match(authSecurity, /verificationCodeSendByTargetDaily: \{\s*maxRequests: 10,\s*windowMs: 24 \* 60 \* 60 \* 1000/, '发码必须有每目标 24 小时上限')
  assert.match(authSecurity, /`verification-send-daily:\$\{channel\}:\$\{target\}`, RATE_LIMIT_RULES\.verificationCodeSendByTargetDaily/, '统一发码频控必须消费日上限桶')
}

function verifyOneboxUploadBoundaryAndImportGuard() {
  const onebox = readRepo('docker/nginx/onebox.conf')
  assert.match(onebox, /location \^~ \/uploads\/products\/ \{\s*root \/app;/, 'onebox 只允许直出商品图目录')
  assert.doesNotMatch(onebox, /location \^~ \/uploads\/ \{\s*root/, 'onebox 通用 uploads 不得直读磁盘')
  assert.match(read('src/services/client-staff-directory.service.ts'), /assertXlsxArchiveWithinLimits\(buffer, STAFF_DIRECTORY_IMPORT_ARCHIVE_LIMITS\)/, '教职工目录 xlsx 导入必须做压缩炸弹预检')
  assert.match(read('src/routes/o2o.routes.ts'), /qty: z\.number\(\)\.int\(\)\.positive\(\)\.max\(MAX_DATABASE_INT, '入库数量超过系统可处理上限'\)/, 'O2O 手工入库数量必须有上限')
}

/**
 * 登录锁定主体：同一账号的大小写/重音/全角变体（MySQL 排序规则会视为相等）以及手机号、邮箱、用户名、工号
 * 必须落到同一个失败计数桶，否则每换一种写法就多一份失败额度。
 */
async function verifyLoginLockUsesCanonicalSubject() {
  const { authService } = await import('../src/services/auth.service.js')
  const { clientAuthService } = await import('../src/services/client-auth.service.js')
  const { authSecurityService } = await import('../src/services/auth-security.service.js')
  const { auditService } = await import('../src/services/audit.service.js')
  const { hashPassword } = await import('../src/utils/password.js')

  const adminRepo = (authService as unknown as { userRepo: { findOne: (options: unknown) => Promise<unknown> } }).userRepo
  try {
    adminRepo.findOne = async () => ({ id: '1', username: 'admin' })
    assert.deepEqual(await authService.resolveLoginRiskSubject(' Ádmin '), { subject: 'admin', resolved: true }, '账号存在时锁定主体必须是库中规范用户名')
    adminRepo.findOne = async () => null
    assert.deepEqual(await authService.resolveLoginRiskSubject(' ghost '), { subject: 'ghost', resolved: false }, '账号不存在时退回输入原文并标记未命中')
  } finally {
    Reflect.deleteProperty(adminRepo, 'findOne')
  }

  const client = clientAuthService as unknown as Record<string, unknown>
  const security = authSecurityService as unknown as Record<string, unknown>
  const audit = auditService as unknown as Record<string, unknown>
  const recorded: string[] = []
  const passwordHash = await hashPassword('CorrectPass123')
  client.findUserByAnyIdentifier = async () => ({ id: '42' })
  client.findUserWithPasswordByAccount = async () => ({ id: '42', passwordHash, status: 'enabled', realName: '张三' })
  security.recordClientLoginFailure = async (_meta: unknown, subject: string) => {
    recorded.push(subject)
    return { remainingAttempts: 3, shouldWarnRemaining: false, lockTriggered: false }
  }
  audit.safeRecord = async () => undefined
  try {
    for (const account of ['13800000000', 'Someone@Example.com', '张三']) {
      assert.equal(await clientAuthService.resolveLoginRiskSubject(account), 'uid:42', `${account} 必须解析为账号主体`)
      await assert.rejects(
        () => clientAuthService.authenticateCredentials({ account, password: 'WrongPass123' }),
        /用户名或密码错误/,
      )
    }
    assert.deepEqual(recorded, ['uid:42', 'uid:42', 'uid:42'], '同一账号的不同登录标识必须共用一个失败计数主体')
    client.findUserByAnyIdentifier = async () => null
    assert.equal(await clientAuthService.resolveLoginRiskSubject('Nobody@Example.com'), 'nobody@example.com', '账号不存在时退回归一化输入')
  } finally {
    for (const key of ['findUserByAnyIdentifier', 'findUserWithPasswordByAccount']) Reflect.deleteProperty(client, key)
    Reflect.deleteProperty(security, 'recordClientLoginFailure')
    Reflect.deleteProperty(audit, 'safeRecord')
  }

  assert.match(read('src/routes/auth.routes.ts'), /guardAdminLoginRequest\(\s*requestMeta,\s*payload\.username,\s*\(\) => authService\.resolveLoginRiskSubject\(payload\.username\)/, '管理端登录锁定判定必须使用规范主体')
  assert.match(read('src/routes/client-auth.routes.ts'), /guardClientLoginRequest\(\s*requestMeta,\s*normalizedAccount,\s*\(\) => clientAuthService\.resolveLoginRiskSubject\(payload\.account\)/, '客户端登录锁定判定必须使用账号主体')
  assert.match(read('src/services/mobile-auth.service.ts'), /guardClientLoginRequest\(\s*requestMeta,\s*normalizedAccount,\s*\(\) => clientAuthService\.resolveLoginRiskSubject\(input\.account\)/, 'Mobile 登录与 Web 共用失败记录，锁定判定必须同口径')
  assert.match(read('src/services/auth.service.ts'), /clearAdminLoginFailures\(requestMeta, user\.username\)/, '登录成功必须清理规范主体的失败计数')

  // 守卫行为：先频控再解析主体；变体写法解析到已锁定的规范主体时必须拦截。
  const { persistentRiskStateService } = await import('../src/services/persistent-risk-state.service.js')
  const riskState = persistentRiskStateService as unknown as Record<string, unknown>
  const requestMeta = { ipAddress: '203.0.113.9', userAgent: null, clientRiskBrowserId: null, clientRiskSessionId: null }
  security.recordRiskEvent = async () => undefined
  try {
    let resolverCalled = false
    riskState.consumeWindow = async (_key: string, _windowMs: number, _nowMs: number, maxRequests: number) => ({
      totalHits: maxRequests + 1,
      resetTime: new Date(Date.now() + 60_000),
    })
    await assert.rejects(
      () => authSecurityService.guardClientLoginRequest(requestMeta, 'someone@example.com', async () => {
        resolverCalled = true
        return 'uid:42'
      }),
      /频繁/,
    )
    assert.equal(resolverCalled, false, '被限流的登录请求不得再查库解析账号主体')

    riskState.consumeWindow = async () => ({ totalHits: 1, resetTime: new Date(Date.now() + 60_000) })
    riskState.readFailure = async (storeKey: string) => (
      storeKey === 'client-login:account:uid:42' || storeKey === 'admin-login:user:admin'
        ? { count: 8, lockedUntil: Date.now() + 60_000 }
        : null
    )
    await assert.rejects(
      () => authSecurityService.guardClientLoginRequest(requestMeta, '13800000000', async () => 'uid:42'),
      /已临时锁定/,
      '换用手机号登录同一账号时必须命中该账号的锁定',
    )
    await assert.rejects(
      () => authSecurityService.guardAdminLoginRequest(requestMeta, 'Ádmin', async () => ({ subject: 'admin', resolved: true })),
      /已临时锁定/,
      '重音变体解析到规范用户名后必须命中锁定',
    )
  } finally {
    Reflect.deleteProperty(riskState, 'consumeWindow')
    Reflect.deleteProperty(riskState, 'readFailure')
    Reflect.deleteProperty(security, 'recordRiskEvent')
  }
}

/**
 * multer 依赖与分段上限：2.3.0 之前存在字段名/数组下标构造的解析拒绝服务与中断上传句柄泄漏，
 * 反馈附件上传对所有客户账号开放，除升级外还必须显式限制字段与分段数量。
 */
async function verifyMultipartHardening() {
  const multerVersion = (JSON.parse(read('node_modules/multer/package.json')) as { version: string }).version
  const [major, minor] = multerVersion.split('.').map(Number)
  assert.ok(major > 2 || (major === 2 && minor >= 3), `multer 必须不低于 2.3.0，当前 ${multerVersion}`)
  assert.match(read('package.json'), /"multer": "\^2\.3\.0"/, 'package.json 必须声明修复后的 multer 版本')

  const { createCategorizedImageUpload } = await import('../src/utils/upload-storage.js')
  const { errorHandler } = await import('../src/middleware/error-handler.js')
  const app = express()
  app.post('/probe', createCategorizedImageUpload('client-feedback').single('file'), (_req, res) => {
    res.json({ ok: true })
  })
  app.use(errorHandler)
  const server = app.listen(0, '127.0.0.1')
  try {
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    const { port } = server.address() as AddressInfo
    const form = new FormData()
    for (let index = 0; index < 12; index += 1) form.append(`field[${index}]`, 'x')
    const response = await fetch(`http://127.0.0.1:${port}/probe`, { method: 'POST', body: form })
    assert.equal(response.status, 400, '超量字段的 multipart 请求必须被拒绝')
    const oversizedFieldForm = new FormData()
    oversizedFieldForm.append('filler', 'y'.repeat(2048))
    const oversizedField = await fetch(`http://127.0.0.1:${port}/probe`, { method: 'POST', body: oversizedFieldForm })
    assert.equal(oversizedField.status, 400, '超长字段值必须触发字段大小上限')
    const oversizedIndexForm = new FormData()
    oversizedIndexForm.append('a[99999999]', 'x')
    const oversizedIndex = await fetch(`http://127.0.0.1:${port}/probe`, { method: 'POST', body: oversizedIndexForm })
    assert.ok(oversizedIndex.status < 500, '超大数组下标字段不得导致服务端异常')
    const healthyForm = new FormData()
    healthyForm.append('note', 'ok')
    const healthy = await fetch(`http://127.0.0.1:${port}/probe`, { method: 'POST', body: healthyForm })
    assert.equal(healthy.status, 200, '异常 multipart 请求之后服务必须仍可正常处理请求')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  assert.match(read('src/routes/system-config.routes.ts'), /fileSize: STAFF_DIRECTORY_IMPORT_MAX_FILE_SIZE,\s*files: 1,\s*fields: 4,\s*parts: 5,/, '教职工目录导入必须限制分段数量')
  assert.match(read('src/routes/product.routes.ts'), /limits: \{ fileSize: 5 \* 1024 \* 1024, files: 1, fields: 4, parts: 5 \}/, '商品导入必须限制分段数量')
}

function verifyClientAbuseGuards() {
  const feedbackRoutes = read('src/routes/client-feedback.routes.ts')
  assert.match(
    feedbackRoutes,
    /'\/attachments',[\s\S]{0,200}consumeAttachmentUploadRate\([\s\S]{0,160}feedbackAttachmentUpload\.single\('file'\)/,
    '反馈附件频控必须在接收文件与图片处理之前计次',
  )
  const feedbackService = read('src/services/client-feedback.service.ts')
  const createStart = feedbackService.indexOf('  async createClientAttachment(')
  const createSource = feedbackService.slice(createStart, feedbackService.indexOf('\n  }\n', createStart))
  assert.doesNotMatch(createSource, /this\.consumeAttachmentUploadRate\(/, '建档阶段不得重复消耗上传频控额度')

  const authSecurity = read('src/services/auth-security.service.ts')
  assert.match(authSecurity, /clientProfileVerificationSendByUser: \{\s*maxRequests: 10,\s*windowMs: 24 \* 60 \* 60 \* 1000/, '资料发码必须有账号日上限')
  assert.match(
    read('src/routes/client-auth.routes.ts'),
    /guardClientProfileVerificationSend\(requestMeta, authReq\.clientAuth\.userId\)\s*\n\s*await authSecurityService\.guardVerificationCodeSendRequest/,
    '资料发码必须先按账号封顶再走通用频控',
  )

  const frontendAttachment = readRepo('src/api/modules/customer-service-feedback.ts')
  assert.match(frontendAttachment, /resolvedUrl\.protocol === 'http:' \|\| resolvedUrl\.protocol === 'https:'/, '前端附件地址只允许 http/https 协议')

  assert.match(read('src/services/notification.service.ts'), /后台处理周期失败', toSafeErrorLog\(error\)/, '通知外发后台错误必须脱敏记录')
  assert.match(read('src/runtime/business-runtime.ts'), /resume automatic database migration failed:', 'red'\), toSafeErrorLog\(error\)/, '迁移续跑错误必须脱敏记录')
}

/**
 * JSON 导入会先清空商品、客户端账号、预订单、库存流水与系统配置：
 * 默认关闭；开启后必须先复核本人密码、再按永久删除类操作要求口令并限流，口令通过前不得进入清表逻辑。
 */
async function verifyJsonImportRequiresPermanentDeletePassword() {
  const { env } = await import('../src/config/env.js')
  const { auditService } = await import('../src/services/audit.service.js')
  const { authService } = await import('../src/services/auth.service.js')
  const { BizError } = await import('../src/utils/errors.js')
  const { dataMaintenanceService } = await import('../src/services/data-maintenance.service.js')
  const { dataMaintenanceRouter } = await import('../src/routes/data-maintenance.routes.js')
  const { errorHandler } = await import('../src/middleware/error-handler.js')

  const mutableEnv = env as { PERMANENT_DELETE_PASSWORD?: string; Y_LINK_JSON_DATA_TRANSFER_ENABLED?: boolean }
  const originalPassword = mutableEnv.PERMANENT_DELETE_PASSWORD
  const originalTransferEnabled = mutableEnv.Y_LINK_JSON_DATA_TRANSFER_ENABLED
  const service = dataMaintenanceService as unknown as Record<string, unknown>
  const audit = auditService as unknown as Record<string, unknown>
  const auth = authService as unknown as Record<string, unknown>
  const importedPayloads: Array<Record<string, unknown>> = []
  const failureAudits: string[] = []
  mutableEnv.PERMANENT_DELETE_PASSWORD = 'Verify-Import-Pass-123'
  mutableEnv.Y_LINK_JSON_DATA_TRANSFER_ENABLED = false
  service.importJson = async (payload: Record<string, unknown>) => {
    importedPayloads.push(payload)
    return { imported: {} }
  }
  // 本人密码复核依赖数据库，这里以同签名桩替换，只验证路由的调用顺序与拒绝语义。
  auth.verifyStepUpPassword = async (_auth: unknown, password: string) => {
    if (password !== 'verify-current-password') throw new BizError('当前密码错误，身份复核未通过', 400)
  }
  audit.safeRecord = async (input: { resultStatus?: string; detail?: { reason?: string } }) => {
    if (input.resultStatus === 'failed') failureAudits.push(String(input.detail?.reason ?? ''))
  }

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as unknown as { auth: Record<string, unknown> }).auth = {
      userId: 'verify-admin',
      username: 'verify-admin',
      displayName: '验证管理员',
      role: 'admin',
      permissions: ['data_maintenance:import'],
      status: 'enabled',
      sessionToken: 'verify-session',
      authSource: 'bearer',
    }
    next()
  })
  app.use('/api/data-maintenance', dataMaintenanceRouter)
  app.use(errorHandler)
  const server = app.listen(0, '127.0.0.1')
  const basePayload = { exportedAt: '2026-09-27T00:00:00.000Z', version: 'verify', tables: {}, currentPassword: 'verify-current-password' }
  try {
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    const { port } = server.address() as AddressInfo
    const post = (body: Record<string, unknown>) => fetch(`http://127.0.0.1:${port}/api/data-maintenance/import/json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    // 频控按账号计每一次请求：以下 5 次放行、第 6 次 429。
    assert.equal((await post({ ...basePayload, permanentDeletePassword: 'Verify-Import-Pass-123' })).status, 403, '未开启时必须拒绝')
    mutableEnv.Y_LINK_JSON_DATA_TRANSFER_ENABLED = true
    assert.equal((await post({ ...basePayload, currentPassword: 'wrong-current', permanentDeletePassword: 'Verify-Import-Pass-123' })).status, 400, '本人密码复核失败必须拒绝')
    assert.equal((await post(basePayload)).status, 400, '缺少永久删除口令必须拒绝')
    assert.equal((await post({ ...basePayload, permanentDeletePassword: 'wrong-pass' })).status, 403, '口令错误必须拒绝')
    assert.equal(importedPayloads.length, 0, '复核与口令通过前不得进入清表导入逻辑')
    assert.deepEqual(failureAudits, ['disabled', 'password_missing', 'password_rejected'], '开关拒绝与口令拒绝必须写脱敏失败审计')
    assert.equal((await post({ ...basePayload, permanentDeletePassword: 'Verify-Import-Pass-123' })).status, 200)
    assert.equal(importedPayloads.length, 1)
    assert.ok(!('permanentDeletePassword' in importedPayloads[0]), '口令不得透传进导入服务与审计')
    assert.ok(!('currentPassword' in importedPayloads[0]), '本人密码不得透传进导入服务与审计')
    assert.equal((await post(basePayload)).status, 429, 'JSON 导入必须按账号限流')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    mutableEnv.PERMANENT_DELETE_PASSWORD = originalPassword
    mutableEnv.Y_LINK_JSON_DATA_TRANSFER_ENABLED = originalTransferEnabled
    Reflect.deleteProperty(service, 'importJson')
    Reflect.deleteProperty(audit, 'safeRecord')
    Reflect.deleteProperty(auth, 'verifyStepUpPassword')
  }
}

/** 操作员也持有 products:manage / tags:manage：改价、上下架、删除等写入口必须留审计。 */
function verifyCatalogWriteAudits() {
  const productService = read('src/services/product.service.ts')
  for (const actionType of ['product.create', 'product.batch_create', 'product.update', 'product.batch_update', 'product.delete']) {
    assert.ok(productService.includes(`'${actionType}'`), `商品写入口缺少 ${actionType} 审计`)
  }
  assert.match(productService, /const auditBefore = await this\.captureProductAuditSnapshot\(product, manager\)[\s\S]{0,4000}buildProductAuditChanges\(auditBefore/, '商品编辑必须在锁内拍快照并按差异写审计')
  assert.match(productService, /costPriceChanged = true/, '成本价只记录是否变更，不得展开数值')
  const tagService = read('src/services/tag.service.ts')
  for (const actionType of ['tag.create', 'tag.update', 'tag.delete']) {
    assert.ok(tagService.includes(`'${actionType}'`), `标签写入口缺少 ${actionType} 审计`)
  }
  const catalog = read('src/constants/audit-action-catalog.ts')
  for (const actionType of ['product.create', 'product.batch_create', 'product.update', 'product.batch_update', 'product.delete', 'tag.create', 'tag.update', 'tag.delete']) {
    assert.ok(catalog.includes(`'${actionType}'`), `审计目录缺少 ${actionType}`)
  }
}

/**
 * 中高危操作审计覆盖：认证成功/失败、找回密码、发码、救援凭证、迁移预检、下单、手工入库与合规标记都必须留痕，
 * 且动作全部登记在审计目录中。
 */
function verifySensitiveOperationAuditCoverage() {
  const catalog = read('src/constants/audit-action-catalog.ts')
  const expectations: Array<[string, string]> = [
    ['src/services/client-auth.service.ts', 'client.auth.register'],
    ['src/services/client-auth.service.ts', 'client.auth.reauth_failed'],
    ['src/services/client-auth.service.ts', 'client.auth.forgot_password.verify'],
    ['src/services/verification-code.service.ts', 'client.auth.verification_code.send'],
    ['src/routes/data-maintenance.routes.ts', 'database_migration.issue_rescue_credential'],
    ['src/routes/data-maintenance.routes.ts', 'database_migration.precheck'],
    ['src/services/o2o-preorder.service.ts', 'o2o.preorder.submit'],
    ['src/services/o2o-preorder.service.ts', 'o2o.preorder.compliance_flags'],
    ['src/services/o2o-preorder.service.ts', 'inventory.manual_inbound'],
  ]
  for (const [file, actionType] of expectations) {
    assert.ok(read(file).includes(`'${actionType}'`), `${file} 缺少 ${actionType} 审计`)
    assert.ok(catalog.includes(`'${actionType}'`), `审计目录缺少 ${actionType}`)
  }
  const clientAuthService = read('src/services/client-auth.service.ts')
  const loginStart = clientAuthService.indexOf('  async login(')
  assert.match(clientAuthService.slice(loginStart, loginStart + 1200), /actionType: 'client\.auth\.login'[\s\S]{0,400}requestMeta/, '客户端登录成功必须写带来源的审计')
  assert.match(clientAuthService, /reason: 'user_disabled'/, '停用账号登录尝试必须留痕')
  assert.match(read('src/routes/data-maintenance.routes.ts'), /detail: \{ host: payload\.target\.host, port: payload\.target\.port, database: payload\.target\.database, user: payload\.target\.user, \.\.\.detail \}/, '迁移预检审计不得记录密码')
}

/** 会话内旧密码复核必须计入账号失败锁定；联系方式一经注册即占用；退货申请与 Web 会话数量封顶。 */
async function verifyRegisteredAccountAbuseGuards() {
  const { authSecurityService } = await import('../src/services/auth-security.service.js')
  const { persistentRiskStateService } = await import('../src/services/persistent-risk-state.service.js')
  const riskState = persistentRiskStateService as unknown as Record<string, unknown>
  const security = authSecurityService as unknown as Record<string, unknown>
  const requestMeta = { ipAddress: '203.0.113.10', userAgent: null, clientRiskBrowserId: null, clientRiskSessionId: null }
  security.recordRiskEvent = async () => undefined
  riskState.readFailure = async (storeKey: string) => (
    storeKey === 'client-login:account:uid:77' || storeKey === 'admin-login:user:admin'
      ? { count: 8, firstFailedAt: Date.now(), lastFailedAt: Date.now(), lockedUntil: Date.now() + 60_000 }
      : null
  )
  try {
    await assert.rejects(() => authSecurityService.assertClientPasswordReauthAllowed(requestMeta, '77'), /已临时锁定/, '客户端旧密码复核必须受账号锁定约束')
    await assert.rejects(() => authSecurityService.assertAdminPasswordReauthAllowed(requestMeta, 'Admin'), /已临时锁定/, '管理端旧密码复核必须受账号锁定约束')
    await authSecurityService.assertClientPasswordReauthAllowed(requestMeta, '78')
  } finally {
    Reflect.deleteProperty(riskState, 'readFailure')
    Reflect.deleteProperty(security, 'recordRiskEvent')
  }

  const clientAuthService = read('src/services/client-auth.service.ts')
  assert.match(clientAuthService, /assertClientPasswordReauthAllowed\(requestMeta, auth\.userId\)[\s\S]{0,1200}recordCurrentPasswordFailure\(auth, requestMeta, 'change_password'\)/, '客户端改密必须先判锁定、失败计数')
  assert.match(clientAuthService, /if \(!manager\) await authSecurityService\.assertClientPasswordReauthAllowed\(requestMeta, user\.id\)[\s\S]{0,300}recordCurrentPasswordFailure\(auth, requestMeta, 'update_profile'\)/, '客户端改资料旧密码复核必须计入锁定')
  const authService = read('src/services/auth.service.ts')
  assert.match(authService, /assertAdminPasswordReauthAllowed\(requestMeta, auth\.username\)[\s\S]{0,4000}recordAdminLoginFailure\(requestMeta, auth\.username\)/, '管理端本人改密必须计入账号锁定')
  assert.doesNotMatch(clientAuthService, /releaseUnverifiedContactClaims|isUnverifiedContactClaimReleasable/, '手机号/邮箱一经注册即占用，未验证也不得被他人接管')
  assert.match(clientAuthService, /const CLIENT_WEB_MAX_ACTIVE_SESSIONS = 20/, '客户端 Web 会话必须封顶')
  assert.match(
    clientAuthService,
    /if \(isTeacherRegister\) \{[\s\S]{0,900}if \(account\) \{[\s\S]{0,400}verifyRegisterChallenge\(input, validationMode, account, \{ forceVerificationCode: true \}\)/,
    '教师注册填写联系方式时必须校验验证码',
  )
  assert.match(readRepo('src/views/client/ClientAuthView.vue'), /teacherContactRequiresVerification && registerUsesVerificationCode/, '教师注册表单填写联系方式后必须展示验证码输入')
  assert.match(read('src/routes/o2o.routes.ts'), /guardClientBusinessWrite\([^;]{0,160}'return_request_create'\)/, '退货申请必须按账号限频')
  assert.match(read('src/services/auth-security.service.ts'), /clientReturnRequestCreateByUser: \{\s*maxRequests: 10,/, '退货申请频控阈值')
}

async function verifyProfileVerificationSendCap() {
  const { authSecurityService } = await import('../src/services/auth-security.service.js')
  const { persistentRiskStateService } = await import('../src/services/persistent-risk-state.service.js')
  const riskState = persistentRiskStateService as unknown as Record<string, unknown>
  const security = authSecurityService as unknown as Record<string, unknown>
  const consumed: string[] = []
  riskState.consumeWindow = async (key: string, _windowMs: number, _nowMs: number, maxRequests: number) => {
    consumed.push(`${key}|${maxRequests}`)
    return { totalHits: maxRequests + 1, resetTime: new Date(Date.now() + 60_000) }
  }
  security.recordRiskEvent = async () => undefined
  try {
    await assert.rejects(
      () => authSecurityService.guardClientProfileVerificationSend(
        { ipAddress: '127.0.0.1', userAgent: null, clientRiskBrowserId: null, clientRiskSessionId: null },
        'client-user-1',
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error && /今日验证码发送次数已达上限/.test(error.message))
        return true
      },
    )
    assert.deepEqual(consumed, ['client-profile-verification-send:user:client-user-1|10'], '资料发码账号日上限必须按账号 ID 计桶')
  } finally {
    Reflect.deleteProperty(riskState, 'consumeWindow')
    Reflect.deleteProperty(security, 'recordRiskEvent')
  }
}

async function main() {
  await verifyMalformedJsonIsClientErrorWithoutBodyLog()
  await verifyProviderTemplateEscaping()
  await verifyCaptchaOneShot()
  await verifyAdminSessionIdleTimeout()
  verifyPermanentDeleteGuards()
  await verifyPermanentDeletePasswordSharedBucket()
  verifySelfPasswordAndClientWriteGuards()
  verifyOneboxUploadBoundaryAndImportGuard()
  await verifyLoginLockUsesCanonicalSubject()
  await verifyMultipartHardening()
  verifyClientAbuseGuards()
  await verifyProfileVerificationSendCap()
  await verifyJsonImportRequiresPermanentDeletePassword()
  verifyCatalogWriteAudits()
  verifySensitiveOperationAuditCoverage()
  await verifyRegisteredAccountAbuseGuards()
  console.log('[web-deep-audit] 深度审计修复回归通过：畸形 JSON、模板转义、验证码一次性、空闲超时、永久删除限流与跨入口共享口令桶、本人改密、客户端频控、onebox 上传边界、导入预检、登录锁定主体、multipart 加固、附件与资料发码频控、JSON 导入口令、商品与标签审计、中高危操作审计覆盖、会话内旧密码锁定、联系方式接管、退货与会话封顶')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
