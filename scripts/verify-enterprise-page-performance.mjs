import fs from 'node:fs'
import path from 'node:path'

const projectRoot = process.cwd()
const distAssetsRoot = path.join(projectRoot, 'dist', 'assets')
const routesFilePath = path.join(projectRoot, 'src', 'router', 'routes.ts')
const routerIndexFilePath = path.join(projectRoot, 'src', 'router', 'index.ts')
const runtimeRoot = path.join(projectRoot, '.local-dev')
const reportPath = path.join(runtimeRoot, 'enterprise-performance-budget-report.json')

const performanceBudget = {
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
      throw new Error(`File not found: ${filePath}. Run this script from the project root after npm run build.`)
    }
    throw error
  }
}

assert(fs.existsSync(distAssetsRoot), `Build output not found: ${distAssetsRoot}. Run npm run build first.`)

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
  assert(asset, `Missing low-frequency chunk: ${prefix}-*.js`)
  assert(asset.sizeKB <= maxKB, `${prefix} low-frequency chunk exceeds budget: ${asset.sizeKB} KB > ${maxKB} KB`)
  return {
    prefix,
    name: asset.name,
    size: asset.size,
    sizeKB: asset.sizeKB,
    maxKB,
  }
})
const lowFrequencyAssetsSize = lowFrequencyChunks.reduce((sum, entry) => sum + entry.size, 0)
const criticalAssetsSize = totalAssetsSize - lowFrequencyAssetsSize

assert(entryChunk, 'Missing entry chunk index-*.js')
assert(loginChunk, 'Missing login chunk LoginView-*.js')
assert(frameworkChunk, 'Missing framework chunk framework-*.js')
assert(uiKitChunk, 'Missing UI chunk ui-kit-*.js')
assert(vendorChunk, 'Missing vendor chunk vendor-*.js')

assert(criticalAssetsSize / 1024 <= performanceBudget.criticalAssetsMaxKB, `Critical assets exceed budget: ${formatKB(criticalAssetsSize)}`)
assert(entryChunk.sizeKB <= performanceBudget.entryChunkMaxKB, `Entry chunk exceeds budget: ${entryChunk.name} = ${entryChunk.sizeKB} KB`)
assert(loginChunk.sizeKB <= performanceBudget.loginChunkMaxKB, `Login chunk exceeds budget: ${loginChunk.name} = ${loginChunk.sizeKB} KB`)
assert(frameworkChunk.sizeKB <= performanceBudget.frameworkChunkMaxKB, `Framework chunk exceeds budget: ${frameworkChunk.name} = ${frameworkChunk.sizeKB} KB`)
assert(uiKitChunk.sizeKB <= performanceBudget.uiKitChunkMaxKB, `UI chunk exceeds budget: ${uiKitChunk.name} = ${uiKitChunk.sizeKB} KB`)
assert(vendorChunk.sizeKB <= performanceBudget.vendorChunkMaxKB, `Vendor chunk exceeds budget: ${vendorChunk.name} = ${vendorChunk.sizeKB} KB`)

const routeChunkReport = Object.entries(performanceBudget.routeChunkMaxKB).map(([prefix, maxKB]) => {
  const asset = findAssetByPrefix(prefix)
  assert(asset, `Missing route chunk: ${prefix}-*.js`)
  assert(asset.sizeKB <= maxKB, `${prefix} route chunk exceeds budget: ${asset.sizeKB} KB > ${maxKB} KB`)

  return `${prefix}: ${asset.sizeKB} KB`
})
const lowFrequencyChunkReport = lowFrequencyChunks.map((entry) => `${entry.prefix}: ${entry.sizeKB} KB`)

const routesSource = readText(routesFilePath)
const routerIndexSource = readText(routerIndexFilePath)

expectedKeepAliveRoutes.forEach((routeName) => {
  assert(
    routesSource.includes(`name: '${routeName}'`) && routesSource.includes('keepAlive: true'),
    `Route ${routeName} is not wired to keepAlive`,
  )
})

expectedWarmupTargets.forEach((routeName) => {
  assert(routesSource.includes(`'${routeName}'`), `Warmup target missing: ${routeName}`)
})

expectedColdStartDeferredRoutes.forEach((routeName) => {
  assert(
    routesSource.includes(`name: '${routeName}'`) && routesSource.includes('deferPreloadOnColdStart: true'),
    `Cold-start deferred route missing: ${routeName}`,
  )
})

assert(routerIndexSource.includes('scheduleRouteComponentWarmup'), 'Route warmup scheduler is not wired')

expectedStableRequestFiles.forEach((filePath) => {
  const source = readText(filePath)
  assert(source.includes('useStableRequest'), `Stable request guard missing: ${filePath}`)
})

fs.mkdirSync(runtimeRoot, { recursive: true })
fs.writeFileSync(
  reportPath,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      performanceBudget,
      totalAssetsKB: toKB(totalAssetsSize),
      criticalAssetsKB: toKB(criticalAssetsSize),
      lowFrequencyAssetsKB: toKB(lowFrequencyAssetsSize),
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
      lowFrequencyChunkReport,
      routeChunkReport,
      keepAliveRoutes: expectedKeepAliveRoutes,
      warmupTargets: expectedWarmupTargets,
      coldStartDeferredRoutes: expectedColdStartDeferredRoutes,
      stableRequestFiles: expectedStableRequestFiles,
    },
    null,
    2,
  )}\n`,
  'utf8',
)

console.log('Performance budget verification passed')
console.log(`- total assets: ${formatKB(totalAssetsSize)}`)
console.log(`- critical assets: ${formatKB(criticalAssetsSize)}`)
console.log(`- low-frequency chunks: ${lowFrequencyChunkReport.join(' | ')}`)
console.log(`- entry chunk: ${entryChunk.name} (${entryChunk.sizeKB} KB)`)
console.log(`- login chunk: ${loginChunk.name} (${loginChunk.sizeKB} KB)`)
console.log(`- framework chunk: ${frameworkChunk.name} (${frameworkChunk.sizeKB} KB)`)
console.log(`- ui-kit chunk: ${uiKitChunk.name} (${uiKitChunk.sizeKB} KB)`)
console.log(`- vendor chunk: ${vendorChunk.name} (${vendorChunk.sizeKB} KB)`)
console.log(`- high-frequency route chunks: ${routeChunkReport.join(' | ')}`)
console.log(`- keep-alive routes: ${expectedKeepAliveRoutes.join(', ')}`)
console.log(`- warmup targets: ${expectedWarmupTargets.join(', ')}`)
console.log(`- stable request files: ${expectedStableRequestFiles.length}`)
console.log(`- report: ${reportPath}`)
