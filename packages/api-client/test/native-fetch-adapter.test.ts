import assert from 'node:assert/strict'
import test from 'node:test'

import { ApiClientError } from '../src/errors.ts'
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  createNativeFetchAdapter,
} from '../src/native-fetch-adapter.ts'

type FetchCall = {
  input: string | URL | Request
  init?: RequestInit
}

const jsonResponse = (payload: unknown, status = 200) => {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  })
}

const createFetchRecorder = (response: Response) => {
  const calls: FetchCall[] = []
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init })
    return response.clone()
  }

  return { calls, fetch }
}

test('默认请求超时为 15000ms', () => {
  assert.equal(DEFAULT_REQUEST_TIMEOUT_MS, 15_000)
})

test('允许单次请求覆盖超时并归一化为 timeout 错误', async () => {
  const fetch = (_input: string | URL | Request, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(init.signal?.reason)
      }, { once: true })
    })
  }
  const adapter = createNativeFetchAdapter({
    baseUrl: 'https://api.example.com',
    fetch,
  })

  await assert.rejects(
    adapter.request({ method: 'GET', path: '/slow', timeoutMs: 5 }),
    (error: unknown) => error instanceof ApiClientError && error.kind === 'timeout',
  )
})

test('外部 AbortSignal 主动取消归一化为 canceled 错误', async () => {
  const fetch = (_input: string | URL | Request, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(init.signal?.reason)
      }, { once: true })
    })
  }
  const adapter = createNativeFetchAdapter({
    baseUrl: 'https://api.example.com',
    fetch,
  })
  const controller = new AbortController()
  const request = adapter.request({
    method: 'GET',
    path: '/profile',
    signal: controller.signal,
  })

  controller.abort()

  await assert.rejects(
    request,
    (error: unknown) => error instanceof ApiClientError && error.kind === 'canceled',
  )
})

test('按需注入 Bearer Authorization 且保留显式 headers', async () => {
  const recorder = createFetchRecorder(jsonResponse({ code: 0, message: 'ok', data: true }))
  const adapter = createNativeFetchAdapter({
    baseUrl: 'https://api.example.com/api',
    fetch: recorder.fetch,
    getAccessToken: async () => 'mobile-token',
  })

  await adapter.request({
    method: 'GET',
    path: '/client-auth/me',
    headers: { 'X-Trace-Id': 'trace-1' },
  })

  const headers = new Headers(recorder.calls[0]?.init?.headers)
  assert.equal(headers.get('Authorization'), 'Bearer mobile-token')
  assert.equal(headers.get('X-Trace-Id'), 'trace-1')
})

test('仅在调用方显式传入 key 时添加 Idempotency-Key', async () => {
  const recorder = createFetchRecorder(jsonResponse({ code: 0, message: 'ok', data: true }))
  const adapter = createNativeFetchAdapter({
    baseUrl: 'https://api.example.com',
    fetch: recorder.fetch,
  })

  await adapter.request({ method: 'POST', path: '/orders', body: { skuId: 1 } })
  await adapter.request({
    method: 'POST',
    path: '/orders',
    body: { skuId: 1 },
    idempotencyKey: 'checkout-1',
  })

  const firstHeaders = new Headers(recorder.calls[0]?.init?.headers)
  const secondHeaders = new Headers(recorder.calls[1]?.init?.headers)
  assert.equal(firstHeaders.has('Idempotency-Key'), false)
  assert.equal(secondHeaders.get('Idempotency-Key'), 'checkout-1')
})

test('编码 query 标量和数组并忽略 null 与 undefined', async () => {
  const recorder = createFetchRecorder(jsonResponse({ code: 0, message: 'ok', data: [] }))
  const adapter = createNativeFetchAdapter({
    baseUrl: 'https://api.example.com/api/',
    fetch: recorder.fetch,
  })

  await adapter.request({
    method: 'GET',
    path: '/items',
    query: {
      search: '中文 空格',
      page: 2,
      enabled: false,
      tags: ['a/b', 'c'],
      empty: null,
      missing: undefined,
    },
  })

  assert.equal(
    recorder.calls[0]?.input,
    'https://api.example.com/api/items?search=%E4%B8%AD%E6%96%87+%E7%A9%BA%E6%A0%BC&page=2&enabled=false&tags=a%2Fb&tags=c',
  )
})

test('JSON 序列化请求体并解包成功响应 data', async () => {
  const recorder = createFetchRecorder(jsonResponse({ code: 0, message: 'ok', data: { id: 7 } }))
  const adapter = createNativeFetchAdapter({
    baseUrl: 'https://api.example.com',
    fetch: recorder.fetch,
  })

  const result = await adapter.request<{ id: number }>({
    method: 'POST',
    path: '/orders',
    body: { skuId: 3 },
  })

  assert.deepEqual(result, { id: 7 })
  assert.equal(recorder.calls[0]?.init?.body, '{"skuId":3}')
  assert.equal(new Headers(recorder.calls[0]?.init?.headers).get('Content-Type'), 'application/json')
})

test('非 2xx 响应归一化为 http 错误', async () => {
  const adapter = createNativeFetchAdapter({
    baseUrl: 'https://api.example.com',
    fetch: async () => jsonResponse({ code: 5001, message: '服务暂不可用', data: null }, 503),
  })

  await assert.rejects(
    adapter.request({ method: 'GET', path: '/health' }),
    (error: unknown) => {
      assert.ok(error instanceof ApiClientError)
      assert.equal(error.kind, 'http')
      assert.equal(error.status, 503)
      assert.equal(error.code, 5001)
      assert.equal(error.message, '服务暂不可用')
      return true
    },
  )
})

test('2xx 中的非零业务码归一化为 business 错误', async () => {
  const adapter = createNativeFetchAdapter({
    baseUrl: 'https://api.example.com',
    fetch: async () => jsonResponse({ code: 4001, message: '库存不足', data: null }),
  })

  await assert.rejects(
    adapter.request({ method: 'POST', path: '/orders', body: {} }),
    (error: unknown) => {
      assert.ok(error instanceof ApiClientError)
      assert.equal(error.kind, 'business')
      assert.equal(error.status, 200)
      assert.equal(error.code, 4001)
      assert.equal(error.message, '库存不足')
      return true
    },
  )
})

test('fetch 通道异常归一化为 network 错误', async () => {
  const cause = new TypeError('fetch failed')
  const adapter = createNativeFetchAdapter({
    baseUrl: 'https://api.example.com',
    fetch: async () => {
      throw cause
    },
  })

  await assert.rejects(
    adapter.request({ method: 'GET', path: '/items' }),
    (error: unknown) => {
      assert.ok(error instanceof ApiClientError)
      assert.equal(error.kind, 'network')
      assert.equal(error.cause, cause)
      return true
    },
  )
})

test('401 只归一化错误且不刷新或重放请求', async () => {
  let callCount = 0
  const adapter = createNativeFetchAdapter({
    baseUrl: 'https://api.example.com',
    getAccessToken: async () => 'expired-token',
    fetch: async () => {
      callCount += 1
      return jsonResponse({ code: 401, message: '登录状态已失效', data: null }, 401)
    },
  })

  await assert.rejects(
    adapter.request({ method: 'GET', path: '/client-auth/me' }),
    (error: unknown) => error instanceof ApiClientError
      && error.kind === 'http'
      && error.status === 401,
  )
  assert.equal(callCount, 1)
})
