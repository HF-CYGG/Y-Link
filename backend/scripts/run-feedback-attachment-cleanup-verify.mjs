/**
 * 文件说明：反馈附件 SQLite/MySQL 专项验收编排器。
 * 实现逻辑：SQLite 直接运行隔离脚本；MySQL 使用唯一 Compose project、随机本地端口和临时库，
 * 验证结束后始终执行 down -v，不连接现有业务容器或业务数据库。
 */

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { randomInt, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createConnection } from 'mysql2/promise'
import { resolveDockerCommand, runCommand } from '../../scripts/process-runner-utils.mjs'

const currentFilePath = fileURLToPath(import.meta.url)
const backendRoot = path.resolve(path.dirname(currentFilePath), '..')
const projectRoot = path.resolve(backendRoot, '..')
const composeFilePath = path.resolve(projectRoot, 'compose.verify-db-concurrency.yml')
const verifyScriptPath = path.resolve(backendRoot, 'scripts', 'feedback-attachment-cleanup-verify.ts')
const requestedMode = process.argv.includes('--mysql')
  ? 'mysql'
  : process.argv.includes('--sqlite')
    ? 'sqlite'
    : 'all'

/** 直接运行 TS 专项时也须核对本轮 Compose 容器、回环端口和随机启动凭据。 */
export function readFeedbackMysqlFixture(env = process.env) {
  const project = env.FEEDBACK_ATTACHMENT_VERIFY_MYSQL_PROJECT ?? ''
  const container = env.FEEDBACK_ATTACHMENT_VERIFY_MYSQL_CONTAINER ?? ''
  const command = env.FEEDBACK_ATTACHMENT_VERIFY_DOCKER_COMMAND ?? ''
  const password = env.FEEDBACK_ATTACHMENT_VERIFY_MYSQL_PASSWORD ?? ''
  const rawPort = env.FEEDBACK_ATTACHMENT_VERIFY_MYSQL_PORT ?? ''
  const port = Number(rawPort)
  if (!/^y-link-feedback-[a-f0-9]{24}$/.test(project) || !/^[a-f0-9]{64}$/.test(container)
    || !command || !/^YLinkFeedback_[a-f0-9]{32}!$/.test(password) || !/^\d{1,5}$/.test(rawPort)
    || port < 10_000 || port > 65_535) {
    throw new Error('缺少本轮反馈 MySQL Compose 所有权上下文，未连接数据库')
  }
  const inspected = spawnSync(command, ['inspect', '--type', 'container', container], { encoding: 'utf8', windowsHide: true })
  if (inspected.status !== 0) throw new Error('无法核对本轮反馈 MySQL 容器，未连接数据库')
  const [info] = JSON.parse(inspected.stdout)
  const labels = info?.Config?.Labels
  const bindings = info?.NetworkSettings?.Ports?.['3306/tcp']
  if (info?.Id !== container || !info?.State?.Running || labels?.['com.docker.compose.project'] !== project
    || labels?.['com.docker.compose.service'] !== 'mysql' || bindings?.length !== 1
    || bindings[0].HostIp !== '127.0.0.1' || Number(bindings[0].HostPort) !== port
    || !info.Config.Env?.includes(`MYSQL_ROOT_PASSWORD=${password}`)) {
    throw new Error('反馈 MySQL 容器标签、端口或启动身份不符，未连接数据库')
  }
  return { host: '127.0.0.1', port, user: 'root', password }
}

const findAvailablePort = async () => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const port = randomInt(20_000, 32_000)
    const available = await new Promise((resolve, reject) => {
      const server = net.createServer()
      server.once('error', (error) => error.code === 'EADDRINUSE' ? resolve(false) : reject(error))
      server.listen(port, '127.0.0.1', () => server.close((error) => error ? reject(error) : resolve(true)))
    })
    if (available) return port
  }
  throw new Error('无法分配 MySQL 隔离验收高位端口')
}

const resolveFeedbackVerifyDocker = () => {
  const explicit = process.env.FEEDBACK_ATTACHMENT_VERIFY_DOCKER?.trim()
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error('FEEDBACK_ATTACHMENT_VERIFY_DOCKER 指向的 Docker CLI 不存在')
    return path.resolve(explicit)
  }
  const localAppData = process.env.LOCALAPPDATA
  const desktopCandidate = localAppData
    ? path.join(localAppData, 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe')
    : ''
  if (desktopCandidate && fs.existsSync(desktopCandidate)) return desktopCandidate
  return resolveDockerCommand()
}

const runVerifyScript = async (env) => {
  await runCommand({
    title: '执行反馈附件并发与孤儿清理专项回归',
    command: process.execPath,
    args: ['--import', 'tsx', verifyScriptPath],
    cwd: backendRoot,
    env,
    windowsHide: false,
  })
}

const waitForMysql = async (env, timeoutMs = 90_000) => {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    const config = readFeedbackMysqlFixture(env)
    try {
      const connection = await createConnection({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        connectTimeout: 3_000,
      })
      await connection.ping()
      await connection.end()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
  }
  throw new Error(`等待隔离 MySQL 就绪超时：${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

const runMysqlVerify = async () => {
  const dockerCommand = resolveFeedbackVerifyDocker()
  const port = await findAvailablePort()
  const projectName = `y-link-feedback-${randomUUID().replaceAll('-', '').slice(0, 24)}`
  const password = `YLinkFeedback_${randomUUID().replaceAll('-', '')}!`
  const composeEnv = {
    ...process.env,
    VERIFY_DB_CONCURRENCY_DOCKER_IMAGE: process.env.FEEDBACK_ATTACHMENT_VERIFY_MYSQL_IMAGE?.trim() || 'mysql:8.4',
    VERIFY_DB_CONCURRENCY_DOCKER_PORT: String(port),
    VERIFY_DB_CONCURRENCY_DOCKER_ROOT_PASSWORD: password,
  }

  console.log(`[feedback-attachment-verify] 启动唯一隔离 MySQL：project=${projectName} port=${port}`)
  try {
    await runCommand({
      title: '启动反馈附件验收 MySQL',
      command: dockerCommand,
      args: ['compose', '-f', composeFilePath, '-p', projectName, 'up', '-d'],
      cwd: projectRoot,
      env: composeEnv,
      windowsHide: false,
    })
    const composeContainer = spawnSync(dockerCommand, ['compose', '-f', composeFilePath, '-p', projectName, 'ps', '-q', 'mysql'], {
      cwd: projectRoot, env: composeEnv, encoding: 'utf8', windowsHide: true,
    })
    if (composeContainer.status !== 0) throw new Error('无法定位本轮反馈 MySQL Compose 容器')
    const childEnv = {
      ...process.env,
      FEEDBACK_ATTACHMENT_VERIFY_DB: 'mysql',
      FEEDBACK_ATTACHMENT_VERIFY_DOCKER_COMMAND: dockerCommand,
      FEEDBACK_ATTACHMENT_VERIFY_MYSQL_PROJECT: projectName,
      FEEDBACK_ATTACHMENT_VERIFY_MYSQL_CONTAINER: composeContainer.stdout.trim(),
      FEEDBACK_ATTACHMENT_VERIFY_MYSQL_PORT: String(port),
      FEEDBACK_ATTACHMENT_VERIFY_MYSQL_PASSWORD: password,
    }
    await waitForMysql(childEnv)
    await runVerifyScript(childEnv)
  } finally {
    await runCommand({
      title: '销毁反馈附件验收 MySQL',
      command: dockerCommand,
      args: ['compose', '-f', composeFilePath, '-p', projectName, 'down', '-v', '--remove-orphans'],
      cwd: projectRoot,
      env: composeEnv,
      windowsHide: false,
    })
    console.log('[feedback-attachment-verify] 隔离 MySQL 已销毁')
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFilePath) {
  if (requestedMode === 'sqlite' || requestedMode === 'all') {
    await runVerifyScript({ ...process.env, FEEDBACK_ATTACHMENT_VERIFY_DB: 'sqlite' })
  }
  if (requestedMode === 'mysql' || requestedMode === 'all') {
    await runMysqlVerify()
  }
}
