import type {
  AppendClientFeedbackMessageInput,
  ClientFeedbackConversationCloseResult,
  ClientFeedbackConversationDetail,
  ClientFeedbackConversationMutationResult,
  ClientFeedbackListQuery,
  ClientFeedbackListResult,
  ClientFeedbackPortalConfig,
  ClientFeedbackSatisfactionResult,
  CreateClientFeedbackConversationInput,
  SubmitClientFeedbackSatisfactionInput,
} from '@ylink/shared-types'

import type { ApiRequestOptions, HttpAdapter } from '../types.ts'

const encodePathSegment = (value: string) => encodeURIComponent(value)

/**
 * 客户端反馈 JSON Contract。
 * 附件上传与 SSE 暂不纳入：二者需要单独确定 Native 文件体与流式连接适配。
 */
export const createFeedbackApi = (http: HttpAdapter) => ({
  getPortalConfig(options: ApiRequestOptions = {}): Promise<ClientFeedbackPortalConfig> {
    return http.request({ ...options, method: 'GET', url: '/client-feedback/portal-config' })
  },

  listMyConversations(
    query: ClientFeedbackListQuery = {},
    options: ApiRequestOptions = {},
  ): Promise<ClientFeedbackListResult> {
    return http.request({
      ...options,
      method: 'GET',
      url: '/client-feedback/conversations',
      params: {
        page: query.page,
        pageSize: query.pageSize,
        keyword: query.keyword,
        status: query.status,
      },
    })
  },

  createConversation(
    data: CreateClientFeedbackConversationInput,
    options: ApiRequestOptions = {},
  ): Promise<ClientFeedbackConversationMutationResult> {
    return http.request({ ...options, method: 'POST', url: '/client-feedback/conversations', data })
  },

  getConversation(id: string, options: ApiRequestOptions = {}): Promise<ClientFeedbackConversationDetail> {
    return http.request({
      ...options,
      method: 'GET',
      url: `/client-feedback/conversations/${encodePathSegment(id)}`,
    })
  },

  appendMessage(
    id: string,
    data: AppendClientFeedbackMessageInput,
    options: ApiRequestOptions = {},
  ): Promise<ClientFeedbackConversationMutationResult> {
    return http.request({
      ...options,
      method: 'POST',
      url: `/client-feedback/conversations/${encodePathSegment(id)}/messages`,
      data,
    })
  },

  confirmResolved(id: string, options: ApiRequestOptions = {}): Promise<ClientFeedbackConversationCloseResult> {
    return http.request({
      ...options,
      method: 'PATCH',
      url: `/client-feedback/conversations/${encodePathSegment(id)}/confirm-resolved`,
    })
  },

  withdraw(id: string, options: ApiRequestOptions = {}): Promise<ClientFeedbackConversationCloseResult> {
    return http.request({
      ...options,
      method: 'PATCH',
      url: `/client-feedback/conversations/${encodePathSegment(id)}/withdraw`,
    })
  },

  submitSatisfaction(
    id: string,
    data: SubmitClientFeedbackSatisfactionInput,
    options: ApiRequestOptions = {},
  ): Promise<ClientFeedbackSatisfactionResult> {
    return http.request({
      ...options,
      method: 'POST',
      url: `/client-feedback/conversations/${encodePathSegment(id)}/satisfaction`,
      data,
    })
  },
})
