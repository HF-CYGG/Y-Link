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

/**
 * Element Plus 标签类型映射：
 * - 统一把业务状态翻译成组件语义色，避免模板层散落多套 class 判断；
 * - 后续若要统一品牌色，只需要在这里集中调整。
 */
const getRealtimeTagType = () => {
  if (realtimeState.value === 'online') {
    return 'success'
  }
  if (realtimeState.value === 'connecting') {
    return 'warning'
  }
  return 'info'
}

const getStatusTagType = (status: FeedbackIssueStatus) => {
  if (status === 'pending') {
    return 'warning'
  }
  if (status === 'processing') {
    return 'primary'
  }
  if (status === 'resolved') {
    return 'success'
  }
  return 'info'
}

const getPriorityTagType = (priority: FeedbackIssuePriority) => {
  if (priority === 'urgent') {
    return 'danger'
  }
  if (priority === 'high') {
    return 'warning'
  }
  if (priority === 'medium') {
    return 'primary'
  }
  return 'info'
}

const getQuickStatusButtonType = (status: FeedbackIssueStatus) => {
  return issueForm.status === status ? 'primary' : 'default'
}

const getPriorityButtonType = (priority: FeedbackIssuePriority) => {
  return issueForm.priority === priority ? 'primary' : 'default'
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
      <el-card class="cs-panel-card" shadow="never">
        <div class="flex flex-col gap-4 2xl:flex-row 2xl:items-start 2xl:justify-between">
          <div class="min-w-0 2xl:max-w-[420px]">
            <div class="flex flex-wrap items-center gap-2">
              <p class="text-base font-semibold text-slate-900">在线状态</p>
              <el-tag :type="getRealtimeTagType()" effect="light" round>
                {{ realtimeState === 'online' ? '客服在线' : realtimeState === 'connecting' ? '连接中' : '客服离线' }}
              </el-tag>
            </div>
            <p class="mt-2 text-sm text-slate-500">
              {{ presence?.availability?.isOnline ? `当前在线，已有 ${presence?.session.serviceConnectionCount ?? 0} 位客服在线接待，可在当前工作台持续跟进。` : (presence?.availability?.offlineNotice || '正在确认客服在线状态...') }}
            </p>
            <p class="mt-1 text-xs text-slate-400">{{ reconnectTip }}</p>
          </div>

          <div class="grid gap-2 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6 2xl:min-w-0 2xl:flex-1">
            <el-card class="cs-summary-card cs-summary-card--compact" shadow="never">
              <p class="cs-summary-card__label">全部反馈</p>
              <p class="cs-summary-card__value">{{ summary.all }}</p>
            </el-card>
            <el-card class="cs-summary-card cs-summary-card--compact" shadow="never">
              <p class="cs-summary-card__label">待受理</p>
              <p class="cs-summary-card__value text-amber-600">{{ summary.pending }}</p>
            </el-card>
            <el-card class="cs-summary-card cs-summary-card--compact" shadow="never">
              <p class="cs-summary-card__label">处理中</p>
              <p class="cs-summary-card__value text-sky-600">{{ summary.processing }}</p>
            </el-card>
            <el-card class="cs-summary-card cs-summary-card--compact" shadow="never">
              <p class="cs-summary-card__label">紧急反馈</p>
              <p class="cs-summary-card__value text-rose-600">{{ summary.urgent }}</p>
            </el-card>
            <el-card class="cs-summary-card cs-summary-card--compact" shadow="never">
              <p class="cs-summary-card__label">待分配</p>
              <p class="cs-summary-card__value text-slate-700">{{ summary.unassigned }}</p>
            </el-card>
            <el-card class="cs-summary-card cs-summary-card--compact" shadow="never">
              <p class="cs-summary-card__label">等待客服回复</p>
              <p class="cs-summary-card__value text-brand">{{ summary.waitingStaffReply }}</p>
            </el-card>
          </div>
        </div>
      </el-card>

      <el-card class="cs-panel-card" shadow="never">
        <el-form label-position="top" class="cs-filter-form">
          <div class="flex flex-col gap-3 xl:flex-row xl:items-end">
            <div class="grid flex-1 gap-3 md:grid-cols-2 xl:grid-cols-[minmax(0,1.5fr)_160px_160px_170px]">
              <el-form-item label="关键字" class="!mb-0">
                <el-input
                  v-model="searchForm.keyword"
                  maxlength="80"
                  clearable
                  placeholder="搜索标题、Issue 编号、用户、订单号、标签"
                  @keyup.enter="handleSearch"
                />
              </el-form-item>
              <el-form-item label="状态" class="!mb-0">
                <el-select v-model="searchForm.status" placeholder="全部状态" clearable class="w-full">
                  <el-option
                    v-for="item in FEEDBACK_STATUS_OPTIONS"
                    :key="item.value"
                    :label="item.label"
                    :value="item.value"
                  />
                </el-select>
              </el-form-item>
              <el-form-item label="优先级" class="!mb-0">
                <el-select v-model="searchForm.priority" placeholder="全部优先级" clearable class="w-full">
                  <el-option
                    v-for="item in FEEDBACK_PRIORITY_OPTIONS"
                    :key="item.value"
                    :label="item.label"
                    :value="item.value"
                  />
                </el-select>
              </el-form-item>
              <el-form-item label="分配范围" class="!mb-0">
                <el-select v-model="searchForm.assigneeScope" class="w-full">
                  <el-option label="全部工单" value="all" />
                  <el-option label="仅看我的" value="mine" />
                  <el-option label="仅看待分配" value="unassigned" />
                </el-select>
              </el-form-item>
            </div>

            <div class="flex flex-wrap gap-2 xl:shrink-0 xl:justify-end">
              <el-button @click="handleReset">重置筛选</el-button>
              <el-button type="primary" :loading="loading" @click="handleSearch">刷新列表</el-button>
            </div>
          </div>
        </el-form>
      </el-card>

      <div class="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)] 2xl:grid-cols-[336px_minmax(0,1fr)]">
        <el-card class="cs-panel-card xl:flex xl:min-h-[calc(100vh-18rem)] xl:flex-col" shadow="never">
          <div class="cs-list-heading">
            <div class="min-w-0">
              <p class="text-base font-semibold text-slate-900">反馈列表</p>
              <p class="cs-list-heading__desc">最近更新的会话优先展示，便于先处理正在往来的问题。</p>
            </div>
            <el-tag type="info" effect="plain" round class="cs-list-count">
              共 {{ conversations.length }} 条
            </el-tag>
          </div>

          <div v-if="loading" class="mt-4">
            <el-skeleton :rows="6" animated />
          </div>

          <div v-else-if="!conversations.length" class="mt-4 rounded-[18px] bg-slate-50/70">
            <el-empty description="当前筛选下暂无反馈会话，可调整筛选条件后重试。" :image-size="88" />
          </div>

          <TransitionGroup
            v-else
            name="cs-conversation-list"
            tag="div"
            class="mt-4 space-y-3 xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:pr-1"
          >
            <el-card
              v-for="item in conversations"
              :key="item.id"
              class="cs-conversation-item"
              shadow="hover"
              :class="item.id === selectedConversationId ? 'is-selected' : ''"
              @click="handleSelectConversation(item.id)"
            >
              <div class="flex flex-wrap items-start justify-between gap-2">
                <div class="min-w-0">
                  <p class="truncate text-sm font-semibold text-slate-900">{{ item.title }}</p>
                  <p class="mt-1 text-xs text-slate-500">{{ item.issueNo }}</p>
                </div>
                <el-tag :type="getStatusTagType(item.status)" effect="light" round>
                  {{ FEEDBACK_STATUS_META_MAP[item.status].label }}
                </el-tag>
              </div>

              <div class="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span>{{ item.clientDisplayName }}</span>
                <span>{{ item.clientDepartmentName || '未填写部门' }}</span>
                <span>{{ formatDateTime(item.lastMessageAt) }}</span>
              </div>

              <div class="mt-3 flex flex-wrap items-center gap-2">
                <el-tag :type="getPriorityTagType(item.priority)" effect="light" round>
                  {{ FEEDBACK_PRIORITY_META_MAP[item.priority].label }}
                </el-tag>
                <el-tag v-if="item.assigneeName" type="info" effect="plain" round>
                  {{ item.assigneeName }}
                </el-tag>
                <el-tag v-if="item.unreadForStaff > 0" type="danger" effect="light" round>
                  待回复 {{ item.unreadForStaff }}
                </el-tag>
              </div>
            </el-card>
          </TransitionGroup>
        </el-card>

        <Transition name="cs-detail-panel" mode="out-in">
          <el-card
            v-if="selectedConversation"
            :key="selectedConversation.id"
            class="cs-panel-card xl:flex xl:min-h-[calc(100vh-18rem)] xl:flex-col"
            shadow="never"
          >
            <div v-if="detailLoading" class="mb-4">
              <el-skeleton :rows="4" animated />
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
                <el-tag :type="getStatusTagType(selectedConversation.status)" effect="light" round>
                  {{ FEEDBACK_STATUS_META_MAP[selectedConversation.status].label }}
                </el-tag>
                <el-tag :type="getPriorityTagType(selectedConversation.priority)" effect="light" round>
                  {{ FEEDBACK_PRIORITY_META_MAP[selectedConversation.priority].label }}
                </el-tag>
              </div>
            </div>

            <div class="mt-4 rounded-[20px] border border-slate-200 bg-slate-50/80 px-4 py-3">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div class="flex flex-wrap items-center gap-2">
                  <el-button type="primary" plain :loading="saving && quickStatusUpdating === '' && priorityUpdating === ''" :disabled="saving" @click="handleTakeOver">
                    接手处理
                  </el-button>
                  <el-button
                    v-for="item in FEEDBACK_STATUS_OPTIONS.filter((option) => ['pending', 'processing', 'resolved'].includes(option.value))"
                    :key="item.value"
                    :type="getQuickStatusButtonType(item.value)"
                    :plain="issueForm.status !== item.value"
                    :loading="quickStatusUpdating === item.value"
                    :disabled="saving"
                    @click="handleQuickStatus(item.value)"
                  >
                    {{ item.label }}
                  </el-button>
                </div>
                <div class="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <el-tag type="info" effect="plain" round>
                    当前负责人：{{ selectedConversation.assigneeName || '待分配' }}
                  </el-tag>
                  <el-button link type="danger" :disabled="saving" @click="handleQuickStatus('closed')">关闭会话</el-button>
                </div>
              </div>
            </div>

            <div class="mt-5 grid gap-4 xl:min-h-0 xl:flex-1 2xl:grid-cols-[minmax(0,1fr)_320px]">
              <div class="flex min-h-0 flex-col gap-4">
                <el-card class="cs-sub-card xl:flex xl:min-h-0 xl:flex-col" shadow="never">
                  <div class="flex items-center justify-between gap-3">
                    <div>
                      <p class="text-base font-semibold text-slate-900">会话详情</p>
                      <p class="mt-1 text-xs text-slate-400">围绕当前 Issue 的完整消息记录，客服回复后客户端会看到同一条会话更新。</p>
                    </div>
                    <span class="text-xs text-slate-400">{{ selectedConversation.messages.length }} 条消息</span>
                  </div>

                  <el-scrollbar class="mt-4 xl:min-h-0 xl:flex-1">
                    <TransitionGroup name="cs-message-stack" tag="div" class="space-y-3 pr-1">
                      <el-card
                        v-for="message in selectedConversation.messages"
                        :key="message.id"
                        class="cs-message-card"
                        shadow="never"
                        :class="message.senderRole === 'staff' ? 'is-staff' : 'is-client'"
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
                      </el-card>
                    </TransitionGroup>
                  </el-scrollbar>
                </el-card>

                <el-card class="cs-sub-card" shadow="never">
                  <div class="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p class="text-base font-semibold text-slate-900">客服处理面板</p>
                      <p class="mt-1 text-xs text-slate-400">将回复、内部备注和优先级重分配收口到同一区域，减少信息分散。</p>
                    </div>
                    <el-button plain :disabled="saving" @click="handleTogglePriorityPanel">
                      {{ isPriorityPanelExpanded ? '收起优先级' : '重分配优先级' }}
                    </el-button>
                  </div>

                  <el-collapse-transition>
                    <div v-if="isPriorityPanelExpanded" class="mt-4 rounded-[18px] border border-slate-200 bg-slate-50 px-4 py-3">
                      <div class="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <p class="text-sm font-semibold text-slate-900">客服优先级重分配</p>
                          <p class="mt-1 text-xs text-slate-400">按实际影响范围与紧急度调整优先级，保存后会同步列表与会话标签。</p>
                        </div>
                        <el-tag :type="getPriorityTagType(issueForm.priority)" effect="light" round>
                          当前：{{ FEEDBACK_PRIORITY_META_MAP[issueForm.priority].label }}
                        </el-tag>
                      </div>
                      <div class="mt-3 flex flex-wrap gap-2">
                        <el-button
                          v-for="item in FEEDBACK_PRIORITY_OPTIONS"
                          :key="item.value"
                          :type="getPriorityButtonType(item.value)"
                          :plain="issueForm.priority !== item.value"
                          :loading="priorityUpdating === item.value"
                          :disabled="saving"
                          @click="handleReassignPriority(item.value)"
                        >
                          {{ item.label }}
                        </el-button>
                      </div>
                    </div>
                  </el-collapse-transition>

                  <div class="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
                    <el-card class="cs-inner-action-card" shadow="never">
                      <div class="flex items-center justify-between gap-3">
                        <div>
                          <p class="text-sm font-semibold text-slate-900">客服回复</p>
                          <p class="mt-1 text-xs text-slate-400">发送前会同步当前结构化字段，确保结论与状态一致。</p>
                        </div>
                        <el-button type="primary" :loading="replying" :disabled="replying" @click="handleReply">
                          发送回复
                        </el-button>
                      </div>
                      <el-input
                        v-model="replyDraft"
                        class="mt-4"
                        type="textarea"
                        :rows="5"
                        maxlength="500"
                        show-word-limit
                        resize="vertical"
                        placeholder="请输入给客户端的回复内容，例如处理结论、补充说明或下一步动作。"
                      />
                    </el-card>

                    <el-card class="cs-inner-action-card" shadow="never">
                      <div class="flex items-center justify-between gap-3">
                        <div>
                          <p class="text-sm font-semibold text-slate-900">内部备注</p>
                          <p class="mt-1 text-xs text-slate-400">仅客服内部可见，适合记录排查结论与交接信息。</p>
                        </div>
                        <el-button :loading="remarkSaving" :disabled="remarkSaving" @click="handleSaveInternalRemark">
                          保存备注
                        </el-button>
                      </div>
                      <el-input
                        v-model="issueForm.internalRemark"
                        class="mt-4"
                        type="textarea"
                        :rows="5"
                        maxlength="4000"
                        show-word-limit
                        resize="vertical"
                        placeholder="可记录排查结论、交接信息、风险判断或内部提醒。"
                      />
                      <p v-if="selectedConversation.internalRemark?.updatedAt" class="mt-2 text-xs text-slate-400">
                        最近更新：{{ selectedConversation.internalRemark.updatedByDisplayName || selectedConversation.internalRemark.updatedByUsername || '未知客服' }}
                        · {{ formatDateTime(selectedConversation.internalRemark.updatedAt) }}
                      </p>
                    </el-card>
                  </div>
                </el-card>
              </div>

              <el-card class="cs-sub-card xl:min-h-0" shadow="never">
                <div class="flex items-center justify-between gap-3">
                  <div>
                    <p class="text-base font-semibold text-slate-900">Issue 字段</p>
                    <p class="mt-1 text-xs text-slate-400">聚焦结构化排查字段，去掉与顶部状态和优先级重复的内容。</p>
                  </div>
                  <el-tag type="info" effect="plain" round>
                    {{ getCategoryLabel(issueForm.category) }}
                  </el-tag>
                </div>

                <el-scrollbar class="mt-4 xl:min-h-0">
                  <el-form label-position="top" class="cs-issue-form pr-1">
                    <el-form-item label="标题">
                      <el-input v-model="issueForm.title" maxlength="80" show-word-limit />
                    </el-form-item>

                    <div class="grid gap-3 sm:grid-cols-2">
                      <el-form-item label="问题类型" class="!mb-0">
                        <el-select v-model="issueForm.issueType" class="w-full">
                          <el-option
                            v-for="item in FEEDBACK_ISSUE_TYPE_OPTIONS"
                            :key="item.value"
                            :label="item.label"
                            :value="item.value"
                          />
                        </el-select>
                      </el-form-item>
                      <el-form-item label="问题分类" class="!mb-0">
                        <el-select v-model="issueForm.category" class="w-full">
                          <el-option
                            v-for="item in FEEDBACK_CATEGORY_OPTIONS"
                            :key="item.value"
                            :label="item.label"
                            :value="item.value"
                          />
                        </el-select>
                      </el-form-item>
                    </div>

                    <el-form-item label="关联订单号">
                      <el-input v-model="issueForm.orderRef" maxlength="64" placeholder="如问题关联订单，可补充订单号或提货码" />
                    </el-form-item>

                    <el-form-item label="期望结果">
                      <el-input v-model="issueForm.expectedResult" type="textarea" :rows="4" maxlength="240" show-word-limit resize="vertical" />
                    </el-form-item>

                    <el-form-item label="实际结果">
                      <el-input v-model="issueForm.actualResult" type="textarea" :rows="4" maxlength="240" show-word-limit resize="vertical" />
                    </el-form-item>

                    <el-form-item label="复现步骤">
                      <el-input v-model="issueForm.reproductionSteps" type="textarea" :rows="4" maxlength="300" show-word-limit resize="vertical" />
                    </el-form-item>

                    <el-form-item label="联系偏好">
                      <el-input v-model="issueForm.contactPreference" maxlength="64" />
                    </el-form-item>

                    <el-form-item label="标签">
                      <el-input v-model="issueForm.tagText" maxlength="120" show-word-limit placeholder="使用中文逗号分隔多个标签" />
                    </el-form-item>
                  </el-form>
                </el-scrollbar>

                <el-button type="primary" class="mt-4 w-full" :loading="saving && quickStatusUpdating === '' && priorityUpdating === ''" :disabled="saving" @click="handleSaveIssue">
                  保存 Issue 字段
                </el-button>
              </el-card>
            </div>
          </el-card>

          <el-card v-else key="empty-detail" class="cs-panel-card" shadow="never">
            <el-empty
              description="当客户端提交反馈后，这里会自动展示统一会话与 Issue 字段明细。"
              :image-size="108"
            >
              <template #description>
                <div class="space-y-2">
                  <p class="text-lg font-semibold text-slate-900">暂无可查看的反馈会话</p>
                  <p class="text-sm leading-6 text-slate-500">当客户端提交反馈后，这里会自动展示统一会话与 Issue 字段明细。</p>
                </div>
              </template>
            </el-empty>
          </el-card>
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
}

.cs-panel-card,
.cs-sub-card,
.cs-inner-action-card,
.cs-summary-card,
.cs-conversation-item,
.cs-message-card {
  border: 1px solid rgba(226, 232, 240, 0.9);
  border-radius: 24px;
  box-shadow: 0 18px 48px -40px rgba(15, 23, 42, 0.24);
}

.cs-panel-card :deep(.el-card__body) {
  padding: 1rem;
}

.cs-sub-card {
  background: rgba(248, 250, 252, 0.75);
}

.cs-sub-card :deep(.el-card__body),
.cs-inner-action-card :deep(.el-card__body),
.cs-summary-card :deep(.el-card__body),
.cs-message-card :deep(.el-card__body) {
  padding: 1rem;
}

.cs-inner-action-card {
  background: rgba(248, 250, 252, 0.7);
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
  cursor: pointer;
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
  border-color: rgba(13, 148, 136, 0.32);
  background: rgba(20, 184, 166, 0.05);
  box-shadow: 0 18px 34px -28px rgba(13, 148, 136, 0.28);
  transform: translateY(-1px);
}

.cs-list-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
}

.cs-list-heading__desc {
  margin-top: 0.35rem;
  max-width: 16rem;
  color: rgb(100 116 139);
  font-size: 0.82rem;
  line-height: 1.45;
}

.cs-list-count {
  flex-shrink: 0;
  min-height: 1.9rem;
  padding-inline: 0.72rem;
  font-size: 0.76rem;
  font-weight: 600;
  white-space: nowrap;
}

/*
 * Element Plus 表单与卡片细节：
 * - 输入框、下拉和文本域统一提高圆角，和管理端当前设计语言保持一致；
 * - 仅调整本页局部外观，不覆盖全局主题。
 */
.cs-filter-form :deep(.el-form-item__label),
.cs-issue-form :deep(.el-form-item__label) {
  color: rgb(100 116 139);
  font-size: 0.78rem;
  font-weight: 600;
}

.cs-filter-form :deep(.el-input__wrapper),
.cs-filter-form :deep(.el-textarea__inner),
.cs-filter-form :deep(.el-select__wrapper),
.cs-issue-form :deep(.el-input__wrapper),
.cs-issue-form :deep(.el-textarea__inner),
.cs-issue-form :deep(.el-select__wrapper) {
  border-radius: 16px;
  box-shadow: 0 0 0 1px rgb(226 232 240) inset;
}

.cs-filter-form :deep(.el-input__wrapper.is-focus),
.cs-filter-form :deep(.el-select__wrapper.is-focused),
.cs-issue-form :deep(.el-input__wrapper.is-focus),
.cs-issue-form :deep(.el-select__wrapper.is-focused) {
  box-shadow:
    0 0 0 1px rgba(13, 148, 136, 0.45) inset,
    0 0 0 4px rgba(13, 148, 136, 0.1);
}

.cs-filter-form :deep(.el-textarea__inner:focus),
.cs-issue-form :deep(.el-textarea__inner:focus) {
  box-shadow:
    0 0 0 1px rgba(13, 148, 136, 0.45) inset,
    0 0 0 4px rgba(13, 148, 136, 0.1);
}

.cs-filter-form :deep(.el-button),
.cs-inner-action-card :deep(.el-button),
.cs-sub-card :deep(.el-button) {
  border-radius: 16px;
}

.cs-message-card {
  transition:
    transform 0.22s ease,
    box-shadow 0.22s ease,
    background-color 0.22s ease;
}

.cs-message-card.is-staff {
  margin-left: auto;
  background: rgba(20, 184, 166, 0.08);
}

.cs-message-card.is-client {
  background: rgba(255, 255, 255, 0.92);
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

@media (max-width: 767px) {
  .cs-list-heading__desc {
    max-width: 13.5rem;
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
