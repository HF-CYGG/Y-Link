/**
 * 模块说明：backend/src/services/data-maintenance.shared.ts
 * 文件职责：沉淀数据维护模块可复用的导出结构类型、字段校验器、行映射器与导入摘要构建逻辑。
 * 实现逻辑：
 * 1. 统一声明导入导出所依赖的表清单、版本信息与载荷类型，避免服务文件重复维护结构定义。
 * 2. 通过字段读取器与表级校验函数，把原始 JSON 行映射为可直接入库的标准对象，同时保留原有报错文案。
 * 3. 对跨表引用和摘要统计做独立封装，让服务层只负责流程编排、事务和审计，不再混杂大量校验细节。
 */

import { CLIENT_USER_STATUSES } from '../entities/client-user.entity.js'
import {
  O2O_CLIENT_ORDER_TYPES,
  O2O_PREORDER_BUSINESS_STATUSES,
  O2O_PREORDER_CANCEL_REASONS,
  O2O_PREORDER_STATUSES,
} from '../entities/o2o-preorder.entity.js'
import { BizError } from '../utils/errors.js'

export const EXPORT_VERSION = 'data-maintenance-v2'
const SUPPORTED_IMPORT_VERSIONS = new Set(['o2o-preorder-v1', EXPORT_VERSION])
export const EXPORT_TABLE_KEYS = ['systemConfigs', 'products', 'clientUsers', 'preorders', 'preorderItems', 'inventoryLogs'] as const

export type ExportTableKey = (typeof EXPORT_TABLE_KEYS)[number]
export type ExportRow = Record<string, unknown>
export type ExportPayload = {
  exportedAt: string
  version: string
  tables: Record<ExportTableKey, ExportRow[]>
}
export type ImportSummary = Record<ExportTableKey, number>

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
 * - 同时保留深拷贝行为，防止后续对实体实例做原地污染。
 */
export function cloneForExportRows<T extends object>(rows: T[]): ExportRow[] {
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

function assertUniqueFieldValues(rows: ExportRow[], field: string, label: string) {
  const uniqueSet = new Set<string>()
  rows.forEach((row, index) => {
    const comparableValue = stringifyComparableValue(row[field])
    if (uniqueSet.has(comparableValue)) {
      throw new BizError(`${label}存在重复值：第 ${index + 1} 行`, 400)
    }
    uniqueSet.add(comparableValue)
  })
}

/**
 * 把“结构合法性 + 行映射 + 唯一键校验”收口为统一模板：
 * - 每张表只需要关注字段如何读取与额外业务约束；
 * - 统一保留原有“第 N 行结构非法/字段非法”的报错格式，避免重构后行为漂移。
 */
function mapAndValidateRows(
  rows: ExportRow[],
  tableKey: ExportTableKey,
  mapper: (rawRow: Record<string, unknown>, index: number) => ExportRow,
  uniqueFields: Array<{ field: string; label: string }>,
) {
  const normalizedRows = rows.map((rawRow, index) => {
    if (!isPlainObject(rawRow)) {
      throw new BizError(`${tableKey} 第 ${index + 1} 行结构非法`, 400)
    }
    return mapper(rawRow, index)
  })
  uniqueFields.forEach(({ field, label }) => {
    assertUniqueFieldValues(normalizedRows, field, label)
  })
  return normalizedRows
}

function validateSystemConfigRows(rows: ExportRow[]) {
  return mapAndValidateRows(
    rows,
    'systemConfigs',
    (rawRow) => ({
      id: readRequiredIdentifier(rawRow, 'id', '系统配置ID'),
      configKey: readRequiredText(rawRow, 'configKey', '系统配置键', 128),
      configValue: readRequiredRawText(rawRow, 'configValue', '系统配置值', 20000),
      configGroup: readRequiredText(rawRow, 'configGroup', '系统配置分组', 64),
      remark: readOptionalText(rawRow, 'remark', 255),
      createdAt: readRequiredDateText(rawRow, 'createdAt', '系统配置创建时间'),
      updatedAt: readRequiredDateText(rawRow, 'updatedAt', '系统配置更新时间'),
    }),
    [
      { field: 'id', label: 'systemConfigs.id' },
      { field: 'configKey', label: 'systemConfigs.configKey' },
    ],
  )
}

function validateProductRows(rows: ExportRow[]) {
  return mapAndValidateRows(
    rows,
    'products',
    (rawRow, index) => {
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
    },
    [
      { field: 'id', label: 'products.id' },
      { field: 'productCode', label: 'products.productCode' },
    ],
  )
}

function validateClientUserRows(rows: ExportRow[]) {
  return mapAndValidateRows(
    rows,
    'clientUsers',
    (rawRow, index) => {
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
    },
    [{ field: 'id', label: 'clientUsers.id' }],
  )
}

function validatePreorderRows(rows: ExportRow[]) {
  return mapAndValidateRows(
    rows,
    'preorders',
    (rawRow) => {
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
    },
    [
      { field: 'id', label: 'preorders.id' },
      { field: 'showNo', label: 'preorders.showNo' },
      { field: 'verifyCode', label: 'preorders.verifyCode' },
    ],
  )
}

function validatePreorderItemRows(rows: ExportRow[]) {
  return mapAndValidateRows(
    rows,
    'preorderItems',
    (rawRow) => ({
      id: readRequiredIdentifier(rawRow, 'id', '预订单明细ID'),
      orderId: readRequiredIdentifier(rawRow, 'orderId', '预订单明细所属订单ID'),
      productId: readRequiredIdentifier(rawRow, 'productId', '预订单明细商品ID'),
      qty: readInteger(rawRow, 'qty', '预订单明细数量', { min: 1, max: 999999 }),
    }),
    [{ field: 'id', label: 'preorderItems.id' }],
  )
}

function validateInventoryLogRows(rows: ExportRow[]) {
  return mapAndValidateRows(
    rows,
    'inventoryLogs',
    (rawRow) => ({
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
    }),
    [{ field: 'id', label: 'inventoryLogs.id' }],
  )
}

/**
 * 表级校验器映射：
 * - 统一把“哪张表交给哪个校验器”声明为常量，方便服务层和未来脚本复用；
 * - 新增导入表时只需在此补齐映射与类型，不需要改动事务流程代码。
 */
const TABLE_ROW_VALIDATORS: Record<ExportTableKey, (rows: ExportRow[]) => ExportRow[]> = {
  systemConfigs: validateSystemConfigRows,
  products: validateProductRows,
  clientUsers: validateClientUserRows,
  preorders: validatePreorderRows,
  preorderItems: validatePreorderItemRows,
  inventoryLogs: validateInventoryLogRows,
}

function assertCrossTableReferences(tables: ExportPayload['tables']) {
  const productIdSet = new Set(tables.products.map((row) => stringifyComparableValue(row.id)))
  const clientUserIdSet = new Set(tables.clientUsers.map((row) => stringifyComparableValue(row.id)))
  const preorderIdSet = new Set(tables.preorders.map((row) => stringifyComparableValue(row.id)))

  tables.preorders.forEach((row, index) => {
    if (!clientUserIdSet.has(stringifyComparableValue(row.clientUserId))) {
      throw new BizError(`preorders 第 ${index + 1} 行引用的客户端用户不存在`, 400)
    }
  })
  tables.preorderItems.forEach((row, index) => {
    if (!preorderIdSet.has(stringifyComparableValue(row.orderId))) {
      throw new BizError(`preorderItems 第 ${index + 1} 行引用的预订单不存在`, 400)
    }
    if (!productIdSet.has(stringifyComparableValue(row.productId))) {
      throw new BizError(`preorderItems 第 ${index + 1} 行引用的商品不存在`, 400)
    }
  })
  tables.inventoryLogs.forEach((row, index) => {
    if (!productIdSet.has(stringifyComparableValue(row.productId))) {
      throw new BizError(`inventoryLogs 第 ${index + 1} 行引用的商品不存在`, 400)
    }
  })
}

/**
 * 构建导入摘要：
 * - 导出与导入都只关心各表条数，不必感知具体数据内容；
 * - 统一放到共享文件后，可被服务、脚本或后续运维工具直接复用。
 */
export function buildImportSummary(payload: ExportPayload): ImportSummary {
  return Object.fromEntries(EXPORT_TABLE_KEYS.map((tableKey) => [tableKey, payload.tables[tableKey].length])) as ImportSummary
}

/**
 * 导入载荷总校验：
 * - 先校验版本、tables 结构和未知表；
 * - 再使用表级校验器把每张表映射为标准入库对象；
 * - 最后校验跨表引用，确保事务开始前就能发现结构性问题。
 */
export function validateExportPayload(payload: ExportPayload): ExportPayload {
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
    normalizedTables[tableKey] = TABLE_ROW_VALIDATORS[tableKey](tableRows)
  })

  assertCrossTableReferences(normalizedTables)

  return {
    exportedAt: payload.exportedAt.trim(),
    version: payload.version,
    tables: normalizedTables,
  }
}
