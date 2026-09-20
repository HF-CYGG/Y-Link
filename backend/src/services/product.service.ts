/**
 * 文件说明：该文件负责商品服务，统一处理商品资料、标签关联、上下架状态、库存字段与批量创建更新等后台能力。
 * 实现逻辑：
 * 1. 以商品表、标签关系表和多类出入库明细为基础，维护商品主数据与库存衍生字段的一致性；
 * 2. 将商品编码生成、字段标准化、唯一性校验与批量操作重试策略集中在服务层，减少不同入口的重复判断；
 * 3. 同时向管理端和 O2O 业务提供稳定的商品查询与写入能力，保证商品治理口径统一。
 */

import { In, Not, type EntityManager, type Repository } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import { runInTransaction } from '../config/transaction-runner.js'
import { BaseCategory } from '../entities/base-category.entity.js'
import { BaseProduct } from '../entities/base-product.entity.js'
import { BaseProductSku } from '../entities/base-product-sku.entity.js'
import { BaseProductVariantCodeRegistry } from '../entities/base-product-variant-code-registry.entity.js'
import { BaseYzSeriesSeqReservation } from '../entities/base-yz-series-seq-reservation.entity.js'
import { BaseStorageLocation } from '../entities/base-storage-location.entity.js'
import { BusinessSequence } from '../entities/business-sequence.entity.js'
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
import type { RequestMeta } from '../utils/request-meta.js'
import { invalidateMallCatalogReadCache } from './mall-catalog-revision.service.js'
import { lockActiveSysAccountForBusiness } from './account-business-guard.service.js'
import { acquireSequenceMutex, allocateWcSkuCode } from './inventory-sequence.service.js'
import { auditService } from './audit.service.js'
import {
  allocateSeriesSeq,
  reserveSeriesSeq,
  assertSeriesCode,
  buildSeriesCodeMutexKey,
  EMPTY_SIZE_SENTINEL_CODE,
  formatProductCode,
  formatSkuCode,
  getProductCodePrefix,
  renameRegistryValue,
  resolveSizeCode,
  resolveVariantCode,
  SIZE_CODE_POOL,
  SPEC_VALUE_MAX_LENGTH,
  VARIANT_CODE_POOL,
} from './product-code.service.js'

/**
 * YZ 通用 SKU 编码体系的规格两轴映射（B8 批次改名）：
 * - 新写入统一使用新命名——一级变体轴 key 为「颜色/款式」，尺码轴 key 为「尺码」；
 * - 历史数据的 specValuesJson 里仍可能是旧命名「颜色」「款式」，且本批不做批量迁移脚本，
 *   所以一切"按轴取值""计算规格匹配 key""反推规格组"的地方都必须先过 normalizeSpecValuesKeys
 *   做双读兼容（新 key 优先，缺失时回退旧 key），否则历史 SKU 会被误判为规格已变更而被退役、
 *   同时新建一批 SKU，是灾难性的数据事故；
 * - 该规范化只用于"读时兼容"，不会改写已落库的 specValuesJson 字节——历史商品被编辑保存时，
 *   新提交的 specValues 自然使用新 key，从而完成懒迁移。
 */
const LEGACY_VARIANT_AXIS_SPEC_KEY = '颜色'
const LEGACY_SIZE_AXIS_SPEC_KEY = '款式'
const VARIANT_AXIS_SPEC_KEY = '颜色/款式'
const SIZE_AXIS_SPEC_KEY = '尺码'

/** 旧规格 key → 新规格 key 的别名表，仅覆盖这两条历史命名的轴；其余自定义规格维度名原样透传。 */
const SPEC_KEY_ALIAS_MAP: Record<string, string> = {
  [LEGACY_VARIANT_AXIS_SPEC_KEY]: VARIANT_AXIS_SPEC_KEY,
  [LEGACY_SIZE_AXIS_SPEC_KEY]: SIZE_AXIS_SPEC_KEY,
}

/**
 * 规格 key 双读兼容：把 specValues 里的旧 key（颜色/款式）映射为新 key（颜色/款式轴→"颜色/款式"、
 * 尺码轴→"尺码"），新旧 key 同时存在时新 key 优先。只用于匹配、按轴取值、反推规格组等只读场景，
 * 绝不能用它的返回值反写回 specValuesJson（那会绕开懒迁移，篡改历史数据字节）。
 */
const normalizeSpecValuesKeys = (specValues: Record<string, string>): Record<string, string> => {
  const normalized: Record<string, string> = {}
  Object.entries(specValues).forEach(([key, value]) => {
    const mappedKey = SPEC_KEY_ALIAS_MAP[key] ?? key
    if (mappedKey in normalized && key in SPEC_KEY_ALIAS_MAP) {
      // 新 key 已经写过值（新旧 key 同时存在的极端情况），旧 key 不覆盖新 key。
      return
    }
    normalized[mappedKey] = value
  })
  return normalized
}

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
  /** 非空时走 YZ 通用 SKU 编码体系：productCode 由系统按该系列生成，不能手工填写。 */
  primarySeriesTagId?: string | null
  /**
   * Excel 建库导入专用：指定该商品在系列内的序号，必须与导入文件里的原序号一致。
   * 非空时走 reserveSeriesSeq 精确占用该号并把序列游标抬到不低于它，而不是 allocateSeriesSeq 顺序 +1，
   * 这样导入既能原样保留 Excel 序号、也不依赖"分组必须按序号升序处理"这种脆弱的调用顺序前提。
   * 普通新建商品不要传这个字段。
   */
  seriesSeq?: number | null
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
  /** YZ 编码商品本批不支持切换系列，传入与当前值不同的值会被拒绝，见 applyUpdateInputToProduct。 */
  primarySeriesTagId?: string | null
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
  /** YZ 编码体系专用：一级变体码（0-9）。历史 legacy 商品的 SKU 恒为 null。 */
  variantCode: string | null
  /** YZ 编码体系专用：尺码码（A-E），无尺码位为 null。历史 legacy 商品的 SKU 恒为 null。 */
  sizeCode: string | null
  /** 升级到 YZ 编码前的历史 SKU 编码，仅作追溯展示；未升级过（含 legacy 商品）恒为 null。 */
  legacySkuCode: string | null
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
  /** YZ 编码体系专用：主系列标签ID，legacy 商品恒为 null。 */
  primarySeriesTagId: string | null
  /** 主系列标签的系列码（取自 base_tag.seriesCode），legacy 商品或未设置系列码的标签恒为 null。 */
  seriesCode: string | null
  /** 系列内商品序号（1-99），legacy 商品恒为 null。 */
  seriesSeq: number | null
  /** 编码体系：legacy=历史 P-/WC 编码，yz=新版定长编码。 */
  codeScheme: string
  /** 升级到 YZ 编码前的历史产品编码，仅作追溯展示；未升级过（含 legacy 商品）恒为 null。 */
  legacyProductCode: string | null
}

export interface ProductLookupView {
  matchedBy: 'barcode' | 'sku_code' | 'legacy_sku_code'
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
  /** SKU 原厂条码原值，未录入时为 null（与 barcode 的“原厂优先，否则退回 SKU 编码”合并语义不同）。 */
  factoryBarcode: string | null
  productName: string
  specText: string
  price: string
  categoryName: string | null
  locationCode: string | null
  /** YZ 编码体系专用：一级变体码，legacy 商品或历史规格组合编码的 SKU 恒为 null。 */
  variantCode: string | null
  /** YZ 编码体系专用：尺码码，legacy 商品或无尺码位的 SKU 恒为 null。 */
  sizeCode: string | null
  /** 主系列标签名称（取自 base_tag.tagName），legacy 商品恒为 null。 */
  seriesName: string | null
  /** 编码体系：legacy=历史 P-/WC 编码，yz=新版定长编码。 */
  codeScheme: string
}

/** 存量商品升级到 YZ 编码：请求入参，只需要选定要挂靠的文创系列标签。 */
export interface ProductYzUpgradeInput {
  primarySeriesTagId: string
}

/**
 * 升级预检 / 执行升级共用的单条 SKU 编码变化视图。
 * B9 批次：不再有“是否回填条码”的分支——每条当前 SKU 的 oldSkuCode 都会无条件写入 legacySkuCode，
 * 用于扫码兼容旧标签，因此原 willBackfillBarcode 字段（曾经在条码被占用时为 false）已失去意义，整体移除。
 */
export interface ProductYzUpgradeSkuChange {
  skuId: string
  specText: string
  oldSkuCode: string
  newSkuCode: string
}

/** 升级预检结果：供前端弹窗展示“升级后会变成什么”，blockingReason 非空时前端应禁止提交。 */
export interface ProductYzUpgradePreview {
  productId: string
  oldProductCode: string
  newProductCode: string
  seriesCode: string
  /** 系列内序号：预检阶段为预测值（未真正分配），执行升级后为实际分配值。 */
  seriesSeq: number
  skuChanges: ProductYzUpgradeSkuChange[]
  /** 保持不动的已退役 SKU 数量。 */
  retiredSkuCount: number
  blockingReason: string | null
}

/** 规格取值重命名：入参。只改显示名称，编码位（skuCode/variantCode/sizeCode）不受影响。 */
export interface ProductSpecValueRenameInput {
  axis: 'variant' | 'size'
  oldValue: string
  newValue: string
}

/** 0 号规格演进：入参。inherit 需要提供 inheritValue，retain 不需要。 */
export interface ProductZeroSpecEvolveInput {
  axis: 'variant' | 'size'
  mode: 'inherit' | 'retain'
  /** mode='inherit' 时必填：把原本"无该轴规格"的 SKU 继承为这个具体取值。 */
  inheritValue?: string
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

// 规格组合匹配 key：编辑商品时靠它判断提交的规格是否对应已有 SKU，必须先做新旧 key 归一化，
// 否则历史 SKU（旧 key）与提交的新规格（新 key）会算出不同的 key，被误判为“规格已移除”而退役。
const buildSpecValuesKey = (specValues: Record<string, string>): string => {
  const entries = Object.entries(normalizeSpecValuesKeys(specValues))
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

// YZ 编码商品的系列内序号唯一约束：极端并发下两个请求可能拿到同一个序号，
// 与产品编码冲突同属“重新分配一次即可解决”的可重试冲突，因此一并纳入重试判断。
const PRODUCT_SERIES_SEQ_CONSTRAINT_MATCHER = {
  mysqlConstraint: 'uk_base_product_series_seq',
  sqliteColumns: ['base_product.primary_series_tag_id', 'base_product.series_seq'],
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
        // P2-C 修复：YZ 商品的主系列标签必须始终出现在标签关联里（与创建、升级路径的不变量一致）。
        // 这里的 primarySeriesTagId 没变不代表 tagIds 没变——用户可能在独立的“关联标签”选择器里把主
        // 系列标签移除，若照单全收地整体替换，会导致商品仍有 primarySeriesTagId/seriesCode，却不再
        // 出现在该系列的标签筛选与报表中。强制把当前主系列标签并入 tagIds 后再替换，已包含时不重复插入。
        const effectiveTagIds = saved.codeScheme === 'yz' && saved.primarySeriesTagId
          && !input.tagIds.some((tagId) => normalizeEntityId(tagId) === normalizeEntityId(saved.primarySeriesTagId as string))
          ? [...input.tagIds, saved.primarySeriesTagId]
          : input.tagIds
        await this.replaceProductTags(saved.id, effectiveTagIds, manager)
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

  /**
   * 存量商品手动升级到 YZ 编码（第 3.5 批；B9 批次改造历史编码落位）：
   * - 业务决策是“冻结在 legacy，逐个手动升级”，因此本方法只处理单个商品，不做批量/自动重编码；
   * - 前置校验全部通过后才在同一事务内重生 productCode 与当前有效 SKU 的 skuCode，已退役 SKU 原样保留；
   * - 旧 productCode 写入 product.legacyProductCode，每条被重算编码的 SKU 旧 skuCode 写入 sku.legacySkuCode，
   *   用于 lookupByCode 的历史编码兼容路径扫描；barcode（原厂条码）字段从此只保留真实原厂条码，不再回填。
   */
  async upgradeProductToYzCode(
    productId: string,
    input: ProductYzUpgradeInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<ProductView> {
    const seriesTagId = this.normalizeSeriesTagIdInput(input?.primarySeriesTagId)
    if (!seriesTagId) {
      throw new BizError('请选择要升级到的文创系列', 400)
    }

    const result = await runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, actor.userId)

      const productRepo = manager.getRepository(BaseProduct)
      const product = await productRepo.findOne({
        where: { id: productId },
        lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
      })
      if (!product) {
        throw new BizError('产品不存在', 404)
      }
      if (product.codeScheme === 'yz') {
        throw new BizError('该商品已经使用 YZ 编码，无需升级', 400)
      }

      const seriesTag = await this.loadAndLockSeriesTagForYzScheme(seriesTagId, manager)

      // 只处理当前有效 SKU；已退役 SKU 一律不读不写，保留旧编码。按 Excel 出现顺序（sortOrder，其次 id）
      // 稳定排序，保证变体码/尺码码的分配顺序与预检模拟、前端展示口径一致。
      const currentSkus = await this.loadCurrentSkusForUpgrade(product.id, manager, true)
      this.assertUpgradeCapacity(currentSkus)

      const prefix = await getProductCodePrefix(manager)
      const seriesSeq = await allocateSeriesSeq(manager, seriesTag.id, seriesTag.seriesCode as string, prefix)
      const oldProductCode = product.productCode
      const newProductCode = formatProductCode(prefix, seriesTag.seriesCode as string, seriesSeq)

      product.primarySeriesTagId = seriesTag.id
      product.seriesSeq = seriesSeq
      product.codeScheme = 'yz'
      product.productCode = newProductCode
      product.legacyProductCode = oldProductCode
      const savedProduct = await productRepo.save(product)

      // 主系列标签必须出现在标签关联里，口径与 YZ 建档（createWithManager）一致；已存在则不重复插入。
      const relationRepo = manager.getRepository(RelProductTag)
      const hasSeriesRelation = await relationRepo.exists({ where: { productId: savedProduct.id, tagId: seriesTag.id } })
      if (!hasSeriesRelation) {
        await relationRepo.save(relationRepo.create({ productId: savedProduct.id, tagId: seriesTag.id }))
      }

      const skuRepo = manager.getRepository(BaseProductSku)
      const auditSkuChanges: Array<{ skuId: string; oldSkuCode: string; newSkuCode: string }> = []
      const updatedSkus: BaseProductSku[] = []

      for (const sku of currentSkus) {
        const specValues = normalizeSpecValuesKeys(parseSpecValuesJson(sku.specValuesJson))
        const variantCode = await resolveVariantCode(manager, savedProduct.id, specValues[VARIANT_AXIS_SPEC_KEY])
        const sizeCode = await resolveSizeCode(manager, savedProduct.id, specValues[SIZE_AXIS_SPEC_KEY])
        const oldSkuCode = sku.skuCode
        const newSkuCode = formatSkuCode(newProductCode, variantCode, sizeCode)

        // 旧标签救济：旧 skuCode 无条件写入 legacySkuCode（历史编码理论上可能重复，不受唯一约束限制），
        // 供 lookupByCode 第三路匹配，让已打印的旧标签仍可扫描；barcode（原厂条码）不再被本流程改动。
        sku.legacySkuCode = oldSkuCode
        sku.variantCode = variantCode
        sku.sizeCode = sizeCode
        sku.skuCode = newSkuCode
        updatedSkus.push(sku)
        auditSkuChanges.push({ skuId: String(sku.id), oldSkuCode, newSkuCode })
      }

      // 保存前做跨列冲突校验：新编码不能撞上其他商品 SKU 的原厂条码或编码，否则扫码会指向错商品。
      // 抛错会回滚本事务内已执行的 product / registry 写入，不会落下半成品数据。
      await this.assertNoUpgradeCodeConflict(
        manager,
        savedProduct.id,
        newProductCode,
        updatedSkus.map((sku) => sku.skuCode),
      )

      if (updatedSkus.length) {
        await skuRepo.save(updatedSkus)
      }

      // 审计：只记编码映射，不落任何敏感值（价格、库存、条码等均不写入）。
      await auditService.record({
        actionType: 'product.yz_code_upgrade',
        actionLabel: '存量商品升级为 YZ 编码',
        targetType: 'base_product',
        targetId: savedProduct.id,
        targetCode: newProductCode,
        actor,
        requestMeta,
        detail: {
          productId: savedProduct.id,
          oldProductCode,
          newProductCode,
          skuCodeChanges: auditSkuChanges,
        },
      }, manager)

      return this.buildProductView(savedProduct, manager)
    })
    invalidateMallCatalogReadCache()
    return result
  }

  /**
   * 规格取值重命名：只改显示名称，skuCode / variantCode / sizeCode 一律不动——这正是重命名区别于
   * "退役旧值再新建一个值"的意义所在，印刷条码不会因为改名失效。
   * 仅 YZ 编码商品可用（legacy 商品没有编码登记表）。
   */
  async renameProductSpecValue(
    productId: string,
    input: ProductSpecValueRenameInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<ProductView> {
    const axis = input?.axis
    if (axis !== 'variant' && axis !== 'size') {
      throw new BizError('规格轴参数无效，只能是 variant 或 size', 400)
    }
    const oldValue = normalizeSpecTextValue(input?.oldValue)
    const newValue = normalizeSpecTextValue(input?.newValue)
    if (!oldValue || !newValue) {
      throw new BizError('请提供有效的原取值与新取值', 400)
    }
    // P2-D 修复：服务层与路由 schema 都要校验，不能只依赖路由——防止绕过路由直接调用服务方法时写入
    // 超过登记表 spec_value 列（VARCHAR(64)）上限的值，导致 MySQL 严格模式抛异常、SQLite 静默接受。
    if (oldValue.length > SPEC_VALUE_MAX_LENGTH) {
      throw new BizError(`原取值不能超过 ${SPEC_VALUE_MAX_LENGTH} 个字符（当前 ${oldValue.length} 个字符）`, 400)
    }
    if (newValue.length > SPEC_VALUE_MAX_LENGTH) {
      throw new BizError(`新取值不能超过 ${SPEC_VALUE_MAX_LENGTH} 个字符（当前 ${newValue.length} 个字符）`, 400)
    }

    const result = await runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, actor.userId)
      const productRepo = manager.getRepository(BaseProduct)
      const product = await productRepo.findOne({
        where: { id: productId },
        lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
      })
      if (!product) {
        throw new BizError('产品不存在', 404)
      }
      if (product.codeScheme !== 'yz') {
        throw new BizError('该商品不是 YZ 编码商品，没有编码登记表，不支持规格取值重命名', 400)
      }

      // 登记表只改 specValue，code 保持不变；这一步顺带校验 oldValue 是否真的已登记、newValue 是否已被占用。
      await renameRegistryValue(manager, product.id, axis, oldValue, newValue)

      const axisKey = axis === 'variant' ? VARIANT_AXIS_SPEC_KEY : SIZE_AXIS_SPEC_KEY
      const skuRepo = manager.getRepository(BaseProductSku)
      // 当前有效与已退役的 SKU 都要改，保证历史行的规格展示文本也跟着更新，不留旧名称的死角。
      const allSkus = await skuRepo.find({ where: { productId: product.id } })
      const specTextSpecGroups: ProductSpecGroupInput[] = [
        { name: VARIANT_AXIS_SPEC_KEY, values: [] },
        { name: SIZE_AXIS_SPEC_KEY, values: [] },
      ]
      const affectedSkus: BaseProductSku[] = []
      for (const sku of allSkus) {
        const specValues = normalizeSpecValuesKeys(parseSpecValuesJson(sku.specValuesJson))
        if (specValues[axisKey] !== oldValue) {
          continue
        }
        specValues[axisKey] = newValue
        sku.specValuesJson = JSON.stringify(specValues)
        sku.specText = buildSpecText(specValues, specTextSpecGroups)
        affectedSkus.push(sku)
      }
      if (affectedSkus.length) {
        await skuRepo.save(affectedSkus)
      }

      await auditService.record({
        actionType: 'product.spec_value_rename',
        actionLabel: '重命名商品规格取值',
        targetType: 'base_product',
        targetId: product.id,
        targetCode: product.productCode,
        actor,
        requestMeta,
        detail: {
          productId: product.id,
          axis,
          oldValue,
          newValue,
          affectedSkuIds: affectedSkus.map((sku) => String(sku.id)),
        },
      }, manager)

      return this.buildProductView(product, manager)
    })
    invalidateMallCatalogReadCache()
    return result
  }

  /**
   * 0 号规格演进：把商品原本"无该轴规格"的那条 SKU（一级变体轴是 variantCode='0'，尺码轴是
   * sizeCode=null）演进为具体取值（inherit）或退役保留（retain），仅 YZ 编码商品可用。
   * - inherit：把 '0' 号 / 空尺码位正式登记给 inheritValue，目标 SKU 的 skuCode 保持不变
   *   （variantCode 本来就是 '0'，登记后编码位不变；sizeCode 走哨兵登记，同样不产生字符）；
   * - retain：目标 SKU 直接退役（isCurrent=false, isActive=false），行保留不删除，'0' 号 / 空尺码位
   *   永久不再使用，后续新取值从候选池正常分配（本就不含 '0'，不受影响）。
   */
  async evolveProductZeroSpec(
    productId: string,
    input: ProductZeroSpecEvolveInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<ProductView> {
    const axis = input?.axis
    const mode = input?.mode
    if (axis !== 'variant' && axis !== 'size') {
      throw new BizError('规格轴参数无效，只能是 variant 或 size', 400)
    }
    if (mode !== 'inherit' && mode !== 'retain') {
      throw new BizError('演进方式参数无效，只能是 inherit 或 retain', 400)
    }
    const inheritValue = mode === 'inherit' ? normalizeSpecTextValue(input?.inheritValue) : ''
    if (mode === 'inherit' && !inheritValue) {
      throw new BizError('继承模式需要提供要继承的规格取值', 400)
    }

    const result = await runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, actor.userId)
      const productRepo = manager.getRepository(BaseProduct)
      const product = await productRepo.findOne({
        where: { id: productId },
        lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
      })
      if (!product) {
        throw new BizError('产品不存在', 404)
      }
      if (product.codeScheme !== 'yz') {
        throw new BizError('该商品不是 YZ 编码商品，不支持 0 号规格演进', 400)
      }

      const skuRepo = manager.getRepository(BaseProductSku)
      const registryRepo = manager.getRepository(BaseProductVariantCodeRegistry)
      const currentSkus = await skuRepo.find({ where: { productId: product.id, isCurrent: true } })

      let targetSku: BaseProductSku
      if (axis === 'variant') {
        const zeroSkus = currentSkus.filter((sku) => (sku.variantCode ?? '0') === '0')
        if (!zeroSkus.length) {
          throw new BizError('该商品当前没有待演进的"无一级变体"SKU', 400)
        }
        if (zeroSkus.length > 1) {
          throw new BizError('该商品存在多条"无一级变体"的 SKU，无法自动判定演进目标，请通过常规规格编辑处理', 400)
        }
        const zeroRegistered = await registryRepo.exists({ where: { productId: product.id, axis: 'variant', code: '0' } })
        if (zeroRegistered) {
          throw new BizError('该商品的 0 号一级变体已被继承，不能重复演进', 400)
        }
        ;[targetSku] = zeroSkus
      } else {
        const zeroSkus = currentSkus.filter((sku) => sku.sizeCode === null || sku.sizeCode === undefined)
        if (!zeroSkus.length) {
          throw new BizError('该商品当前没有待演进的"无尺码位"SKU', 400)
        }
        if (zeroSkus.length > 1) {
          throw new BizError('该商品存在多条"无尺码位"的 SKU，无法自动判定演进目标，请通过常规规格编辑处理', 400)
        }
        const sentinelRegistered = await registryRepo.exists({
          where: { productId: product.id, axis: 'size', code: EMPTY_SIZE_SENTINEL_CODE },
        })
        if (sentinelRegistered) {
          throw new BizError('该商品的空尺码位已被继承，不能重复演进', 400)
        }
        ;[targetSku] = zeroSkus
      }

      const specTextSpecGroups: ProductSpecGroupInput[] = [
        { name: VARIANT_AXIS_SPEC_KEY, values: [] },
        { name: SIZE_AXIS_SPEC_KEY, values: [] },
      ]

      if (mode === 'inherit') {
        const axisKey = axis === 'variant' ? VARIANT_AXIS_SPEC_KEY : SIZE_AXIS_SPEC_KEY

        // 继承前先查登记表：inheritValue 如果已经通过常规规格编辑登记过（对应某个真实编码），
        // 说明这是一个“已存在”的规格取值，不能再借 0 号继承语义强行复用——resolveVariantCode/
        // resolveSizeCode 命中登记表会直接返回旧编码而不会执行继承逻辑，静默放行会让目标 SKU
        // 的规格元数据与实际编码脱节，还会和已存在的同名规格 SKU 撞成重复组合。
        const registeredConflict = await registryRepo.findOneBy({
          productId: product.id,
          axis,
          specValue: inheritValue,
        })
        if (registeredConflict) {
          throw new BizError(
            `规格取值「${inheritValue}」已存在于本商品的规格中（编码 ${registeredConflict.code}），不能用于 0 号继承，请改用其它尚未登记的取值，或直接新增规格`,
            400,
          )
        }

        // 继承后产生的规格组合不能与该商品已有的当前 SKU 重复。
        const targetSpecValues = normalizeSpecValuesKeys(parseSpecValuesJson(targetSku.specValuesJson))
        const nextVariantValue = axis === 'variant' ? inheritValue : (targetSpecValues[VARIANT_AXIS_SPEC_KEY] ?? '')
        const nextSizeValue = axis === 'size' ? inheritValue : (targetSpecValues[SIZE_AXIS_SPEC_KEY] ?? '')
        const duplicateSku = currentSkus.find((sku) => {
          if (sku.id === targetSku.id) return false
          const specValues = normalizeSpecValuesKeys(parseSpecValuesJson(sku.specValuesJson))
          return (specValues[VARIANT_AXIS_SPEC_KEY] ?? '') === nextVariantValue
            && (specValues[SIZE_AXIS_SPEC_KEY] ?? '') === nextSizeValue
        })
        if (duplicateSku) {
          throw new BizError(`继承后的规格组合与现有 SKU「${duplicateSku.specText}」重复，不能继承`, 409)
        }

        // 校验返回值：命中上面的前置检查后这里理应必定拿到 0 号 / 空位，若不是说明登记表出现了
        // 竞态或其他内部状态异常，不能静默继续——直接抛 500 交由人工核查。
        if (axis === 'variant') {
          const resolvedCode = await resolveVariantCode(manager, product.id, inheritValue, { inheritZeroCode: true })
          if (resolvedCode !== '0') {
            throw new BizError(
              `0 号一级变体继承内部状态异常：编码分配结果为「${resolvedCode}」而非预期的 0 号，请联系管理员核查`,
              500,
            )
          }
        } else {
          const resolvedSizeCode = await resolveSizeCode(manager, product.id, inheritValue, { inheritEmptySize: true })
          if (resolvedSizeCode !== null) {
            throw new BizError(
              `空尺码位继承内部状态异常：编码分配结果为「${resolvedSizeCode}」而非预期的空位，请联系管理员核查`,
              500,
            )
          }
        }

        const specValues = targetSpecValues
        specValues[axisKey] = inheritValue
        targetSku.specValuesJson = JSON.stringify(specValues)
        targetSku.specText = buildSpecText(specValues, specTextSpecGroups)
        // skuCode / variantCode / sizeCode 全部保持不变：这是"继承"的全部意义——库存与历史无缝延续。
        await skuRepo.save(targetSku)
      } else {
        if (Number(targetSku.preOrderedStock ?? 0) > 0) {
          throw new BizError(`SKU「${targetSku.specText}」仍有 ${targetSku.preOrderedStock} 件预订占用，释放或核销完成前不能退役`, 409)
        }
        // P1-B 修复：retain 模式退役 0 号 SKU 时，若它仍有物理库存，移出商品汇总会让 product.currentStock
        // 直接变化。此前这里没有像普通商品编辑路径（recordManualStockAdjustments）那样写 InventoryLog，
        // 导致汇总库存的变化在库存流水里找不到对应记录、按流水核对会对不上。这里先拍下退役前的库存快照，
        // 退役落库后复用同一套流水生成逻辑——它会按“该 SKU 从计入汇总变为不计入汇总”自动补一条流水，
        // 口径与普通商品编辑移出/停用 SKU 完全一致，不需要额外定制一套记账逻辑。
        const stockSnapshot = await this.captureProductStockSnapshot(product, manager)
        targetSku.isActive = false
        targetSku.isCurrent = false
        targetSku.o2oRecommended = false
        if (targetSku.barcode) {
          targetSku.barcode = null
        }
        await skuRepo.save(targetSku)

        const summarySkus = (await skuRepo.find({ where: { productId: product.id } }))
          .filter((sku) => isDatabaseFlagEnabled(sku.isCurrent) && isDatabaseFlagEnabled(sku.isActive))
        product.currentStock = summarySkus.reduce((sum, sku) => sum + Math.max(0, Number(sku.currentStock ?? 0)), 0)
        product.preOrderedStock = summarySkus.reduce((sum, sku) => sum + Math.max(0, Number(sku.preOrderedStock ?? 0)), 0)
        await productRepo.save(product)
        await this.recordManualStockAdjustments(product, stockSnapshot, actor, manager)
      }

      await auditService.record({
        actionType: 'product.zero_spec_evolve',
        actionLabel: '商品 0 号规格演进',
        targetType: 'base_product',
        targetId: product.id,
        targetCode: product.productCode,
        actor,
        requestMeta,
        detail: {
          productId: product.id,
          axis,
          mode,
          inheritValue: mode === 'inherit' ? inheritValue : null,
          skuId: String(targetSku.id),
        },
      }, manager)

      return this.buildProductView(product, manager)
    })
    invalidateMallCatalogReadCache()
    return result
  }

  /**
   * 升级预检（只读）：返回升级后 productCode / SKU 编码会变成什么，供前端弹窗展示确认。
   * 不得调用 allocateSeriesSeq / resolveVariantCode / resolveSizeCode（那些会真的消耗序号或写登记表），
   * 一律用“当前最大值 + 1”预测序号、用登记表现状 + 候选池模拟推算变体码/尺码码，均不落库。
   */
  async previewProductYzUpgrade(productId: string, primarySeriesTagId: string): Promise<ProductYzUpgradePreview> {
    const seriesTagId = this.normalizeSeriesTagIdInput(primarySeriesTagId)
    if (!seriesTagId) {
      throw new BizError('请选择要升级到的文创系列', 400)
    }
    const manager = AppDataSource.manager

    const product = await manager.getRepository(BaseProduct).findOneBy({ id: productId })
    if (!product) {
      throw new BizError('产品不存在', 404)
    }
    if (product.codeScheme === 'yz') {
      throw new BizError('该商品已经使用 YZ 编码，无需升级', 400)
    }
    const seriesTag = await this.loadSeriesTagForYzScheme(seriesTagId, manager)

    const [currentSkus, retiredSkuCount, prefix] = await Promise.all([
      this.loadCurrentSkusForUpgrade(product.id, manager, false),
      manager.getRepository(BaseProductSku).count({ where: { productId: product.id, isCurrent: false } }),
      getProductCodePrefix(manager),
    ])
    // P1-C 修复：predictNextSeriesSeq 现在按 (code_prefix, series_code, series_seq) 判定占用，必须先
    // 拿到 prefix 才能调用，因此从上面的 Promise.all 中拆出来单独串行执行。
    const predictedSeriesSeq = await this.predictNextSeriesSeq(manager, seriesTag.id, seriesTag.seriesCode as string, prefix)

    const capacityBlockingReason = this.detectUpgradeCapacityBlockingReason(currentSkus)
    const newProductCode = formatProductCode(prefix, seriesTag.seriesCode as string, predictedSeriesSeq)

    const skuChanges: ProductYzUpgradeSkuChange[] = capacityBlockingReason
      ? []
      : await this.simulateUpgradeSkuChanges(product.id, currentSkus, newProductCode, manager)

    // 预检阶段同样要检测跨列编码冲突，让前端在提交升级前就能拦住并展示原因。
    const codeConflictReason = capacityBlockingReason
      ? null
      : await this.detectUpgradeCodeConflict(manager, product.id, newProductCode, skuChanges.map((change) => change.newSkuCode))

    return {
      productId: normalizeEntityId(product.id),
      oldProductCode: product.productCode,
      newProductCode,
      seriesCode: seriesTag.seriesCode as string,
      seriesSeq: predictedSeriesSeq,
      skuChanges,
      retiredSkuCount,
      blockingReason: capacityBlockingReason ?? codeConflictReason,
    }
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
    // YZ 编码商品：退役 SKU 的规格组合若被重新启用，必须复活原行而不是新建一行。
    // 否则变体码会正确复用（例如仍是 2），但拼出的 skuCode 与永久保留的退役行撞唯一索引，
    // 被下面的 allocateSkuCode 追加 -2 后缀，产出 YZPX012A-2 这种不符合 YZ 定长规则的编码。
    const retiredSkuBySpecKey = new Map<string, BaseProductSku>()
    if (product.codeScheme === 'yz') {
      existingSkus
        .filter((sku) => !isDatabaseFlagEnabled(sku.isCurrent))
        .forEach((sku) => {
          const retiredSpecKey = buildSkuEntitySpecValuesKey(sku)
          const previousRetired = retiredSkuBySpecKey.get(retiredSpecKey)
          // 同一规格组合可能留有多条历史行，取 id 最大的那条（最近一次退役的）复活。
          if (!previousRetired || Number(sku.id) > Number(previousRetired.id)) {
            retiredSkuBySpecKey.set(retiredSpecKey, sku)
          }
        })
    }
    const existingSkuCodeSet = new Set(existingSkus.map((sku) => sku.skuCode))
    // B9 批次后，存量商品升级到 YZ 编码不再把旧 skuCode 回填进 barcode（改写入 legacySkuCode，不受唯一
    // 索引约束），因此下面这段“按 productCode 前缀纳入 barcode 去重集合”对新产生的数据而言通常查不到东西。
    // 仍然保留：051 迁移脚本是保守判定，历史库里可能仍有个别未被迁移语句覆盖到的、按旧方案回填进 barcode
    // 的记录（真实原厂条码本就不该长这个前缀，不会被误伤）；留着这段查询当作过渡期的防御性兜底，等历史
    // 数据全部迁清后可以再评估是否移除。真正承接“升级腾出的日期流水号被当天新建商品重新取到”这一撞码
    // 场景的是下面紧接着的 legacySkuCodeRows 查询——generateProductCode 已同时避开 legacy_product_code，
    // 但手工填写 productCode（如导入脚本）仍可能绕开该保护，这里作为最后一道防线。
    const prefixedBarcodeRows = await skuRepo.createQueryBuilder('sku')
      .select('sku.barcode', 'barcode')
      .where('sku.barcode LIKE :codePrefix', { codePrefix: `${product.productCode}%` })
      .getRawMany<{ barcode: string | null }>()
    prefixedBarcodeRows.forEach((row) => {
      if (row.barcode) existingSkuCodeSet.add(row.barcode)
    })
    // P1-A 修复：legacy_sku_code 不受唯一索引约束，理论上可能与当前商品新分配的 skuCode 撞成同一字符串
    // （典型场景：升级商品腾出的日期流水号被当天新建商品重新取到，二者拼出的 `${productCode}-DEFAULT`
    // 恰好相同）。虽然不会撞唯一索引导致建档失败，但会造成扫码歧义——旧标签本该扫出历史商品，却因为
    // lookupByCode 里 sku_code 命中优先级高于 legacy_sku_code 而跳到新商品。预先查出以本商品 productCode
    // 为前缀的全部历史编码，纳入去重集合，让下面已有的 allocateSkuCode 自动避开，从根源上消除这种撞码。
    const legacySkuCodeRows = await skuRepo.createQueryBuilder('sku')
      .select('sku.legacySkuCode', 'legacySkuCode')
      .where('sku.legacySkuCode LIKE :codePrefix', { codePrefix: `${product.productCode}%` })
      .getRawMany<{ legacySkuCode: string | null }>()
    legacySkuCodeRows.forEach((row) => {
      if (row.legacySkuCode) existingSkuCodeSet.add(row.legacySkuCode)
    })
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
      const currentMatchedSku = matchedById && buildSkuEntitySpecValuesKey(matchedById) === specKey
        ? matchedById
        : existingSkuBySpecKey.get(specKey)
      // 当前有效行没命中时，YZ 商品回落到同规格的退役行并复活它，保证 SKU 身份、编码与库存延续。
      const revivedSku = currentMatchedSku ? undefined : retiredSkuBySpecKey.get(specKey)
      const matchedSku = currentMatchedSku ?? revivedSku
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
          // 复活退役行时必须重新启用，否则会沿用退役时写入的 false，导致规格加回来却不可售。
          skuEntity.isActive = revivedSku ? true : matchedSku.isActive
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
      if (product.codeScheme === 'yz') {
        // YZ 编码路径：对每一个 SKU（含已存在的）都回填一级变体码/尺码码，保证历史行也带上编码轴信息；
        // 只有新增 SKU 才重新拼接 skuCode，已存在 SKU 的 skuCode 在上面已保留原值，不受影响。
        const specValues = normalizeSpecValuesKeys(parseSpecValuesJson(skuEntity.specValuesJson))
        const variantCode = await resolveVariantCode(manager, product.id, specValues[VARIANT_AXIS_SPEC_KEY])
        const sizeCode = await resolveSizeCode(manager, product.id, specValues[SIZE_AXIS_SPEC_KEY])
        skuEntity.variantCode = variantCode
        skuEntity.sizeCode = sizeCode
        // P1-A 修复：已存在 SKU 的基准编码取其保留值（可能是升级/导入遗留的历史格式，不一定等于现场
        // 按当前规则拼接的结果），新增 SKU 的基准编码则现场按 formatSkuCode 派生；两种情况都不允许被
        // 调用方显式传入的自定义 skuCode 覆盖——YZ 商品的 SKU 编码必须始终由服务端按编码规则生成。
        const baselineSkuCode = matchedSku ? matchedSku.skuCode : formatSkuCode(product.productCode, variantCode, sizeCode)
        if (!matchedSku && skuInput.skuCode === undefined) {
          skuEntity.skuCode = baselineSkuCode
        }
        const submittedSkuCode = normalizeSpecTextValue(skuInput.skuCode)
        // 前端编辑已有 SKU 时会原样回传当前 skuCode（与 baselineSkuCode 一致），必须放行；
        // 只拒绝与基准编码不一致的自定义值，空字符串视为未提交，不触发校验。
        if (submittedSkuCode && submittedSkuCode !== baselineSkuCode) {
          throw new BizError('YZ 商品的 SKU 编码由系统按编码规则生成，不接受自定义', 400)
        }
      } else if (!matchedSku && skuInput.skuCode === undefined && categoryCode) {
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
      // P1-A 修复（PR #109 第五轮评审）：YZ 编码是定长规则，任何后缀都会使其非法，因此 YZ 分支的
      // skuCode 冲突只能拒绝、不能像 legacy/WC 路径那样交给 allocateSkuCode 追加 `-2`/`-3` 后缀兜底
      // ——那会产出一个与 variantCode/sizeCode 不对应、也不符合定长规则的非法编码。这里直接跳过
      // allocateSkuCode，冲突判定统一交给循环结束后的 assertNoYzSkuCodeConflict 批量处理。
      if (product.codeScheme !== 'yz') {
        allocateSkuCode(skuEntity, matchedSku, skuInput)
      }
      skuEntities.push(skuEntity)
    }
    if (product.codeScheme === 'yz') {
      await this.assertNoYzSkuCodeConflict(product.id, skuEntities, manager)
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

    // 变体码登记表（base_product_variant_code_registry）刻意不在此处清理：这是「变体码/尺码码永不回收」
    // 不变量的实现方式，退役 SKU 只释放条码，登记表的行必须永久保留，不能仿照 barcode 的写法去清理。
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

  /**
   * P1-A 修复（PR #109 第五轮评审）：YZ 分支派生出的 skuCode 自己做冲突判定，命中即拒绝，不交给
   * allocateSkuCode 的后缀兜底改写——见 replaceProductSkus 调用处注释。冲突范围覆盖其他商品的
   * skuCode（当前编码）、barcode（原厂条码）、legacySkuCode（历史编码）三列，一次批量 IN 查询判定
   * （不 N+1）；`productId: Not(productId)` 排除本商品自身的行，避免编辑自己被误判为冲突。
   * 命中冲突统一抛 409，不在此处做任何"重新分配系列序号"之类的自动改写——那会让编码静默漂移、
   * 难以预期，冲突只能留给人工处理。
   */
  private async assertNoYzSkuCodeConflict(
    productId: string,
    skuEntities: BaseProductSku[],
    manager: EntityManager,
  ): Promise<void> {
    const codes = [...new Set(skuEntities.map((sku) => sku.skuCode).filter(Boolean))]
    if (!codes.length) return
    const skuRepo = manager.getRepository(BaseProductSku)
    const conflicts = await skuRepo.find({
      where: [
        { productId: Not(productId), skuCode: In(codes) },
        { productId: Not(productId), barcode: In(codes) },
        { productId: Not(productId), legacySkuCode: In(codes) },
      ],
      select: ['id', 'productId', 'skuCode', 'barcode', 'legacySkuCode'],
    })
    if (!conflicts.length) return
    const first = conflicts[0]
    const conflictCode = codes.find((code) => code === first.skuCode || code === first.barcode || code === first.legacySkuCode) ?? codes[0]
    const conflictField = first.skuCode === conflictCode ? '当前编码' : (first.barcode === conflictCode ? '原厂条码' : '历史编码')
    throw new BizError(
      `YZ 编码「${conflictCode}」与其他商品（ID ${normalizeEntityId(first.productId)}）的${conflictField}冲突，请先处理该冲突后再操作`,
      409,
    )
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
    const seriesTagIds = [...new Set(products.map((product) => product.primarySeriesTagId).filter(Boolean).map(String))]
    const [categories, locations, seriesTags] = await Promise.all([
      categoryIds.length ? manager.getRepository(BaseCategory).find({ where: { id: In(categoryIds) } }) : [],
      locationIds.length ? manager.getRepository(BaseStorageLocation).find({ where: { id: In(locationIds) } }) : [],
      seriesTagIds.length ? manager.getRepository(BaseTag).find({ where: { id: In(seriesTagIds) }, select: ['id', 'seriesCode'] }) : [],
    ])
    const categoryMap = new Map(categories.map((category) => [String(category.id), category]))
    const locationCodeMap = new Map(locations.map((location) => [String(location.id), location.locationCode]))
    const seriesCodeMap = new Map(seriesTags.map((tag) => [String(tag.id), tag.seriesCode]))

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
        primarySeriesTagId: product.primarySeriesTagId ? normalizeEntityId(product.primarySeriesTagId) : null,
        seriesCode: product.primarySeriesTagId ? seriesCodeMap.get(String(product.primarySeriesTagId)) ?? null : null,
        seriesSeq: product.seriesSeq ?? null,
        codeScheme: product.codeScheme || 'legacy',
        legacyProductCode: product.legacyProductCode ?? null,
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
      variantCode: sku.variantCode ?? null,
      sizeCode: sku.sizeCode ?? null,
      legacySkuCode: sku.legacySkuCode ?? null,
    }
  }

  private buildSpecGroupsFromSkus(skus: ProductSkuView[]): ProductSpecGroupView[] {
    const groupValueMap = new Map<string, string[]>()
    skus.forEach((sku) => {
      // 先归一化新旧 key 再反推维度名，否则历史商品打开编辑页会同时出现"颜色"和"颜色/款式"两个维度。
      Object.entries(normalizeSpecValuesKeys(sku.specValues)).forEach(([name, value]) => {
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
   * 扫码识别：条码、SKU 编码、历史 SKU 编码（B9 批次新增，兼容升级前已打印的旧标签）三路精确匹配合并；
   * 排序优先级为「当前版本 > 启用中 > 条码命中 > SKU 编码命中 > 历史编码命中」——历史编码只是兼容手段，
   * 优先级最低，避免与真实条码/当前编码撞码时抢占展示。
   * 返回的 SKU 视图带库存，调用方按权限决定是否裁剪。
   */
  async lookupByCode(rawCode: string): Promise<ProductLookupView> {
    const code = String(rawCode ?? '').trim()
    if (!code || code.length > 96) throw new BizError('请扫描或输入有效的条码', 400)
    const skuRepo = AppDataSource.getRepository(BaseProductSku)
    const [byBarcode, bySkuCode, byLegacySkuCode] = await Promise.all([
      skuRepo.find({ where: { barcode: code } }),
      skuRepo.find({ where: { skuCode: code } }),
      skuRepo.find({ where: { legacySkuCode: code } }),
    ])
    const candidates = [
      ...byBarcode.map((row) => ({ row, matchedBy: 'barcode' as const, rank: 2 })),
      ...bySkuCode.map((row) => ({ row, matchedBy: 'sku_code' as const, rank: 1 })),
      ...byLegacySkuCode.map((row) => ({ row, matchedBy: 'legacy_sku_code' as const, rank: 0 })),
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
    const seriesTagIds = [...new Set(products.map((product) => product.primarySeriesTagId).filter(Boolean).map(String))]
    const [categories, locations, seriesTags] = await Promise.all([
      categoryIds.length ? AppDataSource.getRepository(BaseCategory).find({ where: { id: In(categoryIds) } }) : [],
      locationIds.length ? AppDataSource.getRepository(BaseStorageLocation).find({ where: { id: In(locationIds) } }) : [],
      seriesTagIds.length ? AppDataSource.getRepository(BaseTag).find({ where: { id: In(seriesTagIds) }, select: ['id', 'tagName'] }) : [],
    ])
    const categoryMap = new Map(categories.map((category) => [String(category.id), category.categoryName]))
    const locationMap = new Map(locations.map((location) => [String(location.id), location.locationCode]))
    const seriesNameMap = new Map(seriesTags.map((tag) => [String(tag.id), tag.tagName]))
    const skuMap = new Map(skus.map((sku) => [String(sku.id), sku]))
    return ids.map((id) => {
      const sku = skuMap.get(id) as BaseProductSku
      const product = productMap.get(String(sku.productId))
      return {
        skuId: id,
        skuCode: sku.skuCode,
        barcode: sku.barcode || sku.skuCode,
        factoryBarcode: sku.barcode || null,
        productName: product?.productName ?? '',
        specText: sku.specText || '默认规格',
        price: calculateDiscountedPrice(sku.defaultPrice, sku.discountRate),
        categoryName: product?.categoryId ? categoryMap.get(String(product.categoryId)) ?? null : null,
        locationCode: sku.locationId ? locationMap.get(String(sku.locationId)) ?? null : null,
        variantCode: sku.variantCode || null,
        sizeCode: sku.sizeCode || null,
        seriesName: product?.primarySeriesTagId ? seriesNameMap.get(String(product.primarySeriesTagId)) ?? null : null,
        codeScheme: product?.codeScheme || 'legacy',
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
    const normalizedCreateInput = this.normalizeCreateInput(input)
    const seriesTagId = this.normalizeSeriesTagIdInput(normalizedCreateInput.primarySeriesTagId)
    const isYzScheme = Boolean(seriesTagId)
    if (isYzScheme && normalizedProductCode) {
      // YZ 路径下 productCode 完全由系列码 + 系列内序号拼接生成，手工填写会破坏编码与序号的一一对应。
      throw new BizError('YZ 编码商品的产品编码由系统生成，不能手工填写', 400)
    }
    const shouldGenerateProductCode = !normalizedProductCode
    let lastError: unknown

    for (let attempt = 1; attempt <= PRODUCT_CREATE_MAX_RETRY; attempt += 1) {
      try {
        const repo = manager.getRepository(BaseProduct)
        let productCode: string
        let seriesInfo: { primarySeriesTagId: string; seriesSeq: number } | undefined
        if (isYzScheme) {
          // YZ 路径：系列标签是编码唯一权威；序号在当前事务内原子分配，重试时会重新分配，不会撞号。
          const seriesTag = await this.loadAndLockSeriesTagForYzScheme(seriesTagId as string, manager)
          const prefix = await getProductCodePrefix(manager)
          // 导入场景显式指定序号时精确占用该号；普通新建仍在事务内顺序分配，重试会重新取号不会撞号。
          const requestedSeriesSeq = normalizedCreateInput.seriesSeq ?? null
          let seriesSeq: number
          if (requestedSeriesSeq !== null) {
            await reserveSeriesSeq(manager, seriesTag.id, requestedSeriesSeq, seriesTag.seriesCode as string, prefix)
            seriesSeq = requestedSeriesSeq
          } else {
            seriesSeq = await allocateSeriesSeq(manager, seriesTag.id, seriesTag.seriesCode as string, prefix)
          }
          productCode = formatProductCode(prefix, seriesTag.seriesCode as string, seriesSeq)
          seriesInfo = { primarySeriesTagId: seriesTag.id, seriesSeq }
        } else {
          productCode = shouldGenerateProductCode ? await generateProductCode(manager) : normalizedProductCode
        }
        const product = this.buildProductEntityForCreate(repo, normalizedCreateInput, productCode, seriesInfo)
        product.categoryId = await this.resolveCategoryId(normalizedCreateInput.categoryId, manager, null)

        const saved = await repo.save(product)
        const requestedTagIds = normalizedCreateInput.tagIds ?? []
        // YZ 商品的主系列标签必须出现在标签关联里：用户没在 tagIds 里带上它时自动补一条关联。
        const effectiveTagIds = seriesInfo && !requestedTagIds.some((tagId) => normalizeEntityId(tagId) === seriesInfo!.primarySeriesTagId)
          ? [...requestedTagIds, seriesInfo.primarySeriesTagId]
          : requestedTagIds
        await this.replaceProductTags(saved.id, effectiveTagIds, manager)
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
    if (product.codeScheme === 'legacy' && input.primarySeriesTagId !== undefined) {
      // 存量商品冻结在 legacy：普通编辑接口不允许顺带切换文创系列（那需要重算 productCode/SKU 编码），
      // 必须走「升级到 YZ 编码」专用入口（upgradeProductToYzCode）。空值/未传不受影响，继续无操作。
      if (this.normalizeSeriesTagIdInput(input.primarySeriesTagId)) {
        throw new BizError('存量商品切换文创系列需要走「升级到 YZ 编码」入口，不能在普通编辑中修改', 400)
      }
    }
    if (product.codeScheme === 'yz') {
      // YZ 编码商品：产品编码由系统生成、不可手工改写；文创系列本批不支持切换（会导致 productCode 需要重算）。
      if (typeof input.productCode === 'string' && input.productCode.trim() !== product.productCode) {
        throw new BizError('YZ 编码商品的产品编码不可修改', 400)
      }
      if (input.primarySeriesTagId !== undefined) {
        const normalizedSeriesTagId = this.normalizeSeriesTagIdInput(input.primarySeriesTagId)
        // 两侧都要归一化再比：SQLite 下主键读出来是 number，而入参归一化后是 string，
        // 直接比较会让「原样回传当前系列」也被判成修改，导致编辑其它字段时被误拦。
        const currentSeriesTagId = this.normalizeSeriesTagIdInput(product.primarySeriesTagId)
        if (normalizedSeriesTagId !== currentSeriesTagId) {
          throw new BizError('YZ 编码商品的文创系列不可修改', 400)
        }
      }
    }
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

  /** 规范化 primarySeriesTagId 输入：空串/null/undefined 统一归一为 null，表示走 legacy 路径。 */
  private normalizeSeriesTagIdInput(value: string | number | null | undefined): string | null {
    if (value === null || value === undefined) return null
    const trimmed = String(value).trim()
    return trimmed || null
  }

  /** YZ 路径专用：加载并校验主系列标签，标签必须存在且已设置合法的两位大写字母系列码。 */
  private async loadSeriesTagForYzScheme(seriesTagId: string, manager: EntityManager): Promise<BaseTag> {
    const tag = await manager.getRepository(BaseTag).findOneBy({ id: seriesTagId })
    if (!tag) {
      throw new BizError('所选文创系列不存在', 400)
    }
    if (!tag.seriesCode) {
      throw new BizError('所选标签尚未设置系列编码，请先在标签管理页设置', 400)
    }
    assertSeriesCode(tag.seriesCode)
    return tag
  }

  /**
   * YZ 路径专用（建档/升级两条写路径调用，P2-C 修复）：与 loadSeriesTagForYzScheme 相比多一步——先获取
   * 与 tag.service.ts 改系列码共用的互斥锁再读标签，把"标签改系列码"与"建档/升级读取系列码"串行化，
   * 避免两者并发时本事务读到另一事务提交前的旧系列码。锁持有到本次调用方事务提交为止。
   * previewProductYzUpgrade 是只读预检、且不在显式事务内运行，不能调用本方法（加锁会退化成读完即释放的
   * 空锁，还会在 business_sequence 表留下多余的互斥键行），继续调用不加锁的 loadSeriesTagForYzScheme。
   */
  private async loadAndLockSeriesTagForYzScheme(seriesTagId: string, manager: EntityManager): Promise<BaseTag> {
    await acquireSequenceMutex(manager, buildSeriesCodeMutexKey(seriesTagId))
    return this.loadSeriesTagForYzScheme(seriesTagId, manager)
  }

  /**
   * 存量商品升级专用：读取该商品当前有效（isCurrent=true）的 SKU，按 Excel 出现顺序
   * （sortOrder，其次 id）稳定排序，保证变体码/尺码码的分配顺序在升级执行与预检模拟之间口径一致。
   * lock=true 时对 MySQL 加写锁（升级执行路径要改这些行）；预检是只读的，必须传 lock=false。
   */
  private async loadCurrentSkusForUpgrade(productId: string, manager: EntityManager, lock: boolean): Promise<BaseProductSku[]> {
    const query = manager.getRepository(BaseProductSku)
      .createQueryBuilder('sku')
      .where('sku.productId = :productId', { productId })
      .andWhere('sku.isCurrent = :isCurrent', { isCurrent: true })
      .orderBy('sku.sortOrder', 'ASC')
      .addOrderBy('sku.id', 'ASC')
    if (lock && manager.connection.options.type !== 'sqlite') {
      query.setLock('pessimistic_write')
    }
    return query.getMany()
  }

  /** 统计当前有效 SKU 在一级变体轴（颜色/款式）与尺码轴（尺码）上的去重取值数，超限返回中文错误信息，否则返回 null。 */
  private detectUpgradeCapacityBlockingReason(currentSkus: BaseProductSku[]): string | null {
    const variantValues = new Set<string>()
    const sizeValues = new Set<string>()
    currentSkus.forEach((sku) => {
      const specValues = normalizeSpecValuesKeys(parseSpecValuesJson(sku.specValuesJson))
      const variantValue = normalizeSpecTextValue(specValues[VARIANT_AXIS_SPEC_KEY])
      const sizeValue = normalizeSpecTextValue(specValues[SIZE_AXIS_SPEC_KEY])
      if (variantValue) variantValues.add(variantValue)
      if (sizeValue) sizeValues.add(sizeValue)
    })
    if (variantValues.size > 9) {
      return `该商品一级变体数量为 ${variantValues.size} 个，超过 YZ 编码规则的 9 个上限，无法升级`
    }
    if (sizeValues.size > 5) {
      return `该商品尺码数量为 ${sizeValues.size} 个，超过 YZ 编码规则的 5 个上限（A-E），无法升级`
    }
    return null
  }

  private assertUpgradeCapacity(currentSkus: BaseProductSku[]): void {
    const reason = this.detectUpgradeCapacityBlockingReason(currentSkus)
    if (reason) {
      throw new BizError(reason, 409)
    }
  }

  /**
   * 升级编码冲突检测：sku_code 与 barcode 只各自唯一，不做跨列约束；lookupByCode 扫码时条码优先命中。
   * 如果升级生成的 newProductCode / newSkuCode 恰好等于*其他*商品 SKU 的原厂条码或编码，扫描这个刚打印
   * 出来的 YZ 编码会返回错误的商品。这里用一次批量 IN 查询（不 N+1）检测，命中则返回中文冲突说明；
   * 预检（previewProductYzUpgrade）把它当 blockingReason 展示，正式升级则据此抛 409 拦截保存。
   * P1-B 修复（PR #109 第五轮评审）：legacySkuCode（历史编码）必须与 barcode/skuCode 同批纳入冲突集合——
   * 另一件已升级商品的历史编码若恰好等于本次升级生成的编码，lookupByCode 里当前 skuCode 的匹配优先级
   * 高于历史编码，那件商品升级前已打印的旧标签会静默指向本商品，这条专用路径不能绕过 legacySkuCode 检查。
   */
  private async detectUpgradeCodeConflict(
    manager: EntityManager,
    productId: string,
    newProductCode: string,
    newSkuCodes: string[],
  ): Promise<string | null> {
    const codes = [...new Set([newProductCode, ...newSkuCodes].filter(Boolean))]
    if (!codes.length) return null
    const skuRepo = manager.getRepository(BaseProductSku)
    const conflicts = await skuRepo.find({
      where: [
        { productId: Not(productId), barcode: In(codes) },
        { productId: Not(productId), skuCode: In(codes) },
        { productId: Not(productId), legacySkuCode: In(codes) },
      ],
      select: ['id', 'productId', 'skuCode', 'barcode', 'legacySkuCode'],
    })
    if (!conflicts.length) return null
    const first = conflicts.find((row) => row.barcode && codes.includes(row.barcode)) ?? conflicts[0]
    const conflictCode = codes.find((code) => code === first.barcode || code === first.skuCode || code === first.legacySkuCode) ?? codes[0]
    const conflictField = first.barcode === conflictCode ? '原厂条码' : (first.skuCode === conflictCode ? 'SKU 编码' : '历史编码')
    return `升级生成的编码「${conflictCode}」与其他商品（ID ${normalizeEntityId(first.productId)}）SKU 的${conflictField}冲突，请先处理该冲突后再升级`
  }

  /** 正式升级路径专用：冲突时直接抛 409，阻止保存。 */
  private async assertNoUpgradeCodeConflict(
    manager: EntityManager,
    productId: string,
    newProductCode: string,
    newSkuCodes: string[],
  ): Promise<void> {
    const reason = await this.detectUpgradeCodeConflict(manager, productId, newProductCode, newSkuCodes)
    if (reason) {
      throw new BizError(reason, 409)
    }
  }

  /**
   * 预检专用：预测该系列下一个 series_seq，不调用 allocateSeriesSeq（那会真的递增序列游标）。
   * 逻辑照抄 allocateSeriesSeq 的初始值来源（序列行的当前值，或库内该系列已有商品的最大 series_seq），
   * 只是最终不写回，纯预测。
   * P1 修复：预测也要跳过永久占用登记表里已登记但当前无商品的序号，否则这里预测的号与真正调用
   * allocateSeriesSeq 时实际分配到的号可能对不上（真正分配会跳过历史已删除商品占用过的号）。
   * P1-C 修复（PR #109 第五轮评审）：占用判定改为按 (code_prefix, series_code, series_seq) 命中，
   * 必须与 allocateSeriesSeq 保持完全一致的判定维度，否则预测号与真正分配号会再次对不上——见调用处
   * previewProductYzUpgrade 改为先取 prefix 再调用本方法。
   */
  private async predictNextSeriesSeq(manager: EntityManager, seriesTagId: string, seriesCode: string, prefix: string): Promise<number> {
    const sequenceKey = `product_series_seq.${seriesTagId}`
    const sequence = await manager.getRepository(BusinessSequence).findOneBy({ sequenceKey })
    let candidate: number
    if (sequence) {
      candidate = Number(sequence.currentValue ?? 0) + 1
    } else {
      const row = await manager.getRepository(BaseProduct)
        .createQueryBuilder('product')
        .select('MAX(product.seriesSeq)', 'maxSeq')
        .where('product.primarySeriesTagId = :seriesTagId', { seriesTagId })
        .getRawOne<{ maxSeq: string | number | null }>()
      candidate = Number(row?.maxSeq ?? 0) + 1
    }
    const reservationRepo = manager.getRepository(BaseYzSeriesSeqReservation)
    while (candidate <= 99 && await reservationRepo.exists({ where: { codePrefix: prefix, seriesCode, seriesSeq: candidate } })) {
      candidate += 1
    }
    return candidate
  }

  /**
   * 预检专用：模拟推算每条当前有效 SKU 升级后的 skuCode，不调用 resolveVariantCode/resolveSizeCode
   * （那些会真的写登记表），改为读登记表现状 + 在内存里按同一份候选池（VARIANT_CODE_POOL/SIZE_CODE_POOL）
   * 模拟分配，模拟结果只在本次调用内有效、不落库。分配顺序必须与 currentSkus 的传入顺序
   * （loadCurrentSkusForUpgrade 已按 sortOrder/id 排好）保持一致，才能保证预测结果与真正升级时相同。
   */
  private async simulateUpgradeSkuChanges(
    productId: string,
    currentSkus: BaseProductSku[],
    newProductCode: string,
    manager: EntityManager,
  ): Promise<ProductYzUpgradeSkuChange[]> {
    const registryRepo = manager.getRepository(BaseProductVariantCodeRegistry)
    const [variantRegistry, sizeRegistry] = await Promise.all([
      registryRepo.find({ where: { productId, axis: 'variant' } }),
      registryRepo.find({ where: { productId, axis: 'size' } }),
    ])
    const variantAssigned = new Map(variantRegistry.map((row) => [row.specValue, row.code]))
    const variantOccupied = new Set(variantRegistry.map((row) => row.code))
    const sizeAssigned = new Map(sizeRegistry.map((row) => [row.specValue, row.code]))
    const sizeOccupied = new Set(sizeRegistry.map((row) => row.code))

    const simulateVariantCode = (value: string | null | undefined): string => {
      const normalized = normalizeSpecTextValue(value)
      if (!normalized) return '0'
      const existing = variantAssigned.get(normalized)
      if (existing) return existing
      const candidate = VARIANT_CODE_POOL.find((code) => !variantOccupied.has(code))
      if (!candidate) {
        throw new BizError('该商品一级变体已达 9 个上限，YZ 编码规则不支持更多变体', 409)
      }
      variantAssigned.set(normalized, candidate)
      variantOccupied.add(candidate)
      return candidate
    }
    const simulateSizeCode = (value: string | null | undefined): string | null => {
      const normalized = normalizeSpecTextValue(value)
      if (!normalized) return null
      const existing = sizeAssigned.get(normalized)
      if (existing !== undefined) {
        return existing === EMPTY_SIZE_SENTINEL_CODE ? null : existing
      }
      const candidate = SIZE_CODE_POOL.find((code) => !sizeOccupied.has(code))
      if (!candidate) {
        throw new BizError('该商品尺码已达 5 个上限（A-E）', 409)
      }
      sizeAssigned.set(normalized, candidate)
      sizeOccupied.add(candidate)
      return candidate
    }

    // B9 批次：旧编码统一落 legacySkuCode，不再受 barcode 占用与否影响，预检不用再模拟条码占用情况。
    return currentSkus.map((sku) => {
      const specValues = normalizeSpecValuesKeys(parseSpecValuesJson(sku.specValuesJson))
      const variantCode = simulateVariantCode(specValues[VARIANT_AXIS_SPEC_KEY])
      const sizeCode = simulateSizeCode(specValues[SIZE_AXIS_SPEC_KEY])
      const oldSkuCode = sku.skuCode
      const newSkuCode = formatSkuCode(newProductCode, variantCode, sizeCode)
      return {
        skuId: String(sku.id),
        specText: sku.specText,
        oldSkuCode,
        newSkuCode,
      }
    })
  }

  private buildProductEntityForCreate(
    repo: Repository<BaseProduct>,
    input: CreateProductInput,
    productCode: string,
    seriesInfo?: { primarySeriesTagId: string; seriesSeq: number },
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
      // YZ 路径下这三个字段必须在实体构建阶段就写好：replaceProductSkus 在商品 save 之后调用，
      // SKU 编码要读 codeScheme / primarySeriesTagId，落库前必须已经就位。
      primarySeriesTagId: seriesInfo?.primarySeriesTagId ?? null,
      seriesSeq: seriesInfo?.seriesSeq ?? null,
      codeScheme: seriesInfo ? 'yz' : 'legacy',
    })
  }

  private shouldRetryCreateAttempt(error: unknown, attempt: number, shouldGenerateProductCode: boolean): boolean {
    return (
      shouldGenerateProductCode &&
      attempt < PRODUCT_CREATE_MAX_RETRY &&
      (
        isUniqueConstraintError(error, PRODUCT_CODE_CONSTRAINT_MATCHER)
        || isUniqueConstraintError(error, PRODUCT_SERIES_SEQ_CONSTRAINT_MATCHER)
        || isRetryableSqliteLockError(error)
      )
    )
  }

  private throwCreateError(error: unknown): never {
    if (isUniqueConstraintError(error, PRODUCT_CODE_CONSTRAINT_MATCHER)) {
      throw new BizError('产品编码已存在，请调整后重试', 409)
    }
    if (isUniqueConstraintError(error, PRODUCT_SERIES_SEQ_CONSTRAINT_MATCHER)) {
      throw new BizError('该系列内的商品序号已被占用，请重试', 409)
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
