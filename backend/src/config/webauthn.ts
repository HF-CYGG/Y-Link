/** 管理端 WebAuthn 依赖固定 RP 与完整 Origin 白名单，绝不从 Host 或转发头推导。 */
import { env } from './env.js'
import { isIP } from 'node:net'

const dnsLabel = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/
function validRpId(value: string): boolean {
  return isIP(value) === 0 && value.length <= 253 && (value === 'localhost' || value.split('.').length >= 2)
    && value.split('.').every((label) => dnsLabel.test(label))
}

function parseOrigins(value: string | undefined): string[] {
  if (!value) return []
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw new Error('AUTH_WEBAUTHN_ORIGINS 必须是 JSON 字符串数组') }
  if (!Array.isArray(parsed) || !parsed.length || parsed.some((item) => typeof item !== 'string')) {
    throw new Error('AUTH_WEBAUTHN_ORIGINS 必须是非空 JSON 字符串数组')
  }
  return parsed as string[]
}

const origins = parseOrigins(env.AUTH_WEBAUTHN_ORIGINS)
if (env.AUTH_WEBAUTHN_ENABLED) {
  if (!env.AUTH_WEBAUTHN_RP_ID || !validRpId(env.AUTH_WEBAUTHN_RP_ID) || !env.AUTH_WEBAUTHN_RP_NAME) {
    throw new Error('启用 WebAuthn 必须配置合法 AUTH_WEBAUTHN_RP_ID 与 AUTH_WEBAUTHN_RP_NAME')
  }
  if (!origins.length || origins.some((origin) => {
    try {
      const url = new URL(origin)
      const devLocalhost = url.protocol === 'http:' && url.hostname === 'localhost'
      return (!devLocalhost && url.protocol !== 'https:') || url.origin !== origin || Boolean(url.username || url.password)
        || isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0
        || url.hostname !== env.AUTH_WEBAUTHN_RP_ID || !validRpId(url.hostname)
    } catch { return true }
  })) {
    throw new Error('AUTH_WEBAUTHN_ORIGINS 必须是与 RP ID 相同主机的固定 HTTPS Origin（仅 localhost 可用 HTTP）')
  }
}

export const webauthnConfig = {
  enabled: env.AUTH_WEBAUTHN_ENABLED,
  rpId: env.AUTH_WEBAUTHN_RP_ID ?? null,
  rpName: env.AUTH_WEBAUTHN_RP_NAME ?? null,
  allowedOrigins: origins,
} as const
