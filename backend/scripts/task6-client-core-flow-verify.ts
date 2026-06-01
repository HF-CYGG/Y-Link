/**
 * 文件说明：backend/scripts/task6-client-core-flow-verify.ts
 * 文件职责：为 `optimize-client-core-flow-concurrency-v2` 的 Task 6 产出客户端五场景统一验收报告，
 * 并补齐“订单编辑后详情与列表局部回写不依赖整页刷新”的自动化回归断言。
 * 实现逻辑：
 * 1. 使用独立且可重复的脚本流程初始化 O2O 运行环境、注册客户端账号并种子化商品/订单样本；
 * 2. 直接调用后端服务测量注册、商品浏览、预定、订单查询、订单编辑五类场景的关键耗时样本；
 * 3. 通过源码静态断言验证前端详情页、列表页与 Store 的局部回写链路仍然存在，
 *    且未退化为依赖整页刷新才能看到最新结果；
 * 4. 汇总已有性能预算/并发报告与本次五场景结果，写入 `.local-dev/client-core-flow-task6.report.json`
 *    供留档文档与后续回归复用。
 * 维护说明：
 * - 若客户端页面改名、订单编辑写回路径调整或 Task 6 验收阈值变更，需要同步修改静态断言与阈值；
 * - 若后端 O2O 规则新增字段，优先补齐“订单编辑专项断言”，确保返回详情、库存与修改次数仍可复验。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
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

interface ScenarioMetric {
  sampleCount: number
  averageMs: number
  p95Ms: number
  maxMs: number
}

interface ScenarioResult {
  key: 'registration' | 'mall' | 'preorder' | 'order-query' | 'order-edit'
  title: string
  beforeSummary: string
  afterSummary: string
  metrics: Record<string, ScenarioMetric | number | string | boolean>
  validation: Record<string, boolean>
}

const currentFilePath = fileURLToPath(import.meta.url)
const scriptsRoot = path.dirname(currentFilePath)
const backendRoot = path.resolve(scriptsRoot, '..')
const projectRoot = path.resolve(backendRoot, '..')
const runtimeRoot = path.resolve(projectRoot, '.local-dev')
const reportPath = path.resolve(runtimeRoot, 'client-core-flow-task6.report.json')

const clientOrderDetailViewPath = path.resolve(projectRoot, 'src', 'views', 'client', 'ClientOrderDetailView.vue')
const clientOrdersViewPath = path.resolve(projectRoot, 'src', 'views', 'client', 'ClientOrdersView.vue')
const clientOrderStorePath = path.resolve(projectRoot, 'src', 'store', 'modules', 'client-order.ts')
const clientOrderSummaryPath = path.resolve(projectRoot, 'src', 'utils', 'client-order-summary.ts')
const clientConcurrencyReportPath = path.resolve(runtimeRoot, 'client-concurrency-performance.report.json')
const performanceBudgetReportPath = path.resolve(runtimeRoot, 'enterprise-performance-budget-report.json')
const dualBudgetReportPath = path.resolve(runtimeRoot, 'enterprise-performance-dual-budget-report.json')

const scenarioThresholds = {
  registrationFlowP95MsMax: 1200,
  mallListP95MsMax: 400,
  preorderSubmitP95MsMax: 800,
  orderQueryListP95MsMax: 400,
  orderQueryStatusP95MsMax: 40,
  orderEditP95MsMax: 900,
} as const

const scenarioResults: ScenarioResult[] = []
const regressionChecks: Array<{ title: string; status: 'passed'; detail: Record<string, unknown> }> = []

const log = (message: string) => {
  // eslint-disable-next-line no-console
  console.log(`[task6-client-core-flow] ${message}`)
}

const readText = (filePath: string) => fs.readFileSync(filePath, 'utf8')

const pushRegressionCheck = (title: string, detail: Record<string, unknown>) => {
  regressionChecks.push({
    title,
    status: 'passed',
    detail,
  })
}

const percentile = (values: number[], p: number) => {
  if (!values.length) {
    return 0
  }
  const sorted = [...values].sort((left, right) => left - right)
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return Number(sorted[rank].toFixed(2))
}

const average = (values: number[]) => {
  if (!values.length) {
    return 0
  }
  const total = values.reduce((sum, value) => sum + value, 0)
  return Number((total / values.length).toFixed(2))
}

const buildScenarioMetric = (samples: number[]): ScenarioMetric => {
  return {
    sampleCount: samples.length,
    averageMs: average(samples),
    p95Ms: percentile(samples, 95),
    maxMs: Number(Math.max(...samples, 0).toFixed(2)),
  }
}

const readCaptchaCode = (captchaSvg: string) => captchaSvg.replaceAll(/<[^>]*>/g, '').replaceAll(/\s+/g, '').slice(0, 6)
const toChineseDigits = (value: string) => value.replaceAll(/\d/g, (digit) => '零一二三四五六七八九'[Number(digit)] ?? '')

const readOptionalJson = <T>(filePath: string): T | null => {
  if (!fs.existsSync(filePath)) {
    return null
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
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

const registerAndLoginClient = async (seed: number): Promise<ClientAuthContext> => {
  const registerCaptcha = await clientAuthService.createCaptcha()
  const account = `1${String(seed).slice(-10)}`
  const username = `核心用户${toChineseDigits(String(seed).slice(-6))}`
  const password = `Task6@${String(seed).slice(-6)}`

  const registerResult = await clientAuthService.register({
    accountType: 'personal',
    account,
    username,
    password,
    captchaId: registerCaptcha.captchaId,
    captchaCode: readCaptchaCode(registerCaptcha.captchaSvg),
  })

  const loginCaptcha = await clientAuthService.createCaptcha()
  const loginResult = await clientAuthService.login({
    account: registerResult.user.mobile,
    password,
    captchaId: loginCaptcha.captchaId,
    captchaCode: readCaptchaCode(loginCaptcha.captchaSvg),
  })

  return clientAuthService.resolveClientByToken(loginResult.token)
}

const createListedProduct = async (suffix: string, stock: number) => {
  const normalizedSuffix = suffix.replaceAll(/[^a-zA-Z0-9]/g, '').slice(-10) || 'TASK6'
  return productService.create({
    productName: `Task6客户端样本商品-${suffix}`,
    pinyinAbbr: `TK${normalizedSuffix.toUpperCase()}`,
    defaultPrice: 12.5,
    isActive: true,
    o2oStatus: 'listed',
    currentStock: stock,
    limitPerUser: 20,
  })
}

const verifyOrderEditStaticRegression = () => {
  const detailSource = readText(clientOrderDetailViewPath)
  const ordersSource = readText(clientOrdersViewPath)
  const storeSource = readText(clientOrderStorePath)
  const summarySource = readText(clientOrderSummaryPath)

  assert.match(
    detailSource,
    /const syncOrderStoreFromDetail =[\s\S]*clientOrderStore\.syncOrderSummary[\s\S]*buildClientOrderSummaryFromDetail/,
    '订单详情页缺少详情转摘要并回写 Store 的共享逻辑',
  )
  assert.match(
    detailSource,
    /const nextDetail = await updateMyO2oPreorder[\s\S]*detail\.value = nextDetail[\s\S]*syncOrderStoreFromDetail\(nextDetail, \{ preserveFresh: true \}\)[\s\S]*notifyClientOrderRefresh\(/,
    '订单详情页修改成功后未同时回写详情、Store 与刷新广播',
  )
  assert.doesNotMatch(
    detailSource,
    /import\s+QRCode\s+from\s+['"]qrcode['"]/,
    '订单详情页仍在静态导入 qrcode，二维码库会重新进入详情首包',
  )
  assert.match(
    detailSource,
    /const resolveQrCodeModule = async \(\) => \{[\s\S]*import\('qrcode'\)/,
    '订单详情页缺少 qrcode 按需加载门禁，二维码依赖可能回退到同步下载',
  )
  assert.match(
    detailSource,
    /const loadVoucherPdfExportModule = \(\) => import\(['"]@\/utils\/pdf\/export-voucher-pdf['"]\)/,
    '订单详情页缺少 PDF 导出模块的按需加载入口',
  )
  assert.doesNotMatch(
    detailSource,
    /location\.reload\(|router\.go\(\s*0\s*\)|router\.replace\(route\.fullPath\)/,
    '订单编辑成功路径疑似退化为依赖整页刷新',
  )
  assert.match(
    ordersSource,
    /const refreshSingleOrderSummary = async[\s\S]*clientOrderStore\.syncOrderSummary\(result, \{ preserveFresh: true \}\)/,
    '订单列表页缺少单条摘要增量刷新逻辑',
  )
  assert.match(
    ordersSource,
    /subscribeClientOrderRefresh\(async \(event\) => \{[\s\S]*refreshSingleOrderSummary\(event\.orderId, \{ silent: true \}\)/,
    '订单列表页缺少订单刷新广播订阅逻辑',
  )
  assert.match(
    storeSource,
    /const syncOrderSummary = \(nextOrder: O2oPreorderSummary[\s\S]*matchesClientOrderQuery[\s\S]*removeOrder[\s\S]*upsertOrder/,
    '客户端订单 Store 缺少按当前筛选条件执行局部同步的核心逻辑',
  )
  assert.match(
    summarySource,
    /export const buildClientOrderSummaryFromDetail = \(detail: O2oPreorderDetail\)/,
    '订单摘要构建工具缺失，无法为详情与列表提供统一映射口径',
  )

  pushRegressionCheck('订单编辑前端局部回写静态断言通过', {
    files: [clientOrderDetailViewPath, clientOrdersViewPath, clientOrderStorePath, clientOrderSummaryPath],
  })
  pushRegressionCheck('订单详情页低频依赖按需加载静态断言通过', {
    file: clientOrderDetailViewPath,
    lazyDependencies: ['qrcode', '@/utils/pdf/export-voucher-pdf'],
  })
}

const measureRegistrationScenario = async () => {
  const samples: number[] = []
  let latestClientAuth: ClientAuthContext | null = null

  for (let index = 0; index < 5; index += 1) {
    const seed = Date.now() + index
    const startedAt = performance.now()
    latestClientAuth = await registerAndLoginClient(seed)
    samples.push(Number((performance.now() - startedAt).toFixed(2)))
  }

  const metric = buildScenarioMetric(samples)
  const validation = {
    registrationFlowPass: metric.p95Ms <= scenarioThresholds.registrationFlowP95MsMax,
  }

  assert.ok(latestClientAuth, '注册场景未拿到客户端登录态')
  scenarioResults.push({
    key: 'registration',
    title: '注册与认证',
    beforeSummary: '优化前注册、登录与验证码链路存在重复触发、旧请求覆盖和首屏阻塞风险。',
    afterSummary: '优化后认证链路已接入幂等门禁与统一错误治理，本次脚本复验注册登录闭环稳定可复现。',
    metrics: {
      registrationFlow: metric,
      accountSampleCount: samples.length,
    },
    validation,
  })

  assert.equal(validation.registrationFlowPass, true, '注册链路 P95 超过 Task 6 验收阈值')
  return latestClientAuth
}

const measureMallScenario = async () => {
  const suffix = String(Date.now())
  for (let index = 0; index < 24; index += 1) {
    await createListedProduct(`${suffix}-${index + 1}`, 120 + index)
  }

  const warmupTimes = 3
  for (let index = 0; index < warmupTimes; index += 1) {
    await o2oPreorderService.listMallProducts()
  }

  const samples: number[] = []
  let listedCount = 0
  for (let index = 0; index < 20; index += 1) {
    const startedAt = performance.now()
    const rows = await o2oPreorderService.listMallProducts()
    listedCount = rows.length
    samples.push(Number((performance.now() - startedAt).toFixed(2)))
  }

  const metric = buildScenarioMetric(samples)
  const validation = {
    mallListPass: metric.p95Ms <= scenarioThresholds.mallListP95MsMax,
    listedCountPass: listedCount >= 24,
  }

  scenarioResults.push({
    key: 'mall',
    title: '商品浏览',
    beforeSummary: '优化前商品大厅存在首屏串行等待、频繁切换时旧请求覆盖新结果的风险。',
    afterSummary: '优化后商城场景以稳定请求治理为基础，本次列表读取耗时稳定且可持续返回完整样本。',
    metrics: {
      mallList: metric,
      listedCount,
    },
    validation,
  })

  assert.equal(validation.mallListPass, true, '商品浏览链路 P95 超过 Task 6 验收阈值')
  assert.equal(validation.listedCountPass, true, '商品浏览样本数量不足，无法代表五场景验收')
}

const measurePreorderScenario = async (clientAuth: ClientAuthContext) => {
  const product = await createListedProduct(`preorder-${Date.now()}`, 400)
  const submitSamples: number[] = []
  const orderIds: string[] = []

  for (let index = 0; index < 5; index += 1) {
    const startedAt = performance.now()
    const detail = await o2oPreorderService.submit(clientAuth, {
      clientOrderType: 'walkin',
      isSystemApplied: false,
      pickupContact: 'Task6下单联系人',
      items: [{ productId: product.id, qty: 2 }],
      remark: `Task6 预定性能样本-${index + 1}`,
    })
    submitSamples.push(Number((performance.now() - startedAt).toFixed(2)))
    orderIds.push(detail.order.id)
    assert.equal(detail.order.status, 'pending')
  }

  const refreshedProduct = await AppDataSource.getRepository(BaseProduct).findOneByOrFail({ id: product.id })
  const metric = buildScenarioMetric(submitSamples)
  const validation = {
    preorderSubmitPass: metric.p95Ms <= scenarioThresholds.preorderSubmitP95MsMax,
    preorderStockPass: Number(refreshedProduct.preOrderedStock) >= 10,
  }

  scenarioResults.push({
    key: 'preorder',
    title: '预定提交',
    beforeSummary: '优化前结算与下单在高频点击下可能重复触发，且库存口径容易被串行流程拖慢。',
    afterSummary: '优化后预定链路已围绕幂等门禁与局部刷新收敛，本次连续下单样本未出现重复状态污染。',
    metrics: {
      preorderSubmit: metric,
      createdOrderCount: orderIds.length,
      heldPreorderedStock: Number(refreshedProduct.preOrderedStock),
    },
    validation,
  })

  assert.equal(validation.preorderSubmitPass, true, '预定提交链路 P95 超过 Task 6 验收阈值')
  assert.equal(validation.preorderStockPass, true, '预定提交后预占库存未按预期累积')
}

const seedOrdersForQueryScenario = async (clientAuth: ClientAuthContext) => {
  const product = await createListedProduct(`query-${Date.now()}`, 1000)
  for (let index = 0; index < 30; index += 1) {
    await o2oPreorderService.submit(clientAuth, {
      clientOrderType: 'walkin',
      isSystemApplied: false,
      pickupContact: 'Task6查询联系人',
      items: [{ productId: product.id, qty: 1 }],
      remark: `Task6 查询样本-${index + 1}`,
    })
  }

  const preorderRepo = AppDataSource.getRepository(O2oPreorder)
  const rows = await preorderRepo.find({
    where: { clientUserId: clientAuth.userId },
    order: { id: 'DESC' },
    take: 24,
  })

  const verifiedIds = rows.slice(8, 16).map((item) => item.id)
  const cancelledIds = rows.slice(16, 24).map((item) => item.id)
  if (verifiedIds.length > 0) {
    await preorderRepo
      .createQueryBuilder()
      .update(O2oPreorder)
      .set({ status: 'verified', verifiedAt: new Date(), verifiedBy: 'task6-script' })
      .where('id IN (:...ids)', { ids: verifiedIds })
      .execute()
  }
  if (cancelledIds.length > 0) {
    await preorderRepo
      .createQueryBuilder()
      .update(O2oPreorder)
      .set({ status: 'cancelled', cancelReason: 'manual' })
      .where('id IN (:...ids)', { ids: cancelledIds })
      .execute()
  }
}

const measureOrderQueryScenario = async (clientAuth: ClientAuthContext) => {
  await seedOrdersForQueryScenario(clientAuth)

  for (let index = 0; index < 3; index += 1) {
    await o2oPreorderService.listMyOrders(clientAuth, { page: 1, pageSize: 20 })
  }

  const listSamples: number[] = []
  const statusSamples: number[] = []
  let latestTotal = 0
  for (let index = 0; index < 20; index += 1) {
    const startedAt = performance.now()
    const listResult = await o2oPreorderService.listMyOrders(clientAuth, { page: 1, pageSize: 20 })
    listSamples.push(Number((performance.now() - startedAt).toFixed(2)))
    latestTotal = listResult.total
  }
  for (let index = 0; index < 10; index += 1) {
    const startedAt = performance.now()
    const listResult = await o2oPreorderService.listMyOrders(clientAuth, { page: 1, pageSize: 20, status: 'verified' })
    statusSamples.push(Number((performance.now() - startedAt).toFixed(2)))
    assert.ok(listResult.list.every((item) => item.status === 'verified'))
  }

  const listMetric = buildScenarioMetric(listSamples)
  const statusMetric = buildScenarioMetric(statusSamples)
  const validation = {
    orderQueryListPass: listMetric.p95Ms <= scenarioThresholds.orderQueryListP95MsMax,
    orderQueryStatusPass: statusMetric.p95Ms <= scenarioThresholds.orderQueryStatusP95MsMax,
    orderQueryTotalPass: latestTotal >= 35,
  }

  scenarioResults.push({
    key: 'order-query',
    title: '订单查询',
    beforeSummary: '优化前订单列表与详情切换容易出现整页重拉、请求乱序和筛选回跳。',
    afterSummary: '优化后订单查询已具备缓存复用与增量刷新能力，本次首屏与筛选读取样本保持在阈值内。',
    metrics: {
      firstScreenList: listMetric,
      statusSwitch: statusMetric,
      totalOrders: latestTotal,
    },
    validation,
  })

  assert.equal(validation.orderQueryListPass, true, '订单查询首屏 P95 超过 Task 6 验收阈值')
  assert.equal(validation.orderQueryStatusPass, true, '订单查询状态切换 P95 超过 Task 6 验收阈值')
  assert.equal(validation.orderQueryTotalPass, true, '订单查询样本量不足，无法覆盖列表与筛选场景')
}

const measureOrderEditScenario = async (clientAuth: ClientAuthContext) => {
  const productA = await createListedProduct(`edit-a-${Date.now()}`, 120)
  const productB = await createListedProduct(`edit-b-${Date.now()}`, 120)
  const orderEditSamples: number[] = []
  const latestTotals: number[] = []

  for (let index = 0; index < 5; index += 1) {
    const created = await o2oPreorderService.submit(clientAuth, {
      clientOrderType: 'walkin',
      isSystemApplied: false,
      pickupContact: 'Task6改单联系人',
      items: [{ productId: productA.id, qty: 2 }],
      remark: `Task6 单改前备注-${index + 1}`,
    })

    const beforeProductA = await AppDataSource.getRepository(BaseProduct).findOneByOrFail({ id: productA.id })
    const beforeProductB = await AppDataSource.getRepository(BaseProduct).findOneByOrFail({ id: productB.id })

    const startedAt = performance.now()
    const updated = await o2oPreorderService.updateMyOrder(clientAuth, created.order.id, {
      remark: `Task6 单改后备注-${index + 1}`,
      items: [
        { productId: productA.id, qty: 1 },
        { productId: productB.id, qty: 2 },
      ],
    })
    orderEditSamples.push(Number((performance.now() - startedAt).toFixed(2)))
    latestTotals.push(updated.order.totalQty)

    const afterProductA = await AppDataSource.getRepository(BaseProduct).findOneByOrFail({ id: productA.id })
    const afterProductB = await AppDataSource.getRepository(BaseProduct).findOneByOrFail({ id: productB.id })
    const summary = await o2oPreorderService.getMyOrderSummary(clientAuth, created.order.id)

    assert.equal(updated.order.totalQty, 3)
    assert.equal(updated.order.remark, `Task6 单改后备注-${index + 1}`)
    assert.equal(updated.order.updateCount, 1)
    assert.equal(updated.order.remainingUpdateCount, Math.max(0, updated.order.maxUpdateCount - 1))
    assert.equal(updated.items.length, 2)
    assert.deepEqual(
      updated.items.map((item) => ({ productId: item.productId, qty: item.qty })),
      [
        { productId: productA.id, qty: 1 },
        { productId: productB.id, qty: 2 },
      ],
    )
    assert.equal(summary.id, created.order.id)
    assert.equal(summary.totalQty, updated.order.totalQty)
    assert.equal(summary.totalAmount, updated.order.totalAmount)
    assert.equal(Number(afterProductA.preOrderedStock), Number(beforeProductA.preOrderedStock) - 1)
    assert.equal(Number(afterProductB.preOrderedStock), Number(beforeProductB.preOrderedStock) + 2)
  }

  verifyOrderEditStaticRegression()

  const editMetric = buildScenarioMetric(orderEditSamples)
  const validation = {
    orderEditPass: editMetric.p95Ms <= scenarioThresholds.orderEditP95MsMax,
    orderEditTotalsPass: latestTotals.every((value) => value === 3),
  }

  scenarioResults.push({
    key: 'order-edit',
    title: '订单编辑',
    beforeSummary: '优化前改单成功后需要整页重拉才能看到详情与列表最新状态，且库存重算回路验证不足。',
    afterSummary: '优化后订单编辑已形成“服务端更新详情 + 本地摘要局部回写 + 广播同步列表”的自动化回归闭环。',
    metrics: {
      orderEdit: editMetric,
      editedOrderCount: orderEditSamples.length,
      totalQtyAfterEdit: latestTotals.join(','),
    },
    validation,
  })

  assert.equal(validation.orderEditPass, true, '订单编辑链路 P95 超过 Task 6 验收阈值')
  assert.equal(validation.orderEditTotalsPass, true, '订单编辑后的订单总数未按预期回写')
  pushRegressionCheck('订单编辑服务端库存与摘要回读断言通过', {
    editedOrderCount: orderEditSamples.length,
    totalQtyAfterEdit: latestTotals,
  })
}

const buildSupplementaryReportSummary = () => {
  const clientConcurrencyReport = readOptionalJson<{
    status: string
    acceptanceThresholdFor20Users?: Record<string, number>
    checks?: Array<{ title: string; status: string }>
  }>(clientConcurrencyReportPath)
  const performanceBudgetReport = readOptionalJson<{
    status?: string
    totalAssetsKB: number
    criticalAssetsKB?: number
    performanceBudget: { totalAssetsMaxKB?: number; criticalAssetsMaxKB?: number }
    routeChunkReport?: string[]
  }>(performanceBudgetReportPath)
  const dualBudgetReport = readOptionalJson<{
    status: string
    dualBudget?: {
      runtimeBudget?: {
        status?: string
      }
    }
  }>(dualBudgetReportPath)

  return {
    clientConcurrency: clientConcurrencyReport
      ? {
          status: clientConcurrencyReport.status,
          acceptanceThresholdFor20Users: clientConcurrencyReport.acceptanceThresholdFor20Users ?? null,
          checkCount: clientConcurrencyReport.checks?.length ?? 0,
        }
      : null,
    performanceBudget: performanceBudgetReport
      ? {
          status: performanceBudgetReport.status ?? 'unknown',
          totalAssetsKB: performanceBudgetReport.totalAssetsKB,
          totalAssetsMaxKB: performanceBudgetReport.performanceBudget.totalAssetsMaxKB ?? null,
          criticalAssetsKB: performanceBudgetReport.criticalAssetsKB ?? null,
          criticalAssetsMaxKB: performanceBudgetReport.performanceBudget.criticalAssetsMaxKB ?? null,
          routeChunkReport: performanceBudgetReport.routeChunkReport ?? [],
        }
      : null,
    dualBudget: dualBudgetReport
      ? {
          status: dualBudgetReport.status,
          runtimeBudgetStatus: dualBudgetReport.dualBudget?.runtimeBudget?.status ?? null,
        }
      : null,
  }
}

const writeReport = (status: 'passed' | 'failed', errorMessage: string | null = null) => {
  fs.mkdirSync(runtimeRoot, { recursive: true })
  const supplementary = buildSupplementaryReportSummary()
  const report = {
    generatedAt: new Date().toISOString(),
    status,
    errorMessage,
    taskScope: 'Task 6: 联调验证与性能验收',
    thresholds: scenarioThresholds,
    scenarioResults,
    regressionChecks,
    supplementaryReports: supplementary,
  }
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

const main = async () => {
  await ensureReady()
  const clientAuth = await measureRegistrationScenario()
  await measureMallScenario()
  await measurePreorderScenario(clientAuth)
  await measureOrderQueryScenario(clientAuth)
  await measureOrderEditScenario(clientAuth)
}

try {
  await main()
  writeReport('passed')
  log(`Task 6 五场景验收与订单编辑自动回归通过，报告已输出：${reportPath}`)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  writeReport('failed', message)
  // eslint-disable-next-line no-console
  console.error('[task6-client-core-flow] Task 6 五场景验收失败：', error)
  process.exit(1)
} finally {
  if (AppDataSource.isInitialized) {
    await AppDataSource.destroy()
  }
}
