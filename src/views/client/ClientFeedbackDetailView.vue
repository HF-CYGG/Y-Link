<script setup lang="ts">
/**
 * 模块说明：src/views/client/ClientFeedbackDetailView.vue
 * 文件职责：提供客户端单条反馈单的独立详情页，集中展示 Issue 字段、会话记录与继续补充说明。
 * 实现逻辑：
 * - 页面按路由参数加载当前反馈单详情，进入后自动续接实时状态和消息变化；
 * - 仅在当前会话发生变化时重拉详情，避免返回列表页才能看到最新处理进度。
 * 维护说明：
 * - 若后续接入附件上传、满意度评价或关闭反馈，可继续在本页扩展；
 * - 列表页仅保留导航职责，详情相关交互统一在此页维护。
 */

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  FEEDBACK_CATEGORY_OPTIONS,
  FEEDBACK_PRIORITY_META_MAP,
  FEEDBACK_STATUS_META_MAP,
  appendClientFeedbackMessage,
  getClientFeedbackConversation,
  getClientFeedbackPortalConfig,
  openFeedbackRealtimeStream,
  type FeedbackConversationRecord,
  type FeedbackIssueCategory,
  type FeedbackPortalAvailability,
  type FeedbackRealtimeConnection,
} from '@/api/modules/customer-service-feedback'
import { useClientAuthStore } from '@/store'
import pinia from '@/store/pinia'
import { formatDateTime } from '@/utils/date-time'
import { extractErrorMessage } from '@/utils/error'
import { normalizeSubmitText } from '@/utils/submit-feedback'

const route = useRoute()
const router = useRouter()
const clientAuthStore = useClientAuthStore(pinia)

const loading = ref(false)
const detailLoading = ref(false)
const replySubmitting = ref(false)
const conversation = ref<FeedbackConversationRecord | null>(null)
const replyDraft = ref('')
const availability = ref<FeedbackPortalAvailability | null>(null)
const realtimeState = ref<'connecting' | 'online' | 'offline'>('offline')
const reconnectTip = ref('进入页面后会自动续接当前会话。')
let realtimeConnection: FeedbackRealtimeConnection | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

const currentClientUser = computed(() => clientAuthStore.currentUser)
const currentConversationId = computed(() => {
  return typeof route.params.id === 'string' ? route.params.id : ''
})

const availabilityText = computed(() => {
  if (!availability.value) {
    return '正在确认客服在线状态...'
  }
  if (availability.value.isOnline) {
    return `当前在线，已有 ${availability.value.serviceConnectedCount} 位客服在线接待，可在当前反馈单内实时沟通。`
  }
  return availability.value.offlineNotice
})

const getCategoryLabel = (category: FeedbackIssueCategory) => {
  return FEEDBACK_CATEGORY_OPTIONS.find((item) => item.value === category)?.label ?? '其他建议'
}

const handleNavigateBack = () => {
  if (globalThis.history.length > 1) {
    router.back()
    return
  }
  router.push('/client/feedback')
}

const loadPortalConfig = async () => {
  const config = await getClientFeedbackPortalConfig()
  availability.value = config.availability
  realtimeState.value = config.availability.isOnline ? 'online' : 'offline'
  reconnectTip.value = config.availability.isOnline
    ? '客服当前在线，后续回复会自动同步到当前反馈单。'
    : '客服当前离线，你仍可先留言，客服上线后会在当前反馈单继续跟进。'
}

const loadConversationDetail = async (conversationId: string) => {
  if (!conversationId) {
    conversation.value = null
    return
  }

  detailLoading.value = true
  if (!conversation.value) {
    loading.value = true
  }

  try {
    const detail = await getClientFeedbackConversation(conversationId)
    if (!detail) {
      ElMessage.warning('未找到对应反馈单，已返回会话列表')
      router.replace('/client/feedback')
      return
    }
    conversation.value = detail
  } finally {
    detailLoading.value = false
    loading.value = false
  }
}

const handleReply = async () => {
  if (!conversation.value) {
    ElMessage.warning('当前反馈单尚未加载完成')
    return
  }

  const normalizedReply = normalizeSubmitText(replyDraft.value)
  if (!normalizedReply) {
    ElMessage.warning('请输入要补充的说明')
    return
  }

  replySubmitting.value = true
  try {
    await appendClientFeedbackMessage(conversation.value.id, {
      body: normalizedReply,
    })
    replyDraft.value = ''
    await loadConversationDetail(conversation.value.id)
    reconnectTip.value = '已自动续接当前反馈单，你的新补充已提交给客服。'
    ElMessage.success('补充说明已发送')
  } catch (error) {
    ElMessage.error(extractErrorMessage(error, '补充说明发送失败，请稍后重试'))
  } finally {
    replySubmitting.value = false
  }
}

const connectRealtime = () => {
  realtimeConnection?.close()
  realtimeConnection = null

  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  realtimeState.value = 'connecting'
  realtimeConnection = openFeedbackRealtimeStream('client', {
    onOpen: (payload) => {
      availability.value = payload.availability ?? availability.value
      realtimeState.value = payload.availability?.isOnline ? 'online' : 'offline'
      reconnectTip.value = '已恢复在线连接，当前反馈单会自动同步最新消息。'
    },
    onConversation: async (payload) => {
      if (payload?.conversationId !== currentConversationId.value) {
        return
      }
      await loadConversationDetail(currentConversationId.value)
      reconnectTip.value = '检测到当前反馈单有新进展，已自动刷新详情。'
    },
    onError: () => {
      realtimeState.value = 'offline'
      reconnectTip.value = '实时连接已中断，系统正在尝试自动续接...'
      reconnectTimer = setTimeout(() => {
        connectRealtime()
      }, 3000)
    },
  })
}

watch(
  () => currentClientUser.value?.id,
  async () => {
    if (!currentClientUser.value?.id || !currentConversationId.value) {
      return
    }
    try {
      await loadPortalConfig()
      await loadConversationDetail(currentConversationId.value)
      connectRealtime()
    } catch (error) {
      ElMessage.error(extractErrorMessage(error, '反馈单详情初始化失败，请稍后重试'))
    }
  },
)

watch(
  () => currentConversationId.value,
  async (conversationId) => {
    if (!conversationId || !currentClientUser.value?.id) {
      return
    }
    try {
      await loadConversationDetail(conversationId)
    } catch (error) {
      ElMessage.error(extractErrorMessage(error, '反馈单详情加载失败，请稍后重试'))
    }
  },
)

onMounted(async () => {
  if (!currentClientUser.value?.id || !currentConversationId.value) {
    return
  }
  try {
    await loadPortalConfig()
    await loadConversationDetail(currentConversationId.value)
    connectRealtime()
  } catch (error) {
    ElMessage.error(extractErrorMessage(error, '反馈单详情加载失败，请稍后重试'))
  }
})

onBeforeUnmount(() => {
  realtimeConnection?.close()
  realtimeConnection = null
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
})
</script>

<template>
  <section class="space-y-4 pb-4">
    <div class="rounded-[1.5rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <button
            type="button"
            class="inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label="返回反馈会话页"
            @click="handleNavigateBack"
          >
            <svg viewBox="0 0 20 20" fill="none" class="h-4 w-4" aria-hidden="true">
              <path d="M11.5 4.5L6 10l5.5 5.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <p class="text-xl font-semibold text-slate-900">反馈单详情</p>
          <p class="mt-1 text-sm leading-6 text-slate-500">
            围绕当前反馈单查看处理进度、Issue 字段和全部消息记录，需要补充说明时可直接在本页续接。
          </p>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <span
            class="rounded-full px-3 py-1.5 text-xs font-semibold"
            :class="realtimeState === 'online' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'"
          >
            {{ realtimeState === 'online' ? '客服在线' : realtimeState === 'connecting' ? '连接中' : '客服离线' }}
          </span>
        </div>
      </div>
      <div class="mt-4 rounded-[1rem] border border-slate-200 bg-slate-50 px-4 py-3">
        <p class="text-sm font-medium text-slate-700">{{ availabilityText }}</p>
        <p class="mt-1 text-xs leading-5 text-slate-500">{{ reconnectTip }}</p>
      </div>
    </div>

    <article v-if="loading && !conversation" class="rounded-[1.4rem] bg-white p-8 text-center shadow-[var(--ylink-shadow-soft)]">
      <p class="text-base font-semibold text-slate-900">正在加载反馈单详情...</p>
      <p class="mt-2 text-sm leading-6 text-slate-500">请稍候，系统正在同步当前会话记录与处理状态。</p>
    </article>

    <article v-else-if="conversation" class="space-y-4">
      <article class="rounded-[1.4rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
        <div v-if="detailLoading" class="mb-4 rounded-[1rem] bg-slate-50 px-4 py-3 text-sm text-slate-500">
          正在同步当前反馈单详情...
        </div>

        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="text-xs font-semibold tracking-[0.16em] text-slate-400">{{ conversation.issueNo }}</p>
            <p class="mt-2 text-xl font-semibold text-slate-900">{{ conversation.title }}</p>
            <p class="mt-2 text-sm leading-6 text-slate-500">{{ conversation.summary }}</p>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <span
              class="rounded-full px-3 py-1.5 text-xs font-semibold"
              :class="FEEDBACK_STATUS_META_MAP[conversation.status].className"
            >
              {{ FEEDBACK_STATUS_META_MAP[conversation.status].label }}
            </span>
            <span
              class="rounded-full px-3 py-1.5 text-xs font-semibold"
              :class="FEEDBACK_PRIORITY_META_MAP[conversation.priority].className"
            >
              {{ FEEDBACK_PRIORITY_META_MAP[conversation.priority].label }}
            </span>
          </div>
        </div>

        <div class="mt-5 grid gap-3 lg:grid-cols-2">
          <div class="rounded-[1rem] bg-slate-50 p-4">
            <p class="text-xs font-semibold tracking-[0.16em] text-slate-400">Issue 字段</p>
            <dl class="mt-3 space-y-3 text-sm">
              <div>
                <dt class="text-slate-400">问题类型</dt>
                <dd class="mt-1 font-medium text-slate-900">{{ conversation.fields.issueType === 'bug' ? '专业 BUG' : '普通建议' }}</dd>
              </div>
              <div>
                <dt class="text-slate-400">问题分类</dt>
                <dd class="mt-1 font-medium text-slate-900">{{ getCategoryLabel(conversation.fields.category) }}</dd>
              </div>
              <div>
                <dt class="text-slate-400">来源入口</dt>
                <dd class="mt-1 font-medium text-slate-900">{{ conversation.fields.sourceLabel }}</dd>
              </div>
              <div>
                <dt class="text-slate-400">关联订单号</dt>
                <dd class="mt-1 font-medium text-slate-900">{{ conversation.fields.orderRef || '未关联' }}</dd>
              </div>
              <div>
                <dt class="text-slate-400">期望结果</dt>
                <dd class="mt-1 leading-6 text-slate-900">{{ conversation.fields.expectedResult || '未填写' }}</dd>
              </div>
              <div>
                <dt class="text-slate-400">实际结果</dt>
                <dd class="mt-1 leading-6 text-slate-900">{{ conversation.fields.actualResult || '未填写' }}</dd>
              </div>
            </dl>
          </div>

          <div class="rounded-[1rem] bg-slate-50 p-4">
            <p class="text-xs font-semibold tracking-[0.16em] text-slate-400">补充信息</p>
            <dl class="mt-3 space-y-3 text-sm">
              <div>
                <dt class="text-slate-400">复现步骤</dt>
                <dd class="mt-1 leading-6 text-slate-900">{{ conversation.fields.reproductionSteps || '未填写' }}</dd>
              </div>
              <div>
                <dt class="text-slate-400">联系偏好</dt>
                <dd class="mt-1 leading-6 text-slate-900">{{ conversation.fields.contactPreference || '站内会话回复' }}</dd>
              </div>
              <div>
                <dt class="text-slate-400">客服负责人</dt>
                <dd class="mt-1 font-medium text-slate-900">{{ conversation.assigneeName || '待分配' }}</dd>
              </div>
              <div>
                <dt class="text-slate-400">标签</dt>
                <dd class="mt-2 flex flex-wrap gap-2">
                  <span
                    v-for="tag in conversation.fields.tags"
                    :key="tag"
                    class="rounded-full bg-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700"
                  >
                    {{ tag }}
                  </span>
                  <span v-if="!conversation.fields.tags.length" class="text-slate-500">暂无标签</span>
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </article>

      <article class="rounded-[1rem] border border-slate-200 bg-slate-50/80 p-4">
        <div class="flex items-center justify-between gap-3">
          <div>
            <p class="text-base font-semibold text-slate-900">会话记录</p>
            <p class="mt-1 text-xs text-slate-400">所有消息按时间顺序展示，便于围绕同一 Issue 持续协作。</p>
          </div>
          <span class="text-xs text-slate-400">{{ conversation.messages.length }} 条消息</span>
        </div>

        <div class="mt-4 space-y-3">
          <article
            v-for="message in conversation.messages"
            :key="message.id"
            class="rounded-[1rem] px-4 py-3"
            :class="message.senderRole === 'client' ? 'ml-auto bg-brand/10 text-slate-900' : 'bg-white text-slate-900'"
          >
            <div class="flex flex-wrap items-center justify-between gap-2">
              <p class="text-sm font-semibold">
                {{ message.senderName }}
                <span class="ml-2 text-xs font-medium text-slate-400">
                  {{ message.senderRole === 'client' ? '我' : message.senderRole === 'staff' ? '客服' : '系统' }}
                </span>
              </p>
              <span class="text-xs text-slate-400">{{ formatDateTime(message.createdAt) }}</span>
            </div>
            <p class="mt-2 whitespace-pre-wrap text-sm leading-6">{{ message.body }}</p>
          </article>
        </div>
      </article>

      <article class="rounded-[1rem] border border-slate-200 bg-white p-4">
        <p class="text-base font-semibold text-slate-900">继续补充说明</p>
        <p class="mt-1 text-xs text-slate-400">同一问题后续有新现象时，直接追加消息即可，不需要重新新建反馈。</p>
        <textarea
          v-model="replyDraft"
          class="feedback-textarea mt-4"
          maxlength="400"
          placeholder="例如：今天再次尝试后，问题仍在 iPhone 浏览器出现。"
        />
        <div class="mt-3 flex justify-end">
          <button
            type="button"
            class="rounded-[1rem] bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="replySubmitting"
            @click="handleReply"
          >
            {{ replySubmitting ? '发送中...' : '发送补充说明' }}
          </button>
        </div>
      </article>
    </article>

    <article v-else class="rounded-[1.4rem] bg-white p-8 text-center shadow-[var(--ylink-shadow-soft)]">
      <p class="text-base font-semibold text-slate-900">未找到对应反馈单</p>
      <p class="mt-2 text-sm leading-6 text-slate-500">
        该会话可能已失效或当前账号无权访问，请返回会话列表重新选择。
      </p>
      <button
        type="button"
        class="mt-4 rounded-[1rem] bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800"
        @click="handleNavigateBack"
      >
        返回我的会话
      </button>
    </article>
  </section>
</template>

<style scoped>
.feedback-textarea {
  width: 100%;
  min-height: 120px;
  resize: vertical;
  border: 1px solid rgb(226 232 240);
  border-radius: 1rem;
  background: rgb(248 250 252);
  color: rgb(15 23 42);
  font-size: 0.92rem;
  line-height: 1.5;
  padding: 0.82rem 0.95rem;
  transition:
    border-color 0.18s ease,
    background-color 0.18s ease,
    box-shadow 0.18s ease;
}

.feedback-textarea:focus {
  outline: none;
  border-color: rgba(13, 148, 136, 0.48);
  background: #ffffff;
  box-shadow: 0 0 0 4px rgba(13, 148, 136, 0.12);
}
</style>
