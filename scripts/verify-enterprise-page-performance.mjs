/**
 * 文件说明：scripts/verify-enterprise-page-performance.mjs
 * 文件职责：执行 Y-Link 前端构建预算校验，覆盖总产物、热路径资源、低频重包与高频路由分包，并输出统一 JSON 报告。
 * 实现逻辑：
 * 1. 读取 dist 产物，按前缀归类关键 chunk；
 * 2. 对“总产物预算 + 热路径预算 + 低频专包预算 + 路由分包预算”逐项断言；
 * 3. 复核 keepAlive、预热与稳定请求等性能治理结构是否仍存在；
 * 4. 将预算上限、实测值、明细结果和最终状态写入 `.local-dev/enterprise-performance-budget-report.json`。
 */

import fs from 'node:fs'
import path from 'node:path'

const projectRoot = process.cwd()
const distAssetsRoot = path.join(projectRoot, 'dist', 'assets')
const routesFilePath = path.join(projectRoot, 'src', 'router', 'routes.ts')
const routerIndexFilePath = path.join(projectRoot, 'src', 'router', 'index.ts')
const runtimeRoot = path.join(projectRoot, '.local-dev')
const reportPath = path.join(runtimeRoot, 'enterprise-performance-budget-report.json')

/**
 * 构建预算分成两层：
 * - 总产物预算：防止整体包体持续膨胀；
 * - 热路径预算：把登录后高频路径与低频重包分开考核，避免“总量没超、首屏却变慢”。
 */
const performanceBudget = {
  totalAssetsMaxKB: 4000,
  criticalAssetsMaxKB: 2200,
  entryChunkMaxKB: 80,
  loginChunkMaxKB: 25,
  frameworkChunkMaxKB: 220,
  uiKitChunkMaxKB: 1000,
  vendorChunkMaxKB: 1900,
  lowFrequencyChunkMaxKB: {
    'pdf-export': 1000,
    'qr-scanner': 450,
    charting: 650,
    'image-tools': 80,
    'qr-code': 60,
  },
  routeChunkMaxKB: {
    DashboardView: 20,
    OrderEntryView: 30,
    OrderListView: 30,
    ProductCenterView: 25,
    UserCenterView: 40,
    AuditLogView: 25,
  },
}

const expectedKeepAliveRoutes = ['dashboard', 'order-entry', 'order-list', 'products', 'tags', 'system-users', 'system-audit-logs']
const expectedWarmupTargets = ['order-entry', 'order-list', 'products', 'system-audit-logs']
const expectedColdStartDeferredRoutes = [
  'system-configs',
  'system-db-migration',
  'system-users',
  'system-client-users',
  'system-audit-logs',
]
const expectedStableRequestFiles = [
  path.join(projectRoot, 'src', 'views', 'dashboard', 'DashboardView.vue'),
  path.join(projectRoot, 'src', 'views', 'order-list', 'composables', 'useOrderListView.ts'),
  path.join(projectRoot, 'src', 'views', 'system', 'SystemConfigView.vue'),
  path.join(projectRoot, 'src', 'views', 'system', 'UserManageView.vue'),
  path.join(projectRoot, 'src', 'views', 'system', 'AuditLogView.vue'),
  path.join(projectRoot, 'src', 'composables', 'useCrudManager.ts'),
]

const toKB = (sizeInBytes) => Number((sizeInBytes / 1024).toFixed(2))
const formatKB = (sizeInBytes) => `${toKB(sizeInBytes)} KB`

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message)
  }
}

const readText = (filePath) => {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`文件未找到：${filePath}，请先在项目根目录执行 npm run build 生成最新产物。`)
    }
    throw error
  }
}

assert(fs.existsSync(distAssetsRoot), `构建产物不存在：${distAssetsRoot}，请先执行 npm run build。`)

const assetEntries = fs
  .readdirSync(distAssetsRoot, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => {
    const absolutePath = path.join(distAssetsRoot, entry.name)
    const stat = fs.statSync(absolutePath)

    return {
      name: entry.name,
      absolutePath,
      size: stat.size,
      sizeKB: toKB(stat.size),
    }
  })

const findAssetByPrefix = (prefix) => assetEntries.find((entry) => entry.name.startsWith(`${prefix}-`) && entry.name.endsWith('.js'))

const totalAssetsSize = assetEntries.reduce((sum, entry) => sum + entry.size, 0)
const entryChunk = findAssetByPrefix('index')
const loginChunk = findAssetByPrefix('LoginView')
const frameworkChunk = findAssetByPrefix('framework')
const uiKitChunk = findAssetByPrefix('ui-kit')
const vendorChunk = findAssetByPrefix('vendor')

const lowFrequencyChunks = Object.entries(performanceBudget.lowFrequencyChunkMaxKB).map(([prefix, maxKB]) => {
  const asset = findAssetByPrefix(prefix)
  assert(asset, `缺少低频重包：${prefix}-*.js`)
  return {
    prefix,
    name: asset.name,
    size: asset.size,
    sizeKB: asset.sizeKB,
    maxKB,
    pass: asset.sizeKB <= maxKB,
  }
})

const lowFrequencyAssetsSize = lowFrequencyChunks.reduce((sum, entry) => sum + entry.size, 0)
const criticalAssetsSize = totalAssetsSize - lowFrequencyAssetsSize

assert(entryChunk, '缺少主入口 chunk：index-*.js')
assert(loginChunk, '缺少登录页 chunk：LoginView-*.js')
assert(frameworkChunk, '缺少框架基础 chunk：framework-*.js')
assert(uiKitChunk, '缺少 UI 共享 chunk：ui-kit-*.js')
assert(vendorChunk, '缺少共享依赖 chunk：vendor-*.js')

const chunkBudgetChecks = [
  {
    key: 'total-assets',
    label: '总产物',
    actualKB: toKB(totalAssetsSize),
    maxKB: performanceBudget.totalAssetsMaxKB,
  },
  {
    key: 'critical-assets',
    label: '热路径关键产物',
    actualKB: toKB(criticalAssetsSize),
    maxKB: performanceBudget.criticalAssetsMaxKB,
  },
  {
    key: 'entry',
    label: '主入口 chunk',
    actualKB: entryChunk.sizeKB,
    maxKB: performanceBudget.entryChunkMaxKB,
    assetName: entryChunk.name,
  },
  {
    key: 'login',
    label: '登录页 chunk',
    actualKB: loginChunk.sizeKB,
    maxKB: performanceBudget.loginChunkMaxKB,
    assetName: loginChunk.name,
  },
  {
    key: 'framework',
    label: '框架基础 chunk',
    actualKB: frameworkChunk.sizeKB,
    maxKB: performanceBudget.frameworkChunkMaxKB,
    assetName: frameworkChunk.name,
  },
  {
    key: 'ui-kit',
    label: 'UI 共享 chunk',
    actualKB: uiKitChunk.sizeKB,
    maxKB: performanceBudget.uiKitChunkMaxKB,
    assetName: uiKitChunk.name,
  },
  {
    key: 'vendor',
    label: '共享依赖 chunk',
    actualKB: vendorChunk.sizeKB,
    maxKB: performanceBudget.vendorChunkMaxKB,
    assetName: vendorChunk.name,
  },
].map((item) => ({
  ...item,
  pass: item.actualKB <= item.maxKB,
}))

const routeChunkChecks = Object.entries(performanceBudget.routeChunkMaxKB).map(([prefix, maxKB]) => {
  const asset = findAssetByPrefix(prefix)
  assert(asset, `缺少高频路由分包：${prefix}-*.js`)
  return {
    prefix,
    assetName: asset.name,
    actualKB: asset.sizeKB,
    maxKB,
    pass: asset.sizeKB <= maxKB,
  }
})

const routesSource = readText(routesFilePath)
const routerIndexSource = readText(routerIndexFilePath)

expectedKeepAliveRoutes.forEach((routeName) => {
  assert(
    routesSource.includes(`name: '${routeName}'`) && routesSource.includes('keepAlive: true'),
    `路由 ${routeName} 未接入 keepAlive。`,
  )
})

expectedWarmupTargets.forEach((routeName) => {
  assert(routesSource.includes(`'${routeName}'`), `缺少预热目标：${routeName}`)
})

expectedColdStartDeferredRoutes.forEach((routeName) => {
  assert(
    routesSource.includes(`name: '${routeName}'`) && routesSource.includes('deferPreloadOnColdStart: true'),
    `缺少冷启动延迟预热路由：${routeName}`,
  )
})

assert(routerIndexSource.includes('scheduleRouteComponentWarmup'), '路由预热调度器未接入 router 层。')

expectedStableRequestFiles.forEach((filePath) => {
  const source = readText(filePath)
  assert(source.includes('useStableRequest'), `稳定请求治理缺失：${filePath}`)
})

/**
 * 收敛为统一失败列表，便于 CI 和人工留档同时复用。
 */
const failedChecks = [
  ...chunkBudgetChecks
    .filter((item) => !item.pass)
    .map((item) => {
      const assetSuffix = item.assetName ? ` (${item.assetName})` : ''
      return `${item.label} 超预算：${item.actualKB} KB > ${item.maxKB} KB${assetSuffix}`
    }),
  ...lowFrequencyChunks
    .filter((item) => !item.pass)
    .map((item) => `低频重包 ${item.prefix} 超预算：${item.sizeKB} KB > ${item.maxKB} KB (${item.name})`),
  ...routeChunkChecks
    .filter((item) => !item.pass)
    .map((item) => `高频路由分包 ${item.prefix} 超预算：${item.actualKB} KB > ${item.maxKB} KB (${item.assetName})`),
]

const report = {
  generatedAt: new Date().toISOString(),
  status: failedChecks.length === 0 ? 'passed' : 'failed',
  errorMessage: failedChecks.length === 0 ? null : failedChecks.join('；'),
  reportType: 'build-budget',
  performanceBudget,
  budgetSummary: {
    totalAssets: {
      actualKB: toKB(totalAssetsSize),
      maxKB: performanceBudget.totalAssetsMaxKB,
      pass: toKB(totalAssetsSize) <= performanceBudget.totalAssetsMaxKB,
    },
    criticalAssets: {
      actualKB: toKB(criticalAssetsSize),
      maxKB: performanceBudget.criticalAssetsMaxKB,
      pass: toKB(criticalAssetsSize) <= performanceBudget.criticalAssetsMaxKB,
    },
  },
  totalAssetsKB: toKB(totalAssetsSize),
  criticalAssetsKB: toKB(criticalAssetsSize),
  lowFrequencyAssetsKB: toKB(lowFrequencyAssetsSize),
  chunks: {
    entry: {
      name: entryChunk.name,
      sizeKB: entryChunk.sizeKB,
      maxKB: performanceBudget.entryChunkMaxKB,
      pass: entryChunk.sizeKB <= performanceBudget.entryChunkMaxKB,
    },
    login: {
      name: loginChunk.name,
      sizeKB: loginChunk.sizeKB,
      maxKB: performanceBudget.loginChunkMaxKB,
      pass: loginChunk.sizeKB <= performanceBudget.loginChunkMaxKB,
    },
    framework: {
      name: frameworkChunk.name,
      sizeKB: frameworkChunk.sizeKB,
      maxKB: performanceBudget.frameworkChunkMaxKB,
      pass: frameworkChunk.sizeKB <= performanceBudget.frameworkChunkMaxKB,
    },
    'ui-kit': {
      name: uiKitChunk.name,
      sizeKB: uiKitChunk.sizeKB,
      maxKB: performanceBudget.uiKitChunkMaxKB,
      pass: uiKitChunk.sizeKB <= performanceBudget.uiKitChunkMaxKB,
    },
    vendor: {
      name: vendorChunk.name,
      sizeKB: vendorChunk.sizeKB,
      maxKB: performanceBudget.vendorChunkMaxKB,
      pass: vendorChunk.sizeKB <= performanceBudget.vendorChunkMaxKB,
    },
  },
  lowFrequencyChunks,
  routeChunkChecks,
  lowFrequencyChunkReport: lowFrequencyChunks.map((entry) => `${entry.prefix}: ${entry.sizeKB} KB`),
  routeChunkReport: routeChunkChecks.map((entry) => `${entry.prefix}: ${entry.actualKB} KB`),
  keepAliveRoutes: expectedKeepAliveRoutes,
  warmupTargets: expectedWarmupTargets,
  coldStartDeferredRoutes: expectedColdStartDeferredRoutes,
  stableRequestFiles: expectedStableRequestFiles,
}

fs.mkdirSync(runtimeRoot, { recursive: true })
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

if (failedChecks.length > 0) {
  throw new Error(failedChecks.join('\n'))
}

console.log('[build-budget] 构建预算校验通过')
console.log(`- 总产物：${formatKB(totalAssetsSize)} / ${performanceBudget.totalAssetsMaxKB} KB`)
console.log(`- 热路径关键产物：${formatKB(criticalAssetsSize)} / ${performanceBudget.criticalAssetsMaxKB} KB`)
console.log(`- 低频重包：${report.lowFrequencyChunkReport.join(' | ')}`)
console.log(`- 高频路由分包：${report.routeChunkReport.join(' | ')}`)
console.log(`- 稳定请求接入文件数：${expectedStableRequestFiles.length}`)
console.log(`- 报告：${reportPath}`)
