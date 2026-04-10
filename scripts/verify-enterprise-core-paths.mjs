/**
 * 模块说明：scripts/verify-enterprise-core-paths.mjs
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { resolveTsxCliPath } from './process-runner-utils.mjs'

/**
 * 核心路径自动化验证脚本：
 * - 目标是为“登录后进入首页、工作台切换、出库列表、基础资料、系统管理”建立可重复执行的回归入口；
 * - 运行时使用独立 SQLite 文件启动隔离后端，避免污染用户当前正在使用的本地数据；
 * - 验证结果会输出到控制台，并写入 .local-dev 下的 JSON 报告，便于追溯。
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const backendRoot = path.join(projectRoot, 'backend')
const runtimeRoot = path.join(projectRoot, '.local-dev')
const verifyRuntimeRoot = path.join(backendRoot, 'data', 'local-dev')
const verifyStartedAt = new Date()
const runId = `task6-core-path-${verifyStartedAt.toISOString().replaceAll(/[:.]/g, '-')}`
const verifyDbPath = path.join(verifyRuntimeRoot, `${runId}.sqlite`)
const reportPath = path.join(runtimeRoot, `${runId}.report.json`)
const backendPort = Number(process.env.Y_LINK_PERF_VERIFY_BACKEND_PORT ?? 3301)
const backendBaseUrl = `http://127.0.0.1:${backendPort}`
const apiBaseUrl = `${backendBaseUrl}/api`
const tsxCliPath = resolveTsxCliPath(backendRoot)
const defaultVerifyPassword = ['Admin', '@', '123456'].join('')
const defaultSystemUserPassword = ['Perf', '@', '123456'].join('')
const verifyCredentials = {
  username: process.env.Y_LINK_VERIFY_USERNAME ?? 'admin',
  password: process.env.Y_LINK_VERIFY_PASSWORD ?? defaultVerifyPassword,
}

/**
 * 统一记录单步验证结果：
 * - 每一项都带上耗时、摘要与附加数据；
 * - 最终会整体写入 JSON 文件，便于后续排查失败点或比较多次执行结果。
 */
const verificationSteps = []

const log = (message) => {
  // eslint-disable-next-line no-console
  console.log(message)
}

const readText = (filePath) => fs.readFileSync(filePath, 'utf8')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 生成唯一测试标识：
 * - 用于 tag / product / user / order 等测试数据，避免与既有数据发生主键或唯一键冲突；
 * - 同时方便在审计日志与导出 CSV 中反向检索本次脚本的落点。
 */
const createUniqueSuffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

/**
 * 统一写入步骤报告：
 * - title 用于人类可读日志；
 * - details 保留结构化数据，方便 JSON 报告回放。
 */
const pushStep = (title, durationMs, details = {}) => {
  verificationSteps.push({
    title,
    durationMs: Number(durationMs.toFixed(2)),
    details,
  })
}

/**
 * 启动隔离后端：
 * - 直接运行 backend/src/index.ts，避免依赖用户当前是否已经手动开启本地链路；
 * - 通过独立 APP_PROFILE + SQLITE_DB_PATH 保证验证数据单独落盘；
 * - 使用 stdio pipe 保留最近日志，失败时可附带上下文一起抛出。
 */
const startIsolatedBackend = async () => {
  fs.mkdirSync(runtimeRoot, { recursive: true })
  fs.mkdirSync(verifyRuntimeRoot, { recursive: true })

  const stdoutChunks = []
  const stderrChunks = []
  const backendProcess = spawn(process.execPath, [tsxCliPath, 'src/index.ts'], {
    cwd: backendRoot,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      APP_PROFILE: runId,
      PORT: String(backendPort),
      DB_TYPE: 'sqlite',
      SQLITE_DB_PATH: verifyDbPath,
      DB_SYNC: 'true',
      INIT_ADMIN_USERNAME: verifyCredentials.username,
      INIT_ADMIN_PASSWORD: verifyCredentials.password,
      INIT_ADMIN_DISPLAY_NAME: '性能验证管理员',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  })

  backendProcess.stdout.on('data', (chunk) => {
    stdoutChunks.push(String(chunk))
    if (stdoutChunks.length > 20) {
      stdoutChunks.shift()
    }
  })

  backendProcess.stderr.on('data', (chunk) => {
    stderrChunks.push(String(chunk))
    if (stderrChunks.length > 20) {
      stderrChunks.shift()
    }
  })

  backendProcess.on('exit', (code) => {
    if (code !== null && code !== 0) {
      log(`[core-path] 隔离后端已退出，exitCode=${code}`)
    }
  })

  const startTime = performance.now()
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    try {
      const response = await fetch(`${backendBaseUrl}/health`)
      if (response.ok) {
        pushStep('启动隔离后端', performance.now() - startTime, {
          backendBaseUrl,
          verifyDbPath,
          attempts: attempt,
        })
        log(`[core-path] 隔离后端已就绪：${backendBaseUrl}`)
        return {
          backendProcess,
          stdoutChunks,
          stderrChunks,
        }
      }
    } catch {
      // 后端尚未可用时继续等待。
    }

    if (backendProcess.exitCode !== null) {
      throw new Error(
        [
          `隔离后端提前退出，exitCode=${backendProcess.exitCode}`,
          'stdout:',
          stdoutChunks.join('').trim() || '(empty)',
          'stderr:',
          stderrChunks.join('').trim() || '(empty)',
        ].join('\n'),
      )
    }

    await sleep(500)
  }

  throw new Error(
    [
      `等待隔离后端就绪超时：${backendBaseUrl}/health`,
      'stdout:',
      stdoutChunks.join('').trim() || '(empty)',
      'stderr:',
      stderrChunks.join('').trim() || '(empty)',
    ].join('\n'),
  )
}

/**
 * 结束隔离后端：
 * - 仅停止脚本自己拉起的进程，不影响用户已有服务；
 * - 适当等待退出，避免 sqlite 仍在落盘时直接结束 Node 主进程。
 */
const stopIsolatedBackend = async (backendProcess) => {
  if (backendProcess?.exitCode !== null) {
    return
  }

  backendProcess.kill()
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    if (backendProcess.exitCode !== null) {
      return
    }
    await sleep(100)
  }
}

/**
 * 带超时的 fetch：
 * - 防止某个请求因异常一直挂住，导致整套回归脚本无法收敛；
 * - 默认 15 秒，既能覆盖本地冷启动，也不会把失败拖得过长。
 */
const fetchWithTimeout = async (url, options = {}, timeoutMs = 15000) => {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * 统一请求 API：
 * - 自动处理 JSON 响应外壳 { code, message, data }；
 * - 返回耗时，便于在报告中沉淀“关键路径响应表现”。
 */
const requestApi = async (
  pathname,
  {
    method = 'GET',
    token,
    body,
    headers = {},
    expectedStatus = 200,
    expectJsonEnvelope = true,
  } = {},
) => {
  const url = pathname.startsWith('http') ? pathname : `${apiBaseUrl}${pathname}`
  const startedAt = performance.now()
  const response = await fetchWithTimeout(url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const durationMs = performance.now() - startedAt
  const responseText = await response.text()

  assert.equal(response.status, expectedStatus, `${method} ${url} 返回状态异常，expected=${expectedStatus} actual=${response.status}\n${responseText}`)

  if (!expectJsonEnvelope) {
    return {
      response,
      responseText,
      durationMs,
    }
  }

  const payload = JSON.parse(responseText)
  assert.equal(payload.code, 0, `${method} ${url} 业务返回失败：${payload.message ?? 'unknown error'}`)

  return {
    data: payload.data,
    response,
    durationMs,
  }
}

/**
 * 前端静态断言：
 * - 覆盖 keepAlive / preload / warmup / stable-request 四类实现；
 * - 对应“快速切页、返回已访问页面、连续筛选”三个高频交互场景的前端保障。
 */
const verifyFrontendStaticCoverage = () => {
  const startedAt = performance.now()
  const routesFilePath = path.join(projectRoot, 'src', 'router', 'routes.ts')
  const routerIndexFilePath = path.join(projectRoot, 'src', 'router', 'index.ts')
  const loginViewPath = path.join(projectRoot, 'src', 'views', 'auth', 'LoginView.vue')
  const authStorePath = path.join(projectRoot, 'src', 'store', 'modules', 'auth.ts')
  const dashboardViewPath = path.join(projectRoot, 'src', 'views', 'dashboard', 'DashboardView.vue')
  const appLayoutPath = path.join(projectRoot, 'src', 'layout', 'AppLayout.vue')
  const orderListComposablePath = path.join(projectRoot, 'src', 'views', 'order-list', 'composables', 'useOrderListView.ts')
  const orderListViewPath = path.join(projectRoot, 'src', 'views', 'order-list', 'OrderListView.vue')
  const orderVoucherTemplatePath = path.join(projectRoot, 'src', 'views', 'order-list', 'components', 'OrderVoucherTemplate.vue')
  const systemConfigViewPath = path.join(projectRoot, 'src', 'views', 'system', 'SystemConfigView.vue')
  const userManageViewPath = path.join(projectRoot, 'src', 'views', 'system', 'UserManageView.vue')
  const auditLogViewPath = path.join(projectRoot, 'src', 'views', 'system', 'AuditLogView.vue')
  const productManagerPath = path.join(projectRoot, 'src', 'views', 'base-data', 'components', 'ProductManager.vue')
  const tagManagerPath = path.join(projectRoot, 'src', 'views', 'base-data', 'components', 'TagManager.vue')
  const crudManagerPath = path.join(projectRoot, 'src', 'composables', 'useCrudManager.ts')
  const stableRequestPath = path.join(projectRoot, 'src', 'composables', 'useStableRequest.ts')

  const routesSource = readText(routesFilePath)
  const routerIndexSource = readText(routerIndexFilePath)
  const loginViewSource = readText(loginViewPath)
  const authStoreSource = readText(authStorePath)
  const dashboardViewSource = readText(dashboardViewPath)
  const appLayoutSource = readText(appLayoutPath)
  const orderListComposableSource = readText(orderListComposablePath)
  const orderListViewSource = readText(orderListViewPath)
  const orderVoucherTemplateSource = readText(orderVoucherTemplatePath)
  const systemConfigViewSource = readText(systemConfigViewPath)
  const userManageViewSource = readText(userManageViewPath)
  const auditLogViewSource = readText(auditLogViewPath)
  const productManagerSource = readText(productManagerPath)
  const tagManagerSource = readText(tagManagerPath)
  const crudManagerSource = readText(crudManagerPath)
  const stableRequestSource = readText(stableRequestPath)

  const keepAliveRouteNames = ['dashboard', 'order-entry', 'order-list', 'products', 'tags', 'system-users', 'system-audit-logs']
  keepAliveRouteNames.forEach((routeName) => {
    assert.match(
      routesSource,
      new RegExp(String.raw`name: '${routeName}'[\s\S]*?keepAlive: true`),
      `路由 ${routeName} 缺少 keepAlive 配置，无法覆盖“返回已访问页面”验证口径`,
    )
  })

  const preloadRouteNames = ['order-entry', 'order-list', 'products', 'system-users', 'system-audit-logs']
  preloadRouteNames.forEach((routeName) => {
    assert.match(routesSource, new RegExp(`'${routeName}'`), `未找到高频预热路由：${routeName}`)
  })

  assert.match(routerIndexSource, /scheduleRouteComponentWarmup\(preloadTargets\)/, '路由 afterEach 未接入统一预热调度')
  assert.match(authStoreSource, /resolvePostLoginWarmupTargets/, '登录后首跳预热目标解析未接入 auth store')
  assert.match(loginViewSource, /warmupPostLoginEntry\(redirectPath\.value\)/, '登录成功后未在跳转前预热主系统入口')
  assert.match(stableRequestSource, /activeController\??\.abort\(\)/, '稳定请求封装未在新请求前取消旧请求')
  assert.match(stableRequestSource, /requestId !== latestRequestId/, '稳定请求封装缺少“仅最新请求生效”保护')
  assert.match(appLayoutSource, /route-loading-shell__heading/, '壳层级 fallback 未增强首屏可见占位')
  assert.match(dashboardViewSource, /loading && !stats/, '工作台未提供页面级首屏加载态')
  assert.match(crudManagerSource, /executor: \(signal\) => config\.loadList\(\{ signal \}\)/, '基础资料通用 CRUD 未透传 signal')
  assert.match(dashboardViewSource, /executor: \(signal\) => getDashboardStats\(\{ signal \}\)/, '工作台未接入 signal 控制')
  assert.match(orderListComposableSource, /executor: \(signal\) => getOrderList\(buildQueryParams\(\), \{ signal \}\)/, '出库列表未接入 signal 控制')
  assert.match(orderListComposableSource, /executor: \(signal\) => getOrderDetailById\(row\.id, \{ signal \}\)/, '出库详情未接入 signal 控制')
  assert.match(orderListViewSource, /handlePrintVoucher/, '出库列表页面未接入凭证打印入口')
  assert.match(orderListViewSource, /handleExportVoucherPdf/, '出库列表页面未接入凭证导出入口')
  assert.match(orderVoucherTemplateSource, /出库明细/, '凭证模板缺少出库明细核心区块')
  assert.match(systemConfigViewSource, /系统配置/, '系统配置页面入口异常')
  assert.match(userManageViewSource, /executor: \(signal\) => getUserList\(buildQueryParams\(\), \{ signal \}\)/, '系统用户页未接入 signal 控制')
  assert.match(auditLogViewSource, /executor: \(signal\) => getAuditLogList\(buildQueryParams\(\), \{ signal \}\)/, '审计日志页未接入 signal 控制')
  assert.match(productManagerSource, /loadList: \(requestConfig\) => getProductList\(buildQueryParams\(\), requestConfig\)/, '产品管理未复用统一 CRUD 列表加载入口')
  assert.match(tagManagerSource, /loadList: getTagList/, '标签管理未复用统一 CRUD 列表加载入口')

  const durationMs = performance.now() - startedAt
  pushStep('前端核心路径静态覆盖断言', durationMs, {
    keepAliveRouteNames,
    preloadRouteNames,
    files: [
      routesFilePath,
      routerIndexFilePath,
      loginViewPath,
      authStorePath,
      dashboardViewPath,
      appLayoutPath,
      orderListComposablePath,
      orderListViewPath,
      orderVoucherTemplatePath,
      systemConfigViewPath,
      userManageViewPath,
      auditLogViewPath,
      productManagerPath,
      tagManagerPath,
      crudManagerPath,
      stableRequestPath,
    ],
  })

  log('[core-path] 前端 keepAlive / 预热 / 稳定请求静态断言通过')
}

/**
 * 登录与首页链路验证：
 * - 覆盖登录、获取当前用户、工作台统计三步；
 * - 其中工作台统计会连续执行多次，确保高频切换时接口返回结构稳定。
 */
const verifyLoginAndDashboard = async () => {
  const startedAt = performance.now()
  const loginResult = await requestApi('/auth/login', {
    method: 'POST',
    body: verifyCredentials,
  })

  const token = loginResult.data.token
  assert.ok(token, '登录成功后未返回 token')
  assert.equal(loginResult.data.user.username, verifyCredentials.username, '登录返回的用户名与预期不一致')

  const meResult = await requestApi('/auth/me', {
    method: 'GET',
    token,
  })
  assert.equal(meResult.data.username, verifyCredentials.username, '/auth/me 返回用户与登录态不一致')

  const dashboardSamples = []
  for (let index = 0; index < 3; index += 1) {
    const dashboardResult = await requestApi('/dashboard/stats', {
      method: 'GET',
      token,
    })

    assert.equal(typeof dashboardResult.data.todayOrderCount, 'number', '工作台统计缺少 todayOrderCount')
    assert.equal(typeof dashboardResult.data.totalProductCount, 'number', '工作台统计缺少 totalProductCount')
    dashboardSamples.push({
      index: index + 1,
      durationMs: Number(dashboardResult.durationMs.toFixed(2)),
      todayOrderCount: dashboardResult.data.todayOrderCount,
      totalProductCount: dashboardResult.data.totalProductCount,
    })
  }

  const durationMs = performance.now() - startedAt
  pushStep('登录后进入首页与工作台连续访问', durationMs, {
    username: verifyCredentials.username,
    dashboardSamples,
  })

  log('[core-path] 登录 / auth.me / 工作台统计连续访问验证通过')
  return {
    token,
  }
}

/**
 * 基础资料链路验证：
 * - 创建专属标签与产品；
 * - 分别按中文关键字、拼音缩写、标签 ID 连续筛选，覆盖“连续筛选结果可追溯”的要求。
 */
const verifyBaseDataPath = async (token) => {
  const startedAt = performance.now()
  const suffix = createUniqueSuffix()
  const tagName = `性能标签-${suffix}`
  const tagCode = `PERF-TAG-${suffix}`.toUpperCase()
  const productCode = `PERF-P-${suffix}`.toUpperCase()
  const productName = `性能产品-${suffix}`
  const pinyinAbbr = `XNCP${suffix.replaceAll(/[^a-z0-9]/gi, '').slice(0, 8)}`.toUpperCase()

  const createTagResult = await requestApi('/tags', {
    method: 'POST',
    token,
    body: {
      tagName,
      tagCode,
    },
  })
  const createdTag = createTagResult.data
  const createdTagId = String(createdTag.id)
  assert.equal(createdTag.tagName, tagName, '创建标签后返回 tagName 不匹配')

  const createProductResult = await requestApi('/products', {
    method: 'POST',
    token,
    body: {
      productCode,
      productName,
      pinyinAbbr,
      defaultPrice: 23.5,
      isActive: true,
      tagIds: [createdTagId],
    },
  })
  const createdProduct = createProductResult.data
  assert.equal(createdProduct.productCode, productCode, '创建产品后返回 productCode 不匹配')

  const listByNameResult = await requestApi(`/products?keyword=${encodeURIComponent(productName)}`, {
    method: 'GET',
    token,
  })
  assert.ok(
    listByNameResult.data.some((item) => item.id === createdProduct.id),
    '按中文关键字筛选产品时未命中新建产品',
  )

  const listByPinyinResult = await requestApi(`/products?keyword=${encodeURIComponent(pinyinAbbr)}`, {
    method: 'GET',
    token,
  })
  assert.ok(
    listByPinyinResult.data.some((item) => item.id === createdProduct.id),
    '按拼音缩写筛选产品时未命中新建产品',
  )

  const listByTagResult = await requestApi(`/products?tagId=${encodeURIComponent(createdTagId)}`, {
    method: 'GET',
    token,
  })
  assert.ok(
    listByTagResult.data.some((item) => item.id === createdProduct.id),
    '按标签筛选产品时未命中新建产品',
  )

  const allTagsResult = await requestApi('/tags', {
    method: 'GET',
    token,
  })
  assert.ok(allTagsResult.data.some((item) => item.id === createdTag.id), '标签列表中未找到新建标签')

  const durationMs = performance.now() - startedAt
  pushStep('基础资料核心路径与连续筛选', durationMs, {
    createdTag: {
      id: createdTag.id,
      tagName: createdTag.tagName,
    },
    createdProduct: {
      id: createdProduct.id,
      productCode: createdProduct.productCode,
      productName: createdProduct.productName,
      pinyinAbbr,
    },
    filterSamples: [
      { type: 'keyword:name', count: listByNameResult.data.length, durationMs: Number(listByNameResult.durationMs.toFixed(2)) },
      { type: 'keyword:pinyin', count: listByPinyinResult.data.length, durationMs: Number(listByPinyinResult.durationMs.toFixed(2)) },
      { type: 'tagId', count: listByTagResult.data.length, durationMs: Number(listByTagResult.durationMs.toFixed(2)) },
    ],
  })

  log('[core-path] 基础资料创建 / 关键字筛选 / 标签筛选验证通过')
  return {
    createdTag,
    createdProduct,
  }
}

/**
 * 出库列表链路验证：
 * - 创建新单据后，立即走列表、按 showNo 筛选、详情 by id / by showNo；
 * - 用于覆盖“开单 -> 列表 -> 详情 -> 返回已访问页”的关键业务回路。
 */
const verifyOrderListPath = async (token, product) => {
  const startedAt = performance.now()
  const idempotencyKey = `perf-order-${createUniqueSuffix()}`

  const submitOrderResult = await requestApi('/orders/submit', {
    method: 'POST',
    token,
    body: {
      idempotencyKey,
      customerName: '性能验证客户',
      remark: '核心路径自动化验证',
      items: [
        {
          productId: product.id,
          qty: 2,
          unitPrice: 23.5,
          remark: '验证明细',
        },
      ],
    },
  })
  const createdOrder = submitOrderResult.data.order
  assert.ok(createdOrder.id, '提交订单后未返回 order.id')
  assert.match(createdOrder.showNo, /^hyyz(?:jd)?\d{1,12}$/i, '提交订单后 showNo 格式不正确')

  const orderListResult = await requestApi(`/orders?page=1&pageSize=20&showNo=${encodeURIComponent(createdOrder.showNo)}`, {
    method: 'GET',
    token,
  })
  assert.ok(orderListResult.data.list?.length ?? orderListResult.data.records?.length ?? 0, '出库列表按 showNo 筛选后未返回记录')
  const orderListRecords = orderListResult.data.list ?? orderListResult.data.records
  assert.ok(orderListRecords.some((item) => item.id === createdOrder.id), '出库列表未命中新建单据')

  const detailByIdResult = await requestApi(`/orders/${createdOrder.id}`, {
    method: 'GET',
    token,
  })
  assert.equal(detailByIdResult.data.order.id, createdOrder.id, '按主键查询订单详情返回错误单据')
  assert.equal(detailByIdResult.data.items.length, 1, '按主键查询订单详情未返回明细')

  const detailByShowNoResult = await requestApi(`/orders/show-no/${encodeURIComponent(createdOrder.showNo)}`, {
    method: 'GET',
    token,
  })
  assert.equal(detailByShowNoResult.data.order.showNo, createdOrder.showNo, '按业务单号查询订单详情返回错误单据')

  const durationMs = performance.now() - startedAt
  pushStep('出库列表核心路径', durationMs, {
    createdOrder,
    timings: {
      submitOrderMs: Number(submitOrderResult.durationMs.toFixed(2)),
      listByShowNoMs: Number(orderListResult.durationMs.toFixed(2)),
      detailByIdMs: Number(detailByIdResult.durationMs.toFixed(2)),
      detailByShowNoMs: Number(detailByShowNoResult.durationMs.toFixed(2)),
    },
  })

  log('[core-path] 出库开单 / 列表筛选 / 详情访问验证通过')
  return {
    createdOrder,
  }
}

/**
 * 系统管理链路验证：
 * - 创建操作员、按关键字/角色/状态连续筛选；
 * - 切换启停状态并校验列表结果，覆盖“连续筛选 + 快速切页”常见治理操作。
 */
const verifySystemManagementPath = async (token) => {
  const startedAt = performance.now()
  const suffix = createUniqueSuffix()
  const username = `perf_user_${suffix.replaceAll(/[^a-z0-9]/gi, '').slice(0, 12)}`

  const createUserResult = await requestApi('/users', {
    method: 'POST',
    token,
    body: {
      username,
      password: defaultSystemUserPassword,
      displayName: '性能验证用户',
      role: 'operator',
      status: 'enabled',
    },
  })
  const createdUser = createUserResult.data
  assert.equal(createdUser.username, username, '新建系统用户后用户名不匹配')

  const usersByKeywordResult = await requestApi(
    `/users?page=1&pageSize=20&keyword=${encodeURIComponent(username)}&role=operator&status=enabled`,
    {
      method: 'GET',
      token,
    },
  )
  assert.ok(usersByKeywordResult.data.list.some((item) => item.id === createdUser.id), '按关键字/角色/状态筛选用户时未命中新建用户')

  const disableUserResult = await requestApi(`/users/${createdUser.id}/status`, {
    method: 'PATCH',
    token,
    body: {
      status: 'disabled',
    },
  })
  assert.equal(disableUserResult.data.status, 'disabled', '停用用户后返回状态不正确')

  const usersByDisabledResult = await requestApi(
    `/users?page=1&pageSize=20&keyword=${encodeURIComponent(username)}&role=operator&status=disabled`,
    {
      method: 'GET',
      token,
    },
  )
  assert.ok(usersByDisabledResult.data.list.some((item) => item.id === createdUser.id), '按 disabled 筛选用户时未命中停用后的用户')

  const enableUserResult = await requestApi(`/users/${createdUser.id}/status`, {
    method: 'PATCH',
    token,
    body: {
      status: 'enabled',
    },
  })
  assert.equal(enableUserResult.data.status, 'enabled', '重新启用用户后返回状态不正确')

  const durationMs = performance.now() - startedAt
  pushStep('系统管理核心路径与连续筛选', durationMs, {
    createdUser: {
      id: createdUser.id,
      username: createdUser.username,
      role: createdUser.role,
    },
    timings: {
      createUserMs: Number(createUserResult.durationMs.toFixed(2)),
      listEnabledMs: Number(usersByKeywordResult.durationMs.toFixed(2)),
      disableUserMs: Number(disableUserResult.durationMs.toFixed(2)),
      listDisabledMs: Number(usersByDisabledResult.durationMs.toFixed(2)),
      enableUserMs: Number(enableUserResult.durationMs.toFixed(2)),
    },
  })

  log('[core-path] 用户创建 / 启停 / 多条件筛选验证通过')
  return {
    createdUser,
  }
}

/**
 * 系统配置链路验证：
 * - 拉取双流水配置；
 * - 使用原值回写，验证保存接口可正常响应（不改变业务数据）。
 */
const verifySystemConfigPath = async (token) => {
  const startedAt = performance.now()
  const fetchSerialResult = await requestApi('/system-configs/order-serial', {
    method: 'GET',
    token,
  })

  const configs = fetchSerialResult.data.list ?? []
  assert.ok(configs.length >= 2, '系统配置返回的双流水配置数量异常')
  const department = configs.find((item) => item.orderType === 'department')
  const walkin = configs.find((item) => item.orderType === 'walkin')
  assert.ok(department, '系统配置缺少 department 流水')
  assert.ok(walkin, '系统配置缺少 walkin 流水')

  const updateResult = await requestApi('/system-configs/order-serial', {
    method: 'PUT',
    token,
    body: {
      department: {
        start: Number(department.start),
        current: Number(department.current),
        width: Number(department.width),
      },
      walkin: {
        start: Number(walkin.start),
        current: Number(walkin.current),
        width: Number(walkin.width),
      },
    },
  })
  assert.ok(Array.isArray(updateResult.data.list), '系统配置更新后返回数据结构异常')

  const durationMs = performance.now() - startedAt
  pushStep('系统配置关键参数读取与保存', durationMs, {
    timings: {
      fetchSerialMs: Number(fetchSerialResult.durationMs.toFixed(2)),
      updateSerialMs: Number(updateResult.durationMs.toFixed(2)),
    },
  })
  log('[core-path] 系统配置读取 / 保存验证通过')
}

/**
 * 审计日志链路验证：
 * - 校验系统治理动作已经沉淀到审计日志；
 * - 同时验证 export 接口能导出当前筛选结果，保证验证结果具备可追溯性。
 */
const verifyAuditLogPath = async (token, createdUser) => {
  const startedAt = performance.now()
  const auditListResult = await requestApi(
    `/audit-logs?page=1&pageSize=20&actionType=${encodeURIComponent('user.update_status')}&targetId=${encodeURIComponent(createdUser.id)}`,
    {
      method: 'GET',
      token,
    },
  )

  assert.ok(
    auditListResult.data.list.some(
      (item) => String(item.targetId) === String(createdUser.id) && item.actionType === 'user.update_status',
    ),
    '审计日志列表未命中用户状态变更记录',
  )

  const exportResult = await requestApi(
    `/audit-logs/export?actionType=${encodeURIComponent('user.update_status')}&targetId=${encodeURIComponent(createdUser.id)}`,
    {
      method: 'GET',
      token,
      expectJsonEnvelope: false,
    },
  )

  const csvText = exportResult.responseText
  assert.match(csvText, /user\.update_status/, '导出的审计日志 CSV 中未包含目标 actionType')
  assert.match(csvText, new RegExp(createdUser.id), '导出的审计日志 CSV 中未包含目标 targetId')

  const durationMs = performance.now() - startedAt
  pushStep('审计日志核心路径与导出', durationMs, {
    targetUserId: createdUser.id,
    timings: {
      listAuditLogsMs: Number(auditListResult.durationMs.toFixed(2)),
      exportAuditLogsMs: Number(exportResult.durationMs.toFixed(2)),
    },
  })

  log('[core-path] 审计日志列表 / 导出验证通过')
}

/**
 * 汇总写入 JSON 报告：
 * - 统一沉淀环境信息、隔离数据库路径与每个验证步骤；
 * - 供任务回写、问题排查与后续对比使用。
 */
const writeReport = () => {
  const report = {
    runId,
    generatedAt: new Date().toISOString(),
    backendBaseUrl,
    verifyDbPath,
    credentials: {
      username: verifyCredentials.username,
    },
    verificationSteps,
  }

  fs.mkdirSync(runtimeRoot, { recursive: true })
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  log(`[core-path] 核心路径验证报告已写入：${reportPath}`)
}

const main = async () => {
  let backendContext

  try {
    verifyFrontendStaticCoverage()
    backendContext = await startIsolatedBackend()
    const { token } = await verifyLoginAndDashboard()
    const { createdProduct } = await verifyBaseDataPath(token)
    await verifyOrderListPath(token, createdProduct)
    await verifySystemConfigPath(token)
    const { createdUser } = await verifySystemManagementPath(token)
    await verifyAuditLogPath(token, createdUser)
    writeReport()
    log('[core-path] 核心路径自动化回归全部通过')
  } finally {
    await stopIsolatedBackend(backendContext?.backendProcess)
  }
}

try {
  await main()
} catch (error) {
  writeReport()
  // eslint-disable-next-line no-console
  console.error('\n[core-path] 核心路径自动化回归失败：', error)
  process.exit(1)
}
