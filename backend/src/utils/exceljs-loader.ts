/**
 * 文件职责：只缓存ExcelJS模块加载，避免业务启动预先解析整套XLSX依赖。
 * 实现逻辑：原异步文件操作按需等待同一个模块Promise；加载失败清空Promise以允许重试。
 * 维护说明：不缓存Workbook/Writer实例，每次导入导出仍由调用方独立创建并管理流/租约。
 */
import type ExcelJS from 'exceljs'

let modulePromise: Promise<typeof ExcelJS> | null = null

export const loadExcelJs = (): Promise<typeof ExcelJS> => {
  modulePromise ??= import('exceljs').then((module) => module.default).catch((error: unknown) => {
    modulePromise = null
    throw error
  })
  return modulePromise
}
