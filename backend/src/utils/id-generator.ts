/**
 * 模块说明：backend/src/utils/id-generator.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { randomUUID } from 'node:crypto'
import { EntityManager } from 'typeorm'
import { BizError } from './errors.js'

/**
 * 生成系统级 UUID，用于主键外的稳定唯一标识。
 */
export function generateOrderUuid(): string {
  return randomUUID()
}

const resolveDatabaseType = (manager: EntityManager) => manager.connection.options.type

const queryLatestCode = async (
  manager: EntityManager,
  tableName: string,
  columnName: string,
  prefix: string,
): Promise<string | undefined> => {
  const databaseType = resolveDatabaseType(manager)
  const rows = await manager.query(
    databaseType === 'mysql'
      ? `
          SELECT ${columnName}
          FROM ${tableName}
          WHERE ${columnName} LIKE ?
          ORDER BY ${columnName} DESC
          LIMIT 1
          FOR UPDATE
        `
      : `
          SELECT ${columnName}
          FROM ${tableName}
          WHERE ${columnName} LIKE ?
          ORDER BY ${columnName} DESC
          LIMIT 1
        `,
    [`${prefix}%`],
  )

  const firstRow = rows?.[0] as Record<string, string> | undefined
  return firstRow?.[columnName]
}

/**
 * 生成业务展示单号：CK-YYYYMMDD-4位流水
 * - MySQL 模式优先使用 FOR UPDATE 锁住“当日最后一单”，降低并发撞号概率；
 * - SQLite 模式退化为普通查询，再由上层提交逻辑对唯一键冲突做重试兜底；
 * - show_no 不依赖自增ID，避免跨库迁移或批量导入影响编号格式。
 */
export async function generateShowNo(manager: EntityManager): Promise<string> {
  const today = new Date()
  const yyyy = today.getFullYear().toString()
  const mm = `${today.getMonth() + 1}`.padStart(2, '0')
  const dd = `${today.getDate()}`.padStart(2, '0')
  const ymd = `${yyyy}${mm}${dd}`
  const prefix = `CK-${ymd}-`
  const current = await queryLatestCode(manager, 'biz_outbound_order', 'show_no', prefix)
  const currentSeq = current ? Number.parseInt(current.slice(-4), 10) : 0
  if (Number.isNaN(currentSeq)) {
    throw new BizError('历史单号格式异常，无法继续生成新单号', 500)
  }
  if (currentSeq >= 9999) {
    throw new BizError('当日单号已达到上限，请联系管理员处理', 409)
  }
  const nextSeq = `${currentSeq + 1}`.padStart(4, '0')
  return `${prefix}${nextSeq}`
}

/**
 * 生成简洁产品编码：P-YYMMDD-4位流水
 * - 新增产品与开单自动建档共用同一规则；
 * - 与出库单号一样按天递增，便于人工识别与查找；
 * - 历史旧编码继续保留，新规则仅作用于后续自动生成场景。
 */
export async function generateProductCode(manager: EntityManager): Promise<string> {
  const today = new Date()
  const yy = today.getFullYear().toString().slice(-2)
  const mm = `${today.getMonth() + 1}`.padStart(2, '0')
  const dd = `${today.getDate()}`.padStart(2, '0')
  const prefix = `P-${yy}${mm}${dd}-`
  const current = await queryLatestCode(manager, 'base_product', 'product_code', prefix)
  const currentSeq = current ? Number.parseInt(current.slice(-4), 10) : 0

  if (Number.isNaN(currentSeq)) {
    throw new BizError('历史产品编码格式异常，无法继续生成新编码', 500)
  }
  if (currentSeq >= 9999) {
    throw new BizError('当日产品编码已达到上限，请联系管理员处理', 409)
  }

  const nextSeq = `${currentSeq + 1}`.padStart(4, '0')
  return `${prefix}${nextSeq}`
}
