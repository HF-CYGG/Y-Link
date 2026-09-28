/**
 * 文件说明：敏感配置落库加密工具，为验证码网关模板、飞书 Webhook/签名密钥、两步验证秘钥等“可逆密钥”提供应用层加密。
 * 实现逻辑：
 * - AES-256-GCM，每次加密使用 12 字节随机 IV；AAD 绑定字段身份（如 `system_config:verification.mobile.api_url`），
 *   密文被挪到别的字段会解密失败；
 * - 密文格式 `ylenc:v1:<密钥ID>:<base64url(IV|密文|认证标签)>`，未带前缀的历史明文按原样兼容读取；
 * - 主密钥优先取可选环境变量 `Y_LINK_DATA_ENCRYPTION_KEY`（多实例部署统一密钥用），否则读取数据目录下的
 *   `secrets/data-encryption.key`，不存在时首次使用自动生成（目录 0700、文件 0600，硬链接原子落位并同步目录项）；
 * - 解密失败（密钥丢失、被更换或密文被篡改）返回 `unreadable`，由调用方按“需重新录入”处理，不影响进程启动。
 * 维护说明：
 * - 密钥文件必须与数据库一起备份；只备份数据库、丢失密钥文件时，这些配置需要重新录入；
 * - 日志只允许输出字段名与密钥 ID，任何明文、密文与密钥本身都不得写入日志、审计或接口响应；
 * - 本工具保护的是“数据库或导出文件单独泄露”场景，拿到整个数据目录（含密钥文件）的攻击者仍可解密。
 */

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { ValueTransformer } from 'typeorm'
import { appDataPaths } from '../config/app-data-paths.js'
import { syncDirectory } from '../runtime/durable-control-file.js'
import { BizError } from './errors.js'

const SEALED_VALUE_PREFIX = 'ylenc:v1:'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_ENV_NAME = 'Y_LINK_DATA_ENCRYPTION_KEY'

export type OpenedSensitiveValue = {
  value: string
  /** empty：空值；plain：历史明文；sealed：已正确解密；unreadable：无法用当前密钥解密。 */
  state: 'empty' | 'plain' | 'sealed' | 'unreadable'
}

interface LoadedDataKey {
  key: Buffer
  keyId: string
  source: 'env' | 'file'
  filePath: string | null
  generated: boolean
}

let loadedDataKey: LoadedDataKey | null = null
const warnedUnreadableContexts = new Set<string>()

const computeKeyId = (key: Buffer) => createHash('sha256')
  .update('y-link.data-key-id.v1')
  .update(Buffer.from([0]))
  .update(key)
  .digest('hex')
  .slice(0, 8)

function decodeKeyMaterial(raw: string, label: string): Buffer {
  const text = raw.trim()
  const decoded = /^[0-9a-fA-F]{64}$/.test(text)
    ? Buffer.from(text, 'hex')
    : Buffer.from(text, 'base64')
  if (decoded.length !== KEY_BYTES) {
    throw new Error(`${label} 必须是 32 字节密钥的 base64 或 64 位十六进制编码`)
  }
  return decoded
}

function readKeyFile(filePath: string): Buffer {
  return decodeKeyMaterial(fs.readFileSync(filePath, 'utf8'), `数据加密密钥文件 ${path.basename(filePath)}`)
}

/**
 * 首次使用时生成密钥文件：先写入同目录临时文件并落盘，再用硬链接原子地放到正式路径；
 * 硬链接在目标已存在时失败，多个进程同时启动也只会有一个密钥生效，其余进程改为读取该文件。
 * 链接成功后先同步所在目录（以及本次新建的各级目录的父目录），确认正式目录项已落盘，才删除临时文件并返回：
 * 否则主机崩溃重启后正式链接可能丢失，服务会另生成一把密钥，已落库的网关、飞书与两步验证密文全部无法解密。
 * 仅导出供回归脚本在临时路径上验证落盘顺序，业务代码统一经 loadDataKey 使用。
 */
export function createDataEncryptionKeyFile(filePath: string): { key: Buffer; generated: boolean } {
  const directory = path.resolve(path.dirname(filePath))
  const firstCreatedDirectory = fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(directory, 0o700)
  } catch {
    // Windows 等不支持 POSIX 权限的文件系统忽略即可，密钥仍只写入应用数据目录。
  }
  const key = randomBytes(KEY_BYTES)
  const temporaryPath = path.join(directory, `.data-encryption.key.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  const fd = fs.openSync(temporaryPath, 'wx', 0o600)
  try {
    fs.writeSync(fd, `${key.toString('base64')}\n`)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  try {
    try {
      fs.linkSync(temporaryPath, filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return { key: readKeyFile(filePath), generated: false }
      }
      throw error
    }
    syncDirectory(directory)
    if (firstCreatedDirectory) {
      // 新建的每一级目录，其目录项都记录在父目录中，逐级同步到首个新建目录的父目录为止。
      // Windows 下 mkdirSync 返回 `\\?\` 命名空间路径，统一转成命名空间形式再比较。
      const toComparable = (item: string) => path.toNamespacedPath(path.resolve(item))
      const topCreated = toComparable(firstCreatedDirectory)
      for (let current = directory; current !== path.dirname(current); current = path.dirname(current)) {
        syncDirectory(path.dirname(current))
        if (toComparable(current) === topCreated) break
      }
    }
    return { key, generated: true }
  } finally {
    // 在上面的目录同步完成之后才删除临时名称；临时文件若因崩溃残留，只是带随机后缀的隐藏文件，不会被当作密钥读取。
    fs.rmSync(temporaryPath, { force: true })
  }
}

function loadDataKey(): LoadedDataKey {
  if (loadedDataKey) return loadedDataKey
  const envValue = process.env[KEY_ENV_NAME]?.trim()
  if (envValue) {
    const key = decodeKeyMaterial(envValue, KEY_ENV_NAME)
    loadedDataKey = { key, keyId: computeKeyId(key), source: 'env', filePath: null, generated: false }
    return loadedDataKey
  }
  const filePath = appDataPaths.dataEncryptionKeyFile
  const { key, generated } = fs.existsSync(filePath)
    ? { key: readKeyFile(filePath), generated: false }
    : createDataEncryptionKeyFile(filePath)
  loadedDataKey = { key, keyId: computeKeyId(key), source: 'file', filePath, generated }
  return loadedDataKey
}

/** 启动日志用：只返回来源与密钥 ID，不返回密钥本身；密钥不可用时返回 null（错误已单独记录）。 */
export function describeDataEncryptionKey(): { source: 'env' | 'file'; keyId: string; filePath: string | null; generated: boolean } | null {
  const loaded = tryLoadDataKey()
  if (!loaded) return null
  const { source, keyId, filePath, generated } = loaded
  return { source, keyId, filePath, generated }
}

export function isSealedSensitiveValue(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(SEALED_VALUE_PREFIX)
}

/**
 * 密钥不可用（环境变量格式错误、密钥文件损坏或不可读）时：
 * - 读取侧按 unreadable 降级，业务请求与进程启动不受影响；
 * - 写入侧拒绝保存，避免用临时生成的新密钥覆盖旧密文导致永久不可恢复。
 */
function tryLoadDataKey(): LoadedDataKey | null {
  try {
    return loadDataKey()
  } catch (error) {
    if (!warnedUnreadableContexts.has('__key__')) {
      warnedUnreadableContexts.add('__key__')
      console.error(`[data-encryption] 数据加密密钥不可用：${error instanceof Error ? error.message : '未知错误'}`)
    }
    return null
  }
}

/** 加密敏感值；空值原样返回，已是密文时不重复加密。 */
export function sealSensitiveValue(context: string, plainValue: string): string {
  if (!plainValue || isSealedSensitiveValue(plainValue)) return plainValue
  const loaded = tryLoadDataKey()
  if (!loaded) {
    throw new BizError('数据加密密钥不可用，暂时无法保存敏感配置，请检查服务端数据目录中的密钥文件', 503)
  }
  const { key, keyId } = loaded
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(context, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(plainValue, 'utf8'), cipher.final()])
  const payload = Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64url')
  return `${SEALED_VALUE_PREFIX}${keyId}:${payload}`
}

function warnUnreadableOnce(context: string, keyId: string) {
  if (warnedUnreadableContexts.has(context)) return
  warnedUnreadableContexts.add(context)
  console.warn(`[data-encryption] 字段 ${context} 的密文无法用当前数据加密密钥（ID ${keyId}）解密，已按未配置处理，请重新录入该配置`)
}

/** 解密敏感值；历史明文原样返回，无法解密时返回空值并标记 unreadable。 */
export function openSensitiveValue(context: string, storedValue: string | null | undefined): OpenedSensitiveValue {
  if (!storedValue) return { value: '', state: 'empty' }
  if (!isSealedSensitiveValue(storedValue)) return { value: storedValue, state: 'plain' }
  const loaded = tryLoadDataKey()
  if (!loaded) return { value: '', state: 'unreadable' }
  const { key, keyId } = loaded
  const body = storedValue.slice(SEALED_VALUE_PREFIX.length)
  const separatorIndex = body.indexOf(':')
  const storedKeyId = separatorIndex > 0 ? body.slice(0, separatorIndex) : ''
  try {
    if (storedKeyId !== keyId) throw new Error('KEY_ID_MISMATCH')
    const payload = Buffer.from(body.slice(separatorIndex + 1), 'base64url')
    if (payload.length < IV_BYTES + TAG_BYTES) throw new Error('PAYLOAD_TOO_SHORT')
    const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(0, IV_BYTES))
    decipher.setAAD(Buffer.from(context, 'utf8'))
    decipher.setAuthTag(payload.subarray(payload.length - TAG_BYTES))
    const plain = Buffer.concat([
      decipher.update(payload.subarray(IV_BYTES, payload.length - TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8')
    return { value: plain, state: 'sealed' }
  } catch {
    warnUnreadableOnce(context, keyId)
    return { value: '', state: 'unreadable' }
  }
}

/**
 * 实体列转换器：写入时加密、读出时解密，覆盖 Repository 的 find/insert/update 与 QueryBuilder 更新。
 * 原始 SQL（迁移逐行复制、导出）不经过转换器，密文原样流转；查询条件不得使用这些列。
 */
export function createSealedColumnTransformer(context: string): ValueTransformer {
  return {
    to: (value: string | null | undefined) => (typeof value === 'string' ? sealSensitiveValue(context, value) : value),
    from: (value: string | null | undefined) => (typeof value === 'string' ? openSensitiveValue(context, value).value : value),
  }
}

/** 从主密钥派生用途隔离的子密钥（HKDF-SHA256），如审计指纹；子密钥泄露不影响主密钥。 */
export function deriveDataSubkey(label: string): Buffer | null {
  const loaded = tryLoadDataKey()
  if (!loaded) return null
  return Buffer.from(hkdfSync('sha256', loaded.key, Buffer.from('y-link.data-subkey.v1', 'utf8'), Buffer.from(label, 'utf8'), KEY_BYTES))
}

/** 仅供同进程回归脚本切换密钥来源（如模拟密钥丢失）；不接收 HTTP 入参。 */
export function resetDataEncryptionKeyCacheForTesting(): void {
  loadedDataKey = null
  warnedUnreadableContexts.clear()
}
