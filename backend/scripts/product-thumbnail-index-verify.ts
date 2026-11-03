/** 商品目录索引行为回归：计数磁盘调用，所有文件只写本轮临时目录。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mock } from 'node:test'
import sharp from 'sharp'

process.env.REDIS_URL = ''
const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ylink-thumbnail-index-'))
const previousCwd = process.cwd()
process.chdir(root)
const thumbnail = await import('../src/utils/product-thumbnail.js')
const products = path.join(root, 'uploads', 'products')
await fs.promises.mkdir(products, { recursive: true })
const realReaddir = fs.promises.readdir
const realNow = Date.now
let now = realNow()
let scans = 0
let synchronousProbes = 0
let failNext = false
let releaseScan: (() => void) | undefined
let holdScan = false
mock.method(Date, 'now', () => now)
mock.method(fs.promises, 'readdir', async (...args: unknown[]) => {
  scans += 1
  if (holdScan) await new Promise<void>((resolve) => { releaseScan = resolve })
  if (failNext) { failNext = false; throw new Error('隔离扫描故障') }
  return Reflect.apply(realReaddir, fs.promises, args)
})
for (const name of ['existsSync', 'statSync', 'lstatSync', 'readdirSync', 'accessSync'] as const) {
  const original = fs[name]
  mock.method(fs, name, (...args: unknown[]) => {
    synchronousProbes += 1
    return Reflect.apply(original, fs, args)
  })
}
const url = (name: string) => `/uploads/products/${name}`
try {
  // 无需解码 6000 张图片：resolver 只负责安全映射与文件存在性，使用真实文件 fixture。
  for (let start = 0; start < 6000; start += 100) {
    await Promise.all(Array.from({ length: 100 }, async (_, offset) => {
      const name = `photo-${start + offset}`
      await fs.promises.writeFile(path.join(products, `${name}.jpg`), '')
      await fs.promises.writeFile(path.join(products, `${name}.thumb.webp`), '')
    }))
  }
  holdScan = true
  assert.equal(thumbnail.resolveProductThumbnailUrl(url('photo-0.jpg'), products), null, '冷索引只能回退原图')
  const cold = thumbnail.prepareProductThumbnailIndex(products)
  assert.equal(thumbnail.prepareProductThumbnailIndex(products), cold, '并发准备必须共用扫描任务')
  assert.equal(scans, 1)
  holdScan = false; releaseScan!(); await cold
  const hotProbeStart = synchronousProbes
  for (let round = 0; round < 2; round += 1) {
    for (let i = 0; i < 6000; i += 1) {
      assert.equal(thumbnail.resolveProductThumbnailUrl(url(`photo-${i}.jpg`), products), url(`photo-${i}.thumb.webp`))
    }
  }
  assert.equal(synchronousProbes - hotProbeStart, 0, '6000 图连续两轮不得同步探测磁盘')
  assert.equal(scans, 1, '超过 5000 项不得整表驱逐重扫')
  console.log('通过：6000 图连续两轮，12000 次解析，同步探测 0，目录扫描 1')

  await fs.promises.writeFile(path.join(products, 'photo-0.PNG'), '')
  now += 60_001
  holdScan = true
  assert.equal(thumbnail.resolveProductThumbnailUrl(url('photo-0.jpg'), products), null, '过期期间不能使用旧无冲突快照')
  const refreshed = thumbnail.prepareProductThumbnailIndex(products)
  assert.equal(thumbnail.resolveProductThumbnailUrl(url('photo-1.jpg'), products), null)
  holdScan = false; releaseScan!(); await refreshed
  assert.equal(thumbnail.resolveProductThumbnailUrl(url('photo-0.jpg'), products), null, '刷新必须识别新增扩展名冲突')
  assert.equal(thumbnail.resolveProductThumbnailUrl(url('photo-1.jpg'), products), url('photo-1.thumb.webp'))

  thumbnail.invalidateProductThumbnailIndex(products)
  failNext = true
  await thumbnail.prepareProductThumbnailIndex(products)
  assert.equal(thumbnail.resolveProductThumbnailUrl(url('photo-1.jpg'), products), null)
  const failedScans = scans
  await thumbnail.prepareProductThumbnailIndex(products)
  assert.equal(scans, failedScans, '失败退避期间不能每张图重试')
  now += 1_001
  await thumbnail.prepareProductThumbnailIndex(products)
  assert.equal(thumbnail.resolveProductThumbnailUrl(url('photo-1.jpg'), products), url('photo-1.thumb.webp'), '失败不得永久毒化正常目录')

  // 扫描已读完目录但尚未发布时，上传通知仍必须覆盖进结果。
  const captured = await realReaddir(products, { withFileTypes: true })
  let finishCaptured!: () => void
  mock.method(fs.promises, 'readdir', async () => {
    await new Promise<void>((resolve) => { finishCaptured = resolve })
    return captured
  })
  thumbnail.invalidateProductThumbnailIndex(products)
  const duringUpload = thumbnail.prepareProductThumbnailIndex(products)
  await thumbnail.notifyProductOriginalCreated('photo-1.PNG', products)
  finishCaptured(); await duringUpload
  assert.equal(thumbnail.resolveProductThumbnailUrl(url('photo-1.jpg'), products), null, '扫描中的增量原图不能丢失')
  thumbnail.invalidateProductThumbnailIndex(products)
  const invalidatedFlight = thumbnail.prepareProductThumbnailIndex(products)
  thumbnail.invalidateProductThumbnailIndex(products)
  finishCaptured(); await invalidatedFlight
  // 显式失效后旧扫描不能重新发布无冲突快照，下一次异步准备才可恢复。
  assert.equal(thumbnail.resolveProductThumbnailUrl(url('photo-2.jpg'), products), null)
  finishCaptured(); await thumbnail.prepareProductThumbnailIndex(products)

  // 本机文件系统未必允许同 stem 大小写并存；通过目录扫描替身验证 Linux 形态。
  const caseDir = path.join(root, 'case-sensitive')
  mock.method(fs.promises, 'readdir', async () => ['case.jpg', 'CASE.JpG', 'case.thumb.webp'].map((name) => ({ name })))
  await thumbnail.prepareProductThumbnailIndex(caseDir)
  assert.equal(thumbnail.resolveProductThumbnailUrl(url('case.jpg'), caseDir), null)
  mock.restoreAll()
  // 恢复计数与时钟，用后续真实生成验证增量更新没有目录扫描。
  mock.method(Date, 'now', () => now)
  mock.method(fs.promises, 'readdir', async (...args: unknown[]) => { scans += 1; return Reflect.apply(realReaddir, fs.promises, args) })

  const beforeIncremental = scans
  const buffer = await sharp({ create: { width: 24, height: 16, channels: 3, background: '#0f766e' } }).jpeg().toBuffer()
  for (let i = 0; i < 3; i += 1) {
    const name = `uploaded-${i}.jpg`
    await fs.promises.writeFile(path.join(products, name), buffer)
    await thumbnail.notifyProductOriginalCreated(name, products)
    assert.equal(await thumbnail.generateProductThumbnailForFile(path.join(products, name), buffer), `uploaded-${i}.thumb.webp`)
    assert.equal(thumbnail.resolveProductThumbnailUrl(url(name), products), url(`uploaded-${i}.thumb.webp`))
  }
  assert.equal(scans, beforeIncremental, '上传及生成回填不得逐图重扫目录')
  await fs.promises.writeFile(path.join(products, 'remote.jpg'), buffer)
  await thumbnail.applyProductThumbnailIndexUpdate({ original: 'remote.jpg' }, products)
  await thumbnail.applyProductThumbnailIndexUpdate(['remote.thumb.webp'], products)
  assert.equal(thumbnail.resolveProductThumbnailUrl(url('remote.jpg'), products), null, '有效远端名称不能替代本地缺失文件')
  assert.equal(scans, beforeIncremental, '远端文件缺失不能触发整目录扫描')
  assert.equal(thumbnail.resolveProductThumbnailUrl(url('remote.jpg'), products), null)
  await fs.promises.writeFile(path.join(products, 'remote.thumb.webp'), '')
  const visibleUpdate = thumbnail.applyProductThumbnailIndexUpdate(['remote.thumb.webp'], products)
  assert.equal(thumbnail.resolveProductThumbnailUrl(url('remote.jpg'), products), null, '异步本地验证完成前必须继续回退')
  await visibleUpdate
  assert.equal(thumbnail.resolveProductThumbnailUrl(url('remote.jpg'), products), url('remote.thumb.webp'))
  assert.equal(scans, beforeIncremental, 'Redis 回填广播只能增量合并，不重新扫描')
  await thumbnail.applyProductThumbnailIndexUpdate({ original: 'remote.PNG' }, products)
  assert.equal(thumbnail.resolveProductThumbnailUrl(url('remote.jpg'), products), null, '跨实例新增原图必须参与冲突判断')
  // 模拟旧版广播或非法载荷：安全失效，扫描后的文件事实恢复正常。
  await thumbnail.applyProductThumbnailIndexUpdate(['../escape.thumb.webp'], products)
  assert.equal(thumbnail.resolveProductThumbnailUrl(url('remote.jpg'), products), null, '非法消息立即安全失效')
  await thumbnail.prepareProductThumbnailIndex(products)
  assert.equal(thumbnail.resolveProductThumbnailUrl(url('remote.jpg'), products), url('remote.thumb.webp'))
  await fs.promises.writeFile(path.join(products, 'uploaded-0.png'), buffer)
  await thumbnail.notifyProductOriginalCreated('uploaded-0.png', products)
  assert.equal(thumbnail.resolveProductThumbnailUrl(url('uploaded-0.jpg'), products), null, '原图新增冲突立即失效')
  assert.equal(await thumbnail.generateProductThumbnailForFile(path.join(products, 'uploaded-0.jpg'), buffer), null)
  const beforeBackfill = scans
  const result = await thumbnail.backfillProductThumbnails({ uploadDir: products, dryRun: true, log: () => {} })
  assert.ok(result.skippedExisting >= 5999)
  assert.equal(scans - beforeBackfill, 1, '整轮回填只准备一次索引，不按图片重扫')

  const raceDir = path.join(root, 'remote-scan')
  await fs.promises.mkdir(raceDir)
  await fs.promises.writeFile(path.join(raceDir, 'race.jpg'), buffer)
  const sourceOnly = await realReaddir(raceDir, { withFileTypes: true })
  let finishScan!: () => void
  const scanMock = mock.method(fs.promises, 'readdir', async () => {
    await new Promise<void>((resolve) => { finishScan = resolve })
    return sourceOnly
  })
  const scanning = thumbnail.prepareProductThumbnailIndex(raceDir)
  await fs.promises.writeFile(path.join(raceDir, 'race.thumb.webp'), '')
  await thumbnail.applyProductThumbnailIndexUpdate(['race.thumb.webp'], raceDir)
  assert.equal(thumbnail.resolveProductThumbnailUrl(url('race.jpg'), raceDir), null)
  finishScan(); await scanning
  assert.equal(thumbnail.resolveProductThumbnailUrl(url('race.jpg'), raceDir), url('race.thumb.webp'), '扫描期间本地验证通过的增量不能丢失')

  const realStat = fs.promises.stat
  let finishStat!: () => void
  let statStarted!: () => void
  const enteredStat = new Promise<void>((resolve) => { statStarted = resolve })
  const statMock = mock.method(fs.promises, 'stat', async (...args: unknown[]) => {
    const localFile = await Reflect.apply(realStat, fs.promises, args)
    await new Promise<void>((resolve) => { finishStat = resolve; statStarted() })
    return localFile
  })
  const obsoleteUpdate = thumbnail.applyProductThumbnailIndexUpdate(['race.thumb.webp'], raceDir)
  await enteredStat
  thumbnail.invalidateProductThumbnailIndex(raceDir)
  const newGeneration = thumbnail.prepareProductThumbnailIndex(raceDir)
  finishStat(); await obsoleteUpdate
  finishScan(); await newGeneration
  assert.equal(thumbnail.resolveProductThumbnailUrl(url('race.jpg'), raceDir), null, '旧代次本地验证结果不得写入新扫描的 pending 或快照')
  statMock.mock.restore(); scanMock.mock.restore()
  thumbnail.invalidateProductThumbnailIndex(raceDir)
  await thumbnail.prepareProductThumbnailIndex(raceDir)
  assert.equal(thumbnail.resolveProductThumbnailUrl(url('race.jpg'), raceDir), url('race.thumb.webp'), '新的本地扫描事实仍可正常恢复')

  const other = path.join(root, 'other')
  await fs.promises.mkdir(other)
  await thumbnail.prepareProductThumbnailIndex(other)
  assert.equal(thumbnail.resolveProductThumbnailUrl(url('photo-1.jpg'), other), null, '目录必须隔离')
  console.log('通过：冷启动/single-flight/TTL刷新/新增冲突/失败退避恢复/大小写/上传增量/回填扫描次数/目录隔离/远端文件本地验证与代次竞态')
} finally {
  mock.restoreAll()
  process.chdir(previousCwd)
  thumbnail.resetProductThumbnailCacheForTest()
  await fs.promises.rm(root, { recursive: true, force: true })
}
