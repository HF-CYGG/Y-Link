/**
 * 模块说明：backend/src/services/auth-security.service.ts
 * 文件职责：集中承接认证风控能力，包括频率限制、失败计数、临时锁定与异常审计。
 * 维护说明：
 * - 当前实现为单实例内存风控，适合现阶段单机/本地部署；
 * - 若后续升级多实例部署，应优先迁移到 Redis 等共享存储；
 * - 认证类接口应统一先经过本服务的 guard，再进入具体业务服务。
 */

import type { RequestMeta } from '../utils/request-meta.js'
import { BizError } from '../utils/errors.js'
import { auditService } from './audit.service.js'

type FailureScope = 'admin-login' | 'client-login'

interface FailureState {
  count: number
  firstFailedAt: number
  lastFailedAt: number
  lockedUntil: number
}

interface RateLimitRule {
  maxRequests: number
  windowMs: number
  blockMessage: string
}

const RATE_LIMIT_RULES = {
  adminLoginByIp: {
    maxRequests: 12,
    windowMs: 5 * 60 * 1000,
    blockMessage: '登录尝试过于频繁，请稍后再试',
  },
  clientLoginByIp: {
    maxRequests: 20,
    windowMs: 5 * 60 * 1000,
    blockMessage: '登录尝试过于频繁，请稍后再试',
  },
  clientRegisterByIp: {
    maxRequests: 6,
    windowMs: 30 * 60 * 1000,
    blockMessage: '注册请求过于频繁，请稍后再试',
  },
  clientRegisterByMobile: {
    maxRequests: 3,
    windowMs: 24 * 60 * 60 * 1000,
    blockMessage: '该手机号注册尝试过于频繁，请明天再试',
  },
  clientForgotVerifyByIp: {
    maxRequests: 6,
    windowMs: 30 * 60 * 1000,
    blockMessage: '找回密码校验请求过于频繁，请稍后再试',
  },
  clientForgotVerifyByMobile: {
    maxRequests: 3,
    windowMs: 30 * 60 * 1000,
    blockMessage: '该手机号找回密码尝试过于频繁，请稍后再试',
  },
  clientForgotResetByIp: {
    maxRequests: 6,
    windowMs: 30 * 60 * 1000,
    blockMessage: '重置密码请求过于频繁，请稍后再试',
  },
  captchaByIp: {
    maxRequests: 30,
    windowMs: 10 * 60 * 1000,
    blockMessage: '验证码请求过于频繁，请稍后再试',
  },
} as const satisfies Record<string, RateLimitRule>

const FAILURE_LOCK_THRESHOLD = {
  'admin-login': 5,
  'client-login': 6,
} as const satisfies Record<FailureScope, number>

const FAILURE_LOCK_MS = {
  'admin-login': 15 * 60 * 1000,
  'client-login': 10 * 60 * 1000,
} as const satisfies Record<FailureScope, number>

const FAILURE_RESET_WINDOW_MS = {
  'admin-login': 15 * 60 * 1000,
  'client-login': 15 * 60 * 1000,
} as const satisfies Record<FailureScope, number>

/**
 * 内存态时间窗口记录：
 * - key 一般由“接口 + IP”或“接口 + 账号/手机号”组成；
 * - value 记录请求时间戳，用于滑动窗口频率限制。
 */
const requestWindowStore = new Map<string, number[]>()

/**
 * 登录失败态：
 * - 分别按“来源 IP”和“账号/手机号”记录；
 * - 同时限制来源与目标账号，可降低密码爆破和撞库的成功率。
 */
const failureStateStore = new Map<string, FailureState>()

const normalizeRiskSource = (meta?: RequestMeta) => meta?.ipAddress?.trim() || 'unknown-ip'

export class AuthSecurityService {
  private trimRateLimitWindow(timestamps: number[], windowMs: number, nowMs: number) {
    return timestamps.filter((timestamp) => nowMs - timestamp < windowMs)
  }

  private async recordRiskEvent(input: {
    actionType: string
    actionLabel: string
    targetCode?: string | null
    requestMeta?: RequestMeta
    detail?: Record<string, unknown>
  }) {
    await auditService.safeRecord({
      actionType: input.actionType,
      actionLabel: input.actionLabel,
      targetType: 'security_guard',
      targetCode: input.targetCode ?? null,
      resultStatus: 'failed',
      requestMeta: input.requestMeta,
      detail: input.detail ?? null,
    })
  }

  private async consumeRateLimit(
    bucketKey: string,
    rule: RateLimitRule,
    auditInput: {
      actionType: string
      actionLabel: string
      targetCode?: string | null
      requestMeta?: RequestMeta
      detail?: Record<string, unknown>
    },
  ) {
    const nowMs = Date.now()
    const existing = requestWindowStore.get(bucketKey) ?? []
    const activeWindow = this.trimRateLimitWindow(existing, rule.windowMs, nowMs)
    if (activeWindow.length >= rule.maxRequests) {
      const waitMs = rule.windowMs - (nowMs - activeWindow[0])
      await this.recordRiskEvent({
        ...auditInput,
        detail: {
          ...(auditInput.detail ?? {}),
          reason: 'rate_limit',
          waitSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
        },
      })
      throw new BizError(`${rule.blockMessage}（约 ${Math.max(1, Math.ceil(waitMs / 1000))} 秒后重试）`, 429)
    }
    activeWindow.push(nowMs)
    requestWindowStore.set(bucketKey, activeWindow)
  }

  private getFailureState(storeKey: string, scope: FailureScope, nowMs: number) {
    const state = failureStateStore.get(storeKey)
    if (!state) {
      return null
    }
    if (nowMs - state.lastFailedAt >= FAILURE_RESET_WINDOW_MS[scope] && state.lockedUntil <= nowMs) {
      failureStateStore.delete(storeKey)
      return null
    }
    return state
  }

  private async assertFailureNotLocked(
    scope: FailureScope,
    storeKey: string,
    requestMeta: RequestMeta | undefined,
    targetCode: string,
  ) {
    const nowMs = Date.now()
    const state = this.getFailureState(storeKey, scope, nowMs)
    if (!state || state.lockedUntil <= nowMs) {
      return
    }
    const waitSeconds = Math.max(1, Math.ceil((state.lockedUntil - nowMs) / 1000))
    await this.recordRiskEvent({
      actionType: 'auth.guard.locked',
      actionLabel: '认证请求被临时锁定',
      targetCode,
      requestMeta,
      detail: {
        scope,
        waitSeconds,
      },
    })
    throw new BizError(`尝试次数过多，已临时锁定，请 ${waitSeconds} 秒后再试`, 429)
  }

  private async recordLoginFailure(
    scope: FailureScope,
    requestMeta: RequestMeta | undefined,
    subject: string,
    sourceKey: string,
    subjectKey: string,
  ) {
    const nowMs = Date.now()
    for (const storeKey of [sourceKey, subjectKey]) {
      const current = this.getFailureState(storeKey, scope, nowMs)
      const next: FailureState = current
        ? {
            ...current,
            count: current.count + 1,
            lastFailedAt: nowMs,
          }
        : {
            count: 1,
            firstFailedAt: nowMs,
            lastFailedAt: nowMs,
            lockedUntil: 0,
          }
      if (next.count >= FAILURE_LOCK_THRESHOLD[scope]) {
        next.lockedUntil = nowMs + FAILURE_LOCK_MS[scope]
      }
      failureStateStore.set(storeKey, next)
    }

    const currentSubjectState = failureStateStore.get(subjectKey)
    if (currentSubjectState?.lockedUntil && currentSubjectState.lockedUntil > nowMs) {
      await this.recordRiskEvent({
        actionType: 'auth.guard.lock',
        actionLabel: '登录失败触发临时锁定',
        targetCode: subject,
        requestMeta,
        detail: {
          scope,
          failedCount: currentSubjectState.count,
          lockedSeconds: Math.max(1, Math.ceil((currentSubjectState.lockedUntil - nowMs) / 1000)),
        },
      })
    }
  }

  private clearLoginFailures(sourceKey: string, subjectKey: string) {
    failureStateStore.delete(sourceKey)
    failureStateStore.delete(subjectKey)
  }

  async guardAdminLoginRequest(requestMeta: RequestMeta | undefined, username: string) {
    const source = normalizeRiskSource(requestMeta)
    const normalizedUsername = username.trim().toLowerCase()
    await this.consumeRateLimit(`admin-login:ip:${source}`, RATE_LIMIT_RULES.adminLoginByIp, {
      actionType: 'auth.guard.admin_login',
      actionLabel: '管理端登录频控',
      targetCode: normalizedUsername,
      requestMeta,
      detail: { source },
    })
    await this.assertFailureNotLocked('admin-login', `admin-login:ip:${source}`, requestMeta, normalizedUsername)
    await this.assertFailureNotLocked('admin-login', `admin-login:user:${normalizedUsername}`, requestMeta, normalizedUsername)
  }

  async recordAdminLoginFailure(requestMeta: RequestMeta | undefined, username: string) {
    const source = normalizeRiskSource(requestMeta)
    const normalizedUsername = username.trim().toLowerCase()
    await this.recordLoginFailure(
      'admin-login',
      requestMeta,
      normalizedUsername,
      `admin-login:ip:${source}`,
      `admin-login:user:${normalizedUsername}`,
    )
  }

  clearAdminLoginFailures(requestMeta: RequestMeta | undefined, username: string) {
    const source = normalizeRiskSource(requestMeta)
    const normalizedUsername = username.trim().toLowerCase()
    this.clearLoginFailures(`admin-login:ip:${source}`, `admin-login:user:${normalizedUsername}`)
  }

  async guardClientCaptchaRequest(requestMeta: RequestMeta | undefined) {
    const source = normalizeRiskSource(requestMeta)
    await this.consumeRateLimit(`client-captcha:ip:${source}`, RATE_LIMIT_RULES.captchaByIp, {
      actionType: 'client.auth.guard.captcha',
      actionLabel: '客户端验证码频控',
      requestMeta,
      detail: { source },
    })
  }

  async guardClientRegisterRequest(requestMeta: RequestMeta | undefined, mobile: string) {
    const source = normalizeRiskSource(requestMeta)
    await this.consumeRateLimit(`client-register:ip:${source}`, RATE_LIMIT_RULES.clientRegisterByIp, {
      actionType: 'client.auth.guard.register',
      actionLabel: '客户端注册频控',
      targetCode: mobile,
      requestMeta,
      detail: { source },
    })
    await this.consumeRateLimit(`client-register:mobile:${mobile}`, RATE_LIMIT_RULES.clientRegisterByMobile, {
      actionType: 'client.auth.guard.register',
      actionLabel: '客户端注册频控',
      targetCode: mobile,
      requestMeta,
      detail: { source, dimension: 'mobile' },
    })
  }

  async guardClientForgotVerifyRequest(requestMeta: RequestMeta | undefined, mobile: string) {
    const source = normalizeRiskSource(requestMeta)
    await this.consumeRateLimit(`client-forgot-verify:ip:${source}`, RATE_LIMIT_RULES.clientForgotVerifyByIp, {
      actionType: 'client.auth.guard.forgot_verify',
      actionLabel: '客户端找回密码校验频控',
      targetCode: mobile,
      requestMeta,
      detail: { source },
    })
    await this.consumeRateLimit(`client-forgot-verify:mobile:${mobile}`, RATE_LIMIT_RULES.clientForgotVerifyByMobile, {
      actionType: 'client.auth.guard.forgot_verify',
      actionLabel: '客户端找回密码校验频控',
      targetCode: mobile,
      requestMeta,
      detail: { source, dimension: 'mobile' },
    })
  }

  async guardClientForgotResetRequest(requestMeta: RequestMeta | undefined, mobile: string) {
    const source = normalizeRiskSource(requestMeta)
    await this.consumeRateLimit(`client-forgot-reset:ip:${source}`, RATE_LIMIT_RULES.clientForgotResetByIp, {
      actionType: 'client.auth.guard.forgot_reset',
      actionLabel: '客户端重置密码频控',
      targetCode: mobile,
      requestMeta,
      detail: { source },
    })
  }

  async guardClientLoginRequest(requestMeta: RequestMeta | undefined, mobile: string) {
    const source = normalizeRiskSource(requestMeta)
    await this.consumeRateLimit(`client-login:ip:${source}`, RATE_LIMIT_RULES.clientLoginByIp, {
      actionType: 'client.auth.guard.login',
      actionLabel: '客户端登录频控',
      targetCode: mobile,
      requestMeta,
      detail: { source },
    })
    await this.assertFailureNotLocked('client-login', `client-login:ip:${source}`, requestMeta, mobile)
    await this.assertFailureNotLocked('client-login', `client-login:mobile:${mobile}`, requestMeta, mobile)
  }

  async recordClientLoginFailure(requestMeta: RequestMeta | undefined, mobile: string) {
    const source = normalizeRiskSource(requestMeta)
    await this.recordLoginFailure(
      'client-login',
      requestMeta,
      mobile,
      `client-login:ip:${source}`,
      `client-login:mobile:${mobile}`,
    )
  }

  clearClientLoginFailures(requestMeta: RequestMeta | undefined, mobile: string) {
    const source = normalizeRiskSource(requestMeta)
    this.clearLoginFailures(`client-login:ip:${source}`, `client-login:mobile:${mobile}`)
  }
}

export const authSecurityService = new AuthSecurityService()
