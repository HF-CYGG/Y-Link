/** 通知 Outbox 装配契约静态验收；无需数据库驱动，适用于最小化 CI 镜像。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relativePath) => fs.readFileSync(path.resolve(backendRoot, relativePath), 'utf8')

const service = read('src/services/notification.service.ts')
const eventEntity = read('src/entities/notification-event.entity.ts')
const inboxEntity = read('src/entities/notification-inbox.entity.ts')
const dispatchEntity = read('src/entities/notification-dispatch.entity.ts')
const bootstrap = read('src/config/database-bootstrap.ts')
const index = read('src/index.ts')
const o2oService = read('src/services/o2o-preorder.service.ts')
const feedbackService = read('src/services/client-feedback.service.ts')
const mysqlMigration = read('sql/036_notification_outbox.sql')

const emitStart = service.indexOf('async emitEvent(')
const emitEnd = service.indexOf('private async processClaimedOutboxEvent', emitStart)
assert.ok(emitStart >= 0 && emitEnd > emitStart, '必须保留独立 emitEvent 与后台处理边界')
const emitBody = service.slice(emitStart, emitEnd)
assert.match(emitBody, /eventRepo\.insert/, 'emitEvent 必须只持久化 outbox 事件')
assert.doesNotMatch(emitBody, /sendEmailByVerificationProvider|sendFeishuWebhook|resolveRuleRecipients/, '热路径不得调用外部通道或展开收件人')
assert.match(emitBody, /manager\?\.getRepository\(NotificationEvent\)/, 'emitEvent 必须支持复用业务事务 manager')
assert.match(
  o2oService,
  /inventoryLogRepo\.save\(inventoryLogs\)[\s\S]{0,800}notificationService\.emitEvent\([\s\S]{0,600},\s*manager\)[\s\S]{0,200}created:\s*true/,
  '新订单与 outbox 事件必须在同一幂等事务提交',
)
const feedbackTransactionalEmits = feedbackService.match(/notificationService\.emitEvent\([\s\S]{0,700},\s*manager\)/g) ?? []
assert.equal(feedbackTransactionalEmits.length, 2, '新反馈会话与客户端追加消息必须各自在业务事务内写 outbox')

assert.match(eventEntity, /'pending',\s*'processing',\s*'processed',\s*'failed'/, '事件必须包含 processing 租约状态')
for (const field of ['attempt_count', 'next_attempt_at', 'processing_started_at', 'processing_owner', 'processed_at']) {
  assert.ok(eventEntity.includes(field), `事件实体缺少 ${field}`)
  assert.ok(bootstrap.includes(field), `SQLite bootstrap 缺少 ${field}`)
  assert.ok(mysqlMigration.includes(field), `MySQL 迁移缺少 ${field}`)
}

assert.match(service, /registerInFlightWrite\(\)/, 'Worker 必须登记数据库维护在途写租约')
assert.doesNotMatch(service, /attemptCount:\s*\(\)\s*=>\s*['"]attempt_count\s*\+\s*1/, '事件领取不得提前消耗失败重试额度')
assert.match(service, /completedFailureCount/, '只有已经完成的失败才能增加事件/投递重试计数')
assert.match(service, /已恢复升级前遗留的通知处理租约/, '必须恢复旧版第 5 次领取后崩溃的陈旧租约')
assert.match(service, /claim\.affected\s*!==\s*1/, '事件领取必须检查 CAS affected 结果')
assert.match(service, /NOTIFICATION_OUTBOX_MAX_ATTEMPTS\s*=\s*5/, '必须配置有限重试上限')
assert.match(service, /NOTIFICATION_OUTBOX_RETRY_DELAYS_MS/, '必须配置退避而非立即热循环')
assert.match(service, /processingStartedAt:\s*new Date\(\)/, '长外发前必须刷新处理租约')
assert.match(index, /notificationService\.startOutboxWorker\(\)/, '启动入口必须装配通知 Worker')

assert.match(inboxEntity, /uk_notification_inbox_event_user[\s\S]*unique:\s*true/, '收件箱必须以事件+账号唯一')
assert.match(dispatchEntity, /uk_notification_dispatch_event_channel_target[\s\S]*unique:\s*true/, '外发记录必须以事件+渠道+目标摘要唯一')
assert.match(dispatchEntity, /dedupe_key/, '外发记录必须保存不可逆目标摘要')
assert.match(mysqlMigration, /CREATE UNIQUE INDEX uk_notification_inbox_event_user/, 'MySQL 迁移必须补收件箱唯一键')
assert.match(mysqlMigration, /CREATE UNIQUE INDEX uk_notification_dispatch_event_channel_target/, 'MySQL 迁移必须补外发唯一键')
assert.doesNotMatch(mysqlMigration, /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/i, 'MySQL 8.4 不支持 ADD COLUMN IF NOT EXISTS')
assert.match(mysqlMigration, /information_schema\.COLUMNS/, 'MySQL 补列必须使用 information_schema + PREPARE 幂等 DDL')
assert.match(mysqlMigration, /merged_is_read/, '历史收件箱去重前必须合并已读状态')
assert.match(mysqlMigration, /tmp_notification_dispatch_dedupe/, '外发唯一键创建前必须清理中断升级留下的重复记录')

console.log('OK 通知 Outbox 热路径、CAS 领取、维护租约、有限重试与幂等装配契约通过')
