/**
 * 模块说明：`backend/src/middleware/error-handler.ts`
 * 文件职责：提供后端统一的兜底响应出口，负责未命中路由、业务异常、上传异常与数据库异常的标准化返回。
 * 实现逻辑：
 * 1. `notFoundHandler` 处理所有未匹配接口，固定返回结构化 404 JSON；
 * 2. `errorHandler` 优先识别业务异常与上传异常，避免把底层错误细节直接暴露给前端；
 * 3. body-parser 解析错误按 4xx 返回，不进入兜底日志（其 `body` 属性含原始请求体）；
 * 4. 对数据库约束类错误先转换成可读业务提示，其余未知异常统一按 500 记录脱敏日志并返回。
 */

import type { NextFunction, Request, Response } from 'express'
import multer from 'multer'
import { mapDatabaseErrorToBizError } from '../utils/database-errors.js'
import { BizError } from '../utils/errors.js'
import { toSafeErrorLog } from '../utils/safe-error-log.js'
import { DatabaseOverloadedError } from '../database/database-errors.js'
import { DatabaseWriteFrozenError } from '../database/operation-gate.js'

/**
 * body-parser 解析阶段错误：
 * - 这类错误带有 `type` 与 4xx `status`，其中 `entity.parse.failed` 还会把原始请求体挂在 `body` 属性上；
 * - 必须在兜底日志之前识别并按客户端错误返回，否则畸形的登录 JSON 会把明文密码写进错误日志。
 */
const BODY_PARSER_ERROR_RESPONSES: Record<string, { status: number; message: string }> = {
  'entity.parse.failed': { status: 400, message: '请求体不是合法的 JSON，请检查后重试' },
  'entity.too.large': { status: 413, message: '请求体过大，请减少单次提交的数据量或改用文件导入' },
  'encoding.unsupported': { status: 415, message: '不支持的请求体编码' },
  'charset.unsupported': { status: 415, message: '不支持的请求体字符集' },
  'parameters.too.many': { status: 413, message: '请求参数过多' },
  'request.aborted': { status: 400, message: '请求已中断，请重试' },
  'request.size.invalid': { status: 400, message: '请求体长度与声明不一致' },
  'entity.verify.failed': { status: 400, message: '请求体校验失败' },
  'stream.encoding.set': { status: 500, message: '服务端异常，请稍后重试' },
}

function resolveBodyParserError(err: unknown): { status: number; message: string } | null {
  if (typeof err !== 'object' || err === null || !('type' in err) || typeof err.type !== 'string') {
    return null
  }
  return BODY_PARSER_ERROR_RESPONSES[err.type] ?? null
}

/**
 * 全局 404 处理中间件：
 * - 拦截所有未匹配到的前端路由请求，返回标准化的错误响应，防止浏览器收到不可解析的 HTML 或超时。
 */
export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({
    code: 404,
    message: '接口不存在',
    data: null,
  })
}

/**
 * 全局异常处理中间件：
 * - 捕获控制器与服务层抛出的所有同步/异步异常。
 * - 优先处理已知的业务异常 (BizError)；
 * - 针对数据库级别的约束异常（如外键或唯一性冲突），通过映射器转换为对用户友好的错误提示，并掩盖底层 SQL 细节；
 * - 其他未知异常统一返回 500 状态码，并在控制台记录堆栈。
 */
export function errorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  // 流式 Excel 等响应一旦开始写入，就不能再追加 JSON 错误体。交给 Express
  // 默认错误处理关闭连接，让客户端下载明确失败而不是得到一个损坏且伪装成功的文件。
  if (res.headersSent) {
    next(err)
    return
  }

  if (err instanceof BizError) {
    if (err.retryAfterSeconds !== undefined) {
      res.setHeader('Retry-After', String(err.retryAfterSeconds))
    }
    if (err instanceof DatabaseOverloadedError || err.statusCode === 503) {
      // 明确告诉浏览器/反向代理这是瞬时过载，便于幂等请求按秒级退避重试，
      // 同时避免高峰期客户端立即重放形成重试风暴。
      res.setHeader('Retry-After', '1')
    }
    res.status(err.statusCode).json({
      code: err instanceof DatabaseWriteFrozenError ? 50301 : err.code,
      message: err.message,
      data: err.data,
    })
    return
  }

  /**
   * 上传类异常统一转成人能理解的业务提示：
   * - 文件体积超限时直接提示 10MB 上限；
   * - 其他 multer 错误统一视为上传失败，避免把底层错误码直接暴露给前端。
   */
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? '图片大小不能超过 10MB' : '文件上传失败，请重试'
    res.status(400).json({
      code: 400,
      message,
      data: null,
    })
    return
  }

  const bodyParserError = resolveBodyParserError(err)
  if (bodyParserError) {
    res.status(bodyParserError.status).json({
      code: bodyParserError.status,
      message: bodyParserError.message,
      data: null,
    })
    return
  }

  const mappedDatabaseError = mapDatabaseErrorToBizError(err)
  if (mappedDatabaseError) {
    // QueryFailedError 会携带 SQL 与 parameters；Mobile 会话参数包含完整 token hash，禁止原样记录。
    console.error('[y-link-backend] database error:', toSafeErrorLog(err))
    res.status(mappedDatabaseError.statusCode).json({
      code: mappedDatabaseError.statusCode,
      message: mappedDatabaseError.message,
      data: null,
    })
    return
  }

  // 未知异常只记录名称、消息与堆栈：错误对象的自有属性可能携带请求体、SQL 参数或令牌，禁止原样打印。
  console.error('[y-link-backend] unexpected error:', toSafeErrorLog(err))
  res.status(500).json({
    code: 500,
    message: '服务端异常，请稍后重试',
    data: null,
  })
}
