/**
 * 模块说明：backend/src/utils/safe-network.ts
 * 文件职责：提供出站 URL 的主机安全校验，拦截 localhost、裸 IP、私网与链路本地地址，降低 SSRF 风险。
 * 设计说明：
 * - 仅基于 URL 中显式声明的主机名或 IP 字面量做静态拦截，不依赖 DNS 查询；
 * - 既支持 IPv4，也支持 IPv6 及 IPv4-mapped IPv6；
 * - 返回可读原因，便于服务层统一转成业务提示。
 */

import { isIP } from 'node:net'

/**
 * 识别结果：
 * - localhost：localhost 或其子域；
 * - loopback：回环地址；
 * - private：私网地址；
 * - link_local：链路本地地址；
 * - unspecified：未指定地址（如 0.0.0.0 / ::）；
 * - reserved：保留的本地测试/共享网段。
 */
export type UnsafeHostReason = 'localhost' | 'loopback' | 'private' | 'link_local' | 'unspecified' | 'reserved'

/**
 * 对 URL 主机名做基础归一化：
 * - 去除 IPv6 方括号；
 * - 去除末尾点号；
 * - 统一小写，避免大小写差异绕过。
 */
function normalizeHost(hostname: string) {
  return hostname.trim().replace(/^\[(.*)\]$/, '$1').replace(/\.+$/, '').toLowerCase()
}

function isLocalhostHost(hostname: string) {
  return hostname === 'localhost' || hostname.endsWith('.localhost')
}

function parseIpv4ToInt(hostname: string) {
  const segments = hostname.split('.')
  if (segments.length !== 4) {
    return null
  }

  let value = 0
  for (const segment of segments) {
    if (!/^\d+$/.test(segment)) {
      return null
    }
    const octet = Number.parseInt(segment, 10)
    if (octet < 0 || octet > 255) {
      return null
    }
    value = (value << 8) | octet
  }

  return value >>> 0
}

function parseIpv4Segments(hostname: string) {
  const segments = hostname.split('.').map((segment) => Number.parseInt(segment, 10))
  if (segments.length !== 4 || segments.some((segment) => !Number.isInteger(segment) || segment < 0 || segment > 255)) {
    return null
  }
  return segments
}

function detectUnsafeIpv4(hostname: string): UnsafeHostReason | null {
  const segments = parseIpv4Segments(hostname)
  const ipValue = parseIpv4ToInt(hostname)
  if (!segments || ipValue == null) {
    return null
  }

  const [firstOctet, secondOctet] = segments

  if (ipValue === 0) {
    return 'unspecified'
  }
  if (firstOctet === 0) {
    return 'unspecified'
  }
  if (firstOctet === 127) {
    return 'loopback'
  }
  if (firstOctet === 10) {
    return 'private'
  }
  if (firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31) {
    return 'private'
  }
  if (firstOctet === 192 && secondOctet === 168) {
    return 'private'
  }
  if (firstOctet === 169 && secondOctet === 254) {
    return 'link_local'
  }
  if (firstOctet === 100 && secondOctet >= 64 && secondOctet <= 127) {
    return 'reserved'
  }
  if (firstOctet === 198 && (secondOctet === 18 || secondOctet === 19)) {
    return 'reserved'
  }

  return null
}

function parseIpv6Parts(part: string) {
  if (!part) {
    return []
  }

  const groups: number[] = []
  const segments = part.split(':')
  for (const segment of segments) {
    if (!segment) {
      return null
    }

    if (segment.includes('.')) {
      const ipv4Segments = parseIpv4Segments(segment)
      if (!ipv4Segments) {
        return null
      }
      groups.push((ipv4Segments[0] << 8) | ipv4Segments[1], (ipv4Segments[2] << 8) | ipv4Segments[3])
      continue
    }

    if (!/^[\da-f]{1,4}$/i.test(segment)) {
      return null
    }
    groups.push(Number.parseInt(segment, 16))
  }

  return groups
}

function expandIpv6(hostname: string) {
  const normalized = normalizeHost(hostname).split('%')[0]
  if (isIP(normalized) !== 6) {
    return null
  }

  const separatorIndex = normalized.indexOf('::')
  if (separatorIndex >= 0) {
    const left = parseIpv6Parts(normalized.slice(0, separatorIndex))
    const right = parseIpv6Parts(normalized.slice(separatorIndex + 2))
    if (!left || !right) {
      return null
    }

    const missingCount = 8 - left.length - right.length
    if (missingCount < 1) {
      return null
    }

    return [...left, ...new Array<number>(missingCount).fill(0), ...right]
  }

  const full = parseIpv6Parts(normalized)
  if (full?.length !== 8) {
    return null
  }
  return full
}

function isIpv6Loopback(groups: number[]) {
  return groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1
}

function isIpv6Unspecified(groups: number[]) {
  return groups.every((group) => group === 0)
}

function detectUnsafeIpv6(hostname: string): UnsafeHostReason | null {
  const groups = expandIpv6(hostname)
  if (!groups) {
    return null
  }

  if (isIpv6Unspecified(groups)) {
    return 'unspecified'
  }
  if (isIpv6Loopback(groups)) {
    return 'loopback'
  }

  const firstGroup = groups[0]
  if ((firstGroup & 0xfe00) === 0xfc00) {
    return 'private'
  }
  if ((firstGroup & 0xffc0) === 0xfe80) {
    return 'link_local'
  }
  if ((firstGroup & 0xffc0) === 0xfec0) {
    return 'private'
  }

  const isIpv4Mapped =
    groups[0] === 0
    && groups[1] === 0
    && groups[2] === 0
    && groups[3] === 0
    && groups[4] === 0
    && groups[5] === 0xffff

  if (isIpv4Mapped) {
    const embeddedIpv4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`
    return detectUnsafeIpv4(embeddedIpv4)
  }

  return null
}

/**
 * 检测主机是否命中本地或内网网段：
 * - 域名仅处理 localhost 及其子域；
 * - 裸 IP 处理回环、私网、链路本地、未指定及常见保留网段；
 * - 未命中时返回 null，表示当前主机可继续交由上层处理。
 */
export function detectUnsafeHost(hostname: string): UnsafeHostReason | null {
  const normalizedHost = normalizeHost(hostname)
  if (!normalizedHost) {
    return 'unspecified'
  }
  if (isLocalhostHost(normalizedHost)) {
    return 'localhost'
  }

  const ipVersion = isIP(normalizedHost)
  if (ipVersion === 4) {
    return detectUnsafeIpv4(normalizedHost)
  }
  if (ipVersion === 6) {
    return detectUnsafeIpv6(normalizedHost)
  }

  return null
}

/**
 * 将识别结果转换为适合用户阅读的中文原因。
 */
export function formatUnsafeHostReason(reason: UnsafeHostReason) {
  switch (reason) {
    case 'localhost':
      return 'localhost 本地地址'
    case 'loopback':
      return '回环地址'
    case 'private':
      return '私网地址'
    case 'link_local':
      return '链路本地地址'
    case 'unspecified':
      return '未指定地址'
    case 'reserved':
      return '保留内网地址'
    default:
      return '受限地址'
  }
}
