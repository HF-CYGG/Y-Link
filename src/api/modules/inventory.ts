/**
 * 模块说明：库存管理 API 模块。
 * 文件职责：封装分类与库位、扫码识别、条码打印数据、商品 Excel 导入导出、当前库存、库存流水、库存单据与盘点接口。
 * 维护说明：
 * - 接口返回值直接沿用后端视图结构；文件下载统一走 downloadInventoryFile，避免各页面重复处理 blob；
 * - 下载失败时服务端返回的是 JSON 错误体（被 axios 当作 blob 接收），需要读出其中的中文提示再抛出。
 */

import axios from 'axios'
import http, { request, type RequestConfig } from '@/api/http'
import type { ProductSkuRecord } from '@/api/modules/product'
import type { StockDocType } from '@/constants/inventory'
import { AppRequestError, normalizeRequestError } from '@/utils/error'

export interface PagedResult<T> {
  page: number
  pageSize: number
  total: number
  list: T[]
}

export interface CategoryRecord {
  id: string
  categoryCode: string
  categoryName: string
  sortOrder: number
  isActive: boolean
  productCount: number
}

export interface LocationRecord {
  id: string
  locationCode: string
  locationName: string | null
  remark: string | null
  isActive: boolean
  skuCount: number
}

export interface CategoryPayload {
  categoryCode?: string
  categoryName?: string
  sortOrder?: number
  isActive?: boolean
}

export interface LocationPayload {
  locationCode?: string
  locationName?: string | null
  remark?: string | null
  isActive?: boolean
}

export interface ProductLookupResult {
  matchedBy: 'barcode' | 'sku_code'
  stockHidden: boolean
  product: {
    id: string
    productCode: string
    productName: string
    thumbnail: string | null
    isActive: boolean
    categoryId: string | null
    categoryName: string | null
  }
  sku: Required<Pick<ProductSkuRecord, 'id' | 'skuCode' | 'specText' | 'currentStock' | 'preOrderedStock' | 'availableStock' | 'isActive' | 'isCurrent'>>
    & Pick<ProductSkuRecord, 'barcode' | 'effectiveBarcode' | 'locationCode' | 'thumbnail'>
}

export interface ProductLabelRecord {
  skuId: string
  skuCode: string
  /** 原厂条码优先，否则退回 SKU 编码（历史合并值，语义不变）。 */
  barcode: string
  /** SKU 原厂条码原值，未录入时为 null。 */
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
  /** 主系列标签名称，legacy 商品恒为 null。 */
  seriesName: string | null
  /** 编码体系：legacy=历史编码，yz=新版定长编码。 */
  codeScheme: string
}

export interface ProductImportRow {
  rowNumber: number
  productName: string
  categoryCode: string
  specText: string
  skuCode: string
  barcode: string
  costPrice: string
  salePrice: string
  initialStock: number
  locationCode: string
  isActive: boolean
  errors: string[]
}

export interface ProductImportPreview {
  rows: ProductImportRow[]
  productCount: number
  skuCount: number
  errorCount: number
}

// ---- YZ 通用 SKU 编码体系：Excel 建库导入 ----
export interface YzImportRow {
  rowNumber: number
  category: string
  seriesSeq: number | null
  productName: string
  variantAxisValue: string
  sizeAxisValue: string
  price: string
  predictedSkuCode: string | null
  errors: string[]
}

export interface YzImportPendingConfirm {
  kind: 'multi_product_name' | 'axis_ambiguous'
  groupKey: string
  description: string
  options: Array<{ value: string; label: string }>
  suggestion: string | null
  resolved: string | null
}

export interface YzImportGroup {
  groupKey: string
  seriesCode: string
  seriesSeq: number
  productNames: string[]
  chosenProductName: string | null
  variantValues: string[]
  sizeValues: string[]
  skuCount: number
  pendingConfirms: YzImportPendingConfirm[]
}

export interface YzImportPreview {
  rows: YzImportRow[]
  groups: YzImportGroup[]
  productCount: number
  skuCount: number
  errorCount: number
  pendingConfirmCount: number
}

export interface YzImportResolution {
  groupKey: string
  kind: 'multi_product_name' | 'axis_ambiguous'
  value: string
}

export interface YzImportResult {
  productCount: number
  skuCount: number
  products: Array<{ id: string; productCode: string; productName: string; skuCount: number }>
}

export interface StockRow {
  skuId: string
  skuCode: string
  barcode: string | null
  effectiveBarcode: string
  specText: string
  productId: string
  productCode: string
  productName: string
  thumbnail: string | null
  categoryId: string | null
  categoryName: string | null
  locationId: string | null
  locationCode: string | null
  costPrice: string | null
  salePrice: string
  currentStock: number
  preOrderedStock: number
  availableStock: number
  isActive: boolean
}

export interface StockQuery {
  page?: number
  pageSize?: number
  keyword?: string
  categoryId?: string
  locationId?: string
  maxStock?: number
  includeInactive?: boolean
}

export interface InventoryLogRow {
  id: string
  createdAt: string
  productId: string
  productName: string
  skuId: string | null
  skuCode: string | null
  specText: string | null
  changeType: string
  changeTypeLabel: string
  /** 各类型沿用的历史口径数量（预订占用/释放等只影响占用量的流水也在这里体现）。 */
  changeQty: number
  /** 带符号的实际库存变化，等于 afterStock - beforeStock。 */
  stockDelta: number
  beforeStock: number
  afterStock: number
  beforeProductStock: number
  afterProductStock: number
  operatorName: string | null
  refType: string | null
  refId: string | null
  remark: string | null
}

export interface InventoryLogQuery {
  page?: number
  pageSize?: number
  keyword?: string
  changeTypes?: string[]
  skuId?: string
  refType?: string
  refId?: string
  startDate?: string
  endDate?: string
}

export interface StockDocItem {
  id: string
  productId: string
  skuId: string
  skuCode: string
  productName: string
  specText: string
  qty: number
  beforeSkuStock: number
  afterSkuStock: number
}

export interface StockDocRecord {
  id: string
  docNo: string
  docType: StockDocType
  docTypeLabel: string
  status: 'completed' | 'voided'
  reasonCode: string | null
  reasonLabel: string | null
  remark: string | null
  totalQty: number
  itemCount: number
  operatorName: string | null
  voidReason: string | null
  voidedAt: string | null
  voidedByName: string | null
  createdAt: string
  items?: StockDocItem[]
}

export interface CreateStockDocPayload {
  docType: StockDocType
  clientRequestId: string
  reasonCode?: string | null
  remark?: string | null
  items: Array<{ skuId: string; qty: number }>
}

export interface StockDocQuery {
  page?: number
  pageSize?: number
  docType?: string
  status?: string
  keyword?: string
  startDate?: string
  endDate?: string
}

export type StocktakeStatus = 'counting' | 'reviewing' | 'completed' | 'cancelled'

export interface StocktakeRecord {
  id: string
  stocktakeNo: string
  scopeType: 'all' | 'category' | 'location' | 'sku'
  scopeLabel: string
  blindMode: boolean
  status: StocktakeStatus
  remark: string | null
  createdByName: string | null
  createdAt: string
  submittedAt: string | null
  completedAt: string | null
  completedByName: string | null
  cancelledAt: string | null
  itemCount: number
  countedCount: number
  diffCount: number | null
  canViewBook: boolean
}

export interface StocktakeItemRecord {
  id: string
  skuId: string
  skuCode: string
  barcode: string
  specText: string
  productId: string
  productName: string
  thumbnail: string | null
  locationCode: string | null
  inScope: boolean
  countedQty: number | null
  countedByName: string | null
  countedAt: string | null
  bookQty: number | null
  diffQty: number | null
  diffReason: string | null
  resolution: string | null
  resolutionRemark: string | null
  appliedQty: number | null
}

export interface CreateStocktakePayload {
  scopeType: StocktakeRecord['scopeType']
  categoryIds?: string[]
  locationIds?: string[]
  skuIds?: string[]
  blindMode: boolean
  remark?: string | null
}

const cleanParams = (params: object) => Object.fromEntries(
  Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ''),
)

const isJsonBlob = (value: unknown): value is Blob =>
  typeof Blob !== 'undefined' && value instanceof Blob && /json/i.test(value.type)

/** 从 JSON 错误体 blob 中读取服务端文案；读取失败时返回空串，由调用方回退到通用提示。 */
const readBlobErrorPayload = async (blob: Blob) => {
  try {
    const payload = JSON.parse(await blob.text()) as { code?: unknown; message?: unknown }
    return {
      message: typeof payload.message === 'string' ? payload.message.trim() : '',
      code: typeof payload.code === 'number' ? payload.code : undefined,
    }
  } catch {
    return { message: '', code: undefined }
  }
}

const requestInventoryBlob = async (url: string, params: object) => {
  try {
    const response = await http.request<Blob>({ method: 'GET', url, params: cleanParams(params), responseType: 'blob' })
    if (isJsonBlob(response.data)) {
      // 服务端以 200 返回业务错误体时同样按错误处理，避免把 JSON 当文件下载。
      const { message, code } = await readBlobErrorPayload(response.data)
      throw new AppRequestError(message || '文件生成失败，请稍后重试', { code, status: response.status })
    }
    return response
  } catch (error) {
    if (error instanceof AppRequestError && !axios.isAxiosError(error.cause)) throw error
    const normalized = normalizeRequestError(error)
    const cause = normalized.cause
    const data = axios.isAxiosError(cause) ? cause.response?.data : undefined
    if (isJsonBlob(data)) {
      const { message, code } = await readBlobErrorPayload(data)
      if (message) throw new AppRequestError(message, { code: code ?? normalized.code, status: normalized.status, cause })
    }
    throw normalized
  }
}

export const downloadInventoryFile = async (url: string, fallbackName: string, params: object = {}) => {
  const response = await requestInventoryBlob(url, params)
  const disposition = response.headers['content-disposition']
  const matched = typeof disposition === 'string' ? /filename="?([^";]+)"?/.exec(disposition) : null
  const objectUrl = globalThis.URL.createObjectURL(response.data)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = matched?.[1] ?? fallbackName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  globalThis.setTimeout(() => globalThis.URL.revokeObjectURL(objectUrl), 1000)
}

// ---- 分类与库位 ----
export const getCategories = (config: RequestConfig = {}) =>
  request<CategoryRecord[]>({ ...config, method: 'GET', url: '/inventory/categories' })
export const createCategory = (data: CategoryPayload) =>
  request<CategoryRecord>({ method: 'POST', url: '/inventory/categories', data })
export const updateCategory = (id: string, data: CategoryPayload) =>
  request<CategoryRecord>({ method: 'PUT', url: `/inventory/categories/${id}`, data })
export const getLocations = (config: RequestConfig = {}) =>
  request<LocationRecord[]>({ ...config, method: 'GET', url: '/inventory/locations' })
export const createLocation = (data: LocationPayload) =>
  request<LocationRecord>({ method: 'POST', url: '/inventory/locations', data })
export const updateLocation = (id: string, data: LocationPayload) =>
  request<LocationRecord>({ method: 'PUT', url: `/inventory/locations/${id}`, data })

// ---- 商品扫码、打印与导入导出 ----
export const lookupProductByCode = (code: string, purpose?: 'stocktake', config: RequestConfig = {}) =>
  request<ProductLookupResult>({ ...config, method: 'GET', url: '/products/lookup', params: cleanParams({ code, purpose }) })
export const getProductLabels = (skuIds: string[]) =>
  request<ProductLabelRecord[]>({ method: 'POST', url: '/products/labels', data: { skuIds } })
export const exportProducts = () => downloadInventoryFile('/products/export', 'products.xlsx')
export const downloadProductImportTemplate = () => downloadInventoryFile('/products/import/template', 'product-import-template.xlsx')

const uploadProductFile = <T>(url: string, file: File) => {
  const formData = new FormData()
  formData.append('file', file)
  return request<T>({ method: 'POST', url, data: formData, headers: { 'Content-Type': 'multipart/form-data' } })
}
export const previewProductImport = (file: File) => uploadProductFile<ProductImportPreview>('/products/import/preview', file)
export const importProducts = (file: File) =>
  uploadProductFile<{ productCount: number; skuCount: number }>('/products/import', file)

// ---- YZ 通用 SKU 编码体系：Excel 建库导入 ----
export const downloadProductYzImportTemplate = () =>
  downloadInventoryFile('/products/import-yz/template', 'product-import-yz-template.xlsx')
export const previewProductYzImport = (file: File) => uploadProductFile<YzImportPreview>('/products/import-yz/preview', file)
export const importProductsYz = (file: File, resolutions: YzImportResolution[]) => {
  const formData = new FormData()
  formData.append('file', file)
  formData.append('resolutions', JSON.stringify(resolutions))
  return request<YzImportResult>({ method: 'POST', url: '/products/import-yz', data: formData, headers: { 'Content-Type': 'multipart/form-data' } })
}

// ---- 当前库存与流水 ----
export const getStocks = (params: StockQuery, config: RequestConfig = {}) =>
  request<PagedResult<StockRow> & { totalQty: number }>({ ...config, method: 'GET', url: '/inventory/stocks', params: cleanParams(params) })

const buildLogParams = (params: InventoryLogQuery) => cleanParams({ ...params, changeTypes: params.changeTypes?.join(',') })
export const getInventoryLogs = (params: InventoryLogQuery, config: RequestConfig = {}) =>
  request<PagedResult<InventoryLogRow>>({ ...config, method: 'GET', url: '/inventory/logs', params: buildLogParams(params) })
export const exportInventoryLogs = (params: InventoryLogQuery) =>
  downloadInventoryFile('/inventory/logs/export', 'inventory-logs.xlsx', buildLogParams({ ...params, page: undefined, pageSize: undefined }))

// ---- 库存单据 ----
export const getStockDocs = (params: StockDocQuery, config: RequestConfig = {}) =>
  request<PagedResult<StockDocRecord>>({ ...config, method: 'GET', url: '/inventory/docs', params: cleanParams(params) })
export const getStockDocDetail = (id: string) =>
  request<StockDocRecord>({ method: 'GET', url: `/inventory/docs/${id}` })
export const createStockDoc = (data: CreateStockDocPayload) =>
  request<StockDocRecord>({ method: 'POST', url: '/inventory/docs', data })
export const voidStockDoc = (id: string, reason: string) =>
  request<StockDocRecord>({ method: 'POST', url: `/inventory/docs/${id}/void`, data: { reason } })

// ---- 盘点 ----
export const getStocktakes = (params: { page?: number; pageSize?: number; status?: string; keyword?: string }, config: RequestConfig = {}) =>
  request<PagedResult<StocktakeRecord>>({ ...config, method: 'GET', url: '/inventory/stocktakes', params: cleanParams(params) })
export const createStocktake = (data: CreateStocktakePayload) =>
  request<StocktakeRecord>({ method: 'POST', url: '/inventory/stocktakes', data })
export const getStocktakeDetail = (id: string, config: RequestConfig = {}) =>
  request<StocktakeRecord>({ ...config, method: 'GET', url: `/inventory/stocktakes/${id}` })
export const getStocktakeItems = (
  id: string,
  params: { page?: number; pageSize?: number; keyword?: string; filter?: 'all' | 'counted' | 'uncounted' | 'diff' },
  config: RequestConfig = {},
) => request<PagedResult<StocktakeItemRecord>>({ ...config, method: 'GET', url: `/inventory/stocktakes/${id}/items`, params: cleanParams(params) })
export const countStocktakeItem = (id: string, data: { skuId: string; qty?: number | null; mode: 'set' | 'add' | 'clear' }) =>
  request<StocktakeItemRecord>({ method: 'POST', url: `/inventory/stocktakes/${id}/count`, data })
export const submitStocktake = (id: string, treatUncountedAsZero = false) =>
  request<StocktakeRecord>({ method: 'POST', url: `/inventory/stocktakes/${id}/submit`, data: { treatUncountedAsZero } })
export const reopenStocktake = (id: string) =>
  request<StocktakeRecord>({ method: 'POST', url: `/inventory/stocktakes/${id}/reopen` })
export const resolveStocktakeItem = (id: string, itemId: string, data: { diffReason?: string | null; resolution?: string | null; remark?: string | null }) =>
  request<StocktakeItemRecord>({ method: 'PUT', url: `/inventory/stocktakes/${id}/items/${itemId}/resolution`, data })
export const completeStocktake = (id: string) =>
  request<StocktakeRecord>({ method: 'POST', url: `/inventory/stocktakes/${id}/complete` })
export const cancelStocktake = (id: string) =>
  request<StocktakeRecord>({ method: 'POST', url: `/inventory/stocktakes/${id}/cancel` })
