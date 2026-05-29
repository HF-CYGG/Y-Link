import { In, MoreThan } from 'typeorm'
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
const ONLINE_WINDOW_MS = 120 * 1000
const HEARTBEAT_WRITE_INTERVAL_MS = 60 * 1000

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
  emailEnabled: boolean
  feishuEnabled: boolean
  externalTriggerMode: NotificationExternalTriggerMode
  watchedUserIds: string[]
  feishuWebhookUrl: string
  emailSubjectPrefix: string
  updatedAt: Date
}

export interface UpdateNotificationRuleInput {
  id: string
  enabled: boolean
  recipientUserIds: string[]
  emailEnabled: boolean
  feishuEnabled: boolean
  externalTriggerMode: NotificationExternalTriggerMode
  watchedUserIds: string[]
  feishuWebhookUrl: string
  emailSubjectPrefix: string
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

function parseJsonStringArray(raw: string): string[] {
  const text = raw.trim()
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

function toRuleRecord(row: NotificationRule): NotificationRuleRecord {
  return {
    id: row.id,
    ruleCode: row.ruleCode,
    ruleName: row.ruleName,
    eventType: row.eventType as NotificationEventType,
    enabled: row.enabled > 0,
    recipientUserIds: parseJsonStringArray(row.recipientUserIdsJson),
    emailEnabled: row.emailEnabled > 0,
    feishuEnabled: row.feishuEnabled > 0,
    externalTriggerMode: row.externalTriggerMode,
    watchedUserIds: parseJsonStringArray(row.watchedUserIdsJson),
    feishuWebhookUrl: row.feishuWebhookUrl?.trim() || '',
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

  async ensureDefaultRules() {
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
        emailEnabled: 0,
        feishuEnabled: 0,
        externalTriggerMode: 'all_management_offline',
        watchedUserIdsJson: '[]',
        feishuWebhookUrl: null,
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

  async updateRules(
    input: UpdateNotificationRuleInput[],
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<{ changed: boolean; list: NotificationRuleRecord[] }> {
    await this.ensureDefaultRules()
    const normalizedById = new Map<string, UpdateNotificationRuleInput>()
    for (const row of input) {
      if (!NOTIFICATION_EXTERNAL_TRIGGER_MODES.includes(row.externalTriggerMode)) {
        throw new BizError('外发时机配置不合法', 400)
      }
      const normalizedWatchedUserIds = row.watchedUserIds.map((item) => item.trim()).filter(Boolean)
      if (row.externalTriggerMode === 'watched_accounts_offline' && normalizedWatchedUserIds.length === 0) {
        throw new BizError('指定账号离线模式至少需要一个监测账号', 400)
      }
      normalizedById.set(row.id, {
        ...row,
        recipientUserIds: row.recipientUserIds.map((item) => item.trim()).filter(Boolean),
        watchedUserIds: normalizedWatchedUserIds,
        feishuWebhookUrl: row.feishuWebhookUrl.trim(),
        emailSubjectPrefix: row.emailSubjectPrefix.trim().slice(0, 128),
      })
    }

    const managementUsers = await this.userRepo.find({
      where: MANAGEMENT_ROLES.map((role) => ({ role, status: 'enabled' })),
      select: { id: true },
    })
    const managementUserIdSet = new Set(managementUsers.map((item) => item.id))
    for (const payload of normalizedById.values()) {
      if (payload.recipientUserIds.some((userId) => !managementUserIdSet.has(userId))) {
        throw new BizError('通知接收账号包含无效或非管理端账号', 400)
      }
      if (payload.watchedUserIds.some((userId) => !managementUserIdSet.has(userId))) {
        throw new BizError('离线监测账号包含无效或非管理端账号', 400)
      }
    }

    const rows = await this.ruleRepo.find()
    let changed = false
    await AppDataSource.transaction(async (manager) => {
      const txRuleRepo = manager.getRepository(NotificationRule)
      for (const row of rows) {
        const payload = normalizedById.get(row.id)
        if (!payload) {
          continue
        }
        const nextRecipientJson = JSON.stringify(payload.recipientUserIds)
        const nextWatchedJson = JSON.stringify(payload.watchedUserIds)
        const nextFeishuWebhookUrl = payload.feishuWebhookUrl || null
        const nextEmailPrefix = payload.emailSubjectPrefix || '[Y-Link]'
        const isChanged = row.enabled !== (payload.enabled ? 1 : 0)
          || row.emailEnabled !== (payload.emailEnabled ? 1 : 0)
          || row.feishuEnabled !== (payload.feishuEnabled ? 1 : 0)
          || row.externalTriggerMode !== payload.externalTriggerMode
          || row.recipientUserIdsJson !== nextRecipientJson
          || row.watchedUserIdsJson !== nextWatchedJson
          || (row.feishuWebhookUrl ?? '') !== (nextFeishuWebhookUrl ?? '')
          || row.emailSubjectPrefix !== nextEmailPrefix
        if (!isChanged) {
          continue
        }
        changed = true
        await txRuleRepo.update(
          { id: row.id },
          {
            enabled: payload.enabled ? 1 : 0,
            emailEnabled: payload.emailEnabled ? 1 : 0,
            feishuEnabled: payload.feishuEnabled ? 1 : 0,
            externalTriggerMode: payload.externalTriggerMode,
            recipientUserIdsJson: nextRecipientJson,
            watchedUserIdsJson: nextWatchedJson,
            feishuWebhookUrl: nextFeishuWebhookUrl,
            emailSubjectPrefix: nextEmailPrefix,
          },
        )
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
    const onlineAfter = new Date(now.getTime() - ONLINE_WINDOW_MS)
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
      const list = byUser.get(session.userId) ?? []
      list.push({
        lastAccessAt: session.lastAccessAt,
        expiresAt: session.expiresAt,
      })
      byUser.set(session.userId, list)
    }

    return {
      serverTime: now.toISOString(),
      onlineWindowSeconds: Math.floor(ONLINE_WINDOW_MS / 1000),
      users: users.map((user) => {
        const sessionList = byUser.get(user.id) ?? []
        const activeSessions = sessionList.filter((session) => session.expiresAt > now)
        const onlineSessions = activeSessions.filter((session) => session.lastAccessAt >= onlineAfter)
        const latest = activeSessions
          .map((session) => session.lastAccessAt)
          .sort((left, right) => right.getTime() - left.getTime())[0]
        return {
          userId: user.id,
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
    return allManagementUsers.filter((item) => idSet.has(item.id))
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

  private async sendFeishuWebhook(webhookUrl: string, title: string, content: string): Promise<{ status: number; ok: boolean; errorMessage?: string }> {
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          msg_type: 'text',
          content: {
            text: `${title}\n${content}`,
          },
        }),
      })
      const text = await response.text()
      if (!response.ok) {
        return {
          status: response.status,
          ok: false,
          errorMessage: `飞书 Webhook 返回异常(HTTP ${response.status})`,
        }
      }
      if (!/\"code\"\s*:\s*0/.test(text)) {
        return {
          status: response.status,
          ok: false,
          errorMessage: '飞书 Webhook 返回非成功响应',
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

  async emitEvent(input: EmitNotificationEventInput): Promise<void> {
    await this.ensureDefaultRules()
    const allRules = await this.listRules()
    const matchedRules = allRules.filter((item) => item.enabled && item.eventType === input.eventType)
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
        matchedRules.map(async (rule) => ({ rule, users: await this.resolveRuleRecipients(rule) })),
      )

      const inboxRows: NotificationInbox[] = []
      for (const item of ruleRecipients) {
        for (const user of item.users) {
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
            recipientCount: item.users.length,
          },
        })

        if (!allowExternal) {
          continue
        }

        if (item.rule.emailEnabled) {
          for (const user of item.users) {
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
          const sendResult = await this.sendFeishuWebhook(item.rule.feishuWebhookUrl, message.title, message.content)
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
