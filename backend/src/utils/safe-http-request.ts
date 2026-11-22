/**
 * 安全出站 HTTP 客户端：在 DNS 解析与每次重定向阶段阻断内网目标，限制超时和响应体。
 */
import { promises as dns } from 'node:dns'
import http, { type ClientRequest, type IncomingMessage, type IncomingHttpHeaders, type RequestOptions } from 'node:http'
import https from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { detectUnsafeHost, isPublicNetworkAddress } from './safe-network.js'

export { isPublicNetworkAddress } from './safe-network.js'

const CROSS_ORIGIN_STRIPPED_HEADERS = new Set(['host', 'authorization', 'cookie', 'proxy-authorization', 'x-api-key', 'api-key'])

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

export function assertSafeOutboundUrl(input: string | URL): URL {
  const url = input instanceof URL ? new URL(input.toString()) : new URL(input)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('出站地址仅允许 HTTP/HTTPS')
  if (url.username || url.password) throw new Error('出站地址禁止包含 userinfo 用户信息')
  if (!url.hostname) throw new Error('出站地址缺少主机名')
  const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1')
  if (isIP(hostname) && !isPublicNetworkAddress(hostname)) throw new Error('出站地址禁止访问内网或保留地址')
  if (detectUnsafeHost(url.hostname)) throw new Error('出站地址禁止访问本地或内网主机')
  return url
}

/** 完整 Origin 白名单只限定重定向，永远不豁免 URL 与 DNS 的 SSRF 校验。 */
export function readOutboundRedirectPolicy(environment: NodeJS.ProcessEnv = process.env) {
  const mode = environment.Y_LINK_OUTBOUND_REDIRECT_POLICY ?? 'compat'
  if (mode !== 'compat' && mode !== 'strict') throw new Error('Y_LINK_OUTBOUND_REDIRECT_POLICY 仅允许 compat 或 strict')
  let values: unknown
  try { values = JSON.parse(environment.Y_LINK_OUTBOUND_REDIRECT_ALLOWED_ORIGINS ?? '[]') } catch {
    throw new Error('Y_LINK_OUTBOUND_REDIRECT_ALLOWED_ORIGINS 必须是完整 Origin 的 JSON 数组')
  }
  if (!Array.isArray(values)) throw new Error('重定向白名单必须是完整 Origin 的 JSON 数组')
  const origins = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string' || !/^https?:\/\/[^/?#\\\s]+\/?$/i.test(value.trim()) || value.includes('*')) {
      throw new Error('重定向白名单仅允许完整 HTTP/HTTPS Origin，禁止通配符、路径、查询与片段')
    }
    const url = assertSafeOutboundUrl(value.trim())
    origins.add(url.origin)
  }
  return { mode, origins }
}

function createSafeLookup(isStopped: () => boolean, timeoutError: Error): LookupFunction {
  return (hostname, options, callback) => {
    if (isStopped()) { callback(timeoutError, []); return }
    void dns.lookup(hostname, { all: true, verbatim: true }).then((addresses) => {
      // dns.lookup 本身不可取消；迟到结果只能失败，不能让已销毁请求继续建立连接。
      if (isStopped()) { callback(timeoutError, []); return }
      if (addresses.length === 0 || addresses.some((item) => !isPublicNetworkAddress(item.address))) {
        callback(Object.assign(new Error('DNS 解析结果包含内网或保留地址'), { code: 'EACCES' }), [])
        return
      }
      // 先检查完整解析集合，再筛选地址族，避免漏检另一地址族中的内网地址。
      const family = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : (options.family ?? 0)
      const candidates = family === 0 ? addresses : addresses.filter((item) => item.family === family)
      if (candidates.length === 0) {
        callback(Object.assign(new Error('DNS 解析结果不包含请求的地址族'), { code: 'ENOTFOUND' }), [])
        return
      }
      // Node 自动选择地址族时使用 all=true，要求回调数组而非单地址字符串。
      if (options.all) {
        callback(null, candidates)
      } else {
        callback(null, candidates[0].address, candidates[0].family)
      }
    }, (error: NodeJS.ErrnoException) => callback(isStopped() ? timeoutError : error, []))
  }
}

function stripCrossOriginHeaders(headers: Record<string, string>) {
  return Object.fromEntries(Object.entries(headers).filter(([key]) => {
    const normalized = key.toLowerCase()
    return !CROSS_ORIGIN_STRIPPED_HEADERS.has(normalized) && !/(?:auth|token|secret|api[-_]?key)/i.test(normalized)
  }))
}

export async function safeHttpRequest(input: string | URL, options: SafeHttpRequestOptions = {}): Promise<SafeHttpResponse> {
  const timeoutMs = options.timeoutMs ?? 8_000
  const maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024
  const maxRedirects = options.maxRedirects ?? 3

  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error('出站总超时必须是有效的正整数毫秒')
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0 || !Number.isSafeInteger(maxRedirects) || maxRedirects < 0) throw new Error('出站响应或重定向限制无效')
  const initialUrl = assertSafeOutboundUrl(input)
  const policy = readOutboundRedirectPolicy()
  const deadline = performance.now() + timeoutMs
  const timeoutError = Object.assign(new Error(`出站请求超过 ${timeoutMs}ms 总超时上限`), { code: 'ETIMEDOUT' })
  return new Promise<SafeHttpResponse>((resolve, reject) => {
    let settled = false
    let activeRequest: ClientRequest | undefined
    let activeResponse: IncomingMessage | undefined
    let cancelHop: ((error: Error) => void) | undefined
    const isStopped = () => settled || performance.now() >= deadline
    const finish = (error?: Error, response?: SafeHttpResponse) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) cancelHop?.(error)
      activeResponse?.destroy()
      activeRequest?.destroy()
      if (error) reject(error)
      else resolve(response!)
    }
    // 一个计时器覆盖 DNS、连接、响应读取与全部跳转，不会被持续小包或下一跳刷新。
    const timer = setTimeout(() => finish(timeoutError), timeoutMs)
    const run = async () => {
      let target = initialUrl
      let method = (options.method ?? 'GET').toUpperCase()
      let headers = { ...(options.headers ?? {}) }
      let body = options.body
      let redirectsLeft = maxRedirects
      for (;;) {
        if (isStopped()) throw timeoutError
        const safeUrl = assertSafeOutboundUrl(target)
        const transport = safeUrl.protocol === 'https:' ? https : http
        const response = await new Promise<SafeHttpResponse>((resolveHop, rejectHop) => {
          let hopSettled = false
          let receivedResponse = false
          const complete = (error?: Error, value?: SafeHttpResponse) => {
            if (hopSettled) return
            hopSettled = true
            cancelHop = undefined
            if (error) rejectHop(error)
            else resolveHop(value!)
          }
          cancelHop = (error) => complete(error)
          const requestOptions: RequestOptions = {
            protocol: safeUrl.protocol, hostname: safeUrl.hostname.replace(/^\[(.*)\]$/, '$1'), port: safeUrl.port || undefined,
            path: `${safeUrl.pathname}${safeUrl.search}`, method, headers,
            // 不复用全局 Agent 的空闲连接：每次跳转都必须真正经过本次安全 DNS 校验。
            agent: false,
            lookup: createSafeLookup(() => isStopped() || hopSettled, timeoutError),
          }
          const request = transport.request(requestOptions, (incoming) => {
            receivedResponse = true
            activeResponse = incoming
            incoming.on('error', (error: Error) => complete(error))
            if (isStopped()) { incoming.destroy(); complete(timeoutError); return }
            const chunks: Buffer[] = []
            let total = 0
            incoming.on('aborted', () => complete(new Error('出站响应被中断')))
            incoming.on('close', () => { if (!hopSettled) complete(new Error('出站响应未完成即关闭')) })
            incoming.on('data', (chunk: Buffer | string) => {
              if (hopSettled || isStopped()) { complete(timeoutError); return }
              const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
              total += buffer.length
              if (total > maxResponseBytes) { complete(new Error('出站响应超过大小上限')); return }
              chunks.push(buffer)
            })
            incoming.on('end', () => {
              if (isStopped()) { complete(timeoutError); return }
              if (incoming.complete === false) { complete(new Error('出站响应未完整接收')); return }
              complete(undefined, { statusCode: incoming.statusCode ?? 0, headers: incoming.headers, body: Buffer.concat(chunks) })
            })
          })
          activeRequest = request
          request.on('error', (error: Error) => complete(error))
          request.on('close', () => { if (!hopSettled && !receivedResponse) complete(new Error('出站连接未收到响应即关闭')) })
          if (body != null) request.write(body)
          request.end()
        })
        if (isStopped()) throw timeoutError
        const location = response.headers.location
        if (![301, 302, 303, 307, 308].includes(response.statusCode) || !location) return response
        if (redirectsLeft-- <= 0) throw new Error('出站请求重定向次数超过上限')
        const redirected = assertSafeOutboundUrl(new URL(location, safeUrl))
        if (policy.mode === 'strict' && (
          (safeUrl.protocol === 'https:' && redirected.protocol === 'http:')
          || (redirected.origin !== initialUrl.origin && !policy.origins.has(redirected.origin))
        )) throw new Error('出站重定向被 strict 策略拒绝')
        const rewriteToGet = response.statusCode === 303 || ((response.statusCode === 301 || response.statusCode === 302) && method === 'POST')
        if (rewriteToGet) {
          method = 'GET'
          body = undefined
        }
        headers = redirected.origin === safeUrl.origin ? { ...headers } : stripCrossOriginHeaders(headers)
        if (body == null) {
          headers = Object.fromEntries(Object.entries(headers).filter(([key]) => {
            const name = key.toLowerCase()
            return name !== 'content-length' && !(rewriteToGet && (name === 'content-type' || name === 'transfer-encoding'))
          }))
        }
        activeResponse = undefined
        activeRequest?.destroy()
        activeRequest = undefined
        target = redirected
      }
    }
    void run().then((response) => finish(undefined, response), (error: Error) => finish(error))
  })
}
