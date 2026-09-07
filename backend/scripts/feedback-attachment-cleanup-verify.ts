/**
 * 文件说明：反馈附件配额、绑定与孤儿清理专项回归。
 * 实现逻辑：默认使用独立临时目录和 SQLite 数据库；显式选择 mysql 时只连接专用验收地址，
 * 自建并销毁随机临时库。验证跨连接配额、绑定/清理竞态、24 小时孤儿回收与冻结准入。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createConnection, type ConnectionOptions } from 'mysql2/promise'

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'y-link-feedback-cleanup-'))
const sqlitePath = path.join(runtimeRoot, 'feedback-cleanup.sqlite')
const verifyDatabaseType = process.env.FEEDBACK_ATTACHMENT_VERIFY_DB?.trim().toLowerCase() === 'mysql'
  ? 'mysql'
  : 'sqlite'
const mysqlTempDatabaseName = `y_link_feedback_verify_${process.pid}_${Date.now().toString(36)}`

function readRequiredMysqlEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`MySQL 专项验收缺少 ${name}，拒绝回退到业务 DB_* 配置`)
  return value
}

function readMysqlVerifyConfig(): ConnectionOptions {
  const portText = readRequiredMysqlEnv('FEEDBACK_ATTACHMENT_VERIFY_MYSQL_PORT')
  const port = Number.parseInt(portText, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('FEEDBACK_ATTACHMENT_VERIFY_MYSQL_PORT 必须是 1 到 65535 的整数')
  }
  return {
    host: readRequiredMysqlEnv('FEEDBACK_ATTACHMENT_VERIFY_MYSQL_HOST'),
    port,
    user: readRequiredMysqlEnv('FEEDBACK_ATTACHMENT_VERIFY_MYSQL_USER'),
    password: process.env.FEEDBACK_ATTACHMENT_VERIFY_MYSQL_PASSWORD ?? '',
  }
}

const mysqlVerifyConfig = verifyDatabaseType === 'mysql' ? readMysqlVerifyConfig() : null

process.chdir(runtimeRoot)
process.env.APP_PROFILE = `feedback-attachment-cleanup-${Date.now()}`
process.env.DB_SYNC = verifyDatabaseType === 'mysql' ? 'true' : 'false'
process.env.YLINK_FEEDBACK_MAX_PENDING_ATTACHMENTS = '1'
if (verifyDatabaseType === 'mysql' && mysqlVerifyConfig) {
  process.env.DB_TYPE = 'mysql'
  process.env.DB_HOST = String(mysqlVerifyConfig.host)
  process.env.DB_PORT = String(mysqlVerifyConfig.port)
  process.env.DB_USER = String(mysqlVerifyConfig.user)
  process.env.DB_PASSWORD = String(mysqlVerifyConfig.password ?? '')
  process.env.DB_NAME = mysqlTempDatabaseName
  process.env.DB_AUTO_MIGRATE = 'true'
} else {
  process.env.DB_TYPE = 'sqlite'
  process.env.SQLITE_DB_PATH = sqlitePath
}

const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000)

function writeOldFeedbackFile(storageName: string): string {
  const directory = path.join(runtimeRoot, 'uploads', 'client-feedback')
  fs.mkdirSync(directory, { recursive: true })
  const filePath = path.join(directory, storageName)
  fs.writeFileSync(filePath, Buffer.from('isolated-feedback-fixture'))
  fs.utimesSync(filePath, oldDate, oldDate)
  return filePath
}

async function assertPromiseStillPending(promise: Promise<unknown>, message: string) {
  let settled = false
  void promise.finally(() => { settled = true }).catch(() => undefined)
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(settled, false, message)
}

async function runSuite() {
  const { AppDataSource } = await import('../src/config/data-source.js')
  const { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime } = await import('../src/config/database-bootstrap.js')
  const { ClientUser } = await import('../src/entities/client-user.entity.js')
  const { ClientFeedbackAttachment } = await import('../src/entities/client-feedback-attachment.entity.js')
  const { ClientFeedbackMessage } = await import('../src/entities/client-feedback-message.entity.js')
  const { databaseOperationGate } = await import('../src/database/operation-gate.js')
  const { clientFeedbackService } = await import('../src/services/client-feedback.service.js')
  const { systemConfigService } = await import('../src/services/system-config.service.js')

  prepareDatabaseRuntime()
  await AppDataSource.initialize()
  try {
    await initializeDatabaseSchemaIfNeeded(AppDataSource)
    await systemConfigService.ensureDefaultConfigs()

    const user = await AppDataSource.getRepository(ClientUser).save({
      mobile: '13800000001',
      email: null,
      mobileVerifiedAt: null,
      emailVerifiedAt: null,
      passwordHash: 'isolated-fixture-only',
      realName: '附件安全回归用户',
      departmentName: '',
      departmentNodeId: null,
      accountType: 'personal',
      staffNo: null,
      staffVerified: false,
      status: 'enabled',
      lastLoginAt: null,
    })
    const clientAuth = {
      userId: user.id,
      account: user.mobile!,
      mobile: user.mobile!,
      email: '',
      realName: user.realName,
      accountType: 'personal' as const,
      staffNo: null,
      sessionToken: 'isolated-session',
      authSource: 'bearer' as const,
    }

    if (mysqlVerifyConfig) {
      const mysqlConnectionOptions = { ...mysqlVerifyConfig, database: mysqlTempDatabaseName }

      const namedLockConnection = await createConnection(mysqlConnectionOptions)
      const namedLockFile = `${randomUUID()}.png`
      writeOldFeedbackFile(namedLockFile)
      try {
        const [rawLockRows] = await namedLockConnection.query(
          'SELECT GET_LOCK(?, 0) AS acquired',
          ['ylink:feedback:attachment-quota-cleanup'],
        )
        const lockRows = rawLockRows as Array<{ acquired?: number | string | null }>
        assert.equal(Number(lockRows[0]?.acquired), 1, '独立连接必须先取得反馈附件数据库命名锁')
        const blockedByNamedLock = clientFeedbackService.createClientAttachment({
          storageName: namedLockFile,
          originalName: '命名锁验证.png',
          mimeType: 'image/png',
          sizeBytes: 100,
        }, clientAuth)
        await assertPromiseStillPending(blockedByNamedLock, '其它连接持有 GET_LOCK 时草稿建档必须等待')
        await namedLockConnection.query(
          'SELECT RELEASE_LOCK(?) AS released',
          ['ylink:feedback:attachment-quota-cleanup'],
        )
        await blockedByNamedLock
      } finally {
        await namedLockConnection.query('SELECT RELEASE_LOCK(?)', ['ylink:feedback:attachment-quota-cleanup'])
        await namedLockConnection.end()
      }
      await AppDataSource.getRepository(ClientFeedbackAttachment).clear()
      fs.rmSync(path.join(runtimeRoot, 'uploads', 'client-feedback', namedLockFile), { force: true })

      const ownerLockConnection = await createConnection(mysqlConnectionOptions)
      const ownerLockFile = `${randomUUID()}.png`
      writeOldFeedbackFile(ownerLockFile)
      try {
        await ownerLockConnection.beginTransaction()
        await ownerLockConnection.query('SELECT id FROM client_user WHERE id = ? FOR UPDATE', [user.id])
        const blockedByOwnerLock = clientFeedbackService.createClientAttachment({
          storageName: ownerLockFile,
          originalName: '所属用户行锁验证.png',
          mimeType: 'image/png',
          sizeBytes: 100,
        }, clientAuth)
        await assertPromiseStillPending(blockedByOwnerLock, '所属用户行被其它连接锁定时草稿建档必须等待')
        await ownerLockConnection.commit()
        await blockedByOwnerLock
      } finally {
        await ownerLockConnection.rollback().catch(() => undefined)
        await ownerLockConnection.end()
      }
      await AppDataSource.getRepository(ClientFeedbackAttachment).clear()
      fs.rmSync(path.join(runtimeRoot, 'uploads', 'client-feedback', ownerLockFile), { force: true })
    }

    const quotaFiles = [`${randomUUID()}.png`, `${randomUUID()}.png`]
    quotaFiles.forEach(writeOldFeedbackFile)
    const quotaResults = await Promise.allSettled(quotaFiles.map((storageName) => clientFeedbackService.createClientAttachment({
      storageName,
      originalName: storageName,
      mimeType: 'image/png',
      sizeBytes: 100,
    }, clientAuth)))
    assert.equal(quotaResults.filter((item) => item.status === 'fulfilled').length, 1, '并发上传只能占用一个草稿配额')
    assert.equal(quotaResults.filter((item) => item.status === 'rejected').length, 1, '超额并发上传必须失败')

    await AppDataSource.getRepository(ClientFeedbackAttachment).clear()
    for (const storageName of quotaFiles) fs.rmSync(path.join(runtimeRoot, 'uploads', 'client-feedback', storageName), { force: true })

    const historicalStorageName = `${randomUUID()}.png`
    const historicalPath = writeOldFeedbackFile(historicalStorageName)
    const historicalConversation = await clientFeedbackService.createConversation({
      subject: '历史引用保留验证',
      content: '创建隔离反馈消息',
    }, clientAuth)
    await AppDataSource.getRepository(ClientFeedbackMessage).update(
      { id: historicalConversation.message.id },
      { attachmentJson: JSON.stringify([{
        name: '历史截图.png',
        url: `/uploads/client-feedback/${historicalStorageName}`,
        mimeType: 'image/png',
        size: 100,
      }]) },
    )

    const orphanStorageName = `${randomUUID()}.png`
    const orphanPath = writeOldFeedbackFile(orphanStorageName)
    const unsafePath = writeOldFeedbackFile('legacy-uncertain-name.png')
    const unsafeAttachment = await AppDataSource.getRepository(ClientFeedbackAttachment).save({
      ownerClientUserId: user.id,
      conversationId: null,
      messageId: null,
      storageName: 'legacy-uncertain-name.png',
      originalName: '历史不确定草稿.png',
      mimeType: 'image/png',
      sizeBytes: 100,
      expiresAt: oldDate,
    })

    const expiredStorageName = `${randomUUID()}.png`
    const expiredPath = writeOldFeedbackFile(expiredStorageName)
    await AppDataSource.getRepository(ClientFeedbackAttachment).save({
      ownerClientUserId: user.id,
      conversationId: null,
      messageId: null,
      storageName: expiredStorageName,
      originalName: '过期草稿.png',
      mimeType: 'image/png',
      sizeBytes: 100,
      expiresAt: oldDate,
    })

    const referencedExpiredStorageName = `${randomUUID()}.png`
    const referencedExpiredPath = writeOldFeedbackFile(referencedExpiredStorageName)
    const referencedExpired = await AppDataSource.getRepository(ClientFeedbackAttachment).save({
      ownerClientUserId: user.id,
      conversationId: null,
      messageId: null,
      storageName: referencedExpiredStorageName,
      originalName: '异常历史引用.png',
      mimeType: 'image/png',
      sizeBytes: 100,
      expiresAt: oldDate,
    })
    await AppDataSource.getRepository(ClientFeedbackMessage).update(
      { id: historicalConversation.message.id },
      { attachmentJson: JSON.stringify([
        {
          name: '历史截图.png',
          url: `/uploads/client-feedback/${historicalStorageName}`,
          mimeType: 'image/png',
          size: 100,
        },
        {
          name: '异常历史引用.png',
          url: `/api/client-feedback/attachments/${referencedExpired.id}`,
          mimeType: 'image/png',
          size: 100,
        },
      ]) },
    )

    const cleanupResult = await clientFeedbackService.runAttachmentCleanupOnce()
    assert.equal(fs.existsSync(orphanPath), false, '超过 24 小时且无双重引用的 UUID 孤儿应回收')
    assert.equal(fs.existsSync(expiredPath), false, '过期且未绑定的草稿文件应在数据库提交后回收')
    assert.equal(fs.existsSync(referencedExpiredPath), true, '消息仍引用的过期草稿属于关系异常，必须保留')
    assert.equal(fs.existsSync(historicalPath), true, '历史消息 JSON 仍引用的文件必须保留')
    assert.equal(fs.existsSync(unsafePath), true, '非 UUID 文件名属于不确定历史文件，禁止删除')
    assert.ok(
      await AppDataSource.getRepository(ClientFeedbackAttachment).findOne({ where: { id: unsafeAttachment.id } }),
      '非 UUID 草稿记录也必须保留，避免把不确定文件变成无记录孤儿',
    )
    assert.ok(cleanupResult.anomalies.some((item) => item.storageName === historicalStorageName))
    assert.ok(cleanupResult.anomalies.some((item) => item.storageName === referencedExpiredStorageName))
    assert.ok(cleanupResult.anomalies.some((item) => item.storageName === 'legacy-uncertain-name.png'))

    const raceStorageName = `${randomUUID()}.png`
    const racePath = writeOldFeedbackFile(raceStorageName)
    const raceAttachment = await AppDataSource.getRepository(ClientFeedbackAttachment).save({
      ownerClientUserId: user.id,
      conversationId: null,
      messageId: null,
      storageName: raceStorageName,
      originalName: '绑定清理竞态.png',
      mimeType: 'image/png',
      sizeBytes: 100,
      expiresAt: oldDate,
    })
    const raceResults = await Promise.allSettled([
      clientFeedbackService.createConversation({
        subject: '绑定与清理竞态验证',
        content: '附件只能被绑定或清理一次',
        attachmentIds: [raceAttachment.id],
      }, clientAuth),
      clientFeedbackService.runAttachmentCleanupOnce(),
    ])
    const raceRow = await AppDataSource.getRepository(ClientFeedbackAttachment).findOne({ where: { id: raceAttachment.id } })
    const createSucceeded = raceResults[0]?.status === 'fulfilled'
    if (createSucceeded) {
      assert.ok(raceRow?.messageId && raceRow.conversationId, '绑定成功时附件关系必须完整')
      assert.equal(fs.existsSync(racePath), true, '绑定成功时清理不得删除附件文件')
    } else {
      assert.equal(raceRow, null, '清理先完成时过期草稿记录必须已删除')
      assert.equal(fs.existsSync(racePath), false, '清理先完成时过期草稿文件必须已删除')
    }

    const freezeControl = databaseOperationGate.freeze()
    try {
      await freezeControl.drain(5_000)
      await assert.rejects(
        () => clientFeedbackService.runAttachmentCleanupOnce(),
        /服务器维护中|只读状态/,
        '维护冻结后不得准入新的附件清理周期',
      )
    } finally {
      freezeControl.release()
    }

    console.log(`反馈附件并发与孤儿清理专项回归通过（${verifyDatabaseType}）。`)
  } finally {
    await clientFeedbackService.stopAttachmentCleanupWorker()
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
    process.chdir(path.dirname(runtimeRoot))
    fs.rmSync(runtimeRoot, { recursive: true, force: true })
  }
}

async function recreateMysqlVerifyDatabase() {
  if (!mysqlVerifyConfig) return
  const connection = await createConnection(mysqlVerifyConfig)
  try {
    await connection.query(`DROP DATABASE IF EXISTS \`${mysqlTempDatabaseName}\``)
    await connection.query(`CREATE DATABASE \`${mysqlTempDatabaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
  } finally {
    await connection.end()
  }
}

async function dropMysqlVerifyDatabase() {
  if (!mysqlVerifyConfig) return
  const connection = await createConnection(mysqlVerifyConfig)
  try {
    await connection.query(`DROP DATABASE IF EXISTS \`${mysqlTempDatabaseName}\``)
  } finally {
    await connection.end()
  }
}

if (verifyDatabaseType === 'mysql') await recreateMysqlVerifyDatabase()
try {
  await runSuite()
} finally {
  if (verifyDatabaseType === 'mysql') await dropMysqlVerifyDatabase()
}
