/**
 * 文件说明：scripts/run-verify-db-concurrency.mjs
 * 文件职责：为 `verify:db:concurrency` 提供统一入口，优先自动准备受控的 Docker MySQL 临时环境，再调用后端并发验收脚本。
 * 实现逻辑：
 * 1. 若已显式提供 `VERIFY_DB_CONCURRENCY_MYSQL_*`，则直接复用该受控连接，避免重复拉起容器；
 * 2. 默认尝试通过 `compose.verify-db-concurrency.yml` 启动临时 MySQL，并等待服务真正可连接后再执行后端校验；
 * 3. 若 Docker 不可用或启动失败，则输出清晰阻断提示，指明“安装/启动 Docker”或“显式提供 VERIFY_DB_CONCURRENCY_MYSQL_* / 手动关闭自动准备”的修复路径；
 * 4. 验证结束后自动下线临时容器，避免残留脏环境影响本地与 CI 的下一次执行。
 */

import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  resolveDockerCommand,
  resolveTsxCliPath,
  runCommand,
} from './process-runner-utils.mjs'

const currentFilePath = fileURLToPath(import.meta.url)
const scriptsRoot = path.dirname(currentFilePath)
const projectRoot = path.resolve(scriptsRoot, '..')
const backendRoot = path.resolve(projectRoot, 'backend')
const composeFilePath = path.resolve(projectRoot, 'compose.verify-db-concurrency.yml')
const rawVerifyScriptPath = path.resolve(backendRoot, 'scripts', 'verify-db-concurrency.ts')

const readTextValue = (...values) => {
  for (const value of values) {
    if (typeof value !== 'string') {
      continue
    }
    const normalized = value.trim()
    if (normalized) {
      return normalized
    }
  }
  return undefined
}

const readBooleanFalseLike = (value) => {
  const normalized = readTextValue(value)?.toLowerCase()
  return normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'manual'
}

const readPositiveInteger = ({ envName, fallbackValue }) => {
  const rawValue = readTextValue(process.env[envName])
  if (!rawValue) {
    return fallbackValue
  }

  const parsedValue = Number.parseInt(rawValue, 10)
  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`环境变量 \`${envName}\` 必须是正整数，当前值：${rawValue}`)
  }

  return parsedValue
}

const log = (message) => {
  console.log(`[verify-db-concurrency-runner] ${message}`)
}

const runCapturedCommand = ({ title, command, args, cwd, env = process.env }) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    })

    const stdoutChunks = []
    const stderrChunks = []

    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk))
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk))

    child.on('error', (error) => {
      reject(new Error(`${title} 启动失败：${error.message}`))
    })

    child.on('exit', (code, signal) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim()
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim()
      resolve({
        code: code ?? 1,
        signal: signal ?? null,
        stdout,
        stderr,
      })
    })
  })

const wait = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms)
})

const hasDedicatedVerifyMysqlEnv = () =>
  [
    process.env.VERIFY_DB_CONCURRENCY_MYSQL_HOST,
    process.env.VERIFY_DB_CONCURRENCY_MYSQL_PORT,
    process.env.VERIFY_DB_CONCURRENCY_MYSQL_USER,
    process.env.VERIFY_DB_CONCURRENCY_MYSQL_PASSWORD,
  ].some((value) => value !== undefined && String(value).trim() !== '')

const createDockerRuntimeConfig = () => ({
  host: readTextValue(process.env.VERIFY_DB_CONCURRENCY_DOCKER_HOST) ?? '127.0.0.1',
  port: readPositiveInteger({
    envName: 'VERIFY_DB_CONCURRENCY_DOCKER_PORT',
    fallbackValue: 3406,
  }),
  user: 'root',
  password: process.env.VERIFY_DB_CONCURRENCY_DOCKER_ROOT_PASSWORD ?? ['YLink', 'Verify', '123!'].join(''),
  image: readTextValue(process.env.VERIFY_DB_CONCURRENCY_DOCKER_IMAGE) ?? 'mysql:8.4',
  projectName: readTextValue(process.env.VERIFY_DB_CONCURRENCY_DOCKER_PROJECT) ?? 'y-link-verify-db-concurrency',
  startupTimeoutMs: readPositiveInteger({
    envName: 'VERIFY_DB_CONCURRENCY_DOCKER_STARTUP_TIMEOUT_MS',
    fallbackValue: 90000,
  }),
})

const createDockerComposeEnv = (dockerConfig) => ({
  ...process.env,
  VERIFY_DB_CONCURRENCY_DOCKER_IMAGE: dockerConfig.image,
  VERIFY_DB_CONCURRENCY_DOCKER_PORT: String(dockerConfig.port),
  VERIFY_DB_CONCURRENCY_DOCKER_ROOT_PASSWORD: dockerConfig.password,
})

const createVerifyRuntimeEnv = (dockerConfig) => ({
  ...process.env,
  VERIFY_DB_CONCURRENCY_MYSQL_HOST: dockerConfig.host,
  VERIFY_DB_CONCURRENCY_MYSQL_PORT: String(dockerConfig.port),
  VERIFY_DB_CONCURRENCY_MYSQL_USER: dockerConfig.user,
  VERIFY_DB_CONCURRENCY_MYSQL_PASSWORD: dockerConfig.password,
})

const runRawVerifyScript = async (env) => {
  const tsxCliPath = resolveTsxCliPath(backendRoot)
  await runCommand({
    title: '执行数据库并发验收脚本',
    command: process.execPath,
    args: [tsxCliPath, rawVerifyScriptPath],
    cwd: backendRoot,
    env,
    windowsHide: false,
  })
}

const waitForDockerMysqlReady = async ({ dockerCommand, dockerConfig, composeEnv }) => {
  const deadline = Date.now() + dockerConfig.startupTimeoutMs
  const mysqlAdminArgs = [
    'compose',
    '-f',
    composeFilePath,
    '-p',
    dockerConfig.projectName,
    'exec',
    '-T',
    'mysql',
    'mysqladmin',
    'ping',
    '-h',
    '127.0.0.1',
    '-uroot',
    `-p${dockerConfig.password}`,
    '--silent',
  ]

  while (Date.now() < deadline) {
    const result = await runCapturedCommand({
      title: '等待 MySQL 就绪',
      command: dockerCommand,
      args: mysqlAdminArgs,
      cwd: projectRoot,
      env: composeEnv,
    })

    if (result.signal) {
      throw new Error(`等待 MySQL 就绪时被中断：${result.signal}`)
    }

    if (result.code === 0) {
      log(`Docker MySQL 已就绪：${dockerConfig.host}:${dockerConfig.port}`)
      return
    }

    await wait(1500)
  }

  throw new Error(
    [
      '等待 Docker MySQL 临时环境就绪超时。',
      `- 目标地址：${dockerConfig.host}:${dockerConfig.port}`,
      `- 超时时间：${dockerConfig.startupTimeoutMs}ms`,
      `- 处理建议：执行 \`docker compose -f ${path.basename(composeFilePath)} -p ${dockerConfig.projectName} logs mysql\` 查看容器日志。`,
    ].join('\n'),
  )
}

const stopDockerMysql = async ({ dockerCommand, dockerConfig, composeEnv }) => {
  await runCommand({
    title: '清理数据库并发验收 Docker 临时环境',
    command: dockerCommand,
    args: ['compose', '-f', composeFilePath, '-p', dockerConfig.projectName, 'down', '-v', '--remove-orphans'],
    cwd: projectRoot,
    env: composeEnv,
    windowsHide: false,
  })
}

const withPreparedDockerMysql = async (callback) => {
  const dockerConfig = createDockerRuntimeConfig()
  const composeEnv = createDockerComposeEnv(dockerConfig)
  let dockerCommand

  try {
    dockerCommand = resolveDockerCommand()
  } catch (error) {
    throw new Error(
      [
        'verify:db:concurrency 已阻断：当前环境未找到可用的 Docker CLI，无法自动准备受控 MySQL 临时环境。',
        '修复方式：',
        '- 安装并启动 Docker Desktop / Docker Engine 后重新执行；',
        '- 或显式提供 `VERIFY_DB_CONCURRENCY_MYSQL_HOST` / `PORT` / `USER` / `PASSWORD` 连接到你自备的 MySQL 验收环境；',
        '- 或设置 `VERIFY_DB_CONCURRENCY_AUTO_PREPARE=off`，再复用已有 `DB_*` 连接参数手动验收。',
        `原始错误：${error instanceof Error ? error.message : String(error)}`,
      ].join('\n'),
    )
  }

  log(`准备拉起 Docker MySQL 临时环境：${dockerConfig.image} -> ${dockerConfig.host}:${dockerConfig.port}`)

  try {
    await runCommand({
      title: '启动数据库并发验收 Docker 临时环境',
      command: dockerCommand,
      args: ['compose', '-f', composeFilePath, '-p', dockerConfig.projectName, 'up', '-d'],
      cwd: projectRoot,
      env: composeEnv,
      windowsHide: false,
    })
    await waitForDockerMysqlReady({
      dockerCommand,
      dockerConfig,
      composeEnv,
    })
    await callback(createVerifyRuntimeEnv(dockerConfig))
  } catch (error) {
    throw new Error(
      [
        'verify:db:concurrency 已阻断：受控 Docker MySQL 临时环境准备失败。',
        '修复方式：',
        '- 确认 Docker 已启动，且当前账号有权限执行 `docker compose`；',
        '- 若 `3406` 端口被占用，可设置 `VERIFY_DB_CONCURRENCY_DOCKER_PORT` 改用其它本地端口；',
        '- 若需要固定镜像版本或密码，可设置 `VERIFY_DB_CONCURRENCY_DOCKER_IMAGE`、`VERIFY_DB_CONCURRENCY_DOCKER_ROOT_PASSWORD`；',
        '- 如果当前 CI 已提供独立 MySQL，也可显式传入 `VERIFY_DB_CONCURRENCY_MYSQL_*` 跳过 Docker 自动准备。',
        `原始错误：${error instanceof Error ? error.message : String(error)}`,
      ].join('\n'),
    )
  } finally {
    if (dockerCommand) {
      try {
        await stopDockerMysql({ dockerCommand, dockerConfig, composeEnv })
        log('Docker MySQL 临时环境已清理完成')
      } catch (error) {
        console.warn(
          [
            '[verify-db-concurrency-runner] Docker MySQL 临时环境清理失败，请手动执行以下命令：',
            `docker compose -f ${path.basename(composeFilePath)} -p ${dockerConfig.projectName} down -v --remove-orphans`,
            `原始错误：${error instanceof Error ? error.message : String(error)}`,
          ].join('\n'),
        )
      }
    }
  }
}

const main = async () => {
  if (hasDedicatedVerifyMysqlEnv()) {
    log('检测到显式 VERIFY_DB_CONCURRENCY_MYSQL_*，本次直接复用受控 MySQL 连接')
    await runRawVerifyScript(process.env)
    return
  }

  if (readBooleanFalseLike(process.env.VERIFY_DB_CONCURRENCY_AUTO_PREPARE)) {
    log('已关闭 Docker 自动准备，转为直接执行后端并发验收脚本')
    await runRawVerifyScript(process.env)
    return
  }

  await withPreparedDockerMysql(async (verifyEnv) => {
    await runRawVerifyScript(verifyEnv)
  })
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
