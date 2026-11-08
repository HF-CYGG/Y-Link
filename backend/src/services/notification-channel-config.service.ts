/**
 * 模块说明：backend/src/services/notification-channel-config.service.ts
 * 文件职责：维护通知共用飞书连接、邮件主题前缀与逐规则连接来源，保留旧规则密文及原始投递目标。
 * 实现逻辑：系统配置 GET 纯读，缺项以内存默认值返回；显式治理写先锁账号，再锁固定顺序配置行。
 * 维护说明：邮件网关始终复用 verification.email；本服务不复制网关配置、不发网络请求、不自动迁移旧目标。
 */
import { type EntityManager } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import { runInTransaction } from '../config/transaction-runner.js'
import { SystemConfig } from '../entities/system-config.entity.js'
import { NotificationRule, FEISHU_WEBHOOK_SEAL_CONTEXT, FEISHU_SIGN_SECRET_SEAL_CONTEXT } from '../entities/notification-rule.entity.js'
import { openSensitiveValue, sealSensitiveValue } from '../utils/data-encryption.js'
import { BizError } from '../utils/errors.js'
import type { AuthUserContext } from '../types/auth.js'
import type { RequestMeta } from '../utils/request-meta.js'
import { detectUnsafeHost, formatUnsafeHostReason } from '../utils/safe-network.js'
import { lockActiveSysAccountForBusiness, assertSysAccountGovernancePermission } from './account-business-guard.service.js'
import { auditService } from './audit.service.js'

export const FEISHU_SIGN_SECRET_PLACEHOLDER = '[已配置签名密钥，保存时保留原值]'
export const FEISHU_WEBHOOK_PLACEHOLDER = '[已配置 Webhook，保存时保留原值]'
const WEBHOOK_KEY = 'notification.feishu.webhook_url'
const SIGN_KEY = 'notification.feishu.sign_secret'
const PREFIX_KEY = 'notification.email.subject_prefix'
const MODES_KEY = 'notification.feishu.shared_rule_modes'
const CONFIG_KEYS = [WEBHOOK_KEY, SIGN_KEY, PREFIX_KEY, MODES_KEY].sort()
const contextFor = (key: string) => `system_config:${key}`

export function normalizeFeishuWebhookUrl(rawValue: string): string {
  const text = rawValue.trim()
  if (!text) return ''
  let url: URL
  try { url = new URL(text) } catch { throw new BizError('飞书 Webhook 地址格式不正确', 400) }
  if (url.protocol !== 'https:') throw new BizError('飞书 Webhook 仅支持 HTTPS 地址', 400)
  if (!new Set(['open.feishu.cn', 'open.larksuite.com']).has(url.hostname.toLowerCase())) {
    throw new BizError('飞书 Webhook 仅允许使用飞书官方机器人地址', 400)
  }
  const reason = detectUnsafeHost(url.hostname)
  if (reason) throw new BizError(`飞书 Webhook 禁止使用${formatUnsafeHostReason(reason)}`, 400)
  if (!/^\/open-apis\/bot\/v2\/hook\/[^/?#]+\/?$/.test(url.pathname) || url.username || url.password) {
    throw new BizError('飞书 Webhook 必须是机器人 hook 地址', 400)
  }
  url.hash = ''
  if (url.toString().length > 300) throw new BizError('飞书 Webhook 地址长度不能超过 300 个字符', 400)
  return url.toString()
}

export function normalizeFeishuSignSecretInput(secret: string): string | null {
  const value = secret.trim()
  if (!value || value === FEISHU_SIGN_SECRET_PLACEHOLDER) return null
  if (value.length > 128) throw new BizError('飞书签名密钥长度不能超过 128 个字符', 400)
  return value
}

export interface UpdateNotificationChannelsInput {
  feishuWebhookUrl?: string
  feishuSignSecret?: string
  clearFeishuWebhook?: boolean
  clearFeishuSignSecret?: boolean
  emailSubjectPrefix?: string
}

export interface NotificationChannelsRecord {
  email: { enabled: boolean; configured: boolean; statusError: string | null }
  feishu: { webhookConfigured: boolean; signSecretConfigured: boolean; webhookStatusError: string | null; signSecretStatusError: string | null; statusError: string | null; legacyRuleCount: number }
  emailSubjectPrefix: string
  emailSubjectPrefixConfigured: boolean
  updatedAt: Date | null
}

export interface NotificationChannelState {
  rows: Map<string, SystemConfig>
  webhook: ReturnType<typeof openSensitiveValue>
  sign: ReturnType<typeof openSensitiveValue>
  modes: Record<string, boolean>
  subjectPrefix: string | null
}

export interface LegacyFeishuState { webhookPresent: boolean; webhookUnreadable: boolean; signUnreadable: boolean }

class NotificationChannelConfigService {
  async load(manager: EntityManager = AppDataSource.manager): Promise<NotificationChannelState> {
    const rows = await manager.getRepository(SystemConfig).find({ where: CONFIG_KEYS.map((configKey) => ({ configKey })) })
    return this.toState(rows)
  }

  private toState(rows: SystemConfig[]): NotificationChannelState {
    const byKey = new Map(rows.map((row) => [row.configKey, row]))
    const rawModes = byKey.get(MODES_KEY)?.configValue || '{}'
    let modes: Record<string, boolean>
    try {
      const parsed: unknown = JSON.parse(rawModes)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || Object.values(parsed).some((value) => typeof value !== 'boolean')) throw new Error('invalid')
      modes = parsed as Record<string, boolean>
    } catch { throw new BizError('通知规则连接来源配置异常，请联系管理员检查', 500) }
    return {
      rows: byKey,
      webhook: openSensitiveValue(contextFor(WEBHOOK_KEY), byKey.get(WEBHOOK_KEY)?.configValue),
      sign: openSensitiveValue(contextFor(SIGN_KEY), byKey.get(SIGN_KEY)?.configValue),
      modes,
      subjectPrefix: byKey.get(PREFIX_KEY)?.configValue.trim() || null,
    }
  }

  /** 仅在已经锁定有效治理 actor 的显式写事务内调用。 */
  async lockForWrite(manager: EntityManager): Promise<NotificationChannelState> {
    const repo = manager.getRepository(SystemConfig)
    // 固定键顺序初始化再取锁，多个管理员并发首次配置也不覆盖既有密文。
    for (const configKey of CONFIG_KEYS) {
      await repo.createQueryBuilder().insert().values({ configKey, configValue: '', configGroup: 'notification', remark: '通知共用通道配置' }).orIgnore().execute()
    }
    const query = repo.createQueryBuilder('config').where('config.configKey IN (:...keys)', { keys: CONFIG_KEYS }).orderBy('config.configKey', 'ASC')
    if (manager.connection.options.type === 'mysql') query.setLock('pessimistic_write')
    return this.toState(await query.getMany())
  }

  async saveModes(manager: EntityManager, state: NotificationChannelState, modes: Record<string, boolean>): Promise<boolean> {
    if (JSON.stringify(state.modes) === JSON.stringify(modes)) return false
    await manager.getRepository(SystemConfig).update({ configKey: MODES_KEY }, { configValue: JSON.stringify(modes) })
    return true
  }

  async legacyStates(manager: EntityManager = AppDataSource.manager): Promise<Map<string, LegacyFeishuState>> {
    const rows = await manager.getRepository(NotificationRule).createQueryBuilder('rule')
      .select('rule.id', 'id').addSelect('rule.feishu_webhook_url', 'webhook').addSelect('rule.feishu_sign_secret', 'sign')
      .getRawMany<{ id: string | number; webhook: string | null; sign: string | null }>()
    return new Map(rows.map((row) => [String(row.id), {
      webhookPresent: Boolean(row.webhook?.trim()),
      webhookUnreadable: openSensitiveValue(FEISHU_WEBHOOK_SEAL_CONTEXT, row.webhook).state === 'unreadable',
      signUnreadable: openSensitiveValue(FEISHU_SIGN_SECRET_SEAL_CONTEXT, row.sign).state === 'unreadable',
    }]))
  }

  resolveFeishu(
    rule: Pick<NotificationRule, 'ruleCode' | 'feishuWebhookUrl' | 'feishuSignSecret'>,
    state: NotificationChannelState,
    legacy?: LegacyFeishuState,
    explicitMode?: boolean,
  ) {
    const useSharedFeishu = explicitMode ?? state.modes[rule.ruleCode] ?? !(legacy?.webhookPresent || rule.feishuWebhookUrl?.trim())
    const configured = useSharedFeishu ? state.webhook.state !== 'empty' : Boolean(legacy?.webhookPresent || rule.feishuWebhookUrl?.trim())
    const unreadable = useSharedFeishu
      ? state.webhook.state === 'unreadable' || state.sign.state === 'unreadable'
      : Boolean(legacy?.webhookUnreadable || legacy?.signUnreadable)
    return {
      useSharedFeishu,
      feishuConfigSource: (configured ? (useSharedFeishu ? 'shared' : 'legacy') : 'none') as 'shared' | 'legacy' | 'none',
      webhookUrl: useSharedFeishu ? state.webhook.value : (rule.feishuWebhookUrl?.trim() || ''),
      signSecret: useSharedFeishu ? state.sign.value || null : rule.feishuSignSecret?.trim() || null,
      configured,
      statusError: unreadable ? '飞书连接无法用当前数据加密密钥解密，请恢复密钥或重新填写连接信息' : null,
    }
  }

  async getChannels(manager: EntityManager = AppDataSource.manager): Promise<NotificationChannelsRecord> {
    const state = await this.load(manager)
    const emailRows = await manager.getRepository(SystemConfig).find({ where: [
      'verification.email.enabled', 'verification.email.api_url', 'verification.email.headers_template', 'verification.email.body_template',
    ].map((configKey) => ({ configKey })) })
    const emailValues = new Map(emailRows.map((row) => [row.configKey, row.configValue]))
    const emailEnabled = emailValues.get('verification.email.enabled') === '1'
    const emailSensitive = ['api_url', 'headers_template', 'body_template'].map((suffix) => {
      const key = `verification.email.${suffix}`
      return openSensitiveValue(contextFor(key), emailValues.get(key))
    })
    const emailUnreadable = emailSensitive.some((value) => value.state === 'unreadable')
    const legacy = await this.legacyStates(manager)
    const rules = await manager.getRepository(NotificationRule).find({ select: { id: true, ruleCode: true } })
    return {
      email: {
        enabled: emailEnabled,
        configured: Boolean(emailSensitive[0]?.value.trim()) && !emailUnreadable,
        statusError: emailUnreadable ? '共用邮件服务配置无法解密，请到验证码平台重新录入' : null,
      },
      feishu: {
        webhookConfigured: state.webhook.state !== 'empty',
        signSecretConfigured: state.sign.state !== 'empty',
        webhookStatusError: state.webhook.state === 'unreadable' ? '共用飞书 Webhook 无法解密，请恢复密钥或重新录入' : null,
        signSecretStatusError: state.sign.state === 'unreadable' ? '共用飞书签名密钥无法解密，请恢复密钥、重新录入或显式清空' : null,
        statusError: state.webhook.state === 'unreadable' || state.sign.state === 'unreadable' ? '共用飞书连接无法解密，请恢复密钥或重新录入' : null,
        legacyRuleCount: rules.filter((rule) => legacy.get(String(rule.id))?.webhookPresent && state.modes[rule.ruleCode] !== true).length,
      },
      emailSubjectPrefix: state.subjectPrefix || '[Y-Link]',
      emailSubjectPrefixConfigured: state.subjectPrefix !== null,
      updatedAt: [...state.rows.values()].map((row) => row.updatedAt).sort((a, b) => b.getTime() - a.getTime())[0] ?? null,
    }
  }

  async updateChannels(input: UpdateNotificationChannelsInput, actor: AuthUserContext, requestMeta?: RequestMeta) {
    let changed = false
    await runInTransaction(async (manager) => {
      const lockedActor = await lockActiveSysAccountForBusiness(manager, actor.userId)
      assertSysAccountGovernancePermission(lockedActor, 'system_configs:update')
      const state = await this.lockForWrite(manager)
      const fields: Array<{ key: string; value?: string; clear?: boolean; placeholder: string; normalize: (text: string) => string }> = [
        { key: WEBHOOK_KEY, value: input.feishuWebhookUrl, clear: input.clearFeishuWebhook, placeholder: FEISHU_WEBHOOK_PLACEHOLDER, normalize: normalizeFeishuWebhookUrl },
        { key: SIGN_KEY, value: input.feishuSignSecret, clear: input.clearFeishuSignSecret, placeholder: FEISHU_SIGN_SECRET_PLACEHOLDER, normalize: (text) => normalizeFeishuSignSecretInput(text) || '' },
      ]
      const updatedKeys: string[] = []
      for (const field of fields) {
        const text = field.value?.trim() || ''
        if (field.clear && text && text !== field.placeholder) throw new BizError('清空连接信息时不能同时填写新值', 400)
        if (!field.clear && (!text || text === field.placeholder)) continue
        const value = field.clear ? '' : field.normalize(text)
        const current = openSensitiveValue(contextFor(field.key), state.rows.get(field.key)?.configValue)
        if (current.state !== 'unreadable' && current.value === value) continue
        await manager.getRepository(SystemConfig).update({ configKey: field.key }, { configValue: value ? sealSensitiveValue(contextFor(field.key), value) : '' })
        updatedKeys.push(field.key)
      }
      if (input.emailSubjectPrefix !== undefined) {
        const prefix = input.emailSubjectPrefix.trim()
        if (prefix.length > 128) throw new BizError('邮件主题前缀不能超过 128 个字符', 400)
        if ((state.subjectPrefix ?? '') !== prefix) {
          await manager.getRepository(SystemConfig).update({ configKey: PREFIX_KEY }, { configValue: prefix })
          updatedKeys.push(PREFIX_KEY)
        }
      }
      changed = updatedKeys.length > 0
      if (changed) await auditService.record({ actionType: 'notification.channel.update', actionLabel: '更新通知共用连接', targetType: 'system_config', targetCode: 'notification_channels', actor, requestMeta, detail: { updatedKeys } }, manager)
    })
    return { changed, config: await this.getChannels() }
  }
}

export const notificationChannelConfigService = new NotificationChannelConfigService()
