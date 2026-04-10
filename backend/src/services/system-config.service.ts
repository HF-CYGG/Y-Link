/**
 * 模块说明：backend/src/services/system-config.service.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { AppDataSource } from '../config/data-source.js'
import { SystemConfig } from '../entities/system-config.entity.js'
import type { AuthUserContext } from '../types/auth.js'
import { BizError } from '../utils/errors.js'
import type { RequestMeta } from '../utils/request-meta.js'
import { auditService } from './audit.service.js'

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const DEFAULT_SYSTEM_CONFIGS = [
  {
    configKey: 'order.serial.department.start',
    configValue: '1',
    configGroup: 'order_serial',
    remark: '部门单号起始值',
  },
  {
    configKey: 'order.serial.department.current',
    configValue: '0',
    configGroup: 'order_serial',
    remark: '部门单号当前值',
  },
  {
    configKey: 'order.serial.department.width',
    configValue: '6',
    configGroup: 'order_serial',
    remark: '部门单号位宽',
  },
  {
    configKey: 'order.serial.walkin.start',
    configValue: '1',
    configGroup: 'order_serial',
    remark: '散客单号起始值',
  },
  {
    configKey: 'order.serial.walkin.current',
    configValue: '0',
    configGroup: 'order_serial',
    remark: '散客单号当前值',
  },
  {
    configKey: 'order.serial.walkin.width',
    configValue: '6',
    configGroup: 'order_serial',
    remark: '散客单号位宽',
  },
  {
    configKey: 'o2o.auto_cancel_enabled',
    configValue: '1',
    configGroup: 'o2o',
    remark: '预订单超时自动取消开关',
  },
  {
    configKey: 'o2o.auto_cancel_hours',
    configValue: '24',
    configGroup: 'o2o',
    remark: '预订单超时自动取消时长（小时）',
  },
  {
    configKey: 'o2o.limit_enabled',
    configValue: '1',
    configGroup: 'o2o',
    remark: '预订单限购开关',
  },
  {
    configKey: 'o2o.limit_qty',
    configValue: '5',
    configGroup: 'o2o',
    remark: '预订单默认限购数量',
  },
] as const

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const ORDER_SERIAL_TYPES = ['department', 'walkin'] as const
type OrderSerialType = (typeof ORDER_SERIAL_TYPES)[number]

const ORDER_SERIAL_META: Record<OrderSerialType, { label: string; prefix: string; keyPrefix: string }> = {
  department: {
    label: '部门订单',
    prefix: 'hyyzjd',
    keyPrefix: 'order.serial.department',
  },
  walkin: {
    label: '散客订单',
    prefix: 'hyyz',
    keyPrefix: 'order.serial.walkin',
  },
}

export interface OrderSerialConfigValue {
  start: number
  current: number
  width: number
}

export interface OrderSerialConfigRecord extends OrderSerialConfigValue {
  orderType: OrderSerialType
  orderTypeLabel: string
  prefix: string
  updatedAt: Date
}

export interface UpdateOrderSerialConfigsInput {
  department: OrderSerialConfigValue
  walkin: OrderSerialConfigValue
}

export interface O2oRuleConfigRecord {
  autoCancelEnabled: boolean
  autoCancelHours: number
  limitEnabled: boolean
  limitQty: number
  updatedAt: Date
}

export interface UpdateO2oRuleConfigsInput {
  autoCancelEnabled: boolean
  autoCancelHours: number
  limitEnabled: boolean
  limitQty: number
}

class SystemConfigService {
  private readonly configRepo = AppDataSource.getRepository(SystemConfig)
  private readonly o2oConfigKeys = ['o2o.auto_cancel_enabled', 'o2o.auto_cancel_hours', 'o2o.limit_enabled', 'o2o.limit_qty'] as const

  private getOrderSerialAllKeys(): string[] {
    return ORDER_SERIAL_TYPES.flatMap((orderType) => {
      const keyPrefix = ORDER_SERIAL_META[orderType].keyPrefix
      return [`${keyPrefix}.start`, `${keyPrefix}.current`, `${keyPrefix}.width`]
    })
  }

  private parsePositiveInteger(value: string, field: string) {
    const parsed = Number.parseInt(value, 10)
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new BizError(`${field} 配置值非法`, 500)
    }
    return parsed
  }

  private parseNonNegativeInteger(value: string, field: string) {
    const parsed = Number.parseInt(value, 10)
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new BizError(`${field} 配置值非法`, 500)
    }
    return parsed
  }

  private validateInputValue(orderType: OrderSerialType, value: OrderSerialConfigValue) {
    if (!Number.isInteger(value.start) || value.start <= 0) {
      throw new BizError(`${ORDER_SERIAL_META[orderType].label}起始号必须为正整数`, 400)
    }
    if (!Number.isInteger(value.current) || value.current < 0) {
      throw new BizError(`${ORDER_SERIAL_META[orderType].label}当前号必须为非负整数`, 400)
    }
    if (!Number.isInteger(value.width) || value.width <= 0 || value.width > 12) {
      throw new BizError(`${ORDER_SERIAL_META[orderType].label}位宽必须为 1 到 12 的整数`, 400)
    }

    if (value.current < value.start - 1) {
      throw new BizError(`${ORDER_SERIAL_META[orderType].label}当前号不能小于起始号减一`, 400)
    }

    const maxValue = 10 ** value.width - 1
    if (value.start > maxValue || value.current > maxValue) {
      throw new BizError(`${ORDER_SERIAL_META[orderType].label}起始号或当前号超过位宽上限`, 400)
    }
  }

  private formatConfigRecord(
    orderType: OrderSerialType,
    configMap: Map<string, Pick<SystemConfig, 'configValue' | 'updatedAt'>>,
  ): OrderSerialConfigRecord {
    const keyPrefix = ORDER_SERIAL_META[orderType].keyPrefix
    const startKey = `${keyPrefix}.start`
    const currentKey = `${keyPrefix}.current`
    const widthKey = `${keyPrefix}.width`
    const startConfig = configMap.get(startKey)
    const currentConfig = configMap.get(currentKey)
    const widthConfig = configMap.get(widthKey)

    if (!startConfig || !currentConfig || !widthConfig) {
      throw new BizError('订单流水配置缺失，请联系管理员补齐配置', 500)
    }

    const start = this.parsePositiveInteger(startConfig.configValue, `${startKey}`)
    const current = this.parseNonNegativeInteger(currentConfig.configValue, `${currentKey}`)
    const width = this.parsePositiveInteger(widthConfig.configValue, `${widthKey}`)
    const updatedAt = [startConfig.updatedAt, currentConfig.updatedAt, widthConfig.updatedAt].sort(
      (prev, next) => next.getTime() - prev.getTime(),
    )[0]

    return {
      orderType,
      orderTypeLabel: ORDER_SERIAL_META[orderType].label,
      prefix: ORDER_SERIAL_META[orderType].prefix,
      start,
      current,
      width,
      updatedAt,
    }
  }

  async ensureDefaultConfigs(): Promise<{ insertedCount: number; totalCount: number }> {
    const existingConfigs = await this.configRepo.find({
      where: DEFAULT_SYSTEM_CONFIGS.map((config) => ({ configKey: config.configKey })),
      select: {
        configKey: true,
      },
    })
    const existingKeySet = new Set(existingConfigs.map((config) => config.configKey))
    const missingConfigs = DEFAULT_SYSTEM_CONFIGS.filter((config) => !existingKeySet.has(config.configKey))

    if (missingConfigs.length > 0) {
      await this.configRepo.insert(missingConfigs)
    }

    return {
      insertedCount: missingConfigs.length,
      totalCount: DEFAULT_SYSTEM_CONFIGS.length,
    }
  }

  async getOrderSerialConfigs(): Promise<{ list: OrderSerialConfigRecord[] }> {
    await this.ensureDefaultConfigs()

    const keys = this.getOrderSerialAllKeys()
    const rows = await this.configRepo.find({
      where: keys.map((key) => ({ configKey: key })),
      select: {
        configKey: true,
        configValue: true,
        updatedAt: true,
      },
    })

    const configMap = new Map(rows.map((row) => [row.configKey, row]))
    const list = ORDER_SERIAL_TYPES.map((orderType) => this.formatConfigRecord(orderType, configMap))
    return { list }
  }

  async updateOrderSerialConfigs(
    input: UpdateOrderSerialConfigsInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<{ list: OrderSerialConfigRecord[]; changed: boolean }> {
    this.validateInputValue('department', input.department)
    this.validateInputValue('walkin', input.walkin)
    await this.ensureDefaultConfigs()

    return AppDataSource.transaction(async (manager) => {
      const keys = this.getOrderSerialAllKeys()
      const placeholders = keys.map(() => '?').join(', ')
      const useForUpdate = manager.connection.options.type === 'mysql'
      const lockedRows = (await manager.query(
        `
          SELECT id, config_key AS configKey, config_value AS configValue, updated_at AS updatedAt
          FROM system_configs
          WHERE config_key IN (${placeholders})
          ${useForUpdate ? 'FOR UPDATE' : ''}
        `,
        keys,
      )) as Array<{ id: string; configKey: string; configValue: string; updatedAt: string }>

      if (lockedRows.length !== keys.length) {
        throw new BizError('订单流水配置缺失，请联系管理员补齐配置', 500)
      }

      const rowMap = new Map(
        lockedRows.map((row) => [
          row.configKey,
          {
            id: row.id,
            configKey: row.configKey,
            configValue: row.configValue,
            updatedAt: new Date(row.updatedAt),
          },
        ]),
      )

      const beforeList = ORDER_SERIAL_TYPES.map((orderType) => this.formatConfigRecord(orderType, rowMap))
      const targetMap = new Map<string, string>()

      ORDER_SERIAL_TYPES.forEach((orderType) => {
        const payload = input[orderType]
        const keyPrefix = ORDER_SERIAL_META[orderType].keyPrefix
        targetMap.set(`${keyPrefix}.start`, String(payload.start))
        targetMap.set(`${keyPrefix}.current`, String(payload.current))
        targetMap.set(`${keyPrefix}.width`, String(payload.width))
      })

      let changedCount = 0
      for (const [configKey, targetValue] of targetMap) {
        const currentRow = rowMap.get(configKey)
        if (!currentRow || currentRow.configValue === targetValue) {
          continue
        }

        await manager.getRepository(SystemConfig).update({ id: currentRow.id }, { configValue: targetValue })
        currentRow.configValue = targetValue
        currentRow.updatedAt = new Date()
        changedCount += 1
      }

      const afterList = ORDER_SERIAL_TYPES.map((orderType) => this.formatConfigRecord(orderType, rowMap))

      if (changedCount > 0) {
        await auditService.record(
          {
            actionType: 'system_config.update_order_serial',
            actionLabel: '更新订单流水配置',
            targetType: 'system_config',
            targetCode: 'order_serial',
            actor,
            requestMeta,
            detail: {
              before: beforeList,
              after: afterList,
            },
          },
          manager,
        )
      }

      return {
        list: afterList,
        changed: changedCount > 0,
      }
    })
  }

  async getO2oRuleConfigs(): Promise<O2oRuleConfigRecord> {
    await this.ensureDefaultConfigs()
    const rows = await this.configRepo.find({
      where: this.o2oConfigKeys.map((key) => ({ configKey: key })),
      select: {
        configKey: true,
        configValue: true,
        updatedAt: true,
      },
    })

    if (rows.length !== this.o2oConfigKeys.length) {
      throw new BizError('线上预订配置缺失，请联系管理员补齐配置', 500)
    }

    const map = new Map(rows.map((row) => [row.configKey, row]))
    const autoCancelEnabled = this.parseNonNegativeInteger(map.get('o2o.auto_cancel_enabled')!.configValue, 'o2o.auto_cancel_enabled') > 0
    const autoCancelHours = this.parsePositiveInteger(map.get('o2o.auto_cancel_hours')!.configValue, 'o2o.auto_cancel_hours')
    const limitEnabled = this.parseNonNegativeInteger(map.get('o2o.limit_enabled')!.configValue, 'o2o.limit_enabled') > 0
    const limitQty = this.parsePositiveInteger(map.get('o2o.limit_qty')!.configValue, 'o2o.limit_qty')
    const updatedAt = rows.map((row) => row.updatedAt).sort((a, b) => b.getTime() - a.getTime())[0]

    return {
      autoCancelEnabled,
      autoCancelHours,
      limitEnabled,
      limitQty,
      updatedAt,
    }
  }

  async updateO2oRuleConfigs(
    input: UpdateO2oRuleConfigsInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<{ config: O2oRuleConfigRecord; changed: boolean }> {
    if (!Number.isInteger(input.autoCancelHours) || input.autoCancelHours <= 0 || input.autoCancelHours > 168) {
      throw new BizError('超时取消时长必须为 1 到 168 小时', 400)
    }
    if (!Number.isInteger(input.limitQty) || input.limitQty <= 0 || input.limitQty > 999) {
      throw new BizError('限购数量必须为 1 到 999 的整数', 400)
    }

    await this.ensureDefaultConfigs()
    return AppDataSource.transaction(async (manager) => {
      const useForUpdate = manager.connection.options.type === 'mysql'
      const placeholders = this.o2oConfigKeys.map(() => '?').join(', ')
      const lockedRows = (await manager.query(
        `
          SELECT id, config_key AS configKey, config_value AS configValue, updated_at AS updatedAt
          FROM system_configs
          WHERE config_key IN (${placeholders})
          ${useForUpdate ? 'FOR UPDATE' : ''}
        `,
        [...this.o2oConfigKeys],
      )) as Array<{ id: string; configKey: string; configValue: string; updatedAt: string }>

      if (lockedRows.length !== this.o2oConfigKeys.length) {
        throw new BizError('线上预订配置缺失，请联系管理员补齐配置', 500)
      }

      const targetMap = new Map<string, string>([
        ['o2o.auto_cancel_enabled', input.autoCancelEnabled ? '1' : '0'],
        ['o2o.auto_cancel_hours', String(input.autoCancelHours)],
        ['o2o.limit_enabled', input.limitEnabled ? '1' : '0'],
        ['o2o.limit_qty', String(input.limitQty)],
      ])

      const before = await this.getO2oRuleConfigs()
      let changed = false
      const repo = manager.getRepository(SystemConfig)
      for (const row of lockedRows) {
        const targetValue = targetMap.get(row.configKey)
        if (!targetValue || targetValue === row.configValue) {
          continue
        }
        await repo.update({ id: row.id }, { configValue: targetValue })
        changed = true
      }

      const config = await this.getO2oRuleConfigs()

      if (changed) {
        await auditService.record(
          {
            actionType: 'system_config.update_o2o_rules',
            actionLabel: '更新线上预订规则配置',
            targetType: 'system_config',
            targetCode: 'o2o_rules',
            actor,
            requestMeta,
            detail: {
              before,
              after: config,
            },
          },
          manager,
        )
      }

      return { config, changed }
    })
  }
}

export const systemConfigService = new SystemConfigService()
