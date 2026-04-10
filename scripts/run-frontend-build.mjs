/**
 * 模块说明：scripts/run-frontend-build.mjs
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
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
