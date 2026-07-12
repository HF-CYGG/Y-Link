/**
 * 安全出站 HTTP 客户端：在 DNS 解析与每次重定向阶段阻断内网目标，限制超时和响应体。
 */
import { promises as dns } from 'node:dns'
import http, { type IncomingHttpHeaders, type RequestOptions } from 'node:http'
import https from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { detectUnsafeHost } from './safe-network.js'

const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization', 'x-api-key', 'api-key'])

export interface SafeHttpRequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: string | Buffer
  timeoutMs?: number
  maxResponseBytes?: number
  maxRedirects?: number
}

export interface SafeHttpResponse {
  statusCode: number
  headers: IncomingHttpHeaders
  body: Buffer
}

function ipv4Octets(address: string) {
  const values = address.split('.').map(Number)
  return values.length === 4 && values.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
    ? values
    : null
}

export function isPublicNetworkAddress(address: string): boolean {
  const normalized = address.trim().replace(/^\[(.*)\]$/, '$1').split('%')[0].toLowerCase()
  if (!normalized || detectUnsafeHost(normalized)) return false
  if (isIP(normalized) === 4) {
    const octets = ipv4Octets(normalized)
    if (!octets) return false
    const [a, b, c] = octets
    if (a >= 224 || a === 255) return false
    if (a === 192 && b === 0 && c === 2) return false
    if (a === 198 && b === 51 && c === 100) return false
    if (a === 203 && b === 0 && c === 113) return false
    return true
  }
  if (isIP(normalized) === 6) {
    if (/^ff/i.test(normalized)) return false
    if (/^2001:db8:/i.test(normalized)) return false
    // IPv4-compatible IPv6，例如 ::127.0.0.1 或 ::7f00:1。
    const compatible = /^::(?:ffff:)?(.+)$/.exec(normalized)
    if (compatible?.[1]) {
      const tail = compatible[1]
      if (isIP(tail) === 4) return isPublicNetworkAddress(tail)
      const groups = tail.split(':')
      if (groups.length <= 2 && groups.every((item) => /^[0-9a-f]{1,4}$/i.test(item))) {
        const padded = groups.map((item) => Number.parseInt(item, 16))
        const high = padded.length === 1 ? 0 : padded[0]
        const low = padded.at(-1) ?? 0
        return isPublicNetworkAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
      }
    }
    return true
  }
  return false
}

export function assertSafeOutboundUrl(input: string | URL): URL {
  const url = input instanceof URL ? new URL(input.toString()) : new URL(input)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('出站地址仅允许 HTTP/HTTPS')
  if (url.username || url.password) throw new Error('出站地址禁止包含 userinfo 用户信息')
  if (!url.hostname) throw new Error('出站地址缺少主机名')
  if (isIP(url.hostname) && !isPublicNetworkAddress(url.hostname)) throw new Error('出站地址禁止访问内网或保留地址')
  if (detectUnsafeHost(url.hostname)) throw new Error('出站地址禁止访问本地或内网主机')
  return url
}

function createSafeLookup(): LookupFunction {
  return ((hostname: string, _options: unknown, callback: (error: NodeJS.ErrnoException | null, address?: string, family?: number) => void) => {
    void dns.lookup(hostname, { all: true, verbatim: true }).then((addresses) => {
      if (addresses.length === 0 || addresses.some((item) => !isPublicNetworkAddress(item.address))) {
        callback(Object.assign(new Error('DNS 解析结果包含内网或保留地址'), { code: 'EACCES' }))
        return
      }
      callback(null, addresses[0].address, addresses[0].family)
    }, (error: NodeJS.ErrnoException) => callback(error))
  }) as LookupFunction
}

function stripCrossOriginSensitiveHeaders(headers: Record<string, string>) {
  return Object.fromEntries(Object.entries(headers).filter(([key]) => {
    const normalized = key.toLowerCase()
    return !SENSITIVE_HEADERS.has(normalized) && !/(?:auth|token|secret|api[-_]?key)/i.test(normalized)
  }))
}

function resolveRedirectMethod(statusCode: number, method: string, body: string | Buffer | undefined) {
  if (statusCode === 303 || ((statusCode === 301 || statusCode === 302) && method === 'POST')) {
    return { method: 'GET', body: undefined }
  }
  return { method, body }
}

export async function safeHttpRequest(input: string | URL, options: SafeHttpRequestOptions = {}): Promise<SafeHttpResponse> {
  const timeoutMs = options.timeoutMs ?? 8_000
  const maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024
  const maxRedirects = options.maxRedirects ?? 3

  const execute = async (
    target: URL,
    method: string,
    headers: Record<string, string>,
    body: string | Buffer | undefined,
    redirectsLeft: number,
  ): Promise<SafeHttpResponse> => {
    const safeUrl = assertSafeOutboundUrl(target)
    const transport = safeUrl.protocol === 'https:' ? https : http
    const response = await new Promise<SafeHttpResponse>((resolve, reject) => {
      const requestOptions: RequestOptions = {
        protocol: safeUrl.protocol,
        hostname: safeUrl.hostname,
        port: safeUrl.port || undefined,
        path: `${safeUrl.pathname}${safeUrl.search}`,
        method,
        headers,
        lookup: createSafeLookup(),
      }
      const request = transport.request(requestOptions, (incoming) => {
        const chunks: Buffer[] = []
        let total = 0
        incoming.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          total += buffer.length
          if (total > maxResponseBytes) {
            request.destroy(new Error('出站响应超过 1 MiB 上限'))
            return
          }
          chunks.push(buffer)
        })
        incoming.on('end', () => resolve({ statusCode: incoming.statusCode ?? 0, headers: incoming.headers, body: Buffer.concat(chunks) }))
      })
      request.setTimeout(timeoutMs, () => request.destroy(new Error(`出站请求超过 ${timeoutMs}ms 超时上限`)))
      request.on('error', reject)
      if (body != null) request.write(body)
      request.end()
    })

    const location = response.headers.location
    if (response.statusCode >= 300 && response.statusCode < 400 && location) {
      if (redirectsLeft <= 0) throw new Error('出站请求重定向次数超过上限')
      const redirected = assertSafeOutboundUrl(new URL(location, safeUrl))
      const next = resolveRedirectMethod(response.statusCode, method, body)
      const nextHeaders = redirected.origin === safeUrl.origin ? headers : stripCrossOriginSensitiveHeaders(headers)
      if (next.body == null) {
        delete nextHeaders['content-length']
        delete nextHeaders['Content-Length']
      }
      return execute(redirected, next.method, nextHeaders, next.body, redirectsLeft - 1)
    }
    return response
  }

  return execute(
    assertSafeOutboundUrl(input),
    (options.method ?? 'GET').toUpperCase(),
    { ...(options.headers ?? {}) },
    options.body,
    maxRedirects,
  )
}
