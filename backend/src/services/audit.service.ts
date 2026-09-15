/**
 * 文件说明：该文件负责审计日志服务，统一处理后台关键动作的留痕写入、分页查询与 CSV 导出。
 * 实现逻辑：
 * 1. 以审计日志实体为中心沉淀操作者、目标对象、结果状态和请求元信息，形成可追溯审计链路；
 * 2. 支持在事务内写入关键日志，也支持以安全模式补记辅助日志，平衡一致性与主流程可用性；
 * 3. 查询与导出共用同一套筛选口径，保证后台展示结果与导出结果保持一致。
 */

import { IsNull, type EntityManager } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import { escapeCsvCell } from '../utils/csv-security.js'
import { SysAuditLog } from '../entities/sys-audit-log.entity.js'
import {
  AUDIT_ACTION_CATALOG,
  AUDIT_CATEGORIES,
  AUDIT_DEFAULT_HIDDEN_ACTION_TYPES,
  AUDIT_TARGET_TYPE_LABELS,
  buildAuditCategoryCondition,
  getAuditActionTypeLabel,
  getAuditCategoryLabel,
  getAuditCategoryLevel,
  resolveAuditCategory,
  type AuditCategoryKey,
  type CategoryImportanceLevel,
} from '../constants/audit-action-catalog.js'
import type { AuditResultStatus } from '../types/auth.js'
import type { RequestMeta } from '../utils/request-meta.js'
import { databaseMaintenanceModeService } from './database-maintenance-mode.service.js'

export interface CreateAuditLogInput {
  actionType: string
  actionLabel: string
  targetType: string
  targetId?: string | null
  targetCode?: string | null
  resultStatus?: AuditResultStatus
  actor?: {
    userId: string | null
    username: string
    displayName: string
  } | null
  requestMeta?: RequestMeta
  detail?: Record<string, unknown> | null
}

export interface AuditLogListQuery {
  /** 业务类别：一级筛选，由后端常量统一翻译为动作编码条件。 */
  category?: AuditCategoryKey
  actionType?: string
  targetType?: string
  actorUserId?: string
  targetId?: string
  startAt?: Date
  endAt?: Date
}

export interface AuditLogPageQuery extends AuditLogListQuery {
  page: number
  pageSize: number
}

export interface SafeAuditRecordOptions {
  /** 恢复协议的最终审计失败必须阻止解除维护，不能按辅助日志吞掉异常。 */
  requireSuccess?: boolean
  /**
   * 仅供数据库迁移控制面在只读维护期间记录终态或紧急回退事件。
   * 普通业务审计不得启用，且非 database_migration 动作即使传入也不会放行。
   */
  allowDuringDatabaseMaintenance?: boolean
}

/** 审计列表记录：在实体字段基础上补充业务类别与中文名，列表与卡片直接展示。 */
export type AuditLogListRecord = SysAuditLog & {
  category: AuditCategoryKey
  categoryLabel: string
  /** 业务类别重要程度，前端据此给类别标签着色。 */
  categoryLevel: CategoryImportanceLevel
  actionTypeLabel: string
  targetTypeLabel: string
}

export interface AuditFilterOptions {
  categories: Array<{
    key: AuditCategoryKey
    label: string
    level: CategoryImportanceLevel
    actionTypes: Array<{ value: string; label: string }>
  }>
  targetTypes: Array<{ value: string; label: string }>
  defaultHiddenActionTypes: string[]
}

const AUDIT_FILTER_OPTIONS_CACHE_MS = 60_000

const truncateAuditTextByCodePoint = (value: string | null | undefined, maxLength: number): string | null => {
  if (value == null) return null
  const characters = Array.from(value)
  return characters.length <= maxLength ? value : characters.slice(0, maxLength).join('')
}

/**
 * 审计日志服务：
 * - 关键动作可在事务内调用，保证“业务成功 = 留痕成功”；
 * - 非关键或辅助日志可调用 safeRecord，避免日志失败反向影响主流程。
 */
export class AuditService {
  private filterOptionsCache: { expiresAt: number; value: AuditFilterOptions } | null = null

  /**
   * 统一构造审计筛选条件：
   * - 列表查询与导出共用同一套 where 条件，避免筛选口径不一致；
   * - 业务类别由后端常量翻译为“精确 IN + 前缀 LIKE”条件，未登记动作归入“其他”；
   * - 未选择业务类别与操作类型时，默认排除通知内部处理记录（改在“通知事件”页签按事件聚合展示）；
   * - 时间范围采用闭区间，满足“按当前筛选导出”预期。
   */
  private buildListQuery(query: AuditLogListQuery) {
    const qb = AppDataSource.getRepository(SysAuditLog).createQueryBuilder('audit')

    if (query.category) {
      const condition = buildAuditCategoryCondition('audit.actionType', query.category)
      qb.andWhere(condition.sql, condition.params)
    }
    if (!query.category && !query.actionType) {
      qb.andWhere('audit.actionType NOT IN (:...defaultHiddenActionTypes)', {
        defaultHiddenActionTypes: [...AUDIT_DEFAULT_HIDDEN_ACTION_TYPES],
      })
    }
    if (query.actionType) {
      qb.andWhere('audit.actionType = :actionType', { actionType: query.actionType })
    }
    if (query.targetType) {
      qb.andWhere('audit.targetType = :targetType', { targetType: query.targetType })
    }
    if (query.actorUserId) {
      qb.andWhere('audit.actorUserId = :actorUserId', { actorUserId: query.actorUserId })
    }
    if (query.targetId) {
      qb.andWhere('audit.targetId = :targetId', { targetId: query.targetId })
    }
    if (query.startAt) {
      qb.andWhere('audit.createdAt >= :startAt', { startAt: query.startAt })
    }
    if (query.endAt) {
      qb.andWhere('audit.createdAt <= :endAt', { endAt: query.endAt })
    }

    return qb
  }

  async record(input: CreateAuditLogInput, manager?: EntityManager): Promise<SysAuditLog> {
    const repository = (manager ?? AppDataSource.manager).getRepository(SysAuditLog)
    const entity = repository.create({
      actionType: input.actionType,
      actionLabel: input.actionLabel,
      actorUserId: input.actor?.userId ?? null,
      // 操作者与目标快照按列宽截断：客户端常以邮箱（最长 128 字符）作账号快照，
      // 超出 varchar(64) 会在 MySQL 严格模式下使同事务内的业务写入整体回滚。
      actorUsername: truncateAuditTextByCodePoint(input.actor?.username, 64),
      actorDisplayName: truncateAuditTextByCodePoint(input.actor?.displayName, 64),
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      targetCode: truncateAuditTextByCodePoint(input.targetCode, 128),
      resultStatus: input.resultStatus ?? 'success',
      detailJson: input.detail ? JSON.stringify(input.detail) : null,
      ipAddress: truncateAuditTextByCodePoint(input.requestMeta?.ipAddress, 64),
      userAgent: truncateAuditTextByCodePoint(input.requestMeta?.userAgent, 255),
    })

    return repository.save(entity)
  }

  private shouldPauseSafeRecord(input: CreateAuditLogInput, options: SafeAuditRecordOptions): boolean {
    if (!databaseMaintenanceModeService.isReadOnly()) {
      return false
    }
    return !(
      options.allowDuringDatabaseMaintenance === true
      && input.actionType.startsWith('database_migration.')
    )
  }

  async safeRecord(input: CreateAuditLogInput, options: SafeAuditRecordOptions = {}): Promise<void> {
    if (this.shouldPauseSafeRecord(input, options)) {
      return
    }
    try {
      await this.record(input)
    } catch (error) {
      console.error('[y-link-backend] audit log write failed:', error)
    }
  }

  /**
   * 为可重入 finalizer 提供幂等审计：
   * - 以动作、目标类型和目标 ID 作为迁移终态的稳定键；
   * - 仅用于同一任务只能出现一次的终态事件，普通业务审计仍使用 safeRecord。
   */
  async safeRecordOnce(input: CreateAuditLogInput, options: SafeAuditRecordOptions = {}): Promise<void> {
    if (this.shouldPauseSafeRecord(input, options)) {
      if (options.requireSuccess) throw new Error('AUDIT_WRITE_NOT_ADMITTED')
      return
    }
    try {
      const repository = AppDataSource.getRepository(SysAuditLog)
      const existing = await repository.exists({
        where: {
          actionType: input.actionType,
          targetType: input.targetType,
          targetId: input.targetId ?? IsNull(),
        },
      })
      if (!existing) {
        await this.record(input)
      }
    } catch (error) {
      if (options.requireSuccess) throw error
      console.error('[y-link-backend] idempotent audit log write failed:', error)
    }
  }

  async list(query: AuditLogPageQuery): Promise<{ page: number; pageSize: number; total: number; list: AuditLogListRecord[] }> {
    const qb = this.buildListQuery(query)
    const [rows, total] = await qb
      .orderBy('audit.id', 'DESC')
      .skip((query.page - 1) * query.pageSize)
      .take(query.pageSize)
      .getManyAndCount()

    return {
      page: query.page,
      pageSize: query.pageSize,
      total,
      list: rows.map((item) => this.toListRecord(item)),
    }
  }

  private toListRecord(item: SysAuditLog): AuditLogListRecord {
    const category = resolveAuditCategory(item.actionType)
    return Object.assign(item, {
      category,
      categoryLabel: getAuditCategoryLabel(category),
      categoryLevel: getAuditCategoryLevel(category),
      actionTypeLabel: getAuditActionTypeLabel(item.actionType) ?? item.actionLabel,
      targetTypeLabel: AUDIT_TARGET_TYPE_LABELS[item.targetType] ?? item.targetType,
    })
  }

  /**
   * 审计筛选项：
   * - 以后端动作目录为主，合并数据库中实际出现过的动作与目标类型，历史或新增未登记动作归入“其他”；
   * - 结果按类别分组下发，前端据此做“业务类别 → 操作类型”二级联动；
   * - 进程内缓存 60 秒，避免每次打开页面都对审计表做分组统计。
   */
  async getFilterOptions(): Promise<AuditFilterOptions> {
    const nowMs = Date.now()
    if (this.filterOptionsCache && this.filterOptionsCache.expiresAt > nowMs) {
      return this.filterOptionsCache.value
    }
    const repository = AppDataSource.getRepository(SysAuditLog)
    const [actionRows, targetRows] = await Promise.all([
      repository
        .createQueryBuilder('audit')
        .select('audit.actionType', 'actionType')
        .addSelect('MAX(audit.actionLabel)', 'actionLabel')
        .groupBy('audit.actionType')
        .getRawMany<{ actionType: string; actionLabel: string | null }>(),
      repository
        .createQueryBuilder('audit')
        .select('audit.targetType', 'targetType')
        .groupBy('audit.targetType')
        .getRawMany<{ targetType: string }>(),
    ])

    const actionTypesByCategory = new Map<AuditCategoryKey, Map<string, string>>(
      AUDIT_CATEGORIES.map((category) => [category.key, new Map<string, string>()]),
    )
    for (const [actionType, definition] of Object.entries(AUDIT_ACTION_CATALOG)) {
      actionTypesByCategory.get(definition.category)?.set(actionType, definition.label)
    }
    for (const row of actionRows) {
      const actionType = String(row.actionType ?? '').trim()
      if (!actionType || AUDIT_ACTION_CATALOG[actionType]) continue
      actionTypesByCategory.get(resolveAuditCategory(actionType))?.set(actionType, row.actionLabel?.trim() || actionType)
    }

    const targetTypeMap = new Map<string, string>(Object.entries(AUDIT_TARGET_TYPE_LABELS))
    for (const row of targetRows) {
      const targetType = String(row.targetType ?? '').trim()
      if (targetType && !targetTypeMap.has(targetType)) {
        targetTypeMap.set(targetType, targetType)
      }
    }

    const value: AuditFilterOptions = {
      categories: AUDIT_CATEGORIES.map((category) => ({
        key: category.key,
        label: category.label,
        level: category.level,
        actionTypes: [...(actionTypesByCategory.get(category.key)?.entries() ?? [])].map(([actionType, label]) => ({
          value: actionType,
          label,
        })),
      })),
      targetTypes: [...targetTypeMap.entries()].map(([targetType, label]) => ({ value: targetType, label })),
      defaultHiddenActionTypes: [...AUDIT_DEFAULT_HIDDEN_ACTION_TYPES],
    }
    this.filterOptionsCache = { expiresAt: nowMs + AUDIT_FILTER_OPTIONS_CACHE_MS, value }
    return value
  }

  /**
   * 导出 CSV：
   * - 完整复用当前筛选条件，确保导出结果与列表检索口径一致；
   * - 对详情 JSON 做 CSV 转义，避免换行与双引号破坏文件结构。
   */
  async exportCsv(query: AuditLogListQuery): Promise<string> {
    const list = await this.buildListQuery(query).orderBy('audit.id', 'DESC').getMany()
    const headers = ['时间', '动作编码', '动作名称', '业务类别', '执行结果', '操作人ID', '操作人账号', '操作人姓名', '目标类型', '目标ID', '目标标识', '来源IP', '客户端UA', '详情']
    const rows = list.map((item) => [
      item.createdAt.toISOString(),
      item.actionType,
      item.actionLabel,
      getAuditCategoryLabel(resolveAuditCategory(item.actionType)),
      item.resultStatus,
      item.actorUserId ?? '',
      item.actorUsername ?? '',
      item.actorDisplayName ?? '',
      item.targetType,
      item.targetId ?? '',
      item.targetCode ?? '',
      item.ipAddress ?? '',
      item.userAgent ?? '',
      item.detailJson ?? '',
    ])

    return [headers, ...rows]
      .map((row) =>
        row
          .map(escapeCsvCell)
          .join(','),
      )
      .join('\n')
  }
}

export const auditService = new AuditService()
