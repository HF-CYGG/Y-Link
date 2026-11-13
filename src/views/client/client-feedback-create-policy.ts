/**
 * 模块说明：src/views/client/client-feedback-create-policy.ts
 * 文件职责：生成新建反馈的独立类型草稿与当前类型允许的提交字段。
 * 实现逻辑：普通建议不包含 BUG 的关联订单、复现、联系与标签字段，隐藏内容仅留在本页内存。
 * 维护说明：禁止展开整个表单提交；补货使用自己的专用表单和 API。
 */
import type { FeedbackConversationMessageAttachment, FeedbackIssueCategory, FeedbackIssuePriority, FeedbackIssueType } from '@/api/modules/customer-service-feedback'
import { normalizeSubmitText } from '@/utils/submit-feedback'

export const createEmptyFeedbackDraft = () => ({
  title: '', summary: '', category: 'order' as FeedbackIssueCategory, priority: 'medium' as FeedbackIssuePriority,
  orderRef: '', expectedResult: '', actualResult: '', reproductionSteps: '', contactPreference: '', tagText: '',
})
export type ClientFeedbackCreateDraft = ReturnType<typeof createEmptyFeedbackDraft>

export const buildFeedbackCreatePayload = (issueType: FeedbackIssueType, draft: ClientFeedbackCreateDraft, attachments: FeedbackConversationMessageAttachment[]) => {
  if (issueType === 'restock') throw new Error('补货需求请使用补货表单')
  return {
    issueType, title: normalizeSubmitText(draft.title), summary: normalizeSubmitText(draft.summary),
    category: draft.category, priority: issueType === 'bug' ? draft.priority : 'medium' as const,
    attachments: [...attachments],
    ...(issueType === 'bug' ? {
      orderRef: draft.orderRef,
      expectedResult: normalizeSubmitText(draft.expectedResult), actualResult: normalizeSubmitText(draft.actualResult),
      reproductionSteps: draft.reproductionSteps, contactPreference: draft.contactPreference,
      tags: [...new Set(draft.tagText.split(/[，,]/).map((item) => item.trim()).filter(Boolean))],
    } : {}),
  }
}
