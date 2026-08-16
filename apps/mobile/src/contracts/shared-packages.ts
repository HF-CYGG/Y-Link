import { ApiClientError } from '@ylink/api-client'
import type { HttpAdapter } from '@ylink/api-client'
import type { O2oMallProductsResult } from '@ylink/shared-types'

/**
 * Mobile 对共享包的最小编译与运行时边界。
 *
 * 本文件只证明正式 workspace package 可被解析；不创建 adapter、不发起请求，
 * 也不定义 token、session、购物车或订单 mutation 生命周期。
 */
export interface MobileSharedPackageContract {
  http: HttpAdapter
  catalog: O2oMallProductsResult
}

export const isSharedApiClientError = (error: unknown): error is ApiClientError => {
  return error instanceof ApiClientError
}
