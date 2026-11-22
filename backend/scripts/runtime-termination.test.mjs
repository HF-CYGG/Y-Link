/** 定向生命周期回归；只运行独占合成子进程，不启动真实服务/数据库或发送OS信号。 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
for (const scenario of ['normal-failure', 'sigterm', 'sigint', 'cleanup-failure-signal', 'late-signal', 'restart75']) {
  test('启动失败清理收口：' + scenario, () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/runtime-termination-synthetic.mjs', import.meta.url)), scenario],
      { encoding: 'utf8', windowsHide: true, timeout: 15_000, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', ENV_FILE: '' } })
    assert.equal(result.error, undefined, result.stderr)
    assert.equal(result.signal, null)
    assert.equal(result.status, scenario === 'restart75' ? 75 : 0, result.stderr)
    const report = JSON.parse(result.stdout.trim())
    assert.equal(report.events.filter(value => value === 'cleanup-blocked').length, 1)
    assert.equal(report.events.includes('rescue-started'), scenario === 'normal-failure')
    if (scenario !== 'normal-failure') assert.ok(report.events.includes('exit:' + (scenario === 'restart75' ? 75 : 0)))
    assert.equal(report.realApp, false)
    assert.equal(report.realDatabase, false)
    assert.equal(report.realHttp, false)
  })
}
