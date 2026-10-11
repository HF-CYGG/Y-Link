/**
 * 文件说明：敏感配置加密密钥的启动预检，确保“数据库里的密文”与“当前主密钥”配套。
 * 实现逻辑：
 * - 在数据源初始化后、任何业务读写之前，扫描已加密的列与仍有效的恢复码摘要元数据，
 *   取得所依赖的密钥 ID；不解密、不输出任何明文、密文或恢复码摘要；
 * - 未设置环境变量且数据目录缺少密钥文件、而库里已有密文时（典型场景：只拿 SQLite 备份在全新数据目录恢复），
 *   直接阻断启动，而不是自动生成新密钥——否则这些配置永久无法解密，开启两步验证的管理员也无法登录；
 * - 密钥文件存在但与库内密文的密钥 ID 不一致时只告警：读取侧已按“需重新录入”降级，保存侧会保留原密文。
 * 维护说明：
 * - 新增使用 `createSealedColumnTransformer` 或 `sealSensitiveValue` 落库的列时，必须登记到 SEALED_COLUMNS；
 * - 表或列尚不存在（全新库、旧库未迁移）时跳过该列，不影响首次启动自动生成密钥。
 */

import type { DataSource } from 'typeorm'
import { peekDataEncryptionKey, readSealedValueKeyId } from '../utils/data-encryption.js'

const SEALED_VALUE_PATTERN = 'ylenc:v1:%'

/** 所有经应用层加密落库的列。 */
export const SEALED_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'system_configs', column: 'config_value' },
  { table: 'notification_rule', column: 'feishu_webhook_url' },
  { table: 'notification_rule', column: 'feishu_sign_secret' },
  { table: 'sys_user_mfa', column: 'totp_secret_sealed' },
]

export interface DataEncryptionPreflightResult {
  keySource: 'env' | 'file'
  /** 当前主密钥 ID；密钥文件尚未生成时为 null（库里也没有密文，首次使用时自动生成）。 */
  keyId: string | null
  /** 库内密文涉及的全部密钥 ID。 */
  databaseKeyIds: string[]
  /** 与当前主密钥不一致、无法解密的密钥 ID。 */
  mismatchedKeyIds: string[]
}

/**
 * message 固定为稳定码：启动入口只把稳定码透传给救援进程的 /health（驱动异常可能含内部信息，其它文本一律丢弃）；
 * 面向运维的处置说明放在 detail 中，由启动流程写入日志。
 */
export class DataEncryptionKeyMissingError extends Error {
  readonly detail: string

  constructor(detail: string) {
    super('DATA_ENCRYPTION_KEY_MISSING')
    this.name = 'DataEncryptionKeyMissingError'
    this.detail = detail
  }
}

async function collectDatabaseKeyIds(dataSource: DataSource): Promise<string[]> {
  const keyIds = new Set<string>()
  const queryRunner = dataSource.createQueryRunner()
  try {
    for (const { table, column } of SEALED_COLUMNS) {
      if (!await queryRunner.hasTable(table) || !await queryRunner.hasColumn(table, column)) continue
      const escapedColumn = dataSource.driver.escape(column)
      const rows = await queryRunner.query(
        `SELECT DISTINCT ${escapedColumn} AS sealed FROM ${dataSource.driver.escape(table)} WHERE ${escapedColumn} LIKE ?`,
        [SEALED_VALUE_PATTERN],
      ) as Array<{ sealed: string | null }>
      for (const row of rows) {
        const keyId = readSealedValueKeyId(row.sealed)
        if (keyId) keyIds.add(keyId)
      }
    }
    // 仅通行密钥用户可以没有 TOTP 密文，但未使用的恢复码仍依赖同一主密钥的 HMAC 子密钥。
    if (await queryRunner.hasTable('sys_user_mfa') && await queryRunner.hasColumn('sys_user_mfa', 'recovery_codes_json')) {
      const rows = await queryRunner.query(
        'SELECT recovery_codes_json AS metadata FROM sys_user_mfa WHERE recovery_codes_json IS NOT NULL',
      ) as Array<{ metadata: string }>
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.metadata) as { kid?: unknown; codes?: unknown }
          if (!parsed || !Array.isArray(parsed.codes)) continue
          const hasActiveCode = parsed.codes.some((code) => typeof code === 'string' && /^[0-9a-f]{64}$/.test(code))
          if (hasActiveCode) {
            // 非法 kid 不会被当作当前密钥；缺文件时同样阻断，交给原有拒绝校验路径处理。
            keyIds.add(typeof parsed.kid === 'string' && /^[0-9a-f]{8}$/.test(parsed.kid) ? parsed.kid : 'unidentified')
          }
        } catch {
          // 损坏的 JSON 在验证恢复码时会被既有解析逻辑拒绝；不猜测或修补密钥 ID。
        }
      }
    }
  } finally {
    await queryRunner.release()
  }
  return [...keyIds].sort()
}

/**
 * 启动预检：库内已有密文而密钥文件缺失时抛出 DataEncryptionKeyMissingError 阻断启动；
 * 密钥 ID 不一致时返回 mismatchedKeyIds 供启动日志告警。
 * 密钥文件存在但损坏、或环境变量格式错误时返回 null：沿用既有“读取降级、拒绝保存”口径（不会生成新密钥），错误由加密工具单独记录。
 */
export async function runDataEncryptionPreflight(dataSource: DataSource): Promise<DataEncryptionPreflightResult | null> {
  let current: ReturnType<typeof peekDataEncryptionKey>
  try {
    current = peekDataEncryptionKey()
  } catch {
    return null
  }
  const databaseKeyIds = await collectDatabaseKeyIds(dataSource)
  if (current.keyId === null && databaseKeyIds.length > 0) {
    throw new DataEncryptionKeyMissingError(
      `数据库中已有使用数据加密密钥（ID ${databaseKeyIds.join('、')}）加密的敏感配置，但数据目录缺少 secrets/data-encryption.key，`
      + '且未设置 Y_LINK_DATA_ENCRYPTION_KEY。为避免自动生成新密钥导致验证码网关、飞书配置与两步验证永久无法解密，已阻止启动。'
      + '请把与该数据库配套的密钥文件恢复到数据目录 secrets/data-encryption.key（或通过环境变量注入同一密钥）后重启；'
      + '若确认原密钥已丢失，可自行生成新的 32 字节密钥写入该文件后启动，再重新录入上述配置并用命令行重置两步验证。',
    )
  }
  return {
    keySource: current.source,
    keyId: current.keyId,
    databaseKeyIds,
    mismatchedKeyIds: current.keyId === null ? [] : databaseKeyIds.filter((keyId) => keyId !== current.keyId),
  }
}
