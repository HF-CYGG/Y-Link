/**
 * 模块说明：按需模块的有界异步加载器。
 * 文件职责：统一组件和提交模块的加载超时、状态回调及定时器清理。
 * 实现逻辑：先报告加载，再对真实导入和超时竞速；失败只报告一次，超时后晚到的导入不再触发成功回调。
 * 维护说明：调用方负责失败后的页面反馈与状态恢复，不得把晚到模块继续用于业务提交。
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
