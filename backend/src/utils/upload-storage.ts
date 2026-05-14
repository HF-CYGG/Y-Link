/**
 * 模块说明：backend/src/utils/upload-storage.ts
 * 文件职责：统一维护图片上传的分目录落盘、白名单校验、尺寸上限、服务端重编码与静态访问 URL 生成规则。
 * 实现逻辑：
 * - 所有图片上传都按业务分类写入 `uploads/<category>` 子目录，避免不同模块文件混放；
 * - 上传前统一校验图片类型、体积与真实文件头，减少路由层重复定义同一套安全边界；
 * - 文件转正前使用服务端图像解码能力校验像素尺寸、识别异常图片，并重编码为干净输出，降低损坏文件与畸形元数据风险；
 * - 返回值继续使用 `/uploads/...` 相对 URL，保持前端访问方式不变。
 * 维护说明：
 * - 若后续新增其他业务上传分类，请优先在本文件扩展 `UploadCategory`；
 * - 若要扩展到文档或视频上传，请拆分图片白名单与其他文件类型策略，避免互相污染；
 * - 调整尺寸与重编码参数后，需同步执行上传专项验证脚本，确认旧路径兼容与异常图片拦截未退化。
 */

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import multer from 'multer'
import type { Express } from 'express'
import sharp from 'sharp'
import { BizError } from './errors.js'

export type UploadCategory = 'products' | 'client-feedback'

export const IMAGE_UPLOAD_MAX_FILE_SIZE = 10 * 1024 * 1024
export const IMAGE_UPLOAD_MAX_WIDTH = 4096
export const IMAGE_UPLOAD_MAX_HEIGHT = 4096
export const IMAGE_UPLOAD_MAX_PIXELS = IMAGE_UPLOAD_MAX_WIDTH * IMAGE_UPLOAD_MAX_HEIGHT

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

const IMAGE_MIME_TO_FINAL_EXTENSION: Record<DetectedImageContent['mimeType'], DetectedImageContent['extension']> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

const SHARP_ANIMATED_MIME_TYPES = new Set<DetectedImageContent['mimeType']>(['image/webp', 'image/gif'])

export interface ValidatedImageDimensions {
  width: number
  height: number
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

const createSharpInput = (buffer: Buffer, mimeType: DetectedImageContent['mimeType']) => {
  return sharp(buffer, {
    animated: SHARP_ANIMATED_MIME_TYPES.has(mimeType),
    failOn: 'error',
    limitInputPixels: IMAGE_UPLOAD_MAX_PIXELS,
  })
}

/**
 * 使用服务端图像解码能力做第二层图片真实性校验：
 * - 能识别“文件头看起来像图片，但实际像素流损坏”的异常文件；
 * - 同时统一读取宽高，避免只靠浏览器或前端脚本约束尺寸；
 * - 对超大像素图直接拒绝，降低图像炸弹与异常内存占用风险。
 */
const validateImageDimensions = async (
  buffer: Buffer,
  detectedContent: DetectedImageContent,
): Promise<ValidatedImageDimensions> => {
  let metadata: sharp.Metadata
  try {
    metadata = await createSharpInput(buffer, detectedContent.mimeType).metadata()
  } catch {
    throw new BizError('上传图片已损坏或内容异常，请重新选择图片', 400)
  }

  const width = Number(metadata.width)
  const height = Number(metadata.height)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new BizError('无法识别图片尺寸，请重新选择图片', 400)
  }

  if (width > IMAGE_UPLOAD_MAX_WIDTH || height > IMAGE_UPLOAD_MAX_HEIGHT || width * height > IMAGE_UPLOAD_MAX_PIXELS) {
    throw new BizError(
      `图片尺寸过大，宽高不能超过 ${IMAGE_UPLOAD_MAX_WIDTH}x${IMAGE_UPLOAD_MAX_HEIGHT} 像素`,
      400,
    )
  }

  return {
    width,
    height,
  }
}

/**
 * 所有通过校验的图片都会在服务端重新编码：
 * - 去掉来源不明的冗余元数据，统一输出格式参数；
 * - 通过重新解码/编码再次确认图片内容可被正常处理；
 * - 对 JPEG 自动执行方向纠正，减少手机拍照图横竖颠倒问题。
 */
const reencodeValidatedImage = async (
  buffer: Buffer,
  detectedContent: DetectedImageContent,
): Promise<Buffer> => {
  const pipeline = createSharpInput(buffer, detectedContent.mimeType).rotate()

  try {
    if (detectedContent.mimeType === 'image/jpeg') {
      return await pipeline
        .jpeg({
          quality: 86,
          mozjpeg: true,
        })
        .toBuffer()
    }

    if (detectedContent.mimeType === 'image/png') {
      return await pipeline
        .png({
          compressionLevel: 9,
          adaptiveFiltering: true,
          palette: false,
        })
        .toBuffer()
    }

    if (detectedContent.mimeType === 'image/webp') {
      return await pipeline
        .webp({
          quality: 86,
          alphaQuality: 90,
          effort: 4,
        })
        .toBuffer()
    }

    return await pipeline
      .gif({
        effort: 7,
        reuse: true,
      })
      .toBuffer()
  } catch {
    throw new BizError('上传图片已损坏或内容异常，请重新选择图片', 400)
  }
}

/**
 * 将临时上传文件校验后转正到业务分类目录：
 * - 仅放行能通过文件头识别的真实图片；
 * - 若扩展名或浏览器声明类型与真实内容不一致，则立即删除临时文件并拒绝；
 * - 若图片已损坏、不可正常解码或像素尺寸超标，则立即删除临时文件并拒绝；
 * - 通过校验后统一做服务端重编码，再以 UUID 文件名写入正式目录，避免外部输入参与正式文件名。
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

    await validateImageDimensions(fileBuffer, detectedContent)
    const reencodedBuffer = await reencodeValidatedImage(fileBuffer, detectedContent)

    const finalExtension = IMAGE_MIME_TO_FINAL_EXTENSION[detectedContent.mimeType]
    const finalFileName = `${randomUUID()}${finalExtension}`
    const finalFilePath = path.resolve(ensureUploadCategoryDir(category), finalFileName)
    await fs.promises.writeFile(finalFilePath, reencodedBuffer)
    await cleanupUploadFileIfExists(tempFilePath)

    return {
      fileName: finalFileName,
      mimeType: detectedContent.mimeType,
      size: reencodedBuffer.byteLength,
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
