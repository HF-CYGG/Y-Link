import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback)
const PASSWORD_SALT_BYTES = 16
const PASSWORD_KEY_LENGTH = 64

/**
 * 生成密码哈希：
 * - 使用 Node.js 原生 scrypt，避免额外引入第三方依赖；
 * - 以 `salt:hash` 格式持久化，便于后续统一校验。
 */
export async function hashPassword(plainPassword: string): Promise<string> {
  const normalizedPassword = plainPassword.trim()
  const salt = randomBytes(PASSWORD_SALT_BYTES).toString('hex')
  const derivedKey = (await scrypt(normalizedPassword, salt, PASSWORD_KEY_LENGTH)) as Buffer
  return `${salt}:${derivedKey.toString('hex')}`
}

/**
 * 校验密码是否匹配：
 * - 使用 timingSafeEqual 避免因字符串比较短路引入时序侧信道；
 * - 若历史数据格式异常，直接返回 false，避免抛出底层异常影响登录接口稳定性。
 */
export async function verifyPassword(plainPassword: string, persistedPasswordHash: string): Promise<boolean> {
  const [salt, storedHash] = persistedPasswordHash.split(':')
  if (!salt || !storedHash) {
    return false
  }

  const normalizedPassword = plainPassword.trim()
  const derivedKey = (await scrypt(normalizedPassword, salt, PASSWORD_KEY_LENGTH)) as Buffer
  const storedBuffer = Buffer.from(storedHash, 'hex')

  if (storedBuffer.length !== derivedKey.length) {
    return false
  }

  return timingSafeEqual(storedBuffer, derivedKey)
}
