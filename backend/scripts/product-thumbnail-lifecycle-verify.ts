/** 缩略图生命周期行为回归：所有文件均为隔离临时目录，绝不读取业务上传目录。 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ylink-thumbnail-lifecycle-'))
const previousCwd = process.cwd()
process.chdir(directory)
process.env.YLINK_PRODUCT_IMAGE_CONCURRENCY = '1'
process.env.REDIS_URL = ''
const thumbnail = await import('../src/utils/product-thumbnail.js')
const { productImageProcessingGate } = await import('../src/utils/product-image-gate.js')
const products = path.join(directory, 'uploads', 'products')
await fs.mkdir(products, { recursive: true })
try {
  const buffer = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#0f766e' } }).jpeg().toBuffer()
  const target = path.join(products, 'same.thumb.webp')
  const races = await Promise.all(Array.from({ length: 8 }, () => thumbnail.generateProductThumbnail(buffer, target)))
  assert.equal(races.filter(Boolean).length, 1, '竞争发布只能成功一次')
  const original = await fs.readFile(target)
  assert.equal((await sharp(original).metadata()).width, 480)
  assert.equal(await thumbnail.generateProductThumbnail(buffer, target), false)
  assert.deepEqual(await fs.readFile(target), original, '已有目标不能覆盖')
  const cancelled = path.join(products, 'cancelled.thumb.webp')
  assert.equal(await thumbnail.generateProductThumbnail(buffer, cancelled, async () => false), false)
  assert.equal(await fs.stat(cancelled).then(() => true, () => false), false)
  assert.ok((await fs.readdir(products)).every((name) => !name.endsWith('.tmp')))
  const oversized = path.join(products, 'oversized.jpg')
  const handle = await fs.open(oversized, 'w'); await handle.truncate(10 * 1024 * 1024 + 1); await handle.close()
  await assert.rejects(thumbnail.generateProductThumbnailForFile(oversized), /10MB/)
  const source = path.join(products, 'visible.jpg'); await fs.writeFile(source, buffer)
  assert.equal(thumbnail.resolveProductThumbnailUrl('/uploads/products/visible.jpg', products), null)
  await thumbnail.generateProductThumbnailForFile(source)
  assert.equal(thumbnail.resolveProductThumbnailUrl('/uploads/products/visible.jpg', products), '/uploads/products/visible.thumb.webp')
  const other = path.join(directory, 'other'); await fs.mkdir(other)
  assert.equal(thumbnail.resolveProductThumbnailUrl('/uploads/products/visible.jpg', other), null, '存在缓存必须按目录隔离')
  await fs.writeFile(path.join(products, 'collision.jpg'), buffer); await fs.writeFile(path.join(products, 'collision.png'), buffer)
  assert.equal(await thumbnail.generateProductThumbnailForFile(path.join(products, 'collision.jpg')), null)
  assert.equal(thumbnail.resolveProductThumbnailUrl('/uploads/products/collision.png', products), null)
  await fs.writeFile(path.join(products, 'queued.jpg'), buffer)
  let release!: () => void
  const held = productImageProcessingGate.run(() => new Promise<void>((resolve) => { release = resolve }))
  while (!release) await new Promise((resolve) => setImmediate(resolve))
  const controller = new AbortController()
  const job = thumbnail.backfillProductThumbnails({ uploadDir: products, signal: controller.signal, log: () => {} })
  controller.abort(); release(); await held; await job
  assert.equal(await fs.stat(path.join(products, 'queued.thumb.webp')).then(() => true, () => false), false)
  thumbnail.scheduleProductThumbnailBackfill(30_000)
  await thumbnail.stopProductThumbnailBackfill()
  console.log('通过：原子竞争/禁止覆盖/取消清理/读前上限/缓存隔离与可见性/历史重名/共享闸门/停机取消')
} finally {
  await thumbnail.stopProductThumbnailBackfill()
  process.chdir(previousCwd)
  await fs.rm(directory, { recursive: true, force: true })
}
