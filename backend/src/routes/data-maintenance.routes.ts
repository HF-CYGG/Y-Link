/**
 * 模块说明：backend/src/routes/data-maintenance.routes.ts
 * 文件职责：提供数据维护接口，包括 SQLite 备份、JSON 导入导出、SQLite -> MySQL 迁移预检、迁移任务与应用切换回退。
 * 维护说明：所有迁移类接口统一收口在这里，避免数据库治理能力分散到多个路由文件。
 */

import { Router } from 'express'
import { z } from 'zod'
import { requirePermission } from '../middleware/auth.middleware.js'
import { databaseMigrationService } from '../services/database-migration.service.js'
import { dataMaintenanceService } from '../services/data-maintenance.service.js'
import type { AuthenticatedRequest } from '../types/auth.js'
import { asyncHandler } from '../utils/async-handler.js'
import { extractRequestMeta } from '../utils/request-meta.js'

const importPayloadSchema = z.object({
  exportedAt: z.string(),
  version: z.string(),
  tables: z.object({
    systemConfigs: z.array(z.record(z.any())).default([]),
    products: z.array(z.record(z.any())).default([]),
    clientUsers: z.array(z.record(z.any())).default([]),
    preorders: z.array(z.record(z.any())).default([]),
    preorderItems: z.array(z.record(z.any())).default([]),
    inventoryLogs: z.array(z.record(z.any())).default([]),
  }),
})

/**
 * MySQL 目标库连接参数：
 * - 由迁移预检、创建任务与应用切换共用；
 * - 统一约束输入格式，避免多个接口各自做散乱校验。
 */
const mysqlMigrationTargetSchema = z.object({
  host: z.string().trim().min(1).max(200),
  port: z.number().int().min(1).max(65535),
  user: z.string().trim().min(1).max(100),
  password: z.string().max(500).default(''),
  database: z.string().trim().min(1).max(100),
  dbSync: z.boolean().optional(),
})

const sqliteToMysqlPrecheckSchema = z.object({
  target: mysqlMigrationTargetSchema,
  allowTargetWithData: z.boolean().optional(),
})

const createSqliteToMysqlTaskSchema = sqliteToMysqlPrecheckSchema.extend({
  initializeSchema: z.boolean().optional(),
  clearTargetBeforeImport: z.boolean().optional(),
  switchAfterSuccess: z.boolean().optional(),
  createSqliteBackup: z.boolean().optional(),
  note: z.string().trim().max(500).optional(),
})

const applyDatabaseSwitchSchema = z
  .object({
    taskId: z.string().trim().min(1).optional(),
    target: mysqlMigrationTargetSchema.optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((value) => value.taskId || value.target, {
    message: '切换应用时必须提供 taskId 或目标 MySQL 配置',
  })

const rollbackDatabaseSwitchSchema = z.object({
  taskId: z.string().trim().min(1).optional(),
  sqlitePath: z.string().trim().min(1).max(500).optional(),
  reason: z.string().trim().max(500).optional(),
  clearOnly: z.boolean().optional(),
})

export const dataMaintenanceRouter = Router()

dataMaintenanceRouter.post(
  '/backup/sqlite',
  requirePermission('system_configs:update'),
  asyncHandler(async (_req, res) => {
    const data = await dataMaintenanceService.createSqliteBackup()
    res.json({ code: 0, message: 'ok', data })
  }),
)

dataMaintenanceRouter.get(
  '/export/json',
  requirePermission('system_configs:view'),
  asyncHandler(async (_req, res) => {
    const data = await dataMaintenanceService.exportJson()
    res.json({ code: 0, message: 'ok', data })
  }),
)

dataMaintenanceRouter.post(
  '/import/json',
  requirePermission('system_configs:update'),
  asyncHandler(async (req, res) => {
    const payload = importPayloadSchema.parse(req.body)
    const data = await dataMaintenanceService.importJson(payload as any)
    res.json({ code: 0, message: 'ok', data })
  }),
)

dataMaintenanceRouter.post(
  '/db-migration/precheck',
  requirePermission('system_configs:view'),
  asyncHandler(async (req, res) => {
    const payload = sqliteToMysqlPrecheckSchema.parse(req.body)
    const data = await databaseMigrationService.precheckSQLiteToMySql(payload)
    res.json({ code: 0, message: 'ok', data })
  }),
)

dataMaintenanceRouter.get(
  '/db-migration/tasks',
  requirePermission('system_configs:view'),
  asyncHandler(async (_req, res) => {
    const data = await databaseMigrationService.listSQLiteToMySqlTasks()
    res.json({ code: 0, message: 'ok', data })
  }),
)

dataMaintenanceRouter.get(
  '/db-migration/tasks/:taskId',
  requirePermission('system_configs:view'),
  asyncHandler(async (req, res) => {
    const data = await databaseMigrationService.getSQLiteToMySqlTask(req.params.taskId)
    res.json({ code: 0, message: 'ok', data })
  }),
)

dataMaintenanceRouter.post(
  '/db-migration/tasks',
  requirePermission('system_configs:update'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = createSqliteToMysqlTaskSchema.parse(req.body)
    const data = await databaseMigrationService.createSQLiteToMySqlTask(
      payload,
      authReq.auth,
      extractRequestMeta(req),
    )
    res.json({ code: 0, message: 'ok', data })
  }),
)

dataMaintenanceRouter.post(
  '/db-migration/tasks/:taskId/run',
  requirePermission('system_configs:update'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const data = await databaseMigrationService.runSQLiteToMySqlTask(
      req.params.taskId,
      authReq.auth,
      extractRequestMeta(req),
    )
    res.json({ code: 0, message: 'ok', data })
  }),
)

dataMaintenanceRouter.get(
  '/db-migration/runtime-override',
  requirePermission('system_configs:view'),
  asyncHandler(async (_req, res) => {
    const data = await databaseMigrationService.getRuntimeOverrideState()
    res.json({ code: 0, message: 'ok', data })
  }),
)

dataMaintenanceRouter.post(
  '/db-migration/switch',
  requirePermission('system_configs:update'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = applyDatabaseSwitchSchema.parse(req.body)
    const data = await databaseMigrationService.applyDatabaseSwitch(payload, authReq.auth, extractRequestMeta(req))
    res.json({ code: 0, message: 'ok', data })
  }),
)

dataMaintenanceRouter.post(
  '/db-migration/rollback',
  requirePermission('system_configs:update'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = rollbackDatabaseSwitchSchema.parse(req.body)
    const data = await databaseMigrationService.rollbackDatabaseSwitch(payload, authReq.auth, extractRequestMeta(req))
    res.json({ code: 0, message: 'ok', data })
  }),
)

dataMaintenanceRouter.delete(
  '/db-migration/runtime-override',
  requirePermission('system_configs:update'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const data = await databaseMigrationService.clearRuntimeOverride(authReq.auth, extractRequestMeta(req))
    res.json({ code: 0, message: 'ok', data })
  }),
)
