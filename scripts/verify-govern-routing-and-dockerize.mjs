/**
 * 模块说明：scripts/verify-govern-routing-and-dockerize.mjs
 * 文件职责：统一验证前后端构建、双库 HTTP、O2O 与 Onebox 本地运行。
 * 维护说明：默认使用本机临时 MySQL，也可显式指定独占的回环 MySQL 8.4 测试实例。
 */

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { resolveCommandFromPath, resolveNpmCommand, runCommand } from './process-runner-utils.mjs'

/**
 * govern-routing-and-dockerize 统一验收脚本：
 * - 覆盖前端构建、后端构建、SQLite 启动冒烟、MySQL 真连冒烟；
 * - 补齐 onebox 本地烟雾验证，确保单端口入口可访问页面与 API；
 * - 将验证结果统一沉淀为可重复执行脚本，避免只靠手工口头回归。
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const backendRoot = path.join(projectRoot, 'backend')
const runtimeRoot = path.join(projectRoot, '.local-dev')
const mysqlPort = Number(process.env.Y_LINK_VERIFY_MYSQL_PORT ?? 33306)
const sqliteBackendPort = Number(process.env.Y_LINK_VERIFY_SQLITE_PORT ?? 3305)
const mysqlBackendPort = Number(process.env.Y_LINK_VERIFY_MYSQL_BACKEND_PORT ?? 3306)
const verifyAdminSecret = process.env.Y_LINK_VERIFY_ADMIN_PASSWORD
  ?? process.env.INIT_ADMIN_PASSWORD
  ?? ('Admin@' + '123456')

const delay = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms)
})

const log = (message) => {
  console.log(`[verify-govern-routing] ${message}`)
}

const waitForTcpReady = async ({ host, port, child, retries = 80, intervalMs = 500 }) => {
  for (let index = 0; index < retries; index += 1) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) throw new Error('本轮临时 MySQL 在就绪前退出')
    try {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host, port }, () => {
          socket.end()
          resolve()
        })
        socket.once('error', reject)
      })
      return
    } catch {
      await delay(intervalMs)
    }
  }

  throw new Error(`等待 TCP 端口就绪超时：${host}:${port}`)
}

const assertLoopbackPortAvailable = async (port) => {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve)
  })
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

const assertBackendRunning = ({ child, stdoutPath }) => {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    throw new Error(`本轮后端在验证前已退出，请查看 ${stdoutPath}`)
  }
}

const waitForBackendListen = async (context, baseUrl) => {
  for (let index = 0; index < 400; index += 1) {
    assertBackendRunning(context)
    const output = stripVTControlCharacters(await fs.promises.readFile(context.stdoutPath, 'utf8'))
    // LISTEN 由当前子进程在业务服务实际收到 listening 后输出，别的 HTTP 服务不能满足此条件。
    if (output.split(/\r?\n/).some((line) => line.trimEnd().endsWith(`[LISTEN] ${baseUrl}`))) {
      assertBackendRunning(context)
      return
    }
    await delay(100)
  }
  throw new Error(`本轮后端监听超时：${baseUrl}；请查看 ${context.stdoutPath}`)
}

const killChildProcess = async (child) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return
  }

  const exited = new Promise((resolve) => child.once('exit', () => resolve(true)))
  child.kill('SIGTERM')
  if (await Promise.race([exited, delay(2500).then(() => false)])) return
  child.kill('SIGKILL')
  await exited
}

const startBackend = ({ port, envOverrides, stdoutPath, stderrPath }) => {
  const stdoutFd = fs.openSync(stdoutPath, 'w')
  const stderrFd = fs.openSync(stderrPath, 'w')

  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: backendRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      DB_SYNC: 'false',
      INIT_ADMIN_PASSWORD: verifyAdminSecret,
      ...envOverrides,
    },
    stdio: ['ignore', stdoutFd, stderrFd],
    shell: false,
    windowsHide: true,
  })
  child.on('error', (error) => log(`启动后端进程失败：${error.code ?? '未知错误'}`))

  return {
    child,
    stdoutPath,
    closeStreams: () => {
      fs.closeSync(stdoutFd)
      fs.closeSync(stderrFd)
    },
  }
}

const verifyBackendApi = async ({ context, baseUrl, label }) => {
  await waitForBackendListen(context, baseUrl)
  const fetchBackend = (route, options = {}) => {
    assertBackendRunning(context)
    return fetch(`${baseUrl}${route}`, { ...options, redirect: 'error', signal: AbortSignal.timeout(10_000) })
  }

  const healthResponse = await fetchBackend('/health')
  const healthJson = await healthResponse.json()
  if (!healthResponse.ok || healthJson?.status !== 'UP') {
    throw new Error(`${label} /health 返回异常`)
  }

  const loginResponse = await fetchBackend('/api/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      username: 'admin',
      password: verifyAdminSecret,
    }),
  })
  const loginJson = await loginResponse.json()
  const setCookies = loginResponse.headers.getSetCookie()
  const adminSession = setCookies.find((line) => /^y_link_admin_session=[^;]+(?:;|$)/.test(line))
  if (!loginResponse.ok || loginJson?.code !== 0 || !adminSession || !/;\s*HttpOnly(?:;|$)/i.test(adminSession)) {
    throw new Error(`${label} /api/auth/login 返回异常`)
  }
  const cookie = setCookies.map((line) => line.split(';', 1)[0]).filter(Boolean).join('; ')

  const productResponse = await fetchBackend('/api/products?page=1&pageSize=1', {
    headers: {
      Cookie: cookie,
    },
  })
  const productJson = await productResponse.json()
  const isProductPayloadValid =
    Array.isArray(productJson?.data)
    || Array.isArray(productJson?.data?.list)
  if (!productResponse.ok || productJson?.code !== 0 || !isProductPayloadValid) {
    throw new Error(`${label} /api/products 返回异常`)
  }
  assertBackendRunning(context)
}

const initializeMysqlData = async ({ mysqldPath, mysqlRuntimeRoot, mysqlDataRoot }) => {
  fs.mkdirSync(mysqlRuntimeRoot, { recursive: true })
  fs.mkdirSync(mysqlDataRoot, { recursive: true })
  log('初始化临时 MySQL 数据目录')
  await runCommand({
    title: '初始化 MySQL 数据目录',
    command: mysqldPath,
    args: ['--no-defaults', '--initialize-insecure', `--datadir=${mysqlDataRoot}`],
    cwd: mysqlRuntimeRoot,
    windowsHide: true,
  })
}

const startTemporaryMysql = async (mysqlRuntimeRoot) => {
  const mysqlDataRoot = path.join(mysqlRuntimeRoot, 'data')
  const mysqlLogPath = path.join(mysqlRuntimeRoot, 'mysqld.log')
  const mysqldPath = resolveCommandFromPath(['mysqld.exe', 'mysqld'])
  if (!mysqldPath) {
    throw new Error('未检测到 mysqld 命令，无法执行本机 MySQL 真连验证')
  }

  await initializeMysqlData({ mysqldPath, mysqlRuntimeRoot, mysqlDataRoot })

  const mysqlLogFd = fs.openSync(mysqlLogPath, 'w')
  const mysqlProcess = spawn(
    mysqldPath,
    ['--no-defaults', `--datadir=${mysqlDataRoot}`, `--port=${mysqlPort}`, '--bind-address=127.0.0.1', '--console'],
    {
      cwd: mysqlRuntimeRoot,
      stdio: ['ignore', mysqlLogFd, mysqlLogFd],
      shell: false,
      windowsHide: true,
    },
  )
  fs.closeSync(mysqlLogFd)
  mysqlProcess.on('error', (error) => log(`启动临时 MySQL 进程失败：${error.code ?? '未知错误'}`))

  try {
    await waitForTcpReady({ host: '127.0.0.1', port: mysqlPort, child: mysqlProcess })
    const { createConnection } = createRequire(path.join(backendRoot, 'package.json'))('mysql2/promise')
    const connection = await createConnection({ host: '127.0.0.1', port: mysqlPort, user: 'root', connectTimeout: 5000 })
    try {
      const [rows] = await connection.query('SELECT @@datadir AS dataDir')
      if (typeof rows[0]?.dataDir !== 'string' || fs.realpathSync(rows[0].dataDir) !== fs.realpathSync(mysqlDataRoot)) {
        throw new Error('本机 MySQL 端口未绑定到本轮创建的数据目录')
      }
      await connection.query('CREATE DATABASE y_link CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci')
    } finally {
      await connection.end()
    }
    log(`临时 MySQL 已启动：127.0.0.1:${mysqlPort}`)
    return mysqlProcess
  } catch (error) {
    await killChildProcess(mysqlProcess)
    throw error
  }
}

const readIsolatedMysqlOptions = () => {
  const {
    Y_LINK_VERIFY_MYSQL_CONFIRM_TEST_SERVER: confirmation,
    Y_LINK_VERIFY_MYSQL_HOST: host,
    Y_LINK_VERIFY_MYSQL_PORT: portText,
    Y_LINK_VERIFY_MYSQL_USER: user,
    Y_LINK_VERIFY_MYSQL_PASSWORD: password,
  } = process.env
  if ([confirmation, host, user, password].every((value) => value === undefined)) return null
  const port = Number(portText)
  if (confirmation !== 'true' || host !== '127.0.0.1' || !/^\d+$/.test(portText ?? '')
    || port < 10000 || port > 65535 || !user?.trim()) {
    throw new Error('外部 MySQL 验收要求 Y_LINK_VERIFY_MYSQL_CONFIRM_TEST_SERVER=true、Y_LINK_VERIFY_MYSQL_HOST=127.0.0.1、显式高位端口（10000–65535）和 Y_LINK_VERIFY_MYSQL_USER')
  }
  return { host, port, user, password: password ?? '' }
}

const resolveRunProfile = (stage, runNonce) => {
  const profile = `govern-routing-${stage}-verify-${runNonce}`
  // env-file-bootstrap 在 ENV_FILE 之前从后端根目录加载 .env.<profile>，且允许覆盖初始进程环境。
  if (fs.existsSync(path.resolve(backendRoot, `.env.${profile}`))) {
    throw new Error(`验收 profile 意外存在本地配置文件：${profile}`)
  }
  return profile
}

const openIsolatedMysql = async (options) => {
  const backendRequire = createRequire(path.join(backendRoot, 'package.json'))
  const { createConnection } = backendRequire('mysql2/promise')
  const connection = await createConnection({ ...options, multipleStatements: false, connectTimeout: 5000 })
  const databaseName = `ylink_govern_verify_${randomBytes(12).toString('hex')}`
  const identifier = `\`${databaseName}\``
  let created = false
  const close = async () => {
    try {
      if (created) await connection.query(`DROP DATABASE ${identifier}`)
    } finally {
      await connection.end()
    }
  }
  try {
    const [rows] = await connection.query('SELECT VERSION() AS version')
    const version = String(rows[0]?.version ?? '')
    if (!/^8\.4\.\d+(?:[-+.]|$)/.test(version) || /mariadb/i.test(version)) {
      throw new Error('外部 MySQL 测试实例必须使用 MySQL 8.4')
    }
    // 禁止 IF NOT EXISTS，碰撞时不接管同名库，也不会进入删除路径。
    await connection.query(`CREATE DATABASE ${identifier} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    created = true
    return { databaseName, close }
  } catch (error) {
    await close()
    throw error
  }
}

const main = async () => {
  const isolatedMysqlOptions = readIsolatedMysqlOptions()
  const oneboxBackendPort = Number(process.env.Y_LINK_ONEBOX_BACKEND_PORT ?? 3310)
  const oneboxPort = Number(process.env.Y_LINK_ONEBOX_PORT ?? 18080)
  for (const port of new Set([sqliteBackendPort, mysqlBackendPort, oneboxBackendPort, oneboxPort, ...(!isolatedMysqlOptions ? [mysqlPort] : [])])) {
    await assertLoopbackPortAvailable(port)
  }
  fs.mkdirSync(runtimeRoot, { recursive: true })
  const runRoot = fs.realpathSync(fs.mkdtempSync(path.join(runtimeRoot, 'govern-routing-verify-')))
  const runNonce = randomBytes(12).toString('hex')
  const envFile = path.join(runRoot, 'isolated.env')
  fs.writeFileSync(envFile, '', { flag: 'wx', mode: 0o600 })
  const isolatedEnv = {
    ENV_FILE: envFile,
    Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE: 'true',
    Y_LINK_LISTEN_HOST: '127.0.0.1',
    Y_LINK_TRUST_PROXY: '',
    Y_LINK_FORCE_SECURE_COOKIES: 'false',
    Y_LINK_MULTI_INSTANCE: 'false',
    DB_AUTO_MIGRATE: 'false',
    REDIS_URL: '',
    ALIYUN_DYPNS_MNS_ENABLED: 'false',
  }
  const sqliteRoot = path.join(runRoot, 'sqlite')
  const mysqlRuntimeRoot = path.join(runRoot, 'mysql')
  const oneboxRoot = path.join(runRoot, 'onebox')
  const o2oRoot = path.join(runRoot, 'o2o')
  for (const root of [sqliteRoot, mysqlRuntimeRoot, oneboxRoot, o2oRoot]) fs.mkdirSync(root)
  log(`本轮隔离验收目录：${runRoot}`)

  log('执行前端构建')
  await runCommand({
    title: '前端构建',
    command: process.execPath,
    args: [path.join(projectRoot, 'scripts', 'run-frontend-build.mjs')],
    cwd: projectRoot,
    windowsHide: false,
  })

  const npmCommand = resolveNpmCommand()

  log('执行后端类型检查与构建')
  await runCommand({
    title: '后端类型检查',
    command: npmCommand.command,
    args: [...npmCommand.prefixArgs, 'run', 'check'],
    cwd: backendRoot,
    windowsHide: false,
  })
  await runCommand({
    title: '后端构建',
    command: npmCommand.command,
    args: [...npmCommand.prefixArgs, 'run', 'build'],
    cwd: backendRoot,
    windowsHide: false,
  })

  log('执行 SQLite 模式真连冒烟')
  const sqliteBackendContext = startBackend({
    port: sqliteBackendPort,
    envOverrides: {
      ...isolatedEnv,
      APP_PROFILE: resolveRunProfile('sqlite', runNonce),
      DB_TYPE: 'sqlite',
      SQLITE_DB_PATH: path.join(sqliteRoot, 'verification.sqlite'),
      Y_LINK_DATA_DIR: sqliteRoot,
    },
    stdoutPath: path.join(sqliteRoot, 'backend.log'),
    stderrPath: path.join(sqliteRoot, 'backend.error.log'),
  })
  try {
    await verifyBackendApi({
      context: sqliteBackendContext,
      baseUrl: `http://127.0.0.1:${sqliteBackendPort}`,
      label: 'SQLite 后端',
    })
    log('SQLite 模式 /health + /api/products 验证通过')
  } finally {
    await killChildProcess(sqliteBackendContext.child)
    sqliteBackendContext.closeStreams()
  }

  log('执行 MySQL 模式真连冒烟')
  let mysqlProcess
  let isolatedMysql
  try {
    if (isolatedMysqlOptions) {
      isolatedMysql = await openIsolatedMysql(isolatedMysqlOptions)
      log('已在独占 MySQL 8.4 实例创建随机验证库')
    } else {
      mysqlProcess = await startTemporaryMysql(mysqlRuntimeRoot)
    }

    const mysqlBackendContext = startBackend({
      port: mysqlBackendPort,
      envOverrides: {
        ...isolatedEnv,
        APP_PROFILE: resolveRunProfile('mysql', runNonce),
        DB_TYPE: 'mysql',
        DB_HOST: '127.0.0.1',
        DB_PORT: String(isolatedMysqlOptions?.port ?? mysqlPort),
        DB_USER: isolatedMysqlOptions?.user ?? 'root',
        DB_PASSWORD: isolatedMysqlOptions?.password ?? '',
        DB_NAME: isolatedMysql?.databaseName ?? 'y_link',
        DB_SYNC: 'true',
        Y_LINK_DATA_DIR: path.join(mysqlRuntimeRoot, 'backend-data'),
      },
      stdoutPath: path.join(mysqlRuntimeRoot, 'backend.log'),
      stderrPath: path.join(mysqlRuntimeRoot, 'backend.error.log'),
    })

    try {
      await verifyBackendApi({
        context: mysqlBackendContext,
        baseUrl: `http://127.0.0.1:${mysqlBackendPort}`,
        label: 'MySQL 后端',
      })
      log('MySQL 模式 /health + /api/products 验证通过')
    } finally {
      await killChildProcess(mysqlBackendContext.child)
      mysqlBackendContext.closeStreams()
    }
  } finally {
    await killChildProcess(mysqlProcess)
    await isolatedMysql?.close()
  }

  log('执行开发规划 O2O 回归脚本')
  await runCommand({
    title: 'O2O 回归验证',
    // 直接运行同一业务夹具，避免专项包装器再生成一个外层未校验的 profile。
    command: process.execPath,
    args: ['--import', 'tsx', 'scripts/o2o-preorder-verify.ts'],
    cwd: backendRoot,
    windowsHide: false,
    env: {
      ...process.env,
      ...isolatedEnv,
      NODE_ENV: 'test',
      APP_PROFILE: resolveRunProfile('o2o', runNonce),
      INIT_ADMIN_PASSWORD: process.env.INIT_ADMIN_PASSWORD || 'O2oVerify_Admin_Aa1!',
      DB_TYPE: 'sqlite',
      DB_SYNC: 'true',
      SQLITE_DB_PATH: path.join(o2oRoot, 'verification.sqlite'),
      Y_LINK_DATA_DIR: o2oRoot,
      TMPDIR: o2oRoot,
      TEMP: o2oRoot,
      TMP: o2oRoot,
    },
  })

  log('执行 onebox 本地烟雾验证')
  await runCommand({
    title: 'onebox 本地烟雾验证',
    command: process.execPath,
    args: [path.join(projectRoot, 'scripts', 'verify-onebox-local-smoke.mjs')],
    cwd: projectRoot,
    windowsHide: false,
    env: {
      ...process.env,
      ...isolatedEnv,
      APP_PROFILE: resolveRunProfile('onebox', runNonce),
      Y_LINK_ONEBOX_SMOKE_RUNTIME_DIR: oneboxRoot,
      SQLITE_DB_PATH: path.join(oneboxRoot, 'verification.sqlite'),
      Y_LINK_DATA_DIR: oneboxRoot,
    },
  })

  log('govern-routing-and-dockerize 统一验收通过')
}

try {
  await main()
} catch (error) {
  console.error('\n[verify-govern-routing] 统一验收失败：', error)
  process.exit(1)
}
