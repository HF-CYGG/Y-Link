/**
 * 文件说明：backend/scripts/order-query-baseline-verify.ts
 * 文件职责：建立客户端订单查询的性能基线、定义目标阈值并输出可复现验证报告。
 * 维护说明：若调整客户端订单查询触发策略、后端列表查询逻辑或任务验收指标，请同步更新本脚本。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { AppDataSource } from '../src/config/data-source.js'
import { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime } from '../src/config/database-bootstrap.js'
import { BaseProduct } from '../src/entities/base-product.entity.js'
import { O2oPreorder } from '../src/entities/o2o-preorder.entity.js'
import { authService } from '../src/services/auth.service.js'
import { clientAuthService } from '../src/services/client-auth.service.js'
import { o2oPreorderService } from '../src/services/o2o-preorder.service.js'
import { productService } from '../src/services/product.service.js'
import { systemConfigService } from '../src/services/system-config.service.js'
import type { ClientAuthContext } from '../src/types/client-auth.js'

interface OrderListRow {
  id: string
  showNo: string
  verifyCode: string
  status: 'pending' | 'verified' | 'cancelled'
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const backendRoot = path.resolve(__dirname, '..')
const projectRoot = path.resolve(backendRoot, '..')
const runtimeRoot = path.join(projectRoot, '.local-dev')
const frontendOrderViewPath = path.join(projectRoot, 'src', 'views', 'client', 'ClientOrdersView.vue')

/**
 * 目标阈值定义：
 * - 首屏查询以服务层 listMyOrders P95 表征；
 * - 筛选切换以“本地过滤函数单次执行 P95”表征；
 * - 连续输入请求次数以“10 次输入触发远端请求数”表征。
 */
const TARGET_THRESHOLDS = {
  firstScreenQueryP95MsMax: 400,
  statusSwitchFilterP95MsMax: 12,
  continuousInputRemoteRequestsPer10KeystrokesMax: 2,
} as const

const log = (message: string) => {
  // eslint-disable-next-line no-console
  console.log(`[order-baseline] ${message}`)
}

const ensureReady = async () => {
  prepareDatabaseRuntime()
  if (!AppDataSource.isInitialized) {
    await AppDataSource.initialize()
  }
  await initializeDatabaseSchemaIfNeeded(AppDataSource)
  await authService.ensureDefaultAdmin()
  await systemConfigService.ensureDefaultConfigs()
}

const readCaptchaCode = (captchaSvg: string) => captchaSvg.replaceAll(/<[^>]*>/g, '').replaceAll(/\s+/g, '').slice(0, 6)

const registerAndLoginClient = async (seed: number): Promise<ClientAuthContext> => {
  const registerCaptcha = await clientAuthService.createCaptcha()
  const account = `1${String(seed).slice(-10)}`
  const username = `order_perf_${String(seed).slice(-6)}`
  const password = `Perf@${String(seed).slice(-6)}`

  const registerResult = await clientAuthService.register({
    account,
    username,
    password,
    captchaId: registerCaptcha.captchaId,
    captchaCode: readCaptchaCode(registerCaptcha.captchaSvg),
  })

  const loginCaptcha = await clientAuthService.createCaptcha()
  const loginResult = await clientAuthService.login({
    account: registerResult.mobile,
    password,
    captchaId: loginCaptcha.captchaId,
    captchaCode: readCaptchaCode(loginCaptcha.captchaSvg),
  })
  return clientAuthService.resolveClientByToken(loginResult.token)
}

const percentile = (values: number[], p: number) => {
  if (!values.length) {
    return 0
  }
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return Number(sorted[rank].toFixed(2))
}

const average = (values: number[]) => {
  if (!values.length) {
    return 0
  }
  const sum = values.reduce((acc, value) => acc + value, 0)
  return Number((sum / values.length).toFixed(2))
}

const filterOrdersByClientViewLogic = (orders: OrderListRow[], status: 'all' | OrderListRow['status'], keyword: string) => {
  const normalizedKeyword = keyword.trim().toLowerCase()
  return orders.filter((order) => {
    if (status !== 'all' && order.status !== status) {
      return false
    }
    if (!normalizedKeyword) {
      return true
    }
    const searchText = `${order.showNo} ${order.verifyCode}`.toLowerCase()
    return searchText.includes(normalizedKeyword)
  })
}

/**
 * 通过读取 ClientOrdersView 实现，提取当前触发路径基线：
 * - 是否在 onMounted 发起远端请求；
 * - 是否在“刷新按钮”发起远端请求；
 * - 是否存在关键词 watch / 筛选 watch 导致远端请求。
 */
const collectClientTriggerPathBaseline = () => {
  const source = fs.readFileSync(frontendOrderViewPath, 'utf8')
  const hasMountedRequest = /onMounted\([\s\S]*?loadOrders\(/.test(source)
  const hasRefreshButtonRequest = /@click="loadOrders\(true\)"/.test(source)
  const hasKeywordWatcherRequest = /watch\(\s*\(?\s*keyword/.test(source)
  const hasStatusWatcherRequest = /watch\(\s*\(?\s*activeStatus/.test(source)
  const hasSearchInputRemoteRequest = /@input="[^"]*loadOrders/.test(source)
  // 只在 handleStatusChange 函数体内查找 loadOrders，避免跨函数误判。
  const hasStatusChangeRemoteRequest = /const\s+handleStatusChange\s*=\s*\([^)]*\)\s*=>\s*\{[^}]*loadOrders\(/s.test(source)

  return {
    hasMountedRequest,
    hasRefreshButtonRequest,
    hasKeywordWatcherRequest,
    hasStatusWatcherRequest,
    hasSearchInputRemoteRequest,
    hasStatusChangeRemoteRequest,
    summary: {
      mounted: hasMountedRequest ? '首屏进入触发远端请求' : '首屏进入未发现远端请求',
      refresh: hasRefreshButtonRequest ? '点击刷新触发远端请求' : '点击刷新未发现远端请求',
      keyword: hasKeywordWatcherRequest || hasSearchInputRemoteRequest ? '关键词变化会触发远端请求' : '关键词变化仅本地过滤',
      status: hasStatusWatcherRequest || hasStatusChangeRemoteRequest ? '状态切换会触发远端请求' : '状态切换仅本地过滤',
    },
  }
}

const seedOrdersForBaseline = async (clientAuth: ClientAuthContext) => {
  const product = await productService.create({
    productName: `订单查询性能样本商品-${Date.now()}`,
    pinyinAbbr: 'DDCX',
    defaultPrice: 12.8,
    isActive: true,
    o2oStatus: 'listed',
    currentStock: 500,
    limitPerUser: 20,
  })

  // 生成 60 条订单样本，覆盖 pending/verified/cancelled 三种状态。
  for (let index = 0; index < 60; index += 1) {
    await o2oPreorderService.submit(clientAuth, {
      items: [{ productId: product.id, qty: 1 }],
      remark: `订单查询性能样本-${index + 1}`,
    })
  }

  const preorderRepo = AppDataSource.getRepository(O2oPreorder)
  const rows = await preorderRepo.find({
    where: { clientUserId: clientAuth.userId },
    order: { id: 'DESC' },
    take: 60,
  })

  const verifiedRows = rows.slice(20, 40).map((item) => item.id)
  const cancelledRows = rows.slice(40, 60).map((item) => item.id)
  if (verifiedRows.length > 0) {
    await preorderRepo
      .createQueryBuilder()
      .update(O2oPreorder)
      .set({ status: 'verified', verifiedAt: new Date(), verifiedBy: 'baseline-script' })
      .where('id IN (:...ids)', { ids: verifiedRows })
      .execute()
  }
  if (cancelledRows.length > 0) {
    await preorderRepo
      .createQueryBuilder()
      .update(O2oPreorder)
      .set({ status: 'cancelled', cancelReason: 'manual' })
      .where('id IN (:...ids)', { ids: cancelledRows })
      .execute()
  }

  // 为避免样本创建过程中的 preOrderedStock 累积影响其它验证，重置到合理值。
  const productRepo = AppDataSource.getRepository(BaseProduct)
  const currentProduct = await productRepo.findOneByOrFail({ id: product.id })
  currentProduct.preOrderedStock = 20
  await productRepo.save(currentProduct)

  return product.id
}

const measureFirstScreenQueryBaseline = async (clientAuth: ClientAuthContext) => {
  // 先热身，降低首次执行初始化抖动对基线的污染。
  for (let index = 0; index < 3; index += 1) {
    await o2oPreorderService.listMyOrders(clientAuth)
  }

  const samples: number[] = []
  for (let index = 0; index < 20; index += 1) {
    const startedAt = performance.now()
    await o2oPreorderService.listMyOrders(clientAuth)
    const durationMs = performance.now() - startedAt
    samples.push(Number(durationMs.toFixed(2)))
  }

  return {
    sampleCount: samples.length,
    avgMs: average(samples),
    p95Ms: percentile(samples, 95),
    minMs: Number(Math.min(...samples).toFixed(2)),
    maxMs: Number(Math.max(...samples).toFixed(2)),
    rawSamplesMs: samples,
  }
}

const measureStatusSwitchFilterBaseline = (orders: OrderListRow[]) => {
  const switchSamples: number[] = []
  const scenarios: Array<{ status: 'all' | OrderListRow['status']; keyword: string }> = [
    { status: 'all', keyword: '' },
    { status: 'pending', keyword: '' },
    { status: 'verified', keyword: '' },
    { status: 'cancelled', keyword: '' },
    { status: 'all', keyword: 'PO' },
    { status: 'all', keyword: 'baseline' },
  ]

  // 使用 300 次切换模拟“快速切换标签+检索词变化”。
  for (let index = 0; index < 300; index += 1) {
    const scenario = scenarios[index % scenarios.length]
    const startedAt = performance.now()
    filterOrdersByClientViewLogic(orders, scenario.status, scenario.keyword)
    const durationMs = performance.now() - startedAt
    switchSamples.push(Number(durationMs.toFixed(4)))
  }

  return {
    sampleCount: switchSamples.length,
    avgMs: average(switchSamples),
    p95Ms: percentile(switchSamples, 95),
    minMs: Number(Math.min(...switchSamples).toFixed(4)),
    maxMs: Number(Math.max(...switchSamples).toFixed(4)),
  }
}

const measureContinuousInputRequestCountBaseline = (triggerPathBaseline: ReturnType<typeof collectClientTriggerPathBaseline>) => {
  /**
   * 连续输入请求次数口径：
   * - 以“输入 10 次字符”作为固定场景；
   * - 当前实现若未发现关键词 watch / input 触发 loadOrders，则记为 0。
   */
  const remoteRequestPerInput =
    triggerPathBaseline.hasKeywordWatcherRequest || triggerPathBaseline.hasSearchInputRemoteRequest ? 1 : 0
  const remoteRequestCountFor10Keystrokes = remoteRequestPerInput * 10

  return {
    keystrokes: 10,
    remoteRequestCount: remoteRequestCountFor10Keystrokes,
    inferredBy: remoteRequestPerInput === 0 ? '关键词变化仅本地过滤（静态分析）' : '关键词变化存在远端请求触发（静态分析）',
  }
}

const main = async () => {
  await ensureReady()
  const clientAuth = await registerAndLoginClient(Date.now())
  await seedOrdersForBaseline(clientAuth)
  const triggerPathBaseline = collectClientTriggerPathBaseline()

  const firstScreenQuery = await measureFirstScreenQueryBaseline(clientAuth)
  const listRows = await o2oPreorderService.listMyOrders(clientAuth, { page: 1, pageSize: 50 })
  const statusSwitch = measureStatusSwitchFilterBaseline(
    listRows.list.map((item) => ({
      id: item.id,
      showNo: item.showNo,
      verifyCode: item.verifyCode,
      status: item.status,
    })),
  )
  const continuousInputRequests = measureContinuousInputRequestCountBaseline(triggerPathBaseline)

  const validation = {
    firstScreenQueryPass: firstScreenQuery.p95Ms <= TARGET_THRESHOLDS.firstScreenQueryP95MsMax,
    statusSwitchPass: statusSwitch.p95Ms <= TARGET_THRESHOLDS.statusSwitchFilterP95MsMax,
    continuousInputPass:
      continuousInputRequests.remoteRequestCount <= TARGET_THRESHOLDS.continuousInputRemoteRequestsPer10KeystrokesMax,
  }

  const report = {
    runId: `order-query-baseline-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`,
    generatedAt: new Date().toISOString(),
    taskScope: 'Task 1: 建立订单查询性能基线',
    triggerPathBaseline,
    baselineMetrics: {
      firstScreenQuery,
      statusSwitch,
      continuousInputRequests,
    },
    targetThresholds: TARGET_THRESHOLDS,
    validation,
    validationPassed: Object.values(validation).every(Boolean),
  }

  fs.mkdirSync(runtimeRoot, { recursive: true })
  const reportPath = path.join(runtimeRoot, `${report.runId}.report.json`)
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  log('订单查询基线测量完成')
  log(`报告路径：${reportPath}`)
  log(`首屏查询 P95：${report.baselineMetrics.firstScreenQuery.p95Ms} ms，阈值：${TARGET_THRESHOLDS.firstScreenQueryP95MsMax} ms`)
  log(`筛选切换 P95：${report.baselineMetrics.statusSwitch.p95Ms} ms，阈值：${TARGET_THRESHOLDS.statusSwitchFilterP95MsMax} ms`)
  log(
    `连续输入请求次数：${report.baselineMetrics.continuousInputRequests.remoteRequestCount} / 10，阈值：${TARGET_THRESHOLDS.continuousInputRemoteRequestsPer10KeystrokesMax} / 10`,
  )
}

try {
  await main()
} catch (error) {
  // eslint-disable-next-line no-console
  console.error('\n[order-baseline] 订单查询基线测量失败')
  // eslint-disable-next-line no-console
  console.error(error)
  process.exit(1)
} finally {
  if (AppDataSource.isInitialized) {
    await AppDataSource.destroy()
  }
}
