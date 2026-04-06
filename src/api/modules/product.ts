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
  tags?: { id: string; tagName: string; tagCode: string | null }[]
}

export interface CreateProductDto {
  productCode: string
  productName: string
  pinyinAbbr?: string
  defaultPrice?: number
  isActive?: boolean
  tagIds?: string[]
}

export interface UpdateProductDto {
  productCode?: string
  productName?: string
  pinyinAbbr?: string
  defaultPrice?: number
  isActive?: boolean
  tagIds?: string[]
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

/**
 * 获取产品列表：
 * - 开单页用于下拉候选与拼音检索；
 * - 默认在调用端限制为启用产品，避免选到停用物料。
 */
export const getProductList = (params: ProductListQuery, requestConfig: RequestConfig = {}) =>
  request<ProductRecord[]>({
    ...requestConfig,
    method: 'GET',
    url: '/products',
    params,
  })

/**
 * 获取产品详情
 */
export const getProductDetail = (id: string) =>
  request<ProductRecord>({
    method: 'GET',
    url: `/products/${id}`,
  })

/**
 * 新增产品
 */
export const createProduct = (data: CreateProductDto) =>
  request<ProductRecord>({
    method: 'POST',
    url: '/products',
    data,
  })

/**
 * 编辑产品
 */
export const updateProduct = (id: string, data: UpdateProductDto) =>
  request<ProductRecord>({
    method: 'PUT',
    url: `/products/${id}`,
    data,
  })

/**
 * 删除产品
 */
export const deleteProduct = (id: string) =>
  request<boolean>({
    method: 'DELETE',
    url: `/products/${id}`,
  })
