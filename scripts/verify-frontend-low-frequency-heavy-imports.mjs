/**
 * 文件说明：scripts/verify-frontend-low-frequency-heavy-imports.mjs
 * 文件职责：校验前端低频重库是否仍按既定异步策略接入，避免重库重新回流到高频首屏与主路由分包。
 * 实现逻辑：
 * 1. 扫描 `src` 下的源码文件，提取静态导入记录，检查重库是否只出现在允许的入口文件中；
 * 2. 对 `html2pdf.js`、`html5-qrcode` 等明确要求运行时异步加载的库，禁止出现运行时静态导入；
 * 3. 对正式出库单、用户中心、系统配置页、客户端详情页等关键异步入口做结构化断言，防止未来被改回同步加载；
 * 4. 统一输出通过/失败结果，让包体治理与性能验收脚本保持同一口径。
 * 维护说明：
 * - 若未来新增新的低频重库或调整异步拆分方案，需要同步修改 `HEAVY_IMPORT_RULES` 与结构断言；
 * - 若允许某个重库新增稳定入口，必须先补白名单与注释说明，再放行对应改动。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const currentFilePath = fileURLToPath(import.meta.url)
const scriptsRoot = path.dirname(currentFilePath)
const projectRoot = path.resolve(scriptsRoot, '..')
const srcRoot = path.join(projectRoot, 'src')

/**
 * 重库静态导入规则：
 * - `runtimeStaticAllowedFiles` 表示允许“运行时静态导入”的稳定入口；
 * - 未列入白名单的文件，一旦直接 `import xxx from '重库'`，就会被判定为契约回退；
 * - 仅类型导入的场景不计入运行时首包负担，因此默认允许。
 */
const HEAVY_IMPORT_RULES = [
  {
    packageName: 'html2pdf.js',
    runtimeStaticAllowedFiles: new Set(),
    description: 'PDF 导出库必须只在真正导出时通过动态 import 拉起',
  },
  {
    packageName: 'html5-qrcode',
    runtimeStaticAllowedFiles: new Set(),
    description: '扫码库必须延迟到用户触发扫码能力时再加载',
  },
  {
    packageName: 'vue-echarts',
    runtimeStaticAllowedFiles: new Set([
      path.join(srcRoot, 'components', 'charts', 'BaseEChart.vue'),
    ]),
    description: '图表渲染入口统一收口在 BaseEChart 组件，避免页面层直接静态引入',
  },
  {
    packageName: 'qrcode',
    runtimeStaticAllowedFiles: new Set([
      path.join(srcRoot, 'views', 'inbound', 'SupplierDeliveryView.vue'),
      path.join(srcRoot, 'views', 'inbound', 'SupplierHistoryView.vue'),
    ]),
    description: '二维码库仅允许在当前稳定入口静态引入，其余低频页面应保持按需加载',
  },
  {
    packageName: 'browser-image-compression',
    runtimeStaticAllowedFiles: new Set([
      path.join(srcRoot, 'utils', 'image-upload.ts'),
      path.join(srcRoot, 'views', 'o2o', 'O2oProductMallManageView.vue'),
    ]),
    description: '图片压缩库仅允许出现在图片上传主链路，避免无关页面顺带拉起',
  },
]

const ECHARTS_RUNTIME_ALLOWED_FILES = new Set([
  path.join(srcRoot, 'components', 'charts', 'echarts.ts'),
])

const log = (message) => {
  console.log(`[verify-low-frequency-imports] ${message}`)
}

const readUtf8 = (filePath) => fs.readFileSync(filePath, 'utf8')

const walkSourceFiles = (directoryPath) => {
  const filePaths = []
  fs.readdirSync(directoryPath, { withFileTypes: true }).forEach((entry) => {
    const entryPath = path.join(directoryPath, entry.name)
    if (entry.isDirectory()) {
      filePaths.push(...walkSourceFiles(entryPath))
      return
    }

    if (/\.(?:ts|vue)$/i.test(entry.name) && !/\.d\.ts$/i.test(entry.name)) {
      filePaths.push(entryPath)
    }
  })
  return filePaths
}

const getLineNumberByIndex = (source, index) => {
  return source.slice(0, index).split('\n').length
}

/**
 * 抽取静态导入：
 * - 这里仅关心 `import ... from 'xxx'` 这类顶层静态导入；
 * - `import('xxx')` 的动态导入不在这里拦截，由结构断言单独校验。
 */
const extractStaticImports = (source) => {
  const records = []
  const importPattern = /^\s*import\s+(type\s+)?[\s\S]*?\sfrom\s+['"]([^'"]+)['"]/gm
  let match

  while ((match = importPattern.exec(source)) !== null) {
    records.push({
      isTypeOnly: Boolean(match[1]),
      specifier: match[2],
      sourceIndex: match.index,
    })
  }

  return records
}

const assertContains = (filePath, source, pattern, message) => {
  if (pattern instanceof RegExp) {
    assert.match(source, pattern, `${path.relative(projectRoot, filePath)}：${message}`)
    return
  }

  assert.ok(source.includes(pattern), `${path.relative(projectRoot, filePath)}：${message}`)
}

const main = () => {
  const sourceFiles = walkSourceFiles(srcRoot)
  assert.ok(sourceFiles.length > 0, '未扫描到前端源码文件，无法执行低频重库校验')

  const violations = []

  sourceFiles.forEach((filePath) => {
    const source = readUtf8(filePath)
    const staticImports = extractStaticImports(source)

    staticImports.forEach((record) => {
      const normalizedSpecifier = record.specifier.trim()

      HEAVY_IMPORT_RULES.forEach((rule) => {
        if (normalizedSpecifier !== rule.packageName) {
          return
        }

        if (record.isTypeOnly) {
          return
        }

        if (!rule.runtimeStaticAllowedFiles.has(filePath)) {
          violations.push(
            `${path.relative(projectRoot, filePath)}:${getLineNumberByIndex(source, record.sourceIndex)} 不允许静态导入 ${rule.packageName}。${rule.description}`,
          )
        }
      })

      const isRuntimeEchartsImport = !record.isTypeOnly
        && (normalizedSpecifier === 'echarts' || normalizedSpecifier.startsWith('echarts/'))
      if (isRuntimeEchartsImport && !ECHARTS_RUNTIME_ALLOWED_FILES.has(filePath)) {
        violations.push(
          `${path.relative(projectRoot, filePath)}:${getLineNumberByIndex(source, record.sourceIndex)} 不允许直接静态导入 ${normalizedSpecifier}。运行时图表能力必须统一收口到 components/charts/echarts.ts`,
        )
      }
    })
  })

  assert.equal(violations.length, 0, `发现低频重库静态导入回退：\n- ${violations.join('\n- ')}`)

  const orderListViewPath = path.join(srcRoot, 'views', 'order-list', 'OrderListView.vue')
  const orderListViewSource = readUtf8(orderListViewPath)
  assertContains(
    orderListViewPath,
    orderListViewSource,
    "defineAsyncComponent(() => import('./components/OrderVoucherWorkbenchDialog.vue'))",
    '正式出库单工作台必须继续保持异步组件入口',
  )

  const orderVoucherDialogPath = path.join(srcRoot, 'views', 'order-list', 'components', 'OrderVoucherWorkbenchDialog.vue')
  const orderVoucherDialogSource = readUtf8(orderVoucherDialogPath)
  assert.doesNotMatch(
    orderVoucherDialogSource,
    /import\s+.+from\s+['"]html2pdf\.js['"]/,
    `${path.relative(projectRoot, orderVoucherDialogPath)}：正式出库单工作台不得直接静态导入 html2pdf.js`,
  )
  assertContains(
    orderVoucherDialogPath,
    orderVoucherDialogSource,
    "import { exportVoucherPdf } from '@/utils/pdf/export-voucher-pdf'",
    '正式出库单工作台必须继续经由统一 PDF 异步导出封装',
  )

  const exportVoucherPdfPath = path.join(srcRoot, 'utils', 'pdf', 'export-voucher-pdf.ts')
  const exportVoucherPdfSource = readUtf8(exportVoucherPdfPath)
  assertContains(
    exportVoucherPdfPath,
    exportVoucherPdfSource,
    "const module = await import('html2pdf.js')",
    'PDF 导出封装必须在运行时动态拉起 html2pdf.js',
  )

  const clientOrderDetailViewPath = path.join(srcRoot, 'views', 'client', 'ClientOrderDetailView.vue')
  const clientOrderDetailViewSource = readUtf8(clientOrderDetailViewPath)
  assertContains(
    clientOrderDetailViewPath,
    clientOrderDetailViewSource,
    "const loadVoucherPdfExportModule = () => import('@/utils/pdf/export-voucher-pdf')",
    '客户端订单详情必须继续按需加载 PDF 导出能力',
  )
  assertContains(
    clientOrderDetailViewPath,
    clientOrderDetailViewSource,
    "qrCodeModulePromise = import('qrcode')",
    '客户端订单详情必须继续按需加载二维码渲染能力',
  )

  const userCenterViewPath = path.join(srcRoot, 'views', 'system', 'UserCenterView.vue')
  const userCenterViewSource = readUtf8(userCenterViewPath)
  assertContains(
    userCenterViewPath,
    userCenterViewSource,
    'const UserManageView = defineAsyncComponent(userCenterTabLoaders.management)',
    '用户中心必须继续把管理端用户页作为异步标签组件加载',
  )
  assertContains(
    userCenterViewPath,
    userCenterViewSource,
    'const ClientUserManageView = defineAsyncComponent(userCenterTabLoaders.client)',
    '用户中心必须继续把客户端用户页作为异步标签组件加载',
  )

  const routePerformancePath = path.join(srcRoot, 'router', 'route-performance.ts')
  const routePerformanceSource = readUtf8(routePerformancePath)
  assertContains(
    routePerformancePath,
    routePerformanceSource,
    "'system-configs': () => import('@/views/system/SystemConfigViewLoader')",
    '系统配置路由必须继续经过独立异步入口，避免治理页同步回流到主路由分包',
  )

  const baseEChartPath = path.join(srcRoot, 'components', 'charts', 'BaseEChart.vue')
  const baseEChartSource = readUtf8(baseEChartPath)
  assertContains(
    baseEChartPath,
    baseEChartSource,
    "import VChart from 'vue-echarts'",
    'BaseEChart 必须继续作为 vue-echarts 的统一运行时入口',
  )

  log(`共扫描 ${sourceFiles.length} 个前端源码文件，未发现低频重库静态导入回退`)
  log('正式出库单、客户端详情、用户中心、系统治理页的异步入口契约通过')
}

try {
  main()
  console.log('前端低频重库静态导入检查通过')
} catch (error) {
  console.error('前端低频重库静态导入检查失败', error)
  process.exit(1)
}
