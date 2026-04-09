import fs from 'node:fs'
import path from 'node:path'

const projectRoot = process.cwd()
const distAssetsRoot = path.join(projectRoot, 'dist', 'assets')
const routesFilePath = path.join(projectRoot, 'src', 'router', 'routes.ts')
const routerIndexFilePath = path.join(projectRoot, 'src', 'router', 'index.ts')
const runtimeRoot = path.join(projectRoot, '.local-dev')
const reportPath = path.join(runtimeRoot, 'enterprise-performance-budget-report.json')

/**
 * 企业页面性能预算：
 * - 预算口径聚焦“首屏核心块、高频页面分包、共享依赖块”三类指标；
 * - 当前阈值基于本项目现有依赖体量制定，后续可在同一脚本内持续收紧；
 * - 只要触线即返回非 0，保证性能优化具备回归约束。
 */
const performanceBudget = {
  totalAssetsMaxKB: 3200,
  entryChunkMaxKB: 80,
  loginChunkMaxKB: 25,
  frameworkChunkMaxKB: 220,
  uiKitChunkMaxKB: 980,
  vendorChunkMaxKB: 1500,
  routeChunkMaxKB: {
    DashboardView: 16,
    OrderEntryView: 28,
    OrderListView: 28,
    ProductManageView: 18,
    UserManageView: 26,
    AuditLogView: 18,
  },
}

const expectedKeepAliveRoutes = ['dashboard', 'order-entry', 'order-list', 'products', 'tags', 'system-users', 'system-audit-logs']
const expectedWarmupTargets = ['order-entry', 'order-list', 'products', 'system-users', 'system-audit-logs']
const expectedStableRequestFiles = [
  path.join(projectRoot, 'src', 'views', 'dashboard', 'DashboardView.vue'),
  path.join(projectRoot, 'src', 'views', 'order-list', 'composables', 'useOrderListView.ts'),
  path.join(projectRoot, 'src', 'views', 'system', 'UserManageView.vue'),
  path.join(projectRoot, 'src', 'views', 'system', 'AuditLogView.vue'),
  path.join(projectRoot, 'src', 'composables', 'useCrudManager.ts'),
]

const toKB = (sizeInBytes) => Number((sizeInBytes / 1024).toFixed(2))
const formatKB = (sizeInBytes) => `${toKB(sizeInBytes)} KB`

const readText = (filePath) => fs.readFileSync(filePath, 'utf8')

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message)
  }
}

assert(fs.existsSync(distAssetsRoot), `未找到构建产物目录：${distAssetsRoot}，请先执行 npm run build`)

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

assert(entryChunk, '未找到主入口 index-*.js 构建文件')
assert(loginChunk, '未找到登录页 LoginView-*.js 构建文件')
assert(frameworkChunk, '未找到 framework-*.js 共享框架块')
assert(uiKitChunk, '未找到 ui-kit-*.js UI 组件共享块')
assert(vendorChunk, '未找到 vendor-*.js 第三方共享块')

assert(totalAssetsSize / 1024 <= performanceBudget.totalAssetsMaxKB, `构建总产物超预算：${formatKB(totalAssetsSize)}`)
assert(entryChunk.sizeKB <= performanceBudget.entryChunkMaxKB, `主入口 chunk 超预算：${entryChunk.name} = ${entryChunk.sizeKB} KB`)
assert(loginChunk.sizeKB <= performanceBudget.loginChunkMaxKB, `登录页 chunk 超预算：${loginChunk.name} = ${loginChunk.sizeKB} KB`)
assert(frameworkChunk.sizeKB <= performanceBudget.frameworkChunkMaxKB, `framework chunk 超预算：${frameworkChunk.name} = ${frameworkChunk.sizeKB} KB`)
assert(uiKitChunk.sizeKB <= performanceBudget.uiKitChunkMaxKB, `ui-kit chunk 超预算：${uiKitChunk.name} = ${uiKitChunk.sizeKB} KB`)
assert(vendorChunk.sizeKB <= performanceBudget.vendorChunkMaxKB, `vendor chunk 超预算：${vendorChunk.name} = ${vendorChunk.sizeKB} KB`)

const routeChunkReport = Object.entries(performanceBudget.routeChunkMaxKB).map(([prefix, maxKB]) => {
  const asset = findAssetByPrefix(prefix)
  assert(asset, `未找到 ${prefix}-*.js 路由分包，说明对应页面没有独立拆包`)
  assert(asset.sizeKB <= maxKB, `${prefix} 路由分包超预算：${asset.sizeKB} KB > ${maxKB} KB`)

  return `${prefix}: ${asset.sizeKB} KB`
})

const routesSource = readText(routesFilePath)
const routerIndexSource = readText(routerIndexFilePath)

expectedKeepAliveRoutes.forEach((routeName) => {
  assert(
    routesSource.includes(`name: '${routeName}'`) && routesSource.includes('keepAlive: true'),
    `路由 ${routeName} 未接入 keepAlive 配置`,
  )
})

expectedWarmupTargets.forEach((routeName) => {
  assert(routesSource.includes(`'${routeName}'`), `未找到高频路由 ${routeName} 的预热配置`)
})

assert(routerIndexSource.includes('scheduleRouteComponentWarmup'), '路由后置守卫未接入预热调度')

expectedStableRequestFiles.forEach((filePath) => {
  const source = readText(filePath)
  assert(source.includes('useStableRequest'), `文件未接入稳定请求治理：${filePath}`)
})

/**
 * 写入构建预算验证报告：
 * - 把本次预算口径、chunk 体积与关键断言结果持久化到 .local-dev；
 * - 便于后续对比优化前后差异，也让统一入口输出具备可追溯结果。
 */
fs.mkdirSync(runtimeRoot, { recursive: true })
fs.writeFileSync(
  reportPath,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      performanceBudget,
      totalAssetsKB: toKB(totalAssetsSize),
      chunks: {
        entry: {
          name: entryChunk.name,
          sizeKB: entryChunk.sizeKB,
        },
        login: {
          name: loginChunk.name,
          sizeKB: loginChunk.sizeKB,
        },
        framework: {
          name: frameworkChunk.name,
          sizeKB: frameworkChunk.sizeKB,
        },
        'ui-kit': {
          name: uiKitChunk.name,
          sizeKB: uiKitChunk.sizeKB,
        },
        vendor: {
          name: vendorChunk.name,
          sizeKB: vendorChunk.sizeKB,
        },
      },
      routeChunkReport,
      keepAliveRoutes: expectedKeepAliveRoutes,
      warmupTargets: expectedWarmupTargets,
      stableRequestFiles: expectedStableRequestFiles,
    },
    null,
    2,
  )}\n`,
  'utf8',
)

console.log('性能验证通过')
console.log(`- 构建总产物：${formatKB(totalAssetsSize)}`)
console.log(`- 主入口 chunk：${entryChunk.name} (${entryChunk.sizeKB} KB)`)
console.log(`- 登录页 chunk：${loginChunk.name} (${loginChunk.sizeKB} KB)`)
console.log(`- framework chunk：${frameworkChunk.name} (${frameworkChunk.sizeKB} KB)`)
console.log(`- ui-kit chunk：${uiKitChunk.name} (${uiKitChunk.sizeKB} KB)`)
console.log(`- vendor chunk：${vendorChunk.name} (${vendorChunk.sizeKB} KB)`)
console.log(`- 高频路由分包：${routeChunkReport.join(' | ')}`)
console.log(`- keep-alive 路由：${expectedKeepAliveRoutes.join(', ')}`)
console.log(`- 预热调度：${expectedWarmupTargets.join(', ')}`)
console.log(`- 稳定请求接入文件数：${expectedStableRequestFiles.length}`)
console.log(`- 构建预算报告：${reportPath}`)
