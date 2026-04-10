/**
 * 模块说明：backend/src/entities/entity-column-options.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
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
