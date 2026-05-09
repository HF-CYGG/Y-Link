<script setup lang="ts">
/**
 * 模块说明：src/views/system/CustomerServiceWorkbenchView.vue
 * 文件职责：提供管理端客服工作台，统一查看客户端反馈、维护结构化字段、记录内部备注并展示在线/续接状态。
 * 实现逻辑：
 * - 页面以“左侧会话列表 + 右侧会话详情”的工作台方式组织，减少客服在筛选、查看、回复之间的来回切页；
 * - 详情区同时包含消息时间线、结构化 Issue 表单与内部备注编辑区，便于客服在一个工作台里完成受理、整理和跟进；
 * - 页面通过真实后端接口与 SSE 订阅同步在线状态、续接提示和会话变化，保证客服视角与客户端视角一致。
 * 维护说明：
 * - 若后续继续扩展附件、快捷回复或 SLA 指标，建议继续扩展右侧详情区，不再拆分独立子页；
 * - 若客服在线规则改为更精细的排班模型，本页优先消费共享 API 已暴露的 presence 数据，不在页面层重复实现。
 */

import { computed, onActivated, onBeforeUnmount, onDeactivated, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import {
  FEEDBACK_CATEGORY_OPTIONS,
  FEEDBACK_ISSUE_TYPE_OPTIONS,
  FEEDBACK_PRIORITY_META_MAP,
  FEEDBACK_PRIORITY_OPTIONS,
  FEEDBACK_STATUS_META_MAP,
  FEEDBACK_STATUS_OPTIONS,
  appendStaffFeedbackMessage,
  getCustomerServicePresence,
  getSupportFeedbackConversation,
  listSupportFeedbackConversations,
  openFeedbackRealtimeStream,
  summarizeSupportFeedbackConversations,
  updateFeedbackInternalRemark,
  updateFeedbackIssue,
  type FeedbackConversationRecord,
  type FeedbackConversationMessage,
  type FeedbackIssueCategory,
  type FeedbackIssuePriority,
  type FeedbackIssueStatus,
  type FeedbackIssueType,
  type FeedbackRealtimeConnection,
  type FeedbackRealtimeConversationEvent,
  type FeedbackServicePresence,
} from '@/api/modules/customer-service-feedback'
import { PageContainer } from '@/components/common'
import { useAuthStore } from '@/store'
import { extractErrorMessage } from '@/utils/error'
import { formatDateTime } from '@/utils/date-time'
import { normalizeSubmitText } from '@/utils/submit-feedback'

const authStore = useAuthStore()

const detailLoading = ref(false)
const loading = ref(false)
const saving = ref(false)
const remarkSaving = ref(false)
const replying = ref(false)
const selectedConversationId = ref('')
const replyDraft = ref('')
const conversations = ref<FeedbackConversationRecord[]>([])
const selectedConversation = ref<FeedbackConversationRecord | null>(null)
const summary = computed(() => summarizeSupportFeedbackConversations(conversations.value))
const presence = ref<FeedbackServicePresence | null>(null)
const realtimeState = ref<'connecting' | 'online' | 'offline'>('offline')
const reconnectTip = ref('进入工作台后会自动续接当前客服会话。')
const isWorkbenchResident = ref(false)
const isPriorityPanelExpanded = ref(false)
const quickStatusUpdating = ref<FeedbackIssueStatus | ''>('')
const priorityUpdating = ref<FeedbackIssuePriority | ''>('')
let realtimeConnection: FeedbackRealtimeConnection | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let refreshTimer: ReturnType<typeof setInterval> | null = null
let lifecycleToken = 0
let refreshInFlight = false
let pendingRefresh = false

/**
 * - 关键字覆盖标题、Issue 编号、用户、订单号和标签；
 * - 分配范围让客服可快速查看“我的工单”或“待分配”工单。
 */
const searchForm = reactive({
  keyword: '',
  status: '' as FeedbackIssueStatus | '',
  priority: '' as FeedbackIssuePriority | '',
  assigneeScope: 'all' as 'all' | 'mine' | 'unassigned',
})

/**
 * Issue 编辑表单：
 * - 详情切换时同步回填；
 * - 保存动作统一写回共享反馈模块，避免列表卡片与详情侧栏口径不一致。
 */
const issueForm = reactive({
  title: '',
  status: 'pending' as FeedbackIssueStatus,
  priority: 'medium' as FeedbackIssuePriority,
  issueType: 'suggestion' as FeedbackIssueType,
  category: 'other' as FeedbackIssueCategory,
  orderRef: '',
  expectedResult: '',
  actualResult: '',
  reproductionSteps: '',
  contactPreference: '',
  tagText: '',
  internalRemark: '',
})

const getCategoryLabel = (category: FeedbackIssueCategory) => {
  return FEEDBACK_CATEGORY_OPTIONS.find((item) => item.value === category)?.label ?? '其他建议'
}

const parseTagText = (value: string): string[] => {
  return [...new Set(
    value
      .split(/[，,]/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  )]
}

const syncIssueForm = (record: FeedbackConversationRecord | null) => {
  issueForm.title = record?.title ?? ''
  issueForm.status = record?.status ?? 'pending'
  issueForm.priority = record?.priority ?? 'medium'
  issueForm.issueType = record?.fields.issueType ?? 'suggestion'
  issueForm.category = record?.fields.category ?? 'other'
  issueForm.orderRef = record?.fields.orderRef ?? ''
  issueForm.expectedResult = record?.fields.expectedResult ?? ''
  issueForm.actualResult = record?.fields.actualResult ?? ''
  issueForm.reproductionSteps = record?.fields.reproductionSteps ?? ''
  issueForm.contactPreference = record?.fields.contactPreference ?? ''
  issueForm.tagText = record?.fields.tags.join('，') ?? ''
  issueForm.internalRemark = record?.internalRemark?.content ?? ''
}

const patchSelectedConversation = (patch: Partial<FeedbackConversationRecord>) => {
  if (!selectedConversation.value) {
    return
  }
  selectedConversation.value = {
    ...selectedConversation.value,
    ...patch,
  }
}

const patchConversationListItem = (conversationId: string, patch: Partial<FeedbackConversationRecord>) => {
  conversations.value = conversations.value.map((item) => {
    if (item.id !== conversationId) {
      return item
    }
    return {
      ...item,
      ...patch,
    }
  })
}

const handleTogglePriorityPanel = () => {
  isPriorityPanelExpanded.value = !isPriorityPanelExpanded.value
}

const loadConversationDetail = async (conversationId: string) => {
  if (!conversationId) {
    selectedConversation.value = null
    isPriorityPanelExpanded.value = false
    return
  }

  detailLoading.value = true
  try {
    selectedConversation.value = await getSupportFeedbackConversation(conversationId)
    isPriorityPanelExpanded.value = false
    syncIssueForm(selectedConversation.value)
  } finally {
    detailLoading.value = false
  }
}

const loadConversations = async (options: { refreshSelectedDetail?: boolean } = {}) => {
  const shouldRefreshSelectedDetail = options.refreshSelectedDetail ?? true
  loading.value = true
  try {
    conversations.value = await listSupportFeedbackConversations({
      keyword: searchForm.keyword,
      status: searchForm.status,
      priority: searchForm.priority,
      assigneeScope: searchForm.assigneeScope,
    })

    if (!conversations.value.length) {
      selectedConversationId.value = ''
      selectedConversation.value = null
      syncIssueForm(null)
      return
    }

    const hasCurrentSelection = conversations.value.some((item) => item.id === selectedConversationId.value)
    if (!hasCurrentSelection) {
      selectedConversationId.value = conversations.value[0].id
    }

    const shouldLoadDetail = shouldRefreshSelectedDetail
      || !selectedConversation.value
      || selectedConversation.value.id !== selectedConversationId.value

    if (shouldLoadDetail) {
      await loadConversationDetail(selectedConversationId.value)
    }
  } finally {
    loading.value = false
  }
}

const replaceConversationSummary = (records: FeedbackConversationRecord[], nextRecord: FeedbackConversationRecord) => {
  const nextRecords = [...records]
  const currentIndex = nextRecords.findIndex((item) => item.id === nextRecord.id)
  if (currentIndex >= 0) {
    nextRecords.splice(currentIndex, 1)
  }
  nextRecords.unshift(nextRecord)
  return nextRecords.sort((left, right) => right.lastMessageAt.localeCompare(left.lastMessageAt))
}

const mergeSelectedConversationSummary = (summaryRecord: FeedbackConversationRecord) => {
  const currentRecord = selectedConversation.value
  if (!currentRecord || currentRecord.id !== summaryRecord.id) {
    return
  }

  selectedConversation.value = {
    ...currentRecord,
    issueNo: summaryRecord.issueNo,
    title: summaryRecord.title,
    summary: summaryRecord.summary,
    status: summaryRecord.status,
    priority: summaryRecord.priority,
    clientUserId: summaryRecord.clientUserId,
    clientAccount: summaryRecord.clientAccount,
    clientDisplayName: summaryRecord.clientDisplayName,
    clientDepartmentName: summaryRecord.clientDepartmentName,
    assigneeName: summaryRecord.assigneeName,
    lastMessageAt: summaryRecord.lastMessageAt,
    unreadForClient: summaryRecord.unreadForClient,
    unreadForStaff: summaryRecord.unreadForStaff,
    createdAt: summaryRecord.createdAt,
    updatedAt: summaryRecord.updatedAt,
    fields: summaryRecord.fields,
  }

  if (!saving.value && !remarkSaving.value && !replying.value) {
    syncIssueForm(selectedConversation.value)
  }
}

const mergeRealtimeMessageIntoSelectedConversation = (message: FeedbackConversationMessage | undefined) => {
  if (!message || !selectedConversation.value) {
    return
  }

  const nextMessages = [...selectedConversation.value.messages]
  const currentIndex = nextMessages.findIndex((item) => item.id === message.id)
  if (currentIndex >= 0) {
    nextMessages.splice(currentIndex, 1, message)
  } else {
    nextMessages.push(message)
  }
  nextMessages.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  selectedConversation.value = {
    ...selectedConversation.value,
    messages: nextMessages,
  }
}

const applyRealtimeConversationPatch = async (
  payload: FeedbackRealtimeConversationEvent,
) => {
  conversations.value = replaceConversationSummary(conversations.value, payload.conversation)

  if (selectedConversationId.value !== payload.conversationId) {
    return
  }

  mergeSelectedConversationSummary(payload.conversation)
  mergeRealtimeMessageIntoSelectedConversation(payload.message)

  if (payload.eventType === 'conversation_internal_remark_updated') {
    await loadConversationDetail(payload.conversationId)
    return
  }

  if (!selectedConversation.value || selectedConversation.value.id !== payload.conversationId) {
    await loadConversationDetail(payload.conversationId)
    return
  }

  if (payload.eventType === 'conversation_created' && !payload.message) {
    await loadConversationDetail(payload.conversationId)
  }
}

const handleSearch = () => {
  void loadConversations()
}

const handleReset = () => {
  searchForm.keyword = ''
  searchForm.status = ''
  searchForm.priority = ''
  searchForm.assigneeScope = 'all'
  void loadConversations()
}

const handleSelectConversation = async (conversationId: string) => {
  selectedConversationId.value = conversationId
  await loadConversationDetail(conversationId)
}

const handleTakeOver = async () => {
  if (!selectedConversation.value) {
    ElMessage.warning('请先选择一条会话')
    return
  }

  saving.value = true
  try {
    await updateFeedbackIssue(selectedConversation.value.id, {
      status: issueForm.status === 'pending' ? 'processing' : issueForm.status,
    })
    await loadConversations()
    reconnectTip.value = '已续接并接手当前会话，后续消息会实时同步。'
    ElMessage.success('已接手当前会话')
  } catch (error) {
    ElMessage.error(extractErrorMessage(error, '接手会话失败，请稍后重试'))
  } finally {
    saving.value = false
  }
}

const handleSaveIssue = async () => {
  if (!selectedConversation.value) {
    ElMessage.warning('请先选择一条会话')
    return
  }

  const normalizedTitle = normalizeSubmitText(issueForm.title)
  const normalizedExpectedResult = normalizeSubmitText(issueForm.expectedResult)
  const normalizedActualResult = normalizeSubmitText(issueForm.actualResult)

  if (!normalizedTitle) {
    ElMessage.warning('请填写标题')
    return
  }

  if (issueForm.issueType === 'bug' && (!normalizedExpectedResult || !normalizedActualResult)) {
    ElMessage.warning('专业 BUG 需要完整填写期望结果与实际结果')
    return
  }

  saving.value = true
  try {
    await updateFeedbackIssue(selectedConversation.value.id, {
      title: normalizedTitle,
      status: issueForm.status,
      priority: issueForm.priority,
      issueType: issueForm.issueType,
      category: issueForm.category,
      orderRef: issueForm.orderRef,
      expectedResult: normalizedExpectedResult || undefined,
      actualResult: normalizedActualResult || undefined,
      reproductionSteps: issueForm.reproductionSteps,
      contactPreference: issueForm.contactPreference,
      tags: parseTagText(issueForm.tagText),
    })
    await loadConversations()
    ElMessage.success('Issue 字段已保存')
  } catch (error) {
    ElMessage.error(extractErrorMessage(error, 'Issue 字段保存失败，请稍后重试'))
  } finally {
    saving.value = false
  }
}

const handleQuickStatus = async (status: FeedbackIssueStatus) => {
  if (!selectedConversation.value) {
    ElMessage.warning('请先选择一条会话')
    return
  }

  quickStatusUpdating.value = status
  saving.value = true
  try {
    await updateFeedbackIssue(selectedConversation.value.id, {
      status,
    })
    issueForm.status = status
    patchSelectedConversation({
      status,
      updatedAt: new Date().toISOString(),
    })
    patchConversationListItem(selectedConversation.value.id, {
      status,
      updatedAt: new Date().toISOString(),
    })
    await loadConversations()
    ElMessage.success(`状态已更新为${FEEDBACK_STATUS_META_MAP[status].label}`)
  } catch (error) {
    ElMessage.error(extractErrorMessage(error, '状态更新失败，请稍后重试'))
  } finally {
    quickStatusUpdating.value = ''
    saving.value = false
  }
}

const handleReassignPriority = async (priority: FeedbackIssuePriority) => {
  if (!selectedConversation.value) {
    ElMessage.warning('请先选择一条会话')
    return
  }

  priorityUpdating.value = priority
  saving.value = true
  try {
    await updateFeedbackIssue(selectedConversation.value.id, {
      priority,
    })
    issueForm.priority = priority
    patchSelectedConversation({
      priority,
      updatedAt: new Date().toISOString(),
    })
    patchConversationListItem(selectedConversation.value.id, {
      priority,
      updatedAt: new Date().toISOString(),
    })
    await loadConversations({
      refreshSelectedDetail: true,
    })
    isPriorityPanelExpanded.value = false
    ElMessage.success(`已将优先级调整为${FEEDBACK_PRIORITY_META_MAP[priority].label}`)
  } catch (error) {
    ElMessage.error(extractErrorMessage(error, '优先级调整失败，请稍后重试'))
  } finally {
    priorityUpdating.value = ''
    saving.value = false
  }
}

const handleSaveInternalRemark = async () => {
  if (!selectedConversation.value) {
    ElMessage.warning('请先选择一条会话')
    return
  }

  remarkSaving.value = true
  try {
    await updateFeedbackInternalRemark(selectedConversation.value.id, issueForm.internalRemark)
    await loadConversationDetail(selectedConversation.value.id)
    ElMessage.success('内部备注已保存')
  } catch (error) {
    ElMessage.error(extractErrorMessage(error, '内部备注保存失败，请稍后重试'))
  } finally {
    remarkSaving.value = false
  }
}

const handleReply = async () => {
  if (!selectedConversation.value) {
    ElMessage.warning('请先选择一条会话')
    return
  }

  const normalizedReply = normalizeSubmitText(replyDraft.value)
  if (!normalizedReply) {
    ElMessage.warning('请输入回复内容')
    return
  }

  replying.value = true
  try {
    await updateFeedbackIssue(selectedConversation.value.id, {
      title: issueForm.title,
      status: issueForm.status,
      priority: issueForm.priority,
      issueType: issueForm.issueType,
      category: issueForm.category,
      orderRef: issueForm.orderRef,
      expectedResult: issueForm.expectedResult,
      actualResult: issueForm.actualResult,
      reproductionSteps: issueForm.reproductionSteps,
      contactPreference: issueForm.contactPreference,
      tags: parseTagText(issueForm.tagText),
    })

    await appendStaffFeedbackMessage(selectedConversation.value.id, {
      body: normalizedReply,
    })
    replyDraft.value = ''
    await loadConversations()
    reconnectTip.value = '已续接当前客服会话，最新回复已同步发送给客户端。'
    ElMessage.success('客服回复已发送')
  } catch (error) {
    ElMessage.error(extractErrorMessage(error, '客服回复发送失败，请稍后重试'))
  } finally {
    replying.value = false
  }
}

const loadPresence = async () => {
  presence.value = await getCustomerServicePresence()
  realtimeState.value = presence.value.availability.isOnline ? 'online' : 'offline'
}

/**
 * 工作台列表刷新统一收口：
 * - SSE 与轮询都走同一条刷新链路，避免多处各自拉取导致覆盖顺序混乱；
 * - 若前一次刷新尚未完成，新的刷新请求只做排队，等当前批次结束后立即补一次。
 */
const refreshWorkbenchData = async (
  currentToken: number,
  options: {
    refreshPresence?: boolean
    refreshSelectedDetail?: boolean
  } = {},
) => {
  if (!isWorkbenchResident.value || currentToken !== lifecycleToken) {
    return
  }

  if (refreshInFlight) {
    pendingRefresh = true
    return
  }

  refreshInFlight = true
  try {
    await loadConversations({
      refreshSelectedDetail: options.refreshSelectedDetail,
    })
    if (options.refreshPresence !== false) {
      await loadPresence()
    }
  } finally {
    refreshInFlight = false
    const shouldStopRefreshLoop = !isWorkbenchResident.value || currentToken !== lifecycleToken
    if (shouldStopRefreshLoop) {
      pendingRefresh = false
    } else if (pendingRefresh) {
      pendingRefresh = false
      await refreshWorkbenchData(currentToken, options)
    }
  }
}

/**
 * 轮询兜底：
 * - 正常情况下优先依赖 SSE 推送即时刷新；
 * - 若浏览器标签页挂起、网络瞬断或 SSE 事件丢失，轮询会把反馈列表重新拉回最新状态。
 */
const startRefreshPolling = (currentToken: number) => {
  if (refreshTimer) {
    clearInterval(refreshTimer)
  }
  refreshTimer = setInterval(() => {
    if (!isWorkbenchResident.value || currentToken !== lifecycleToken) {
      return
    }
    void refreshWorkbenchData(currentToken, { refreshPresence: true })
  }, 8000)
}

const handleRealtimeConversation = async (
  currentToken: number,
  payload: FeedbackRealtimeConversationEvent | null,
) => {
  if (!isWorkbenchResident.value || currentToken !== lifecycleToken) {
    return
  }

  if (!payload) {
    await refreshWorkbenchData(currentToken, { refreshPresence: false, refreshSelectedDetail: false })
    return
  }

  try {
    await applyRealtimeConversationPatch(payload)
  } catch {
    await refreshWorkbenchData(currentToken, { refreshPresence: false, refreshSelectedDetail: false })
    return
  }

  await refreshWorkbenchData(currentToken, { refreshPresence: false, refreshSelectedDetail: false })
  if (!isWorkbenchResident.value || currentToken !== lifecycleToken) {
    return
  }
  reconnectTip.value = '检测到会话有新变化，工作台已自动续接最新进展。'
}

/**
 * 统一释放实时连接与重连定时器。
 * - 页面离开但组件被 keep-alive 缓存时，也必须主动释放在线占位；
 * - 统一收口后可以避免重连定时器在离页后继续把客服重新拉回在线。
 */
const disposeRealtime = () => {
  realtimeConnection?.close()
  realtimeConnection = null

  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
}

const connectRealtime = (currentToken: number) => {
  disposeRealtime()

  if (!isWorkbenchResident.value || currentToken !== lifecycleToken) {
    return
  }

  realtimeState.value = 'connecting'
  realtimeConnection = openFeedbackRealtimeStream('service', {
    onOpen: (payload) => {
      if (!isWorkbenchResident.value || currentToken !== lifecycleToken) {
        return
      }
      if (payload.availability || payload.session) {
        presence.value = {
          availability: payload.availability ?? presence.value?.availability ?? {
            status: 'offline',
            reason: 'no_online_staff',
            isOnline: false,
            withinWorkHours: false,
            hasOnlineStaff: false,
            serviceConnectedCount: 0,
            serverTime: new Date().toISOString(),
            workHoursText: '',
            offlineNotice: '正在确认客服在线状态...',
            offlineFaqs: [],
          },
          session: payload.session ?? presence.value?.session ?? {
            currentConversationEventId: 0,
            clientConnectionCount: 0,
            serviceConnectionCount: 0,
            recentConnections: [],
          },
        }
      }
      void refreshWorkbenchData(currentToken, { refreshPresence: true, refreshSelectedDetail: false })
      reconnectTip.value = '已恢复客服实时连接，当前工作台会自动续接最新会话变化。'
    },
    onConversation: async (payload) => {
      await handleRealtimeConversation(currentToken, payload)
    },
    onError: () => {
      if (!isWorkbenchResident.value || currentToken !== lifecycleToken) {
        return
      }
      realtimeState.value = 'offline'
      reconnectTip.value = '实时连接已中断，系统正在尝试自动续接...'
      reconnectTimer = setTimeout(() => {
        if (!isWorkbenchResident.value || currentToken !== lifecycleToken) {
          return
        }
        connectRealtime(currentToken)
      }, 3000)
    },
  })
}

/**
 * 进入工作台时才建立在线态。
 * - keep-alive 首次进入与再次切回都会调用这里；
 * - 通过生命周期令牌拦截旧请求回流，避免离页后旧异步任务重新接管连接。
 */
const enterWorkbench = async () => {
  lifecycleToken += 1
  const currentToken = lifecycleToken
  isWorkbenchResident.value = true
  reconnectTip.value = '进入工作台后会自动续接当前客服会话。'

  try {
    await refreshWorkbenchData(currentToken, { refreshPresence: true, refreshSelectedDetail: true })
    if (!isWorkbenchResident.value || currentToken !== lifecycleToken) {
      return
    }
    startRefreshPolling(currentToken)
    connectRealtime(currentToken)
  } catch (error) {
    if (!isWorkbenchResident.value || currentToken !== lifecycleToken) {
      return
    }
    ElMessage.error(extractErrorMessage(error, '客服工作台初始化失败，请稍后重试'))
  }
}

const leaveWorkbench = () => {
  isWorkbenchResident.value = false
  lifecycleToken += 1
  pendingRefresh = false
  disposeRealtime()
  realtimeState.value = 'offline'
  reconnectTip.value = '离开工作台后已释放在线状态，返回页面会自动续接。'
}

watch(
  () => authStore.currentUser?.id,
  (currentUserId, previousUserId) => {
    if (currentUserId && currentUserId !== previousUserId && isWorkbenchResident.value) {
      void enterWorkbench()
      return
    }

    if (!currentUserId) {
      leaveWorkbench()
    }
  },
)

onActivated(() => {
  void enterWorkbench()
})

onDeactivated(() => {
  leaveWorkbench()
})

onBeforeUnmount(() => {
  leaveWorkbench()
})
</script>

<template>
  <PageContainer
    title="客服工作台"
    description="统一承接客户端反馈、Issue 字段治理与会话回复，减少客服在多个系统之间切换。"
  >
    <div class="space-y-3">
      <article class="rounded-[28px] border border-slate-200/80 bg-white/95 p-4 shadow-[0_18px_48px_-40px_rgba(15,23,42,0.24)]">
        <div class="flex flex-col gap-4 2xl:flex-row 2xl:items-start 2xl:justify-between">
          <div class="min-w-0 2xl:max-w-[420px]">
            <div class="flex flex-wrap items-center gap-2">
              <p class="text-base font-semibold text-slate-900">在线状态</p>
              <span
                class="rounded-full px-3 py-1.5 text-xs font-semibold"
                :class="realtimeState === 'online' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'"
              >
                {{ realtimeState === 'online' ? '客服在线' : realtimeState === 'connecting' ? '连接中' : '客服离线' }}
              </span>
            </div>
            <p class="mt-2 text-sm text-slate-500">
              {{ presence?.availability?.isOnline ? `当前在线，已有 ${presence?.session.serviceConnectionCount ?? 0} 位客服在线接待，可在当前工作台持续跟进。` : (presence?.availability?.offlineNotice || '正在确认客服在线状态...') }}
            </p>
            <p class="mt-1 text-xs text-slate-400">{{ reconnectTip }}</p>
          </div>

          <div class="grid gap-2 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6 2xl:min-w-0 2xl:flex-1">
            <article class="cs-summary-card cs-summary-card--compact">
              <p class="cs-summary-card__label">全部反馈</p>
              <p class="cs-summary-card__value">{{ summary.all }}</p>
            </article>
            <article class="cs-summary-card cs-summary-card--compact">
              <p class="cs-summary-card__label">待受理</p>
              <p class="cs-summary-card__value text-amber-600">{{ summary.pending }}</p>
            </article>
            <article class="cs-summary-card cs-summary-card--compact">
              <p class="cs-summary-card__label">处理中</p>
              <p class="cs-summary-card__value text-sky-600">{{ summary.processing }}</p>
            </article>
            <article class="cs-summary-card cs-summary-card--compact">
              <p class="cs-summary-card__label">紧急反馈</p>
              <p class="cs-summary-card__value text-rose-600">{{ summary.urgent }}</p>
            </article>
            <article class="cs-summary-card cs-summary-card--compact">
              <p class="cs-summary-card__label">待分配</p>
              <p class="cs-summary-card__value text-slate-700">{{ summary.unassigned }}</p>
            </article>
            <article class="cs-summary-card cs-summary-card--compact">
              <p class="cs-summary-card__label">等待客服回复</p>
              <p class="cs-summary-card__value text-brand">{{ summary.waitingStaffReply }}</p>
            </article>
          </div>
        </div>
      </article>

      <article class="rounded-[28px] border border-slate-200/80 bg-white/95 p-4 shadow-[0_18px_48px_-40px_rgba(15,23,42,0.24)]">
        <div class="flex flex-col gap-3 xl:flex-row xl:items-end">
          <div class="grid flex-1 gap-3 md:grid-cols-2 xl:grid-cols-[minmax(0,1.5fr)_160px_160px_170px]">
            <label class="block">
              <span class="mb-1.5 block text-xs font-medium tracking-[0.16em] text-slate-400">关键字</span>
              <input
                v-model="searchForm.keyword"
                type="text"
                maxlength="80"
                class="cs-input"
                placeholder="搜索标题、Issue 编号、用户、订单号、标签"
                @keyup.enter="handleSearch"
              />
            </label>
            <label class="block">
              <span class="mb-1.5 block text-xs font-medium tracking-[0.16em] text-slate-400">状态</span>
              <select v-model="searchForm.status" class="cs-input">
                <option value="">全部状态</option>
                <option v-for="item in FEEDBACK_STATUS_OPTIONS" :key="item.value" :value="item.value">
                  {{ item.label }}
                </option>
              </select>
            </label>
            <label class="block">
              <span class="mb-1.5 block text-xs font-medium tracking-[0.16em] text-slate-400">优先级</span>
              <select v-model="searchForm.priority" class="cs-input">
                <option value="">全部优先级</option>
                <option v-for="item in FEEDBACK_PRIORITY_OPTIONS" :key="item.value" :value="item.value">
                  {{ item.label }}
                </option>
              </select>
            </label>
            <label class="block">
              <span class="mb-1.5 block text-xs font-medium tracking-[0.16em] text-slate-400">分配范围</span>
              <select v-model="searchForm.assigneeScope" class="cs-input">
                <option value="all">全部工单</option>
                <option value="mine">仅看我的</option>
                <option value="unassigned">仅看待分配</option>
              </select>
            </label>
          </div>

          <div class="flex flex-wrap gap-2 xl:shrink-0 xl:justify-end">
            <button type="button" class="cs-secondary-button" @click="handleReset">重置筛选</button>
            <button type="button" class="cs-primary-button" @click="handleSearch">刷新列表</button>
          </div>
        </div>
      </article>

      <div class="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)] 2xl:grid-cols-[336px_minmax(0,1fr)]">
        <article class="rounded-[28px] border border-slate-200/80 bg-white/95 p-4 shadow-[0_18px_48px_-40px_rgba(15,23,42,0.24)] xl:flex xl:min-h-[calc(100vh-18rem)] xl:flex-col">
          <div class="flex items-center justify-between gap-3">
            <div>
              <p class="text-base font-semibold text-slate-900">反馈列表</p>
              <p class="mt-1 text-xs text-slate-400">最近更新的会话优先展示，便于先处理正在往来的问题。</p>
            </div>
            <span class="text-xs font-medium text-slate-400">{{ conversations.length }} 条</span>
          </div>

          <div v-if="loading" class="mt-4 rounded-[18px] bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
            正在加载反馈列表...
          </div>

          <div v-else-if="!conversations.length" class="mt-4 rounded-[18px] bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
            当前筛选下暂无反馈会话，可调整筛选条件后重试。
          </div>

          <TransitionGroup
            v-else
            name="cs-conversation-list"
            tag="div"
            class="mt-4 space-y-3 xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:pr-1"
          >
            <button
              v-for="item in conversations"
              :key="item.id"
              type="button"
              class="cs-conversation-item block w-full rounded-[20px] border p-4 text-left transition"
              :class="item.id === selectedConversationId ? 'is-selected border-brand bg-brand/5' : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'"
              @click="handleSelectConversation(item.id)"
            >
              <div class="flex flex-wrap items-start justify-between gap-2">
                <div class="min-w-0">
                  <p class="truncate text-sm font-semibold text-slate-900">{{ item.title }}</p>
                  <p class="mt-1 text-xs text-slate-500">{{ item.issueNo }}</p>
                </div>
                <span class="rounded-full px-2.5 py-1 text-[11px] font-semibold" :class="FEEDBACK_STATUS_META_MAP[item.status].className">
                  {{ FEEDBACK_STATUS_META_MAP[item.status].label }}
                </span>
              </div>

              <div class="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span>{{ item.clientDisplayName }}</span>
                <span>{{ item.clientDepartmentName || '未填写部门' }}</span>
                <span>{{ formatDateTime(item.lastMessageAt) }}</span>
              </div>

              <div class="mt-3 flex flex-wrap items-center gap-2">
                <span class="rounded-full px-2.5 py-1 text-[11px] font-semibold" :class="FEEDBACK_PRIORITY_META_MAP[item.priority].className">
                  {{ FEEDBACK_PRIORITY_META_MAP[item.priority].label }}
                </span>
                <span v-if="item.assigneeName" class="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-medium text-slate-600">
                  {{ item.assigneeName }}
                </span>
                <span v-if="item.unreadForStaff > 0" class="rounded-full bg-rose-50 px-2.5 py-1 text-[11px] font-semibold text-rose-600">
                  待回复 {{ item.unreadForStaff }}
                </span>
              </div>
            </button>
          </TransitionGroup>
        </article>

        <Transition name="cs-detail-panel" mode="out-in">
          <article
            v-if="selectedConversation"
            :key="selectedConversation.id"
            class="rounded-[28px] border border-slate-200/80 bg-white/95 p-4 shadow-[0_18px_48px_-40px_rgba(15,23,42,0.24)] xl:flex xl:min-h-[calc(100vh-18rem)] xl:flex-col"
          >
          <div v-if="detailLoading" class="mb-4 rounded-[18px] bg-slate-50 px-4 py-3 text-sm text-slate-500">
            正在同步会话详情...
          </div>
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="text-xs font-semibold tracking-[0.16em] text-slate-400">{{ selectedConversation.issueNo }}</p>
              <h2 class="mt-2 text-xl font-semibold text-slate-900">{{ selectedConversation.title }}</h2>
              <p class="mt-2 text-sm leading-6 text-slate-500">
                {{ selectedConversation.clientDisplayName }} · {{ selectedConversation.clientAccount }} · {{ selectedConversation.clientDepartmentName || '未填写部门' }}
              </p>
            </div>

            <div class="flex flex-wrap gap-2">
              <span class="rounded-full px-3 py-1.5 text-xs font-semibold" :class="FEEDBACK_STATUS_META_MAP[selectedConversation.status].className">
                {{ FEEDBACK_STATUS_META_MAP[selectedConversation.status].label }}
              </span>
              <span class="rounded-full px-3 py-1.5 text-xs font-semibold" :class="FEEDBACK_PRIORITY_META_MAP[selectedConversation.priority].className">
                {{ FEEDBACK_PRIORITY_META_MAP[selectedConversation.priority].label }}
              </span>
            </div>
          </div>

          <div class="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[20px] border border-slate-200 bg-slate-50/80 px-4 py-3">
            <div class="flex flex-wrap items-center gap-2">
              <button type="button" class="cs-mini-button" :class="{ 'is-busy': saving && quickStatusUpdating === '' && priorityUpdating === '' }" :disabled="saving" @click="handleTakeOver">接手处理</button>
              <button
                v-for="item in FEEDBACK_STATUS_OPTIONS.filter((option) => ['pending', 'processing', 'resolved'].includes(option.value))"
                :key="item.value"
                type="button"
                class="cs-status-button"
                :class="[{ 'is-busy': quickStatusUpdating === item.value }, issueForm.status === item.value ? 'is-active' : '']"
                :disabled="saving"
                @click="handleQuickStatus(item.value)"
              >
                {{ quickStatusUpdating === item.value ? '处理中...' : item.label }}
              </button>
            </div>
            <div class="flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <span class="rounded-full bg-white px-2.5 py-1 font-medium text-slate-600">
                当前负责人：{{ selectedConversation.assigneeName || '待分配' }}
              </span>
              <button type="button" class="cs-text-button" :disabled="saving" @click="handleQuickStatus('closed')">关闭会话</button>
            </div>
          </div>

          <div class="mt-5 grid gap-4 xl:min-h-0 xl:flex-1 2xl:grid-cols-[minmax(0,1fr)_320px]">
            <div class="flex min-h-0 flex-col gap-4">
              <div class="rounded-[20px] border border-slate-200 bg-slate-50/80 p-4 xl:flex xl:min-h-0 xl:flex-col">
                <div class="flex items-center justify-between gap-3">
                  <div>
                    <p class="text-base font-semibold text-slate-900">会话详情</p>
                    <p class="mt-1 text-xs text-slate-400">围绕当前 Issue 的完整消息记录，客服回复后客户端会看到同一条会话更新。</p>
                  </div>
                  <span class="text-xs text-slate-400">{{ selectedConversation.messages.length }} 条消息</span>
                </div>

                <TransitionGroup name="cs-message-stack" tag="div" class="mt-4 space-y-3 xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:pr-1">
                  <article
                    v-for="message in selectedConversation.messages"
                    :key="message.id"
                    class="cs-message-card rounded-[18px] px-4 py-3"
                    :class="message.senderRole === 'staff' ? 'ml-auto bg-brand/10' : 'bg-white'"
                  >
                    <div class="flex flex-wrap items-center justify-between gap-2">
                      <p class="text-sm font-semibold text-slate-900">
                        {{ message.senderName }}
                        <span class="ml-2 text-xs font-medium text-slate-400">
                          {{ message.senderRole === 'staff' ? '客服' : '客户端' }}
                        </span>
                      </p>
                      <span class="text-xs text-slate-400">{{ formatDateTime(message.createdAt) }}</span>
                    </div>
                    <p class="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">{{ message.body }}</p>
                  </article>
                </TransitionGroup>
              </div>

              <div class="rounded-[20px] border border-slate-200 bg-white p-4">
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p class="text-base font-semibold text-slate-900">客服处理面板</p>
                    <p class="mt-1 text-xs text-slate-400">将回复、内部备注和优先级重分配收口到同一区域，减少信息分散。</p>
                  </div>
                  <button type="button" class="cs-mini-button" :disabled="saving" @click="handleTogglePriorityPanel">
                    {{ isPriorityPanelExpanded ? '收起优先级' : '重分配优先级' }}
                  </button>
                </div>

                <Transition name="cs-collapse">
                  <div v-if="isPriorityPanelExpanded" class="mt-4 rounded-[18px] border border-slate-200 bg-slate-50 px-4 py-3">
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p class="text-sm font-semibold text-slate-900">客服优先级重分配</p>
                      <p class="mt-1 text-xs text-slate-400">按实际影响范围与紧急度调整优先级，保存后会同步列表与会话标签。</p>
                    </div>
                    <span class="rounded-full px-2.5 py-1 text-[11px] font-semibold" :class="FEEDBACK_PRIORITY_META_MAP[issueForm.priority].className">
                      当前：{{ FEEDBACK_PRIORITY_META_MAP[issueForm.priority].label }}
                    </span>
                  </div>
                  <div class="mt-3 flex flex-wrap gap-2">
                    <button
                      v-for="item in FEEDBACK_PRIORITY_OPTIONS"
                      :key="item.value"
                      type="button"
                      class="cs-priority-button"
                      :class="[{ 'is-busy': priorityUpdating === item.value }, issueForm.priority === item.value ? 'is-active' : '']"
                      :disabled="saving"
                      @click="handleReassignPriority(item.value)"
                    >
                      {{ priorityUpdating === item.value ? '更新中...' : item.label }}
                    </button>
                  </div>
                  </div>
                </Transition>

                <div class="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
                  <section class="rounded-[18px] border border-slate-200 bg-slate-50/70 p-4">
                    <div class="flex items-center justify-between gap-3">
                      <div>
                        <p class="text-sm font-semibold text-slate-900">客服回复</p>
                        <p class="mt-1 text-xs text-slate-400">发送前会同步当前结构化字段，确保结论与状态一致。</p>
                      </div>
                      <button type="button" class="cs-primary-button cs-primary-button--compact" :class="{ 'is-busy': replying }" :disabled="replying" @click="handleReply">
                        {{ replying ? '发送中...' : '发送回复' }}
                      </button>
                    </div>
                    <textarea
                      v-model="replyDraft"
                      class="cs-textarea mt-4"
                      maxlength="500"
                      placeholder="请输入给客户端的回复内容，例如处理结论、补充说明或下一步动作。"
                    />
                  </section>

                  <section class="rounded-[18px] border border-slate-200 bg-slate-50/70 p-4">
                    <div class="flex items-center justify-between gap-3">
                      <div>
                        <p class="text-sm font-semibold text-slate-900">内部备注</p>
                        <p class="mt-1 text-xs text-slate-400">仅客服内部可见，适合记录排查结论与交接信息。</p>
                      </div>
                      <button type="button" class="cs-mini-button" :class="{ 'is-busy': remarkSaving }" :disabled="remarkSaving" @click="handleSaveInternalRemark">
                        {{ remarkSaving ? '保存中...' : '保存备注' }}
                      </button>
                    </div>
                    <textarea
                      v-model="issueForm.internalRemark"
                      class="cs-textarea mt-4"
                      maxlength="4000"
                      placeholder="可记录排查结论、交接信息、风险判断或内部提醒。"
                    />
                    <p v-if="selectedConversation.internalRemark?.updatedAt" class="mt-2 text-xs text-slate-400">
                      最近更新：{{ selectedConversation.internalRemark.updatedByDisplayName || selectedConversation.internalRemark.updatedByUsername || '未知客服' }}
                      · {{ formatDateTime(selectedConversation.internalRemark.updatedAt) }}
                    </p>
                  </section>
                </div>
              </div>
            </div>

            <div class="rounded-[20px] border border-slate-200 bg-slate-50/70 p-4 xl:min-h-0 xl:overflow-y-auto">
              <div class="flex items-center justify-between gap-3">
                <div>
                  <p class="text-base font-semibold text-slate-900">Issue 字段</p>
                  <p class="mt-1 text-xs text-slate-400">聚焦结构化排查字段，去掉与顶部状态和优先级重复的内容。</p>
                </div>
                <span class="rounded-full bg-slate-200 px-2.5 py-1 text-[11px] font-semibold text-slate-600">
                  {{ getCategoryLabel(issueForm.category) }}
                </span>
              </div>

              <div class="mt-4 space-y-3">
                <label class="block">
                  <span class="mb-1.5 block text-xs font-medium text-slate-500">标题</span>
                  <input v-model="issueForm.title" type="text" maxlength="80" class="cs-input" />
                </label>

                <div class="grid gap-3 sm:grid-cols-2">
                  <label class="block">
                    <span class="mb-1.5 block text-xs font-medium text-slate-500">问题类型</span>
                    <select v-model="issueForm.issueType" class="cs-input">
                      <option v-for="item in FEEDBACK_ISSUE_TYPE_OPTIONS" :key="item.value" :value="item.value">
                        {{ item.label }}
                      </option>
                    </select>
                  </label>
                  <label class="block">
                    <span class="mb-1.5 block text-xs font-medium text-slate-500">问题分类</span>
                    <select v-model="issueForm.category" class="cs-input">
                      <option v-for="item in FEEDBACK_CATEGORY_OPTIONS" :key="item.value" :value="item.value">
                        {{ item.label }}
                      </option>
                    </select>
                  </label>
                </div>

                <label class="block">
                  <span class="mb-1.5 block text-xs font-medium text-slate-500">关联订单号</span>
                  <input v-model="issueForm.orderRef" type="text" maxlength="64" class="cs-input" placeholder="如问题关联订单，可补充订单号或提货码" />
                </label>

                <label class="block">
                  <span class="mb-1.5 block text-xs font-medium text-slate-500">期望结果</span>
                  <textarea v-model="issueForm.expectedResult" class="cs-textarea cs-textarea--compact" maxlength="240" />
                </label>

                <label class="block">
                  <span class="mb-1.5 block text-xs font-medium text-slate-500">实际结果</span>
                  <textarea v-model="issueForm.actualResult" class="cs-textarea cs-textarea--compact" maxlength="240" />
                </label>

                <label class="block">
                  <span class="mb-1.5 block text-xs font-medium text-slate-500">复现步骤</span>
                  <textarea v-model="issueForm.reproductionSteps" class="cs-textarea cs-textarea--compact" maxlength="300" />
                </label>

                <label class="block">
                  <span class="mb-1.5 block text-xs font-medium text-slate-500">联系偏好</span>
                  <input v-model="issueForm.contactPreference" type="text" maxlength="64" class="cs-input" />
                </label>

                <label class="block">
                  <span class="mb-1.5 block text-xs font-medium text-slate-500">标签</span>
                  <input v-model="issueForm.tagText" type="text" maxlength="120" class="cs-input" placeholder="使用中文逗号分隔多个标签" />
                </label>
              </div>

              <button type="button" class="cs-primary-button mt-4 w-full justify-center" :class="{ 'is-busy': saving && quickStatusUpdating === '' && priorityUpdating === '' }" :disabled="saving" @click="handleSaveIssue">
                {{ saving ? '保存中...' : '保存 Issue 字段' }}
              </button>
            </div>
          </div>
          </article>

          <article v-else key="empty-detail" class="rounded-[28px] border border-slate-200/80 bg-white/95 p-8 text-center shadow-[0_18px_48px_-40px_rgba(15,23,42,0.24)]">
            <p class="text-lg font-semibold text-slate-900">暂无可查看的反馈会话</p>
            <p class="mt-2 text-sm leading-6 text-slate-500">当客户端提交反馈后，这里会自动展示统一会话与 Issue 字段明细。</p>
          </article>
        </Transition>
      </div>
    </div>
  </PageContainer>
</template>

<style scoped>
/*
 * 工作台卡片数字样式：
 * - 用更大的数字快速传达积压量与处理状态；
 * - 维持和现有管理端卡片相同的圆角留白语言。
 */
.cs-summary-card {
  border: 1px solid rgba(226, 232, 240, 0.9);
  border-radius: 24px;
  background: rgba(255, 255, 255, 0.95);
  box-shadow: 0 18px 48px -40px rgba(15, 23, 42, 0.24);
  padding: 1rem;
}

.cs-summary-card__label {
  color: rgb(148 163 184);
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.16em;
}

.cs-summary-card__value {
  margin-top: 0.85rem;
  color: rgb(15 23 42);
  font-size: 1.8rem;
  font-weight: 700;
  line-height: 1;
}

.cs-summary-card--compact {
  min-width: 0;
  border-radius: 20px;
  padding: 0.75rem 0.82rem;
}

.cs-summary-card--compact .cs-summary-card__label {
  white-space: nowrap;
  letter-spacing: 0.12em;
  font-size: 0.68rem;
}

.cs-summary-card--compact .cs-summary-card__value {
  margin-top: 0.5rem;
  white-space: nowrap;
  font-size: 1.35rem;
}

.cs-conversation-item {
  transition:
    border-color 0.2s ease,
    background-color 0.2s ease,
    box-shadow 0.22s ease,
    transform 0.22s ease;
}

.cs-conversation-item:hover {
  transform: translateY(-1px);
  box-shadow: 0 14px 28px -24px rgba(15, 23, 42, 0.22);
}

.cs-conversation-item.is-selected {
  box-shadow: 0 18px 34px -28px rgba(13, 148, 136, 0.28);
  transform: translateY(-1px);
}

/*
 * 统一输入控件与按钮样式：
 * - 避免页面中混用多套边框、圆角与焦点反馈；
 * - 让筛选区、Issue 编辑区与回复区维持同一套语言。
 */
.cs-input,
.cs-textarea {
  width: 100%;
  border: 1px solid rgb(226 232 240);
  border-radius: 16px;
  background: #ffffff;
  color: rgb(15 23 42);
  font-size: 0.92rem;
  line-height: 1.5;
  padding: 0.8rem 0.92rem;
  transition:
    border-color 0.18s ease,
    box-shadow 0.18s ease;
}

.cs-input:focus,
.cs-textarea:focus {
  outline: none;
  border-color: rgba(13, 148, 136, 0.5);
  box-shadow: 0 0 0 4px rgba(13, 148, 136, 0.12);
}

.cs-textarea {
  min-height: 124px;
  resize: vertical;
}

.cs-textarea--compact {
  min-height: 92px;
}

.cs-primary-button,
.cs-secondary-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 16px;
  font-size: 0.92rem;
  font-weight: 600;
  line-height: 1;
  padding: 0.82rem 1rem;
  transition:
    transform 0.18s ease,
    opacity 0.18s ease,
    background-color 0.18s ease;
}

.cs-primary-button {
  background: rgb(15 118 110);
  color: #ffffff;
}

.cs-primary-button,
.cs-mini-button,
.cs-status-button,
.cs-priority-button {
  position: relative;
  overflow: hidden;
}

.cs-primary-button:hover,
.cs-secondary-button:hover {
  transform: translateY(-1px);
}

.cs-secondary-button {
  border: 1px solid rgb(226 232 240);
  background: #ffffff;
  color: rgb(51 65 85);
}

.cs-primary-button:disabled,
.cs-secondary-button:disabled {
  cursor: not-allowed;
  opacity: 0.6;
  transform: none;
}

.cs-primary-button--compact {
  min-height: 2.25rem;
  border-radius: 14px;
  font-size: 0.84rem;
  padding: 0.68rem 0.92rem;
}

.cs-mini-button,
.cs-status-button,
.cs-priority-button,
.cs-text-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 9999px;
  font-size: 0.78rem;
  font-weight: 600;
  line-height: 1;
  transition:
    background-color 0.18s ease,
    color 0.18s ease,
    border-color 0.18s ease,
    transform 0.18s ease,
    opacity 0.18s ease;
}

.cs-mini-button,
.cs-status-button,
.cs-priority-button {
  border: 1px solid rgb(226 232 240);
  background: #ffffff;
  color: rgb(51 65 85);
  padding: 0.52rem 0.85rem;
}

.cs-text-button {
  color: rgb(148 35 35);
  padding: 0.3rem 0;
}

.cs-mini-button:hover,
.cs-status-button:hover,
.cs-priority-button:hover,
.cs-text-button:hover {
  transform: translateY(-1px);
}

.cs-status-button.is-active {
  border-color: rgba(13, 148, 136, 0.22);
  background: rgba(13, 148, 136, 0.12);
  color: rgb(15 118 110);
  box-shadow: inset 0 0 0 1px rgba(13, 148, 136, 0.04), 0 8px 18px -16px rgba(13, 148, 136, 0.45);
}

.cs-priority-button.is-active {
  border-color: rgba(2, 132, 199, 0.2);
  background: rgba(14, 165, 233, 0.12);
  color: rgb(3 105 161);
  box-shadow: inset 0 0 0 1px rgba(14, 165, 233, 0.04), 0 8px 18px -16px rgba(14, 165, 233, 0.38);
}

.cs-mini-button:disabled,
.cs-status-button:disabled,
.cs-priority-button:disabled,
.cs-text-button:disabled {
  cursor: not-allowed;
  opacity: 0.6;
  transform: none;
}

.cs-primary-button.is-busy,
.cs-mini-button.is-busy,
.cs-status-button.is-busy,
.cs-priority-button.is-busy {
  animation: cs-button-busy 1.1s ease-in-out infinite;
}

.cs-message-card {
  transition:
    transform 0.22s ease,
    box-shadow 0.22s ease,
    background-color 0.22s ease;
}

.cs-message-card:hover {
  transform: translateY(-1px);
  box-shadow: 0 14px 28px -24px rgba(15, 23, 42, 0.18);
}

.cs-conversation-list-enter-active,
.cs-conversation-list-leave-active,
.cs-message-stack-enter-active,
.cs-message-stack-leave-active,
.cs-detail-panel-enter-active,
.cs-detail-panel-leave-active,
.cs-collapse-enter-active,
.cs-collapse-leave-active {
  transition: all 0.24s ease;
}

.cs-conversation-list-enter-from,
.cs-conversation-list-leave-to {
  opacity: 0;
  transform: translateY(10px);
}

.cs-message-stack-enter-from,
.cs-message-stack-leave-to {
  opacity: 0;
  transform: translateY(12px) scale(0.98);
}

.cs-message-stack-move,
.cs-conversation-list-move {
  transition: transform 0.24s ease;
}

.cs-detail-panel-enter-from,
.cs-detail-panel-leave-to {
  opacity: 0;
  transform: translateY(12px);
}

.cs-collapse-enter-from,
.cs-collapse-leave-to {
  opacity: 0;
  transform: translateY(-8px);
  max-height: 0;
}

.cs-collapse-enter-to,
.cs-collapse-leave-from {
  opacity: 1;
  transform: translateY(0);
  max-height: 16rem;
}

@keyframes cs-button-busy {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(13, 148, 136, 0.1);
    transform: translateY(0);
  }
  50% {
    box-shadow: 0 0 0 6px rgba(13, 148, 136, 0.06);
    transform: translateY(-1px);
  }
}

/*
 * 统一滚动条观感：
 * - 桌面端内部滚动区域较多，统一弱化滚动条存在感；
 * - 保留足够的拖拽面积，避免列表和详情区难以操作。
 */
:deep(*::-webkit-scrollbar) {
  width: 8px;
  height: 8px;
}

:deep(*::-webkit-scrollbar-thumb) {
  border-radius: 9999px;
  background: rgba(148, 163, 184, 0.45);
}

:deep(*::-webkit-scrollbar-track) {
  background: transparent;
}
</style>
