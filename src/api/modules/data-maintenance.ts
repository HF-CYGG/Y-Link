/**
 * 模块说明：数据维护与迁移 API 模块。
 * 文件职责：封装 SQLite 备份、全量 JSON 导出与导入恢复接口，服务系统运维与环境迁移场景。
 * 维护说明：维护时重点关注导入覆盖风险、数据结构兼容性与仅限管理员触发的操作边界。
 */

import { request } from '@/api/http'

/**
 * 创建 SQLite 数据库备份：
 * - 仅适用于本地 SQLite 运行环境，供系统管理员做数据快照兜底。
 */
export const createSqliteBackup = () =>
  request<{ fileName: string; filePath: string }>({
    method: 'POST',
    url: '/data-maintenance/backup/sqlite',
  })

/**
 * 导出系统全量数据为 JSON 格式：
 * - 返回包含全部基础表数据及导出时间戳与版本号的对象，可用于跨库或环境迁移。
 */
export const exportDataAsJson = () =>
  request<{
    exportedAt: string
    version: string
    tables: Record<string, Array<Record<string, unknown>>>
  }>({
    method: 'GET',
    url: '/data-maintenance/export/json',
  })

/**
 * 通过 JSON 格式导入恢复系统全量数据：
 * - 覆盖现有数据，具有破坏性操作，通常在运维环境交接或系统重建时调用。
 */
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
