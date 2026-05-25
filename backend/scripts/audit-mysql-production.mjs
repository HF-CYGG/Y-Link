/**
 * 文件说明：MySQL-only 生产依赖审计脚本。
 * 实现逻辑：
 * - 在 .local-dev 中生成临时 package/lockfile；
 * - 仅移除 SQLite profile 需要的 sqlite3 可选依赖；
 * - 保留 sharp 等其他运行时依赖，再执行 npm audit --omit=dev。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const currentFilePath = fileURLToPath(import.meta.url)
const backendRoot = path.resolve(path.dirname(currentFilePath), '..')
const projectRoot = path.resolve(backendRoot, '..')
const auditRoot = path.join(projectRoot, '.local-dev', 'backend-mysql-production-audit')
const reportPath = path.join(projectRoot, '.local-dev', 'backend-mysql-production-audit.report.json')

const resolveNpmCommand = () => (process.platform === 'win32' ? 'npm.cmd' : 'npm')

const runCommand = async (title, args, options = {}) => {
  return await new Promise((resolve, reject) => {
    const child = spawn(resolveNpmCommand(), args, {
      cwd: auditRoot,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      shell: process.platform === 'win32',
      windowsHide: true,
    })

    const stdout = []
    const stderr = []
    if (options.capture) {
      child.stdout?.on('data', (chunk) => stdout.push(chunk))
      child.stderr?.on('data', (chunk) => stderr.push(chunk))
    }

    child.once('error', reject)
    child.once('exit', (code) => {
      const result = {
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }
      if (code === 0 || options.allowFailure) {
        resolve(result)
        return
      }
      reject(new Error(`${title} failed with exit code ${code}`))
    })
  })
}

const prepareAuditPackage = async () => {
  await fs.rm(auditRoot, { recursive: true, force: true })
  await fs.mkdir(auditRoot, { recursive: true })

  const packageJson = JSON.parse(await fs.readFile(path.join(backendRoot, 'package.json'), 'utf8'))
  if (packageJson.optionalDependencies) {
    delete packageJson.optionalDependencies.sqlite3
    if (Object.keys(packageJson.optionalDependencies).length === 0) {
      delete packageJson.optionalDependencies
    }
  }

  await fs.writeFile(path.join(auditRoot, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8')
}

const main = async () => {
  await prepareAuditPackage()
  await runCommand('refresh mysql-only package-lock', [
    'install',
    '--package-lock-only',
    '--ignore-scripts',
    '--registry=https://registry.npmjs.org',
  ])

  const auditResult = await runCommand(
    'audit mysql-only production dependencies',
    ['audit', '--omit=dev', '--registry=https://registry.npmjs.org', '--json'],
    { capture: true, allowFailure: true },
  )

  await fs.writeFile(reportPath, auditResult.stdout || auditResult.stderr, 'utf8')
  if (auditResult.stdout) {
    process.stdout.write(auditResult.stdout)
  }
  if (auditResult.stderr) {
    process.stderr.write(auditResult.stderr)
  }

  if (auditResult.code !== 0) {
    process.exit(auditResult.code ?? 1)
  }
}

await main()
