/**
 * 文件说明：backend/scripts/task2-governance-verify.ts
 * 文件职责：验证 Task2 的高危治理能力，包括细化权限后的关键写接口审计、操作者传递与请求上下文留痕。
 * 实现逻辑：
 * 1. 使用独立 SQLite 数据库初始化后端运行环境，避免污染本地开发数据；
 * 2. 以管理员身份直接调用 SQLite 备份、JSON 导入、验证码平台测试发送等关键写服务；
 * 3. 分别断言成功/失败场景下的审计日志已记录操作者、请求上下文和关键结果摘要；
 * 4. 通过可重复执行的自动化脚本，为本次 Task2 提供聚焦回归证据。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const runtimeRoot = path.resolve(process.cwd(), '.local-dev')
const sqlitePath = path.resolve(runtimeRoot, `task2-governance-verify-${Date.now()}.sqlite`)
const adminPassword = `Task2_Admin_${Date.now()}_Aa9!`

process.env.APP_PROFILE = `task2-governance-verify-${Date.now()}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'true'
process.env.SQLITE_DB_PATH = sqlitePath
process.env.INIT_ADMIN_PASSWORD = adminPassword

function pass(message: string) {
  console.log(`✅ ${message}`)
}

async function expectBizError(
  task: string,
  runner: () => Promise<unknown>,
  statusCode: number,
  keyword: string,
  BizErrorCtor: new (...args: any[]) => Error,
) {
  try {
    await runner()
    assert.fail(`${task} 未抛出 BizError`)
  } catch (error) {
    assert.ok(error instanceof BizErrorCtor, `${task} 应抛出 BizError`)
    const bizError = error as Error & { statusCode: number }
    assert.equal(bizError.statusCode, statusCode, `${task} 错误码不符合预期`)
    assert.match(bizError.message, new RegExp(keyword), `${task} 错误文案不符合预期`)
  }
}

async function main() {
  const [{ AppDataSource }, { authService }, { systemConfigService }, { dataMaintenanceService }, { verificationCodeService }, { auditService }, { BizError }] =
    await Promise.all([
      import('../src/config/data-source.js'),
      import('../src/services/auth.service.js'),
      import('../src/services/system-config.service.js'),
      import('../src/services/data-maintenance.service.js'),
      import('../src/services/verification-code.service.js'),
      import('../src/services/audit.service.js'),
      import('../src/utils/errors.js'),
    ])

  const requestMeta = {
    ipAddress: '10.20.30.40',
    userAgent: 'Task2GovernanceVerify/1.0',
  }

  let createdBackupPath = ''
  const originalFetch = globalThis.fetch

  fs.mkdirSync(runtimeRoot, { recursive: true })
  await AppDataSource.initialize()

  try {
    await AppDataSource.synchronize()
    await authService.ensureDefaultAdmin()
    await systemConfigService.ensureDefaultConfigs()

    const loginResult = await authService.login({
      username: 'admin',
      password: adminPassword,
    }, requestMeta)
    const adminActor = await authService.resolveAuthUserByToken(loginResult.token)

    const backupResult = await dataMaintenanceService.createSqliteBackup(adminActor, requestMeta)
    createdBackupPath = backupResult.filePath
    assert.equal(fs.existsSync(backupResult.filePath), true, 'SQLite 备份文件未成功落盘')
    const backupAuditPage = await auditService.list({
      page: 1,
      pageSize: 20,
      actionType: 'data_maintenance.backup_sqlite',
    })
    const backupAudit = backupAuditPage.list[0]
    assert.ok(backupAudit, '缺少 SQLite 备份审计日志')
    assert.equal(backupAudit.actorUserId, adminActor.userId)
    assert.equal(backupAudit.ipAddress, requestMeta.ipAddress)
    assert.equal(backupAudit.userAgent, requestMeta.userAgent)
    assert.equal(backupAudit.targetCode, backupResult.fileName)
    pass('SQLite 备份接口已记录操作者与请求上下文审计')

    const importPayload = {
      exportedAt: new Date().toISOString(),
      version: 'data-maintenance-v2',
      tables: {
        systemConfigs: [
          {
            id: '900001',
            configKey: 'task2.audit.marker',
            configValue: '1',
            configGroup: 'verify',
            remark: 'Task2 审计验证标记',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        products: [],
        clientUsers: [],
        preorders: [],
        preorderItems: [],
        inventoryLogs: [],
      },
    }
    const importResult = await dataMaintenanceService.importJson(importPayload, adminActor, requestMeta)
    assert.equal(importResult.imported.systemConfigs, 1)
    const importAuditPage = await auditService.list({
      page: 1,
      pageSize: 20,
      actionType: 'data_maintenance.import_json',
    })
    const importAudit = importAuditPage.list[0]
    assert.ok(importAudit, '缺少 JSON 导入审计日志')
    assert.equal(importAudit.actorUserId, adminActor.userId)
    assert.equal(importAudit.ipAddress, requestMeta.ipAddress)
    assert.equal(importAudit.targetCode, importPayload.version)
    assert.match(importAudit.detailJson ?? '', /data-maintenance-v2/)
    assert.match(importAudit.detailJson ?? '', /"imported"/)
    assert.match(importAudit.detailJson ?? '', /"systemConfigs":1/)
    pass('JSON 导入接口已记录操作者、请求上下文与导入摘要')

    globalThis.fetch = async () => new Response('ok', { status: 200 })
    const sendTestSuccess = await verificationCodeService.sendTest({
      channel: 'mobile',
      target: '13800138000',
      config: {
        enabled: true,
        httpMethod: 'POST',
        apiUrl: 'https://example.com/send-sms',
        headersTemplate: '{"Content-Type":"application/json"}',
        bodyTemplate: '{"mobile":"{{target}}","code":"{{code}}","scene":"{{scene}}"}',
        successMatch: '',
      },
      actor: adminActor,
      requestMeta,
    })
    assert.equal(sendTestSuccess.channel, 'mobile')

    const sendSuccessAuditPage = await auditService.list({
      page: 1,
      pageSize: 20,
      actionType: 'system_config.test_verification_provider',
    })
    const sendSuccessAudit = sendSuccessAuditPage.list.find((item) => item.resultStatus === 'success')
    assert.ok(sendSuccessAudit, '缺少验证码平台测试发送成功审计日志')
    assert.equal(sendSuccessAudit?.actorUserId, adminActor.userId)
    assert.equal(sendSuccessAudit?.targetCode, 'mobile')
    assert.equal(sendSuccessAudit?.ipAddress, requestMeta.ipAddress)
    pass('验证码平台测试发送成功场景已记录审计')

    globalThis.fetch = async () => new Response('failed', { status: 500 })
    await expectBizError(
      '验证码平台测试发送失败审计',
      () =>
        verificationCodeService.sendTest({
          channel: 'email',
          target: 'verify@example.com',
          config: {
            enabled: true,
            httpMethod: 'POST',
            apiUrl: 'https://example.com/send-email',
            headersTemplate: '{"Content-Type":"application/json"}',
            bodyTemplate: '{"email":"{{target}}","code":"{{code}}","scene":"{{scene}}"}',
            successMatch: '',
          },
          actor: adminActor,
          requestMeta,
        }),
      502,
      '验证码平台请求失败',
      BizError,
    )
    const sendFailureAuditPage = await auditService.list({
      page: 1,
      pageSize: 20,
      actionType: 'system_config.test_verification_provider',
    })
    const sendFailureAudit = sendFailureAuditPage.list.find((item) => item.resultStatus === 'failed')
    assert.ok(sendFailureAudit, '缺少验证码平台测试发送失败审计日志')
    assert.equal(sendFailureAudit?.actorUserId, adminActor.userId)
    assert.equal(sendFailureAudit?.targetCode, 'email')
    assert.match(sendFailureAudit?.detailJson ?? '', /errorMessage/)
    pass('验证码平台测试发送失败场景已记录失败审计')
  } finally {
    globalThis.fetch = originalFetch
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy()
    }
    if (createdBackupPath) {
      fs.rmSync(createdBackupPath, { force: true })
    }
    fs.rmSync(sqlitePath, { force: true })
  }
}

try {
  await main()
  console.log('Task2 治理链路验证通过')
} catch (error) {
  console.error('Task2 治理链路验证失败', error)
  process.exit(1)
}
