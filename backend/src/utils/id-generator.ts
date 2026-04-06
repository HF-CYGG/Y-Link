import { randomUUID } from 'node:crypto'
import { EntityManager } from 'typeorm'
import { BizError } from './errors.js'

/**
 * 生成系统级 UUID，用于主键外的稳定唯一标识。
 */
export function generateOrderUuid(): string {
  return randomUUID()
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
  const databaseType = manager.connection.options.type

  // MySQL 支持 FOR UPDATE，可在事务中锁住当日最后一条记录。
  // SQLite 不支持该语法，因此改为普通查询并交由上层重试机制兜底。
  const rows = await manager.query(
    databaseType === 'mysql'
      ? `
          SELECT show_no
          FROM biz_outbound_order
          WHERE show_no LIKE ?
          ORDER BY show_no DESC
          LIMIT 1
          FOR UPDATE
        `
      : `
          SELECT show_no
          FROM biz_outbound_order
          WHERE show_no LIKE ?
          ORDER BY show_no DESC
          LIMIT 1
        `,
    [`${prefix}%`],
  )

  const current = rows?.[0]?.show_no as string | undefined
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
