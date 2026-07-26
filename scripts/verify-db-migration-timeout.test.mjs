/**
 * 模块说明：scripts/verify-db-migration-timeout.test.mjs
 * 文件职责：回归验证数据库迁移验收脚本的子进程超时、错误分类与超时清理行为。
 * 实现逻辑：
 * - 从正式验收脚本加载当前 runProcess 实现，避免复制一份可能漂移的测试替身；
 * - 启动一个会延迟写入标记文件的真实 Node 子进程，并设置极短的测试超时；
 * - 断言调用及时返回 PROCESS_TIMEOUT，且被终止的子进程不会继续写入标记文件。
 * 维护说明：
 * - 本测试只使用 Node 内置模块，不依赖 Docker，也不得把生产 Compose 长任务套入短超时。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const currentFile = fileURLToPath(import.meta.url)
const scriptsDirectory = path.dirname(currentFile)
const projectRoot = path.resolve(scriptsDirectory, '..')
const migrationVerifierPath = path.join(scriptsDirectory, 'verify-db-migration.mjs')

const loadRunProcess = async () => {
  const source = readFileSync(migrationVerifierPath, 'utf8')
  const implementationStart = source.indexOf('class VerificationError')
  const implementationEnd = source.indexOf('const verifyDockerPrerequisites')

  assert.ok(implementationStart >= 0, '未找到 VerificationError，无法加载正式 runProcess 实现')
  assert.ok(implementationEnd > implementationStart, '未找到 verifyDockerPrerequisites，无法界定 runProcess 实现')

  const harness = [
    "import { spawn } from 'node:child_process'",
    `const projectRoot = ${JSON.stringify(projectRoot)}`,
    source.slice(implementationStart, implementationEnd),
    'export { runProcess }',
  ].join('\n')

  return await import(`data:text/javascript;base64,${Buffer.from(harness).toString('base64')}`)
}

const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'ylink-db-migration-timeout-'))
const lateMarkerPath = path.join(temporaryDirectory, 'late-marker.txt')

try {
  const { runProcess } = await loadRunProcess()
  const childScript = [
    "const fs = require('node:fs')",
    `setTimeout(() => fs.writeFileSync(${JSON.stringify(lateMarkerPath)}, 'late'), 450)`,
    'setTimeout(() => process.exit(0), 800)',
  ].join(';')
  const startedAt = Date.now()
  const result = await runProcess(process.execPath, ['-e', childScript], {
    allowFailure: true,
    capture: true,
    label: 'runProcess 超时回归子进程',
    timeoutMs: 100,
  })
  const elapsedMs = Date.now() - startedAt

  await new Promise((resolve) => setTimeout(resolve, 500))

  assert.equal(result.code, null, '超时子进程不应被误报为正常退出')
  assert.equal(result.error?.code, 'PROCESS_TIMEOUT', '超时错误必须具有稳定的 PROCESS_TIMEOUT 分类')
  assert.equal(result.error?.timeoutMs, 100, '超时错误必须保留实际 timeoutMs')
  assert.match(result.error?.message ?? '', /超时/, '超时错误应提供明确中文提示')
  assert.ok(elapsedMs < 500, `runProcess 未在截止时间附近返回，实际耗时 ${elapsedMs}ms`)
  assert.equal(existsSync(lateMarkerPath), false, '超时后子进程仍继续运行并写入了标记文件')

  console.log(`[verify:db:migration:timeout] PASS elapsed=${elapsedMs}ms`)
} finally {
  rmSync(temporaryDirectory, {
    force: true,
    recursive: true,
  })
}
