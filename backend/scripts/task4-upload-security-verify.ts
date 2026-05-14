/**
 * 文件说明：Task4 上传内容校验与静态资源安全策略专项验证脚本。
 * 文件职责：校验本次上传安全治理的关键回归点，覆盖真实图片内容识别、旧路径兼容映射、后端上传静态头配置以及 Nginx 前端静态托管策略。
 * 实现逻辑：
 * 1. 直接调用上传工具函数，验证 PNG/JPEG/GIF/WEBP 文件头可被识别，伪装文本内容会被拒绝；
 * 2. 验证“扩展名 + 浏览器声明类型”必须与真实图片内容一致，避免仅改后缀名绕过；
 * 3. 验证旧单层 `/uploads/<file>` 路径仍会被归一化到分类目录，不破坏历史数据库记录访问；
 * 4. 通过静态源码断言，确认后端 `/uploads` 已补长期缓存与资源级安全头，Nginx 已补 gzip、缓存与 `/uploads` 代理。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/app.js'
import {
  detectImageContentFromBuffer,
  finalizeUploadedImageFile,
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

/**
 * 通过转正流程动态验证：
 * - 真 PNG 会被转移到正式业务目录；
 * - 伪装成 PNG 的文本内容会被拒绝，且临时文件会被清理。
 */
async function verifyFinalizeUploadFlow() {
  await fs.promises.mkdir(uploadTempDir, { recursive: true })
  await fs.promises.mkdir(productUploadDir, { recursive: true })

  const validTempFilePath = path.resolve(uploadTempDir, `task4-valid-${Date.now()}.png`)
  const invalidTempFilePath = path.resolve(uploadTempDir, `task4-invalid-${Date.now()}.png`)

  // 这里使用最小 PNG 头即可触发真实内容识别；验证目标是“识别与转存流程”而非图像解码能力。
  await fs.promises.writeFile(
    validTempFilePath,
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]),
  )
  await fs.promises.writeFile(invalidTempFilePath, Buffer.from('not-a-real-png', 'utf8'))

  let finalizedFilePath: string | null = null
  try {
    const finalizedFile = await finalizeUploadedImageFile('products', {
      path: validTempFilePath,
      originalname: 'demo.png',
      mimetype: 'image/png',
      size: 10,
    } as any)
    finalizedFilePath = path.resolve(productUploadDir, finalizedFile.fileName)

    assert.equal(finalizedFile.mimeType, 'image/png')
    assert.match(finalizedFile.fileName, /\.png$/)
    assert.equal(fs.existsSync(finalizedFilePath), true)
    assert.equal(fs.existsSync(validTempFilePath), false)

    await assert.rejects(
      () =>
        finalizeUploadedImageFile('products', {
          path: invalidTempFilePath,
          originalname: 'fake.png',
          mimetype: 'image/png',
          size: 14,
        } as any),
      /不是受支持的真实图片内容/,
    )
    assert.equal(fs.existsSync(invalidTempFilePath), false)
    pass('上传文件会先校验真实内容后再转正，伪装文件会被拒绝并清理临时文件')
  } finally {
    if (finalizedFilePath) {
      await cleanupFileIfExists(finalizedFilePath)
    }
    await cleanupFileIfExists(validTempFilePath)
    await cleanupFileIfExists(invalidTempFilePath)
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

  // 运行时只依赖静态文件存在即可，不需要完整图片像素数据；最小 PNG 头足以让静态响应返回正确 MIME。
  await fs.promises.writeFile(
    categorizedFilePath,
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]),
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
