/**
 * 文件说明：商品缩略图专项验证脚本。
 * 文件职责：校验缩略图命名约定、生成尺寸、URL 解析的安全边界、上传链路自动生成以及存量回填的幂等性。
 * 实现逻辑：
 * 1. 在系统临时目录下创建隔离的商品图目录，不触碰真实 uploads；
 * 2. 生成大尺寸 JPEG 与动图 GIF，验证缩略图长边不超过 480、只缩不放、动图取首帧且输出 WebP；
 * 3. 验证 resolveProductThumbnailUrl 只解析站内商品图，拒绝外链、私有反馈目录、路径穿越与缺失文件；
 * 4. 验证回填只补缺失项，二次执行不再生成；
 * 5. 静态断言上传链路、商城目录与启动流程均已接入缩略图。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import {
  backfillProductThumbnails,
  buildProductThumbnailFileName,
  generateProductThumbnailForFile,
  PRODUCT_THUMBNAIL_MAX_EDGE,
  prepareProductThumbnailIndex,
  resetProductThumbnailCacheForTest,
  resolveProductThumbnailUrl,
} from '../src/utils/product-thumbnail.js'

const pass = (title: string) => console.log(`✅ ${title}`)
const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ylink-thumb-verify-'))
const uploadDir = path.join(tempRoot, 'products')
fs.mkdirSync(uploadDir, { recursive: true })

try {
  // 1. 命名约定
  assert.equal(buildProductThumbnailFileName('3f1c2b9a-1111-4222-8333-444455556666.jpg'), '3f1c2b9a-1111-4222-8333-444455556666.thumb.webp')
  assert.equal(buildProductThumbnailFileName('legacy_photo-01.PNG'), 'legacy_photo-01.thumb.webp')
  assert.equal(buildProductThumbnailFileName('../evil.jpg'), null)
  assert.equal(buildProductThumbnailFileName('a.b.jpg'), null)
  assert.equal(buildProductThumbnailFileName('photo.svg'), null)
  pass('缩略图命名约定只接受安全文件名与受支持图片扩展名')

  // 2. 生成尺寸与格式
  const largeJpeg = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: '#0d9488' } }).jpeg().toBuffer()
  const largePath = path.join(uploadDir, 'large-photo.jpg')
  fs.writeFileSync(largePath, largeJpeg)
  const largeThumbName = await generateProductThumbnailForFile(largePath)
  assert.equal(largeThumbName, 'large-photo.thumb.webp')
  const largeThumbMeta = await sharp(fs.readFileSync(path.join(uploadDir, largeThumbName!))).metadata()
  assert.equal(largeThumbMeta.format, 'webp')
  assert.equal(largeThumbMeta.width, PRODUCT_THUMBNAIL_MAX_EDGE)
  assert.equal(largeThumbMeta.height, PRODUCT_THUMBNAIL_MAX_EDGE / 2)

  const smallPng = await sharp({ create: { width: 120, height: 80, channels: 4, background: '#ffffff' } }).png().toBuffer()
  const smallPath = path.join(uploadDir, 'small-photo.png')
  fs.writeFileSync(smallPath, smallPng)
  await generateProductThumbnailForFile(smallPath)
  const smallThumbMeta = await sharp(fs.readFileSync(path.join(uploadDir, 'small-photo.thumb.webp'))).metadata()
  assert.equal(smallThumbMeta.width, 120, '小图不应被放大')

  const gifFrame = await sharp({ create: { width: 600, height: 600, channels: 3, background: '#f59e0b' } }).gif().toBuffer()
  const gifPath = path.join(uploadDir, 'animated.gif')
  fs.writeFileSync(gifPath, gifFrame)
  await generateProductThumbnailForFile(gifPath)
  const gifThumbMeta = await sharp(fs.readFileSync(path.join(uploadDir, 'animated.thumb.webp')), { animated: true }).metadata()
  assert.equal(gifThumbMeta.pages ?? 1, 1, '动图缩略图只取首帧')
  assert.ok(fs.readdirSync(uploadDir).every((name) => !name.endsWith('.tmp')), '生成过程不应残留临时文件')
  pass('缩略图长边不超过 480、只缩不放、动图取首帧并输出 WebP')

  // 3. URL 解析安全边界
  resetProductThumbnailCacheForTest()
  await prepareProductThumbnailIndex(uploadDir)
  assert.equal(resolveProductThumbnailUrl('/uploads/products/large-photo.jpg', uploadDir), '/uploads/products/large-photo.thumb.webp')
  assert.equal(resolveProductThumbnailUrl('/uploads/large-photo.jpg', uploadDir), '/uploads/products/large-photo.thumb.webp', '历史单层路径兼容')
  assert.equal(resolveProductThumbnailUrl('/uploads/products/missing.jpg', uploadDir), null, '缩略图缺失时返回 null 以便前端回退原图')
  assert.equal(resolveProductThumbnailUrl('/uploads/client-feedback/large-photo.jpg', uploadDir), null, '私有反馈图片不得解析缩略图')
  assert.equal(resolveProductThumbnailUrl('https://example.com/uploads/products/large-photo.jpg', uploadDir), null, '外链不得解析缩略图')
  assert.equal(resolveProductThumbnailUrl('/uploads/products/../products/large-photo.jpg', uploadDir), null, '路径穿越不得解析')
  assert.equal(resolveProductThumbnailUrl('/uploads/products/large-photo.thumb.webp', uploadDir), null, '缩略图自身不再二次映射')
  assert.equal(resolveProductThumbnailUrl(null, uploadDir), null)
  pass('缩略图 URL 解析只覆盖站内商品图并拒绝越权与穿越输入')

  // 4. 回填幂等
  fs.writeFileSync(path.join(uploadDir, 'backfill-a.jpg'), largeJpeg)
  fs.writeFileSync(path.join(uploadDir, 'backfill-b.png'), smallPng)
  fs.writeFileSync(path.join(uploadDir, 'broken.jpg'), Buffer.from('not-an-image'))
  fs.writeFileSync(path.join(uploadDir, 'notes.txt'), 'skip')
  const silent = () => undefined
  const dryRun = await backfillProductThumbnails({ uploadDir, dryRun: true, log: silent })
  assert.equal(dryRun.generated, 0)
  assert.equal(fs.existsSync(path.join(uploadDir, 'backfill-a.thumb.webp')), false, '预览模式不写入')
  const firstRun = await backfillProductThumbnails({ uploadDir, concurrency: 2, log: silent })
  assert.equal(firstRun.generated, 2)
  assert.equal(firstRun.failed, 1, '损坏图片只记录失败，不中断回填')
  assert.equal(firstRun.skippedInvalid, 1)
  assert.equal(firstRun.skippedExisting, 3)
  const secondRun = await backfillProductThumbnails({ uploadDir, log: silent })
  assert.equal(secondRun.generated, 0, '二次回填不重复生成')
  assert.equal(secondRun.skippedExisting, 5)
  pass('存量回填只补缺失项、单张失败不中断且可重复执行')

  // 5. 链路接入静态断言
  const read = (relativePath: string) => fs.readFileSync(path.resolve(backendRoot, relativePath), 'utf8')
  assert.match(read('src/utils/upload-storage.ts'), /if \(category === 'products'\) \{[\s\S]*?generateProductThumbnailForFile\(finalFilePath, reencodedBuffer\)/, '商品图上传同步生成缩略图')
  const o2oService = read('src/services/o2o-preorder.service.ts')
  assert.match(o2oService, /thumbnailSmall: resolveProductThumbnailUrl\(item\.thumbnail\)/, '商城商品输出缩略图')
  assert.match(o2oService, /thumbnailSmall: resolveProductThumbnailUrl\(sku\.thumbnail \?\? item\.thumbnail\)/, '商城规格输出缩略图')
  assert.match(read('src/runtime/business-runtime.ts'), /scheduleProductThumbnailBackfill\(\)/, '启动后自动回填存量缩略图')
  pass('上传、商城目录与启动回填均已接入缩略图')

  console.log('[product-thumbnail:verify] 商品缩略图专项验证通过')
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
