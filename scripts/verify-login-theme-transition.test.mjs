/** 登录页浏览器回归脚本的启动失败清理验证；仅使用本地隔离临时目录。 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(new URL('./verify-login-theme-transition.mjs', import.meta.url))
const projectRoot = fileURLToPath(new URL('../', import.meta.url))

test('Chrome 启动错误正常退出并清理本次临时 profile', async () => {
  const sandboxPrefix = resolve(tmpdir(), 'ylink-login-startup-test-')
  const sandboxRoot = await mkdtemp(sandboxPrefix)
  try {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(?:temp|tmp|tmpdir)$/iu.test(key)),
    )
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: projectRoot,
      env: { ...env, CHROME_PATH: join(sandboxRoot, 'missing-chrome.exe'), TEMP: sandboxRoot, TMP: sandboxRoot, TMPDIR: sandboxRoot },
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    })

    assert.equal(result.error, undefined, '验证子进程应在超时前退出')
    assert.equal(result.status, 1, '浏览器启动失败应返回非零状态')
    assert.match(result.stderr, /ENOENT/u, '失败应来自 Chrome 路径不存在，而非运行环境前置检查')
    assert.deepEqual(await readdir(sandboxRoot), [], '脚本应清理本次创建的临时 profile')
    assert.doesNotMatch(result.stderr, /Unhandled 'error' event/u, 'Chrome error 事件不应成为未处理异常')
  } finally {
    const safeSandbox = resolve(sandboxRoot)
    assert.ok(safeSandbox.startsWith(resolve(tmpdir()) + sep) && safeSandbox.startsWith(sandboxPrefix) && safeSandbox !== sandboxPrefix)
    await rm(safeSandbox, { recursive: true, force: true })
  }
})
