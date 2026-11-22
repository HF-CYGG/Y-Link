/**
 * 文件职责：验证安全出站客户端的 DNS 回调契约、地址族选择和重定向安全边界。
 * 实现逻辑：仅替换 DNS 与 HTTP/HTTPS 传输边界，执行真实客户端逻辑；不连接数据库或外部服务。
 * 维护说明：测试串行运行并自动恢复模拟，禁止使用真实 Webhook 或放宽生产网络校验。
 */
import assert from 'node:assert/strict'
import { promises as dns, type LookupAddress, type LookupOptions } from 'node:dns'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import http, { type IncomingMessage, type RequestOptions } from 'node:http'
import https from 'node:https'
import { type LookupFunction } from 'node:net'
import { PassThrough } from 'node:stream'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { test, type TestContext } from 'node:test'
import { assertSafeOutboundUrl, isPublicNetworkAddress, safeHttpRequest, readOutboundRedirectPolicy } from '../src/utils/safe-http-request.js'
import { detectUnsafeHost } from '../src/utils/safe-network.js'

const ipv4: LookupAddress = { address: '8.8.8.8', family: 4 }
const ipv6: LookupAddress = { address: '2606:4700:4700::1111', family: 6 }
const privateV6: LookupAddress = { address: 'fd00::1', family: 6 }

await test('URL 与 DNS 统一拒绝特殊用途地址的等价表示', () => {
  for (const address of [
    '64:ff9b::0808:0808', '0064:ff9b:0001::1', '0:0:0:0:ffff:0:0808:0808',
    '2002::1', '2001:0000::1', '0100::1', '100:0:0:1::1', '2001:0db8::1',
    '3fff::1', 'ff00::1', '0:0:0:0:0:ffff:c000:0201', '0:0:0:0:0:0:c000:0201',
  ]) {
    assert.equal(detectUnsafeHost(address), 'reserved', address)
    assert.equal(isPublicNetworkAddress(address), false, address)
    assert.throws(() => assertSafeOutboundUrl('https://[' + address + ']/'), /内网或保留地址/)
  }
  for (const address of [ipv6.address, '::ffff:8.8.8.8']) {
    assert.equal(detectUnsafeHost(address), null, address)
    assert.equal(isPublicNetworkAddress(address), true, address)
    assert.doesNotThrow(() => assertSafeOutboundUrl('https://[' + address + ']/'))
  }
})

async function captureLookup(t: TestContext, protocol = 'https:') {
  let lookup: LookupFunction | undefined
  const sentinel = new Error('仅截取请求，不建立连接')
  const outgoing = Object.assign(new EventEmitter(), { write: () => true, end: () => {}, destroy: () => outgoing })
  t.mock.method(protocol === 'https:' ? https : http, 'request', (options: RequestOptions) => {
    assert.equal(options.agent, false, '不得复用全局连接池跳过逐跳 DNS 校验')
    lookup = options.lookup
    return outgoing
  })
  // lookup 必须在请求尚未结束时验证；结束后的迟到 DNS 现在应被拒绝，不能再复用旧 lookup。
  const pending = assert.rejects(safeHttpRequest(`${protocol}//outbound.example/test`), (error) => error === sentinel)
  t.after(async () => { outgoing.emit('error', sentinel); await pending })
  assert.ok(lookup, '请求必须装配安全 lookup')
  return lookup
}

async function resolveWith(lookup: LookupFunction, options: LookupOptions) {
  let calls = 0
  const args = await new Promise<Parameters<Parameters<LookupFunction>[2]>>((resolve) => {
    lookup('outbound.example', options, (...values) => {
      calls += 1
      resolve(values)
    })
  })
  await nextTurn()
  assert.equal(calls, 1, '成功和失败都只能回调一次')
  return args
}

type LookupCase = {
  name: string
  addresses: LookupAddress[]
  options: LookupOptions
  expected?: LookupAddress[]
  errorCode?: string
}

const cases: LookupCase[] = [
  { name: '双栈中的 IPv6 过渡地址拦截全部解析结果', addresses: [ipv4, { address: '0064:ff9b:0001::1', family: 6 }],
    options: { all: true, family: 4 }, errorCode: 'EACCES' },
  { name: '双栈数组保持解析顺序', addresses: [ipv6, ipv4], options: { all: true }, expected: [ipv6, ipv4] },
  { name: '单 IPv4 也返回数组', addresses: [ipv4], options: { all: true }, expected: [ipv4] },
  { name: '单 IPv6 也返回数组', addresses: [ipv6], options: { all: true }, expected: [ipv6] },
  { name: '省略 all 返回首个 IPv6', addresses: [ipv6, ipv4], options: {}, expected: [ipv6] },
  { name: 'all false 返回首个 IPv4', addresses: [ipv4, ipv6], options: { all: false }, expected: [ipv4] },
  { name: 'family 0 保留双栈', addresses: [ipv4, ipv6], options: { all: true, family: 0 }, expected: [ipv4, ipv6] },
  { name: '数组限定 IPv4', addresses: [ipv6, ipv4], options: { all: true, family: 4 }, expected: [ipv4] },
  { name: '数组限定 IPv6', addresses: [ipv4, ipv6], options: { all: true, family: 6 }, expected: [ipv6] },
  { name: '单地址限定 IPv6', addresses: [ipv4, ipv6], options: { family: 6 }, expected: [ipv6] },
  { name: '单地址限定 IPv4', addresses: [ipv6, ipv4], options: { family: 4 }, expected: [ipv4] },
  { name: 'IPv4 字符串别名', addresses: [ipv6, ipv4], options: { family: 'IPv4' }, expected: [ipv4] },
  { name: 'IPv6 字符串别名', addresses: [ipv4, ipv6], options: { all: true, family: 'IPv6' }, expected: [ipv6] },
  { name: 'IPv6 无匹配不回退 IPv4', addresses: [ipv4], options: { family: 6 }, errorCode: 'ENOTFOUND' },
  { name: 'IPv4 无匹配不返回空数组', addresses: [ipv6], options: { all: true, family: 4 }, errorCode: 'ENOTFOUND' },
  { name: '空解析集合保持拒绝', addresses: [], options: { all: true }, errorCode: 'EACCES' },
  { name: '私网排首整次拒绝', addresses: [privateV6, ipv4], options: {}, errorCode: 'EACCES' },
  { name: '未请求地址族含私网也拒绝', addresses: [ipv4, privateV6], options: { family: 4 }, errorCode: 'EACCES' },
  { name: '公网混合映射回环地址拒绝', addresses: [ipv4, { address: '::ffff:127.0.0.1', family: 6 }], options: { all: true }, errorCode: 'EACCES' },
  { name: '保留 IPv4 地址拒绝', addresses: [ipv4, { address: '192.0.2.1', family: 4 }], options: {}, errorCode: 'EACCES' },
]

for (const item of cases) {
  await test(item.name, { timeout: 2000 }, async (t) => {
    const lookup = await captureLookup(t)
    t.mock.method(dns, 'lookup', async (_hostname: string, options: LookupOptions) => {
      assert.equal(options.all, true, '安全 DNS 查询必须获取完整地址集合')
      assert.ok(options.family === undefined || options.family === 0, '安全 DNS 查询不得预先限制地址族')
      return item.addresses
    })
    const [error, address, family] = await resolveWith(lookup, item.options)
    if (item.errorCode) {
      assert.equal(error?.code, item.errorCode)
      return
    }
    assert.equal(error, null)
    if (item.options.all) {
      assert.deepEqual(address, item.expected, 'all=true 必须返回地址对象数组')
      assert.equal(family, undefined)
    } else {
      assert.equal(address, item.expected![0].address)
      assert.equal(family, item.expected![0].family)
    }
  })
}

await test('HTTP 装配同样保留 DNS 原始错误', { timeout: 2000 }, async (t) => {
  const lookup = await captureLookup(t, 'http:')
  const failure = Object.assign(new Error('模拟 DNS 暂时失败'), { code: 'EAI_AGAIN' })
  t.mock.method(dns, 'lookup', async () => { throw failure })
  const [error] = await resolveWith(lookup, { all: true })
  assert.equal(error, failure)
})

/** 模拟传输层连接前调用 lookup，真实客户端仍负责响应和每次重定向处理。 */
function mockTransport(t: TestContext, redirect: string) {
  const requests: RequestOptions[] = []
  const connectedHosts: string[] = []
  const request = (options: RequestOptions, onResponse: (incoming: IncomingMessage) => void) => {
    requests.push(options)
    const emitter = new EventEmitter()
    const outgoing = Object.assign(emitter, {
      setTimeout: () => outgoing,
      write: () => true,
      destroy: (error: Error) => { emitter.emit('error', error); return outgoing },
      end: () => {
        assert.ok(options.lookup)
        options.lookup(String(options.hostname), { all: true, family: 0 }, (error, addresses) => {
          if (error) { emitter.emit('error', error); return }
          if (!Array.isArray(addresses)) {
            emitter.emit('error', Object.assign(new Error('DNS 数组回调格式错误'), { code: 'ERR_INVALID_IP_ADDRESS' }))
            return
          }
          connectedHosts.push(String(options.hostname))
          const first = connectedHosts.length === 1
          const incoming = Object.assign(new PassThrough(), {
            statusCode: first ? 302 : 200,
            headers: first ? { location: redirect } : {},
          })
          onResponse(incoming as unknown as IncomingMessage)
          incoming.end(first ? '' : '{"code":0}')
        })
      },
    })
    return outgoing
  }
  t.mock.method(http, 'request', request)
  t.mock.method(https, 'request', request)
  return { requests, connectedHosts }
}

await test('跨源重定向重新解析并剥离敏感头', { timeout: 2000 }, async (t) => {
  const { requests, connectedHosts } = mockTransport(t, 'https://second.example/result')
  const resolvedHosts: string[] = []
  t.mock.method(dns, 'lookup', async (hostname: string) => {
    resolvedHosts.push(hostname)
    return [ipv4, ipv6]
  })
  const response = await safeHttpRequest('http://first.example/start', {
    headers: { Authorization: 'test-only', Cookie: 'test-only', 'X-Api-Key': 'test-only', 'X-Secret': 'test-only', Accept: 'application/json' },
  })
  assert.equal(response.statusCode, 200)
  assert.equal(response.body.toString(), '{"code":0}')
  assert.deepEqual(resolvedHosts, ['first.example', 'second.example'])
  assert.deepEqual(connectedHosts, resolvedHosts)
  assert.deepEqual(requests[1].headers, { Accept: 'application/json' })
})

await test('同源重定向后 DNS 变为私网时禁止连接', { timeout: 2000 }, async (t) => {
  const { connectedHosts } = mockTransport(t, '/next')
  let lookups = 0
  t.mock.method(dns, 'lookup', async () => ++lookups === 1 ? [ipv4] : [privateV6])
  await assert.rejects(safeHttpRequest('https://first.example/start'), { code: 'EACCES' })
  assert.equal(lookups, 2, '重定向必须重新执行安全 DNS 解析')
  assert.deepEqual(connectedHosts, ['first.example'])
})

await test('重定向到回环 URL 在解析和连接前拒绝', { timeout: 2000 }, async (t) => {
  const { requests } = mockTransport(t, 'http://127.0.0.1/private')
  t.mock.method(dns, 'lookup', async () => [ipv4])
  await assert.rejects(safeHttpRequest('https://first.example/start'), /内网|保留|本地/)
  assert.equal(requests.length, 1)
})

function redirectEnvironment(t: TestContext, mode = 'compat', origins: string[] = []) {
  const keys = ['Y_LINK_OUTBOUND_REDIRECT_POLICY', 'Y_LINK_OUTBOUND_REDIRECT_ALLOWED_ORIGINS'] as const
  const previous = keys.map(key => process.env[key])
  process.env[keys[0]] = mode
  process.env[keys[1]] = JSON.stringify(origins)
  t.after(() => keys.forEach((key, index) => {
    if (previous[index] === undefined) delete process.env[key]
    else process.env[key] = previous[index]
  }))
}

type MockIncoming = PassThrough & { statusCode: number; headers: Record<string, string>; complete: boolean }
function sequenceTransport(t: TestContext, respond: (incoming: MockIncoming, index: number) => void) {
  const requests: Array<{ options: RequestOptions; body: string; destroyed: boolean }> = []
  const responses: MockIncoming[] = [], connected: string[] = []
  const request = (options: RequestOptions, onResponse: (incoming: IncomingMessage) => void) => {
    const record = { options, body: '', destroyed: false }
    requests.push(record)
    const outgoing = Object.assign(new EventEmitter(), {
      write: (value: string | Buffer) => { record.body += value.toString(); return true },
      destroy: () => { record.destroyed = true; return outgoing },
      end: () => options.lookup!(String(options.hostname), { all: true }, (error) => {
        if (error) { outgoing.emit('error', error); return }
        if (record.destroyed) return
        connected.push(String(options.hostname))
        const incoming = Object.assign(new PassThrough(), { statusCode: 200, headers: {} as Record<string, string>, complete: true })
        responses.push(incoming)
        onResponse(incoming as unknown as IncomingMessage)
        respond(incoming, requests.length - 1)
      }),
    })
    return outgoing
  }
  t.mock.method(http, 'request', request)
  t.mock.method(https, 'request', request)
  return { requests, responses, connected }
}

await test('DNS 停滞受总时限约束，迟到结果不再连接', { timeout: 2000 }, async t => {
  redirectEnvironment(t)
  let resolveDns!: (addresses: LookupAddress[]) => void
  t.mock.method(dns, 'lookup', () => new Promise<LookupAddress[]>(resolve => { resolveDns = resolve }))
  const fixture = sequenceTransport(t, incoming => incoming.end('ok'))
  await assert.rejects(safeHttpRequest('https://deadline.example', { timeoutMs: 25 }), { code: 'ETIMEDOUT' })
  assert.ok(fixture.requests[0].destroyed)
  resolveDns([ipv4])
  await nextTurn()
  assert.deepEqual(fixture.connected, [])
})

await test('响应持续小包不能刷新总预算，失败销毁请求和响应', { timeout: 2000 }, async t => {
  redirectEnvironment(t)
  t.mock.method(dns, 'lookup', async () => [ipv4])
  const intervals: Array<ReturnType<typeof setInterval>> = []
  const fixture = sequenceTransport(t, incoming => {
    incoming.write('first')
    intervals.push(setInterval(() => { if (!incoming.destroyed) incoming.write('x') }, 5))
  })
  t.after(() => intervals.forEach(clearInterval))
  await assert.rejects(safeHttpRequest('https://deadline.example', { timeoutMs: 40 }), { code: 'ETIMEDOUT' })
  assert.ok(fixture.requests[0].destroyed && fixture.responses[0].destroyed)
})

await test('连接/响应停滞与多跳共用同一总预算', { timeout: 2000 }, async t => {
  redirectEnvironment(t)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.method(dns, 'lookup', async () => [ipv4])
  const fixture = sequenceTransport(t, incoming => {
    incoming.statusCode = 307
    incoming.headers.location = '/next'
    setTimeout(() => { if (!incoming.destroyed) incoming.end() }, 12_000)
  })
  const pending = assert.rejects(safeHttpRequest('https://deadline.example', { timeoutMs: 30_000, maxRedirects: 10 }), { code: 'ETIMEDOUT' })
  await nextTurn()
  t.mock.timers.tick(12_000)
  await nextTurn()
  t.mock.timers.tick(12_000)
  await nextTurn()
  t.mock.timers.tick(6_000)
  await pending
  assert.equal(fixture.requests.length, 3, '第三跳只剩总预算的 6 秒，不能重新获得 30 秒')
  assert.ok(fixture.requests.every(request => request.destroyed))
})

for (const kind of ['error', 'aborted', 'close', 'incomplete-end'] as const) {
  await test(`响应 ${kind} 必须确定失败，不接受半包`, { timeout: 2000 }, async t => {
    redirectEnvironment(t)
    t.mock.method(dns, 'lookup', async () => [ipv4])
    const fixture = sequenceTransport(t, incoming => {
      incoming.write('partial')
      if (kind === 'incomplete-end') { incoming.complete = false; incoming.end(); return }
      incoming.emit(kind, ...(kind === 'error' ? [new Error('fixture response failure')] : []))
    })
    await assert.rejects(safeHttpRequest('https://deadline.example', { timeoutMs: 500 }), /中断|未完成|未完整|fixture response failure/)
    assert.ok(fixture.requests[0].destroyed && fixture.responses[0].destroyed)
  })
}

await test('结束/错误/close 竞态只收口一次，成功与失败均清理总计时器', { timeout: 2000 }, async t => {
  redirectEnvironment(t)
  t.mock.method(dns, 'lookup', async () => [ipv4])
  const original = globalThis.clearTimeout, cleared: unknown[] = []
  t.mock.method(globalThis, 'clearTimeout', ((timer: ReturnType<typeof setTimeout>) => { cleared.push(timer); original(timer) }) as typeof clearTimeout)
  const fixture = sequenceTransport(t, incoming => {
    incoming.emit('error', new Error('first failure'))
    incoming.emit('aborted')
    incoming.emit('close')
    incoming.end('late')
  })
  await assert.rejects(safeHttpRequest('https://deadline.example'), /first failure/)
  await nextTurn()
  assert.equal(cleared.length, 1)
  assert.ok(fixture.requests[0].destroyed)
})

await test('响应大小限制仍失败并清理资源', { timeout: 2000 }, async t => {
  redirectEnvironment(t)
  t.mock.method(dns, 'lookup', async () => [ipv4])
  const fixture = sequenceTransport(t, incoming => incoming.end('12345'))
  await assert.rejects(safeHttpRequest('https://deadline.example', { maxResponseBytes: 4 }), /大小上限/)
  assert.ok(fixture.requests[0].destroyed && fixture.responses[0].destroyed)
})

await test('连接在收到响应前关闭或停滞时不会永久等待', { timeout: 2000 }, async t => {
  redirectEnvironment(t)
  let outgoing!: EventEmitter & { write: () => boolean; end: () => void; destroy: () => unknown }
  let destroyed = 0
  t.mock.method(https, 'request', () => {
    outgoing = Object.assign(new EventEmitter(), { write: () => true, end: () => {}, destroy: () => { destroyed++; return outgoing } })
    return outgoing
  })
  const closed = assert.rejects(safeHttpRequest('https://deadline.example'), /未收到响应即关闭/)
  outgoing.emit('close')
  await closed
  await assert.rejects(safeHttpRequest('https://deadline.example', { timeoutMs: 25 }), { code: 'ETIMEDOUT' })
  assert.equal(destroyed, 2)
})

await test('成功读取后立即清理总计时器与请求资源', { timeout: 2000 }, async t => {
  redirectEnvironment(t)
  t.mock.method(dns, 'lookup', async () => [ipv4])
  const original = globalThis.clearTimeout, cleared: unknown[] = []
  t.mock.method(globalThis, 'clearTimeout', ((timer: ReturnType<typeof setTimeout>) => { cleared.push(timer); original(timer) }) as typeof clearTimeout)
  const fixture = sequenceTransport(t, incoming => incoming.end('ok'))
  assert.equal((await safeHttpRequest('https://deadline.example')).body.toString(), 'ok')
  assert.equal(cleared.length, 1)
  assert.ok(fixture.requests[0].destroyed && fixture.responses[0].destroyed)
})

await test('strict 配置仅接受规范化完整公网 Origin，默认 compat', () => {
  assert.equal(readOutboundRedirectPolicy({}).mode, 'compat')
  assert.deepEqual([...readOutboundRedirectPolicy({ Y_LINK_OUTBOUND_REDIRECT_ALLOWED_ORIGINS: '["HTTPS://Public.Example:443"]' }).origins], ['https://public.example'])
  for (const value of ['{}', 'bad-json', '["https://*.example"]', '["https://user:pass@public.example"]', '["https://public.example/path"]', '["https://public.example/a/.."]', '["https://public.example?"]', '["https://public.example#"]', '["http://127.0.0.1"]', '["http://[::1]"]', '["http://[2001:db8::1]"]']) {
    assert.throws(() => readOutboundRedirectPolicy({ Y_LINK_OUTBOUND_REDIRECT_ALLOWED_ORIGINS: value }))
  }
  assert.throws(() => readOutboundRedirectPolicy({ Y_LINK_OUTBOUND_REDIRECT_POLICY: 'unknown' }))
})

for (const status of [301, 302, 303, 307, 308]) {
  for (const mode of ['compat', 'strict']) {
    await test(`${mode} ${status} 保留既有 POST method/body 规则与跨源敏感头剥离`, { timeout: 2000 }, async t => {
      redirectEnvironment(t, mode, ['https://second.example'])
      t.mock.method(dns, 'lookup', async () => [ipv4])
      const fixture = sequenceTransport(t, (incoming, index) => {
        if (index === 0) { incoming.statusCode = status; incoming.headers.location = 'https://second.example/result' }
        incoming.end('ok')
      })
      assert.equal((await safeHttpRequest('https://first.example/start', {
        method: 'POST', body: 'body', headers: { Authorization: 'fixture', 'CONTENT-LENGTH': '4', Accept: 'text/plain' },
      })).statusCode, 200)
      const preserve = status === 307 || status === 308
      assert.equal(fixture.requests[1].options.method, preserve ? 'POST' : 'GET')
      assert.equal(fixture.requests[1].body, preserve ? 'body' : '')
      assert.deepEqual(fixture.requests[1].options.headers, preserve ? { 'CONTENT-LENGTH': '4', Accept: 'text/plain' } : { Accept: 'text/plain' })
    })
  }
}

for (const scenario of ['same-http', 'reject-cross-post', 'reject-downgrade', 'allowlist-private-dns', 'reject-second-cross-hop']) {
  await test(`strict ${scenario} 不绕过逐跳策略或 DNS 校验`, { timeout: 2000 }, async t => {
    redirectEnvironment(t, 'strict', ['https://second.example', 'http://second.example'])
    t.mock.method(dns, 'lookup', async (hostname: string) => scenario === 'allowlist-private-dns' && hostname === 'second.example' ? [privateV6] : [ipv4])
    const fixture = sequenceTransport(t, (incoming, index) => {
      if (index === 0) {
        incoming.statusCode = 307
        incoming.headers.location = scenario === 'same-http' ? '/same' : scenario === 'reject-cross-post' ? 'https://denied.example/'
          : scenario === 'reject-downgrade' ? 'http://second.example/' : 'https://second.example/'
      } else if (scenario === 'reject-second-cross-hop') { incoming.statusCode = 308; incoming.headers.location = 'https://third.example/' }
      incoming.end('ok')
    })
    const pending = safeHttpRequest(`${scenario === 'same-http' ? 'http' : 'https'}://first.example/start`, { method: 'POST', body: 'fixture' })
    if (scenario === 'same-http') { await pending; assert.equal(fixture.requests[1].options.method, 'POST'); return }
    await assert.rejects(pending, scenario === 'allowlist-private-dns' ? /DNS/ : /strict/)
    assert.ok(!fixture.connected.includes('denied.example') && !fixture.connected.includes('third.example'))
    if (scenario === 'reject-cross-post' || scenario === 'reject-downgrade') assert.equal(fixture.requests.length, 1, '策略拒绝不能改 POST 为 GET 后重试')
  })
}

await test('真实启动配置允许默认值，非法策略/Origin/非 root 开关在启动期拒绝', { timeout: 30_000 }, () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'ylink-outbound-config-'))
  const envFile = path.join(runtime, 'isolated.env')
  fs.writeFileSync(envFile, '', { flag: 'wx', mode: 0o600 })
  const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  try {
    for (const [extra, expected] of [
      [{}, 0],
      [{ Y_LINK_OUTBOUND_REDIRECT_POLICY: 'strict', Y_LINK_OUTBOUND_REDIRECT_ALLOWED_ORIGINS: '["https://public.example"]' }, 0],
      [{ Y_LINK_OUTBOUND_REDIRECT_POLICY: 'unknown' }, 42],
      [{ Y_LINK_OUTBOUND_REDIRECT_ALLOWED_ORIGINS: 'not-json' }, 42],
      [{ Y_LINK_OUTBOUND_REDIRECT_ALLOWED_ORIGINS: '["http://127.0.0.1"]' }, 42],
      [{ Y_LINK_ONEBOX_NON_ROOT: 'unknown' }, 42],
    ] as const) {
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
        "try { await import('./src/config/env.ts') } catch { process.exitCode = 42 }"], {
        cwd: backend, encoding: 'utf8', timeout: 5000,
        env: { ...process.env, NODE_ENV: 'test', APP_PROFILE: 'outbound-config-fixture', ENV_FILE: envFile,
          Y_LINK_DATA_DIR: runtime, SQLITE_DB_PATH: path.join(runtime, 'unused.sqlite'), DB_TYPE: 'sqlite',
          Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE: 'true', REDIS_URL: '', Y_LINK_OUTBOUND_REDIRECT_POLICY: 'compat',
          Y_LINK_OUTBOUND_REDIRECT_ALLOWED_ORIGINS: '[]', Y_LINK_ONEBOX_NON_ROOT: 'false', ...extra },
      })
      assert.equal(result.error, undefined)
      assert.equal(result.status, expected)
    }
    assert.equal(fs.existsSync(path.join(runtime, 'unused.sqlite')), false, '启动配置验证不能初始化业务库')
  } finally { fs.rmSync(runtime, { recursive: true, force: true }) }
})
