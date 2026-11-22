/** 首次并发共享同一资源加载；失败不缓存，后续调用可重试。 */
export function createRetryableLazyResource<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined
  return () => {
    if (!pending) {
      pending = Promise.resolve().then(load).catch((error: unknown) => {
        pending = undefined
        throw error
      })
    }
    return pending
  }
}
