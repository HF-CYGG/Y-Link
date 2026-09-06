/**
 * 文件说明：认证安全工作包的可执行回归验证。
 * 文件职责：覆盖客户端 Cookie CSRF、短期票据原子消费、验证码图像泄露和验证码失败次数上限。
 * 实现逻辑：测试只依赖进程内可注入实现，不通过 HTTP 接口或 SVG 文本反推出验证码答案。
 */

import assert from 'node:assert/strict'
import {
  CaptchaService,
  type CaptchaRenderer,
} from '../src/services/captcha.service.js'
import {
  VerificationCodeAttemptStore,
  type VerificationCodeTicket,
} from '../src/services/verification-code.service.js'
import { requireClientAuth } from '../src/middleware/client-auth.middleware.js'
import { clientAuthService } from '../src/services/client-auth.service.js'
import type { ClientAuthContext } from '../src/types/client-auth.js'
import { BizError } from '../src/utils/errors.js'
import { deriveClientCsrfToken } from '../src/utils/client-auth-cookie.js'
import { EphemeralTicketStore } from '../src/utils/ephemeral-ticket-store.js'

const createTicketStore = <TTicket extends { expiresAt: number }>() => new EphemeralTicketStore<TTicket>({
  maxSize: 10,
  resolveExpiresAt: (ticket) => ticket.expiresAt,
})

const run = async () => {
  const oneTimeStore = createTicketStore<{ expiresAt: number; value: string }>()
  oneTimeStore.set('reset-token', { expiresAt: Date.now() + 60_000, value: 'bound-user' })
  assert.equal(oneTimeStore.take('reset-token')?.value, 'bound-user', '票据首次消费必须取到原值')
  assert.equal(oneTimeStore.take('reset-token'), undefined, '票据消费必须是同步原子的一次性操作')

  const csrfForFirstSession = deriveClientCsrfToken('client-session-a')
  const csrfForSecondSession = deriveClientCsrfToken('client-session-b')
  assert.notEqual(csrfForFirstSession, csrfForSecondSession, '不同会话不能派生相同客户端 CSRF 值')
  assert.notEqual(csrfForFirstSession, 'client-session-a', '客户端 CSRF 值不得复用会话令牌')

  const originalResolveClientByToken = clientAuthService.resolveClientByToken
  clientAuthService.resolveClientByToken = async (sessionToken: string): Promise<ClientAuthContext> => ({
    userId: 'client-user-id',
    account: 'client-account',
    mobile: '13800138000',
    email: '',
    realName: '测试用户',
    accountType: 'personal',
    staffNo: null,
    sessionToken,
    authSource: 'bearer',
  })
  const invokeClientAuth = async (request: { method: string; headers: Record<string, string | undefined> }) => {
    let middlewareError: unknown
    await requireClientAuth(request as never, {} as never, (error?: unknown) => {
      middlewareError = error
    })
    return middlewareError
  }
  try {
    const missingCsrf = await invokeClientAuth({
      method: 'POST',
      headers: { cookie: 'y_link_client_session=client-session-a' },
    })
    assert.ok(missingCsrf instanceof BizError, 'Cookie 写请求缺少 CSRF 必须被拒绝')
    assert.equal(missingCsrf.data?.reason, 'CLIENT_CSRF_MISSING')

    const mismatchCsrf = await invokeClientAuth({
      method: 'POST',
      headers: {
        cookie: `y_link_client_session=client-session-a; y_link_client_csrf=${encodeURIComponent(csrfForSecondSession)}`,
        'x-client-csrf-token': csrfForSecondSession,
      },
    })
    assert.ok(mismatchCsrf instanceof BizError, '伪造的相等 Cookie/Header 值不能通过')
    assert.equal(mismatchCsrf.data?.reason, 'CLIENT_CSRF_MISMATCH')

    assert.equal(await invokeClientAuth({
      method: 'POST',
      headers: {
        cookie: `y_link_client_session=client-session-a; y_link_client_csrf=${encodeURIComponent(csrfForFirstSession)}`,
        'x-client-csrf-token': csrfForFirstSession,
      },
    }), undefined, '派生 CSRF 值应允许 Cookie 会话写请求')
    assert.equal(await invokeClientAuth({
      method: 'POST',
      headers: { authorization: 'Bearer bearer-only-session' },
    }), undefined, '纯 Bearer 兼容请求不应被 Cookie CSRF 规则拦截')
    const mixedCredential = await invokeClientAuth({
      method: 'POST',
      headers: { cookie: 'y_link_client_session=client-session-a', authorization: 'Bearer bearer-only-session' },
    })
    assert.ok(mixedCredential instanceof BizError, '混合凭据必须按 Cookie 优先，不能绕过 CSRF')
  } finally {
    clientAuthService.resolveClientByToken = originalResolveClientByToken
  }

  const captchaStore = createTicketStore<{ code: string; expireAt: number }>()
  const renderer: CaptchaRenderer = async () => Buffer.from([0x89, 0x50, 0x4e, 0x47])
  const captcha = new CaptchaService({
    stores: {
      admin: captchaStore,
      client: createTicketStore<{ code: string; expireAt: number }>(),
    },
    createCode: () => 'ABC123',
    renderPng: renderer,
  })
  const clientCaptcha = await captcha.createCaptcha('client')
  assert.match(clientCaptcha.captchaImage ?? '', /^data:image\/png;base64,/, '验证码必须提供 PNG data URL')
  assert.match(clientCaptcha.captchaSvg, /<image\b/i, '旧 SVG 字段必须仅包装 PNG 图像')
  assert.doesNotMatch(clientCaptcha.captchaSvg, /<text\b/i, 'SVG 不能再包含可读取的验证码答案文本')
  assert.throws(
    () => captcha.verifyCaptcha('admin', clientCaptcha.captchaId, 'ABC123'),
    /失效/,
    '管理端和客户端验证码票据必须隔离',
  )
  captcha.verifyCaptcha('client', clientCaptcha.captchaId, 'ABC123')

  const verificationStore = createTicketStore<VerificationCodeTicket>()
  const attempts = new VerificationCodeAttemptStore(verificationStore)
  const key = 'mobile:register:13800138000'
  attempts.set(key, {
    channel: 'mobile',
    target: '13800138000',
    scene: 'register',
    code: '123456',
    expiresAt: Date.now() + 60_000,
    failedAttempts: 0,
  })
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(attempts.consume(key, '000000'), false, `第 ${attempt + 1} 次错误验证码必须失败`)
  }
  assert.equal(attempts.consume(key, '123456'), null, '连续五次错误后验证码必须作废，不能再被正确答案消费')

  console.log('认证安全工作包核心回归验证通过')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
