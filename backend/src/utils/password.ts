/**
 * 文件说明：密码工具文件，统一维护客户端与管理端密码策略、强度校验、哈希生成和密码比对能力。
 * 实现逻辑：集中定义密码长度与复杂度规则，并基于安全哈希算法提供无状态的加密与校验实现。
 * 维护重点：调整密码策略或哈希参数时，需要同步核对注册、改密、找回密码和后台登录等所有入口；
 *   哈希参数随哈希一起保存，旧哈希在登录成功时透明升级，调参无需一次性迁移全部账号。
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { PASSWORD_HASH_GATE_POLICY } from '../config/load-protection-policy.js'
import { BoundedConcurrencyGate } from './bounded-concurrency.js'
import { BizError } from './errors.js'
import { isCommonWeakPassword } from './password-blocklist.js'

const PASSWORD_SALT_BYTES = 16
const PASSWORD_KEY_LENGTH = 64

interface ScryptParams {
  N: number
  r: number
  p: number
}

/** 历史格式 `salt:hash` 使用 Node 默认参数（N=2^14、r=8、p=1），约为 OWASP 基线的 1/5。 */
const LEGACY_SCRYPT_PARAMS: ScryptParams = { N: 16384, r: 8, p: 1 }
/**
 * 当前参数：OWASP 密码存储速查表给出的等价组合之一（N=2^14、r=8、p=5）。
 * 与 N=2^17/p=1 同等强度，但单次只占约 16 MiB 内存，并发登录时不易把内存打满；单次耗时仍远低于 1 秒。
 */
const CURRENT_SCRYPT_PARAMS: ScryptParams = { N: 16384, r: 8, p: 5 }
/** 旧格式校验时补做的等量计算（p=1 + p=4 ≈ p=5），让未升级账号与新格式、账号不存在时的登录耗时一致。 */
const LEGACY_TIMING_PAD_PARAMS: ScryptParams = { N: 16384, r: 8, p: 4 }
const LEGACY_TIMING_PAD_SALT = 'y-link-legacy-scrypt-timing-pad'
const CURRENT_HASH_PREFIX = 's2'
const SCRYPT_MAXMEM = 64 * 1024 * 1024

/**
 * 所有 scrypt 派生都经同一个有界并发闸门：登录洪水时线程池不会被密码派生占满，数据库查询仍有线程可用；
 * 每次派生单独申请一次（不嵌套），满载时快速返回 503，由前端提示稍后重试。
 */
const passwordHashGate = new BoundedConcurrencyGate({
  name: 'password-hash',
  ...PASSWORD_HASH_GATE_POLICY,
  busyMessage: '当前登录与密码校验请求较多，请稍后重试',
})

const deriveScryptKey = (plainPassword: string, salt: string, params: ScryptParams): Promise<Buffer> => (
  passwordHashGate.run(() => new Promise<Buffer>((resolve, reject) => {
    scryptCallback(
      plainPassword,
      salt,
      PASSWORD_KEY_LENGTH,
      { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM },
      (error, derivedKey) => (error ? reject(error) : resolve(derivedKey)),
    )
  }))
)

type ParsedPasswordHash =
  | { format: 'current'; params: ScryptParams; salt: string; hash: Buffer }
  | { format: 'legacy'; salt: string; hash: Buffer }

/**
 * 解析持久化哈希：
 * - 新格式 `s2$N$r$p$salt$hash`，参数随哈希保存，后续调参无需一次性迁移；
 * - 参数必须落在安全区间内（N 为 2 的幂且不超过 2^20），防止导入的畸形哈希制造超大计算量；
 * - 无法识别时返回 null，校验按不匹配处理。
 */
function parsePasswordHash(persistedPasswordHash: string): ParsedPasswordHash | null {
  if (persistedPasswordHash.startsWith(`${CURRENT_HASH_PREFIX}$`)) {
    const [, rawN, rawR, rawP, salt, hash] = persistedPasswordHash.split('$')
    const params = { N: Number(rawN), r: Number(rawR), p: Number(rawP) }
    const validParams = Number.isInteger(params.N) && params.N >= 1024 && params.N <= 1_048_576 && (params.N & (params.N - 1)) === 0
      && Number.isInteger(params.r) && params.r >= 1 && params.r <= 32
      && Number.isInteger(params.p) && params.p >= 1 && params.p <= 16
    if (!validParams || !salt || !hash) return null
    return { format: 'current', params, salt, hash: Buffer.from(hash, 'hex') }
  }
  const [salt, storedHash] = persistedPasswordHash.split(':')
  if (!salt || !storedHash) return null
  return { format: 'legacy', salt, hash: Buffer.from(storedHash, 'hex') }
}

const isWeakerThanCurrent = (params: ScryptParams) => (
  params.N * params.r * params.p < CURRENT_SCRYPT_PARAMS.N * CURRENT_SCRYPT_PARAMS.r * CURRENT_SCRYPT_PARAMS.p
  || params.N < CURRENT_SCRYPT_PARAMS.N
)
export const CLIENT_PASSWORD_POLICY_MIN_LENGTH = 8
export const ADMIN_PASSWORD_POLICY_MIN_LENGTH = 8
/** NIST SP 800-63B-4 要求至少允许 64 位；上限同时约束单次哈希输入规模。 */
export const PASSWORD_POLICY_MAX_LENGTH = 64

export interface PasswordPolicyContext {
  /** 用户名、手机号、邮箱、工号等账号标识：新密码不得包含其中任一（长度不少于 4 时比较，邮箱另比较 @ 前部分）。 */
  identifiers?: Array<string | null | undefined>
}

const MIN_DISTINCT_PASSWORD_CHARACTERS = 4
const SERVICE_NAME_TOKENS = ['ylink', 'y-link']

const expandPasswordIdentifier = (identifier: string | null | undefined): string[] => {
  const normalized = (identifier ?? '').trim().toLowerCase()
  if (!normalized) return []
  const atIndex = normalized.indexOf('@')
  return atIndex > 0 ? [normalized, normalized.slice(0, atIndex)] : [normalized]
}

/**
 * NIST SP 800-63B-4 口令检查（仅用于新设或修改密码，存量密码照常登录）：
 * - 长度上限、字符种类过少（如 aaaa1111）、常见弱口令黑名单（整串比较）；
 * - 不得包含系统名称或本账号的用户名、手机号、邮箱、工号等可预期信息。
 */
function assertPasswordNotPredictable(normalizedPassword: string, fieldLabel: string, context: PasswordPolicyContext) {
  if (normalizedPassword.length > PASSWORD_POLICY_MAX_LENGTH) {
    throw new BizError(`${fieldLabel}长度不能超过 ${PASSWORD_POLICY_MAX_LENGTH} 位`, 400)
  }
  const lowered = normalizedPassword.toLowerCase()
  if (new Set(Array.from(lowered)).size < MIN_DISTINCT_PASSWORD_CHARACTERS) {
    throw new BizError(`${fieldLabel}过于简单，请避免大量重复字符`, 400)
  }
  if (isCommonWeakPassword(lowered)) {
    throw new BizError(`${fieldLabel}属于常见弱口令，容易被猜中，请更换`, 400)
  }
  if (SERVICE_NAME_TOKENS.some((token) => lowered.includes(token))) {
    throw new BizError(`${fieldLabel}不能包含系统名称`, 400)
  }
  assertPasswordAvoidsAccountIdentifiers(normalizedPassword, fieldLabel, context.identifiers ?? [])
}

/**
 * 新密码不得包含本账号的用户名、手机号、邮箱（及 @ 前部分）、工号等标识。
 * 管理员为他人设置密码时目标账号在事务内才加载，可在加载后单独调用本函数。
 */
export function assertPasswordAvoidsAccountIdentifiers(
  normalizedPassword: string,
  fieldLabel: string,
  identifiers: Array<string | null | undefined>,
): void {
  const lowered = normalizedPassword.toLowerCase()
  const identifierHit = identifiers
    .flatMap(expandPasswordIdentifier)
    .some((identifier) => identifier.length >= 4 && lowered.includes(identifier))
  if (identifierHit) {
    throw new BizError(`${fieldLabel}不能包含用户名、手机号、邮箱或工号等账号信息`, 400)
  }
}

/**
 * 客户端统一密码策略说明：
 * - 仅对真正提交到后端的密码做 `trim` 归一化，避免首尾空格造成“看起来一致、实际不一致”；
 * - 当前策略要求至少 8 位，且必须同时包含字母与数字；
 * - 若后续要扩展特殊字符、黑名单词等规则，只在这里集中追加即可。
 */
export function normalizePassword(plainPassword: string): string {
  return plainPassword.trim()
}

/**
 * 判断客户端密码是否满足统一策略：
 * - 该方法只返回布尔结果，便于路由层和服务层共用；
 * - 路由层可据此做请求拦截，服务层仍应继续调用断言方法兜底。
 */
export function isClientPasswordPolicySatisfied(plainPassword: string): boolean {
  const normalizedPassword = normalizePassword(plainPassword)
  return (
    normalizedPassword.length >= CLIENT_PASSWORD_POLICY_MIN_LENGTH &&
    /[A-Za-z]/.test(normalizedPassword) &&
    /\d/.test(normalizedPassword)
  )
}

/**
 * 生成统一的客户端密码策略报错文案：
 * - 允许调用方传入“密码 / 新密码”等字段名，保证不同入口的提示语义自然；
 * - 文案集中后，前后端联调时也更容易保持一致。
 */
export function getClientPasswordPolicyMessage(fieldLabel = '密码'): string {
  return `${fieldLabel}至少 ${CLIENT_PASSWORD_POLICY_MIN_LENGTH} 位，且需包含字母和数字`
}

/**
 * 对客户端密码执行统一断言：
 * - 服务层应始终调用该方法，避免绕过路由直接调用服务时失去约束；
 * - 断言通过后返回归一化后的密码，便于后续直接参与哈希。
 */
export function assertClientPasswordPolicy(
  plainPassword: string,
  fieldLabel = '密码',
  context: PasswordPolicyContext = {},
): string {
  const normalizedPassword = normalizePassword(plainPassword)
  if (!isClientPasswordPolicySatisfied(normalizedPassword)) {
    throw new BizError(getClientPasswordPolicyMessage(fieldLabel), 400)
  }
  assertPasswordNotPredictable(normalizedPassword, fieldLabel, context)
  return normalizedPassword
}

export function isAdminPasswordPolicySatisfied(plainPassword: string): boolean {
  const normalizedPassword = normalizePassword(plainPassword)
  return (
    normalizedPassword.length >= ADMIN_PASSWORD_POLICY_MIN_LENGTH &&
    /[A-Za-z]/.test(normalizedPassword) &&
    /\d/.test(normalizedPassword)
  )
}

export function getAdminPasswordPolicyMessage(fieldLabel = '密码'): string {
  return `${fieldLabel}至少 ${ADMIN_PASSWORD_POLICY_MIN_LENGTH} 位，且需包含字母和数字`
}

export function assertAdminPasswordPolicy(
  plainPassword: string,
  fieldLabel = '密码',
  context: PasswordPolicyContext = {},
): string {
  const normalizedPassword = normalizePassword(plainPassword)
  if (!isAdminPasswordPolicySatisfied(normalizedPassword)) {
    throw new BizError(getAdminPasswordPolicyMessage(fieldLabel), 400)
  }
  assertPasswordNotPredictable(normalizedPassword, fieldLabel, context)
  return normalizedPassword
}

/**
 * 生成密码哈希：
 * - 使用 Node.js 原生 scrypt（生产镜像固定 Node 22，原生 Argon2 需 Node 24.19+，暂不可用），不引入第三方依赖；
 * - 以 `s2$N$r$p$salt$hash` 格式持久化，参数随哈希保存。
 */
export async function hashPassword(plainPassword: string): Promise<string> {
  const normalizedPassword = normalizePassword(plainPassword)
  const salt = randomBytes(PASSWORD_SALT_BYTES).toString('hex')
  const { N, r, p } = CURRENT_SCRYPT_PARAMS
  const derivedKey = await deriveScryptKey(normalizedPassword, salt, CURRENT_SCRYPT_PARAMS)
  return `${CURRENT_HASH_PREFIX}$${N}$${r}$${p}$${salt}$${derivedKey.toString('hex')}`
}

// 不存在账号也执行同等 scrypt 工作量，减少按登录耗时枚举账号的信号。
let nonexistentAccountHashPromise: Promise<string> | null = null

export async function verifyPasswordForNonexistentAccount(plainPassword: string): Promise<void> {
  // 计时用哈希只在首次需要时生成；派生闸门满载等失败不能被缓存，否则此后所有不存在账号的登录都会返回 503，
  // 既误伤正常用户，又与存在账号的 401 形成可区分信号。失败时清空缓存，下次请求重新生成。
  nonexistentAccountHashPromise ??= hashPassword('y-link-nonexistent-account-timing-only').catch((error: unknown) => {
    nonexistentAccountHashPromise = null
    throw error
  })
  await verifyPassword(plainPassword, await nonexistentAccountHashPromise)
}

/**
 * 校验密码并告知是否需要升级哈希：
 * - 使用 timingSafeEqual 避免因字符串比较短路引入时序侧信道；
 * - 旧格式校验后补做等量计算，保持与新格式一致的耗时；匹配成功时 needsRehash=true，由登录流程透明升级；
 * - 历史数据格式异常时直接返回不匹配，避免抛出底层异常影响登录接口稳定性。
 */
export async function verifyPasswordDetailed(
  plainPassword: string,
  persistedPasswordHash: string,
): Promise<{ matched: boolean; needsRehash: boolean }> {
  const parsed = parsePasswordHash(persistedPasswordHash)
  if (!parsed) {
    return { matched: false, needsRehash: false }
  }
  const normalizedPassword = normalizePassword(plainPassword)
  if (parsed.format === 'legacy') {
    const derivedKey = await deriveScryptKey(normalizedPassword, parsed.salt, LEGACY_SCRYPT_PARAMS)
    await deriveScryptKey(normalizedPassword, LEGACY_TIMING_PAD_SALT, LEGACY_TIMING_PAD_PARAMS)
    const matched = parsed.hash.length === derivedKey.length && timingSafeEqual(parsed.hash, derivedKey)
    return { matched, needsRehash: matched }
  }
  const derivedKey = await deriveScryptKey(normalizedPassword, parsed.salt, parsed.params)
  const matched = parsed.hash.length === derivedKey.length && timingSafeEqual(parsed.hash, derivedKey)
  return { matched, needsRehash: matched && isWeakerThanCurrent(parsed.params) }
}

export async function verifyPassword(plainPassword: string, persistedPasswordHash: string): Promise<boolean> {
  return (await verifyPasswordDetailed(plainPassword, persistedPasswordHash)).matched
}
