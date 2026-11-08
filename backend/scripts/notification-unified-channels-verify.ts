/**
 * 模块说明：通知共用连接与送货单外发的隔离验收。
 * 文件职责：在唯一临时 SQLite 中验证真实路由、治理事务、加密兼容、业务 outbox 与接收边界。
 * 实现逻辑：只替换邮件/飞书网络发送，真实调用送货单提交、规则解析、外发去重、失败重试及审计。
 * 维护说明：测试账号与密钥仅存在于本次临时目录；不加载或修改真实数据库，不进行真实外发。
 */
import 'reflect-metadata'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import express from 'express'
import type { AuthUserContext, AuthenticatedRequest } from '../src/types/auth.js'
import type { UpdateNotificationRuleInput } from '../src/services/notification.service.js'

const runId = `${process.pid}-${Date.now()}`
// 独占目录与空 env 文件均由本次进程创建；不能继承调用者的 ENV_FILE/profile/runtime 覆盖。
const runtimeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ylink-notification-unified-')))
const sqlitePath = path.join(runtimeDir, 'verify.sqlite')
const ownedEnvFile = path.join(runtimeDir, 'isolated.env')
fs.writeFileSync(ownedEnvFile, '', { flag: 'wx', mode: 0o600 })
process.env.NODE_ENV = 'test'
process.env.APP_PROFILE = `notification-unified-${runId}`
process.env.ENV_FILE = ownedEnvFile
process.env.Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE = 'true'
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'true'
process.env.DB_AUTO_MIGRATE = 'false'
process.env.REDIS_URL = ''
process.env.ALIYUN_DYPNS_MNS_ENABLED = 'false'
process.env.SQLITE_DB_PATH = sqlitePath
process.env.Y_LINK_DATA_DIR = runtimeDir
process.env.Y_LINK_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const sharedUrl = 'https://open.feishu.cn/open-apis/bot/v2/hook/shared-fixture'
const legacyA = 'https://open.feishu.cn/open-apis/bot/v2/hook/legacy-a-fixture'
const legacyB = 'https://open.feishu.cn/open-apis/bot/v2/hook/legacy-b-fixture'
const secretFixture = 'notification-sign-fixture'

async function main() {
  const { AppDataSource } = await import('../src/config/data-source.js')
  const { appDataPaths } = await import('../src/config/app-data-paths.js')
  const { env, envLoadContext } = await import('../src/config/env.js')
  const assertOwnedTarget = (database: unknown) => {
    if (typeof database !== 'string' || path.resolve(database) !== sqlitePath) throw new Error('ISOLATION_DATABASE_TARGET_MISMATCH')
  }
  // 必须核对已经过 env/profile/runtime override 解析的真实数据源及冻结数据目录，再允许任何 mkdir/初始化/同步。
  assert.equal(AppDataSource.isInitialized, false, 'ISOLATION_ALREADY_INITIALIZED')
  assert.equal(AppDataSource.options.type, 'sqlite', 'ISOLATION_DATABASE_TYPE_MISMATCH')
  assertOwnedTarget(AppDataSource.options.database)
  assert.equal(path.resolve(appDataPaths.rootDir), runtimeDir, 'ISOLATION_DATA_ROOT_MISMATCH')
  assert.equal(fs.realpathSync(appDataPaths.rootDir), runtimeDir, 'ISOLATION_DATA_ROOT_ALIAS_MISMATCH')
  assert.equal(path.resolve(process.env.Y_LINK_DATA_DIR || ''), runtimeDir, 'ISOLATION_EFFECTIVE_DATA_DIR_MISMATCH')
  assert.equal(path.resolve(env.SQLITE_DB_PATH), sqlitePath, 'ISOLATION_EFFECTIVE_SQLITE_MISMATCH')
  assert.equal(envLoadContext.requestedEnvFile, ownedEnvFile, 'ISOLATION_ENV_FILE_MISMATCH')
  assert.equal(envLoadContext.requestedProfile, `notification-unified-${runId}`, 'ISOLATION_PROFILE_MISMATCH')
  assert.equal(env.APP_PROFILE, `notification-unified-${runId}`, 'ISOLATION_EFFECTIVE_PROFILE_MISMATCH')
  assert.equal(path.resolve(env.ENV_FILE || ''), ownedEnvFile, 'ISOLATION_EFFECTIVE_ENV_FILE_MISMATCH')
  assert.equal(process.env.Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE, 'true', 'ISOLATION_RUNTIME_OVERRIDE_NOT_DISABLED')
  assert.equal(envLoadContext.runtimeDatabaseOverrideLoaded, false, 'ISOLATION_RUNTIME_OVERRIDE_LOADED')
  for (const value of Object.values(appDataPaths)) {
    const relative = path.relative(runtimeDir, value)
    assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), 'ISOLATION_DERIVED_PATH_ESCAPED')
  }
  if (process.argv.includes('--isolation-probe')) {
    assert.throws(() => assertOwnedTarget(path.join(runtimeDir, 'sentinel.sqlite')), /ISOLATION_DATABASE_TARGET_MISMATCH/)
    assert.equal(fs.existsSync(sqlitePath), false, 'probe不得创建数据库')
    console.log('OK 通知隔离探针：实际type/database/dataRoot已核对；错误目标在初始化前拒绝；initialized=false；未创建数据库或外发')
    return
  }
  const { prepareDatabaseRuntime, initializeDatabaseSchemaIfNeeded } = await import('../src/config/database-bootstrap.js')
  const { initializeDatabaseInfrastructure } = await import('../src/database/database-strategy.js')
  const { notificationService } = await import('../src/services/notification.service.js')
  const { notificationChannelConfigService, FEISHU_SIGN_SECRET_PLACEHOLDER, FEISHU_WEBHOOK_PLACEHOLDER } = await import('../src/services/notification-channel-config.service.js')
  const { systemConfigService } = await import('../src/services/system-config.service.js')
  const { NotificationRule } = await import('../src/entities/notification-rule.entity.js')
  const { NotificationEvent } = await import('../src/entities/notification-event.entity.js')
  const { NotificationInbox } = await import('../src/entities/notification-inbox.entity.js')
  const { SystemConfig } = await import('../src/entities/system-config.entity.js')
  const { SysUser } = await import('../src/entities/sys-user.entity.js')
  const { SysUserSession } = await import('../src/entities/sys-user-session.entity.js')
  const { SysAuditLog } = await import('../src/entities/sys-audit-log.entity.js')
  const { productService } = await import('../src/services/product.service.js')
  const { inboundService } = await import('../src/services/inbound.service.js')
  const { notificationRouter } = await import('../src/routes/notification.routes.js')
  const { resolvePermissionsByRole } = await import('../src/constants/auth-permissions.js')
  const { resetDataEncryptionKeyCacheForTesting, sealSensitiveValue } = await import('../src/utils/data-encryption.js')
  prepareDatabaseRuntime()
  await AppDataSource.initialize()
  await initializeDatabaseInfrastructure(AppDataSource)
  await initializeDatabaseSchemaIfNeeded(AppDataSource)
  const users = AppDataSource.getRepository(SysUser)
  const configs = AppDataSource.getRepository(SystemConfig)
  const rules = AppDataSource.getRepository(NotificationRule)
  const events = AppDataSource.getRepository(NotificationEvent)
  const inbox = AppDataSource.getRepository(NotificationInbox)
  const audits = AppDataSource.getRepository(SysAuditLog)
  const account = async (name: string, role: SysUser['role']) => users.save(users.create({
    username: `${name}_${runId}`, displayName: name, passwordHash: 'isolated_fixture_unused', role, status: 'enabled', email: `${name}@example.com`,
  }))
  const admin = await account('admin', 'admin')
  const operator = await account('operator', 'operator')
  const supplier = await account('supplier', 'supplier')
  const otherSupplier = await account('supplier_other', 'supplier')
  const actorOf = (user: SysUser): AuthUserContext => ({ userId: String(user.id), username: user.username, displayName: user.displayName, role: user.role, permissions: resolvePermissionsByRole(user.role), status: 'enabled', authSource: 'bearer', sessionToken: 'isolated_fixture' })
  const adminActor = actorOf(admin)
  const supplierActor = actorOf(supplier)

  // 真实路由与权限中间件；认证上下文为本机隔离 fixture，治理服务仍必须复核数据库中当前账号。
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { (req as AuthenticatedRequest).auth = req.header('x-fixture-role') === 'operator' ? actorOf(operator) : adminActor; next() })
  app.use('/notifications', notificationRouter)
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const failure = error as { statusCode?: number; status?: number; message?: string }
    res.status(failure.statusCode ?? failure.status ?? 500).json({ message: failure.message })
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}/notifications`
  const http = async (route: string, method = 'GET', body?: unknown, role?: string) => {
    const response = await fetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json', ...(role ? { 'x-fixture-role': role } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, data: await response.json() as { data?: unknown; message?: string } }
  }
  try {
    // 连默认配置都未初始化时读取不得补写；拦截实际 ORM 查询而不是只检查最终行数。
    const configCountBeforeReads = await configs.count()
    const ruleCountBeforeReads = await rules.count()
    const writes: string[] = []
    let watchWrites = true
    const originalLogQuery = AppDataSource.logger.logQuery.bind(AppDataSource.logger)
    AppDataSource.logger.logQuery = (query, parameters, runner) => {
      if (watchWrites && /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i.test(query)) writes.push(query.split(/\s+/)[0]!)
      originalLogQuery(query, parameters, runner)
    }
    assert.equal((await http('/channels')).status, 200)
    assert.equal((await http('/rules')).status, 200)
    assert.equal((await http('/presence-snapshot')).status, 200)
    assert.deepEqual(writes, [], '读取通知配置、规则及在线态必须零写入')
    watchWrites = false
    assert.equal(await configs.count(), configCountBeforeReads, 'GET 不得增改启动自举已存在的默认配置')
    assert.equal(await rules.count(), ruleCountBeforeReads, 'GET 不得补写缺失规则')
    assert.equal((await http('/channels', 'PUT', {}, 'operator')).status, 403)

    await systemConfigService.ensureDefaultConfigs()
    await notificationService.ensureDefaultRules()
    const newInbound = await rules.findOneByOrFail({ ruleCode: 'inbound_submitted_rule' })
    assert.equal(newInbound.externalTriggerMode, 'always', '仅新建送货单默认规则使用立即外发')
    await rules.update({ id: newInbound.id }, { externalTriggerMode: 'watched_accounts_offline' })
    await notificationService.ensureDefaultRules()
    assert.equal((await rules.findOneByOrFail({ id: newInbound.id })).externalTriggerMode, 'watched_accounts_offline', '启动补齐不得升级已持久规则的时机')
    const preorder = await rules.findOneByOrFail({ ruleCode: 'preorder_created_rule' })
    const customer = await rules.findOneByOrFail({ ruleCode: 'customer_service_message_rule' })
    const mobile = await rules.findOneByOrFail({ ruleCode: 'mobile_refresh_replay_rule' })
    await rules.update({ id: preorder.id }, { feishuWebhookUrl: legacyA, feishuSignSecret: secretFixture, emailSubjectPrefix: '[旧订单]' })
    await rules.update({ id: customer.id }, { feishuWebhookUrl: legacyB })
    await rules.update({ id: mobile.id }, { feishuWebhookUrl: legacyB, feishuSignSecret: secretFixture, emailEnabled: 1, emailRecipientAdminUserIdsJson: '[]' })
    const rawRules = () => AppDataSource.manager.query('SELECT * FROM notification_rule ORDER BY id') as Promise<Array<Record<string, unknown>>>
    const originals = await rawRules()
    const mobileOriginal = originals.find((row) => String(row.id) === String(mobile.id))
    const initialChannels = await notificationChannelConfigService.getChannels()
    assert.equal(initialChannels.feishu.legacyRuleCount, 3)
    assert.equal((await notificationService.listRules()).find((row) => row.id === String(preorder.id))!.useSharedFeishu, false)

    // stale 身份仍显示管理员，锁后的当前账号停用、降级及权限移除均必须阻断两类治理写及测试发送。
    const draft = async (id: string): Promise<UpdateNotificationRuleInput> => {
      const row = (await notificationService.listRules()).find((item) => item.id === String(id))!
      return { ...row, feishuWebhookUrl: '', feishuSignSecret: '' }
    }
    const staleDraft = await draft(preorder.id)
    for (const patch of [{ status: 'disabled' as const }, { role: 'operator' as const }, { governancePermissionsJson: '[]' }]) {
      await users.update({ id: admin.id }, patch)
      await assert.rejects(() => notificationChannelConfigService.updateChannels({ emailSubjectPrefix: '[禁止]' }, adminActor), /停用|失效|权限不足/)
      await assert.rejects(() => notificationService.updateRules([staleDraft], 120, adminActor), /停用|失效|权限不足/)
      await assert.rejects(() => notificationService.testSendByRule({ ruleId: preorder.id, channel: 'feishu', draft: staleDraft, actor: adminActor }), /停用|失效|权限不足/)
      await users.update({ id: admin.id }, { status: 'enabled', role: 'admin', governancePermissionsJson: null })
    }

    const saved = await http('/channels', 'PUT', { feishuWebhookUrl: sharedUrl, feishuSignSecret: secretFixture })
    assert.equal(saved.status, 200)
    assert.deepEqual(await rawRules(), originals, '保存共用连接不得迁移、清空或重加密任何旧规则')
    assert.equal((await notificationChannelConfigService.getChannels()).emailSubjectPrefixConfigured, false)
    const rawShared = await configs.findOneByOrFail({ configKey: 'notification.feishu.webhook_url' })
    const rawSign = await configs.findOneByOrFail({ configKey: 'notification.feishu.sign_secret' })
    assert.ok(rawShared.configValue.startsWith('ylenc:v1:'))
    assert.ok(!JSON.stringify(saved).includes(sharedUrl) && !JSON.stringify(saved).includes(secretFixture), '共用连接响应不能回显密钥')
    await notificationChannelConfigService.updateChannels({ feishuWebhookUrl: FEISHU_WEBHOOK_PLACEHOLDER, feishuSignSecret: '' }, adminActor)
    assert.equal((await configs.findOneByOrFail({ id: rawShared.id })).configValue, rawShared.configValue)
    assert.equal((await configs.findOneByOrFail({ id: rawSign.id })).configValue, rawSign.configValue)
    assert.equal((await http('/channels', 'PUT', { clearFeishuWebhook: true, feishuWebhookUrl: sharedUrl })).status, 400)
    assert.equal((await http('/channels', 'PUT', { feishuWebhookUrl: 'http://127.0.0.1/hook' })).status, 400)

    const beforeAdopt = await draft(preorder.id)
    const omittedLegacy = { ...beforeAdopt }
    delete omittedLegacy.feishuWebhookUrl
    delete omittedLegacy.feishuSignSecret
    delete omittedLegacy.emailSubjectPrefix
    assert.equal((await http('/rules', 'PUT', { offlineWindowSeconds: 120, rules: [omittedLegacy] })).status, 200)
    assert.deepEqual((await rawRules()).find((row) => String(row.id) === String(preorder.id)), originals.find((row) => String(row.id) === String(preorder.id)), '真实 HTTP 省略旧连接与主题字段必须保留整行原值')
    await notificationService.updateRules([{ ...beforeAdopt, useSharedFeishu: true, feishuEnabled: true }], 120, adminActor)
    assert.equal((await http('/rules', 'PUT', { offlineWindowSeconds: 120, rules: [{ ...omittedLegacy, useSharedFeishu: true, feishuEnabled: true }] })).status, 200)
    assert.equal((await draft(preorder.id)).useSharedFeishu, true)
    const sharedWithLegacy = (await notificationService.listRules()).find((row) => row.id === String(preorder.id))!
    assert.equal(sharedWithLegacy.feishuConfigSource, 'shared')
    assert.equal(sharedWithLegacy.legacyFeishuWebhookConfigured, true, '保存统一来源后仍独立展示旧目标存在')
    assert.equal(sharedWithLegacy.legacyFeishuStatusError, null)
    assert.ok(!JSON.stringify(sharedWithLegacy).includes(legacyA) && !JSON.stringify(sharedWithLegacy).includes(secretFixture))
    assert.equal((await rawRules()).find((row) => String(row.id) === String(preorder.id))!.feishu_webhook_url, originals.find((row) => String(row.id) === String(preorder.id))!.feishu_webhook_url)
    assert.equal((await draft(customer.id)).useSharedFeishu, false, '其它旧目标不得自动切换')
    assert.deepEqual((await rawRules()).find((row) => String(row.id) === String(mobile.id)), mobileOriginal, '省略隐藏 Mobile 行必须保留整行原值')
    await assert.rejects(() => notificationService.updateRules([{ ...beforeAdopt, useSharedFeishu: true, feishuWebhookUrl: legacyA }], 120, adminActor), /不能同时修改/)
    await notificationService.updateRules([{ ...(await draft(preorder.id)), useSharedFeishu: false }], 120, adminActor)
    assert.equal((await draft(preorder.id)).useSharedFeishu, false, '显式选择可回退原 legacy')
    assert.equal((await notificationService.listRules()).find((row) => row.id === String(preorder.id))!.feishuConfigSource, 'legacy')
    await notificationService.updateRules([{ ...beforeAdopt, useSharedFeishu: undefined, feishuWebhookUrl: legacyA, feishuSignSecret: FEISHU_SIGN_SECRET_PLACEHOLDER }], 120, adminActor)
    assert.equal((await draft(preorder.id)).useSharedFeishu, false, '旧 API 明确写旧连接仍走 legacy')
    await notificationChannelConfigService.updateChannels({ emailSubjectPrefix: '[统一]' }, adminActor)
    await notificationService.updateRules([await draft(preorder.id)], 120, adminActor)
    assert.equal((await rules.findOneByOrFail({ id: preorder.id })).emailSubjectPrefix, '[旧订单]', '统一前缀优先但不覆盖旧规则主题')
    await notificationChannelConfigService.updateChannels({ emailSubjectPrefix: '' }, adminActor)
    assert.equal((await notificationChannelConfigService.getChannels()).emailSubjectPrefixConfigured, false)
    assert.equal((await draft(preorder.id)).emailSubjectPrefix, '[旧订单]', '显式空前缀恢复各规则原主题')

    // 整个加密密钥暂时不匹配：空白/占位保存只改其它配置，不损坏原密文，且绝不自动换目标或无签名发送。
    const legacyCipherBeforeWrongKey = (await rawRules()).find((row) => String(row.id) === String(preorder.id))!.feishu_webhook_url
    const originalKey = process.env.Y_LINK_DATA_ENCRYPTION_KEY
    process.env.Y_LINK_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
    resetDataEncryptionKeyCacheForTesting()
    const unreadable = await notificationChannelConfigService.getChannels()
    assert.ok(unreadable.feishu.statusError)
    assert.equal(unreadable.feishu.webhookConfigured, true)
    await notificationChannelConfigService.updateChannels({ feishuWebhookUrl: '', feishuSignSecret: FEISHU_SIGN_SECRET_PLACEHOLDER, emailSubjectPrefix: '[统一2]' }, adminActor)
    assert.equal((await configs.findOneByOrFail({ id: rawShared.id })).configValue, rawShared.configValue)
    assert.equal((await configs.findOneByOrFail({ id: rawSign.id })).configValue, rawSign.configValue)
    const unreadableLegacy = await draft(preorder.id)
    assert.equal(unreadableLegacy.useSharedFeishu, false)
    const unreadableLegacyMetadata = (await notificationService.listRules()).find((row) => row.id === String(preorder.id))!
    assert.equal(unreadableLegacyMetadata.legacyFeishuWebhookConfigured, true, '旧密文不可读仍必须标记旧目标存在')
    assert.ok(unreadableLegacyMetadata.legacyFeishuStatusError)
    await assert.rejects(() => notificationService.updateRules([{ ...unreadableLegacy, feishuEnabled: true }], 120, adminActor), /无法.*解密/)
    await notificationService.updateRules([{ ...unreadableLegacy, feishuEnabled: false }], 120, adminActor)
    assert.ok((await rawRules()).find((row) => String(row.id) === String(preorder.id))!.feishu_webhook_url === legacyCipherBeforeWrongKey, '不可解密期间不得改动最近一次显式旧连接写入后的原始密文')
    await assert.rejects(() => notificationService.testSendByRule({ ruleId: preorder.id, channel: 'feishu', draft: { ...unreadableLegacy, useSharedFeishu: true }, actor: adminActor }), /无法.*解密/)
    process.env.Y_LINK_DATA_ENCRYPTION_KEY = originalKey
    resetDataEncryptionKeyCacheForTesting()
    // 只有签名密文损坏时，Webhook 仍可用；单独重录或显式清空签名必须能够恢复。
    await configs.update({ id: rawSign.id }, { configValue: 'ylenc:v1:invalid-key:broken-sign-fixture' })
    const brokenSign = await notificationChannelConfigService.getChannels()
    assert.equal(brokenSign.feishu.webhookStatusError, null)
    assert.ok(brokenSign.feishu.signSecretStatusError)
    assert.ok(brokenSign.feishu.statusError)
    await notificationChannelConfigService.updateChannels({ feishuSignSecret: secretFixture }, adminActor)
    assert.equal((await notificationChannelConfigService.getChannels()).feishu.signSecretStatusError, null)
    await configs.update({ id: rawSign.id }, { configValue: 'ylenc:v1:invalid-key:broken-sign-fixture' })
    await notificationChannelConfigService.updateChannels({ clearFeishuSignSecret: true }, adminActor)
    assert.equal((await notificationChannelConfigService.getChannels()).feishu.signSecretConfigured, false)
    assert.equal((await notificationChannelConfigService.getChannels()).feishu.signSecretStatusError, null)
    await notificationChannelConfigService.updateChannels({ feishuSignSecret: secretFixture }, adminActor)
    await notificationChannelConfigService.updateChannels({ clearFeishuWebhook: true }, adminActor)
    assert.equal((await notificationChannelConfigService.getChannels()).feishu.webhookConfigured, false)
    await notificationChannelConfigService.updateChannels({ feishuWebhookUrl: sharedUrl }, adminActor)

    // 邮件状态读取相同真源，不回显网关模板；坏密文必须带状态错误。
    await configs.update({ configKey: 'verification.email.enabled' }, { configValue: '1' })
    await configs.update({ configKey: 'verification.email.api_url' }, { configValue: sealSensitiveValue('system_config:verification.email.api_url', 'https://mail.example.com/send') })
    assert.deepEqual((await notificationChannelConfigService.getChannels()).email, { enabled: true, configured: true, statusError: null })
    const oldHeaders = await configs.findOneByOrFail({ configKey: 'verification.email.headers_template' })
    await configs.update({ id: oldHeaders.id }, { configValue: 'ylenc:v1:invalid-key:broken-fixture' })
    assert.ok((await notificationChannelConfigService.getChannels()).email.statusError)
    await configs.update({ id: oldHeaders.id }, { configValue: oldHeaders.configValue })

    const sends: Array<{ channel: string; destination: string; subject: string }> = []
    let failFeishu = false
    const stub = notificationService as unknown as {
      sendEmailByVerificationProvider: (target: string, subject: string) => Promise<{ status: number; ok: boolean }>
      sendFeishuWebhook: (target: string, subject: string) => Promise<{ status: number; ok: boolean; errorMessage?: string }>
    }
    stub.sendEmailByVerificationProvider = async (destination, subject) => { sends.push({ channel: 'email', destination, subject }); return { status: 200, ok: true } }
    stub.sendFeishuWebhook = async (destination, subject) => { sends.push({ channel: 'feishu', destination, subject }); return failFeishu ? { status: 503, ok: false, errorMessage: '隔离模拟暂时失败' } : { status: 200, ok: true } }
    await notificationService.updateRules([{ ...(await draft(preorder.id)), feishuEnabled: true, useSharedFeishu: false }], 120, adminActor)
    await notificationService.updateRules([{ ...(await draft(customer.id)), feishuEnabled: true }], 120, adminActor)
    await notificationService.emitEvent({ eventType: 'o2o_preorder_created', sourceType: 'fixture', sourceId: 'legacy-a', payload: { preorderNo: 'fixture-a' } })
    await notificationService.emitEvent({ eventType: 'customer_service_client_message_created', sourceType: 'fixture', sourceId: 'legacy-b', payload: { summary: 'fixture-b' } })
    await notificationService.runOutboxOnce()
    assert.deepEqual(sends.map((send) => send.destination), [legacyA, legacyB], '多个旧地址实际投递保留原目标')
    await notificationService.updateRules([{ ...(await draft(preorder.id)), useSharedFeishu: true }], 120, adminActor)
    await notificationService.emitEvent({ eventType: 'o2o_preorder_created', sourceType: 'fixture', sourceId: 'shared-a', payload: { preorderNo: 'fixture-shared' } })
    await notificationService.runOutboxOnce()
    assert.equal(sends.at(-1)!.destination, sharedUrl, '仅明确采用共用连接的规则切换实际投递目标')
    const beforeUnreadableWorker = sends.length
    process.env.Y_LINK_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
    resetDataEncryptionKeyCacheForTesting()
    await notificationService.emitEvent({ eventType: 'o2o_preorder_created', sourceType: 'fixture', sourceId: 'unreadable-selected-target', payload: { preorderNo: 'fixture-unreadable' } })
    await notificationService.runOutboxOnce()
    assert.equal(sends.length, beforeUnreadableWorker, '已启用连接后来不可解密时不能换目标或无签名外发')
    assert.equal((await events.findOneByOrFail({ sourceId: 'unreadable-selected-target' })).status, 'failed')
    process.env.Y_LINK_DATA_ENCRYPTION_KEY = originalKey
    resetDataEncryptionKeyCacheForTesting()
    sends.length = 0
    const inboundDraft = await draft(newInbound.id)
    await notificationService.updateRules([{ ...inboundDraft, enabled: true, useSharedFeishu: true, feishuEnabled: true, emailEnabled: true, emailRecipientAdminUserIds: [String(operator.id)], emailRecipientSupplierUserIds: [String(otherSupplier.id)], externalTriggerMode: 'always', watchedUserIds: [] }], 120, adminActor)
    const product = await productService.create({ productCode: `NT-${runId}`, productName: '通知验收商品', pinyinAbbr: 'TZYS', defaultPrice: 10, discountRate: 10, isActive: true, o2oStatus: 'unlisted', currentStock: 0, limitPerUser: 20 }, adminActor)
    const submit = () => inboundService.submitSupplierDelivery(supplierActor, { expectedArrivalAt: new Date(Date.now() + 3600_000).toISOString(), items: [{ productId: String(product.id), skuId: String(product.skus[0]!.id), qty: 2 }] })
    // 真实供货方在线，always 仍投递；两个旧模式保持原来包含供货方的在线定义。
    await AppDataSource.getRepository(SysUserSession).save({ userId: supplier.id, sessionToken: `fixture-${runId}`, expiresAt: new Date(Date.now() + 3600_000), lastAccessAt: new Date() })
    const delivery = await submit()
    assert.equal(sends.length, 0, '业务提交只落 outbox，不同步外发')
    const firstEvent = await events.findOneByOrFail({ sourceType: 'biz_inbound_order', sourceId: String(delivery.order.id) })
    assert.equal(firstEvent.status, 'pending')
    await notificationService.runOutboxOnce()
    assert.deepEqual(sends.map((send) => [send.channel, send.destination]), [['email', 'operator@example.com'], ['feishu', sharedUrl]])
    assert.ok(sends.filter((send) => send.channel === 'email').every((send) => send.subject.startsWith('[统一2]')))
    assert.equal(await inbox.count({ where: { eventId: firstEvent.id, userId: supplier.id } }), 0)
    assert.equal(await inbox.count({ where: { eventId: firstEvent.id, userId: operator.id } }), 1)

    for (const mode of ['all_management_offline', 'watched_accounts_offline'] as const) {
      await notificationService.updateRules([{ ...(await draft(newInbound.id)), externalTriggerMode: mode, watchedUserIds: mode === 'watched_accounts_offline' ? [String(supplier.id)] : [] }], 120, adminActor)
      const before = sends.length
      await submit()
      await notificationService.runOutboxOnce()
      assert.equal(sends.length, before, '旧离线模式在供货方在线时保持拦截外发')
    }
    await assert.rejects(async () => notificationService.updateRules([{ ...(await draft(newInbound.id)), externalTriggerMode: 'watched_accounts_offline', watchedUserIds: [] }], 120, adminActor), /至少需要一个/)
    await notificationService.updateRules([{ ...(await draft(newInbound.id)), externalTriggerMode: 'always', watchedUserIds: [] }], 120, adminActor)
    failFeishu = true
    const failedDelivery = await submit()
    await notificationService.runOutboxOnce()
    const failure = await events.findOneByOrFail({ sourceId: String(failedDelivery.order.id), sourceType: 'biz_inbound_order' })
    assert.equal(failure.status, 'pending', '外发失败保留已成功业务并等待重试')
    assert.equal((await inboundService.detailByVerifyCode(failedDelivery.order.verifyCode, supplierActor)).order.id, failedDelivery.order.id)
    const emailCount = sends.filter((send) => send.channel === 'email').length
    failFeishu = false
    await events.update({ id: failure.id }, { nextAttemptAt: new Date(0) })
    await notificationService.runOutboxOnce()
    assert.equal((await events.findOneByOrFail({ id: failure.id })).status, 'processed')
    assert.equal(sends.filter((send) => send.channel === 'email').length, emailCount, '成功邮件重试时不重复发送')

    // 状态变更真实核验后仅所属供货方收到站内及邮件；其它供货方和后台不收到该状态邮件。
    const statusRule = await rules.findOneByOrFail({ ruleCode: 'inbound_status_changed_rule' })
    await notificationService.updateRules([{ ...(await draft(statusRule.id)), externalTriggerMode: 'always', emailEnabled: true, emailRecipientAdminUserIds: [String(operator.id)], emailRecipientSupplierUserIds: [String(supplier.id), String(otherSupplier.id)] }], 120, adminActor)
    const beforeStatus = sends.length
    await inboundService.verifyInbound(delivery.order.verifyCode, adminActor)
    await notificationService.runOutboxOnce()
    assert.deepEqual(sends.slice(beforeStatus).map((send) => send.destination), ['supplier@example.com'])
    const statusEvent = await events.findOneByOrFail({ sourceId: String(delivery.order.id), eventType: 'inbound_order_status_changed' })
    assert.equal(await inbox.count({ where: { eventId: statusEvent.id, userId: supplier.id } }), 1)
    assert.equal(await inbox.count({ where: { eventId: statusEvent.id, userId: otherSupplier.id } }), 0)
    assert.equal(await inbox.count({ where: { eventId: statusEvent.id, userId: operator.id } }), 0)

    const auditText = JSON.stringify(await audits.find())
    for (const sensitive of [sharedUrl, legacyA, legacyB, secretFixture]) assert.ok(!auditText.includes(sensitive), '审计不包含完整 Webhook 或签名密钥')
    assert.ok(await audits.count({ where: { actionType: 'notification.channel.update' } }))
    console.log('OK 通知共用配置纯读、锁后授权、加密兼容、逐规则目标、立即/离线时机与送货单 outbox 验收通过（仅 stub 外发）')
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await notificationService.stopOutboxWorker()
    await AppDataSource.destroy()
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(() => {
  // 只清理本脚本新建的唯一临时目录；不触碰项目数据库或预览数据卷。
  fs.rmSync(runtimeDir, { recursive: true, force: true })
})
