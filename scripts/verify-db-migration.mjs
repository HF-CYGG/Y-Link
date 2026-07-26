/**
 * 模块说明：scripts/verify-db-migration.mjs
 * 文件职责：通过隔离 Docker Compose 环境严格验收 SQLite -> MySQL onebox 自动迁移闭环。
 * 实现逻辑：
 * - 首先检查 Docker CLI、Docker Compose 与 Docker daemon，任一不可用都明确失败，不允许跳过即通过；
 * - 每次运行生成独立 Compose project、随机测试凭据、临时卷和 internal 网络，迁移目标固定为编排内 MySQL；
 * - 默认覆盖自动任务 API、维护只读屏障、/health 横幅、容器自动重启、MySQL 实际生效与业务快照一致性；
 * - 可用 Y_LINK_DB_MIGRATION_SCENARIO 运行错误连接、非空目标库、切换持久化失败及连续启动失败自动回退断言。
 * 维护说明：
 * - 禁止把外部数据库参数接入本脚本，避免验收命令误伤开发库或生产库；
 * - 后端契约变化时必须更新这里的真实 HTTP 断言，不能降级为源码字符串匹配或 skip-as-pass。
 */

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const composeFile = path.join(projectRoot, 'docker', 'compose.verify-db-migration.yml')

const mysqlTarget = Object.freeze({
  host: 'mysql',
  port: 3306,
  user: 'y_link_verify',
  database: 'y_link_migration_verify',
})

const allowedScenarios = new Set([
  'success',
  'wrong-connection',
  'old-version',
  'wrong-charset',
  'insufficient-permissions',
  'non-empty-target',
  'duplicate-task',
  'content-tamper',
  'execution-interruption',
  'cutover-persistence-failure',
  'verifying-emergency-rollback',
  'failure-rollback',
])
const terminalTaskStatuses = new Set(['succeeded', 'failed', 'rolled_back'])
const acceptedTaskStatuses = new Set([
  'queued',
  'running',
  'restart_pending',
  'verifying',
  'succeeded',
  'failed',
  'rolled_back',
])
const defaultTimeoutMs = Number(process.env.Y_LINK_DB_MIGRATION_TIMEOUT_MS ?? 240_000)
const dockerPrerequisiteTimeoutMs = 12_000
const scenario = String(process.env.Y_LINK_DB_MIGRATION_SCENARIO ?? 'success').trim()
const composeProject = `ylink-db-migration-${Date.now().toString(36)}-${process.pid}`
  .toLowerCase()
  .replace(/[^a-z0-9_-]/g, '-')
const adminPassword = `Admin-${crypto.randomBytes(18).toString('hex')}`
const mysqlPassword = `Mysql-${crypto.randomBytes(18).toString('hex')}`
const mysqlRootPassword = `Root-${crypto.randomBytes(18).toString('hex')}`

class VerificationError extends Error {}

class DockerPrerequisiteError extends VerificationError {}

class ProcessTimeoutError extends Error {
  constructor(label, timeoutMs) {
    super(`${label} 超时（${timeoutMs}ms）`)
    this.name = 'ProcessTimeoutError'
    this.code = 'PROCESS_TIMEOUT'
    this.timeoutMs = timeoutMs
  }
}

const delay = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms)
})

const log = (message) => {
  console.log(`[verify:db:migration] ${message}`)
}

const formatProcessFailure = ({ command, args, code, stderr, error }) => {
  if (error?.code === 'ENOENT') {
    return `未找到命令：${command}`
  }
  if (error?.code === 'PROCESS_TIMEOUT') {
    return `${error.message}，命令：${command} ${args.join(' ')}`
  }
  if (error) {
    return `无法启动命令 ${command}（${error.code ?? error.name ?? 'unknown'}：${error.message}）`
  }
  const detail = String(stderr ?? '').trim()
  return `${command} ${args.join(' ')} 执行失败（exit=${code ?? 'spawn-error'}）${detail ? `：${detail}` : ''}`
}

const runProcess = async (command, args, options = {}) => {
  const {
    cwd = projectRoot,
    env = process.env,
    capture = false,
    allowFailure = false,
    label = `${command} ${args.join(' ')}`,
    timeoutMs,
  } = options

  return await new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      })
    } catch (error) {
      const result = {
        command,
        args,
        code: null,
        stdout: '',
        stderr: '',
        error,
      }
      if (allowFailure) {
        resolve(result)
        return
      }
      reject(new VerificationError(`${label}：${formatProcessFailure(result)}`))
      return
    }
    const stdoutChunks = []
    const stderrChunks = []
    let settled = false
    let timeoutTimer = null

    const settle = (result) => {
      if (settled) {
        return
      }
      settled = true
      if (timeoutTimer) {
        clearTimeout(timeoutTimer)
        timeoutTimer = null
      }
      if (result.code === 0 || allowFailure) {
        resolve(result)
        return
      }
      reject(new VerificationError(`${label}：${formatProcessFailure(result)}`))
    }

    if (capture) {
      child.stdout.on('data', (chunk) => stdoutChunks.push(chunk))
      child.stderr.on('data', (chunk) => stderrChunks.push(chunk))
    }

    child.once('error', (error) => {
      const result = {
        command,
        args,
        code: null,
        stdout: '',
        stderr: '',
        error,
      }
      settle(result)
    })

    child.once('close', (code) => {
      const result = {
        command,
        args,
        code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        error: null,
      }
      settle(result)
    })

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        const error = new ProcessTimeoutError(label, timeoutMs)
        try {
          child.kill()
        } catch {
          // 子进程可能已在超时边界退出；settle 仍负责只返回一次稳定的超时结果。
        }
        settle({
          command,
          args,
          code: null,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          error,
        })
      }, timeoutMs)
      timeoutTimer.unref?.()
    }
  })
}

const verifyDockerPrerequisites = async () => {
  const dockerCli = await runProcess('docker', ['--version'], {
    capture: true,
    allowFailure: true,
    timeoutMs: dockerPrerequisiteTimeoutMs,
  })
  if (dockerCli.code !== 0) {
    throw new DockerPrerequisiteError(
      `Docker 前置门禁失败：${formatProcessFailure(dockerCli)}。本验收禁止在 Docker 缺失时跳过。`,
    )
  }

  const composePlugin = await runProcess('docker', ['compose', 'version'], {
    capture: true,
    allowFailure: true,
    timeoutMs: dockerPrerequisiteTimeoutMs,
  })
  if (composePlugin.code !== 0) {
    throw new DockerPrerequisiteError(
      `Docker Compose 前置门禁失败：${formatProcessFailure(composePlugin)}。请安装 Compose v2 后重试。`,
    )
  }

  const daemon = await runProcess('docker', ['info', '--format', '{{.ServerVersion}}'], {
    capture: true,
    allowFailure: true,
    timeoutMs: dockerPrerequisiteTimeoutMs,
  })
  if (daemon.code !== 0 || !daemon.stdout.trim()) {
    throw new DockerPrerequisiteError(
      `Docker daemon 前置门禁失败：${formatProcessFailure(daemon)}。请启动 Docker daemon 后重试，禁止 skip-as-pass。`,
    )
  }

  log(`Docker 门禁通过：${dockerCli.stdout.trim()}；${composePlugin.stdout.trim()}；daemon=${daemon.stdout.trim()}`)
}

const resolveAvailablePort = async () =>
  await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new VerificationError('无法分配 onebox 本机隔离端口'))
        return
      }
      const { port } = address
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(port)
      })
    })
  })

const buildComposeEnvironment = (oneboxPort) => ({
  ...process.env,
  Y_LINK_VERIFY_ONEBOX_PORT: String(oneboxPort),
  Y_LINK_VERIFY_ADMIN_PASSWORD: adminPassword,
  Y_LINK_VERIFY_MYSQL_PASSWORD: mysqlPassword,
  Y_LINK_VERIFY_MYSQL_ROOT_PASSWORD: mysqlRootPassword,
  Y_LINK_VERIFY_MYSQL_STARTUP_FAILURES: scenario === 'failure-rollback' ? '2' : '0',
  Y_LINK_VERIFY_MYSQL_IMAGE: scenario === 'old-version' ? 'mysql:8.0.15' : 'mysql:8.4',
  Y_LINK_VERIFY_TAMPER_TARGET: scenario === 'content-tamper' ? 'true' : 'false',
  Y_LINK_VERIFY_INTERRUPT_ONCE: scenario === 'execution-interruption' ? 'true' : 'false',
  Y_LINK_VERIFY_FAIL_CUTOVER_TASK_WRITE_ONCE: scenario === 'cutover-persistence-failure' ? 'true' : 'false',
  Y_LINK_VERIFY_FINALIZER_DELAY_MS: scenario === 'verifying-emergency-rollback' ? '10000' : '0',
})

const composeArgs = (...args) => [
  'compose',
  '--project-name',
  composeProject,
  '--file',
  composeFile,
  ...args,
]

const runCompose = async (args, options = {}) =>
  await runProcess('docker', composeArgs(...args), options)

const fetchWithTimeout = async (url, options = {}, timeoutMs = 5000) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

const collectSetCookieHeaders = (headers) => {
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie()
  }
  const rawSetCookie = headers.get('set-cookie')
  if (!rawSetCookie) {
    return []
  }
  return rawSetCookie
    .split(/,\s*(?=[^=;,]+=)/)
    .map((item) => item.trim())
    .filter(Boolean)
}

const updateCookieJar = (cookieJar, headers) => {
  for (const setCookieHeader of collectSetCookieHeaders(headers)) {
    const pair = setCookieHeader.split(';')[0]?.trim()
    const separatorIndex = pair?.indexOf('=') ?? -1
    if (!pair || separatorIndex <= 0) {
      continue
    }
    cookieJar.set(pair.slice(0, separatorIndex), pair.slice(separatorIndex + 1))
  }
}

const buildCookieHeader = (cookieJar) =>
  Array.from(cookieJar.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')

const parseJsonResponse = async (response, label) => {
  const text = await response.text()
  try {
    return text ? JSON.parse(text) : null
  } catch {
    throw new VerificationError(`${label} 未返回合法 JSON（HTTP ${response.status}）`)
  }
}

const createHttpClient = (baseUrl) => {
  const cookieJar = new Map()

  const request = async (pathname, options = {}) => {
    const {
      method = 'GET',
      body,
      expectedStatuses = [200],
      authenticated = true,
      includeCsrf = !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()),
      timeoutMs = 10_000,
    } = options
    const headers = {
      Accept: 'application/json',
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }
    if (authenticated && cookieJar.size > 0) {
      headers.Cookie = buildCookieHeader(cookieJar)
    }
    if (includeCsrf) {
      const csrfToken = cookieJar.get('y_link_admin_csrf')
      if (csrfToken) {
        headers['x-csrf-token'] = csrfToken
      }
    }

    const response = await fetchWithTimeout(
      `${baseUrl}${pathname}`,
      {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      timeoutMs,
    )
    updateCookieJar(cookieJar, response.headers)
    const payload = await parseJsonResponse(response, `${method} ${pathname}`)
    if (!expectedStatuses.includes(response.status)) {
      throw new VerificationError(
        `${method} ${pathname} 返回 HTTP ${response.status}，期望 ${expectedStatuses.join('/')}；code=${payload?.code ?? 'unknown'}，message=${payload?.message ?? 'unknown'}`,
      )
    }
    return {
      response,
      payload,
    }
  }

  const login = async () => {
    cookieJar.clear()
    const result = await request('/api/auth/login', {
      method: 'POST',
      authenticated: false,
      includeCsrf: false,
      body: {
        username: 'admin',
        password: adminPassword,
      },
    })
    assert.equal(result.payload?.code, 0, '管理员登录 envelope code 必须为 0')
    assert.ok(result.payload?.data?.user?.id, '管理员登录必须返回真实用户')
    assert.ok(cookieJar.get('y_link_admin_session'), '管理员登录必须写入 session Cookie')
    assert.ok(cookieJar.get('y_link_admin_csrf'), '管理员登录必须写入 CSRF Cookie')
    return result.payload.data.user
  }

  return {
    request,
    login,
  }
}

const readHealth = async (baseUrl) => {
  const response = await fetchWithTimeout(`${baseUrl}/health`, {}, 5000)
  const payload = await parseJsonResponse(response, 'GET /health')
  if (response.status !== 200 || payload?.status !== 'UP') {
    throw new VerificationError(
      `/health 异常：HTTP ${response.status}，status=${payload?.status ?? 'unknown'}`,
    )
  }
  return payload
}

const readRuntimeOverrideState = async (client) => {
  const { payload } = await client.request('/api/data-maintenance/db-migration/runtime-override')
  assert.equal(payload?.code, 0, '数据库运行时状态接口必须成功')
  assert.ok(payload?.data?.effectiveDatabase, '数据库运行时状态接口缺少 effectiveDatabase')
  assert.ok(payload?.data?.runtimeOverrideStatus, '数据库运行时状态接口缺少 runtimeOverrideStatus')
  return payload.data
}

const waitFor = async (label, probe, options = {}) => {
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs
  const intervalMs = options.intervalMs ?? 500
  const startedAt = Date.now()
  let lastError

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await probe()
      if (result) {
        return result
      }
    } catch (error) {
      lastError = error
    }
    await delay(intervalMs)
  }

  throw new VerificationError(
    `${label} 超时（${timeoutMs}ms）${lastError ? `；最后错误：${lastError instanceof Error ? lastError.message : String(lastError)}` : ''}`,
  )
}

const waitForRuntimeState = async ({
  baseUrl,
  client,
  label,
  dbType,
  readOnly,
  phase,
  intervalMs = 500,
}) =>
  await waitFor(
    label,
    async () => {
      const health = await readHealth(baseUrl)
      if (health.maintenance?.readOnly !== readOnly) {
        return null
      }
      if (phase !== undefined && health.maintenance?.phase !== phase) {
        return null
      }
      const runtimeState = await readRuntimeOverrideState(client)
      return runtimeState.effectiveDatabase?.dbType === dbType
        ? { health, runtimeState }
        : null
    },
    { intervalMs },
  )

const normalizeComparableNumber = (value) => {
  const normalized = String(value).trim()
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) {
    return value
  }
  const negative = normalized.startsWith('-')
  const unsigned = negative ? normalized.slice(1) : normalized
  const [integerPart, fractionPart = ''] = unsigned.split('.')
  const integer = integerPart.replace(/^0+(?=\d)/, '') || '0'
  const fraction = fractionPart.replace(/0+$/, '')
  const numeric = fraction ? `${integer}.${fraction}` : integer
  return negative && numeric !== '0' ? `-${numeric}` : numeric
}

const isCrossDialectNumericField = (fieldName) => (
  typeof fieldName === 'string'
  && (
    fieldName.toLowerCase().endsWith('id')
    || /(?:price|amount|rate|qty)$/i.test(fieldName)
  )
)

const normalizeSnapshotValue = (value, fieldName) => {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeSnapshotValue(item, fieldName))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, normalizeSnapshotValue(nestedValue, key)]),
    )
  }
  if (
    isCrossDialectNumericField(fieldName)
    && (typeof value === 'number' || typeof value === 'string')
  ) {
    return normalizeComparableNumber(value)
  }
  return value
}

const normalizeExportTables = (tables) => Object.fromEntries(
  Object.entries(tables)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([tableName, rows]) => [
      tableName,
      rows
        .map((row) => normalizeSnapshotValue(row))
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    ]),
)

const assertExportNormalizationContract = () => {
  const left = normalizeExportTables({
    example: [
      { id: 2, payload: ['a', 'b'] },
      { id: 1, payload: ['c'] },
    ],
  })
  const reorderedRows = normalizeExportTables({
    example: [
      { id: 1, payload: ['c'] },
      { id: 2, payload: ['a', 'b'] },
    ],
  })
  const reorderedJsonArray = normalizeExportTables({
    example: [
      { id: 1, payload: ['c'] },
      { id: 2, payload: ['b', 'a'] },
    ],
  })
  assert.deepEqual(left, reorderedRows, '导出快照应忽略顶层表记录返回顺序')
  assert.notDeepEqual(left, reorderedJsonArray, '导出快照必须保留 JSON 字段内部数组顺序')
}

assertExportNormalizationContract()

const readExportSnapshot = async (client) => {
  const { payload } = await client.request('/api/data-maintenance/export/json')
  assert.equal(payload?.code, 0, 'JSON 导出 envelope code 必须为 0')
  assert.ok(payload?.data?.tables && typeof payload.data.tables === 'object', 'JSON 导出必须包含 tables')
  const tableRows = Object.values(payload.data.tables)
  assert.ok(tableRows.every((rows) => Array.isArray(rows)), 'JSON 导出 tables 中每项都必须是数组')
  const totalRows = tableRows.reduce((sum, rows) => sum + rows.length, 0)
  assert.ok(totalRows > 0, 'SQLite 基线夹具必须包含至少一条可迁移业务数据')
  return normalizeExportTables(payload.data.tables)
}

const readMigrationTaskIds = async (client) => {
  const { payload } = await client.request('/api/data-maintenance/db-migration/tasks')
  assert.equal(payload?.code, 0, '迁移任务列表 envelope code 必须为 0')
  assert.ok(Array.isArray(payload?.data), '迁移任务列表 data 必须为数组')
  return payload.data
    .map((task) => task?.id)
    .filter((taskId) => typeof taskId === 'string' && taskId.length > 0)
    .sort()
}

const assertMigrationAuditExists = async (client, actionType, taskId) => {
  const search = new URLSearchParams({
    page: '1',
    pageSize: '20',
    actionType,
    targetId: taskId,
  })
  const { payload } = await client.request(`/api/audit-logs?${search.toString()}`)
  assert.equal(payload?.code, 0, '迁移审计查询 envelope code 必须为 0')
  assert.ok(
    Array.isArray(payload?.data?.list) && payload.data.list.some((item) =>
      item.actionType === actionType && item.targetId === taskId),
    `缺少迁移终态审计：${actionType} / ${taskId}`,
  )
  assert.ok(
    !JSON.stringify(payload.data.list).includes(mysqlPassword),
    `迁移终态审计泄露 MySQL 密码：${actionType}`,
  )
}

const createAutomaticTask = async (client, target) => {
  const { response, payload } = await client.request(
    '/api/data-maintenance/db-migration/automatic-tasks',
    {
      method: 'POST',
      expectedStatuses: [202],
      body: {
        target,
        note: `隔离自动迁移验收：${scenario}`,
      },
      timeoutMs: 60_000,
    },
  )
  assert.equal(response.status, 202, '自动任务 API 必须返回 HTTP 202')
  assert.equal(payload?.code, 0, '自动任务 API envelope code 必须为 0')
  assert.ok(payload?.data?.id, '自动任务 API 必须返回脱敏任务 id')
  assert.ok(acceptedTaskStatuses.has(payload.data.status), `自动任务返回了未知状态：${payload.data.status}`)
  const serializedTask = JSON.stringify(payload.data)
  assert.ok(!serializedTask.includes(mysqlPassword), '自动任务响应泄露了 MySQL 密码')
  assert.ok(!serializedTask.includes(mysqlRootPassword), '自动任务响应泄露了 MySQL root 密码')
  return payload.data
}

const readMigrationTask = async (client, taskId) => {
  const { payload } = await client.request(`/api/data-maintenance/db-migration/tasks/${encodeURIComponent(taskId)}`)
  assert.equal(payload?.code, 0, '任务查询 envelope code 必须为 0')
  assert.equal(payload?.data?.id, taskId, '任务查询返回了错误 task id')
  assert.ok(acceptedTaskStatuses.has(payload.data.status), `任务查询返回了未知状态：${payload.data.status}`)
  const serializedTask = JSON.stringify(payload.data)
  assert.ok(!serializedTask.includes(mysqlPassword), '任务查询响应泄露了 MySQL 密码')
  return payload.data
}

const waitForTaskTerminal = async (client, taskId) => {
  let lastStatus = null
  const task = await waitFor(
    `自动迁移任务 ${taskId} 进入终态`,
    async () => {
      const currentTask = await readMigrationTask(client, taskId)
      if (currentTask.status !== lastStatus) {
        lastStatus = currentTask.status
        log(`任务状态：${lastStatus}`)
      }
      return terminalTaskStatuses.has(currentTask.status) ? currentTask : null
    },
    {
      intervalMs: 500,
    },
  )
  return task
}

const getOneboxContainerState = async (composeEnv) => {
  const psResult = await runCompose(['ps', '--quiet', 'onebox'], {
    capture: true,
    env: composeEnv,
  })
  const containerId = psResult.stdout.trim()
  assert.ok(containerId, 'Compose 未返回 onebox 容器 ID')
  const inspectResult = await runProcess(
    'docker',
    ['inspect', '--format', '{{.RestartCount}}|{{.State.Status}}|{{.State.Health.Status}}', containerId],
    {
      capture: true,
      env: composeEnv,
    },
  )
  const [restartCountText, status, healthStatus] = inspectResult.stdout.trim().split('|')
  return {
    containerId,
    restartCount: Number(restartCountText),
    status,
    healthStatus,
  }
}

const waitForOneboxRestart = async (composeEnv, initialRestartCount, client, taskId) => {
  const result = await waitFor(
    'onebox 自动重启',
    async () => {
      const state = await getOneboxContainerState(composeEnv)
      if (state.restartCount > initialRestartCount) {
        return { restartedState: state }
      }
      const currentTask = await readMigrationTask(client, taskId)
      return terminalTaskStatuses.has(currentTask.status) ? { terminalTask: currentTask } : null
    },
    {
      intervalMs: 250,
    },
  )
  if (result.terminalTask) {
    throw new VerificationError(
      `自动迁移在 onebox 重启前已终止：status=${result.terminalTask.status}，error=${result.terminalTask.errorMessage ?? '(none)'}`,
    )
  }
  return result.restartedState
}

const runMySqlQuery = async (composeEnv, sql) => {
  const result = await runCompose(
    [
      'exec',
      '-T',
      'mysql',
      'sh',
      '-ec',
      'MYSQL_PWD="$MYSQL_PASSWORD" mysql --batch --skip-column-names -u"$MYSQL_USER" "$MYSQL_DATABASE" -e "$1"',
      'verify-db-migration',
      sql,
    ],
    {
      capture: true,
      env: composeEnv,
      label: '执行隔离 MySQL 断言',
    },
  )
  return result.stdout.trim()
}

const runMySqlRootQuery = async (composeEnv, sql) => {
  const result = await runCompose(
    [
      'exec',
      '-T',
      'mysql',
      'sh',
      '-ec',
      'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql --batch --skip-column-names -uroot -e "$1"',
      'verify-db-migration-root',
      sql,
    ],
    {
      capture: true,
      env: composeEnv,
      label: '执行隔离 MySQL root 断言',
    },
  )
  return result.stdout.trim()
}

const runFullEntityFixtureCommand = async (composeEnv, verifyOnly = false) => {
  const args = ['exec', '-T']
  if (verifyOnly) {
    args.push('-e', 'Y_LINK_DB_MIGRATION_E2E_FIXTURE_MODE=verify')
  }
  args.push(
    'onebox',
    'node',
    '/app/backend/dist/commands/seed-database-migration-e2e.js',
  )
  const result = await runCompose(args, {
    capture: true,
    env: composeEnv,
    label: verifyOnly ? '复核回退后的全实体 SQLite 夹具' : '生成全实体 SQLite 迁移夹具',
  })
  const manifestLine = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .reverse()
    .find((line) => line.startsWith('{') && line.endsWith('}'))
  if (!manifestLine) {
    throw new VerificationError('全实体迁移夹具命令未返回 JSON 清单')
  }
  const manifest = JSON.parse(manifestLine)
  const tableCounts = manifest?.tableCounts
  assert.ok(tableCounts && typeof tableCounts === 'object', '全实体迁移夹具缺少 tableCounts')
  assert.equal(
    manifest.tableCount,
    Object.keys(tableCounts).length,
    '全实体迁移夹具 tableCount 与实际清单不一致',
  )
  assert.ok(manifest.tableCount >= 26, `全实体迁移夹具表数异常：${manifest.tableCount}`)
  assert.ok(
    Object.values(tableCounts).every((rowCount) => Number.isSafeInteger(rowCount) && rowCount > 0),
    '全实体迁移夹具仍存在空表',
  )
  return manifest
}

const assertFixtureCountsNotReduced = (actualCounts, baselineCounts, label) => {
  for (const [tableName, baselineCount] of Object.entries(baselineCounts)) {
    assert.ok(
      Number(actualCounts[tableName]) >= Number(baselineCount),
      `${label}：表 ${tableName} 行数从 ${baselineCount} 降为 ${actualCounts[tableName]}`,
    )
  }
}

const assertFullTableValidationPassed = (terminalTask, fixtureManifest) => {
  const validationItems = terminalTask.result?.validation?.items
  assert.ok(Array.isArray(validationItems), '成功任务缺少全表强校验明细')
  assert.equal(
    validationItems.length,
    fixtureManifest.tableCount,
    '成功任务强校验表数与全实体夹具不一致',
  )
  assert.ok(
    validationItems.every((item) =>
      item.sourceRowCount > 0
      && item.targetRowCount > 0
      && item.sourceSha256
      && item.sourceSha256 === item.targetSha256
      && item.structureMatched === true
      && item.constraintsMatched === true
      && item.autoIncrementMatched === true),
    '成功任务未对每张非空实体表完成内容、结构、约束与自增强校验',
  )
}

const assertIsolatedComposeResources = async (composeEnv) => {
  const volumesResult = await runProcess(
    'docker',
    [
      'volume',
      'ls',
      '--quiet',
      '--filter',
      `label=com.docker.compose.project=${composeProject}`,
    ],
    {
      capture: true,
      env: composeEnv,
    },
  )
  const volumes = volumesResult.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
  assert.equal(volumes.length, 3, '验收编排必须创建且只创建 3 个 project 隔离卷')
  assert.ok(volumes.every((name) => name.startsWith(`${composeProject}_`)), '验收卷名称没有按 project 隔离')

  const mysqlContainer = await runCompose(['ps', '--quiet', 'mysql'], {
    capture: true,
    env: composeEnv,
  })
  const mysqlContainerId = mysqlContainer.stdout.trim()
  assert.ok(mysqlContainerId, '未找到 MySQL 验收容器，无法校验宿主机端口隔离')

  const mysqlPortBindingsResult = await runProcess(
    'docker',
    ['inspect', '--format', '{{json .HostConfig.PortBindings}}', mysqlContainerId],
    {
      capture: true,
      env: composeEnv,
    },
  )
  let mysqlPortBindings
  try {
    mysqlPortBindings = JSON.parse(mysqlPortBindingsResult.stdout.trim())
  } catch {
    throw new VerificationError('无法解析 MySQL 验收容器的 HostConfig.PortBindings')
  }
  const publishedMysqlPorts = Object.entries(mysqlPortBindings ?? {})
    .filter(([, bindings]) => Array.isArray(bindings) && bindings.length > 0)
    .map(([containerPort]) => containerPort)
  assert.deepEqual(
    publishedMysqlPorts,
    [],
    `MySQL 验收服务不得向宿主机发布端口，实际=${publishedMysqlPorts.join(',')}`,
  )

  const oneboxContainer = await runCompose(['ps', '--quiet', 'onebox'], {
    capture: true,
    env: composeEnv,
  })
  const oneboxContainerId = oneboxContainer.stdout.trim()
  assert.ok(oneboxContainerId, '未找到 onebox 验收容器，无法校验宿主机端口隔离')

  const oneboxPortBindingsResult = await runProcess(
    'docker',
    ['inspect', '--format', '{{json .NetworkSettings.Ports}}', oneboxContainerId],
    {
      capture: true,
      env: composeEnv,
    },
  )
  let oneboxPortBindings
  try {
    oneboxPortBindings = JSON.parse(oneboxPortBindingsResult.stdout.trim())
  } catch {
    throw new VerificationError('无法解析 onebox 验收容器的 NetworkSettings.Ports')
  }
  const publishedOneboxBindings = oneboxPortBindings?.['80/tcp']
  assert.ok(
    Array.isArray(publishedOneboxBindings) && publishedOneboxBindings.length === 1,
    `onebox 验收服务必须且只能发布一个宿主机端口，实际=${JSON.stringify(publishedOneboxBindings ?? null)}`,
  )
  assert.deepEqual(
    publishedOneboxBindings[0],
    {
      HostIp: '127.0.0.1',
      HostPort: composeEnv.Y_LINK_VERIFY_ONEBOX_PORT,
    },
    `onebox 验收端口必须仅绑定本机回环地址，实际=${JSON.stringify(publishedOneboxBindings[0])}`,
  )
}

const assertMySqlRuntime = async (composeEnv, runtimeState) => {
  assert.equal(runtimeState.effectiveDatabase?.dbType, 'mysql', '管理员运行时状态未确认 MySQL 实际生效')
  assert.equal(
    runtimeState.effectiveDatabase?.source,
    'runtime_override',
    '管理员运行时状态未确认运行时覆盖已被当前进程加载',
  )
  assert.match(
    String(runtimeState.effectiveDatabase?.summary ?? ''),
    /^mysql:3306\/y_link_migration_verify$/,
    '管理员运行时状态返回的 MySQL 目标不是隔离验收库',
  )
  assert.equal(
    runtimeState.runtimeOverrideStatus?.pendingRestart,
    false,
    '迁移成功后运行时覆盖仍处于待重启状态',
  )

  const databaseInfo = await runMySqlQuery(
    composeEnv,
    'SELECT VERSION(), DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = DATABASE();',
  )
  const [version, charset, collation] = databaseInfo.split('\t')
  assert.match(version ?? '', /^8\.4\./, `MySQL 实际版本不是 8.4：${version ?? '(empty)'}`)
  assert.equal(charset, 'utf8mb4', `隔离验收库字符集不是 utf8mb4：${charset ?? '(empty)'}`)
  assert.match(collation ?? '', /^utf8mb4_/, `隔离验收库排序规则不是 utf8mb4：${collation ?? '(empty)'}`)

  const tableCount = Number(
    await runMySqlQuery(
      composeEnv,
      'SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE();',
    ),
  )
  assert.ok(Number.isInteger(tableCount) && tableCount > 0, '迁移后 MySQL 目标库没有业务表')
  const systemConfigCount = Number(
    await runMySqlQuery(composeEnv, 'SELECT COUNT(*) FROM system_configs;'),
  )
  assert.ok(Number.isInteger(systemConfigCount) && systemConfigCount > 0, '迁移后 MySQL 缺少 system_configs 业务数据')
}

const waitForInitialService = async (baseUrl) => {
  const health = await waitFor(
    'onebox 初始服务就绪',
    async () => {
      const current = await readHealth(baseUrl)
      return current.status === 'UP' ? current : null
    },
    {
      intervalMs: 1000,
    },
  )
  assert.equal(health.maintenance?.readOnly, false, '初始 SQLite 服务不应处于维护只读态')
  return health
}

const waitForMaintenanceReadOnly = async (baseUrl, client, taskId) => {
  const state = await waitFor(
    '迁移维护只读态与 /health 横幅',
    async () => {
      const current = await readHealth(baseUrl)
      if (current.maintenance?.readOnly === true) {
        return { health: current }
      }
      const currentTask = await readMigrationTask(client, taskId)
      return terminalTaskStatuses.has(currentTask.status) ? { terminalTask: currentTask } : null
    },
    {
      intervalMs: 100,
    },
  )
  if (state.terminalTask) {
    throw new VerificationError(
      `自动迁移在进入维护只读态前已终止：status=${state.terminalTask.status}，error=${state.terminalTask.errorMessage ?? '(none)'}`,
    )
  }
  const health = state.health
  assert.equal(health.maintenance.readOnly, true, '/health maintenance.readOnly 必须为 true')
  assert.equal(typeof health.maintenance.phase, 'string', '/health 维护横幅必须返回 phase')
  assert.ok(health.maintenance.phase.length > 0, '/health 维护横幅 phase 不能为空')
  assert.equal(typeof health.maintenance.message, 'string', '/health 维护横幅必须返回 message')
  assert.ok(health.maintenance.message.length > 0, '/health 维护横幅 message 不能为空')
  return health
}

const assertWriteBarrier = async (client) => {
  const { response, payload } = await client.request('/api/auth/presence/heartbeat', {
    method: 'POST',
    expectedStatuses: [503],
  })
  assert.equal(response.status, 503, '维护期间写请求必须返回 HTTP 503')
  assert.equal(payload?.code, 50301, '维护期间写请求必须返回业务码 50301')
  assert.equal(payload?.data, null, '维护期间写屏障响应 data 必须为 null')
  const retryAfter = response.headers.get('retry-after')
  assert.ok(retryAfter, '维护期间写屏障必须返回 Retry-After')
}

const assertReturnedToSqlite = async (baseUrl, client) => {
  const state = await waitForRuntimeState({
    baseUrl,
    client,
    label: '失败任务退出维护态并保持 SQLite',
    dbType: 'sqlite',
    readOnly: false,
  })
  assert.equal(
    state.runtimeState.effectiveDatabase?.source,
    'environment',
    '失败回退后不应加载 MySQL 运行时覆盖',
  )
  return state
}

const assertCutoverArtifactsAbsent = async (composeEnv, runtimeState, label) => {
  assert.equal(runtimeState.activeOverride, null, `${label}后不得残留数据库运行时覆盖`)
  assert.equal(
    runtimeState.runtimeOverrideStatus?.hasOverrideFile,
    false,
    `${label}后运行时覆盖文件必须不存在`,
  )
  assert.equal(
    runtimeState.runtimeOverrideStatus?.pendingRestart,
    false,
    `${label}后不得留下待重启数据库切换`,
  )
  await runCompose(
    [
      'exec',
      '-T',
      'onebox',
      'sh',
      '-ec',
      'test ! -e /app/data/runtime/database-runtime-override.json && test ! -e /app/data/runtime/database-migration-cutover.json',
    ],
    {
      capture: true,
      env: composeEnv,
      label: `${label}切换持久化残留断言`,
    },
  )
}

const assertFailedTaskWithoutRestart = async ({
  baseUrl,
  client,
  composeEnv,
  baselineSnapshot,
  fixtureManifest,
  target = { ...mysqlTarget, password: mysqlPassword },
  errorPattern,
  label,
}) => {
  const initialState = await getOneboxContainerState(composeEnv)
  const createdTask = await createAutomaticTask(client, target)
  const terminalTask = await waitForTaskTerminal(client, createdTask.id)
  assert.equal(terminalTask.status, 'failed', `${label}任务终态必须为 failed，实际=${terminalTask.status}`)
  assert.match(String(terminalTask.errorMessage ?? ''), errorPattern, `${label}任务没有记录预期阻断原因`)
  assert.ok(!String(terminalTask.errorMessage ?? '').includes(mysqlPassword), `${label}任务错误信息泄露密码`)
  await assertReturnedToSqlite(baseUrl, client)
  const finalState = await getOneboxContainerState(composeEnv)
  assert.equal(finalState.containerId, initialState.containerId, `${label}不应替换 onebox 容器`)
  assert.equal(finalState.restartCount, initialState.restartCount, `${label}不应触发 onebox 重启`)
  await client.login()
  const finalSnapshot = await readExportSnapshot(client)
  assert.deepEqual(finalSnapshot, baselineSnapshot, `${label}后 SQLite 业务内容发生变化`)
  const verifiedManifest = await runFullEntityFixtureCommand(composeEnv, true)
  assertFixtureCountsNotReduced(
    verifiedManifest.tableCounts,
    fixtureManifest.tableCounts,
    `${label}后全实体夹具发生数据丢失`,
  )
  return terminalTask
}

const runSuccessScenario = async ({ baseUrl, client, composeEnv, baselineSnapshot, fixtureManifest }) => {
  const initialState = await getOneboxContainerState(composeEnv)
  const createdTask = await createAutomaticTask(client, {
    ...mysqlTarget,
    password: mysqlPassword,
  })

  const maintenanceHealth = await waitForMaintenanceReadOnly(baseUrl, client, createdTask.id)
  log(`维护横幅已生效：phase=${maintenanceHealth.maintenance.phase}`)
  await waitFor(
    '维护期普通写请求 50301 屏障',
    async () => {
      await assertWriteBarrier(client)
      return true
    },
    {
      timeoutMs: 30_000,
      intervalMs: 100,
    },
  )
  log('维护期普通写请求已被 HTTP 503 / code 50301 严格阻断')

  const restartedState = await waitForOneboxRestart(composeEnv, initialState.restartCount, client, createdTask.id)
  log(`检测到 onebox 自动重启：restartCount ${initialState.restartCount} -> ${restartedState.restartCount}`)

  const terminalTask = await waitForTaskTerminal(client, createdTask.id)
  assert.equal(
    terminalTask.status,
    'succeeded',
    `自动迁移未成功，终态=${terminalTask.status}，error=${terminalTask.errorMessage ?? '(none)'}`,
  )
  assertFullTableValidationPassed(terminalTask, fixtureManifest)

  const finalState = await waitForRuntimeState({
    baseUrl,
    client,
    label: 'MySQL 生效且维护态结束',
    dbType: 'mysql',
    readOnly: false,
  })
  await assertMySqlRuntime(composeEnv, finalState.runtimeState)
  await client.login()
  await assertMigrationAuditExists(client, 'database_migration.automatic_succeeded', createdTask.id)
  const mysqlSnapshot = await readExportSnapshot(client)
  assert.deepEqual(mysqlSnapshot, baselineSnapshot, '迁移前后 export/json 业务内容不一致')
  log('成功迁移、维护态、自动重启、MySQL 8.4/utf8mb4 生效与业务内容一致性均通过')
}

const runWrongConnectionScenario = async ({ baseUrl, client, composeEnv, baselineSnapshot, fixtureManifest }) => {
  const initialTaskIds = await readMigrationTaskIds(client)
  const initialState = await getOneboxContainerState(composeEnv)
  const createdTask = await createAutomaticTask(client, {
    ...mysqlTarget,
    host: 'mysql-unreachable',
    password: mysqlPassword,
  })
  const terminalTask = await waitForTaskTerminal(client, createdTask.id)
  assert.equal(terminalTask.status, 'failed', `错误连接任务终态必须为 failed，实际=${terminalTask.status}`)
  assert.ok(terminalTask.errorMessage, '错误连接任务必须记录脱敏错误摘要')
  assert.ok(!terminalTask.errorMessage.includes(mysqlPassword), '错误连接任务 errorMessage 泄露了 MySQL 密码')
  assert.deepEqual(
    await readMigrationTaskIds(client),
    [...initialTaskIds, createdTask.id].sort(),
    '错误连接任务列表没有保留唯一失败任务记录',
  )
  await assertReturnedToSqlite(baseUrl, client)
  const finalState = await getOneboxContainerState(composeEnv)
  assert.equal(finalState.containerId, initialState.containerId, '错误连接失败不应替换 onebox 容器')
  assert.equal(finalState.restartCount, initialState.restartCount, '错误连接失败不应触发 onebox 重启')
  await client.login()
  const finalSnapshot = await readExportSnapshot(client)
  assert.deepEqual(finalSnapshot, baselineSnapshot, '错误连接失败后 SQLite 内容发生变化')
  const verifiedManifest = await runFullEntityFixtureCommand(composeEnv, true)
  assertFixtureCountsNotReduced(
    verifiedManifest.tableCounts,
    fixtureManifest.tableCounts,
    '错误连接失败后全实体夹具发生数据丢失',
  )
  log('错误连接断言通过：先返回 HTTP 202，再进入 failed；onebox 未重启，SQLite 与内容保持不变')
}

const runOldVersionScenario = async (context) => {
  await assertFailedTaskWithoutRestart({
    ...context,
    errorPattern: /MySQL 8\.0\.16\+/,
    label: '旧版 MySQL 阻断',
  })
  log('旧版 MySQL 断言通过：真实 8.0.15 目标被预检阻断，未进入切换或重启')
}

const runWrongCharsetScenario = async (context) => {
  await runMySqlQuery(
    context.composeEnv,
    'ALTER DATABASE y_link_migration_verify CHARACTER SET latin1 COLLATE latin1_swedish_ci;',
  )
  await assertFailedTaskWithoutRestart({
    ...context,
    errorPattern: /utf8mb4/,
    label: '错误字符集阻断',
  })
  log('错误字符集断言通过：latin1 目标库被阻断，未进入切换或重启')
}

const runInsufficientPermissionsScenario = async (context) => {
  await runMySqlRootQuery(
    context.composeEnv,
    "REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'y_link_verify'@'%'; GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, INDEX, REFERENCES, CREATE TEMPORARY TABLES ON y_link_migration_verify.* TO 'y_link_verify'@'%'; FLUSH PRIVILEGES;",
  )
  await assertFailedTaskWithoutRestart({
    ...context,
    errorPattern: /缺少自动迁移权限.*ALTER/,
    label: '权限不足阻断',
  })
  const targetTableCount = Number(await runMySqlRootQuery(
    context.composeEnv,
    "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'y_link_migration_verify';",
  ))
  assert.equal(targetTableCount, 0, '权限不足预检不应在目标库留下探针或业务表')
  log('权限不足断言通过：缺少 ALTER 时在任何 DDL 探针前阻断，目标库保持为空')
}

const runNonEmptyTargetScenario = async ({ baseUrl, client, composeEnv, baselineSnapshot, fixtureManifest }) => {
  const initialTaskIds = await readMigrationTaskIds(client)
  const initialState = await getOneboxContainerState(composeEnv)
  await runMySqlQuery(
    composeEnv,
    'CREATE TABLE migration_guard (id INT PRIMARY KEY, marker VARCHAR(64) NOT NULL); INSERT INTO migration_guard (id, marker) VALUES (1, "keep-existing-data");',
  )
  const createdTask = await createAutomaticTask(client, {
    ...mysqlTarget,
    password: mysqlPassword,
  })
  const terminalTask = await waitForTaskTerminal(client, createdTask.id)
  assert.equal(terminalTask.status, 'failed', `非空目标库任务终态必须为 failed，实际=${terminalTask.status}`)
  assert.match(
    String(terminalTask.errorMessage ?? ''),
    /独立空库|已存在表/,
    '非空目标库任务没有记录预期保护提示',
  )
  assert.ok(!terminalTask.errorMessage.includes(mysqlPassword), '非空目标库任务 errorMessage 泄露了 MySQL 密码')
  assert.deepEqual(
    await readMigrationTaskIds(client),
    [...initialTaskIds, createdTask.id].sort(),
    '非空目标库任务列表没有保留唯一失败任务记录',
  )
  const guardCount = Number(
    await runMySqlQuery(composeEnv, 'SELECT COUNT(*) FROM migration_guard WHERE marker = "keep-existing-data";'),
  )
  assert.equal(guardCount, 1, '非空目标库保护失败：既有 guard 数据被修改')
  await assertReturnedToSqlite(baseUrl, client)
  const finalState = await getOneboxContainerState(composeEnv)
  assert.equal(finalState.containerId, initialState.containerId, '非空目标库失败不应替换 onebox 容器')
  assert.equal(finalState.restartCount, initialState.restartCount, '非空目标库失败不应触发 onebox 重启')
  await client.login()
  const finalSnapshot = await readExportSnapshot(client)
  assert.deepEqual(finalSnapshot, baselineSnapshot, '非空目标库拒绝后 SQLite 内容发生变化')
  const verifiedManifest = await runFullEntityFixtureCommand(composeEnv, true)
  assertFixtureCountsNotReduced(
    verifiedManifest.tableCounts,
    fixtureManifest.tableCounts,
    '非空目标库拒绝后全实体夹具发生数据丢失',
  )
  log('非空目标库断言通过：先返回 HTTP 202，再进入 failed；目标既有数据与 SQLite 内容均未变化')
}

const runDuplicateTaskScenario = async ({ baseUrl, client, composeEnv, baselineSnapshot, fixtureManifest }) => {
  const initialState = await getOneboxContainerState(composeEnv)
  const firstTask = await createAutomaticTask(client, {
    ...mysqlTarget,
    password: mysqlPassword,
  })
  const duplicateResult = await client.request(
    '/api/data-maintenance/db-migration/automatic-tasks',
    {
      method: 'POST',
      expectedStatuses: [409, 503],
      body: {
        target: {
          ...mysqlTarget,
          password: mysqlPassword,
        },
        note: '重复任务阻断验收',
      },
    },
  )
  assert.ok(
    duplicateResult.response.status === 409 || duplicateResult.payload?.code === 50301,
    '重复自动迁移任务必须由全局锁或维护写屏障拒绝',
  )
  assert.ok(!JSON.stringify(duplicateResult.payload).includes(mysqlPassword), '重复任务拒绝响应泄露密码')

  await waitForOneboxRestart(composeEnv, initialState.restartCount, client, firstTask.id)
  const terminalTask = await waitForTaskTerminal(client, firstTask.id)
  assert.equal(terminalTask.status, 'succeeded', `首个自动迁移任务未成功：${terminalTask.status}`)
  assertFullTableValidationPassed(terminalTask, fixtureManifest)
  const finalRuntimeState = await waitForRuntimeState({
    baseUrl,
    client,
    label: '重复任务阻断后首任务完成并解除维护',
    dbType: 'mysql',
    readOnly: false,
  })
  await assertMySqlRuntime(composeEnv, finalRuntimeState.runtimeState)
  await client.login()
  assert.deepEqual(await readExportSnapshot(client), baselineSnapshot, '重复任务阻断后首任务迁移内容不一致')
  log('重复任务断言通过：第二个任务被拒绝，首任务仍完成强校验与 MySQL 切换')
}

const runContentTamperScenario = async (context) => {
  const terminalTask = await assertFailedTaskWithoutRestart({
    ...context,
    errorPattern: /哈希|校验|内容/,
    label: '同等行数内容篡改阻断',
  })
  assert.ok(
    terminalTask.result?.validation === undefined
      || terminalTask.result.validation.passed === false,
    '内容篡改任务不得留下通过的强校验结果',
  )
  log('同等行数内容篡改断言通过：目标行数不变但 SHA-256 不一致，任务禁止切换')
}

const runExecutionInterruptionScenario = async ({
  baseUrl,
  client,
  composeEnv,
  baselineSnapshot,
  fixtureManifest,
}) => {
  const initialState = await getOneboxContainerState(composeEnv)
  const createdTask = await createAutomaticTask(client, {
    ...mysqlTarget,
    password: mysqlPassword,
  })
  const terminalTask = await waitForTaskTerminal(client, createdTask.id)
  assert.equal(
    terminalTask.status,
    'succeeded',
    `执行中断后的自动续跑未成功：${terminalTask.status} ${terminalTask.errorMessage ?? ''}`,
  )
  assert.ok((terminalTask.resumeCount ?? 0) >= 1, '执行中断后任务没有记录自动续跑次数')
  assertFullTableValidationPassed(terminalTask, fixtureManifest)
  const finalState = await getOneboxContainerState(composeEnv)
  assert.ok(
    finalState.restartCount >= initialState.restartCount + 2,
    `执行中断续跑与最终切换至少需要两次重启，实际 ${initialState.restartCount} -> ${finalState.restartCount}`,
  )
  const finalRuntimeState = await waitForRuntimeState({
    baseUrl,
    client,
    label: '执行中断续跑后 MySQL 生效且维护解除',
    dbType: 'mysql',
    readOnly: false,
  })
  await assertMySqlRuntime(composeEnv, finalRuntimeState.runtimeState)
  await client.login()
  assert.deepEqual(await readExportSnapshot(client), baselineSnapshot, '执行中断续跑后迁移内容不一致')
  log('执行中断断言通过：onebox 自动拉起、任务安全续跑、强校验和最终切换均完成')
}

const runCutoverPersistenceFailureScenario = async (context) => {
  const terminalTask = await assertFailedTaskWithoutRestart({
    ...context,
    errorPattern: /切换任务状态持久化故障/,
    label: '切换任务状态持久化失败',
  })
  assert.equal(
    terminalTask.result?.runtimeOverrideApplied,
    false,
    '切换任务状态持久化失败后不得宣称运行时覆盖已应用',
  )
  const runtimeState = await readRuntimeOverrideState(context.client)
  await assertCutoverArtifactsAbsent(
    context.composeEnv,
    runtimeState,
    '切换任务状态持久化失败',
  )
  log('切换任务状态持久化失败断言通过：MySQL 覆盖与 cutover marker 已撤销，SQLite 写入恢复且 onebox 未重启')
}

const runFailureRollbackScenario = async ({ baseUrl, client, composeEnv, baselineSnapshot, fixtureManifest }) => {
  const initialState = await getOneboxContainerState(composeEnv)
  const createdTask = await createAutomaticTask(client, {
    ...mysqlTarget,
    password: mysqlPassword,
  })
  await waitForMaintenanceReadOnly(baseUrl, client, createdTask.id)

  const terminalTask = await waitForTaskTerminal(client, createdTask.id)
  assert.equal(
    terminalTask.status,
    'rolled_back',
    `连续两次 MySQL 启动失败后必须自动回退，实际=${terminalTask.status}，error=${terminalTask.errorMessage ?? '(none)'}`,
  )
  assert.equal(
    terminalTask.rollbackResult?.mysqlStartupAttempts,
    2,
    '自动回退任务必须记录两次 MySQL 启动失败',
  )

  const finalState = await getOneboxContainerState(composeEnv)
  assert.ok(
    finalState.restartCount >= initialState.restartCount + 3,
    `自动迁移、两次 MySQL 启动失败与 SQLite 回退至少需要 3 次容器重启，实际 ${initialState.restartCount} -> ${finalState.restartCount}`,
  )
  const rollbackState = await waitForRuntimeState({
    baseUrl,
    client,
    label: '连续启动失败后 SQLite 自动回退并解除维护',
    dbType: 'sqlite',
    readOnly: false,
  })
  assert.equal(
    rollbackState.runtimeState.effectiveDatabase?.source,
    'runtime_override',
    '自动回退后必须由持久化 SQLite 运行时覆盖生效',
  )
  await client.login()
  await assertMigrationAuditExists(client, 'database_migration.automatic_rolled_back', createdTask.id)
  const finalSnapshot = await readExportSnapshot(client)
  assert.deepEqual(finalSnapshot, baselineSnapshot, '自动回退后原 SQLite 业务内容发生变化')
  const verifiedManifest = await runFullEntityFixtureCommand(composeEnv, true)
  assertFixtureCountsNotReduced(
    verifiedManifest.tableCounts,
    fixtureManifest.tableCounts,
    '自动回退后全实体夹具发生数据丢失',
  )
  log('连续两次 MySQL 启动失败、SQLite 自动回退、维护解除与原库内容一致性均通过')
}

const runVerifyingEmergencyRollbackScenario = async ({
  baseUrl,
  client,
  composeEnv,
  baselineSnapshot,
  fixtureManifest,
}) => {
  const initialState = await getOneboxContainerState(composeEnv)
  const createdTask = await createAutomaticTask(client, {
    ...mysqlTarget,
    password: mysqlPassword,
  })
  await waitForMaintenanceReadOnly(baseUrl, client, createdTask.id)
  await waitForOneboxRestart(composeEnv, initialState.restartCount, client, createdTask.id)
  await waitForRuntimeState({
    baseUrl,
    client,
    label: 'MySQL 重启后进入 verifying 维护阶段',
    dbType: 'mysql',
    readOnly: true,
    phase: 'verifying',
    intervalMs: 100,
  })

  const rollbackResult = await client.request('/api/data-maintenance/db-migration/rollback', {
    method: 'POST',
    body: {
      taskId: createdTask.id,
      reason: 'E2E：verifying 阶段紧急回退',
    },
    timeoutMs: 35_000,
  })
  assert.equal(rollbackResult.payload?.code, 0, 'verifying 阶段紧急回退接口必须成功')

  const terminalTask = await waitForTaskTerminal(client, createdTask.id)
  assert.equal(terminalTask.status, 'rolled_back', 'verifying 阶段紧急回退后任务必须为 rolled_back')
  assert.ok(terminalTask.cancelRequestedAt, '紧急回退任务必须持久化 cancelRequestedAt')

  const finalRuntimeState = await waitForRuntimeState({
    baseUrl,
    client,
    label: 'verifying 紧急回退后 SQLite 生效且维护解除',
    dbType: 'sqlite',
    readOnly: false,
  })
  assert.equal(finalRuntimeState.runtimeState.effectiveDatabase?.source, 'runtime_override')
  await client.login()
  await assertMigrationAuditExists(client, 'database_migration.automatic_rolled_back', createdTask.id)
  assert.deepEqual(await readExportSnapshot(client), baselineSnapshot, 'verifying 紧急回退后 SQLite 内容发生变化')
  const verifiedManifest = await runFullEntityFixtureCommand(composeEnv, true)
  assertFixtureCountsNotReduced(
    verifiedManifest.tableCounts,
    fixtureManifest.tableCounts,
    'verifying 紧急回退后全实体夹具发生数据丢失',
  )
  log('verifying 阶段紧急回退断言通过：取消意图持久化、任务未被 succeeded 覆盖、SQLite 自检后解除维护')
}

const runSelectedScenario = async (context) => {
  if (scenario === 'success') {
    await runSuccessScenario(context)
    return
  }
  if (scenario === 'wrong-connection') {
    await runWrongConnectionScenario(context)
    return
  }
  if (scenario === 'old-version') {
    await runOldVersionScenario(context)
    return
  }
  if (scenario === 'wrong-charset') {
    await runWrongCharsetScenario(context)
    return
  }
  if (scenario === 'insufficient-permissions') {
    await runInsufficientPermissionsScenario(context)
    return
  }
  if (scenario === 'non-empty-target') {
    await runNonEmptyTargetScenario(context)
    return
  }
  if (scenario === 'duplicate-task') {
    await runDuplicateTaskScenario(context)
    return
  }
  if (scenario === 'content-tamper') {
    await runContentTamperScenario(context)
    return
  }
  if (scenario === 'execution-interruption') {
    await runExecutionInterruptionScenario(context)
    return
  }
  if (scenario === 'cutover-persistence-failure') {
    await runCutoverPersistenceFailureScenario(context)
    return
  }
  if (scenario === 'verifying-emergency-rollback') {
    await runVerifyingEmergencyRollbackScenario(context)
    return
  }
  await runFailureRollbackScenario(context)
}

const run = async () => {
  await verifyDockerPrerequisites()

  if (!allowedScenarios.has(scenario)) {
    throw new VerificationError(
      `未知 Y_LINK_DB_MIGRATION_SCENARIO=${scenario}；可选值：${Array.from(allowedScenarios).join(', ')}`,
    )
  }
  if (!Number.isFinite(defaultTimeoutMs) || defaultTimeoutMs < 30_000) {
    throw new VerificationError('Y_LINK_DB_MIGRATION_TIMEOUT_MS 必须是不小于 30000 的毫秒数')
  }
  const oneboxPort = await resolveAvailablePort()
  const baseUrl = `http://127.0.0.1:${oneboxPort}`
  const composeEnv = buildComposeEnvironment(oneboxPort)
  let composeCreated = false
  let runError = null

  try {
    await runCompose(['config', '--quiet'], {
      capture: true,
      env: composeEnv,
      label: '校验数据库迁移 Compose 配置',
    })
    log(`启动隔离编排：project=${composeProject}，scenario=${scenario}`)
    composeCreated = true
    await runCompose(['up', '--detach', '--build', '--wait'], {
      env: composeEnv,
      label: '构建并启动数据库迁移隔离编排',
    })

    await assertIsolatedComposeResources(composeEnv)
    log(`onebox 宿主机验收入口已就绪：${baseUrl}`)
    await waitForInitialService(baseUrl)
    const client = createHttpClient(baseUrl)
    await client.login()
    const initialRuntimeState = await readRuntimeOverrideState(client)
    assert.equal(
      initialRuntimeState.effectiveDatabase?.dbType,
      'sqlite',
      '管理员运行时状态未确认 onebox 初始使用 SQLite',
    )
    assert.equal(
      initialRuntimeState.effectiveDatabase?.source,
      'environment',
      'onebox 初始 SQLite 不应来自运行时覆盖',
    )
    const fixtureManifest = await runFullEntityFixtureCommand(composeEnv)
    const baselineSnapshot = await readExportSnapshot(client)
    log(`SQLite 全实体夹具已就绪：${fixtureManifest.tableCount} 张实体表全部非空`)

    await runSelectedScenario({
      baseUrl,
      client,
      composeEnv,
      baselineSnapshot,
      fixtureManifest,
    })
  } catch (error) {
    runError = error
    if (composeCreated) {
      const logs = await runCompose(['logs', '--no-color', '--tail', '250', 'onebox', 'mysql'], {
        capture: true,
        allowFailure: true,
        env: composeEnv,
      })
      if (logs.stdout.trim()) {
        console.error('\n[verify:db:migration] 失败现场（最近 250 行，测试凭据未输出）：\n')
        console.error(logs.stdout.trim())
      }
      if (logs.stderr.trim()) {
        console.error(logs.stderr.trim())
      }
    }
  } finally {
    if (composeCreated) {
      try {
        await runCompose(['down', '--volumes', '--remove-orphans', '--timeout', '10'], {
          env: composeEnv,
          label: '销毁数据库迁移隔离编排与临时卷',
        })
        log(`已销毁隔离 project 与临时卷：${composeProject}`)
      } catch (cleanupError) {
        if (!runError) {
          runError = cleanupError
        } else {
          console.error(
            `[verify:db:migration] 清理失败：${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          )
        }
      }
    }
  }

  if (runError) {
    throw runError
  }
}

try {
  await run()
  log(`严格验收通过：scenario=${scenario}`)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof DockerPrerequisiteError) {
    console.error(`\n[verify:db:migration] Docker 严格阻断：${message}`)
  } else {
    console.error(`\n[verify:db:migration] 验收失败：${message}`)
  }
  process.exitCode = error?.exitCode ?? 1
}
