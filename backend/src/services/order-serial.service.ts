/**
 * 文件说明：订单流水号服务，统一为部门单与散客单分配并发安全的展示单号。
 * 实现逻辑：
 * 1. business_sequence 每种流水只维护一行，生成时通过 MySQL 行锁或 SQLite 单写事务原子递增；
 * 2. 首次升级时才用数据库聚合校准历史最大值，正常下单不再把全部历史订单号载入 Node 内存；
 * 3. system_configs.current 继续作为管理端兼容镜像，物理删除只能按锁定游标回收连续尾号。
 */

import type { EntityManager } from 'typeorm'
import { runInTransaction } from '../config/transaction-runner.js'
import { BusinessSequence } from '../entities/business-sequence.entity.js'
import { SystemConfig } from '../entities/system-config.entity.js'
import {
  isRetryableMysqlTransactionError,
  isRetryableSqliteLockError,
} from '../utils/database-errors.js'
import { BizError } from '../utils/errors.js'

const ORDER_TYPE_VALUES = ['department', 'walkin'] as const
export type OrderType = (typeof ORDER_TYPE_VALUES)[number]

type OrderIdentifierKind = 'system' | 'preorder'

const ORDER_IDENTIFIER_RULES: Record<OrderIdentifierKind, Record<OrderType, {
  prefix: string
  configKeyPrefix: string
  sequenceKey: string
  tableName: 'biz_outbound_order' | 'o2o_preorder'
}>> = {
  system: {
    department: {
      prefix: 'OUT-D-',
      configKeyPrefix: 'order.system.department',
      sequenceKey: 'order.system.department',
      tableName: 'biz_outbound_order',
    },
    walkin: {
      prefix: 'OUT-W-',
      configKeyPrefix: 'order.system.walkin',
      sequenceKey: 'order.system.walkin',
      tableName: 'biz_outbound_order',
    },
  },
  preorder: {
    department: {
      prefix: 'PRE-D-',
      configKeyPrefix: 'o2o.preorder.department',
      sequenceKey: 'o2o.preorder.department',
      tableName: 'o2o_preorder',
    },
    walkin: {
      prefix: 'PRE-W-',
      configKeyPrefix: 'o2o.preorder.walkin',
      sequenceKey: 'o2o.preorder.walkin',
      tableName: 'o2o_preorder',
    },
  },
}

export interface IdentifierSerialRollbackResult {
  kind: OrderIdentifierKind
  orderType: OrderType
  applied: boolean
  rolledBack: boolean
  beforeCurrent: number
  current: number
  start: number
  removedSerials: number[]
}

interface SerialConfigSnapshot {
  start: number
  current: number
  width: number
  currentKey: string
}

export function resolveCompatibleIdentifierInput(input: {
  canonicalValue?: string | null
  legacyValue?: string | null
  fieldLabel: string
}): string {
  const canonicalValue = input.canonicalValue?.trim() ?? ''
  const legacyValue = input.legacyValue?.trim() ?? ''
  if (canonicalValue && legacyValue && canonicalValue !== legacyValue) {
    throw new BizError(`${input.fieldLabel} 与兼容字段 showNo 不一致`, 400)
  }
  const resolved = canonicalValue || legacyValue
  if (!resolved) throw new BizError(`请填写${input.fieldLabel}`, 400)
  return resolved
}

class OrderSerialService {
  async generateSystemNo(orderType: string, manager?: EntityManager): Promise<string> {
    return this.generateIdentifierNo('system', orderType, manager)
  }

  async generatePreorderNo(orderType: string, manager?: EntityManager): Promise<string> {
    return this.generateIdentifierNo('preorder', orderType, manager)
  }

  /**
   * 物理删除后的编号回收只比较锁定游标，不扫描表内最大值。
   * 批量输入按流水倒序处理，只有从当前游标开始连续命中的删除后缀会逐位回收；
   * 先删中间号、再删尾号时最多回退一位，绝不会跨过此前形成的缺口复用旧号。
   */
  async rollbackDeletedIdentifierBatch(
    kind: OrderIdentifierKind,
    orderType: string,
    deletedIdentifiers: string[],
    manager?: EntityManager,
  ): Promise<IdentifierSerialRollbackResult> {
    const normalizedOrderType = this.normalizeOrderType(orderType)
    if (!normalizedOrderType) throw new BizError('订单类型非法，仅支持 department 或 walkin', 400)
    if (manager) {
      return this.rollbackDeletedIdentifierBatchWithManager(kind, normalizedOrderType, deletedIdentifiers, manager)
    }
    return runInTransaction((transactionManager) => this.rollbackDeletedIdentifierBatchWithManager(
      kind,
      normalizedOrderType,
      deletedIdentifiers,
      transactionManager,
    ))
  }

  private async rollbackDeletedIdentifierBatchWithManager(
    kind: OrderIdentifierKind,
    orderType: OrderType,
    deletedIdentifiers: string[],
    manager: EntityManager,
  ): Promise<IdentifierSerialRollbackResult> {
    const rule = ORDER_IDENTIFIER_RULES[kind][orderType]
    const initialConfig = await this.loadSerialConfig(rule.configKeyPrefix, manager)
    this.assertSerialWidth(initialConfig.width)
    let sequence = await this.loadSequenceForUpdateIfPresent(rule.sequenceKey, manager)
    if (!sequence) {
      await this.ensureSequenceRow(manager, rule.sequenceKey, Math.max(initialConfig.start - 1, initialConfig.current))
      sequence = await this.loadSequenceForUpdate(rule.sequenceKey, manager)
    }
    if (!sequence) throw new BizError('订单编号序列初始化失败，请稍后重试', 500)
    const config = await this.loadSerialConfig(rule.configKeyPrefix, manager, true)
    this.assertSerialWidth(config.width)

    const beforeCurrent = Math.max(
      config.start - 1,
      config.current,
      this.parseNonNegativeInteger(String(sequence.currentValue), '订单编号序列值异常'),
    )
    const removedSerials = [...new Set(deletedIdentifiers
      .map((identifier) => this.parseSerialFromShowNo(identifier, rule.prefix))
      .filter((serial): serial is number => serial !== null))]
      .sort((left, right) => right - left)
    let current = beforeCurrent
    for (const removedSerial of removedSerials) {
      if (removedSerial === current) current = Math.max(config.start - 1, current - 1)
    }
    if (current !== beforeCurrent) {
      sequence.currentValue = current
      await manager.getRepository(BusinessSequence).save(sequence)
      await manager.getRepository(SystemConfig).update(
        { configKey: config.currentKey },
        { configValue: String(current) },
      )
    }
    return {
      kind,
      orderType,
      applied: current !== beforeCurrent,
      rolledBack: current < beforeCurrent,
      beforeCurrent,
      current,
      start: config.start,
      removedSerials,
    }
  }

  private async generateIdentifierNo(
    kind: OrderIdentifierKind,
    orderType: string,
    manager?: EntityManager,
  ): Promise<string> {
    const normalizedOrderType = this.normalizeOrderType(orderType)
    if (!normalizedOrderType) {
      throw new BizError('订单类型非法，仅支持 department 或 walkin', 400)
    }
    if (manager) {
      return this.generateIdentifierNoWithManager(kind, normalizedOrderType, manager)
    }
    let lastError: unknown
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await runInTransaction((transactionManager) =>
          this.generateIdentifierNoWithManager(kind, normalizedOrderType, transactionManager),
        )
      } catch (error) {
        lastError = error
        const retryable = isRetryableSqliteLockError(error) || isRetryableMysqlTransactionError(error)
        if (attempt < 3 && retryable) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 15 + Math.floor(Math.random() * 20)))
          continue
        }
        throw error
      }
    }
    throw lastError ?? new BizError('订单编号生成失败，请稍后重试', 500)
  }

  private async generateIdentifierNoWithManager(
    kind: OrderIdentifierKind,
    orderType: OrderType,
    manager: EntityManager,
  ): Promise<string> {
    const rule = ORDER_IDENTIFIER_RULES[kind][orderType]
    const initialConfig = await this.loadSerialConfig(rule.configKeyPrefix, manager)
    this.assertSerialWidth(initialConfig.width)
    let sequence = await this.loadSequenceForUpdateIfPresent(rule.sequenceKey, manager)
    if (!sequence) {
      const historicalMax = await this.loadIdentifierMaxSerial(rule.tableName, rule.prefix, initialConfig.width, manager)
      await this.ensureSequenceRow(
        manager,
        rule.sequenceKey,
        Math.max(initialConfig.start - 1, initialConfig.current, historicalMax),
      )
      sequence = await this.loadSequenceForUpdate(rule.sequenceKey, manager)
    }
    if (!sequence) throw new BizError('订单编号序列初始化失败，请稍后重试', 500)
    const config = await this.loadSerialConfig(rule.configKeyPrefix, manager, true)
    this.assertSerialWidth(config.width)

    const current = Math.max(
      config.start - 1,
      config.current,
      this.parseNonNegativeInteger(String(sequence.currentValue), '订单编号序列值异常'),
    )
    const maxSerial = 10 ** config.width - 1
    const nextSerial = await this.findNextAvailableIdentifierSerial(
      manager,
      rule.tableName,
      rule.prefix,
      Math.max(config.start, current + 1),
      maxSerial,
      config.width,
    )
    sequence.currentValue = nextSerial
    await manager.getRepository(BusinessSequence).save(sequence)
    await manager.getRepository(SystemConfig).update(
      { configKey: config.currentKey },
      { configValue: String(nextSerial) },
    )
    return `${rule.prefix}${String(nextSerial).padStart(config.width, '0')}`
  }

  private async loadIdentifierMaxSerial(
    tableName: 'biz_outbound_order' | 'o2o_preorder',
    prefix: string,
    width: number,
    manager: EntityManager,
  ): Promise<number> {
    const castType = manager.connection.options.type === 'mysql' ? 'UNSIGNED' : 'INTEGER'
    const rows = await manager.query(
      `SELECT MAX(CAST(SUBSTR(show_no, ?) AS ${castType})) AS maxSerial
       FROM ${tableName}
       WHERE show_no LIKE ?`,
      [prefix.length + 1, `${prefix}${'_'.repeat(width)}`],
    ) as Array<{ maxSerial?: string | number | null }>
    return Math.max(0, Number(rows[0]?.maxSerial ?? 0))
  }

  private async findNextAvailableIdentifierSerial(
    manager: EntityManager,
    tableName: 'biz_outbound_order' | 'o2o_preorder',
    prefix: string,
    startSerial: number,
    maxSerial: number,
    width: number,
  ): Promise<number> {
    for (let serial = startSerial; serial <= maxSerial; serial += 1) {
      const identifier = `${prefix}${String(serial).padStart(width, '0')}`
      const rows = await manager.query(`SELECT 1 AS occupied FROM ${tableName} WHERE show_no = ? LIMIT 1`, [identifier]) as Array<{ occupied?: number }>
      if (!rows.length) return serial
    }
    throw new BizError('订单编号已超出位宽上限，请联系管理员调整配置', 409)
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

  /**
   * MySQL 对不存在的唯一键执行 `SELECT ... FOR UPDATE` 会锁住索引间隙。
   * 两种流水首次并发初始化时，如果都先锁空隙再插入各自的键，就可能形成
   * gap-lock 转换死锁。先做一致性无关的无锁存在性判断，仅在记录确实存在时
   * 再获取行锁；缺行分支则先用幂等 INSERT 建行，随后锁定真实记录。
   */
  private async loadSequenceForUpdateIfPresent(sequenceKey: string, manager: EntityManager) {
    if (manager.connection.options.type === 'mysql') {
      const exists = await manager.getRepository(BusinessSequence).existsBy({ sequenceKey })
      if (!exists) {
        return null
      }
    }
    return this.loadSequenceForUpdate(sequenceKey, manager)
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

  private async loadSerialConfig(
    configKeyPrefix: string,
    manager: EntityManager,
    lockForUpdate = false,
  ): Promise<SerialConfigSnapshot> {
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
        ${lockForUpdate && manager.connection.options.type === 'mysql' ? 'FOR UPDATE' : ''}
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
