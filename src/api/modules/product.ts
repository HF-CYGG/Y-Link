/**
 * 模块说明：src/api/modules/product.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { request, type RequestConfig } from '@/api/http'

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
  isActive: boolean
  category: string
  o2oStatus: 'listed' | 'unlisted'
  thumbnail: string | null
  detailContent: string | null
  limitPerUser: number
  currentStock: number
  preOrderedStock: number
  availableStock: number
  tagIds: string[]
  tags: { id: string; tagName: string; tagCode: string | null }[]
}

export interface CreateProductDto {
  productCode?: string
  productName: string
  pinyinAbbr?: string
  defaultPrice?: number
  isActive?: boolean
  category?: string
  o2oStatus?: 'listed' | 'unlisted'
  thumbnail?: string | null
  detailContent?: string | null
  limitPerUser?: number
  currentStock?: number
  preOrderedStock?: number
  tagIds?: Array<string | number>
}

export interface UpdateProductDto {
  productCode?: string
  productName?: string
  pinyinAbbr?: string
  defaultPrice?: number
  isActive?: boolean
  category?: string
  o2oStatus?: 'listed' | 'unlisted'
  thumbnail?: string | null
  detailContent?: string | null
  limitPerUser?: number
  currentStock?: number
  preOrderedStock?: number
  tagIds?: Array<string | number>
}

export interface BatchUpdateProductDto {
  ids: Array<string | number>
  isActive?: boolean
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
  isActive?: PrimitiveValue
  category?: PrimitiveValue
  o2oStatus?: PrimitiveValue
  thumbnail?: PrimitiveValue
  detailContent?: PrimitiveValue
  limitPerUser?: PrimitiveValue
  currentStock?: PrimitiveValue
  preOrderedStock?: PrimitiveValue
  availableStock?: PrimitiveValue
  tagIds?: PrimitiveValue[]
  tags?: ProductTagRawRecord[] | null
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

const normalizeInteger = (value: PrimitiveValue, fallback = 0): number => {
  const normalized = Number(normalizeText(value))
  if (!Number.isFinite(normalized)) {
    return fallback
  }
  return Math.floor(normalized)
}

const normalizeTagRecord = (tag: ProductTagRawRecord) => ({
  id: normalizeId(tag.id),
  tagName: normalizeText(tag.tagName),
  tagCode: normalizeText(tag.tagCode) || null,
})

const normalizeTagIds = (tagIds: PrimitiveValue[] = []): string[] => {
  return [...new Set(tagIds.map((tagId) => normalizeId(tagId)).filter(Boolean))]
}

const normalizeProductRecord = (record: ProductRawRecord): ProductRecord => {
  const tags = (record.tags ?? []).map(normalizeTagRecord).filter((tag) => tag.id)
  const tagIds = normalizeTagIds([...(record.tagIds ?? []), ...tags.map((tag) => tag.id)])

  return {
    id: normalizeId(record.id),
    productCode: normalizeText(record.productCode),
    productName: normalizeText(record.productName),
    pinyinAbbr: normalizeText(record.pinyinAbbr),
    defaultPrice: normalizeDecimal(record.defaultPrice),
    isActive: normalizeBoolean(record.isActive),
    category: normalizeText(record.category, '默认分类'),
    o2oStatus: normalizeText(record.o2oStatus, 'unlisted') === 'listed' ? 'listed' : 'unlisted',
    thumbnail: normalizeText(record.thumbnail) || null,
    detailContent: normalizeText(record.detailContent) || null,
    limitPerUser: normalizeInteger(record.limitPerUser, 5),
    currentStock: normalizeInteger(record.currentStock, 0),
    preOrderedStock: normalizeInteger(record.preOrderedStock, 0),
    availableStock: normalizeInteger(record.availableStock, 0),
    tagIds,
    tags,
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

/**
 * 获取产品详情
 */
export const getProductDetail = async (id: string): Promise<ProductRecord> => {
  const result = await request<ProductRawRecord | ProductDetailRawResult>({
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
 * 删除产品
 */
export const deleteProduct = (id: string) =>
  request<boolean>({
    method: 'DELETE',
    url: `/products/${id}`,
  })
