/**
 * 模块说明：backend/src/middleware/database-maintenance.middleware.ts
 * 文件职责：在全应用路由之前执行数据库只读维护写屏障，并登记可排空的在途写请求。
 * 实现逻辑：
 * - GET、HEAD、OPTIONS 在维护期间继续放行，保证查询和健康检查可用；
 * - 维护状态生效后，普通写请求统一返回 HTTP 503 与业务码 50301；
 * - 未进入维护时登记所有短请求，覆盖会刷新会话活跃时间、已读状态等 GET 隐式写；
 * - SSE 长连接不占用请求级租约，其认证活跃时间更新由服务级短租约单独保护。
 * 维护说明：
 * - 本中间件必须位于匿名客户端路由和管理端鉴权路由之前，避免任何写入口漏网；
 * - 紧急回退仍由原路由的管理员鉴权、CSRF、角色与权限门禁保护。
 */

import type { NextFunction, Request, Response } from 'express'
import {
  databaseMaintenanceModeService,
  MAINTENANCE_READ_ONLY_CODE,
  MAINTENANCE_READ_ONLY_MESSAGE,
  shouldAllowWriteDuringDatabaseMaintenance,
} from '../services/database-maintenance-mode.service.js'

export function databaseMaintenanceWriteBarrier(req: Request, res: Response, next: NextFunction): void {
  const allowedDuringMaintenance = shouldAllowWriteDuringDatabaseMaintenance(req.method, req.originalUrl)
  if (databaseMaintenanceModeService.isReadOnly() && !allowedDuringMaintenance) {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Retry-After', '5')
    res.status(503).json({
      code: MAINTENANCE_READ_ONLY_CODE,
      message: MAINTENANCE_READ_ONLY_MESSAGE,
      data: null,
    })
    return
  }

  const normalizedMethod = req.method.toUpperCase()
  const normalizedPath = req.path.replace(/\/+$/, '')
  const isLongLivedSseRequest = normalizedMethod === 'GET' && (
    normalizedPath === '/api/client-feedback/stream'
    || normalizedPath === '/api/customer-service/stream'
  )
  if (
    normalizedMethod === 'OPTIONS'
    || isLongLivedSseRequest
    || databaseMaintenanceModeService.isReadOnly()
  ) {
    next()
    return
  }

  const finishWrite = databaseMaintenanceModeService.registerInFlightWrite()
  if (!finishWrite) {
    // 仅可能发生在未来本函数引入异步边界后；保留防御分支，避免漏过冻结窗口。
    if (!allowedDuringMaintenance) {
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Retry-After', '5')
      res.status(503).json({
        code: MAINTENANCE_READ_ONLY_CODE,
        message: MAINTENANCE_READ_ONLY_MESSAGE,
        data: null,
      })
      return
    }
    next()
    return
  }
  res.once('finish', finishWrite)
  res.once('close', finishWrite)
  next()
}
