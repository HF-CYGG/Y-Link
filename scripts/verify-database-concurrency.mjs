import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolveTsxCliPath } from './process-runner-utils.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const backendRoot = path.join(projectRoot, 'backend')
const runtimeRoot = path.join(projectRoot, '.local-dev')
const concurrencyRoot = path.join(runtimeRoot, 'db-concurrency')
const reportPath = path.join(runtimeRoot, 'database-concurrency.report.json')
const targetScriptPath = path.join(backendRoot, 'scripts', 'database-concurrency-target-verify.ts')
const tsxCliPath = resolveTsxCliPath(backendRoot)

const runId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const targets = ['sqlite', 'mysql']

const runTarget = (target) =>
  new Promise((resolve) => {
    const targetReportPath = path.join(concurrencyRoot, `${target}-${runId}.report.json`)
    const child = spawn(process.execPath, [tsxCliPath, targetScriptPath], {
      cwd: backendRoot,
      env: {
        ...process.env,
        Y_LINK_DB_CONCURRENCY_RUN_ID: runId,
        Y_LINK_DB_CONCURRENCY_TARGET: target,
        Y_LINK_DB_CONCURRENCY_REPORT_PATH: targetReportPath,
        Y_LINK_DB_CONCURRENCY_SQLITE_SOURCE:
          process.env.Y_LINK_DB_CONCURRENCY_SQLITE_SOURCE ?? path.join(backendRoot, 'data', 'y-link.sqlite'),
        Y_LINK_DB_CONCURRENCY_SQLITE_PATH: path.join(concurrencyRoot, `${target}-${runId}.sqlite`),
      },
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
    })

    child.on('error', (error) => {
      resolve({
        target,
        status: 'runner_failed',
        errorMessage: error.message,
        reportPath: targetReportPath,
      })
    })

    child.on('exit', (code, signal) => {
      let targetReport = null
      if (fs.existsSync(targetReportPath)) {
        targetReport = JSON.parse(fs.readFileSync(targetReportPath, 'utf8'))
      }

      resolve({
        target,
        exitCode: code,
        signal,
        reportPath: targetReportPath,
        status: targetReport?.status ?? (code === 0 ? 'passed_without_report' : 'failed_without_report'),
        errorMessage: targetReport?.errorMessage ?? null,
        report: targetReport,
      })
    })
  })

const main = async () => {
  fs.mkdirSync(concurrencyRoot, { recursive: true })

  const startedAt = new Date().toISOString()
  const targetResults = []
  for (const target of targets) {
    console.log(`\n[db-concurrency] start target=${target}`)
    const result = await runTarget(target)
    targetResults.push(result)
    console.log(`[db-concurrency] finish target=${target} status=${result.status}`)
  }

  const failedTargets = targetResults.filter((result) =>
    result.status === 'failed'
    || result.status === 'runner_failed'
    || result.status === 'failed_without_report'
    || (typeof result.exitCode === 'number' && result.exitCode !== 0),
  )
  const blockedTargets = targetResults.filter((result) => result.status === 'environment_blocked')
  const status = failedTargets.length > 0 ? 'failed' : 'passed'
  const summary = {
    generatedAt: new Date().toISOString(),
    startedAt,
    runId,
    status,
    reportPath,
    blockedTargets: blockedTargets.map((result) => ({
      target: result.target,
      reason: result.errorMessage ?? result.report?.errorMessage ?? 'environment blocked',
    })),
    failedTargets: failedTargets.map((result) => ({
      target: result.target,
      status: result.status,
      errorMessage: result.errorMessage ?? result.report?.errorMessage ?? null,
      reportPath: result.reportPath,
    })),
    targetResults,
  }

  fs.writeFileSync(reportPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  console.log(`\n[db-concurrency] report written: ${reportPath}`)

  if (failedTargets.length > 0) {
    process.exit(1)
  }
}

await main()
