/**
 * 模块说明：规格分库位库存服务。
 * 文件职责：读取 SKU 在各库位的件数分布，并在调用方事务内完成库位间拨转、主库位切换、按库位增减与扣减后的规整。
 * 实现逻辑：
 * - SKU 物理总库存仍以 base_product_sku.current_stock 为唯一口径；inv_sku_location_stock 只记“主库位以外”的件数；
 * - 主库位件数 = 总库存 − 其他库位件数之和，所以入库、退货等增加库存时件数自然落在主库位，无需改动这些链路；
 * - 扣减物理库存时先扣主库位，主库位不够再按库位编码升序扣其他库位：调用方改完 current_stock 后
 *   在同一事务内调用 reconcileSkuLocationStocks，它会把“其他库位之和”压回总库存以内并返回扣减明细；
 * - 主库位为空（未设置库位）时，主库位件数表示“未放到任何库位”的件数，规则不变。
 * 维护重点：
 * - 所有写函数都要求调用方已在同一事务内按“商品 → SKU”锁定目标 SKU，本模块再锁该 SKU 的分库位行；
 * - 必须在扣减当场规整，不能只在读取时折算：例如先扣 8 件、再入 5 件，延后规整会把入库件数错算到其他库位；
 * - 新增扣减物理库存的写路径时，要么走 inventory-ledger.service 的 applyInventoryDeltas，要么在改完库存后调用本模块规整。
 */

import { In, type EntityManager } from 'typeorm'
import { MAX_DATABASE_INT } from '../constants/web-resource-limits.js'
import { BaseProductSku } from '../entities/base-product-sku.entity.js'
import { BaseStorageLocation } from '../entities/base-storage-location.entity.js'
import { InvSkuLocationStock } from '../entities/inv-sku-location-stock.entity.js'
import { BizError } from '../utils/errors.js'

export interface SkuLocationQty {
  locationId: string
  locationCode: string
  qty: number
}

export interface SkuLocationDistribution {
  skuId: string
  /** 主库位 ID；为空表示未设置库位。 */
  mainLocationId: string | null
  mainLocationCode: string | null
  /** 主库位件数 = 总库存 − 其他库位件数之和。 */
  mainQty: number
  /** 主库位以外的库位，按库位编码升序。 */
  others: SkuLocationQty[]
}

export interface SkuLocationDeduction {
  locationId: string
  locationCode: string
  qty: number
}

type SkuStockLike = Pick<BaseProductSku, 'id' | 'locationId' | 'currentStock'> & { skuCode?: string }

const normalizeId = (value: unknown) => String(value ?? '').trim()
const normalizeNullableId = (value: unknown) => {
  const id = normalizeId(value)
  return id ? id : null
}
const byLocationCode = (left: { locationCode: string }, right: { locationCode: string }) => left.locationCode.localeCompare(right.locationCode)

interface StockRowWithCode {
  row: InvSkuLocationStock
  locationCode: string
}

/** 读取一批 SKU 的分库位行（附库位编码），可选加写锁。 */
async function loadRows(manager: EntityManager, skuIds: string[], lock: boolean): Promise<Map<string, StockRowWithCode[]>> {
  const ids = [...new Set(skuIds.map(normalizeId).filter(Boolean))]
  const result = new Map<string, StockRowWithCode[]>()
  if (!ids.length) return result
  const query = manager.getRepository(InvSkuLocationStock)
    .createQueryBuilder('stock')
    .where('stock.skuId IN (:...ids)', { ids })
    .orderBy('stock.skuId', 'ASC')
    .addOrderBy('stock.locationId', 'ASC')
  if (lock && manager.connection.options.type !== 'sqlite') query.setLock('pessimistic_write')
  const rows = await query.getMany()
  const locationIds = [...new Set(rows.map((row) => normalizeId(row.locationId)))]
  const locations = locationIds.length
    ? await manager.getRepository(BaseStorageLocation).find({ where: { id: In(locationIds) }, select: ['id', 'locationCode'] })
    : []
  const codeMap = new Map(locations.map((location) => [normalizeId(location.id), location.locationCode]))
  for (const row of rows) {
    const skuId = normalizeId(row.skuId)
    const list = result.get(skuId) ?? []
    list.push({ row, locationCode: codeMap.get(normalizeId(row.locationId)) ?? normalizeId(row.locationId) })
    result.set(skuId, list)
  }
  for (const list of result.values()) list.sort((left, right) => byLocationCode(left, right))
  return result
}

async function loadLocationCodes(manager: EntityManager, locationIds: Array<string | null>) {
  const ids = [...new Set(locationIds.filter((id): id is string => Boolean(id)))]
  if (!ids.length) return new Map<string, string>()
  const rows = await manager.getRepository(BaseStorageLocation).find({ where: { id: In(ids) }, select: ['id', 'locationCode'] })
  return new Map(rows.map((row) => [normalizeId(row.id), row.locationCode]))
}

/**
 * 只读：按当前数据计算一批 SKU 的库位分布，用于列表与详情展示。
 * 正常情况下写路径已规整，这里仍对“其他库位之和超过总库存”的异常数据按扣减规则折算展示，避免出现负数主库位件数。
 */
export async function loadSkuLocationDistributions(
  manager: EntityManager,
  skus: SkuStockLike[],
): Promise<Map<string, SkuLocationDistribution>> {
  const rowMap = await loadRows(manager, skus.map((sku) => normalizeId(sku.id)), false)
  const mainCodes = await loadLocationCodes(manager, skus.map((sku) => normalizeNullableId(sku.locationId)))
  const result = new Map<string, SkuLocationDistribution>()
  for (const sku of skus) {
    const skuId = normalizeId(sku.id)
    const mainLocationId = normalizeNullableId(sku.locationId)
    const total = Math.max(0, Number(sku.currentStock ?? 0))
    const others: SkuLocationQty[] = []
    for (const { row, locationCode } of rowMap.get(skuId) ?? []) {
      const qty = Math.max(0, Number(row.qty ?? 0))
      if (!qty) continue
      // 与主库位相同的行视为主库位件数（主库位件数由总库存倒推，不单独累加）。
      if (normalizeId(row.locationId) === mainLocationId) continue
      others.push({ locationId: normalizeId(row.locationId), locationCode, qty })
    }
    const othersTotal = others.reduce((sum, item) => sum + item.qty, 0)
    if (othersTotal > total) {
      // 异常折算：主库位先归零，再按库位编码升序扣减其他库位。
      let remaining = total
      for (const item of others) {
        const keep = Math.min(item.qty, remaining)
        remaining -= keep
        item.qty = keep
      }
    }
    const visibleOthers = others.filter((item) => item.qty > 0)
    const visibleTotal = visibleOthers.reduce((sum, item) => sum + item.qty, 0)
    result.set(skuId, {
      skuId,
      mainLocationId,
      mainLocationCode: mainLocationId ? mainCodes.get(mainLocationId) ?? null : null,
      mainQty: Math.max(0, total - visibleTotal),
      others: visibleOthers,
    })
  }
  return result
}

/**
 * 写路径：在扣减物理库存后规整分库位行，保证“其他库位之和 ≤ 总库存”。
 * - 与主库位相同的行并回主库位（删除该行，件数自然计入主库位）；件数为 0 或负数的行删除；
 * - 其他库位之和超过总库存时，超出部分按库位编码升序依次扣减（主库位此时已经为 0）。
 * 调用方必须已锁定 SKU，并传入改完 current_stock 后的 SKU 实体。返回每个 SKU 实际被扣减的其他库位明细。
 */
export async function reconcileSkuLocationStocks(
  manager: EntityManager,
  skus: SkuStockLike[],
): Promise<Map<string, SkuLocationDeduction[]>> {
  const deductions = new Map<string, SkuLocationDeduction[]>()
  if (!skus.length) return deductions
  const rowMap = await loadRows(manager, skus.map((sku) => normalizeId(sku.id)), true)
  const repo = manager.getRepository(InvSkuLocationStock)
  for (const sku of skus) {
    const skuId = normalizeId(sku.id)
    const rows = rowMap.get(skuId) ?? []
    if (!rows.length) continue
    const mainLocationId = normalizeNullableId(sku.locationId)
    const total = Math.max(0, Number(sku.currentStock ?? 0))
    const removeIds: string[] = []
    const kept: StockRowWithCode[] = []
    for (const entry of rows) {
      if (normalizeId(entry.row.locationId) === mainLocationId || Number(entry.row.qty) <= 0) {
        removeIds.push(normalizeId(entry.row.id))
      } else {
        kept.push(entry)
      }
    }
    let overflow = kept.reduce((sum, entry) => sum + Number(entry.row.qty), 0) - total
    const skuDeductions: SkuLocationDeduction[] = []
    for (const entry of kept) {
      if (overflow <= 0) break
      const take = Math.min(Number(entry.row.qty), overflow)
      overflow -= take
      skuDeductions.push({ locationId: normalizeId(entry.row.locationId), locationCode: entry.locationCode, qty: take })
      const next = Number(entry.row.qty) - take
      if (next <= 0) removeIds.push(normalizeId(entry.row.id))
      else await repo.update({ id: entry.row.id }, { qty: next })
    }
    if (removeIds.length) await repo.delete({ id: In(removeIds) })
    if (skuDeductions.length) deductions.set(skuId, skuDeductions)
  }
  return deductions
}

/** 读取单个 SKU 在指定库位的件数（主库位返回主库位件数），调用方需已锁定 SKU。 */
export async function readSkuLocationQty(manager: EntityManager, sku: SkuStockLike, locationId: string | null): Promise<number> {
  const rows = (await loadRows(manager, [normalizeId(sku.id)], true)).get(normalizeId(sku.id)) ?? []
  const mainLocationId = normalizeNullableId(sku.locationId)
  const othersTotal = rows
    .filter((entry) => normalizeId(entry.row.locationId) !== mainLocationId)
    .reduce((sum, entry) => sum + Math.max(0, Number(entry.row.qty)), 0)
  const mainQty = Math.max(0, Number(sku.currentStock ?? 0) - othersTotal)
  const target = normalizeNullableId(locationId)
  if (target === mainLocationId) return mainQty
  if (!target) return 0
  const row = rows.find((entry) => normalizeId(entry.row.locationId) === target)
  return row ? Math.max(0, Number(row.row.qty)) : 0
}

async function upsertRowQty(manager: EntityManager, skuId: string, locationId: string, delta: number) {
  const repo = manager.getRepository(InvSkuLocationStock)
  const existing = await repo.findOne({ where: { skuId, locationId } })
  const next = Number(existing?.qty ?? 0) + delta
  if (next < 0) throw new BizError('库位件数不足，请刷新后重试', 409)
  if (next > MAX_DATABASE_INT) throw new BizError('库位件数超过系统可处理上限', 409)
  if (existing) {
    if (next === 0) await repo.delete({ id: existing.id })
    else await repo.update({ id: existing.id }, { qty: next })
    return
  }
  if (next > 0) await repo.insert(repo.create({ skuId, locationId, qty: next }))
}

/**
 * 按库位增减：配合 current_stock 同步增减 delta，使指定库位件数变化 delta、其他库位不受影响。
 * - 指定库位就是主库位（含未设置库位）时无需写行，主库位件数随总库存自动变化；
 * - 指定的是其他库位时增减该行件数，扣减不得超过该库位现有件数。
 * 调用方负责在同一事务内把 current_stock 也改动 delta，并已锁定 SKU。
 */
export async function applySkuLocationDelta(
  manager: EntityManager,
  sku: SkuStockLike,
  locationId: string | null,
  delta: number,
): Promise<void> {
  if (!Number.isSafeInteger(delta) || delta === 0) return
  const target = normalizeNullableId(locationId)
  if (target === normalizeNullableId(sku.locationId) || !target) {
    if (delta < 0) {
      const mainQty = await readSkuLocationQty(manager, sku, normalizeNullableId(sku.locationId))
      if (mainQty + delta < 0) {
        throw new BizError(`规格 ${sku.skuCode ?? normalizeId(sku.id)} 在主库位的件数不足（现有 ${mainQty}，需要 ${-delta}）`, 409)
      }
    }
    return
  }
  const current = await readSkuLocationQty(manager, sku, target)
  if (current + delta < 0) {
    const codes = await loadLocationCodes(manager, [target])
    throw new BizError(`规格 ${sku.skuCode ?? normalizeId(sku.id)} 在库位 ${codes.get(target) ?? target} 的件数不足（现有 ${current}，需要 ${-delta}）`, 409)
  }
  await upsertRowQty(manager, normalizeId(sku.id), target, delta)
}

export interface TransferSkuLocationInput {
  /** 来源库位；等于主库位（或主库位为空时传 null）表示从主库位拨出。 */
  fromLocationId: string | null
  toLocationId: string
  qty: number
  /** 拨转后把目标库位设为主库位：原主库位剩余件数转为原主库位的其他库位行。 */
  setAsMain?: boolean
}

export interface TransferSkuLocationResult {
  before: SkuLocationDistribution
  after: SkuLocationDistribution
  mainChanged: boolean
}

/**
 * 库位间拨转：总库存不变，只调整件数所在的库位。调用方需已锁定 SKU，并已校验目标库位存在且启用。
 * 返回拨转前后的分布，供审计记录。
 */
export async function transferSkuLocationStock(
  manager: EntityManager,
  sku: BaseProductSku,
  input: TransferSkuLocationInput,
): Promise<TransferSkuLocationResult> {
  if (!Number.isSafeInteger(input.qty) || input.qty <= 0) throw new BizError('拨转件数必须为正整数', 400)
  await reconcileSkuLocationStocks(manager, [sku])
  const before = (await loadSkuLocationDistributions(manager, [sku])).get(normalizeId(sku.id)) as SkuLocationDistribution
  const mainLocationId = normalizeNullableId(sku.locationId)
  const fromId = normalizeNullableId(input.fromLocationId)
  const toId = normalizeId(input.toLocationId)
  const fromIsMain = fromId === mainLocationId
  if (!fromIsMain && !fromId) throw new BizError('请选择来源库位', 400)
  if (fromId === toId) throw new BizError('来源库位与目标库位相同', 400)

  const available = fromIsMain ? before.mainQty : before.others.find((item) => item.locationId === fromId)?.qty ?? 0
  if (input.qty > available) {
    const fromCode = fromIsMain ? before.mainLocationCode ?? '未设置库位' : before.others.find((item) => item.locationId === fromId)?.locationCode ?? fromId
    throw new BizError(`来源库位 ${fromCode} 只有 ${available} 件，不能拨出 ${input.qty} 件`, 409)
  }

  const skuId = normalizeId(sku.id)
  // 拨出：其他库位扣行；主库位无需写行（主库位件数 = 总库存 − 其他库位之和，拨入其他库位后自动减少）。
  if (!fromIsMain) await upsertRowQty(manager, skuId, fromId as string, -input.qty)
  // 拨入：目标是主库位时无需写行；否则增加目标库位行。
  if (toId !== mainLocationId) await upsertRowQty(manager, skuId, toId, input.qty)

  let mainChanged = false
  if (input.setAsMain && toId !== mainLocationId) {
    await setSkuMainLocation(manager, sku, toId)
    mainChanged = true
  }
  await reconcileSkuLocationStocks(manager, [sku])
  const after = (await loadSkuLocationDistributions(manager, [sku])).get(skuId) as SkuLocationDistribution
  return { before, after, mainChanged }
}

/**
 * 切换主库位且不移动实物：
 * - 原主库位剩余件数改记为原主库位的其他库位行（原主库位为空即“未设置库位”时，这部分件数随主库位迁到新主库位）；
 * - 新主库位原有的其他库位行并回主库位（删除该行，件数由“总库存 − 其他库位之和”自动计入）；
 * - newMainLocationId 为 null 表示清空主库位，原主库位剩余件数变为“未设置库位”。
 * 调用方需已锁定 SKU，并已校验新主库位存在且启用。
 */
export async function setSkuMainLocation(manager: EntityManager, sku: SkuStockLike, newMainLocationId: string | null): Promise<void> {
  const skuId = normalizeId(sku.id)
  const oldMain = normalizeNullableId(sku.locationId)
  const newMain = normalizeNullableId(newMainLocationId)
  if (oldMain === newMain) return
  if (oldMain && newMain) {
    const oldMainQty = await readSkuLocationQty(manager, sku, oldMain)
    if (oldMainQty > 0) await upsertRowQty(manager, skuId, oldMain, oldMainQty)
  }
  if (newMain) await manager.getRepository(InvSkuLocationStock).delete({ skuId, locationId: newMain })
  // 只更新主库位列，绝不保存 SKU 实体快照中的库存或价格字段。
  await manager.getRepository(BaseProductSku).update({ id: sku.id }, { locationId: newMain })
  sku.locationId = newMain
}

/** 把扣减明细格式化为流水备注片段，例如“扣减其他库位 A-01-02×3、B-02-01×1”。 */
export const formatLocationDeductions = (deductions: SkuLocationDeduction[] | undefined) => {
  if (!deductions?.length) return ''
  return `扣减其他库位 ${deductions.map((item) => `${item.locationCode}×${item.qty}`).join('、')}`
}
