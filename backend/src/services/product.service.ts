/**
 * 文件说明：该文件负责商品服务，统一处理商品资料、标签关联、上下架状态、库存字段与批量创建更新等后台能力。
 * 实现逻辑：
 * 1. 以商品表、标签关系表和多类出入库明细为基础，维护商品主数据与库存衍生字段的一致性；
 * 2. 将商品编码生成、字段标准化、唯一性校验与批量操作重试策略集中在服务层，减少不同入口的重复判断；
 * 3. 同时向管理端和 O2O 业务提供稳定的商品查询与写入能力，保证商品治理口径统一。
 */

import { In, type EntityManager, type Repository } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import { runInTransaction } from '../config/transaction-runner.js'
import { BaseCategory } from '../entities/base-category.entity.js'
import { BaseProduct } from '../entities/base-product.entity.js'
import { BaseProductSku } from '../entities/base-product-sku.entity.js'
import { BaseStorageLocation } from '../entities/base-storage-location.entity.js'
import { RelProductTag } from '../entities/rel-product-tag.entity.js'
import { BaseTag } from '../entities/base-tag.entity.js'
import { BizInboundOrderItem } from '../entities/biz-inbound-order-item.entity.js'
import { BizOutboundOrderItem } from '../entities/biz-outbound-order-item.entity.js'
import { InventoryLog } from '../entities/inventory-log.entity.js'
import { O2oPreorderItem } from '../entities/o2o-preorder-item.entity.js'
import type { PaginationResult } from '../types/api.js'
import type { AuthUserContext } from '../types/auth.js'
import { isRetryableSqliteLockError, isUniqueConstraintError } from '../utils/database-errors.js'
import { BizError } from '../utils/errors.js'
import { generateProductCode } from '../utils/id-generator.js'
import { isDatabaseFlagEnabled, summarizeProductInventory } from '../utils/product-inventory-summary.js'
import { normalizeLegacyUploadUrl } from '../utils/upload-storage.js'
import { assertDiscountRateInRange, calculateDiscountedPrice, normalizeDiscountRate } from '../utils/discount-price.js'
import { invalidateMallCatalogReadCache } from './mall-catalog-revision.service.js'
import { lockActiveSysAccountForBusiness } from './account-business-guard.service.js'
import { allocateWcSkuCode } from './inventory-sequence.service.js'

export interface ProductQuery {
  keyword?: string
  tagId?: string
  categoryId?: string
  isActive?: boolean
  o2oStatus?: 'listed' | 'unlisted'
  page?: number
  pageSize?: number
}

export interface CreateProductInput {
  productCode?: string
  productName: string
  pinyinAbbr?: string
  defaultPrice?: number
  discountRate?: number
  isActive?: boolean
  o2oStatus?: 'listed' | 'unlisted'
  o2oRecommended?: boolean
  thumbnail?: string | null
  detailContent?: string | null
  limitPerUser?: number
  currentStock?: number
  preOrderedStock?: number
  tagIds?: Array<string | number>
  categoryId?: string | number | null
  /** 单规格商品（未提交 skus）时写入默认规格的条码、成本价与库位。 */
  defaultSku?: ProductDefaultSkuExtras
  specGroups?: ProductSpecGroupInput[]
  skus?: ProductSkuInput[]
}

export type ProductDefaultSkuExtras = Pick<ProductSkuInput, 'barcode' | 'costPrice' | 'locationId'>

export interface UpdateProductInput {
  productCode?: string
  productName?: string
  pinyinAbbr?: string
  defaultPrice?: number
  discountRate?: number
  isActive?: boolean
  o2oStatus?: 'listed' | 'unlisted'
  o2oRecommended?: boolean
  thumbnail?: string | null
  detailContent?: string | null
  limitPerUser?: number
  currentStock?: number
  preOrderedStock?: number
  tagIds?: Array<string | number>
  categoryId?: string | number | null
  defaultSku?: ProductDefaultSkuExtras
  specGroups?: ProductSpecGroupInput[]
  skus?: ProductSkuInput[]
  /** 编辑弹窗打开时读取到的库存基线，库存变动时用于拦截并发出入库造成的覆盖。 */
  stockBaseline?: ProductStockBaselineInput
}

export interface ProductStockBaselineInput {
  currentStock?: number
  skus?: Array<{ id: string | number; currentStock: number }>
}

interface ProductStockSnapshot {
  productCurrentStock: number
  productPreOrderedStock: number
  skus: Map<string, { currentStock: number; preOrderedStock: number; contributes: boolean }>
}

export interface BatchUpdateProductInput {
  ids: Array<string | number>
  isActive?: boolean
}

export interface ProductTagView {
  id: string
  tagName: string
  tagCode: string | null
}

export interface ProductSpecGroupInput {
  name: string
  values: string[]
}

export interface ProductSkuInput {
  id?: string | number
  skuCode?: string
  specValues?: Record<string, string>
  defaultPrice?: number
  discountRate?: number
  currentStock?: number
  preOrderedStock?: number
  isActive?: boolean
  isCurrent?: boolean
  o2oRecommended?: boolean
  thumbnail?: string | null
  sortOrder?: number
  /** 原厂条码；空字符串或 null 表示使用 SKU 编码作为内部条码。 */
  barcode?: string | null
  costPrice?: number | null
  locationId?: string | number | null
}

export interface ProductSpecGroupView {
  name: string
  values: string[]
}

export interface ProductSkuView {
  id: string
  productId: string
  skuCode: string
  specValues: Record<string, string>
  specText: string
  defaultPrice: string
  originalPrice: string
  discountRate: string
  discountedPrice: string
  currentStock: number
  preOrderedStock: number
  availableStock: number
  isActive: boolean
  isCurrent: boolean
  o2oRecommended: boolean
  thumbnail: string | null
  sortOrder: number
  barcode: string | null
  /** 实际用于打印与扫码的条码：原厂条码优先，否则为 SKU 编码。 */
  effectiveBarcode: string
  costPrice: string | null
  locationId: string | null
  locationCode: string | null
}

export interface ProductView {
  id: string
  productCode: string
  productName: string
  pinyinAbbr: string
  defaultPrice: string
  discountRate: string
  discountedPrice: string
  isActive: boolean
  o2oStatus: 'listed' | 'unlisted'
  o2oRecommended: boolean
  thumbnail: string | null
  detailContent: string | null
  limitPerUser: number
  currentStock: number
  preOrderedStock: number
  availableStock: number
  tagIds: string[]
  tags: ProductTagView[]
  categoryId: string | null
  categoryCode: string | null
  categoryName: string | null
  specGroups: ProductSpecGroupView[]
  skus: ProductSkuView[]
}

export interface ProductLookupView {
  matchedBy: 'barcode' | 'sku_code'
  product: {
    id: string
    productCode: string
    productName: string
    thumbnail: string | null
    isActive: boolean
    categoryId: string | null
    categoryName: string | null
  }
  sku: ProductSkuView
}

export interface ProductLabelView {
  skuId: string
  skuCode: string
  barcode: string
  productName: string
  specText: string
  price: string
  categoryName: string | null
  locationCode: string | null
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const normalizeEntityId = (value: string | number): string => String(value).trim()

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const normalizeDecimalText = (value: string | number | null | undefined, fallback = '0.00'): string => {
  if (value === null || value === undefined || value === '') {
    return fallback
  }

  const normalizedNumber = Number(value)
  return Number.isFinite(normalizedNumber) ? normalizedNumber.toFixed(2) : fallback
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const normalizeTagIds = (tagIds: Array<string | number>): string[] => {
  return [...new Set(tagIds.map((tagId) => normalizeEntityId(tagId)).filter(Boolean))]
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const normalizeProductCodeInput = (value: string | null | undefined): string => {
  if (typeof value !== 'string') {
    return ''
  }

  return value.trim()
}

const normalizeProductThumbnailUrl = (value: string | null | undefined) => {
  return normalizeLegacyUploadUrl('products', value)
}

const normalizeSpecTextValue = (value: unknown): string => {
  return typeof value === 'string' ? value.trim() : ''
}

const normalizeSpecValuesRecord = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  const normalized: Record<string, string> = {}
  Object.entries(value as Record<string, unknown>).forEach(([key, rawValue]) => {
    const normalizedKey = normalizeSpecTextValue(key)
    const normalizedValue = normalizeSpecTextValue(rawValue)
    if (normalizedKey && normalizedValue) {
      normalized[normalizedKey] = normalizedValue
    }
  })
  return normalized
}

const parseSpecValuesJson = (value: string | null | undefined): Record<string, string> => {
  if (!value) {
    return {}
  }
  try {
    return normalizeSpecValuesRecord(JSON.parse(value))
  } catch {
    return {}
  }
}

const buildSpecText = (specValues: Record<string, string>, specGroups: ProductSpecGroupInput[] = []): string => {
  const orderedNames = specGroups
    .map((group) => normalizeSpecTextValue(group.name))
    .filter(Boolean)
  const values = [
    ...orderedNames.map((name) => specValues[name]).filter(Boolean),
    ...Object.entries(specValues)
      .filter(([name]) => !orderedNames.includes(name))
      .map(([, value]) => value)
      .filter(Boolean),
  ]
  return values.length ? values.join(' / ') : '默认规格'
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const buildSpecValuesKey = (specValues: Record<string, string>): string => {
  const entries = Object.entries(specValues)
    .map(([name, value]) => [normalizeSpecTextValue(name), normalizeSpecTextValue(value)] as const)
    .filter(([name, value]) => name && value)
    .sort(([leftName], [rightName]) => leftName.localeCompare(rightName))
  return JSON.stringify(entries)
}

const buildSkuEntitySpecValuesKey = (sku: Pick<BaseProductSku, 'specValuesJson'>): string => {
  return buildSpecValuesKey(parseSpecValuesJson(sku.specValuesJson))
}

const PRODUCT_CODE_CONSTRAINT_MATCHER = {
  mysqlConstraint: 'uk_base_product_code',
  sqliteColumns: ['base_product.product_code'],
} as const

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const PRODUCT_CREATE_MAX_RETRY = 3
const PRODUCT_BATCH_CREATE_LIMIT = 50
const PRODUCT_FIELD_LIMITS = {
  code: 64,
  name: 128,
  pinyinAbbr: 64,
  thumbnail: 255,
  detailContent: 20000,
  priceMax: 9999999999.99,
  maxLimitPerUser: 999999,
  maxStock: 999999999,
} as const

const SKU_BARCODE_PATTERN = /^[!-~]{1,64}$/

const PRODUCT_REFERENCE_LABELS = [
  { repoEntity: BizInboundOrderItem, label: '入库明细' },
  { repoEntity: BizOutboundOrderItem, label: '出库明细' },
  { repoEntity: InventoryLog, label: '库存流水' },
  { repoEntity: O2oPreorderItem, label: '线上预订单明细' },
] as const

const resolveEffectiveO2oStatus = (
  isActive: boolean,
  requestedStatus: 'listed' | 'unlisted' | undefined,
  currentStatus: 'listed' | 'unlisted' = 'unlisted',
): 'listed' | 'unlisted' => {
  if (!isActive) {
    return 'unlisted'
  }

  if (requestedStatus === 'listed' || requestedStatus === 'unlisted') {
    return requestedStatus
  }

  return currentStatus
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
export class ProductService {
  private readonly productRepo = AppDataSource.getRepository(BaseProduct)

  /**
   * 列表与计数共用的筛选条件：
   * - 关键字同时匹配商品名称、拼音、商品编码，以及当前 SKU 的编码与原厂条码；
   * - 标签、分类筛选直接在 SQL 中完成，避免拉取全量数据后在内存筛选。
   */
  private applyListFilters(qb: ReturnType<Repository<BaseProduct>['createQueryBuilder']>, query: ProductQuery) {
    if (typeof query.isActive === 'boolean') {
      qb.andWhere('p.is_active = :isActive', { isActive: query.isActive ? 1 : 0 })
    }
    if (query.o2oStatus) {
      qb.andWhere('p.o2o_status = :o2oStatus', { o2oStatus: query.o2oStatus })
    }
    if (query.keyword?.trim()) {
      qb.andWhere(
        `(p.product_name LIKE :keyword OR p.pinyin_abbr LIKE :keyword OR p.product_code LIKE :keyword
          OR EXISTS (SELECT 1 FROM base_product_sku ks WHERE ks.product_id = p.id AND (ks.sku_code LIKE :keyword OR ks.barcode LIKE :keyword)))`,
        { keyword: `%${query.keyword.trim()}%` },
      )
    }
    if (query.tagId) {
      qb.innerJoin('rel_product_tag', 'rpt', 'rpt.product_id = p.id AND rpt.tag_id = :tagId', { tagId: query.tagId })
    }
    if (query.categoryId) {
      qb.andWhere('p.category_id = :categoryId', { categoryId: query.categoryId })
    }
  }

  async list(query: ProductQuery): Promise<ProductView[]> {
    const qb = this.productRepo.createQueryBuilder('p')
    this.applyListFilters(qb, query)
    qb.orderBy('p.id', 'DESC')

    const page = query.page ?? 0
    const pageSize = query.pageSize ?? 0
    if (Number.isFinite(page) && Number.isFinite(pageSize) && page > 0 && pageSize > 0) {
      qb.skip((page - 1) * pageSize).take(pageSize)
    }

    const products = await qb.getMany()
    return this.buildProductViews(products)
  }

  async listPaged(query: ProductQuery): Promise<PaginationResult<ProductView>> {
    const page = Math.max(1, Math.floor(Number(query.page || 1)))
    const pageSize = Math.min(100, Math.max(10, Math.floor(Number(query.pageSize || 20))))
    const list = await this.list({
      ...query,
      page,
      pageSize,
    })
    const total = await this.count(query)
    return { page, pageSize, total, list }
  }

  private async count(query: ProductQuery): Promise<number> {
    const qb = this.productRepo.createQueryBuilder('p')
    this.applyListFilters(qb, query)
    return qb.getCount()
  }

  async detail(id: string): Promise<ProductView> {
    const product = await this.productRepo.findOne({ where: { id } })
    if (!product) {
      throw new BizError('产品不存在', 404)
    }

    return this.buildProductView(product)
  }

  async create(input: CreateProductInput, actor: AuthUserContext): Promise<ProductView> {
    const result = await runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, actor.userId)
      return this.createWithManager(input, manager, actor)
    })
    invalidateMallCatalogReadCache()
    return result
  }

  async batchCreate(inputs: CreateProductInput[], actor: AuthUserContext): Promise<ProductView[]> {
    if (!Array.isArray(inputs) || !inputs.length) {
      throw new BizError('至少新增一个产品')
    }
    if (inputs.length > PRODUCT_BATCH_CREATE_LIMIT) {
      throw new BizError(`单次最多新增 ${PRODUCT_BATCH_CREATE_LIMIT} 个产品`)
    }

    this.assertNoDuplicateProductCodesInBatch(inputs)

    const result = await runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, actor.userId)
      const createdProducts: ProductView[] = []

      for (let index = 0; index < inputs.length; index += 1) {
        const currentInput = inputs[index]
        try {
          const createdProduct = await this.createWithManager(currentInput, manager, actor)
          createdProducts.push(createdProduct)
        } catch (error) {
          if (error instanceof BizError) {
            throw new BizError(`第 ${index + 1} 行创建失败：${error.message}`, error.statusCode)
          }
          throw new BizError(`第 ${index + 1} 行创建失败，请检查输入后重试`)
        }
      }

      return createdProducts
    })
    invalidateMallCatalogReadCache()
    return result
  }

  async update(id: string, input: UpdateProductInput, actor: AuthUserContext): Promise<ProductView> {
    const result = await runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, actor.userId)
      const repo = manager.getRepository(BaseProduct)
      const product = await repo.findOne({
        where: { id },
        lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
      })
      if (!product) {
        throw new BizError('产品不存在', 404)
      }

      // 先在锁内拍下库存快照并校验基线，避免把打开弹窗时的旧库存写回、覆盖期间发生的出入库。
      const stockSnapshot = await this.captureProductStockSnapshot(product, manager)
      this.assertProductLevelStockBaseline(product, input)

      this.applyUpdateInputToProduct(product, input)
      if (input.categoryId !== undefined) {
        product.categoryId = await this.resolveCategoryId(input.categoryId, manager, product.categoryId)
      }

      const saved = await repo.save(product)
      if (Array.isArray(input.tagIds)) {
        await this.replaceProductTags(saved.id, input.tagIds, manager)
      }
      if (Array.isArray(input.skus) || Array.isArray(input.specGroups)) {
        await this.replaceProductSkus(saved, input, manager, { stockBaseline: input.stockBaseline, enforceSkuStockBaseline: true })
      } else {
        if (this.shouldSyncDefaultProductSku(input)) {
          await this.syncDefaultProductSkuFields(saved, manager)
        }
        if (input.defaultSku) {
          await this.applyDefaultSkuExtras(saved, input.defaultSku, manager)
        }
      }
      await this.recordManualStockAdjustments(saved, stockSnapshot, actor, manager)
      return this.buildProductView(saved, manager)
    })
    invalidateMallCatalogReadCache()
    return result
  }

  /**
   * 拍下商品编辑前的库存快照：
   * - 包含商品汇总库存与全部 SKU（含已退役）的物理库存、启用状态，供事后逐项生成调整流水；
   * - MySQL 下对 SKU 加写锁，与出库扣减的加锁顺序（商品 → SKU）保持一致。
   */
  private async captureProductStockSnapshot(product: BaseProduct, manager: EntityManager): Promise<ProductStockSnapshot> {
    const skuQuery = manager.getRepository(BaseProductSku)
      .createQueryBuilder('sku')
      .where('sku.productId = :productId', { productId: product.id })
      .orderBy('sku.id', 'ASC')
    if (manager.connection.options.type !== 'sqlite') skuQuery.setLock('pessimistic_write')
    const skus = await skuQuery.getMany()
    return {
      productCurrentStock: Number(product.currentStock ?? 0),
      productPreOrderedStock: Number(product.preOrderedStock ?? 0),
      skus: new Map(skus.map((sku) => [String(sku.id), {
        currentStock: Number(sku.currentStock ?? 0),
        preOrderedStock: Number(sku.preOrderedStock ?? 0),
        contributes: isDatabaseFlagEnabled(sku.isCurrent) && isDatabaseFlagEnabled(sku.isActive),
      }])),
    }
  }

  /**
   * 商品级库存基线校验：提交的物理库存与数据库不一致时，必须携带且匹配打开编辑时的基线。
   * 未提交库存字段或提交值与数据库一致时不做任何限制。
   */
  private assertProductLevelStockBaseline(product: BaseProduct, input: UpdateProductInput): void {
    if (typeof input.currentStock !== 'number') return
    // 显式提交 SKU 列表时，商品汇总库存由 SKU 重新计算，商品级字段不会落库，无需校验。
    if (Array.isArray(input.skus) && input.skus.length > 0) return
    const databaseStock = Number(product.currentStock ?? 0)
    if (input.currentStock === databaseStock) return
    this.assertStockBaselineMatches(databaseStock, input.stockBaseline?.currentStock, product.productName)
  }

  private assertStockBaselineMatches(databaseStock: number, baselineStock: number | undefined, label: string): void {
    if (typeof baselineStock !== 'number') {
      throw new BizError(`「${label}」库存调整缺少打开编辑时的库存基线，请刷新后重新编辑`, 409, {
        reason: 'PRODUCT_STOCK_BASELINE_REQUIRED',
        currentStock: databaseStock,
      })
    }
    if (baselineStock !== databaseStock) {
      throw new BizError(
        `「${label}」库存已被出入库变动（打开编辑时 ${baselineStock}，当前 ${databaseStock}），请刷新后重新编辑`,
        409,
        { reason: 'PRODUCT_STOCK_BASELINE_CONFLICT', currentStock: databaseStock, baselineStock },
      )
    }
  }

  /**
   * 生成商品编辑导致的库存调整流水：
   * - 逐个 SKU 比较“对商品汇总的贡献”（启用且当前版本才计入）与物理库存，变化即写一条 `manual_stock_adjust`（新建商品为 `stock_initial`）；
   * - 商品汇总前后值按流水顺序串联，若最终仍与落库汇总不一致（历史汇总漂移被重算纠正），补一条无 SKU 的汇总校正流水；
   * - 预订库存不在商品编辑中改动，流水前后预订量保持一致。
   */
  private async recordManualStockAdjustments(
    product: BaseProduct,
    snapshot: ProductStockSnapshot,
    actor: AuthUserContext,
    manager: EntityManager,
    mode: 'edit' | 'create' = 'edit',
  ): Promise<void> {
    const skus = await manager.getRepository(BaseProductSku).find({ where: { productId: product.id }, order: { id: 'ASC' } })
    const logRepo = manager.getRepository(InventoryLog)
    const logs: InventoryLog[] = []
    const finalProductStock = Number(product.currentStock ?? 0)
    const preOrderedStock = Number(product.preOrderedStock ?? 0)
    let runningProductStock = snapshot.productCurrentStock
    const baseLog = {
      productId: String(product.id),
      changeType: mode === 'create' ? 'stock_initial' : 'manual_stock_adjust',
      beforePreorderedStock: snapshot.productPreOrderedStock,
      afterPreorderedStock: preOrderedStock,
      operatorType: 'admin',
      operatorId: actor.userId,
      operatorName: actor.displayName,
      refType: 'base_product',
      refId: String(product.id),
    }

    for (const sku of skus) {
      const before = snapshot.skus.get(String(sku.id))
      const afterSkuStock = Number(sku.currentStock ?? 0)
      const afterContributes = isDatabaseFlagEnabled(sku.isCurrent) && isDatabaseFlagEnabled(sku.isActive)
      // 本次新建的 SKU 视为一开始就处于最终的汇总状态，只记一条库存流水，不再额外记“计入汇总”。
      const beforeContributes = before ? before.contributes : afterContributes
      const beforeSkuStock = before?.currentStock ?? 0
      const skuPreOrderedStock = Number(sku.preOrderedStock ?? 0)

      // 第一条：SKU 物理库存变化（在变化前的汇总状态下发生），changeQty 与 SKU 快照差值一致；
      // 仅当该 SKU 变化前参与汇总时商品快照同步变化，否则商品快照前后相同。
      const stockDelta = afterSkuStock - beforeSkuStock
      if (stockDelta !== 0) {
        const beforeProductStock = runningProductStock
        runningProductStock += beforeContributes ? stockDelta : 0
        logs.push(logRepo.create({
          ...baseLog,
          skuId: String(sku.id),
          changeQty: stockDelta,
          beforeCurrentStock: beforeProductStock,
          afterCurrentStock: runningProductStock,
          beforeSkuCurrentStock: beforeSkuStock,
          afterSkuCurrentStock: afterSkuStock,
          beforeSkuPreorderedStock: before?.preOrderedStock ?? skuPreOrderedStock,
          afterSkuPreorderedStock: before?.preOrderedStock ?? skuPreOrderedStock,
          remark: `${mode === 'create' ? '新建商品初始库存' : '商品编辑调整'} SKU ${sku.skuCode} 库存 ${beforeSkuStock} → ${afterSkuStock}${beforeContributes ? '' : '（该规格不计入商品汇总）'}`,
        }))
      }

      // 第二条：规格启停或退役导致移入/移出商品汇总，SKU 物理库存不变，changeQty 与商品快照差值一致。
      if (beforeContributes !== afterContributes && afterSkuStock !== 0) {
        const aggregateDelta = afterContributes ? afterSkuStock : -afterSkuStock
        const beforeProductStock = runningProductStock
        runningProductStock += aggregateDelta
        logs.push(logRepo.create({
          ...baseLog,
          skuId: String(sku.id),
          changeQty: aggregateDelta,
          beforeCurrentStock: beforeProductStock,
          afterCurrentStock: runningProductStock,
          beforeSkuCurrentStock: afterSkuStock,
          afterSkuCurrentStock: afterSkuStock,
          beforeSkuPreorderedStock: skuPreOrderedStock,
          afterSkuPreorderedStock: skuPreOrderedStock,
          remark: afterContributes
            ? `商品编辑启用 SKU ${sku.skuCode}，库存 ${afterSkuStock} 计入商品汇总`
            : `商品编辑停用或退役 SKU ${sku.skuCode}，库存 ${afterSkuStock} 移出商品汇总`,
        }))
      }
    }

    if (runningProductStock !== finalProductStock) {
      logs.push(logRepo.create({
        ...baseLog,
        skuId: null,
        changeQty: finalProductStock - runningProductStock,
        beforeCurrentStock: runningProductStock,
        afterCurrentStock: finalProductStock,
        beforeSkuCurrentStock: null,
        afterSkuCurrentStock: null,
        beforeSkuPreorderedStock: null,
        afterSkuPreorderedStock: null,
        remark: `商品编辑校正汇总库存 ${runningProductStock} → ${finalProductStock}`,
      }))
    }

    if (logs.length > 0) await logRepo.save(logs)
  }

  async batchUpdate(input: BatchUpdateProductInput, actor: AuthUserContext): Promise<ProductView[]> {
    const productIds = [...new Set(input.ids.map((item) => normalizeEntityId(item)).filter(Boolean))]
      .sort((left, right) => left.localeCompare(right))
    if (!productIds.length) {
      throw new BizError('至少选择一个产品')
    }
    if (typeof input.isActive !== 'boolean') {
      throw new BizError('至少提供一个可更新字段')
    }

    const result = await runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, actor.userId)
      const repo = manager.getRepository(BaseProduct)
      const productQuery = repo
        .createQueryBuilder('product')
        .where('product.id IN (:...productIds)', { productIds })
        .orderBy('product.id', 'ASC')
      if (manager.connection.options.type !== 'sqlite') productQuery.setLock('pessimistic_write')
      const products = await productQuery.getMany()

      if (products.length !== productIds.length) {
        throw new BizError('存在无效产品，批量更新失败')
      }

      products.forEach((product) => {
        product.isActive = input.isActive as boolean
        product.o2oStatus = resolveEffectiveO2oStatus(product.isActive, undefined, product.o2oStatus)
      })

      const saved = await repo.save(products)
      return this.buildProductViews(saved, manager)
    })
    invalidateMallCatalogReadCache()
    return result
  }

  async delete(id: string, actor: AuthUserContext): Promise<void> {
    await runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, actor.userId)
      const productRepo = manager.getRepository(BaseProduct)
      const product = await productRepo.findOne({
        where: { id },
        select: ['id', 'productName'],
        lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
      })
      if (!product) {
        throw new BizError('产品不存在', 404)
      }

      const referenceResults = await Promise.all(
        PRODUCT_REFERENCE_LABELS.map(async ({ repoEntity, label }) => {
          const count = await manager.getRepository(repoEntity).count({
            where: { productId: id },
          })
          return {
            label,
            count,
          }
        }),
      )

      const referencedLabels = referenceResults
        .filter((item) => item.count > 0)
        .map((item) => item.label)

      if (referencedLabels.length) {
        throw new BizError(
          `产品“${product.productName}”已被${referencedLabels.join('、')}引用，无法删除；如不再使用，建议改为停用。`,
          409,
        )
      }

      await manager.getRepository(RelProductTag).delete({ productId: id })
      const result = await productRepo.delete({ id })
      if (!result.affected) {
        throw new BizError('产品不存在', 404)
      }
    })
    invalidateMallCatalogReadCache()
  }

  private async replaceProductTags(
    productId: string,
    tagIds: Array<string | number>,
    manager = AppDataSource.manager,
  ): Promise<void> {
    const relationRepo = manager.getRepository(RelProductTag)
    await relationRepo.delete({ productId })

    const uniqueIds = normalizeTagIds(tagIds)
    if (!uniqueIds.length) {
      return
    }

    const existsTags = await manager.getRepository(BaseTag).find({
      where: { id: In(uniqueIds) },
      select: ['id'],
    })

    if (existsTags.length !== uniqueIds.length) {
      throw new BizError('存在无效标签ID')
    }

    const rows = uniqueIds.map((tagId) =>
      relationRepo.create({
        productId,
        tagId,
      }),
    )
    await relationRepo.save(rows)
  }

  private normalizeSpecGroups(input: ProductSpecGroupInput[] | undefined): ProductSpecGroupInput[] {
    if (!Array.isArray(input)) {
      return []
    }
    return input
      .map((group) => ({
        name: normalizeSpecTextValue(group?.name),
        values: Array.isArray(group?.values)
          ? [...new Set(group.values.map(normalizeSpecTextValue).filter(Boolean))]
          : [],
      }))
      .filter((group) => group.name && group.values.length)
  }

  private normalizeSkuInputs(product: BaseProduct, input: CreateProductInput | UpdateProductInput): ProductSkuInput[] {
    if (Array.isArray(input.skus) && input.skus.length) {
      return input.skus
    }
    // 默认规格不显式传编码：已存在的默认 SKU 保留原编码（已打印的标签依赖它），
    // 新建时再由 replaceProductSkus 按分类生成 WC 编码或回退为 `${productCode}-DEFAULT`。
    return [{
      ...input.defaultSku,
      specValues: {},
      defaultPrice: Number(product.defaultPrice ?? 0),
      discountRate: Number(product.discountRate ?? 10),
      currentStock: Number(product.currentStock ?? 0),
      preOrderedStock: Number(product.preOrderedStock ?? 0),
      isActive: true,
      isCurrent: true,
      o2oRecommended: false,
      thumbnail: product.thumbnail,
      sortOrder: 0,
    }]
  }

  private buildProductSkuEntity(
    product: BaseProduct,
    input: ProductSkuInput,
    specGroups: ProductSpecGroupInput[],
    index: number,
    repo: Repository<BaseProductSku>,
  ): BaseProductSku {
    const specValues = normalizeSpecValuesRecord(input.specValues)
    const specText = buildSpecText(specValues, specGroups)
    const defaultPrice = this.readOptionalPrice(input.defaultPrice, 'SKU 原价')
      ?? normalizeDecimalText(product.defaultPrice)
    const discountRate = this.readOptionalDiscountRate(input.discountRate, 'SKU 折扣')
      ?? normalizeDiscountRate(product.discountRate)
    const currentStock = this.readOptionalInteger(
      input.currentStock,
      'SKU 物理库存',
      0,
      PRODUCT_FIELD_LIMITS.maxStock,
    ) ?? 0
    const preOrderedStock = this.readOptionalInteger(
      input.preOrderedStock,
      'SKU 预订库存',
      0,
      PRODUCT_FIELD_LIMITS.maxStock,
    ) ?? 0
    this.assertStockRelation(currentStock, preOrderedStock)

    const rawSkuCode = normalizeSpecTextValue(input.skuCode) || `${product.productCode}-SKU-${index + 1}`
    const skuCode = this.readLimitedText(rawSkuCode, 'SKU 编码', 96, { required: true }) as string
    const thumbnail = typeof input.thumbnail === 'string' || input.thumbnail === null
      ? normalizeProductThumbnailUrl(input.thumbnail)
      : product.thumbnail

    return repo.create({
      productId: product.id,
      skuCode,
      barcode: this.readOptionalBarcode(input.barcode) ?? null,
      costPrice: input.costPrice === null ? null : (this.readOptionalPrice(input.costPrice ?? undefined, 'SKU 成本价') ?? null),
      locationId: input.locationId === null || input.locationId === undefined || String(input.locationId).trim() === ''
        ? null
        : normalizeEntityId(input.locationId),
      specValuesJson: JSON.stringify(specValues),
      specText,
      defaultPrice,
      discountRate,
      currentStock,
      preOrderedStock,
      isActive: input.isActive !== false,
      isCurrent: input.isCurrent !== false,
      o2oRecommended: input.o2oRecommended === true,
      thumbnail: thumbnail ?? null,
      sortOrder: this.readOptionalInteger(input.sortOrder, 'SKU 排序', 0, PRODUCT_FIELD_LIMITS.maxStock) ?? index,
    })
  }

  private async replaceProductSkus(
    product: BaseProduct,
    input: CreateProductInput | UpdateProductInput,
    manager = AppDataSource.manager,
    options: { stockBaseline?: ProductStockBaselineInput; enforceSkuStockBaseline?: boolean } = {},
  ): Promise<void> {
    const skuRepo = manager.getRepository(BaseProductSku)
    const specGroups = this.normalizeSpecGroups(input.specGroups)
    // 只对调用方显式提交的 SKU 库存做基线校验；缺省 SKU 由商品级字段推导，已在商品级校验。
    const shouldEnforceSkuBaseline = options.enforceSkuStockBaseline === true && Array.isArray(input.skus) && input.skus.length > 0
    const skuBaselineMap = new Map((options.stockBaseline?.skus ?? []).map((item) => [String(item.id), Number(item.currentStock)]))
    const skuInputs = this.normalizeSkuInputs(product, input)
    const isSynthesizedDefaultMatrix = !(Array.isArray(input.skus) && input.skus.length)
    const existingSkuQuery = skuRepo
      .createQueryBuilder('sku')
      .where('sku.productId = :productId', { productId: product.id })
      .orderBy('sku.id', 'ASC')
    if (manager.connection.options.type !== 'sqlite') {
      existingSkuQuery.setLock('pessimistic_write')
    }
    const existingSkus = await existingSkuQuery.getMany()
    const currentExistingSkus = existingSkus.filter((sku) => isDatabaseFlagEnabled(sku.isCurrent))
    const existingSkuById = new Map(currentExistingSkus.map((sku) => [String(sku.id), sku]))
    const existingSkuBySpecKey = new Map<string, BaseProductSku>()
    currentExistingSkus.forEach((sku) => {
      existingSkuBySpecKey.set(buildSkuEntitySpecValuesKey(sku), sku)
    })
    const existingSkuCodeSet = new Set(existingSkus.map((sku) => sku.skuCode))
    const usedSkuCodeSet = new Set<string>()

    const allocateSkuCode = (sku: BaseProductSku, matchedSku: BaseProductSku | undefined, skuInput: ProductSkuInput) => {
      const isMatchedOwner = matchedSku?.skuCode === sku.skuCode
      const conflictsWithExisting = existingSkuCodeSet.has(sku.skuCode) && !isMatchedOwner
      const conflictsWithBatch = usedSkuCodeSet.has(sku.skuCode)
      if (!conflictsWithExisting && !conflictsWithBatch) {
        usedSkuCodeSet.add(sku.skuCode)
        return
      }

      if (skuInput.skuCode !== undefined) {
        throw new BizError(`SKU code ${sku.skuCode} already exists`, 409)
      }

      const baseCode = sku.skuCode.slice(0, 88)
      let suffix = 2
      let nextCode = `${baseCode}-${suffix}`
      while (existingSkuCodeSet.has(nextCode) || usedSkuCodeSet.has(nextCode)) {
        suffix += 1
        nextCode = `${baseCode}-${suffix}`
      }
      sku.skuCode = nextCode
      usedSkuCodeSet.add(nextCode)
    }

    const categoryCode = product.categoryId
      ? (await manager.getRepository(BaseCategory).findOne({ where: { id: product.categoryId }, select: ['id', 'categoryCode'] }))?.categoryCode ?? null
      : null
    const submittedBarcodeSet = new Set(skuInputs.map((item) => this.readOptionalBarcode(item.barcode)).filter((code): code is string => Boolean(code)))
    const skuEntities: BaseProductSku[] = []
    for (const [index, skuInput] of skuInputs.entries()) {
      const skuEntity = this.buildProductSkuEntity(product, skuInput, specGroups, index, skuRepo)
      const specKey = buildSkuEntitySpecValuesKey(skuEntity)
      const matchedById = skuInput.id ? existingSkuById.get(String(skuInput.id)) : undefined
      const matchedSku = matchedById && buildSkuEntitySpecValuesKey(matchedById) === specKey
        ? matchedById
        : existingSkuBySpecKey.get(specKey)
      if (matchedSku && String(matchedSku.productId) === String(product.id)) {
        skuEntity.id = matchedSku.id
        if (skuInput.skuCode === undefined) {
          skuEntity.skuCode = matchedSku.skuCode
        }
        if (skuInput.currentStock === undefined) {
          skuEntity.currentStock = matchedSku.currentStock
        } else if (shouldEnforceSkuBaseline && Number(skuEntity.currentStock) !== Number(matchedSku.currentStock)) {
          // 提交的 SKU 库存与锁内数据库值不同：必须证明打开编辑时看到的就是当前值，否则视为覆盖并发出入库。
          this.assertStockBaselineMatches(
            Number(matchedSku.currentStock),
            skuBaselineMap.get(String(matchedSku.id)),
            `${product.productName} / ${matchedSku.specText || matchedSku.skuCode}`,
          )
        }
        // 预订占用只能由 O2O 订单生命周期记账。商品编辑即使回传或伪造该字段，
        // 也必须以已加锁的数据库值为准，避免先把占用改成 0 再停用 SKU。
        skuEntity.preOrderedStock = matchedSku.preOrderedStock
        if (skuInput.thumbnail === undefined) {
          skuEntity.thumbnail = matchedSku.thumbnail
        }
        if (skuInput.isActive === undefined) {
          skuEntity.isActive = matchedSku.isActive
        }
        if (skuInput.o2oRecommended === undefined) {
          skuEntity.o2oRecommended = matchedSku.o2oRecommended
        }
        if (skuInput.sortOrder === undefined) {
          skuEntity.sortOrder = matchedSku.sortOrder
        }
        if (skuInput.barcode === undefined) {
          skuEntity.barcode = matchedSku.barcode
        }
        if (skuInput.costPrice === undefined) {
          skuEntity.costPrice = matchedSku.costPrice
        }
        if (skuInput.locationId === undefined) {
          skuEntity.locationId = matchedSku.locationId
        }
        this.assertStockRelation(skuEntity.currentStock, skuEntity.preOrderedStock)
      }
      skuEntity.isCurrent = true
      if (!matchedSku && skuInput.skuCode === undefined && categoryCode) {
        // 已归类商品的新规格按 WC + 分类码 + 流水号编码；流水号与手工编码或原厂条码撞码时继续取下一个。
        let wcCode = await allocateWcSkuCode(manager, categoryCode)
        while (
          existingSkuCodeSet.has(wcCode)
          || usedSkuCodeSet.has(wcCode)
          || submittedBarcodeSet.has(wcCode)
          || await skuRepo.exists({ where: [{ skuCode: wcCode }, { barcode: wcCode }] })
        ) {
          wcCode = await allocateWcSkuCode(manager, categoryCode)
        }
        skuEntity.skuCode = wcCode
      } else if (!matchedSku && skuInput.skuCode === undefined && isSynthesizedDefaultMatrix) {
        skuEntity.skuCode = `${product.productCode}-DEFAULT`
      }
      allocateSkuCode(skuEntity, matchedSku, skuInput)
      skuEntities.push(skuEntity)
    }
    await this.assertSkuRelationsValid(product, skuEntities, manager)
    const specTextSet = new Set<string>()
    const skuCodeSet = new Set<string>()
    skuEntities.forEach((sku) => {
      if (specTextSet.has(sku.specText)) {
        throw new BizError(`SKU 规格组合「${sku.specText}」重复`, 409)
      }
      if (skuCodeSet.has(sku.skuCode)) {
        throw new BizError(`SKU 编码「${sku.skuCode}」重复`, 409)
      }
      specTextSet.add(sku.specText)
      skuCodeSet.add(sku.skuCode)
      if (!isDatabaseFlagEnabled(sku.isActive) && Number(sku.preOrderedStock ?? 0) > 0) {
        throw new BizError(`SKU「${sku.specText}」仍有 ${sku.preOrderedStock} 件预订占用，释放或核销完成前不能停用`, 409)
      }
    })

    const nextSkuIdSet = new Set(skuEntities.filter((sku) => sku.id).map((sku) => String(sku.id)))
    const inactiveLegacySkus = existingSkus
      .filter((sku) => !nextSkuIdSet.has(String(sku.id)))
      .map((sku) => {
        if (Number(sku.preOrderedStock ?? 0) > 0) {
          throw new BizError(`SKU「${sku.specText}」仍有 ${sku.preOrderedStock} 件预订占用，释放或核销完成前不能退役`, 409)
        }
        sku.isActive = false
        sku.isCurrent = false
        sku.o2oRecommended = false
        return sku
      })
    // 条码全局唯一：退役规格释放条码（退役规格不能再做库存操作，也不参与扫码），
    // 保留规格若改了条码，先在库里置空，保证两个规格互换条码时不会撞唯一索引。
    const existingBarcodeById = new Map(existingSkus.map((sku) => [String(sku.id), sku.barcode ?? null]))
    const releaseBarcodeIds = [
      ...inactiveLegacySkus.filter((sku) => sku.barcode).map((sku) => String(sku.id)),
      ...skuEntities
        .filter((sku) => sku.id && existingBarcodeById.get(String(sku.id)) && existingBarcodeById.get(String(sku.id)) !== (sku.barcode ?? null))
        .map((sku) => String(sku.id)),
    ]
    inactiveLegacySkus.forEach((sku) => {
      sku.barcode = null
    })
    if (releaseBarcodeIds.length) {
      await skuRepo.createQueryBuilder().update(BaseProductSku).set({ barcode: null }).whereInIds(releaseBarcodeIds).execute()
    }
    if (inactiveLegacySkus.length) {
      await skuRepo.save(inactiveLegacySkus)
    }
    const savedSkus = await skuRepo.save(skuEntities)

    const summarySkus = savedSkus.filter((sku) => isDatabaseFlagEnabled(sku.isCurrent) && isDatabaseFlagEnabled(sku.isActive))
    product.currentStock = summarySkus.reduce((sum, sku) => sum + Math.max(0, Number(sku.currentStock ?? 0)), 0)
    product.preOrderedStock = summarySkus.reduce((sum, sku) => sum + Math.max(0, Number(sku.preOrderedStock ?? 0)), 0)
    await manager.getRepository(BaseProduct).save(product)
  }

  /** 单规格商品编辑时写入默认规格的条码、成本价与库位；多规格商品必须通过 skus 逐行提交。 */
  private async applyDefaultSkuExtras(product: BaseProduct, extras: ProductDefaultSkuExtras, manager: EntityManager): Promise<void> {
    const skuRepo = manager.getRepository(BaseProductSku)
    const skus = (await skuRepo.find({ where: { productId: product.id } })).filter((sku) => isDatabaseFlagEnabled(sku.isCurrent))
    const [sku] = skus
    if (skus.length !== 1 || !sku || !this.isDefaultProductSku(sku)) {
      throw new BizError('多规格商品请在规格配置中逐个设置条码、成本价与库位', 400)
    }
    if (extras.barcode !== undefined) sku.barcode = this.readOptionalBarcode(extras.barcode) ?? null
    if (extras.costPrice !== undefined) {
      sku.costPrice = extras.costPrice === null ? null : this.readOptionalPrice(extras.costPrice, 'SKU 成本价') ?? null
    }
    if (extras.locationId !== undefined) {
      sku.locationId = extras.locationId === null || String(extras.locationId).trim() === '' ? null : normalizeEntityId(extras.locationId)
    }
    await this.assertSkuRelationsValid(product, [sku], manager)
    await skuRepo.save(sku)
  }

  private shouldSyncDefaultProductSku(input: UpdateProductInput): boolean {
    return input.defaultPrice !== undefined
      || input.discountRate !== undefined
      || input.currentStock !== undefined
      || input.isActive !== undefined
      || input.thumbnail !== undefined
  }

  private isDefaultProductSku(sku: BaseProductSku): boolean {
    const specValues = parseSpecValuesJson(sku.specValuesJson)
    return Object.keys(specValues).length === 0 || sku.specText === '默认规格'
  }

  private async syncDefaultProductSkuFields(product: BaseProduct, manager = AppDataSource.manager): Promise<void> {
    const skuRepo = manager.getRepository(BaseProductSku)
    const skus = (await skuRepo.find({ where: { productId: product.id } }))
      .filter((sku) => isDatabaseFlagEnabled(sku.isCurrent))
    if (!skus.length) {
      await this.replaceProductSkus(product, {}, manager)
      return
    }
    if (skus.length > 1) {
      return
    }
    const [sku] = skus
    if (sku && this.isDefaultProductSku(sku)) {
      const nextIsActive = Boolean(product.isActive)
      // 与 replaceProductSkus 里的停用/退役守卫保持同一口径：唯一默认 SKU 仍有在途预订占用时，
      // 不允许通过商品级 isActive 字段间接把它停用，否则会重新制造出“非活跃 SKU 仍持有占用”的状态。
      if (!nextIsActive && isDatabaseFlagEnabled(sku.isActive) && Number(sku.preOrderedStock ?? 0) > 0) {
        throw new BizError(`SKU「${sku.specText}」仍有 ${sku.preOrderedStock} 件预订占用，释放或核销完成前不能停用`, 409)
      }
      sku.defaultPrice = normalizeDecimalText(product.defaultPrice)
      sku.discountRate = normalizeDiscountRate(product.discountRate)
      sku.currentStock = Math.max(0, Number(product.currentStock ?? 0))
      sku.isActive = nextIsActive
      sku.isCurrent = true
      sku.thumbnail = product.thumbnail ?? null
      this.assertStockRelation(sku.currentStock, sku.preOrderedStock)
      await skuRepo.save(sku)
      product.currentStock = Math.max(0, Number(sku.currentStock ?? 0))
      product.preOrderedStock = Math.max(0, Number(sku.preOrderedStock ?? 0))
      await manager.getRepository(BaseProduct).save(product)
      return
    }
    if (!sku || (sku.specText && sku.specText !== '默认规格')) {
      return
    }
    sku.discountRate = normalizeDiscountRate(product.discountRate)
    await skuRepo.save(sku)
  }

  private async buildProductView(product: BaseProduct, manager = AppDataSource.manager): Promise<ProductView> {
    const [view] = await this.buildProductViews([product], manager)
    if (!view) {
      throw new BizError('产品不存在', 404)
    }

    return view
  }

  private async buildProductViews(
    products: BaseProduct[],
    manager: EntityManager = AppDataSource.manager,
  ): Promise<ProductView[]> {
    if (!products.length) {
      return []
    }

    const productIds = products.map((product) => normalizeEntityId(product.id))
    const relations = await manager.getRepository(RelProductTag).find({
      where: { productId: In(productIds) },
      relations: {
        tag: true,
      },
      order: {
        id: 'ASC',
      },
    })
    const skus = await manager.getRepository(BaseProductSku).find({
      where: { productId: In(productIds) },
      order: {
        productId: 'ASC',
        sortOrder: 'ASC',
        id: 'ASC',
      },
    })

    const categoryIds = [...new Set(products.map((product) => product.categoryId).filter(Boolean).map(String))]
    const locationIds = [...new Set(skus.map((sku) => sku.locationId).filter(Boolean).map(String))]
    const [categories, locations] = await Promise.all([
      categoryIds.length ? manager.getRepository(BaseCategory).find({ where: { id: In(categoryIds) } }) : [],
      locationIds.length ? manager.getRepository(BaseStorageLocation).find({ where: { id: In(locationIds) } }) : [],
    ])
    const categoryMap = new Map(categories.map((category) => [String(category.id), category]))
    const locationCodeMap = new Map(locations.map((location) => [String(location.id), location.locationCode]))

    const productTagMap = new Map<string, ProductTagView[]>()
    relations.forEach((relation) => {
      const productId = normalizeEntityId(relation.productId)
      const currentTags = productTagMap.get(productId) ?? []
      currentTags.push({
        id: normalizeEntityId(relation.tag?.id ?? relation.tagId),
        tagName: relation.tag?.tagName ?? '',
        tagCode: relation.tag?.tagCode ?? null,
      })
      productTagMap.set(productId, currentTags)
    })
    const productSkuMap = new Map<string, ProductSkuView[]>()
    skus.forEach((sku) => {
      const productId = normalizeEntityId(sku.productId)
      const currentSkus = productSkuMap.get(productId) ?? []
      currentSkus.push(this.buildProductSkuView(sku, locationCodeMap))
      productSkuMap.set(productId, currentSkus)
    })

    return products.map((product) => {
      const productId = normalizeEntityId(product.id)
      const tags = productTagMap.get(productId) ?? []
      const allProductSkus = productSkuMap.get(productId) ?? []
      const productSkus = allProductSkus.filter((sku) => isDatabaseFlagEnabled(sku.isCurrent))
      const inventory = summarizeProductInventory(product, allProductSkus)
      const category = product.categoryId ? categoryMap.get(String(product.categoryId)) : undefined

      return {
        id: productId,
        productCode: product.productCode,
        productName: product.productName,
        pinyinAbbr: product.pinyinAbbr || '',
        defaultPrice: normalizeDecimalText(product.defaultPrice),
        discountRate: normalizeDiscountRate(product.discountRate),
        discountedPrice: calculateDiscountedPrice(product.defaultPrice, product.discountRate),
        isActive: Boolean(product.isActive),
        o2oStatus: product.o2oStatus ?? 'unlisted',
        o2oRecommended: Boolean(product.o2oRecommended),
        thumbnail: normalizeProductThumbnailUrl(product.thumbnail) ?? null,
        detailContent: product.detailContent ?? null,
        limitPerUser: Number(product.limitPerUser ?? 5),
        ...inventory,
        tagIds: tags.map((tag) => tag.id),
        tags,
        categoryId: product.categoryId ? normalizeEntityId(product.categoryId) : null,
        categoryCode: category?.categoryCode ?? null,
        categoryName: category?.categoryName ?? null,
        specGroups: this.buildSpecGroupsFromSkus(productSkus),
        skus: productSkus,
      }
    })
  }

  private buildProductSkuView(sku: BaseProductSku, locationCodeMap?: Map<string, string>): ProductSkuView {
    const specValues = parseSpecValuesJson(sku.specValuesJson)
    const originalPrice = normalizeDecimalText(sku.defaultPrice)
    const discountRate = normalizeDiscountRate(sku.discountRate)
    const discountedPrice = calculateDiscountedPrice(originalPrice, discountRate)
    const currentStock = Math.max(0, Number(sku.currentStock ?? 0))
    const preOrderedStock = Math.max(0, Number(sku.preOrderedStock ?? 0))

    return {
      id: normalizeEntityId(sku.id),
      productId: normalizeEntityId(sku.productId),
      skuCode: sku.skuCode,
      specValues,
      specText: sku.specText || buildSpecText(specValues),
      defaultPrice: originalPrice,
      originalPrice,
      discountRate,
      discountedPrice,
      currentStock,
      preOrderedStock,
      availableStock: Math.max(0, currentStock - preOrderedStock),
      isActive: isDatabaseFlagEnabled(sku.isActive),
      isCurrent: isDatabaseFlagEnabled(sku.isCurrent),
      o2oRecommended: Boolean(sku.o2oRecommended),
      thumbnail: normalizeProductThumbnailUrl(sku.thumbnail) ?? null,
      sortOrder: Number(sku.sortOrder ?? 0),
      barcode: sku.barcode ?? null,
      effectiveBarcode: sku.barcode || sku.skuCode,
      costPrice: sku.costPrice === null || sku.costPrice === undefined ? null : normalizeDecimalText(sku.costPrice),
      locationId: sku.locationId ? normalizeEntityId(sku.locationId) : null,
      locationCode: locationCodeMap?.get(String(sku.locationId ?? '')) ?? null,
    }
  }

  private buildSpecGroupsFromSkus(skus: ProductSkuView[]): ProductSpecGroupView[] {
    const groupValueMap = new Map<string, string[]>()
    skus.forEach((sku) => {
      Object.entries(sku.specValues).forEach(([name, value]) => {
        const currentValues = groupValueMap.get(name) ?? []
        if (value && !currentValues.includes(value)) {
          currentValues.push(value)
        }
        groupValueMap.set(name, currentValues)
      })
    })
    return [...groupValueMap.entries()].map(([name, values]) => ({ name, values }))
  }

  /**
   * 扫码识别：先按原厂条码精确匹配，再按 SKU 编码精确匹配；同码时优先当前版本、启用中的规格。
   * 返回的 SKU 视图带库存，调用方按权限决定是否裁剪。
   */
  async lookupByCode(rawCode: string): Promise<ProductLookupView> {
    const code = String(rawCode ?? '').trim()
    if (!code || code.length > 96) throw new BizError('请扫描或输入有效的条码', 400)
    const skuRepo = AppDataSource.getRepository(BaseProductSku)
    // 条码与编码两路合并：优先当前版本、启用中的规格，同等条件下条码命中优先。
    const [byBarcode, bySkuCode] = await Promise.all([
      skuRepo.find({ where: { barcode: code } }),
      skuRepo.find({ where: { skuCode: code } }),
    ])
    const candidates = [
      ...byBarcode.map((row) => ({ row, matchedBy: 'barcode' as const, rank: 1 })),
      ...bySkuCode.map((row) => ({ row, matchedBy: 'sku_code' as const, rank: 0 })),
    ].sort((left, right) =>
      Number(isDatabaseFlagEnabled(right.row.isCurrent)) - Number(isDatabaseFlagEnabled(left.row.isCurrent))
      || Number(isDatabaseFlagEnabled(right.row.isActive)) - Number(isDatabaseFlagEnabled(left.row.isActive))
      || right.rank - left.rank)
    const best = candidates[0]
    if (!best) throw new BizError(`未找到条码「${code}」对应的商品`, 404)
    const { row: sku, matchedBy } = best
    const product = await this.productRepo.findOne({ where: { id: sku.productId } })
    if (!product) throw new BizError(`未找到条码「${code}」对应的商品`, 404)
    const [category, location] = await Promise.all([
      product.categoryId ? AppDataSource.getRepository(BaseCategory).findOne({ where: { id: product.categoryId } }) : null,
      sku.locationId ? AppDataSource.getRepository(BaseStorageLocation).findOne({ where: { id: sku.locationId } }) : null,
    ])
    return {
      matchedBy,
      product: {
        id: normalizeEntityId(product.id),
        productCode: product.productCode,
        productName: product.productName,
        thumbnail: normalizeProductThumbnailUrl(product.thumbnail) ?? null,
        isActive: Boolean(product.isActive),
        categoryId: product.categoryId ? normalizeEntityId(product.categoryId) : null,
        categoryName: category?.categoryName ?? null,
      },
      sku: this.buildProductSkuView(sku, location ? new Map([[String(location.id), location.locationCode]]) : undefined),
    }
  }

  /** 条码打印数据：按传入顺序返回，条码图由前端生成。 */
  async listLabels(skuIds: Array<string | number>): Promise<ProductLabelView[]> {
    const ids = [...new Set(skuIds.map((id) => normalizeEntityId(id)).filter(Boolean))]
    if (!ids.length) throw new BizError('请至少选择一个规格', 400)
    if (ids.length > 500) throw new BizError('单次最多打印 500 个规格', 400)
    const skus = await AppDataSource.getRepository(BaseProductSku).find({ where: { id: In(ids) } })
    if (skus.length !== ids.length) throw new BizError('存在无效的规格，请刷新后重试', 404)
    const products = await this.productRepo.find({ where: { id: In([...new Set(skus.map((sku) => String(sku.productId)))]) } })
    const productMap = new Map(products.map((product) => [String(product.id), product]))
    const categoryIds = [...new Set(products.map((product) => product.categoryId).filter(Boolean).map(String))]
    const locationIds = [...new Set(skus.map((sku) => sku.locationId).filter(Boolean).map(String))]
    const [categories, locations] = await Promise.all([
      categoryIds.length ? AppDataSource.getRepository(BaseCategory).find({ where: { id: In(categoryIds) } }) : [],
      locationIds.length ? AppDataSource.getRepository(BaseStorageLocation).find({ where: { id: In(locationIds) } }) : [],
    ])
    const categoryMap = new Map(categories.map((category) => [String(category.id), category.categoryName]))
    const locationMap = new Map(locations.map((location) => [String(location.id), location.locationCode]))
    const skuMap = new Map(skus.map((sku) => [String(sku.id), sku]))
    return ids.map((id) => {
      const sku = skuMap.get(id) as BaseProductSku
      const product = productMap.get(String(sku.productId))
      return {
        skuId: id,
        skuCode: sku.skuCode,
        barcode: sku.barcode || sku.skuCode,
        productName: product?.productName ?? '',
        specText: sku.specText || '默认规格',
        price: calculateDiscountedPrice(sku.defaultPrice, sku.discountRate),
        categoryName: product?.categoryId ? categoryMap.get(String(product.categoryId)) ?? null : null,
        locationCode: sku.locationId ? locationMap.get(String(sku.locationId)) ?? null : null,
      }
    })
  }

  /** 分类只能指向存在的分类；新指定的分类必须启用，保持原分类不变时允许其已停用。 */
  private async resolveCategoryId(
    value: string | number | null | undefined,
    manager: EntityManager,
    currentCategoryId: string | null,
  ): Promise<string | null> {
    if (value === undefined) return currentCategoryId
    const id = value === null ? '' : normalizeEntityId(value)
    if (!id) return null
    const category = await manager.getRepository(BaseCategory).findOne({ where: { id } })
    if (!category) throw new BizError('商品分类不存在', 400)
    if (!isDatabaseFlagEnabled(category.isActive) && String(currentCategoryId ?? '') !== id) {
      throw new BizError(`商品分类「${category.categoryName}」已停用`, 400)
    }
    return String(category.id)
  }

  private readOptionalBarcode(value: string | null | undefined): string | null | undefined {
    if (value === undefined) return undefined
    const normalized = (value ?? '').trim()
    if (!normalized) return null
    if (!SKU_BARCODE_PATTERN.test(normalized)) {
      throw new BizError(`条码「${normalized}」只能包含 1 到 64 个半角字母、数字或符号`, 400)
    }
    return normalized
  }

  /**
   * 规格关联校验：
   * - 库位必须存在，新指定的库位必须启用；
   * - 扫码时条码与 SKU 编码共用一个命名空间，任何 SKU 的条码都不能与其他 SKU 的条码或编码相同。
   */
  private async assertSkuRelationsValid(product: BaseProduct, skus: BaseProductSku[], manager: EntityManager) {
    const skuRepo = manager.getRepository(BaseProductSku)
    const locationIds = [...new Set(skus.map((sku) => sku.locationId).filter(Boolean).map(String))]
    if (locationIds.length) {
      const locations = await manager.getRepository(BaseStorageLocation).find({ where: { id: In(locationIds) } })
      const locationMap = new Map(locations.map((location) => [String(location.id), location]))
      const existingSkus = await skuRepo.find({ where: { productId: product.id }, select: ['id', 'locationId'] })
      const existingLocationBySkuId = new Map(existingSkus.map((sku) => [String(sku.id), String(sku.locationId ?? '')]))
      for (const sku of skus) {
        if (!sku.locationId) continue
        const location = locationMap.get(String(sku.locationId))
        if (!location) throw new BizError('SKU 库位不存在，请刷新后重试', 400)
        const unchanged = Boolean(sku.id) && existingLocationBySkuId.get(String(sku.id)) === String(sku.locationId)
        if (!isDatabaseFlagEnabled(location.isActive) && !unchanged) {
          throw new BizError(`库位 ${location.locationCode} 已停用`, 400)
        }
      }
    }

    const seen = new Map<string, string>()
    for (const sku of skus) {
      for (const code of [sku.skuCode, sku.barcode]) {
        if (!code) continue
        const owner = seen.get(code)
        if (owner !== undefined && owner !== sku.skuCode) {
          throw new BizError(`条码或编码「${code}」在本商品的多个规格中重复`, 409)
        }
        seen.set(code, sku.skuCode)
      }
    }
    const barcodes = skus.map((sku) => sku.barcode).filter((code): code is string => Boolean(code))
    const allCodes = [...new Set([...barcodes, ...skus.map((sku) => sku.skuCode)])]
    const query = skuRepo.createQueryBuilder('sku')
      .select(['sku.id', 'sku.skuCode', 'sku.barcode', 'sku.productId'])
      .where('sku.barcode IN (:...allCodes)', { allCodes })
    if (barcodes.length) query.orWhere('sku.skuCode IN (:...barcodes)', { barcodes })
    const conflicts = await query.getMany()
    for (const other of conflicts) {
      if (String(other.productId) === String(product.id)) continue
      const hit = [other.barcode, other.skuCode].find((code) => code && allCodes.includes(code))
      throw new BizError(`条码或编码「${hit}」已被其他商品的规格使用`, 409)
    }
  }

  private assertNoDuplicateProductCodesInBatch(inputs: CreateProductInput[]): void {
    const productCodeRowMap = new Map<string, number>()

    inputs.forEach((input, rowIndex) => {
      const normalizedProductCode = normalizeProductCodeInput(input.productCode)
      if (!normalizedProductCode) {
        return
      }

      const duplicatedRow = productCodeRowMap.get(normalizedProductCode)
      if (duplicatedRow !== undefined) {
        throw new BizError(`第 ${rowIndex + 1} 行产品编码与第 ${duplicatedRow + 1} 行重复`, 409)
      }
      productCodeRowMap.set(normalizedProductCode, rowIndex)
    })
  }

  async createWithManager(input: CreateProductInput, manager: EntityManager, actor: AuthUserContext): Promise<ProductView> {
    const normalizedProductCode = normalizeProductCodeInput(input.productCode)
    const shouldGenerateProductCode = !normalizedProductCode
    const normalizedCreateInput = this.normalizeCreateInput(input)
    let lastError: unknown

    for (let attempt = 1; attempt <= PRODUCT_CREATE_MAX_RETRY; attempt += 1) {
      try {
        const repo = manager.getRepository(BaseProduct)
        const productCode = shouldGenerateProductCode ? await generateProductCode(manager) : normalizedProductCode
        const product = this.buildProductEntityForCreate(repo, normalizedCreateInput, productCode)
        product.categoryId = await this.resolveCategoryId(normalizedCreateInput.categoryId, manager, null)

        const saved = await repo.save(product)
        await this.replaceProductTags(saved.id, normalizedCreateInput.tagIds ?? [], manager)
        await this.replaceProductSkus(saved, normalizedCreateInput, manager)
        // 新建商品的初始库存同样要落流水，保证“库存 = 初始库存 + 各类变动”可追溯。
        await this.recordManualStockAdjustments(saved, {
          productCurrentStock: 0,
          productPreOrderedStock: Number(saved.preOrderedStock ?? 0),
          skus: new Map(),
        }, actor, manager, 'create')
        return this.buildProductView(saved, manager)
      } catch (error) {
        lastError = error

        if (this.shouldRetryCreateAttempt(error, attempt, shouldGenerateProductCode)) {
          continue
        }

        this.throwCreateError(error)
      }
    }

    throw lastError ?? new BizError('产品创建失败，请稍后重试', 500)
  }

  /**
   * 统一收敛商品文本字段：
   * - 创建和更新共用同一套长度与必填规则；
   * - 避免前端绕过页面校验后把超长或空白文本直接写入数据库。
   */
  private readLimitedText(
    value: string | null | undefined,
    label: string,
    maxLength: number,
    options: { required?: boolean; allowNull?: boolean } = {},
  ): string | null | undefined {
    if (value === null) {
      if (options.allowNull) {
        return null
      }
      throw new BizError(`${label}不能为空`, 400)
    }
    if (value === undefined) {
      if (options.required) {
        throw new BizError(`${label}不能为空`, 400)
      }
      return undefined
    }

    const normalizedValue = value.trim()
    if (!normalizedValue) {
      if (options.allowNull) {
        return null
      }
      throw new BizError(`${label}不能为空`, 400)
    }
    if (normalizedValue.length > maxLength) {
      throw new BizError(`${label}长度不能超过 ${maxLength} 个字符`, 400)
    }
    return normalizedValue
  }

  private readOptionalPrice(value: number | undefined, label: string): string | undefined {
    if (value === undefined) {
      return undefined
    }
    if (!Number.isFinite(value) || value < 0) {
      throw new BizError(`${label}不能小于 0`, 400)
    }
    if (value > PRODUCT_FIELD_LIMITS.priceMax) {
      throw new BizError(`${label}不能超过 ${PRODUCT_FIELD_LIMITS.priceMax}`, 400)
    }
    return normalizeDecimalText(value)
  }

  private readOptionalDiscountRate(value: number | undefined, label: string): string | undefined {
    if (value === undefined) {
      return undefined
    }
    try {
      return assertDiscountRateInRange(value, label)
    } catch (error) {
      throw new BizError(error instanceof Error ? error.message : `${label}不合法`, 400)
    }
  }

  private readOptionalInteger(
    value: number | undefined,
    label: string,
    minimum: number,
    maximum: number,
  ): number | undefined {
    if (value === undefined) {
      return undefined
    }
    if (!Number.isInteger(value)) {
      throw new BizError(`${label}必须为整数`, 400)
    }
    if (value < minimum) {
      throw new BizError(`${label}不能小于 ${minimum}`, 400)
    }
    if (value > maximum) {
      throw new BizError(`${label}不能超过 ${maximum}`, 400)
    }
    return value
  }

  private assertStockRelation(currentStock: number, preOrderedStock: number): void {
    if (preOrderedStock > currentStock) {
      throw new BizError('预订库存不能超过物理库存', 400)
    }
  }

  private normalizeCreateInput(input: CreateProductInput): CreateProductInput {
    const normalizedInput: CreateProductInput = {
      ...input,
      productName: this.readLimitedText(
        input.productName,
        '产品名称',
        PRODUCT_FIELD_LIMITS.name,
        { required: true },
      ) as string,
    }

    if (typeof input.productCode === 'string') {
      normalizedInput.productCode = this.readLimitedText(
        input.productCode,
        '产品编码',
        PRODUCT_FIELD_LIMITS.code,
      ) as string
    }
    if (typeof input.pinyinAbbr === 'string') {
      normalizedInput.pinyinAbbr = (this.readLimitedText(
        input.pinyinAbbr,
        '拼音首字母',
        PRODUCT_FIELD_LIMITS.pinyinAbbr,
      ) ?? '')
    }
    if (typeof input.thumbnail === 'string' || input.thumbnail === null) {
      normalizedInput.thumbnail = normalizeProductThumbnailUrl(
        this.readLimitedText(
          input.thumbnail,
          '商品缩略图地址',
          PRODUCT_FIELD_LIMITS.thumbnail,
          { allowNull: true },
        ),
      )
    }
    if (typeof input.detailContent === 'string' || input.detailContent === null) {
      normalizedInput.detailContent = this.readLimitedText(
        input.detailContent,
        '商品详情',
        PRODUCT_FIELD_LIMITS.detailContent,
        { allowNull: true },
      )
    }

    const normalizedPrice = this.readOptionalPrice(input.defaultPrice, '默认单价')
    if (normalizedPrice !== undefined) {
      normalizedInput.defaultPrice = Number(normalizedPrice)
    }
    const normalizedDiscountRate = this.readOptionalDiscountRate(input.discountRate, '商品折扣')
    if (normalizedDiscountRate !== undefined) {
      normalizedInput.discountRate = Number(normalizedDiscountRate)
    }

    const normalizedLimitPerUser = this.readOptionalInteger(
      input.limitPerUser,
      '单人限购数量',
      1,
      PRODUCT_FIELD_LIMITS.maxLimitPerUser,
    )
    if (normalizedLimitPerUser !== undefined) {
      normalizedInput.limitPerUser = normalizedLimitPerUser
    }

    const normalizedCurrentStock = this.readOptionalInteger(
      input.currentStock,
      '物理库存',
      0,
      PRODUCT_FIELD_LIMITS.maxStock,
    )
    const normalizedPreOrderedStock = this.readOptionalInteger(
      input.preOrderedStock,
      '预订库存',
      0,
      PRODUCT_FIELD_LIMITS.maxStock,
    )
    if (normalizedCurrentStock !== undefined) {
      normalizedInput.currentStock = normalizedCurrentStock
    }
    if (normalizedPreOrderedStock !== undefined) {
      normalizedInput.preOrderedStock = normalizedPreOrderedStock
    }
    this.assertStockRelation(normalizedInput.currentStock ?? 0, normalizedInput.preOrderedStock ?? 0)
    return normalizedInput
  }

  private applyUpdateInputToProduct(product: BaseProduct, input: UpdateProductInput): void {
    if (typeof input.productCode === 'string') {
      const normalizedProductCode = this.readLimitedText(
        input.productCode,
        '产品编码',
        PRODUCT_FIELD_LIMITS.code,
        { required: true },
      )
      product.productCode = normalizedProductCode as string
    }
    if (typeof input.productName === 'string') {
      product.productName = this.readLimitedText(
        input.productName,
        '产品名称',
        PRODUCT_FIELD_LIMITS.name,
        { required: true },
      ) as string
    }
    if (typeof input.pinyinAbbr === 'string') {
      product.pinyinAbbr = (this.readLimitedText(
        input.pinyinAbbr,
        '拼音首字母',
        PRODUCT_FIELD_LIMITS.pinyinAbbr,
      ) ?? '')
    }
    if (typeof input.defaultPrice === 'number') {
      product.defaultPrice = this.readOptionalPrice(input.defaultPrice, '默认单价') as string
    }
    if (typeof input.discountRate === 'number') {
      product.discountRate = this.readOptionalDiscountRate(input.discountRate, '商品折扣') as string
    }
    if (typeof input.isActive === 'boolean') {
      product.isActive = input.isActive
    }
    if (typeof input.o2oRecommended === 'boolean') {
      product.o2oRecommended = input.o2oRecommended
    }
    this.applyO2oStatusUpdate(product, input)
    this.applyContentUpdate(product, input)
    this.applyStockAndLimitUpdate(product, input)
  }

  private applyO2oStatusUpdate(product: BaseProduct, input: UpdateProductInput): void {
    if (input.o2oStatus === 'listed' || input.o2oStatus === 'unlisted') {
      product.o2oStatus = resolveEffectiveO2oStatus(product.isActive, input.o2oStatus, product.o2oStatus)
      return
    }
    if (typeof input.isActive === 'boolean') {
      product.o2oStatus = resolveEffectiveO2oStatus(product.isActive, undefined, product.o2oStatus)
    }
  }

  private applyContentUpdate(product: BaseProduct, input: UpdateProductInput): void {
    if (typeof input.thumbnail === 'string' || input.thumbnail === null) {
      product.thumbnail =
        normalizeProductThumbnailUrl(
          this.readLimitedText(
            input.thumbnail,
            '商品缩略图地址',
            PRODUCT_FIELD_LIMITS.thumbnail,
            { allowNull: true },
          ),
        ) ?? null
    }
    if (typeof input.detailContent === 'string' || input.detailContent === null) {
      product.detailContent = this.readLimitedText(
        input.detailContent,
        '商品详情',
        PRODUCT_FIELD_LIMITS.detailContent,
        { allowNull: true },
      ) ?? null
    }
  }

  private applyStockAndLimitUpdate(product: BaseProduct, input: UpdateProductInput): void {
    if (typeof input.limitPerUser === 'number') {
      product.limitPerUser = this.readOptionalInteger(
        input.limitPerUser,
        '单人限购数量',
        1,
        PRODUCT_FIELD_LIMITS.maxLimitPerUser,
      ) as number
    }
    if (typeof input.currentStock === 'number') {
      product.currentStock = this.readOptionalInteger(
        input.currentStock,
        '物理库存',
        0,
        PRODUCT_FIELD_LIMITS.maxStock,
      ) as number
    }
    // 预订库存只能由 O2O 订单生命周期记账：商品编辑即使回传该字段也忽略，与 SKU 编辑口径保持一致。
    this.assertStockRelation(product.currentStock, product.preOrderedStock)
  }

  private buildProductEntityForCreate(
    repo: Repository<BaseProduct>,
    input: CreateProductInput,
    productCode: string,
  ): BaseProduct {
    const isActive = input.isActive ?? true
    const normalizedProductCode = this.readLimitedText(
      productCode,
      '产品编码',
      PRODUCT_FIELD_LIMITS.code,
      { required: true },
    ) as string
    return repo.create({
      productCode: normalizedProductCode,
      productName: input.productName,
      pinyinAbbr: input.pinyinAbbr ?? '',
      defaultPrice: this.readOptionalPrice(input.defaultPrice, '默认单价') ?? '0.00',
      discountRate: this.readOptionalDiscountRate(input.discountRate, '商品折扣') ?? '10.0',
      isActive,
      o2oStatus: resolveEffectiveO2oStatus(isActive, input.o2oStatus),
      o2oRecommended: input.o2oRecommended ?? false,
      thumbnail: normalizeProductThumbnailUrl(input.thumbnail) ?? null,
      detailContent: input.detailContent ?? null,
      limitPerUser: input.limitPerUser ?? 5,
      currentStock: input.currentStock ?? 0,
      preOrderedStock: input.preOrderedStock ?? 0,
    })
  }

  private shouldRetryCreateAttempt(error: unknown, attempt: number, shouldGenerateProductCode: boolean): boolean {
    return (
      shouldGenerateProductCode &&
      attempt < PRODUCT_CREATE_MAX_RETRY &&
      (isUniqueConstraintError(error, PRODUCT_CODE_CONSTRAINT_MATCHER) || isRetryableSqliteLockError(error))
    )
  }

  private throwCreateError(error: unknown): never {
    if (isUniqueConstraintError(error, PRODUCT_CODE_CONSTRAINT_MATCHER)) {
      throw new BizError('产品编码已存在，请调整后重试', 409)
    }
    throw error
  }
}

export const productService = new ProductService()

/**
 * 批量新增产品（函数导出）：
 * - 供路由层按函数形式调用，减少类型服务对类实例成员增量感知不一致导致的误报。
 */
export const batchCreateProducts = (inputs: CreateProductInput[], actor: AuthUserContext) => productService.batchCreate(inputs, actor)
