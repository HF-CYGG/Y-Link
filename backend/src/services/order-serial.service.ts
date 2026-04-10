/**
 * 模块说明：backend/src/services/order-serial.service.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import type { EntityManager } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
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

  private async loadSerialConfigMap(configKeyPrefix: string, manager: EntityManager): Promise<Map<string, string>> {
    const keys = [`${configKeyPrefix}.start`, `${configKeyPrefix}.current`, `${configKeyPrefix}.width`]
    const placeholders = keys.map(() => '?').join(', ')
    const useForUpdate = manager.connection.options.type === 'mysql'
    const rows = (await manager.query(
      `
        SELECT config_key AS configKey, config_value AS configValue
        FROM system_configs
        WHERE config_key IN (${placeholders})
        ${useForUpdate ? 'FOR UPDATE' : ''}
      `,
      keys,
    )) as Array<{ configKey?: string; configValue?: string }>

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

  private normalizeOrderType(orderType: string): OrderType | null {
    if (ORDER_TYPE_VALUES.includes(orderType as OrderType)) {
      return orderType as OrderType
    }
    return null
  }
}

export const orderSerialService = new OrderSerialService()
