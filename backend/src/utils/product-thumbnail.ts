/**
 * 文件说明：商品缩略图工具，负责按命名约定生成、定位和对外解析商品图的小尺寸 WebP 版本。
 * 实现逻辑：
 * - 命名约定：原图 `uploads/products/<name>.<ext>` 对应缩略图 `uploads/products/<name>.thumb.webp`，不改表结构、不改数据库里保存的原图 URL；
 * - 生成规则：长边不超过 480px、只缩不放、取动图首帧，统一输出 WebP，供商城卡片、购物车等小尺寸场景使用；
 * - 对外解析：商城目录构建时把原图 URL 映射为缩略图 URL，仅当缩略图文件真实存在才返回，缺失时返回 null，前端回退原图；
 * - 存在性判断带有界内存缓存：已存在的结果长期缓存（缩略图不会被删除），不存在的结果短期缓存，回填后约一分钟内生效；
 * - 存量回填：服务启动后延迟在后台以并发 1 自动补齐缺失缩略图（幂等，可用 Y_LINK_PRODUCT_THUMBNAIL_BACKFILL=false 关闭），
 *   生产镜像只包含编译产物，因此回填核心放在 src 内，命令行脚本 scripts/product-thumbnail-backfill.ts 仅做本地入口。
 * 维护重点：
 * - 只接受 `/uploads/products/` 与历史单层 `/uploads/<file>` 两种格式，文件名只允许字母数字、下划线与连字符，防止路径穿越；
 * - 反馈私有图片（client-feedback）绝不生成或解析缩略图；
 * - 缩略图生成失败不得影响原图上传结果，调用方只记录日志。
 */

import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

export const PRODUCT_THUMBNAIL_MAX_EDGE = 480
export const PRODUCT_THUMBNAIL_QUALITY = 78
export const PRODUCT_THUMBNAIL_SUFFIX = '.thumb.webp'

const PRODUCT_UPLOAD_DIR = path.resolve(process.cwd(), 'uploads', 'products')
const ORIGINAL_FILE_NAME_MATCHER = /^([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.(?:jpg|jpeg|png|webp|gif)$/i
const PRODUCT_IMAGE_URL_MATCHER = /^\/uploads\/(?:products\/)?([^/?#]+)$/
const EXISTENCE_CACHE_LIMIT = 5000
const MISSING_CACHE_TTL_MS = 60_000

/** 已存在的缩略图文件名（长期缓存）与“不存在”的短期缓存（记录失效时间）。 */
const existingThumbnailCache = new Set<string>()
const missingThumbnailCache = new Map<string, number>()

/** 原图文件名 → 缩略图文件名；原图文件名不合法时返回 null。 */
export const buildProductThumbnailFileName = (originalFileName: string): string | null => {
  const matched = ORIGINAL_FILE_NAME_MATCHER.exec(originalFileName)
  if (!matched?.[1]) {
    return null
  }
  return `${matched[1]}${PRODUCT_THUMBNAIL_SUFFIX}`
}

export const isProductThumbnailFileName = (fileName: string) => fileName.endsWith(PRODUCT_THUMBNAIL_SUFFIX)

/** 从已通过校验的图片内容生成缩略图并写入目标路径。 */
export const generateProductThumbnail = async (imageBuffer: Buffer, targetFilePath: string): Promise<void> => {
  const thumbnailBuffer = await sharp(imageBuffer, {
    animated: false,
    failOn: 'error',
    limitInputPixels: 4096 * 4096,
  })
    .rotate()
    .resize({
      width: PRODUCT_THUMBNAIL_MAX_EDGE,
      height: PRODUCT_THUMBNAIL_MAX_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: PRODUCT_THUMBNAIL_QUALITY, effort: 4 })
    .toBuffer()
  // 先写临时文件再原子改名，避免并发读取到半截文件。
  const temporaryPath = `${targetFilePath}.${process.pid}.tmp`
  await fs.promises.writeFile(temporaryPath, thumbnailBuffer)
  await fs.promises.rename(temporaryPath, targetFilePath)
  rememberThumbnailExists(path.basename(targetFilePath))
}

/** 为商品原图文件生成缩略图；原图文件名不合法时直接跳过。返回缩略图文件名或 null。 */
export const generateProductThumbnailForFile = async (originalFilePath: string, imageBuffer?: Buffer): Promise<string | null> => {
  const thumbnailFileName = buildProductThumbnailFileName(path.basename(originalFilePath))
  if (!thumbnailFileName) {
    return null
  }
  const sourceBuffer = imageBuffer ?? await fs.promises.readFile(originalFilePath)
  await generateProductThumbnail(sourceBuffer, path.resolve(path.dirname(originalFilePath), thumbnailFileName))
  return thumbnailFileName
}

const trimCache = () => {
  if (existingThumbnailCache.size > EXISTENCE_CACHE_LIMIT) {
    existingThumbnailCache.clear()
  }
  if (missingThumbnailCache.size > EXISTENCE_CACHE_LIMIT) {
    missingThumbnailCache.clear()
  }
}

export const rememberThumbnailExists = (thumbnailFileName: string) => {
  trimCache()
  existingThumbnailCache.add(thumbnailFileName)
  missingThumbnailCache.delete(thumbnailFileName)
}

const thumbnailFileExists = (thumbnailFileName: string, uploadDir: string) => {
  if (existingThumbnailCache.has(thumbnailFileName)) {
    return true
  }
  const missingUntil = missingThumbnailCache.get(thumbnailFileName)
  const now = Date.now()
  if (missingUntil !== undefined && missingUntil > now) {
    return false
  }
  const exists = fs.existsSync(path.resolve(uploadDir, thumbnailFileName))
  trimCache()
  if (exists) {
    existingThumbnailCache.add(thumbnailFileName)
    missingThumbnailCache.delete(thumbnailFileName)
  } else {
    missingThumbnailCache.set(thumbnailFileName, now + MISSING_CACHE_TTL_MS)
  }
  return exists
}

/**
 * 原图 URL → 缩略图 URL：只有缩略图文件真实存在才返回；
 * 任何不符合商品图格式的输入（含外链、私有反馈图片、带路径穿越的文件名）都返回 null。
 */
export const resolveProductThumbnailUrl = (
  originalUrl: string | null | undefined,
  uploadDir: string = PRODUCT_UPLOAD_DIR,
): string | null => {
  const normalizedUrl = originalUrl?.trim()
  if (!normalizedUrl) {
    return null
  }
  const fileName = PRODUCT_IMAGE_URL_MATCHER.exec(normalizedUrl)?.[1]
  if (!fileName) {
    return null
  }
  const thumbnailFileName = buildProductThumbnailFileName(fileName)
  if (!thumbnailFileName || !thumbnailFileExists(thumbnailFileName, uploadDir)) {
    return null
  }
  return `/uploads/products/${thumbnailFileName}`
}

export interface ProductThumbnailBackfillResult {
  scanned: number
  generated: number
  skippedExisting: number
  skippedInvalid: number
  failed: number
}

/** 扫描商品图目录，为缺失缩略图的原图补齐缩略图；幂等，单张失败不影响其他文件。 */
export const backfillProductThumbnails = async (options: {
  uploadDir?: string
  dryRun?: boolean
  concurrency?: number
  log?: (message: string) => void
} = {}): Promise<ProductThumbnailBackfillResult> => {
  const uploadDir = options.uploadDir ?? PRODUCT_UPLOAD_DIR
  const log = options.log ?? ((message: string) => console.log(message))
  const result: ProductThumbnailBackfillResult = { scanned: 0, generated: 0, skippedExisting: 0, skippedInvalid: 0, failed: 0 }
  if (!fs.existsSync(uploadDir)) {
    return result
  }

  const entries = await fs.promises.readdir(uploadDir, { withFileTypes: true })
  const pending: string[] = []
  for (const entry of entries) {
    if (!entry.isFile() || isProductThumbnailFileName(entry.name) || entry.name.endsWith('.tmp')) {
      continue
    }
    result.scanned += 1
    const thumbnailFileName = buildProductThumbnailFileName(entry.name)
    if (!thumbnailFileName) {
      result.skippedInvalid += 1
      continue
    }
    if (fs.existsSync(path.resolve(uploadDir, thumbnailFileName))) {
      result.skippedExisting += 1
      continue
    }
    pending.push(entry.name)
  }

  if (options.dryRun) {
    log(`[product-thumbnail] 预览模式：待生成 ${pending.length} 张，已存在 ${result.skippedExisting} 张，跳过非商品图 ${result.skippedInvalid} 个`)
    return result
  }

  const concurrency = Math.max(1, Math.min(4, Math.floor(options.concurrency ?? 1)))
  let cursor = 0
  const worker = async () => {
    while (cursor < pending.length) {
      const fileName = pending[cursor]
      cursor += 1
      try {
        await generateProductThumbnailForFile(path.resolve(uploadDir, fileName))
        result.generated += 1
      } catch (error) {
        result.failed += 1
        log(`[product-thumbnail] 缩略图生成失败：${fileName}（${error instanceof Error ? error.message : '未知错误'}）`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker))
  if (pending.length > 0) {
    log(`[product-thumbnail] 回填完成：扫描 ${result.scanned}，新生成 ${result.generated}，已存在 ${result.skippedExisting}，跳过非商品图 ${result.skippedInvalid}，失败 ${result.failed}`)
  }
  return result
}

let backfillScheduled = false

/**
 * 服务启动后延迟执行一次存量回填：并发 1、计时器 unref 不阻塞进程退出；
 * 多实例同时执行也安全（写入采用临时文件 + 原子改名，已存在即跳过）。
 */
export const scheduleProductThumbnailBackfill = (delayMs = 30_000) => {
  if (backfillScheduled || process.env.Y_LINK_PRODUCT_THUMBNAIL_BACKFILL === 'false') {
    return
  }
  backfillScheduled = true
  const timer = setTimeout(() => {
    void backfillProductThumbnails({ concurrency: 1 }).catch((error) => {
      console.warn('[product-thumbnail] 存量缩略图回填失败', error instanceof Error ? error.message : '未知错误')
    })
  }, delayMs)
  timer.unref?.()
}

/** 仅供验证脚本重置缓存，业务代码不要调用。 */
export const resetProductThumbnailCacheForTest = () => {
  existingThumbnailCache.clear()
  missingThumbnailCache.clear()
}
