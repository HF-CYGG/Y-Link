/**
 * 模块说明：scripts/verify-quality-full-suite.mjs
 * 文件职责：串联“单元功能 + 全部性能”两大测试套件，提供统一总控入口。
 * 实现逻辑：严格串行执行、失败即停、落盘步骤报告，帮助快速且精准定位失败阶段。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCommand } from './process-runner-utils.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const runtimeRoot = path.join(projectRoot, '.local-dev')
const reportPath = path.join(runtimeRoot, 'verify-quality-full-suite.report.json')

const steps = []

const log = (message) => {
  // eslint-disable-next-line no-console
  console.log(message)
}

const nowIso = () => new Date().toISOString()

/**
 * 统一步骤执行器：
 * - 所有步骤均记录开始时间、结束时间、耗时与状态；
 * - 一旦失败立即抛错，确保“快、准、狠”地暴露第一个阻断问题。
 */
const runStep = async (title, scriptPath) => {
  const startedAt = Date.now()
  log(`\n[quality-all] 开始：${title}`)
  try {
    await runCommand({
      title,
      command: process.execPath,
      args: [scriptPath],
      cwd: projectRoot,
      windowsHide: false,
    })
    const durationMs = Date.now() - startedAt
    steps.push({
      title,
      status: 'passed',
      startedAt: new Date(startedAt).toISOString(),
      endedAt: nowIso(),
      durationMs,
    })
    log(`[quality-all] 通过：${title}（${durationMs}ms）`)
  } catch (error) {
    const durationMs = Date.now() - startedAt
    steps.push({
      title,
      status: 'failed',
      startedAt: new Date(startedAt).toISOString(),
      endedAt: nowIso(),
      durationMs,
      errorMessage: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

const writeReport = (status) => {
  fs.mkdirSync(runtimeRoot, { recursive: true })
  fs.writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        generatedAt: nowIso(),
        status,
        steps,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  log(`[quality-all] 报告已写入：${reportPath}`)
}

const main = async () => {
  await runStep('单元功能测试套件', path.join(projectRoot, 'scripts', 'verify-unit-functional-suite.mjs'))
  await runStep('全部性能测试套件', path.join(projectRoot, 'scripts', 'verify-all-performance-suite.mjs'))
}

try {
  await main()
  writeReport('passed')
  log('\n[quality-all] 单元功能 + 全部性能 已全部通过')
} catch (error) {
  writeReport('failed')
  // eslint-disable-next-line no-console
  console.error('\n[quality-all] 质量总控套件失败，已在报告中定位到首个阻断步骤：', error)
  process.exit(1)
}
