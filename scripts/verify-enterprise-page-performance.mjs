/**
 * 文件说明：scripts/verify-enterprise-page-performance.mjs
 * 文件职责：执行 Y-Link 前端构建预算校验，覆盖总产物、热路径资源、低频重包与高频路由分包，并输出统一 JSON 报告。
 * 实现逻辑：
 * 1. 读取 dist 产物，并从 index.html 的 module/stylesheet 引用递归还原真实首屏静态依赖图；
 * 2. 对“总产物预算 + 首屏 JS/CSS 预算 + 低频专包预算 + 路由分包预算”逐项断言；
 * 3. 复核 keepAlive、预热与稳定请求等性能治理结构是否仍存在；
 * 4. 将预算上限、实测值、明细结果和最终状态写入 `.local-dev/enterprise-performance-budget-report.json`。
 */

import fs from 'node:fs'
import path from 'node:path'

const projectRoot = process.cwd()
const distAssetsRoot = path.join(projectRoot, 'dist', 'assets')
const distIndexFilePath = path.join(projectRoot, 'dist', 'index.html')
const routesFilePath = path.join(projectRoot, 'src', 'router', 'routes.ts')
const routerIndexFilePath = path.join(projectRoot, 'src', 'router', 'index.ts')
const runtimeRoot = path.join(projectRoot, '.local-dev')
const reportPath = path.join(runtimeRoot, 'enterprise-performance-budget-report.json')

/**
 * 构建预算分成两层：
 * - 总产物预算：防止整体包体持续膨胀；
 * - 首屏预算：以 index.html 实际 modulepreload、入口模块和 stylesheet 依赖图为准，
 *   避免把动态路由产物误算进热路径，也避免低频重包意外回到入口而不被发现。
 *
 * 已批准的 Issues #68-#74 在相同 Node 与依赖环境中的构建总产物为 4251.56 KB；
 * 相对 main@6dc428b 的 4199.83 KB 真实增加 51.73 KB。该增量来自四项已批准功能，
 * 而 pdf-export、charting、qr-scanner 三个低频重包与 main 的哈希和体积均未变化。
 * 首屏、路由、低频重包和运行时细分预算均已通过，因此总量上限设为 4315 KB，
 * 为当前批准功能基线保留约 1.49% 余量，同时继续阻止整体包体无约束增长。
 *
 * Issue #96（部门单到店取货时间）：同一环境下 main@ed46790 总产物实测 4310.83 KB，
 * 本功能新增结算页日期按钮与时段下拉后为 4315.89 KB（+5.06 KB），增量落在客户端结算页分包，
 * 首屏依赖图、首屏 JS/CSS、低频重包与路由分包预算均无新增超额，因此总量上限上调为 4325 KB。
 *
 * Issues #93/#94（报表中心规格明细抽屉、标签销售汇总）：相对 main@ed46790 单独叠加后实测 4320.15 KB（+9.32 KB），
 * 增量集中在异步拆包的 InventorySkuDetailDrawer 与报表中心路由分包。#96 合入 main 后两份增量叠加，
 * 与 main@80e0b54 合并后同一环境实测 4325.74 KB，因此上限定为 4330 KB（约 0.1% 余量）；
 * 两个分支各自的上限不能简单取大值沿用，合并后必须重新实测。
 */
const performanceBudget = {
  totalAssetsMaxKB: 4330,
  criticalAssetsMaxKB: 1180,
  initialLoadJsMaxKB: 850,
  initialLoadCssMaxKB: 320,
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
  /**
   * OrderEntryView：#68-#74 引入 SKU 选择、草稿商品对账后接近 30 KB 上限；
   * #75 客户部门下拉与自由录入另增约 2.0 KB（main@6dc428b 上实测 25.13 → 27.15 KB），
   * 合并后实测 30.75 KB，按当前值重设为 32 KB，保留约 4% 余量继续约束开单页主包增长。
   */
  routeChunkMaxKB: {
    DashboardView: 20,
    OrderEntryView: 32,
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

const extractHtmlAttribute = (tag, attributeName) => {
  const match = tag.match(new RegExp(`\\b${attributeName}\\s*=\\s*(["'])(.*?)\\1`, 'i'))
  return match?.[2] ?? null
}

const normalizeAssetReference = (reference, sourceLabel) => {
  const cleanReference = reference.split(/[?#]/, 1)[0]
  const assetPrefix = cleanReference.includes('/assets/')
    ? cleanReference.slice(cleanReference.indexOf('/assets/') + '/assets/'.length)
    : cleanReference.replace(/^(?:\.\/)?assets\//, '')
  const normalizedName = path.posix.normalize(assetPrefix)

  assert(
    normalizedName && normalizedName !== '.' && !normalizedName.startsWith('../') && !path.posix.isAbsolute(normalizedName),
    `${sourceLabel} 包含非法构建资源路径：${reference}`,
  )
  assert(
    cleanReference.includes('/assets/') || /^(?:\.\/)?assets\//.test(cleanReference),
    `${sourceLabel} 必须引用 dist/assets 内的构建资源：${reference}`,
  )

  return normalizedName
}

const resolveRelativeAssetReference = (ownerName, reference) => {
  const cleanReference = reference.split(/[?#]/, 1)[0]
  if (!cleanReference.startsWith('.')) {
    return null
  }
  const normalizedName = path.posix.normalize(path.posix.join(path.posix.dirname(ownerName), cleanReference))
  assert(!normalizedName.startsWith('../') && !path.posix.isAbsolute(normalizedName), `构建依赖越界：${ownerName} -> ${reference}`)
  return normalizedName
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

const assetEntryByName = new Map(assetEntries.map((entry) => [entry.name, entry]))

const requireAsset = (assetName, sourceLabel) => {
  const asset = assetEntryByName.get(assetName)
  assert(asset, `${sourceLabel} 引用了不存在的构建资源：${assetName}`)
  return asset
}

/**
 * Vite/Rolldown 会把入口模块及其静态依赖写为 modulepreload；这里仍递归扫描静态
 * import/export，防止构建器配置变化时遗漏浏览器启动阶段实际会继续请求的模块。
 * `import(...)` 动态路由不会命中，因此图表、PDF、扫码等低频包仍按真实懒加载口径统计。
 */
const collectStaticModuleGraph = (seedNames) => {
  const visited = new Set()
  const pending = [...seedNames]
  const staticImportPattern = /\b(?:import|export)(?!\s*\()\s*(?:[^;"']*?\sfrom\s*)?["']([^"']+)["']/g

  while (pending.length > 0) {
    const assetName = pending.pop()
    if (!assetName || visited.has(assetName)) {
      continue
    }
    const asset = requireAsset(assetName, '首屏模块图')
    visited.add(assetName)
    if (!/\.(?:m?js)$/.test(assetName)) {
      continue
    }

    const source = readText(asset.absolutePath)
    staticImportPattern.lastIndex = 0
    for (const match of source.matchAll(staticImportPattern)) {
      const dependencyName = resolveRelativeAssetReference(assetName, match[1])
      if (dependencyName && !visited.has(dependencyName)) {
        requireAsset(dependencyName, assetName)
        pending.push(dependencyName)
      }
    }
  }

  return visited
}

const distIndexSource = readText(distIndexFilePath)
const htmlTags = distIndexSource.match(/<(?:script|link)\b[^>]*>/gi) ?? []
const entryModuleNames = htmlTags
  .filter((tag) => /^<script\b/i.test(tag) && /\btype\s*=\s*(["'])module\1/i.test(tag))
  .map((tag) => extractHtmlAttribute(tag, 'src'))
  .filter(Boolean)
  .map((reference) => normalizeAssetReference(reference, 'index.html 模块入口'))
const modulePreloadNames = htmlTags
  .filter((tag) => /^<link\b/i.test(tag) && /\brel\s*=\s*(["'])modulepreload\1/i.test(tag))
  .map((tag) => extractHtmlAttribute(tag, 'href'))
  .filter(Boolean)
  .map((reference) => normalizeAssetReference(reference, 'index.html modulepreload'))
const stylesheetNames = htmlTags
  .filter((tag) => /^<link\b/i.test(tag) && /\brel\s*=\s*(["'])stylesheet\1/i.test(tag))
  .map((tag) => extractHtmlAttribute(tag, 'href'))
  .filter(Boolean)
  .map((reference) => normalizeAssetReference(reference, 'index.html stylesheet'))

assert(entryModuleNames.length === 1, 'index.html 必须且只能有一个 type="module" 的前端入口。')
assert(modulePreloadNames.length > 0, 'index.html 缺少 modulepreload；首屏依赖预加载已被关闭。')
assert(stylesheetNames.length > 0, 'index.html 缺少首屏 stylesheet。')

const initialModuleGraph = collectStaticModuleGraph([...entryModuleNames, ...modulePreloadNames])
const initialAssetNames = new Set([...initialModuleGraph, ...stylesheetNames])
const initialAssets = [...initialAssetNames].map((assetName) => requireAsset(assetName, '首屏依赖图'))

const findAssetByPrefix = (prefix) => assetEntries.find((entry) => entry.name.startsWith(`${prefix}-`) && entry.name.endsWith('.js'))

const totalAssetsSize = assetEntries.reduce((sum, entry) => sum + entry.size, 0)
// 构建器可把源入口命名为 main、index 或其他稳定名称；预算必须以 index.html 实际加载的模块为准，
// 不能把某个历史 chunk 文件名前缀当成入口事实。
const entryChunk = requireAsset(entryModuleNames[0], 'index.html 模块入口')
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
const initialLoadAssetsSize = initialAssets.reduce((sum, entry) => sum + entry.size, 0)
const initialLoadJsSize = initialAssets
  .filter((entry) => /\.(?:m?js)$/.test(entry.name))
  .reduce((sum, entry) => sum + entry.size, 0)
const initialLoadCssSize = initialAssets
  .filter((entry) => entry.name.endsWith('.css'))
  .reduce((sum, entry) => sum + entry.size, 0)
// 保留 criticalAssets 命名作为既有双预算报告的兼容字段，但口径已修正为真实首屏图。
const criticalAssetsSize = initialLoadAssetsSize

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
    label: '首屏依赖图',
    actualKB: toKB(criticalAssetsSize),
    maxKB: performanceBudget.criticalAssetsMaxKB,
  },
  {
    key: 'initial-load-js',
    label: '首屏 JS',
    actualKB: toKB(initialLoadJsSize),
    maxKB: performanceBudget.initialLoadJsMaxKB,
  },
  {
    key: 'initial-load-css',
    label: '首屏 CSS',
    actualKB: toKB(initialLoadCssSize),
    maxKB: performanceBudget.initialLoadCssMaxKB,
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

const lowFrequencyInitialLeaks = lowFrequencyChunks.filter((entry) => initialAssetNames.has(entry.name))

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
  ...lowFrequencyInitialLeaks.map((item) => `低频重包 ${item.prefix} 不应出现在 index.html 首屏依赖图：${item.name}`),
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
    initialLoadJs: {
      actualKB: toKB(initialLoadJsSize),
      maxKB: performanceBudget.initialLoadJsMaxKB,
      pass: toKB(initialLoadJsSize) <= performanceBudget.initialLoadJsMaxKB,
    },
    initialLoadCss: {
      actualKB: toKB(initialLoadCssSize),
      maxKB: performanceBudget.initialLoadCssMaxKB,
      pass: toKB(initialLoadCssSize) <= performanceBudget.initialLoadCssMaxKB,
    },
  },
  totalAssetsKB: toKB(totalAssetsSize),
  criticalAssetsKB: toKB(criticalAssetsSize),
  initialLoadAssetsKB: toKB(initialLoadAssetsSize),
  initialLoadJsKB: toKB(initialLoadJsSize),
  initialLoadCssKB: toKB(initialLoadCssSize),
  lowFrequencyAssetsKB: toKB(lowFrequencyAssetsSize),
  initialLoadGraph: {
    entryModules: entryModuleNames,
    modulePreloads: modulePreloadNames,
    stylesheets: stylesheetNames,
    assets: initialAssets.map((entry) => ({ name: entry.name, sizeKB: entry.sizeKB })),
    lowFrequencyLeaks: lowFrequencyInitialLeaks.map((entry) => entry.name),
  },
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
console.log(`- 首屏依赖图：${formatKB(initialLoadAssetsSize)} / ${performanceBudget.criticalAssetsMaxKB} KB`)
console.log(`- 首屏 JS：${formatKB(initialLoadJsSize)} / ${performanceBudget.initialLoadJsMaxKB} KB`)
console.log(`- 首屏 CSS：${formatKB(initialLoadCssSize)} / ${performanceBudget.initialLoadCssMaxKB} KB`)
console.log(`- 低频重包：${report.lowFrequencyChunkReport.join(' | ')}`)
console.log(`- 高频路由分包：${report.routeChunkReport.join(' | ')}`)
console.log(`- 稳定请求接入文件数：${expectedStableRequestFiles.length}`)
console.log(`- 报告：${reportPath}`)
