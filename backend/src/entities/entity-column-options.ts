/**
 * 文件说明：实体列配置工具，统一封装 MySQL 与 SQLite 两种方言下主键、外键、时间和布尔字段的列定义。
 * 实现逻辑：根据当前数据库类型生成可复用的 TypeORM 列选项，避免各实体重复分支判断并保持迁移结构一致。
 * 维护重点：新增数据库方言或修改字段类型时，需要同步核对初始化 SQL、迁移脚本以及现有实体的列兼容性。
 */

import { env } from '../config/env.js'

// 统一维护实体字段在不同数据库方言下的列类型，避免在每个实体里重复判断。
const isSqlite = env.DB_TYPE === 'sqlite'

/**
 * 主键/外键在 MySQL 中保持与初始化 SQL 一致的 bigint unsigned，
 * 在 SQLite 中退化为 integer，确保自增主键与外键关系可正常工作。
 */
export const entityColumnOptions = {
  isSqlite,
  primaryId: isSqlite
    ? ({
        type: 'integer' as const,
      })
    : ({
        type: 'bigint' as const,
        unsigned: true,
      }),
  foreignId: isSqlite
    ? ({
        type: 'integer' as const,
      })
    : ({
        type: 'bigint' as const,
        unsigned: true,
      }),
  booleanFlag: isSqlite
    ? ({
        type: 'integer' as const,
        default: 1,
      })
    : ({
        type: 'tinyint' as const,
        width: 1,
        default: () => '1',
      }),
  timestamp: isSqlite
    ? ({
        type: 'datetime' as const,
      })
    : ({
        type: 'datetime' as const,
        precision: 6,
      }),
  uuid: isSqlite
    ? ({
        type: 'varchar' as const,
      })
    : ({
        type: 'char' as const,
      }),
}
