/**
 * 模块说明：backend/scripts/support/local-http-request.ts
 * 文件职责：为本地 Express 回归脚本提供基于 Node http.request 的请求适配器。
 * 实现逻辑：保留 Response 式的状态、响应头和文本读取接口，但不经过 fetch 的 forbidden-port 校验。
 * 维护说明：本工具仅用于本地测试，不得用于生产外部请求或绕过安全边界。
 */

import { request } from 'node:http'

export interface LocalHttpRequestInit {
  method?: string
  headers?: Record<string, string>
  body?: string
}

export function requestLocalHttp(url: string, init: LocalHttpRequestInit = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const requestUrl = new URL(url)
    const clientRequest = request(requestUrl, {
      method: init.method ?? 'GET',
      headers: init.headers,
    }, (incoming) => {
      const chunks: Buffer[] = []
      incoming.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })
      incoming.on('end', () => {
        const responseHeaders = new Headers()
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          const name = incoming.rawHeaders[index]
          const value = incoming.rawHeaders[index + 1]
          if (name && value !== undefined) responseHeaders.append(name, value)
        }
        const body = Buffer.concat(chunks)
        const status = incoming.statusCode ?? 500
        resolve(new Response(status === 204 || status === 304 ? null : body, {
          status,
          statusText: incoming.statusMessage,
          headers: responseHeaders,
        }))
      })
    })
    clientRequest.once('error', reject)
    if (init.body !== undefined) clientRequest.write(init.body)
    clientRequest.end()
  })
}
