import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
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
const verifySqliteRoot = path.join(backendRoot, 'data', 'local-dev')
const sqliteDbPath = path.join(verifySqliteRoot, 'y-link.govern-routing-dockerize.sqlite')
const mysqlRuntimeRoot = path.join(runtimeRoot, 'mysql-govern-routing-dockerize')
const mysqlDataRoot = path.join(mysqlRuntimeRoot, 'data')
const mysqlLogPath = path.join(mysqlRuntimeRoot, 'mysqld.log')
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

const waitForTcpReady = async ({ host, port, retries = 80, intervalMs = 500 }) => {
  for (let index = 0; index < retries; index += 1) {
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

const waitForHttpReady = async ({ url, retries = 80, intervalMs = 500 }) => {
  for (let index = 0; index < retries; index += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        return
      }
    } catch {
      // 启动期间允许重试，超时统一抛错。
    }
    await delay(intervalMs)
  }

  throw new Error(`等待 HTTP 服务就绪超时：${url}`)
}

const killChildProcess = async (child) => {
  if (child?.exitCode !== null) {
    return
  }

  child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(2500),
  ])

  if (child.exitCode === null) {
    child.kill('SIGKILL')
  }
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

  return {
    child,
    closeStreams: () => {
      fs.closeSync(stdoutFd)
      fs.closeSync(stderrFd)
    },
  }
}

const verifyBackendApi = async ({ baseUrl, label }) => {
  await waitForHttpReady({ url: `${baseUrl}/health` })

  const healthResponse = await fetch(`${baseUrl}/health`)
  const healthJson = await healthResponse.json()
  if (!healthResponse.ok || healthJson?.data?.status !== 'UP') {
    throw new Error(`${label} /health 返回异常`)
  }

  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
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
  const token = loginJson?.data?.token
  if (!loginResponse.ok || typeof token !== 'string' || token.length === 0) {
    throw new Error(`${label} /api/auth/login 返回异常`)
  }

  const productResponse = await fetch(`${baseUrl}/api/products?page=1&pageSize=1`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })
  const productJson = await productResponse.json()
  const isProductPayloadValid =
    Array.isArray(productJson?.data)
    || Array.isArray(productJson?.data?.list)
  if (!productResponse.ok || productJson?.code !== 0 || !isProductPayloadValid) {
    throw new Error(`${label} /api/products 返回异常`)
  }
}

const initializeMysqlDataIfNeeded = async (mysqldPath) => {
  fs.mkdirSync(mysqlRuntimeRoot, { recursive: true })

  const mysqlSystemSchemaPath = path.join(mysqlDataRoot, 'mysql')
  if (fs.existsSync(mysqlSystemSchemaPath)) {
    return
  }

  fs.mkdirSync(mysqlDataRoot, { recursive: true })
  log('初始化临时 MySQL 数据目录')
  await runCommand({
    title: '初始化 MySQL 数据目录',
    command: mysqldPath,
    args: ['--initialize-insecure', `--datadir=${mysqlDataRoot}`],
    cwd: mysqlRuntimeRoot,
    windowsHide: true,
  })
}

const startTemporaryMysql = async () => {
  const mysqldPath = resolveCommandFromPath(['mysqld.exe', 'mysqld'])
  const mysqlCliPath = resolveCommandFromPath(['mysql.exe', 'mysql'])
  if (!mysqldPath || !mysqlCliPath) {
    throw new Error('未检测到 mysqld/mysql 命令，无法执行 MySQL 真连验证')
  }

  await initializeMysqlDataIfNeeded(mysqldPath)

  const mysqlProcess = spawn(
    mysqldPath,
    [`--datadir=${mysqlDataRoot}`, `--port=${mysqlPort}`, '--bind-address=127.0.0.1', '--console'],
    {
      cwd: mysqlRuntimeRoot,
      stdio: ['ignore', fs.openSync(mysqlLogPath, 'w'), fs.openSync(mysqlLogPath, 'a')],
      shell: false,
      windowsHide: true,
    },
  )

  await waitForTcpReady({ host: '127.0.0.1', port: mysqlPort })
  log(`临时 MySQL 已启动：127.0.0.1:${mysqlPort}`)

  await runCommand({
    title: '创建验证数据库',
    command: mysqlCliPath,
    args: [
      '--protocol=tcp',
      '--host=127.0.0.1',
      `--port=${mysqlPort}`,
      '--user=root',
      '--skip-password',
      '-e',
      'CREATE DATABASE IF NOT EXISTS y_link CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;',
    ],
    cwd: mysqlRuntimeRoot,
    windowsHide: true,
  })

  return mysqlProcess
}

const main = async () => {
  fs.mkdirSync(runtimeRoot, { recursive: true })
  fs.mkdirSync(verifySqliteRoot, { recursive: true })

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
      APP_PROFILE: 'govern-routing-sqlite-verify',
      DB_TYPE: 'sqlite',
      SQLITE_DB_PATH: sqliteDbPath,
    },
    stdoutPath: path.join(runtimeRoot, 'govern-routing-sqlite-backend.log'),
    stderrPath: path.join(runtimeRoot, 'govern-routing-sqlite-backend.error.log'),
  })
  try {
    await verifyBackendApi({
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
  try {
    mysqlProcess = await startTemporaryMysql()

    const mysqlBackendContext = startBackend({
      port: mysqlBackendPort,
      envOverrides: {
        APP_PROFILE: 'govern-routing-mysql-verify',
        DB_TYPE: 'mysql',
        DB_HOST: '127.0.0.1',
        DB_PORT: String(mysqlPort),
        DB_USER: 'root',
        DB_PASSWORD: '',
        DB_NAME: 'y_link',
        DB_SYNC: 'true',
      },
      stdoutPath: path.join(runtimeRoot, 'govern-routing-mysql-backend.log'),
      stderrPath: path.join(runtimeRoot, 'govern-routing-mysql-backend.error.log'),
    })

    try {
      await verifyBackendApi({
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
  }

  log('执行开发规划 O2O 回归脚本')
  await runCommand({
    title: 'O2O 回归验证',
    command: npmCommand.command,
    args: [...npmCommand.prefixArgs, 'run', 'o2o:verify'],
    cwd: backendRoot,
    windowsHide: false,
    env: {
      ...process.env,
      APP_PROFILE: 'govern-routing-o2o-verify',
      DB_TYPE: 'sqlite',
      DB_SYNC: 'true',
      SQLITE_DB_PATH: path.join(verifySqliteRoot, 'y-link.govern-routing-o2o.sqlite'),
    },
  })

  log('执行 onebox 本地烟雾验证')
  await runCommand({
    title: 'onebox 本地烟雾验证',
    command: process.execPath,
    args: [path.join(projectRoot, 'scripts', 'verify-onebox-local-smoke.mjs')],
    cwd: projectRoot,
    windowsHide: false,
  })

  log('govern-routing-and-dockerize 统一验收通过')
}

try {
  await main()
} catch (error) {
  console.error('\n[verify-govern-routing] 统一验收失败：', error)
  process.exit(1)
}
