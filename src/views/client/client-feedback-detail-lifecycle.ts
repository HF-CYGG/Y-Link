/**
 * 模块说明：src/views/client/client-feedback-detail-lifecycle.ts
 * 文件职责：隔离反馈详情的页面归属、附件上传与实时连接代次。
 * 实现逻辑：上传只淘汰旧上传；页面归属改变淘汰全部旧操作；重建实时连接只淘汰旧连接。
 * 维护说明：所有操作仍校验挂载状态、账号、登录会话代次与反馈会话；上传不能使有效 SSE 失效。
 */
interface FeedbackDetailOwnerContext {
  ownerId: string | number | null | undefined
  sessionGeneration: number
  conversationId: string
}

export const createFeedbackDetailLifecycle = ({ readContext, isMounted }: {
  readContext: () => FeedbackDetailOwnerContext
  isMounted: () => boolean
}) => {
  let pageGeneration = 0
  let uploadGeneration = 0
  let realtimeGeneration = 0

  const capturePage = () => {
    const owner = { ...readContext() }
    const generation = pageGeneration
    return () => {
      const current = readContext()
      return isMounted() && generation === pageGeneration
        && owner.ownerId === current.ownerId && owner.sessionGeneration === current.sessionGeneration
        && owner.conversationId === current.conversationId
    }
  }
  const startUpload = () => {
    const isCurrentPage = capturePage()
    const generation = ++uploadGeneration
    return () => isCurrentPage() && generation === uploadGeneration
  }
  const startRealtime = () => {
    const isCurrentPage = capturePage()
    const generation = ++realtimeGeneration
    return () => isCurrentPage() && generation === realtimeGeneration
  }
  const invalidateRealtime = () => { realtimeGeneration += 1 }
  const invalidatePage = () => {
    pageGeneration += 1
    uploadGeneration += 1
    realtimeGeneration += 1
  }
  return { capturePage, startUpload, startRealtime, invalidateRealtime, invalidatePage }
}
