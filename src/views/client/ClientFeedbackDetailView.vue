<script setup lang="ts">
/**
 * 模块说明：src/views/client/ClientFeedbackDetailView.vue
 * 文件职责：提供客户端单条反馈单的独立详情页，集中展示 Issue 字段、附件证据、满意度评价与继续补充说明。
 * 实现逻辑：
 * - 页面按路由参数加载当前反馈单详情，进入后自动续接实时状态和消息变化；
 * - 附件与评价都复用当前反馈单详情接口回显，尽量不打断既有确认已解决与实时续接链路；
 * - 仅在当前会话发生变化时重拉详情，避免返回列表页才能看到最新处理进度。
 * 维护说明：
 * - 当前附件上传仅开放图片类型，若后续扩展文档附件，需要同步补充预览与安全策略；
 * - 列表页仅保留导航职责，详情相关交互统一在此页维护。
 */

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  buildClientFeedbackNextStepPrompt,
  FEEDBACK_CATEGORY_OPTIONS,
  FEEDBACK_PRIORITY_META_MAP,
  FEEDBACK_SATISFACTION_META_MAP,
  FEEDBACK_STATUS_META_MAP,
  appendClientFeedbackMessage,
  confirmClientFeedbackResolved,
  getClientFeedbackConversation,
  getClientFeedbackPortalConfig,
  openFeedbackRealtimeStream,
  resolveFeedbackAttachmentUrl,
  submitClientFeedbackSatisfaction,
  uploadClientFeedbackAttachment,
  type FeedbackConversationRecord,
  type FeedbackConversationMessageAttachment,
  type FeedbackIssueCategory,
  type FeedbackMessageSenderRole,
  type FeedbackPortalAvailability,
  type FeedbackRealtimeConnection,
  type FeedbackSatisfactionLevel,
} from '@/api/modules/customer-service-feedback'
import { useClientAuthStore } from '@/store'
import pinia from '@/store/pinia'
import { formatDateTime } from '@/utils/date-time'
import { extractErrorMessage } from '@/utils/error'
import { normalizeSubmitText } from '@/utils/submit-feedback'

const route = useRoute()
const router = useRouter()
const clientAuthStore = useClientAuthStore(pinia)
const FEEDBACK_ATTACHMENT_LIMIT = 9
const FEEDBACK_ATTACHMENT_MAX_SIZE = 10 * 1024 * 1024

const loading = ref(false)
const detailLoading = ref(false)
const replySubmitting = ref(false)
const confirmingResolved = ref(false)
const uploadingReplyAttachments = ref(false)
const satisfactionSubmitting = ref(false)
const satisfactionDialogVisible = ref(false)
const conversation = ref<FeedbackConversationRecord | null>(null)
const replyDraft = ref('')
const replyAttachments = ref<FeedbackConversationMessageAttachment[]>([])
const satisfactionComment = ref('')
const selectedSatisfactionLevel = ref<FeedbackSatisfactionLevel>('satisfied')
const replyTextareaRef = ref<HTMLTextAreaElement | null>(null)
const replyAttachmentInputRef = ref<HTMLInputElement | null>(null)
const availability = ref<FeedbackPortalAvailability | null>(null)
const realtimeState = ref<'connecting' | 'online' | 'offline'>('offline')
const reconnectTip = ref('进入页面后会自动续接当前会话。')
const previewImageUrl = ref('')
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
const canRateSatisfaction = computed(() => {
  return conversation.value?.status === 'resolved' || conversation.value?.status === 'closed'
})
const hasRatedSatisfaction = computed(() => Boolean(conversation.value?.satisfaction))
const showSatisfactionEntry = computed(() => canRateSatisfaction.value && !hasRatedSatisfaction.value)
const currentSatisfactionMeta = computed(() => {
  const level = conversation.value?.satisfaction?.level
  return level ? FEEDBACK_SATISFACTION_META_MAP[level] : null
})
/**
 * 满意度评价选项按“满意 -> 一般 -> 不满意”排序：
 * - 默认选中满意时，视觉阅读方向更贴近处理结果确认场景；
 * - 统一从元信息映射读取文案，避免再次手写字符串导致 key 拼写错误。
 */
const satisfactionOptionOrder = ['satisfied', 'neutral', 'unsatisfied'] as const satisfies readonly FeedbackSatisfactionLevel[]
const satisfactionCardOptions = satisfactionOptionOrder.map((level) => ({
  value: level,
  label: FEEDBACK_SATISFACTION_META_MAP[level].label,
  description: FEEDBACK_SATISFACTION_META_MAP[level].description,
}))
const selectedSatisfactionMeta = computed(() => {
  return FEEDBACK_SATISFACTION_META_MAP[selectedSatisfactionLevel.value]
})
const conversationAttachmentEntries = computed(() => {
  const currentConversation = conversation.value
  if (!currentConversation) {
    return []
  }
  return currentConversation.messages.flatMap((message) => {
    return message.attachments.map((attachment) => ({
      id: `${message.id}-${attachment.url}`,
      messageId: message.id,
      senderName: getMessageTitle(message.senderRole, message.senderName),
      senderRole: message.senderRole,
      createdAt: message.createdAt,
      attachment,
    }))
  })
})

type FeedbackProgressStepState = 'done' | 'current' | 'upcoming'

const resolveProgressStepIndex = (currentConversation: FeedbackConversationRecord | null) => {
  if (currentConversation === null) {
    return -1
  }
  if (currentConversation.status === 'closed') {
    return 3
  }
  if (currentConversation.status === 'resolved' || currentConversation.unreadForClient > 0) {
    return 2
  }
  if (currentConversation.status === 'processing' || currentConversation.unreadForStaff > 0) {
    return 1
  }
  return 0
}

const resolveProgressStepState = (
  currentStepIndex: number,
  stepIndex: number,
): FeedbackProgressStepState => {
  if (currentStepIndex > stepIndex) {
    return 'done'
  }
  if (currentStepIndex === stepIndex) {
    return 'current'
  }
  return 'upcoming'
}

/**
 * 详情页进度条采用固定四阶段表达：
 * - 已提交：反馈已创建成功，等待系统或客服接入；
 * - 客服跟进中：客服已接手，或客户端刚补充信息后重新回到处理队列；
 * - 待我确认：客服给出回复/结论后，当前更需要客户端确认或补充；
 * - 已完成：会话关闭，作为历史记录保留。
 */
const progressSteps = computed(() => {
  const currentStepIndex = resolveProgressStepIndex(conversation.value)

  return [
    {
      key: 'submitted',
      label: '已提交',
      description: '反馈单已经创建，系统会保留完整上下文。',
      state: resolveProgressStepState(currentStepIndex, 0),
    },
    {
      key: 'processing',
      label: '客服跟进中',
      description: '客服会基于现有信息受理、排查并持续回复。',
      state: resolveProgressStepState(currentStepIndex, 1),
    },
    {
      key: 'waiting_client',
      label: '待我确认',
      description: '客服已给出阶段性回复，当前更需要你查看或继续补充。',
      state: resolveProgressStepState(currentStepIndex, 2),
    },
    {
      key: 'completed',
      label: '已完成',
      description: '当前反馈单已关闭，历史记录继续保留。',
      state: resolveProgressStepState(currentStepIndex, 3),
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
const getMessageRoleLabel = (senderRole: FeedbackMessageSenderRole) => {
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
const getMessageTitle = (senderRole: FeedbackMessageSenderRole, senderName: string) => {
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
const getMessageCardClass = (senderRole: FeedbackMessageSenderRole) => {
  if (senderRole === 'client') {
    return 'ml-auto border border-brand/10 bg-brand/10 text-slate-900'
  }
  if (senderRole === 'staff') {
    return 'border border-slate-200 bg-white text-slate-900'
  }
  return 'mx-auto border border-dashed border-slate-200 bg-slate-50/85 text-slate-600 shadow-none'
}

const getMessageContainerClass = (senderRole: FeedbackMessageSenderRole) => {
  return senderRole === 'system' ? 'max-w-[92%]' : 'max-w-full'
}

const getMessageTitleClass = (senderRole: FeedbackMessageSenderRole) => {
  return senderRole === 'system' ? 'text-xs font-semibold text-slate-500' : 'text-sm font-semibold text-slate-900'
}

const getMessageBodyClass = (senderRole: FeedbackMessageSenderRole) => {
  return senderRole === 'system'
    ? 'mt-2 whitespace-pre-wrap text-xs leading-6 text-slate-500'
    : 'mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700'
}

const formatAttachmentSize = (size: number | null) => {
  if (!size || size <= 0) {
    return '大小未知'
  }
  if (size >= 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`
  }
  return `${Math.max(1, Math.round(size / 1024))} KB`
}

const resolveAttachmentUrl = (attachment: FeedbackConversationMessageAttachment) => {
  return resolveFeedbackAttachmentUrl(attachment.url)
}

const isImageAttachment = (attachment: FeedbackConversationMessageAttachment) => {
  const normalizedMimeType = attachment.mimeType?.toLowerCase() || ''
  if (normalizedMimeType.startsWith('image/')) {
    return true
  }
  return /\.(png|jpe?g|gif|webp)$/i.test(attachment.name)
}

const openAttachmentPreview = (attachment: FeedbackConversationMessageAttachment) => {
  const targetUrl = resolveAttachmentUrl(attachment)
  if (!targetUrl) {
    ElMessage.warning('当前附件地址无效，暂时无法预览')
    return
  }
  if (!isImageAttachment(attachment)) {
    window.open(targetUrl, '_blank', 'noopener')
    return
  }
  previewImageUrl.value = targetUrl
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
    satisfactionComment.value = detail.satisfaction?.comment || ''
    selectedSatisfactionLevel.value = detail.satisfaction?.level || 'satisfied'
    if (detail.satisfaction) {
      satisfactionDialogVisible.value = false
    }
  } finally {
    detailLoading.value = false
    loading.value = false
  }
}

const openReplyAttachmentPicker = () => {
  replyAttachmentInputRef.value?.click()
}

/**
 * 详情页补充说明与新建页保持同一上传约束：
 * - 单条补充消息最多 9 个附件；
 * - 仅支持图片，减少客服侧消息渲染与安全策略分叉。
 */
const handleReplyAttachmentChange = async (event: Event) => {
  const input = event.target as HTMLInputElement | null
  const files = Array.from(input?.files ?? [])
  if (!files.length) {
    return
  }

  if (replyAttachments.value.length >= FEEDBACK_ATTACHMENT_LIMIT) {
    ElMessage.warning(`单条补充消息最多上传 ${FEEDBACK_ATTACHMENT_LIMIT} 张图片`)
    if (input) {
      input.value = ''
    }
    return
  }

  const remainCount = FEEDBACK_ATTACHMENT_LIMIT - replyAttachments.value.length
  const targetFiles = files.slice(0, remainCount)
  uploadingReplyAttachments.value = true
  try {
    for (const file of targetFiles) {
      if (!file.type.startsWith('image/')) {
        ElMessage.warning(`文件 ${file.name} 不是图片，已跳过`)
        continue
      }
      if (file.size > FEEDBACK_ATTACHMENT_MAX_SIZE) {
        ElMessage.warning(`文件 ${file.name} 超过 10MB，已跳过`)
        continue
      }
      const attachment = await uploadClientFeedbackAttachment(file)
      replyAttachments.value = [...replyAttachments.value, attachment]
    }
    ElMessage.success('补充图片上传完成，可随消息一起发送')
  } catch (error) {
    ElMessage.error(extractErrorMessage(error, '附件上传失败，请稍后重试'))
  } finally {
    uploadingReplyAttachments.value = false
    if (input) {
      input.value = ''
    }
  }
}

const handleRemoveReplyAttachment = (attachmentIndex: number) => {
  replyAttachments.value = replyAttachments.value.filter((_, index) => index !== attachmentIndex)
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
      attachments: replyAttachments.value,
    })
    replyDraft.value = ''
    replyAttachments.value = []
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

const handleSubmitSatisfaction = async () => {
  if (!conversation.value) {
    ElMessage.warning('当前反馈单尚未加载完成')
    return
  }
  if (!canRateSatisfaction.value) {
    ElMessage.warning('当前反馈单尚未进入可评价阶段')
    return
  }

  satisfactionSubmitting.value = true
  try {
    await submitClientFeedbackSatisfaction(conversation.value.id, {
      level: selectedSatisfactionLevel.value,
      comment: normalizeSubmitText(satisfactionComment.value) || undefined,
    })
    satisfactionDialogVisible.value = false
    await loadConversationDetail(conversation.value.id)
    reconnectTip.value = '已记录你的满意度评价，当前反馈单详情已同步更新。'
    ElMessage.success('满意度评价已提交')
  } catch (error) {
    ElMessage.error(extractErrorMessage(error, '满意度评价提交失败，请稍后重试'))
  } finally {
    satisfactionSubmitting.value = false
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

const handleOpenSatisfactionDialog = () => {
  if (!showSatisfactionEntry.value) {
    return
  }
  satisfactionDialogVisible.value = true
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
  <div class="space-y-4 pb-4">
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
              <div
                v-if="showSatisfactionEntry || hasRatedSatisfaction"
                class="rounded-[0.95rem] border border-dashed border-slate-200 bg-white px-3 py-3"
              >
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p class="text-xs font-medium text-slate-400">处理评价</p>
                    <p class="mt-1 text-sm leading-6 text-slate-600">
                      {{ hasRatedSatisfaction ? '你的评价已记录，客服可基于该结果持续优化处理体验。' : '当前反馈单已进入结果阶段，可补充对本次处理体验的评价。' }}
                    </p>
                  </div>
                  <span
                    v-if="currentSatisfactionMeta"
                    class="rounded-full px-3 py-1 text-xs font-semibold"
                    :class="currentSatisfactionMeta.className"
                  >
                    {{ currentSatisfactionMeta.label }}
                  </span>
                </div>

                <div v-if="hasRatedSatisfaction && conversation.satisfaction" class="mt-3 space-y-2 text-sm">
                  <p class="text-slate-500">评价时间：{{ formatDateTime(conversation.satisfaction.ratedAt) }}</p>
                  <p class="leading-6 text-slate-700">
                    {{ conversation.satisfaction.comment || '你未填写额外说明，系统已记录当前评价结果。' }}
                  </p>
                </div>

                <div v-else class="mt-3 rounded-[0.95rem] bg-slate-50 px-3 py-3">
                  <p class="text-sm leading-6 text-slate-600">
                    你可以通过弹窗快速评价本次处理体验，并补充对回复速度、结论清晰度或改进建议的看法。
                  </p>
                  <div class="mt-3 flex justify-end">
                    <button
                      type="button"
                      class="rounded-[0.9rem] bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800"
                      @click="handleOpenSatisfactionDialog"
                    >
                      填写处理评价
                    </button>
                  </div>
                </div>
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

        <article
          v-if="conversationAttachmentEntries.length"
          class="mt-5 rounded-[1rem] border border-slate-200 bg-slate-50/80 p-4"
        >
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p class="text-sm font-semibold text-slate-900">附件总览</p>
              <p class="mt-1 text-xs leading-5 text-slate-400">集中查看当前反馈单里已经上传的图片证据，不必逐条翻消息寻找。</p>
            </div>
            <span class="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-500">
              {{ conversationAttachmentEntries.length }} 个附件
            </span>
          </div>

          <div class="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <article
              v-for="item in conversationAttachmentEntries"
              :key="item.id"
              class="rounded-[1rem] bg-white p-3 shadow-sm ring-1 ring-inset ring-slate-200"
            >
              <img
                v-if="isImageAttachment(item.attachment)"
                :src="resolveAttachmentUrl(item.attachment)"
                :alt="item.attachment.name"
                class="detail-attachment-preview"
              />
              <div
                v-else
                class="detail-attachment-preview detail-attachment-preview--placeholder flex items-center justify-center text-sm font-semibold text-slate-500"
              >
                附件
              </div>
              <p class="mt-3 truncate text-sm font-semibold text-slate-900">{{ item.attachment.name }}</p>
              <p class="mt-1 text-xs text-slate-400">{{ item.senderName }} · {{ formatDateTime(item.createdAt) }}</p>
              <p class="mt-1 text-xs text-slate-400">{{ formatAttachmentSize(item.attachment.size) }}</p>
              <div class="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  class="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-200"
                  @click="openAttachmentPreview(item.attachment)"
                >
                  预览
                </button>
                <a
                  class="rounded-full bg-brand/10 px-3 py-1 text-xs font-medium text-brand transition hover:bg-brand/15"
                  :href="resolveAttachmentUrl(item.attachment)"
                  target="_blank"
                  rel="noopener"
                >
                  新窗口打开
                </a>
              </div>
            </article>
          </div>
        </article>
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
            <div v-if="message.attachments.length" class="mt-3 grid gap-2 sm:grid-cols-2">
              <button
                v-for="(attachment, attachmentIndex) in message.attachments"
                :key="`${message.id}-${attachment.url}-${attachmentIndex}`"
                type="button"
                class="message-attachment-card"
                @click="openAttachmentPreview(attachment)"
              >
                <img
                  v-if="isImageAttachment(attachment)"
                  :src="resolveAttachmentUrl(attachment)"
                  :alt="attachment.name"
                  class="message-attachment-card__image"
                />
                <div
                  v-else
                  class="message-attachment-card__image message-attachment-card__image--placeholder flex items-center justify-center text-xs font-semibold text-slate-500"
                >
                  附件
                </div>
                <div class="min-w-0 flex-1 text-left">
                  <p class="truncate text-sm font-semibold text-slate-900">{{ attachment.name }}</p>
                  <p class="mt-1 text-xs text-slate-400">{{ formatAttachmentSize(attachment.size) }}</p>
                </div>
              </button>
            </div>
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
        <div class="mt-3 rounded-[1rem] border border-dashed border-slate-200 bg-slate-50 px-3 py-3">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p class="text-sm font-semibold text-slate-900">补充图片附件</p>
              <p class="mt-1 text-xs leading-5 text-slate-400">
                新的异常截图、界面对比图或订单凭证可直接附在本次补充说明里，方便客服继续定位。
              </p>
            </div>
            <button
              type="button"
              class="rounded-[0.9rem] border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
              :disabled="uploadingReplyAttachments || replyAttachments.length >= FEEDBACK_ATTACHMENT_LIMIT"
              @click="openReplyAttachmentPicker"
            >
              {{ uploadingReplyAttachments ? '上传中...' : replyAttachments.length ? '继续添加图片' : '上传图片附件' }}
            </button>
          </div>
          <input
            ref="replyAttachmentInputRef"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            class="hidden"
            @change="handleReplyAttachmentChange"
          />

          <div v-if="replyAttachments.length" class="mt-3 grid gap-3 sm:grid-cols-2">
            <article
              v-for="(attachment, index) in replyAttachments"
              :key="`${attachment.url}-${index}`"
              class="rounded-[0.95rem] bg-white p-3 shadow-sm ring-1 ring-inset ring-slate-200"
            >
              <div class="flex items-start gap-3">
                <img
                  v-if="isImageAttachment(attachment)"
                  :src="resolveAttachmentUrl(attachment)"
                  :alt="attachment.name"
                  class="reply-attachment-thumb"
                />
                <div
                  v-else
                  class="reply-attachment-thumb reply-attachment-thumb--placeholder flex items-center justify-center text-xs font-semibold text-slate-500"
                >
                  附件
                </div>
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm font-semibold text-slate-900">{{ attachment.name }}</p>
                  <p class="mt-1 text-xs text-slate-400">{{ formatAttachmentSize(attachment.size) }}</p>
                  <div class="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      class="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-200"
                      @click="openAttachmentPreview(attachment)"
                    >
                      预览
                    </button>
                    <button
                      type="button"
                      class="rounded-full bg-rose-50 px-3 py-1 text-xs font-medium text-rose-600 transition hover:bg-rose-100"
                      @click="handleRemoveReplyAttachment(index)"
                    >
                      移除
                    </button>
                  </div>
                </div>
              </div>
            </article>
          </div>
        </div>
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
  

    <Teleport to="body">
      <div v-if="previewImageUrl" class="feedback-preview-overlay" @click.self="previewImageUrl = ''">
        <div class="feedback-preview-panel">
          <button type="button" class="feedback-preview-close" @click="previewImageUrl = ''">关闭</button>
          <img :src="previewImageUrl" alt="附件预览" class="feedback-preview-image" />
        </div>
      </div>
    </Teleport>

    <el-dialog
      v-model="satisfactionDialogVisible"
      class="client-feedback-satisfaction-dialog ylink-dialog-height-mode--auto"
      width="32rem"
      append-to-body
      align-center
      destroy-on-close
    >
      <template #header>
        <div class="client-feedback-satisfaction-dialog__header">
          <span class="client-feedback-satisfaction-dialog__eyebrow">处理反馈</span>
          <h3 class="client-feedback-satisfaction-dialog__title">满意度评价</h3>
          <p class="client-feedback-satisfaction-dialog__desc">
            请选择你对本次处理结果的感受，如有补充建议，也可以一并写给我们。
          </p>
        </div>
      </template>
      <div class="space-y-4">
        <div class="space-y-3">
          <el-radio-group
            v-model="selectedSatisfactionLevel"
            class="client-feedback-satisfaction-dialog__radio-group"
            aria-label="满意度评价选项"
          >
            <el-radio
              v-for="option in satisfactionCardOptions"
              :key="option.value"
              :value="option.value"
              class="client-feedback-satisfaction-dialog__radio-card"
              :class="[
                `client-feedback-satisfaction-dialog__radio-card--${option.value}`,
                { 'is-active': selectedSatisfactionLevel === option.value },
              ]"
            >
              <span class="client-feedback-satisfaction-dialog__radio-card-title">{{ option.label }}</span>
              <span class="client-feedback-satisfaction-dialog__radio-card-desc">{{ option.description }}</span>
            </el-radio>
          </el-radio-group>
          <div class="client-feedback-satisfaction-dialog__selected-card" :class="selectedSatisfactionMeta.className">
            <p class="client-feedback-satisfaction-dialog__selected-title">
              当前选择：{{ selectedSatisfactionMeta.label }}
            </p>
            <p class="client-feedback-satisfaction-dialog__selected-desc">
              {{ selectedSatisfactionMeta.description }}
            </p>
          </div>
        </div>
        <textarea
          v-model="satisfactionComment"
          class="feedback-textarea feedback-textarea--compact"
          maxlength="300"
          placeholder="可选填写：比如回复速度、结论清晰度、是否仍有改进建议。"
        />
      </div>
      <template #footer>
        <div class="flex justify-end gap-3">
          <el-button
            class="client-feedback-satisfaction-dialog__cancel"
            plain
            @click="satisfactionDialogVisible = false"
          >
            取消
          </el-button>
          <el-button
            class="client-feedback-satisfaction-dialog__submit"
            type="primary"
            :loading="satisfactionSubmitting"
            :disabled="satisfactionSubmitting"
            @click="handleSubmitSatisfaction"
          >
            {{ satisfactionSubmitting ? '提交中...' : '提交处理评价' }}
          </el-button>
        </div>
      </template>
    </el-dialog>
  </div>
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

.feedback-textarea--compact {
  min-height: 6rem;
}

.detail-attachment-preview,
.reply-attachment-thumb {
  height: 5rem;
  width: 100%;
  border-radius: 1rem;
  object-fit: cover;
  background: rgb(241 245 249);
}

.reply-attachment-thumb {
  width: 4.5rem;
  flex-shrink: 0;
}

.detail-attachment-preview--placeholder,
.reply-attachment-thumb--placeholder,
.message-attachment-card__image--placeholder {
  border: 1px dashed rgb(203 213 225);
}

.message-attachment-card {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  border: none;
  border-radius: 1rem;
  background: rgba(255, 255, 255, 0.92);
  padding: 0.65rem;
  cursor: pointer;
}

.message-attachment-card__image {
  height: 4rem;
  width: 4rem;
  flex-shrink: 0;
  border-radius: 0.95rem;
  object-fit: cover;
  background: rgb(241 245 249);
}

.feedback-preview-overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 23, 42, 0.72);
  padding: 1rem;
}

.feedback-preview-panel {
  width: min(100%, 48rem);
  border-radius: 1.5rem;
  background: rgba(255, 255, 255, 0.98);
  padding: 1rem;
  box-shadow: 0 24px 80px rgba(15, 23, 42, 0.28);
}

.feedback-preview-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 999px;
  background: rgb(241 245 249);
  color: rgb(71 85 105);
  padding: 0.55rem 0.95rem;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
}

.feedback-preview-image {
  margin-top: 0.9rem;
  max-height: 72vh;
  width: 100%;
  border-radius: 1.25rem;
  object-fit: contain;
  background: rgb(248 250 252);
}

.client-feedback-satisfaction-dialog :deep(.el-dialog) {
  border-radius: 1.5rem;
  overflow: hidden;
  border: 1px solid rgba(13, 148, 136, 0.08);
  box-shadow: 0 26px 70px rgba(15, 23, 42, 0.14);
}

.client-feedback-satisfaction-dialog :deep(.el-dialog__header) {
  margin-right: 0;
  padding: 0;
}

.client-feedback-satisfaction-dialog :deep(.el-dialog__body) {
  padding: 1.15rem 1.25rem 0.5rem;
}

.client-feedback-satisfaction-dialog :deep(.el-dialog__footer) {
  padding: 0 1.25rem 1.2rem;
}

.client-feedback-satisfaction-dialog__header {
  margin: -20px -20px 0;
  border-bottom: 1px solid rgba(13, 148, 136, 0.1);
  background:
    radial-gradient(circle at top right, rgba(45, 212, 191, 0.2), transparent 42%),
    linear-gradient(135deg, rgba(13, 148, 136, 0.16), rgba(20, 184, 166, 0.08)),
    rgb(248 250 252);
  padding: 1.15rem 1.25rem 1.05rem;
}

.client-feedback-satisfaction-dialog__eyebrow {
  display: inline-flex;
  align-items: center;
  border-radius: 9999px;
  background: rgba(204, 251, 241, 0.96);
  padding: 0.28rem 0.62rem;
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: rgb(19 78 74);
}

.client-feedback-satisfaction-dialog__title {
  margin-top: 0.8rem;
  font-size: 1.18rem;
  font-weight: 700;
  line-height: 1.35;
  color: rgb(15 23 42);
}

.client-feedback-satisfaction-dialog__desc {
  margin-top: 0.35rem;
  font-size: 0.88rem;
  line-height: 1.6;
  color: rgb(71 85 105);
}

.client-feedback-satisfaction-dialog__radio-group {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.75rem;
  width: 100%;
}

.client-feedback-satisfaction-dialog__radio-card {
  margin-right: 0;
  min-width: 0;
}

.client-feedback-satisfaction-dialog__radio-card :deep(.el-radio__input) {
  display: none;
}

.client-feedback-satisfaction-dialog__radio-card :deep(.el-radio__label) {
  display: flex;
  min-height: 6.25rem;
  width: 100%;
  flex-direction: column;
  justify-content: space-between;
  gap: 0.55rem;
  border-radius: 1.1rem;
  border: 1px solid rgba(148, 163, 184, 0.2);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(248, 250, 252, 0.96));
  padding: 0.95rem 0.9rem;
  color: rgb(51 65 85);
  transition:
    border-color 0.18s ease,
    box-shadow 0.18s ease,
    transform 0.18s ease,
    background-color 0.18s ease;
}

.client-feedback-satisfaction-dialog__radio-card.is-active :deep(.el-radio__label) {
  transform: translateY(-1px);
  border-color: rgba(13, 148, 136, 0.24);
  background:
    linear-gradient(180deg, rgba(240, 253, 250, 0.98), rgba(255, 255, 255, 0.96));
  box-shadow:
    0 0 0 1px rgba(13, 148, 136, 0.08) inset,
    0 12px 24px rgba(13, 148, 136, 0.12);
}

.client-feedback-satisfaction-dialog__radio-card--satisfied.is-active :deep(.el-radio__label) {
  border-color: rgba(16, 185, 129, 0.28);
  box-shadow:
    0 0 0 1px rgba(16, 185, 129, 0.08) inset,
    0 12px 24px rgba(16, 185, 129, 0.12);
}

.client-feedback-satisfaction-dialog__radio-card--neutral.is-active :deep(.el-radio__label) {
  border-color: rgba(245, 158, 11, 0.28);
  box-shadow:
    0 0 0 1px rgba(245, 158, 11, 0.08) inset,
    0 12px 24px rgba(245, 158, 11, 0.12);
}

.client-feedback-satisfaction-dialog__radio-card--unsatisfied.is-active :deep(.el-radio__label) {
  border-color: rgba(244, 63, 94, 0.28);
  box-shadow:
    0 0 0 1px rgba(244, 63, 94, 0.08) inset,
    0 12px 24px rgba(244, 63, 94, 0.12);
}

.client-feedback-satisfaction-dialog__radio-card-title {
  font-size: 0.92rem;
  font-weight: 700;
  line-height: 1.35;
  color: rgb(15 23 42);
}

.client-feedback-satisfaction-dialog__radio-card-desc {
  font-size: 0.78rem;
  line-height: 1.55;
  color: rgb(100 116 139);
}

.client-feedback-satisfaction-dialog__selected-card {
  border-radius: 1rem;
  border: 1px solid rgba(13, 148, 136, 0.1);
  padding: 0.85rem 0.95rem;
}

.client-feedback-satisfaction-dialog__selected-title {
  font-size: 0.9rem;
  font-weight: 700;
  line-height: 1.4;
}

.client-feedback-satisfaction-dialog__selected-desc {
  margin-top: 0.2rem;
  font-size: 0.8rem;
  line-height: 1.6;
}

.client-feedback-satisfaction-dialog__cancel,
.client-feedback-satisfaction-dialog__submit {
  min-width: 6rem;
  border-radius: 9999px;
  font-weight: 600;
}

.client-feedback-satisfaction-dialog__cancel {
  --el-button-bg-color: rgba(240, 253, 250, 0.92);
  --el-button-border-color: rgba(13, 148, 136, 0.16);
  --el-button-text-color: rgb(15 118 110);
  --el-button-hover-bg-color: rgba(13, 148, 136, 0.06);
  --el-button-hover-border-color: rgba(13, 148, 136, 0.28);
  --el-button-hover-text-color: rgb(15 118 110);
}

.client-feedback-satisfaction-dialog__submit {
  --el-button-bg-color: rgb(15 118 110);
  --el-button-border-color: rgb(15 118 110);
  --el-button-hover-bg-color: rgb(17 94 89);
  --el-button-hover-border-color: rgb(17 94 89);
  --el-button-active-bg-color: rgb(19 78 74);
  --el-button-active-border-color: rgb(19 78 74);
  box-shadow: 0 10px 24px rgba(15, 118, 110, 0.22);
}

@media (max-width: 640px) {
  .client-feedback-satisfaction-dialog__radio-group {
    grid-template-columns: 1fr;
  }
}
</style>
