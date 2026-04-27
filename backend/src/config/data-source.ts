/**
 * 模块说明：backend/src/config/data-source.ts
 * 文件职责：集中定义 TypeORM 实体清单与数据库连接选项，供主应用与迁移任务复用。
 * 维护说明：若新增实体，必须同时补入 `appEntities`，否则正常运行与跨库迁移都会遗漏该表。
 */

import 'reflect-metadata'
import { DataSource, type DataSourceOptions } from 'typeorm'
import { resolveSqliteDatabasePath } from './database-bootstrap.js'
import { env } from './env.js'
import type { DatabaseRuntimeOverrideConfig } from './database-runtime-override.js'
import { BaseProduct } from '../entities/base-product.entity.js'
import { BaseTag } from '../entities/base-tag.entity.js'
import { RelProductTag } from '../entities/rel-product-tag.entity.js'
import { BizOutboundOrder } from '../entities/biz-outbound-order.entity.js'
import { BizOutboundOrderItem } from '../entities/biz-outbound-order-item.entity.js'
import { SysUser } from '../entities/sys-user.entity.js'
import { SysUserSession } from '../entities/sys-user-session.entity.js'
import { SysAuditLog } from '../entities/sys-audit-log.entity.js'
import { SystemConfig } from '../entities/system-config.entity.js'
import { ClientUser } from '../entities/client-user.entity.js'
import { ClientUserSession } from '../entities/client-user-session.entity.js'
import { O2oPreorder } from '../entities/o2o-preorder.entity.js'
import { O2oPreorderItem } from '../entities/o2o-preorder-item.entity.js'
import { O2oReturnRequest } from '../entities/o2o-return-request.entity.js'
import { O2oReturnRequestItem } from '../entities/o2o-return-request-item.entity.js'
import { InventoryLog } from '../entities/inventory-log.entity.js'
import { BizInboundOrder } from '../entities/biz-inbound-order.entity.js'
import { BizInboundOrderItem } from '../entities/biz-inbound-order-item.entity.js'

export const appEntities = [
  BaseProduct,
  BaseTag,
  RelProductTag,
  BizOutboundOrder,
  BizOutboundOrderItem,
  SysUser,
  SysUserSession,
  SysAuditLog,
  SystemConfig,
  ClientUser,
  ClientUserSession,
  O2oPreorder,
  O2oPreorderItem,
  O2oReturnRequest,
  O2oReturnRequestItem,
  InventoryLog,
  BizInboundOrder,
  BizInboundOrderItem,
]

function resolveEffectiveDatabaseConfig(
  runtimeOverride?: DatabaseRuntimeOverrideConfig,
): DatabaseRuntimeOverrideConfig {
  if (runtimeOverride) {
    return runtimeOverride
  }

  return {
    DB_TYPE: env.DB_TYPE,
    DB_HOST: env.DB_HOST,
    DB_PORT: env.DB_PORT,
    DB_USER: env.DB_USER,
    DB_PASSWORD: env.DB_PASSWORD,
    DB_NAME: env.DB_NAME,
    SQLITE_DB_PATH: env.SQLITE_DB_PATH,
    DB_SYNC: env.DB_SYNC,
  }
}

/**
 * 为应用运行态与迁移目标库统一生成连接配置：
 * - 默认读取当前 env；
 * - 迁移任务可传入独立目标库配置，避免污染全局数据源实例。
 */
export function createDataSourceOptions(runtimeOverride?: DatabaseRuntimeOverrideConfig): DataSourceOptions {
  const databaseConfig = resolveEffectiveDatabaseConfig(runtimeOverride)
  const commonOptions = {
    logging: false,
    entities: appEntities,
    synchronize: databaseConfig.DB_SYNC ?? false,
  } satisfies Pick<DataSourceOptions, 'logging' | 'entities' | 'synchronize'>

  // 通过 DB_TYPE 切换数据库方言：
  // - sqlite：默认用于一体化部署，数据库落盘为本地文件；
  // - mysql：默认用于分体化部署，连接外置 MySQL 服务。
  if (databaseConfig.DB_TYPE === 'sqlite') {
    if (!databaseConfig.SQLITE_DB_PATH) {
      throw new Error('SQLite 数据库路径缺失，无法创建数据源配置')
    }
    return {
      type: 'sqlite',
      database: resolveSqliteDatabasePath(databaseConfig.SQLITE_DB_PATH),
      ...commonOptions,
    }
  }

  if (!databaseConfig.DB_HOST || !databaseConfig.DB_PORT || !databaseConfig.DB_USER || !databaseConfig.DB_NAME) {
    throw new Error('MySQL 数据库配置缺失，无法创建数据源配置')
  }

  return {
    type: 'mysql',
    host: databaseConfig.DB_HOST,
    port: databaseConfig.DB_PORT,
    username: databaseConfig.DB_USER,
    password: databaseConfig.DB_PASSWORD ?? '',
    database: databaseConfig.DB_NAME,
    ...commonOptions,
  }
}

// TypeORM 数据源统一管理，避免在各业务模块重复创建连接。
export const AppDataSource = new DataSource(createDataSourceOptions())
