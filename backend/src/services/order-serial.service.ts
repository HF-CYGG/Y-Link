/**
 * 文件说明：订单流水号服务，统一为部门单与散客单分配并发安全的展示单号。
 * 实现逻辑：
 * 1. business_sequence 每种流水只维护一行，生成时通过 MySQL 行锁或 SQLite 单写事务原子递增；
 * 2. 首次升级时才用数据库聚合校准历史最大值，正常下单不再把全部历史订单号载入 Node 内存；
 * 3. system_configs.current 继续作为管理端兼容镜像，删除治理仍可显式触发聚合校准。
 */

import type { EntityManager } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import { BizOutboundOrder } from '../entities/biz-outbound-order.entity.js'
import { BusinessSequence } from '../entities/business-sequence.entity.js'
import { O2oPreorder } from '../entities/o2o-preorder.entity.js'
import { SystemConfig } from '../entities/system-config.entity.js'
import { isRetryableSqliteLockError } from '../utils/database-errors.js'
import { BizError } from '../utils/errors.js'

const ORDER_TYPE_VALUES = ['department', 'walkin'] as const
export type OrderType = (typeof ORDER_TYPE_VALUES)[number]

const ORDER_SERIAL_RULES: Record<OrderType, { prefix: string; configKeyPrefix: string; sequenceKey: string }> = {
  department: {
    prefix: 'hyyzjd',
    configKeyPrefix: 'order.serial.department',
    sequenceKey: 'order.serial.department',
  },
  walkin: {
    prefix: 'hyyz',
    configKeyPrefix: 'order.serial.walkin',
    sequenceKey: 'order.serial.walkin',
  },
}

export interface OrderSerialRollbackResult {
  applied: boolean
  current: number
  removedSerial: number | null
}

export interface OrderSerialRecalibrationResult {
  orderType: OrderType
  applied: boolean
  rolledBack: boolean
  beforeCurrent: number
  current: number
  start: number
  maxOccupiedSerial: number
  outboundCount: number
  preorderCount: number
  latestOutboundShowNo: string | null
  latestPreorderShowNo: string | null
}

interface OrderSerialOccupancySnapshot {
  outboundCount: number
  preorderCount: number
  maxOccupiedSerial: number
  latestOutboundShowNo: string | null
  latestPreorderShowNo: string | null
}

interface SerialConfigSnapshot {
  start: number
  current: number
  width: number
  currentKey: string
}

class OrderSerialService {
  async generateOrderNo(orderType: string, manager?: EntityManager): Promise<string> {
    const normalizedOrderType = this.normalizeOrderType(orderType)
    if (!normalizedOrderType) {
      throw new BizError('订单类型非法，仅支持 department 或 walkin', 400)
    }

    if (manager) {
      return this.generateOrderNoWithManager(normalizedOrderType, manager)
    }

    let lastError: unknown
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await AppDataSource.transaction((transactionManager) =>
          this.generateOrderNoWithManager(normalizedOrderType, transactionManager),
        )
      } catch (error) {
        lastError = error
        if (attempt < 3 && isRetryableSqliteLockError(error)) {
          continue
        }
        throw error
      }
    }

    throw lastError ?? new BizError('订单流水号生成失败，请稍后重试', 500)
  }

  async rollbackCurrentIfMatches(orderType: string, showNo: string, manager?: EntityManager): Promise<OrderSerialRollbackResult> {
    const normalizedOrderType = this.normalizeOrderType(orderType)
    if (!normalizedOrderType) {
      throw new BizError('订单类型非法，仅支持 department 或 walkin', 400)
    }

    if (manager) {
      return this.rollbackCurrentIfMatchesWithManager(normalizedOrderType, showNo, manager)
    }
    return AppDataSource.transaction((transactionManager) =>
      this.rollbackCurrentIfMatchesWithManager(normalizedOrderType, showNo, transactionManager),
    )
  }

  async recalibrateCurrentFromOccupancy(orderType: string, manager?: EntityManager): Promise<OrderSerialRecalibrationResult> {
    const normalizedOrderType = this.normalizeOrderType(orderType)
    if (!normalizedOrderType) {
      throw new BizError('订单类型非法，仅支持 department 或 walkin', 400)
    }

    if (manager) {
      return this.recalibrateCurrentFromOccupancyWithManager(normalizedOrderType, manager)
    }
    return AppDataSource.transaction((transactionManager) =>
      this.recalibrateCurrentFromOccupancyWithManager(normalizedOrderType, transactionManager),
    )
  }

  private async generateOrderNoWithManager(orderType: OrderType, manager: EntityManager): Promise<string> {
    const serialRule = ORDER_SERIAL_RULES[orderType]
    const config = await this.loadSerialConfig(serialRule.configKeyPrefix, manager)
    this.assertSerialWidth(config.width)

    let sequence = await this.loadSequenceForUpdate(serialRule.sequenceKey, manager)
    if (!sequence) {
      // 仅首次升级/首次使用时聚合历史占用；正常生成永远只读取单行 sequence。
      const occupancy = await this.loadOccupancySnapshotWithManager(orderType, manager, config.width)
      const initialCurrent = Math.max(config.start - 1, config.current, occupancy.maxOccupiedSerial)
      await this.ensureSequenceRow(manager, serialRule.sequenceKey, initialCurrent)
      sequence = await this.loadSequenceForUpdate(serialRule.sequenceKey, manager)
    }
    if (!sequence) {
      throw new BizError('订单流水序列初始化失败，请稍后重试', 500)
    }

    const sequenceCurrent = this.parseNonNegativeInteger(String(sequence.currentValue), '订单流水序列值异常')
    const effectiveCurrent = Math.max(config.start - 1, config.current, sequenceCurrent)
    const maxSerial = 10 ** config.width - 1
    const nextSerial = await this.findNextAvailableSerial(
      manager,
      serialRule.prefix,
      Math.max(config.start, effectiveCurrent + 1),
      maxSerial,
      config.width,
    )

    sequence.currentValue = nextSerial
    await manager.getRepository(BusinessSequence).save(sequence)
    await manager.getRepository(SystemConfig).update(
      { configKey: config.currentKey },
      { configValue: String(nextSerial) },
    )
    return `${serialRule.prefix}${String(nextSerial).padStart(config.width, '0')}`
  }

  private async rollbackCurrentIfMatchesWithManager(
    orderType: OrderType,
    showNo: string,
    manager: EntityManager,
  ): Promise<OrderSerialRollbackResult> {
    const serialRule = ORDER_SERIAL_RULES[orderType]
    const config = await this.loadSerialConfig(serialRule.configKeyPrefix, manager)
    this.assertSerialWidth(config.width)
    const removedSerial = this.parseSerialFromShowNo(showNo, serialRule.prefix)

    let sequence = await this.loadSequenceForUpdate(serialRule.sequenceKey, manager)
    if (!sequence) {
      const occupancy = await this.loadOccupancySnapshotWithManager(orderType, manager, config.width)
      await this.ensureSequenceRow(
        manager,
        serialRule.sequenceKey,
        Math.max(config.start - 1, config.current, occupancy.maxOccupiedSerial),
      )
      sequence = await this.loadSequenceForUpdate(serialRule.sequenceKey, manager)
    }
    if (!sequence) {
      throw new BizError('订单流水序列初始化失败，请稍后重试', 500)
    }

    const current = Math.max(
      config.current,
      this.parseNonNegativeInteger(String(sequence.currentValue), '订单流水序列值异常'),
    )
    if (removedSerial === null || removedSerial !== current) {
      return { applied: false, current, removedSerial }
    }

    const nextCurrent = Math.max(config.start - 1, current - 1)
    sequence.currentValue = nextCurrent
    await manager.getRepository(BusinessSequence).save(sequence)
    await manager.getRepository(SystemConfig).update(
      { configKey: config.currentKey },
      { configValue: String(nextCurrent) },
    )
    return { applied: true, current: nextCurrent, removedSerial }
  }

  private async recalibrateCurrentFromOccupancyWithManager(
    orderType: OrderType,
    manager: EntityManager,
  ): Promise<OrderSerialRecalibrationResult> {
    const serialRule = ORDER_SERIAL_RULES[orderType]
    const config = await this.loadSerialConfig(serialRule.configKeyPrefix, manager)
    this.assertSerialWidth(config.width)
    const existingSequence = await this.loadSequenceForUpdate(serialRule.sequenceKey, manager)
    const beforeCurrent = Math.max(
      config.current,
      existingSequence
        ? this.parseNonNegativeInteger(String(existingSequence.currentValue), '订单流水序列值异常')
        : config.start - 1,
    )
    const snapshot = await this.loadOccupancySnapshotWithManager(orderType, manager, config.width)
    const current = Math.max(config.start - 1, snapshot.maxOccupiedSerial)

    if (!existingSequence) {
      await this.ensureSequenceRow(manager, serialRule.sequenceKey, current)
    }
    const sequence = existingSequence ?? await this.loadSequenceForUpdate(serialRule.sequenceKey, manager)
    if (!sequence) {
      throw new BizError('订单流水序列初始化失败，请稍后重试', 500)
    }
    sequence.currentValue = current
    await manager.getRepository(BusinessSequence).save(sequence)
    await manager.getRepository(SystemConfig).update(
      { configKey: config.currentKey },
      { configValue: String(current) },
    )

    return {
      orderType,
      applied: current !== beforeCurrent,
      rolledBack: current < beforeCurrent,
      beforeCurrent,
      current,
      start: config.start,
      ...snapshot,
    }
  }

  private async loadSequenceForUpdate(sequenceKey: string, manager: EntityManager) {
    const query = manager.getRepository(BusinessSequence)
      .createQueryBuilder('sequence')
      .where('sequence.sequenceKey = :sequenceKey', { sequenceKey })
    if (manager.connection.options.type !== 'sqlite') {
      query.setLock('pessimistic_write')
    }
    return query.getOne()
  }

  private async ensureSequenceRow(manager: EntityManager, sequenceKey: string, currentValue: number): Promise<void> {
    if (manager.connection.options.type === 'mysql') {
      await manager.query(
        `
          INSERT INTO business_sequence (sequence_key, current_value, created_at, updated_at)
          VALUES (?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))
          ON DUPLICATE KEY UPDATE sequence_key = sequence_key
        `,
        [sequenceKey, currentValue],
      )
      return
    }
    await manager.query(
      `
        INSERT OR IGNORE INTO business_sequence (sequence_key, current_value, created_at, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `,
      [sequenceKey, currentValue],
    )
  }

  /** 精确检查候选号是否已被异常导入数据占用；命中唯一索引，不扫描历史表。 */
  private async findNextAvailableSerial(
    manager: EntityManager,
    prefix: string,
    startSerial: number,
    maxSerial: number,
    width: number,
  ): Promise<number> {
    for (let serial = startSerial; serial <= maxSerial; serial += 1) {
      const showNo = `${prefix}${String(serial).padStart(width, '0')}`
      const rows = await manager.query(
        `
          SELECT 1 AS occupied FROM biz_outbound_order WHERE show_no = ?
          UNION ALL
          SELECT 1 AS occupied FROM o2o_preorder WHERE show_no = ?
          LIMIT 1
        `,
        [showNo, showNo],
      ) as Array<{ occupied?: number }>
      if (!rows.length) {
        return serial
      }
    }
    throw new BizError('订单流水号已超出位宽上限，请联系管理员调整配置', 409)
  }

  /**
   * 历史聚合只返回 count/max 两行摘要，不再把全部 showNo 传回 Node。
   * 该方法只用于序列表首次领养旧库，以及管理员永久删除后的显式重校准。
   */
  private async loadOccupancySnapshotWithManager(
    orderType: OrderType,
    manager: EntityManager,
    width: number,
  ): Promise<OrderSerialOccupancySnapshot> {
    const serialRule = ORDER_SERIAL_RULES[orderType]
    const castType = manager.connection.options.type === 'mysql' ? 'UNSIGNED' : 'INTEGER'
    const serialStart = serialRule.prefix.length + 1
    const outboundRow = await manager.getRepository(BizOutboundOrder)
      .createQueryBuilder('outboundOrder')
      .select('COUNT(1)', 'totalCount')
      .addSelect(`MAX(CAST(SUBSTR(outboundOrder.showNo, ${serialStart}) AS ${castType}))`, 'maxSerial')
      .where('outboundOrder.orderType = :orderType', { orderType })
      .andWhere('outboundOrder.showNo LIKE :showNoPrefix', { showNoPrefix: `${serialRule.prefix}%` })
      .getRawOne<{ totalCount: string | number | null; maxSerial: string | number | null }>()
    const preorderRow = await manager.getRepository(O2oPreorder)
      .createQueryBuilder('preorder')
      .select('COUNT(1)', 'totalCount')
      .addSelect(`MAX(CAST(SUBSTR(preorder.showNo, ${serialStart}) AS ${castType}))`, 'maxSerial')
      .where('preorder.clientOrderType = :orderType', { orderType })
      .andWhere('preorder.showNo LIKE :showNoPrefix', { showNoPrefix: `${serialRule.prefix}%` })
      .getRawOne<{ totalCount: string | number | null; maxSerial: string | number | null }>()

    const outboundCount = Math.max(0, Number(outboundRow?.totalCount ?? 0))
    const preorderCount = Math.max(0, Number(preorderRow?.totalCount ?? 0))
    const outboundMaxSerial = Math.max(0, Number(outboundRow?.maxSerial ?? 0))
    const preorderMaxSerial = Math.max(0, Number(preorderRow?.maxSerial ?? 0))
    return {
      outboundCount,
      preorderCount,
      maxOccupiedSerial: Math.max(outboundMaxSerial, preorderMaxSerial),
      latestOutboundShowNo: outboundMaxSerial > 0
        ? `${serialRule.prefix}${String(outboundMaxSerial).padStart(width, '0')}`
        : null,
      latestPreorderShowNo: preorderMaxSerial > 0
        ? `${serialRule.prefix}${String(preorderMaxSerial).padStart(width, '0')}`
        : null,
    }
  }

  private async loadSerialConfig(configKeyPrefix: string, manager: EntityManager): Promise<SerialConfigSnapshot> {
    const startKey = `${configKeyPrefix}.start`
    const currentKey = `${configKeyPrefix}.current`
    const widthKey = `${configKeyPrefix}.width`
    const keys = [startKey, currentKey, widthKey]
    const placeholders = keys.map(() => '?').join(', ')
    const rows: Array<{ configKey?: string; configValue?: string }> = await manager.query(
      `
        SELECT config_key AS configKey, config_value AS configValue
        FROM system_configs
        WHERE config_key IN (${placeholders})
        ${manager.connection.options.type === 'mysql' ? 'FOR UPDATE' : ''}
      `,
      keys,
    )
    if (rows.length !== keys.length) {
      throw new BizError('订单流水配置缺失，请联系管理员补齐配置', 500)
    }
    const configMap = new Map(rows.map((row) => [row.configKey?.trim() ?? '', row.configValue?.trim() ?? '']))
    if (configMap.size !== keys.length) {
      throw new BizError('订单流水配置缺失，请联系管理员补齐配置', 500)
    }
    const start = this.parsePositiveInteger(configMap.get(startKey), `${startKey} 配置异常`)
    const current = this.parseNonNegativeInteger(configMap.get(currentKey), `${currentKey} 配置异常`)
    const width = this.parsePositiveInteger(configMap.get(widthKey), `${widthKey} 配置异常`)
    if (current < start - 1) {
      throw new BizError(`${currentKey} 配置异常：当前值不能小于起始值减一`, 500)
    }
    return { start, current, width, currentKey }
  }

  private assertSerialWidth(width: number): void {
    if (width > 12) {
      throw new BizError('订单流水位宽配置异常：位宽必须在 1 到 12 之间', 500)
    }
  }

  private parsePositiveInteger(value: string | undefined, errorMessage: string): number {
    const parsed = Number.parseInt(value ?? '', 10)
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new BizError(errorMessage, 500)
    }
    return parsed
  }

  private parseNonNegativeInteger(value: string | undefined, errorMessage: string): number {
    const parsed = Number.parseInt(value ?? '', 10)
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new BizError(errorMessage, 500)
    }
    return parsed
  }

  private parseSerialFromShowNo(showNo: string, prefix: string): number | null {
    const normalizedShowNo = showNo.trim()
    if (!normalizedShowNo.startsWith(prefix)) {
      return null
    }
    const serialText = normalizedShowNo.slice(prefix.length)
    if (!/^\d+$/.test(serialText)) {
      return null
    }
    const parsed = Number.parseInt(serialText, 10)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null
  }

  private normalizeOrderType(orderType: string): OrderType | null {
    return ORDER_TYPE_VALUES.includes(orderType as OrderType) ? orderType as OrderType : null
  }
}

export const orderSerialService = new OrderSerialService()
