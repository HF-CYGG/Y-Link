/**
 * 模块说明：backend/src/services/data-maintenance.service.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { AppDataSource } from '../config/data-source.js'
import { resolveSqliteDatabasePath } from '../config/database-bootstrap.js'
import { env } from '../config/env.js'
import { BaseProduct } from '../entities/base-product.entity.js'
import { ClientUser } from '../entities/client-user.entity.js'
import { InventoryLog } from '../entities/inventory-log.entity.js'
import { O2oPreorder } from '../entities/o2o-preorder.entity.js'
import { O2oPreorderItem } from '../entities/o2o-preorder-item.entity.js'
import { SystemConfig } from '../entities/system-config.entity.js'
import { BizError } from '../utils/errors.js'

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const EXPORT_ENTITY_MAP = {
  systemConfigs: SystemConfig,
  products: BaseProduct,
  clientUsers: ClientUser,
  preorders: O2oPreorder,
  preorderItems: O2oPreorderItem,
  inventoryLogs: InventoryLog,
}

type ExportPayload = {
  exportedAt: string
  version: string
  tables: Record<string, Record<string, unknown>[]>
}

class DataMaintenanceService {
  async createSqliteBackup() {
    if (env.DB_TYPE !== 'sqlite') {
      throw new BizError('当前环境不是 SQLite，无法执行物理备份', 400)
    }
    const sourcePath = resolveSqliteDatabasePath()
    const backupDir = path.resolve(process.cwd(), 'data', 'backup')
    await fs.mkdir(backupDir, { recursive: true })
    const fileName = `y-link-backup-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.sqlite`
    const targetPath = path.resolve(backupDir, fileName)
    await fs.copyFile(sourcePath, targetPath)
    return {
      fileName,
      filePath: targetPath,
    }
  }

  async exportJson(): Promise<ExportPayload> {
    const tables = {} as ExportPayload['tables']
    for (const [key, entity] of Object.entries(EXPORT_ENTITY_MAP) as Array<
      [keyof typeof EXPORT_ENTITY_MAP, (typeof EXPORT_ENTITY_MAP)[keyof typeof EXPORT_ENTITY_MAP]]
    >) {
      const rows = await AppDataSource.getRepository(entity).find()
      tables[key] = rows.map((item) => JSON.parse(JSON.stringify(item)))
    }
    return {
      exportedAt: new Date().toISOString(),
      version: 'o2o-preorder-v1',
      tables,
    }
  }

  async importJson(payload: ExportPayload) {
    if (!payload?.tables) {
      throw new BizError('导入数据格式错误', 400)
    }
    return AppDataSource.transaction(async (manager) => {
      await manager.getRepository(InventoryLog).clear()
      await manager.getRepository(O2oPreorderItem).clear()
      await manager.getRepository(O2oPreorder).clear()
      await manager.getRepository(ClientUser).clear()
      await manager.getRepository(BaseProduct).clear()
      await manager.getRepository(SystemConfig).clear()

      const configRows = payload.tables.systemConfigs ?? []
      if (configRows.length) {
        await manager.getRepository(SystemConfig).insert(configRows as any)
      }
      const productRows = payload.tables.products ?? []
      if (productRows.length) {
        await manager.getRepository(BaseProduct).insert(productRows as any)
      }
      const clientRows = payload.tables.clientUsers ?? []
      if (clientRows.length) {
        await manager.getRepository(ClientUser).insert(clientRows as any)
      }
      const preorderRows = payload.tables.preorders ?? []
      if (preorderRows.length) {
        await manager.getRepository(O2oPreorder).insert(preorderRows as any)
      }
      const preorderItemRows = payload.tables.preorderItems ?? []
      if (preorderItemRows.length) {
        await manager.getRepository(O2oPreorderItem).insert(preorderItemRows as any)
      }
      const inventoryLogRows = payload.tables.inventoryLogs ?? []
      if (inventoryLogRows.length) {
        await manager.getRepository(InventoryLog).insert(inventoryLogRows as any)
      }
      return {
        imported: {
          systemConfigs: configRows.length,
          products: productRows.length,
          clientUsers: clientRows.length,
          preorders: preorderRows.length,
          preorderItems: preorderItemRows.length,
          inventoryLogs: inventoryLogRows.length,
        },
      }
    })
  }
}

export const dataMaintenanceService = new DataMaintenanceService()
