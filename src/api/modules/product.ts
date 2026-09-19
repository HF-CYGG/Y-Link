/**
 * 模块说明：产品管理 API 模块。
 * 文件职责：封装产品列表查询、详情、增删改、批量操作、YZ 通用 SKU 编码升级与字段归一化能力，供基础资料与 O2O 场景复用。
 * 维护说明：维护时重点关注价格与库存字段类型、标签关联结构、批量接口的参数兼容边界，以及 codeScheme/primarySeriesTagId 等 YZ 编码字段的透传口径。
 */

import { request, type RequestConfig } from '@/api/http'
import { calculateDiscountedPriceText, normalizeDiscountRateText } from '@/utils/o2o-price'

/**
 * 产品实体（前端消费版）：
 * - 字段与后端 BaseProduct 基本保持一致；
 * - defaultPrice 在后端为 decimal 字符串，这里保留 string 以保证精度，再由业务层按需转 number。
 */
export interface ProductRecord {
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
  tags: { id: string; tagName: string; tagCode: string | null }[]
  categoryId?: string | null
  categoryCode?: string | null
  categoryName?: string | null
  skus?: ProductSkuRecord[]
  /** YZ 编码体系专用：主系列标签ID，legacy 商品恒为 null。 */
  primarySeriesTagId: string | null
  /** 主系列标签的系列码（取自标签的 seriesCode），legacy 商品或未设置系列码的标签恒为 null。 */
  seriesCode: string | null
  /** 系列内商品序号（1-99），legacy 商品恒为 null。 */
  seriesSeq: number | null
  /** 编码体系：legacy=历史 P-/WC 编码，yz=新版定长编码。 */
  codeScheme: 'legacy' | 'yz'
  /** 升级到 YZ 编码前的历史产品编码，仅作追溯展示；未升级过（含 legacy 商品）恒为 null。 */
  legacyProductCode: string | null
}

export interface ProductSpecGroup {
  name: string
  values: string[]
}

export interface ProductSkuRecord {
  id?: string
  productId?: string
  skuCode?: string
  specValues?: Record<string, string>
  specText?: string
  defaultPrice?: string | number
  originalPrice?: string
  discountRate?: string | number
  discountedPrice?: string
  currentStock?: number
  preOrderedStock?: number
  availableStock?: number
  isActive?: boolean
  isCurrent?: boolean
  o2oRecommended?: boolean
  thumbnail?: string | null
  sortOrder?: number
  /** 原厂条码；为空表示以 SKU 编码作为内部条码。 */
  barcode?: string | null
  effectiveBarcode?: string
  costPrice?: string | number | null
  locationId?: string | null
  locationCode?: string | null
  /** YZ 编码体系专用：一级变体码（0-9）。历史 legacy 商品的 SKU 恒为 null。 */
  variantCode?: string | null
  /** YZ 编码体系专用：尺码码（A-E），无尺码位为 null。历史 legacy 商品的 SKU 恒为 null。 */
  sizeCode?: string | null
  /** 升级到 YZ 编码前的历史 SKU 编码，仅作追溯展示；未升级过（含 legacy 商品）恒为 null。 */
  legacySkuCode?: string | null
}

export interface ProductDefaultSkuDto {
  barcode?: string | null
  costPrice?: number | null
  locationId?: string | null
}

export interface CreateProductDto {
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
  categoryId?: string | null
  /** 单规格商品默认 SKU 的条码、成本价与库位。 */
  defaultSku?: ProductDefaultSkuDto
  specGroups?: ProductSpecGroup[]
  skus?: ProductSkuRecord[]
  /** 仅编辑复用同一 payload 时携带；新增接口不识别该字段。 */
  stockBaseline?: ProductStockBaseline
  /** 非空时走 YZ 通用 SKU 编码体系：productCode 由系统按该系列生成，不能手工填写。 */
  primarySeriesTagId?: string | null
}

export interface UpdateProductDto {
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
  categoryId?: string | null
  /** 单规格商品默认 SKU 的条码、成本价与库位。 */
  defaultSku?: ProductDefaultSkuDto
  specGroups?: ProductSpecGroup[]
  skus?: ProductSkuRecord[]
  /** 编辑弹窗打开时的库存基线：提交库存变动时服务端据此拦截“期间已被出入库改动”的覆盖。 */
  stockBaseline?: ProductStockBaseline
  /** YZ 编码商品本批不支持切换系列，传入与当前值不同的值会被服务层拒绝；legacy 商品传非空值同样会被拒绝。 */
  primarySeriesTagId?: string | null
}

export interface ProductStockBaseline {
  currentStock?: number
  skus?: Array<{ id: string; currentStock: number }>
}

export interface BatchUpdateProductDto {
  ids: Array<string | number>
  isActive?: boolean
}

export interface BatchCreateProductDto {
  products: CreateProductDto[]
}

/**
 * 产品查询参数：
 * - keyword 支持名称/拼音首字母模糊检索；
 * - isActive 默认传 true，仅拉取启用产品用于开单。
 */
export interface ProductListQuery {
  keyword?: string
  isActive?: boolean
  tagId?: string
  categoryId?: string
  page?: number
  pageSize?: number
}

export interface ProductPagedResult {
  page: number
  pageSize: number
  total: number
  list: ProductRecord[]
}

type PrimitiveValue = string | number | boolean | null | undefined

interface ProductTagRawRecord {
  id: PrimitiveValue
  tagName?: PrimitiveValue
  tagCode?: PrimitiveValue
}

interface ProductRawRecord {
  id?: PrimitiveValue
  productCode?: PrimitiveValue
  productName?: PrimitiveValue
  pinyinAbbr?: PrimitiveValue
  defaultPrice?: PrimitiveValue
  discountRate?: PrimitiveValue
  discountedPrice?: PrimitiveValue
  isActive?: PrimitiveValue
  o2oStatus?: PrimitiveValue
  o2oRecommended?: PrimitiveValue
  thumbnail?: PrimitiveValue
  detailContent?: PrimitiveValue
  limitPerUser?: PrimitiveValue
  currentStock?: PrimitiveValue
  preOrderedStock?: PrimitiveValue
  availableStock?: PrimitiveValue
  tagIds?: PrimitiveValue[]
  tags?: ProductTagRawRecord[] | null
  categoryId?: PrimitiveValue
  categoryCode?: PrimitiveValue
  categoryName?: PrimitiveValue
  skus?: ProductSkuRecord[] | null
  primarySeriesTagId?: PrimitiveValue
  seriesCode?: PrimitiveValue
  seriesSeq?: PrimitiveValue
  codeScheme?: PrimitiveValue
  legacyProductCode?: PrimitiveValue
}

interface ProductDetailRawResult {
  product?: ProductRawRecord | null
  tagIds?: PrimitiveValue[]
  tags?: ProductTagRawRecord[] | null
}

const normalizeId = (value: PrimitiveValue): string => {
  if (value === null || value === undefined) {
    return ''
  }

  return String(value).trim()
}

const normalizeText = (value: PrimitiveValue, fallback = ''): string => {
  const normalizedValue = normalizeId(value)
  return normalizedValue || fallback
}

const normalizeBoolean = (value: PrimitiveValue): boolean => {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    return value !== 0
  }

  const normalizedValue = normalizeText(value).toLowerCase()
  if (normalizedValue === 'true' || normalizedValue === '1') {
    return true
  }
  if (normalizedValue === 'false' || normalizedValue === '0') {
    return false
  }

  return Boolean(normalizedValue)
}

const normalizeDecimal = (value: PrimitiveValue, fallback = '0.00'): string => {
  const normalizedValue = normalizeText(value)
  if (!normalizedValue) {
    return fallback
  }

  const normalizedNumber = Number(normalizedValue)
  return Number.isFinite(normalizedNumber) ? normalizedNumber.toFixed(2) : fallback
}

const normalizeDiscountRate = (value: PrimitiveValue, fallback = '10.0'): string => {
  const normalizedValue = normalizeText(value)
  if (!normalizedValue) {
    return fallback
  }
  return normalizeDiscountRateText(normalizedValue)
}

const normalizeInteger = (value: PrimitiveValue, fallback = 0): number => {
  const normalized = Number(normalizeText(value))
  if (!Number.isFinite(normalized)) {
    return fallback
  }
  return Math.floor(normalized)
}

const normalizeCodeScheme = (value: PrimitiveValue): 'legacy' | 'yz' => (normalizeText(value) === 'yz' ? 'yz' : 'legacy')

const normalizeTagRecord = (tag: ProductTagRawRecord) => ({
  id: normalizeId(tag.id),
  tagName: normalizeText(tag.tagName),
  tagCode: normalizeText(tag.tagCode) || null,
})

const normalizeTagIds = (tagIds: PrimitiveValue[] = []): string[] => {
  return [...new Set(tagIds.map((tagId) => normalizeId(tagId)).filter(Boolean))]
}

const normalizeProductSkuRecord = (record: ProductSkuRecord): ProductSkuRecord => ({
  id: normalizeId(record.id),
  productId: normalizeId(record.productId),
  skuCode: normalizeText(record.skuCode),
  specValues: record.specValues && typeof record.specValues === 'object' ? { ...record.specValues } : {},
  specText: normalizeText(record.specText, '默认规格'),
  defaultPrice: normalizeDecimal(record.defaultPrice),
  originalPrice: normalizeDecimal(record.originalPrice ?? record.defaultPrice),
  discountRate: normalizeDiscountRate(record.discountRate),
  discountedPrice: normalizeDecimal(
    record.discountedPrice
      ?? calculateDiscountedPriceText(
        record.defaultPrice as string | number | null | undefined,
        record.discountRate as string | number | null | undefined,
      ),
  ),
  currentStock: normalizeInteger(record.currentStock),
  preOrderedStock: normalizeInteger(record.preOrderedStock),
  availableStock: normalizeInteger(record.availableStock),
  isActive: normalizeBoolean(record.isActive),
  isCurrent: normalizeBoolean(record.isCurrent),
  o2oRecommended: normalizeBoolean(record.o2oRecommended),
  thumbnail: normalizeText(record.thumbnail) || null,
  sortOrder: normalizeInteger(record.sortOrder),
  barcode: normalizeText(record.barcode) || null,
  effectiveBarcode: normalizeText(record.effectiveBarcode) || normalizeText(record.barcode) || normalizeText(record.skuCode),
  costPrice: record.costPrice === null || record.costPrice === undefined || record.costPrice === '' ? null : normalizeDecimal(record.costPrice),
  locationId: normalizeId(record.locationId) || null,
  locationCode: normalizeText(record.locationCode) || null,
  variantCode: normalizeText(record.variantCode) || null,
  sizeCode: normalizeText(record.sizeCode) || null,
  legacySkuCode: normalizeText(record.legacySkuCode) || null,
})

const normalizeProductRecord = (record: ProductRawRecord): ProductRecord => {
  const tags = (record.tags ?? []).map(normalizeTagRecord).filter((tag) => tag.id)
  const tagIds = normalizeTagIds([...(record.tagIds ?? []), ...tags.map((tag) => tag.id)])

  return {
    id: normalizeId(record.id),
    productCode: normalizeText(record.productCode),
    productName: normalizeText(record.productName),
    pinyinAbbr: normalizeText(record.pinyinAbbr),
    defaultPrice: normalizeDecimal(record.defaultPrice),
    discountRate: normalizeDiscountRate(record.discountRate),
    discountedPrice: normalizeDecimal(record.discountedPrice ?? calculateDiscountedPriceText(record.defaultPrice as string | number | null | undefined, record.discountRate as string | number | null | undefined)),
    isActive: normalizeBoolean(record.isActive),
    o2oStatus: normalizeText(record.o2oStatus, 'unlisted') === 'listed' ? 'listed' : 'unlisted',
    o2oRecommended: normalizeBoolean(record.o2oRecommended),
    thumbnail: normalizeText(record.thumbnail) || null,
    detailContent: normalizeText(record.detailContent) || null,
    limitPerUser: normalizeInteger(record.limitPerUser, 5),
    currentStock: normalizeInteger(record.currentStock, 0),
    preOrderedStock: normalizeInteger(record.preOrderedStock, 0),
    availableStock: normalizeInteger(record.availableStock, 0),
    tagIds,
    tags,
    categoryId: normalizeId(record.categoryId) || null,
    categoryCode: normalizeText(record.categoryCode) || null,
    categoryName: normalizeText(record.categoryName) || null,
    skus: Array.isArray(record.skus) ? record.skus.map(normalizeProductSkuRecord).filter((sku) => sku.id) : [],
    primarySeriesTagId: normalizeId(record.primarySeriesTagId) || null,
    seriesCode: normalizeText(record.seriesCode) || null,
    seriesSeq: record.seriesSeq === null || record.seriesSeq === undefined || record.seriesSeq === ''
      ? null
      : normalizeInteger(record.seriesSeq),
    codeScheme: normalizeCodeScheme(record.codeScheme),
    legacyProductCode: normalizeText(record.legacyProductCode) || null,
  }
}

const normalizeProductDetail = (payload: ProductRawRecord | ProductDetailRawResult): ProductRecord => {
  if ('product' in payload && payload.product) {
    return normalizeProductRecord({
      ...payload.product,
      tagIds: payload.tagIds ?? payload.product.tagIds,
      tags: payload.tags ?? payload.product.tags,
    })
  }

  return normalizeProductRecord(payload as ProductRawRecord)
}

/**
 * 获取产品列表：
 * - 开单页用于下拉候选与拼音检索；
 * - 默认在调用端限制为启用产品，避免选到停用物料。
 */
export const getProductList = async (params: ProductListQuery, requestConfig: RequestConfig = {}): Promise<ProductRecord[]> => {
  const result = await request<ProductRawRecord[]>({
    ...requestConfig,
    method: 'GET',
    url: '/products',
    params,
  })

  return result.map(normalizeProductRecord)
}

export const getProductListPaged = async (
  params: ProductListQuery,
  requestConfig: RequestConfig = {},
): Promise<ProductPagedResult> => {
  const result = await request<{
    page: number
    pageSize: number
    total: number
    list: ProductRawRecord[]
  }>({
    ...requestConfig,
    method: 'GET',
    url: '/products/paged',
    params,
  })

  return {
    page: result.page,
    pageSize: result.pageSize,
    total: result.total,
    list: result.list.map(normalizeProductRecord),
  }
}

/**
 * 获取产品详情：
 * - 支持透传 signal，供编辑弹窗等高频详情入口取消旧请求；
 * - 返回值统一归一化为前端可直接消费的产品实体。
 */
export const getProductDetail = async (id: string, requestConfig: RequestConfig = {}): Promise<ProductRecord> => {
  const result = await request<ProductRawRecord | ProductDetailRawResult>({
    ...requestConfig,
    method: 'GET',
    url: `/products/${id}`,
  })

  return normalizeProductDetail(result)
}

/**
 * 新增产品
 */
export const createProduct = async (data: CreateProductDto): Promise<ProductRecord> => {
  const result = await request<ProductRawRecord | ProductDetailRawResult>({
    method: 'POST',
    url: '/products',
    data,
  })

  return normalizeProductDetail(result)
}

/**
 * 编辑产品
 */
export const updateProduct = async (id: string, data: UpdateProductDto): Promise<ProductRecord> => {
  const result = await request<ProductRawRecord | ProductDetailRawResult>({
    method: 'PUT',
    url: `/products/${id}`,
    data,
  })

  return normalizeProductDetail(result)
}

/**
 * 批量更新产品
 */
export const batchUpdateProducts = async (data: BatchUpdateProductDto): Promise<ProductRecord[]> => {
  const result = await request<ProductRawRecord[]>({
    method: 'POST',
    url: '/products/batch',
    data,
  })

  return result.map(normalizeProductRecord)
}

/**
 * 批量新增产品
 */
export const batchCreateProducts = async (data: BatchCreateProductDto): Promise<ProductRecord[]> => {
  const result = await request<ProductRawRecord[]>({
    method: 'POST',
    url: '/products/batch-create',
    data,
  })

  return result.map(normalizeProductRecord)
}

/**
 * 删除产品
 */
export const deleteProduct = (id: string) =>
  request<boolean>({
    method: 'DELETE',
    url: `/products/${id}`,
  })

/**
 * 存量商品升级到 YZ 编码：单条 SKU 编码变化视图，供升级预检 / 执行弹窗共用。
 * B9 批次：旧编码统一写入 legacySkuCode 用于扫码兼容，不再有“是否回填条码”的分支，原
 * willBackfillBarcode 字段已随后端一并移除。
 */
export interface ProductYzUpgradeSkuChange {
  skuId: string
  specText: string
  oldSkuCode: string
  newSkuCode: string
}

/** 升级预检结果：blockingReason 非空时前端应禁止提交升级。 */
export interface ProductYzUpgradePreview {
  productId: string
  oldProductCode: string
  newProductCode: string
  seriesCode: string
  seriesSeq: number
  skuChanges: ProductYzUpgradeSkuChange[]
  retiredSkuCount: number
  blockingReason: string | null
}

/**
 * 预检存量商品升级到 YZ 编码：
 * - 只读接口，不会真正分配序号或编码，供升级弹窗展示“升级后会变成什么”。
 */
export const previewProductYzUpgrade = (productId: string, primarySeriesTagId: string): Promise<ProductYzUpgradePreview> =>
  request<ProductYzUpgradePreview>({
    method: 'POST',
    url: `/products/${productId}/yz-code-upgrade/preview`,
    data: { primarySeriesTagId },
  })

/**
 * 执行存量商品升级到 YZ 编码：
 * - 返回升级后的完整产品详情，供页面直接回填编辑态与刷新列表。
 */
export const upgradeProductToYzCode = async (productId: string, primarySeriesTagId: string): Promise<ProductRecord> => {
  const result = await request<ProductRawRecord | ProductDetailRawResult>({
    method: 'POST',
    url: `/products/${productId}/yz-code-upgrade`,
    data: { primarySeriesTagId },
  })

  return normalizeProductDetail(result)
}

/** 规格轴：variant=一级变体轴（颜色/款式），size=尺码轴。 */
export type ProductSpecAxis = 'variant' | 'size'

export interface ProductSpecValueRenamePayload {
  axis: ProductSpecAxis
  oldValue: string
  newValue: string
}

/**
 * 规格取值重命名：只改显示名称，skuCode / variantCode / sizeCode 均不变。
 * 仅 YZ 编码商品可用，legacy 商品会被后端拒绝（400）。
 */
export const renameProductSpecValue = async (productId: string, payload: ProductSpecValueRenamePayload): Promise<ProductRecord> => {
  const result = await request<ProductRawRecord | ProductDetailRawResult>({
    method: 'POST',
    url: `/products/${productId}/spec-value-rename`,
    data: payload,
  })

  return normalizeProductDetail(result)
}

export interface ProductZeroSpecEvolvePayload {
  axis: ProductSpecAxis
  mode: 'inherit' | 'retain'
  /** mode='inherit' 时必填：把原本"无该轴规格"的 SKU 继承为这个具体取值。 */
  inheritValue?: string
}

/**
 * 0 号规格演进：把商品原本"无该轴规格"的 SKU 继承为具体取值（inherit，skuCode 不变），
 * 或退役保留（retain，行保留不删除）。仅 YZ 编码商品可用，legacy 商品会被后端拒绝（400）。
 */
export const evolveProductZeroSpec = async (productId: string, payload: ProductZeroSpecEvolvePayload): Promise<ProductRecord> => {
  const result = await request<ProductRawRecord | ProductDetailRawResult>({
    method: 'POST',
    url: `/products/${productId}/zero-spec-evolve`,
    data: payload,
  })

  return normalizeProductDetail(result)
}
