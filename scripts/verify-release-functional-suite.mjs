/**
 * 文件说明：scripts/verify-release-functional-suite.mjs
 * 文件职责：聚合执行发布前功能回归，覆盖前端构建、后端构建、后端 HTTP 全链路回归与 onebox 静态烟雾验证。
 * 实现逻辑：严格串行执行各步骤、失败即停，并生成发布前功能回归报告，便于发版前定位阻断项。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveNpmCommand, runCommand } from './process-runner-utils.mjs'

const currentFilePath = fileURLToPath(import.meta.url)
const scriptsRoot = path.dirname(currentFilePath)
const projectRoot = path.resolve(scriptsRoot, '..')
const backendRoot = path.resolve(projectRoot, 'backend')
const runtimeRoot = path.resolve(projectRoot, '.local-dev')
const reportPath = path.resolve(runtimeRoot, 'verify-release-functional-suite.report.json')

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
  log(`[release-functional] 报告已写入：${reportPath}`)
}

const runStep = async ({ title, command, args, cwd }) => {
  const startedAt = Date.now()
  log(`\n[release-functional] 开始：${title}`)

  try {
    await runCommand({
      title,
      command,
      args,
      cwd,
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
    log(`[release-functional] 通过：${title}（${durationMs}ms）`)
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

const runNodeScript = async (title, scriptPath, cwd = projectRoot) => {
  await runStep({
    title,
    command: process.execPath,
    args: [scriptPath],
    cwd,
  })
}

const runNpmScript = async (title, scriptName, cwd) => {
  const npmCommand = resolveNpmCommand()
  await runStep({
    title,
    command: npmCommand.command,
    args: [...npmCommand.prefixArgs, 'run', scriptName],
    cwd,
  })
}

const main = async () => {
  /**
   * 发布前先做前端构建：
   * - 同时校验管理端与客户端页面依赖、路由分包和构建产物是否完整；
   * - 也为后续 onebox 静态烟雾验证准备 dist 产物。
   */
  await runNodeScript('前端构建', path.resolve(projectRoot, 'scripts', 'run-frontend-build.mjs'))

  /**
   * 后端先做类型与产物构建门禁：
   * - 避免仅运行 tsx 验收脚本而遗漏正式 dist 构建失败；
   * - 发布前必须同时保证源码与构建产物都可用。
   */
  await runNpmScript('后端类型校验', 'check', backendRoot)
  await runNpmScript('后端构建', 'build', backendRoot)

  /**
   * 后端全功能回归覆盖：
   * - 管理端登录、商品管理、订单核销；
   * - 客户端注册、登录、商城、下单；
   * - 上传接口与上传后静态访问。
   */
  await runNpmScript('后端发布前全功能回归', 'release:verify', backendRoot)

  /**
   * onebox 烟雾验证补齐前端静态入口与单端口代理链路：
   * - 验证前端 dist 可被静态托管；
   * - 验证首页、健康检查与 API 反代在一体化部署形态下仍可用。
   */
  await runNpmScript('onebox 本地静态烟雾验证', 'verify:onebox:smoke', projectRoot)
}

try {
  await main()
  writeReport('passed')
  log('\n[release-functional] 发布前功能回归全部通过')
} catch (error) {
  writeReport('failed')
  console.error('\n[release-functional] 发布前功能回归失败：', error)
  process.exit(1)
}
