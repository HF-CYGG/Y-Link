/**
 * 模块说明：scripts/verify-all-performance-suite.mjs
 * 文件职责：聚合执行项目全部性能相关测试脚本，提供“一键全量性能验证”入口。
 * 实现逻辑：先执行前端性能套件，再执行后端订单查询基线验证，形成前后端联合性能闭环。
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveNpmCommand, runCommand } from './process-runner-utils.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const backendRoot = path.join(projectRoot, 'backend')

const log = (message) => {
  // eslint-disable-next-line no-console
  console.log(message)
}

/**
 * 顺序执行步骤：
 * - 性能验证存在明显前置依赖，必须串行执行，避免并发读写产物与数据库导致结果污染；
 * - 任一步失败立即退出，防止“部分通过”掩盖真实性能回归。
 */
const runStep = async (title, command, args, cwd) => {
  log(`\n[perf-all] 开始：${title}`)
  await runCommand({
    title,
    command,
    args,
    cwd,
    windowsHide: false,
  })
  log(`[perf-all] 通过：${title}`)
}

const runNpmScript = async (title, scriptName, cwd) => {
  const npmCommand = resolveNpmCommand()
  await runStep(title, npmCommand.command, [...npmCommand.prefixArgs, 'run', scriptName], cwd)
}

const main = async () => {
  // 前端性能套件：包含 build + 预算校验 + 核心路径回归，属于页面性能与交互性能主入口。
  await runNpmScript('前端性能套件', 'verify:performance', projectRoot)

  // 后端性能套件：重点验证订单查询链路的基线表现，防止分页/索引变更造成查询退化。
  await runNpmScript('后端订单查询性能基线', 'order-query:baseline:verify', backendRoot)

  log('\n[perf-all] 全部性能测试脚本执行完成')
}

try {
  await main()
} catch (error) {
  // eslint-disable-next-line no-console
  console.error('\n[perf-all] 全部性能测试脚本失败：', error)
  process.exit(1)
}
