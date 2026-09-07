/**
 * 文件说明：反馈附件 SQLite/MySQL 专项验收编排器。
 * 实现逻辑：SQLite 直接运行隔离脚本；MySQL 使用唯一 Compose project、随机本地端口和临时库，
 * 验证结束后始终执行 down -v，不连接现有业务容器或业务数据库。
 */

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
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

const findAvailablePort = () => new Promise((resolve, reject) => {
  const server = net.createServer()
  server.unref()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') {
      server.close()
      reject(new Error('无法分配 MySQL 隔离验收端口'))
      return
    }
    const { port } = address
    server.close((error) => error ? reject(error) : resolve(port))
  })
})

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

const waitForMysql = async (config, timeoutMs = 90_000) => {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
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
  const projectName = `y-link-feedback-${process.pid}-${Date.now().toString(36)}`.toLowerCase()
  const password = `YLinkFeedback_${randomUUID().replaceAll('-', '').slice(0, 16)}!`
  const mysqlConfig = { host: '127.0.0.1', port, user: 'root', password }
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
    await waitForMysql(mysqlConfig)
    await runVerifyScript({
      ...process.env,
      FEEDBACK_ATTACHMENT_VERIFY_DB: 'mysql',
      FEEDBACK_ATTACHMENT_VERIFY_MYSQL_HOST: mysqlConfig.host,
      FEEDBACK_ATTACHMENT_VERIFY_MYSQL_PORT: String(mysqlConfig.port),
      FEEDBACK_ATTACHMENT_VERIFY_MYSQL_USER: mysqlConfig.user,
      FEEDBACK_ATTACHMENT_VERIFY_MYSQL_PASSWORD: mysqlConfig.password,
    })
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

if (requestedMode === 'sqlite' || requestedMode === 'all') {
  await runVerifyScript({ ...process.env, FEEDBACK_ATTACHMENT_VERIFY_DB: 'sqlite' })
}
if (requestedMode === 'mysql' || requestedMode === 'all') {
  await runMysqlVerify()
}
