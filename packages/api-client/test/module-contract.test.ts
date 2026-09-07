import assert from 'node:assert/strict'
import test from 'node:test'

import { createCatalogApi } from '../src/modules/catalog.ts'
import { createClientAuthApi } from '../src/modules/client-auth.ts'
import { createFeedbackApi } from '../src/modules/feedback.ts'
import { createMobileAuthApi } from '../src/modules/mobile-auth.ts'
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

test('mobile-auth module 固定 v1 Bearer 会话路径且 refresh 显式禁用 access 注入', async () => {
  const { adapter, requests } = createRecordingAdapter()
  const api = createMobileAuthApi(adapter)
  const device = {
    deviceId: '0f2c0000-0000-4000-8000-000000000001',
    deviceName: 'Pixel 8',
    platform: 'android' as const,
    appVersion: '1.0.0',
  }
  const login = { account: 'demo@example.com', password: 'not-a-real-secret', device }
  const refresh = {
    refreshToken: `ylmr_${'a'.repeat(64)}`,
    device: { deviceId: device.deviceId, appVersion: '1.0.1' },
  }

  await api.getCaptcha()
  await api.login(login)
  await api.refresh(refresh, { timeoutMs: 5_000 })
  await api.logout()
  await api.logoutAll({ scope: 'others' })
  await api.getMe()
  await api.listSessions()
  await api.revokeSession('session/1')

  assert.deepEqual(requests, [
    { method: 'GET', url: '/v1/mobile-auth/captcha', auth: 'none' },
    { method: 'POST', url: '/v1/mobile-auth/login', data: login, auth: 'none' },
    {
      method: 'POST',
      url: '/v1/mobile-auth/refresh',
      data: refresh,
      auth: 'none',
      timeoutMs: 5_000,
    },
    { method: 'POST', url: '/v1/mobile-auth/logout' },
    {
      method: 'POST',
      url: '/v1/mobile-auth/logout-all',
      params: { scope: 'others' },
    },
    { method: 'GET', url: '/v1/mobile-auth/me' },
    { method: 'GET', url: '/v1/mobile-auth/sessions' },
    { method: 'DELETE', url: '/v1/mobile-auth/sessions/session%2F1' },
  ])
})

test('mobile-auth module 覆盖所有公开、资料与密码端点，且仅公开端点禁用 access 注入', async () => {
  const { adapter, requests } = createRecordingAdapter()
  const api = createMobileAuthApi(adapter)
  const device = {
    deviceId: '0f2c0000-0000-4000-8000-000000000001',
    deviceName: 'Pixel 8',
    platform: 'android' as const,
    appVersion: '1.0.0',
  }
  const register = { accountType: 'personal' as const, password: 'not-a-real-secret', device }
  const profile = { username: '新昵称', currentPassword: 'not-a-real-secret' }
  const changePassword = {
    currentPassword: 'not-a-real-secret',
    newPassword: 'another-not-a-real-secret',
    device,
  }
  const forgotPassword = { account: 'demo@example.com', verificationCode: '123456' }
  const resetPassword = {
    account: 'demo@example.com',
    resetToken: 'reset-token',
    newPassword: 'another-not-a-real-secret',
  }
  const verificationCode = {
    channel: 'email' as const,
    target: 'demo@example.com',
    scene: 'register' as const,
    captchaId: 'captcha-id',
    captchaCode: '1234',
  }

  await api.getCapabilities()
  await api.sendVerificationCode(verificationCode)
  await api.register(register)
  await api.updateProfile(profile)
  await api.changePassword(changePassword)
  await api.verifyForgotPassword(forgotPassword)
  await api.resetPassword(resetPassword)

  assert.deepEqual(requests, [
    { method: 'GET', url: '/v1/mobile-auth/capabilities', auth: 'none' },
    {
      method: 'POST',
      url: '/v1/mobile-auth/verification-code',
      data: verificationCode,
      auth: 'none',
    },
    { method: 'POST', url: '/v1/mobile-auth/register', data: register, auth: 'none' },
    { method: 'PATCH', url: '/v1/mobile-auth/profile', data: profile },
    { method: 'POST', url: '/v1/mobile-auth/change-password', data: changePassword },
    {
      method: 'POST',
      url: '/v1/mobile-auth/forgot-password/verify',
      data: forgotPassword,
      auth: 'none',
    },
    {
      method: 'POST',
      url: '/v1/mobile-auth/forgot-password/reset',
      data: resetPassword,
      auth: 'none',
    },
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
