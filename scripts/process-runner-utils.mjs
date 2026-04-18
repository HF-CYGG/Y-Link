/**
 * 模块说明：scripts/process-runner-utils.mjs
 * 文件职责：提供命令解析、CLI 定位与子进程执行的共享工具，供本地联调、构建和验证脚本复用。
 * 实现逻辑：尽量通过显式绝对路径和 `shell: false` 运行命令，降低 Windows/CI 环境差异带来的不稳定性。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

/**
 * 统一的子进程执行与命令解析工具：
 * - 避免依赖 shell=true、cmd.exe、powershell.exe 的隐式解析；
 * - 在 PATH / COMSPEC 被宿主裁剪时，仍优先通过绝对路径启动关键命令；
 * - 让构建、本地联调包装层、性能验证脚本共用同一套稳健实现。
 */

const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== ''

const normalizePath = (candidatePath) => {
  if (!isNonEmptyString(candidatePath)) return ''
  return path.normalize(candidatePath)
}

const fileExists = (candidatePath) => {
  if (!isNonEmptyString(candidatePath)) {
    return false
  }

  try {
    return fs.existsSync(candidatePath)
  } catch {
    return false
  }
}

const resolveFirstExistingPath = (candidates) => {
  if (!Array.isArray(candidates)) return null

  for (const candidate of candidates) {
    if (fileExists(candidate)) {
      return normalizePath(candidate)
    }
  }

  return null
}

const getPathEntries = () => {
  const rawPath = process.env.PATH ?? process.env.Path ?? ''
  return rawPath
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

/**
 * 在 PATH 中解析命令：
 * - 仅做显式文件存在性判断，不依赖 shell 的扩展名补全；
 * - 允许传入多个候选命令名，便于兼容 .cmd / .exe 等不同包装文件。
 */
export const resolveCommandFromPath = (commandNames) => {
  const normalizedCommandNames = commandNames.filter(isNonEmptyString)
  for (const directoryPath of getPathEntries()) {
    const resolvedPath = resolveFirstExistingPath(
      normalizedCommandNames.map((commandName) => path.join(directoryPath, commandName)),
    )
    if (resolvedPath) {
      return resolvedPath
    }
  }

  return null
}

/**
 * 解析当前系统中的 Windows PowerShell 5 可执行文件：
 * - 优先复用 PATH 中已可见的 powershell.exe；
 * - 若 PATH 不完整，则回退到 SystemRoot / windir 下的标准安装目录；
 * - 最终返回绝对路径，避免在受限终端里再次依赖 PATH 查找。
 */
export const resolveWindowsPowerShellPath = () => {
  const fromPath = resolveCommandFromPath(['powershell.exe'])
  if (fromPath) {
    return fromPath
  }

  const systemRoot = process.env.SYSTEMROOT ?? process.env.SystemRoot ?? process.env.windir
  const fallbackCandidates = []

  if (isNonEmptyString(systemRoot)) {
    fallbackCandidates.push(
      path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      path.join(systemRoot, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    )
  }

  fallbackCandidates.push(
    String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
    String.raw`C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe`,
  )

  const resolvedPath = resolveFirstExistingPath(fallbackCandidates)
  if (resolvedPath) {
    return resolvedPath
  }

  throw new Error('未找到可用的 Windows PowerShell 5 可执行文件（powershell.exe）。')
}

/**
 * 解析 npm 入口：
 * - 在 npm script 内优先复用 npm_execpath，对 PATH 最不敏感；
 * - 若当前不是从 npm script 进入，则回退到 Node 安装目录或 PATH 中的 npm.cmd；
 * - 统一返回 command + prefixArgs，方便上层直接追加 run/build 等参数。
 */
export const resolveNpmCommand = () => {
  const npmExecPath = process.env.npm_execpath
  if (fileExists(npmExecPath) && /\.(?:c?js|mjs)$/i.test(String(npmExecPath))) {
    return {
      command: process.execPath,
      prefixArgs: [normalizePath(npmExecPath)],
      displayName: `node ${normalizePath(npmExecPath)}`,
    }
  }

  const nodeExecutableDirectory = path.dirname(process.execPath)
  const fallbackCandidates = [
    path.join(nodeExecutableDirectory, 'npm.cmd'),
    path.join(nodeExecutableDirectory, 'npm'),
    resolveCommandFromPath(['npm.cmd', 'npm']),
  ].filter(Boolean)

  const npmCommandPath = resolveFirstExistingPath(fallbackCandidates)
  if (npmCommandPath) {
    return {
      command: npmCommandPath,
      prefixArgs: [],
      displayName: npmCommandPath,
    }
  }

  throw new Error('未找到可用的 npm 入口（npm_execpath / npm.cmd）。')
}

/**
 * 解析前端构建所需 CLI 的 JS 入口：
 * - 直接使用 process.execPath + cli.js，彻底绕开 .cmd 与 shell 运算符；
 * - 对 PowerShell 5、受限 PATH 终端以及 CI 壳层都更稳定。
 */
export const resolveVueTscCliPath = (projectRoot) => {
  if (!isNonEmptyString(projectRoot)) throw new Error('解析 vue-tsc 路径失败：未提供项目根目录')
  const resolvedPath = path.join(projectRoot, 'node_modules', 'vue-tsc', 'bin', 'vue-tsc.js')
  if (!fileExists(resolvedPath)) {
    throw new Error(`未找到 vue-tsc CLI：${resolvedPath}`)
  }

  return normalizePath(resolvedPath)
}

export const resolveViteCliPath = (projectRoot) => {
  if (!isNonEmptyString(projectRoot)) throw new Error('解析 Vite 路径失败：未提供项目根目录')
  const resolvedPath = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js')
  if (!fileExists(resolvedPath)) {
    throw new Error(`未找到 Vite CLI：${resolvedPath}`)
  }

  return normalizePath(resolvedPath)
}

export const resolveTsxCliPath = (backendRoot) => {
  if (!isNonEmptyString(backendRoot)) throw new Error('解析 tsx 路径失败：未提供后端根目录')
  const resolvedPath = path.join(backendRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  if (!fileExists(resolvedPath)) {
    throw new Error(`未找到 tsx CLI：${resolvedPath}`)
  }

  return normalizePath(resolvedPath)
}

const formatCommandLine = (command, args) => [command, ...args].join(' ')

/**
 * 使用“显式命令 + 显式参数”执行子进程：
 * - 默认关闭 shell，避免 PowerShell 5 / cmd 的语法差异导致异常退出；
 * - 保留 stdio 透传，便于终端直接看到实时日志；
 * - error 与 exit 均抛出带上下文的错误信息，方便定位根因。
 */
export const runCommand = ({
  title,
  command,
  args = [],
  cwd,
  env = process.env,
  stdio = 'inherit',
  windowsHide = true,
}) =>
  new Promise((resolve, reject) => {
    if (!isNonEmptyString(title)) return reject(new TypeError('启动失败：必须提供有效的 title 参数'))
    if (!isNonEmptyString(command)) return reject(new TypeError(`${title} 启动失败：必须提供有效的 command 参数`))
    if (!Array.isArray(args)) return reject(new TypeError(`${title} 启动失败：args 必须是数组`))

    const child = spawn(command, args, {
      cwd,
      env,
      stdio,
      shell: false,
      windowsHide,
    })

    child.on('error', (error) => {
      reject(
        new Error(
          `${title} 启动失败：${error.message}\ncommand: ${formatCommandLine(command, args)}\ncwd: ${cwd}`,
        ),
      )
    })

    child.on('exit', (code, signal) => {
      if (signal) {
        reject(
          new Error(
            `${title} 被信号中断：${signal}\ncommand: ${formatCommandLine(command, args)}\ncwd: ${cwd}`,
          ),
        )
        return
      }

      if (code === 0) {
        resolve()
        return
      }

      reject(
        new Error(
          `${title} 执行失败，exitCode=${code ?? 'unknown'}\ncommand: ${formatCommandLine(command, args)}\ncwd: ${cwd}`,
        ),
      )
    })
  })
