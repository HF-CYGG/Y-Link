/**
 * 文件说明：Task4 上传内容校验与静态资源安全策略专项验证脚本。
 * 文件职责：校验本次上传安全治理的关键回归点，覆盖真实图片内容识别、尺寸上限、服务端重编码、异常图片拦截、旧路径兼容映射、后端上传静态头配置以及 Nginx 前端静态托管策略。
 * 实现逻辑：
 * 1. 直接调用上传工具函数，验证 PNG/JPEG/GIF/WEBP 文件头可被识别，伪装文本内容会被拒绝；
 * 2. 验证“扩展名 + 浏览器声明类型”必须与真实图片内容一致，避免仅改后缀名绕过；
 * 3. 验证服务端会拒绝超尺寸图片、拦截截断损坏图片，并将有效图片重编码后再落盘；
 * 4. 验证旧单层 `/uploads/<file>` 路径仍会被归一化到分类目录，不破坏历史数据库记录访问；
 * 5. 通过静态源码断言，确认后端 `/uploads` 已补长期缓存与资源级安全头，Nginx 已补 gzip、缓存与 `/uploads` 代理。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { createApp } from '../src/app.js'
import {
  detectImageContentFromBuffer,
  finalizeUploadedImageFile,
  IMAGE_UPLOAD_MAX_HEIGHT,
  IMAGE_UPLOAD_MAX_WIDTH,
  isDetectedImageCompatibleWithMetadata,
  normalizeLegacyUploadUrl,
} from '../src/utils/upload-storage.js'

function pass(title: string) {
  console.log(`✅ ${title}`)
}

const currentFilePath = fileURLToPath(import.meta.url)
const backendRoot = path.resolve(path.dirname(currentFilePath), '..')
const workspaceRoot = path.resolve(backendRoot, '..')
const uploadsRootDir = path.resolve(backendRoot, 'uploads')
const uploadTempDir = path.resolve(uploadsRootDir, '.tmp')
const productUploadDir = path.resolve(uploadsRootDir, 'products')

const appFilePath = path.resolve(backendRoot, 'src/app.ts')
const nginxDefaultFilePath = path.resolve(workspaceRoot, 'docker/nginx/default.conf')
const nginxTemplateFilePath = path.resolve(workspaceRoot, 'docker/nginx/default.conf.template')
const nginxOneboxFilePath = path.resolve(workspaceRoot, 'docker/nginx/onebox.conf')

function readSource(filePath: string) {
  return fs.readFileSync(filePath, 'utf8')
}

async function cleanupFileIfExists(filePath: string) {
  if (!fs.existsSync(filePath)) {
    return
  }
  await fs.promises.unlink(filePath)
}

async function createSolidImageBuffer(options: {
  width: number
  height: number
  format: 'jpeg' | 'png'
  withOrientationMetadata?: boolean
}) {
  const baseImage = sharp({
    create: {
      width: options.width,
      height: options.height,
      channels: 3,
      background: {
        r: 64,
        g: 128,
        b: 192,
      },
    },
  })

  const normalizedImage = options.withOrientationMetadata ? baseImage.withMetadata({ orientation: 6 }) : baseImage
  if (options.format === 'jpeg') {
    return normalizedImage.jpeg({ quality: 92 }).toBuffer()
  }
  return normalizedImage.png().toBuffer()
}

/**
 * 通过转正流程动态验证：
 * - 真 JPEG 会被重编码后写入正式业务目录；
 * - 截断损坏的 PNG 即使文件头正确，也会因无法正常解码被拒绝；
 * - 超尺寸图片会被拒绝，且所有失败场景都会清理临时文件。
 */
async function verifyFinalizeUploadFlow() {
  await fs.promises.mkdir(uploadTempDir, { recursive: true })
  await fs.promises.mkdir(productUploadDir, { recursive: true })

  const validTempFilePath = path.resolve(uploadTempDir, `task4-valid-${Date.now()}.jpg`)
  const invalidTempFilePath = path.resolve(uploadTempDir, `task4-invalid-${Date.now()}.png`)
  const oversizeTempFilePath = path.resolve(uploadTempDir, `task4-oversize-${Date.now()}.png`)

  const validJpegBuffer = await createSolidImageBuffer({
    width: 80,
    height: 40,
    format: 'jpeg',
    withOrientationMetadata: true,
  })
  const validPngBuffer = await createSolidImageBuffer({
    width: 48,
    height: 48,
    format: 'png',
  })
  const oversizePngBuffer = await createSolidImageBuffer({
    width: IMAGE_UPLOAD_MAX_WIDTH + 1,
    height: 16,
    format: 'png',
  })

  await fs.promises.writeFile(validTempFilePath, validJpegBuffer)
  await fs.promises.writeFile(invalidTempFilePath, validPngBuffer.subarray(0, 24))
  await fs.promises.writeFile(oversizeTempFilePath, oversizePngBuffer)

  let finalizedFilePath: string | null = null
  try {
    const finalizedFile = await finalizeUploadedImageFile('products', {
      path: validTempFilePath,
      originalname: 'demo.jpg',
      mimetype: 'image/jpeg',
      size: validJpegBuffer.byteLength,
    } as any)
    finalizedFilePath = path.resolve(productUploadDir, finalizedFile.fileName)
    const finalizedBuffer = await fs.promises.readFile(finalizedFilePath)
    const finalizedMetadata = await sharp(finalizedBuffer).metadata()

    assert.equal(finalizedFile.mimeType, 'image/jpeg')
    assert.match(finalizedFile.fileName, /\.jpg$/)
    assert.equal(fs.existsSync(finalizedFilePath), true)
    assert.equal(fs.existsSync(validTempFilePath), false)
    assert.notDeepEqual(finalizedBuffer, validJpegBuffer)
    assert.equal(finalizedMetadata.orientation, undefined)
    assert.equal(finalizedMetadata.width, 40)
    assert.equal(finalizedMetadata.height, 80)

    await assert.rejects(
      () =>
        finalizeUploadedImageFile('products', {
          path: invalidTempFilePath,
          originalname: 'fake.png',
          mimetype: 'image/png',
          size: 24,
        } as any),
      /已损坏或内容异常/,
    )
    assert.equal(fs.existsSync(invalidTempFilePath), false)

    await assert.rejects(
      () =>
        finalizeUploadedImageFile('products', {
          path: oversizeTempFilePath,
          originalname: 'oversize.png',
          mimetype: 'image/png',
          size: oversizePngBuffer.byteLength,
        } as any),
      new RegExp(`宽高不能超过 ${IMAGE_UPLOAD_MAX_WIDTH}x${IMAGE_UPLOAD_MAX_HEIGHT} 像素`),
    )
    assert.equal(fs.existsSync(oversizeTempFilePath), false)
    pass('上传文件会先校验尺寸与异常内容，再重编码转正；损坏图与超尺寸图都会被拒绝并清理临时文件')
  } finally {
    if (finalizedFilePath) {
      await cleanupFileIfExists(finalizedFilePath)
    }
    await cleanupFileIfExists(validTempFilePath)
    await cleanupFileIfExists(invalidTempFilePath)
    await cleanupFileIfExists(oversizeTempFilePath)
  }
}

/**
 * 直接喂入最小可识别图片头，验证真实内容识别不会退化成“只看扩展名”。
 */
function verifyImageSignatureDetection() {
  const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xdb])
  const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const gifBuffer = Buffer.from('GIF89a', 'ascii')
  const webpBuffer = Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x2a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  ])
  const fakeTextBuffer = Buffer.from('<script>alert(1)</script>', 'utf8')

  assert.equal(detectImageContentFromBuffer(jpegBuffer)?.mimeType, 'image/jpeg')
  assert.equal(detectImageContentFromBuffer(pngBuffer)?.mimeType, 'image/png')
  assert.equal(detectImageContentFromBuffer(gifBuffer)?.mimeType, 'image/gif')
  assert.equal(detectImageContentFromBuffer(webpBuffer)?.mimeType, 'image/webp')
  assert.equal(detectImageContentFromBuffer(fakeTextBuffer), null)
  pass('真实图片内容识别可正确区分 JPEG/PNG/GIF/WEBP，并拒绝伪装文本内容')
}

/**
 * 真实内容识别通过后，仍要继续校验扩展名和浏览器声明类型，避免 PNG 内容伪装成 JPG 或反之。
 */
function verifyImageMetadataConsistencyGuard() {
  const detectedPng = detectImageContentFromBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  assert.ok(detectedPng)
  assert.equal(isDetectedImageCompatibleWithMetadata(detectedPng, '.png', 'image/png'), true)
  assert.equal(isDetectedImageCompatibleWithMetadata(detectedPng, '.jpg', 'image/png'), false)
  assert.equal(isDetectedImageCompatibleWithMetadata(detectedPng, '.png', 'image/jpeg'), false)
  pass('上传文件必须同时满足真实内容、扩展名和声明类型一致')
}

/**
 * 旧数据库中仍可能保留单层 `/uploads/<file>`，这里验证统一归一化逻辑未被破坏。
 */
function verifyLegacyUploadUrlCompatibility() {
  assert.equal(normalizeLegacyUploadUrl('products', '/uploads/demo.png'), '/uploads/products/demo.png')
  assert.equal(
    normalizeLegacyUploadUrl('client-feedback', '/uploads/demo.png'),
    '/uploads/client-feedback/demo.png',
  )
  assert.equal(normalizeLegacyUploadUrl('products', '/uploads/products/demo.png'), '/uploads/products/demo.png')
  assert.equal(normalizeLegacyUploadUrl('products', ' https://example.com/demo.png '), 'https://example.com/demo.png')
  pass('旧单层上传路径仍会被归一化到分类目录，已升级路径和外链不会被误改写')
}

/**
 * 直接启动临时应用，验证旧路径内部改写和上传静态响应头确实在运行时生效。
 */
async function verifyBackendUploadStaticRuntime() {
  await fs.promises.mkdir(productUploadDir, { recursive: true })
  const legacyCompatibleFileName = `task4-legacy-${Date.now()}.png`
  const categorizedFilePath = path.resolve(productUploadDir, legacyCompatibleFileName)

  await fs.promises.writeFile(
    categorizedFilePath,
    await createSolidImageBuffer({
      width: 12,
      height: 12,
      format: 'png',
    }),
  )

  const app = createApp()
  const server = http.createServer(app)

  try {
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const port = (server.address() as AddressInfo).port

    const response = await fetch(`http://127.0.0.1:${port}/uploads/${legacyCompatibleFileName}`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-site')
    assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/)
    pass('后端上传静态服务可在运行时兼容旧路径，并返回长期缓存与基础安全头')
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
    await cleanupFileIfExists(categorizedFilePath)
  }
}

/**
 * 通过静态断言验证三套 Nginx 配置都已统一补齐：
 * - gzip 压缩；
 * - hash 静态资源长期缓存；
 * - `/uploads` 代理仍然存在，避免图片被前端静态目录误吞。
 */
function verifyNginxStaticAssetPolicySources() {
  const nginxSources = [
    { name: 'default.conf', source: readSource(nginxDefaultFilePath) },
    { name: 'default.conf.template', source: readSource(nginxTemplateFilePath) },
    { name: 'onebox.conf', source: readSource(nginxOneboxFilePath) },
  ]

  nginxSources.forEach(({ name, source }) => {
    assert.match(source, /gzip on;/, `${name} 未开启 gzip`)
    assert.match(source, /Cache-Control "public, max-age=31536000, immutable"/, `${name} 未设置静态长期缓存`)
    assert.match(source, /location \^~ \/uploads\//, `${name} 缺少 uploads 代理位置`)
    assert.match(source, /Content-Security-Policy/, `${name} 未补充基础安全头`)
  })
  pass('三套 Nginx 配置已统一补齐 gzip、长期缓存、基础安全头与 uploads 代理')
}

async function main() {
  verifyImageSignatureDetection()
  verifyImageMetadataConsistencyGuard()
  await verifyFinalizeUploadFlow()
  verifyLegacyUploadUrlCompatibility()
  await verifyBackendUploadStaticRuntime()
  verifyNginxStaticAssetPolicySources()
}

try {
  await main()
  console.log('\nTask4 上传安全与静态资源策略验证全部通过。')
} catch (error) {
  console.error('\nTask4 上传安全与静态资源策略验证失败：', error)
  process.exit(1)
}
