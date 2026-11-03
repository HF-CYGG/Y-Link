/**
 * 文件说明：商品缩略图工具，负责按命名约定生成、定位和对外解析商品图的小尺寸 WebP 版本。
 * 实现逻辑：
 * - 命名约定：原图 `uploads/products/<name>.<ext>` 对应缩略图 `uploads/products/<name>.thumb.webp`，不改表结构、不改数据库里保存的原图 URL；
 * - 生成规则：长边不超过 480px、只缩不放、取动图首帧，统一输出 WebP，供商城卡片、购物车等小尺寸场景使用；
 * - 对外解析：商城目录构建时把原图 URL 映射为缩略图 URL，仅当缩略图文件真实存在才返回，缺失时返回 null，前端回退原图；
 * - 存在性判断带有界内存缓存：已存在的结果长期缓存（缩略图不会被删除），不存在的结果短期缓存，回填后约一分钟内生效；
 * - 存量回填：服务启动后延迟在后台以并发 1、共享资源闸门及集群租约补齐缺失缩略图（幂等，可用 Y_LINK_PRODUCT_THUMBNAIL_BACKFILL=false 关闭），
 *   生产镜像只包含编译产物，因此回填核心放在 src 内，命令行脚本 scripts/product-thumbnail-backfill.ts 仅做本地入口。
 * 维护重点：
 * - 只接受 `/uploads/products/` 与历史单层 `/uploads/<file>` 两种格式，文件名只允许字母数字、下划线与连字符，防止路径穿越；
 * - 反馈私有图片（client-feedback）绝不生成或解析缩略图；
 * - 缩略图生成失败不得影响原图上传结果，调用方只记录日志。
 */

import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { BizError } from './errors.js'
import { randomUUID } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'
import { productImageProcessingGate } from './product-image-gate.js'
import { acquireThumbnailLease } from './product-thumbnail-lease.js'
import { publishRedisBus, subscribeRedisBus } from '../redis/redis-bus.js'

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
export const generateProductThumbnail = async (imageBuffer: Buffer, targetFilePath: string, canPublish: () => Promise<boolean> = async () => true): Promise<boolean> => {
  const thumbnailBuffer = await sharp(imageBuffer, { animated: false, failOn: 'error', limitInputPixels: 4096 * 4096 })
    .rotate().resize({ width: PRODUCT_THUMBNAIL_MAX_EDGE, height: PRODUCT_THUMBNAIL_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: PRODUCT_THUMBNAIL_QUALITY, effort: 4 }).toBuffer()
  const temporaryPath = `${targetFilePath}.${randomUUID()}.tmp`
  try {
    await fs.promises.writeFile(temporaryPath, thumbnailBuffer, { flag: 'wx' })
    if (!await canPublish()) return false
    // 同目录硬链接是完整文件的原子、禁止覆盖发布；rename 会覆盖另一实例已完成的目标。
    try { await fs.promises.link(temporaryPath, targetFilePath) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error }
    rememberThumbnailExists(path.basename(targetFilePath), path.dirname(targetFilePath))
    return true
  } finally { await fs.promises.unlink(temporaryPath).catch(() => undefined) }
}

const sourceExtensions = ['jpg', 'jpeg', 'png', 'webp', 'gif'].flatMap((ext) =>
  [...ext].reduce<string[]>((forms, char) => forms.flatMap((prefix) => [prefix + char, prefix + char.toUpperCase()]), ['']))
/** 历史同 stem 不同扩展名会映射同一个目标，必须回退原图，不能任选一张。 */
const collisionCache = new Map<string, { source: string; collision: boolean; expiresAt: number }>()
const hasOriginalCollision = (filePath: string, refresh = false) => {
  const stem = filePath.slice(0, -path.extname(filePath).length)
  const cached = collisionCache.get(stem)
  if (!refresh && cached && cached.expiresAt > Date.now() && (cached.collision || cached.source === filePath)) return cached.collision
  const collision = sourceExtensions.some((ext) => {
    const candidate = `${stem}.${ext}`
    return candidate !== filePath && fs.existsSync(candidate)
      && (process.platform !== 'win32' || candidate.toLowerCase() !== filePath.toLowerCase())
  })
  if (collisionCache.size >= EXISTENCE_CACHE_LIMIT) collisionCache.clear()
  collisionCache.set(stem, { source: filePath, collision, expiresAt: Date.now() + MISSING_CACHE_TTL_MS })
  return collision
}
export const generateProductThumbnailForFile = async (originalFilePath: string, imageBuffer?: Buffer, canPublish?: () => Promise<boolean>): Promise<string | null> => {
  const thumbnailFileName = buildProductThumbnailFileName(path.basename(originalFilePath))
  if (!thumbnailFileName || hasOriginalCollision(originalFilePath, true)) return null
  const handle = imageBuffer ? null : await fs.promises.open(originalFilePath, 'r')
  try {
    // 与上传相同的 10MB 上限，在分配原图 buffer 前检查；读入时再限定长度，防止文件增长绕过。
    if (handle && (await handle.stat()).size > 10 * 1024 * 1024) throw new Error('原图超过 10MB，已跳过')
    let sourceBuffer = imageBuffer
    if (!sourceBuffer && handle) {
      const buffer = Buffer.alloc(10 * 1024 * 1024 + 1)
      let size = 0
      while (size < buffer.length) {
        const result = await handle.read(buffer, size, buffer.length - size, null)
        if (!result.bytesRead) break
        size += result.bytesRead
      }
      if (size > 10 * 1024 * 1024) throw new Error('原图超过 10MB，已跳过')
      sourceBuffer = buffer.subarray(0, size)
    }
    if (!sourceBuffer) return null
    const published = await generateProductThumbnail(sourceBuffer, path.resolve(path.dirname(originalFilePath), thumbnailFileName), canPublish)
    return published ? thumbnailFileName : null
  } finally { await handle?.close() }
}

const trimCache = () => {
  if (existingThumbnailCache.size > EXISTENCE_CACHE_LIMIT) {
    existingThumbnailCache.clear()
  }
  if (missingThumbnailCache.size > EXISTENCE_CACHE_LIMIT) {
    missingThumbnailCache.clear()
  }
}

export const rememberThumbnailExists = (fileName: string, uploadDir = PRODUCT_UPLOAD_DIR) => {
  const thumbnailFileName = path.resolve(uploadDir, fileName)
  trimCache()
  existingThumbnailCache.add(thumbnailFileName)
  missingThumbnailCache.delete(thumbnailFileName)
}

const thumbnailFileExists = (fileName: string, uploadDir: string) => {
  const thumbnailFileName = path.resolve(uploadDir, fileName)
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
  if (!thumbnailFileName || hasOriginalCollision(path.resolve(uploadDir, fileName)) || !thumbnailFileExists(thumbnailFileName, uploadDir)) {
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

const INVALIDATION_TOPIC = 'cache:product-thumbnails'
let invalidateCatalog: (() => unknown) | undefined
export const configureProductThumbnailInvalidation = (callback: () => unknown) => { invalidateCatalog = callback }
subscribeRedisBus(INVALIDATION_TOPIC, () => { missingThumbnailCache.clear() })

/** 流式扫描，最多一个后台工作；与上传共享闸门，失败后可幂等重试。 */
export const backfillProductThumbnails = async (options: {
  uploadDir?: string; dryRun?: boolean; concurrency?: number; signal?: AbortSignal; log?: (message: string) => void
} = {}): Promise<ProductThumbnailBackfillResult> => {
  const uploadDir = options.uploadDir ?? PRODUCT_UPLOAD_DIR
  const log = options.log ?? console.log
  const result: ProductThumbnailBackfillResult = { scanned: 0, generated: 0, skippedExisting: 0, skippedInvalid: 0, failed: 0 }
  if (!fs.existsSync(uploadDir)) return result
  let lease = options.dryRun ? { valid: async () => !options.signal?.aborted, release: async () => {} } : await acquireThumbnailLease(options.signal)
  const waitForLease = async () => {
    while (!options.signal?.aborted) {
      if (lease && await lease.valid()) return true
      await lease?.release(); lease = null
      try { await pause(5_000, undefined, { signal: options.signal }) } catch { return false }
      lease = await acquireThumbnailLease(options.signal)
    }
    return false
  }
  if (!lease && !await waitForLease()) return result
  let published: string[] = [], flushAt = Date.now()
  let flushChain = Promise.resolve()
  const flush = () => {
    const names = published.splice(0, 50)
    if (!names.length) return flushChain
    flushAt = Date.now()
    for (const name of names) rememberThumbnailExists(name, uploadDir)
    flushChain = flushChain.then(async () => {
      // 同一连接先广播负缓存失效，再推进目录代次，避免新代次仍读到旧缺失结果。
      await publishRedisBus(INVALIDATION_TOPIC, names).catch(() => undefined)
      invalidateCatalog?.()
    })
    return flushChain
  }
  const flushTimer = setInterval(() => { void flush() }, 5_000); flushTimer.unref()
  try {
    const directory = await fs.promises.opendir(uploadDir)
    for await (const entry of directory) {
      if (!await waitForLease()) break
      if (!entry.isFile() || isProductThumbnailFileName(entry.name) || entry.name.endsWith('.tmp')) continue
      result.scanned += 1
      const name = buildProductThumbnailFileName(entry.name)
      const filePath = path.resolve(uploadDir, entry.name)
      if (!name || hasOriginalCollision(filePath, true)) { result.skippedInvalid += 1; continue }
      if (fs.existsSync(path.resolve(uploadDir, name))) { result.skippedExisting += 1; continue }
      if (options.dryRun) continue
      try {
        // 外层独占一次资源租约；generate 内部不能再次申请，否则并发 1 时会死锁。
        let generated: string | null = null
        do {
          if (!await waitForLease()) break
          const currentLease = lease!
          try {
            generated = await productImageProcessingGate.run(async () => {
              if (!await currentLease.valid()) return null
              return generateProductThumbnailForFile(filePath, undefined, currentLease.valid)
            })
          } catch (error) {
            if (!(error instanceof BizError) || error.statusCode !== 503) throw error
            try { await pause(1_000, undefined, { signal: options.signal }) } catch { break }
            continue
          }
          if (generated || await currentLease.valid()) break
        } while (!options.signal?.aborted)
        if (generated) { result.generated += 1; published.push(generated) }
        if (published.length >= 50 || Date.now() - flushAt >= 5_000) await flush()
      } catch (error) {
        result.failed += 1
        log(`[product-thumbnail] 缩略图生成失败：${entry.name}（${error instanceof Error ? error.message : '未知错误'}）`)
      }
      // 每张完成后让出资源，不连续占用 libuv 队列；取消时立即退出。
      try { await pause(25, undefined, { signal: options.signal }) } catch { break }
    }
  } finally {
    clearInterval(flushTimer)
    try { await flush(); await flushChain } finally { await lease?.release() }
  }
  log(`[product-thumbnail] 回填完成：扫描 ${result.scanned}，新生成 ${result.generated}，已存在 ${result.skippedExisting}，跳过 ${result.skippedInvalid}，失败 ${result.failed}`)
  return result
}

let backfillController: AbortController | null = null
let backfillTask: Promise<void> | null = null
/** 启动延迟 30 秒；集群租约繁忙或 Redis 降级时暂停，停机先取消再等待当前完整文件收尾。 */
export const scheduleProductThumbnailBackfill = (delayMs = 30_000) => {
  if (backfillTask || process.env.Y_LINK_PRODUCT_THUMBNAIL_BACKFILL === 'false') return
  const controller = new AbortController(); backfillController = controller
  backfillTask = (async () => {
    try {
      await pause(delayMs, undefined, { signal: controller.signal, ref: false })
      await backfillProductThumbnails({ concurrency: 1, signal: controller.signal })
    } catch (error) {
      if (!controller.signal.aborted) console.warn('[product-thumbnail] 回填失败', error instanceof Error ? error.message : '未知错误')
    }
  })()
}
export const stopProductThumbnailBackfill = async () => {
  backfillController?.abort(); await backfillTask
  backfillController = null; backfillTask = null
}
/** 仅供隔离验证使用。 */
export const resetProductThumbnailCacheForTest = () => { existingThumbnailCache.clear(); missingThumbnailCache.clear(); collisionCache.clear() }
