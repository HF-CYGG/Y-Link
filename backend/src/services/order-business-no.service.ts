/**
 * 模块说明：订单独立业务号服务。
 * 文件职责：维护 hyyzjd/hyyz 两个永久占用命名空间，并在事务中严格按 cursor + 1 分配新号。
 * 实现逻辑：游标复用 business_sequence 的独立 key，号码占用写入不可删除表；冲突一律 409，禁止扫描跳号。
 */

import type { EntityManager } from 'typeorm'
import { BusinessSequence } from '../entities/business-sequence.entity.js'
import { OrderBusinessNoOccupancy } from '../entities/order-business-no-occupancy.entity.js'
import { SystemConfig } from '../entities/system-config.entity.js'
import { isUniqueConstraintError } from '../utils/database-errors.js'
import { BizError } from '../utils/errors.js'
import type { OrderType } from './order-serial.service.js'

const BUSINESS_NO_RULES: Record<OrderType, {
  namespace: 'hyyzjd' | 'hyyz'
  sequenceKey: string
  configKeyPrefix: string
}> = {
  department: {
    namespace: 'hyyzjd',
    sequenceKey: 'order.business.department',
    configKeyPrefix: 'order.serial.department',
  },
  walkin: {
    namespace: 'hyyz',
    sequenceKey: 'order.business.walkin',
    configKeyPrefix: 'order.serial.walkin',
  },
}

const BUSINESS_NO_UNIQUE_MATCHER = {
  mysqlConstraints: [
    'uk_order_business_no_occupancy_business_no',
    'uk_order_business_no_occupancy_namespace_serial',
    'uk_biz_outbound_business_no',
  ],
  sqliteColumns: [
    'order_business_no_occupancy.business_no',
    'order_business_no_occupancy.business_namespace, order_business_no_occupancy.serial_value',
    'biz_outbound_order.business_no',
  ],
} as const

interface BusinessNoConfig {
  start: number
  width: number
}

export interface ParsedBusinessNo {
  orderType: OrderType
  namespace: 'hyyzjd' | 'hyyz'
  serialValue: number
  businessNo: string
}

export interface BusinessNoCursorPlan {
  namespace: 'hyyzjd' | 'hyyz'
  beforeCursor: number
  afterCursor: number
  nextBusinessNo: string | null
}

export interface BusinessNoSuggestion {
  orderType: OrderType
  namespace: 'hyyzjd' | 'hyyz'
  cursor: number
  businessNos: string[]
  skippedBusinessNos: string[]
}

/** 建议号每批按区间查询占用表，并限制最大扫描跨度，避免异常占用数据导致长时间扫描。 */
const SUGGESTION_WINDOW_SIZE = 200
const SUGGESTION_SCAN_LIMIT = 5000

export interface BusinessNoReservationTarget {
  parsed: ParsedBusinessNo
  orderUuid: string
  reason: string | null
}

export class OrderBusinessNoService {
  async allocate(orderType: OrderType, orderUuid: string, manager: EntityManager): Promise<string> {
    const rule = BUSINESS_NO_RULES[orderType]
    const config = await this.loadConfig(rule.configKeyPrefix, manager)
    const sequence = await this.loadOrCreateSequence(rule.sequenceKey, config.start - 1, manager)
    const current = this.parseNonNegativeInteger(sequence.currentValue, '订单业务号游标异常')
    const next = current + 1
    const maxSerial = 10 ** config.width - 1
    if (next < config.start || next > maxSerial) {
      throw new BizError('订单业务号已超出位宽上限，请联系管理员处理', 409)
    }

    const businessNo = `${rule.namespace}${String(next).padStart(config.width, '0')}`
    await this.insertOccupancy({
      namespace: rule.namespace,
      serialValue: next,
      businessNo,
      orderUuid,
      assignedReason: 'order_create',
    }, manager)
    sequence.currentValue = next
    await manager.getRepository(BusinessSequence).save(sequence)
    return businessNo
  }

  async reserveConfirmed(
    businessNo: string,
    orderType: OrderType,
    orderUuid: string,
    reason: string | null,
    manager: EntityManager,
  ): Promise<ParsedBusinessNo> {
    const parsed = await this.parseForOrderType(businessNo, orderType, manager)
    await this.reserveConfirmedBatch([{ parsed, orderUuid, reason }], manager)
    return parsed
  }

  /**
   * 批量重编按命名空间键和流水升序锁游标、占号，避免请求顺序决定游标或形成跨命名空间死锁。
   * 每个命名空间最终游标固定为本批最大确认号，下一单仍严格 cursor + 1。
   */
  async reserveConfirmedBatch(
    targets: BusinessNoReservationTarget[],
    manager: EntityManager,
  ): Promise<BusinessNoCursorPlan[]> {
    const grouped = this.groupTargets(targets)
    const plans: BusinessNoCursorPlan[] = []
    for (const [namespace, namespaceTargets] of grouped) {
      const orderType = namespace === 'hyyzjd' ? 'department' : 'walkin'
      const rule = BUSINESS_NO_RULES[orderType]
      const config = await this.loadConfig(rule.configKeyPrefix, manager)
      const sequence = await this.loadOrCreateSequence(rule.sequenceKey, config.start - 1, manager)
      const beforeCursor = this.parseNonNegativeInteger(sequence.currentValue, '订单业务号游标异常')
      const sortedTargets = [...namespaceTargets].sort((left, right) =>
        left.parsed.serialValue - right.parsed.serialValue
        || left.orderUuid.localeCompare(right.orderUuid),
      )
      for (const target of sortedTargets) {
        await this.insertOccupancy({
          namespace,
          serialValue: target.parsed.serialValue,
          businessNo: target.parsed.businessNo,
          orderUuid: target.orderUuid,
          assignedReason: target.reason
            ? `order_amendment:${target.reason}`.slice(0, 128)
            : 'order_amendment',
        }, manager)
      }
      const afterCursor = sortedTargets.at(-1)?.parsed.serialValue ?? beforeCursor
      sequence.currentValue = afterCursor
      await manager.getRepository(BusinessSequence).save(sequence)
      plans.push(this.buildCursorPlan(namespace, beforeCursor, afterCursor, config.width))
    }
    return plans
  }

  async previewCursorPlans(parsedNumbers: ParsedBusinessNo[], manager: EntityManager): Promise<BusinessNoCursorPlan[]> {
    const grouped = this.groupTargets(parsedNumbers.map((parsed) => ({
      parsed,
      orderUuid: '',
      reason: null,
    })))
    const plans: BusinessNoCursorPlan[] = []
    for (const [namespace, namespaceTargets] of grouped) {
      const orderType = namespace === 'hyyzjd' ? 'department' : 'walkin'
      const rule = BUSINESS_NO_RULES[orderType]
      const config = await this.loadConfig(rule.configKeyPrefix, manager)
      const beforeCursor = await this.readCursorWithoutLock(orderType, config, manager)
      const afterCursor = Math.max(...namespaceTargets.map((target) => target.parsed.serialValue))
      plans.push(this.buildCursorPlan(namespace, beforeCursor, afterCursor, config.width))
    }
    return plans
  }

  /**
   * 修订弹窗切换订单类型时的业务号建议：只读游标与占用表，不加锁、不占号、不推进游标。
   * 从 cursor + 1 起顺延，跳过已永久占用号与调用方排除号（同批其他草稿），结果仅作为可手改的默认值；
   * 最终是否可用仍以预览/提交时的事务内校验为准，因此这里的跳过不改变新单分配“禁止扫描跳号”的约束。
   */
  async suggestForAmendment(
    orderType: OrderType,
    count: number,
    excludeBusinessNos: string[],
    manager: EntityManager,
  ): Promise<BusinessNoSuggestion> {
    const rule = BUSINESS_NO_RULES[orderType]
    const config = await this.loadConfig(rule.configKeyPrefix, manager)
    const cursor = await this.readCursorWithoutLock(orderType, config, manager)
    const maxSerial = 10 ** config.width - 1
    const excluded = new Set(excludeBusinessNos.map((value) => value.trim().toLowerCase()).filter(Boolean))
    const businessNos: string[] = []
    const skippedBusinessNos: string[] = []
    const formatSerial = (serial: number) => `${rule.namespace}${String(serial).padStart(config.width, '0')}`

    let windowStart = Math.max(cursor + 1, config.start)
    while (businessNos.length < count && windowStart <= maxSerial) {
      if (windowStart - cursor > SUGGESTION_SCAN_LIMIT) {
        throw new BizError(`业务号游标之后连续 ${SUGGESTION_SCAN_LIMIT} 个号均不可用，请手动填写业务单号`, 409)
      }
      const windowEnd = Math.min(maxSerial, windowStart + SUGGESTION_WINDOW_SIZE - 1)
      const occupiedRows = await manager.getRepository(OrderBusinessNoOccupancy)
        .createQueryBuilder('occupancy')
        .select('occupancy.serialValue', 'serialValue')
        .where('occupancy.namespace = :namespace', { namespace: rule.namespace })
        .andWhere('occupancy.serialValue BETWEEN :windowStart AND :windowEnd', { windowStart, windowEnd })
        .getRawMany<{ serialValue: string | number }>()
      const occupied = new Set(occupiedRows.map((row) => Number(row.serialValue)))
      for (let serial = windowStart; serial <= windowEnd && businessNos.length < count; serial += 1) {
        const businessNo = formatSerial(serial)
        if (occupied.has(serial)) {
          skippedBusinessNos.push(businessNo)
        } else if (!excluded.has(businessNo)) {
          businessNos.push(businessNo)
        }
      }
      windowStart = windowEnd + 1
    }

    return {
      orderType,
      namespace: rule.namespace,
      cursor,
      businessNos,
      skippedBusinessNos,
    }
  }

  async inspectConfirmed(
    businessNo: string,
    orderType: OrderType,
    manager: EntityManager,
  ): Promise<{ parsed: ParsedBusinessNo | null; blockingReason: string | null }> {
    let parsed: ParsedBusinessNo
    try {
      parsed = await this.parseForOrderType(businessNo, orderType, manager)
    } catch (error) {
      return {
        parsed: null,
        blockingReason: error instanceof Error ? error.message : '业务号格式非法',
      }
    }
    const occupied = await manager.getRepository(OrderBusinessNoOccupancy).existsBy({ businessNo: parsed.businessNo })
    return occupied
      ? { parsed, blockingReason: `业务号 ${parsed.businessNo} 已被永久占用` }
      : { parsed, blockingReason: null }
  }

  async parseForOrderType(businessNo: string, orderType: OrderType, manager: EntityManager): Promise<ParsedBusinessNo> {
    const normalizedBusinessNo = businessNo.trim().toLowerCase()
    const rule = BUSINESS_NO_RULES[orderType]
    const config = await this.loadConfig(rule.configKeyPrefix, manager)
    const pattern = new RegExp(`^${rule.namespace}\\d{${config.width}}$`)
    if (!pattern.test(normalizedBusinessNo)) {
      throw new BizError(`业务号格式或命名空间不匹配，应为 ${rule.namespace} 加 ${config.width} 位数字`, 409)
    }
    const serialValue = Number.parseInt(normalizedBusinessNo.slice(rule.namespace.length), 10)
    if (!Number.isSafeInteger(serialValue) || serialValue < config.start) {
      throw new BizError('业务号流水值非法', 409)
    }
    return { orderType, namespace: rule.namespace, serialValue, businessNo: normalizedBusinessNo }
  }

  private async insertOccupancy(
    input: Pick<OrderBusinessNoOccupancy, 'namespace' | 'serialValue' | 'businessNo' | 'orderUuid' | 'assignedReason'>,
    manager: EntityManager,
  ): Promise<void> {
    const repository = manager.getRepository(OrderBusinessNoOccupancy)
    try {
      await repository.insert(repository.create(input))
    } catch (error) {
      if (isUniqueConstraintError(error, BUSINESS_NO_UNIQUE_MATCHER)) {
        throw new BizError(`业务号 ${input.businessNo} 已被永久占用`, 409)
      }
      throw error
    }
  }

  private async loadConfig(configKeyPrefix: string, manager: EntityManager): Promise<BusinessNoConfig> {
    const startKey = `${configKeyPrefix}.start`
    const widthKey = `${configKeyPrefix}.width`
    const rows = await manager.getRepository(SystemConfig).findBy([
      { configKey: startKey },
      { configKey: widthKey },
    ])
    const configMap = new Map(rows.map((row) => [row.configKey, row.configValue]))
    const start = this.parsePositiveInteger(configMap.get(startKey), '订单业务号起始配置异常')
    const width = this.parsePositiveInteger(configMap.get(widthKey), '订单业务号位宽配置异常')
    if (width > 12) {
      throw new BizError('订单业务号位宽配置异常：位宽必须在 1 到 12 之间', 500)
    }
    return { start, width }
  }

  /** 无锁读取命名空间游标；游标行尚未创建时与分配逻辑一致，取 start - 1 与历史最大占用号的较大值。 */
  private async readCursorWithoutLock(orderType: OrderType, config: BusinessNoConfig, manager: EntityManager): Promise<number> {
    const rule = BUSINESS_NO_RULES[orderType]
    const existingSequence = await manager.getRepository(BusinessSequence).findOneBy({ sequenceKey: rule.sequenceKey })
    if (existingSequence) {
      return this.parseNonNegativeInteger(existingSequence.currentValue, '订单业务号游标异常')
    }
    const maxRow = await manager.getRepository(OrderBusinessNoOccupancy)
      .createQueryBuilder('occupancy')
      .select('MAX(occupancy.serialValue)', 'maxSerial')
      .where('occupancy.namespace = :namespace', { namespace: rule.namespace })
      .getRawOne<{ maxSerial: string | number | null }>()
    return Math.max(config.start - 1, Number(maxRow?.maxSerial ?? config.start - 1))
  }

  private groupTargets(targets: BusinessNoReservationTarget[]) {
    const groups = new Map<'hyyzjd' | 'hyyz', BusinessNoReservationTarget[]>()
    for (const target of targets) {
      const current = groups.get(target.parsed.namespace) ?? []
      current.push(target)
      groups.set(target.parsed.namespace, current)
    }
    return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))
  }

  private buildCursorPlan(
    namespace: 'hyyzjd' | 'hyyz',
    beforeCursor: number,
    afterCursor: number,
    width: number,
  ): BusinessNoCursorPlan {
    const nextSerial = afterCursor + 1
    const maxSerial = 10 ** width - 1
    return {
      namespace,
      beforeCursor,
      afterCursor,
      nextBusinessNo: nextSerial <= maxSerial ? `${namespace}${String(nextSerial).padStart(width, '0')}` : null,
    }
  }

  private async loadOrCreateSequence(sequenceKey: string, initialValue: number, manager: EntityManager) {
    let sequence = await this.loadSequenceForUpdateIfPresent(sequenceKey, manager)
    if (!sequence) {
      const occupancyMaxRow = await manager.getRepository(OrderBusinessNoOccupancy)
        .createQueryBuilder('occupancy')
        .select('MAX(occupancy.serialValue)', 'maxSerial')
        .where('occupancy.namespace = :namespace', {
          namespace: sequenceKey.endsWith('.department') ? 'hyyzjd' : 'hyyz',
        })
        .getRawOne<{ maxSerial: string | number | null }>()
      const maxOccupied = Math.max(initialValue, Number(occupancyMaxRow?.maxSerial ?? initialValue))
      await this.ensureSequenceRow(sequenceKey, maxOccupied, manager)
      sequence = await this.loadSequenceForUpdate(sequenceKey, manager)
    }
    if (!sequence) {
      throw new BizError('订单业务号游标初始化失败，请稍后重试', 500)
    }
    return sequence
  }

  private async loadSequenceForUpdateIfPresent(sequenceKey: string, manager: EntityManager) {
    if (manager.connection.options.type === 'mysql') {
      const exists = await manager.getRepository(BusinessSequence).existsBy({ sequenceKey })
      if (!exists) return null
    }
    return this.loadSequenceForUpdate(sequenceKey, manager)
  }

  private loadSequenceForUpdate(sequenceKey: string, manager: EntityManager) {
    const query = manager.getRepository(BusinessSequence)
      .createQueryBuilder('sequence')
      .where('sequence.sequenceKey = :sequenceKey', { sequenceKey })
    if (manager.connection.options.type !== 'sqlite') {
      query.setLock('pessimistic_write')
    }
    return query.getOne()
  }

  private async ensureSequenceRow(sequenceKey: string, currentValue: number, manager: EntityManager): Promise<void> {
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

  private parsePositiveInteger(value: string | number | undefined, message: string): number {
    const parsed = Number.parseInt(String(value ?? ''), 10)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new BizError(message, 500)
    return parsed
  }

  private parseNonNegativeInteger(value: string | number | undefined, message: string): number {
    const parsed = Number.parseInt(String(value ?? ''), 10)
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new BizError(message, 500)
    return parsed
  }
}

export const orderBusinessNoService = new OrderBusinessNoService()
