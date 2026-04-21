/**
 * 模块说明：scripts/verify-client-concurrency-performance.mjs
 * 文件职责：建立客户端并发风险基线、20 人混合场景阈值与静态验收断言，并输出可复现报告。
 * 实现逻辑：通过“规则清单 + 关键文件断言 + 统一 JSON 报告”确保并发治理可比对、可追溯。
 */

import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const runtimeRoot = path.join(projectRoot, '.local-dev')
const reportPath = path.join(runtimeRoot, 'client-concurrency-performance.report.json')

/**
 * 并发风险基线：
 * - 按“触发点 -> 竞争风险 -> 治理策略”结构固化，便于团队统一口径复用；
 * - 用于指导 20 人并发混合场景下的回归重点，不依赖单人手工记忆。
 */
const concurrencyRiskBaseline = [
  {
    flow: '认证链路',
    triggers: ['连续点击登录', '重复发送验证码', '注册与验证码交替触发'],
    raceRisks: ['重复提交', '旧验证码覆盖新验证码', '错误提示与按钮状态不一致'],
    guards: ['动作幂等门禁', '验证码请求仅最新生效', '统一错误归一化提示'],
  },
  {
    flow: '商城链路',
    triggers: ['快速切换分类', '连续刷新库存', '搜索词频繁变更'],
    raceRisks: ['旧请求覆盖新筛选结果', '列表闪烁回跳', '库存视图与购物车状态不一致'],
    guards: ['取消旧请求', '仅最后一次结果回写', '目录刷新后购物车同步映射'],
  },
  {
    flow: '购物车与下单链路',
    triggers: ['重复点击提交订单', '库存抖动时增减数量', '结算页与购物车并行操作'],
    raceRisks: ['重复落单意图', '数量状态污染', '提交后前端状态提前删除'],
    guards: ['提交动作幂等门禁', '数量边界标准化', '服务端成功后再清购物车'],
  },
  {
    flow: '订单查询链路',
    triggers: ['状态筛选连续切换', '关键词连续输入', '详情页快速切换订单'],
    raceRisks: ['列表结果乱序', '刷新失败导致整页闪退', '详情状态回写污染列表'],
    guards: ['列表请求仅最新生效', '缓存兜底 + 局部错误提示', '详情回写统一 upsert'],
  },
]

/**
 * 20 人混合操作验收阈值：
 * - 该阈值用于验证“并发稳态能力”是否达标；
 * - 实际压测可由外部工具执行，脚本负责固化阈值口径和回归断言。
 */
const acceptanceThresholdFor20Users = {
  mixedScenarioUsers: 20,
  maxErrorRate: 0.03,
  maxAverageResponseMs: 1200,
  maxP95ResponseMs: 2500,
  maxInteractiveReadyMs: 2200,
}

const checks = []

const readText = (filePath) => {
  return fs.readFileSync(filePath, 'utf8')
}

const pushCheck = (title, detail) => {
  checks.push({
    title,
    status: 'passed',
    detail,
  })
}

const verifyBaselineDefinition = () => {
  assert.equal(concurrencyRiskBaseline.length >= 4, true, '并发风险基线条目不足，无法覆盖认证/商城/购物车下单/订单查询')
  const flows = concurrencyRiskBaseline.map((item) => item.flow)
  ;['认证链路', '商城链路', '购物车与下单链路', '订单查询链路'].forEach((requiredFlow) => {
    assert.equal(flows.includes(requiredFlow), true, `并发风险基线缺失：${requiredFlow}`)
  })
  pushCheck('并发风险基线定义完整', { flows })
}

const verifyThresholdDefinition = () => {
  assert.equal(acceptanceThresholdFor20Users.mixedScenarioUsers, 20, '并发阈值未锁定 20 人混合场景')
  assert.equal(acceptanceThresholdFor20Users.maxErrorRate <= 0.05, true, '错误率阈值过宽，不满足稳态验收要求')
  assert.equal(acceptanceThresholdFor20Users.maxP95ResponseMs <= 3000, true, 'P95 阈值过宽，缺少性能约束价值')
  pushCheck('20 人并发验收阈值已固化', acceptanceThresholdFor20Users)
}

const verifyClientGovernanceCoverage = () => {
  const authViewPath = path.join(projectRoot, 'src', 'views', 'client', 'ClientAuthView.vue')
  const forgotViewPath = path.join(projectRoot, 'src', 'views', 'client', 'ClientForgotPasswordView.vue')
  const checkoutViewPath = path.join(projectRoot, 'src', 'views', 'client', 'ClientCheckoutView.vue')
  const mallViewPath = path.join(projectRoot, 'src', 'views', 'client', 'ClientMallView.vue')
  const ordersViewPath = path.join(projectRoot, 'src', 'views', 'client', 'ClientOrdersView.vue')
  const orderDetailViewPath = path.join(projectRoot, 'src', 'views', 'client', 'ClientOrderDetailView.vue')
  const routesPath = path.join(projectRoot, 'src', 'router', 'routes.ts')
  const routePerformancePath = path.join(projectRoot, 'src', 'router', 'route-performance.ts')
  const errorUtilPath = path.join(projectRoot, 'src', 'utils', 'error.ts')
  const idempotentComposablePath = path.join(projectRoot, 'src', 'composables', 'useIdempotentAction.ts')
  const stableRequestPath = path.join(projectRoot, 'src', 'composables', 'useStableRequest.ts')

  const authViewSource = readText(authViewPath)
  const forgotViewSource = readText(forgotViewPath)
  const checkoutViewSource = readText(checkoutViewPath)
  const mallViewSource = readText(mallViewPath)
  const ordersViewSource = readText(ordersViewPath)
  const orderDetailViewSource = readText(orderDetailViewPath)
  const routesSource = readText(routesPath)
  const routePerformanceSource = readText(routePerformancePath)
  const errorUtilSource = readText(errorUtilPath)
  const idempotentComposableSource = readText(idempotentComposablePath)
  const stableRequestSource = readText(stableRequestPath)

  assert.match(idempotentComposableSource, /runWithGate/, '幂等门禁组合式缺失 runWithGate 导出')
  assert.match(authViewSource, /runWithGate/, '认证页未接入幂等门禁')
  assert.match(forgotViewSource, /runWithGate/, '找回密码页未接入幂等门禁')
  assert.match(checkoutViewSource, /runWithGate/, '结算页未接入幂等门禁')
  assert.match(mallViewSource, /useStableRequest/, '商城页未接入稳定请求治理')
  assert.match(ordersViewSource, /useStableRequest/, '订单列表页未接入稳定请求治理')
  assert.match(orderDetailViewSource, /useStableRequest/, '订单详情页未接入稳定请求治理')
  assert.match(errorUtilSource, /normalizeRequestError/, '错误归一化工具缺失 normalizeRequestError')
  assert.match(stableRequestSource, /requestId !== latestRequestId/, '稳定请求缺失“仅最后一次生效”保护')
  assert.match(routesSource, /name: 'client-mall'[\s\S]*?preloadTargets:/, '客户端商城路由未配置预热目标')
  assert.match(routePerformanceSource, /resolveClientPostLoginWarmupTargets/, '客户端登录后预热策略未落地')

  pushCheck('客户端并发治理覆盖断言通过', {
    files: [
      authViewPath,
      forgotViewPath,
      checkoutViewPath,
      mallViewPath,
      ordersViewPath,
      orderDetailViewPath,
      routesPath,
      routePerformancePath,
      errorUtilPath,
      idempotentComposablePath,
      stableRequestPath,
    ],
  })
}

const writeReport = (status, errorMessage = null) => {
  fs.mkdirSync(runtimeRoot, { recursive: true })
  fs.writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        status,
        errorMessage,
        concurrencyRiskBaseline,
        acceptanceThresholdFor20Users,
        checks,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
}

const main = () => {
  verifyBaselineDefinition()
  verifyThresholdDefinition()
  verifyClientGovernanceCoverage()
}

try {
  main()
  writeReport('passed')
  // eslint-disable-next-line no-console
  console.log(`[client-perf] 客户端并发与性能基线验证通过，报告已输出：${reportPath}`)
} catch (error) {
  writeReport('failed', error instanceof Error ? error.message : String(error))
  // eslint-disable-next-line no-console
  console.error('[client-perf] 客户端并发与性能基线验证失败：', error)
  process.exit(1)
}
