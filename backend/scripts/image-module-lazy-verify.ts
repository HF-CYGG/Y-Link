/**
 * 文件职责：以独立进程验证图像依赖的首次加载、失败重试和真实图像处理，不连接业务数据库。
 * 实现逻辑：仅测试进程安装 Node 解析钩子模拟一次加载失败；生产模块没有注入开关。
 * 维护说明：字体可见性、完整上传边界和缩略图矩阵继续复用已有专项，不以本脚本替代。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import type { Express } from 'express'

const redisOnly = process.argv[2] === '--owned-redis'
const selectedCase = process.argv[2]?.startsWith('--case=') ? process.argv[2].slice('--case='.length) : undefined
const mode = redisOnly || selectedCase ? undefined : process.argv[2]
const scriptPath = fileURLToPath(import.meta.url)
if (!mode) {
  const scenarios = selectedCase ? [selectedCase] : redisOnly ? ['backfill-persistent-sharp-redis'] : ['import-only', 'fail-sharp', 'fail-svg-captcha',
    'fail-upload-sharp', 'functional', 'backfill-persistent-sharp', 'backfill-transient-sharp', 'backfill-stop']
  for (const scenario of scenarios) {
    // 在真实包解析前只拒绝一次；之后交回 tsx / Node 原解析链，不替换包的工厂或字体。
    const target = scenario === 'fail-upload-sharp' || scenario.startsWith('backfill-') ? 'sharp' : scenario.startsWith('fail-') ? scenario.slice(5) : ''
    const persistent = scenario.startsWith('backfill-persistent-') || scenario === 'backfill-stop'
    const hook = `let rejected = false; export async function resolve(specifier, context, nextResolve) {
      if (specifier === ${JSON.stringify(target)} && (${persistent} || !rejected)) {
        rejected = true;
        await new Promise(resolve => setTimeout(resolve, ${scenario === 'backfill-stop' ? 100 : 30}));
        throw new Error('fixture-private-package-path-and-secret');
      }
      return nextResolve(specifier, context);
    }`
    const registration = `import { register } from 'node:module'; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hook)}`)}, import.meta.url)`
    // 在父测试进程生成真实 PNG；独立失败进程不能预先加载 sharp 来制作夹具。
    const fixture = scenario === 'fail-upload-sharp' || scenario.startsWith('backfill-')
      ? (await (await import('sharp')).default({ create: { width: 8, height: 4, channels: 3, background: '#0d9488' } }).png().toBuffer()).toString('base64')
      : ''
    const result = spawnSync(process.execPath, [
      '--import', 'tsx', '--import', `data:text/javascript,${encodeURIComponent(registration)}`,
      scriptPath, scenario, fixture,
    ], { stdio: 'inherit', windowsHide: true, timeout: 30_000 })
    if (result.error) throw result.error
    assert.equal(result.status, 0, `图像按需加载场景失败：${scenario}`)
  }
  console.log('[image-module-lazy] 独立导入、首次合并、失败重试和真实图像路径通过')
} else {
  assert.ok(['import-only', 'fail-sharp', 'fail-svg-captcha', 'fail-upload-sharp', 'functional',
    'backfill-persistent-sharp', 'backfill-transient-sharp', 'backfill-stop', 'backfill-persistent-sharp-redis'].includes(mode))
  let redisUrl = '', redisPrefix = ''
  if (mode === 'backfill-persistent-sharp-redis') {
    // 仅消费统一 QA 创建的独占实例；先核对真实 Docker owner/回环高位映射，再允许应用读取 URL。
    const owner = process.env.Y_LINK_IMAGE_LAZY_REDIS_OWNER ?? ''
    assert.match(owner, /^[a-f0-9]{16}$/)
    const name = `ylink-image-redis-${owner}`
    let url: URL
    try { url = new URL(process.env.Y_LINK_IMAGE_LAZY_REDIS_URL ?? '') }
    catch { throw new Error('缺少或无效的 owned Redis URL，拒绝连接') }
    assert.equal(url.protocol, 'redis:'); assert.equal(url.hostname, '127.0.0.1')
    assert.ok(Number(url.port) >= 10000 && Number(url.port) <= 65535)
    assert.ok(url.pathname === '' || url.pathname === '/' || url.pathname === '/0')
    assert.ok(!url.search && !url.hash, 'owned Redis URL 禁止 query/hash')
    const inspected = spawnSync('docker', ['inspect', name], { encoding: 'utf8', windowsHide: true })
    assert.equal(inspected.status, 0, '无法证明独占 Redis 所有权，拒绝连接')
    const info = JSON.parse(inspected.stdout)[0]
    assert.equal(info.Config.Labels['ylink.verify.owner'], owner)
    const bindings = info.NetworkSettings.Ports['6379/tcp']
    assert.equal(bindings.length, 1); assert.equal(bindings[0].HostIp, '127.0.0.1')
    assert.equal(Number(bindings[0].HostPort), Number(url.port))
    redisUrl = url.toString(); redisPrefix = `img-lazy:${owner}:`
  }
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'ylink-image-lazy-'))
  const previousCwd = process.cwd()
  const emptyEnv = path.join(runtime, 'empty.env')
  fs.writeFileSync(emptyEnv, '')
  Object.assign(process.env, {
    NODE_ENV: 'test', APP_PROFILE: 'image-module-lazy-verify', ENV_FILE: emptyEnv,
    Y_LINK_DATA_DIR: path.join(runtime, 'data'), Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE: 'true',
    Y_LINK_DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    REDIS_URL: redisUrl, REDIS_KEY_PREFIX: redisPrefix || 'image-lazy-verify:', Y_LINK_MULTI_INSTANCE: 'false',
  })
  process.chdir(runtime)
  const require = createRequire(import.meta.url)
  let closeResources: (() => Promise<void>) | undefined
  const failures: unknown[] = []
  try {
    const { CaptchaService } = await import('../src/services/captcha.service.js')
    const upload = await import('../src/utils/upload-storage.js')
    const thumbnail = await import('../src/utils/product-thumbnail.js')
    const { loadSharp, loadSvgCaptcha } = await import('../src/utils/image-module-loader.js')
    const { listConcurrencyGateSnapshots } = await import('../src/utils/bounded-concurrency.js')
    const redis = await import('../src/redis/redis-client.js')
    closeResources = async () => {
      try { await thumbnail.stopProductThumbnailBackfill() } finally { await redis.closeRedis() }
    }
    const imagePackageFiles = () => Object.keys(require.cache).filter(id =>
      /node_modules[\/\\](?:sharp|svg-captcha|opentype\.js|@img)[\/\\]/.test(id))
    assert.deepEqual(imagePackageFiles(), [], '仅导入共享模块不能执行图像包或字体依赖')

    let writes = 0
    const tickets = new Map<string, { code: string; expireAt: number }>()
    const store = {
      set(key: string, value: { code: string; expireAt: number }) { writes += 1; tickets.set(key, value) },
      get(key: string) { return tickets.get(key) },
      take(key: string) { const value = tickets.get(key); tickets.delete(key); return value },
      delete(key: string) { tickets.delete(key) },
      recordFailedAttempt() { return null },
    }
    const service = new CaptchaService({ createCode: () => 'AB234C', stores: { admin: store, client: store } })
    if (mode === 'import-only') {
      // 保持进程在没有任何生成调用的情况下退出，不能用先加载后清缓存伪造冷导入。
      assert.equal(writes, 0)
    } else if (mode.startsWith('backfill-')) {
      const png = Buffer.from(process.argv[3]!, 'base64')
      const productDir = path.join(runtime, 'uploads/products')
      fs.mkdirSync(productDir, { recursive: true })
      for (const name of ['backfill-a.png', 'backfill-b.png']) fs.writeFileSync(path.join(productDir, name), png)
      if (mode === 'backfill-stop') {
        thumbnail.scheduleProductThumbnailBackfill(0)
        const deadline = Date.now() + 5_000
        while (!listConcurrencyGateSnapshots().some(gate => gate.name === 'product-image-processing' && gate.active > 0)) {
          assert.ok(Date.now() < deadline, '必须在真实图像工作已开始后测试主动停止')
          await new Promise(resolve => setTimeout(resolve, 2))
        }
        await thumbnail.stopProductThumbnailBackfill()
        assert.deepEqual(fs.readdirSync(productDir).sort(), ['backfill-a.png', 'backfill-b.png'])
      } else {
        if (redisUrl) {
          await redis.connectRedis()
          const deadline = Date.now() + 5_000
          while (!redis.isRedisReady()) {
            assert.ok(Date.now() < deadline, 'owned Redis 未就绪，不能把无租约回填当通过')
            await new Promise(resolve => setTimeout(resolve, 10))
          }
        }
        const client = redis.getRedisClient(), leaseKey = redis.redisKey('lease', 'product-thumbnail-backfill')
        let heldAtFailure: Promise<string | null> | undefined
        const logs: string[] = []
        const first = await thumbnail.backfillProductThumbnails({ uploadDir: productDir, log: message => {
          logs.push(message)
          // GET 在真实释放命令前同连接排队，证明不是从未获得租约的空跑。
          if (client && message.includes('缩略图生成失败')) heldAtFailure = client.get(leaseKey)
        } })
        assert.deepEqual([first.scanned, first.generated, first.failed], [1, 0, 1], '依赖不可用必须结束整轮，不逐文件持续重试')
        assert.equal(logs.filter(message => message.includes('缩略图生成失败')).length, 1)
        assert.doesNotMatch(logs.join('\n'), /fixture|private-package|secret/)
        assert.deepEqual(fs.readdirSync(productDir).sort(), ['backfill-a.png', 'backfill-b.png'])
        assert.equal(thumbnail.resolveProductThumbnailUrl('/uploads/products/backfill-a.png', productDir), null)
        if (client) {
          assert.ok(await heldAtFailure, '失败时应持有真实 Redis 租约')
          assert.equal(await client.get(leaseKey), null, '失败收尾必须真实删除自己的租约')
          const { acquireThumbnailLease } = await import('../src/utils/product-thumbnail-lease.js')
          const next = await acquireThumbnailLease()
          assert.ok(next, '后续合法工作必须能接管租约')
          try { assert.equal(await next.valid(), true) } finally { await next.release() }
          assert.equal(await client.get(leaseKey), null)
        }
        if (mode === 'backfill-transient-sharp') {
          const retry = await thumbnail.backfillProductThumbnails({ uploadDir: productDir, log: () => {} })
          assert.deepEqual([retry.generated, retry.failed], [2, 0], '下一次合法回填应重新加载真实依赖并恢复')
          const sharp = await loadSharp()
          assert.equal((await sharp(fs.readFileSync(path.join(productDir, 'backfill-a.thumb.webp'))).metadata()).format, 'webp')
        }
      }
      assert.equal(listConcurrencyGateSnapshots().find(gate => gate.name === 'product-image-processing')?.active, 0)
    } else if (mode === 'fail-upload-sharp') {
      const png = Buffer.from(process.argv[3]!, 'base64')
      assert.equal(upload.detectImageContentFromBuffer(png)?.mimeType, 'image/png')
      const temp = path.join(runtime, 'uploads/.tmp')
      fs.mkdirSync(temp, { recursive: true })
      const makeFile = (name: string, buffer: Buffer) => {
        const filePath = path.join(temp, name); fs.writeFileSync(filePath, buffer)
        return { path: filePath, originalname: name, mimetype: 'image/png', size: buffer.length } as Express.Multer.File
      }
      const first = makeFile('first.png', png)
      await assert.rejects(upload.finalizeProductImageFile(first), (error: unknown) => {
        assert.ok(error instanceof Error && 'statusCode' in error)
        assert.equal(error.statusCode, 503, '合法图片遇到依赖加载失败应保留可重试服务错误')
        assert.doesNotMatch(error.message, /fixture|private|secret|已损坏/)
        return true
      })
      assert.equal(fs.existsSync(first.path), false, '依赖失败也必须清理临时文件')
      const retry = makeFile('retry.png', png)
      const result = await upload.finalizeProductImageFile(retry)
      assert.equal(fs.existsSync(retry.path), false)
      const sharp = await loadSharp()
      assert.equal((await sharp(fs.readFileSync(path.join(runtime, 'uploads/products', result.fileName))).metadata()).format, 'png')
      const corrupt = makeFile('corrupt.png', png.subarray(0, 24))
      await assert.rejects(upload.finalizeProductImageFile(corrupt), (error: unknown) => {
        assert.ok(error instanceof Error && 'statusCode' in error)
        assert.equal(error.statusCode, 400, '真实解码错误继续返回内容错误')
        assert.match(error.message, /已损坏/)
        return true
      })
      assert.equal(fs.existsSync(corrupt.path), false)
      assert.equal(listConcurrencyGateSnapshots().find(gate => gate.name === 'product-image-processing')?.active, 0)
    } else if (mode.startsWith('fail-')) {
      const failures = Promise.allSettled([service.createCaptcha('admin'), service.createCaptcha('admin')])
      if (mode === 'fail-sharp') {
        const deadline = Date.now() + 3000
        while (!listConcurrencyGateSnapshots().find(gate => gate.name === 'captcha-render')?.active) {
          assert.ok(Date.now() < deadline, '首次图像加载应在验证码渲染闸门内等待')
          await new Promise(resolve => setTimeout(resolve, 1))
        }
      }
      const failed = await failures
      assert.ok(failed.every(result => result.status === 'rejected'), '并发首次加载应共享同一次失败')
      for (const result of failed) {
        if (result.status !== 'rejected') continue
        assert.equal(result.reason.statusCode, 503)
        assert.doesNotMatch(result.reason.message, /fixture|private|secret|AB234C/)
      }
      assert.equal(writes, 0, '加载失败不能生成可用票据')
      assert.equal(tickets.size, 0)
      const retry = await service.createCaptcha('admin')
      assert.match(retry.captchaImage, /^data:image\/png;base64,/)
      await service.verifyCaptcha('admin', retry.captchaId, 'AB234C')
      await assert.rejects(service.verifyCaptcha('admin', retry.captchaId, 'AB234C'), /失效/)
      assert.equal(listConcurrencyGateSnapshots().find(gate => gate.name === 'captcha-render')?.active, 0)
    } else {
      const firstSharp = loadSharp()
      assert.equal(loadSharp(), firstSharp, '首次并发加载必须返回同一个 Promise')
      const sharp = await firstSharp
      assert.equal(await loadSharp(), sharp)
      assert.equal(sharp, (await import('sharp')).default, '不能替换真实图像工厂')
      const firstSvg = loadSvgCaptcha()
      assert.equal(loadSvgCaptcha(), firstSvg)
      assert.equal(await firstSvg, (await import('svg-captcha')).default, '必须使用原字体生成器')

      const captcha = await service.createCaptcha('admin')
      assert.doesNotMatch(JSON.stringify(captcha), /AB234C/)
      const png = Buffer.from(captcha.captchaImage.split(',')[1]!, 'base64')
      const metadata = await sharp(png).metadata()
      assert.equal(metadata.format, 'png'); assert.equal(metadata.width, 140); assert.equal(metadata.height, 40)
      await service.verifyCaptcha('admin', captcha.captchaId, 'ab234c')
      await assert.rejects(service.verifyCaptcha('admin', captcha.captchaId, 'AB234C'), /失效/)
      const beforeFailure = writes
      const failingRenderer = new CaptchaService({
        createCode: () => 'AB234C', stores: { admin: store, client: store },
        renderPng: async svg => { assert.match(svg, /<svg/); throw Error('fixture-render-failure') },
      })
      await assert.rejects(failingRenderer.createCaptcha('admin'), /fixture-render-failure/)
      assert.equal(writes, beforeFailure, '渲染失败不能写票据；原 renderer 注入仍接收 SVG 字符串')

      const temp = path.join(runtime, 'uploads/.tmp')
      fs.mkdirSync(temp, { recursive: true })
      const valid = await sharp({ create: { width: 80, height: 40, channels: 3, background: '#0d9488' } }).png().toBuffer()
      const makeUpload = (name: string, buffer: Buffer) => {
        const filePath = path.join(temp, name); fs.writeFileSync(filePath, buffer)
        return { path: filePath, originalname: name, mimetype: 'image/png', size: buffer.length } as Express.Multer.File
      }
      const original = makeUpload('valid.png', valid)
      const finalized = await upload.finalizeProductImageFile(original)
      assert.equal(fs.existsSync(original.path), false)
      const productDir = path.join(runtime, 'uploads/products')
      const originalPath = path.join(productDir, finalized.fileName)
      assert.equal((await sharp(fs.readFileSync(originalPath)).metadata()).format, 'png')
      const thumbnailName = thumbnail.buildProductThumbnailFileName(finalized.fileName)!
      assert.equal((await sharp(fs.readFileSync(path.join(productDir, thumbnailName))).metadata()).format, 'webp')
      await thumbnail.prepareProductThumbnailIndex(productDir)
      assert.equal(thumbnail.resolveProductThumbnailUrl('/uploads/products/missing.png', productDir), null)
      assert.ok(thumbnail.resolveProductThumbnailUrl(`/uploads/products/${finalized.fileName}`, productDir))
      for (const [name, buffer] of [
        ['corrupt.png', valid.subarray(0, 24)],
        ['oversized.png', await sharp({ create: { width: upload.IMAGE_UPLOAD_MAX_WIDTH + 1, height: 1, channels: 3, background: '#ffffff' } }).png().toBuffer()],
      ] as const) {
        const file = makeUpload(name, buffer)
        await assert.rejects(upload.finalizeProductImageFile(file))
        assert.equal(fs.existsSync(file.path), false, '非法或超尺寸图片必须清理临时文件')
      }
      const rejectedPublication = path.join(productDir, 'cancelled.thumb.webp')
      assert.equal(await thumbnail.generateProductThumbnail(valid, rejectedPublication, async () => false), false)
      assert.equal(fs.existsSync(rejectedPublication), false)
      assert.ok(fs.readdirSync(productDir).every(name => !name.endsWith('.tmp')))
      const beforeStop = fs.readdirSync(productDir).sort()
      thumbnail.scheduleProductThumbnailBackfill()
      await thumbnail.stopProductThumbnailBackfill()
      assert.deepEqual(fs.readdirSync(productDir).sort(), beforeStop, '关闭应取消延迟回填，不启动新图像任务')
      assert.equal(listConcurrencyGateSnapshots().find(gate => gate.name === 'product-image-processing')?.active, 0)
    }
    console.log(`[image-module-lazy] ${mode} 通过`)
  } catch (error) { failures.push(error) }
  finally {
    try { await closeResources?.() } catch (error) { failures.push(error) }
    try {
      process.chdir(previousCwd)
      fs.rmSync(runtime, { recursive: true, force: true })
    } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, `图像场景或所属资源清理失败：${mode}`)
}
