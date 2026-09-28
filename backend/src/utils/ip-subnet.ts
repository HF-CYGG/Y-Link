/**
 * 文件说明：把来源 IP 归一为风控计数用的来源键。
 * 实现逻辑：
 * - IPv4 与 IPv4 映射的 IPv6（`::ffff:a.b.c.d`，双栈监听时 Express 常见的写法）统一为点分 IPv4，
 *   避免同一来源因写法不同落入两个计数桶；
 * - 其它 IPv6 聚合到 /64 网段：运营商通常给每个终端分配一整个 /64，攻击者可在网段内任意轮换地址，
 *   按完整地址计数等于没有频控；/64 也不会把不同家庭宽带误并到一起；
 * - 无法解析的值返回 null，由调用方决定兜底键。
 * 维护说明：审计记录仍保存完整 IP（`RequestMeta.ipAddress`），本工具只用于频控、锁定等计数键。
 */
import net from 'node:net'

const IPV6_GROUP_COUNT = 8
const RISK_PREFIX_GROUPS = 4 // /64 = 前 4 组，每组 16 位

function expandIpv6Groups(address: string): number[] | null {
  let text = address
  // 末尾内嵌 IPv4（如 ::ffff:1.2.3.4、64:ff9b::1.2.3.4）先换成两组十六进制，统一按 8 组处理。
  const embedded = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text)
  if (embedded) {
    const octets = embedded[2].split('.').map(Number)
    text = `${embedded[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const zeroFill = IPV6_GROUP_COUNT - head.length - tail.length
  if (halves.length === 1 ? zeroFill !== 0 : zeroFill < 1) return null
  const groups = [...head, ...Array<string>(halves.length === 2 ? zeroFill : 0).fill('0'), ...tail]
  const parsed = groups.map((group) => (/^[0-9a-f]{1,4}$/i.test(group) ? Number.parseInt(group, 16) : Number.NaN))
  return parsed.some((value) => Number.isNaN(value)) ? null : parsed
}

export function toRiskSourceKey(rawAddress: string | null | undefined): string | null {
  const address = rawAddress?.trim() ?? ''
  if (!address) return null
  if (net.isIPv4(address)) return address
  // 链路本地地址可能带网卡后缀（fe80::1%eth0），聚合网段时忽略它。
  const withoutZone = address.split('%')[0]
  if (!net.isIPv6(withoutZone)) return null
  const groups = expandIpv6Groups(withoutZone)
  if (!groups) return null
  const isIpv4Mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff
  if (isIpv4Mapped) {
    return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.')
  }
  return `${groups.slice(0, RISK_PREFIX_GROUPS).map((group) => group.toString(16)).join(':')}::/64`
}
