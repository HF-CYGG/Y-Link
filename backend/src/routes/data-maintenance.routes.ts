/**
 * 文件说明：数据维护路由，负责数据库备份、JSON 导入导出、SQLite 到 MySQL 迁移预检与切换回退等治理接口。
 * 实现逻辑：通过后台权限与角色控制把高风险数据操作统一收口，在路由层校验导入结构后调用维护服务和迁移服务执行任务。
 * 维护重点：调整数据治理流程时，需要同步核对权限边界、导入导出结构版本以及迁移切换的审计留痕。
 */

import { Router, type Request } from 'express'
import { z } from 'zod'
import { env } from '../config/env.js'
import { requirePermission, requireRole } from '../middleware/auth.middleware.js'
import { authService } from '../services/auth.service.js'
import { databaseMigrationService } from '../services/database-migration.service.js'
import { dataMaintenanceService } from '../services/data-maintenance.service.js'
import type { AuthenticatedRequest } from '../types/auth.js'
import { asyncHandler } from '../utils/async-handler.js'
import { extractRequestMeta } from '../utils/request-meta.js'
import { AppDataSource } from '../config/data-source.js'
import { resolveDatabaseCapabilities } from '../database/database-capabilities.js'
import { getTransactionCoordinator } from '../database/transaction-coordinator.js'
import { issueDatabaseRescueCredential } from '../runtime/database-rescue-control.js'
import { isSecureOrDirectLoopback } from '../utils/http-security.js'
import { BizError } from '../utils/errors.js'
import { assertPermanentDeletePasswordForRequest, createPermanentDeleteLimiter } from '../utils/permanent-delete-guard.js'
import { auditService } from '../services/audit.service.js'
import { EXISTING_PASSWORD_INPUT_MAX_LENGTH } from '../constants/auth-input-limits.js'
import { listConcurrencyGateSnapshots } from '../utils/bounded-concurrency.js'

const importPayloadSchema = z
  .object({
    exportedAt: z.string().trim().min(1).max(100),
    version: z.string().trim().min(1).max(100),
    tables: z
      .object({
        systemConfigs: z.array(z.record(z.any())).default([]),
        products: z.array(z.record(z.any())).default([]),
        clientUsers: z.array(z.record(z.any())).default([]),
        preorders: z.array(z.record(z.any())).default([]),
        preorderItems: z.array(z.record(z.any())).default([]),
        inventoryLogs: z.array(z.record(z.any())).default([]),
      })
      .strict(),
    // 导入会先清空商品、客户端账号、预订单、库存流水与系统配置再写入，属于永久删除类操作，必须校验服务端永久删除口令。
    permanentDeletePassword: z.string().max(256).optional(),
    // 本人当前密码复核：会话被劫持时仅凭 Cookie 不能触发全量覆盖。
    currentPassword: z.string().max(EXISTING_PASSWORD_INPUT_MAX_LENGTH).optional(),
  })
  .strict()

const stepUpPasswordSchema = z.object({
  currentPassword: z.string().max(EXISTING_PASSWORD_INPUT_MAX_LENGTH).optional(),
})

const JSON_IMPORT_AUDIT_TARGET = {
  actionType: 'data_maintenance.import_json',
  actionLabel: '导入 JSON 数据',
  targetType: 'data_maintenance',
} as const
const jsonImportLimiter = createPermanentDeleteLimiter({ ...JSON_IMPORT_AUDIT_TARGET, storePrefix: 'data-maintenance-import-json' })

const JSON_EXPORT_AUDIT_TARGET = {
  actionType: 'data_maintenance.export_json',
  actionLabel: '导出 JSON 数据',
  targetType: 'data_maintenance',
} as const
// 导出是批量外泄与重负载入口：主防线是本人密码复核，频控用于压制反复导出（验收流程单场景至多数次）。
const jsonExportLimiter = createPermanentDeleteLimiter({
  ...JSON_EXPORT_AUDIT_TARGET,
  storePrefix: 'data-maintenance-export-json',
  windowMs: 10 * 60 * 1000,
  limit: 10,
  blockedMessage: 'JSON 导出请求过于频繁，请稍后再试',
})

/**
 * JSON 全量导入导出默认关闭：导出含全部客户个人信息与密码哈希，导入会清空多张业务表，
 * 只在迁移或运维窗口通过 `Y_LINK_JSON_DATA_TRANSFER_ENABLED=true` 临时开启；关闭时拒绝并留痕。
 */
async function assertJsonDataTransferEnabled(
  req: Request,
  target: typeof JSON_EXPORT_AUDIT_TARGET | typeof JSON_IMPORT_AUDIT_TARGET,
): Promise<void> {
  if (env.Y_LINK_JSON_DATA_TRANSFER_ENABLED) {
    return
  }
  await auditService.safeRecord({
    actionType: target.actionType,
    actionLabel: `${target.actionLabel}（未开启）`,
    targetType: target.targetType,
    targetCode: 'json_data_transfer',
    actor: (req as AuthenticatedRequest).auth,
    requestMeta: extractRequestMeta(req),
    resultStatus: 'failed',
    detail: { reason: 'disabled' },
  })
  throw new BizError('服务端未开启 JSON 全量导入导出，请在维护窗口设置 Y_LINK_JSON_DATA_TRANSFER_ENABLED=true 后重试', 403)
}

/** 救援凭证可绕开普通登录触发回退，签发必须落业务审计（凭证本身只在响应里交付，不进审计）。 */
function recordRescueCredentialIssued(req: AuthenticatedRequest, taskId: string, expiresAt: string, via: 'automatic_task' | 'manual_issue') {
  return auditService.safeRecord({
    actionType: 'database_migration.issue_rescue_credential',
    actionLabel: '签发数据库救援凭证',
    targetType: 'database_migration_task',
    targetId: taskId,
    actor: req.auth,
    requestMeta: extractRequestMeta(req),
    detail: { via, expiresAt },
  })
}

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

const createAutomaticSqliteToMysqlTaskSchema = z.object({
  target: mysqlMigrationTargetSchema.omit({ dbSync: true }).strict(),
  note: z.string().trim().max(500).optional(),
}).strict()

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

/**
 * 数据库运行能力与 Onebox 写协调器指标只对管理员开放。
 * 公开 `/health` 仅用于存活探测，不能暴露数据库类型、扩容能力或队列压力。
 */
dataMaintenanceRouter.get(
  '/database/performance',
  requirePermission('db_migration:view'),
  requireRole('admin'),
  asyncHandler(async (_req, res) => {
    const capabilities = resolveDatabaseCapabilities(AppDataSource)
    const transactionCoordinator = getTransactionCoordinator(AppDataSource)
    res.json({
      code: 0,
      message: 'ok',
      data: {
        engine: capabilities.engine,
        supportsConcurrentWriters: capabilities.supportsConcurrentWriters,
        supportsMultipleApiInstances: capabilities.supportsMultipleApiInstances,
        writeCoordinator: transactionCoordinator?.snapshot() ?? null,
        // 密码派生、验证码渲染、商品图处理等并发闸门：观察峰值与拒绝计数，判断是否需要调参或扩容。
        concurrencyGates: listConcurrencyGateSnapshots(),
      },
    })
  }),
)

dataMaintenanceRouter.post(
  '/backup/sqlite',
  requirePermission('data_maintenance:backup'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const data = await dataMaintenanceService.createSqliteBackup(authReq.auth, extractRequestMeta(req))
    res.json({ code: 0, message: 'ok', data })
  }),
)

// 导出改为 POST：请求体携带本人当前密码完成复核，密码不进入 URL 与访问日志。
dataMaintenanceRouter.post(
  '/export/json',
  requirePermission('system_configs:view'),
  requireRole('admin'),
  jsonExportLimiter,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    await assertJsonDataTransferEnabled(req, JSON_EXPORT_AUDIT_TARGET)
    const { currentPassword } = stepUpPasswordSchema.parse(req.body ?? {})
    const requestMeta = extractRequestMeta(req)
    await authService.verifyStepUpPassword(authReq.auth, currentPassword ?? '', requestMeta, JSON_EXPORT_AUDIT_TARGET.actionType)
    const data = await dataMaintenanceService.exportJson(authReq.auth, requestMeta)
    res.json({ code: 0, message: 'ok', data })
  }),
)

dataMaintenanceRouter.post(
  '/import/json',
  requirePermission('data_maintenance:import'),
  requireRole('admin'),
  jsonImportLimiter,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    await assertJsonDataTransferEnabled(req, JSON_IMPORT_AUDIT_TARGET)
    const { permanentDeletePassword, currentPassword, ...payload } = importPayloadSchema.parse(req.body)
    // 先复核本人密码、再核对永久删除口令，最后才进入清表事务：被劫持的管理员会话不能凭一次请求清空业务数据。
    await authService.verifyStepUpPassword(authReq.auth, currentPassword ?? '', extractRequestMeta(req), JSON_IMPORT_AUDIT_TARGET.actionType)
    await assertPermanentDeletePasswordForRequest(req, permanentDeletePassword, JSON_IMPORT_AUDIT_TARGET)
    const data = await dataMaintenanceService.importJson(payload as any, authReq.auth, extractRequestMeta(req))
    res.json({ code: 0, message: 'ok', data })
  }),
)

dataMaintenanceRouter.post(
  '/db-migration/automatic-tasks',
  requirePermission('db_migration:operate'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = createAutomaticSqliteToMysqlTaskSchema.parse(req.body)
    const requestMeta = extractRequestMeta(req)
    const data = await databaseMigrationService.createAutomaticSQLiteToMySqlTask(
      payload,
      authReq.auth,
      requestMeta,
    )
    const rescueCredential = isSecureOrDirectLoopback(req) ? issueDatabaseRescueCredential(data.id) : undefined
    if (rescueCredential) await recordRescueCredentialIssued(authReq, data.id, rescueCredential.expiresAt, 'automatic_task')
    res.setHeader('Cache-Control', 'no-store')
    res.status(202).json({ code: 0, message: 'accepted', data: { ...data, rescueCredential } })

    setImmediate(() => {
      void databaseMigrationService
        .runAutomaticSQLiteToMySqlTask(data.id, authReq.auth, requestMeta)
        .catch((error) => {
          const rawMessage = error instanceof Error ? error.message : String(error)
          const errorMessage = payload.target.password
            ? rawMessage.replaceAll(payload.target.password, '***')
            : rawMessage
          console.error('[database-migration] 自动迁移后台任务失败', {
            taskId: data.id,
            errorMessage,
          })
        })
    })
  }),
)

dataMaintenanceRouter.post(
  '/db-migration/tasks/:taskId/rescue-credential',
  requirePermission('db_migration:operate'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    if (!isSecureOrDirectLoopback(req)) throw new BizError('救援凭证需通过可信 HTTPS 或容器本地工具签发', 403)
    await databaseMigrationService.getSQLiteToMySqlTask(req.params.taskId)
    const data = issueDatabaseRescueCredential(req.params.taskId)
    await recordRescueCredentialIssued(req as AuthenticatedRequest, data.taskId, data.expiresAt, 'manual_issue')
    res.setHeader('Cache-Control', 'no-store')
    res.json({ code: 0, message: 'ok', data })
  }),
)

dataMaintenanceRouter.post(
  '/db-migration/precheck',
  requirePermission('db_migration:view'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const payload = sqliteToMysqlPrecheckSchema.parse(req.body)
    // 预检会用管理员提供的凭据连接任意主机，需留审计以便追溯内网探测；不记录密码。
    const recordPrecheck = (resultStatus: 'success' | 'failed', detail: Record<string, unknown> = {}) => auditService.safeRecord({
      actionType: 'database_migration.precheck',
      actionLabel: '预检 MySQL 迁移目标',
      targetType: 'database',
      targetCode: `${payload.target.host}:${payload.target.port}/${payload.target.database}`,
      actor: (req as AuthenticatedRequest).auth,
      requestMeta: extractRequestMeta(req),
      resultStatus,
      detail: { host: payload.target.host, port: payload.target.port, database: payload.target.database, user: payload.target.user, ...detail },
    })
    let data: Awaited<ReturnType<typeof databaseMigrationService.precheckSQLiteToMySql>>
    try {
      data = await databaseMigrationService.precheckSQLiteToMySql(payload)
    } catch (error) {
      await recordPrecheck('failed', { statusCode: error instanceof BizError ? error.statusCode : 500 })
      throw error
    }
    await recordPrecheck('success')
    res.json({ code: 0, message: 'ok', data })
  }),
)

dataMaintenanceRouter.get(
  '/db-migration/tasks',
  requirePermission('db_migration:view'),
  asyncHandler(async (_req, res) => {
    const data = await databaseMigrationService.listSQLiteToMySqlTasks()
    res.json({ code: 0, message: 'ok', data })
  }),
)

dataMaintenanceRouter.get(
  '/db-migration/tasks/:taskId',
  requirePermission('db_migration:view'),
  asyncHandler(async (req, res) => {
    const data = await databaseMigrationService.getSQLiteToMySqlTask(req.params.taskId)
    res.json({ code: 0, message: 'ok', data })
  }),
)

dataMaintenanceRouter.post(
  '/db-migration/tasks',
  requirePermission('db_migration:operate'),
  requireRole('admin'),
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
  requirePermission('db_migration:operate'),
  requireRole('admin'),
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
  requirePermission('db_migration:view'),
  asyncHandler(async (_req, res) => {
    const data = await databaseMigrationService.getRuntimeOverrideState()
    res.json({ code: 0, message: 'ok', data })
  }),
)

dataMaintenanceRouter.post(
  '/db-migration/switch',
  requirePermission('db_migration:operate'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = applyDatabaseSwitchSchema.parse(req.body)
    const data = await databaseMigrationService.applyDatabaseSwitch(payload, authReq.auth, extractRequestMeta(req))
    res.json({ code: 0, message: 'ok', data })
  }),
)

dataMaintenanceRouter.post(
  '/db-migration/rollback',
  requirePermission('db_migration:operate'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const payload = rollbackDatabaseSwitchSchema.parse(req.body)
    const data = await databaseMigrationService.rollbackDatabaseSwitch(payload, authReq.auth, extractRequestMeta(req))
    res.json({ code: 0, message: 'ok', data })
  }),
)

dataMaintenanceRouter.delete(
  '/db-migration/runtime-override',
  requirePermission('db_migration:operate'),
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest
    const data = await databaseMigrationService.clearRuntimeOverride(authReq.auth, extractRequestMeta(req))
    res.json({ code: 0, message: 'ok', data })
  }),
)
