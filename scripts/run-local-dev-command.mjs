/**
 * 模块说明：scripts/run-local-dev-command.mjs
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveWindowsPowerShellPath } from './process-runner-utils.mjs'

// 通过 Node 包装层统一调用 Windows PowerShell 5：
// 1. 规避 npm script 在 Windows 下对 PowerShell 参数透传不稳定的问题；
// 2. 始终显式调用 powershell.exe，确保与项目当前的 PowerShell 5 脚本语法保持一致；
// 3. 同时兼容“PowerShell 风格参数”和“npm 风格参数”，保证 start/status/stop 链路行为一致。
const [, , scriptName, ...rawForwardedArgs] = process.argv
const forwardedArgs = rawForwardedArgs.filter((arg) => arg !== '--')

const parameterDefinitions = [
  {
    powerShellName: '-BackendProfile',
    kind: 'value',
    aliases: ['--backend-profile', '--backendProfile', '-BackendProfile'],
    envKeys: ['npm_config_backend_profile', 'npm_config_backendprofile'],
  },
  {
    powerShellName: '-BackendPort',
    kind: 'value',
    aliases: ['--backend-port', '--backendPort', '-BackendPort'],
    envKeys: ['npm_config_backend_port', 'npm_config_backendport'],
  },
  {
    powerShellName: '-FrontendPort',
    kind: 'value',
    aliases: ['--frontend-port', '--frontendPort', '-FrontendPort'],
    envKeys: ['npm_config_frontend_port', 'npm_config_frontendport'],
  },
  {
    powerShellName: '-MaxReadyAttempts',
    kind: 'value',
    aliases: ['--max-ready-attempts', '--maxReadyAttempts', '-MaxReadyAttempts'],
    envKeys: ['npm_config_max_ready_attempts', 'npm_config_maxreadyattempts'],
  },
  {
    powerShellName: '-NoCleanLogs',
    kind: 'switch',
    aliases: ['--no-clean-logs', '--noCleanLogs', '-NoCleanLogs'],
    envKeys: ['npm_config_no_clean_logs', 'npm_config_nocleanlogs'],
  },
  {
    powerShellName: '-NoAttachLogs',
    kind: 'switch',
    aliases: ['--no-attach-logs', '--noAttachLogs', '-NoAttachLogs'],
    envKeys: ['npm_config_no_attach_logs', 'npm_config_noattachlogs'],
  },
  {
    powerShellName: '-OpenBrowser',
    kind: 'switch',
    aliases: ['--open-browser', '--openBrowser', '-OpenBrowser'],
    envKeys: ['npm_config_open_browser', 'npm_config_openbrowser'],
  },
]

function isTruthySwitchValue(value) {
  if (value == null) {
    return false
  }

  const normalizedValue = String(value).trim().toLowerCase()
  return normalizedValue === '' || normalizedValue === 'true' || normalizedValue === '1' || normalizedValue === 'yes'
}

function getEnvironmentValue(envKeys) {
  for (const envKey of envKeys) {
    if (Object.hasOwn(process.env, envKey)) {
      return process.env[envKey]
    }
  }

  return undefined
}

function normalizeForwardedArgs(rawArgs) {
  const resolvedArgs = []

  for (let index = 0; index < rawArgs.length; index += 1) {
    const currentArg = rawArgs[index]
    let matchedDefinition = null
    let matchedAlias = null

    for (const definition of parameterDefinitions) {
      matchedAlias = definition.aliases.find((alias) => {
        const loweredArg = currentArg.toLowerCase()
        return loweredArg === alias.toLowerCase() || loweredArg.startsWith(`${alias.toLowerCase()}=`)
      })

      if (matchedAlias) {
        matchedDefinition = definition
        break
      }
    }

    if (!matchedDefinition || !matchedAlias) {
      resolvedArgs.push(currentArg)
      continue
    }

    if (matchedDefinition.kind === 'switch') {
      resolvedArgs.push(matchedDefinition.powerShellName)
      continue
    }

    const inlineValue = currentArg.slice(matchedAlias.length + 1)
    if (inlineValue) {
      resolvedArgs.push(matchedDefinition.powerShellName, inlineValue)
      continue
    }

    const nextArg = rawArgs[index + 1]
    if (nextArg == null) {
      throw new Error(`参数 ${currentArg} 缺少值。`)
    }

    resolvedArgs.push(matchedDefinition.powerShellName, nextArg)
    index += 1
  }

  return resolvedArgs
}

function hasResolvedArgument(resolvedArgs, powerShellName) {
  return resolvedArgs.some((arg) => String(arg).toLowerCase() === powerShellName.toLowerCase())
}

function buildPowerShellArguments(rawArgs) {
  const resolvedArgs = normalizeForwardedArgs(rawArgs)

  // 若 npm 将附加参数吞为 npm_config_* 环境变量，则在这里回填到真正的 PowerShell 参数中。
  for (const definition of parameterDefinitions) {
    if (hasResolvedArgument(resolvedArgs, definition.powerShellName)) {
      continue
    }

    const envValue = getEnvironmentValue(definition.envKeys)
    if (definition.kind === 'switch') {
      if (isTruthySwitchValue(envValue)) {
        resolvedArgs.push(definition.powerShellName)
      }
      continue
    }

    if (envValue != null && String(envValue).trim() !== '') {
      resolvedArgs.push(definition.powerShellName, String(envValue).trim())
    }
  }

  return resolvedArgs
}

if (!scriptName) {
  console.error('[local-dev] 缺少需要执行的 PowerShell 脚本名。')
  process.exit(1)
}

const currentFilePath = fileURLToPath(import.meta.url)
const scriptsDirectory = path.dirname(currentFilePath)
const projectRoot = path.resolve(scriptsDirectory, '..')
const targetScriptPath = path.resolve(projectRoot, scriptName)
const resolvedPowerShellArgs = buildPowerShellArguments(forwardedArgs)
const powerShellExecutablePath = resolveWindowsPowerShellPath()

const child = spawn(
  powerShellExecutablePath,
  [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    targetScriptPath,
    ...resolvedPowerShellArgs,
  ],
  {
    cwd: projectRoot,
    stdio: 'inherit',
    windowsHide: false,
  },
)

child.on('error', (error) => {
  console.error(
    `[local-dev] 启动 PowerShell 失败：${error.message}\n[local-dev] powershell=${powerShellExecutablePath}\n[local-dev] script=${targetScriptPath}`,
  )
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal) {
    // 保留与原生终端一致的退出语义，便于上层命令链识别“被中断”而非“脚本异常”。
    process.kill(process.pid, signal)
    return
  }

  process.exit(code ?? 0)
})
