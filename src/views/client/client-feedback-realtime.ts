/** 管理一个客户端反馈页的 SSE 连接和重连计时器。连接、计时器和异步刷新都必须确认仍归属于当前页面。 */
import type { FeedbackRealtimeConnection, FeedbackRealtimeHandlers } from '@/api/modules/customer-service-feedback'

type IsCurrent = () => boolean
type ConnectionAttempt = { stream: FeedbackRealtimeConnection | null }

export const createClientFeedbackRealtime = ({ openStream, isEligible, captureOwner, onConnecting, onOpen, onConversation, onDisconnect }: {
  openStream: (handlers: FeedbackRealtimeHandlers) => FeedbackRealtimeConnection | null
  isEligible: IsCurrent
  captureOwner: () => IsCurrent
  onConnecting: () => void
  onOpen: (payload: Parameters<NonNullable<FeedbackRealtimeHandlers['onOpen']>>[0], isCurrent: IsCurrent) => void
  onConversation: (payload: Parameters<NonNullable<FeedbackRealtimeHandlers['onConversation']>>[0], isCurrent: IsCurrent) => void
  onDisconnect: () => void
}) => {
  let connection: ConnectionAttempt | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  const cancelReconnect = () => {
    if (reconnectTimer !== null) clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  const closeConnection = () => {
    const previous = connection
    connection = null
    previous?.stream?.close()
  }

  const connect = () => {
    if (!isEligible() || connection) return
    cancelReconnect()

    const ownerIsCurrent = captureOwner()
    const attempt: ConnectionAttempt = { stream: null }
    connection = attempt
    const isCurrent = () => connection === attempt && ownerIsCurrent() && isEligible()
    onConnecting()
    const stream = openStream({
      onOpen: (payload) => {
        if (!isCurrent()) return
        cancelReconnect()
        onOpen(payload, isCurrent)
      },
      onConversation: (payload) => {
        if (isCurrent()) onConversation(payload, isCurrent)
      },
      onError: () => {
        if (!isCurrent()) return
        cancelReconnect()
        closeConnection()
        // 关闭旧流会停止浏览器的自动重连。应用只保留一个计时器，可由手动重试抢占。
        const timer = setTimeout(() => {
          if (reconnectTimer !== timer) return
          reconnectTimer = null
          if (ownerIsCurrent()) connect()
        }, 3000)
        reconnectTimer = timer
        onDisconnect()
      },
    })
    if (!isCurrent()) {
      if (connection === attempt) connection = null
      stream?.close()
    } else if (stream) {
      attempt.stream = stream
    } else {
      connection = null
    }
  }

  const stop = () => {
    cancelReconnect()
    closeConnection()
  }

  return {
    connect,
    stop,
    hasConnection: () => connection !== null,
    hasConnectionOrRetry: () => connection !== null || reconnectTimer !== null,
  }
}
