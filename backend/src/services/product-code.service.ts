/**
 * 文件说明：YZ 通用 SKU 编码体系的核心编码服务，负责系列内序号分配、一级变体码/尺码码登记与编码拼接。
 * 实现逻辑：
 * - 系列内序号复用 inventory-sequence.service 的 business_sequence 行锁原语：新建商品走
 *   `allocateSequenceValue` 严格 +1；Excel 导入走新增的 `raiseSequenceFloor` 把序列游标抬高到导入
 *   携带的原序号，保证导入原序号不被后续新建分配占用，也不会重新从 1 分配造成撞号；
 * - PR #109 第四轮评审 P1 修复：仅凭 business_sequence 的最高水位无法拦住"删除商品后重新分配到完全
 *   相同序号"的问题（物理删除会让该序号看起来"没人用"）。因此新增永久占用登记表
 *   `base_yz_series_seq_reservation`：`allocateSeriesSeq` 取号与 `reserveSeriesSeq` 预占号都会跳过 /
 *   拒绝已登记过的序号，并在成功后写入登记，登记只增不减，不随商品删除而清除；
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
import { BaseYzSeriesSeqReservation } from '../entities/base-yz-series-seq-reservation.entity.js'
import { SystemConfig } from '../entities/system-config.entity.js'
import { BizError } from '../utils/errors.js'
import { acquireSequenceMutex, allocateSequenceValue, raiseSequenceFloor } from './inventory-sequence.service.js'

const PRODUCT_CODE_PREFIX_CONFIG_KEY = 'product.yz_code.prefix'
const DEFAULT_PRODUCT_CODE_PREFIX = 'YZ'
const PRODUCT_CODE_PREFIX_PATTERN = /^[A-Z]{1,4}$/

/** 空尺码位继承的哨兵 code：不在 A-E 候选池内，仅用于占位、不产生尺码字母，也不计入 5 个容量上限。 */
export const EMPTY_SIZE_SENTINEL_CODE = '-'

/**
 * 规格取值登记表 base_product_variant_code_registry.spec_value 列的最大长度（VARCHAR(64)）。
 * P2-D 修复：路由 schema、服务层重命名校验与 Excel 导入校验必须共用同一常量，避免各处各写一份
 * 魔法数字导致数据库列上限调整时遗漏某处、或三处口径不一致。
 */
export const SPEC_VALUE_MAX_LENGTH = 64

/** 系列码互斥键：标签改系列码（tag.service.ts）与 YZ 建档/升级读取系列码（product.service.ts）
 *  必须用这同一把互斥锁串行化，见 P2-C 修复。 */
export const buildSeriesCodeMutexKey = (tagId: string): string => `tag_series_code.${tagId}`

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
 * 只读查询：某个系列的某个序号是否已被永久占用登记表登记过（PR #109 第四轮评审 P1 修复）。
 * 导入预览阶段与 allocateSeriesSeq/reserveSeriesSeq 共用这个查询，保证“预览提示的冲突”与
 * “真正执行时会抛出的冲突”完全是同一个判断口径。
 */
export async function findYzSeriesSeqReservation(
  manager: EntityManager,
  seriesTagId: string,
  seq: number,
): Promise<BaseYzSeriesSeqReservation | null> {
  return manager.getRepository(BaseYzSeriesSeqReservation).findOneBy({ seriesTagId, seriesSeq: seq })
}

/**
 * 新建商品时分配该系列的下一个序号（1-99）。
 * 首次分配时以库内该系列已有商品的最大 series_seq 为起点，兼容导入时预占过的序号。
 * P1 修复：取号时同时参考永久占用登记表——一个序号即使当前没有任何商品在用（例如对应商品已被物理
 * 删除），只要历史上被分配/预占过，就必须跳过，不能被重新分配出去，否则会与已经打印过的旧标签撞码。
 * 分配到号后立即写入登记表，登记永久生效，不会因商品后续被删除而清除。
 */
export async function allocateSeriesSeq(
  manager: EntityManager,
  seriesTagId: string,
  seriesCode: string,
  prefix: string,
): Promise<number> {
  const sequenceKey = `product_series_seq.${seriesTagId}`
  const reservationRepo = manager.getRepository(BaseYzSeriesSeqReservation)

  let value: number
  for (;;) {
    // 序号需要逐个试探是否已被永久占用登记，只能按候选顺序依次等待上一次结果，不能并发发起。
    value = await allocateSequenceValue(manager, sequenceKey, async () => {
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
    const reserved = await reservationRepo.exists({ where: { seriesTagId, seriesSeq: value } })
    if (!reserved) break
    // 该号历史上已被分配/预占过（对应商品可能已被删除），跳过继续取下一个，不重新分配给新商品。
  }

  const productCode = formatProductCode(prefix, seriesCode, value)
  await reservationRepo.insert(reservationRepo.create({ seriesTagId, seriesSeq: value, productCode }))
  return value
}

/**
 * Excel 导入专用：占用一个指定序号。导入必须保留 Excel 原序号，不能像新建那样重新分配。
 * 把序列游标抬高到 seq（而不是 +1），后续 allocateSeriesSeq 会从 seq 继续分配。
 * P1 修复：写入前先查永久占用登记表，命中则说明该系列的该序号此前已经分配过（不论对应商品是否还
 * 存在），为避免旧标签指向新商品，一律拒绝复用，抛 409 并在文案中带出历史 productCode 供人工核对。
 */
export async function reserveSeriesSeq(
  manager: EntityManager,
  seriesTagId: string,
  seq: number,
  seriesCode: string,
  prefix: string,
): Promise<void> {
  if (!Number.isInteger(seq) || seq < 1 || seq > 99) {
    throw new BizError('预占的系列内序号必须是 1 到 99 之间的整数', 400)
  }
  // 与 allocateSeriesSeq 共用同一把序列行锁，串行化“查占用登记 + 抬升游标 + 写占用登记”整个过程，
  // 避免并发导入两次都读到“未占用”后同时写入登记表撞唯一键。
  await acquireSequenceMutex(manager, `product_series_seq.${seriesTagId}`)

  const existing = await findYzSeriesSeqReservation(manager, seriesTagId, seq)
  if (existing) {
    throw new BizError(
      `该系列的序号 ${seq} 此前已分配过（历史编码 ${existing.productCode}），为避免旧标签指向新商品，不允许复用，请改用其它序号`,
      409,
    )
  }

  await raiseSequenceFloor(manager, `product_series_seq.${seriesTagId}`, seq)
  const productCode = formatProductCode(prefix, seriesCode, seq)
  const reservationRepo = manager.getRepository(BaseYzSeriesSeqReservation)
  await reservationRepo.insert(reservationRepo.create({ seriesTagId, seriesSeq: seq, productCode }))
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
  const registryRepo = manager.getRepository(BaseProductVariantCodeRegistry)

  if (!normalized) {
    // P1-B 修复：0 号编码位一旦通过 inheritZeroCode 正式继承给某个具体取值，就不能再被空规格（未选
    // 一级变体）重新占用——否则空规格与已继承的具体取值会拼出完全相同的 skuCode（规格组合不同、编码
    // 却相同），被下游的重复编码兜底逻辑追加非法的 `-2` 后缀。加锁后查登记表，保证与继承操作互斥。
    await acquireSequenceMutex(manager, buildRegistryMutexKey(productId, 'variant'))
    const inherited = await registryRepo.findOneBy({ productId, axis: 'variant', code: '0' })
    if (inherited) {
      throw new BizError('该商品的 0 号编码位已继承给某个具体规格取值，不能再用空规格占用，请为该规格轴指定取值', 409)
    }
    return '0'
  }

  await acquireSequenceMutex(manager, buildRegistryMutexKey(productId, 'variant'))

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
  const registryRepo = manager.getRepository(BaseProductVariantCodeRegistry)

  if (!normalized) {
    // P1-B 修复：空尺码位一旦通过 inheritEmptySize 正式继承（哨兵 code='-'）给某个具体取值，就不能再被
    // 空尺码重新占用，理由与 resolveVariantCode 的 0 号继承检查完全一致。
    await acquireSequenceMutex(manager, buildRegistryMutexKey(productId, 'size'))
    const inherited = await registryRepo.findOneBy({ productId, axis: 'size', code: EMPTY_SIZE_SENTINEL_CODE })
    if (inherited) {
      throw new BizError('该商品的空尺码编码位已继承给某个具体规格取值，不能再用空规格占用，请为该规格轴指定取值', 409)
    }
    return null
  }

  await acquireSequenceMutex(manager, buildRegistryMutexKey(productId, 'size'))

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
