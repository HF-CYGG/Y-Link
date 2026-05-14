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
import type { Express } from 'express'
import { BizError } from './errors.js'

export type UploadCategory = 'products' | 'client-feedback'

export const IMAGE_UPLOAD_MAX_FILE_SIZE = 10 * 1024 * 1024

const IMAGE_UPLOAD_ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const IMAGE_UPLOAD_ALLOWED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif'])
const UPLOAD_ROOT_DIR = path.resolve(process.cwd(), 'uploads')
const UPLOAD_TEMP_DIR = path.resolve(UPLOAD_ROOT_DIR, '.tmp')

export interface DetectedImageContent {
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'
  extension: '.jpg' | '.jpeg' | '.png' | '.webp' | '.gif'
}

const IMAGE_MIME_TO_EXTENSIONS: Record<DetectedImageContent['mimeType'], Set<DetectedImageContent['extension']>> = {
  'image/jpeg': new Set(['.jpg', '.jpeg']),
  'image/png': new Set(['.png']),
  'image/webp': new Set(['.webp']),
  'image/gif': new Set(['.gif']),
}

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

export const ensureUploadTempDir = () => {
  if (!fs.existsSync(UPLOAD_TEMP_DIR)) {
    fs.mkdirSync(UPLOAD_TEMP_DIR, { recursive: true })
  }
  return UPLOAD_TEMP_DIR
}

export const buildUploadPublicUrl = (category: UploadCategory, fileName: string) => {
  return `/uploads/${category}/${fileName}`
}

/**
 * 根据图片文件头识别真实内容类型：
 * - JPEG 识别 `FF D8 FF`；
 * - PNG 识别标准 8 字节签名；
 * - GIF 识别 `GIF87a` / `GIF89a`；
 * - WEBP 识别 `RIFF....WEBP` 容器头。
 * 若未命中任何受支持签名，则返回 `null`。
 */
export const detectImageContentFromBuffer = (buffer: Buffer): DetectedImageContent | null => {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return {
      mimeType: 'image/jpeg',
      extension: '.jpg',
    }
  }

  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return {
      mimeType: 'image/png',
      extension: '.png',
    }
  }

  const gifHeader = buffer.subarray(0, 6).toString('ascii')
  if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') {
    return {
      mimeType: 'image/gif',
      extension: '.gif',
    }
  }

  const riffHeader = buffer.subarray(0, 4).toString('ascii')
  const webpHeader = buffer.subarray(8, 12).toString('ascii')
  if (buffer.length >= 12 && riffHeader === 'RIFF' && webpHeader === 'WEBP') {
    return {
      mimeType: 'image/webp',
      extension: '.webp',
    }
  }

  return null
}

/**
 * 判断“声明元数据”和“真实图片内容”是否一致：
 * - 原始扩展名必须属于该真实类型允许的扩展名集合；
 * - 浏览器上报的 MIME 也必须与真实类型一致；
 * - 只有两者都一致，才允许文件进入正式业务目录。
 */
export const isDetectedImageCompatibleWithMetadata = (
  detectedContent: DetectedImageContent,
  originalExt: string,
  declaredMimeType: string,
) => {
  const normalizedExt = originalExt.trim().toLowerCase() as DetectedImageContent['extension']
  const normalizedMimeType = declaredMimeType.trim().toLowerCase() as DetectedImageContent['mimeType']

  if (!IMAGE_MIME_TO_EXTENSIONS[detectedContent.mimeType].has(normalizedExt)) {
    return false
  }

  return normalizedMimeType === detectedContent.mimeType
}

const cleanupUploadFileIfExists = async (filePath: string | undefined) => {
  if (!filePath || !fs.existsSync(filePath)) {
    return
  }
  await fs.promises.unlink(filePath)
}

/**
 * 将临时上传文件校验后转正到业务分类目录：
 * - 仅放行能通过文件头识别的真实图片；
 * - 若扩展名或浏览器声明类型与真实内容不一致，则立即删除临时文件并拒绝；
 * - 最终文件名仍使用 UUID，避免外部输入参与正式文件名。
 */
export const finalizeUploadedImageFile = async (
  category: UploadCategory,
  file: Express.Multer.File,
) => {
  const tempFilePath = file.path
  if (!tempFilePath) {
    throw new BizError('文件上传失败', 400)
  }

  try {
    const fileBuffer = await fs.promises.readFile(tempFilePath)
    const detectedContent = detectImageContentFromBuffer(fileBuffer)
    if (!detectedContent) {
      throw new BizError('上传文件不是受支持的真实图片内容，请重新选择图片', 400)
    }

    const originalExt = path.extname(file.originalname).toLowerCase()
    const declaredMimeType = file.mimetype.toLowerCase()
    if (!isDetectedImageCompatibleWithMetadata(detectedContent, originalExt, declaredMimeType)) {
      throw new BizError('上传文件扩展名或类型声明与真实图片内容不一致，请重新选择图片', 400)
    }

    const finalExtension =
      detectedContent.mimeType === 'image/jpeg' && originalExt === '.jpeg' ? '.jpeg' : detectedContent.extension
    const finalFileName = `${randomUUID()}${finalExtension}`
    const finalFilePath = path.resolve(ensureUploadCategoryDir(category), finalFileName)
    await fs.promises.rename(tempFilePath, finalFilePath)

    return {
      fileName: finalFileName,
      mimeType: detectedContent.mimeType,
      size: file.size,
    }
  } catch (error) {
    await cleanupUploadFileIfExists(tempFilePath)
    throw error
  }
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
        cb(null, ensureUploadTempDir())
      },
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase()
        cb(null, `${category}-${randomUUID()}${ext}`)
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
