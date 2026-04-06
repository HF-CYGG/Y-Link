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

const entities = [
  BaseProduct,
  BaseTag,
  RelProductTag,
  BizOutboundOrder,
  BizOutboundOrderItem,
  SysUser,
  SysUserSession,
  SysAuditLog,
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
