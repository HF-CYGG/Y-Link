import type {
  O2oMallProductsResult,
  O2oMallStorefrontConfig,
} from '@ylink/shared-types'

import type { ApiRequestOptions, HttpAdapter } from '../types.ts'

/** O2O 公开商品目录 Contract。 */
export const createCatalogApi = (http: HttpAdapter) => ({
  getProducts(options: ApiRequestOptions = {}): Promise<O2oMallProductsResult> {
    return http.request({ ...options, method: 'GET', url: '/o2o/mall/products' })
  },

  getStorefront(options: ApiRequestOptions = {}): Promise<O2oMallStorefrontConfig> {
    return http.request({ ...options, method: 'GET', url: '/o2o/mall/storefront' })
  },
})
