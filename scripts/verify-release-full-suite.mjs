/**
 * 文件说明：scripts/verify-release-full-suite.mjs
 * 文件职责：提供正式发布前总控入口，在功能回归基础上追加强制性能验证。
 * 实现逻辑：先执行发布前功能回归，再执行项目全局规范要求的性能验证，最终写入总控报告。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCommand } from './process-runner-utils.mjs'

const currentFilePath = fileURLToPath(import.meta.url)
const scriptsRoot = path.dirname(currentFilePath)
const projectRoot = path.resolve(scriptsRoot, '..')
const runtimeRoot = path.resolve(projectRoot, '.local-dev')
const reportPath = path.resolve(runtimeRoot, 'verify-release-full-suite.report.json')

const steps = []

const log = (message) => {
  console.log(message)
}

const nowIso = () => new Date().toISOString()

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
  log(`[release-full] 报告已写入：${reportPath}`)
}

const runStep = async (title, scriptPath) => {
  const startedAt = Date.now()
  log(`\n[release-full] 开始：${title}`)

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
    log(`[release-full] 通过：${title}（${durationMs}ms）`)
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

const main = async () => {
  await runStep('发布前功能回归', path.resolve(projectRoot, 'scripts', 'verify-release-functional-suite.mjs'))
  await runStep('发布前性能验证', path.resolve(projectRoot, 'scripts', 'verify-enterprise-performance-suite.mjs'))
}

try {
  await main()
  writeReport('passed')
  log('\n[release-full] 发布前全量回归全部通过')
} catch (error) {
  writeReport('failed')
  console.error('\n[release-full] 发布前全量回归失败：', error)
  process.exit(1)
}
