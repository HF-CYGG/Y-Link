/**
 * 模块说明：backend/scripts/mobile-sse-session-regression-verify.ts
 * 文件职责：在隔离 SQLite 中验证客服 SSE 对 Mobile/Web/Admin 会话的只读复核语义。
 * 实现逻辑：有效 Mobile access 会话应接收业务事件并通过 idle 复核；撤销、access/absolute 过期与账号停用后必须关闭；Web 与客服会话保持既有投递行为。
 * 维护说明：脚本只保存临时令牌摘要，不输出令牌或数据库配置，也不连接业务数据库。
 */

import 'reflect-metadata'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'y-link-mobile-sse-session-'))
const sqlitePath = path.join(tempRoot, 'mobile-sse-session.sqlite')

process.env.NODE_ENV = 'test'
process.env.APP_PROFILE = 'mobile-sse-session-regression'
process.env.Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE = 'true'
process.env.Y_LINK_DATA_DIR = tempRoot
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'true'
process.env.SQLITE_DB_PATH = sqlitePath

class ControlledSseResponse extends EventEmitter {
  writableEnded = false
  destroyed = false
  writableLength = 0
  readonly writes: string[] = []

  status() { return this }
  setHeader() { return this }
  flushHeaders() {}
  write(payload: string) {
    this.writes.push(payload)
    return true
  }
  end() {
    if (!this.writableEnded) {
      this.writableEnded = true
      this.emit('close')
    }
    return this
  }
}

const delay = (durationMs: number) => new Promise<void>((resolve) => {
  globalThis.setTimeout(resolve, durationMs)
})

const waitFor = async (predicate: () => boolean, message: string) => {
  for (let remaining = 100; remaining > 0; remaining -= 1) {
    if (predicate()) return
    await delay(10)
  }
  assert.fail(message)
}

const { AppDataSource } = await import('../src/config/data-source.js')
const [
  { initializeDatabaseInfrastructure },
  { initializeDatabaseSchemaIfNeeded },
  { ClientUser },
  { ClientUserSession },
  { ClientMobileSession },
  { SysUser },
  { SysUserSession },
  { customerServiceRealtimeService },
  { generateMobileAccessToken, hashMobileToken },
  { hashSessionToken },
] = await Promise.all([
  import('../src/database/database-strategy.js'),
  import('../src/config/database-bootstrap.js'),
  import('../src/entities/client-user.entity.js'),
  import('../src/entities/client-user-session.entity.js'),
  import('../src/entities/client-mobile-session.entity.js'),
  import('../src/entities/sys-user.entity.js'),
  import('../src/entities/sys-user-session.entity.js'),
  import('../src/services/customer-service-realtime.service.js'),
  import('../src/utils/mobile-token.js'),
  import('../src/utils/session-token.js'),
])

let userSequence = 0
const createClientUser = async () => {
  userSequence += 1
  return AppDataSource.getRepository(ClientUser).save({
    mobile: `1370000${String(userSequence).padStart(4, '0')}`,
    email: `mobile-sse-${userSequence}@example.test`,
    mobileVerifiedAt: new Date(),
    emailVerifiedAt: new Date(),
    passwordHash: 'test-only-password-hash',
    realName: `SSE 回归用户${userSequence}`,
    departmentName: '',
    departmentNodeId: null,
    accountType: 'personal',
    staffNo: null,
    staffVerified: false,
    status: 'enabled',
    lastLoginAt: null,
  })
}

const createMobileSession = async (clientUserId: string) => {
  const accessToken = generateMobileAccessToken()
  const now = new Date()
  const session = await AppDataSource.getRepository(ClientMobileSession).save({
    clientUserId,
    deviceId: `00000000-0000-4000-8002-${String(userSequence).padStart(12, '0')}`,
    deviceName: 'SSE 回归设备',
    platform: 'android',
    appVersion: '1.0.0',
    accessTokenHash: hashMobileToken(accessToken),
    accessExpiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    refreshTokenHash: `r${String(userSequence).padStart(63, '0')}`,
    refreshExpiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    previousRefreshTokenHash: null,
    previousRefreshGraceUntil: null,
    refreshGeneration: 0,
    absoluteExpiresAt: new Date(now.getTime() + 2 * 60 * 60 * 1000),
    lastIp: null,
    lastAccessAt: now,
    revokedAt: null,
    revokeReason: null,
  })
  return { accessToken, session }
}

const publishClientEvent = (clientUserId: string, eventType = 'message_created') => {
  customerServiceRealtimeService.publishConversationEvent({
    eventType,
    conversationId: `mobile-sse-conversation-${clientUserId}`,
    clientUserId,
    occurredAt: new Date().toISOString(),
    conversation: { id: `mobile-sse-conversation-${clientUserId}` },
  })
}

const originalSetInterval = globalThis.setInterval
const originalClearInterval = globalThis.clearInterval
const intervalCallbacks: Array<() => void> = []
let intervalSeed = 0
globalThis.setInterval = ((callback: () => void) => {
  intervalCallbacks.push(callback)
  intervalSeed += 1
  return intervalSeed as unknown as ReturnType<typeof globalThis.setInterval>
}) as typeof globalThis.setInterval
globalThis.clearInterval = (() => undefined) as typeof globalThis.clearInterval

const triggerIdleValidation = async () => {
  const callback = intervalCallbacks.at(-1)
  assert.ok(callback, 'SSE 建连必须登记 idle 会话复核定时器')
  callback()
  await delay(30)
}

try {
  await AppDataSource.initialize()
  await initializeDatabaseInfrastructure(AppDataSource)
  await initializeDatabaseSchemaIfNeeded(AppDataSource)

  const mobileOwner = await createClientUser()
  const validMobile = await createMobileSession(mobileOwner.id)
  const validMobileResponse = new ControlledSseResponse()
  customerServiceRealtimeService.openClientStream(mobileOwner.id, validMobile.accessToken, validMobileResponse as never, 60)
  publishClientEvent(mobileOwner.id)
  await waitFor(
    () => validMobileResponse.writes.some((payload) => payload.includes('event: conversation')),
    '有效 Mobile SSE 必须接收自己的业务事件',
  )
  await triggerIdleValidation()
  assert.equal(validMobileResponse.writableEnded, false, '有效 Mobile SSE 必须通过 idle 会话复核')
  const validMobileState = await AppDataSource.getRepository(ClientMobileSession).findOneByOrFail({ id: validMobile.session.id })
  assert.equal(validMobileState.lastAccessAt.getTime(), validMobile.session.lastAccessAt.getTime(), 'SSE 会话复核必须保持只读，不更新活动时间')

  await AppDataSource.getRepository(ClientMobileSession).update(validMobile.session.id, { revokedAt: new Date(), revokeReason: 'user_logout' })
  await triggerIdleValidation()
  assert.equal(validMobileResponse.writableEnded, true, '被撤销的 Mobile SSE 必须在 idle 复核时关闭')

  const accessExpiredOwner = await createClientUser()
  const accessExpired = await createMobileSession(accessExpiredOwner.id)
  const accessExpiredResponse = new ControlledSseResponse()
  customerServiceRealtimeService.openClientStream(accessExpiredOwner.id, accessExpired.accessToken, accessExpiredResponse as never, 60)
  await AppDataSource.getRepository(ClientMobileSession).update(accessExpired.session.id, { accessExpiresAt: new Date(Date.now() - 1_000) })
  await triggerIdleValidation()
  assert.equal(accessExpiredResponse.writableEnded, true, 'access 已过期的 Mobile SSE 必须关闭')

  const absoluteExpiredOwner = await createClientUser()
  const absoluteExpired = await createMobileSession(absoluteExpiredOwner.id)
  const absoluteExpiredResponse = new ControlledSseResponse()
  customerServiceRealtimeService.openClientStream(absoluteExpiredOwner.id, absoluteExpired.accessToken, absoluteExpiredResponse as never, 60)
  await AppDataSource.getRepository(ClientMobileSession).update(absoluteExpired.session.id, { absoluteExpiresAt: new Date(Date.now() - 1_000) })
  await triggerIdleValidation()
  assert.equal(absoluteExpiredResponse.writableEnded, true, 'absolute 已过期的 Mobile SSE 必须关闭')

  const disabledOwner = await createClientUser()
  const disabledMobile = await createMobileSession(disabledOwner.id)
  const disabledResponse = new ControlledSseResponse()
  customerServiceRealtimeService.openClientStream(disabledOwner.id, disabledMobile.accessToken, disabledResponse as never, 60)
  await AppDataSource.getRepository(ClientUser).update(disabledOwner.id, { status: 'disabled' })
  await triggerIdleValidation()
  assert.equal(disabledResponse.writableEnded, true, '账号停用后的 Mobile SSE 必须关闭')

  const webOwner = await createClientUser()
  const webToken = 'web-sse-session-token'
  await AppDataSource.getRepository(ClientUserSession).save({
    userId: webOwner.id,
    sessionToken: hashSessionToken(webToken),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    lastAccessAt: new Date(),
  })
  const webResponse = new ControlledSseResponse()
  customerServiceRealtimeService.openClientStream(webOwner.id, webToken, webResponse as never, 60)
  publishClientEvent(webOwner.id, 'web_message_created')
  await waitFor(
    () => webResponse.writes.some((payload) => payload.includes('event: conversation')),
    '既有 Web SSE 必须继续接收业务事件',
  )
  await triggerIdleValidation()
  assert.equal(webResponse.writableEnded, false, '既有 Web SSE 必须继续通过 idle 会话复核')

  const admin = await AppDataSource.getRepository(SysUser).save({
    username: 'sse-admin', passwordHash: 'test-only-password-hash', displayName: 'SSE 管理员', email: null, role: 'admin', status: 'enabled', lastLoginAt: null,
  })
  const adminToken = 'admin-sse-session-token'
  await AppDataSource.getRepository(SysUserSession).save({
    userId: admin.id, sessionToken: hashSessionToken(adminToken), expiresAt: new Date(Date.now() + 60 * 60 * 1000), lastAccessAt: new Date(),
  })
  const adminResponse = new ControlledSseResponse()
  customerServiceRealtimeService.openServiceStream(admin.id, adminToken, adminResponse as never, 60)
  publishClientEvent(webOwner.id, 'service_message_created')
  await waitFor(
    () => adminResponse.writes.some((payload) => payload.includes('event: conversation')),
    '既有客服 SSE 必须继续接收业务事件',
  )
  await triggerIdleValidation()
  assert.equal(adminResponse.writableEnded, false, '既有客服 SSE 必须继续通过 idle 会话复核')

  webResponse.end()
  adminResponse.end()
  console.log('mobile-sse-session-regression-verify 全部通过。')
} finally {
  globalThis.setInterval = originalSetInterval
  globalThis.clearInterval = originalClearInterval
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
