/**
 * 模块说明：src/api/modules/audit.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { http, request, type RequestConfig } from '@/api/http'
import type { PaginationQueryInput, PaginationResult } from '@/types/api'

/**
 * 审计日志查询参数：
 * - 与后端列表接口保持一致；
 * - startAt/endAt 用于本期新增的时间范围检索与导出筛选。
 */
export interface AuditLogListQuery extends PaginationQueryInput {
  actionType?: string
  targetType?: string
  actorUserId?: string
  targetId?: string
  startAt?: string
  endAt?: string
}

/**
 * 审计日志记录：
 * - 字段与后端实体保持基本一致；
 * - detailJson 保留字符串，页面层按需安全解析展示。
 */
export interface AuditLogRecord {
  id: string
  actionType: string
  actionLabel: string
  actorUserId: string | null
  actorUsername: string | null
  actorDisplayName: string | null
  targetType: string
  targetId: string | null
  targetCode: string | null
  resultStatus: 'success' | 'failed'
  detailJson: string | null
  ipAddress: string | null
  userAgent: string | null
  createdAt: string
}

interface AuditLogListRawResult {
  page: number
  pageSize: number
  total: number
  list: AuditLogRecord[]
}

/**
 * 审计日志分页结果：
 * - 标准化为 records 供页面复用统一分页工具；
 * - 避免日志页再单独写一套 list 兼容逻辑。
 */
export type AuditLogListResult = PaginationResult<AuditLogRecord>

/**
 * 获取审计日志分页列表：
 * - 与页面当前筛选项一一对应；
 * - 导出接口会复用同一套查询参数，确保口径一致。
 */
export const getAuditLogList = async (
  params: AuditLogListQuery,
  requestConfig: RequestConfig = {},
): Promise<AuditLogListResult> => {
  const result = await request<AuditLogListRawResult>({
    ...requestConfig,
    method: 'GET',
    url: '/audit-logs',
    params,
  })

  return {
    page: result.page,
    pageSize: result.pageSize,
    total: result.total,
    records: result.list,
  }
}

/**
 * 导出审计日志：
 * - 直接返回文件二进制与文件名；
 * - 调用方只需传入当前筛选条件，即可导出“当前筛选结果”。
 */
export const exportAuditLogs = async (params: AuditLogListQuery) => {
  const response = await http.request<Blob>({
    method: 'GET',
    url: '/audit-logs/export',
    params,
    responseType: 'blob',
  })

  const disposition = response.headers['content-disposition']
  const fileNamePattern = /filename="?([^";]+)"?/
  const matchedFileName = typeof disposition === 'string' ? fileNamePattern.exec(disposition) : null

  return {
    blob: response.data,
    fileName: matchedFileName?.[1] ?? 'audit-logs.csv',
  }
}
