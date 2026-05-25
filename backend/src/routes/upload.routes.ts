/**
 * 模块说明：backend/src/routes/upload.routes.ts
 * 文件职责：提供商品图片上传接口，统一完成分类目录落盘与静态访问 URL 返回。
 * 维护说明：调整上传规则时需同时评估磁盘占用、文件安全与前端访问路径兼容性。
 */

import { Router } from 'express'
import { requirePermission } from '../middleware/auth.middleware.js'
import { asyncHandler } from '../utils/async-handler.js'
import { BizError } from '../utils/errors.js'
import { buildUploadPublicUrl, createCategorizedImageUpload, persistValidatedImageUpload } from '../utils/upload-storage.js'

export const uploadRouter = Router()

/**
 * 上传路由说明：
 * - 当前仅开放图片上传，用于商品图片等前端静态展示资源；
 * - 文件落盘到 `uploads/products`，与反馈截图等其他业务文件分目录隔离；
 * - 路由返回的是可直接访问的 URL，而不是物理绝对路径。
 */
const upload = createCategorizedImageUpload('products')

uploadRouter.post(
  '/',
  requirePermission('products:manage'),
  upload.single('file'),
  persistValidatedImageUpload('products'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      throw new BizError('文件上传失败', 400)
    }

    const url = buildUploadPublicUrl('products', req.file.filename)
    res.json({ code: 0, message: 'ok', data: { url } })
  }),
)
