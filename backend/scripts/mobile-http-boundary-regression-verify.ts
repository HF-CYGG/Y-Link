/**
 * 文件职责：以隔离 Express HTTP 夹具验证 Web 与 Mobile 的 429 边界、Bearer 登出兼容性和重试元数据。
 * 不初始化数据源、不读取真实业务数据；仅替换风控存储和会话撤销的进程内边界。
 */
import 'reflect-metadata'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mock } from 'node:test'
import express, { type Express } from 'express'
import { errorHandler } from '../src/middleware/error-handler.js'
import { mobileAuthRouter } from '../src/routes/mobile-auth.routes.js'
import { authSecurityService } from '../src/services/auth-security.service.js'
import { mobileSessionService } from '../src/services/mobile-session.service.js'
import { persistentRiskStateService } from '../src/services/persistent-risk-state.service.js'
import { clientAuthService } from '../src/services/client-auth.service.js'
import { mobileAuthService } from '../src/services/mobile-auth.service.js'
import { BizError } from '../src/utils/errors.js'

type HttpResult = { status: number; headers: Headers; body: unknown }

async function withServer<T>(app: Express, run: (origin: string) => Promise<T>): Promise<T> {
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string', '隔离 HTTP 服务必须绑定本地临时端口')
  try {
    return await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

async function request(origin: string, path: string, options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<HttpResult> {
  const response = await fetch(`${origin}${path}`, {
    method: options.method ?? 'GET',
    headers: options.body === undefined ? options.headers : { 'content-type': 'application/json', ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  return { status: response.status, headers: response.headers, body: await response.json() }
}

const createMobileApp = () => {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/mobile-auth', mobileAuthRouter)
  app.use(errorHandler)
  return app
}

async function verifyWeb429RemainsUnchanged() {
  const app = express()
  app.get('/limited', (_req, _res, next) => next(new BizError('Web 请求过于频繁', 429)))
  app.use(errorHandler)
  await withServer(app, async (origin) => {
    const result = await request(origin, '/limited')
    assert.equal(result.status, 429)
    assert.deepEqual(result.body, { code: 429, message: 'Web 请求过于频繁', data: null })
  })
}

async function verifyMobileLoginRateLimitUsesNativeContract() {
  const riskState = persistentRiskStateService as unknown as { consumeWindow: typeof persistentRiskStateService.consumeWindow }
  const security = authSecurityService as unknown as { recordRiskEvent: (...args: unknown[]) => Promise<void> }
  const originalConsumeWindow = riskState.consumeWindow
  const originalRecordRiskEvent = security.recordRiskEvent
  riskState.consumeWindow = async () => ({ totalHits: 19, resetTime: new Date(Date.now() + 2_100) })
  security.recordRiskEvent = async () => undefined
  try {
    await assert.rejects(
      () => authSecurityService.guardClientLoginRequest({ ipAddress: '127.0.0.1' }, '13800138000'),
      (error: unknown) => {
        assert.ok(error instanceof BizError)
        assert.equal(error.code, 429, '共享 Web 守卫不得改写为 Mobile 协议码')
        assert.equal(error.data, null, '共享 Web 守卫不得输出 Mobile 重试 data')
        assert.ok(error.retryAfterSeconds && error.retryAfterSeconds >= 1)
        return true
      },
    )
    await withServer(createMobileApp(), async (origin) => {
      const result = await request(origin, '/api/v1/mobile-auth/login', {
        method: 'POST',
        body: {
          account: '13800138000',
          password: 'not-used-after-rate-limit',
          device: { deviceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', platform: 'android' },
        },
      })
      assert.equal(result.status, 429)
      assert.equal((result.body as { code: number }).code, 42900)
      const retryAfterSeconds = (result.body as { data: { retryAfterSeconds: number } }).data.retryAfterSeconds
      assert.ok(retryAfterSeconds >= 1 && retryAfterSeconds <= 3, 'Mobile 限流必须携带准确秒级退避')
      assert.equal(result.headers.get('retry-after'), String(retryAfterSeconds))
    })
  } finally {
    riskState.consumeWindow = originalConsumeWindow
    security.recordRiskEvent = originalRecordRiskEvent
  }
}

async function verifyMobileNon429PassesToGlobalHandler() {
  const originalGetCapabilities = clientAuthService.getCapabilities
  clientAuthService.getCapabilities = async () => { throw new BizError('能力读取失败', 400, { reason: 'TEST_NON_429' }) }
  try {
    await withServer(createMobileApp(), async (origin) => {
      const result = await request(origin, '/api/v1/mobile-auth/capabilities')
      assert.deepEqual(result.body, { code: 400, message: '能力读取失败', data: { reason: 'TEST_NON_429' } })
    })
  } finally {
    clientAuthService.getCapabilities = originalGetCapabilities
  }
}

async function verifyLogoutRemainsIdempotentForExpiredAccess() {
  const originalRevokeByAccessToken = mobileSessionService.revokeByAccessToken
  const receivedTokens: string[] = []
  mobileSessionService.revokeByAccessToken = async (accessToken) => {
    receivedTokens.push(accessToken)
    return { ok: true, alreadyRevoked: true }
  }
  try {
    await withServer(createMobileApp(), async (origin) => {
      for (const token of ['still-active-token', 'still-active-token', 'expired-access-token']) {
        const result = await request(origin, '/api/v1/mobile-auth/logout', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
        })
        assert.equal(result.status, 200, '重复或已过期 Access Token 的登出必须保持幂等成功')
      }
    })
    assert.deepEqual(receivedTokens, ['still-active-token', 'still-active-token', 'expired-access-token'])
  } finally {
    mobileSessionService.revokeByAccessToken = originalRevokeByAccessToken
  }
}

async function verifyMobileAuthInputBounds() {
  const account = 'http-contract@example.test'
  const device = { deviceId: 'a'.repeat(32), platform: 'android' }
  const historicalPassword = 'h'.repeat(256)
  const passwordCalls: string[] = []
  const acceptHistoricalPassword = async (input: { password?: string; currentPassword?: string }) => {
    passwordCalls.push(input.password ?? input.currentPassword ?? '')
    return { ok: true }
  }
  try {
    mock.method(mobileSessionService, 'resolveAccess', async () => ({ userId: 'fixture-user' }))
    mock.method(authSecurityService, 'guardClientProfileUpdateRequest', async () => {})
    mock.method(mobileAuthService, 'login', acceptHistoricalPassword)
    mock.method(mobileAuthService, 'updateProfile', async (_auth, input) => acceptHistoricalPassword(input))
    mock.method(mobileAuthService, 'changePassword', async (_auth, input) => acceptHistoricalPassword(input))
    const { createApp } = await import('../src/app.js')
    await withServer(createApp(), async (origin) => {
      const post = (path: string, body: unknown, method = 'POST') => request(origin, '/api/v1/mobile-auth' + path, {
        method, body, headers: { authorization: 'Bearer fixture-access-token' },
      })
      const loginBody = { account, password: historicalPassword, device }
      const changeBody = { device, currentPassword: historicalPassword, newPassword: 'NewFixture789!' }
      assert.equal((await post('/login', loginBody)).status, 200)
      assert.equal((await post('/change-password', changeBody)).status, 200)
      assert.equal((await post('/profile', { username: 'fixture', currentPassword: historicalPassword }, 'PATCH')).status, 200)
      for (const [route, body, method] of [
        ['/login', { ...loginBody, password: 'p'.repeat(257) }],
        ['/login', { ...loginBody, captchaId: 'i'.repeat(65) }],
        ['/login', { ...loginBody, captchaCode: 'c'.repeat(17) }],
        ['/register', { accountType: 'personal', device, password: 'StrongFixture123!', captchaId: 'i'.repeat(65) }],
        ['/forgot-password/verify', { account: 'a'.repeat(129) }],
        ['/forgot-password/verify', { account, captchaCode: 'c'.repeat(17) }],
        ['/forgot-password/reset', { account, resetToken: 'x'.repeat(257), newPassword: 'ResetFixture789!' }],
        ['/verification-code', { channel: 'email', target: account, scene: 'register', captchaId: 'i'.repeat(65), captchaCode: 'AB2345' }],
        ['/change-password', { ...changeBody, currentPassword: 'p'.repeat(257) }],
        ['/profile', { username: 'fixture', currentPassword: 'p'.repeat(257) }, 'PATCH'],
      ] as const) assert.equal((await post(route, body, method)).status, 400, route)
      assert.deepEqual(passwordCalls, [historicalPassword, historicalPassword, historicalPassword])
    })
  } finally {
    mock.restoreAll()
  }
}

async function main() {
  await verifyMobileAuthInputBounds()
  await verifyWeb429RemainsUnchanged()
  await verifyMobileLoginRateLimitUsesNativeContract()
  await verifyMobileNon429PassesToGlobalHandler()
  await verifyLogoutRemainsIdempotentForExpiredAccess()
  console.log('[mobile-http-boundary-regression] Web/Mobile HTTP 边界回归通过')
}

main().catch((error) => {
  console.error('[mobile-http-boundary-regression] 验证失败:', error)
  process.exitCode = 1
})
