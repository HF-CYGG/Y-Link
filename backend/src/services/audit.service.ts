/**
 * 文件说明：该文件负责审计日志服务，统一处理后台关键动作的留痕写入、分页查询与 CSV 导出。
 * 实现逻辑：
 * 1. 以审计日志实体为中心沉淀操作者、目标对象、结果状态和请求元信息，形成可追溯审计链路；
 * 2. 支持在事务内写入关键日志，也支持以安全模式补记辅助日志，平衡一致性与主流程可用性；
 * 3. 查询与导出共用同一套筛选口径，保证后台展示结果与导出结果保持一致。
 */

import { once } from 'node:events'
import type { Writable } from 'node:stream'
import { IsNull, type EntityManager } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import { escapeCsvCell } from '../utils/csv-security.js'
import { BizError } from '../utils/errors.js'
import { toSafeErrorLog } from '../utils/safe-error-log.js'
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
const AUDIT_EXPORT_MAX_ROWS = 200_000
const AUDIT_EXPORT_BATCH_SIZE = 1000
const AUDIT_EXPORT_HEADERS = ['时间', '动作编码', '动作名称', '业务类别', '执行结果', '操作人ID', '操作人账号', '操作人姓名', '目标类型', '目标ID', '目标标识', '来源IP', '客户端UA', '详情']

export type DataExportType = 'audit_logs' | 'report' | 'inventory_logs' | 'products'

const DATA_EXPORT_LABELS: Readonly<Record<DataExportType, string>> = {
  audit_logs: '导出审计日志',
  report: '导出报表',
  inventory_logs: '导出库存流水',
  products: '导出商品',
}

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
      // 审计写入失败的 SQL 参数即审计明细本身，只记录驱动错误码。
      console.error('[y-link-backend] audit log write failed:', toSafeErrorLog(error))
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
      console.error('[y-link-backend] idempotent audit log write failed:', toSafeErrorLog(error))
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
  private toCsvLine(item: SysAuditLog): string {
    return [
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
    ].map(escapeCsvCell).join(',')
  }

  /** 导出前先计数：超过上限直接拒绝并提示缩小范围，避免大表导出拖垮进程内存与数据库。 */
  private async assertExportWithinLimit(query: AuditLogListQuery): Promise<number> {
    const total = await this.buildListQuery(query).getCount()
    if (total > AUDIT_EXPORT_MAX_ROWS) {
      throw new BizError(`导出结果 ${total} 条，超过 ${AUDIT_EXPORT_MAX_ROWS} 条上限，请缩小时间范围或筛选条件`, 400)
    }
    return total
  }

  /** 一次性返回整份 CSV 文本（不含 BOM），仅供回归脚本与小结果集使用；同样受行数上限约束。 */
  async exportCsv(query: AuditLogListQuery): Promise<string> {
    await this.assertExportWithinLimit(query)
    const list = await this.buildListQuery(query).orderBy('audit.id', 'DESC').getMany()
    return [AUDIT_EXPORT_HEADERS.map(escapeCsvCell).join(','), ...list.map((item) => this.toCsvLine(item))].join('\n')
  }

  /**
   * 流式导出 CSV：先计数校验上限，首查成功后才回调 onReady 声明下载；
   * 再按 id 游标每批读取写出并遵守背压，内存占用与结果集大小无关。
   */
  async exportCsvToStream(query: AuditLogListQuery, output: Writable, onReady?: () => void): Promise<{ rowCount: number }> {
    await this.assertExportWithinLimit(query)
    onReady?.()
    const write = async (chunk: string) => {
      if (output.destroyed) {
        throw new Error('审计日志下载连接已关闭')
      }
      if (!output.write(chunk)) {
        await once(output, 'drain')
      }
    }
    // CSV 前置 UTF-8 BOM，保证 Excel 直接打开中文不乱码。
    await write(`${String.fromCharCode(0xfeff)}${AUDIT_EXPORT_HEADERS.map(escapeCsvCell).join(',')}`)
    let rowCount = 0
    let cursorId: string | null = null
    while (true) {
      const batchQuery = this.buildListQuery(query).orderBy('audit.id', 'DESC').take(AUDIT_EXPORT_BATCH_SIZE)
      if (cursorId !== null) {
        batchQuery.andWhere('audit.id < :cursorId', { cursorId })
      }
      const batch = await batchQuery.getMany()
      if (batch.length) {
        await write(`\n${batch.map((item) => this.toCsvLine(item)).join('\n')}`)
        rowCount += batch.length
      }
      if (batch.length < AUDIT_EXPORT_BATCH_SIZE || rowCount >= AUDIT_EXPORT_MAX_ROWS) {
        break
      }
      cursorId = batch[batch.length - 1].id
    }
    output.end()
    return { rowCount }
  }

  /**
   * 数据导出留痕（批量外泄检测）：只记录导出类型、筛选条件与行数，不记录导出内容本身。
   * 导出已完成、数据已发出，审计写入失败不能反向影响响应，因此使用 safeRecord。
   */
  async recordDataExport(input: {
    exportType: DataExportType
    actor: CreateAuditLogInput['actor']
    requestMeta?: RequestMeta
    rowCount: number | null
    filters: Record<string, unknown>
  }): Promise<void> {
    await this.safeRecord({
      actionType: `data_export.${input.exportType}`,
      actionLabel: DATA_EXPORT_LABELS[input.exportType],
      targetType: 'data_export',
      targetCode: input.exportType,
      actor: input.actor,
      requestMeta: input.requestMeta,
      detail: {
        rowCount: input.rowCount,
        filters: input.filters,
      },
    })
  }
}

export const auditService = new AuditService()
