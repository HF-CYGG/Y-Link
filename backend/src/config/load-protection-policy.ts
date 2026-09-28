/**
 * 文件说明：抗爆破与负载防护阈值的集中配置。
 * 实现逻辑：默认值面向单实例部署，均可用同名环境变量覆盖；读取时严格校验整数范围，非法配置在启动期直接报错，
 * 避免把未校验的部署参数带入风控与削峰逻辑（与 `client-feedback-security-policy.ts` 同一写法）。
 * 维护说明：阈值调整应同步更新文档 `42-权限、Cookie、CSRF、审计与上传安全.md` 与 `51-本地联调与部署模式.md`。
 */

import os from 'node:os'

const CPU_COUNT = Math.max(1, typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length)

function readBoundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`${name} 必须是整数`)
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} 必须在 ${minimum} 到 ${maximum} 之间`)
  }
  return value
}

function readBooleanFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase()
  if (!raw) return fallback
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new Error(`${name} 只能为 true 或 false`)
}

/**
 * 全局撞库态势（OWASP 凭证填充防御的分级响应）：
 * 同一端 5 分钟内全站登录失败达到阈值时，对该端所有登录强制图形验证码一段时间；
 * 分布式撞库时单个 IP、单个账号都可能低于各自阈值，只有全局视角能发现。
 */
export const GLOBAL_LOGIN_FAILURE_POLICY = {
  windowMs: 5 * 60 * 1000,
  captchaHoldMs: readBoundedInteger('YLINK_GLOBAL_CAPTCHA_HOLD_MINUTES', 15, 1, 24 * 60) * 60 * 1000,
  adminThreshold: readBoundedInteger('YLINK_ADMIN_GLOBAL_FAILURE_THRESHOLD', 30, 5, 100_000),
  clientThreshold: readBoundedInteger('YLINK_CLIENT_GLOBAL_FAILURE_THRESHOLD', 150, 10, 1_000_000),
} as const

/**
 * 密码派生闸门：scrypt 与 SQLite 驱动、sharp、文件读写共用 libuv 线程池（镜像内 UV_THREADPOOL_SIZE=8）。
 * 并发默认 min(4, CPU-1)，给数据库查询留出线程；登录洪水时超出排队上限或等待超时即返回 503，
 * 避免线程池被占满后正常业务查询一起卡住。
 */
export const PASSWORD_HASH_GATE_POLICY = {
  maxConcurrent: readBoundedInteger('YLINK_PASSWORD_HASH_CONCURRENCY', Math.min(4, Math.max(1, CPU_COUNT - 1)), 1, 64),
  maxQueue: readBoundedInteger('YLINK_PASSWORD_HASH_QUEUE', 64, 0, 10_000),
  queueTimeoutMs: readBoundedInteger('YLINK_PASSWORD_HASH_QUEUE_TIMEOUT_MS', 10_000, 100, 120_000),
} as const

/**
 * 商品图重编码闸门：sharp 解码与重编码同样占用线程池与大块内存，与反馈附件（独立闸门）分开限流、互不挤占。
 */
export const PRODUCT_IMAGE_GATE_POLICY = {
  maxConcurrent: readBoundedInteger('YLINK_PRODUCT_IMAGE_CONCURRENCY', 2, 1, 16),
  maxQueue: readBoundedInteger('YLINK_PRODUCT_IMAGE_QUEUE', 16, 0, 1_000),
  queueTimeoutMs: readBoundedInteger('YLINK_PRODUCT_IMAGE_QUEUE_TIMEOUT_MS', 15_000, 100, 120_000),
} as const

/**
 * 匿名认证入口（管理端 + Web 客户端的登录、验证码、注册、发码、找回）进程级在途上限：
 * 超出直接 503，不排队；移动端入口有独立契约，不纳入。
 */
export const ANONYMOUS_AUTH_IN_FLIGHT_POLICY = {
  maxInFlight: readBoundedInteger('YLINK_ANONYMOUS_AUTH_MAX_IN_FLIGHT', 64, 4, 10_000),
} as const

/** 图形验证码渲染闸门：svg-captcha + sharp 转 PNG，匿名即可触发，必须限并发。 */
export const CAPTCHA_RENDER_GATE_POLICY = {
  maxConcurrent: readBoundedInteger('YLINK_CAPTCHA_RENDER_CONCURRENCY', 4, 1, 64),
  maxQueue: readBoundedInteger('YLINK_CAPTCHA_RENDER_QUEUE', 32, 0, 1_000),
  queueTimeoutMs: readBoundedInteger('YLINK_CAPTCHA_RENDER_QUEUE_TIMEOUT_MS', 3_000, 100, 60_000),
} as const

/**
 * 过载自适应削峰：每秒采样事件循环延迟 p99 与 SQLite 写队列占用，连续 3 次越线升级、连续 5 次回落到一半以下降级。
 * elevated（延迟 ≥500ms 或写队列 ≥90%）拒绝匿名认证、新 SSE 与导出；critical（延迟 ≥1 秒持续）再拒绝读请求。
 */
const OVERLOAD_ELEVATED_LOOP_DELAY_MS = readBoundedInteger('YLINK_OVERLOAD_ELEVATED_LOOP_DELAY_MS', 500, 50, 60_000)
const OVERLOAD_CRITICAL_LOOP_DELAY_MS = readBoundedInteger('YLINK_OVERLOAD_CRITICAL_LOOP_DELAY_MS', 1_000, 100, 120_000)
if (OVERLOAD_CRITICAL_LOOP_DELAY_MS <= OVERLOAD_ELEVATED_LOOP_DELAY_MS) {
  throw new Error('YLINK_OVERLOAD_CRITICAL_LOOP_DELAY_MS 必须大于 YLINK_OVERLOAD_ELEVATED_LOOP_DELAY_MS')
}

/**
 * 按会话的请求速率保险丝（令牌桶）：容量即允许的瞬时突发（正常页面并行加载十余个接口），按每秒速率补充。
 * 只作用于管理端与 Web 客户端会话，移动端访问令牌不纳入。
 */
export const SESSION_RATE_FUSE_POLICY = {
  capacity: readBoundedInteger('YLINK_SESSION_RATE_BURST', 200, 10, 100_000),
  refillPerSecond: readBoundedInteger('YLINK_SESSION_RATE_PER_SECOND', 30, 1, 10_000),
  maxSessions: 50_000,
} as const

export const OVERLOAD_SHEDDING_POLICY = {
  enabled: readBooleanFlag('YLINK_OVERLOAD_SHEDDING_ENABLED', true),
  sampleIntervalMs: 1_000,
  elevatedLoopDelayMs: OVERLOAD_ELEVATED_LOOP_DELAY_MS,
  criticalLoopDelayMs: OVERLOAD_CRITICAL_LOOP_DELAY_MS,
  elevatedWriteQueueRatio: readBoundedInteger('YLINK_OVERLOAD_ELEVATED_WRITE_QUEUE_PERCENT', 90, 10, 100) / 100,
  enterSamples: 3,
  recoverSamples: 5,
}
