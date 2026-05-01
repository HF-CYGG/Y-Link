/**
 * 模块说明：backend/src/services/data-maintenance.service.ts
 * 文件职责：负责 SQLite 备份、JSON 导入导出与高风险数据维护动作的结构校验和审计收口。
 * 实现逻辑：
 * 1. 导出侧仅允许管理员执行，并补齐回灌所需的敏感字段与导出审计。
 * 2. 导入侧在事务前完成版本、表结构、关键字段和跨表引用校验，避免“先清库后报错”。
 * 3. 对商品、客户端用户、预订单等关键表补服务层边界校验，减少只靠前端校验的风险。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { AppDataSource } from '../config/data-source.js'
import { resolveSqliteDatabasePath } from '../config/database-bootstrap.js'
import { env } from '../config/env.js'
import { BaseProduct } from '../entities/base-product.entity.js'
import { CLIENT_USER_STATUSES, ClientUser } from '../entities/client-user.entity.js'
import { InventoryLog } from '../entities/inventory-log.entity.js'
import {
  O2O_CLIENT_ORDER_TYPES,
  O2O_PREORDER_BUSINESS_STATUSES,
  O2O_PREORDER_CANCEL_REASONS,
  O2O_PREORDER_STATUSES,
  O2oPreorder,
} from '../entities/o2o-preorder.entity.js'
import { O2oPreorderItem } from '../entities/o2o-preorder-item.entity.js'
import { SystemConfig } from '../entities/system-config.entity.js'
import type { AuthUserContext } from '../types/auth.js'
import { BizError } from '../utils/errors.js'
import type { RequestMeta } from '../utils/request-meta.js'
import { auditService } from './audit.service.js'

const EXPORT_VERSION = 'data-maintenance-v2'
const SUPPORTED_IMPORT_VERSIONS = new Set(['o2o-preorder-v1', EXPORT_VERSION])
const EXPORT_TABLE_KEYS = ['systemConfigs', 'products', 'clientUsers', 'preorders', 'preorderItems', 'inventoryLogs'] as const
type ExportTableKey = (typeof EXPORT_TABLE_KEYS)[number]
type ExportRow = Record<string, unknown>

type ExportPayload = {
  exportedAt: string
  version: string
  tables: Record<ExportTableKey, ExportRow[]>
}

type ImportSummary = Record<ExportTableKey, number>

const PRODUCT_O2O_STATUS_SET = new Set(['listed', 'unlisted'])
const CLIENT_USER_STATUS_SET = new Set<string>(CLIENT_USER_STATUSES)
const PREORDER_STATUS_SET = new Set<string>(O2O_PREORDER_STATUSES)
const PREORDER_CANCEL_REASON_SET = new Set<string>(O2O_PREORDER_CANCEL_REASONS)
const PREORDER_BUSINESS_STATUS_SET = new Set<string>(O2O_PREORDER_BUSINESS_STATUSES)
const PREORDER_CLIENT_ORDER_TYPE_SET = new Set<string>(O2O_CLIENT_ORDER_TYPES)

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cloneForJson<T>(value: T): T {
  return structuredClone(value)
}

/**
 * 导出数据最终都会被序列化为 JSON 对象数组：
 * - 这里显式收口为 `ExportRow[]`，避免实体类型与导出载荷类型在编译期产生不必要冲突；
 * - 同时保留 `cloneForJson` 的深拷贝行为，防止后续对实体实例做原地污染。
 */
function cloneForExportRows<T extends object>(rows: T[]): ExportRow[] {
  return cloneForJson(rows) as ExportRow[]
}

function stringifyComparableValue(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'string') {
    return String(value)
  }
  throw new BizError('导入数据中的主键或关联键类型非法', 400)
}

function readRequiredText(row: Record<string, unknown>, field: string, label: string, maxLength: number): string {
  const rawValue = row[field]
  if (typeof rawValue !== 'string') {
    throw new BizError(`${label}缺失或类型非法`, 400)
  }
  const normalizedValue = rawValue.trim()
  if (!normalizedValue) {
    throw new BizError(`${label}不能为空`, 400)
  }
  if (normalizedValue.length > maxLength) {
    throw new BizError(`${label}长度不能超过 ${maxLength} 个字符`, 400)
  }
  return normalizedValue
}

function readRequiredRawText(row: Record<string, unknown>, field: string, label: string, maxLength: number): string {
  const rawValue = row[field]
  if (typeof rawValue !== 'string') {
    throw new BizError(`${label}缺失或类型非法`, 400)
  }
  if (!rawValue.trim()) {
    throw new BizError(`${label}不能为空`, 400)
  }
  if (rawValue.length > maxLength) {
    throw new BizError(`${label}长度不能超过 ${maxLength} 个字符`, 400)
  }
  return rawValue
}

function readOptionalText(row: Record<string, unknown>, field: string, maxLength: number): string | null {
  const rawValue = row[field]
  if (rawValue === null || rawValue === undefined || rawValue === '') {
    return null
  }
  if (typeof rawValue !== 'string') {
    throw new BizError(`${field} 类型非法`, 400)
  }
  const normalizedValue = rawValue.trim()
  if (!normalizedValue) {
    return null
  }
  if (normalizedValue.length > maxLength) {
    throw new BizError(`${field} 长度不能超过 ${maxLength} 个字符`, 400)
  }
  return normalizedValue
}

function readOptionalLongText(row: Record<string, unknown>, field: string, maxLength: number): string | null {
  return readOptionalText(row, field, maxLength)
}

function parseNumberish(rawValue: unknown): number {
  if (typeof rawValue === 'number') {
    return rawValue
  }
  if (typeof rawValue === 'string' && rawValue.trim()) {
    return Number(rawValue)
  }
  return Number.NaN
}

function readRequiredIdentifier(row: Record<string, unknown>, field: string, label: string): string {
  const rawValue = row[field]
  if ((typeof rawValue !== 'string' && typeof rawValue !== 'number') || `${rawValue}`.trim() === '') {
    throw new BizError(`${label}缺失或类型非法`, 400)
  }
  return `${rawValue}`.trim()
}

function readOptionalIdentifier(row: Record<string, unknown>, field: string): string | null {
  const rawValue = row[field]
  if (rawValue === null || rawValue === undefined || rawValue === '') {
    return null
  }
  if (typeof rawValue !== 'string' && typeof rawValue !== 'number') {
    throw new BizError(`${field} 类型非法`, 400)
  }
  return `${rawValue}`.trim() || null
}

function readBooleanFlag(row: Record<string, unknown>, field: string, label: string): boolean {
  const rawValue = row[field]
  if (typeof rawValue === 'boolean') {
    return rawValue
  }
  if (rawValue === 1 || rawValue === '1') {
    return true
  }
  if (rawValue === 0 || rawValue === '0') {
    return false
  }
  throw new BizError(`${label}类型非法，仅支持布尔值或 0/1`, 400)
}

function readInteger(row: Record<string, unknown>, field: string, label: string, options: { min?: number; max?: number } = {}): number {
  const rawValue = row[field]
  const parsedValue = parseNumberish(rawValue)
  if (!Number.isInteger(parsedValue)) {
    throw new BizError(`${label}必须为整数`, 400)
  }
  if (options.min !== undefined && parsedValue < options.min) {
    throw new BizError(`${label}不能小于 ${options.min}`, 400)
  }
  if (options.max !== undefined && parsedValue > options.max) {
    throw new BizError(`${label}不能大于 ${options.max}`, 400)
  }
  return parsedValue
}

function readDecimalText(
  row: Record<string, unknown>,
  field: string,
  label: string,
  options: { min?: number; max?: number } = {},
): string {
  const rawValue = row[field]
  const parsedValue = parseNumberish(rawValue)
  if (!Number.isFinite(parsedValue)) {
    throw new BizError(`${label}必须为数字`, 400)
  }
  if (options.min !== undefined && parsedValue < options.min) {
    throw new BizError(`${label}不能小于 ${options.min}`, 400)
  }
  if (options.max !== undefined && parsedValue > options.max) {
    throw new BizError(`${label}不能大于 ${options.max}`, 400)
  }
  return parsedValue.toFixed(2)
}

function readRequiredDateText(row: Record<string, unknown>, field: string, label: string): string {
  const rawValue = row[field]
  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    throw new BizError(`${label}缺失或类型非法`, 400)
  }
  return rawValue
}

function readOptionalDateText(row: Record<string, unknown>, field: string): string | null {
  const rawValue = row[field]
  if (rawValue === null || rawValue === undefined || rawValue === '') {
    return null
  }
  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    throw new BizError(`${field} 类型非法`, 400)
  }
  return rawValue
}

function assertEnumValue(value: string | null, label: string, candidates: Set<string>, allowNull = false): string | null {
  if (value === null) {
    if (allowNull) {
      return null
    }
    throw new BizError(`${label}不能为空`, 400)
  }
  if (!candidates.has(value)) {
    throw new BizError(`${label}取值非法`, 400)
  }
  return value
}

function assertUniqueFieldValues(rows: Array<Record<string, unknown>>, field: string, label: string) {
  const uniqueSet = new Set<string>()
  rows.forEach((row, index) => {
    const comparableValue = stringifyComparableValue(row[field])
    if (uniqueSet.has(comparableValue)) {
      throw new BizError(`${label}存在重复值：第 ${index + 1} 行`, 400)
    }
    uniqueSet.add(comparableValue)
  })
}

class DataMaintenanceService {
  /**
   * 管理员兜底校验：
   * - 路由层门禁之外，服务层再次校验角色，避免后续路由误配导致高危写操作被绕过；
   * - 拒绝时写入越权审计，保留访问者身份和请求元信息。
   */
  private async assertAdminActor(actor: AuthUserContext, requestMeta: RequestMeta | undefined, actionType: string, actionLabel: string) {
    if (actor.role === 'admin') {
      return actor
    }

    await auditService.safeRecord({
      actionType,
      actionLabel: `${actionLabel}（越权拦截）`,
      targetType: 'data_maintenance',
      targetCode: actionType,
      actor,
      requestMeta,
      resultStatus: 'failed',
      detail: {
        reason: 'role_mismatch',
        requiredRole: 'admin',
        actualRole: actor.role,
      },
    })
    throw new BizError('当前账号无权执行该操作', 403)
  }

  async createSqliteBackup(actor: AuthUserContext, requestMeta?: RequestMeta) {
    const adminActor = await this.assertAdminActor(actor, requestMeta, 'data_maintenance.backup_sqlite', '创建 SQLite 物理备份')
    if (env.DB_TYPE !== 'sqlite') {
      throw new BizError('当前环境不是 SQLite，无法执行物理备份', 400)
    }
    const sourcePath = resolveSqliteDatabasePath()
    const backupDir = path.resolve(process.cwd(), 'data', 'backup')
    await fs.mkdir(backupDir, { recursive: true })
    const fileName = `y-link-backup-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.sqlite`
    const targetPath = path.resolve(backupDir, fileName)
    await fs.copyFile(sourcePath, targetPath)
    await auditService.safeRecord({
      actionType: 'data_maintenance.backup_sqlite',
      actionLabel: '创建 SQLite 物理备份',
      targetType: 'data_maintenance',
      targetCode: fileName,
      actor: adminActor,
      requestMeta,
      detail: {
        sourcePath,
        fileName,
        filePath: targetPath,
      },
    })
    return {
      fileName,
      filePath: targetPath,
    }
  }

  private buildImportSummary(payload: ExportPayload): ImportSummary {
    return Object.fromEntries(EXPORT_TABLE_KEYS.map((tableKey) => [tableKey, payload.tables[tableKey].length])) as ImportSummary
  }

  private async loadExportRows(tableKey: ExportTableKey): Promise<ExportRow[]> {
    switch (tableKey) {
      case 'systemConfigs':
        return cloneForExportRows(
          await AppDataSource.getRepository(SystemConfig).find({
            order: { id: 'ASC' },
          }),
        )
      case 'products':
        return cloneForExportRows(
          await AppDataSource.getRepository(BaseProduct).find({
            order: { id: 'ASC' },
          }),
        )
      case 'clientUsers':
        return cloneForExportRows(
          await AppDataSource.getRepository(ClientUser)
            .createQueryBuilder('user')
            .addSelect('user.passwordHash')
            .orderBy('user.id', 'ASC')
            .getMany(),
        )
      case 'preorders':
        return cloneForExportRows(
          await AppDataSource.getRepository(O2oPreorder).find({
            order: { id: 'ASC' },
          }),
        )
      case 'preorderItems':
        return cloneForExportRows(
          await AppDataSource.getRepository(O2oPreorderItem).find({
            order: { id: 'ASC' },
          }),
        )
      case 'inventoryLogs':
        return cloneForExportRows(
          await AppDataSource.getRepository(InventoryLog).find({
            order: { id: 'ASC' },
          }),
        )
    }
  }

  private validateSystemConfigRows(rows: ExportRow[]) {
    const normalizedRows = rows.map((rawRow, index) => {
      if (!isPlainObject(rawRow)) {
        throw new BizError(`systemConfigs 第 ${index + 1} 行结构非法`, 400)
      }
      return {
        id: readRequiredIdentifier(rawRow, 'id', '系统配置ID'),
        configKey: readRequiredText(rawRow, 'configKey', '系统配置键', 128),
        configValue: readRequiredRawText(rawRow, 'configValue', '系统配置值', 20000),
        configGroup: readRequiredText(rawRow, 'configGroup', '系统配置分组', 64),
        remark: readOptionalText(rawRow, 'remark', 255),
        createdAt: readRequiredDateText(rawRow, 'createdAt', '系统配置创建时间'),
        updatedAt: readRequiredDateText(rawRow, 'updatedAt', '系统配置更新时间'),
      }
    })
    assertUniqueFieldValues(normalizedRows, 'id', 'systemConfigs.id')
    assertUniqueFieldValues(normalizedRows, 'configKey', 'systemConfigs.configKey')
    return normalizedRows
  }

  private validateProductRows(rows: ExportRow[]) {
    const normalizedRows = rows.map((rawRow, index) => {
      if (!isPlainObject(rawRow)) {
        throw new BizError(`products 第 ${index + 1} 行结构非法`, 400)
      }
      const currentStock = readInteger(rawRow, 'currentStock', '商品物理库存', { min: 0 })
      const preOrderedStock = readInteger(rawRow, 'preOrderedStock', '商品预订库存', { min: 0 })
      if (preOrderedStock > currentStock) {
        throw new BizError(`products 第 ${index + 1} 行预订库存不能大于物理库存`, 400)
      }
      const o2oStatus = readRequiredText(rawRow, 'o2oStatus', '商品线上状态', 16)
      assertEnumValue(o2oStatus, '商品线上状态', PRODUCT_O2O_STATUS_SET)
      return {
        id: readRequiredIdentifier(rawRow, 'id', '商品ID'),
        productCode: readRequiredText(rawRow, 'productCode', '商品编码', 64),
        productName: readRequiredText(rawRow, 'productName', '商品名称', 128),
        pinyinAbbr: typeof rawRow.pinyinAbbr === 'string' ? rawRow.pinyinAbbr.trim().slice(0, 64) : '',
        defaultPrice: readDecimalText(rawRow, 'defaultPrice', '商品默认单价', { min: 0, max: 9999999999.99 }),
        isActive: readBooleanFlag(rawRow, 'isActive', '商品启停状态'),
        o2oStatus,
        thumbnail: readOptionalText(rawRow, 'thumbnail', 255),
        detailContent: readOptionalLongText(rawRow, 'detailContent', 50000),
        limitPerUser: readInteger(rawRow, 'limitPerUser', '商品限购数量', { min: 1, max: 999999 }),
        currentStock,
        preOrderedStock,
        createdAt: readRequiredDateText(rawRow, 'createdAt', '商品创建时间'),
        updatedAt: readRequiredDateText(rawRow, 'updatedAt', '商品更新时间'),
      }
    })
    assertUniqueFieldValues(normalizedRows, 'id', 'products.id')
    assertUniqueFieldValues(normalizedRows, 'productCode', 'products.productCode')
    return normalizedRows
  }

  private validateClientUserRows(rows: ExportRow[]) {
    const normalizedRows = rows.map((rawRow, index) => {
      if (!isPlainObject(rawRow)) {
        throw new BizError(`clientUsers 第 ${index + 1} 行结构非法`, 400)
      }
      const mobile = readOptionalText(rawRow, 'mobile', 20)
      const email = readOptionalText(rawRow, 'email', 128)?.toLowerCase() ?? null
      if (!mobile && !email) {
        throw new BizError(`clientUsers 第 ${index + 1} 行手机号和邮箱至少保留一项`, 400)
      }
      const status = readRequiredText(rawRow, 'status', '客户端用户状态', 16)
      assertEnumValue(status, '客户端用户状态', CLIENT_USER_STATUS_SET)
      return {
        id: readRequiredIdentifier(rawRow, 'id', '客户端用户ID'),
        mobile,
        email,
        passwordHash: readRequiredRawText(rawRow, 'passwordHash', '客户端用户密码哈希', 255),
        realName: readRequiredText(rawRow, 'realName', '客户端用户名', 128),
        departmentName: readOptionalText(rawRow, 'departmentName', 128) ?? '',
        status,
        lastLoginAt: readOptionalDateText(rawRow, 'lastLoginAt'),
        createdAt: readRequiredDateText(rawRow, 'createdAt', '客户端用户创建时间'),
        updatedAt: readRequiredDateText(rawRow, 'updatedAt', '客户端用户更新时间'),
      }
    })
    assertUniqueFieldValues(normalizedRows, 'id', 'clientUsers.id')
    return normalizedRows
  }

  private validatePreorderRows(rows: ExportRow[]) {
    const normalizedRows = rows.map((rawRow, index) => {
      if (!isPlainObject(rawRow)) {
        throw new BizError(`preorders 第 ${index + 1} 行结构非法`, 400)
      }
      const status = readRequiredText(rawRow, 'status', '预订单状态', 16)
      const cancelReason = readOptionalText(rawRow, 'cancelReason', 16)
      const businessStatus = readOptionalText(rawRow, 'businessStatus', 32)
      const clientOrderType = readRequiredText(rawRow, 'clientOrderType', '预订单归属类型', 16)
      assertEnumValue(status, '预订单状态', PREORDER_STATUS_SET)
      assertEnumValue(cancelReason, '预订单取消原因', PREORDER_CANCEL_REASON_SET, true)
      assertEnumValue(businessStatus, '预订单商家状态', PREORDER_BUSINESS_STATUS_SET, true)
      assertEnumValue(clientOrderType, '预订单归属类型', PREORDER_CLIENT_ORDER_TYPE_SET)
      return {
        id: readRequiredIdentifier(rawRow, 'id', '预订单ID'),
        showNo: readRequiredText(rawRow, 'showNo', '预订单号', 48),
        clientUserId: readRequiredIdentifier(rawRow, 'clientUserId', '预订单客户端用户ID'),
        verifyCode: readRequiredText(rawRow, 'verifyCode', '预订单核销码', 64),
        status,
        cancelReason,
        businessStatus,
        merchantMessage: readOptionalText(rawRow, 'merchantMessage', 500),
        clientOrderType,
        departmentNameSnapshot: readOptionalText(rawRow, 'departmentNameSnapshot', 128),
        isSystemApplied: readBooleanFlag(rawRow, 'isSystemApplied', '是否系统申请'),
        hasCustomerOrder: readBooleanFlag(rawRow, 'hasCustomerOrder', '是否已触发正式出库单'),
        totalQty: readInteger(rawRow, 'totalQty', '预订单总件数', { min: 0, max: 999999 }),
        remark: readOptionalText(rawRow, 'remark', 255),
        updateCount: readInteger(rawRow, 'updateCount', '预订单修改次数', { min: 0, max: 999999 }),
        timeoutAt: readOptionalDateText(rawRow, 'timeoutAt'),
        verifiedAt: readOptionalDateText(rawRow, 'verifiedAt'),
        verifiedBy: readOptionalText(rawRow, 'verifiedBy', 64),
        createdAt: readRequiredDateText(rawRow, 'createdAt', '预订单创建时间'),
        updatedAt: readRequiredDateText(rawRow, 'updatedAt', '预订单更新时间'),
      }
    })
    assertUniqueFieldValues(normalizedRows, 'id', 'preorders.id')
    assertUniqueFieldValues(normalizedRows, 'showNo', 'preorders.showNo')
    assertUniqueFieldValues(normalizedRows, 'verifyCode', 'preorders.verifyCode')
    return normalizedRows
  }

  private validatePreorderItemRows(rows: ExportRow[]) {
    const normalizedRows = rows.map((rawRow, index) => {
      if (!isPlainObject(rawRow)) {
        throw new BizError(`preorderItems 第 ${index + 1} 行结构非法`, 400)
      }
      return {
        id: readRequiredIdentifier(rawRow, 'id', '预订单明细ID'),
        orderId: readRequiredIdentifier(rawRow, 'orderId', '预订单明细所属订单ID'),
        productId: readRequiredIdentifier(rawRow, 'productId', '预订单明细商品ID'),
        qty: readInteger(rawRow, 'qty', '预订单明细数量', { min: 1, max: 999999 }),
      }
    })
    assertUniqueFieldValues(normalizedRows, 'id', 'preorderItems.id')
    return normalizedRows
  }

  private validateInventoryLogRows(rows: ExportRow[]) {
    const normalizedRows = rows.map((rawRow, index) => {
      if (!isPlainObject(rawRow)) {
        throw new BizError(`inventoryLogs 第 ${index + 1} 行结构非法`, 400)
      }
      return {
        id: readRequiredIdentifier(rawRow, 'id', '库存流水ID'),
        productId: readRequiredIdentifier(rawRow, 'productId', '库存流水商品ID'),
        changeType: readRequiredText(rawRow, 'changeType', '库存变更类型', 32),
        changeQty: readInteger(rawRow, 'changeQty', '库存变更数量'),
        beforeCurrentStock: readInteger(rawRow, 'beforeCurrentStock', '变更前物理库存', { min: 0 }),
        afterCurrentStock: readInteger(rawRow, 'afterCurrentStock', '变更后物理库存', { min: 0 }),
        beforePreorderedStock: readInteger(rawRow, 'beforePreorderedStock', '变更前预订库存', { min: 0 }),
        afterPreorderedStock: readInteger(rawRow, 'afterPreorderedStock', '变更后预订库存', { min: 0 }),
        operatorType: readRequiredText(rawRow, 'operatorType', '库存流水操作人类型', 32),
        operatorId: readOptionalIdentifier(rawRow, 'operatorId'),
        operatorName: readOptionalText(rawRow, 'operatorName', 128),
        refType: readOptionalText(rawRow, 'refType', 32),
        refId: readOptionalIdentifier(rawRow, 'refId'),
        remark: readOptionalText(rawRow, 'remark', 255),
        createdAt: readRequiredDateText(rawRow, 'createdAt', '库存流水创建时间'),
      }
    })
    assertUniqueFieldValues(normalizedRows, 'id', 'inventoryLogs.id')
    return normalizedRows
  }

  private validateExportPayload(payload: ExportPayload): ExportPayload {
    if (!payload || typeof payload !== 'object') {
      throw new BizError('导入数据格式错误', 400)
    }
    if (typeof payload.exportedAt !== 'string' || !payload.exportedAt.trim()) {
      throw new BizError('导入数据缺少导出时间', 400)
    }
    if (!SUPPORTED_IMPORT_VERSIONS.has(payload.version)) {
      throw new BizError(`暂不支持该导入版本：${payload.version}`, 400)
    }
    if (!isPlainObject(payload.tables)) {
      throw new BizError('导入数据缺少 tables 结构', 400)
    }

    const unknownTableKeys = Object.keys(payload.tables).filter((key) => !EXPORT_TABLE_KEYS.includes(key as ExportTableKey))
    if (unknownTableKeys.length > 0) {
      throw new BizError(`导入数据包含未支持的数据表：${unknownTableKeys.join('、')}`, 400)
    }

    const normalizedTables = {} as ExportPayload['tables']
    EXPORT_TABLE_KEYS.forEach((tableKey) => {
      const tableRows = payload.tables[tableKey]
      if (!Array.isArray(tableRows)) {
        throw new BizError(`导入数据表 ${tableKey} 结构非法`, 400)
      }
      switch (tableKey) {
        case 'systemConfigs':
          normalizedTables.systemConfigs = this.validateSystemConfigRows(tableRows)
          break
        case 'products':
          normalizedTables.products = this.validateProductRows(tableRows)
          break
        case 'clientUsers':
          normalizedTables.clientUsers = this.validateClientUserRows(tableRows)
          break
        case 'preorders':
          normalizedTables.preorders = this.validatePreorderRows(tableRows)
          break
        case 'preorderItems':
          normalizedTables.preorderItems = this.validatePreorderItemRows(tableRows)
          break
        case 'inventoryLogs':
          normalizedTables.inventoryLogs = this.validateInventoryLogRows(tableRows)
          break
      }
    })

    const productIdSet = new Set(normalizedTables.products.map((row) => stringifyComparableValue(row.id)))
    const clientUserIdSet = new Set(normalizedTables.clientUsers.map((row) => stringifyComparableValue(row.id)))
    const preorderIdSet = new Set(normalizedTables.preorders.map((row) => stringifyComparableValue(row.id)))

    normalizedTables.preorders.forEach((row, index) => {
      if (!clientUserIdSet.has(stringifyComparableValue(row.clientUserId))) {
        throw new BizError(`preorders 第 ${index + 1} 行引用的客户端用户不存在`, 400)
      }
    })
    normalizedTables.preorderItems.forEach((row, index) => {
      if (!preorderIdSet.has(stringifyComparableValue(row.orderId))) {
        throw new BizError(`preorderItems 第 ${index + 1} 行引用的预订单不存在`, 400)
      }
      if (!productIdSet.has(stringifyComparableValue(row.productId))) {
        throw new BizError(`preorderItems 第 ${index + 1} 行引用的商品不存在`, 400)
      }
    })
    normalizedTables.inventoryLogs.forEach((row, index) => {
      if (!productIdSet.has(stringifyComparableValue(row.productId))) {
        throw new BizError(`inventoryLogs 第 ${index + 1} 行引用的商品不存在`, 400)
      }
    })

    return {
      exportedAt: payload.exportedAt.trim(),
      version: payload.version,
      tables: normalizedTables,
    }
  }

  async exportJson(actor: AuthUserContext, requestMeta?: RequestMeta): Promise<ExportPayload> {
    const adminActor = await this.assertAdminActor(actor, requestMeta, 'data_maintenance.export_json', '导出 JSON 数据')
    const tables = {} as ExportPayload['tables']
    for (const tableKey of EXPORT_TABLE_KEYS) {
      tables[tableKey] = await this.loadExportRows(tableKey)
    }
    const payload: ExportPayload = {
      exportedAt: new Date().toISOString(),
      version: EXPORT_VERSION,
      tables,
    }
    await auditService.safeRecord({
      actionType: 'data_maintenance.export_json',
      actionLabel: '导出 JSON 数据',
      targetType: 'data_maintenance',
      targetCode: payload.version,
      actor: adminActor,
      requestMeta,
      detail: {
        tableCounts: this.buildImportSummary(payload),
      },
    })
    return payload
  }

  async importJson(payload: ExportPayload, actor: AuthUserContext, requestMeta?: RequestMeta) {
    const adminActor = await this.assertAdminActor(actor, requestMeta, 'data_maintenance.import_json', '导入 JSON 数据')
    const normalizedPayload = this.validateExportPayload(payload)
    const importSummary = this.buildImportSummary(normalizedPayload)
    return AppDataSource.transaction(async (manager) => {
      await manager.getRepository(InventoryLog).clear()
      await manager.getRepository(O2oPreorderItem).clear()
      await manager.getRepository(O2oPreorder).clear()
      await manager.getRepository(ClientUser).clear()
      await manager.getRepository(BaseProduct).clear()
      await manager.getRepository(SystemConfig).clear()

      if (normalizedPayload.tables.systemConfigs.length > 0) {
        await manager.getRepository(SystemConfig).insert(normalizedPayload.tables.systemConfigs)
      }
      if (normalizedPayload.tables.products.length > 0) {
        await manager.getRepository(BaseProduct).insert(normalizedPayload.tables.products)
      }
      if (normalizedPayload.tables.clientUsers.length > 0) {
        await manager.getRepository(ClientUser).insert(normalizedPayload.tables.clientUsers)
      }
      if (normalizedPayload.tables.preorders.length > 0) {
        await manager.getRepository(O2oPreorder).insert(normalizedPayload.tables.preorders)
      }
      if (normalizedPayload.tables.preorderItems.length > 0) {
        await manager.getRepository(O2oPreorderItem).insert(normalizedPayload.tables.preorderItems)
      }
      if (normalizedPayload.tables.inventoryLogs.length > 0) {
        await manager.getRepository(InventoryLog).insert(normalizedPayload.tables.inventoryLogs)
      }

      await auditService.record(
        {
          actionType: 'data_maintenance.import_json',
          actionLabel: '导入 JSON 数据',
          targetType: 'data_maintenance',
          targetCode: normalizedPayload.version,
          actor: adminActor,
          requestMeta,
          detail: {
            exportedAt: normalizedPayload.exportedAt,
            version: normalizedPayload.version,
            imported: importSummary,
          },
        },
        manager,
      )
      return {
        imported: importSummary,
      }
    })
  }
}

export const dataMaintenanceService = new DataMaintenanceService()
