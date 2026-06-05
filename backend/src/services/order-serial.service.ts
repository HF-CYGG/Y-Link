/**
 * 文件说明：该文件负责订单流水号服务，统一处理部门单与散客单的编号生成、配置读取和安全回拨。
 * 实现逻辑：
 * 1. 基于系统配置中的起始值、当前值和位宽规则，生成符合业务前缀规范的订单展示单号；
 * 2. 通过事务与重试机制降低并发写入或 SQLite 锁冲突带来的编号生成失败风险；
 * 3. 在单据被安全删除时提供受限回拨能力，避免错误回退中间号导致编号顺序失真。
 */

import type { EntityManager } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import { BizOutboundOrder } from '../entities/biz-outbound-order.entity.js'
import { O2oPreorder } from '../entities/o2o-preorder.entity.js'
import { SystemConfig } from '../entities/system-config.entity.js'
import { isRetryableSqliteLockError } from '../utils/database-errors.js'
import { BizError } from '../utils/errors.js'

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const ORDER_TYPE_VALUES = ['department', 'walkin'] as const
export type OrderType = (typeof ORDER_TYPE_VALUES)[number]

const ORDER_SERIAL_RULES: Record<OrderType, { prefix: string; configKeyPrefix: string }> = {
  department: {
    prefix: 'hyyzjd',
    configKeyPrefix: 'order.serial.department',
  },
  walkin: {
    prefix: 'hyyz',
    configKeyPrefix: 'order.serial.walkin',
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
        return await AppDataSource.transaction(async (transactionManager) =>
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

  /**
   * 安全回拨订单流水：
   * - 仅当被永久删除单据的流水号正好等于当前流水 current 时才执行回拨；
   * - 回拨后的 current 不会低于起始值减一，保证下一次生成仍符合既有规则；
   * - 未命中条件时直接返回当前值，避免删除历史中间号导致编号倒退。
   */
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
    const configMap = await this.loadSerialConfigMap(serialRule.configKeyPrefix, manager)

    const startKey = `${serialRule.configKeyPrefix}.start`
    const currentKey = `${serialRule.configKeyPrefix}.current`
    const widthKey = `${serialRule.configKeyPrefix}.width`

    const start = this.parsePositiveInteger(configMap.get(startKey), `${startKey} 配置异常`)
    const current = this.parseNonNegativeInteger(configMap.get(currentKey), `${currentKey} 配置异常`)
    const width = this.parsePositiveInteger(configMap.get(widthKey), `${widthKey} 配置异常`)

    if (width > 12) {
      throw new BizError(`${widthKey} 配置异常：位宽必须在 1 到 12 之间`, 500)
    }
    if (current < start - 1) {
      throw new BizError(`${currentKey} 配置异常：当前值不能小于起始值减一`, 500)
    }

    const nextSerial = Math.max(start, current + 1)
    const maxSerial = 10 ** width - 1
    if (nextSerial > maxSerial) {
      throw new BizError('订单流水号已超出位宽上限，请联系管理员调整配置', 409)
    }

    await manager.getRepository(SystemConfig).update({ configKey: currentKey }, { configValue: String(nextSerial) })
    return `${serialRule.prefix}${String(nextSerial).padStart(width, '0')}`
  }

  private async rollbackCurrentIfMatchesWithManager(
    orderType: OrderType,
    showNo: string,
    manager: EntityManager,
  ): Promise<OrderSerialRollbackResult> {
    const serialRule = ORDER_SERIAL_RULES[orderType]
    const configMap = await this.loadSerialConfigMap(serialRule.configKeyPrefix, manager)

    const startKey = `${serialRule.configKeyPrefix}.start`
    const currentKey = `${serialRule.configKeyPrefix}.current`
    const widthKey = `${serialRule.configKeyPrefix}.width`

    const start = this.parsePositiveInteger(configMap.get(startKey), `${startKey} 配置异常`)
    const current = this.parseNonNegativeInteger(configMap.get(currentKey), `${currentKey} 配置异常`)
    this.parsePositiveInteger(configMap.get(widthKey), `${widthKey} 配置异常`)
    const removedSerial = this.parseSerialFromShowNo(showNo, serialRule.prefix)

    if (removedSerial === null || removedSerial !== current) {
      return {
        applied: false,
        current,
        removedSerial,
      }
    }

    const nextCurrent = Math.max(start - 1, current - 1)
    await manager.getRepository(SystemConfig).update({ configKey: currentKey }, { configValue: String(nextCurrent) })

    return {
      applied: true,
      current: nextCurrent,
      removedSerial,
    }
  }

  private async recalibrateCurrentFromOccupancyWithManager(
    orderType: OrderType,
    manager: EntityManager,
  ): Promise<OrderSerialRecalibrationResult> {
    const serialRule = ORDER_SERIAL_RULES[orderType]
    const configMap = await this.loadSerialConfigMap(serialRule.configKeyPrefix, manager)
    const startKey = `${serialRule.configKeyPrefix}.start`
    const currentKey = `${serialRule.configKeyPrefix}.current`
    const start = this.parsePositiveInteger(configMap.get(startKey), `${startKey} 配置异常`)
    const beforeCurrent = this.parseNonNegativeInteger(configMap.get(currentKey), `${currentKey} 配置异常`)
    const snapshot = await this.loadOccupancySnapshotWithManager(orderType, manager)
    const current = Math.max(start - 1, snapshot.maxOccupiedSerial)
    const applied = current !== beforeCurrent

    if (applied) {
      await manager.getRepository(SystemConfig).update({ configKey: currentKey }, { configValue: String(current) })
    }

    return {
      orderType,
      applied,
      rolledBack: current < beforeCurrent,
      beforeCurrent,
      current,
      start,
      ...snapshot,
    }
  }

  private async loadOccupancySnapshotWithManager(
    orderType: OrderType,
    manager: EntityManager,
  ): Promise<OrderSerialOccupancySnapshot> {
    const serialRule = ORDER_SERIAL_RULES[orderType]
    const [outboundRows, preorderRows] = await Promise.all([
      manager
        .getRepository(BizOutboundOrder)
        .createQueryBuilder('outboundOrder')
        .select('outboundOrder.showNo', 'showNo')
        .where('outboundOrder.orderType = :orderType', { orderType })
        .getRawMany<{ showNo: string }>(),
      manager
        .getRepository(O2oPreorder)
        .createQueryBuilder('preorder')
        .select('preorder.showNo', 'showNo')
        .where('preorder.clientOrderType = :orderType', { orderType })
        .getRawMany<{ showNo: string }>(),
    ])
    const outboundMax = this.pickMaxSerialShowNo(outboundRows, serialRule.prefix)
    const preorderMax = this.pickMaxSerialShowNo(preorderRows, serialRule.prefix)

    return {
      outboundCount: outboundRows.length,
      preorderCount: preorderRows.length,
      maxOccupiedSerial: Math.max(outboundMax.maxSerial, preorderMax.maxSerial),
      latestOutboundShowNo: outboundMax.showNo,
      latestPreorderShowNo: preorderMax.showNo,
    }
  }

  private async loadSerialConfigMap(configKeyPrefix: string, manager: EntityManager): Promise<Map<string, string>> {
    const keys = [`${configKeyPrefix}.start`, `${configKeyPrefix}.current`, `${configKeyPrefix}.width`]
    const placeholders = keys.map(() => '?').join(', ')
    const useForUpdate = manager.connection.options.type === 'mysql'
    const rows: Array<{ configKey?: string; configValue?: string }> = await manager.query(
      `
        SELECT config_key AS configKey, config_value AS configValue
        FROM system_configs
        WHERE config_key IN (${placeholders})
        ${useForUpdate ? 'FOR UPDATE' : ''}
      `,
      keys,
    )

    if (rows.length !== keys.length) {
      throw new BizError('订单流水配置缺失，请联系管理员补齐配置', 500)
    }

    const configMap = new Map<string, string>()
    rows.forEach((row) => {
      const configKey = typeof row.configKey === 'string' ? row.configKey.trim() : ''
      if (!configKey) {
        return
      }
      configMap.set(configKey, typeof row.configValue === 'string' ? row.configValue.trim() : '')
    })

    if (configMap.size !== keys.length) {
      throw new BizError('订单流水配置缺失，请联系管理员补齐配置', 500)
    }

    return configMap
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

  private pickMaxSerialShowNo(rows: Array<{ showNo: string }>, prefix: string): { maxSerial: number; showNo: string | null } {
    return rows.reduce(
      (result, row) => {
        const serial = this.parseSerialFromShowNo(row.showNo, prefix)
        if (serial === null || serial <= result.maxSerial) {
          return result
        }
        return {
          maxSerial: serial,
          showNo: row.showNo,
        }
      },
      { maxSerial: 0, showNo: null as string | null },
    )
  }

  /**
   * 从展示单号中提取数值流水：
   * - 仅识别当前订单类型对应前缀的标准展示单号；
   * - 解析失败时返回 null，让上层按“不满足安全回拨条件”处理。
   */
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
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return null
    }

    return parsed
  }

  private normalizeOrderType(orderType: string): OrderType | null {
    if (ORDER_TYPE_VALUES.includes(orderType as OrderType)) {
      return orderType as OrderType
    }
    return null
  }
}

export const orderSerialService = new OrderSerialService()
