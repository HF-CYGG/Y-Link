/**
 * 模块说明：移动端订单卡片异步加载器。
 * 文件职责：将组件加载、超时拒绝与加载状态回调收口，确保超时和真实导入失败走同一错误路径。
 * 维护说明：load 成功后才允许调用 onSuccess；超时后的晚到结果不会改写已发布的错误状态。
 */
export interface TimedAsyncLoaderOptions<T> {
  load: () => Promise<T>
  timeoutMs: number
  timeoutMessage: string
  onLoading: () => void
  onSuccess: () => void
  onError: (error: unknown) => void
}

export const createTimedAsyncLoader = <T>(options: TimedAsyncLoaderOptions<T>) => {
  return async (): Promise<T> => {
    options.onLoading()
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => reject(new Error(options.timeoutMessage)), options.timeoutMs)
    })

    try {
      const component = await Promise.race([options.load(), timeout])
      options.onSuccess()
      return component
    } catch (error) {
      options.onError(error)
      throw error
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId)
    }
  }
}
