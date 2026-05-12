/**
 * 模块说明：backend/src/utils/upload-storage.ts
 * 文件职责：统一维护图片上传的分目录落盘、白名单校验与静态访问 URL 生成规则。
 * 实现逻辑：
 * - 所有图片上传都按业务分类写入 `uploads/<category>` 子目录，避免不同模块文件混放；
 * - 上传前统一校验图片类型与体积，减少路由层重复定义同一套安全边界；
 * - 返回值继续使用 `/uploads/...` 相对 URL，保持前端访问方式不变。
 * 维护说明：
 * - 若后续新增其他业务上传分类，请优先在本文件扩展 `UploadCategory`；
 * - 若要扩展到文档或视频上传，请拆分图片白名单与其他文件类型策略，避免互相污染。
 */

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import multer from 'multer'
import { BizError } from './errors.js'

export type UploadCategory = 'products' | 'client-feedback'

export const IMAGE_UPLOAD_MAX_FILE_SIZE = 10 * 1024 * 1024

const IMAGE_UPLOAD_ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const IMAGE_UPLOAD_ALLOWED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif'])
const UPLOAD_ROOT_DIR = path.resolve(process.cwd(), 'uploads')

/**
 * 业务上传目录统一按分类创建：
 * - 例如商品图进入 `uploads/products`；
 * - 反馈截图进入 `uploads/client-feedback`。
 */
export const resolveUploadCategoryDir = (category: UploadCategory) => {
  return path.resolve(UPLOAD_ROOT_DIR, category)
}

export const ensureUploadCategoryDir = (category: UploadCategory) => {
  const categoryDir = resolveUploadCategoryDir(category)
  if (!fs.existsSync(categoryDir)) {
    fs.mkdirSync(categoryDir, { recursive: true })
  }
  return categoryDir
}

export const buildUploadPublicUrl = (category: UploadCategory, fileName: string) => {
  return `/uploads/${category}/${fileName}`
}

/**
 * 把历史单层上传路径规范化到指定分类目录：
 * - 仅处理 `/uploads/<file>` 这类旧格式；
 * - 已经是 `/uploads/<category>/<file>` 的新格式保持不变；
 * - 供服务层在保存前与返回前统一收口，避免旧路径继续写回数据库。
 */
export const normalizeLegacyUploadUrl = (
  category: UploadCategory,
  value: string | null | undefined,
): string | null | undefined => {
  if (value === null || value === undefined) {
    return value
  }

  const normalizedValue = value.trim()
  if (!normalizedValue) {
    return normalizedValue
  }

  const legacyMatch = /^\/uploads\/([^/]+)$/.exec(normalizedValue)
  if (!legacyMatch?.[1]) {
    return normalizedValue
  }

  return buildUploadPublicUrl(category, legacyMatch[1])
}

/**
 * 统一生成按分类落盘的图片上传中间件：
 * - 文件名仍使用 UUID，防止重名覆盖与中文名兼容问题；
 * - 目录在写入前自动确保存在，避免首次上传时报路径不存在。
 */
export const createCategorizedImageUpload = (category: UploadCategory) => {
  return multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        cb(null, ensureUploadCategoryDir(category))
      },
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase()
        cb(null, `${randomUUID()}${ext}`)
      },
    }),
    limits: {
      fileSize: IMAGE_UPLOAD_MAX_FILE_SIZE,
    },
    fileFilter: (_req, file, cb) => {
      const normalizedMime = file.mimetype.toLowerCase()
      const normalizedExt = path.extname(file.originalname).toLowerCase()
      if (IMAGE_UPLOAD_ALLOWED_MIMES.has(normalizedMime) && IMAGE_UPLOAD_ALLOWED_EXTS.has(normalizedExt)) {
        cb(null, true)
        return
      }
      cb(new BizError('仅支持上传 JPG/PNG/WEBP/GIF 图片', 400))
    },
  })
}
