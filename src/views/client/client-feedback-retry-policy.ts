/**
 * 模块说明：src/views/client/client-feedback-retry-policy.ts
 * 文件职责：在反馈详情手动重试成功后恢复实时连接，避免首次加载失败后永久离线。
 * 实现逻辑：重试结束后重新检查账号/会话身份、详情与可见状态；已有连接时不重复建立。
 * 维护说明：连接检查必须在异步回读完成后执行；失败与过期回读不能触发连接。
 */
export const retryFeedbackDetailAndEnsureRealtime = async ({ load, isCurrent, hasDetail, eligible, hasConnection, connect }: {
  load: () => Promise<unknown>
  isCurrent: () => boolean
  hasDetail: () => boolean
  eligible: () => boolean
  hasConnection: () => boolean
  connect: () => void
}) => {
  await load()
  if (isCurrent() && hasDetail() && eligible() && !hasConnection()) connect()
}
