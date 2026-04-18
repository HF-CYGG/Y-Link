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
  token?: string
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
  password: ['Admin', '@', '123456'].join(''),
}

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
  if (!backendProcess || backendProcess.exitCode !== null) {
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
  const response = await fetch(`${apiBaseUrl}${pathname}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const durationMs = performance.now() - startedAt
  const responseText = await response.text()

  assert.equal(
    response.status,
    options.expectedStatus ?? 200,
    `${options.method ?? 'GET'} ${pathname} 返回状态异常：${response.status}\n${responseText}`,
  )

  const payload = JSON.parse(responseText) as {
    code: number
    message?: string
    data: T
  }

  assert.equal(payload.code, 0, `${options.method ?? 'GET'} ${pathname} 业务返回失败：${payload.message ?? 'unknown error'}`)

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

const assertOrderDetailShape = (payload: Record<string, unknown>) => {
  const order = payload.order as Record<string, unknown>
  const items = payload.items as Array<Record<string, unknown>>

  assert.equal(typeof order.id, 'string', '订单详情缺少 order.id')
  assert.equal(typeof order.showNo, 'string', '订单详情缺少 order.showNo')
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
  const tagManagerPath = path.resolve(projectRoot, 'src/views/base-data/components/TagManager.vue')
  const productApiPath = path.resolve(projectRoot, 'src/api/modules/product.ts')
  const tagApiPath = path.resolve(projectRoot, 'src/api/modules/tag.ts')

  const orderEntrySource = readText(orderEntryPath)
  const orderListSource = readText(orderListPath)
  const productManagerSource = readText(productManagerPath)
  const tagManagerSource = readText(tagManagerPath)
  const productApiSource = readText(productApiPath)
  const tagApiSource = readText(tagApiPath)

  assert.match(
    orderEntrySource,
    /router\.push\(\{[\s\S]*path:\s*'\/order-list'[\s\S]*focusOrderId:\s*result\.order\.id[\s\S]*focusOrderShowNo:\s*result\.order\.showNo[\s\S]*focusRefreshToken:/,
  )
  assert.match(orderListSource, /const refreshForSubmittedOrder = async \(\) =>/)
  assert.match(orderListSource, /await loadData\(\)[\s\S]*loadOrderDetail\(targetOrder\?\.id \?\? payload\.orderId\)/)
  assert.match(orderListSource, /onActivated\(\(\) =>[\s\S]*void refreshListView\(\)/)
  assert.match(orderEntrySource, /productApi\.createProduct\(\{[\s\S]*productName:\s*normalizedValue[\s\S]*isActive:\s*true[\s\S]*\}\)/)
  assert.doesNotMatch(orderEntrySource, /productApi\.createProduct\(\{[\s\S]*?productCode:/)

  assert.match(productManagerSource, /const normalizeSelectValue = \(value: string \| number \| null \| undefined\): string =>/)
  assert.match(productManagerSource, /const resolveTagIds = async \(tagValues: Array<string \| number>\): Promise<string\[]> =>/)
  assert.match(productManagerSource, /const buildEditForm = \(row: ProductRecord\): ProductForm => \(\{[\s\S]*isActive:\s*row\.isActive[\s\S]*tagIds:\s*row\.tagIds/)
  assert.match(productManagerSource, /await batchUpdateProducts\(\{[\s\S]*ids:\s*selectedProductIds\.value[\s\S]*isActive,/)
  assert.match(productManagerSource, /onActivated\(\(\) =>[\s\S]*void refreshProductView\(\)/)

  assert.match(tagManagerSource, /onActivated\(\(\) =>[\s\S]*void refreshTagView\(\)/)
  assert.match(productApiSource, /return String\(value\)\.trim\(\)/)
  assert.match(tagApiSource, /const normalizedValue = String\(value\)\.trim\(\)/)

  return {
    files: [
      orderEntryPath,
      orderListPath,
      productManagerPath,
      tagManagerPath,
      productApiPath,
      tagApiPath,
    ],
  }
}

const loginAsAdmin = async () => {
  const loginResult = await requestApi<{
    token: string
    user: {
      id: string
      username: string
    }
  }>('/auth/login', {
    method: 'POST',
    body: verifyCredentials,
  })

  assert.equal(loginResult.data.user.username, verifyCredentials.username)
  assert.ok(loginResult.data.token)

  return {
    token: loginResult.data.token,
    loginDurationMs: Number(loginResult.durationMs.toFixed(2)),
  }
}

const verifyChecklistFlow = async (token: string) => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  const createdTagAResult = await requestApi<Record<string, unknown>>('/tags', {
    method: 'POST',
    token,
    body: {
      tagName: `  验收标签A-${suffix}  `,
      tagCode: '#409EFF',
    },
  })
  assertTagView(createdTagAResult.data, '创建标签A返回')
  assert.equal(createdTagAResult.data.tagName, `验收标签A-${suffix}`)

  const updatedTagAResult = await requestApi<Record<string, unknown>>(`/tags/${createdTagAResult.data.id}`, {
    method: 'PUT',
    token,
    body: {
      tagName: `  验收标签A已更新-${suffix}  `,
      tagCode: '#67C23A',
    },
  })
  assertTagView(updatedTagAResult.data, '更新标签A返回')
  assert.equal(updatedTagAResult.data.tagName, `验收标签A已更新-${suffix}`)

  const createdTagBResult = await requestApi<Record<string, unknown>>('/tags', {
    method: 'POST',
    token,
    body: {
      tagName: `验收标签B-${suffix}`,
      tagCode: '#E6A23C',
    },
  })
  assertTagView(createdTagBResult.data, '创建标签B返回')

  const createdProductAResult = await requestApi<Record<string, unknown>>('/products', {
    method: 'POST',
    token,
    body: {
      productName: `验收产品A-${suffix}`,
      pinyinAbbr: 'YSCPA',
      defaultPrice: 10,
      isActive: true,
      tagIds: [Number(createdTagAResult.data.id)],
    },
  })
  const createdProductBResult = await requestApi<Record<string, unknown>>('/products', {
    method: 'POST',
    token,
    body: {
      productName: `验收产品B-${suffix}`,
      pinyinAbbr: 'YSCPB',
      defaultPrice: 12.5,
      isActive: true,
      tagIds: [createdTagBResult.data.id],
    },
  })

  assertProductView(createdProductAResult.data, '创建产品A返回')
  assertProductView(createdProductBResult.data, '创建产品B返回')
  assert.match(String(createdProductAResult.data.productCode), /^P-\d{6}-0001$/)
  assert.match(String(createdProductBResult.data.productCode), /^P-\d{6}-0002$/)

  const productListBeforeBatchResult = await requestApi<Array<Record<string, unknown>>>('/products', {
    method: 'GET',
    token,
  })
  const createdProductAInList = productListBeforeBatchResult.data.find((item) => item.id === createdProductAResult.data.id)
  assert.ok(createdProductAInList, '产品列表未返回产品A')
  assertProductView(createdProductAInList as Record<string, unknown>, '产品列表产品A')
  assert.equal((createdProductAInList?.isActive as boolean) ?? null, true)

  const batchUpdateResult = await requestApi<Array<Record<string, unknown>>>('/products/batch', {
    method: 'POST',
    token,
    body: {
      ids: [createdProductAResult.data.id, createdProductBResult.data.id],
      isActive: false,
    },
  })
  assert.equal(batchUpdateResult.data.length, 2)
  batchUpdateResult.data.forEach((item, index) => {
    assertProductView(item, `批量返回第${index + 1}项`)
    assert.equal(item.isActive, false)
  })

  const productADetailAfterBatchResult = await requestApi<Record<string, unknown>>(`/products/${createdProductAResult.data.id}`, {
    method: 'GET',
    token,
  })
  assertProductView(productADetailAfterBatchResult.data, '批量后产品A详情')
  assert.equal(productADetailAfterBatchResult.data.isActive, false)

  const productAUpdatedResult = await requestApi<Record<string, unknown>>(`/products/${createdProductAResult.data.id}`, {
    method: 'PUT',
    token,
    body: {
      isActive: true,
      defaultPrice: 10,
      tagIds: [updatedTagAResult.data.id, Number(createdTagBResult.data.id)],
    },
  })
  assertProductView(productAUpdatedResult.data, '更新产品A返回')
  assert.equal(productAUpdatedResult.data.isActive, true)
  assert.deepEqual(productAUpdatedResult.data.tagIds, [String(updatedTagAResult.data.id), String(createdTagBResult.data.id)])
  assert.equal(Array.isArray(productAUpdatedResult.data.tags), true)
  assert.equal((productAUpdatedResult.data.tags as Array<unknown>).length, 2)

  const productADetailBeforeOrderResult = await requestApi<Record<string, unknown>>(`/products/${createdProductAResult.data.id}`, {
    method: 'GET',
    token,
  })
  assert.equal(productADetailBeforeOrderResult.data.isActive, true)
  assert.equal(productADetailBeforeOrderResult.data.defaultPrice, '10.00')

  const submitOrderResult = await requestApi<{
    order: {
      id: string
      showNo: string
    }
    items: Array<Record<string, unknown>>
  }>('/orders/submit', {
    method: 'POST',
    token,
    body: {
      idempotencyKey: `task7-check-${suffix}`,
      customerName: 'Task7验收客户',
      remark: 'Task7系统化验收',
      items: [
        {
          productId: createdProductAResult.data.id,
          qty: 2,
          unitPrice: 18.8,
          remark: '回写默认售价',
        },
      ],
    },
  })
  assert.ok(submitOrderResult.data.order.id)
  assert.match(submitOrderResult.data.order.showNo, /^CK-\d{8}-\d{4}$/)

  const orderListResult = await requestApi<{
    list: Array<Record<string, unknown>>
    total: number
    page: number
    pageSize: number
  }>(`/orders?page=1&pageSize=20&showNo=${encodeURIComponent(submitOrderResult.data.order.showNo)}`, {
    method: 'GET',
    token,
  })
  assert.ok(orderListResult.data.list.some((item) => item.id === submitOrderResult.data.order.id))

  const orderDetailByIdResult = await requestApi<Record<string, unknown>>(`/orders/${submitOrderResult.data.order.id}`, {
    method: 'GET',
    token,
  })
  assertOrderDetailShape(orderDetailByIdResult.data)
  assert.equal((orderDetailByIdResult.data.order as Record<string, unknown>).id, submitOrderResult.data.order.id)

  const orderDetailByShowNoResult = await requestApi<Record<string, unknown>>(
    `/orders/show-no/${encodeURIComponent(submitOrderResult.data.order.showNo)}`,
    {
      method: 'GET',
      token,
    },
  )
  assertOrderDetailShape(orderDetailByShowNoResult.data)
  assert.equal((orderDetailByShowNoResult.data.order as Record<string, unknown>).showNo, submitOrderResult.data.order.showNo)

  const productADetailAfterOrderResult = await requestApi<Record<string, unknown>>(`/products/${createdProductAResult.data.id}`, {
    method: 'GET',
    token,
  })
  assert.equal(productADetailAfterOrderResult.data.defaultPrice, '18.80')
  assert.equal(productADetailAfterOrderResult.data.isActive, true)

  const productListAfterOrderResult = await requestApi<Array<Record<string, unknown>>>(
    `/products?keyword=${encodeURIComponent(String(createdProductAResult.data.productName))}`,
    {
      method: 'GET',
      token,
    },
  )
  const productAAfterOrderInList = productListAfterOrderResult.data.find((item) => item.id === createdProductAResult.data.id)
  assert.ok(productAAfterOrderInList, '订单提交后产品列表未返回产品A')
  assert.equal(productAAfterOrderInList?.defaultPrice, '18.80')
  assert.equal(productAAfterOrderInList?.isActive, true)

  const tagListResult = await requestApi<Array<Record<string, unknown>>>('/tags', {
    method: 'GET',
    token,
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
        id: createdTagBResult.data.id,
        tagName: createdTagBResult.data.tagName,
      },
    ],
    createdProducts: [
      {
        id: createdProductAResult.data.id,
        productCode: createdProductAResult.data.productCode,
      },
      {
        id: createdProductBResult.data.id,
        productCode: createdProductBResult.data.productCode,
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

    const { token, loginDurationMs } = await loginAsAdmin()

    await recordVerification('出库单刷新/详情与基础数据回归链路通过', async () => {
      return {
        loginDurationMs,
        ...(await verifyChecklistFlow(token)),
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
