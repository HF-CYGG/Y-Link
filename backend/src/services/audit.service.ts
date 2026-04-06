import type { EntityManager } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import { SysAuditLog } from '../entities/sys-audit-log.entity.js'
import type { AuditResultStatus, AuthUserContext } from '../types/auth.js'
import type { RequestMeta } from '../utils/request-meta.js'

export interface CreateAuditLogInput {
  actionType: string
  actionLabel: string
  targetType: string
  targetId?: string | null
  targetCode?: string | null
  resultStatus?: AuditResultStatus
  actor?: Pick<AuthUserContext, 'userId' | 'username' | 'displayName'> | null
  requestMeta?: RequestMeta
  detail?: Record<string, unknown> | null
}

export interface AuditLogListQuery {
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

/**
 * 审计日志服务：
 * - 关键动作可在事务内调用，保证“业务成功 = 留痕成功”；
 * - 非关键或辅助日志可调用 safeRecord，避免日志失败反向影响主流程。
 */
export class AuditService {
  /**
   * 统一构造审计筛选条件：
   * - 列表查询与导出共用同一套 where 条件，避免筛选口径不一致；
   * - 时间范围采用闭区间，满足“按当前筛选导出”预期。
   */
  private buildListQuery(query: AuditLogListQuery) {
    const qb = AppDataSource.getRepository(SysAuditLog).createQueryBuilder('audit')

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
      actorUsername: input.actor?.username ?? null,
      actorDisplayName: input.actor?.displayName ?? null,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      targetCode: input.targetCode ?? null,
      resultStatus: input.resultStatus ?? 'success',
      detailJson: input.detail ? JSON.stringify(input.detail) : null,
      ipAddress: input.requestMeta?.ipAddress ?? null,
      userAgent: input.requestMeta?.userAgent ?? null,
    })

    return repository.save(entity)
  }

  async safeRecord(input: CreateAuditLogInput): Promise<void> {
    try {
      await this.record(input)
    } catch (error) {
      console.error('[y-link-backend] audit log write failed:', error)
    }
  }

  async list(query: AuditLogPageQuery): Promise<{ page: number; pageSize: number; total: number; list: SysAuditLog[] }> {
    const qb = this.buildListQuery(query)
    const [list, total] = await qb
      .orderBy('audit.id', 'DESC')
      .skip((query.page - 1) * query.pageSize)
      .take(query.pageSize)
      .getManyAndCount()

    return {
      page: query.page,
      pageSize: query.pageSize,
      total,
      list,
    }
  }

  /**
   * 导出 CSV：
   * - 完整复用当前筛选条件，确保导出结果与列表检索口径一致；
   * - 对详情 JSON 做 CSV 转义，避免换行与双引号破坏文件结构。
   */
  async exportCsv(query: AuditLogListQuery): Promise<string> {
    const list = await this.buildListQuery(query).orderBy('audit.id', 'DESC').getMany()
    const headers = ['时间', '动作编码', '动作名称', '执行结果', '操作人ID', '操作人账号', '操作人姓名', '目标类型', '目标ID', '目标标识', '来源IP', '客户端UA', '详情']
    const rows = list.map((item) => [
      item.createdAt.toISOString(),
      item.actionType,
      item.actionLabel,
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
          .map((cell) => {
            const normalized = String(cell ?? '').replaceAll('"', '""')
            return `"${normalized}"`
          })
          .join(','),
      )
      .join('\n')
  }
}

export const auditService = new AuditService()
