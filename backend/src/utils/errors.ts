/**
 * 文件说明：业务异常定义文件，提供可携带 HTTP 状态码的统一业务错误类型。
 * 实现逻辑：通过扩展原生 Error 把业务提示语与状态码打包，供路由层和服务层抛出后被全局错误处理中间件识别。
 * 维护重点：扩展错误模型时，需要同步检查全局错误响应格式以及前端对状态码和提示语的消费方式。
 */

export class BizError extends Error {
  statusCode: number

  constructor(message: string, statusCode = 400) {
    super(message)
    this.name = 'BizError'
    this.statusCode = statusCode
  }
}
