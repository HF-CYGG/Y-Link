import type { NextFunction, Request, Response } from 'express'
import { mapDatabaseErrorToBizError } from '../utils/database-errors.js'
import { BizError } from '../utils/errors.js'

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({
    code: 404,
    message: '接口不存在',
    data: null,
  })
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof BizError) {
    res.status(err.statusCode).json({
      code: err.statusCode,
      message: err.message,
      data: null,
    })
    return
  }

  const mappedDatabaseError = mapDatabaseErrorToBizError(err)
  if (mappedDatabaseError) {
    console.error('[y-link-backend] database error:', err)
    res.status(mappedDatabaseError.statusCode).json({
      code: mappedDatabaseError.statusCode,
      message: mappedDatabaseError.message,
      data: null,
    })
    return
  }

  console.error('[y-link-backend] unexpected error:', err)
  res.status(500).json({
    code: 500,
    message: '服务端异常，请稍后重试',
    data: null,
  })
}
