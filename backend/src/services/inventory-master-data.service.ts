/**
 * 模块说明：库存主数据服务（商品分类与库位）。
 * 文件职责：提供分类、库位的列表、新增、修改、启停，以及规格在库位间的整体移入、移出与按数量拨转，并在同一事务内写审计。
 * 实现逻辑：
 * - 分类编码固定两位数字，作为 SKU 的 WC 编码组成部分；已关联商品的分类禁止改码；
 * - 库位编码统一转大写，仅允许字母、数字与短横线；
 * - 主数据只停用不删除，保证历史 SKU、盘点单引用始终可追溯；
 * - 同一规格可分放多个库位：主库位件数 = 总库存 − 其他库位件数之和（见 sku-location-stock.service），
 *   库位的“已关联”规格 = 主库位在此或在此拆有件数的规格，库位操作只搬动件数，不改总库存与流水。
 * 维护重点：列表附带引用计数，前端据此提示“已被使用”；新增字段需同步前端表单与导入模板。
 */

import { Brackets, In, Not, type EntityManager } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import { runInTransaction } from '../config/transaction-runner.js'
import { BaseCategory } from '../entities/base-category.entity.js'
import { BaseProduct } from '../entities/base-product.entity.js'
import { BaseProductSku } from '../entities/base-product-sku.entity.js'
import { BaseStorageLocation } from '../entities/base-storage-location.entity.js'
import { InvSkuLocationStock } from '../entities/inv-sku-location-stock.entity.js'
import { RelProductTag } from '../entities/rel-product-tag.entity.js'
import type { AuthUserContext } from '../types/auth.js'
import { isUniqueConstraintError } from '../utils/database-errors.js'
import { BizError } from '../utils/errors.js'
import type { RequestMeta } from '../utils/request-meta.js'
import { lockActiveSysAccountForBusiness } from './account-business-guard.service.js'
import { auditService } from './audit.service.js'
import { invalidateMallCatalogReadCache } from './mall-catalog-revision.service.js'
import {
  loadSkuLocationDistributions,
  reconcileSkuLocationStocks,
  setSkuMainLocation,
  transferSkuLocationStock,
  type SkuLocationDistribution,
} from './sku-location-stock.service.js'

export interface CategoryInput {
  categoryCode?: string
  categoryName?: string
  sortOrder?: number
  isActive?: boolean
}

export interface LocationInput {
  locationCode?: string
  locationName?: string | null
  remark?: string | null
  isActive?: boolean
}

export interface CategoryView {
  id: string
  categoryCode: string
  categoryName: string
  sortOrder: number
  isActive: boolean
  productCount: number
}

export interface LocationView {
  id: string
  locationCode: string
  locationName: string | null
  remark: string | null
  isActive: boolean
  skuCount: number
}

export interface LocationSkuQuery {
  scope: 'assigned' | 'other'
  keyword: string
  /** 分类 ID；'none' 表示只看未分类商品。 */
  categoryId?: string
  /** 商品标签 ID：商品关联了该标签即命中。 */
  tagId?: string
  /** 规格启停状态。 */
  status?: 'active' | 'inactive'
  page: number
  pageSize: number
}

export interface LocationSkuChange {
  action: 'assign' | 'remove'
  expectedLocationId: string | null
}

export interface LocationSkuTransfer {
  /** 来源库位；传主库位 ID（主库位为空时传 null）表示从主库位拨出。 */
  fromLocationId: string | null
  qty: number
  /** 打开弹窗时看到的来源库位件数，用于并发基线校验。 */
  expectedFromQty: number
  /** 打开弹窗时看到的主库位，用于并发基线校验。 */
  expectedMainLocationId: string | null
  setAsMain?: boolean
}

export interface LocationSkuBatchChange {
  action: 'assign' | 'remove'
  items: Array<{ skuId: string; expectedLocationId: string | null }>
}

const UNCATEGORIZED_FILTER = 'none'

const CATEGORY_CODE_PATTERN = /^\d{2}$/
const LOCATION_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{0,31}$/

const isEnabled = (value: unknown) => value !== false && value !== 0 && value !== '0'
const escapeLikeKeyword = (value: string) => value.replace(/[!%_]/g, '!$&')

const readRequiredText = (value: string | undefined, label: string, maxLength: number) => {
  const normalized = value?.trim() ?? ''
  if (!normalized) throw new BizError(`${label}不能为空`, 400)
  if (normalized.length > maxLength) throw new BizError(`${label}不能超过 ${maxLength} 个字符`, 400)
  return normalized
}

const readOptionalText = (value: string | null | undefined, label: string, maxLength: number) => {
  const normalized = value?.trim() ?? ''
  if (!normalized) return null
  if (normalized.length > maxLength) throw new BizError(`${label}不能超过 ${maxLength} 个字符`, 400)
  return normalized
}

const normalizeCategoryCode = (value: string | undefined) => {
  const code = value?.trim() ?? ''
  if (!CATEGORY_CODE_PATTERN.test(code)) throw new BizError('分类编码必须为两位数字，例如 02', 400)
  return code
}

const normalizeLocationCode = (value: string | undefined) => {
  const code = value?.trim().toUpperCase() ?? ''
  if (!LOCATION_CODE_PATTERN.test(code)) {
    throw new BizError('库位编码只能包含字母、数字与短横线，且不超过 32 个字符，例如 A-01-01', 400)
  }
  return code
}

const lockById = async <T extends BaseCategory | BaseStorageLocation>(
  manager: EntityManager,
  entity: new () => T,
  id: string,
  notFoundMessage: string,
): Promise<T> => {
  const query = manager.getRepository(entity).createQueryBuilder('row').where('row.id = :id', { id })
  if (manager.connection.options.type !== 'sqlite') query.setLock('pessimistic_write')
  const row = await query.getOne()
  if (!row) throw new BizError(notFoundMessage, 404)
  return row
}

export class InventoryMasterDataService {
  async listCategories(): Promise<CategoryView[]> {
    const [rows, counts] = await Promise.all([
      AppDataSource.getRepository(BaseCategory).find({ order: { sortOrder: 'ASC', categoryCode: 'ASC' } }),
      AppDataSource.getRepository(BaseProduct)
        .createQueryBuilder('product')
        .select('product.categoryId', 'categoryId')
        .addSelect('COUNT(*)', 'total')
        .where('product.categoryId IS NOT NULL')
        .groupBy('product.categoryId')
        .getRawMany<{ categoryId: string; total: string }>(),
    ])
    const countMap = new Map(counts.map((row) => [String(row.categoryId), Number(row.total)]))
    return rows.map((row) => this.buildCategoryView(row, countMap.get(String(row.id)) ?? 0))
  }

  async listLocations(): Promise<LocationView[]> {
    const [rows, mainCounts, stockCounts] = await Promise.all([
      AppDataSource.getRepository(BaseStorageLocation).find({ order: { locationCode: 'ASC' } }),
      AppDataSource.getRepository(BaseProductSku)
        .createQueryBuilder('sku')
        .select('sku.locationId', 'locationId')
        .addSelect('sku.id', 'skuId')
        .where('sku.locationId IS NOT NULL')
        .andWhere('sku.isCurrent = :isCurrent', { isCurrent: true })
        .getRawMany<{ locationId: string; skuId: string }>(),
      AppDataSource.getRepository(InvSkuLocationStock)
        .createQueryBuilder('stock')
        .innerJoin(BaseProductSku, 'sku', 'sku.id = stock.skuId')
        .select('stock.locationId', 'locationId')
        .addSelect('stock.skuId', 'skuId')
        .where('sku.isCurrent = :isCurrent', { isCurrent: true })
        .getRawMany<{ locationId: string; skuId: string }>(),
    ])
    // 库位关联规格数 = 主库位在此的规格 ∪ 在此拆有件数的规格（同一规格只算一次）。
    const skuSets = new Map<string, Set<string>>()
    for (const row of [...mainCounts, ...stockCounts]) {
      const key = String(row.locationId)
      const set = skuSets.get(key) ?? new Set<string>()
      set.add(String(row.skuId))
      skuSets.set(key, set)
    }
    return rows.map((row) => this.buildLocationView(row, skuSets.get(String(row.id))?.size ?? 0))
  }

  async listLocationSkus(locationId: string, query: LocationSkuQuery) {
    const location = await AppDataSource.getRepository(BaseStorageLocation).findOneBy({ id: locationId })
    if (!location) throw new BizError('库位不存在', 404)

    const qb = AppDataSource.getRepository(BaseProductSku)
      .createQueryBuilder('sku')
      .innerJoin(BaseProduct, 'product', 'product.id = sku.productId')
      .leftJoin(BaseStorageLocation, 'location', 'location.id = sku.locationId')
      .leftJoin(BaseCategory, 'category', 'category.id = product.categoryId')
      .where('sku.isCurrent = :isCurrent', { isCurrent: true })
    const stockedHereSubQuery = qb.subQuery()
      .select('1')
      .from(InvSkuLocationStock, 'stock')
      .where('stock.skuId = sku.id')
      .andWhere('stock.locationId = :locationId')
      .getQuery()
    if (query.scope === 'assigned') {
      // 已关联：主库位在此，或在此拆有件数。
      qb.andWhere(new Brackets((where) => {
        where.where('sku.locationId = :locationId', { locationId }).orWhere(`EXISTS ${stockedHereSubQuery}`)
      }))
    } else {
      qb.andWhere('(sku.locationId IS NULL OR sku.locationId <> :locationId)', { locationId })
        .andWhere(`NOT EXISTS ${stockedHereSubQuery}`)
    }
    const categoryId = String(query.categoryId ?? '').trim()
    if (categoryId === UNCATEGORIZED_FILTER) {
      qb.andWhere('product.categoryId IS NULL')
    } else if (categoryId) {
      qb.andWhere('product.categoryId = :categoryId', { categoryId })
    }
    const tagId = String(query.tagId ?? '').trim()
    if (tagId) {
      // 用 EXISTS 子查询而不是 JOIN，避免一个商品挂多个标签时规格行重复、总数失真。
      qb.andWhere((builder) => {
        const subQuery = builder.subQuery()
          .select('1')
          .from(RelProductTag, 'rel')
          .where('rel.productId = product.id')
          .andWhere('rel.tagId = :tagId')
          .getQuery()
        return `EXISTS ${subQuery}`
      }, { tagId })
    }
    if (query.status) {
      qb.andWhere('sku.isActive = :skuActive', { skuActive: query.status === 'active' })
    }
    const keyword = query.keyword.trim()
    if (keyword) {
      qb.andWhere("(product.productName LIKE :keyword ESCAPE '!' OR sku.skuCode LIKE :keyword ESCAPE '!' OR sku.specText LIKE :keyword ESCAPE '!')", {
        keyword: `%${escapeLikeKeyword(keyword)}%`,
      })
    }
    const total = await qb.getCount()
    const rows = await qb
      .select('sku.id', 'skuId')
      .addSelect('sku.skuCode', 'skuCode')
      .addSelect('product.productName', 'productName')
      .addSelect('sku.specText', 'specText')
      .addSelect('sku.locationId', 'locationId')
      .addSelect('location.locationCode', 'locationCode')
      .addSelect('category.categoryName', 'categoryName')
      .addSelect('sku.isActive', 'isActive')
      .addSelect('sku.currentStock', 'currentStock')
      .orderBy('product.productName', 'ASC')
      .addOrderBy('sku.id', 'ASC')
      .offset((query.page - 1) * query.pageSize)
      .limit(query.pageSize)
      .getRawMany<{
        skuId: string; skuCode: string; productName: string; specText: string
        locationId: string | null; locationCode: string | null; categoryName: string | null
        isActive: boolean | number; currentStock: number
      }>()
    const distributions = await loadSkuLocationDistributions(AppDataSource.manager, rows.map((row) => ({
      id: String(row.skuId),
      locationId: row.locationId == null ? null : String(row.locationId),
      currentStock: Number(row.currentStock),
    })))
    return {
      page: query.page,
      pageSize: query.pageSize,
      total,
      list: rows.map((row) => {
        const distribution = distributions.get(String(row.skuId)) as SkuLocationDistribution
        const isMainHere = String(row.locationId ?? '') === String(location.id)
        return {
          skuId: String(row.skuId),
          skuCode: row.skuCode,
          productName: row.productName,
          specText: row.specText,
          // 主库位（沿用字段名 locationId / locationCode，兼容旧调用方）。
          locationId: row.locationId == null ? null : String(row.locationId),
          locationCode: row.locationCode ?? null,
          categoryName: row.categoryName ?? null,
          isActive: isEnabled(row.isActive),
          currentStock: Number(row.currentStock),
          isMainHere,
          /** 本库位件数：主库位在此时为主库位件数，否则为在此拆分的件数。 */
          locationQty: isMainHere
            ? distribution.mainQty
            : distribution.others.find((item) => item.locationId === String(location.id))?.qty ?? 0,
          mainQty: distribution.mainQty,
          otherLocations: distribution.others,
        }
      }),
    }
  }

  /**
   * 锁定单个 SKU（账号 → 商品 → SKU），并校验读取时的主库位基线。预读只用于定位商品，锁内必须重新核对。
   */
  private async lockSkuForLocationChange(manager: EntityManager, skuId: string, expectedLocationId: string | null) {
    const candidate = await manager.getRepository(BaseProductSku).findOne({ where: { id: skuId }, select: ['id', 'productId'] })
    if (!candidate) throw new BizError('商品规格不存在', 404)
    const productQuery = manager.getRepository(BaseProduct)
      .createQueryBuilder('product')
      .where('product.id = :id', { id: candidate.productId })
    if (manager.connection.options.type !== 'sqlite') productQuery.setLock('pessimistic_write')
    const product = await productQuery.getOne()
    if (!product) throw new BizError('商品不存在，请刷新后重试', 409)

    const skuQuery = manager.getRepository(BaseProductSku)
      .createQueryBuilder('sku')
      .where('sku.id = :skuId', { skuId })
    if (manager.connection.options.type !== 'sqlite') skuQuery.setLock('pessimistic_write')
    const sku = await skuQuery.getOne()
    if (!sku || String(sku.productId) !== String(product.id) || !isEnabled(sku.isCurrent)) {
      throw new BizError('商品规格不存在或已退役，请刷新后重试', 409)
    }
    const beforeLocationId = sku.locationId == null ? null : String(sku.locationId)
    if (beforeLocationId !== expectedLocationId) throw new BizError('商品规格的库位已变化，请刷新后重试', 409)
    return { product, sku }
  }

  /**
   * 整体移入 / 移出（单条与批量共用，调用方已锁定 SKU 与库位）：
   * - assign（整体移入）：主库位全部件数搬到本库位并把本库位设为主库位；其他库位的件数保持不动；
   * - remove（移出）：本库位是主库位时清空主库位，件数变为“未设置库位”；
   *   本库位只是拆分库位时，把这里的件数并回主库位。
   * 返回是否发生变化以及前后分布，供审计记录。
   */
  private async applyWholeLocationChange(
    manager: EntityManager,
    sku: BaseProductSku,
    location: BaseStorageLocation,
    action: 'assign' | 'remove',
  ): Promise<{ changed: boolean; before: SkuLocationDistribution; after: SkuLocationDistribution }> {
    await reconcileSkuLocationStocks(manager, [sku])
    const skuId = String(sku.id)
    const locationId = String(location.id)
    const before = (await loadSkuLocationDistributions(manager, [sku])).get(skuId) as SkuLocationDistribution
    const mainLocationId = sku.locationId == null ? null : String(sku.locationId)
    const hereQty = before.others.find((item) => item.locationId === locationId)?.qty ?? 0
    if (action === 'assign') {
      if (mainLocationId === locationId) return { changed: false, before, after: before }
      if (!isEnabled(location.isActive)) throw new BizError(`库位 ${location.locationCode} 已停用`, 400)
      if (before.mainQty > 0) {
        await transferSkuLocationStock(manager, sku, { fromLocationId: mainLocationId, toLocationId: locationId, qty: before.mainQty })
      }
      // 原主库位件数已全部搬走，切换主库位时不会再留下原主库位行；本库位已有的拆分件数并回主库位。
      await setSkuMainLocation(manager, sku, locationId)
    } else if (mainLocationId === locationId) {
      await setSkuMainLocation(manager, sku, null)
    } else if (hereQty > 0) {
      await transferSkuLocationStock(manager, sku, { fromLocationId: locationId, toLocationId: mainLocationId ?? locationId, qty: hereQty })
    } else {
      throw new BizError('商品规格不属于当前库位，请刷新后重试', 409)
    }
    await reconcileSkuLocationStocks(manager, [sku])
    const after = (await loadSkuLocationDistributions(manager, [sku])).get(skuId) as SkuLocationDistribution
    return { changed: true, before, after }
  }

  async changeSkuLocation(
    locationId: string,
    skuId: string,
    input: LocationSkuChange,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<{ skuId: string; locationId: string | null; locationCode: string | null }> {
    return runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, actor.userId)
      const { product, sku } = await this.lockSkuForLocationChange(manager, skuId, input.expectedLocationId)
      const beforeLocationId = sku.locationId == null ? null : String(sku.locationId)
      // 库位锁在 SKU 锁之后，防止启停与新增关联并发穿透。
      const location = await lockById(manager, BaseStorageLocation, locationId, '库位不存在')
      const result = await this.applyWholeLocationChange(manager, sku, location, input.action)
      const afterLocationId = sku.locationId == null ? null : String(sku.locationId)
      if (result.changed) {
        await auditService.record({
          actionType: 'product.location.update',
          actionLabel: input.action === 'assign' ? '整体移入库位并设为主库位' : '移出库位中的商品规格',
          targetType: 'base_product_sku',
          targetId: String(sku.id),
          targetCode: sku.skuCode,
          actor,
          requestMeta,
          detail: {
            skuId: String(sku.id),
            productId: String(product.id),
            locationId: String(location.id),
            beforeLocationId,
            afterLocationId,
            beforeDistribution: result.before,
            afterDistribution: result.after,
          },
        }, manager)
      }
      return {
        skuId: String(sku.id),
        locationId: afterLocationId,
        locationCode: afterLocationId === String(location.id) ? location.locationCode : result.after.mainLocationCode,
      }
    })
  }

  /**
   * 批量整体移入 / 移出：整批在同一事务内校验并写入，任一规格的主库位与读取时不一致即整批 409，避免部分成功。
   * 锁序与单条一致：账号 → 商品（按 ID 升序）→ SKU（按 ID 升序）→ 库位。
   */
  async changeSkuLocations(
    locationId: string,
    input: LocationSkuBatchChange,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<{ action: 'assign' | 'remove'; skuIds: string[]; updatedCount: number }> {
    const expectedBySkuId = new Map<string, string | null>()
    for (const item of input.items) {
      const skuId = item.skuId.trim()
      if (expectedBySkuId.has(skuId) && expectedBySkuId.get(skuId) !== item.expectedLocationId) {
        throw new BizError('批量规格中存在重复且库位不一致的条目，请刷新后重试', 400)
      }
      expectedBySkuId.set(skuId, item.expectedLocationId)
    }
    const skuIds = [...expectedBySkuId.keys()].sort((left, right) => left.localeCompare(right))
    if (!skuIds.length) throw new BizError('请至少选择一个规格', 400)

    // 预读只用于定位商品，锁内必须重新核对归属。
    const candidates = await AppDataSource.getRepository(BaseProductSku).find({ where: { id: In(skuIds) }, select: ['id', 'productId'] })
    if (candidates.length !== skuIds.length) throw new BizError('部分商品规格不存在，请刷新后重试', 409)
    const productIds = [...new Set(candidates.map((sku) => String(sku.productId)))].sort((left, right) => left.localeCompare(right))

    return runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, actor.userId)
      const lockRows = manager.connection.options.type !== 'sqlite'
      const productQuery = manager.getRepository(BaseProduct)
        .createQueryBuilder('product')
        .where('product.id IN (:...productIds)', { productIds })
        .orderBy('product.id', 'ASC')
      if (lockRows) productQuery.setLock('pessimistic_write')
      const products = await productQuery.getMany()
      if (products.length !== productIds.length) throw new BizError('部分商品不存在，请刷新后重试', 409)
      const lockedProductIds = new Set(products.map((product) => String(product.id)))

      const skuQuery = manager.getRepository(BaseProductSku)
        .createQueryBuilder('sku')
        .where('sku.id IN (:...skuIds)', { skuIds })
        .orderBy('sku.id', 'ASC')
      if (lockRows) skuQuery.setLock('pessimistic_write')
      const skus = await skuQuery.getMany()
      if (skus.length !== skuIds.length) throw new BizError('部分商品规格不存在，请刷新后重试', 409)
      for (const sku of skus) {
        if (!lockedProductIds.has(String(sku.productId)) || !isEnabled(sku.isCurrent)) {
          throw new BizError(`商品规格 ${sku.skuCode} 不存在或已退役，请刷新后重试`, 409)
        }
        const beforeLocationId = sku.locationId == null ? null : String(sku.locationId)
        if (beforeLocationId !== expectedBySkuId.get(String(sku.id))) {
          throw new BizError(`商品规格 ${sku.skuCode} 的库位已变化，请刷新后重试`, 409)
        }
      }

      // 库位锁在 SKU 锁之后，防止启停与新增关联并发穿透。
      const location = await lockById(manager, BaseStorageLocation, locationId, '库位不存在')
      let updatedCount = 0
      for (const sku of skus) {
        const beforeLocationId = sku.locationId == null ? null : String(sku.locationId)
        let result: Awaited<ReturnType<typeof this.applyWholeLocationChange>>
        try {
          result = await this.applyWholeLocationChange(manager, sku, location, input.action)
        } catch (error) {
          if (error instanceof BizError) throw new BizError(`商品规格 ${sku.skuCode}：${error.message}`, error.statusCode ?? 409)
          throw error
        }
        if (!result.changed) continue
        updatedCount += 1
        // 逐条写审计，保持与单条相同的 actionType，按 SKU 追溯时不会漏掉批量操作。
        await auditService.record({
          actionType: 'product.location.update',
          actionLabel: input.action === 'assign' ? '批量整体移入库位并设为主库位' : '批量移出库位中的商品规格',
          targetType: 'base_product_sku',
          targetId: String(sku.id),
          targetCode: sku.skuCode,
          actor,
          requestMeta,
          detail: {
            skuId: String(sku.id),
            productId: String(sku.productId),
            locationId: String(location.id),
            beforeLocationId,
            afterLocationId: sku.locationId == null ? null : String(sku.locationId),
            beforeDistribution: result.before,
            afterDistribution: result.after,
            batch: true,
          },
        }, manager)
      }
      return { action: input.action, skuIds, updatedCount }
    })
  }

  /**
   * 按数量拨转：把规格在来源库位的 N 件拨到目标库位（路径中的库位），总库存与流水不变。
   * - 来源库位传主库位 ID（主库位为空时传 null）表示从主库位拨出；
   * - expectedFromQty 是打开弹窗时看到的来源件数，与锁内实际件数不一致即 409，避免并发拨转或连点重复拨出；
   * - setAsMain 为 true 时拨转后把目标库位设为主库位（原主库位剩余件数保留在原库位）。
   * 锁序：账号 → 商品 → SKU → 分库位行 → 库位。
   */
  async transferSkuStock(
    locationId: string,
    skuId: string,
    input: LocationSkuTransfer,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ) {
    return runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, actor.userId)
      const { product, sku } = await this.lockSkuForLocationChange(manager, skuId, input.expectedMainLocationId)
      await reconcileSkuLocationStocks(manager, [sku])
      const distribution = (await loadSkuLocationDistributions(manager, [sku])).get(String(sku.id)) as SkuLocationDistribution
      const fromLocationId = input.fromLocationId ?? null
      const mainLocationId = sku.locationId == null ? null : String(sku.locationId)
      const fromQty = fromLocationId === mainLocationId
        ? distribution.mainQty
        : distribution.others.find((item) => item.locationId === fromLocationId)?.qty ?? 0
      if (fromQty !== input.expectedFromQty) {
        throw new BizError(`来源库位的件数已变化（打开时 ${input.expectedFromQty}，当前 ${fromQty}），请刷新后重试`, 409)
      }
      const location = await lockById(manager, BaseStorageLocation, locationId, '库位不存在')
      if (!isEnabled(location.isActive)) throw new BizError(`库位 ${location.locationCode} 已停用`, 400)
      const result = await transferSkuLocationStock(manager, sku, {
        fromLocationId,
        toLocationId: String(location.id),
        qty: input.qty,
        setAsMain: input.setAsMain,
      })
      await auditService.record({
        actionType: 'product.location.transfer',
        actionLabel: result.mainChanged ? '库位拨转并设为主库位' : '库位拨转',
        targetType: 'base_product_sku',
        targetId: String(sku.id),
        targetCode: sku.skuCode,
        actor,
        requestMeta,
        detail: {
          skuId: String(sku.id),
          productId: String(product.id),
          fromLocationId,
          toLocationId: String(location.id),
          qty: input.qty,
          setAsMain: Boolean(input.setAsMain),
          beforeDistribution: result.before,
          afterDistribution: result.after,
        },
      }, manager)
      return { skuId: String(sku.id), distribution: result.after }
    })
  }

  /** 单个规格的库位分布，供拨转弹窗打开时读取最新件数与来源库位。 */
  async getSkuLocationDistribution(skuId: string) {
    const sku = await AppDataSource.getRepository(BaseProductSku).findOne({ where: { id: skuId } })
    if (!sku || !isEnabled(sku.isCurrent)) throw new BizError('商品规格不存在或已退役', 404)
    const distribution = (await loadSkuLocationDistributions(AppDataSource.manager, [sku])).get(String(sku.id)) as SkuLocationDistribution
    return {
      ...distribution,
      skuCode: sku.skuCode,
      currentStock: Number(sku.currentStock ?? 0),
    }
  }

  async createCategory(input: CategoryInput, actor: AuthUserContext, requestMeta?: RequestMeta): Promise<CategoryView> {
    const categoryCode = normalizeCategoryCode(input.categoryCode)
    const categoryName = readRequiredText(input.categoryName, '分类名称', 64)
    const result = await runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, actor.userId)
      const repo = manager.getRepository(BaseCategory)
      await this.assertCategoryUnique(manager, categoryCode, categoryName)
      const saved = await this.saveCategory(repo.create({
        categoryCode,
        categoryName,
        sortOrder: this.readSortOrder(input.sortOrder),
        isActive: input.isActive !== false,
      }), manager)
      await auditService.record({
        actionType: 'product.category.create',
        actionLabel: '新增商品分类',
        targetType: 'base_category',
        targetId: saved.id,
        targetCode: `${saved.categoryCode} ${saved.categoryName}`,
        actor,
        requestMeta,
        detail: { categoryCode, categoryName, isActive: saved.isActive },
      }, manager)
      return this.buildCategoryView(saved, 0)
    })
    invalidateMallCatalogReadCache()
    return result
  }

  async updateCategory(id: string, input: CategoryInput, actor: AuthUserContext, requestMeta?: RequestMeta): Promise<CategoryView> {
    const result = await runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, actor.userId)
      const category = await lockById(manager, BaseCategory, id, '分类不存在')
      const before = { categoryCode: category.categoryCode, categoryName: category.categoryName, isActive: isEnabled(category.isActive) }
      const nextCode = input.categoryCode === undefined ? category.categoryCode : normalizeCategoryCode(input.categoryCode)
      const nextName = input.categoryName === undefined ? category.categoryName : readRequiredText(input.categoryName, '分类名称', 64)
      const productCount = await manager.getRepository(BaseProduct).count({ where: { categoryId: category.id } })
      if (nextCode !== category.categoryCode && productCount > 0) {
        throw new BizError(`分类「${category.categoryName}」已关联 ${productCount} 个商品，不能修改分类编码`, 409)
      }
      await this.assertCategoryUnique(manager, nextCode, nextName, category.id)
      category.categoryCode = nextCode
      category.categoryName = nextName
      if (input.sortOrder !== undefined) category.sortOrder = this.readSortOrder(input.sortOrder)
      if (typeof input.isActive === 'boolean') category.isActive = input.isActive
      const saved = await this.saveCategory(category, manager)
      await auditService.record({
        actionType: 'product.category.update',
        actionLabel: typeof input.isActive === 'boolean' && input.isActive !== before.isActive
          ? (input.isActive ? '启用商品分类' : '停用商品分类')
          : '修改商品分类',
        targetType: 'base_category',
        targetId: saved.id,
        targetCode: `${saved.categoryCode} ${saved.categoryName}`,
        actor,
        requestMeta,
        detail: { before, after: { categoryCode: saved.categoryCode, categoryName: saved.categoryName, isActive: isEnabled(saved.isActive) } },
      }, manager)
      return this.buildCategoryView(saved, productCount)
    })
    invalidateMallCatalogReadCache()
    return result
  }

  async createLocation(input: LocationInput, actor: AuthUserContext, requestMeta?: RequestMeta): Promise<LocationView> {
    const locationCode = normalizeLocationCode(input.locationCode)
    return runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, actor.userId)
      const repo = manager.getRepository(BaseStorageLocation)
      await this.assertLocationUnique(manager, locationCode)
      const saved = await this.saveLocation(repo.create({
        locationCode,
        locationName: readOptionalText(input.locationName, '库位名称', 64),
        remark: readOptionalText(input.remark, '备注', 255),
        isActive: input.isActive !== false,
      }), manager)
      await auditService.record({
        actionType: 'product.location.create',
        actionLabel: '新增库位',
        targetType: 'base_storage_location',
        targetId: saved.id,
        targetCode: saved.locationCode,
        actor,
        requestMeta,
        detail: { locationCode, locationName: saved.locationName, isActive: saved.isActive },
      }, manager)
      return this.buildLocationView(saved, 0)
    })
  }

  async updateLocation(id: string, input: LocationInput, actor: AuthUserContext, requestMeta?: RequestMeta): Promise<LocationView> {
    return runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, actor.userId)
      const location = await lockById(manager, BaseStorageLocation, id, '库位不存在')
      const before = { locationCode: location.locationCode, locationName: location.locationName, isActive: isEnabled(location.isActive) }
      if (input.locationCode !== undefined) {
        const nextCode = normalizeLocationCode(input.locationCode)
        await this.assertLocationUnique(manager, nextCode, location.id)
        location.locationCode = nextCode
      }
      if (input.locationName !== undefined) location.locationName = readOptionalText(input.locationName, '库位名称', 64)
      if (input.remark !== undefined) location.remark = readOptionalText(input.remark, '备注', 255)
      if (typeof input.isActive === 'boolean') location.isActive = input.isActive
      const saved = await this.saveLocation(location, manager)
      const skuCount = await this.countLocationSkus(manager, String(saved.id))
      await auditService.record({
        actionType: 'product.location.update',
        actionLabel: typeof input.isActive === 'boolean' && input.isActive !== before.isActive
          ? (input.isActive ? '启用库位' : '停用库位')
          : '修改库位',
        targetType: 'base_storage_location',
        targetId: saved.id,
        targetCode: saved.locationCode,
        actor,
        requestMeta,
        detail: { before, after: { locationCode: saved.locationCode, locationName: saved.locationName, isActive: isEnabled(saved.isActive) } },
      }, manager)
      return this.buildLocationView(saved, skuCount)
    })
  }

  /** 库位关联规格数：主库位在此或在此拆有件数的当前版本规格（同一规格只算一次）。 */
  private async countLocationSkus(manager: EntityManager, locationId: string): Promise<number> {
    const [mainRows, stockRows] = await Promise.all([
      manager.getRepository(BaseProductSku).find({ where: { locationId, isCurrent: true }, select: ['id'] }),
      manager.getRepository(InvSkuLocationStock)
        .createQueryBuilder('stock')
        .innerJoin(BaseProductSku, 'sku', 'sku.id = stock.skuId')
        .select('stock.skuId', 'skuId')
        .where('stock.locationId = :locationId', { locationId })
        .andWhere('sku.isCurrent = :isCurrent', { isCurrent: true })
        .getRawMany<{ skuId: string }>(),
    ])
    return new Set([...mainRows.map((row) => String(row.id)), ...stockRows.map((row) => String(row.skuId))]).size
  }

  private readSortOrder(value: number | undefined) {
    if (value === undefined) return 0
    if (!Number.isInteger(value) || value < 0 || value > 999999) throw new BizError('排序必须为 0 到 999999 的整数', 400)
    return value
  }

  private async assertCategoryUnique(manager: EntityManager, categoryCode: string, categoryName: string, excludeId?: string) {
    const repo = manager.getRepository(BaseCategory)
    const exclude = excludeId ? { id: Not(excludeId) } : {}
    if (await repo.exists({ where: { categoryCode, ...exclude } })) throw new BizError(`分类编码 ${categoryCode} 已存在`, 409)
    if (await repo.exists({ where: { categoryName, ...exclude } })) throw new BizError(`分类名称「${categoryName}」已存在`, 409)
  }

  private async assertLocationUnique(manager: EntityManager, locationCode: string, excludeId?: string) {
    const exists = await manager.getRepository(BaseStorageLocation).exists({
      where: { locationCode, ...(excludeId ? { id: Not(excludeId) } : {}) },
    })
    if (exists) throw new BizError(`库位编码 ${locationCode} 已存在`, 409)
  }

  private async saveCategory(entity: BaseCategory, manager: EntityManager) {
    try {
      return await manager.getRepository(BaseCategory).save(entity)
    } catch (error) {
      if (isUniqueConstraintError(error, { mysqlConstraints: ['uk_base_category_code', 'uk_base_category_name'], sqliteColumns: ['base_category.category_code', 'base_category.category_name'] })) {
        throw new BizError('分类编码或名称已存在', 409)
      }
      throw error
    }
  }

  private async saveLocation(entity: BaseStorageLocation, manager: EntityManager) {
    try {
      return await manager.getRepository(BaseStorageLocation).save(entity)
    } catch (error) {
      if (isUniqueConstraintError(error, { mysqlConstraint: 'uk_base_storage_location_code', sqliteColumns: ['base_storage_location.location_code'] })) {
        throw new BizError('库位编码已存在', 409)
      }
      throw error
    }
  }

  private buildCategoryView(row: BaseCategory, productCount: number): CategoryView {
    return {
      id: String(row.id),
      categoryCode: row.categoryCode,
      categoryName: row.categoryName,
      sortOrder: Number(row.sortOrder ?? 0),
      isActive: isEnabled(row.isActive),
      productCount,
    }
  }

  private buildLocationView(row: BaseStorageLocation, skuCount: number): LocationView {
    return {
      id: String(row.id),
      locationCode: row.locationCode,
      locationName: row.locationName ?? null,
      remark: row.remark ?? null,
      isActive: isEnabled(row.isActive),
      skuCount,
    }
  }
}

export const inventoryMasterDataService = new InventoryMasterDataService()
