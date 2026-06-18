/**
 * 模块说明：backend/scripts/database-concurrency-target-verify.ts
 * 文件职责：执行数据库高并发验收，覆盖 SQLite / MySQL 临时库下的混合请求、库存一致性与唯一键稳定性校验。
 * 维护说明：
 * - 该脚本会临时启动一套后端进程内应用并注入独立数据库环境，请优先保持环境隔离与清理逻辑稳定；
 * - 若后续继续扩展验收场景，优先复用现有统计、样本记录与临时数据种子能力，避免各段脚本重复维护。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import type { Server } from 'node:http'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

type TargetName = 'sqlite' | 'mysql'
type TargetStatus = 'passed' | 'failed' | 'environment_blocked'

interface RequestSample {
  label: string
  method: string
  pathname: string
  status: number
  code: number | null
  durationMs: number
  expected: boolean
  message: string | null
}

interface ScenarioSummary {
  totalRequests: number
  successCount: number
  businessConflictCount: number
  unexpectedErrorCount: number
  averageMs: number
  p95Ms: number
  p99Ms: number
  maxMs: number
}

interface TargetReport {
  runId: string
  target: TargetName
  status: TargetStatus
  startedAt: string
  endedAt: string | null
  errorMessage: string | null
  database: Record<string, unknown>
  thresholds: {
    mixedScenarioUsers: number
    maxUnexpectedErrorRate: number
    maxAverageResponseMs: number
    maxP95ResponseMs: number
    requestTimeoutMs: number
  }
  scenarios: Record<string, ScenarioSummary>
  checks: Array<{ title: string; status: 'passed'; detail: Record<string, unknown> }>
  failures: Array<{ title: string; detail: Record<string, unknown> }>
  failedSamples: RequestSample[]
}

const __filename = fileURLToPath(import.meta.url)
const backendRoot = path.resolve(path.dirname(__filename), '..')
const projectRoot = path.resolve(backendRoot, '..')
const runtimeRoot = path.resolve(projectRoot, '.local-dev')
const concurrencyRoot = path.resolve(runtimeRoot, 'db-concurrency')

const runId = process.env.Y_LINK_DB_CONCURRENCY_RUN_ID?.trim() || `${Date.now()}`
const target = (process.env.Y_LINK_DB_CONCURRENCY_TARGET?.trim() || 'sqlite') as TargetName
const reportPath =
  process.env.Y_LINK_DB_CONCURRENCY_REPORT_PATH?.trim()
  || path.resolve(concurrencyRoot, `${target}-${runId}.report.json`)

const thresholds = {
  mixedScenarioUsers: 20,
  maxUnexpectedErrorRate: 0.03,
  maxAverageResponseMs: 1200,
  maxP95ResponseMs: 2500,
  requestTimeoutMs: 10000,
} as const

const report: TargetReport = {
  runId,
  target,
  status: 'failed',
  startedAt: new Date().toISOString(),
  endedAt: null,
  errorMessage: null,
  database: {},
  thresholds,
  scenarios: {},
  checks: [],
  failures: [],
  failedSamples: [],
}

const requestSamplesByScenario = new Map<string, RequestSample[]>()

function writeReport() {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  report.endedAt = new Date().toISOString()
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

function addCheck(title: string, detail: Record<string, unknown>) {
  report.checks.push({ title, status: 'passed', detail })
}

function addFailure(title: string, detail: Record<string, unknown>) {
  report.failures.push({ title, detail })
}

function percentile(values: number[], p: number) {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return Number(sorted[index].toFixed(2))
}

function average(values: number[]) {
  if (!values.length) return 0
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2))
}

function summarizeSamples(samples: RequestSample[]): ScenarioSummary {
  const durations = samples.map((sample) => sample.durationMs)
  return {
    totalRequests: samples.length,
    successCount: samples.filter((sample) => sample.status === 200 && sample.code === 0).length,
    businessConflictCount: samples.filter((sample) => sample.status === 409).length,
    unexpectedErrorCount: samples.filter((sample) => !sample.expected).length,
    averageMs: average(durations),
    p95Ms: percentile(durations, 95),
    p99Ms: percentile(durations, 99),
    maxMs: Number(Math.max(...durations, 0).toFixed(2)),
  }
}

function readCookieValueFromResponse(response: Response, cookieName: string): string | null {
  const headersWithSetCookie = response.headers as Headers & {
    getSetCookie?: () => string[]
    raw?: () => Record<string, string[]>
  }
  const setCookieValues = headersWithSetCookie.getSetCookie?.()
    ?? headersWithSetCookie.raw?.()['set-cookie']
    ?? [response.headers.get('set-cookie') ?? '']
  const rawSetCookie = setCookieValues.filter(Boolean).join(',')
  const match = rawSetCookie.match(new RegExp(`(?:^|,\\s*)${cookieName}=([^;]+)`))
  return match?.[1] ? decodeURIComponent(match[1]) : null
}

function parseJsonPayload<T>(text: string): T {
  return (text ? JSON.parse(text) : {}) as T
}

function normalizeSqlIdentifier(value: string) {
  return value.replaceAll(/\W/g, '_').slice(0, 60)
}

async function prepareTargetEnvironment() {
  fs.mkdirSync(concurrencyRoot, { recursive: true })

  process.env.NODE_ENV = 'development'
  process.env.APP_PROFILE = `db-concurrency-${target}-${runId}`
  process.env.INIT_ADMIN_USERNAME = 'admin'
  process.env.INIT_ADMIN_PASSWORD = `DbConcurrency_${runId}_Aa1!`
  process.env.INIT_ADMIN_DISPLAY_NAME = 'Database Concurrency Admin'

  if (target === 'sqlite') {
    const sourcePath = process.env.Y_LINK_DB_CONCURRENCY_SQLITE_SOURCE?.trim()
      || path.resolve(backendRoot, 'data', 'y-link.sqlite')
    const sqlitePath = process.env.Y_LINK_DB_CONCURRENCY_SQLITE_PATH?.trim()
      || path.resolve(concurrencyRoot, `sqlite-${runId}.sqlite`)
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true })
    if (fs.existsSync(sourcePath)) {
      fs.copyFileSync(sourcePath, sqlitePath)
    }
    process.env.DB_TYPE = 'sqlite'
    process.env.DB_SYNC = 'false'
    process.env.SQLITE_DB_PATH = sqlitePath
    report.database = {
      type: 'sqlite',
      sourcePath,
      sqlitePath,
      sourceCopied: fs.existsSync(sourcePath),
    }
    return null
  }

  const mysqlHost = process.env.Y_LINK_DB_CONCURRENCY_MYSQL_HOST || process.env.DB_HOST || '127.0.0.1'
  const mysqlPort = Number(process.env.Y_LINK_DB_CONCURRENCY_MYSQL_PORT || process.env.DB_PORT || 3306)
  const mysqlUser = process.env.Y_LINK_DB_CONCURRENCY_MYSQL_USER || process.env.DB_USER || 'root'
  const mysqlPassword = process.env.Y_LINK_DB_CONCURRENCY_MYSQL_PASSWORD ?? process.env.DB_PASSWORD ?? ''
  const mysqlBaseName = process.env.Y_LINK_DB_CONCURRENCY_MYSQL_BASE_DB || process.env.DB_NAME || 'y_link'
  const tempDatabaseName = normalizeSqlIdentifier(`${mysqlBaseName}_concurrency_${runId}`)

  try {
    const mysql = await import('mysql2/promise')
    const connection = await mysql.createConnection({
      host: mysqlHost,
      port: mysqlPort,
      user: mysqlUser,
      password: mysqlPassword,
      connectTimeout: 3000,
      multipleStatements: false,
    })
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${tempDatabaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    await connection.end()
  } catch (error) {
    report.status = 'environment_blocked'
    report.errorMessage = `MySQL environment unavailable: ${error instanceof Error ? error.message : String(error)}`
    report.database = {
      type: 'mysql',
      host: mysqlHost,
      port: mysqlPort,
      user: mysqlUser,
      database: tempDatabaseName,
      environmentBlocked: true,
    }
    writeReport()
    process.exit(0)
  }

  process.env.DB_TYPE = 'mysql'
  process.env.DB_HOST = mysqlHost
  process.env.DB_PORT = String(mysqlPort)
  process.env.DB_USER = mysqlUser
  process.env.DB_PASSWORD = mysqlPassword
  process.env.DB_NAME = tempDatabaseName
  process.env.DB_SYNC = 'true'
  report.database = {
    type: 'mysql',
    host: mysqlHost,
    port: mysqlPort,
    user: mysqlUser,
    database: tempDatabaseName,
    temporarySchema: true,
  }

  return async () => {
    if (process.env.Y_LINK_DB_CONCURRENCY_KEEP_MYSQL === '1') return
    const mysql = await import('mysql2/promise')
    const connection = await mysql.createConnection({
      host: mysqlHost,
      port: mysqlPort,
      user: mysqlUser,
      password: mysqlPassword,
      connectTimeout: 3000,
      multipleStatements: false,
    })
    await connection.query(`DROP DATABASE IF EXISTS \`${tempDatabaseName}\``)
    await connection.end()
  }
}

async function ensureKnownAdmin(dataSource: { getRepository: Function }) {
  const { SysUser } = await import('../src/entities/sys-user.entity.js')
  const { hashPassword } = await import('../src/utils/password.js')
  const userRepo = dataSource.getRepository(SysUser)
  const username = process.env.INIT_ADMIN_USERNAME ?? 'admin'
  const password = process.env.INIT_ADMIN_PASSWORD ?? `DbConcurrency_${runId}_Aa1!`
  const existed = await userRepo.findOne({ where: { username } })

  if (existed) {
    existed.passwordHash = await hashPassword(password)
    existed.displayName = 'Database Concurrency Admin'
    existed.role = 'admin'
    existed.status = 'enabled'
    await userRepo.save(existed)
    return
  }

  await userRepo.save(
    userRepo.create({
      username,
      passwordHash: await hashPassword(password),
      displayName: 'Database Concurrency Admin',
      role: 'admin',
      status: 'enabled',
    }),
  )
}

async function seedClientSessions(dataSource: { getRepository: Function }, count: number) {
  const { ClientUser } = await import('../src/entities/client-user.entity.js')
  const { ClientUserSession } = await import('../src/entities/client-user-session.entity.js')
  const { hashPassword } = await import('../src/utils/password.js')
  const { hashSessionToken } = await import('../src/utils/session-token.js')
  const { generateSessionToken } = await import('../src/utils/token.js')
  const userRepo = dataSource.getRepository(ClientUser)
  const sessionRepo = dataSource.getRepository(ClientUserSession)
  const numericSeed = runId.replaceAll(/\D/g, '').slice(-8).padStart(8, '0')
  const baseMobileSuffix = Number(numericSeed)
  const now = new Date()
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000)
  const tokens: string[] = []

  for (let index = 0; index < count; index += 1) {
    const mobileSuffix = String((baseMobileSuffix + index) % 100_000_000).padStart(8, '0')
    const mobile = `139${mobileSuffix}`
    const email = `dbc_${runId}_${index}@example.local`
    const passwordHash = await hashPassword(`Client_${runId}_${index}_Aa1!`)
    const existed = await userRepo.findOne({ where: { mobile } })
    const user = existed ?? userRepo.create({ mobile })

    user.email = email
    user.passwordHash = passwordHash
    user.realName = `DBC Client ${index + 1}`
    user.departmentName = ''
    user.status = 'enabled'
    user.lastLoginAt = now

    const saved = await userRepo.save(user)
    const token = generateSessionToken()
    await sessionRepo.save(sessionRepo.create({
      sessionToken: hashSessionToken(token),
      userId: saved.id,
      expiresAt,
      lastAccessAt: now,
    }))
    tokens.push(token)
  }

  return tokens
}

async function waitForServer(server: Server) {
  if (server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.once('listening', () => resolve())
  })
}

function makeRequest(baseUrl: string) {
  return async function requestJson<T>(input: {
    scenario?: string
    label: string
    method?: string
    pathname: string
    token?: string
    body?: unknown
    expectedStatuses?: number[]
  }): Promise<{ response: Response; payload: T; sample: RequestSample }> {
    const method = input.method ?? 'GET'
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), thresholds.requestTimeoutMs)
    const startedAt = performance.now()
    let response: Response
    let payload: T
    try {
      response = await fetch(`${baseUrl}${input.pathname}`, {
        method,
        headers: {
          ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}),
          ...(input.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        signal: controller.signal,
      })
      const text = await response.text()
      payload = parseJsonPayload<T>(text)
    } catch (error) {
      const sample: RequestSample = {
        label: input.label,
        method,
        pathname: input.pathname,
        status: 0,
        code: null,
        durationMs: Number((performance.now() - startedAt).toFixed(2)),
        expected: false,
        message: error instanceof Error ? error.message : String(error),
      }
      if (input.scenario) {
        const samples = requestSamplesByScenario.get(input.scenario) ?? []
        samples.push(sample)
        requestSamplesByScenario.set(input.scenario, samples)
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }

    const statusCode = typeof (payload as { code?: unknown }).code === 'number'
      ? ((payload as { code: number }).code)
      : null
    const expectedStatuses = input.expectedStatuses ?? [200]
    const sample: RequestSample = {
      label: input.label,
      method,
      pathname: input.pathname,
      status: response.status,
      code: statusCode,
      durationMs: Number((performance.now() - startedAt).toFixed(2)),
      expected: expectedStatuses.includes(response.status) && (response.status !== 200 || statusCode === 0),
      message: typeof (payload as { message?: unknown }).message === 'string'
        ? (payload as { message: string }).message
        : null,
    }

    if (input.scenario) {
      const samples = requestSamplesByScenario.get(input.scenario) ?? []
      samples.push(sample)
      requestSamplesByScenario.set(input.scenario, samples)
    }

    return { response, payload, sample }
  }
}

async function loginAdminSession(
  requestJson: ReturnType<typeof makeRequest>,
  body: Record<string, unknown>,
  scene: string,
) {
  const loginResponse = await requestJson<{
    code?: number
    data?: {
      token?: string
      user?: { username: string; role: string }
    }
  }>({
    label: scene,
    method: 'POST',
    pathname: '/api/auth/login',
    body,
  })
  const token = loginResponse.payload.data?.token ?? readCookieValueFromResponse(loginResponse.response, 'y_link_admin_session')
  assert.equal(loginResponse.response.status, 200, `${scene} failed`)
  assert.ok(token, `${scene} did not return admin session cookie`)
  return {
    token,
    user: loginResponse.payload.data?.user ?? null,
  }
}

async function setupFixtures(
  requestJson: ReturnType<typeof makeRequest>,
  dataSource: { getRepository: Function },
) {
  const adminLogin = await loginAdminSession(
    requestJson,
    {
      username: 'admin',
      password: process.env.INIT_ADMIN_PASSWORD,
    },
    'admin login',
  )
  const adminToken = adminLogin.token

  const supplierPassword = `Supplier_${runId}_Aa1!`
  const supplier = await requestJson<{ code: number; data: { username: string } }>({
    label: 'create supplier',
    method: 'POST',
    pathname: '/api/users',
    token: adminToken,
    body: {
      username: `dbc_supplier_${runId}`,
      password: supplierPassword,
      displayName: 'DBC Supplier',
      role: 'supplier',
      status: 'enabled',
    },
  })
  assert.equal(supplier.response.status, 200, 'supplier create failed')

  const supplierLogin = await loginAdminSession(
    requestJson,
    {
      username: `dbc_supplier_${runId}`,
      password: supplierPassword,
    },
    'supplier login',
  )

  const clientTokens = await seedClientSessions(dataSource, thresholds.mixedScenarioUsers)

  addCheck('fixture users ready', {
    clientCount: clientTokens.length,
    supplierUsername: supplier.payload.data.username,
  })

  return {
    adminToken,
    supplierToken: supplierLogin.token,
    clientTokens,
  }
}

async function createProduct(
  requestJson: ReturnType<typeof makeRequest>,
  token: string,
  suffix: string,
  stock: number,
) {
  const response = await requestJson<{
    code: number
    data: { id: string; currentStock: number; preOrderedStock: number; productName: string }
  }>({
    label: `create product ${suffix}`,
    method: 'POST',
    pathname: '/api/products',
    token,
    body: {
      productCode: `DBC-${target}-${runId}-${suffix}`,
      productName: `DBC ${suffix}`,
      pinyinAbbr: `DBC${suffix}`,
      defaultPrice: 10,
      isActive: true,
      o2oStatus: 'listed',
      currentStock: stock,
      preOrderedStock: 0,
      limitPerUser: 999,
    },
  })
  assert.equal(response.response.status, 200, `create product ${suffix} failed`)
  return response.payload.data
}

async function getProductStock(AppDataSource: Awaited<typeof import('../src/config/data-source.js')>['AppDataSource'], id: string) {
  const rows: Array<{ currentStock: string | number; preOrderedStock: string | number }> = await AppDataSource.query(
    'SELECT current_stock AS currentStock, pre_ordered_stock AS preOrderedStock FROM base_product WHERE id = ?',
    [id],
  )
  assert.ok(rows.length === 1, `product not found: ${id}`)
  return {
    currentStock: Number(rows[0].currentStock),
    preOrderedStock: Number(rows[0].preOrderedStock),
  }
}

async function countRows(
  AppDataSource: Awaited<typeof import('../src/config/data-source.js')>['AppDataSource'],
  sql: string,
  params: unknown[],
) {
  const rows: Array<{ count: string | number }> = await AppDataSource.query(sql, params)
  return Number(rows[0]?.count ?? 0)
}

async function runBatch<T>(tasks: Array<() => Promise<T>>) {
  return Promise.all(tasks.map((task) => task()))
}

async function runScenarios(
  requestJson: ReturnType<typeof makeRequest>,
  fixtures: Awaited<ReturnType<typeof setupFixtures>>,
  AppDataSource: Awaited<typeof import('../src/config/data-source.js')>['AppDataSource'],
) {
  const stockRaceProduct = await createProduct(requestJson, fixtures.adminToken, 'stock-race', 5)

  await runBatch(
    Array.from({ length: thresholds.mixedScenarioUsers }, (_, index) => () =>
      requestJson({
        scenario: 'anonymous-mall-read',
        label: `mall read ${index + 1}`,
        pathname: '/api/o2o/mall/products',
      }),
    ),
  )

  await runBatch(
    fixtures.clientTokens.map((token, index) => () =>
      requestJson({
        scenario: 'client-order-read',
        label: `client order read ${index + 1}`,
        pathname: '/api/o2o/mall/preorders?page=1&pageSize=10',
        token,
      }),
    ),
  )

  const beforeStockRace = await getProductStock(AppDataSource, stockRaceProduct.id)
  const stockRaceResults = await runBatch(
    fixtures.clientTokens.map((token, index) => () =>
      requestJson({
        scenario: 'stock-race-preorder',
        label: `stock race preorder ${index + 1}`,
        method: 'POST',
        pathname: '/api/o2o/mall/preorders',
        token,
        expectedStatuses: [200, 409],
        body: {
          isSystemApplied: false,
          pickupContact: `client-${index + 1}`,
          items: [{ productId: stockRaceProduct.id, qty: 1 }],
        },
      }),
    ),
  )
  const afterStockRace = await getProductStock(AppDataSource, stockRaceProduct.id)
  const stockRaceSuccessCount = stockRaceResults.filter((result) => result.response.status === 200).length
  const stockRacePreorderDelta = afterStockRace.preOrderedStock - beforeStockRace.preOrderedStock
  assert.equal(stockRacePreorderDelta, stockRaceSuccessCount, 'preorder hold delta must match successful preorder count')
  assert.ok(afterStockRace.preOrderedStock <= afterStockRace.currentStock, 'preordered stock cannot exceed current stock')
  addCheck('stock race reconciliation passed', {
    productId: stockRaceProduct.id,
    successCount: stockRaceSuccessCount,
    conflictCount: stockRaceResults.filter((result) => result.response.status === 409).length,
    beforeStockRace,
    afterStockRace,
  })

  const verifyProduct = await createProduct(requestJson, fixtures.adminToken, 'verify-race', 10)
  const verifyOrder = await requestJson<{
    code: number
    data: { order: { id: string; verifyCode: string }; items: Array<{ qty: number }> }
  }>({
    label: 'create verify race preorder',
    method: 'POST',
    pathname: '/api/o2o/mall/preorders',
    token: fixtures.clientTokens[0],
    body: {
      isSystemApplied: false,
      pickupContact: 'verify-client',
      items: [{ productId: verifyProduct.id, qty: 2 }],
    },
  })
  const beforeVerifyStock = await getProductStock(AppDataSource, verifyProduct.id)
  const verifyResults = await runBatch(
    Array.from({ length: thresholds.mixedScenarioUsers }, (_, index) => () =>
      requestJson({
        scenario: 'same-preorder-verify',
        label: `same preorder verify ${index + 1}`,
        method: 'POST',
        pathname: '/api/o2o/verify',
        token: fixtures.adminToken,
        expectedStatuses: [200, 409],
        body: { verifyCode: verifyOrder.payload.data.order.verifyCode },
      }),
    ),
  )
  const afterVerifyStock = await getProductStock(AppDataSource, verifyProduct.id)
  const verifySuccessCount = verifyResults.filter((result) => result.response.status === 200).length
  assert.equal(verifySuccessCount, 1, 'same preorder verify must succeed exactly once')
  assert.equal(beforeVerifyStock.currentStock - afterVerifyStock.currentStock, 2, 'verify must deduct current stock once')
  assert.equal(beforeVerifyStock.preOrderedStock - afterVerifyStock.preOrderedStock, 2, 'verify must release preordered stock once')
  addCheck('same preorder verify reconciliation passed', {
    orderId: verifyOrder.payload.data.order.id,
    successCount: verifySuccessCount,
    beforeVerifyStock,
    afterVerifyStock,
  })

  const inboundProduct = await createProduct(requestJson, fixtures.adminToken, 'inbound-race', 1)
  const inboundBefore = await getProductStock(AppDataSource, inboundProduct.id)
  const supplierInbound = await requestJson<{
    code: number
    data: { order: { id: string; verifyCode: string }; items: unknown[] }
  }>({
    label: 'supplier submit inbound',
    method: 'POST',
    pathname: '/api/inbound/supplier/submit',
    token: fixtures.supplierToken,
    body: {
      remark: 'concurrency inbound',
      items: [{ productId: inboundProduct.id, qty: 7 }],
    },
  })
  assert.equal(supplierInbound.response.status, 200, 'supplier inbound submit failed')
  const inboundResults = await runBatch(
    Array.from({ length: thresholds.mixedScenarioUsers }, (_, index) => () =>
      requestJson({
        scenario: 'same-inbound-verify',
        label: `same inbound verify ${index + 1}`,
        method: 'POST',
        pathname: '/api/inbound/admin/verify',
        token: fixtures.adminToken,
        expectedStatuses: [200, 409],
        body: { verifyCode: supplierInbound.payload.data.order.verifyCode },
      }),
    ),
  )
  const inboundAfter = await getProductStock(AppDataSource, inboundProduct.id)
  const inboundSuccessCount = inboundResults.filter((result) => result.response.status === 200).length
  assert.equal(inboundSuccessCount, 1, 'same inbound verify must succeed exactly once')
  assert.equal(inboundAfter.currentStock - inboundBefore.currentStock, 7, 'inbound verify must add stock once')
  addCheck('same inbound verify reconciliation passed', {
    orderId: supplierInbound.payload.data.order.id,
    successCount: inboundSuccessCount,
    inboundBefore,
    inboundAfter,
  })

  const outboundProduct = await createProduct(requestJson, fixtures.adminToken, 'outbound-idempotent', 20)
  const idempotencyKey = `dbc-idempotent-${target}-${runId}`
  const sameKeyResults = await runBatch(
    Array.from({ length: thresholds.mixedScenarioUsers }, (_, index) => () =>
      requestJson({
        scenario: 'same-outbound-idempotency',
        label: `same outbound idempotency ${index + 1}`,
        method: 'POST',
        pathname: '/api/orders/submit',
        token: fixtures.adminToken,
        expectedStatuses: [200, 409],
        body: {
          idempotencyKey,
          orderType: 'walkin',
          issuerName: 'DBC',
          customerName: 'Concurrency Customer',
          items: [{ productId: outboundProduct.id, qty: 1, unitPrice: 10 }],
        },
      }),
    ),
  )
  const sameKeyOrderCount = await countRows(
    AppDataSource,
    'SELECT COUNT(1) AS count FROM biz_outbound_order WHERE idempotency_key = ?',
    [idempotencyKey],
  )
  assert.equal(sameKeyOrderCount, 1, 'same idempotency key must create exactly one outbound order')
  addCheck('same outbound idempotency reconciliation passed', {
    successCount: sameKeyResults.filter((result) => result.response.status === 200).length,
    conflictCount: sameKeyResults.filter((result) => result.response.status === 409).length,
    sameKeyOrderCount,
  })

  const differentKeyResults = await runBatch(
    Array.from({ length: thresholds.mixedScenarioUsers }, (_, index) => () =>
      requestJson({
        scenario: 'different-outbound-idempotency',
        label: `different outbound idempotency ${index + 1}`,
        method: 'POST',
        pathname: '/api/orders/submit',
        token: fixtures.adminToken,
        expectedStatuses: [200, 409],
        body: {
          idempotencyKey: `dbc-idempotent-${target}-${runId}-${index}`,
          orderType: 'walkin',
          issuerName: 'DBC',
          customerName: `Concurrency Customer ${index}`,
          items: [{ productId: outboundProduct.id, qty: 1, unitPrice: 10 }],
        },
      }),
    ),
  )
  const differentSuccessCount = differentKeyResults.filter((result) => result.response.status === 200).length
  const differentUniqueShowNoCount = await countRows(
    AppDataSource,
    `
      SELECT COUNT(1) AS count
      FROM (
        SELECT show_no
        FROM biz_outbound_order
        WHERE idempotency_key LIKE ?
        GROUP BY show_no
      ) unique_show_no
    `,
    [`dbc-idempotent-${target}-${runId}-%`],
  )
  assert.equal(differentUniqueShowNoCount, differentSuccessCount, 'successful outbound orders must have unique show numbers')
  addCheck('different outbound idempotency reconciliation passed', {
    successCount: differentSuccessCount,
    uniqueShowNoCount: differentUniqueShowNoCount,
  })

  const mixedProduct = await createProduct(requestJson, fixtures.adminToken, 'mixed', 30)
  await runBatch(
    Array.from({ length: thresholds.mixedScenarioUsers }, (_, index) => {
      const token = fixtures.clientTokens[index % fixtures.clientTokens.length]
      const bucket = index % 5
      if (bucket === 0) {
        return () =>
          requestJson({
            scenario: 'mixed-read-write',
            label: `mixed mall read ${index + 1}`,
            pathname: '/api/o2o/mall/products',
          })
      }
      if (bucket === 1) {
        return () =>
          requestJson({
            scenario: 'mixed-read-write',
            label: `mixed client orders ${index + 1}`,
            pathname: '/api/o2o/mall/preorders?page=1&pageSize=10',
            token,
          })
      }
      if (bucket === 2) {
        return () =>
          requestJson({
            scenario: 'mixed-read-write',
            label: `mixed inventory logs ${index + 1}`,
            pathname: '/api/o2o/inventory/logs?limit=20',
            token: fixtures.adminToken,
          })
      }
      if (bucket === 3) {
        return () =>
          requestJson({
            scenario: 'mixed-read-write',
            label: `mixed admin inbound list ${index + 1}`,
            pathname: '/api/inbound/admin/list?limit=20',
            token: fixtures.adminToken,
          })
      }
      return () =>
        requestJson({
          scenario: 'mixed-read-write',
          label: `mixed preorder ${index + 1}`,
          method: 'POST',
          pathname: '/api/o2o/mall/preorders',
          token,
          expectedStatuses: [200, 409],
          body: {
            isSystemApplied: false,
            pickupContact: `mixed-${index + 1}`,
            items: [{ productId: mixedProduct.id, qty: 1 }],
          },
        })
    }),
  )

  const duplicateChecks = [
    {
      tableName: 'o2o_preorder',
      columnName: 'show_no',
      title: 'preorder show numbers unique',
    },
    {
      tableName: 'o2o_preorder',
      columnName: 'verify_code',
      title: 'preorder verify codes unique',
    },
    {
      tableName: 'biz_inbound_order',
      columnName: 'show_no',
      title: 'inbound show numbers unique',
    },
    {
      tableName: 'biz_inbound_order',
      columnName: 'verify_code',
      title: 'inbound verify codes unique',
    },
    {
      tableName: 'biz_outbound_order',
      columnName: 'show_no',
      title: 'outbound show numbers unique',
    },
  ]
  for (const check of duplicateChecks) {
    const duplicateCount = await countRows(
      AppDataSource,
      `
        SELECT COUNT(1) AS count
        FROM (
          SELECT ${check.columnName}
          FROM ${check.tableName}
          GROUP BY ${check.columnName}
          HAVING COUNT(1) > 1
        ) duplicated
      `,
      [],
    )
    assert.equal(duplicateCount, 0, check.title)
    addCheck(check.title, {
      tableName: check.tableName,
      columnName: check.columnName,
      duplicateCount,
    })
  }

  const dirtyProductCount = await countRows(
    AppDataSource,
    'SELECT COUNT(1) AS count FROM base_product WHERE pre_ordered_stock > current_stock OR current_stock < 0 OR pre_ordered_stock < 0',
    [],
  )
  assert.equal(dirtyProductCount, 0, 'stock invariants must hold')
  addCheck('stock invariants passed', { dirtyProductCount })

  if (target === 'sqlite') {
    const integrityRows: Array<{ integrity_check: string }> = await AppDataSource.query('PRAGMA integrity_check')
    const integrityCheck = integrityRows[0]?.integrity_check ?? 'missing'
    assert.equal(integrityCheck, 'ok', 'SQLite integrity_check must be ok')
    addCheck('sqlite integrity_check passed', { integrityCheck })
  }
}

function finalizeScenarioMetrics() {
  for (const [scenario, samples] of requestSamplesByScenario.entries()) {
    const summary = summarizeSamples(samples)
    report.scenarios[scenario] = summary
    if (summary.totalRequests === 0) continue
    const unexpectedErrorRate = summary.unexpectedErrorCount / summary.totalRequests
    if (unexpectedErrorRate > thresholds.maxUnexpectedErrorRate) {
      addFailure(`${scenario} unexpected error rate exceeded`, { summary, unexpectedErrorRate })
    }
    if (summary.averageMs > thresholds.maxAverageResponseMs) {
      addFailure(`${scenario} average response exceeded`, { summary })
    }
    if (summary.p95Ms > thresholds.maxP95ResponseMs) {
      addFailure(`${scenario} p95 response exceeded`, { summary })
    }
  }

  const failedSamples = [...requestSamplesByScenario.values()]
    .flat()
    .filter((sample) => !sample.expected)
    .slice(0, 30)
  report.failedSamples = failedSamples
}

async function main() {
  if (target !== 'sqlite' && target !== 'mysql') {
    throw new Error(`unsupported target: ${target}`)
  }

  const cleanupTarget = await prepareTargetEnvironment()
  let server: Server | null = null
  let dataSource: Awaited<typeof import('../src/config/data-source.js')>['AppDataSource'] | null = null

  try {
    const { createApp } = await import('../src/app.js')
    const { AppDataSource } = await import('../src/config/data-source.js')
    const { applySqlitePragmas, initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime } = await import('../src/config/database-bootstrap.js')
    const { installSqliteTransactionQueue } = await import('../src/utils/sqlite-transaction-queue.js')
    const { authService } = await import('../src/services/auth.service.js')
    const { systemConfigService } = await import('../src/services/system-config.service.js')

    dataSource = AppDataSource
    prepareDatabaseRuntime()
    await AppDataSource.initialize()
    await applySqlitePragmas(AppDataSource)
    installSqliteTransactionQueue(AppDataSource)
    await initializeDatabaseSchemaIfNeeded(AppDataSource)
    await authService.ensureDefaultAdmin()
    await ensureKnownAdmin(AppDataSource)
    await systemConfigService.ensureDefaultConfigs()

    const app = createApp()
    server = app.listen(0, '127.0.0.1')
    await waitForServer(server)
    const address = server.address()
    assert.ok(address && typeof address === 'object' && typeof address.port === 'number', 'server port unavailable')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const requestJson = makeRequest(baseUrl)

    const health = await requestJson<{ code: number; data: { status: string } }>({
      label: 'health',
      pathname: '/health',
    })
    assert.equal(health.payload.data.status, 'UP')

    const fixtures = await setupFixtures(requestJson, AppDataSource)
    await runScenarios(requestJson, fixtures, AppDataSource)
    finalizeScenarioMetrics()

    if (report.failures.length > 0) {
      report.status = 'failed'
      report.errorMessage = `${report.failures.length} concurrency acceptance checks failed`
      process.exitCode = 1
      return
    }

    report.status = 'passed'
  } catch (error) {
    report.status = 'failed'
    report.errorMessage = error instanceof Error ? error.stack ?? error.message : String(error)
    process.exitCode = 1
  } finally {
    finalizeScenarioMetrics()
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()))
    }
    if (dataSource?.isInitialized) {
      await dataSource.destroy()
    }
    try {
      await cleanupTarget?.()
    } catch (error) {
      addFailure('temporary database cleanup failed', {
        message: error instanceof Error ? error.message : String(error),
      })
      if (report.status === 'passed') {
        report.status = 'failed'
        process.exitCode = 1
      }
    }
    writeReport()
  }
}

await main()
