/**
 * 模块说明：backend/src/utils/upload-storage.ts
 * 文件职责：统一维护图片上传的分目录落盘、白名单校验与静态访问 URL 生成规则。
 * 实现逻辑：
 * - 所有图片上传都按业务分类写入 `uploads/<category>` 子目录，避免不同模块文件混放；
 * - 上传前统一校验图片类型、真实文件头与基础尺寸，减少路由层重复定义同一套安全边界；
 * - 返回值继续使用 `/uploads/...` 相对 URL，保持前端访问方式不变。
 * 维护说明：
 * - 若后续新增其他业务上传分类，请优先在本文件扩展 `UploadCategory`；
 * - 若要扩展到文档或视频上传，请拆分图片白名单与其他文件类型策略，避免互相污染。
 */

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RequestHandler } from 'express'
import multer from 'multer'
import { BizError } from './errors.js'

export type UploadCategory = 'products' | 'client-feedback'

export const IMAGE_UPLOAD_MAX_FILE_SIZE = 10 * 1024 * 1024
export const IMAGE_UPLOAD_MAX_DIMENSION = 12000

const IMAGE_UPLOAD_ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const IMAGE_UPLOAD_ALLOWED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif'])
const UPLOAD_ROOT_DIR = path.resolve(process.cwd(), 'uploads')

type DetectedImageFormat = 'jpeg' | 'png' | 'webp' | 'gif'

type ImageMetadata = {
  format: DetectedImageFormat
  width: number
  height: number
}

const IMAGE_UPLOAD_FORMAT_TO_MIME: Record<DetectedImageFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
}

const IMAGE_UPLOAD_FORMAT_TO_EXTS: Record<DetectedImageFormat, readonly string[]> = {
  jpeg: ['.jpg', '.jpeg'],
  png: ['.png'],
  webp: ['.webp'],
  gif: ['.gif'],
}

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf,
])

function readUInt24LE(buffer: Buffer, offset: number) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16)
}

function validateImageDimensions(width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new BizError('上传文件不是合法图片', 400)
  }
  if (width > IMAGE_UPLOAD_MAX_DIMENSION || height > IMAGE_UPLOAD_MAX_DIMENSION) {
    throw new BizError(`图片尺寸不能超过 ${IMAGE_UPLOAD_MAX_DIMENSION} x ${IMAGE_UPLOAD_MAX_DIMENSION}`, 400)
  }
}

function detectPngMetadata(buffer: Buffer): ImageMetadata | null {
  if (buffer.length < 24) {
    return null
  }
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (!signature.every((value, index) => buffer[index] === value)) {
    return null
  }
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') {
    return null
  }
  return {
    format: 'png',
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  }
}

function detectGifMetadata(buffer: Buffer): ImageMetadata | null {
  if (buffer.length < 10) {
    return null
  }
  const header = buffer.toString('ascii', 0, 6)
  if (header !== 'GIF87a' && header !== 'GIF89a') {
    return null
  }
  return {
    format: 'gif',
    width: buffer.readUInt16LE(6),
    height: buffer.readUInt16LE(8),
  }
}

function detectJpegMetadata(buffer: Buffer): ImageMetadata | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null
  }

  let offset = 2
  while (offset + 3 < buffer.length) {
    while (offset < buffer.length && buffer[offset] === 0xff) {
      offset += 1
    }
    if (offset >= buffer.length) {
      break
    }

    const marker = buffer[offset]
    offset += 1

    if (marker === 0xd8 || marker === 0xd9) {
      continue
    }

    if (offset + 1 >= buffer.length) {
      break
    }

    const segmentLength = buffer.readUInt16BE(offset)
    if (segmentLength < 2 || offset + segmentLength > buffer.length) {
      break
    }

    if (JPEG_SOF_MARKERS.has(marker)) {
      if (segmentLength < 7) {
        break
      }
      return {
        format: 'jpeg',
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      }
    }

    offset += segmentLength
  }

  return null
}

function detectWebpMetadata(buffer: Buffer): ImageMetadata | null {
  if (buffer.length < 30 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') {
    return null
  }

  const chunkType = buffer.toString('ascii', 12, 16)

  if (chunkType === 'VP8X') {
    return {
      format: 'webp',
      width: readUInt24LE(buffer, 24) + 1,
      height: readUInt24LE(buffer, 27) + 1,
    }
  }

  if (chunkType === 'VP8L') {
    if (buffer[20] !== 0x2f) {
      return null
    }
    const b0 = buffer[21]
    const b1 = buffer[22]
    const b2 = buffer[23]
    const b3 = buffer[24]
    return {
      format: 'webp',
      width: 1 + (b0 | ((b1 & 0x3f) << 8)),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    }
  }

  if (chunkType === 'VP8 ') {
    if (buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) {
      return null
    }
    return {
      format: 'webp',
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    }
  }

  return null
}

function detectImageMetadata(buffer: Buffer): ImageMetadata | null {
  return (
    detectPngMetadata(buffer)
    ?? detectGifMetadata(buffer)
    ?? detectJpegMetadata(buffer)
    ?? detectWebpMetadata(buffer)
  )
}

function validateUploadedImageFile(file: Express.Multer.File): ImageMetadata {
  const normalizedMime = file.mimetype.toLowerCase()
  const normalizedExt = path.extname(file.originalname).toLowerCase()
  const metadata = detectImageMetadata(file.buffer)

  if (!metadata) {
    throw new BizError('上传文件不是合法图片', 400)
  }

  validateImageDimensions(metadata.width, metadata.height)

  const expectedMime = IMAGE_UPLOAD_FORMAT_TO_MIME[metadata.format]
  const expectedExts = IMAGE_UPLOAD_FORMAT_TO_EXTS[metadata.format]
  if (normalizedMime !== expectedMime || !expectedExts.includes(normalizedExt)) {
    throw new BizError('图片内容与扩展名或 MIME 类型不匹配', 400)
  }

  return metadata
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

export const buildUploadPublicUrl = (category: UploadCategory, fileName: string) => {
  return `/uploads/${category}/${fileName}`
}

/**
 * 统一生成按分类上传的图片中间件：
 * - 首层只做扩展名、MIME 与大小白名单过滤；
 * - 真正的图片内容校验与落盘放到后续中间件，避免恶意文件先写入磁盘。
 */
export const createCategorizedImageUpload = (_category: UploadCategory) => {
  return multer({
    storage: multer.memoryStorage(),
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

/**
 * 校验图片内容后再落盘：
 * - 通过文件头识别真实格式，阻断伪造后缀和 MIME 的恶意上传；
 * - 复用 UUID 文件名策略，避免重名覆盖；
 * - 将验证后的文件信息回填到 `req.file`，保持既有路由返回结构不变。
 */
export const persistValidatedImageUpload = (category: UploadCategory): RequestHandler => {
  return async (req, _res, next) => {
    try {
      if (!req.file) {
        next()
        return
      }

      const metadata = validateUploadedImageFile(req.file)
      const categoryDir = ensureUploadCategoryDir(category)
      const normalizedExt = path.extname(req.file.originalname).toLowerCase()
      const targetExt = IMAGE_UPLOAD_FORMAT_TO_EXTS[metadata.format].includes(normalizedExt)
        ? normalizedExt
        : IMAGE_UPLOAD_FORMAT_TO_EXTS[metadata.format][0]
      const fileName = `${randomUUID()}${targetExt}`
      const filePath = path.resolve(categoryDir, fileName)

      await fs.promises.writeFile(filePath, req.file.buffer)

      req.file.destination = categoryDir
      req.file.filename = fileName
      req.file.mimetype = IMAGE_UPLOAD_FORMAT_TO_MIME[metadata.format]
      req.file.path = filePath
      req.file.size = req.file.buffer.length

      next()
    } catch (error) {
      next(error)
    }
  }
}
