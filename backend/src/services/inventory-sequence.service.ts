/**
 * 模块说明：库存域业务编号分配（SKU 的 WC 编码、库存单据号、盘点单号），以及供其他编码体系
 *          （如 YZ 通用 SKU 编码）复用的 business_sequence 行锁原语。
 * 文件职责：基于 business_sequence 行锁在调用方事务内分配递增流水，保证并发下编号不重复。
 * 实现逻辑：
 * - 与订单流水同一套“先无锁判断存在 → 缺行幂等插入 → 再加行锁递增”流程，规避 MySQL 间隙锁死锁；
 * - 序列首次建行时由调用方提供初始值（如已有 WC 编码的最大流水号），兼容历史手工编码；
 * - SQLite 由写事务单队列串行化，不需要显式行锁；
 * - `raiseSequenceFloor` 复用同一套行锁流程，把序列当前值抬高到指定下限而不是 +1，
 *   供“导入必须保留原序号”这类场景（如 YZ 编码 Excel 导入）预占指定值后再继续走 `allocateSequenceValue`。
 * 维护重点：编号格式调整只改本文件的 format 函数，序列键前缀保持不变以免流水回退；
 *          新增复用函数时只允许追加导出，不得改变 `allocateSequenceValue` / `acquireSequenceMutex` 的既有行为。
 */

import type { EntityManager } from 'typeorm'
import { BaseProductSku } from '../entities/base-product-sku.entity.js'
import { BusinessSequence } from '../entities/business-sequence.entity.js'
import { BizError } from '../utils/errors.js'

const loadSequenceForUpdate = (manager: EntityManager, sequenceKey: string) => {
  const query = manager.getRepository(BusinessSequence)
    .createQueryBuilder('sequence')
    .where('sequence.sequenceKey = :sequenceKey', { sequenceKey })
  if (manager.connection.options.type !== 'sqlite') query.setLock('pessimistic_write')
  return query.getOne()
}

const ensureSequenceRow = async (manager: EntityManager, sequenceKey: string, currentValue: number) => {
  if (manager.connection.options.type === 'mysql') {
    await manager.query(
      `INSERT INTO business_sequence (sequence_key, current_value, created_at, updated_at)
       VALUES (?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))
       ON DUPLICATE KEY UPDATE sequence_key = sequence_key`,
      [sequenceKey, currentValue],
    )
    return
  }
  await manager.query(
    `INSERT OR IGNORE INTO business_sequence (sequence_key, current_value, created_at, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [sequenceKey, currentValue],
  )
}

export async function allocateSequenceValue(
  manager: EntityManager,
  sequenceKey: string,
  resolveInitialValue: () => Promise<number> = async () => 0,
): Promise<number> {
  let sequence = manager.connection.options.type === 'mysql'
    && !(await manager.getRepository(BusinessSequence).existsBy({ sequenceKey }))
    ? null
    : await loadSequenceForUpdate(manager, sequenceKey)
  if (!sequence) {
    await ensureSequenceRow(manager, sequenceKey, Math.max(0, await resolveInitialValue()))
    sequence = await loadSequenceForUpdate(manager, sequenceKey)
  }
  if (!sequence) throw new BizError('编号序列初始化失败，请稍后重试', 500)
  const nextValue = Number(sequence.currentValue ?? 0) + 1
  if (!Number.isSafeInteger(nextValue)) throw new BizError('编号序列已超出上限', 500)
  sequence.currentValue = nextValue
  await manager.getRepository(BusinessSequence).save(sequence)
  return nextValue
}

/**
 * 业务互斥锁：借用 business_sequence 的一行做 MySQL 行级互斥（SQLite 写事务本身已串行）。
 * 适用于“先检查再插入”且检查对象不在同一行上的场景，例如同一 SKU 不能同时进入两张未完成盘点单。
 */
export async function acquireSequenceMutex(manager: EntityManager, mutexKey: string): Promise<void> {
  if (manager.connection.options.type === 'sqlite') return
  if (!(await manager.getRepository(BusinessSequence).existsBy({ sequenceKey: mutexKey }))) {
    await ensureSequenceRow(manager, mutexKey, 0)
  }
  if (!(await loadSequenceForUpdate(manager, mutexKey))) throw new BizError('业务互斥锁初始化失败，请稍后重试', 500)
}

/**
 * 把序列当前值抬高到 minValue（取两者较大值），不做 +1 递增。
 * 用于“必须保留指定编号”的预占场景：预占后序列游标停在 minValue，
 * 后续 `allocateSequenceValue` 会从 minValue + 1 继续分配，不会重新从头分配导致撞号。
 */
export async function raiseSequenceFloor(
  manager: EntityManager,
  sequenceKey: string,
  minValue: number,
): Promise<void> {
  if (!Number.isSafeInteger(minValue) || minValue < 0) {
    throw new BizError('序列下限值非法', 500)
  }
  let sequence = manager.connection.options.type === 'mysql'
    && !(await manager.getRepository(BusinessSequence).existsBy({ sequenceKey }))
    ? null
    : await loadSequenceForUpdate(manager, sequenceKey)
  if (!sequence) {
    await ensureSequenceRow(manager, sequenceKey, minValue)
    sequence = await loadSequenceForUpdate(manager, sequenceKey)
  }
  if (!sequence) throw new BizError('编号序列初始化失败，请稍后重试', 500)
  const current = Number(sequence.currentValue ?? 0)
  if (minValue > current) {
    sequence.currentValue = minValue
    await manager.getRepository(BusinessSequence).save(sequence)
  }
}

const formatLocalDate = (date: Date) => {
  const yyyy = date.getFullYear()
  const mm = `${date.getMonth() + 1}`.padStart(2, '0')
  const dd = `${date.getDate()}`.padStart(2, '0')
  return `${yyyy}${mm}${dd}`
}

/** 库存单据号：KD20260917-0001，按自然日重新计数。 */
export async function allocateStockDocNo(manager: EntityManager, now = new Date()): Promise<string> {
  const day = formatLocalDate(now)
  const value = await allocateSequenceValue(manager, `inv_stock_doc.${day}`)
  return `KD${day}-${String(value).padStart(4, '0')}`
}

/** 盘点单号：PD20260917-01，按自然日重新计数。 */
export async function allocateStocktakeNo(manager: EntityManager, now = new Date()): Promise<string> {
  const day = formatLocalDate(now)
  const value = await allocateSequenceValue(manager, `inv_stocktake.${day}`)
  return `PD${day}-${String(value).padStart(2, '0')}`
}

/**
 * SKU 编码：WC + 两位分类编码 + 三位流水（超过 999 后自然扩展位数）。
 * 首次分配时以库内已有同前缀编码的最大流水号为起点，兼容手工录入过的 WC 编码。
 */
export async function allocateWcSkuCode(manager: EntityManager, categoryCode: string): Promise<string> {
  if (!/^\d{2}$/.test(categoryCode)) throw new BizError('分类编码必须为两位数字', 400)
  const prefix = `WC${categoryCode}`
  const pattern = new RegExp(`^${prefix}(\\d{3,})$`)
  const value = await allocateSequenceValue(manager, `sku_code.${prefix}`, async () => {
    const rows = await manager.getRepository(BaseProductSku)
      .createQueryBuilder('sku')
      .select('sku.skuCode', 'skuCode')
      .where('sku.skuCode LIKE :prefix', { prefix: `${prefix}%` })
      .getRawMany<{ skuCode: string }>()
    return rows.reduce((max, row) => {
      const matched = pattern.exec(String(row.skuCode ?? ''))
      return matched ? Math.max(max, Number(matched[1])) : max
    }, 0)
  })
  return `${prefix}${String(value).padStart(3, '0')}`
}
