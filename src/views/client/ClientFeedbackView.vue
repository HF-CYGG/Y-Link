<script setup lang="ts">
/**
 * 模块说明：src/views/client/ClientFeedbackView.vue
 * 文件职责：提供客户端统一反馈会话页，负责历史会话查看、续接沟通与跳转到独立新建反馈页，并将左上返回入口收敛为更轻量的小箭头样式。
 * 实现逻辑：
 * - 页面主视图聚焦“我的反馈会话”和当前线程沟通，新增反馈通过独立按钮跳转到专门的新建页；
 * - 新建页和会话页分离后，会话页首屏信息更聚焦，用户更容易先继续已有会话而不是重复建单；
 * - 页面通过真实后端接口与 SSE 订阅同步在线状态、离线提示和续接结果，确保客户端与客服工作台数据一致。
 * 维护说明：
 * - 若后续需要扩展附件上传、截图或满意度评价，建议继续在当前页面局部扩展，不再拆分页级流程；
 * - 若客服在线规则改为后端动态可配置，优先复用共享 API 中的 availability 字段，不在页面层重复推导。
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
  listClientFeedbackConversations,
  openFeedbackRealtimeStream,
  summarizeClientFeedbackConversations,
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
const selectedConversationId = ref('')
const selectedConversation = ref<FeedbackConversationRecord | null>(null)
const replyDraft = ref('')
const conversations = ref<FeedbackConversationRecord[]>([])
const portalNotice = ref('请尽量描述问题现象、出现时间和影响范围，便于客服持续跟进。')
const availability = ref<FeedbackPortalAvailability | null>(null)
const realtimeState = ref<'connecting' | 'online' | 'offline'>('offline')
const reconnectTip = ref('进入页面后会自动续接当前在线会话。')
let realtimeConnection: FeedbackRealtimeConnection | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
const preferredConversationId = ref('')

const currentClientUser = computed(() => clientAuthStore.currentUser)
const summary = computed(() => summarizeClientFeedbackConversations(conversations.value))
const summaryCards = computed(() => {
  return [
    { key: 'all', label: '全部会话', value: summary.value.all, valueClassName: 'text-slate-900' },
    { key: 'pending', label: '待受理', value: summary.value.pending, valueClassName: 'text-amber-600' },
    { key: 'processing', label: '处理中', value: summary.value.processing, valueClassName: 'text-sky-600' },
    { key: 'resolved', label: '已解决', value: summary.value.resolved, valueClassName: 'text-emerald-600' },
    { key: 'closed', label: '已关闭', value: summary.value.closed, valueClassName: 'text-slate-600' },
  ]
})

const availabilityText = computed(() => {
  if (!availability.value) {
    return '正在确认客服在线状态...'
  }
  if (availability.value.isOnline) {
    return `当前在线，已有 ${availability.value.serviceConnectedCount} 位客服在线接待，可在当前会话实时沟通。`
  }
  return availability.value.offlineNotice
})

const getCategoryLabel = (category: FeedbackIssueCategory) => {
  return FEEDBACK_CATEGORY_OPTIONS.find((item) => item.value === category)?.label ?? '其他建议'
}

/**
 * 返回上一页：
 * - 优先遵循用户真实浏览路径返回；
 * - 若当前是首次直达反馈页，则回退到“我的”页，避免返回空白或站外页面。
 */
const handleNavigateBack = () => {
  if (globalThis.history.length > 1) {
    router.back()
    return
  }
  router.push('/client/profile')
}

const handleNavigateToCreate = () => {
  router.push('/client/feedback/create')
}

const loadPortalConfig = async () => {
  const config = await getClientFeedbackPortalConfig()
  portalNotice.value = config.entryNotice
  availability.value = config.availability
  realtimeState.value = config.availability.isOnline ? 'online' : 'offline'
  reconnectTip.value = config.availability.isOnline
    ? '客服当前在线，进入页面后会自动续接同一条会话。'
    : '客服当前离线，你仍可先留言，客服上线后会从当前会话继续跟进。'
}

const loadConversationDetail = async (conversationId: string) => {
  if (!conversationId) {
    selectedConversation.value = null
    return
  }

  detailLoading.value = true
  try {
    selectedConversation.value = await getClientFeedbackConversation(conversationId)
  } finally {
    detailLoading.value = false
  }
}

const loadConversations = async () => {
  if (!currentClientUser.value?.id) {
    conversations.value = []
    selectedConversation.value = null
    selectedConversationId.value = ''
    return
  }

  loading.value = true
  try {
    conversations.value = await listClientFeedbackConversations()
    if (!conversations.value.length) {
      selectedConversationId.value = ''
      selectedConversation.value = null
      preferredConversationId.value = ''
      return
    }

    const hasPreferredSelection = preferredConversationId.value
      && conversations.value.some((item) => item.id === preferredConversationId.value)
    if (hasPreferredSelection) {
      selectedConversationId.value = preferredConversationId.value
      preferredConversationId.value = ''
    }

    const hasCurrentSelection = conversations.value.some((item) => item.id === selectedConversationId.value)
    if (!hasCurrentSelection) {
      selectedConversationId.value = conversations.value[0].id
    }
    await loadConversationDetail(selectedConversationId.value)
  } finally {
    loading.value = false
  }
}

const handleSelectConversation = async (conversationId: string) => {
  selectedConversationId.value = conversationId
  await loadConversationDetail(conversationId)
}

const handleReply = async () => {
  if (!selectedConversation.value) {
    ElMessage.warning('请先选择一条会话')
    return
  }

  const normalizedReply = normalizeSubmitText(replyDraft.value)
  if (!normalizedReply) {
    ElMessage.warning('请输入要补充的说明')
    return
  }

  replySubmitting.value = true
  try {
    await appendClientFeedbackMessage(selectedConversation.value.id, {
      body: normalizedReply,
    })
    replyDraft.value = ''
    await loadConversations()
    reconnectTip.value = '已自动续接当前会话，你的新补充已提交给客服。'
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
      reconnectTip.value = '已恢复在线连接，后续消息会自动同步到当前会话。'
    },
    onConversation: async () => {
      await loadConversations()
      reconnectTip.value = '检测到会话有新进展，已为你自动续接最新消息。'
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
    if (!currentClientUser.value?.id) {
      return
    }
    try {
      await loadPortalConfig()
      await loadConversations()
      connectRealtime()
    } catch (error) {
      ElMessage.error(extractErrorMessage(error, '反馈中心初始化失败，请稍后重试'))
    }
  },
)

watch(
  () => route.query.conversationId,
  (conversationId) => {
    preferredConversationId.value = typeof conversationId === 'string' ? conversationId : ''
  },
  {
    immediate: true,
  },
)

onMounted(async () => {
  if (!currentClientUser.value?.id) {
    return
  }
  try {
    await loadPortalConfig()
    await loadConversations()
    connectRealtime()
  } catch (error) {
    ElMessage.error(extractErrorMessage(error, '反馈中心加载失败，请稍后重试'))
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
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <button
            type="button"
            class="inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label="返回上一页"
            @click="handleNavigateBack"
          >
            <svg viewBox="0 0 20 20" fill="none" class="h-4 w-4" aria-hidden="true">
              <path d="M11.5 4.5L6 10l5.5 5.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <p class="text-xl font-semibold text-slate-900">反馈会话</p>
          <p class="mt-1 text-sm leading-6 text-slate-500">
            查看历史反馈并继续补充说明；如需新增问题，可进入独立的新建反馈页提交。
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

    <div class="feedback-summary-strip">
      <article
        v-for="item in summaryCards"
        :key="item.key"
        class="feedback-summary-card rounded-[1.2rem] bg-white px-4 py-3 shadow-[var(--ylink-shadow-soft)]"
      >
        <p class="truncate text-xs font-medium tracking-[0.12em] text-slate-400">{{ item.label }}</p>
        <p class="text-xl font-semibold" :class="item.valueClassName">{{ item.value }}</p>
      </article>
    </div>

    <div class="grid gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
      <div class="space-y-4">
        <article class="rounded-[1.4rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
          <div class="flex items-center justify-between gap-3">
            <div>
              <p class="text-base font-semibold text-slate-900">新建反馈</p>
              <p class="mt-1 text-xs leading-5 text-slate-400">新问题将跳转到独立提交页，已创建的反馈请继续在原会话补充。</p>
            </div>
            <span class="rounded-full bg-brand/10 px-3 py-1 text-xs font-semibold text-brand">独立提交页</span>
          </div>
          <button
            type="button"
            class="mt-4 flex w-full items-center justify-between rounded-[1rem] border border-brand/20 bg-brand/5 px-4 py-3 text-left transition hover:border-brand/35 hover:bg-brand/10"
            @click="handleNavigateToCreate"
          >
            <div>
              <p class="text-sm font-semibold text-slate-900">进入新建反馈页</p>
              <p class="mt-1 text-xs leading-5 text-slate-500">{{ portalNotice }}</p>
            </div>
            <span class="rounded-full bg-brand px-3 py-1 text-xs font-semibold text-white">新建</span>
          </button>
        </article>

        <article class="rounded-[1.4rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
          <div class="flex items-center justify-between gap-3">
            <div>
              <p class="text-base font-semibold text-slate-900">我的会话</p>
              <p class="mt-1 text-xs leading-5 text-slate-400">按最近更新时间排序，继续补充说明时无需重新建单。</p>
            </div>
            <span class="text-xs font-medium text-slate-400">{{ conversations.length }} 条</span>
          </div>

          <div v-if="loading" class="mt-4 rounded-[1rem] bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
            正在加载会话...
          </div>

          <div v-else-if="!conversations.length" class="mt-4 rounded-[1rem] bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
            还没有反馈记录，可先提交一条新的问题说明。
          </div>

          <div v-else class="mt-4 space-y-3">
            <button
              v-for="item in conversations"
              :key="item.id"
              type="button"
              class="block w-full rounded-[1rem] border p-4 text-left transition"
              :class="item.id === selectedConversationId ? 'border-brand bg-brand/5' : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'"
              @click="handleSelectConversation(item.id)"
            >
              <div class="flex flex-wrap items-start justify-between gap-2">
                <div class="min-w-0">
                  <p class="truncate text-sm font-semibold text-slate-900">{{ item.title }}</p>
                  <p class="mt-1 text-xs text-slate-500">{{ item.issueNo }}</p>
                </div>
                <span
                  class="rounded-full px-2.5 py-1 text-[11px] font-semibold"
                  :class="FEEDBACK_STATUS_META_MAP[item.status].className"
                >
                  {{ FEEDBACK_STATUS_META_MAP[item.status].label }}
                </span>
              </div>

              <p class="mt-3 line-clamp-2 text-sm leading-6 text-slate-600">{{ item.summary }}</p>

              <div class="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                <span class="rounded-full px-2.5 py-1 font-medium" :class="FEEDBACK_PRIORITY_META_MAP[item.priority].className">
                  {{ FEEDBACK_PRIORITY_META_MAP[item.priority].label }}
                </span>
                <span>{{ item.fields.issueType === 'bug' ? '专业 BUG' : '普通建议' }}</span>
                <span>更新于 {{ formatDateTime(item.lastMessageAt) }}</span>
                <span v-if="item.unreadForClient > 0" class="rounded-full bg-rose-50 px-2 py-1 font-medium text-rose-600">
                  {{ item.unreadForClient }} 条未读
                </span>
              </div>
            </button>
          </div>
        </article>
      </div>

      <div class="space-y-4">
        <article v-if="selectedConversation" class="rounded-[1.4rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
          <div v-if="detailLoading" class="mb-4 rounded-[1rem] bg-slate-50 px-4 py-3 text-sm text-slate-500">
            正在同步会话详情...
          </div>

          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="text-xs font-semibold tracking-[0.16em] text-slate-400">{{ selectedConversation.issueNo }}</p>
              <p class="mt-2 text-xl font-semibold text-slate-900">{{ selectedConversation.title }}</p>
              <p class="mt-2 text-sm leading-6 text-slate-500">{{ selectedConversation.summary }}</p>
            </div>

            <div class="flex flex-wrap items-center gap-2">
              <span
                class="rounded-full px-3 py-1.5 text-xs font-semibold"
                :class="FEEDBACK_STATUS_META_MAP[selectedConversation.status].className"
              >
                {{ FEEDBACK_STATUS_META_MAP[selectedConversation.status].label }}
              </span>
              <span
                class="rounded-full px-3 py-1.5 text-xs font-semibold"
                :class="FEEDBACK_PRIORITY_META_MAP[selectedConversation.priority].className"
              >
                {{ FEEDBACK_PRIORITY_META_MAP[selectedConversation.priority].label }}
              </span>
            </div>
          </div>

          <div class="mt-5 grid gap-3 lg:grid-cols-2">
            <div class="rounded-[1rem] bg-slate-50 p-4">
              <p class="text-xs font-semibold tracking-[0.16em] text-slate-400">Issue 字段</p>
              <dl class="mt-3 space-y-3 text-sm">
                <div>
                  <dt class="text-slate-400">问题类型</dt>
                  <dd class="mt-1 font-medium text-slate-900">{{ selectedConversation.fields.issueType === 'bug' ? '专业 BUG' : '普通建议' }}</dd>
                </div>
                <div>
                  <dt class="text-slate-400">问题分类</dt>
                  <dd class="mt-1 font-medium text-slate-900">{{ getCategoryLabel(selectedConversation.fields.category) }}</dd>
                </div>
                <div>
                  <dt class="text-slate-400">来源入口</dt>
                  <dd class="mt-1 font-medium text-slate-900">{{ selectedConversation.fields.sourceLabel }}</dd>
                </div>
                <div>
                  <dt class="text-slate-400">关联订单号</dt>
                  <dd class="mt-1 font-medium text-slate-900">{{ selectedConversation.fields.orderRef || '未关联' }}</dd>
                </div>
                <div>
                  <dt class="text-slate-400">期望结果</dt>
                  <dd class="mt-1 leading-6 text-slate-900">{{ selectedConversation.fields.expectedResult || '未填写' }}</dd>
                </div>
                <div>
                  <dt class="text-slate-400">实际结果</dt>
                  <dd class="mt-1 leading-6 text-slate-900">{{ selectedConversation.fields.actualResult || '未填写' }}</dd>
                </div>
              </dl>
            </div>

            <div class="rounded-[1rem] bg-slate-50 p-4">
              <p class="text-xs font-semibold tracking-[0.16em] text-slate-400">补充信息</p>
              <dl class="mt-3 space-y-3 text-sm">
                <div>
                  <dt class="text-slate-400">复现步骤</dt>
                  <dd class="mt-1 leading-6 text-slate-900">{{ selectedConversation.fields.reproductionSteps || '未填写' }}</dd>
                </div>
                <div>
                  <dt class="text-slate-400">联系偏好</dt>
                  <dd class="mt-1 leading-6 text-slate-900">{{ selectedConversation.fields.contactPreference || '站内会话回复' }}</dd>
                </div>
                <div>
                  <dt class="text-slate-400">客服负责人</dt>
                  <dd class="mt-1 font-medium text-slate-900">{{ selectedConversation.assigneeName || '待分配' }}</dd>
                </div>
                <div>
                  <dt class="text-slate-400">标签</dt>
                  <dd class="mt-2 flex flex-wrap gap-2">
                    <span
                      v-for="tag in selectedConversation.fields.tags"
                      :key="tag"
                      class="rounded-full bg-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700"
                    >
                      {{ tag }}
                    </span>
                    <span v-if="!selectedConversation.fields.tags.length" class="text-slate-500">暂无标签</span>
                  </dd>
                </div>
              </dl>
            </div>
          </div>

          <div class="mt-5 rounded-[1rem] border border-slate-200 bg-slate-50/80 p-4">
            <div class="flex items-center justify-between gap-3">
              <div>
                <p class="text-base font-semibold text-slate-900">会话记录</p>
                <p class="mt-1 text-xs text-slate-400">所有消息按时间顺序展示，便于围绕同一 Issue 持续协作。</p>
              </div>
              <span class="text-xs text-slate-400">{{ selectedConversation.messages.length }} 条消息</span>
            </div>

            <div class="mt-4 space-y-3">
              <article
                v-for="message in selectedConversation.messages"
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
          </div>

          <div class="mt-5 rounded-[1rem] border border-slate-200 bg-white p-4">
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
          </div>
        </article>

        <article v-else class="rounded-[1.4rem] bg-white p-8 text-center shadow-[var(--ylink-shadow-soft)]">
          <p class="text-base font-semibold text-slate-900">还没有打开任何会话</p>
          <p class="mt-2 text-sm leading-6 text-slate-500">
            先在左侧提交一条反馈，或者从历史记录中选中一条会话，即可查看客服处理状态与消息往来。
          </p>
        </article>
      </div>
    </div>
  </section>
</template>

<style scoped>
/*
 * 页面输入控件统一收口为圆角卡片风格：
 * - 保持客户端视觉语言一致；
 * - 避免原生表单控件在不同浏览器下出现割裂边框。
 */
.feedback-input,
.feedback-textarea {
  width: 100%;
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

.feedback-input:focus,
.feedback-textarea:focus {
  outline: none;
  border-color: rgba(13, 148, 136, 0.48);
  background: #ffffff;
  box-shadow: 0 0 0 4px rgba(13, 148, 136, 0.12);
}

.feedback-textarea {
  min-height: 120px;
  resize: vertical;
}

.feedback-textarea--short {
  min-height: 96px;
}

/*
 * 统计卡片改为单行横向紧凑布局：
 * - 默认保持一行连续滚动，优先保证会话页首屏信息密度；
 * - 在更宽屏幕上自动均分宽度，避免出现左右留白不均。
 */
.feedback-summary-strip {
  display: flex;
  gap: 0.75rem;
  overflow-x: auto;
  padding-bottom: 0.25rem;
  scrollbar-width: none;
}

.feedback-summary-strip::-webkit-scrollbar {
  display: none;
}

.feedback-summary-card {
  display: flex;
  min-width: 8.75rem;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 0.9rem;
}

@media (min-width: 1280px) {
  .feedback-summary-card {
    min-width: 0;
    flex: 1 1 0;
  }
}
</style>
