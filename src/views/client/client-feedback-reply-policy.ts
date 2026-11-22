/**
 * 模块说明：src/views/client/client-feedback-reply-policy.ts
 * 文件职责：区分反馈消息写入结果与展示回读结果，保护发送期间继续编辑的草稿。
 * 实现逻辑：仅 POST 失败向外抛出；POST 成功后立即确认，GET 失败只通知刷新警告。
 * 维护说明：调用方提供账号/会话代次检查；过期操作不再清草稿或弹提示。
 */
export const resolveReplyDraftAfterSend = (draft: string, revision: number, submittedRevision: number) => revision === submittedRevision ? '' : draft

export const sendFeedbackReplyAndRefresh = async ({ post, refresh, isCurrent, onSent, onRefreshFailed }: {
  post: () => Promise<unknown>
  refresh: () => Promise<unknown>
  isCurrent: () => boolean
  onSent: () => void
  onRefreshFailed: () => void
}): Promise<'sent' | 'stale' | 'sent_refresh_failed'> => {
  await post()
  if (!isCurrent()) return 'stale'
  onSent()
  try { await refresh() } catch {
    if (!isCurrent()) return 'stale'
    onRefreshFailed()
    return 'sent_refresh_failed'
  }
  return isCurrent() ? 'sent' : 'stale'
}
