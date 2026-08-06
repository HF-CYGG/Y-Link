/**
 * 模块说明：backend/src/services/data-maintenance.service.ts
 * 文件职责：负责 SQLite 备份、JSON 导入导出与高风险数据维护动作的结构校验和审计收口。
 * 实现逻辑：
 * 1. 导出侧仅允许管理员执行，并补齐回灌所需的敏感字段与导出审计。
 * 2. 导入侧在事务前完成版本、表结构、关键字段和跨表引用校验，避免“先清库后报错”。
 * 3. 对商品、客户端用户、预订单等关键表补服务层边界校验，减少只靠前端校验的风险。
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DataSource } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import { runDatabaseExclusive } from '../database/transaction-coordinator.js'
import { BaseProduct } from '../entities/base-product.entity.js'
import { ClientUser } from '../entities/client-user.entity.js'
import { InventoryLog } from '../entities/inventory-log.entity.js'
import { O2oPreorder } from '../entities/o2o-preorder.entity.js'
import { O2oPreorderItem } from '../entities/o2o-preorder-item.entity.js'
import { SystemConfig } from '../entities/system-config.entity.js'
import type { AuthUserContext } from '../types/auth.js'
import { BizError } from '../utils/errors.js'
import type { RequestMeta } from '../utils/request-meta.js'
import { auditService } from './audit.service.js'
import {
  buildImportSummary,
  cloneForExportRows,
  EXPORT_TABLE_KEYS,
  EXPORT_VERSION,
  type ExportPayload,
  type ExportRow,
  type ExportTableKey,
  type ImportSummary,
  validateExportPayload,
} from './data-maintenance.shared.js'

class DataMaintenanceService {
  /**
   * 管理员兜底校验：
   * - 路由层门禁之外，服务层再次校验角色，避免后续路由误配导致高危写操作被绕过；
   * - 拒绝时写入越权审计，保留访问者身份和请求元信息。
   */
  private async assertAdminActor(actor: AuthUserContext, requestMeta: RequestMeta | undefined, actionType: string, actionLabel: string) {
    if (actor.role === 'admin') {
      return actor
    }

    await auditService.safeRecord({
      actionType,
      actionLabel: `${actionLabel}（越权拦截）`,
      targetType: 'data_maintenance',
      targetCode: actionType,
      actor,
      requestMeta,
      resultStatus: 'failed',
      detail: {
        reason: 'role_mismatch',
        requiredRole: 'admin',
        actualRole: actor.role,
      },
    })
    throw new BizError('当前账号无权执行该操作', 403)
  }

  async createSqliteBackup(actor: AuthUserContext, requestMeta?: RequestMeta) {
    const adminActor = await this.assertAdminActor(actor, requestMeta, 'data_maintenance.backup_sqlite', '创建 SQLite 物理备份')
    if (AppDataSource.options.type !== 'sqlite') {
      throw new BizError('当前环境不是 SQLite，无法执行物理备份', 400)
    }
    const sourcePath = path.resolve(String(AppDataSource.options.database))
    const backupDir = path.resolve(process.cwd(), 'data', 'backup')
    await fs.mkdir(backupDir, { recursive: true, mode: 0o700 })
    await fs.chmod(backupDir, 0o700)
    const fileName = `y-link-backup-${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.sqlite`
    const targetPath = path.resolve(backupDir, fileName)

    // WAL 模式下已提交数据可能仍位于 `-wal` 文件，直接 copyFile 主库会产生缺行备份。
    // `VACUUM INTO` 由 SQLite 自身生成一致性快照，并与应用写队列共用独占租约。
    const quotedTargetPath = `'${targetPath.replaceAll("'", "''")}'`
    try {
      await runDatabaseExclusive(AppDataSource, async () => {
        await AppDataSource.query(`VACUUM INTO ${quotedTargetPath}`)
      })

      const backupDataSource = new DataSource({
        type: 'sqlite',
        database: targetPath,
        entities: [],
        synchronize: false,
      })
      try {
        await backupDataSource.initialize()
        const integrityRows = await backupDataSource.query('PRAGMA integrity_check') as Array<Record<string, unknown>>
        const integrityResult = String(integrityRows[0]?.integrity_check ?? '')
        if (integrityResult !== 'ok') {
          throw new Error(`SQLite 备份完整性校验失败：${integrityResult || 'unknown'}`)
        }
      } finally {
        if (backupDataSource.isInitialized) {
          await backupDataSource.destroy()
        }
      }
      await fs.chmod(targetPath, 0o600)
    } catch (error) {
      await fs.rm(targetPath, { force: true })
      throw error
    }
    await auditService.safeRecord({
      actionType: 'data_maintenance.backup_sqlite',
      actionLabel: '创建 SQLite 物理备份',
      targetType: 'data_maintenance',
      targetCode: fileName,
      actor: adminActor,
      requestMeta,
      detail: {
        sourcePath,
        fileName,
        filePath: targetPath,
      },
    })
    return {
      fileName,
      filePath: targetPath,
    }
  }

  private async loadExportRows(tableKey: ExportTableKey): Promise<ExportRow[]> {
    switch (tableKey) {
      case 'systemConfigs':
        return cloneForExportRows(
          await AppDataSource.getRepository(SystemConfig).find({
            order: { id: 'ASC' },
          }),
        )
      case 'products':
        return cloneForExportRows(
          await AppDataSource.getRepository(BaseProduct).find({
            order: { id: 'ASC' },
          }),
        )
      case 'clientUsers':
        return cloneForExportRows(
          await AppDataSource.getRepository(ClientUser)
            .createQueryBuilder('user')
            .addSelect('user.passwordHash')
            .orderBy('user.id', 'ASC')
            .getMany(),
        )
      case 'preorders':
        return cloneForExportRows(
          await AppDataSource.getRepository(O2oPreorder).find({
            order: { id: 'ASC' },
          }),
        )
      case 'preorderItems':
        return cloneForExportRows(
          await AppDataSource.getRepository(O2oPreorderItem).find({
            order: { id: 'ASC' },
          }),
        )
      case 'inventoryLogs':
        return cloneForExportRows(
          await AppDataSource.getRepository(InventoryLog).find({
            order: { id: 'ASC' },
          }),
        )
    }
  }

  async exportJson(actor: AuthUserContext, requestMeta?: RequestMeta): Promise<ExportPayload> {
    const adminActor = await this.assertAdminActor(actor, requestMeta, 'data_maintenance.export_json', '导出 JSON 数据')
    const tables = {} as ExportPayload['tables']
    for (const tableKey of EXPORT_TABLE_KEYS) {
      tables[tableKey] = await this.loadExportRows(tableKey)
    }
    const payload: ExportPayload = {
      exportedAt: new Date().toISOString(),
      version: EXPORT_VERSION,
      tables,
    }
    await auditService.safeRecord({
      actionType: 'data_maintenance.export_json',
      actionLabel: '导出 JSON 数据',
      targetType: 'data_maintenance',
      targetCode: payload.version,
      actor: adminActor,
      requestMeta,
      detail: {
        tableCounts: buildImportSummary(payload),
      },
    })
    return payload
  }

  async importJson(payload: ExportPayload, actor: AuthUserContext, requestMeta?: RequestMeta) {
    const adminActor = await this.assertAdminActor(actor, requestMeta, 'data_maintenance.import_json', '导入 JSON 数据')
    const normalizedPayload = validateExportPayload(payload)
    const importSummary: ImportSummary = buildImportSummary(normalizedPayload)
    return AppDataSource.transaction(async (manager) => {
      await manager.getRepository(InventoryLog).clear()
      await manager.getRepository(O2oPreorderItem).clear()
      await manager.getRepository(O2oPreorder).clear()
      await manager.getRepository(ClientUser).clear()
      await manager.getRepository(BaseProduct).clear()
      await manager.getRepository(SystemConfig).clear()

      if (normalizedPayload.tables.systemConfigs.length > 0) {
        await manager.getRepository(SystemConfig).insert(normalizedPayload.tables.systemConfigs)
      }
      if (normalizedPayload.tables.products.length > 0) {
        await manager.getRepository(BaseProduct).insert(normalizedPayload.tables.products)
      }
      if (normalizedPayload.tables.clientUsers.length > 0) {
        await manager.getRepository(ClientUser).insert(normalizedPayload.tables.clientUsers)
      }
      if (normalizedPayload.tables.preorders.length > 0) {
        await manager.getRepository(O2oPreorder).insert(normalizedPayload.tables.preorders)
      }
      if (normalizedPayload.tables.preorderItems.length > 0) {
        await manager.getRepository(O2oPreorderItem).insert(normalizedPayload.tables.preorderItems)
      }
      if (normalizedPayload.tables.inventoryLogs.length > 0) {
        await manager.getRepository(InventoryLog).insert(normalizedPayload.tables.inventoryLogs)
      }

      await auditService.record(
        {
          actionType: 'data_maintenance.import_json',
          actionLabel: '导入 JSON 数据',
          targetType: 'data_maintenance',
          targetCode: normalizedPayload.version,
          actor: adminActor,
          requestMeta,
          detail: {
            exportedAt: normalizedPayload.exportedAt,
            version: normalizedPayload.version,
            imported: importSummary,
          },
        },
        manager,
      )
      return {
        imported: importSummary,
      }
    })
  }
}

export const dataMaintenanceService = new DataMaintenanceService()
