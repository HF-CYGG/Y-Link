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
  compareSupportFeedbackConversationPriority,
  DEFAULT_SUPPORT_QUICK_REPLY_TEMPLATES,
  FEEDBACK_CATEGORY_OPTIONS,
  FEEDBACK_ISSUE_TYPE_OPTIONS,
  FEEDBACK_PRIORITY_META_MAP,
  FEEDBACK_PRIORITY_OPTIONS,
  FEEDBACK_STATUS_META_MAP,
  FEEDBACK_STATUS_OPTIONS,
  appendStaffFeedbackMessage,
  getCustomerServicePresence,
  getSupportFeedbackConversation,
  listSupportAssignableUsers,
  listSupportFeedbackConversations,
  resolveClientFeedbackConversationGroupKey,
  openFeedbackRealtimeStream,
  resolveSupportFeedbackConversationSla,
  SUPPORT_QUICK_REPLY_SOURCE_META,
  summarizeSupportFeedbackConversations,
  updateFeedbackInternalRemark,
  updateFeedbackIssue,
  updateSupportConversationAssignee,
  type FeedbackConversationRecord,
  type FeedbackConversationMessage,
  type FeedbackIssueCategory,
  type FeedbackIssuePriority,
  type FeedbackIssueStatus,
  type FeedbackIssueType,
  type FeedbackRealtimeConnection,
  type FeedbackRealtimeConversationEvent,
  type FeedbackServicePresence,
  type SupportAssignableUser,
} from '@/api/modules/customer-service-feedback'
import { PageContainer } from '@/components/common'
import { useAuthStore } from '@/store'
import { extractErrorMessage } from '@/utils/error'
import { formatDateTime } from '@/utils/date-time'
import { normalizeSubmitText } from '@/utils/submit-feedback'

const authStore = useAuthStore()

type WorkbenchQuickViewKey = 'all' | 'pending' | 'processing' | 'urgent' | 'unassigned' | 'sla_risk' | 'waiting_staff_reply'
type DetailTabKey = 'conversation' | 'issue' | 'internal'

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
const assigneeLoading = ref(false)
const assigneeUpdating = ref(false)
const quickStatusUpdating = ref<FeedbackIssueStatus | ''>('')
const priorityUpdating = ref<FeedbackIssuePriority | ''>('')
const activeQuickView = ref<WorkbenchQuickViewKey>('all')
const activeDetailTab = ref<DetailTabKey>('conversation')
const selectedQuickReplyKey = ref('')
const transferAssigneeUserId = ref('')
const assigneeOptions = ref<SupportAssignableUser[]>([])
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

/**
 * 顶部分类卡片统一作为工作台主筛选入口：
 * - 所有分类都基于当前搜索与筛选结果再次聚焦，保证上方数字与左侧列表口径一致；
 * - 默认进入“全部反馈”，让客服首次进入页面时先看到完整队列。
 */
const getQuickViewFilteredConversations = (records: FeedbackConversationRecord[] = conversations.value) => {
  const nextRecords = records.filter((conversation) => {
    if (activeQuickView.value === 'all') {
      return true
    }
    if (activeQuickView.value === 'pending') {
      return conversation.status === 'pending'
    }
    if (activeQuickView.value === 'processing') {
      return conversation.status === 'processing'
    }
    if (activeQuickView.value === 'urgent') {
      return conversation.priority === 'urgent'
    }
    if (activeQuickView.value === 'unassigned') {
      return !conversation.assigneeUserId
    }
    if (activeQuickView.value === 'sla_risk') {
      const slaMeta = resolveSupportFeedbackConversationSla(conversation)
      return slaMeta.level === 'warning' || slaMeta.level === 'overtime'
    }
    return resolveClientFeedbackConversationGroupKey(conversation) === 'waiting_staff'
  })
  return nextRecords.sort(compareSupportFeedbackConversationPriority)
}

/**
 * SLA 标签映射：
 * - 超时使用红色，提醒马上处理；
 * - 即将超时使用橙色，帮助客服提前介入；
 * - 已暂停或正常保持中性，避免高频误报造成视觉疲劳。
 */
const getSlaTagType = (conversation: FeedbackConversationRecord) => {
  const slaMeta = resolveSupportFeedbackConversationSla(conversation)
  if (slaMeta.level === 'overtime') {
    return 'danger'
  }
  if (slaMeta.level === 'warning') {
    return 'warning'
  }
  if (slaMeta.level === 'paused') {
    return 'info'
  }
  return 'success'
}

const getSlaPanelClass = (conversation: FeedbackConversationRecord) => {
  const slaMeta = resolveSupportFeedbackConversationSla(conversation)
  if (slaMeta.level === 'overtime') {
    return 'border-rose-200 bg-rose-50/90'
  }
  if (slaMeta.level === 'warning') {
    return 'border-amber-200 bg-amber-50/90'
  }
  return 'border-slate-200 bg-slate-50/80'
}

const getAssigneeTagType = (conversation: FeedbackConversationRecord) => {
  if (!conversation.assigneeUserId) {
    return 'warning'
  }
  if (currentUserId.value && conversation.assigneeUserId === currentUserId.value) {
    return 'success'
  }
  return 'info'
}

const getAssigneeTagLabel = (conversation: FeedbackConversationRecord) => {
  if (!conversation.assigneeName) {
    return '待分配'
  }
  return currentUserId.value && conversation.assigneeUserId === currentUserId.value
    ? `我负责`
    : conversation.assigneeName
}

const summaryCategoryDefinitions = computed(() => {
  return [
    {
      key: 'all' as const,
      label: '全部反馈',
      description: '查看当前筛选条件下的全部反馈单，适合作为默认处理入口。',
      count: conversations.value.length,
      valueClass: 'text-slate-900',
    },
    {
      key: 'pending' as const,
      label: '待受理',
      description: '尚未由客服正式接入的反馈单，优先用于首轮响应。',
      count: summary.value.pending,
      valueClass: 'text-amber-600',
    },
    {
      key: 'processing' as const,
      label: '处理中',
      description: '已经进入处理阶段的反馈单，便于连续跟进。',
      count: summary.value.processing,
      valueClass: 'text-sky-600',
    },
    {
      key: 'urgent' as const,
      label: '紧急反馈',
      description: '优先级为紧急的反馈单，用于快速聚焦高影响问题。',
      count: summary.value.urgent,
      valueClass: 'text-rose-600',
    },
    {
      key: 'unassigned' as const,
      label: '待分配',
      description: '当前尚未明确负责人的反馈单，适合快速接单分流。',
      count: summary.value.unassigned,
      valueClass: 'text-slate-700',
    },
    {
      key: 'sla_risk' as const,
      label: 'SLA 风险',
      description: '即将超时或已经超时的反馈单，优先用于抢救处理时效。',
      count: summary.value.slaRisk,
      valueClass: 'text-rose-600',
    },
    {
      key: 'waiting_staff_reply' as const,
      label: '待客服跟进',
      description: '当前更需要客服继续回复或处理的反馈单，适合作为排队主视图。',
      count: summary.value.waitingStaffReply,
      valueClass: 'text-brand',
    },
  ]
})

const filteredConversations = computed(() => getQuickViewFilteredConversations())
const currentUserId = computed(() => authStore.currentUser?.id ?? '')

/**
 * 显式接单模型下的负责人判断：
 * - 当前负责人是自己时，允许继续回复、改状态；
 * - 未接单或由他人负责时，需要先通过接单/转派动作切换归属。
 */
const isSelectedConversationOwnedByCurrentUser = computed(() => {
  if (!selectedConversation.value || !currentUserId.value) {
    return false
  }
  return selectedConversation.value.assigneeUserId === currentUserId.value
})

const selectedConversationSla = computed(() => {
  return selectedConversation.value ? resolveSupportFeedbackConversationSla(selectedConversation.value) : null
})

const takeOverButtonText = computed(() => {
  if (!selectedConversation.value) {
    return '立即接单'
  }
  if (!selectedConversation.value.assigneeUserId) {
    return '立即接单'
  }
  if (isSelectedConversationOwnedByCurrentUser.value) {
    return '当前由我负责'
  }
  return '转派给我'
})

const assignmentActionTip = computed(() => {
  if (!selectedConversation.value) {
    return '请选择一条会话后再处理负责人。'
  }
  if (!selectedConversation.value.assigneeUserId) {
    return '当前会话尚未接单，请先点击“立即接单”后再回复或变更状态。'
  }
  if (!isSelectedConversationOwnedByCurrentUser.value) {
    return `当前会话由 ${selectedConversation.value.assigneeName || '其他客服'} 负责，如需继续处理，请先转派给自己或指定其他客服。`
  }
  return '当前会话已由你负责，可继续回复、改状态或转派给其他客服。'
})

const transferAssigneeOptions = computed(() => {
  if (!selectedConversation.value) {
    return assigneeOptions.value
  }
  return assigneeOptions.value.filter((item) => item.id !== selectedConversation.value?.assigneeUserId)
})

const activeQuickViewDefinition = computed(() => {
  return summaryCategoryDefinitions.value.find((item) => item.key === activeQuickView.value) ?? summaryCategoryDefinitions.value[0]
})

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

const quickReplyTemplates = computed(() => {
  const recommendedTemplates = DEFAULT_SUPPORT_QUICK_REPLY_TEMPLATES.filter((item) => {
    return !item.suggestedStatuses || item.suggestedStatuses.includes(issueForm.status)
  })
  const fallbackTemplates = DEFAULT_SUPPORT_QUICK_REPLY_TEMPLATES.filter((item) => {
    return item.suggestedStatuses && !item.suggestedStatuses.includes(issueForm.status)
  })
  return [...recommendedTemplates, ...fallbackTemplates]
})

const selectedQuickReplyTemplate = computed(() => {
  return quickReplyTemplates.value.find((item) => item.key === selectedQuickReplyKey.value) ?? null
})

const getQuickReplySuggestedStatusText = (statuses?: FeedbackIssueStatus[]) => {
  if (!statuses?.length) {
    return '适用于通用沟通场景'
  }
  return `推荐状态：${statuses.map((status) => FEEDBACK_STATUS_META_MAP[status].label).join(' / ')}`
}

/**
 * 会话消息角色显示：
 * - 客服与客户端维持清晰角色标签；
 * - 系统消息单独标记为“系统通知”，避免与人工客服回复混淆。
 */
const getMessageRoleLabel = (senderRole: FeedbackConversationMessage['senderRole']) => {
  if (senderRole === 'staff') {
    return '客服'
  }
  if (senderRole === 'client') {
    return '客户端'
  }
  return '系统通知'
}

/**
 * 会话消息标题：
 * - 系统消息不强调发送者姓名，而是固定展示“系统通知”；
 * - 人工消息继续展示真实发送者姓名，方便客服辨认上下文参与方。
 */
const getMessageTitle = (message: FeedbackConversationMessage) => {
  if (message.senderRole === 'system') {
    return '系统通知'
  }
  return message.senderName
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

/**
 * 快捷视图切换后，详情区只保留当前视图可见的会话：
 * - 若当前选中项仍在视图内，只保留原详情；
 * - 若已被筛掉，则自动切到该视图下第一条，保证“左侧列表”和“右侧详情”始终一致。
 */
const syncVisibleConversationSelection = async (options: { forceReloadDetail?: boolean } = {}) => {
  const visibleConversations = getQuickViewFilteredConversations()
  if (!visibleConversations.length) {
    selectedConversationId.value = ''
    selectedConversation.value = null
    replyDraft.value = ''
    selectedQuickReplyKey.value = ''
    syncIssueForm(null)
    return
  }

  const hasCurrentSelection = visibleConversations.some((item) => item.id === selectedConversationId.value)
  const nextConversationId = hasCurrentSelection ? selectedConversationId.value : visibleConversations[0].id
  const shouldLoadDetail = options.forceReloadDetail
    || !selectedConversation.value
    || selectedConversation.value.id !== nextConversationId

  selectedConversationId.value = nextConversationId
  if (shouldLoadDetail) {
    await loadConversationDetail(nextConversationId)
  }
}

const loadConversationDetail = async (conversationId: string) => {
  if (!conversationId) {
    selectedConversation.value = null
    replyDraft.value = ''
    selectedQuickReplyKey.value = ''
    isPriorityPanelExpanded.value = false
    return
  }

  const previousConversationId = selectedConversation.value?.id ?? ''
  detailLoading.value = true
  try {
    selectedConversation.value = await getSupportFeedbackConversation(conversationId)
    isPriorityPanelExpanded.value = false
    if (previousConversationId !== conversationId) {
      replyDraft.value = ''
      selectedQuickReplyKey.value = ''
      transferAssigneeUserId.value = ''
    }
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
    await syncVisibleConversationSelection({
      forceReloadDetail: shouldRefreshSelectedDetail,
    })
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
    assigneeUserId: summaryRecord.assigneeUserId,
    assigneeUsername: summaryRecord.assigneeUsername,
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

const handleChangeQuickView = async (quickViewKey: WorkbenchQuickViewKey) => {
  if (activeQuickView.value === quickViewKey) {
    return
  }
  activeQuickView.value = quickViewKey
  await syncVisibleConversationSelection()
}

const handleTakeOver = async () => {
  if (!selectedConversation.value) {
    ElMessage.warning('请先选择一条会话')
    return
  }
  if (!currentUserId.value) {
    ElMessage.warning('当前登录信息已失效，请重新进入工作台')
    return
  }
  if (selectedConversation.value.assigneeUserId === currentUserId.value) {
    ElMessage.info('当前会话已经由你负责')
    return
  }

  assigneeUpdating.value = true
  try {
    await updateSupportConversationAssignee(selectedConversation.value.id, currentUserId.value)
    await loadConversations({
      refreshSelectedDetail: true,
    })
    reconnectTip.value = '已完成显式接单，当前会话后续消息会继续实时同步。'
    ElMessage.success('当前会话已接单')
  } catch (error) {
    ElMessage.error(extractErrorMessage(error, '接单失败，请稍后重试'))
  } finally {
    assigneeUpdating.value = false
  }
}

const handleTransferConversation = async () => {
  if (!selectedConversation.value) {
    ElMessage.warning('请先选择一条会话')
    return
  }
  if (!transferAssigneeUserId.value) {
    ElMessage.warning('请先选择转派目标')
    return
  }

  assigneeUpdating.value = true
  try {
    await updateSupportConversationAssignee(selectedConversation.value.id, transferAssigneeUserId.value)
    transferAssigneeUserId.value = ''
    await loadConversations({
      refreshSelectedDetail: true,
    })
    reconnectTip.value = '负责人已更新，工作台已同步最新归属信息。'
    ElMessage.success('负责人已更新')
  } catch (error) {
    ElMessage.error(extractErrorMessage(error, '转派失败，请稍后重试'))
  } finally {
    assigneeUpdating.value = false
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

const handleApplyQuickReply = () => {
  if (!selectedConversation.value) {
    ElMessage.warning('请先选择一条会话')
    return
  }
  if (!selectedQuickReplyTemplate.value) {
    ElMessage.warning('请先选择一条快捷回复')
    return
  }

  const nextDraft = replyDraft.value.trim()
    ? `${replyDraft.value.trimEnd()}\n\n${selectedQuickReplyTemplate.value.content}`
    : selectedQuickReplyTemplate.value.content
  replyDraft.value = nextDraft
  ElMessage.success('已插入快捷回复，可继续编辑后发送')
}

const loadPresence = async () => {
  presence.value = await getCustomerServicePresence()
  realtimeState.value = presence.value.availability.isOnline ? 'online' : 'offline'
}

/**
 * 转派候选人列表单独加载：
 * - 页面只在工作台内获取一次，避免每次切换会话都重复请求；
 * - 若后端调整可接单范围，前端只消费统一结果，不自行推断角色。
 */
const loadAssignableUsers = async () => {
  assigneeLoading.value = true
  try {
    assigneeOptions.value = await listSupportAssignableUsers()
  } finally {
    assigneeLoading.value = false
  }
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
    await loadAssignableUsers()
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

          <div class="grid gap-2 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-7 2xl:min-w-0 2xl:flex-1">
            <el-card
              v-for="item in summaryCategoryDefinitions"
              :key="item.key"
              class="cs-summary-card cs-summary-card--compact"
              shadow="never"
              :class="item.key === activeQuickView ? 'is-active' : ''"
              @click="handleChangeQuickView(item.key)"
            >
              <p class="cs-summary-card__label">{{ item.label }}</p>
              <p class="cs-summary-card__value" :class="item.valueClass">{{ item.count }}</p>
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
              <p class="cs-list-heading__desc">
                {{ activeQuickViewDefinition.description }}
              </p>
            </div>
            <el-tag type="info" effect="plain" round class="cs-list-count">
              当前：{{ activeQuickViewDefinition.label }} · {{ filteredConversations.length }} 条
            </el-tag>
          </div>

          <div v-if="loading" class="mt-4">
            <el-skeleton :rows="6" animated />
          </div>

          <div v-else-if="!filteredConversations.length" class="mt-4 rounded-[18px] bg-slate-50/70">
            <el-empty :description="`${activeQuickViewDefinition.label}视图下暂无反馈会话，可切换视图或调整筛选条件后重试。`" :image-size="88" />
          </div>

          <TransitionGroup
            v-else
            name="cs-conversation-list"
            tag="div"
            class="mt-4 space-y-3 xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:pr-1"
          >
            <el-card
              v-for="item in filteredConversations"
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
                <el-tag :type="getSlaTagType(item)" effect="light" round>
                  {{ resolveSupportFeedbackConversationSla(item).label }}
                </el-tag>
                <el-tag :type="getAssigneeTagType(item)" effect="plain" round>
                  {{ getAssigneeTagLabel(item) }}
                </el-tag>
                <el-tag v-if="item.unreadForStaff > 0" type="danger" effect="light" round>
                  待回复 {{ item.unreadForStaff }}
                </el-tag>
              </div>
              <p class="mt-3 text-xs leading-5 text-slate-500">
                {{ resolveSupportFeedbackConversationSla(item).stageLabel }} · {{ resolveSupportFeedbackConversationSla(item).countdownText }}
              </p>
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
                <el-tag :type="getSlaTagType(selectedConversation)" effect="light" round>
                  {{ selectedConversationSla?.label }}
                </el-tag>
              </div>
            </div>

            <div class="mt-4 rounded-[20px] border px-4 py-3" :class="getSlaPanelClass(selectedConversation)">
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div class="space-y-2">
                  <div class="flex flex-wrap items-center gap-2">
                    <el-tag :type="getSlaTagType(selectedConversation)" effect="light" round>
                      {{ selectedConversationSla?.label }}
                    </el-tag>
                    <span class="text-sm font-semibold text-slate-900">{{ selectedConversationSla?.stageLabel }}</span>
                    <span class="text-xs text-slate-500">{{ selectedConversationSla?.countdownText }}</span>
                  </div>
                  <p class="text-sm leading-6 text-slate-600">
                    {{ selectedConversationSla?.description }}
                  </p>
                  <div class="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span>当前负责人：{{ selectedConversation.assigneeName || '待分配' }}</span>
                    <span v-if="selectedConversationSla?.deadlineAt">目标截止：{{ formatDateTime(selectedConversationSla.deadlineAt) }}</span>
                    <span>最近消息：{{ formatDateTime(selectedConversation.lastMessageAt) }}</span>
                  </div>
                </div>
                <div class="min-w-[260px] max-w-full space-y-3">
                  <div class="flex flex-wrap items-center gap-2">
                    <el-button
                      type="primary"
                      plain
                      :loading="assigneeUpdating"
                      :disabled="assigneeUpdating || !selectedConversation || isSelectedConversationOwnedByCurrentUser"
                      @click="handleTakeOver"
                    >
                      {{ takeOverButtonText }}
                    </el-button>
                    <el-button
                      v-for="item in FEEDBACK_STATUS_OPTIONS.filter((option) => ['pending', 'processing', 'resolved'].includes(option.value))"
                      :key="item.value"
                      :type="getQuickStatusButtonType(item.value)"
                      :plain="issueForm.status !== item.value"
                      :loading="quickStatusUpdating === item.value"
                      :disabled="saving || !isSelectedConversationOwnedByCurrentUser"
                      @click="handleQuickStatus(item.value)"
                    >
                      {{ item.label }}
                    </el-button>
                    <el-button link type="danger" :disabled="saving || !isSelectedConversationOwnedByCurrentUser" @click="handleQuickStatus('closed')">
                      关闭会话
                    </el-button>
                  </div>

                  <div class="flex flex-wrap items-center gap-2">
                    <el-select
                      v-model="transferAssigneeUserId"
                      class="min-w-[180px] flex-1"
                      clearable
                      filterable
                      :loading="assigneeLoading"
                      placeholder="选择转派目标"
                    >
                      <el-option
                        v-for="item in transferAssigneeOptions"
                        :key="item.id"
                        :label="`${item.displayName}（${item.username}）`"
                        :value="item.id"
                      />
                    </el-select>
                    <el-button :loading="assigneeUpdating" :disabled="assigneeUpdating || !transferAssigneeUserId" @click="handleTransferConversation">
                      确认转派
                    </el-button>
                  </div>
                  <p class="text-xs leading-5 text-slate-500">
                    {{ assignmentActionTip }}
                  </p>
                </div>
              </div>
            </div>

            <div class="mt-4 rounded-[20px] border border-slate-200 bg-slate-50/80 px-4 py-3">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div class="flex flex-wrap items-center gap-2">
                  <el-tag :type="getAssigneeTagType(selectedConversation)" effect="plain" round>
                    {{ getAssigneeTagLabel(selectedConversation) }}
                  </el-tag>
                  <el-tag v-if="selectedConversation.unreadForStaff > 0" type="danger" effect="light" round>
                    待回复 {{ selectedConversation.unreadForStaff }}
                  </el-tag>
                  <el-tag v-if="selectedConversation.unreadForClient > 0" type="warning" effect="light" round>
                    客户未读 {{ selectedConversation.unreadForClient }}
                  </el-tag>
                </div>
                <div class="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <span>最近更新时间：{{ formatDateTime(selectedConversation.updatedAt) }}</span>
                  <span>会话编号：{{ selectedConversation.issueNo }}</span>
                </div>
              </div>
            </div>

            <el-tabs v-model="activeDetailTab" class="cs-detail-tabs mt-5 xl:min-h-0 xl:flex-1" stretch>
              <el-tab-pane label="会话记录" name="conversation" class="cs-detail-tab-pane">
                <div class="flex min-h-0 flex-col gap-4">
                  <el-card class="cs-sub-card cs-conversation-detail-card xl:flex xl:min-h-0 xl:flex-col" shadow="never">
                    <div class="flex items-center justify-between gap-3">
                      <div>
                        <p class="text-base font-semibold text-slate-900">会话记录</p>
                        <p class="mt-1 text-xs text-slate-400">围绕当前 Issue 的完整消息记录，客服回复后客户端会看到同一条会话更新。</p>
                      </div>
                      <span class="text-xs text-slate-400">{{ selectedConversation.messages.length }} 条消息</span>
                    </div>

                    <el-scrollbar class="cs-conversation-detail-scrollbar mt-4 xl:min-h-0 xl:flex-1">
                      <TransitionGroup name="cs-message-stack" tag="div" class="space-y-3 pr-1">
                        <el-card
                          v-for="message in selectedConversation.messages"
                          :key="message.id"
                          class="cs-message-card"
                          shadow="never"
                          :class="
                            message.senderRole === 'staff'
                              ? 'is-staff'
                              : message.senderRole === 'system'
                                ? 'is-system'
                                : 'is-client'
                          "
                        >
                          <div class="flex flex-wrap items-center justify-between gap-2">
                            <p
                              class="font-semibold"
                              :class="message.senderRole === 'system' ? 'text-xs text-slate-500' : 'text-sm text-slate-900'"
                            >
                              {{ getMessageTitle(message) }}
                              <span
                                class="ml-2 rounded-full px-2 py-0.5 text-[0.68rem] font-medium"
                                :class="message.senderRole === 'system' ? 'bg-slate-200/80 text-slate-500' : 'bg-slate-100 text-slate-500'"
                              >
                                {{ getMessageRoleLabel(message.senderRole) }}
                              </span>
                            </p>
                            <span class="text-xs text-slate-400">{{ formatDateTime(message.createdAt) }}</span>
                          </div>
                          <p
                            class="mt-2 whitespace-pre-wrap leading-6"
                            :class="message.senderRole === 'system' ? 'text-xs text-slate-500' : 'text-sm text-slate-700'"
                          >
                            {{ message.body }}
                          </p>
                        </el-card>
                      </TransitionGroup>
                    </el-scrollbar>
                  </el-card>

                  <el-card class="cs-sub-card" shadow="never">
                    <div class="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p class="text-base font-semibold text-slate-900">客服回复</p>
                        <p class="mt-1 text-xs text-slate-400">回复区已接入快捷回复，插入后仍可继续编辑；显式接单后才允许继续发送。</p>
                      </div>
                      <el-button type="primary" :loading="replying" :disabled="replying || !isSelectedConversationOwnedByCurrentUser" @click="handleReply">
                        发送回复
                      </el-button>
                    </div>
                    <p class="mt-3 text-xs leading-5 text-slate-500">
                      {{ assignmentActionTip }}
                    </p>

                    <div class="mt-4 grid gap-3 xl:grid-cols-[minmax(0,280px)_auto]">
                      <el-select
                        v-model="selectedQuickReplyKey"
                        clearable
                        filterable
                        placeholder="选择快捷回复模板"
                      >
                        <el-option
                          v-for="item in quickReplyTemplates"
                          :key="item.key"
                          :label="item.label"
                          :value="item.key"
                        >
                          <div class="flex items-center justify-between gap-3">
                            <span class="truncate">{{ item.label }}</span>
                            <span class="text-xs text-slate-400">{{ getQuickReplySuggestedStatusText(item.suggestedStatuses) }}</span>
                          </div>
                        </el-option>
                      </el-select>
                      <el-button plain :disabled="!selectedQuickReplyKey" @click="handleApplyQuickReply">
                        插入快捷回复
                      </el-button>
                    </div>

                    <div v-if="selectedQuickReplyTemplate" class="mt-3 rounded-[18px] border border-slate-200 bg-slate-50 px-4 py-3">
                      <div class="flex flex-wrap items-center justify-between gap-2">
                        <p class="text-sm font-semibold text-slate-900">{{ selectedQuickReplyTemplate.label }}</p>
                        <el-tag type="info" effect="plain" round>
                          {{ getQuickReplySuggestedStatusText(selectedQuickReplyTemplate.suggestedStatuses) }}
                        </el-tag>
                      </div>
                      <p class="mt-2 text-xs leading-5 text-slate-500">{{ selectedQuickReplyTemplate.description }}</p>
                      <p class="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">{{ selectedQuickReplyTemplate.content }}</p>
                    </div>

                    <p class="mt-3 text-xs text-slate-400">
                      模板来源：{{ SUPPORT_QUICK_REPLY_SOURCE_META.sourceLabel }}，当前仅作为草稿插入能力，不会限制你继续补充说明。
                    </p>

                    <el-input
                      v-model="replyDraft"
                      class="mt-4"
                      type="textarea"
                      :rows="6"
                      maxlength="500"
                      show-word-limit
                      resize="vertical"
                      placeholder="请输入给客户端的回复内容，例如处理结论、补充说明或下一步动作。"
                    />
                  </el-card>
                </div>
              </el-tab-pane>

              <el-tab-pane label="工单信息" name="issue" class="cs-detail-tab-pane">
                <el-card class="cs-sub-card xl:min-h-0" shadow="never">
                  <div class="flex items-center justify-between gap-3">
                    <div>
                      <p class="text-base font-semibold text-slate-900">工单信息</p>
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
              </el-tab-pane>

              <el-tab-pane label="内部协同" name="internal" class="cs-detail-tab-pane">
                <div class="grid gap-4 2xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
                  <el-card class="cs-sub-card" shadow="never">
                    <div class="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p class="text-base font-semibold text-slate-900">优先级与协同状态</p>
                        <p class="mt-1 text-xs text-slate-400">集中处理负责人、优先级和跟进协同信息，避免和工单字段混在一起。</p>
                      </div>
                      <el-button plain :disabled="saving" @click="handleTogglePriorityPanel">
                        {{ isPriorityPanelExpanded ? '收起优先级' : '重分配优先级' }}
                      </el-button>
                    </div>

                    <div class="mt-4 rounded-[18px] border border-slate-200 bg-slate-50 px-4 py-3">
                      <div class="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <p class="text-sm font-semibold text-slate-900">当前协同信息</p>
                          <p class="mt-1 text-xs text-slate-400">这里用于快速确认当前负责人、SLA 风险与最新会话更新时间。</p>
                        </div>
                        <el-tag :type="getAssigneeTagType(selectedConversation)" effect="plain" round>
                          当前负责人：{{ getAssigneeTagLabel(selectedConversation) }}
                        </el-tag>
                      </div>
                      <div class="mt-3 flex flex-wrap gap-2 text-xs text-slate-500">
                        <span>SLA 状态：{{ selectedConversationSla?.label }} · {{ selectedConversationSla?.countdownText }}</span>
                        <span>最近更新时间：{{ formatDateTime(selectedConversation.updatedAt) }}</span>
                        <span>客户未读：{{ selectedConversation.unreadForClient }}</span>
                        <span>客服待处理：{{ selectedConversation.unreadForStaff }}</span>
                      </div>
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
                  </el-card>

                  <el-card class="cs-sub-card" shadow="never">
                    <div class="flex items-center justify-between gap-3">
                      <div>
                        <p class="text-base font-semibold text-slate-900">内部备注</p>
                        <p class="mt-1 text-xs text-slate-400">仅客服内部可见，适合记录排查结论、交接信息与风险判断。</p>
                      </div>
                      <el-button :loading="remarkSaving" :disabled="remarkSaving" @click="handleSaveInternalRemark">
                        保存备注
                      </el-button>
                    </div>
                    <el-input
                      v-model="issueForm.internalRemark"
                      class="mt-4"
                      type="textarea"
                      :rows="9"
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
              </el-tab-pane>
            </el-tabs>
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
  cursor: pointer;
  border: 1px solid rgba(226, 232, 240, 0.9);
  border-radius: 24px;
  background: rgba(255, 255, 255, 0.95);
  transition:
    border-color 0.2s ease,
    background-color 0.2s ease,
    box-shadow 0.2s ease,
    transform 0.2s ease;
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

.cs-conversation-detail-card {
  overflow: hidden;
}

.cs-conversation-detail-scrollbar {
  min-height: 0;
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

.cs-summary-card:hover {
  transform: translateY(-1px);
  box-shadow: 0 14px 28px -24px rgba(15, 23, 42, 0.2);
}

.cs-summary-card.is-active {
  border-color: rgba(13, 148, 136, 0.36);
  background: rgba(20, 184, 166, 0.06);
  box-shadow: 0 18px 34px -28px rgba(13, 148, 136, 0.28);
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
 * 详情标签负责拆分“查看消息 / 管理字段 / 内部协同”：
 * - 通过标签头减少长页滚动；
 * - 内容区仍保留工作台卡片感，不让分区后出现割裂。
 */
.cs-detail-tabs {
  min-height: 0;
}

.cs-detail-tabs :deep(.el-tabs__header) {
  margin: 0 0 1rem;
}

.cs-detail-tabs :deep(.el-tabs__nav-wrap::after) {
  background-color: rgba(226, 232, 240, 0.9);
}

.cs-detail-tabs :deep(.el-tabs__item) {
  height: 2.75rem;
  color: rgb(100 116 139);
  font-weight: 600;
}

.cs-detail-tabs :deep(.el-tabs__item.is-active) {
  color: rgb(13 148 136);
}

.cs-detail-tabs :deep(.el-tabs__content) {
  min-height: 0;
}

.cs-detail-tab-pane {
  min-height: 0;
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

.cs-message-card.is-system {
  margin-inline: auto;
  max-width: 92%;
  border-style: dashed;
  border-color: rgba(203, 213, 225, 0.95);
  background: rgba(248, 250, 252, 0.86);
  box-shadow: none;
}

.cs-message-card.is-client {
  background: rgba(255, 255, 255, 0.92);
}

.cs-message-card.is-system:hover {
  transform: none;
  box-shadow: none;
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

@media (min-width: 1280px) {
  .cs-conversation-detail-card {
    max-height: min(36rem, calc(100dvh - 18rem));
  }

  .cs-conversation-detail-scrollbar {
    max-height: calc(min(36rem, calc(100dvh - 18rem)) - 5.5rem);
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
