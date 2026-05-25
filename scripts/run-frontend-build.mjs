/**
 * 模块说明：F:/Y-Link/scripts/run-frontend-build.mjs
 * 文件职责：前端构建入口脚本，负责串联类型检查与生产打包。
 * 实现逻辑：按“vue-tsc -> vite build”顺序执行并统一 Node CLI 调用，规避 shell 差异导致的构建失败。
 * 维护说明：构建链路变更需同步 CI 命令与本地脚本口径。
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveViteCliPath, resolveVueTscCliPath, runCommand } from './process-runner-utils.mjs'

/**
 * 前端构建包装层：
 * - 先执行 vue-tsc 增量类型构建，再执行 Vite 打包；
 * - 全程使用 `node cli.js` 方式，不依赖 PowerShell / cmd 对 `&&` 的解析；
 * - 解决 PowerShell 5 或 script-shell 被改写时 `npm run build` 异常退出的问题。
 */

const currentFilePath = fileURLToPath(import.meta.url)
const scriptsDirectory = path.dirname(currentFilePath)
const projectRoot = path.resolve(scriptsDirectory, '..')

try {
  const vueTscCliPath = resolveVueTscCliPath(projectRoot)
  const viteCliPath = resolveViteCliPath(projectRoot)

  console.log('[build] 开始执行前端类型构建')
  await runCommand({
    title: '前端类型构建',
    command: process.execPath,
    args: [vueTscCliPath, '-b'],
    cwd: projectRoot,
    windowsHide: false,
  })

  console.log('[build] 开始执行 Vite 打包')
  await runCommand({
    title: 'Vite 打包',
    command: process.execPath,
    args: [viteCliPath, 'build'],
    cwd: projectRoot,
    windowsHide: false,
  })

  console.log('[build] 前端构建完成')
} catch (error) {
  console.error(`[build] 构建过程中出现错误:`, error)
  process.exit(1)
}
