/**
 * 模块说明：backend/src/utils/errors.ts
 * 文件职责：业务异常模型定义，提供可控状态码与标准错误信息封装。
 * 实现逻辑：
 * - 通过 `BizError` 承载业务可预期失败；
 * - 让错误中间件可按类型输出稳定响应。
 * 维护说明：
 * - 业务错误码扩展需保证前端提示与回归断言同步更新。
 */

export class BizError extends Error {
  statusCode: number

  constructor(message: string, statusCode = 400) {
    super(message)
    this.name = 'BizError'
    this.statusCode = statusCode
  }
}
