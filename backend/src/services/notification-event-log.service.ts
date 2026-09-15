/**
 * 文件说明：backend/src/services/notification-event-log.service.ts
 * 文件职责：按通知事件（eventId）聚合查询通知处理链路，供审计日志页“通知事件”页签展示分类、处理结果、外发渠道与重试明细。
 * 实现逻辑：
 * - 主列表以 notification_event 为准，每个业务事件只展示一条主记录；外发数量与状态由 notification_dispatch 实际状态汇总；
 * - 处理结果由事件状态与外发状态推导（deriveNotificationEventResult），“成功”只代表真实外发成功，不再代表审计写入成功；
 * - 详情中的规则命中与外发执行记录从审计日志按 eventId 精确匹配读取，并按处理轮次分组，历史无轮次字段的数据按规则重复出现切分；
 * - 外发目标、失败原因统一脱敏，客服消息正文等业务载荷不透出。
 * 维护说明：
 * - 筛选口径必须与 deriveNotificationEventResult 保持一致，调整任一处时需同步 `notification:event-log:verify`；
 * - 本服务只读，不改写通知事件、外发记录或审计数据。
 */

import { Brackets, In, type SelectQueryBuilder } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import {
  getNotificationEventCategoryLabel,
  getNotificationEventCategoryLevel,
  getNotificationEventTypeLabel,
  listNotificationEventTypesByCategory,
  NOTIFICATION_EVENT_CATEGORIES,
  NOTIFICATION_EVENT_CHANNEL_LABELS,
  NOTIFICATION_EVENT_MAX_ATTEMPTS,
  NOTIFICATION_EVENT_RESULT_LABELS,
  NOTIFICATION_EVENT_RESULT_STATUSES,
  NOTIFICATION_EVENT_TYPE_CATALOG,
  resolveNotificationEventCategory,
  type NotificationEventCategoryKey,
  type NotificationEventResultStatus,
} from '../constants/notification-event-catalog.js'
import { NotificationDispatch, type NotificationDispatchChannel } from '../entities/notification-dispatch.entity.js'
import { NotificationEvent, type NotificationEventStatus } from '../entities/notification-event.entity.js'
import { NotificationInbox } from '../entities/notification-inbox.entity.js'
import { NotificationRule } from '../entities/notification-rule.entity.js'
import { SysAuditLog } from '../entities/sys-audit-log.entity.js'
import { BizError } from '../utils/errors.js'
import { maskDispatchTarget, sanitizeNotificationErrorMessage } from '../utils/notification-target-mask.js'

export interface NotificationEventLogQuery {
  page: number
  pageSize: number
  category?: NotificationEventCategoryKey
  eventType?: string
  resultStatus?: NotificationEventResultStatus
  channel?: NotificationDispatchChannel
  eventId?: string
  startAt?: Date
  endAt?: Date
}

export interface NotificationChannelDispatchSummary {
  total: number
  sent: number
  failed: number
  pending: number
}

export type NotificationEventDispatchSummary = Record<NotificationDispatchChannel, NotificationChannelDispatchSummary>

const createEmptyChannelSummary = (): NotificationChannelDispatchSummary => ({ total: 0, sent: 0, failed: 0, pending: 0 })
const createEmptyDispatchSummary = (): NotificationEventDispatchSummary => ({
  email: createEmptyChannelSummary(),
  feishu: createEmptyChannelSummary(),
})

/** 详情中审计匹配的时间窗：事件创建前 1 分钟至最后一次处理后 10 分钟，先用时间索引缩小范围再做 eventId 精确匹配。 */
const AUDIT_WINDOW_BEFORE_MS = 60 * 1000
const AUDIT_WINDOW_AFTER_MS = 10 * 60 * 1000
const AUDIT_DETAIL_LIMIT = 200

/**
 * 通知事件处理结果推导：
 * - pending/processing/failed 直接取事件状态，pending 且已有失败次数视为“重试中”；
 * - processed 时再看外发：有失败外发为“部分外发失败”，没有任何外发为“仅站内通知”，其余为“外发成功”；
 * - 与 listEvents 中 resultStatus 的 SQL 筛选口径一一对应。
 */
export function deriveNotificationEventResult(
  event: { status: NotificationEventStatus; attemptCount: number },
  summary: NotificationEventDispatchSummary,
): NotificationEventResultStatus {
  if (event.status === 'failed') return 'failed'
  if (event.status === 'processing') return 'processing'
  if (event.status === 'pending') return Number(event.attemptCount ?? 0) > 0 ? 'retrying' : 'pending'
  const failed = summary.email.failed + summary.feishu.failed
  const total = summary.email.total + summary.feishu.total
  if (failed > 0) return 'partial_failed'
  if (total === 0) return 'internal_only'
  return 'success'
}

const parseJsonObject = (raw: string | null | undefined): Record<string, unknown> => {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const readText = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '')
const readNumber = (value: unknown) => {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : 0
}

/**
 * 事件摘要：按事件类型白名单读取载荷字段，只保留单号、会话号、触发方式等定位信息，不返回客服消息正文。
 */
const buildEventSummary = (eventType: string, payload: Record<string, unknown>) => {
  const sourceUserDisplayName = readText(payload.sourceUserDisplayName) || null
  if (eventType === 'o2o_preorder_created') {
    const showNo = readText(payload.showNo)
    return { summary: showNo ? `预订单 ${showNo}` : '新预订单', sourceUserDisplayName }
  }
  if (eventType === 'customer_service_client_message_created') {
    const conversationNo = readText(payload.conversationNo)
    return { summary: conversationNo ? `会话 ${conversationNo}` : '客服新消息', sourceUserDisplayName }
  }
  if (eventType === 'mobile_refresh_replay_detected') {
    const trigger = readText(payload.trigger)
    const generation = readText(payload.generation)
    const parts = [trigger ? `触发方式 ${trigger}` : '', generation ? `令牌代次 ${generation}` : ''].filter(Boolean)
    return { summary: parts.length ? parts.join('，') : '刷新令牌重放', sourceUserDisplayName: null }
  }
  return { summary: getNotificationEventTypeLabel(eventType), sourceUserDisplayName: null }
}

export class NotificationEventLogService {
  private get eventRepo() {
    return AppDataSource.getRepository(NotificationEvent)
  }

  private get dispatchRepo() {
    return AppDataSource.getRepository(NotificationDispatch)
  }

  /** 通知事件筛选项：业务分类（含事件类型）、处理结果与外发渠道，均来自后端常量。 */
  getFilterOptions() {
    return {
      categories: NOTIFICATION_EVENT_CATEGORIES.map((category) => ({
        key: category.key,
        label: category.label,
        level: category.level,
        eventTypes: listNotificationEventTypesByCategory(category.key).map((eventType) => ({
          value: eventType,
          label: getNotificationEventTypeLabel(eventType),
        })),
      })),
      resultStatuses: NOTIFICATION_EVENT_RESULT_STATUSES.map((status) => ({ value: status, label: NOTIFICATION_EVENT_RESULT_LABELS[status] })),
      channels: (Object.keys(NOTIFICATION_EVENT_CHANNEL_LABELS) as NotificationDispatchChannel[]).map((channel) => ({
        value: channel,
        label: NOTIFICATION_EVENT_CHANNEL_LABELS[channel],
      })),
    }
  }

  /** 构造外发记录存在性子查询；alias 需在同一查询内唯一。 */
  private buildDispatchExistsSql(
    qb: SelectQueryBuilder<NotificationEvent>,
    alias: string,
    extraCondition?: string,
  ) {
    const subQuery = qb
      .subQuery()
      .select('1')
      .from(NotificationDispatch, alias)
      .where(`${alias}.eventId = event.id`)
    if (extraCondition) {
      subQuery.andWhere(extraCondition)
    }
    return `EXISTS ${subQuery.getQuery()}`
  }

  private applyResultStatusCondition(qb: SelectQueryBuilder<NotificationEvent>, resultStatus: NotificationEventResultStatus) {
    if (resultStatus === 'pending') {
      qb.andWhere('event.status = :resultEventStatus', { resultEventStatus: 'pending' }).andWhere('event.attemptCount = 0')
      return
    }
    if (resultStatus === 'retrying') {
      qb.andWhere('event.status = :resultEventStatus', { resultEventStatus: 'pending' }).andWhere('event.attemptCount > 0')
      return
    }
    if (resultStatus === 'processing' || resultStatus === 'failed') {
      qb.andWhere('event.status = :resultEventStatus', { resultEventStatus: resultStatus })
      return
    }
    qb.andWhere('event.status = :resultEventStatus', { resultEventStatus: 'processed' })
    const failedExists = this.buildDispatchExistsSql(qb, 'resultFailedDispatch', "resultFailedDispatch.status = 'failed'")
    const anyExists = this.buildDispatchExistsSql(qb, 'resultAnyDispatch')
    if (resultStatus === 'partial_failed') {
      qb.andWhere(failedExists)
    } else if (resultStatus === 'internal_only') {
      qb.andWhere(`NOT ${anyExists}`)
    } else {
      qb.andWhere(anyExists).andWhere(`NOT ${failedExists}`)
    }
  }

  private async loadDispatchSummaryMap(eventIds: string[]) {
    const summaryMap = new Map<string, NotificationEventDispatchSummary>()
    if (!eventIds.length) return summaryMap
    const rows = await this.dispatchRepo
      .createQueryBuilder('dispatch')
      .select('dispatch.eventId', 'eventId')
      .addSelect('dispatch.channel', 'channel')
      .addSelect('dispatch.status', 'status')
      .addSelect('COUNT(1)', 'total')
      .where('dispatch.eventId IN (:...eventIds)', { eventIds })
      .groupBy('dispatch.eventId')
      .addGroupBy('dispatch.channel')
      .addGroupBy('dispatch.status')
      .getRawMany<{ eventId: string | number; channel: string; status: string; total: string | number }>()
    for (const row of rows) {
      const channel = row.channel === 'feishu' ? 'feishu' : row.channel === 'email' ? 'email' : null
      if (!channel) continue
      const eventId = String(row.eventId)
      const summary = summaryMap.get(eventId) ?? createEmptyDispatchSummary()
      const count = readNumber(row.total)
      summary[channel].total += count
      if (row.status === 'sent') summary[channel].sent += count
      else if (row.status === 'failed') summary[channel].failed += count
      else summary[channel].pending += count
      summaryMap.set(eventId, summary)
    }
    return summaryMap
  }

  private async loadInboxCountMap(eventIds: string[]) {
    const countMap = new Map<string, number>()
    if (!eventIds.length) return countMap
    const rows = await AppDataSource.getRepository(NotificationInbox)
      .createQueryBuilder('inbox')
      .select('inbox.eventId', 'eventId')
      .addSelect('COUNT(1)', 'total')
      .where('inbox.eventId IN (:...eventIds)', { eventIds })
      .groupBy('inbox.eventId')
      .getRawMany<{ eventId: string | number; total: string | number }>()
    for (const row of rows) {
      countMap.set(String(row.eventId), readNumber(row.total))
    }
    return countMap
  }

  private toEventRow(event: NotificationEvent, summary: NotificationEventDispatchSummary, inboxRecipientCount: number) {
    const category = resolveNotificationEventCategory(event.eventType)
    const resultStatus = deriveNotificationEventResult(event, summary)
    const { summary: summaryText, sourceUserDisplayName } = buildEventSummary(event.eventType, parseJsonObject(event.payloadJson))
    return {
      id: String(event.id),
      eventType: event.eventType,
      eventTypeLabel: getNotificationEventTypeLabel(event.eventType),
      category,
      categoryLabel: getNotificationEventCategoryLabel(category),
      categoryLevel: getNotificationEventCategoryLevel(category),
      sourceType: event.sourceType,
      sourceId: event.sourceId,
      summary: summaryText,
      sourceUserDisplayName,
      status: event.status,
      attemptCount: Number(event.attemptCount ?? 0),
      maxAttempts: NOTIFICATION_EVENT_MAX_ATTEMPTS,
      nextAttemptAt: event.nextAttemptAt,
      processedAt: event.processedAt,
      errorMessage: sanitizeNotificationErrorMessage(event.errorMessage),
      resultStatus,
      resultLabel: NOTIFICATION_EVENT_RESULT_LABELS[resultStatus],
      dispatchSummary: summary,
      inboxRecipientCount,
      createdAt: event.createdAt,
      updatedAt: event.updatedAt,
    }
  }

  /**
   * 通知事件主列表：
   * - 每个 eventId 只返回一条主记录，按事件 ID 倒序分页；
   * - 业务分类翻译为事件类型集合（系统通知 = 未登记事件类型），外发渠道按是否存在该渠道外发记录筛选。
   */
  async listEvents(query: NotificationEventLogQuery) {
    const qb = this.eventRepo.createQueryBuilder('event')
    if (query.category) {
      const knownEventTypes = Object.keys(NOTIFICATION_EVENT_TYPE_CATALOG)
      if (query.category === 'system') {
        qb.andWhere('event.eventType NOT IN (:...knownEventTypes)', { knownEventTypes })
      } else {
        const categoryEventTypes = listNotificationEventTypesByCategory(query.category)
        if (categoryEventTypes.length) {
          qb.andWhere('event.eventType IN (:...categoryEventTypes)', { categoryEventTypes })
        } else {
          qb.andWhere('1 = 0')
        }
      }
    }
    if (query.eventType) {
      qb.andWhere('event.eventType = :eventType', { eventType: query.eventType })
    }
    if (query.eventId) {
      qb.andWhere('event.id = :eventId', { eventId: query.eventId })
    }
    if (query.startAt) {
      qb.andWhere('event.createdAt >= :startAt', { startAt: query.startAt })
    }
    if (query.endAt) {
      qb.andWhere('event.createdAt <= :endAt', { endAt: query.endAt })
    }
    if (query.channel) {
      qb.andWhere(this.buildDispatchExistsSql(qb, 'channelDispatch', 'channelDispatch.channel = :channel'), { channel: query.channel })
    }
    if (query.resultStatus) {
      this.applyResultStatusCondition(qb, query.resultStatus)
    }

    const [events, total] = await qb
      .orderBy('event.id', 'DESC')
      .skip((query.page - 1) * query.pageSize)
      .take(query.pageSize)
      .getManyAndCount()
    const eventIds = events.map((event) => String(event.id))
    const [summaryMap, inboxCountMap] = await Promise.all([
      this.loadDispatchSummaryMap(eventIds),
      this.loadInboxCountMap(eventIds),
    ])

    return {
      page: query.page,
      pageSize: query.pageSize,
      total,
      list: events.map((event) =>
        this.toEventRow(
          event,
          summaryMap.get(String(event.id)) ?? createEmptyDispatchSummary(),
          inboxCountMap.get(String(event.id)) ?? 0,
        ),
      ),
    }
  }

  /**
   * 通知事件详情：
   * - dispatches：外发明细（渠道、脱敏目标、状态、失败次数、响应码、失败原因）；
   * - processingAttempts：按处理轮次分组的规则命中与外发执行记录；
   * - failureAudits：事件达到重试上限后的终态失败留痕。
   */
  async getEventDetail(eventId: string) {
    const event = await this.eventRepo.findOneBy({ id: eventId })
    if (!event) {
      throw new BizError('通知事件不存在', 404)
    }
    const normalizedEventId = String(event.id)
    const [dispatchRows, summaryMap, inboxCountMap] = await Promise.all([
      this.dispatchRepo.find({ where: { eventId: normalizedEventId }, order: { id: 'ASC' } }),
      this.loadDispatchSummaryMap([normalizedEventId]),
      this.loadInboxCountMap([normalizedEventId]),
    ])

    const auditRepo = AppDataSource.getRepository(SysAuditLog)
    const lastTouchedAt = Math.max(
      event.updatedAt?.getTime() ?? 0,
      event.processedAt?.getTime() ?? 0,
      event.createdAt?.getTime() ?? 0,
    )
    const processAudits = await auditRepo
      .createQueryBuilder('audit')
      .where('audit.actionType IN (:...actionTypes)', { actionTypes: ['notification.rule.matched', 'notification.external.dispatch'] })
      .andWhere('audit.targetType = :targetType', { targetType: 'notification_rule' })
      .andWhere('audit.createdAt >= :windowStart', { windowStart: new Date(event.createdAt.getTime() - AUDIT_WINDOW_BEFORE_MS) })
      .andWhere('audit.createdAt <= :windowEnd', { windowEnd: new Date(lastTouchedAt + AUDIT_WINDOW_AFTER_MS) })
      .andWhere(
        new Brackets((detailQb) => {
          // eventId 在审计 detail 中通常序列化为字符串；兼容早期数值写法（后接逗号或右花括号）。
          detailQb
            .where('audit.detailJson LIKE :eventIdStringPattern', { eventIdStringPattern: `%"eventId":"${normalizedEventId}"%` })
            .orWhere('audit.detailJson LIKE :eventIdNumberCommaPattern', { eventIdNumberCommaPattern: `%"eventId":${normalizedEventId},%` })
            .orWhere('audit.detailJson LIKE :eventIdNumberEndPattern', { eventIdNumberEndPattern: `%"eventId":${normalizedEventId}}%` })
        }),
      )
      .orderBy('audit.id', 'ASC')
      .take(AUDIT_DETAIL_LIMIT)
      .getMany()

    const ruleIds = [...new Set(processAudits.map((audit) => String(audit.targetId ?? '')).filter(Boolean))]
    const rules = ruleIds.length ? await AppDataSource.getRepository(NotificationRule).findBy({ id: In(ruleIds) }) : []
    const ruleNameMap = new Map(rules.map((rule) => [String(rule.id), rule.ruleName]))

    const failureAudits = await auditRepo.find({
      where: { actionType: 'notification.event.process', targetType: 'notification_event', targetId: normalizedEventId },
      order: { id: 'ASC' },
      take: AUDIT_DETAIL_LIMIT,
    })

    return {
      event: this.toEventRow(event, summaryMap.get(normalizedEventId) ?? createEmptyDispatchSummary(), inboxCountMap.get(normalizedEventId) ?? 0),
      dispatches: dispatchRows.map((dispatch) => ({
        id: String(dispatch.id),
        channel: dispatch.channel,
        channelLabel: NOTIFICATION_EVENT_CHANNEL_LABELS[dispatch.channel] ?? dispatch.channel,
        target: maskDispatchTarget(dispatch.channel, dispatch.target),
        status: dispatch.status,
        attemptCount: Number(dispatch.attemptCount ?? 0),
        maxAttempts: NOTIFICATION_EVENT_MAX_ATTEMPTS,
        responseCode: dispatch.responseCode,
        errorMessage: sanitizeNotificationErrorMessage(dispatch.errorMessage),
        sentAt: dispatch.sentAt,
        lastAttemptAt: dispatch.lastAttemptAt,
        createdAt: dispatch.createdAt,
      })),
      processingAttempts: this.groupProcessingAttempts(processAudits, ruleNameMap),
      failureAudits: failureAudits.map((audit) => {
        const detail = parseJsonObject(audit.detailJson)
        return {
          id: String(audit.id),
          createdAt: audit.createdAt,
          attemptCount: readNumber(detail.attemptCount),
          errorMessage: sanitizeNotificationErrorMessage(readText(detail.errorMessage) || null),
        }
      }),
    }
  }

  /**
   * 处理轮次分组：
   * - 新数据按审计 detail.attemptNo 分组；
   * - 历史数据没有 attemptNo 时，同一规则再次出现“规则命中”即视为进入下一轮。
   */
  private groupProcessingAttempts(audits: SysAuditLog[], ruleNameMap: Map<string, string>) {
    type RuleEntry = {
      ruleId: string
      ruleCode: string | null
      ruleName: string | null
      matchedAt: Date | null
      externalTriggerMode: string | null
      externalAllowed: boolean | null
      recipientCount: number
      dispatch: null | {
        resultStatus: string
        skipped: string | null
        emailSent: number
        emailAlreadySent: number
        emailFailed: number
        feishuSent: number
        feishuAlreadySent: number
        feishuFailed: number
        occurredAt: Date
      }
    }
    type AttemptEntry = { attemptNo: number; occurredAt: Date; rules: Map<string, RuleEntry> }

    const attempts: AttemptEntry[] = []
    let heuristicAttempt: AttemptEntry | null = null

    const ensureRule = (attempt: AttemptEntry, audit: SysAuditLog) => {
      const ruleId = String(audit.targetId ?? '')
      const existing = attempt.rules.get(ruleId)
      if (existing) return existing
      const entry: RuleEntry = {
        ruleId,
        ruleCode: audit.targetCode ?? null,
        ruleName: ruleNameMap.get(ruleId) ?? null,
        matchedAt: null,
        externalTriggerMode: null,
        externalAllowed: null,
        recipientCount: 0,
        dispatch: null,
      }
      attempt.rules.set(ruleId, entry)
      return entry
    }

    for (const audit of audits) {
      const detail = parseJsonObject(audit.detailJson)
      const ruleId = String(audit.targetId ?? '')
      const explicitAttemptNo = readNumber(detail.attemptNo)
      let attempt: AttemptEntry
      if (explicitAttemptNo > 0) {
        const found = attempts.find((item) => item.attemptNo === explicitAttemptNo)
        attempt = found ?? { attemptNo: explicitAttemptNo, occurredAt: audit.createdAt, rules: new Map() }
        if (!found) attempts.push(attempt)
      } else {
        const startsNewAttempt = !heuristicAttempt
          || (audit.actionType === 'notification.rule.matched' && heuristicAttempt.rules.get(ruleId)?.matchedAt)
        if (startsNewAttempt || !heuristicAttempt) {
          heuristicAttempt = { attemptNo: attempts.length + 1, occurredAt: audit.createdAt, rules: new Map() }
          attempts.push(heuristicAttempt)
        }
        attempt = heuristicAttempt
      }

      const rule = ensureRule(attempt, audit)
      if (audit.actionType === 'notification.rule.matched') {
        rule.matchedAt = audit.createdAt
        rule.externalTriggerMode = readText(detail.externalTriggerMode) || null
        rule.externalAllowed = typeof detail.externalAllowed === 'boolean' ? detail.externalAllowed : null
        rule.recipientCount = readNumber(detail.recipientCount)
      } else {
        rule.dispatch = {
          resultStatus: audit.resultStatus,
          skipped: readText(detail.skipped) || null,
          emailSent: readNumber(detail.emailSent),
          emailAlreadySent: readNumber(detail.emailAlreadySent),
          emailFailed: readNumber(detail.emailFailed),
          feishuSent: readNumber(detail.feishuSent),
          feishuAlreadySent: readNumber(detail.feishuAlreadySent),
          feishuFailed: readNumber(detail.feishuFailed),
          occurredAt: audit.createdAt,
        }
      }
    }

    return attempts
      .sort((prev, next) => prev.attemptNo - next.attemptNo)
      .map((attempt) => ({
        attemptNo: attempt.attemptNo,
        occurredAt: attempt.occurredAt,
        rules: [...attempt.rules.values()],
      }))
  }
}

export const notificationEventLogService = new NotificationEventLogService()
