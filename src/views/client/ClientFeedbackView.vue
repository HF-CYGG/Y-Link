<script setup lang="ts">
/**
 * 模块说明：src/views/client/ClientFeedbackView.vue
 * 文件职责：提供客户端反馈会话总览页，负责展示统计、会话列表与跳转到独立的新建页或详情页。
 * 实现逻辑：
 * - 会话页只负责“看列表”和“进详情”，避免与详情页职责重复；
 * - 页面通过真实后端接口与 SSE 订阅同步在线状态和列表变化，确保用户回到列表页时仍能看到最新进展。
 * 维护说明：
 * - 若后续增加筛选、搜索或分组，优先继续在本页扩展；
 * - 会话补充说明、消息时间线等深度操作统一放在详情页维护。
 */

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  FEEDBACK_PRIORITY_META_MAP,
  FEEDBACK_STATUS_META_MAP,
  getClientFeedbackPortalConfig,
  listClientFeedbackConversations,
  openFeedbackRealtimeStream,
  summarizeClientFeedbackConversations,
  type FeedbackConversationRecord,
  type FeedbackPortalAvailability,
  type FeedbackRealtimeConnection,
} from '@/api/modules/customer-service-feedback'
import { useClientAuthStore } from '@/store'
import pinia from '@/store/pinia'
import { formatDateTime } from '@/utils/date-time'
import { extractErrorMessage } from '@/utils/error'

const router = useRouter()
const clientAuthStore = useClientAuthStore(pinia)

const loading = ref(false)
const conversations = ref<FeedbackConversationRecord[]>([])
const portalNotice = ref('请尽量描述问题现象、出现时间和影响范围，便于客服持续跟进。')
const availability = ref<FeedbackPortalAvailability | null>(null)
const realtimeState = ref<'connecting' | 'online' | 'offline'>('offline')
const reconnectTip = ref('进入页面后会自动同步最新会话进展。')
let realtimeConnection: FeedbackRealtimeConnection | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

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
    return `当前在线，已有 ${availability.value.serviceConnectedCount} 位客服在线接待，可进入详情页实时沟通。`
  }
  return availability.value.offlineNotice
})

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

const handleNavigateToDetail = (conversationId: string) => {
  router.push(`/client/feedback/${conversationId}`)
}

const loadPortalConfig = async () => {
  const config = await getClientFeedbackPortalConfig()
  portalNotice.value = config.entryNotice
  availability.value = config.availability
  realtimeState.value = config.availability.isOnline ? 'online' : 'offline'
  reconnectTip.value = config.availability.isOnline
    ? '客服当前在线，进入详情页后会自动续接同一条会话。'
    : '客服当前离线，你仍可先进入详情页留言，客服上线后会从原会话继续跟进。'
}

const loadConversations = async () => {
  if (!currentClientUser.value?.id) {
    conversations.value = []
    return
  }

  loading.value = true
  try {
    conversations.value = await listClientFeedbackConversations()
  } finally {
    loading.value = false
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
      reconnectTip.value = '已恢复在线连接，后续消息会自动同步到会话列表。'
    },
    onConversation: async () => {
      await loadConversations()
      reconnectTip.value = '检测到会话有新进展，列表已自动刷新。'
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
      conversations.value = []
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
            class="inline-flex items-center gap-1 rounded-full px-2.5 py-1.5 text-sm font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            @click="handleNavigateBack"
          >
            <svg viewBox="0 0 20 20" fill="none" class="h-4 w-4" aria-hidden="true">
              <path d="M11.5 4.5L6 10l5.5 5.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <span>返回</span>
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

    <div class="space-y-4">
      <article class="rounded-[1.4rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
        <div class="flex items-center justify-between gap-3">
          <div>
            <p class="text-base font-semibold text-slate-900">新建反馈</p>
            <p class="mt-1 text-xs leading-5 text-slate-400">新问题将跳转到独立提交页，已创建的反馈请进入对应详情页继续补充。</p>
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
            <p class="mt-1 text-xs leading-5 text-slate-400">按最近更新时间排序，可从每张卡片右上角进入对应反馈单详情。</p>
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
          <article
            v-for="item in conversations"
            :key="item.id"
            class="rounded-[1rem] border border-slate-200 p-4 transition hover:border-slate-300 hover:bg-slate-50"
          >
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-semibold text-slate-900">{{ item.title }}</p>
                <p class="mt-1 text-xs text-slate-500">{{ item.issueNo }}</p>
              </div>

              <div class="flex shrink-0 items-center gap-2">
                <span
                  class="rounded-full px-2.5 py-1 text-[11px] font-semibold"
                  :class="FEEDBACK_STATUS_META_MAP[item.status].className"
                >
                  {{ FEEDBACK_STATUS_META_MAP[item.status].label }}
                </span>
                <button
                  type="button"
                  class="feedback-conversation-card__detail-button"
                  @click="handleNavigateToDetail(item.id)"
                >
                  详情
                </button>
              </div>
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
          </article>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
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

.feedback-conversation-card__detail-button {
  display: inline-flex;
  min-width: 3rem;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  white-space: nowrap;
  border-radius: 9999px;
  background: rgb(15 23 42);
  padding: 0.375rem 0.875rem;
  font-size: 0.75rem;
  font-weight: 600;
  line-height: 1.2;
  color: rgb(255 255 255);
  transition:
    background-color 0.18s ease,
    transform 0.18s ease,
    box-shadow 0.18s ease;
}

.feedback-conversation-card__detail-button:hover {
  background: rgb(30 41 59);
}

.feedback-conversation-card__detail-button:active {
  transform: translateY(1px);
}

.feedback-conversation-card__detail-button:focus-visible {
  outline: none;
  box-shadow: 0 0 0 4px rgba(15, 23, 42, 0.12);
}

@media (min-width: 1280px) {
  .feedback-summary-card {
    min-width: 0;
    flex: 1 1 0;
  }
}
</style>
