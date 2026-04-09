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
