import { createHmac } from 'node:crypto'
import { In, MoreThan, type EntityManager } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import {
  NotificationRule,
  NOTIFICATION_EXTERNAL_TRIGGER_MODES,
  type NotificationExternalTriggerMode,
} from '../entities/notification-rule.entity.js'
import { NotificationEvent } from '../entities/notification-event.entity.js'
import { NotificationInbox } from '../entities/notification-inbox.entity.js'
import {
  NotificationDispatch,
  NOTIFICATION_DISPATCH_CHANNELS,
  type NotificationDispatchChannel,
} from '../entities/notification-dispatch.entity.js'
import { SysUser } from '../entities/sys-user.entity.js'
import { SysUserSession } from '../entities/sys-user-session.entity.js'
import { SystemConfig } from '../entities/system-config.entity.js'
import type { AuthUserContext } from '../types/auth.js'
import { BizError } from '../utils/errors.js'
import type { RequestMeta } from '../utils/request-meta.js'
import { auditService } from './audit.service.js'
import { systemConfigService } from './system-config.service.js'

export const NOTIFICATION_EVENT_TYPES = [
  'o2o_preorder_created',
  'customer_service_client_message_created',
] as const

export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number]

type NotificationRuleCode = 'preorder_created_rule' | 'customer_service_message_rule'

const MANAGEMENT_ROLES: Array<SysUser['role']> = ['admin', 'operator', 'supplier']
const ADMIN_MANAGEMENT_ROLES: Array<SysUser['role']> = ['admin', 'operator']
const SUPPLIER_ROLE: SysUser['role'] = 'supplier'
const NOTIFICATION_ONLINE_WINDOW_CONFIG_KEY = 'notification.online_window_seconds'
const DEFAULT_ONLINE_WINDOW_SECONDS = 120
const MIN_ONLINE_WINDOW_SECONDS = 30
const MAX_ONLINE_WINDOW_SECONDS = 3600
const HEARTBEAT_WRITE_INTERVAL_MS = 60 * 1000
const FEISHU_WEBHOOK_TIMEOUT_MS = 10 * 1000
export const FEISHU_SIGN_SECRET_PLACEHOLDER = '[已配置签名密钥，保存时保留原值]'

const DEFAULT_RULES: Array<{
  ruleCode: NotificationRuleCode
  ruleName: string
  eventType: NotificationEventType
}> = [
  {
    ruleCode: 'preorder_created_rule',
    ruleName: '新预订单通知规则',
    eventType: 'o2o_preorder_created',
  },
  {
    ruleCode: 'customer_service_message_rule',
    ruleName: '新客服消息通知规则',
    eventType: 'customer_service_client_message_created',
  },
]

export interface NotificationRuleRecord {
  id: string
  ruleCode: string
  ruleName: string
  eventType: NotificationEventType
  enabled: boolean
  recipientUserIds: string[]
  emailRecipientAdminUserIds: string[]
  emailRecipientSupplierUserIds: string[]
  emailEnabled: boolean
  feishuEnabled: boolean
  externalTriggerMode: NotificationExternalTriggerMode
  watchedUserIds: string[]
  feishuWebhookUrl: string
  feishuSignSecretMasked: boolean
  emailSubjectPrefix: string
  updatedAt: Date
}

export interface UpdateNotificationRuleInput {
  id: string
  enabled: boolean
  recipientUserIds: string[]
  emailRecipientAdminUserIds: string[]
  emailRecipientSupplierUserIds: string[]
  emailEnabled: boolean
  feishuEnabled: boolean
  externalTriggerMode: NotificationExternalTriggerMode
  watchedUserIds: string[]
  feishuWebhookUrl: string
  feishuSignSecret: string
  emailSubjectPrefix: string
}

export interface NotificationRuleTestSendInput {
  ruleId: string
  channel: 'email' | 'feishu'
  draft: UpdateNotificationRuleInput
  actor: AuthUserContext
  requestMeta?: RequestMeta
}

export interface NotificationRuleTestSendResult {
  channel: 'email' | 'feishu'
  success: boolean
  message: string
  summary: {
    attempted: number
    succeeded: number
    failed: number
  }
  failures: Array<{
    target: string
    reason: string
  }>
}

export interface NotificationPresenceSnapshot {
  serverTime: string
  onlineWindowSeconds: number
  users: Array<{
    userId: string
    username: string
    displayName: string
    role: SysUser['role']
    isOnline: boolean
    activeSessionCount: number
    lastAccessAt: string | null
  }>
}

interface NotificationEventPayload {
  showNo?: string
  conversationNo?: string
  sourceUserDisplayName?: string
  sourceUserId?: string
  summary?: string
}

interface EmitNotificationEventInput {
  eventType: NotificationEventType
  sourceType: string
  sourceId: string
  payload: NotificationEventPayload
  requestMeta?: RequestMeta
}

interface NormalizedNotificationRuleDraft {
  id: string
  ruleCode: string
  ruleName: string
  enabled: boolean
  recipientUserIds: string[]
  emailRecipientAdminUserIds: string[]
  emailRecipientSupplierUserIds: string[]
  emailEnabled: boolean
  feishuEnabled: boolean
  externalTriggerMode: NotificationExternalTriggerMode
  watchedUserIds: string[]
  feishuWebhookUrl: string
  feishuSignSecret: string | null
  emailSubjectPrefix: string
}

function parseJsonStringArray(raw: string | null | undefined): string[] {
  const text = String(raw ?? '').trim()
  if (!text) {
    return []
  }
  try {
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed
      .map((item) => String(item ?? '').trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function normalizeFeishuSignSecretInput(secret: string): string | null {
  const normalized = secret.trim()
  if (!normalized || normalized === FEISHU_SIGN_SECRET_PLACEHOLDER) {
    return null
  }
  return normalized.slice(0, 256)
}

function normalizeId(value: string | number | null | undefined): string {
  return String(value ?? '').trim()
}

function toRuleRecord(row: NotificationRule): NotificationRuleRecord {
  return {
    id: normalizeId(row.id),
    ruleCode: row.ruleCode,
    ruleName: row.ruleName,
    eventType: row.eventType as NotificationEventType,
    enabled: row.enabled > 0,
    recipientUserIds: parseJsonStringArray(row.recipientUserIdsJson),
    emailRecipientAdminUserIds: parseJsonStringArray(row.emailRecipientAdminUserIdsJson),
    emailRecipientSupplierUserIds: parseJsonStringArray(row.emailRecipientSupplierUserIdsJson),
    emailEnabled: row.emailEnabled > 0,
    feishuEnabled: row.feishuEnabled > 0,
    externalTriggerMode: row.externalTriggerMode,
    watchedUserIds: parseJsonStringArray(row.watchedUserIdsJson),
    feishuWebhookUrl: row.feishuWebhookUrl?.trim() || '',
    feishuSignSecretMasked: Boolean(row.feishuSignSecret?.trim()),
    emailSubjectPrefix: row.emailSubjectPrefix?.trim() || '',
    updatedAt: row.updatedAt,
  }
}

export class NotificationService {
  private readonly ruleRepo = AppDataSource.getRepository(NotificationRule)
  private readonly eventRepo = AppDataSource.getRepository(NotificationEvent)
  private readonly inboxRepo = AppDataSource.getRepository(NotificationInbox)
  private readonly dispatchRepo = AppDataSource.getRepository(NotificationDispatch)
  private readonly userRepo = AppDataSource.getRepository(SysUser)
  private readonly sessionRepo = AppDataSource.getRepository(SysUserSession)
  private readonly systemConfigRepo = AppDataSource.getRepository(SystemConfig)

  private normalizeOnlineWindowSeconds(value: number): number {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new BizError('离线窗口必须为整数秒', 400)
    }
    if (value < MIN_ONLINE_WINDOW_SECONDS || value > MAX_ONLINE_WINDOW_SECONDS) {
      throw new BizError(`离线窗口需在 ${MIN_ONLINE_WINDOW_SECONDS}-${MAX_ONLINE_WINDOW_SECONDS} 秒之间`, 400)
    }
    return value
  }

  private parseOnlineWindowSeconds(raw: string | null | undefined): number {
    const parsed = Number.parseInt(String(raw ?? '').trim(), 10)
    if (!Number.isFinite(parsed) || parsed < MIN_ONLINE_WINDOW_SECONDS || parsed > MAX_ONLINE_WINDOW_SECONDS) {
      return DEFAULT_ONLINE_WINDOW_SECONDS
    }
    return parsed
  }

  private async ensureOnlineWindowConfig(manager?: EntityManager): Promise<void> {
    const repo = manager ? manager.getRepository(SystemConfig) : this.systemConfigRepo
    const exists = await repo.findOne({
      where: { configKey: NOTIFICATION_ONLINE_WINDOW_CONFIG_KEY },
      select: { id: true },
    })
    if (exists) {
      return
    }
    await repo.save(repo.create({
      configKey: NOTIFICATION_ONLINE_WINDOW_CONFIG_KEY,
      configValue: String(DEFAULT_ONLINE_WINDOW_SECONDS),
      configGroup: 'notification',
      remark: '通知中心离线判定窗口（秒）',
    }))
  }

  private async getOnlineWindowSeconds(manager?: EntityManager): Promise<number> {
    const repo = manager ? manager.getRepository(SystemConfig) : this.systemConfigRepo
    const row = await repo.findOne({
      where: { configKey: NOTIFICATION_ONLINE_WINDOW_CONFIG_KEY },
      select: { configValue: true },
    })
    return this.parseOnlineWindowSeconds(row?.configValue)
  }

  async ensureDefaultRules() {
    await this.ensureOnlineWindowConfig()
    const existing = await this.ruleRepo.find({
      where: DEFAULT_RULES.map((item) => ({ ruleCode: item.ruleCode })),
      select: { id: true, ruleCode: true },
    })
    const existingCodes = new Set(existing.map((item) => item.ruleCode))
    const missingRules = DEFAULT_RULES.filter((item) => !existingCodes.has(item.ruleCode))
    if (!missingRules.length) {
      return
    }
    const entities = missingRules.map((item) =>
      this.ruleRepo.create({
        ruleCode: item.ruleCode,
        ruleName: item.ruleName,
        eventType: item.eventType,
        enabled: 1,
        recipientUserIdsJson: '[]',
        emailRecipientAdminUserIdsJson: '[]',
        emailRecipientSupplierUserIdsJson: '[]',
        emailEnabled: 0,
        feishuEnabled: 0,
        externalTriggerMode: 'all_management_offline',
        watchedUserIdsJson: '[]',
        feishuWebhookUrl: null,
        feishuSignSecret: null,
        emailSubjectPrefix: '[Y-Link]',
      }),
    )
    await this.ruleRepo.save(entities)
  }

  async listRules(): Promise<NotificationRuleRecord[]> {
    await this.ensureDefaultRules()
    const rows = await this.ruleRepo.find({
      where: DEFAULT_RULES.map((item) => ({ ruleCode: item.ruleCode })),
      order: { id: 'ASC' },
    })
    return rows.map(toRuleRecord)
  }

  private validateRuleUserSelections(
    payload: Pick<NormalizedNotificationRuleDraft, 'recipientUserIds' | 'watchedUserIds' | 'emailRecipientAdminUserIds' | 'emailRecipientSupplierUserIds'>,
    managementUsers: Array<Pick<SysUser, 'id' | 'role'>>,
  ): void {
    const managementUserIdSet = new Set(managementUsers.map((item) => normalizeId(item.id)))
    const roleByUserId = new Map(managementUsers.map((item) => [normalizeId(item.id), item.role]))

    if (payload.recipientUserIds.some((userId) => !managementUserIdSet.has(userId))) {
      throw new BizError('通知接收账号包含无效或非管理端账号', 400)
    }
    if (payload.watchedUserIds.some((userId) => !managementUserIdSet.has(userId))) {
      throw new BizError('离线监测账号包含无效或非管理端账号', 400)
    }
    if (payload.emailRecipientAdminUserIds.some((userId) => !managementUserIdSet.has(userId))) {
      throw new BizError('管理端邮件接收账号包含无效或非管理端账号', 400)
    }
    if (payload.emailRecipientSupplierUserIds.some((userId) => !managementUserIdSet.has(userId))) {
      throw new BizError('供货端邮件接收账号包含无效或非管理端账号', 400)
    }
    if (payload.emailRecipientAdminUserIds.some((userId) => roleByUserId.get(userId) === SUPPLIER_ROLE)) {
      throw new BizError('管理端邮件接收账号仅允许 admin/operator', 400)
    }
    if (payload.emailRecipientSupplierUserIds.some((userId) => roleByUserId.get(userId) !== SUPPLIER_ROLE)) {
      throw new BizError('供货端邮件接收账号仅允许 supplier', 400)
    }
  }

  private normalizeRuleDraft(
    row: UpdateNotificationRuleInput,
    persistedRule: Pick<NotificationRule, 'ruleCode' | 'ruleName' | 'feishuSignSecret'>,
  ): NormalizedNotificationRuleDraft {
    if (!NOTIFICATION_EXTERNAL_TRIGGER_MODES.includes(row.externalTriggerMode)) {
      throw new BizError('外发时机配置不合法', 400)
    }

    const recipientUserIds = row.recipientUserIds.map((item) => normalizeId(item)).filter(Boolean)
    const watchedUserIds = row.watchedUserIds.map((item) => normalizeId(item)).filter(Boolean)
    const emailRecipientAdminUserIds = row.emailRecipientAdminUserIds.map((item) => normalizeId(item)).filter(Boolean)
    const emailRecipientSupplierUserIds = row.emailRecipientSupplierUserIds.map((item) => normalizeId(item)).filter(Boolean)
    const feishuWebhookUrl = row.feishuWebhookUrl.trim()
    const emailSubjectPrefix = row.emailSubjectPrefix.trim().slice(0, 128) || '[Y-Link]'

    if (row.externalTriggerMode === 'watched_accounts_offline' && watchedUserIds.length === 0) {
      throw new BizError('指定账号离线模式至少需要一个监测账号', 400)
    }
    if (row.emailEnabled && emailRecipientAdminUserIds.length + emailRecipientSupplierUserIds.length === 0) {
      throw new BizError('启用邮箱提醒时必须至少选择一组邮件接收账号', 400)
    }
    if (row.feishuEnabled && !feishuWebhookUrl) {
      throw new BizError('启用飞书提醒时必须填写 Webhook 地址', 400)
    }

    const rawFeishuSignSecret = row.feishuSignSecret.trim()
    const feishuSignSecret = rawFeishuSignSecret === FEISHU_SIGN_SECRET_PLACEHOLDER
      ? (persistedRule.feishuSignSecret?.trim() || null)
      : normalizeFeishuSignSecretInput(rawFeishuSignSecret)

    return {
      id: normalizeId(row.id),
      ruleCode: persistedRule.ruleCode,
      ruleName: persistedRule.ruleName,
      enabled: row.enabled,
      recipientUserIds,
      emailRecipientAdminUserIds,
      emailRecipientSupplierUserIds,
      emailEnabled: row.emailEnabled,
      feishuEnabled: row.feishuEnabled,
      externalTriggerMode: row.externalTriggerMode,
      watchedUserIds,
      feishuWebhookUrl,
      feishuSignSecret,
      emailSubjectPrefix,
    }
  }

  async updateRules(
    input: UpdateNotificationRuleInput[],
    offlineWindowSeconds: number,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<{ changed: boolean; list: NotificationRuleRecord[] }> {
    const normalizedOnlineWindowSeconds = this.normalizeOnlineWindowSeconds(offlineWindowSeconds)
    await this.ensureDefaultRules()
    const rows = await this.ruleRepo.find()
    const rowById = new Map(rows.map((item) => [normalizeId(item.id), item]))
    const normalizedById = new Map<string, UpdateNotificationRuleInput>()
    for (const row of input) {
      const persistedRule = rowById.get(normalizeId(row.id))
      if (!persistedRule) {
        throw new BizError('通知规则不存在', 404)
      }
      const normalized = this.normalizeRuleDraft(row, persistedRule)
      normalizedById.set(normalizeId(row.id), {
        id: normalized.id,
        enabled: normalized.enabled,
        recipientUserIds: normalized.recipientUserIds,
        emailRecipientAdminUserIds: normalized.emailRecipientAdminUserIds,
        emailRecipientSupplierUserIds: normalized.emailRecipientSupplierUserIds,
        emailEnabled: normalized.emailEnabled,
        feishuEnabled: normalized.feishuEnabled,
        externalTriggerMode: normalized.externalTriggerMode,
        watchedUserIds: normalized.watchedUserIds,
        feishuWebhookUrl: normalized.feishuWebhookUrl,
        feishuSignSecret: normalized.feishuSignSecret ?? '',
        emailSubjectPrefix: normalized.emailSubjectPrefix,
      })
    }

    const managementUsers = await this.userRepo.find({
      where: MANAGEMENT_ROLES.map((role) => ({ role, status: 'enabled' })),
      select: { id: true, role: true },
    })
    for (const payload of normalizedById.values()) {
      this.validateRuleUserSelections(payload, managementUsers)
    }

    let changed = false
    await AppDataSource.transaction(async (manager) => {
      const txRuleRepo = manager.getRepository(NotificationRule)
      const txSystemConfigRepo = manager.getRepository(SystemConfig)
      await this.ensureOnlineWindowConfig(manager)
      for (const row of rows) {
        const payload = normalizedById.get(normalizeId(row.id))
        if (!payload) {
          continue
        }
        const nextRecipientJson = JSON.stringify(payload.recipientUserIds)
        const nextEmailAdminRecipientJson = JSON.stringify(payload.emailRecipientAdminUserIds)
        const nextEmailSupplierRecipientJson = JSON.stringify(payload.emailRecipientSupplierUserIds)
        const nextWatchedJson = JSON.stringify(payload.watchedUserIds)
        const nextFeishuWebhookUrl = payload.feishuWebhookUrl || null
        const nextFeishuSignSecret = normalizeFeishuSignSecretInput(payload.feishuSignSecret)
        const nextEmailPrefix = payload.emailSubjectPrefix || '[Y-Link]'
        const isChanged = row.enabled !== (payload.enabled ? 1 : 0)
          || row.emailRecipientAdminUserIdsJson !== nextEmailAdminRecipientJson
          || row.emailRecipientSupplierUserIdsJson !== nextEmailSupplierRecipientJson
          || row.emailEnabled !== (payload.emailEnabled ? 1 : 0)
          || row.feishuEnabled !== (payload.feishuEnabled ? 1 : 0)
          || row.externalTriggerMode !== payload.externalTriggerMode
          || row.recipientUserIdsJson !== nextRecipientJson
          || row.watchedUserIdsJson !== nextWatchedJson
          || (row.feishuWebhookUrl ?? '') !== (nextFeishuWebhookUrl ?? '')
          || (row.feishuSignSecret ?? '') !== (nextFeishuSignSecret ?? '')
          || row.emailSubjectPrefix !== nextEmailPrefix
        if (!isChanged) {
          continue
        }
        changed = true
        await txRuleRepo.update(
          { id: row.id },
          {
            enabled: payload.enabled ? 1 : 0,
            emailRecipientAdminUserIdsJson: nextEmailAdminRecipientJson,
            emailRecipientSupplierUserIdsJson: nextEmailSupplierRecipientJson,
            emailEnabled: payload.emailEnabled ? 1 : 0,
            feishuEnabled: payload.feishuEnabled ? 1 : 0,
            externalTriggerMode: payload.externalTriggerMode,
            recipientUserIdsJson: nextRecipientJson,
            watchedUserIdsJson: nextWatchedJson,
            feishuWebhookUrl: nextFeishuWebhookUrl,
            feishuSignSecret: nextFeishuSignSecret,
            emailSubjectPrefix: nextEmailPrefix,
          },
        )
      }

      const currentOnlineWindowRow = await txSystemConfigRepo.findOne({
        where: { configKey: NOTIFICATION_ONLINE_WINDOW_CONFIG_KEY },
        select: { id: true, configValue: true },
      })
      const currentOnlineWindowSeconds = this.parseOnlineWindowSeconds(currentOnlineWindowRow?.configValue)
      if (currentOnlineWindowSeconds !== normalizedOnlineWindowSeconds && currentOnlineWindowRow) {
        await txSystemConfigRepo.update(
          { id: currentOnlineWindowRow.id },
          { configValue: String(normalizedOnlineWindowSeconds) },
        )
        changed = true
      }

      if (changed) {
        await auditService.record({
          actionType: 'notification.rule.update',
          actionLabel: '更新通知中心规则',
          targetType: 'notification_rule',
          targetCode: 'notification_rules',
          actor,
          requestMeta,
          detail: {
            updatedRuleIds: [...normalizedById.keys()],
            offlineWindowSeconds: normalizedOnlineWindowSeconds,
          },
        }, manager)
      }
    })

    return {
      changed,
      list: await this.listRules(),
    }
  }

  async getPresenceSnapshot(): Promise<NotificationPresenceSnapshot> {
    const now = new Date()
    const onlineWindowSeconds = await this.getOnlineWindowSeconds()
    const onlineWindowMs = onlineWindowSeconds * 1000
    const onlineAfter = new Date(now.getTime() - onlineWindowMs)
    const users = await this.userRepo.find({
      where: MANAGEMENT_ROLES.map((role) => ({ role, status: 'enabled' })),
      select: {
        id: true,
        username: true,
        displayName: true,
        role: true,
      },
      order: {
        role: 'ASC',
        id: 'ASC',
      },
    })
    const userIds = users.map((item) => item.id)
    const sessions = userIds.length
      ? await this.sessionRepo.find({
        where: {
          userId: In(userIds),
          expiresAt: MoreThan(now),
        },
        select: {
          id: true,
          userId: true,
          lastAccessAt: true,
          expiresAt: true,
        },
      })
      : []

    const byUser = new Map<string, Array<Pick<SysUserSession, 'lastAccessAt' | 'expiresAt'>>>()
    for (const session of sessions) {
      const list = byUser.get(normalizeId(session.userId)) ?? []
      list.push({
        lastAccessAt: session.lastAccessAt,
        expiresAt: session.expiresAt,
      })
      byUser.set(normalizeId(session.userId), list)
    }

    return {
      serverTime: now.toISOString(),
      onlineWindowSeconds,
      users: users.map((user) => {
        const sessionList = byUser.get(normalizeId(user.id)) ?? []
        const activeSessions = sessionList.filter((session) => session.expiresAt > now)
        const onlineSessions = activeSessions.filter((session) => session.lastAccessAt >= onlineAfter)
        const latest = activeSessions
          .map((session) => session.lastAccessAt)
          .sort((left, right) => right.getTime() - left.getTime())[0]
        return {
          userId: normalizeId(user.id),
          username: user.username,
          displayName: user.displayName,
          role: user.role,
          isOnline: onlineSessions.length > 0,
          activeSessionCount: activeSessions.length,
          lastAccessAt: latest ? latest.toISOString() : null,
        }
      }),
    }
  }

  async touchSessionHeartbeat(auth: AuthUserContext): Promise<void> {
    const now = new Date()
    const threshold = new Date(now.getTime() - HEARTBEAT_WRITE_INTERVAL_MS)
    await this.sessionRepo
      .createQueryBuilder()
      .update(SysUserSession)
      .set({ lastAccessAt: now })
      .where('session_token = :sessionToken', { sessionToken: auth.sessionToken })
      .andWhere('(last_access_at IS NULL OR last_access_at < :threshold)', { threshold })
      .execute()
  }

  private buildNotificationMessage(eventType: NotificationEventType, payload: NotificationEventPayload): {
    title: string
    content: string
  } {
    if (eventType === 'o2o_preorder_created') {
      const showNo = payload.showNo?.trim() || '-'
      return {
        title: `新预订单 ${showNo}`,
        content: `系统收到新的线上预订单，业务单号：${showNo}。请尽快处理。`,
      }
    }

    const conversationNo = payload.conversationNo?.trim() || '-'
    const sourceUser = payload.sourceUserDisplayName?.trim() || '客户'
    const summary = payload.summary?.trim() || '收到新的消息'
    return {
      title: `新客服消息 ${conversationNo}`,
      content: `会话 ${conversationNo} 收到来自 ${sourceUser} 的新消息：${summary}`,
    }
  }

  private async resolveRuleRecipients(rule: NotificationRuleRecord): Promise<SysUser[]> {
    const whereConditions = MANAGEMENT_ROLES.map((role) => ({ role, status: 'enabled' as const }))
    const allManagementUsers = await this.userRepo.find({
      where: whereConditions,
      select: {
        id: true,
        username: true,
        displayName: true,
        role: true,
        email: true,
      },
    })
    if (!rule.recipientUserIds.length) {
      return allManagementUsers
    }
    const idSet = new Set(rule.recipientUserIds)
    return allManagementUsers.filter((item) => idSet.has(normalizeId(item.id)))
  }

  private async resolveRuleEmailRecipients(rule: NotificationRuleRecord): Promise<SysUser[]> {
    const whereConditions = MANAGEMENT_ROLES.map((role) => ({ role, status: 'enabled' as const }))
    const allManagementUsers = await this.userRepo.find({
      where: whereConditions,
      select: {
        id: true,
        username: true,
        displayName: true,
        role: true,
        email: true,
      },
    })

    const adminRecipients = rule.emailRecipientAdminUserIds.length
      ? allManagementUsers.filter((item) =>
        rule.emailRecipientAdminUserIds.includes(normalizeId(item.id)) && ADMIN_MANAGEMENT_ROLES.includes(item.role),
      )
      : []
    const supplierRecipients = rule.emailRecipientSupplierUserIds.length
      ? allManagementUsers.filter((item) =>
        rule.emailRecipientSupplierUserIds.includes(normalizeId(item.id)) && item.role === SUPPLIER_ROLE,
      )
      : []
    const deduped = new Map<string, SysUser>()
    for (const user of [...adminRecipients, ...supplierRecipients]) {
      deduped.set(normalizeId(user.id), user)
    }
    return [...deduped.values()]
  }

  private async shouldTriggerExternal(rule: NotificationRuleRecord): Promise<boolean> {
    const snapshot = await this.getPresenceSnapshot()
    const onlineMap = new Map(snapshot.users.map((item) => [item.userId, item.isOnline]))
    if (rule.externalTriggerMode === 'all_management_offline') {
      return snapshot.users.every((item) => item.isOnline === false)
    }

    if (!rule.watchedUserIds.length) {
      return false
    }
    return rule.watchedUserIds.every((userId) => !onlineMap.get(userId))
  }

  private async sendEmailByVerificationProvider(target: string, subject: string, content: string): Promise<{ status: number; ok: boolean; errorMessage?: string }> {
    const provider = (await systemConfigService.getVerificationProviderConfigs({ maskSensitiveValues: false })).email
    if (!provider.enabled || !provider.apiUrl.trim()) {
      return {
        status: 500,
        ok: false,
        errorMessage: '邮件通道未配置或未启用(verification.email)',
      }
    }

    let headers: Record<string, string> = {}
    try {
      headers = JSON.parse(provider.headersTemplate.trim() || '{}')
    } catch {
      return {
        status: 500,
        ok: false,
        errorMessage: '邮件通道请求头模板 JSON 不合法',
      }
    }

    const body = provider.bodyTemplate
      .replaceAll(/\{\{\s*target\s*\}\}/g, target)
      .replaceAll(/\{\{\s*scene\s*\}\}/g, 'notification')
      .replaceAll(/\{\{\s*code\s*\}\}/g, '')
      .replaceAll(/\{\{\s*subject\s*\}\}/g, subject)
      .replaceAll(/\{\{\s*content\s*\}\}/g, content)

    const requestInit: RequestInit = {
      method: provider.httpMethod,
      headers,
      body: provider.httpMethod === 'GET' ? undefined : body,
    }

    try {
      const response = await fetch(provider.apiUrl, requestInit)
      const responseText = await response.text()
      const successMatch = provider.successMatch.trim()
      if (!response.ok || (successMatch && !responseText.includes(successMatch))) {
        return {
          status: response.status,
          ok: false,
          errorMessage: `邮件网关返回异常(HTTP ${response.status})`,
        }
      }
      return {
        status: response.status,
        ok: true,
      }
    } catch (error) {
      return {
        status: 500,
        ok: false,
        errorMessage: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private buildFeishuSignature(signSecret: string): { timestamp: string; sign: string } {
    const timestamp = String(Math.floor(Date.now() / 1000))
    const stringToSign = `${timestamp}\n${signSecret}`
    // 飞书自定义机器人签名规范：
    // key = `${timestamp}\n${secret}`，消息体为“空字符串”，再做 HMAC-SHA256 + Base64
    // 参考官方文档「签名校验」示例代码（Java/Go/Python）
    const sign = createHmac('sha256', stringToSign).digest('base64')
    return {
      timestamp,
      sign,
    }
  }

  private async sendFeishuWebhook(
    webhookUrl: string,
    title: string,
    content: string,
    signSecret?: string | null,
  ): Promise<{ status: number; ok: boolean; errorMessage?: string }> {
    const abortController = new AbortController()
    const timeout = setTimeout(() => {
      abortController.abort()
    }, FEISHU_WEBHOOK_TIMEOUT_MS)

    try {
      const normalizedSecret = signSecret?.trim() || ''
      const signedPart = normalizedSecret ? this.buildFeishuSignature(normalizedSecret) : null
      const response = await fetch(webhookUrl, {
        method: 'POST',
        signal: abortController.signal,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...(signedPart ?? {}),
          msg_type: 'text',
          content: {
            text: `${title}\n${content}`,
          },
        }),
      })
      const text = await response.text()
      let feishuCode: number | null = null
      let feishuMsg = ''
      try {
        const parsed = JSON.parse(text) as { code?: number; msg?: string }
        feishuCode = typeof parsed.code === 'number' ? parsed.code : null
        feishuMsg = typeof parsed.msg === 'string' ? parsed.msg.trim() : ''
      } catch {
        // 非 JSON 响应时走兜底文案
      }

      if (!response.ok) {
        return {
          status: response.status,
          ok: false,
          errorMessage: feishuCode !== null
            ? `飞书 Webhook 返回异常(HTTP ${response.status}, code=${feishuCode}${feishuMsg ? `, msg=${feishuMsg}` : ''})`
            : `飞书 Webhook 返回异常(HTTP ${response.status})`,
        }
      }
      if (feishuCode !== 0 && !/\"code\"\s*:\s*0/.test(text)) {
        return {
          status: response.status,
          ok: false,
          errorMessage: feishuCode !== null
            ? `飞书 Webhook 返回非成功响应(code=${feishuCode}${feishuMsg ? `, msg=${feishuMsg}` : ''})`
            : '飞书 Webhook 返回非成功响应',
        }
      }
      return {
        status: response.status,
        ok: true,
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return {
          status: 504,
          ok: false,
          errorMessage: `飞书 Webhook 请求超时（${Math.floor(FEISHU_WEBHOOK_TIMEOUT_MS / 1000)} 秒内未响应）`,
        }
      }
      return {
        status: 500,
        ok: false,
        errorMessage: error instanceof Error ? error.message : String(error),
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  async testSendByRule(input: NotificationRuleTestSendInput): Promise<NotificationRuleTestSendResult> {
    await this.ensureDefaultRules()
    const ruleId = normalizeId(input.ruleId)
    if (ruleId !== normalizeId(input.draft.id)) {
      throw new BizError('测试参数中的规则标识不一致', 400)
    }
    const persistedRule = await this.ruleRepo.findOne({
      where: { id: ruleId },
      select: {
        id: true,
        ruleCode: true,
        ruleName: true,
        feishuSignSecret: true,
      },
    })
    if (!persistedRule) {
      throw new BizError('通知规则不存在', 404)
    }

    const normalizedDraft = this.normalizeRuleDraft(input.draft, persistedRule)
    const managementUsers = await this.userRepo.find({
      where: MANAGEMENT_ROLES.map((role) => ({ role, status: 'enabled' })),
      select: { id: true, role: true },
    })
    this.validateRuleUserSelections(normalizedDraft, managementUsers)

    const subject = `${normalizedDraft.emailSubjectPrefix || '[Y-Link]'} 通知中心测试消息`
    const content = `规则：${normalizedDraft.ruleName}（${normalizedDraft.ruleCode}）\n渠道：${input.channel}\n时间：${new Date().toISOString()}`

    if (input.channel === 'email') {
      const emailUsers = await this.resolveRuleEmailRecipients({
        id: normalizedDraft.id,
        ruleCode: normalizedDraft.ruleCode,
        ruleName: normalizedDraft.ruleName,
        eventType: 'o2o_preorder_created',
        enabled: normalizedDraft.enabled,
        recipientUserIds: normalizedDraft.recipientUserIds,
        emailRecipientAdminUserIds: normalizedDraft.emailRecipientAdminUserIds,
        emailRecipientSupplierUserIds: normalizedDraft.emailRecipientSupplierUserIds,
        emailEnabled: normalizedDraft.emailEnabled,
        feishuEnabled: normalizedDraft.feishuEnabled,
        externalTriggerMode: normalizedDraft.externalTriggerMode,
        watchedUserIds: normalizedDraft.watchedUserIds,
        feishuWebhookUrl: normalizedDraft.feishuWebhookUrl,
        feishuSignSecretMasked: Boolean(normalizedDraft.feishuSignSecret),
        emailSubjectPrefix: normalizedDraft.emailSubjectPrefix,
        updatedAt: new Date(),
      })

      const failures: NotificationRuleTestSendResult['failures'] = []
      let attempted = 0
      let succeeded = 0
      for (const user of emailUsers) {
        const email = user.email?.trim() || ''
        attempted += 1
        if (!email || !isValidEmail(email)) {
          failures.push({
            target: user.username,
            reason: '接收账号未配置有效邮箱',
          })
          continue
        }
        const result = await this.sendEmailByVerificationProvider(email, subject, content)
        if (result.ok) {
          succeeded += 1
        } else {
          failures.push({
            target: email,
            reason: result.errorMessage ?? '邮件发送失败',
          })
        }
      }

      const output: NotificationRuleTestSendResult = {
        channel: 'email',
        success: attempted > 0 && failures.length === 0,
        message: attempted === 0
          ? '未命中任何邮件接收账号'
          : failures.length === 0
            ? '邮件测试发送成功'
            : '邮件测试发送部分失败',
        summary: {
          attempted,
          succeeded,
          failed: failures.length,
        },
        failures,
      }

      await auditService.safeRecord({
        actionType: 'notification.rule.test_send',
        actionLabel: '通知规则测试发送',
        targetType: 'notification_rule',
        targetId: normalizedDraft.id,
        targetCode: normalizedDraft.ruleCode,
        resultStatus: output.success ? 'success' : 'failed',
        actor: input.actor,
        requestMeta: input.requestMeta,
        detail: {
          channel: 'email',
          summary: output.summary,
          failureCount: output.failures.length,
          failures: output.failures.slice(0, 5),
        },
      })

      return output
    }

    if (!normalizedDraft.feishuWebhookUrl) {
      throw new BizError('飞书 Webhook 不能为空', 400)
    }
    const feishuResult = await this.sendFeishuWebhook(
      normalizedDraft.feishuWebhookUrl,
      subject,
      content,
      normalizedDraft.feishuSignSecret,
    )
    const output: NotificationRuleTestSendResult = {
      channel: 'feishu',
      success: feishuResult.ok,
      message: feishuResult.ok ? '飞书测试发送成功' : (feishuResult.errorMessage ?? '飞书测试发送失败'),
      summary: {
        attempted: 1,
        succeeded: feishuResult.ok ? 1 : 0,
        failed: feishuResult.ok ? 0 : 1,
      },
      failures: feishuResult.ok
        ? []
        : [
            {
              target: normalizedDraft.feishuWebhookUrl,
              reason: feishuResult.errorMessage ?? '飞书测试发送失败',
            },
          ],
    }

    await auditService.safeRecord({
      actionType: 'notification.rule.test_send',
      actionLabel: '通知规则测试发送',
      targetType: 'notification_rule',
      targetId: normalizedDraft.id,
      targetCode: normalizedDraft.ruleCode,
      resultStatus: output.success ? 'success' : 'failed',
      actor: input.actor,
      requestMeta: input.requestMeta,
      detail: {
        channel: 'feishu',
        summary: output.summary,
        success: output.success,
        failures: output.failures.slice(0, 5),
      },
    })

    return output
  }

  async emitEvent(input: EmitNotificationEventInput): Promise<void> {
    await this.ensureDefaultRules()
    const allRuleRows = await this.ruleRepo.find({
      where: DEFAULT_RULES.map((item) => ({ ruleCode: item.ruleCode })),
      order: { id: 'ASC' },
    })
    const matchedRules = allRuleRows
      .map((row) => ({
        rule: toRuleRecord(row),
        feishuSignSecret: row.feishuSignSecret?.trim() || null,
      }))
      .filter((item) => item.rule.enabled && item.rule.eventType === input.eventType)
    if (!matchedRules.length) {
      return
    }

    const message = this.buildNotificationMessage(input.eventType, input.payload)
    const event = await this.eventRepo.save(this.eventRepo.create({
      eventType: input.eventType,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      payloadJson: JSON.stringify(input.payload),
      status: 'pending',
      errorMessage: null,
    }))

    try {
      const ruleRecipients = await Promise.all(
        matchedRules.map(async (item) => ({
          ...item,
          inboxUsers: await this.resolveRuleRecipients(item.rule),
          emailUsers: await this.resolveRuleEmailRecipients(item.rule),
        })),
      )

      const inboxRows: NotificationInbox[] = []
      for (const item of ruleRecipients) {
        for (const user of item.inboxUsers) {
          inboxRows.push(this.inboxRepo.create({
            eventId: event.id,
            userId: user.id,
            eventType: input.eventType,
            title: message.title,
            content: message.content,
            payloadJson: JSON.stringify(input.payload),
            isRead: 0,
            readAt: null,
          }))
        }
      }
      if (inboxRows.length) {
        await this.inboxRepo.save(inboxRows)
      }

      for (const item of ruleRecipients) {
        const allowExternal = await this.shouldTriggerExternal(item.rule)
        let emailSent = 0
        let emailFailed = 0
        let feishuSent = 0
        let feishuFailed = 0

        await auditService.safeRecord({
          actionType: 'notification.rule.matched',
          actionLabel: '通知规则命中',
          targetType: 'notification_rule',
          targetId: item.rule.id,
          targetCode: item.rule.ruleCode,
          requestMeta: input.requestMeta,
          detail: {
            eventId: event.id,
            eventType: input.eventType,
            externalTriggerMode: item.rule.externalTriggerMode,
            externalAllowed: allowExternal,
            recipientCount: item.inboxUsers.length,
            emailRecipientAdminCount: item.rule.emailRecipientAdminUserIds.length,
            emailRecipientSupplierCount: item.rule.emailRecipientSupplierUserIds.length,
          },
        })

        if (!allowExternal) {
          continue
        }

        if (item.rule.emailEnabled) {
          for (const user of item.emailUsers) {
            const email = user.email?.trim() || ''
            if (!email || !isValidEmail(email)) {
              await this.dispatchRepo.save(this.dispatchRepo.create({
                eventId: event.id,
                channel: 'email',
                target: email || user.username,
                status: 'failed',
                attemptCount: 1,
                errorMessage: '接收账号未配置有效邮箱',
                responseCode: null,
                sentAt: null,
              }))
              emailFailed += 1
              continue
            }
            const subject = `${item.rule.emailSubjectPrefix || '[Y-Link]'} ${message.title}`
            const sendResult = await this.sendEmailByVerificationProvider(email, subject, message.content)
            await this.dispatchRepo.save(this.dispatchRepo.create({
              eventId: event.id,
              channel: 'email',
              target: email,
              status: sendResult.ok ? 'sent' : 'failed',
              attemptCount: 1,
              errorMessage: sendResult.ok ? null : (sendResult.errorMessage ?? '邮件发送失败'),
              responseCode: sendResult.status,
              sentAt: sendResult.ok ? new Date() : null,
            }))
            if (sendResult.ok) {
              emailSent += 1
            } else {
              emailFailed += 1
            }
          }
        }

        if (item.rule.feishuEnabled && item.rule.feishuWebhookUrl) {
          const sendResult = await this.sendFeishuWebhook(
            item.rule.feishuWebhookUrl,
            message.title,
            message.content,
            item.feishuSignSecret,
          )
          await this.dispatchRepo.save(this.dispatchRepo.create({
            eventId: event.id,
            channel: 'feishu',
            target: item.rule.feishuWebhookUrl,
            status: sendResult.ok ? 'sent' : 'failed',
            attemptCount: 1,
            errorMessage: sendResult.ok ? null : (sendResult.errorMessage ?? '飞书发送失败'),
            responseCode: sendResult.status,
            sentAt: sendResult.ok ? new Date() : null,
          }))
          if (sendResult.ok) {
            feishuSent += 1
          } else {
            feishuFailed += 1
          }
        }

        await auditService.safeRecord({
          actionType: 'notification.external.dispatch',
          actionLabel: '通知外发执行',
          targetType: 'notification_rule',
          targetId: item.rule.id,
          targetCode: item.rule.ruleCode,
          requestMeta: input.requestMeta,
          detail: {
            eventId: event.id,
            eventType: input.eventType,
            emailSent,
            emailFailed,
            feishuSent,
            feishuFailed,
          },
        })
      }

      event.status = 'processed'
      event.errorMessage = null
      await this.eventRepo.save(event)
    } catch (error) {
      event.status = 'failed'
      event.errorMessage = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)
      await this.eventRepo.save(event)
      await auditService.safeRecord({
        actionType: 'notification.event.process',
        actionLabel: '通知事件处理失败',
        targetType: 'notification_event',
        targetId: event.id,
        targetCode: event.eventType,
        requestMeta: input.requestMeta,
        resultStatus: 'failed',
        detail: {
          errorMessage: event.errorMessage,
        },
      })
    }
  }

  async listInbox(
    auth: AuthUserContext,
    query: { page: number; pageSize: number; unreadOnly?: boolean },
  ): Promise<{ page: number; pageSize: number; total: number; list: Array<{
    id: string
    eventType: string
    title: string
    content: string
    isRead: boolean
    readAt: Date | null
    createdAt: Date
  }> }> {
    const qb = this.inboxRepo.createQueryBuilder('inbox')
      .where('inbox.userId = :userId', { userId: auth.userId })
    if (query.unreadOnly) {
      qb.andWhere('inbox.isRead = :isRead', { isRead: 0 })
    }

    const [rows, total] = await qb
      .orderBy('inbox.id', 'DESC')
      .skip((query.page - 1) * query.pageSize)
      .take(query.pageSize)
      .getManyAndCount()

    return {
      page: query.page,
      pageSize: query.pageSize,
      total,
      list: rows.map((item) => ({
        id: item.id,
        eventType: item.eventType,
        title: item.title,
        content: item.content,
        isRead: item.isRead > 0,
        readAt: item.readAt,
        createdAt: item.createdAt,
      })),
    }
  }

  async markInboxRead(id: string, auth: AuthUserContext): Promise<boolean> {
    const row = await this.inboxRepo.findOne({
      where: { id, userId: auth.userId },
      select: { id: true, isRead: true },
    })
    if (!row) {
      throw new BizError('通知不存在', 404)
    }
    if (row.isRead > 0) {
      return false
    }
    await this.inboxRepo.update({ id: row.id }, { isRead: 1, readAt: new Date() })
    return true
  }

  async getUnreadCount(auth: AuthUserContext): Promise<number> {
    return this.inboxRepo.count({
      where: {
        userId: auth.userId,
        isRead: 0,
      },
    })
  }
}

export const notificationService = new NotificationService()
