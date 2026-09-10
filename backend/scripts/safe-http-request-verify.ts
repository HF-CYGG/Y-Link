/**
 * 文件职责：验证安全出站客户端的 DNS 回调契约、地址族选择和重定向安全边界。
 * 实现逻辑：仅替换 DNS 与 HTTP/HTTPS 传输边界，执行真实客户端逻辑；不连接数据库或外部服务。
 * 维护说明：测试串行运行并自动恢复模拟，禁止使用真实 Webhook 或放宽生产网络校验。
 */
import assert from 'node:assert/strict'
import { promises as dns, type LookupAddress, type LookupOptions } from 'node:dns'
import { EventEmitter } from 'node:events'
import http, { type IncomingMessage, type RequestOptions } from 'node:http'
import https from 'node:https'
import { type LookupFunction } from 'node:net'
import { PassThrough } from 'node:stream'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { test, type TestContext } from 'node:test'
import { safeHttpRequest } from '../src/utils/safe-http-request.js'

const ipv4: LookupAddress = { address: '8.8.8.8', family: 4 }
const ipv6: LookupAddress = { address: '2606:4700:4700::1111', family: 6 }
const privateV6: LookupAddress = { address: 'fd00::1', family: 6 }

async function captureLookup(t: TestContext, protocol = 'https:') {
  let lookup: LookupFunction | undefined
  const sentinel = new Error('仅截取请求，不建立连接')
  t.mock.method(protocol === 'https:' ? https : http, 'request', (options: RequestOptions) => {
    lookup = options.lookup
    throw sentinel
  })
  await assert.rejects(safeHttpRequest(`${protocol}//outbound.example/test`), (error) => error === sentinel)
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
