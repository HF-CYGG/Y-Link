/**
 * 文件说明：业务异常定义文件，提供可携带 HTTP 状态码的统一业务错误类型。
 * 实现逻辑：通过扩展原生 Error 把业务提示语与状态码打包，供路由层和服务层抛出后被全局错误处理中间件识别。
 * 维护重点：扩展错误模型时，需要同步检查全局错误响应格式以及前端对状态码和提示语的消费方式。
 */

export class BizError extends Error {
  statusCode: number
  code: number
  data: unknown
  retryAfterSeconds?: number

  constructor(
    message: string,
    statusCode = 400,
    optionsOrData: { code?: number; data?: unknown; retryAfterSeconds?: number } | Record<string, unknown> | null = null,
  ) {
    super(message)
    this.name = 'BizError'
    this.statusCode = statusCode

    const isProtocolOptions = optionsOrData !== null
      && (
        Object.hasOwn(optionsOrData, 'data')
        || Object.hasOwn(optionsOrData, 'retryAfterSeconds')
        || (Object.hasOwn(optionsOrData, 'code') && Object.keys(optionsOrData).every((key) => key === 'code'))
      )

    if (isProtocolOptions) {
      const options = optionsOrData as { code?: number; data?: unknown; retryAfterSeconds?: number }
      this.code = options.code ?? statusCode
      this.data = options.data ?? null
      this.retryAfterSeconds = options.retryAfterSeconds
      return
    }

    // 保持 main 既有调用的扁平业务 data，例如 { reason } 和维护冻结的 { code: 50301, reason }；
    // 不能把它们误嵌套为 data.data，也不能因 Mobile 协议扩展而丢失原因字段。
    this.code = statusCode
    this.data = optionsOrData
  }
}
