/** 真实子进程验证：业务数据库不可达/控制文件损坏时仍有受限 HTTP，不生成业务库。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}
for (const scenario of ['database_unavailable', 'marker_corrupted', 'override_corrupted']) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ylink-rescue-startup-'))
  const port = await freePort()
  const runtime = path.join(directory, 'runtime')
  fs.mkdirSync(runtime, { recursive: true })
  if (scenario === 'marker_corrupted') fs.writeFileSync(path.join(runtime, 'database-migration-cutover.json'), '{')
  if (scenario === 'override_corrupted') fs.writeFileSync(path.join(runtime, 'database-runtime-override.json'), '{')
  const sourcePath = path.join(directory, 'must-not-bootstrap.sqlite')
  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, APP_PROFILE: 'verify-rescue-startup', ENV_FILE: '', Y_LINK_DATA_DIR: directory, PORT: String(port),
      DB_TYPE: 'mysql', DB_HOST: '127.0.0.1', DB_PORT: '1', DB_USER: 'isolated_test', DB_PASSWORD: 'test-only',
      DB_NAME: 'unreachable', DB_CONNECT_TIMEOUT_MS: '250', SQLITE_DB_PATH: sourcePath,
      Y_LINK_TRUST_PROXY: '', Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE: 'false', ALIYUN_DYPNS_MNS_ENABLED: 'false', NO_COLOR: '1' },
  })
  let output = ''
  child.stdout.on('data', (part) => { output += String(part) })
  child.stderr.on('data', (part) => { output += String(part) })
  try {
    const deadline = Date.now() + 15_000
    let health: Response | null = null
    while (Date.now() < deadline) {
      try { health = await fetch(`http://127.0.0.1:${port}/health`); break } catch { /* 等待独立控制面监听 */ }
      if (child.exitCode !== null) assert.fail(`${scenario} 子进程提前退出: ${output.slice(-1000)}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.ok(health, `${scenario} 救援未监听: ${output.slice(-1000)}`)
    assert.equal(health.status, 503)
    const state = await health.json() as { status: string; code: string }
    assert.equal(state.status, 'RESCUE')
    assert.match(state.code, /^[A-Z_]+$/)
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/auth/captcha`)).status, 503)
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/database-rescue/status`)).status, 401)
    assert.equal(fs.existsSync(sourcePath), false, '救援不得生成 SQLite / bootstrap')
    assert.equal(output.includes('test-only'), false, '启动错误不得泄露连接密码')
    console.log(`[database-rescue-startup] ${scenario} 通过`)
  } finally {
    child.kill('SIGTERM')
    await new Promise<void>((resolve) => { if (child.exitCode !== null) resolve(); else child.once('exit', () => resolve()) })
  }
}
