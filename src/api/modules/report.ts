/**
 * 模块说明：src/api/modules/report.ts
 * 文件职责：封装报表中心五类报表的分页预览、字段定义与 Excel 导出接口。
 * 实现逻辑：
 * - 前端把字段与标签数组统一序列化为逗号分隔参数，兼容后端路由解析；
 * - 查询接口返回当前页数据、已选字段和可选字段，页面据此渲染动态表格；
 * - 导出接口返回 Blob 与文件名，由页面复用统一下载流程。
 * 维护说明：
 * - 新增报表类型时需要同步扩展 ReportType、页面字段配置和后端白名单；
 * - 不在前端拼装 Excel，避免导出口径和服务端查询口径漂移。
 */

import { http, request, type RequestConfig } from '@/api/http'
import type { PaginationQueryInput, PaginationResult } from '@/types/api'

export type ReportType = 'inventory' | 'tag-sales' | 'kingdee' | 'walkin' | 'outbound-flow'

export interface ReportFieldDefinition {
  key: string
  label: string
  width: number
  numeric?: boolean
}

export type ReportRow = Record<string, string | number | null>

export interface ReportQuery extends PaginationQueryInput {
  startDate?: string
  endDate?: string
  tagIds?: string[]
  fields?: string[]
}

export interface ReportQueryResult extends PaginationResult<ReportRow> {
  type: ReportType
  title: string
  fields: ReportFieldDefinition[]
  availableFields: ReportFieldDefinition[]
}

const buildReportParams = (params: ReportQuery = {}) => {
  return {
    ...params,
    tagIds: params.tagIds?.length ? params.tagIds.join(',') : undefined,
    fields: params.fields?.length ? params.fields.join(',') : undefined,
  }
}

export const getReportData = async (
  type: ReportType,
  params: ReportQuery,
  requestConfig: RequestConfig = {},
): Promise<ReportQueryResult> => {
  const result = await request<{
    type: ReportType
    title: string
    page: number
    pageSize: number
    total: number
    list: ReportRow[]
    fields: ReportFieldDefinition[]
    availableFields: ReportFieldDefinition[]
  }>({
    ...requestConfig,
    method: 'GET',
    url: `/reports/${type}`,
    params: buildReportParams(params),
  })

  return {
    type: result.type,
    title: result.title,
    page: result.page,
    pageSize: result.pageSize,
    total: result.total,
    records: result.list,
    fields: result.fields,
    availableFields: result.availableFields,
  }
}

export const exportReportExcel = async (type: ReportType, params: ReportQuery) => {
  const response = await http.request<Blob>({
    method: 'GET',
    url: `/reports/${type}/export`,
    params: buildReportParams(params),
    responseType: 'blob',
  })

  const disposition = response.headers['content-disposition']
  const fileNamePattern = /filename="?([^";]+)"?/
  const matchedFileName = typeof disposition === 'string' ? fileNamePattern.exec(disposition) : null

  return {
    blob: response.data,
    fileName: matchedFileName?.[1] ?? `report-${type}.xlsx`,
  }
}
