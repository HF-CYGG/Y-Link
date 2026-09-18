/**
 * 文件说明：YZ 通用 SKU 编码体系的核心编码服务，负责系列内序号分配、一级变体码/尺码码登记与编码拼接。
 * 实现逻辑：
 * - 系列内序号复用 inventory-sequence.service 的 business_sequence 行锁原语：新建商品走
 *   `allocateSequenceValue` 严格 +1；Excel 导入走新增的 `raiseSequenceFloor` 把序列游标抬高到导入
 *   携带的原序号，保证导入原序号不被后续新建分配占用，也不会重新从 1 分配造成撞号；
 * - 一级变体码 / 尺码码在 `acquireSequenceMutex` 持锁后按登记表 `base_product_variant_code_registry`
 *   的现状分配：命中已登记的规格取值直接复用其 code（这就是“不回收”的落地方式），未命中则从候选池
 *   （变体 '1'-'9'、尺码 'A'-'E'）取最小未占用码写入登记表；
 * - 商品无一级变体固定使用 '0' 且不写登记表；“0 号继承”“空尺码位继承”分别用 code='0' 正式登记、
 *   code='-' 哨兵登记表示，二者都只允许发生一次（哨兵 '-' 不在 A-E 候选池内，不占用尺码容量）。
 * 维护重点：
 * - 核心不变量——变体码 / 尺码码一经分配，永不因排序、改名、退役而变更或回收：本文件所有写操作只允许
 *   新增登记行，或者在 `renameRegistryValue` 里改写 specValue（改名），任何情况下都不能删除登记行、
 *   也不能更换已登记的 code；
 * - 所有导出函数都接收调用方事务内的 EntityManager，不自行开事务，必须与商品服务的其他写操作在同一
 *   事务内原子提交；
 * - 编号格式调整只改本文件的 format / pattern 函数，候选池与容量上限调整需要同步检查前端展示与导入校验。
 */

import type { EntityManager } from 'typeorm'
import { BaseProduct } from '../entities/base-product.entity.js'
import { BaseProductVariantCodeRegistry } from '../entities/base-product-variant-code-registry.entity.js'
import { SystemConfig } from '../entities/system-config.entity.js'
import { BizError } from '../utils/errors.js'
import { acquireSequenceMutex, allocateSequenceValue, raiseSequenceFloor } from './inventory-sequence.service.js'

const PRODUCT_CODE_PREFIX_CONFIG_KEY = 'product.yz_code.prefix'
const DEFAULT_PRODUCT_CODE_PREFIX = 'YZ'
const PRODUCT_CODE_PREFIX_PATTERN = /^[A-Z]{1,4}$/

/** 空尺码位继承的哨兵 code：不在 A-E 候选池内，仅用于占位、不产生尺码字母，也不计入 5 个容量上限。 */
export const EMPTY_SIZE_SENTINEL_CODE = '-'

// 导出候选池仅供“存量商品升级到 YZ 编码”的只读预检（previewProductYzUpgrade）模拟推算使用，
// 预检不能调用 resolveVariantCode/resolveSizeCode（那会真的写登记表），只能照同一份候选池自行模拟。
export const VARIANT_CODE_POOL = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const
export const SIZE_CODE_POOL = ['A', 'B', 'C', 'D', 'E'] as const

export type ProductCodeRegistryAxis = 'variant' | 'size'

export interface ResolveVariantCodeOptions {
  /** 把商品原本的 '0' 号（无一级变体）正式继承给该规格取值。仅当 '0' 尚未被登记时允许。 */
  inheritZeroCode?: boolean
}

export interface ResolveSizeCodeOptions {
  /** 把该规格取值登记为“空尺码位”（哨兵 code='-'），返回 null，用于商品原本无尺码、码长 7 位的继承场景。 */
  inheritEmptySize?: boolean
}

const normalizeSpecValue = (value: string | null | undefined): string | null => {
  const trimmed = (value ?? '').trim()
  return trimmed ? trimmed : null
}

const buildRegistryMutexKey = (productId: string, axis: ProductCodeRegistryAxis) =>
  `product_variant_registry.${productId}.${axis}`

/**
 * 读取 YZ 编码全局前缀（system_configs 的 product.yz_code.prefix）。
 * 读不到或值非法（不匹配 /^[A-Z]{1,4}$/）时回退默认值 'YZ'，不抛错——前缀配置异常不应阻断编码分配。
 */
export async function getProductCodePrefix(manager: EntityManager): Promise<string> {
  const config = await manager.getRepository(SystemConfig).findOneBy({ configKey: PRODUCT_CODE_PREFIX_CONFIG_KEY })
  const value = (config?.configValue ?? '').trim()
  return PRODUCT_CODE_PREFIX_PATTERN.test(value) ? value : DEFAULT_PRODUCT_CODE_PREFIX
}

/**
 * 新建商品时分配该系列的下一个序号（1-99）。
 * 首次分配时以库内该系列已有商品的最大 series_seq 为起点，兼容导入时预占过的序号。
 */
export async function allocateSeriesSeq(manager: EntityManager, seriesTagId: string): Promise<number> {
  const sequenceKey = `product_series_seq.${seriesTagId}`
  const value = await allocateSequenceValue(manager, sequenceKey, async () => {
    const row = await manager.getRepository(BaseProduct)
      .createQueryBuilder('product')
      .select('MAX(product.seriesSeq)', 'maxSeq')
      .where('product.primarySeriesTagId = :seriesTagId', { seriesTagId })
      .getRawOne<{ maxSeq: string | number | null }>()
    return Number(row?.maxSeq ?? 0)
  })
  if (value > 99) {
    throw new BizError('该系列商品数量已达上限（99），无法继续分配序号', 409)
  }
  return value
}

/**
 * Excel 导入专用：占用一个指定序号。导入必须保留 Excel 原序号，不能像新建那样重新分配。
 * 把序列游标抬高到 seq（而不是 +1），后续 allocateSeriesSeq 会从 seq 继续分配。
 */
export async function reserveSeriesSeq(manager: EntityManager, seriesTagId: string, seq: number): Promise<void> {
  if (!Number.isInteger(seq) || seq < 1 || seq > 99) {
    throw new BizError('预占的系列内序号必须是 1 到 99 之间的整数', 400)
  }
  await raiseSequenceFloor(manager, `product_series_seq.${seriesTagId}`, seq)
}

/**
 * 一级变体码分配（核心不变量：一经登记永不回收，见文件头注释）。
 * specValue 为空表示该商品无一级变体，固定返回 '0' 且不写登记表。
 */
export async function resolveVariantCode(
  manager: EntityManager,
  productId: string,
  specValue: string | null | undefined,
  options?: ResolveVariantCodeOptions,
): Promise<string> {
  const normalized = normalizeSpecValue(specValue)
  if (!normalized) return '0'

  await acquireSequenceMutex(manager, buildRegistryMutexKey(productId, 'variant'))
  const registryRepo = manager.getRepository(BaseProductVariantCodeRegistry)

  const existing = await registryRepo.findOneBy({ productId, axis: 'variant', specValue: normalized })
  if (existing) return existing.code

  const occupiedRows = await registryRepo.find({ where: { productId, axis: 'variant' }, select: { code: true } })
  const occupied = new Set(occupiedRows.map((row) => row.code))

  let code: string
  if (options?.inheritZeroCode) {
    if (occupied.has('0')) {
      throw new BizError('该商品的 0 号规格已被其他取值继承', 409)
    }
    code = '0'
  } else {
    const candidate = VARIANT_CODE_POOL.find((value) => !occupied.has(value))
    if (!candidate) {
      throw new BizError('该商品一级变体已达 9 个上限，YZ 编码规则不支持更多变体', 409)
    }
    code = candidate
  }

  await registryRepo.insert(registryRepo.create({ productId, axis: 'variant', specValue: normalized, code }))
  return code
}

/**
 * 尺码码分配（核心不变量同上）。specValue 为空表示无尺码位，返回 null（skuCode 不补任何字符）。
 */
export async function resolveSizeCode(
  manager: EntityManager,
  productId: string,
  specValue: string | null | undefined,
  options?: ResolveSizeCodeOptions,
): Promise<string | null> {
  const normalized = normalizeSpecValue(specValue)
  if (!normalized) return null

  await acquireSequenceMutex(manager, buildRegistryMutexKey(productId, 'size'))
  const registryRepo = manager.getRepository(BaseProductVariantCodeRegistry)

  const existing = await registryRepo.findOneBy({ productId, axis: 'size', specValue: normalized })
  if (existing) return existing.code === EMPTY_SIZE_SENTINEL_CODE ? null : existing.code

  const occupiedRows = await registryRepo.find({ where: { productId, axis: 'size' }, select: { code: true } })
  const occupied = new Set(occupiedRows.map((row) => row.code))

  if (options?.inheritEmptySize) {
    if (occupied.has(EMPTY_SIZE_SENTINEL_CODE)) {
      throw new BizError('该商品的空尺码位已被其他规格取值继承，不能重复继承', 409)
    }
    await registryRepo.insert(registryRepo.create({
      productId, axis: 'size', specValue: normalized, code: EMPTY_SIZE_SENTINEL_CODE,
    }))
    return null
  }

  const candidate = SIZE_CODE_POOL.find((value) => !occupied.has(value))
  if (!candidate) {
    throw new BizError('该商品尺码已达 5 个上限（A-E）', 409)
  }
  await registryRepo.insert(registryRepo.create({ productId, axis: 'size', specValue: normalized, code: candidate }))
  return candidate
}

/**
 * 重命名规格取值：只改登记行的 specValue，code 保持不变——这是保证“印刷条码不因改名失效”的关键。
 */
export async function renameRegistryValue(
  manager: EntityManager,
  productId: string,
  axis: ProductCodeRegistryAxis,
  oldValue: string,
  newValue: string,
): Promise<void> {
  const normalizedOld = oldValue.trim()
  const normalizedNew = newValue.trim()

  await acquireSequenceMutex(manager, buildRegistryMutexKey(productId, axis))
  const registryRepo = manager.getRepository(BaseProductVariantCodeRegistry)

  const existing = await registryRepo.findOneBy({ productId, axis, specValue: normalizedOld })
  if (!existing) {
    throw new BizError(`未找到规格取值「${normalizedOld}」对应的编码登记记录`, 404)
  }
  if (normalizedNew !== normalizedOld) {
    const conflict = await registryRepo.findOneBy({ productId, axis, specValue: normalizedNew })
    if (conflict) {
      throw new BizError('该规格取值已存在', 409)
    }
  }
  existing.specValue = normalizedNew
  await registryRepo.save(existing)
}

/** 拼接 productCode：前缀 + 两位系列码 + 两位系列内序号（补零）。 */
export function formatProductCode(prefix: string, seriesCode: string, seriesSeq: number): string {
  return `${prefix}${seriesCode}${String(seriesSeq).padStart(2, '0')}`
}

/** 拼接 skuCode：productCode + 一级变体码 + 可选尺码码（无尺码位时不补任何字符）。 */
export function formatSkuCode(productCode: string, variantCode: string, sizeCode: string | null): string {
  return `${productCode}${variantCode}${sizeCode ?? ''}`
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** productCode 正则：前缀 + 两位大写字母系列码 + 两位数字序号。 */
export function buildProductCodePattern(prefix: string): RegExp {
  return new RegExp(`^${escapeRegExp(prefix)}[A-Z]{2}\\d{2}$`)
}

/** skuCode 正则：productCode 结构 + 一位数字变体码 + 可选一位 A-E 尺码码。 */
export function buildSkuCodePattern(prefix: string): RegExp {
  return new RegExp(`^${escapeRegExp(prefix)}[A-Z]{2}\\d{2}[0-9][A-E]?$`)
}

/** 校验系列编码必须是两位大写字母，非法则抛 400。 */
export function assertSeriesCode(value: string): string {
  if (!/^[A-Z]{2}$/.test(value)) {
    throw new BizError('系列编码必须是两位大写字母', 400)
  }
  return value
}
