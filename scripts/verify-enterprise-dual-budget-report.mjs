/**
 * 文件说明：scripts/verify-enterprise-dual-budget-report.mjs
 * 文件职责：聚合 Y-Link 的构建预算与运行时预算，形成统一“双预算”报告并作为 `verify:performance` 的最终验收出口。
 * 实现逻辑：
 * 1. 读取构建预算、管理端运行时预算、客户端并发报告与客户端五场景报告；
 * 2. 将“构建预算”定义为第一预算维度，将“关键链路运行时预算”定义为第二预算维度；
 * 3. 汇总状态、阈值、明细与报告路径，输出 `.local-dev/enterprise-performance-dual-budget-report.json`；
 * 4. 若任一预算维度失败，则直接退出非零状态，阻止性能回归被误判为通过。
 */

import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const runtimeRoot = path.join(projectRoot, '.local-dev')

const buildBudgetReportPath = path.join(runtimeRoot, 'enterprise-performance-budget-report.json')
const adminRuntimeBudgetReportPath = path.join(runtimeRoot, 'enterprise-core-path-runtime-budget-report.json')
const clientConcurrencyReportPath = path.join(runtimeRoot, 'client-concurrency-performance.report.json')
const clientCoreFlowReportPath = path.join(runtimeRoot, 'client-core-flow-task6.report.json')
const dualBudgetReportPath = path.join(runtimeRoot, 'enterprise-performance-dual-budget-report.json')

const readJson = (filePath) => {
  assert.ok(fs.existsSync(filePath), `缺少性能报告：${filePath}`)
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

const ensureScenarioBudgetPassed = (scenarioResults = []) => {
  return scenarioResults.every((scenario) =>
    Object.values(scenario.validation ?? {}).every((value) => value === true),
  )
}

const buildDualBudgetReport = () => {
  const buildBudgetReport = readJson(buildBudgetReportPath)
  const adminRuntimeBudgetReport = readJson(adminRuntimeBudgetReportPath)
  const clientConcurrencyReport = readJson(clientConcurrencyReportPath)
  const clientCoreFlowReport = readJson(clientCoreFlowReportPath)

  const buildBudgetStatus = buildBudgetReport.status === 'passed'
  const adminRuntimeStatus =
    adminRuntimeBudgetReport.status === 'passed' && adminRuntimeBudgetReport.runtimeBudgetSummary?.status === 'passed'
  const clientConcurrencyStatus = clientConcurrencyReport.status === 'passed'
  const clientCoreFlowStatus =
    clientCoreFlowReport.status === 'passed' && ensureScenarioBudgetPassed(clientCoreFlowReport.scenarioResults)

  const report = {
    generatedAt: new Date().toISOString(),
    status: buildBudgetStatus && adminRuntimeStatus && clientConcurrencyStatus && clientCoreFlowStatus ? 'passed' : 'failed',
    reportType: 'dual-budget',
    dualBudget: {
      buildBudget: {
        status: buildBudgetStatus ? 'passed' : 'failed',
        reportPath: buildBudgetReportPath,
        totalAssetsKB: buildBudgetReport.totalAssetsKB,
        totalAssetsMaxKB: buildBudgetReport.performanceBudget?.totalAssetsMaxKB ?? null,
        criticalAssetsKB: buildBudgetReport.criticalAssetsKB,
        criticalAssetsMaxKB: buildBudgetReport.performanceBudget?.criticalAssetsMaxKB ?? null,
        routeChunkChecks: buildBudgetReport.routeChunkChecks ?? [],
        lowFrequencyChunks: buildBudgetReport.lowFrequencyChunks ?? [],
      },
      runtimeBudget: {
        status: adminRuntimeStatus && clientConcurrencyStatus && clientCoreFlowStatus ? 'passed' : 'failed',
        adminCorePath: {
          status: adminRuntimeStatus ? 'passed' : 'failed',
          reportPath: adminRuntimeBudgetReportPath,
          runtimePerformanceBudget: adminRuntimeBudgetReport.runtimePerformanceBudget ?? null,
          runtimeBudgetSummary: adminRuntimeBudgetReport.runtimeBudgetSummary ?? null,
        },
        clientConcurrency: {
          status: clientConcurrencyStatus ? 'passed' : 'failed',
          reportPath: clientConcurrencyReportPath,
          acceptanceThresholdFor20Users: clientConcurrencyReport.acceptanceThresholdFor20Users ?? null,
          checkCount: clientConcurrencyReport.checks?.length ?? 0,
        },
        clientCoreFlow: {
          status: clientCoreFlowStatus ? 'passed' : 'failed',
          reportPath: clientCoreFlowReportPath,
          thresholds: clientCoreFlowReport.thresholds ?? null,
          scenarioCount: clientCoreFlowReport.scenarioResults?.length ?? 0,
          scenarioResults: clientCoreFlowReport.scenarioResults ?? [],
        },
      },
    },
  }

  return report
}

try {
  const report = buildDualBudgetReport()
  fs.mkdirSync(runtimeRoot, { recursive: true })
  fs.writeFileSync(dualBudgetReportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  if (report.status !== 'passed') {
    throw new Error('性能双预算校验失败，请检查构建预算、管理端运行时预算、客户端并发报告或客户端五场景报告。')
  }

  // eslint-disable-next-line no-console
  console.log('[dual-budget] 性能双预算报告已生成并通过')
  // eslint-disable-next-line no-console
  console.log(`- 构建预算报告：${buildBudgetReportPath}`)
  // eslint-disable-next-line no-console
  console.log(`- 管理端运行时预算报告：${adminRuntimeBudgetReportPath}`)
  // eslint-disable-next-line no-console
  console.log(`- 客户端并发报告：${clientConcurrencyReportPath}`)
  // eslint-disable-next-line no-console
  console.log(`- 客户端五场景报告：${clientCoreFlowReportPath}`)
  // eslint-disable-next-line no-console
  console.log(`- 双预算报告：${dualBudgetReportPath}`)
} catch (error) {
  // eslint-disable-next-line no-console
  console.error('[dual-budget] 性能双预算校验失败：', error)
  process.exit(1)
}
