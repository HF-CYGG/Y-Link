/**
 * 模块说明：backend/src/app.ts
 * 文件职责：统一装配后端应用、中间件、静态上传资源兼容策略与各业务路由。
 * 实现逻辑：
 * - 启动时注入基础安全响应头，收口敏感认证接口缓存策略；
 * - 对历史 `/uploads/<file>` 旧路径做内部改写，兼容已迁移到分类目录的真实文件；
 * - 为上传静态资源补充长期缓存与资源级安全头，降低重复回源与内容嗅探风险。
 * 维护说明：
 * - 若继续新增上传分类，请同步更新旧路径兼容改写的分类列表；
 * - 若前端托管层也有安全头策略，需与本文件保持不冲突、不过度收紧。
 */

import express from 'express'
import path from 'node:path'
import fs from 'node:fs'
import { ZodError } from 'zod'
import { requireAdminCsrf, requireAuth } from './middleware/auth.middleware.js'
import { errorHandler, notFoundHandler } from './middleware/error-handler.js'
import { authRouter } from './routes/auth.routes.js'
import { auditLogRouter } from './routes/audit-log.routes.js'
import { clientAuthRouter } from './routes/client-auth.routes.js'
import { clientFeedbackRouter } from './routes/client-feedback.routes.js'
import { clientUserManageRouter } from './routes/client-user-manage.routes.js'
import { customerServiceRouter } from './routes/customer-service.routes.js'
import { dataMaintenanceRouter } from './routes/data-maintenance.routes.js'
import { dashboardRouter } from './routes/dashboard.routes.js'
import { o2oRouter } from './routes/o2o.routes.js'
import { orderRouter } from './routes/order.routes.js'
import { productRouter } from './routes/product.routes.js'
import { reportRouter } from './routes/report.routes.js'
import { systemConfigRouter } from './routes/system-config.routes.js'
import { notificationRouter } from './routes/notification.routes.js'
import { tagRouter } from './routes/tag.routes.js'
import { uploadRouter } from './routes/upload.routes.js'
import { userRouter } from './routes/user.routes.js'
import { inboundRouter } from './routes/inbound.routes.js'
import { maskDatabaseRuntimeOverride, readDatabaseRuntimeOverride } from './config/database-runtime-override.js'
import {
  buildEffectiveDatabaseSummary,
  buildRuntimeOverrideStatusSummary,
} from './utils/effective-database.js'
import { BizError } from './utils/errors.js'

const UPLOAD_CACHE_CONTROL_VALUE = 'public, max-age=31536000, immutable'
const UPLOAD_CONTENT_SECURITY_POLICY_VALUE = "default-src 'none'; img-src 'self' data:; style-src 'none'; sandbox"
const API_JSON_BODY_LIMIT = '64mb'

/**
 * 上传静态资源头部策略：
 * - 商品图、反馈截图均为已落盘且文件名带 UUID 的只读资源，适合长期缓存；
 * - 通过资源级 CSP 与 `nosniff` 限制浏览器把图片误判成脚本等可执行内容；
 * - `same-site` 兼容当前同域代理与本地联调，不强行收紧到跨子域不可用。
 */
function applyUploadStaticResponseHeaders(res: express.Response): void {
  res.setHeader('Cache-Control', UPLOAD_CACHE_CONTROL_VALUE)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site')
  res.setHeader('Content-Security-Policy', UPLOAD_CONTENT_SECURITY_POLICY_VALUE)
}

export function createApp() {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 'loopback, linklocal, uniquelocal')
  app.disable('x-powered-by')

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    const isAuthPath = req.path.startsWith('/api/auth') || req.path.startsWith('/api/client-auth')
    if (isAuthPath) {
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Pragma', 'no-cache')
      res.vary('Cookie')
      res.vary('Authorization')
      res.vary('X-Forwarded-Proto')

      const forwardedProto = req.headers['x-forwarded-proto']
      const isHttps =
        req.secure ||
        (typeof forwardedProto === 'string' &&
          forwardedProto
            .split(',')
            .map((item) => item.trim().toLowerCase())
            .includes('https')) ||
        (Array.isArray(forwardedProto) && forwardedProto.some((item) => item.trim().toLowerCase() === 'https'))
      if (!isHttps) {
        const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : 'unknown'
        console.warn(
          `[security.transport] insecure_auth_request method=${req.method} path=${req.path} ip=${req.ip} proto=http ua=${userAgent}`,
        )
      }
    }
    next()
  })

  // 确保 uploads 目录存在
  const uploadsDir = path.resolve(process.cwd(), 'uploads')
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true })
  }

  /**
   * 兼容历史单层上传路径：
   * - 早期记录可能仍引用 `/uploads/<file>`；
   * - 当前真实文件已经按业务迁移到 `uploads/products` 或 `uploads/client-feedback`；
   * - 若命中旧路径但根目录不存在对应文件，则直接把请求内部改写到真实分类目录；
   * - 避免浏览器先请求旧路径再跟随 302 请求新路径，导致访问日志被同一张图片放大为两条。
   */
  app.use('/uploads', (req, res, next) => {
    const normalizedRequestPath = req.path.replace(/^\/+/, '')
    if (!normalizedRequestPath || normalizedRequestPath.includes('/')) {
      next()
      return
    }

    const legacyFilePath = path.resolve(uploadsDir, normalizedRequestPath)
    if (fs.existsSync(legacyFilePath)) {
      next()
      return
    }

    const uploadCategories = ['products', 'client-feedback'] as const
    const matchedCategory = uploadCategories.find((category) => {
      return fs.existsSync(path.resolve(uploadsDir, category, normalizedRequestPath))
    })

    if (!matchedCategory) {
      next()
      return
    }

    req.url = `/${matchedCategory}/${normalizedRequestPath}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`
    next()
  })

  // 配置上传静态文件服务：
  // - 继续直接暴露图片访问能力，前端数据库内仍只保存 `/uploads/...` 相对路径；
  // - 对图片返回长期缓存与基础安全头，减少商品列表/反馈详情重复拉取压力；
  // - 历史 `/uploads/<file>` 会先在上方被内部改写到分类目录，因此不会破坏旧路径兼容。
  app.use(
    '/uploads',
    express.static(uploadsDir, {
      etag: true,
      immutable: true,
      maxAge: '365d',
      setHeaders: (res) => {
        applyUploadStaticResponseHeaders(res)
      },
    }),
  )

  /**
   * JSON 请求体上限：
   * - 教职工目录“预览后确认导入”会把已识别记录以 JSON 数组再次提交；
   * - 批量导入上千条记录时，默认 100 KB 容量会被轻易撑爆，导致 body-parser 直接抛 `PayloadTooLargeError`；
   * - 这里统一放宽到与文件上传场景相同的 8 MB，覆盖系统配置大文本与批量导入确认请求。
   */
  app.use(express.json({ limit: API_JSON_BODY_LIMIT }))

  app.get('/health', (_req, res) => {
    const activeOverride = maskDatabaseRuntimeOverride(readDatabaseRuntimeOverride())
    const effectiveDatabase = buildEffectiveDatabaseSummary(activeOverride)
    const runtimeOverrideStatus = buildRuntimeOverrideStatusSummary(activeOverride)
    res.json({
      code: 0,
      message: 'ok',
      data: {
        status: 'UP',
        database: {
          effectiveDatabase,
          runtimeOverrideStatus,
        },
      },
    })
  })

  // 认证接口允许匿名访问，其中 logout / me 已在子路由内部再次做鉴权。
  app.use('/api/auth', authRouter)
  app.use('/api/client-auth', clientAuthRouter)
  app.use('/api/client-feedback', clientFeedbackRouter)
  app.use('/api/o2o', o2oRouter)

  // 业务主系统统一要求先登录再访问，且管理端写操作必须通过 CSRF 校验。
  app.use('/api', requireAuth, requireAdminCsrf)

  app.use('/api/upload', uploadRouter)

  // 日常业务接口：管理员与操作员均可访问。
  app.use('/api/products', productRouter)
  app.use('/api/tags', tagRouter)
  app.use('/api/orders', orderRouter)
  app.use('/api/dashboard', dashboardRouter)
  app.use('/api/reports', reportRouter)
  app.use('/api/inbound', inboundRouter)

  // 系统治理接口：由细粒度权限点控制，而不是单纯依赖管理员角色。
  app.use('/api/users', userRouter)
  app.use('/api/client-users', clientUserManageRouter)
  app.use('/api/customer-service', customerServiceRouter)
  app.use('/api/audit-logs', auditLogRouter)
  app.use('/api/system-configs', systemConfigRouter)
  app.use('/api/notifications', notificationRouter)
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
