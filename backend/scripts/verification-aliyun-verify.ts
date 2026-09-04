/**
 * 阿里云 PNVS 短信验证码专项验证：
 * - 使用临时 SQLite，不访问阿里云或 MNS；
 * - 覆盖系统配置默认值、脱敏就绪态、服务端动态码和回执落库契约；
 * - 外部 SDK 均通过依赖注入替身驱动，避免专项验证产生真实发送。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const runId = `${process.pid}-${Date.now()}`
const runtimeDir = path.join(os.tmpdir(), `ylink-aliyun-pnvs-${runId}`)
const sqlitePath = path.join(runtimeDir, 'verification.sqlite')

process.env.NODE_ENV = 'test'
process.env.APP_PROFILE = `aliyun-pnvs-${runId}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'true'
process.env.SQLITE_DB_PATH = sqlitePath
process.env.Y_LINK_DATA_DIR = runtimeDir
process.env.INIT_ADMIN_PASSWORD = `Pnvs_${runId}_Aa1!`
process.env.VERIFICATION_TICKET_HMAC_SECRET = `pnvs-ticket-${runId}-minimum-32-characters-secret`
process.env.ALIBABA_CLOUD_ACCESS_KEY_ID = 'test-access-key-id'
process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET = 'test-access-key-secret'
process.env.ALIYUN_DYPNS_MNS_ENABLED = 'true'

async function main() {
  fs.mkdirSync(runtimeDir, { recursive: true })
  const { AppDataSource } = await import('../src/config/data-source.js')
  const { prepareDatabaseRuntime, initializeDatabaseSchemaIfNeeded } = await import('../src/config/database-bootstrap.js')
  const { systemConfigService } = await import('../src/services/system-config.service.js')

  try {
    prepareDatabaseRuntime()
    await AppDataSource.initialize()
    await initializeDatabaseSchemaIfNeeded(AppDataSource)
    await systemConfigService.ensureDefaultConfigs()

    const configs = await systemConfigService.getVerificationProviderConfigs()
    const mobile = configs.mobile as unknown as { providerType?: string; ready?: boolean }
    assert.equal(mobile.providerType, 'generic_http', '旧数据库默认短信提供方必须兼容 generic_http')
    assert.equal(mobile.ready, false, '未启用或未配置地址的默认短信通道不得标记为就绪')

    const { SystemConfig } = await import('../src/entities/system-config.entity.js')
    const { SmsVerificationRecord } = await import('../src/entities/sms-verification-record.entity.js')
    const { SmsVerificationRecordService } = await import('../src/services/sms-verification-record.service.js')
    const { VerificationCodeService } = await import('../src/services/verification-code.service.js')
    const { AliyunDypnsMnsWorkerService } = await import('../src/services/aliyun-dypns-mns-worker.service.js')
    const { AliyunDypnsSmsProvider } = await import('../src/services/aliyun-dypns-sms.service.js')
    const { clientAuthService } = await import('../src/services/client-auth.service.js')
    const { databaseMaintenanceModeService } = await import('../src/services/database-maintenance-mode.service.js')
    const configRepo = AppDataSource.getRepository(SystemConfig)
    const recordRepo = AppDataSource.getRepository(SmsVerificationRecord)
    await configRepo.createQueryBuilder().update(SystemConfig)
      .set({ configValue: 'https://example.com/legacy-sms-provider' })
      .where('config_key = :key', { key: 'verification.mobile.api_url' })
      .execute()
    const switchedConfig = await systemConfigService.resolveVerificationProviderConfigInput('mobile', {
      enabled: false,
      httpMethod: 'POST',
      apiUrl: '',
      headersTemplate: '',
      bodyTemplate: '',
      successMatch: '',
      providerType: 'aliyun_dypns',
    })
    assert.equal(switchedConfig.providerType, 'aliyun_dypns')
    assert.equal(switchedConfig.apiUrl, 'https://example.com/legacy-sms-provider', '切换阿里云短信时不得清空旧 HTTP 配置')
    assert.equal('accessKeyId' in switchedConfig, false, '配置读取不得返回阿里云访问密钥')
    const sentRequests: Array<Record<string, unknown>> = []
    const checkedRequests: Array<Record<string, unknown>> = []
    let verifyResult = 'PASS'
    let providerSendRequest: Record<string, unknown> | null = null
    let providerCheckRequest: Record<string, unknown> | null = null
    const sdkProvider = new AliyunDypnsSmsProvider(() => ({
      async sendSmsVerifyCode(request) {
        providerSendRequest = request as unknown as Record<string, unknown>
        return { body: { code: 'OK', success: true, model: { bizId: 'sdk-biz-id' } } }
      },
      async checkSmsVerifyCode(request) {
        providerCheckRequest = request as unknown as Record<string, unknown>
        return { body: { code: 'OK', success: true, model: { verifyResult: 'PASS' } } }
      },
    }))
    const sdkOutId = '11111111-2222-4333-8444-555555555555'
    await sdkProvider.send({
      phoneNumber: '13800001111', countryCode: '86', outId: sdkOutId, scene: 'register',
      config: {
        signName: 'Y-Link 测试签名', schemeName: 'verify-scheme',
        templates: { register: 'SMS_REGISTER', forgotPassword: 'SMS_FORGOT', profileUpdate: 'SMS_PROFILE', test: 'SMS_TEST' },
      },
    })
    assert.deepEqual({ ...providerSendRequest }, {
      phoneNumber: '13800001111', countryCode: '86', outId: sdkOutId, signName: 'Y-Link 测试签名', schemeName: 'verify-scheme',
      templateCode: 'SMS_REGISTER', templateParam: '{"code":"##code##","min":"5"}', codeLength: 6, validTime: 300,
      interval: 60, returnVerifyCode: false, duplicatePolicy: 1, codeType: 1, autoRetry: 1,
    }, '动态码发送必须固定使用 PNVS 服务端生成参数')
    await sdkProvider.check({ phoneNumber: '13800001111', countryCode: '86', outId: sdkOutId, verifyCode: '123456', schemeName: 'verify-scheme' })
    assert.deepEqual({ ...providerCheckRequest }, {
      phoneNumber: '13800001111', countryCode: '86', outId: sdkOutId, verifyCode: '123456', schemeName: 'verify-scheme',
    }, '动态码核验必须复用手机号、国家码、服务名和 outId')
    const recordService = new SmsVerificationRecordService({
      async send(input) {
        sentRequests.push({ ...input })
        return { code: 'OK', success: true, bizId: 'biz-verify-001' }
      },
      async check(input) {
        checkedRequests.push({ ...input })
        return { code: 'OK', success: true, verifyResult }
      },
    })
    const genericCodes: string[] = []
    const verificationService = new VerificationCodeService(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { code?: string }
      if (body.code) genericCodes.push(body.code)
      return { statusCode: 200, headers: {}, body: Buffer.from('ok') }
    }, recordService)

    await configRepo.createQueryBuilder().update(SystemConfig).set({ configValue: '1' }).where('config_key = :key', { key: 'verification.mobile.enabled' }).execute()
    await configRepo.createQueryBuilder().update(SystemConfig).set({ configValue: 'aliyun_dypns' }).where('config_key = :key', { key: 'verification.mobile.provider_type' }).execute()
    await configRepo.createQueryBuilder().update(SystemConfig).set({ configValue: 'Y-Link 测试签名' }).where('config_key = :key', { key: 'verification.mobile.aliyun_sign_name' }).execute()
    await Promise.all([
      ['verification.mobile.aliyun_template_register', 'SMS_REGISTER'],
      ['verification.mobile.aliyun_template_forgot_password', 'SMS_FORGOT'],
      ['verification.mobile.aliyun_template_profile_update', 'SMS_PROFILE'],
      ['verification.mobile.aliyun_template_test', 'SMS_TEST'],
    ].map(([key, value]) => configRepo.createQueryBuilder().update(SystemConfig).set({ configValue: value }).where('config_key = :key', { key }).execute()))
    const readyConfigs = await systemConfigService.getVerificationProviderConfigs()
    assert.equal(readyConfigs.mobile.ready, true, '阿里云短信只有启用、签名、模板、AK 和 HMAC 均就绪时才可用')
    assert.equal((await clientAuthService.getCapabilities()).channels.mobile, true, '客户端能力必须基于 provider ready 而不是单独 enabled')

    await configRepo.createQueryBuilder().update(SystemConfig).set({ configValue: '0' }).where('config_key = :key', { key: 'verification.mobile.enabled' }).execute()
    await assert.rejects(
      () => verificationService.sendCode({ channel: 'mobile', target: '13800001111', scene: 'register' }),
      /未就绪/,
      '公共发送必须拒绝已关闭的阿里云短信通道',
    )
    await configRepo.createQueryBuilder().update(SystemConfig).set({ configValue: '1' }).where('config_key = :key', { key: 'verification.mobile.enabled' }).execute()

    const sent = await verificationService.sendCode({ channel: 'mobile', target: '13800001111', scene: 'register' })
    assert.equal(sent.provider, 'aliyun_dypns')
    assert.equal('code' in sent, false, '阿里云动态码发送结果不得向调用方返回验证码')
    assert.match(sent.outId, /^[0-9a-f-]{36}$/i)
    assert.equal(sent.targetMasked, '138****1111')
    assert.deepEqual(sentRequests[0], {
      phoneNumber: '13800001111',
      countryCode: '86',
      outId: sent.outId,
      scene: 'register',
      config: {
        signName: 'Y-Link 测试签名',
        schemeName: '',
        templates: { register: 'SMS_REGISTER', forgotPassword: 'SMS_FORGOT', profileUpdate: 'SMS_PROFILE', test: 'SMS_TEST' },
      },
    })
    const acceptedRecord = await recordRepo.findOneByOrFail({ outId: sent.outId })
    assert.equal(acceptedRecord.sendStatus, 'sent')
    assert.equal(JSON.stringify(acceptedRecord).includes('13800001111'), false, '记录不得保存完整手机号')
    assert.equal(JSON.stringify(acceptedRecord).includes('123456'), false, '记录不得保存验证码')

    await verificationService.verifyCode({ channel: 'mobile', target: '13800001111', scene: 'register', code: '123456' })
    assert.deepEqual(checkedRequests[0], {
      phoneNumber: '13800001111', countryCode: '86', outId: sent.outId, verifyCode: '123456', schemeName: '',
    })
    assert.equal((await recordRepo.findOneByOrFail({ outId: sent.outId })).verificationStatus, 'passed')
    await assert.rejects(
      () => verificationService.verifyCode({ channel: 'mobile', target: '13800001111', scene: 'register', code: '123456' }),
      /验证码不存在或已过期|验证码已完成核验/,
      '已通过的验证码不得再次使用',
    )

    const receiptWorker = new AliyunDypnsMnsWorkerService(recordService)
    const officialReportTime = '2026-09-04 10:20:30'
    assert.equal(await receiptWorker.applyReceiptMessage(Buffer.from(JSON.stringify({
      send_time: '2026-09-04 10:19:30',
      report_time: officialReportTime,
      success: true,
      sms_size: '70',
      err_msg: '',
      err_code: '',
      phone_number: '13800001111',
      biz_id: acceptedRecord.bizId,
      out_id: sent.outId,
    })).toString('base64')), 'updated', '官方扁平 DypnsSmsVerifyReport 必须作为主路径受理')
    assert.equal(
      (await recordRepo.findOneByOrFail({ outId: sent.outId })).reportedAt?.toISOString(),
      '2026-09-04T02:20:30.000Z',
      '官方 report_time 必须按 Asia/Shanghai 解析并落库',
    )
    assert.equal(await receiptWorker.applyReceiptMessage({
      messageType: 'DypnsSmsVerifyReport',
      data: { out_id: sent.outId, delivery_status: 'DELIVERED' },
    }), 'malformed', '缺少官方必填字段的兼容结构必须作为毒消息拒绝')
    assert.equal((await recordRepo.findOneByOrFail({ outId: sent.outId })).deliveryStatus, 'delivered')
    assert.equal(await receiptWorker.applyReceiptMessage(Buffer.from(JSON.stringify({
      messageType: 'DypnsSmsVerifyReport',
      data: { out_id: sent.outId, delivery_status: 'SUCCESS' },
    })).toString('base64')), 'malformed', 'Base64 解码后仍必须严格校验官方平铺字段')
    assert.equal(await receiptWorker.applyReceiptMessage('{"__proto__":{"polluted":true}}'), 'malformed', '回执原型键必须拒绝')

    const deletedMessages: Array<{ queueName: string; receiptHandle: string }> = []
    const rpcRequests: Array<{ action: string; params: Record<string, unknown> }> = []
    let mnsClientInput: Record<string, unknown> | null = null
    const injectedMnsWorker = new AliyunDypnsMnsWorkerService(recordService, {
      createPopClient: (input) => {
        assert.equal(input.accessKeyId, 'test-access-key-id')
        assert.equal(input.accessKeySecret, 'test-access-key-secret')
        return {
          async request(action, params) {
            rpcRequests.push({ action, params: params as Record<string, unknown> })
            return {
              Code: 'OK',
              MessageTokenDTO: {
                AccessKeyId: 'temporary-key-id',
                AccessKeySecret: 'temporary-key-secret',
                SecurityToken: 'temporary-security-token',
                ExpireTime: '2026-09-04 10:20:30',
              },
            }
          },
        }
      },
      createMnsClient: (input) => {
        mnsClientInput = { ...input }
        return {
          async batchReceiveMessage(queueName, numOfMessages, waitSeconds) {
            assert.equal(queueName, 'Alicom-Queue-1873897471328909-DypnsSmsVerifyReport')
            assert.equal(numOfMessages, 10)
            assert.equal(waitSeconds, 5)
            return {
              body: [{
                ReceiptHandle: 'receipt-handle-001',
                MessageBody: Buffer.from(JSON.stringify({
                  send_time: '2026-09-04 10:19:30',
                  report_time: '2026-09-04 10:20:30',
                  success: true,
                  sms_size: '70',
                  err_msg: '',
                  err_code: '',
                  phone_number: '13800001111',
                  biz_id: acceptedRecord.bizId,
                  out_id: sent.outId,
                })).toString('base64'),
              }, {
                ReceiptHandle: 'receipt-handle-unknown',
                MessageBody: Buffer.from(JSON.stringify({
                  send_time: '2026-09-04 10:19:30',
                  report_time: '2026-09-04 10:20:30',
                  success: false,
                  sms_size: '70',
                  err_msg: '投递失败',
                  err_code: 'DELIVERY_FAILED',
                  phone_number: '13800002222',
                  biz_id: 'external-biz-id',
                  out_id: 'external-out-id-1',
                })).toString('base64'),
              }],
            }
          },
          async deleteMessage(queueName, receiptHandle) {
            deletedMessages.push({ queueName, receiptHandle })
            return {}
          },
        }
      },
    })
    assert.equal(injectedMnsWorker.getStatus().configured, true, '已配置凭证的 MNS 状态必须可用')
    assert.equal(await injectedMnsWorker.runOnce(), 2, 'MNS worker 必须兼容 SDK 直接返回的消息数组并处理未知 outId')
    assert.deepEqual(rpcRequests, [{
      action: 'QueryTokenForMnsQueue',
      params: {
        MessageType: 'DypnsSmsVerifyReport',
        QueueName: 'Alicom-Queue-1873897471328909-DypnsSmsVerifyReport',
        RegionId: 'cn-hangzhou',
      },
    }], 'STS 请求必须绑定固定短信回执队列')
    assert.equal(mnsClientInput?.accountId, '1943695596114318')
    assert.equal(mnsClientInput?.endpoint, 'https://1943695596114318.mns.cn-hangzhou.aliyuncs.com')
    assert.equal(mnsClientInput?.securityToken, 'temporary-security-token')
    assert.deepEqual(deletedMessages, [{
      queueName: 'Alicom-Queue-1873897471328909-DypnsSmsVerifyReport',
      receiptHandle: 'receipt-handle-001',
    }, {
      queueName: 'Alicom-Queue-1873897471328909-DypnsSmsVerifyReport',
      receiptHandle: 'receipt-handle-unknown',
    }], '成功或未知 outId 的确定性回执必须确认删除')

    const listedReceipts = await recordService.listReceipts({ page: 1, pageSize: 20, scene: 'register', deliveryStatus: 'delivered' })
    assert.equal(listedReceipts.items.length, 1)
    assert.deepEqual(Object.keys(listedReceipts.items[0] ?? {}).sort(), [
      'bizId', 'createdAt', 'deliveryStatus', 'errorCode', 'outId', 'reportedAt',
      'scene', 'sendStatus', 'sentAt', 'targetMasked', 'verificationStatus', 'verifiedAt',
    ].sort(), '回执查询只允许返回脱敏状态字段')

    const unknownResult = await verificationService.sendCode({ channel: 'mobile', target: '13800001111', scene: 'forgot_password' })
    verifyResult = 'UNKNOWN'
    await assert.rejects(
      () => verificationService.verifyCode({ channel: 'mobile', target: '13800001111', scene: 'forgot_password', code: '111111' }),
      /验证码校验未通过，请重新获取后再试/,
    )
    assert.equal((await recordRepo.findOneByOrFail({ outId: unknownResult.outId })).verificationStatus, 'failed')

    const dypnsConfig = {
      signName: 'Y-Link 测试签名',
      schemeName: '',
      templates: { register: 'SMS_REGISTER', forgotPassword: 'SMS_FORGOT', profileUpdate: 'SMS_PROFILE', test: 'SMS_TEST' },
    }
    for (const sendFailure of [
      { code: 'INVALID_TEMPLATE', success: true, message: '发送失败' },
      { code: 'OK', success: false, message: '发送失败' },
    ]) {
      const failedSendService = new SmsVerificationRecordService({
        async send() { return sendFailure },
        async check() { return { code: 'OK', success: true, verifyResult: 'PASS' } },
      }, recordRepo)
      await assert.rejects(
        () => failedSendService.send({ target: '13800003333', scene: 'test', config: dypnsConfig }),
        /短信验证码发送失败/,
        'Send 只有 Code=OK 且 Success=true 才能受理',
      )
    }
    const thrownSendService = new SmsVerificationRecordService({
      async send() { throw new Error('上游回显验证码 654321') },
      async check() { return { code: 'OK', success: true, verifyResult: 'PASS' } },
    }, recordRepo)
    await assert.rejects(
      () => thrownSendService.send({ target: '13800004444', scene: 'test', config: dypnsConfig }),
      /短信验证码发送服务暂不可用/,
      'Send 抛错必须落失败状态而不透传上游错误',
    )
    const thrownSendRecord = await recordRepo.createQueryBuilder('record').orderBy('record.createdAt', 'DESC').getOneOrFail()
    assert.equal(thrownSendRecord.providerErrorMessage?.includes('654321'), false, '发送失败记录不得保存验证码文本')

    let checkResponse = { code: 'OK', success: true, verifyResult: 'REJECT', message: '验证码 654321 无效' }
    const nonPassService = new SmsVerificationRecordService({
      async send() { return { code: 'OK', success: true, bizId: 'biz-non-pass' } },
      async check() { return checkResponse },
    }, recordRepo)
    const nonPassRecord = await nonPassService.send({ target: '13800005555', scene: 'test', config: dypnsConfig })
    await assert.rejects(
      () => nonPassService.verify({ target: '13800005555', scene: 'test', code: '654321', schemeName: '' }),
      /验证码校验服务暂不可用/,
      'Code=OK、Success=true 但 VerifyResult 非 PASS 时绝不能成功',
    )
    assert.equal((await recordRepo.findOneByOrFail({ outId: nonPassRecord.outId })).providerErrorMessage?.includes('654321'), false, '核验失败记录不得保存验证码文本')
    checkResponse = { code: 'CHECK_FAILED', success: true, verifyResult: 'PASS', message: '失败' }
    await assert.rejects(
      () => nonPassService.verify({ target: '13800005555', scene: 'test', code: '654321', schemeName: '' }),
      /验证码校验服务暂不可用/,
      'Check 即使返回 PASS，也必须同时满足 Code=OK 与 Success=true',
    )
    checkResponse = { code: 'OK', success: false, verifyResult: 'PASS', message: '失败' }
    await assert.rejects(
      () => nonPassService.verify({ target: '13800005555', scene: 'test', code: '654321', schemeName: '' }),
      /验证码校验服务暂不可用/,
      'Check 的 Success=false 不能形成成功路径',
    )

    const checkResolvers: Array<() => void> = []
    const concurrentVerifyService = new SmsVerificationRecordService({
      async send() { return { code: 'OK', success: true, bizId: 'biz-concurrent' } },
      async check() {
        await new Promise<void>((resolve) => checkResolvers.push(resolve))
        return { code: 'OK', success: true, verifyResult: 'PASS' }
      },
    }, recordRepo)
    await concurrentVerifyService.send({ target: '13800006666', scene: 'profile_update', config: dypnsConfig })
    const concurrentResultsPromise = Promise.allSettled([
      concurrentVerifyService.verify({ target: '13800006666', scene: 'profile_update', code: '123456', schemeName: '' }),
      concurrentVerifyService.verify({ target: '13800006666', scene: 'profile_update', code: '123456', schemeName: '' }),
    ])
    for (let attempt = 0; attempt < 20 && checkResolvers.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(checkResolvers.length, 2, '并发核验必须在状态更新前同时进入远端检查')
    checkResolvers.splice(0).forEach((resolve) => resolve())
    const concurrentResults = await concurrentResultsPromise
    assert.equal(concurrentResults.filter((result) => result.status === 'fulfilled').length, 1, '并发 PASS 只能有一个请求消耗验证码')
    assert.equal(concurrentResults.filter((result) => result.status === 'rejected').length, 1, '并发重复核验必须失败')

    const oldRecordAt = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000)
    const oldTerminalRecord = await recordRepo.save(recordRepo.create({
      outId: 'cleanup-terminal-record', bizId: null, channel: 'mobile', scene: 'test', targetDigest: 'a'.repeat(64), targetMasked: '138****7777',
      sendStatus: 'sent', deliveryStatus: 'delivered', verificationStatus: 'pending', providerErrorCode: null, providerErrorMessage: null,
      sentAt: oldRecordAt, reportedAt: oldRecordAt, verifiedAt: null, expiresAt: oldRecordAt,
    }))
    const oldExpiredPendingRecord = await recordRepo.save(recordRepo.create({
      outId: 'cleanup-pending-record', bizId: null, channel: 'mobile', scene: 'test', targetDigest: 'b'.repeat(64), targetMasked: '138****8888',
      sendStatus: 'sent', deliveryStatus: 'pending', verificationStatus: 'pending', providerErrorCode: null, providerErrorMessage: null,
      sentAt: oldRecordAt, reportedAt: null, verifiedAt: null, expiresAt: oldRecordAt,
    }))
    const oldUnexpiredPendingRecord = await recordRepo.save(recordRepo.create({
      outId: 'cleanup-unexpired-pending-record', bizId: null, channel: 'mobile', scene: 'test', targetDigest: 'c'.repeat(64), targetMasked: '138****9999',
      sendStatus: 'sent', deliveryStatus: 'pending', verificationStatus: 'pending', providerErrorCode: null, providerErrorMessage: null,
      sentAt: oldRecordAt, reportedAt: null, verifiedAt: null, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    }))
    const recentExpiredPendingRecord = await recordRepo.save(recordRepo.create({
      outId: 'cleanup-recent-expired-pending-record', bizId: null, channel: 'mobile', scene: 'test', targetDigest: 'd'.repeat(64), targetMasked: '138****0000',
      sendStatus: 'sent', deliveryStatus: 'pending', verificationStatus: 'pending', providerErrorCode: null, providerErrorMessage: null,
      sentAt: new Date(), reportedAt: null, verifiedAt: null, expiresAt: oldRecordAt,
    }))
    await recordRepo.update({ id: oldTerminalRecord.id }, { createdAt: oldRecordAt })
    await recordRepo.update({ id: oldExpiredPendingRecord.id }, { createdAt: oldRecordAt })
    await recordRepo.update({ id: oldUnexpiredPendingRecord.id }, { createdAt: oldRecordAt })
    assert.equal(await recordService.cleanupExpiredRecords(), 2, '90 天清理必须删除终态或已过期的记录')
    assert.equal(await recordRepo.findOneBy({ id: oldTerminalRecord.id }), null)
    assert.equal(await recordRepo.findOneBy({ id: oldExpiredPendingRecord.id }), null, '已过期 pending 记录不得无限保留')
    assert.notEqual(await recordRepo.findOneBy({ id: oldUnexpiredPendingRecord.id }), null, '未过期 pending 记录不得被 90 天清理误删')
    assert.notEqual(await recordRepo.findOneBy({ id: recentExpiredPendingRecord.id }), null, '不足 90 天的记录不得被清理')

    const buildMnsSdk = (batchReceiveMessage: () => Promise<unknown>, deleteMessage: (queueName: string, receiptHandle: string) => Promise<unknown>) => ({
      createPopClient: () => ({
        async request() {
          return {
            Code: 'OK',
            MessageTokenDTO: {
              AccessKeyId: 'temporary-key-id', AccessKeySecret: 'temporary-key-secret', SecurityToken: 'temporary-security-token',
              ExpireTime: '2026-09-04 10:20:30',
            },
          }
        },
      }),
      createMnsClient: () => ({ batchReceiveMessage, deleteMessage }),
    })
    const emptyQueueWorker = new AliyunDypnsMnsWorkerService(recordService, buildMnsSdk(
      async () => {
        const error = new Error('Message not exist')
        error.name = 'MNSMessageNotExistError'
        throw error
      },
      async () => { throw new Error('空队列不应删除消息') },
    ))
    assert.equal(await emptyQueueWorker.runOnce(), 0, 'MessageNotExist 必须作为正常空队列处理')

    const dbFailureDeletes: string[] = []
    const dbFailureWorker = new AliyunDypnsMnsWorkerService({
      async applyReceipt() { throw new Error('数据库暂态失败') },
      async cleanupExpiredRecords() { return 0 },
    }, buildMnsSdk(
      async () => ({ body: [{ ReceiptHandle: 'db-failure-handle', MessageBody: Buffer.from(JSON.stringify({
        send_time: '2026-09-04 10:19:30', report_time: '2026-09-04 10:20:30', success: true, sms_size: '70', err_msg: '', err_code: '',
        phone_number: '13800001111', biz_id: acceptedRecord.bizId, out_id: sent.outId,
      })).toString('base64') }] }),
      async (_queueName, receiptHandle) => { dbFailureDeletes.push(receiptHandle); return {} },
    ))
    await assert.rejects(() => dbFailureWorker.runOnce(), /数据库暂态失败/, '数据库暂态失败必须使消息保留')
    assert.deepEqual(dbFailureDeletes, [], '数据库异常时不得确认删除回执消息')

    const maintenanceDeletes: string[] = []
    const maintenanceTaskId = `maintenance-${runId}`
    const maintenanceWorker = new AliyunDypnsMnsWorkerService(recordService, buildMnsSdk(
      async () => {
        await databaseMaintenanceModeService.beginReadOnly({ taskId: maintenanceTaskId, phase: 'verification-test' })
        return { body: [{ ReceiptHandle: 'maintenance-handle', MessageBody: Buffer.from(JSON.stringify({
          send_time: '2026-09-04 10:19:30', report_time: '2026-09-04 10:20:30', success: true, sms_size: '70', err_msg: '', err_code: '',
          phone_number: '13800001111', biz_id: acceptedRecord.bizId, out_id: sent.outId,
        })).toString('base64') }] }
      },
      async (_queueName, receiptHandle) => { maintenanceDeletes.push(receiptHandle); return {} },
    ))
    try {
      assert.equal(await maintenanceWorker.runOnce(), 1)
      assert.deepEqual(maintenanceDeletes, [], '维护切换后未取得写租约时不得确认删除消息')
    } finally {
      await databaseMaintenanceModeService.finishReadOnly(maintenanceTaskId)
    }

    await configRepo.createQueryBuilder().update(SystemConfig).set({ configValue: 'generic_http' }).where('config_key = :key', { key: 'verification.mobile.provider_type' }).execute()
    await configRepo.createQueryBuilder().update(SystemConfig).set({ configValue: 'https://example.com/verification' }).where('config_key = :key', { key: 'verification.mobile.api_url' }).execute()
    const genericResult = await verificationService.sendCode({ channel: 'mobile', target: '13800002222', scene: 'register' })
    assert.equal(genericResult.provider, 'generic_http', 'generic_http 既有发送逻辑必须保持可用')
    assert.equal(genericCodes.length, 1, 'generic_http 仍应使用内存票据生成验证码')
  } finally {
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy()
    }
  }
}

main()
  .then(() => console.log('OK 阿里云 PNVS 短信验证码专项验证通过'))
  .catch((error) => {
    console.error('[verification-aliyun] 验证失败:', error)
    process.exitCode = 1
  })
  .finally(() => {
    fs.rmSync(runtimeDir, { recursive: true, force: true })
  })
