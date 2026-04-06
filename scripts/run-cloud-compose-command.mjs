import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const [, , action = 'start'] = process.argv
const currentFilePath = fileURLToPath(import.meta.url)
const projectRoot = path.resolve(path.dirname(currentFilePath), '..')
const composeFilePath = path.join(projectRoot, 'compose.cloud.yml')

const run = ({ title, args, blocking = true }) =>
  new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      cwd: projectRoot,
      stdio: 'inherit',
      shell: false,
      windowsHide: false,
    })

    child.on('error', (error) => {
      reject(new Error(`${title} 启动失败：${error.message}`))
    })

    child.on('exit', (code, signal) => {
      if (!blocking) {
        resolve(0)
        return
      }

      if (signal) {
        reject(new Error(`${title} 被信号中断：${signal}`))
        return
      }

      resolve(code ?? 1)
    })
  })

const ensureExitCodeZero = (title, code) => {
  if (code !== 0) {
    throw new Error(`${title} 执行失败，exitCode=${code}`)
  }
}

const runCloudStack = async () => {
  if (action === 'start') {
    const pullExitCode = await run({
      title: '拉取云端镜像',
      args: ['compose', '-f', composeFilePath, 'pull'],
    })
    ensureExitCodeZero('拉取云端镜像', pullExitCode)

    const upExitCode = await run({
      title: '启动云端编排',
      args: ['compose', '-f', composeFilePath, 'up', '-d'],
    })
    ensureExitCodeZero('启动云端编排', upExitCode)

    console.log('[cloud-compose] 服务已启动，开始附加统一日志流（frontend + backend）...')
    const logsExitCode = await run({
      title: '附加统一日志流',
      args: ['compose', '-f', composeFilePath, 'logs', '-f', '--tail=200', 'frontend', 'backend'],
    })
    ensureExitCodeZero('附加统一日志流', logsExitCode)
    return
  }

  if (action === 'logs') {
    const logsExitCode = await run({
      title: '附加统一日志流',
      args: ['compose', '-f', composeFilePath, 'logs', '-f', '--tail=200', 'frontend', 'backend'],
    })
    ensureExitCodeZero('附加统一日志流', logsExitCode)
    return
  }

  if (action === 'stop') {
    const downExitCode = await run({
      title: '停止云端编排',
      args: ['compose', '-f', composeFilePath, 'down'],
    })
    ensureExitCodeZero('停止云端编排', downExitCode)
    return
  }

  throw new Error(`不支持的动作：${action}，可选值为 start|logs|stop`)
}

try {
  await runCloudStack()
} catch (error) {
  console.error(`[cloud-compose] ${error.message}`)
  process.exit(1)
}
