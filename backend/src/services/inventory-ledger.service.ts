/**
 * 模块说明：库存记账共享模块（所有物理库存变动的统一入口）。
 * 文件职责：在调用方事务内校验并应用 SKU 级物理库存增减，同步商品汇总库存，并为每个 SKU 变动写一条完整流水。
 * 实现逻辑：
 * - 调用方必须已在同一事务内按商品 ID、SKU ID 稳定顺序锁定商品与 SKU，本模块只做校验、记账与落库；
 * - `stockDelta` 为库存净变化：正数增加物理库存，负数扣减物理库存；
 * - 商品汇总库存只由“当前版本且启用”的 SKU 构成：停用或退役的 SKU 只改动自身库存，不改商品汇总；
 * - 净扣减方向逐一校验 SKU 与商品可用量（`currentStock - preOrderedStock`），净增加方向校验整数上限；
 * - `preOrderedStock` 永不改动，预订占用由 O2O 链路自行维护。
 * 维护重点：新增库存变动场景只调用本模块，不要在服务里再手写增减与流水，避免口径漂移。
 */

import { In, type EntityManager } from 'typeorm'
import { MAX_DATABASE_INT } from '../constants/web-resource-limits.js'
import { BaseProduct } from '../entities/base-product.entity.js'
import { BaseProductSku } from '../entities/base-product-sku.entity.js'
import { InventoryLog } from '../entities/inventory-log.entity.js'
import { BizError } from '../utils/errors.js'

export interface InventoryStockDelta {
  product: BaseProduct
  sku: BaseProductSku
  /** 库存净变化：正数增加，负数扣减，0 会被忽略。 */
  stockDelta: number
  /** 调用方自定义的回溯键，原样带回到返回行，便于把记账结果对应回业务明细。 */
  key?: string
}

export interface InventoryLedgerOperator {
  type: string
  id: string | null
  name: string | null
}

export interface InventoryLedgerLineView {
  key?: string
  productId: string
  skuId: string
  skuCode: string
  stockDelta: number
  /** 该 SKU 是否参与商品汇总；为 false 时商品汇总库存前后不变。 */
  affectsProductAggregate: boolean
  beforeCurrentStock: number
  afterCurrentStock: number
  beforeSkuCurrentStock: number
  afterSkuCurrentStock: number
}

export interface ApplyInventoryDeltasInput {
  deltas: InventoryStockDelta[]
  changeType: string
  refType: string
  refId: string
  operator: InventoryLedgerOperator
  buildRemark: (delta: InventoryStockDelta) => string
  /**
   * 流水 `changeQty` 口径：
   * - `stock`（默认）：记录库存净变化，满足 `after - before = changeQty`；
   * - `outbound`：记录出库方向数量（扣减为正），仅用于兼容手工出库的历史流水口径。
   */
  logQtyDirection?: 'stock' | 'outbound'
}

const normalizeId = (value: unknown): string => String(value ?? '').trim()
const isEnabled = (value: unknown) => value !== false && value !== 0 && value !== '0' && value !== 'false'

/** SKU 是否参与商品汇总库存：仅“当前版本且启用”的 SKU 计入商品 currentStock。 */
export const skuContributesToProductAggregate = (sku: Pick<BaseProductSku, 'isActive' | 'isCurrent'>): boolean => {
  return isEnabled(sku.isActive) && isEnabled(sku.isCurrent)
}

const availableOf = (entity: { currentStock: number; preOrderedStock: number }) =>
  Number(entity.currentStock) - Number(entity.preOrderedStock)

export async function applyInventoryDeltas(
  manager: EntityManager,
  input: ApplyInventoryDeltasInput,
): Promise<InventoryLedgerLineView[]> {
  const changed = input.deltas
    .filter((delta) => delta.stockDelta !== 0)
    .sort((left, right) => normalizeId(left.product.id).localeCompare(normalizeId(right.product.id))
      || normalizeId(left.sku.id).localeCompare(normalizeId(right.sku.id)))
  if (changed.length === 0) return []

  const skuNetMap = new Map<string, { sku: BaseProductSku; qty: number }>()
  const productNetMap = new Map<string, { product: BaseProduct; qty: number }>()
  for (const delta of changed) {
    if (!Number.isSafeInteger(delta.stockDelta)) {
      throw new BizError('库存变动数量必须为整数', 409)
    }
    if (normalizeId(delta.sku.productId) !== normalizeId(delta.product.id)) {
      throw new BizError(`SKU ${delta.sku.skuCode} 不属于商品 ${delta.product.productName}`, 409)
    }
    const skuId = normalizeId(delta.sku.id)
    skuNetMap.set(skuId, { sku: delta.sku, qty: (skuNetMap.get(skuId)?.qty ?? 0) + delta.stockDelta })
    if (skuContributesToProductAggregate(delta.sku)) {
      const productId = normalizeId(delta.product.id)
      productNetMap.set(productId, { product: delta.product, qty: (productNetMap.get(productId)?.qty ?? 0) + delta.stockDelta })
    }
  }

  for (const { sku, qty } of skuNetMap.values()) {
    if (qty < 0 && availableOf(sku) + qty < 0) {
      throw new BizError(`SKU ${sku.skuCode} 可用库存不足（可用 ${availableOf(sku)}，需要 ${-qty}）`, 409)
    }
    if (qty > 0 && Number(sku.currentStock) + qty > MAX_DATABASE_INT) {
      throw new BizError(`SKU ${sku.skuCode} 库存超过系统可处理上限`, 409)
    }
  }
  for (const { product, qty } of productNetMap.values()) {
    if (qty < 0 && availableOf(product) + qty < 0) {
      throw new BizError(`商品 ${product.productName} 可用库存不足（可用 ${availableOf(product)}，需要 ${-qty}）`, 409)
    }
    if (qty > 0 && Number(product.currentStock) + qty > MAX_DATABASE_INT) {
      throw new BizError(`商品 ${product.productName} 库存超过系统可处理上限`, 409)
    }
  }

  const inventoryLogRepo = manager.getRepository(InventoryLog)
  const logs: InventoryLog[] = []
  const lines: InventoryLedgerLineView[] = []
  for (const delta of changed) {
    const { product, sku } = delta
    const affectsProductAggregate = skuContributesToProductAggregate(sku)
    const beforeCurrentStock = Number(product.currentStock)
    const beforePreorderedStock = Number(product.preOrderedStock)
    const beforeSkuCurrentStock = Number(sku.currentStock)
    const beforeSkuPreorderedStock = Number(sku.preOrderedStock)
    product.currentStock = beforeCurrentStock + (affectsProductAggregate ? delta.stockDelta : 0)
    sku.currentStock = beforeSkuCurrentStock + delta.stockDelta
    lines.push({
      key: delta.key,
      productId: normalizeId(product.id),
      skuId: normalizeId(sku.id),
      skuCode: sku.skuCode,
      stockDelta: delta.stockDelta,
      affectsProductAggregate,
      beforeCurrentStock,
      afterCurrentStock: product.currentStock,
      beforeSkuCurrentStock,
      afterSkuCurrentStock: sku.currentStock,
    })
    const remark = `${input.buildRemark(delta)}${affectsProductAggregate ? '' : '（规格已停用或退役，不计入商品汇总）'}`
    logs.push(inventoryLogRepo.create({
      productId: normalizeId(product.id),
      skuId: normalizeId(sku.id),
      changeType: input.changeType,
      changeQty: input.logQtyDirection === 'outbound' ? -delta.stockDelta : delta.stockDelta,
      beforeCurrentStock,
      afterCurrentStock: product.currentStock,
      beforePreorderedStock,
      afterPreorderedStock: beforePreorderedStock,
      beforeSkuCurrentStock,
      afterSkuCurrentStock: sku.currentStock,
      beforeSkuPreorderedStock,
      afterSkuPreorderedStock: beforeSkuPreorderedStock,
      operatorType: input.operator.type,
      operatorId: input.operator.id,
      operatorName: input.operator.name,
      refType: input.refType,
      refId: input.refId,
      remark: remark.slice(0, 255),
    }))
  }

  // 写后兜底：只校验净扣减的实体，避免历史异常数据阻断回补、入库这类增加操作。
  for (const { sku, qty } of skuNetMap.values()) {
    if (qty < 0 && (Number(sku.currentStock) < 0 || availableOf(sku) < 0)) {
      throw new BizError(`SKU ${sku.skuCode} 扣减后库存异常，已回滚`, 409)
    }
  }
  for (const { product, qty } of productNetMap.values()) {
    if (qty < 0 && (Number(product.currentStock) < 0 || availableOf(product) < 0)) {
      throw new BizError(`商品 ${product.productName} 扣减后库存异常，已回滚`, 409)
    }
  }

  // 库存列按主键显式 UPDATE，不用 save()：MySQL 可重复读下 save() 以事务快照做变更比较，
  // 锁内读到的最新值若恰好与旧快照相同，库存列会被跳过不写，造成流水与库存不一致。
  const productRepo = manager.getRepository(BaseProduct)
  for (const { product } of productNetMap.values()) {
    await productRepo.update({ id: product.id }, { currentStock: product.currentStock })
  }
  const skuRepo = manager.getRepository(BaseProductSku)
  for (const { sku } of skuNetMap.values()) {
    await skuRepo.update({ id: sku.id }, { currentStock: sku.currentStock })
  }
  await inventoryLogRepo.save(logs)
  return lines
}

export interface SkuStockSnapshot {
  skuId: string
  currentStock: number
  preOrderedStock: number
}

/** 在手写库存变动前抓取 SKU 快照，配合 `buildSkuLogFields` 让流水带上 SKU 前后值。 */
export const snapshotSkuStock = (sku: BaseProductSku | null | undefined): SkuStockSnapshot | null => {
  if (!sku) return null
  return {
    skuId: normalizeId(sku.id),
    currentStock: Number(sku.currentStock ?? 0),
    preOrderedStock: Number(sku.preOrderedStock ?? 0),
  }
}

export const buildSkuLogFields = (
  sku: BaseProductSku | null | undefined,
  before: SkuStockSnapshot | null,
): Partial<Pick<InventoryLog, 'skuId' | 'beforeSkuCurrentStock' | 'afterSkuCurrentStock' | 'beforeSkuPreorderedStock' | 'afterSkuPreorderedStock'>> => {
  if (!sku || !before) return {}
  return {
    skuId: before.skuId,
    beforeSkuCurrentStock: before.currentStock,
    afterSkuCurrentStock: Number(sku.currentStock ?? 0),
    beforeSkuPreorderedStock: before.preOrderedStock,
    afterSkuPreorderedStock: Number(sku.preOrderedStock ?? 0),
  }
}

export interface LockedSkuTarget {
  product: BaseProduct
  sku: BaseProductSku
}

/**
 * 按“商品 → SKU”稳定顺序加锁加载记账目标（MySQL 行锁；SQLite 由写事务队列串行化），
 * 同一事务内多个 SKU 共享同一个商品实体，保证汇总库存在内存中连续累加。
 */
export async function loadLockedSkuTargets(manager: EntityManager, skuIds: string[]): Promise<Map<string, LockedSkuTarget>> {
  const ids = [...new Set(skuIds.map(normalizeId).filter(Boolean))]
  if (!ids.length) return new Map()
  const lockable = manager.connection.options.type !== 'sqlite'
  const skuHeads = await manager.getRepository(BaseProductSku).find({ where: { id: In(ids) }, select: ['id', 'productId'] })
  const productIds = [...new Set(skuHeads.map((sku) => normalizeId(sku.productId)))].sort((left, right) => left.localeCompare(right))
  const productMap = new Map<string, BaseProduct>()
  if (productIds.length) {
    const productQuery = manager.getRepository(BaseProduct)
      .createQueryBuilder('product')
      .where('product.id IN (:...productIds)', { productIds })
      .orderBy('product.id', 'ASC')
    if (lockable) productQuery.setLock('pessimistic_write')
    for (const product of await productQuery.getMany()) productMap.set(normalizeId(product.id), product)
  }
  const skuQuery = manager.getRepository(BaseProductSku)
    .createQueryBuilder('sku')
    .where('sku.id IN (:...ids)', { ids })
    .orderBy('sku.productId', 'ASC')
    .addOrderBy('sku.id', 'ASC')
  if (lockable) skuQuery.setLock('pessimistic_write')
  const targets = new Map<string, LockedSkuTarget>()
  for (const sku of await skuQuery.getMany()) {
    const product = productMap.get(normalizeId(sku.productId))
    if (product) targets.set(normalizeId(sku.id), { product, sku })
  }
  return targets
}
