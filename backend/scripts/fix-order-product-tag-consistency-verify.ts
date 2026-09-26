/**
 * 文件说明：backend/scripts/fix-order-product-tag-consistency-verify.ts
 * 文件职责：验证订单详情、商品标签一致性与隔离后端联调流程是否符合预期。
 * 维护说明：若调整商品标签、订单详情字段或隔离验证启动流程，请同步更新本脚本。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

type VerificationItem = {
  title: string
  passed: boolean
  durationMs: number
  details?: Record<string, unknown>
  error?: string
}

type RequestOptions = {
  method?: string
  authenticated?: boolean
  body?: unknown
  expectedStatus?: number
}

const require = createRequire(import.meta.url)
const currentFilePath = fileURLToPath(import.meta.url)
const backendRoot = path.resolve(path.dirname(currentFilePath), '..')
const projectRoot = path.resolve(backendRoot, '..')
const runtimeRoot = path.resolve(projectRoot, '.local-dev')
const verifyRuntimeRoot = path.resolve(backendRoot, 'data', 'local-dev')
const verifyStartedAt = new Date()
const runId = `fix-order-product-tag-consistency-task7-${verifyStartedAt.toISOString().replaceAll(/[:.]/g, '-')}`
const verifyDbPath = path.join(verifyRuntimeRoot, `${runId}.sqlite`)
const reportPath = path.join(runtimeRoot, `${runId}.report.json`)
const backendPort = Number(process.env.Y_LINK_SPEC_VERIFY_BACKEND_PORT ?? 3312)
const backendBaseUrl = `http://127.0.0.1:${backendPort}`
const apiBaseUrl = `${backendBaseUrl}/api`
const verifyCredentials = {
  username: 'admin',
  password: process.env.Y_LINK_SPEC_VERIFY_PASSWORD ?? `SpecVerify@${Date.now()}`,
}
const authCookies = new Map<string, string>()

const verificationItems: VerificationItem[] = []

const log = (message: string) => {
  console.log(message)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const readText = (filePath: string) => fs.readFileSync(filePath, 'utf8')

const writeReport = () => {
  fs.mkdirSync(runtimeRoot, { recursive: true })
  fs.writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        runId,
        generatedAt: new Date().toISOString(),
        backendBaseUrl,
        verifyDbPath,
        reportPath,
        verificationItems,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
}

const resolveTsxCliPath = () => {
  const packageJsonPath = require.resolve('tsx/package.json', {
    paths: [backendRoot],
  })
  const packageJson = JSON.parse(readText(packageJsonPath)) as {
    bin?: string | Record<string, string>
  }
  const binEntry =
    typeof packageJson.bin === 'string'
      ? packageJson.bin
      : packageJson.bin?.tsx ?? packageJson.bin?.default

  if (!binEntry) {
    throw new Error('无法解析 tsx CLI 路径')
  }

  return path.resolve(path.dirname(packageJsonPath), binEntry)
}

const startIsolatedBackend = async () => {
  fs.mkdirSync(runtimeRoot, { recursive: true })
  fs.mkdirSync(verifyRuntimeRoot, { recursive: true })

  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  const tsxCliPath = resolveTsxCliPath()
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
      Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE: 'true',
      INIT_ADMIN_USERNAME: verifyCredentials.username,
      INIT_ADMIN_PASSWORD: verifyCredentials.password,
      INIT_ADMIN_DISPLAY_NAME: 'Task7验收管理员',
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

  for (let attempt = 1; attempt <= 60; attempt += 1) {
    try {
      const response = await fetch(`${backendBaseUrl}/health`)
      if (response.ok) {
        return {
          backendProcess,
          stdoutChunks,
          stderrChunks,
        }
      }
    } catch {}

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

const stopIsolatedBackend = async (backendProcess?: ChildProcess) => {
  if (!backendProcess) {
    return
  }
  if (backendProcess.exitCode !== null) {
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

const requestApi = async <T>(pathname: string, options: RequestOptions = {}) => {
  const startedAt = performance.now()
  const method = options.method ?? 'GET'
  const csrfToken = authCookies.get('y_link_admin_csrf')
  const response = await fetch(`${apiBaseUrl}${pathname}`, {
    method,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.authenticated && authCookies.size
        ? { Cookie: [...authCookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ') }
        : {}),
      ...(options.authenticated && !['GET', 'HEAD', 'OPTIONS'].includes(method) && csrfToken
        ? { 'x-csrf-token': decodeURIComponent(csrfToken) }
        : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const durationMs = performance.now() - startedAt
  const responseText = await response.text()

  for (const setCookie of response.headers.getSetCookie()) {
    const [cookiePair] = setCookie.split(';', 1)
    const separatorIndex = cookiePair.indexOf('=')
    if (separatorIndex > 0) {
      authCookies.set(cookiePair.slice(0, separatorIndex), cookiePair.slice(separatorIndex + 1))
    }
  }

  assert.equal(
    response.status,
    options.expectedStatus ?? 200,
    `${method} ${pathname} 返回状态异常：${response.status}\n${responseText}`,
  )

  const payload = JSON.parse(responseText) as {
    code: number
    message?: string
    data: T
  }

  assert.equal(payload.code, 0, `${method} ${pathname} 业务返回失败：${payload.message ?? 'unknown error'}`)

  return {
    data: payload.data,
    durationMs,
  }
}

const recordVerification = async (title: string, runner: () => Promise<Record<string, unknown> | void>) => {
  const startedAt = performance.now()

  try {
    const details = (await runner()) ?? {}
    verificationItems.push({
      title,
      passed: true,
      durationMs: Number((performance.now() - startedAt).toFixed(2)),
      details,
    })
    log(`✅ ${title}`)
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error)
    verificationItems.push({
      title,
      passed: false,
      durationMs: Number((performance.now() - startedAt).toFixed(2)),
      error: message,
    })
    throw error
  }
}

const assertProductView = (payload: Record<string, unknown>, label: string) => {
  assert.equal(typeof payload.id, 'string', `${label} 缺少 string id`)
  assert.equal(typeof payload.productCode, 'string', `${label} 缺少 string productCode`)
  assert.equal(typeof payload.productName, 'string', `${label} 缺少 string productName`)
  assert.equal(typeof payload.pinyinAbbr, 'string', `${label} 缺少 string pinyinAbbr`)
  assert.equal(typeof payload.defaultPrice, 'string', `${label} 缺少 string defaultPrice`)
  assert.equal(typeof payload.isActive, 'boolean', `${label} 缺少 boolean isActive`)
  assert.ok(Array.isArray(payload.tagIds), `${label} 缺少 tagIds 数组`)
  assert.ok(Array.isArray(payload.tags), `${label} 缺少 tags 数组`)
}

const assertTagView = (payload: Record<string, unknown>, label: string) => {
  assert.equal(typeof payload.id, 'string', `${label} 缺少 string id`)
  assert.equal(typeof payload.tagName, 'string', `${label} 缺少 string tagName`)
  assert.ok(typeof payload.tagCode === 'string' || payload.tagCode === null, `${label} 缺少 tagCode`)
}

const requireStringField = (payload: Record<string, unknown>, fieldName: string, label: string): string => {
  const value = payload[fieldName]
  assert.equal(typeof value, 'string', `${label} 缺少 string ${fieldName}`)
  return value as string
}

const assertOrderDetailShape = (payload: Record<string, unknown>) => {
  const order = payload.order as Record<string, unknown>
  const items = payload.items as Array<Record<string, unknown>>

  assert.equal(typeof order.id, 'string', '订单详情缺少 order.id')
  assert.equal(typeof order.systemNo, 'string', '订单详情缺少 order.systemNo')
  assert.equal(typeof order.businessNo, 'string', '订单详情缺少 order.businessNo')
  assert.ok(Array.isArray(items), '订单详情缺少 items 数组')
  assert.equal(items.length > 0, true, '订单详情 items 为空')
  assert.equal(typeof items[0]?.productCode, 'string', '订单详情缺少 item.productCode')
  assert.equal(typeof items[0]?.productName, 'string', '订单详情缺少 item.productName')
  assert.equal(typeof items[0]?.subTotal, 'string', '订单详情缺少 item.subTotal')
  assert.equal(typeof items[0]?.lineAmount, 'string', '订单详情缺少 item.lineAmount')
}

const verifyFrontendStaticCoverage = async () => {
  const orderEntryPath = path.resolve(projectRoot, 'src/views/order-entry/composables/useOrderEntryForm.ts')
  const orderListPath = path.resolve(projectRoot, 'src/views/order-list/composables/useOrderListView.ts')
  const productManagerPath = path.resolve(projectRoot, 'src/views/base-data/components/ProductManager.vue')
  const productManagerHelpersPath = path.resolve(projectRoot, 'src/views/base-data/components/product-manager.helpers.ts')
  const tagManagerPath = path.resolve(projectRoot, 'src/views/base-data/components/TagManager.vue')
  const productApiPath = path.resolve(projectRoot, 'src/api/modules/product.ts')
  const tagApiPath = path.resolve(projectRoot, 'src/api/modules/tag.ts')

  const orderEntrySource = readText(orderEntryPath)
  const orderListSource = readText(orderListPath)
  const productManagerSource = readText(productManagerPath)
  const productManagerHelpersSource = readText(productManagerHelpersPath)
  const tagManagerSource = readText(tagManagerPath)
  const productApiSource = readText(productApiPath)
  const tagApiSource = readText(tagApiPath)

  assert.match(
    orderEntrySource,
    /router\.push\(\{[\s\S]*path:\s*'\/order-list'[\s\S]*focusOrderId:\s*result\.order\.id[\s\S]*focusOrderSystemNo:\s*result\.order\.systemNo[\s\S]*focusRefreshToken:/,
  )
  assert.doesNotMatch(orderEntrySource, /focusOrderShowNo:\s*result\.order\.showNo/)
  assert.match(orderListSource, /const ORDER_LIST_TARGET_ORDER_SYSTEM_NO_QUERY_KEY = 'focusOrderSystemNo'/)
  assert.match(orderListSource, /const ORDER_LIST_TARGET_ORDER_SHOW_NO_QUERY_KEY = 'focusOrderShowNo'/)
  assert.match(
    orderListSource,
    /route\.query\[ORDER_LIST_TARGET_ORDER_SYSTEM_NO_QUERY_KEY\]\s*\?\?\s*route\.query\[ORDER_LIST_TARGET_ORDER_SHOW_NO_QUERY_KEY\]/,
  )
  assert.match(orderListSource, /const refreshForSubmittedOrder = async \(\) =>/)
  assert.match(
    orderListSource,
    /await loadData\(\{\s*highlightNewOrders:\s*true,\s*\}\)[\s\S]*loadOrderDetail\(\{\s*id:\s*targetOrder\?\.id \?\? payload\.orderId,\s*\}\)/,
  )
  assert.match(orderListSource, /onActivated\(\(\) =>[\s\S]*scheduleAutoRefresh\(\)[\s\S]*void triggerSilentRefresh\(\)/)
  assert.match(
    orderEntrySource,
    /productApi\.getProductList\(\{\s*isActive:\s*true,?\s*\}\)[\s\S]*loadedProducts\.filter\(\(product\) => getSelectableProductSkus\(product\)\.length > 0\)/,
  )
  assert.doesNotMatch(orderEntrySource, /productApi\.createProduct\(/)

  assert.match(productManagerSource, /normalizeSelectValue,/)
  assert.match(productManagerHelpersSource, /export const normalizeSelectValue = \(value: string \| number \| null \| undefined\): string =>/)
  assert.match(productManagerSource, /const resolveTagIds = async \(tagValues: Array<string \| number>, silent = false\): Promise<string\[]> =>/)
  assert.match(productManagerSource, /const buildEditForm = \(row: ProductRecord\): ProductForm => \{[\s\S]*return \{[\s\S]*isActive:\s*row\.isActive[\s\S]*tagIds:\s*row\.tagIds/)
  assert.match(productManagerSource, /await batchUpdateProducts\(\{[\s\S]*ids:\s*selectedProductIds\.value[\s\S]*isActive,/)
  assert.match(productManagerSource, /onActivated\(\(\) =>[\s\S]*void refreshProductView\(\)/)

  assert.match(tagManagerSource, /onActivated\(\(\) =>[\s\S]*refreshTagView\(\)\.then\(\(\) => handleAggregateSearch\(\)\)\.catch\(\(\) => undefined\)/)
  assert.match(productApiSource, /return String\(value\)\.trim\(\)/)
  assert.match(tagApiSource, /const normalizedValue = String\(value\)\.trim\(\)/)

  return {
    files: [
      orderEntryPath,
      orderListPath,
      productManagerPath,
      productManagerHelpersPath,
      tagManagerPath,
      productApiPath,
      tagApiPath,
    ],
  }
}

const loginAsAdmin = async () => {
  const loginResult = await requestApi<{
    expiresAt: string
    user: {
      id: string
      username: string
    }
  }>('/auth/login', {
    method: 'POST',
    body: verifyCredentials,
  })

  assert.equal(loginResult.data.user.username, verifyCredentials.username)
  assert.ok(loginResult.data.expiresAt)
  assert.ok(authCookies.get('y_link_admin_session'), '登录响应未设置管理端会话 Cookie')
  assert.ok(authCookies.get('y_link_admin_csrf'), '登录响应未设置管理端 CSRF Cookie')

  return {
    loginDurationMs: Number(loginResult.durationMs.toFixed(2)),
  }
}

const verifyChecklistFlow = async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  const createdTagAResult = await requestApi<Record<string, unknown>>('/tags', {
    method: 'POST',
    authenticated: true,
    body: {
      tagName: `  验收标签A-${suffix}  `,
      tagCode: '#409EFF',
    },
  })
  assertTagView(createdTagAResult.data, '创建标签A返回')
  assert.equal(createdTagAResult.data.tagName, `验收标签A-${suffix}`)
  const createdTagAId = requireStringField(createdTagAResult.data, 'id', '创建标签A返回')

  const updatedTagAResult = await requestApi<Record<string, unknown>>(`/tags/${createdTagAId}`, {
    method: 'PUT',
    authenticated: true,
    body: {
      tagName: `  验收标签A已更新-${suffix}  `,
      tagCode: '#67C23A',
    },
  })
  assertTagView(updatedTagAResult.data, '更新标签A返回')
  assert.equal(updatedTagAResult.data.tagName, `验收标签A已更新-${suffix}`)
  const updatedTagAId = requireStringField(updatedTagAResult.data, 'id', '更新标签A返回')

  const createdTagBResult = await requestApi<Record<string, unknown>>('/tags', {
    method: 'POST',
    authenticated: true,
    body: {
      tagName: `验收标签B-${suffix}`,
      tagCode: '#E6A23C',
    },
  })
  assertTagView(createdTagBResult.data, '创建标签B返回')
  const createdTagBId = requireStringField(createdTagBResult.data, 'id', '创建标签B返回')

  const createdProductAResult = await requestApi<Record<string, unknown>>('/products', {
    method: 'POST',
    authenticated: true,
    body: {
      productName: `验收产品A-${suffix}`,
      pinyinAbbr: 'YSCPA',
      defaultPrice: 10,
      currentStock: 10,
      isActive: true,
      tagIds: [Number(createdTagAId)],
    },
  })
  const createdProductBResult = await requestApi<Record<string, unknown>>('/products', {
    method: 'POST',
    authenticated: true,
    body: {
      productName: `验收产品B-${suffix}`,
      pinyinAbbr: 'YSCPB',
      defaultPrice: 12.5,
      currentStock: 10,
      isActive: true,
      tagIds: [createdTagBId],
    },
  })

  assertProductView(createdProductAResult.data, '创建产品A返回')
  assertProductView(createdProductBResult.data, '创建产品B返回')
  const createdProductAId = requireStringField(createdProductAResult.data, 'id', '创建产品A返回')
  const createdProductBId = requireStringField(createdProductBResult.data, 'id', '创建产品B返回')
  const createdProductAName = requireStringField(createdProductAResult.data, 'productName', '创建产品A返回')
  const createdProductACode = requireStringField(createdProductAResult.data, 'productCode', '创建产品A返回')
  const createdProductBCode = requireStringField(createdProductBResult.data, 'productCode', '创建产品B返回')

  assert.match(createdProductACode, /^P-\d{6}-0001$/)
  assert.match(createdProductBCode, /^P-\d{6}-0002$/)

  const productListBeforeBatchResult = await requestApi<Array<Record<string, unknown>>>('/products', {
    method: 'GET',
    authenticated: true,
  })
  const createdProductAInList = productListBeforeBatchResult.data.find((item) => item.id === createdProductAId)
  assert.ok(createdProductAInList, '产品列表未返回产品A')
  assertProductView(createdProductAInList, '产品列表产品A')
  assert.equal((createdProductAInList?.isActive as boolean) ?? null, true)

  const batchUpdateResult = await requestApi<Array<Record<string, unknown>>>('/products/batch', {
    method: 'POST',
    authenticated: true,
    body: {
      ids: [createdProductAId, createdProductBId],
      isActive: false,
    },
  })
  assert.equal(batchUpdateResult.data.length, 2)
  batchUpdateResult.data.forEach((item, index) => {
    assertProductView(item, `批量返回第${index + 1}项`)
    assert.equal(item.isActive, false)
  })

  const productADetailAfterBatchResult = await requestApi<Record<string, unknown>>(`/products/${createdProductAId}`, {
    method: 'GET',
    authenticated: true,
  })
  assertProductView(productADetailAfterBatchResult.data, '批量后产品A详情')
  assert.equal(productADetailAfterBatchResult.data.isActive, false)

  const productAUpdatedResult = await requestApi<Record<string, unknown>>(`/products/${createdProductAId}`, {
    method: 'PUT',
    authenticated: true,
    body: {
      isActive: true,
      defaultPrice: 10,
      tagIds: [updatedTagAId, Number(createdTagBId)],
    },
  })
  assertProductView(productAUpdatedResult.data, '更新产品A返回')
  assert.equal(productAUpdatedResult.data.isActive, true)
  assert.deepEqual(productAUpdatedResult.data.tagIds, [updatedTagAId, createdTagBId])
  assert.equal(Array.isArray(productAUpdatedResult.data.tags), true)
  assert.equal((productAUpdatedResult.data.tags as Array<unknown>).length, 2)

  const productADetailBeforeOrderResult = await requestApi<Record<string, unknown>>(`/products/${createdProductAId}`, {
    method: 'GET',
    authenticated: true,
  })
  assert.equal(productADetailBeforeOrderResult.data.isActive, true)
  assert.equal(productADetailBeforeOrderResult.data.defaultPrice, '10.00')

  const submitOrderResult = await requestApi<{
    order: {
      id: string
      systemNo: string
      businessNo: string
      showNo: string
    }
    items: Array<Record<string, unknown>>
  }>('/orders/submit', {
    method: 'POST',
    authenticated: true,
    body: {
      idempotencyKey: `task7-check-${suffix}`,
      customerName: 'Task7验收客户',
      remark: 'Task7系统化验收',
      items: [
        {
          productId: createdProductAId,
          qty: 2,
          unitPrice: 18.8,
          remark: '回写默认售价',
        },
      ],
    },
  })
  assert.ok(submitOrderResult.data.order.id)
  assert.match(submitOrderResult.data.order.systemNo, /^OUT-(?:D|W)-\d{6}$/)
  assert.match(submitOrderResult.data.order.businessNo, /^hyyz(?:jd)?\d{6}$/i)

  const orderListResult = await requestApi<{
    list: Array<Record<string, unknown>>
    total: number
    page: number
    pageSize: number
  }>(`/orders?page=1&pageSize=20&keyword=${encodeURIComponent(submitOrderResult.data.order.systemNo)}`, {
    method: 'GET',
    authenticated: true,
  })
  assert.ok(orderListResult.data.list.some((item) => item.id === submitOrderResult.data.order.id))

  const orderDetailByIdResult = await requestApi<Record<string, unknown>>(`/orders/${submitOrderResult.data.order.id}`, {
    method: 'GET',
    authenticated: true,
  })
  assertOrderDetailShape(orderDetailByIdResult.data)
  assert.equal((orderDetailByIdResult.data.order as Record<string, unknown>).id, submitOrderResult.data.order.id)

  const orderDetailByShowNoResult = await requestApi<Record<string, unknown>>(
    `/orders/system-no/${encodeURIComponent(submitOrderResult.data.order.systemNo)}`,
    {
      method: 'GET',
      authenticated: true,
    },
  )
  assertOrderDetailShape(orderDetailByShowNoResult.data)
  assert.equal((orderDetailByShowNoResult.data.order as Record<string, unknown>).systemNo, submitOrderResult.data.order.systemNo)

  const productADetailAfterOrderResult = await requestApi<Record<string, unknown>>(`/products/${createdProductAId}`, {
    method: 'GET',
    authenticated: true,
  })
  assert.equal(productADetailAfterOrderResult.data.defaultPrice, '18.80')
  assert.equal(productADetailAfterOrderResult.data.isActive, true)

  const productListAfterOrderResult = await requestApi<Array<Record<string, unknown>>>(
    `/products?keyword=${encodeURIComponent(createdProductAName)}`,
    {
      method: 'GET',
      authenticated: true,
    },
  )
  const productAAfterOrderInList = productListAfterOrderResult.data.find((item) => item.id === createdProductAId)
  assert.ok(productAAfterOrderInList, '订单提交后产品列表未返回产品A')
  assert.equal(productAAfterOrderInList?.defaultPrice, '18.80')
  assert.equal(productAAfterOrderInList?.isActive, true)

  const tagListResult = await requestApi<Array<Record<string, unknown>>>('/tags', {
    method: 'GET',
    authenticated: true,
  })
  assert.ok(tagListResult.data.some((item) => item.id === updatedTagAResult.data.id))
  assert.ok(tagListResult.data.some((item) => item.id === createdTagBResult.data.id))

  return {
    createdTags: [
      {
        id: updatedTagAResult.data.id,
        tagName: updatedTagAResult.data.tagName,
      },
      {
        id: createdTagBId,
        tagName: createdTagBResult.data.tagName,
      },
    ],
    createdProducts: [
      {
        id: createdProductAId,
        productCode: createdProductACode,
      },
      {
        id: createdProductBId,
        productCode: createdProductBCode,
      },
    ],
    submittedOrder: submitOrderResult.data.order,
    productAAfterOrder: {
      id: productADetailAfterOrderResult.data.id,
      defaultPrice: productADetailAfterOrderResult.data.defaultPrice,
      isActive: productADetailAfterOrderResult.data.isActive,
      tagIds: productADetailAfterOrderResult.data.tagIds,
    },
  }
}

const main = async () => {
  let backendContext:
    | {
        backendProcess: ChildProcess
        stdoutChunks: string[]
        stderrChunks: string[]
      }
    | undefined

  try {
    backendContext = await startIsolatedBackend()

    const { loginDurationMs } = await loginAsAdmin()

    await recordVerification('出库单刷新/详情与基础数据回归链路通过', async () => {
      return {
        loginDurationMs,
        ...(await verifyChecklistFlow()),
      }
    })

    await recordVerification('前端静态实现覆盖出库跳转、状态回填、无感刷新与 trim 修复', async () => {
      return verifyFrontendStaticCoverage()
    })
  } finally {
    await stopIsolatedBackend(backendContext?.backendProcess)
    writeReport()
  }
}

try {
  await main()
  log(`\nTask7 验收脚本全部通过，报告已写入：${reportPath}`)
} catch (error) {
  console.error(`\nTask7 验收脚本失败，报告已写入：${reportPath}`)
  console.error(error)
  process.exit(1)
}
