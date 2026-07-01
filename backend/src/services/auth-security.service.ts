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

interface RateLimitConsumeResult {
  remainingRequests: number
  maxRequests: number
}

interface LoginFailureRecordResult {
  remainingAttempts: number
  shouldWarnRemaining: boolean
  lockTriggered: boolean
}

interface RegisterSourceGuardResult {
  remainingAttempts: number
  shouldWarnRemaining: boolean
  maxAttempts: number
  sourceType: ClientRiskActor['sourceType']
}

interface RateLimitRule {
  maxRequests: number
  windowMs: number
  blockMessage: string
}

interface ClientRiskActor {
  source: string
  sourceType: 'session' | 'browser' | 'ip'
  bucketSegment: string
}

const RATE_LIMIT_RULES = {
  adminLoginByIp: {
    maxRequests: 12,
    windowMs: 5 * 60 * 1000,
    blockMessage: '登录尝试过于频繁，请稍后再试',
  },
  clientLoginBySource: {
    maxRequests: 18,
    windowMs: 5 * 60 * 1000,
    blockMessage: '登录尝试过于频繁，请稍后再试',
  },
  clientLoginByIpFallback: {
    maxRequests: 120,
    windowMs: 5 * 60 * 1000,
    blockMessage: '当前网络下登录请求过于频繁，请稍后再试',
  },
  clientRegisterBySource: {
    maxRequests: 40,
    windowMs: 30 * 60 * 1000,
    blockMessage: '注册请求过于频繁，请稍后再试',
  },
  clientRegisterByIpFallback: {
    maxRequests: 300,
    windowMs: 30 * 60 * 1000,
    blockMessage: '当前网络下注册请求过于频繁，请稍后再试',
  },
  clientRegisterByAccount: {
    maxRequests: 10,
    windowMs: 24 * 60 * 60 * 1000,
    blockMessage: '该账号注册尝试过于频繁，请明天再试',
  },
  clientForgotVerifyBySource: {
    maxRequests: 8,
    windowMs: 30 * 60 * 1000,
    blockMessage: '找回密码校验请求过于频繁，请稍后再试',
  },
  clientForgotVerifyByIpFallback: {
    maxRequests: 48,
    windowMs: 30 * 60 * 1000,
    blockMessage: '当前网络下找回密码校验请求过于频繁，请稍后再试',
  },
  clientForgotVerifyByAccount: {
    maxRequests: 5,
    windowMs: 30 * 60 * 1000,
    blockMessage: '该账号找回密码尝试过于频繁，请稍后再试',
  },
  clientForgotResetBySource: {
    maxRequests: 8,
    windowMs: 30 * 60 * 1000,
    blockMessage: '重置密码请求过于频繁，请稍后再试',
  },
  clientForgotResetByIpFallback: {
    maxRequests: 48,
    windowMs: 30 * 60 * 1000,
    blockMessage: '当前网络下重置密码请求过于频繁，请稍后再试',
  },
  // clientForgotResetByAccount：客户端忘记密码完成重置的最后一步，按账号限频，避免同一账号被重复撞库或脚本化重置。
  clientForgotResetByAccount: {
    maxRequests: 5,
    windowMs: 30 * 60 * 1000,
    blockMessage: '该账号重置密码请求过于频繁，请稍后再试',
  },
  // clientChangePasswordByIp：客户端已登录后修改密码，按来源 IP 限频，降低同设备高频试探或批量脚本请求风险。
  clientChangePasswordByIp: {
    maxRequests: 10,
    windowMs: 10 * 60 * 1000,
    blockMessage: '修改密码请求过于频繁，请稍后再试',
  },
  // clientChangePasswordByUser：客户端已登录后修改密码，按当前用户限频，避免单账号短时间内反复改密触发异常行为。
  clientChangePasswordByUser: {
    maxRequests: 5,
    windowMs: 10 * 60 * 1000,
    blockMessage: '当前账号修改密码过于频繁，请稍后再试',
  },
  // clientProfileUpdateByIp：客户端资料维护操作，按来源 IP 限频，用于抑制批量资料写入或自动化刷接口。
  clientProfileUpdateByIp: {
    maxRequests: 20,
    windowMs: 10 * 60 * 1000,
    blockMessage: '资料更新请求过于频繁，请稍后再试',
  },
  // clientProfileUpdateByUser：客户端资料维护操作，按当前用户限频，避免单账号在短窗口内反复修改资料。
  clientProfileUpdateByUser: {
    maxRequests: 10,
    windowMs: 10 * 60 * 1000,
    blockMessage: '当前账号资料更新过于频繁，请稍后再试',
  },
  captchaBySource: {
    maxRequests: 40,
    windowMs: 10 * 60 * 1000,
    blockMessage: '验证码请求过于频繁，请稍后再试',
  },
  captchaByIpFallback: {
    maxRequests: 120,
    windowMs: 10 * 60 * 1000,
    blockMessage: '当前网络下验证码请求过于频繁，请稍后再试',
  },
  verificationCodeSendBySource: {
    maxRequests: 8,
    windowMs: 10 * 60 * 1000,
    blockMessage: '验证码发送过于频繁，请稍后再试',
  },
  verificationCodeSendByIpFallback: {
    maxRequests: 40,
    windowMs: 10 * 60 * 1000,
    blockMessage: '当前网络下验证码发送过于频繁，请稍后再试',
  },
  verificationCodeSendByTarget: {
    maxRequests: 5,
    windowMs: 10 * 60 * 1000,
    blockMessage: '该账号验证码发送过于频繁，请稍后再试',
  },
  staffDirectoryLookupBySource: {
    maxRequests: 20,
    windowMs: 10 * 60 * 1000,
    blockMessage: '工号目录查询过于频繁，请稍后再试',
  },
  staffDirectoryLookupByIpFallback: {
    maxRequests: 80,
    windowMs: 10 * 60 * 1000,
    blockMessage: '当前网络下工号目录查询过于频繁，请稍后再试',
  },
} as const satisfies Record<string, RateLimitRule>

const FAILURE_LOCK_THRESHOLD = {
  'admin-login': 5,
  'client-login': 8,
} as const satisfies Record<FailureScope, number>

const FAILURE_LOCK_MS = {
  'admin-login': 15 * 60 * 1000,
  'client-login': 5 * 60 * 1000,
} as const satisfies Record<FailureScope, number>

const FAILURE_RESET_WINDOW_MS = {
  'admin-login': 15 * 60 * 1000,
  'client-login': 15 * 60 * 1000,
} as const satisfies Record<FailureScope, number>

const LOGIN_REMAINING_WARNING_RATIO = 0.2
const REGISTER_REMAINING_WARNING_THRESHOLD = 3
const MAX_RATE_LIMIT_BUCKETS = 10000
const MAX_FAILURE_STATE_BUCKETS = 5000
const STORE_CLEANUP_INTERVAL_MS = 60 * 1000
const MAX_RATE_LIMIT_WINDOW_MS = Math.max(...Object.values(RATE_LIMIT_RULES).map((rule) => rule.windowMs))

let lastStoreCleanupAt = 0

/**
 * 内存态时间窗口记录：
 * - key 一般由“接口 + 浏览器会话/浏览器实例/IP”或“接口 + 账号/手机号”组成；
 * - value 记录请求时间戳，用于滑动窗口频率限制。
 */
const requestWindowStore = new Map<string, number[]>()

/**
 * 登录失败态：
 * - 管理端继续按“来源 IP”和“账号/手机号”记录；
 * - 客户端公共认证接口按“来源 IP”和“账号/手机号”记录，避免信任未认证请求可随意伪造的浏览器风险请求头。
 */
const failureStateStore = new Map<string, FailureState>()

const normalizeRiskSource = (meta?: RequestMeta) => meta?.ipAddress?.trim() || 'unknown-ip'

export class AuthSecurityService {
  private trimRateLimitWindow(timestamps: number[], windowMs: number, nowMs: number) {
    return timestamps.filter((timestamp) => nowMs - timestamp < windowMs)
  }

  private cleanupStores(nowMs: number) {
    if (nowMs - lastStoreCleanupAt < STORE_CLEANUP_INTERVAL_MS) {
      return
    }
    lastStoreCleanupAt = nowMs

    for (const [key, timestamps] of requestWindowStore) {
      const activeWindow = this.trimRateLimitWindow(timestamps, MAX_RATE_LIMIT_WINDOW_MS, nowMs)
      if (activeWindow.length) {
        requestWindowStore.set(key, activeWindow)
      } else {
        requestWindowStore.delete(key)
      }
    }

    for (const [key, state] of failureStateStore) {
      const isExpired =
        state.lockedUntil <= nowMs &&
        nowMs - state.lastFailedAt >= Math.max(...Object.values(FAILURE_RESET_WINDOW_MS))
      if (isExpired) {
        failureStateStore.delete(key)
      }
    }

    this.evictOldestEntries(requestWindowStore, MAX_RATE_LIMIT_BUCKETS)
    this.evictOldestEntries(failureStateStore, MAX_FAILURE_STATE_BUCKETS)
  }

  private evictOldestEntries(store: Map<string, unknown>, maxSize: number) {
    while (store.size > maxSize) {
      const oldestKey = store.keys().next().value
      if (oldestKey === undefined) {
        return
      }
      store.delete(oldestKey)
    }
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
  ): Promise<RateLimitConsumeResult> {
    const nowMs = Date.now()
    this.cleanupStores(nowMs)
    const existing = requestWindowStore.get(bucketKey) ?? []
    const activeWindow = this.trimRateLimitWindow(existing, rule.windowMs, nowMs)
    if (activeWindow.length >= rule.maxRequests) {
      const waitMs = rule.windowMs - (nowMs - activeWindow[0])
      const riskDetail: Record<string, unknown> = {
        reason: 'rate_limit',
        waitSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
      }
      if (auditInput.detail) {
        Object.assign(riskDetail, auditInput.detail)
      }
      await this.recordRiskEvent({
        ...auditInput,
        detail: riskDetail,
      })
      throw new BizError(`${rule.blockMessage}（约 ${Math.max(1, Math.ceil(waitMs / 1000))} 秒后重试）`, 429)
    }
    activeWindow.push(nowMs)
    requestWindowStore.set(bucketKey, activeWindow)
    this.evictOldestEntries(requestWindowStore, MAX_RATE_LIMIT_BUCKETS)
    return {
      remainingRequests: Math.max(0, rule.maxRequests - activeWindow.length),
      maxRequests: rule.maxRequests,
    }
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
  ): Promise<LoginFailureRecordResult> {
    const nowMs = Date.now()
    this.cleanupStores(nowMs)
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
    this.evictOldestEntries(failureStateStore, MAX_FAILURE_STATE_BUCKETS)

    const currentSubjectState = failureStateStore.get(subjectKey)
    const remainingAttempts = Math.max(0, FAILURE_LOCK_THRESHOLD[scope] - (currentSubjectState?.count ?? 0))
    const shouldWarnRemaining =
      remainingAttempts > 0 &&
      remainingAttempts <= Math.max(1, Math.ceil(FAILURE_LOCK_THRESHOLD[scope] * LOGIN_REMAINING_WARNING_RATIO))
    const lockTriggered = Boolean(currentSubjectState?.lockedUntil && currentSubjectState.lockedUntil > nowMs)
    if (lockTriggered && currentSubjectState) {
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

    return {
      remainingAttempts,
      shouldWarnRemaining,
      lockTriggered,
    }
  }

  private clearLoginFailures(sourceKey: string, subjectKey: string) {
    failureStateStore.delete(sourceKey)
    failureStateStore.delete(subjectKey)
  }

  private hasActiveFailures(scope: FailureScope, storeKey: string) {
    const nowMs = Date.now()
    const state = this.getFailureState(storeKey, scope, nowMs)
    return Boolean(state && state.count > 0)
  }

  private resolveClientRiskActor(requestMeta?: RequestMeta): ClientRiskActor {
    /**
     * 客户端风控请求头来自未认证客户端，不能作为频控桶或登录失败锁定的主键。
     * 这里保留 RequestMeta 中的浏览器/会话标识供审计排查使用，但认证防护主链路只按服务端解析出的 IP 聚合，
     * 避免攻击者轮换 `x-client-risk-session-id` / `x-client-risk-browser-id` 绕过失败态或制造无界内存键。
     */
    const ipAddress = normalizeRiskSource(requestMeta)
    return {
      source: ipAddress,
      sourceType: 'ip',
      bucketSegment: `ip:${ipAddress}`,
    }
  }

  private async consumeClientSourceRateLimit(
    baseBucketKey: string,
    primaryRule: RateLimitRule,
    ipFallbackRule: RateLimitRule,
    auditInput: {
      actionType: string
      actionLabel: string
      targetCode?: string | null
      requestMeta?: RequestMeta
      detail?: Record<string, unknown>
    },
  ): Promise<RateLimitConsumeResult> {
    const riskActor = this.resolveClientRiskActor(auditInput.requestMeta)
    const primaryDetail = auditInput.detail
      ? {
          ...auditInput.detail,
          source: riskActor.source,
          sourceType: riskActor.sourceType,
        }
      : {
          source: riskActor.source,
          sourceType: riskActor.sourceType,
        }

    const primaryConsumeResult = await this.consumeRateLimit(`${baseBucketKey}:${riskActor.bucketSegment}`, primaryRule, {
      ...auditInput,
      detail: primaryDetail,
    })

    const ipAddress = normalizeRiskSource(auditInput.requestMeta)
    if (riskActor.sourceType === 'ip' || ipAddress === 'unknown-ip') {
      return primaryConsumeResult
    }

    const fallbackDetail = auditInput.detail
      ? {
          ...auditInput.detail,
          source: ipAddress,
          sourceType: 'ip_fallback',
          primarySourceType: riskActor.sourceType,
        }
      : {
          source: ipAddress,
          sourceType: 'ip_fallback',
          primarySourceType: riskActor.sourceType,
        }

    await this.consumeRateLimit(`${baseBucketKey}:ip-fallback:${ipAddress}`, ipFallbackRule, {
      ...auditInput,
      detail: fallbackDetail,
    })

    return primaryConsumeResult
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

  async guardAdminCaptchaRequest(requestMeta: RequestMeta | undefined) {
    const source = normalizeRiskSource(requestMeta)
    await this.consumeRateLimit(`admin-captcha:ip:${source}`, RATE_LIMIT_RULES.captchaBySource, {
      actionType: 'auth.guard.admin_captcha',
      actionLabel: '管理端图形验证码频控',
      requestMeta,
      detail: { source },
    })
  }

  isAdminLoginCaptchaRequired(requestMeta: RequestMeta | undefined, username: string) {
    const source = normalizeRiskSource(requestMeta)
    const normalizedUsername = username.trim().toLowerCase()
    return (
      this.hasActiveFailures('admin-login', `admin-login:ip:${source}`) ||
      this.hasActiveFailures('admin-login', `admin-login:user:${normalizedUsername}`)
    )
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
    await this.consumeClientSourceRateLimit('client-captcha', RATE_LIMIT_RULES.captchaBySource, RATE_LIMIT_RULES.captchaByIpFallback, {
      actionType: 'client.auth.guard.captcha',
      actionLabel: '客户端验证码频控',
      requestMeta,
      detail: {},
    })
  }

  async guardStaffDirectoryLookupRequest(requestMeta: RequestMeta | undefined, staffNo: string) {
    await this.consumeClientSourceRateLimit(
      'staff-directory-lookup',
      RATE_LIMIT_RULES.staffDirectoryLookupBySource,
      RATE_LIMIT_RULES.staffDirectoryLookupByIpFallback,
      {
        actionType: 'client.auth.guard.staff_directory_lookup',
        actionLabel: '客户端工号目录查询频控',
        targetCode: staffNo,
        requestMeta,
        detail: {},
      },
    )
  }

  async guardVerificationCodeSendRequest(requestMeta: RequestMeta | undefined, target: string, channel: 'mobile' | 'email') {
    const riskActor = this.resolveClientRiskActor(requestMeta)
    await this.consumeClientSourceRateLimit(
      'verification-send',
      RATE_LIMIT_RULES.verificationCodeSendBySource,
      RATE_LIMIT_RULES.verificationCodeSendByIpFallback,
      {
      actionType: 'client.auth.guard.verification_send',
      actionLabel: '验证码发送频控',
      targetCode: target,
      requestMeta,
      detail: { channel },
    })
    await this.consumeRateLimit(`verification-send:${channel}:${target}`, RATE_LIMIT_RULES.verificationCodeSendByTarget, {
      actionType: 'client.auth.guard.verification_send',
      actionLabel: '验证码发送频控',
      targetCode: target,
      requestMeta,
      detail: { source: riskActor.source, sourceType: riskActor.sourceType, channel, dimension: 'target' },
    })
  }

  /**
   * 客户端注册来源频控：
   * - 只负责浏览器会话 / 浏览器实例 / IP 这一层的注册来源频控；
   * - 账号 24 小时额度由单独方法处理，便于在确认账号未占用后再记账。
   */
  async guardClientRegisterSourceRequest(requestMeta: RequestMeta | undefined, accountKey: string): Promise<RegisterSourceGuardResult> {
    const riskActor = this.resolveClientRiskActor(requestMeta)
    const consumeResult = await this.consumeClientSourceRateLimit(
      'client-register',
      RATE_LIMIT_RULES.clientRegisterBySource,
      RATE_LIMIT_RULES.clientRegisterByIpFallback,
      {
      actionType: 'client.auth.guard.register',
      actionLabel: '客户端注册频控',
      targetCode: accountKey,
      requestMeta,
      detail: {},
    })
    return {
      remainingAttempts: consumeResult.remainingRequests,
      shouldWarnRemaining: consumeResult.remainingRequests > 0 && consumeResult.remainingRequests <= REGISTER_REMAINING_WARNING_THRESHOLD,
      maxAttempts: consumeResult.maxRequests,
      sourceType: riskActor.sourceType,
    }
  }

  /**
   * 客户端注册账号频控：
   * - 这里接收的 accountKey 必须是路由层先做过归一化后的账号键；
   * - 仅在确认账号未被占用后调用，避免“旧账号重复注册”继续消耗 24 小时额度。
   */
  async guardClientRegisterAccountRequest(requestMeta: RequestMeta | undefined, accountKey: string) {
    const riskActor = this.resolveClientRiskActor(requestMeta)
    await this.consumeRateLimit(`client-register:account:${accountKey}`, RATE_LIMIT_RULES.clientRegisterByAccount, {
      actionType: 'client.auth.guard.register',
      actionLabel: '客户端注册频控',
      targetCode: accountKey,
      requestMeta,
      detail: { source: riskActor.source, sourceType: riskActor.sourceType, dimension: 'account' },
    })
  }

  async guardClientForgotVerifyRequest(requestMeta: RequestMeta | undefined, accountKey: string) {
    const riskActor = this.resolveClientRiskActor(requestMeta)
    await this.consumeClientSourceRateLimit(
      'client-forgot-verify',
      RATE_LIMIT_RULES.clientForgotVerifyBySource,
      RATE_LIMIT_RULES.clientForgotVerifyByIpFallback,
      {
      actionType: 'client.auth.guard.forgot_verify',
      actionLabel: '客户端找回密码校验频控',
      targetCode: accountKey,
      requestMeta,
      detail: {},
    })
    await this.consumeRateLimit(`client-forgot-verify:account:${accountKey}`, RATE_LIMIT_RULES.clientForgotVerifyByAccount, {
      actionType: 'client.auth.guard.forgot_verify',
      actionLabel: '客户端找回密码校验频控',
      targetCode: accountKey,
      requestMeta,
      detail: { source: riskActor.source, sourceType: riskActor.sourceType, dimension: 'account' },
    })
  }

  async guardClientForgotResetRequest(requestMeta: RequestMeta | undefined, accountKey: string) {
    const riskActor = this.resolveClientRiskActor(requestMeta)
    await this.consumeClientSourceRateLimit(
      'client-forgot-reset',
      RATE_LIMIT_RULES.clientForgotResetBySource,
      RATE_LIMIT_RULES.clientForgotResetByIpFallback,
      {
      actionType: 'client.auth.guard.forgot_reset',
      actionLabel: '客户端重置密码频控',
      targetCode: accountKey,
      requestMeta,
      detail: {},
    })
    await this.consumeRateLimit(`client-forgot-reset:account:${accountKey}`, RATE_LIMIT_RULES.clientForgotResetByAccount, {
      actionType: 'client.auth.guard.forgot_reset',
      actionLabel: '客户端重置密码频控',
      targetCode: accountKey,
      requestMeta,
      detail: { source: riskActor.source, sourceType: riskActor.sourceType, dimension: 'account' },
    })
  }

  async guardClientLoginRequest(requestMeta: RequestMeta | undefined, accountKey: string) {
    const riskActor = this.resolveClientRiskActor(requestMeta)
    await this.consumeClientSourceRateLimit('client-login', RATE_LIMIT_RULES.clientLoginBySource, RATE_LIMIT_RULES.clientLoginByIpFallback, {
      actionType: 'client.auth.guard.login',
      actionLabel: '客户端登录频控',
      targetCode: accountKey,
      requestMeta,
      detail: {},
    })
    await this.assertFailureNotLocked('client-login', `client-login:${riskActor.bucketSegment}`, requestMeta, accountKey)
    await this.assertFailureNotLocked('client-login', `client-login:account:${accountKey}`, requestMeta, accountKey)
  }

  isClientLoginCaptchaRequired(requestMeta: RequestMeta | undefined, accountKey: string) {
    const riskActor = this.resolveClientRiskActor(requestMeta)
    return (
      this.hasActiveFailures('client-login', `client-login:${riskActor.bucketSegment}`) ||
      this.hasActiveFailures('client-login', `client-login:account:${accountKey}`)
    )
  }

  async recordClientLoginFailure(requestMeta: RequestMeta | undefined, accountKey: string) {
    const riskActor = this.resolveClientRiskActor(requestMeta)
    return this.recordLoginFailure(
      'client-login',
      requestMeta,
      accountKey,
      `client-login:${riskActor.bucketSegment}`,
      `client-login:account:${accountKey}`,
    )
  }

  clearClientLoginFailures(requestMeta: RequestMeta | undefined, accountKey: string) {
    const riskActor = this.resolveClientRiskActor(requestMeta)
    this.clearLoginFailures(`client-login:${riskActor.bucketSegment}`, `client-login:account:${accountKey}`)
  }

  async guardClientChangePasswordRequest(requestMeta: RequestMeta | undefined, userId: string) {
    const source = normalizeRiskSource(requestMeta)
    await this.consumeRateLimit(`client-change-password:ip:${source}`, RATE_LIMIT_RULES.clientChangePasswordByIp, {
      actionType: 'client.auth.guard.change_password',
      actionLabel: '客户端修改密码频控',
      targetCode: userId,
      requestMeta,
      detail: { source },
    })
    await this.consumeRateLimit(`client-change-password:user:${userId}`, RATE_LIMIT_RULES.clientChangePasswordByUser, {
      actionType: 'client.auth.guard.change_password',
      actionLabel: '客户端修改密码频控',
      targetCode: userId,
      requestMeta,
      detail: { source, dimension: 'user' },
    })
  }

  async guardClientProfileUpdateRequest(requestMeta: RequestMeta | undefined, userId: string) {
    const source = normalizeRiskSource(requestMeta)
    await this.consumeRateLimit(`client-profile-update:ip:${source}`, RATE_LIMIT_RULES.clientProfileUpdateByIp, {
      actionType: 'client.auth.guard.profile_update',
      actionLabel: '客户端资料更新频控',
      targetCode: userId,
      requestMeta,
      detail: { source },
    })
    await this.consumeRateLimit(`client-profile-update:user:${userId}`, RATE_LIMIT_RULES.clientProfileUpdateByUser, {
      actionType: 'client.auth.guard.profile_update',
      actionLabel: '客户端资料更新频控',
      targetCode: userId,
      requestMeta,
      detail: { source, dimension: 'user' },
    })
  }
}

export const authSecurityService = new AuthSecurityService()
