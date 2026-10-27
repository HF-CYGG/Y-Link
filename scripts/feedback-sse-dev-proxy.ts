/**
 * 文件职责：仅为Vite开发代理的反馈SSE绑定下游关闭与上游销毁。
 * 实现逻辑：HTTP/2 RST_STREAM后writableFinished也可能为true，因此以close/error事件为准；普通API不增加监听。
 * 维护说明：不修改TLS、代理目标、生产Nginx或服务端鉴权/连接预算。
 */
import type { ProxyOptions } from 'vite'

export const configureFeedbackSseProxy: NonNullable<ProxyOptions['configure']> = (proxy) => {
  proxy.on('proxyReq', (upstream, request, response) => {
    const pathname = request.url?.split('?')[0] ?? ''
    if (!/^\/api\/(?:client-feedback|customer-service)\/stream\/?$/.test(pathname)) return
    const cleanup = () => {
      response.off('close', disconnect)
      response.off('error', disconnect)
      upstream.off('close', cleanup)
    }
    const disconnect = () => {
      cleanup()
      if (!upstream.destroyed) upstream.destroy()
    }
    response.once('close', disconnect)
    response.once('error', disconnect)
    upstream.once('close', cleanup)
    // 代理等待socket分配时，下游也可能已关闭；监听安装后再次检查，避免错过先发生的close。
    if (response.destroyed || response.writableEnded || response.closed) disconnect()
  })
}
