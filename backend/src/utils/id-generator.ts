/**
 * 模块说明：`backend/src/utils/id-generator.ts`
 * 文件职责：封装业务侧常用的唯一标识与展示编码生成逻辑，覆盖 UUID、出库单号和产品编码三类场景。
 * 实现逻辑：
 * 1. 使用 `randomUUID` 生成跨模块可复用的稳定唯一标识；
 * 2. 结合数据库事务与当日最新编码查询，生成按日期递增的出库单号和产品编码；
 * 3. 对历史格式异常、当日流水超限和潜在 SQL 注入入口统一做显式校验与报错。
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
  // 增加标识符正则校验，防范潜在的内部方法滥用导致的 SQL 注入风险
  if (!/^\w+$/.test(tableName) || !/^\w+$/.test(columnName)) {
    throw new BizError('表名或列名不合法，存在注入风险', 500)
  }

  const databaseType = resolveDatabaseType(manager)
  const rows = await manager.query(
    databaseType === 'mysql'
      ? `
          SELECT \`${columnName}\`
          FROM \`${tableName}\`
          WHERE \`${columnName}\` LIKE ?
          ORDER BY \`${columnName}\` DESC
          LIMIT 1
          FOR UPDATE
        `
      : `
          SELECT "${columnName}"
          FROM "${tableName}"
          WHERE "${columnName}" LIKE ?
          ORDER BY "${columnName}" DESC
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
 * - 同时比较 `legacy_product_code`：存量商品升级到 YZ 编码后，旧 productCode 会从 product_code 列
 *   消失、转存到 legacy_product_code。若只看 product_code 的当日最大值，腾出的流水号会被当天新建
 *   的商品重新分配到，其默认 SKU 码可能与该历史编码撞成同一字符串，引发扫码歧义（见 P1-A 修复说明）。
 *   取两列当日最大流水号中的较大者，从根源上避免流水号被重新分配。
 */
export async function generateProductCode(manager: EntityManager): Promise<string> {
  const today = new Date()
  const yy = today.getFullYear().toString().slice(-2)
  const mm = `${today.getMonth() + 1}`.padStart(2, '0')
  const dd = `${today.getDate()}`.padStart(2, '0')
  const prefix = `P-${yy}${mm}${dd}-`
  // 同一事务连接上顺序查询两列，不用 Promise.all 并发发起——避免个别数据库驱动在同一连接上
  // 并发执行多条 FOR UPDATE 查询时的排队/顺序问题。
  const current = await queryLatestCode(manager, 'base_product', 'product_code', prefix)
  const legacyCurrent = await queryLatestCode(manager, 'base_product', 'legacy_product_code', prefix)
  const currentSeq = current ? Number.parseInt(current.slice(-4), 10) : 0
  const legacySeq = legacyCurrent ? Number.parseInt(legacyCurrent.slice(-4), 10) : 0

  if (Number.isNaN(currentSeq) || Number.isNaN(legacySeq)) {
    throw new BizError('历史产品编码格式异常，无法继续生成新编码', 500)
  }
  const maxSeq = Math.max(currentSeq, legacySeq)
  if (maxSeq >= 9999) {
    throw new BizError('当日产品编码已达到上限，请联系管理员处理', 409)
  }

  const nextSeq = `${maxSeq + 1}`.padStart(4, '0')
  return `${prefix}${nextSeq}`
}
