import type { HttpAdapter, HttpRequestConfig } from './types.ts'

/** Web 运行时提供的桥接边界；共享包不依赖现有 Web 请求源码。 */
export interface WebHttpBridge {
  request<T>(config: HttpRequestConfig): Promise<T>
}

/** 将调用方传入的 Web bridge 暴露为统一 HttpAdapter，不追加平台行为。 */
export const createWebHttpAdapter = (bridge: WebHttpBridge): HttpAdapter => {
  return {
    request<T>(config: HttpRequestConfig) {
      return bridge.request<T>(config)
    },
  }
}
