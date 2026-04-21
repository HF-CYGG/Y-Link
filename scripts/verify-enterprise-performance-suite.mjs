/**
 * 模块说明：scripts/verify-enterprise-performance-suite.mjs
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCommand } from './process-runner-utils.mjs'

/**
 * 企业页面性能统一验证入口：
 * - 先构建前端，确保产物级预算检查有最新输入；
 * - 再执行构建预算校验；
 * - 最后执行核心路径回归脚本，形成“预算 + 核心链路”的完整闭环。
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')

const log = (message) => {
  // eslint-disable-next-line no-console
  console.log(message)
}

/**
 * 顺序执行子命令：
 * - 任何一步失败都会中断整套验证；
 * - stdio 直接继承当前终端，保证用户能看到完整的实时输出。
 */
const runStep = async (title, command, args, cwd = projectRoot) => {
  log(`\n[suite] 开始：${title}`)
  await runCommand({
    title,
    command,
    args,
    cwd,
    windowsHide: false,
  })
  log(`[suite] 通过：${title}`)
}

const main = async () => {
  // 显式使用当前 Node 进程执行各个脚本，避免 shell=true 在 PowerShell 5 / 受限终端中
  // 因 cmd、COMSPEC 或 PATH 缺失而导致“命令未真正启动就直接退出”。
  // 执行顺序刻意固定为“构建 -> 预算 -> 核心路径”：
  // - 预算校验依赖最新产物；
  // - 核心路径回归应在预算通过后再执行，避免把明显超预算产物继续带入后续验收。
  await runStep('前端构建', process.execPath, [path.join(projectRoot, 'scripts', 'run-frontend-build.mjs')])
  await runStep('构建预算校验', process.execPath, [path.join(projectRoot, 'scripts', 'verify-enterprise-page-performance.mjs')])
  await runStep('核心路径回归校验', process.execPath, [path.join(projectRoot, 'scripts', 'verify-enterprise-core-paths.mjs')])
  await runStep('客户端并发与性能基线校验', process.execPath, [path.join(projectRoot, 'scripts', 'verify-client-concurrency-performance.mjs')])

  log('\n[suite] 企业页面性能统一验证入口执行完成')
}

try {
  await main()
} catch (error) {
  // eslint-disable-next-line no-console
  console.error('\n[suite] 企业页面性能统一验证入口失败：', error)
  process.exit(1)
}
