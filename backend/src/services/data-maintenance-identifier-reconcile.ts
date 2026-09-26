/**
 * 模块说明：JSON 回灌后的订单编号安全领养。
 * 文件职责：在导入事务内保留当前命名空间形状和高水位，并复用 055 的历史配置领养规则。
 * 维护说明：六套 sequence 必须先按 055 的稳定顺序锁定，再触碰 system_configs；不回写旧订单号。
 */

import type { EntityManager } from 'typeorm'
import { backfillSqliteOrderIdentifierNamespaces } from '../config/database-bootstrap.js'
import { applyMysqlOrderIdentifierNamespacesInTransaction } from '../config/mysql-migration-runner.js'
import { BusinessSequence } from '../entities/business-sequence.entity.js'
import { SystemConfig } from '../entities/system-config.entity.js'
import { BizError } from '../utils/errors.js'

const NAMESPACES = [
  { key: 'order.system.walkin', field: 'showNo', orderType: 'walkin', pattern: /^OUT-W-(\d{6})$/ },
  { key: 'o2o.preorder.walkin', field: 'preorderNo', orderType: 'walkin', pattern: /^PRE-W-(\d{6})$/ },
  { key: 'order.business.walkin', field: 'businessNo', orderType: 'walkin', pattern: /^hyyz(\d+)$/i },
  { key: 'order.system.department', field: 'showNo', orderType: 'department', pattern: /^OUT-D-(\d{6})$/ },
  { key: 'o2o.preorder.department', field: 'preorderNo', orderType: 'department', pattern: /^PRE-D-(\d{6})$/ },
  { key: 'order.business.department', field: 'businessNo', orderType: 'department', pattern: /^hyyzjd(\d+)$/i },
] as const

const protectedKeys = NAMESPACES.flatMap(({ key }) => [`${key}.start`, `${key}.current`, `${key}.width`])
protectedKeys.push('order.business.walkin.migration.055', 'order.business.department.migration.055')

function parseCurrent(value: string | number | null | undefined, label: string): number {
  if (value === null || value === undefined) return 0
  const text = String(value).trim()
  if (!/^\d+$/.test(text)) throw new BizError(`编号游标非法：${label}`, 409)
  const parsed = Number(text)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new BizError(`编号游标非法：${label}`, 409)
  return parsed
}

/** 导入清表前先锁住六条并发流水，避免 MySQL 与开单形成反向锁序。 */
export async function captureOrderIdentifierConfigsBeforeImport(manager: EntityManager): Promise<SystemConfig[]> {
  for (const { key } of NAMESPACES) {
    if (manager.connection.options.type === 'mysql') {
      await manager.query(
        `INSERT INTO business_sequence (sequence_key, current_value, created_at, updated_at)
         VALUES (?, 0, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))
         ON DUPLICATE KEY UPDATE sequence_key = sequence_key`,
        [key],
      )
    } else {
      await manager.query(
        `INSERT OR IGNORE INTO business_sequence (sequence_key, current_value, created_at, updated_at)
         VALUES (?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [key],
      )
    }
    const query = manager.getRepository(BusinessSequence)
      .createQueryBuilder('sequence')
      .where('sequence.sequenceKey = :key', { key })
    if (manager.connection.options.type === 'mysql') query.setLock('pessimistic_write')
    if (!await query.getOne()) throw new BizError(`编号序列缺失：${key}`, 500)
  }
  const configQuery = manager.getRepository(SystemConfig)
    .createQueryBuilder('config')
    .where('config.configKey IN (:...keys)', { keys: protectedKeys })
    .orderBy('config.configKey', 'ASC')
  if (manager.connection.options.type === 'mysql') configQuery.setLock('pessimistic_write')
  return configQuery.getMany()
}

/** 导入载荷可替换普通配置，但不能抹掉当前运行时已确认的新编号形状与高水位。 */
export async function reconcileOrderIdentifierConfigsAfterImport(
  manager: EntityManager,
  previousConfigs: SystemConfig[],
): Promise<void> {
  const configRepo = manager.getRepository(SystemConfig)
  const importedBusinessConfigs = await configRepo.find({
    where: [
      { configKey: 'order.business.walkin.start' },
      { configKey: 'order.business.walkin.current' },
      { configKey: 'order.business.walkin.width' },
      { configKey: 'order.business.walkin.migration.055' },
      { configKey: 'order.business.department.start' },
      { configKey: 'order.business.department.current' },
      { configKey: 'order.business.department.width' },
      { configKey: 'order.business.department.migration.055' },
    ],
  })
  const importedBusinessMap = new Map(importedBusinessConfigs.map((row) => [row.configKey, row.configValue]))
  const legacyBusinessTypes = new Set(['walkin', 'department'].filter((orderType) => {
    const key = `order.business.${orderType}`
    return ['start', 'current', 'width'].some((suffix) => !importedBusinessMap.has(`${key}.${suffix}`))
      || importedBusinessMap.get(`${key}.migration.055`) !== '1'
  }))
  for (const previous of previousConfigs) {
    const imported = await configRepo.findOneBy({ configKey: previous.configKey })
    const value = previous.configKey.endsWith('.current')
      ? String(Math.max(
        parseCurrent(previous.configValue, previous.configKey),
        parseCurrent(imported?.configValue, previous.configKey),
      ))
      : previous.configKey.endsWith('.migration.055')
        ? previous.configValue === '1' || imported?.configValue === '1' ? '1' : previous.configValue
        : previous.configValue
    if (imported) {
      if (imported.configValue !== value) await configRepo.update({ id: imported.id }, { configValue: value })
    } else {
      await configRepo.insert({
        configKey: previous.configKey,
        configValue: value,
        configGroup: previous.configGroup,
        remark: previous.remark,
      })
    }
  }

  if (manager.connection.options.type === 'mysql') {
    await applyMysqlOrderIdentifierNamespacesInTransaction(manager)
  } else {
    await backfillSqliteOrderIdentifierNamespaces(manager)
  }

  // 055 只在缺 namespace 时写 MySQL；导入后还需把已存在的 sequence、配置与物理单号取最大。
  // 旧 hyyz 预订单号不属于 PRE 命名空间，因此仅匹配 PRE-D/PRE-W 六位编号。
  const outboundRows = await manager.query(
    'SELECT show_no AS showNo, business_no AS businessNo, order_type AS orderType FROM biz_outbound_order',
  ) as Array<{ showNo: string; businessNo: string; orderType: string }>
  const preorderRows = await manager.query(
    'SELECT show_no AS preorderNo, client_order_type AS orderType FROM o2o_preorder',
  ) as Array<{ preorderNo: string; orderType: string }>
  const sequenceRepo = manager.getRepository(BusinessSequence)
  for (const namespace of NAMESPACES) {
    const configKey = `${namespace.key}.current`
    const currentConfig = await configRepo.findOneBy({ configKey })
    const startConfig = await configRepo.findOneBy({ configKey: `${namespace.key}.start` })
    const widthConfig = await configRepo.findOneBy({ configKey: `${namespace.key}.width` })
    const sequence = await sequenceRepo.findOneBy({ sequenceKey: namespace.key })
    if (!currentConfig || !startConfig || !widthConfig || !sequence) {
      throw new BizError(`编号配置或序列缺失：${namespace.key}`, 409)
    }
    const start = parseCurrent(startConfig.configValue, `${namespace.key}.start`)
    const width = parseCurrent(widthConfig.configValue, `${namespace.key}.width`)
    if (start < 1 || width < 1 || width > 12
      || (!namespace.key.startsWith('order.business.') && (start !== 1 || width !== 6))) {
      throw new BizError(`导入编号配置形状非法：${namespace.key}`, 409)
    }
    const maxSerial = 10 ** width - 1
    if (start > maxSerial) throw new BizError(`导入编号起始号超出位宽：${namespace.key}`, 409)
    const physicalRows = namespace.field === 'preorderNo' ? preorderRows : outboundRows
    const physicalPattern = namespace.key.startsWith('order.business.')
      ? new RegExp(`^${namespace.orderType === 'walkin' ? 'hyyz' : 'hyyzjd'}(\\d{${width}})$`, 'i')
      : namespace.pattern
    const physicalMaximum = physicalRows.reduce((maximum, row) => {
      if (row.orderType !== namespace.orderType) return maximum
      const rawValue = String(row[namespace.field as keyof typeof row] ?? '').trim()
      const match = physicalPattern.exec(rawValue)
      if (!match) {
        if (namespace.field === 'businessNo') throw new BizError(`物理订单业务号格式与位宽不匹配：${namespace.key}`, 409)
        return maximum
      }
      const serial = Number(match[1])
      if (!Number.isSafeInteger(serial) || serial < start || serial > maxSerial) {
        throw new BizError(`物理订单编号流水值非法：${namespace.key}`, 409)
      }
      return Math.max(maximum, serial)
    }, 0)
    const legacyOrderType = namespace.key.startsWith('order.business.')
      ? namespace.orderType
      : null
    const legacyCurrent = legacyOrderType && legacyBusinessTypes.has(legacyOrderType)
      ? await configRepo.findOneBy({ configKey: `order.serial.${legacyOrderType}.current` })
      : null
    const legacySequence = legacyOrderType && legacyBusinessTypes.has(legacyOrderType)
      ? await sequenceRepo.findOneBy({ sequenceKey: `order.serial.${legacyOrderType}` })
      : null
    const target = Math.max(
      parseCurrent(currentConfig.configValue, configKey),
      parseCurrent(sequence.currentValue, namespace.key),
      physicalMaximum,
      parseCurrent(legacyCurrent?.configValue, `order.serial.${legacyOrderType}.current`),
      parseCurrent(legacySequence?.currentValue, `order.serial.${legacyOrderType}`),
    )
    if (target < start - 1 || target > maxSerial) {
      throw new BizError(`导入编号游标超出位宽或起始号：${namespace.key}`, 409)
    }
    if (parseCurrent(sequence.currentValue, namespace.key) < target) {
      await sequenceRepo.update({ sequenceKey: namespace.key }, { currentValue: target })
    }
    if (parseCurrent(currentConfig.configValue, configKey) < target) {
      await configRepo.update({ configKey }, { configValue: String(target) })
    }
  }
}
