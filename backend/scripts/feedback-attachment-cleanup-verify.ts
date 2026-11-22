/**
 * 文件说明：反馈附件配额、绑定与孤儿清理专项回归。
 * 实现逻辑：默认使用独立临时目录和 SQLite 数据库；显式选择 mysql 时只连接专用验收地址，
 * 自建并销毁随机临时库。验证跨连接配额、绑定/清理竞态、24 小时孤儿回收与冻结准入。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { mock } from 'node:test'
import { createConnection } from 'mysql2/promise'
import { createVerificationIsolation } from './verification-isolation.js'
import { createOwnedVerificationDatabase, verificationDatabaseName } from './owned-verification-database.js'
import { readFeedbackMysqlFixture } from './run-feedback-attachment-cleanup-verify.mjs'

const isolation = createVerificationIsolation('feedback-attachment-cleanup-verify')
const runtimeRoot = isolation.rootDir
const sqlitePath = path.join(runtimeRoot, 'feedback-cleanup.sqlite')
const verifyDatabaseType = process.env.FEEDBACK_ATTACHMENT_VERIFY_DB?.trim().toLowerCase() === 'mysql'
  ? 'mysql'
  : 'sqlite'
const mysqlVerifyConfig = verifyDatabaseType === 'mysql' ? readFeedbackMysqlFixture() : null
let ownedMysql: Awaited<ReturnType<typeof createOwnedVerificationDatabase>> | undefined

process.env.DB_SYNC = verifyDatabaseType === 'mysql' ? 'true' : 'false'
process.env.YLINK_FEEDBACK_MAX_PENDING_ATTACHMENTS = '1'
process.env.YLINK_FEEDBACK_CLEANUP_BATCH_SIZE = '500'
process.env.YLINK_FEEDBACK_ORPHAN_GRACE_MS = '86400000'
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

  await isolation.assertTarget(AppDataSource)
  prepareDatabaseRuntime()
  // 在真实连接再次证明服务器与库身份后，才由下方显式初始化写入结构。
  if (ownedMysql) AppDataSource.setOptions({ synchronize: false })
  await AppDataSource.initialize()
  try {
    if (ownedMysql) {
      const [target] = await AppDataSource.query('SELECT @@server_uuid AS serverId, DATABASE() AS databaseName')
      assert.equal(target?.serverId, ownedMysql.serverId)
      assert.equal(target?.databaseName, ownedMysql.database)
    }
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

    if (mysqlVerifyConfig && ownedMysql) {
      const ownedTarget = ownedMysql
      const openFixtureConnection = async () => {
        const connection = await createConnection({ ...readFeedbackMysqlFixture(), database: ownedTarget.database })
        try {
          const [rows] = await connection.query('SELECT @@server_uuid AS serverId, DATABASE() AS databaseName')
          const [target] = rows as Array<{ serverId: string; databaseName: string }>
          assert.equal(target?.serverId, ownedTarget.serverId)
          assert.equal(target?.databaseName, ownedTarget.database)
          return connection
        } catch (error) {
          await connection.end()
          throw error
        }
      }

      const namedLockConnection = await openFixtureConnection()
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

      const ownerLockConnection = await openFixtureConnection()
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
    const uncertainStorageName = `${randomUUID()}.png`
    const uncertainPath = writeOldFeedbackFile(uncertainStorageName)
    await AppDataSource.getRepository(ClientFeedbackMessage).insert({
      conversationId: historicalConversation.conversation.id,
      senderType: 'client',
      content: '旧附件快照格式不完整',
      attachmentJson: `[{"url":"/uploads/client-feedback/${uncertainStorageName}"`,
    })
    const uploadTemp = path.join(runtimeRoot, 'uploads', '.tmp')
    fs.mkdirSync(uploadTemp, { recursive: true })
    const createTempFile = (name: string, aged: boolean) => {
      const file = path.join(uploadTemp, name)
      fs.writeFileSync(file, '隔离验收文件')
      if (aged) fs.utimesSync(file, oldDate, oldDate)
      return file
    }
    const agedFeedbackTemp = createTempFile(`client-feedback-${randomUUID()}.png`, true)
    const agedProductTemp = createTempFile(`products-${randomUUID()}.jpg`, true)
    const freshTemp = createTempFile(`client-feedback-${randomUUID()}.png`, false)
    const unrecognizedTemp = createTempFile('历史临时文件.png', true)
    const tempDirectory = path.join(uploadTemp, `products-${randomUUID()}.png`)
    fs.mkdirSync(tempDirectory)
    fs.utimesSync(tempDirectory, oldDate, oldDate)
    const blockedOrphanName = '00000000-0001-4000-8000-000000000001.png'
    const blockedOrphan = writeOldFeedbackFile(blockedOrphanName)
    const blockedTempName = 'products-00000000-0001-4000-8000-000000000001.png'
    const blockedTemp = createTempFile(blockedTempName, true)
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
    const idOnlyStorageName = `${randomUUID()}.png`
    const idOnlyPath = writeOldFeedbackFile(idOnlyStorageName)
    const idOnlyDraft = await AppDataSource.getRepository(ClientFeedbackAttachment).save({
      ownerClientUserId: user.id,
      conversationId: null,
      messageId: null,
      storageName: idOnlyStorageName,
      originalName: '历史 ID 引用.png',
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
        { attachmentId: String(idOnlyDraft.id) },
      ]) },
    )

    const unlink = fs.promises.unlink
    const blockedFiles = new Map([[blockedOrphan, 'EACCES'], [blockedTemp, 'EBUSY']])
    const blockedUnlink = mock.method(fs.promises, 'unlink', async (...args: Parameters<typeof unlink>) => {
      const faultCode = blockedFiles.get(String(args[0]))
      if (faultCode) throw Object.assign(new Error('底层文件异常明细应保持脱敏'), { code: faultCode })
      return unlink(...args)
    })
    const cleanupResult = await clientFeedbackService.runAttachmentCleanupOnce().finally(() => blockedUnlink.mock.restore())
    assert.equal(fs.existsSync(orphanPath), false, '超过 24 小时且无双重引用的 UUID 孤儿应回收')
    assert.equal(fs.existsSync(expiredPath), false, '过期且未绑定的草稿文件应在数据库提交后回收')
    assert.equal(fs.existsSync(referencedExpiredPath), true, '消息仍引用的过期草稿属于关系异常，必须保留')
    assert.equal(fs.existsSync(idOnlyPath), true, '历史消息仅有附件 ID 的快照仍应保留草稿文件')
    assert.equal(await AppDataSource.getRepository(ClientFeedbackAttachment).existsBy({ id: String(idOnlyDraft.id) }), true)
    assert.equal(fs.existsSync(historicalPath), true, '历史消息 JSON 仍引用的文件必须保留')
    assert.equal(fs.existsSync(uncertainPath), true, '格式不明的历史快照保留可识别的附件引用')
    assert.equal(fs.existsSync(unsafePath), true, '非 UUID 文件名属于不确定历史文件，禁止删除')
    assert.ok(
      await AppDataSource.getRepository(ClientFeedbackAttachment).findOne({ where: { id: unsafeAttachment.id } }),
      '非 UUID 草稿记录也必须保留，避免把不确定文件变成无记录孤儿',
    )
    assert.ok(cleanupResult.anomalies.some((item) => item.storageName === historicalStorageName))
    assert.ok(cleanupResult.anomalies.some((item) => item.storageName === referencedExpiredStorageName))
    assert.ok(cleanupResult.anomalies.some((item) => item.storageName === idOnlyStorageName))
    assert.ok(cleanupResult.anomalies.some((item) => item.storageName === 'legacy-uncertain-name.png'))
    assert.ok(cleanupResult.anomalies.some((item) => item.storageName === uncertainStorageName))
    assert.equal(cleanupResult.removedTempFiles, 2)
    assert.equal(cleanupResult.retainedReferencedFiles, 4, '保留统计不得计入本轮回收的过期草稿')
    for (const file of [agedFeedbackTemp, agedProductTemp]) assert.equal(fs.existsSync(file), false)
    for (const file of [freshTemp, unrecognizedTemp, tempDirectory]) assert.equal(fs.existsSync(file), true)
    for (const file of [blockedOrphan, blockedTemp]) assert.equal(fs.existsSync(file), true)
    for (const storageName of [blockedOrphanName, blockedTempName]) {
      assert.match(cleanupResult.anomalies.find((item) => item.storageName === storageName)?.reason ?? '', /保留待下次核查/)
    }

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
    assert.equal(raceResults[0]?.status, 'rejected', '过期草稿不能绑定')
    assert.equal(raceResults[1]?.status, 'fulfilled')
    assert.equal(raceRow, null, '过期草稿记录必须已删除')
    assert.equal(fs.existsSync(racePath), false, '过期草稿文件必须已删除')
    for (const file of [blockedOrphan, blockedTemp]) assert.equal(fs.existsSync(file), false, '占用恢复后下一轮可回收')

    const newBindingName = `${randomUUID()}.png`
    const newBindingPath = writeOldFeedbackFile(newBindingName)
    const lstat = fs.promises.lstat
    let boundId: string | undefined
    const registerDuringScan = mock.method(fs.promises, 'lstat', async (filename: string) => {
      const info = await lstat(filename)
      // 初筛已经看到该文件无登记。此处用真实业务入口完成注册、绑定，再让清理回到其候选。
      if (filename === newBindingPath && !boundId) {
        const newAttachment = await clientFeedbackService.createClientAttachment({
          storageName: newBindingName, originalName: '绑定与复查并发.png', mimeType: 'image/png', sizeBytes: 100,
        }, clientAuth)
        boundId = newAttachment.id
        await clientFeedbackService.appendClientMessage(historicalConversation.conversation.id, {
          content: '消息已绑定有效附件', attachmentIds: [boundId],
        }, clientAuth)
      }
      return info
    })
    await clientFeedbackService.runAttachmentCleanupOnce().finally(() => registerDuringScan.mock.restore())
    assert.ok(boundId, '必须经过无登记候选的实时注册屏障')
    const boundRow = await AppDataSource.getRepository(ClientFeedbackAttachment).findOneByOrFail({ id: boundId })
    assert.ok(boundRow.messageId && boundRow.conversationId, '登记和绑定已真实提交')
    assert.equal(fs.existsSync(newBindingPath), true, '回收前二次检查必须保留新登记并绑定的文件')

    const attachmentRepo = AppDataSource.getRepository(ClientFeedbackAttachment)
    const messageRepo = AppDataSource.getRepository(ClientFeedbackMessage)
    for (let group = 0; group < 101; group += 1) {
      const message = await messageRepo.save({
        conversationId: historicalConversation.conversation.id,
        senderType: 'client', content: '正常历史附件', attachmentJson: '[]',
      })
      const rows = await attachmentRepo.save(Array.from({ length: 5 }, (_, index) => {
        const suffix = (group * 5 + index + 1).toString(16).padStart(12, '0')
        const storageName = `00000000-0000-4000-8000-${suffix}.png`
        writeOldFeedbackFile(storageName)
        return {
          storageName, ownerClientUserId: user.id, originalName: '正常附件.png',
          conversationId: String(historicalConversation.conversation.id), messageId: String(message.id), expiresAt: null,
        }
      }))
      await messageRepo.update({ id: message.id }, {
        attachmentJson: JSON.stringify(rows.map(({ id, originalName: name }) => ({ name, url: `/api/client-feedback/attachments/${id}` }))),
      })
    }

    for (let group = 0; group < 5; group += 1) {
      await attachmentRepo.insert(Array.from({ length: 100 }, (_, index) => ({
        storageName: `历史非标准文件名-${group * 100 + index}.png`,
        ownerClientUserId: user.id, originalName: '等待人工核查', expiresAt: oldDate,
      })))
    }
    const lateDraftName = `${randomUUID()}.png`
    const lateDraftPath = writeOldFeedbackFile(lateDraftName)
    const lateDraft = await attachmentRepo.save({
      storageName: lateDraftName, ownerClientUserId: user.id, originalName: '后续有效过期草稿.png', expiresAt: oldDate,
    })
    const lateOrphanPath = writeOldFeedbackFile('ffffffff-ffff-4fff-bfff-ffffffffffff.png')
    await clientFeedbackService.runAttachmentCleanupOnce()
    assert.equal(fs.existsSync(lateOrphanPath), false, '超过 500 个合法绑定文件不能挡住后续孤儿')
    await clientFeedbackService.runAttachmentCleanupOnce()
    assert.equal(await attachmentRepo.existsBy({ id: lateDraft.id }), false, '草稿批次推进经过异常留存行后必须回收到后续草稿')
    assert.equal(fs.existsSync(lateDraftPath), false)
    assert.equal(await attachmentRepo.existsBy({ storageName: '历史非标准文件名-0.png' }), true)

    if (verifyDatabaseType === 'sqlite') {
      const exactIds = ['9007199254740992', '9007199254740993']
      const [claimedName, expiredName] = exactIds.map(() => `${randomUUID()}.png`) as [string, string]
      const claimedFile = writeOldFeedbackFile(claimedName)
      const expiredFile = writeOldFeedbackFile(expiredName)
      for (const [index, storageName] of [claimedName, expiredName].entries()) {
        await AppDataSource.query(
          `INSERT INTO client_feedback_attachment (id, owner_client_user_id, storage_name, original_name, expires_at)
           VALUES (CAST(? AS INTEGER), ?, ?, '历史大整数附件.png', '2000-01-01 00:00:00.000')`,
          [exactIds[index], user.id, storageName],
        )
      }
      await messageRepo.insert({
        conversationId: historicalConversation.conversation.id,
        senderType: 'client',
        content: '仅引用第一个精确大整数 ID',
        attachmentJson: `[{"attachmentId":${exactIds[0]}}]`,
      })
      // 第一页仍有先前用于验证分页的大批历史草稿，两次清理均走实际读写。
      await clientFeedbackService.runAttachmentCleanupOnce()
      await clientFeedbackService.runAttachmentCleanupOnce()
      assert.equal(fs.existsSync(claimedFile), true, '精确被引用的附件文件应保留')
      assert.equal(fs.existsSync(expiredFile), false, '相邻的无引用附件文件应回收')
      assert.deepEqual(
        await AppDataSource.query(
          'SELECT CAST(id AS TEXT) AS id FROM client_feedback_attachment WHERE storage_name IN (?, ?) ORDER BY id',
          [claimedName, expiredName],
        ),
        [{ id: exactIds[0] }],
        '删除时应使用精确的主键，只保留历史消息真正引用的附件登记',
      )
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
    isolation.cleanup()
  }
}

try {
  if (mysqlVerifyConfig) {
    ownedMysql = await createOwnedVerificationDatabase(mysqlVerifyConfig, verificationDatabaseName('feedback_cleanup'), async (captured) => {
      const current = readFeedbackMysqlFixture()
      if (current.port !== captured.port || current.password !== captured.password) {
        throw new Error('反馈 MySQL Compose 所有权上下文已变化，未连接数据库')
      }
      return createConnection({ ...captured, connectTimeout: 3_000, multipleStatements: false })
    })
    await ownedMysql.assertEmpty()
    isolation.seal({ type: 'mysql', ...mysqlVerifyConfig, database: ownedMysql.database })
  } else {
    isolation.seal({ type: 'sqlite', database: sqlitePath })
  }
  await runSuite()
} finally {
  try {
    await ownedMysql?.cleanup()
  } finally {
    isolation.cleanup()
  }
}
