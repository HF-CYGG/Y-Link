/** 仅在无 .env/data/uploads 的隔离源码副本运行；真实 HTTP 覆盖生产入口桶、在途与削峰。 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const isWorker = process.argv.includes('--route-alias-worker')
const runtime = isWorker
  ? process.env.YLINK_ROUTE_ALIAS_TEST_RUNTIME!
  : fs.mkdtempSync(path.join(os.tmpdir(), 'ylink-route-alias-'))
assert.ok(runtime && path.isAbsolute(runtime), '测试运行目录必须是绝对路径')
const previousCwd = process.cwd()
for (const key of Object.keys(process.env)) {
  if (key.startsWith('YLINK_') || key.startsWith('REDIS_') || key.startsWith('DB_') || key.startsWith('Y_LINK_')) delete process.env[key]
}
Object.assign(process.env, {
  NODE_ENV: 'test', DB_TYPE: 'sqlite', DB_SYNC: 'false',
  SQLITE_DB_PATH: path.join(runtime, 'unused.sqlite'), Y_LINK_DATA_DIR: runtime,
  Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE: 'true', YLINK_ANONYMOUS_AUTH_MAX_IN_FLIGHT: '4',
})
delete process.env.ENV_FILE
if (isWorker) process.chdir(runtime)

const variants = (p: string) => [p, p.toUpperCase(), `${p}/`, `${p.toUpperCase()}/`]
const web = [
  '/api/auth/captcha', '/api/auth/login', '/api/auth/login/mfa',
  '/api/auth/login/mfa/webauthn/options', '/api/auth/login/mfa/webauthn/verify',
  '/api/auth/webauthn/login/options', '/api/auth/webauthn/login/verify',
  '/api/client-auth/captcha', '/api/client-auth/capabilities', '/api/client-auth/login',
  '/api/client-auth/register', '/api/client-auth/verification-code/send',
  '/api/client-auth/forgot-password/verify', '/api/client-auth/forgot-password/reset',
]
const mobile = ['/captcha', '/capabilities', '/verification-code', '/register', '/login',
  '/forgot-password/verify', '/forgot-password/reset'].map((p) => `/api/v1/mobile-auth${p}`)

async function main() {
  const { createApp } = await import('../src/app.js')
  const { overloadMonitor, classifyOverloadShed } = await import('../src/middleware/overload-shedding.middleware.js')
  const { listConcurrencyGateSnapshots } = await import('../src/utils/bounded-concurrency.js')
  const { staticPathKey } = await import('../src/utils/static-path-key.js')
  for (const [input, expected] of [['/', '/'], ['/LOGIN/', '/login'], ['/login//', '/login/'],
    ['/a%2Fb', '/a%2fb'], ['/a/../B', '/a/../b'], ['/Ä', '/Ä']]) {
    assert.equal(staticPathKey(input!), expected)
  }
  const server = createApp({ publicAuthRateLimits: { admin: 4, client: 1 } }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const call = async (p: string, method = 'POST') => {
    const response = await fetch(base + p, {
      method, headers: { 'content-type': 'application/json' },
      body: method === 'GET' || method === 'HEAD' ? undefined : '{}',
      signal: AbortSignal.timeout(5000),
    })
    const text = await response.text()
    return { status: response.status, headers: response.headers, text }
  }
  const held: Array<{ request: http.ClientRequest; completed: Promise<number>; closed: Promise<void> }> = []
  try {
    assert.equal((await call('/api/auth/webauthn/capabilities', 'GET')).status, 200, '正常公开能力入口保持可用')
    // 使用生产允许的最小上限 4；四个未完成请求阻塞在真实 JSON parser，占满共享闸门。
    // 管理端入口配额也设为 4，确保四个占槽请求都能进入 parser，不被限流提前释放。
    for (let index = 0; index < 4; index += 1) {
      const request = http.request(base + '/api/auth/login', { method: 'POST', headers: {
        'Content-Type': 'application/json', 'Content-Length': '100',
      } })
      const closed = new Promise<void>((resolve) => request.once('close', resolve))
      const completed = new Promise<number>((resolve) => {
        request.once('error', () => resolve(-1))
        request.once('response', (response) => {
          response.once('end', () => resolve(response.statusCode ?? -1))
          response.once('error', () => resolve(-1))
          response.once('aborted', () => resolve(-1))
          response.resume()
        })
        // 失败清理时连接可能在收到响应前关闭，也必须收齐完成状态。
        request.once('close', () => resolve(-1))
      })
      held.push({ request, completed, closed })
      request.write('{')
    }
    const deadline = Date.now() + 5000
    while (!listConcurrencyGateSnapshots().some((g) => g.name === 'anonymous-auth-in-flight' && g.active === 4)) {
      assert.ok(Date.now() < deadline, '四个占槽请求必须全部进入真实闸门')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    for (const p of web) for (const alias of variants(p)) for (const query of ['', '?probe=1']) {
      const result = await call(alias + query)
      assert.equal(result.status, 503, `在途保护 ${alias}${query}: ${result.text}`)
      assert.ok(result.headers.get('retry-after'))
      if (p.endsWith('/captcha')) assert.equal((await call(alias + query, 'GET')).status, 503)
    }
    assert.notEqual((await call('/api/v1/mobile-auth/login')).status, 503, 'Mobile 保持无 Web 在途闸门')
    for (const p of ['/api/auth/unknown', '/api/auth/login//', '/api/auth/%6cogin', '/api/auth/login/extra']) {
      assert.notEqual((await call(p)).status, 503, `未知路径不应占用闸门 ${p}`)
    }
    // 补齐声明的 100 字节 JSON，使占槽请求正常完成并读尽响应，不遗留悬挂连接。
    for (const { request } of held) request.end('}' + ' '.repeat(98))
    assert.deepEqual(await Promise.all(held.map(({ completed }) => completed)), [400, 400, 400, 400],
      '四个占槽请求均须完成正文解析并进入真实入参校验')
    await Promise.all(held.map(({ closed }) => closed))
    const releaseDeadline = Date.now() + 5000
    while (listConcurrencyGateSnapshots().some((g) => g.name === 'anonymous-auth-in-flight' && g.active !== 0)) {
      assert.ok(Date.now() < releaseDeadline, '关闭请求必须释放槽位')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    // 四个占槽请求已消耗管理端的四次配额；客户端用无效 schema 消耗一次配额。
    assert.equal((await call('/api/client-auth/login')).status, 400)
    for (const p of web) for (const alias of variants(p)) for (const query of ['', '?probe=1']) {
      assert.equal((await call(alias + query)).status, 429, `同桶限流 ${alias}${query}`)
    }
    // Mobile 仍采用生产 180 次阈值；先前合法控制已消耗一次。
    for (let index = 1; index < 180; index += 1) assert.equal((await call('/api/v1/mobile-auth/login')).status, 400)
    for (const p of mobile) for (const alias of variants(p)) for (const query of ['', '?probe=1']) {
      const result = await call(alias + query)
      assert.equal(result.status, 429, `Mobile 同桶 ${alias}${query}`)
      assert.equal(JSON.parse(result.text).code, 42900)
    }
    const originalGetLevel = overloadMonitor.getLevel
    try {
      for (const level of ['elevated', 'critical'] as const) {
        overloadMonitor.getLevel = () => level
        for (const p of web) for (const alias of variants(p)) for (const query of ['', '?probe=1']) {
          // POST 是原绕过路径；GET captcha 在 critical 时同样应属于 anonymousAuth。
          const method = p.endsWith('/captcha') ? 'GET' : 'POST'
          assert.equal(classifyOverloadShed(method, alias, level), 'anonymousAuth')
          const result = await call(alias + query, method)
          assert.equal(result.status, 503, `削峰 ${level} ${alias}`)
          assert.equal(JSON.parse(result.text).data.reason, 'SERVER_OVERLOADED')
          assert.equal(result.headers.get('retry-after'), '5')
        }
        for (const p of mobile) for (const alias of variants(p)) {
          assert.equal(classifyOverloadShed('POST', alias, level), null)
          assert.equal((await call(alias)).status, 429, 'Mobile 豁免削峰并保留入口桶')
        }
        for (const p of ['/api/auth/me', '/api/client-auth/me', '/api/database-rescue/status', '/health']) {
          for (const alias of variants(p)) assert.equal(classifyOverloadShed('GET', alias, level), null)
        }
        assert.equal(classifyOverloadShed('POST', '/api/orders', level), null)
        assert.notEqual((await call('/health', 'GET')).status, 503)
        assert.notEqual((await call('/api/auth/unknown')).status, 503)
        assert.equal(classifyOverloadShed('GET', '/api/unknown', level), level === 'critical' ? 'read' : null)
      }
    } finally { overloadMonitor.getLevel = originalGetLevel }
  } finally {
    for (const { request } of held) request.destroy()
    server.closeAllConnections()
    await Promise.all(held.map(({ completed }) => completed))
    await Promise.all(held.map(({ closed }) => closed))
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
if (isWorker) {
  try { await main() } finally { process.chdir(previousCwd) }
} else {
  // Windows 下应用加载后可能仍持有运行目录句柄；HTTP 关闭不等于进程资源全部释放。
  // 父进程从不进入运行目录，等待测试进程完全退出后再删除；删除失败仍使脚本失败。
  let failure: unknown
  try {
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), '--route-alias-worker'], {
      cwd: previousCwd,
      env: { ...process.env, YLINK_ROUTE_ALIAS_TEST_RUNTIME: runtime },
      windowsHide: true,
      stdio: 'inherit',
    })
    const [code, signal] = await once(child, 'close')
    assert.equal(code, 0, `HTTP 测试子进程失败：exit=${code}, signal=${signal}`)
  } catch (error) { failure = error }
  try {
    assert.equal(path.dirname(path.resolve(runtime)), path.resolve(os.tmpdir()), '拒绝清理临时根目录以外的路径')
    await fs.promises.rm(runtime, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], 'HTTP 验证及临时目录清理失败') : error
  }
  if (failure) throw failure
  console.log('OK 真实 HTTP 路径别名、查询参数、同桶限流、在途、削峰与 Mobile 控制；子进程退出及目录清理完成')
}
