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

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  buildClientFeedbackNextStepPrompt,
  FEEDBACK_CATEGORY_OPTIONS,
  FEEDBACK_PRIORITY_META_MAP,
  FEEDBACK_STATUS_META_MAP,
  appendClientFeedbackMessage,
  confirmClientFeedbackResolved,
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
const confirmingResolved = ref(false)
const conversation = ref<FeedbackConversationRecord | null>(null)
const replyDraft = ref('')
const replyTextareaRef = ref<HTMLTextAreaElement | null>(null)
const availability = ref<FeedbackPortalAvailability | null>(null)
const realtimeState = ref<'connecting' | 'online' | 'offline'>('offline')
const reconnectTip = ref('进入页面后会自动续接当前会话。')
let realtimeConnection: FeedbackRealtimeConnection | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

const currentClientUser = computed(() => clientAuthStore.currentUser)
const currentConversationId = computed(() => {
  return typeof route.params.id === 'string' ? route.params.id : ''
})
const nextStepPrompt = computed(() => {
  return conversation.value ? buildClientFeedbackNextStepPrompt(conversation.value) : null
})
const offlineFaqEntries = computed(() => availability.value?.offlineFaqs ?? [])
const showOfflineFaq = computed(() => Boolean(availability.value && !availability.value.isOnline && offlineFaqEntries.value.length))
const canConfirmResolved = computed(() => conversation.value?.status === 'resolved')
const shouldShowReplyComposer = computed(() => conversation.value?.status !== 'closed')

/**
 * 详情页进度条采用固定四阶段表达：
 * - 已提交：反馈已创建成功，等待系统或客服接入；
 * - 客服跟进中：客服已接手，或客户端刚补充信息后重新回到处理队列；
 * - 待我确认：客服给出回复/结论后，当前更需要客户端确认或补充；
 * - 已完成：会话关闭，作为历史记录保留。
 */
const progressSteps = computed(() => {
  const currentConversation = conversation.value
  const currentStepIndex = !currentConversation
    ? -1
    : currentConversation.status === 'closed'
      ? 3
      : currentConversation.status === 'resolved' || currentConversation.unreadForClient > 0
        ? 2
        : currentConversation.status === 'processing' || currentConversation.unreadForStaff > 0
          ? 1
          : 0

  return [
    {
      key: 'submitted',
      label: '已提交',
      description: '反馈单已经创建，系统会保留完整上下文。',
      state: currentStepIndex > 0 ? 'done' : currentStepIndex === 0 ? 'current' : 'upcoming',
    },
    {
      key: 'processing',
      label: '客服跟进中',
      description: '客服会基于现有信息受理、排查并持续回复。',
      state: currentStepIndex > 1 ? 'done' : currentStepIndex === 1 ? 'current' : 'upcoming',
    },
    {
      key: 'waiting_client',
      label: '待我确认',
      description: '客服已给出阶段性回复，当前更需要你查看或继续补充。',
      state: currentStepIndex > 2 ? 'done' : currentStepIndex === 2 ? 'current' : 'upcoming',
    },
    {
      key: 'completed',
      label: '已完成',
      description: '当前反馈单已关闭，历史记录继续保留。',
      state: currentStepIndex === 3 ? 'current' : 'upcoming',
    },
  ] as const
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

/**
 * 消息角色显示文案：
 * - 客户端自己的消息保持“我”，延续当前会话语境；
 * - 客服消息明确标记为“客服”；
 * - 系统消息统一降级为“系统通知”，避免和人工回复混淆。
 */
const getMessageRoleLabel = (senderRole: 'client' | 'staff' | 'system') => {
  if (senderRole === 'client') {
    return '我'
  }
  if (senderRole === 'staff') {
    return '客服'
  }
  return '系统通知'
}

/**
 * 消息标题文案：
 * - 系统消息不再突出具体发送者姓名，而是直接展示“系统通知”；
 * - 客服与客户端仍保留原始发送者姓名，方便用户识别真实回复人。
 */
const getMessageTitle = (senderRole: 'client' | 'staff' | 'system', senderName: string) => {
  if (senderRole === 'system') {
    return '系统通知'
  }
  return senderName
}

/**
 * 会话消息卡片样式：
 * - 客户端消息保持主色块，突出“我刚刚补充了什么”；
 * - 客服消息使用普通白卡片，作为主要人工回复；
 * - 系统消息弱化为更窄、更浅、更轻的通知条，降低视觉占比。
 */
const getMessageCardClass = (senderRole: 'client' | 'staff' | 'system') => {
  if (senderRole === 'client') {
    return 'ml-auto border border-brand/10 bg-brand/10 text-slate-900'
  }
  if (senderRole === 'staff') {
    return 'border border-slate-200 bg-white text-slate-900'
  }
  return 'mx-auto border border-dashed border-slate-200 bg-slate-50/85 text-slate-600 shadow-none'
}

const getMessageContainerClass = (senderRole: 'client' | 'staff' | 'system') => {
  return senderRole === 'system' ? 'max-w-[92%]' : 'max-w-full'
}

const getMessageTitleClass = (senderRole: 'client' | 'staff' | 'system') => {
  return senderRole === 'system' ? 'text-xs font-semibold text-slate-500' : 'text-sm font-semibold text-slate-900'
}

const getMessageBodyClass = (senderRole: 'client' | 'staff' | 'system') => {
  return senderRole === 'system'
    ? 'mt-2 whitespace-pre-wrap text-xs leading-6 text-slate-500'
    : 'mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700'
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

const handleConfirmResolved = async () => {
  if (!conversation.value) {
    ElMessage.warning('当前反馈单尚未加载完成')
    return
  }
  if (conversation.value.status !== 'resolved') {
    ElMessage.warning('当前反馈单还未进入待确认阶段')
    return
  }

  confirmingResolved.value = true
  try {
    await confirmClientFeedbackResolved(conversation.value.id)
    await loadConversationDetail(conversation.value.id)
    reconnectTip.value = '你已确认处理完成，当前反馈单已归档保留。'
    ElMessage.success('已确认问题处理完成')
  } catch (error) {
    ElMessage.error(extractErrorMessage(error, '确认处理结果失败，请稍后重试'))
  } finally {
    confirmingResolved.value = false
  }
}

/**
 * “仍未解决，继续反馈”动作用于把用户直接带到补充说明区：
 * - 若输入框当前为空，自动补一段简短开头，降低继续反馈的表达门槛；
 * - 再滚动并聚焦到输入框，让“待我确认”真正具备下一步动作。
 */
const handleContinueFeedback = async () => {
  if (!canConfirmResolved.value) {
    return
  }

  if (!normalizeSubmitText(replyDraft.value)) {
    replyDraft.value = '当前问题仍未解决，补充说明如下：\n'
  }

  await nextTick()
  replyTextareaRef.value?.scrollIntoView({
    behavior: 'smooth',
    block: 'center',
  })
  replyTextareaRef.value?.focus()
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
            class="inline-flex items-center gap-1 rounded-full px-2.5 py-1.5 text-sm font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            @click="handleNavigateBack"
          >
            <svg viewBox="0 0 20 20" fill="none" class="h-4 w-4" aria-hidden="true">
              <path d="M11.5 4.5L6 10l5.5 5.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <span>返回</span>
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

        <div class="mt-5 grid gap-3 lg:grid-cols-[1.3fr_0.9fr]">
          <div class="rounded-[1rem] bg-slate-50 p-4">
            <div class="flex items-center justify-between gap-3">
              <div>
                <p class="text-xs font-semibold tracking-[0.16em] text-slate-400">处理进度</p>
                <p class="mt-1 text-sm text-slate-500">统一用四个阶段说明当前反馈单所处位置，减少“看见状态但不知道下一步”的落差。</p>
              </div>
              <span
                v-if="nextStepPrompt"
                class="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-600 ring-1 ring-inset ring-slate-200"
              >
                {{ nextStepPrompt.groupLabel }}
              </span>
            </div>

            <div class="mt-4 space-y-3">
              <div
                v-for="(step, index) in progressSteps"
                :key="step.key"
                class="flex items-start gap-3"
              >
                <div class="flex flex-col items-center">
                  <span
                    class="flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold"
                    :class="
                      step.state === 'done'
                        ? 'bg-emerald-500 text-white'
                        : step.state === 'current'
                          ? 'bg-slate-900 text-white'
                          : 'bg-white text-slate-400 ring-1 ring-inset ring-slate-200'
                    "
                  >
                    {{ index + 1 }}
                  </span>
                  <span
                    v-if="index < progressSteps.length - 1"
                    class="mt-2 h-8 w-px"
                    :class="step.state === 'upcoming' ? 'bg-slate-200' : 'bg-slate-300'"
                  />
                </div>
                <div class="min-w-0 flex-1 pb-2">
                  <p class="text-sm font-semibold" :class="step.state === 'upcoming' ? 'text-slate-500' : 'text-slate-900'">
                    {{ step.label }}
                  </p>
                  <p class="mt-1 text-xs leading-5 text-slate-500">{{ step.description }}</p>
                </div>
              </div>
            </div>
          </div>

          <div class="rounded-[1rem] bg-slate-50 p-4">
            <p class="text-xs font-semibold tracking-[0.16em] text-slate-400">进度提示</p>
            <div v-if="nextStepPrompt" class="mt-3 space-y-3">
              <div class="rounded-[0.9rem] bg-white px-3 py-3">
                <p class="text-xs font-medium text-slate-400">当前阶段</p>
                <p class="mt-1 text-sm font-semibold text-slate-900">{{ nextStepPrompt.stageLabel }}</p>
              </div>
              <div class="rounded-[0.9rem] bg-white px-3 py-3">
                <p class="text-xs font-medium text-slate-400">最近动作</p>
                <p class="mt-1 text-sm leading-6 text-slate-600">{{ nextStepPrompt.recentAction }}</p>
              </div>
              <div class="rounded-[0.9rem] bg-white px-3 py-3">
                <p class="text-xs font-medium text-slate-400">建议下一步</p>
                <p class="mt-1 text-sm leading-6 text-slate-600">{{ nextStepPrompt.nextStep }}</p>
              </div>
              <div v-if="canConfirmResolved" class="grid gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  class="rounded-[0.9rem] bg-emerald-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
                  :disabled="confirmingResolved"
                  @click="handleConfirmResolved"
                >
                  {{ confirmingResolved ? '确认中...' : '确认已解决' }}
                </button>
                <button
                  type="button"
                  class="rounded-[0.9rem] border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-slate-50"
                  @click="handleContinueFeedback"
                >
                  仍未解决，继续反馈
                </button>
              </div>
            </div>
          </div>
        </div>

        <article v-if="showOfflineFaq" class="mt-5 rounded-[1rem] border border-amber-200 bg-amber-50/70 p-4">
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-sm font-semibold text-slate-900">离线常见问题</p>
              <p class="mt-1 text-xs leading-5 text-slate-500">客服当前离线时，可先查看常见问题答案；如果当前反馈单还有新增现象，仍可直接在下方继续补充。</p>
            </div>
            <span class="rounded-full bg-white px-3 py-1 text-xs font-semibold text-amber-700">离线导流</span>
          </div>
          <div class="mt-4 grid gap-3">
            <article
              v-for="item in offlineFaqEntries"
              :key="item.question"
              class="rounded-[0.9rem] bg-white px-4 py-3"
            >
              <p class="text-sm font-semibold text-slate-900">{{ item.question }}</p>
              <p class="mt-2 text-xs leading-6 text-slate-500">{{ item.answer }}</p>
            </article>
          </div>
        </article>

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
            class="rounded-[1rem] px-4 py-3 transition"
            :class="[getMessageCardClass(message.senderRole), getMessageContainerClass(message.senderRole)]"
          >
            <div class="flex flex-wrap items-center justify-between gap-2">
              <p :class="getMessageTitleClass(message.senderRole)">
                {{ getMessageTitle(message.senderRole, message.senderName) }}
                <span
                  class="ml-2 rounded-full px-2 py-0.5 text-[0.68rem] font-medium"
                  :class="message.senderRole === 'system' ? 'bg-slate-200/80 text-slate-500' : 'bg-slate-100 text-slate-500'"
                >
                  {{ getMessageRoleLabel(message.senderRole) }}
                </span>
              </p>
              <span class="text-xs text-slate-400">{{ formatDateTime(message.createdAt) }}</span>
            </div>
            <p :class="getMessageBodyClass(message.senderRole)">{{ message.body }}</p>
          </article>
        </div>
      </article>

      <article v-if="shouldShowReplyComposer" class="rounded-[1rem] border border-slate-200 bg-white p-4">
        <p class="text-base font-semibold text-slate-900">继续补充说明</p>
        <p class="mt-1 text-xs text-slate-400">同一问题后续有新现象时，直接追加消息即可，不需要重新新建反馈。</p>
        <textarea
          ref="replyTextareaRef"
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
