/**
 * 模块说明：订单独立业务号服务。
 * 文件职责：维护 hyyzjd/hyyz 两个业务号命名空间，并在事务中严格按 cursor + 1 分配新号。
 * 实现逻辑：业务号只在物理存在的订单之间唯一；软删除仍占用，永久删除后可由普通改单复用。
 * 部门预订单下单时预留的号与正式单共用同一占用口径，预订单被物理清理后才释放。
 */

import type { EntityManager } from 'typeorm'
import { BizOutboundOrder } from '../entities/biz-outbound-order.entity.js'
import { BusinessSequence } from '../entities/business-sequence.entity.js'
import { O2oPreorder } from '../entities/o2o-preorder.entity.js'
import { SystemConfig } from '../entities/system-config.entity.js'
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
    configKeyPrefix: 'order.business.department',
  },
  walkin: {
    namespace: 'hyyz',
    sequenceKey: 'order.business.walkin',
    configKeyPrefix: 'order.business.walkin',
  },
}

interface BusinessNoConfig {
  start: number
  current: number
  width: number
  currentKey: string
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

/** 建议号每批按区间查询物理订单，并限制最大扫描跨度，避免异常数据导致长时间扫描。 */
const SUGGESTION_WINDOW_SIZE = 200
const SUGGESTION_SCAN_LIMIT = 5000
const PHYSICAL_SERIAL_SCAN_BATCH_SIZE = 500

/** SQLite 原有唯一索引按字节比较。枚举受控前缀的大小写等价形式，查询时仍可使用索引。 */
function sqliteBusinessNoPrefixes(prefix: string): string[] {
  return [...prefix].reduce(
    (variants, letter) => variants.flatMap((variant) => [variant + letter, variant + letter.toUpperCase()]),
    [''],
  )
}

function sqliteBusinessNoVariants(businessNo: string): string[] {
  const match = /^(hyyz(?:jd)?)(\d+)$/i.exec(businessNo)
  if (!match) return [businessNo]
  const [, prefix, digits] = match
  return sqliteBusinessNoPrefixes(prefix!.toLowerCase()).map((variant) => variant + digits)
}

export interface BusinessNoReservationTarget {
  parsed: ParsedBusinessNo
  orderUuid: string
  reason: string | null
}

interface BusinessNoInspection {
  parsed: ParsedBusinessNo | null
  blockingReason: string | null
}

export class OrderBusinessNoService {
  async allocate(orderType: OrderType, orderUuid: string, manager: EntityManager): Promise<string> {
    const rule = BUSINESS_NO_RULES[orderType]
    const config = await this.loadConfig(rule.configKeyPrefix, manager)
    const sequence = await this.loadOrCreateSequence(rule.sequenceKey, Math.max(config.start - 1, config.current), manager)
    const current = Math.max(config.current, this.parseNonNegativeInteger(sequence.currentValue, '订单业务号游标异常'))
    const next = current + 1
    const maxSerial = 10 ** config.width - 1
    if (next < config.start || next > maxSerial) {
      throw new BizError('订单业务号已超出位宽上限，请联系管理员处理', 409)
    }

    const businessNo = `${rule.namespace}${String(next).padStart(config.width, '0')}`
    await this.assertBusinessNoAvailable(businessNo, orderUuid, manager)
    sequence.currentValue = next
    await manager.getRepository(BusinessSequence).save(sequence)
    await this.updateCurrentMirror(config.currentKey, next, manager)
    return businessNo
  }

  /** 核销继承预留号：只放行预留方自身，其他订单或预订单占用都按冲突拒绝，不推进游标。 */
  async assertInheritableByPreorder(
    businessNo: string,
    orderUuid: string,
    preorderId: string,
    manager: EntityManager,
  ): Promise<void> {
    await this.assertBusinessNoAvailable(businessNo, orderUuid, manager, preorderId)
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
      const sequence = await this.loadOrCreateSequence(rule.sequenceKey, Math.max(config.start - 1, config.current), manager)
      const beforeCursor = Math.max(
        config.start - 1,
        config.current,
        this.parseNonNegativeInteger(sequence.currentValue, '订单业务号游标异常'),
      )
      const sortedTargets = [...namespaceTargets].sort((left, right) =>
        left.parsed.serialValue - right.parsed.serialValue
        || left.orderUuid.localeCompare(right.orderUuid),
      )
      const occupancy = await this.readBusinessNoOccupancy(sortedTargets.map((target) => target.parsed.businessNo), manager, true)
      for (const target of sortedTargets) {
        const businessNo = target.parsed.businessNo
        const owners = occupancy.orders.get(businessNo)
        if (owners?.some((owner) => owner !== target.orderUuid) || occupancy.preorders.has(businessNo)) {
          throw new BizError(`业务号 ${businessNo} 当前已被其他订单使用`, 409)
        }
      }
      const afterCursor = Math.max(beforeCursor, sortedTargets.at(-1)?.parsed.serialValue ?? beforeCursor)
      sequence.currentValue = afterCursor
      await manager.getRepository(BusinessSequence).save(sequence)
      await this.updateCurrentMirror(config.currentKey, afterCursor, manager)
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
      const afterCursor = Math.max(beforeCursor, ...namespaceTargets.map((target) => target.parsed.serialValue))
      plans.push(this.buildCursorPlan(namespace, beforeCursor, afterCursor, config.width))
    }
    return plans
  }

  /**
   * 修订弹窗切换订单类型时的业务号建议：只读游标与物理订单，不加锁、不占号、不推进游标。
   * 从 cursor + 1 起顺延，跳过当前仍在用的号与调用方排除号（同批其他草稿），结果仅作为可手改的默认值；
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
    const prefixes = manager.connection.options.type === 'sqlite' ? sqliteBusinessNoPrefixes(rule.namespace) : [rule.namespace]

    let windowStart = Math.max(cursor + 1, config.start)
    while (businessNos.length < count && windowStart <= maxSerial) {
      if (windowStart - cursor > SUGGESTION_SCAN_LIMIT) {
        throw new BizError(`业务号游标之后连续 ${SUGGESTION_SCAN_LIMIT} 个号均不可用，请手动填写业务单号`, 409)
      }
      const windowEnd = Math.min(maxSerial, windowStart + SUGGESTION_WINDOW_SIZE - 1)
      const rangeCondition = (column: string) => '(' + prefixes.map((_, index) =>
        `${column} BETWEEN :start${index} AND :end${index}`,
      ).join(' OR ') + ')'
      const rangeParameters = Object.fromEntries(prefixes.flatMap((prefix, index) => [
        [`start${index}`, prefix + String(windowStart).padStart(config.width, '0')],
        [`end${index}`, prefix + String(windowEnd).padStart(config.width, '0')],
      ]))
      const occupiedRows = await manager.getRepository(BizOutboundOrder)
        .createQueryBuilder('order')
        .select('order.businessNo', 'businessNo')
        .where('order.orderType = :orderType', { orderType })
        .andWhere(rangeCondition('order.businessNo'), rangeParameters)
        .getRawMany<{ businessNo: string }>()
      const reservedRows = await manager.getRepository(O2oPreorder)
        .createQueryBuilder('preorder')
        .select('preorder.reservedBusinessNo', 'businessNo')
        .where('preorder.clientOrderType = :orderType', { orderType })
        .andWhere(rangeCondition('preorder.reservedBusinessNo'), rangeParameters)
        .getRawMany<{ businessNo: string }>()
      const occupied = new Set([...occupiedRows, ...reservedRows].map((row) => String(row.businessNo).trim().toLowerCase()))
      for (let serial = windowStart; serial <= windowEnd && businessNos.length < count; serial += 1) {
        const businessNo = formatSerial(serial)
        if (occupied.has(businessNo)) {
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
  ): Promise<BusinessNoInspection> {
    const [result] = await this.inspectConfirmedBatch([{ businessNo, orderType }], manager)
    return result!
  }

  async inspectConfirmedBatch(
    numbers: Array<{ businessNo: string; orderType: OrderType }>,
    manager: EntityManager,
  ): Promise<BusinessNoInspection[]> {
    const configs = new Map<OrderType, Promise<BusinessNoConfig>>()
    const results: BusinessNoInspection[] = []
    for (const item of numbers) {
      try {
        let config = configs.get(item.orderType)
        if (!config) {
          config = this.loadConfig(BUSINESS_NO_RULES[item.orderType].configKeyPrefix, manager)
          configs.set(item.orderType, config)
        }
        results.push({ parsed: this.parseWithConfig(item.businessNo, item.orderType, await config), blockingReason: null })
      } catch (error) {
        results.push({ parsed: null, blockingReason: error instanceof Error ? error.message : '业务号格式非法' })
      }
    }
    const businessNos = results.flatMap((item) => item.parsed ? [item.parsed.businessNo] : [])
    if (!businessNos.length) return results
    const occupancy = await this.readBusinessNoOccupancy(businessNos, manager, false)
    for (const item of results) {
      const businessNo = item.parsed?.businessNo
      if (businessNo && (occupancy.orders.has(businessNo) || occupancy.preorders.has(businessNo))) {
        item.blockingReason = `业务号 ${businessNo} 当前已被其他订单使用`
      }
    }
    return results
  }

  async parseForOrderType(businessNo: string, orderType: OrderType, manager: EntityManager): Promise<ParsedBusinessNo> {
    const config = await this.loadConfig(BUSINESS_NO_RULES[orderType].configKeyPrefix, manager)
    return this.parseWithConfig(businessNo, orderType, config)
  }

  private parseWithConfig(businessNo: string, orderType: OrderType, config: BusinessNoConfig): ParsedBusinessNo {
    const normalizedBusinessNo = businessNo.trim().toLowerCase()
    const rule = BUSINESS_NO_RULES[orderType]
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

  private async readBusinessNoOccupancy(businessNos: string[], manager: EntityManager, lock: boolean) {
    const unique = [...new Set(businessNos)]
    const bindings = unique.map((businessNo, index) => [`confirmed${index}`, businessNo] as const)
    const sqlite = manager.connection.options.type === 'sqlite'
    const parameters = {
      businessNos: sqlite ? unique.flatMap(sqliteBusinessNoVariants) : unique,
      ...Object.fromEntries(bindings),
    }
    // 返回数据库实际判等的候选号。历史值即使大小写或字形不同，也沿用各列原生排序规则。
    const matchedNo = (column: string) => sqlite
      ? `LOWER(${column})`
      : `CASE ${column} ${bindings.map(([key]) => `WHEN :${key} THEN :${key}`).join(' ')} END`
    const orders = manager.getRepository(BizOutboundOrder).createQueryBuilder('order')
      .select(matchedNo('order.businessNo'), 'businessNo')
      .addSelect('order.orderUuid', 'orderUuid')
      .where('order.businessNo IN (:...businessNos)', parameters)
      .orderBy('order.businessNo', 'ASC')
    const preorders = manager.getRepository(O2oPreorder).createQueryBuilder('preorder')
      .select(matchedNo('preorder.reservedBusinessNo'), 'businessNo')
      .where('preorder.reservedBusinessNo IN (:...businessNos)', parameters)
      .orderBy('preorder.reservedBusinessNo', 'ASC')
    if (lock && !sqlite) {
      orders.setLock('pessimistic_read')
      preorders.setLock('pessimistic_read')
    }
    const orderRows = await orders.getRawMany<{ businessNo: string; orderUuid: string }>()
    const preorderRows = await preorders.getRawMany<{ businessNo: string }>()
    const owners = new Map<string, string[]>()
    for (const row of orderRows) {
      const existing = owners.get(row.businessNo)
      if (existing) existing.push(row.orderUuid)
      else owners.set(row.businessNo, [row.orderUuid])
    }
    return { orders: owners, preorders: new Set(preorderRows.map((preorder) => preorder.businessNo)) }
  }

  private async assertBusinessNoAvailable(
    businessNo: string,
    orderUuid: string,
    manager: EntityManager,
    ownerPreorderId?: string,
  ): Promise<void> {
    const sqlite = manager.connection.options.type === 'sqlite'
    const businessNos = sqlite ? sqliteBusinessNoVariants(businessNo) : [businessNo]
    const query = manager.getRepository(BizOutboundOrder)
      .createQueryBuilder('order')
      .where('order.businessNo IN (:...businessNos)', { businessNos })
      .andWhere('order.orderUuid <> :orderUuid', { orderUuid })
    const reservationQuery = manager.getRepository(O2oPreorder)
      .createQueryBuilder('preorder')
      .where('preorder.reservedBusinessNo IN (:...businessNos)', { businessNos })
    if (ownerPreorderId) reservationQuery.andWhere('preorder.id <> :ownerPreorderId', { ownerPreorderId })
    if (!sqlite) {
      query.setLock('pessimistic_read')
      reservationQuery.setLock('pessimistic_read')
    }
    if (await query.getExists() || await reservationQuery.getExists()) {
      throw new BizError(`业务号 ${businessNo} 当前已被其他订单使用`, 409)
    }
  }

  private async loadConfig(configKeyPrefix: string, manager: EntityManager): Promise<BusinessNoConfig> {
    const startKey = `${configKeyPrefix}.start`
    const currentKey = `${configKeyPrefix}.current`
    const widthKey = `${configKeyPrefix}.width`
    const rows = await manager.getRepository(SystemConfig).findBy([
      { configKey: startKey },
      { configKey: currentKey },
      { configKey: widthKey },
    ])
    const configMap = new Map(rows.map((row) => [row.configKey, row.configValue]))
    const start = this.parsePositiveInteger(configMap.get(startKey), '订单业务号起始配置异常')
    const current = this.parseNonNegativeInteger(configMap.get(currentKey), '订单业务号当前值配置异常')
    const width = this.parsePositiveInteger(configMap.get(widthKey), '订单业务号位宽配置异常')
    if (width > 12) {
      throw new BizError('订单业务号位宽配置异常：位宽必须在 1 到 12 之间', 500)
    }
    if (current < start - 1) throw new BizError('订单业务号当前值配置异常', 500)
    return { start, current, width, currentKey }
  }

  private async updateCurrentMirror(currentKey: string, current: number, manager: EntityManager): Promise<void> {
    await manager.getRepository(SystemConfig).update({ configKey: currentKey }, { configValue: String(current) })
  }

  private async readPhysicalMaxSerial(
    orderType: OrderType,
    config: BusinessNoConfig,
    manager: EntityManager,
    excludeOrderId?: string,
  ): Promise<number> {
    const rule = BUSINESS_NO_RULES[orderType]
    const pattern = new RegExp(`^${rule.namespace}\\d{${config.width}}$`)
    const outbound = manager.getRepository(BizOutboundOrder)
      .createQueryBuilder('entry')
      .select('entry.businessNo', 'businessNo')
      .where('entry.orderType = :orderType', { orderType })
    if (excludeOrderId) outbound.andWhere('entry.id <> :excludeOrderId', { excludeOrderId })
    const preorder = manager.getRepository(O2oPreorder)
      .createQueryBuilder('entry')
      .select('entry.reservedBusinessNo', 'businessNo')
      .where('entry.clientOrderType = :orderType', { orderType })
      .andWhere('entry.reservedBusinessNo IS NOT NULL')

    const sqlite = manager.connection.options.type === 'sqlite'
    const idTextType = sqlite ? 'TEXT' : 'CHAR'
    const idParameterType = sqlite ? 'INTEGER' : 'UNSIGNED'
    let maxSerial = 0
    for (const [source, query] of [['outbound', outbound], ['preorder', preorder]] as const) {
      query.addSelect(`CAST(entry.id AS ${idTextType})`, 'id')
        .orderBy('entry.id', 'DESC').limit(PHYSICAL_SERIAL_SCAN_BATCH_SIZE)
      let cursor: string | undefined
      while (true) {
        const batch = query.clone()
        if (cursor !== undefined) batch.andWhere(`entry.id < CAST(:cursor AS ${idParameterType})`, { cursor })
        const rows = await batch.getRawMany<{ id: string; businessNo: string }>()
        for (const row of rows) {
          const businessNo = String(row.businessNo ?? '').trim().toLowerCase()
          if (!pattern.test(businessNo)) {
            if (source === 'preorder') {
              throw new BizError(`预订单预留业务号 ${businessNo} 不符合 ${rule.namespace} 命名空间，无法安全校准游标`, 500)
            }
            throw new BizError(`订单 ${row.id || '未知'} 的当前业务号不符合 ${rule.namespace} 命名空间，无法安全校准游标`, 500)
          }
          const serialValue = Number.parseInt(businessNo.slice(rule.namespace.length), 10)
          if (source === 'outbound' && (!Number.isSafeInteger(serialValue) || serialValue < config.start)) {
            throw new BizError(`订单 ${row.id || '未知'} 的当前业务号流水值非法，无法安全校准游标`, 500)
          }
          maxSerial = Math.max(maxSerial, serialValue)
        }
        if (rows.length < PHYSICAL_SERIAL_SCAN_BATCH_SIZE) break
        cursor = rows.at(-1)!.id
      }
    }
    return maxSerial
  }

  /** 无锁读取命名空间游标；游标行尚未创建时取 start - 1 与物理现存订单最大号的较大值。 */
  private async readCursorWithoutLock(orderType: OrderType, config: BusinessNoConfig, manager: EntityManager): Promise<number> {
    const rule = BUSINESS_NO_RULES[orderType]
    const existingSequence = await manager.getRepository(BusinessSequence).findOneBy({ sequenceKey: rule.sequenceKey })
    if (existingSequence) {
      return Math.max(config.current, this.parseNonNegativeInteger(existingSequence.currentValue, '订单业务号游标异常'))
    }
    return Math.max(config.start - 1, config.current, await this.readPhysicalMaxSerial(orderType, config, manager))
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
      const orderType: OrderType = sequenceKey.endsWith('.department') ? 'department' : 'walkin'
      const config = await this.loadConfig(BUSINESS_NO_RULES[orderType].configKeyPrefix, manager)
      const maxCurrent = Math.max(initialValue, await this.readPhysicalMaxSerial(orderType, config, manager))
      await this.ensureSequenceRow(sequenceKey, maxCurrent, manager)
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
