import express from 'express'
import { ZodError } from 'zod'
import { requireAuth } from './middleware/auth.middleware.js'
import { errorHandler, notFoundHandler } from './middleware/error-handler.js'
import { authRouter } from './routes/auth.routes.js'
import { auditLogRouter } from './routes/audit-log.routes.js'
import { clientAuthRouter } from './routes/client-auth.routes.js'
import { dataMaintenanceRouter } from './routes/data-maintenance.routes.js'
import { dashboardRouter } from './routes/dashboard.routes.js'
import { o2oRouter } from './routes/o2o.routes.js'
import { orderRouter } from './routes/order.routes.js'
import { productRouter } from './routes/product.routes.js'
import { systemConfigRouter } from './routes/system-config.routes.js'
import { tagRouter } from './routes/tag.routes.js'
import { userRouter } from './routes/user.routes.js'
import { BizError } from './utils/errors.js'

export function createApp() {
  const app = express()

  app.use(express.json())

  app.get('/health', (_req, res) => {
    res.json({
      code: 0,
      message: 'ok',
      data: { status: 'UP' },
    })
  })

  // 认证接口允许匿名访问，其中 logout / me 已在子路由内部再次做鉴权。
  app.use('/api/auth', authRouter)
  app.use('/api/client-auth', clientAuthRouter)
  app.use('/api/o2o', o2oRouter)

  // 业务主系统统一要求先登录再访问，避免接口侧出现“匿名调用”漏洞。
  app.use('/api', requireAuth)

  // 日常业务接口：管理员与操作员均可访问。
  app.use('/api/products', productRouter)
  app.use('/api/tags', tagRouter)
  app.use('/api/orders', orderRouter)
  app.use('/api/dashboard', dashboardRouter)

  // 系统治理接口：由细粒度权限点控制，而不是单纯依赖管理员角色。
  app.use('/api/users', userRouter)
  app.use('/api/audit-logs', auditLogRouter)
  app.use('/api/system-configs', systemConfigRouter)
  app.use('/api/data-maintenance', dataMaintenanceRouter)

  // 将 zod 参数校验错误转为业务错误，统一响应格式。
  app.use((err: unknown, _req: express.Request, _res: express.Response, next: express.NextFunction) => {
    if (err instanceof ZodError) {
      return next(new BizError(err.errors[0]?.message ?? '参数校验失败', 400))
    }
    return next(err)
  })

  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
