import assert from 'node:assert/strict'
import test from 'node:test'

import { createCatalogApi } from '../src/modules/catalog.ts'
import { createClientAuthApi } from '../src/modules/client-auth.ts'
import { createFeedbackApi } from '../src/modules/feedback.ts'
import { createOrdersApi } from '../src/modules/orders.ts'
import type { ApiRequestOptions, HttpAdapter, HttpRequestConfig } from '../src/types.ts'

const createRecordingAdapter = () => {
  const requests: HttpRequestConfig[] = []
  const adapter: HttpAdapter = {
    async request<T>(config: HttpRequestConfig): Promise<T> {
      requests.push(config)
      return undefined as T
    },
  }
  return { adapter, requests }
}

test('client-auth module 固定真实认证路径并透传请求控制选项', async () => {
  const { adapter, requests } = createRecordingAdapter()
  const api = createClientAuthApi(adapter)
  const signal = new AbortController().signal
  const login = { account: 'demo@example.com', password: 'not-a-real-secret' }

  await api.getCaptcha({ signal })
  await api.login(login, { timeoutMs: 3_000 })
  await api.login(login, {
    method: 'DELETE',
    url: 'https://invalid.example/override',
    data: { replaced: true },
    timeoutMs: 1_000,
  } as unknown as ApiRequestOptions)

  assert.deepEqual(requests, [
    { method: 'GET', url: '/client-auth/captcha', signal },
    { method: 'POST', url: '/client-auth/login', data: login, timeoutMs: 3_000 },
    { method: 'POST', url: '/client-auth/login', data: login, timeoutMs: 1_000 },
  ])
})

test('catalog module 只描述公开目录与门店配置读取', async () => {
  const { adapter, requests } = createRecordingAdapter()
  const api = createCatalogApi(adapter)

  await api.getProducts()
  await api.getStorefront({ headers: { 'If-None-Match': 'catalog-etag' } })

  assert.deepEqual(requests, [
    { method: 'GET', url: '/o2o/mall/products' },
    {
      method: 'GET',
      url: '/o2o/mall/storefront',
      headers: { 'If-None-Match': 'catalog-etag' },
    },
  ])
})

test('orders module 保留服务端分页原始结构且不自动生成幂等请求头', async () => {
  const { adapter, requests } = createRecordingAdapter()
  const api = createOrdersApi(adapter)
  const payload = {
    clientRequestId: 'mobile-order:1234567890',
    isSystemApplied: false,
    pickupContact: '测试用户',
    items: [{ productId: 'p-1', skuId: 'sku-1', qty: 2 }],
  }

  await api.listMyOrders({ page: 2, pageSize: 20, status: 'pending', keyword: 'YL' })
  await api.submitPreorder(payload)
  await api.submitPreorder(payload, { idempotencyKey: 'caller-owned-key' })
  await api.getPreorderDetail('order/1')

  assert.deepEqual(requests, [
    {
      method: 'GET',
      url: '/o2o/mall/preorders',
      params: { page: 2, pageSize: 20, status: 'pending', keyword: 'YL' },
    },
    { method: 'POST', url: '/o2o/mall/preorders', data: payload },
    {
      method: 'POST',
      url: '/o2o/mall/preorders',
      data: payload,
      idempotencyKey: 'caller-owned-key',
    },
    { method: 'GET', url: '/o2o/mall/preorders/order%2F1' },
  ])
})

test('feedback module 使用后端原始会话 contract，不混入 Web UI 映射', async () => {
  const { adapter, requests } = createRecordingAdapter()
  const api = createFeedbackApi(adapter)
  const createPayload = {
    subject: '页面异常',
    content: '出现可复现问题',
    issueType: 'bug' as const,
    priority: 'high' as const,
  }

  await api.getPortalConfig()
  await api.listMyConversations({ page: 1, pageSize: 100, status: 'open' })
  await api.createConversation(createPayload)
  await api.appendMessage('conversation/1', { content: '补充说明' })

  assert.deepEqual(requests, [
    { method: 'GET', url: '/client-feedback/portal-config' },
    {
      method: 'GET',
      url: '/client-feedback/conversations',
      params: { page: 1, pageSize: 100, keyword: undefined, status: 'open' },
    },
    { method: 'POST', url: '/client-feedback/conversations', data: createPayload },
    {
      method: 'POST',
      url: '/client-feedback/conversations/conversation%2F1/messages',
      data: { content: '补充说明' },
    },
  ])
})
