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
