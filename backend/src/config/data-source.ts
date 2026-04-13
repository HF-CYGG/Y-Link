/**
 * 模块说明：backend/src/config/data-source.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import 'reflect-metadata'
import { DataSource, type DataSourceOptions } from 'typeorm'
import { resolveSqliteDatabasePath } from './database-bootstrap.js'
import { env } from './env.js'
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
import { InventoryLog } from '../entities/inventory-log.entity.js'
import { BizInboundOrder } from '../entities/biz-inbound-order.entity.js'
import { BizInboundOrderItem } from '../entities/biz-inbound-order-item.entity.js'

const entities = [
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
  InventoryLog,
  BizInboundOrder,
  BizInboundOrderItem,
]

function createDataSourceOptions(): DataSourceOptions {
  const commonOptions = {
    logging: false,
    entities,
    synchronize: env.DB_SYNC ?? false,
  } satisfies Pick<DataSourceOptions, 'logging' | 'entities' | 'synchronize'>

  // 通过 DB_TYPE 切换数据库方言：
  // - sqlite：默认用于一体化部署，数据库落盘为本地文件；
  // - mysql：默认用于分体化部署，连接外置 MySQL 服务。
  if (env.DB_TYPE === 'sqlite') {
    return {
      type: 'sqlite',
      database: resolveSqliteDatabasePath(),
      ...commonOptions,
    }
  }

  return {
    type: 'mysql',
    host: env.DB_HOST,
    port: env.DB_PORT,
    username: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    ...commonOptions,
  }
}

// TypeORM 数据源统一管理，避免在各业务模块重复创建连接。
export const AppDataSource = new DataSource(createDataSourceOptions())
