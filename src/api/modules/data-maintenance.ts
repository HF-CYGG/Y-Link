/**
 * 模块说明：src/api/modules/data-maintenance.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { request } from '@/api/http'

export const createSqliteBackup = () =>
  request<{ fileName: string; filePath: string }>({
    method: 'POST',
    url: '/data-maintenance/backup/sqlite',
  })

export const exportDataAsJson = () =>
  request<{
    exportedAt: string
    version: string
    tables: Record<string, Array<Record<string, unknown>>>
  }>({
    method: 'GET',
    url: '/data-maintenance/export/json',
  })

export const importDataFromJson = (payload: {
  exportedAt: string
  version: string
  tables: Record<string, Array<Record<string, unknown>>>
}) =>
  request<{
    imported: Record<string, number>
  }>({
    method: 'POST',
    url: '/data-maintenance/import/json',
    data: payload,
  })
