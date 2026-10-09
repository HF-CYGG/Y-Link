<script setup lang="ts">
/**
 * 模块说明：src/views/system/CustomerServiceWorkbenchView.vue
 * 文件职责：提供管理端客服工作台，统一查看客户端反馈、维护结构化字段、记录内部备注并展示在线/续接状态。
 * 实现逻辑：
 * - 页面采用“队列栏 + 会话栏 + 属性栏”三栏工作台：左侧视图与筛选聚焦队列，中间只放消息流与底部回复框，
 *   右侧集中 SLA、负责人、状态、优先级、工单字段与内部备注，状态/负责人等信息全页只展示一处；
 * - 宽屏（≥1536px）三栏并排、各自独立滚动；较窄时退化为“队列 + 详情”或单列，详情内用两枚标签切换
 *   “会话 / 工单与协同”，属性栏模板只写一份，通过 v-show 在不同布局间复用；
 * - 页面通过真实后端接口与 SSE 订阅同步在线状态、续接提示和会话变化，保证客服视角与客户端视角一致。
 * 维护说明：
 * - 若后续继续扩展附件、快捷回复或 SLA 指标，优先在属性栏新增分段，不再拆分独立子页或新增顶部卡片；
 * - 自动刷新会快照草稿与三栏滚动位置，新增可编辑区域时需同步纳入快照与脏检查，避免刷新覆盖输入；
 * - 若客服在线规则改为更精细的排班模型，本页优先消费共享 API 已暴露的 presence 数据，不在页面层重复实现。
 */

import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, reactive, ref, watch } from 'vue'

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
  resolveFeedbackConversationStatusMeta,
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
import { PageContainer, PassiveSegmentedTabs } from '@/components/common'
import { useDevice } from '@/composables/useDevice'
import { useStableRequest } from '@/composables/useStableRequest'
import { useAuthStore } from '@/store'
import pinia from '@/store/pinia'
import { extractErrorMessage } from '@/utils/error'
import { showCriticalErrorDialog } from '@/utils/error-dialog'
import { formatDateTime } from '@/utils/date-time'
import { normalizeSubmitText } from '@/utils/submit-feedback'

import { showAppError, showAppInfo, showAppSuccess, showAppWarning } from '@/utils/app-alert'

/**
 * 显式注入全局 Pinia 单例：
 * - 客服工作台页面属于懒加载页面，首次进入时可能与路由预热、KeepAlive 恢复并发发生；
 * - 若依赖隐式 activePinia，极端时序下会出现 “getActivePinia() was called but there was no active Pinia”；
 * - 这里改为显式传入单例，避免页面首次进入偶发白屏。
 */
const authStore = useAuthStore(pinia)

type WorkbenchQuickViewKey = 'all' | 'pending' | 'processing' | 'urgent' | 'unassigned' | 'sla_risk' | 'waiting_staff_reply'
type DetailTabKey = 'conversation' | 'detail'
type WorkbenchLayoutMode = 'wide' | 'split' | 'stacked'
const detailTabs = [
  { label: '会话', name: 'conversation' },
  { label: '工单与协同', name: 'detail' },
] as const

/**
 * 三栏布局断点：
 * - 复用全局共享的窗口宽度响应源，不在页面内重复注册 resize 监听；
 * - wide 时属性栏常驻右侧，其余模式下属性栏收进“工单与协同”标签。
 */
const { width: viewportWidth } = useDevice()
const workbenchLayout = computed<WorkbenchLayoutMode>(() => {
  if (viewportWidth.value >= 1536) {
    return 'wide'
  }
  if (viewportWidth.value >= 1280) {
    return 'split'
  }
  return 'stacked'
})
const isWideWorkbench = computed(() => workbenchLayout.value === 'wide')
type WorkbenchScrollbarLike = {
  wrapRef?: HTMLElement | null
  setScrollTop?: (value: number) => void
}
type WorkbenchIssueFormSnapshot = typeof issueForm
type WorkbenchDetailUiSnapshot = {
  activeDetailTab: DetailTabKey
  replyDraft: string
  selectedQuickReplyKey: string
  transferAssigneeUserId: string
  issueForm: WorkbenchIssueFormSnapshot
  listScrollTop: number
  conversationScrollTop: number
  issueScrollTop: number
}

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
const isFilterPanelExpanded = ref(false)
const assigneeLoading = ref(false)
const assigneeUpdating = ref(false)
const quickStatusUpdating = ref<FeedbackIssueStatus | ''>('')
const priorityUpdating = ref<FeedbackIssuePriority | ''>('')
const activeQuickView = ref<WorkbenchQuickViewKey>('all')
const activeDetailTab = ref<DetailTabKey>('conversation')
const selectedQuickReplyKey = ref('')
const transferAssigneeUserId = ref('')
const assigneeOptions = ref<SupportAssignableUser[]>([])
const conversationListPanelRef = ref<HTMLDivElement | null>(null)
const conversationMessageScrollbarRef = ref<WorkbenchScrollbarLike | null>(null)
const issueFormScrollbarRef = ref<WorkbenchScrollbarLike | null>(null)
const freshConversationIds = ref<string[]>([])
const freshMessageIds = ref<string[]>([])
let realtimeConnection: FeedbackRealtimeConnection | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let refreshTimer: ReturnType<typeof setTimeout> | null = null
let freshConversationTimer: ReturnType<typeof setTimeout> | null = null
let freshMessageTimer: ReturnType<typeof setTimeout> | null = null
let lifecycleToken = 0
let refreshInFlight = false
let pendingRefresh = false
let workbenchComponentActive = false
const CUSTOMER_SERVICE_FALLBACK_POLL_MIN_MS = 25_000
const CUSTOMER_SERVICE_FALLBACK_POLL_MAX_MS = 35_000
const listRequest = useStableRequest()
const detailRequest = useStableRequest()
const presenceRequest = useStableRequest()
const assigneeRequest = useStableRequest()
const draftTrackingSuspended = ref(false)
const hasUnsavedReplyDraft = ref(false)
const hasUnsavedIssueDraft = ref(false)
const hasUnsavedInternalRemarkDraft = ref(false)

const handleDetailTabChange = (value: string | number) => {
  if (value === 'conversation' || value === 'detail') {
    activeDetailTab.value = value
  }
}

/**
 * - 关键字覆盖标题、Issue 编号、用户、关联编号和标签；
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

const normalizeComparableText = (value: unknown) => {
  return normalizeSubmitText(value)
}

const normalizeComparableTagText = (value: string | string[]) => {
  const tags = Array.isArray(value)
    ? value.map((item) => item.trim()).filter((item) => item.length > 0)
    : parseTagText(value)
  return [...new Set(tags)].sort().join('||')
}

const buildIssueFormComparableSnapshot = () => {
  return {
    title: normalizeComparableText(issueForm.title),
    status: issueForm.status,
    priority: issueForm.priority,
    issueType: issueForm.issueType,
    category: issueForm.category,
    orderRef: normalizeComparableText(issueForm.orderRef),
    expectedResult: normalizeComparableText(issueForm.expectedResult),
    actualResult: normalizeComparableText(issueForm.actualResult),
    reproductionSteps: normalizeComparableText(issueForm.reproductionSteps),
    contactPreference: normalizeComparableText(issueForm.contactPreference),
    tagText: normalizeComparableTagText(issueForm.tagText),
  }
}

const buildConversationIssueComparableSnapshot = (record: FeedbackConversationRecord | null) => {
  return {
    title: normalizeComparableText(record?.title),
    status: record?.status ?? 'pending',
    priority: record?.priority ?? 'medium',
    issueType: record?.fields.issueType ?? 'suggestion',
    category: record?.fields.category ?? 'other',
    orderRef: normalizeComparableText(record?.fields.orderRef),
    expectedResult: normalizeComparableText(record?.fields.expectedResult),
    actualResult: normalizeComparableText(record?.fields.actualResult),
    reproductionSteps: normalizeComparableText(record?.fields.reproductionSteps),
    contactPreference: normalizeComparableText(record?.fields.contactPreference),
    tagText: normalizeComparableTagText(record?.fields.tags ?? []),
  }
}

const syncLocalDraftFlags = () => {
  if (draftTrackingSuspended.value) {
    return
  }

  hasUnsavedReplyDraft.value = Boolean(normalizeComparableText(replyDraft.value))
  hasUnsavedIssueDraft.value = JSON.stringify(buildIssueFormComparableSnapshot())
    !== JSON.stringify(buildConversationIssueComparableSnapshot(selectedConversation.value))
  hasUnsavedInternalRemarkDraft.value = normalizeComparableText(issueForm.internalRemark)
    !== normalizeComparableText(selectedConversation.value?.internalRemark?.content)
}

const runWithSuspendedDraftTracking = (task: () => void) => {
  draftTrackingSuspended.value = true
  try {
    task()
  } finally {
    draftTrackingSuspended.value = false
  }
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
    return 'border-rose-200 bg-rose-50/90 dark:border-rose-500/30 dark:bg-rose-500/10'
  }
  if (slaMeta.level === 'warning') {
    return 'border-amber-200 bg-amber-50/90 dark:border-amber-500/30 dark:bg-amber-500/10'
  }
  return 'border-slate-200 bg-slate-50/80 dark:border-white/10 dark:bg-white/[0.03]'
}

/**
 * 列表行 SLA 倒计时只用文字着色表达风险：
 * - 替代原先一排彩色标签，降低列表视觉噪音；
 * - 超时与即将超时仍保持醒目，正常与暂停状态退为弱化色。
 */
const getSlaTextClass = (conversation: FeedbackConversationRecord) => {
  const slaMeta = resolveSupportFeedbackConversationSla(conversation)
  if (slaMeta.level === 'overtime') {
    return 'text-rose-600 dark:text-rose-400'
  }
  if (slaMeta.level === 'warning') {
    return 'text-amber-600 dark:text-amber-400'
  }
  return 'text-slate-400 dark:text-slate-500'
}

/**
 * 列表行左侧色条表达优先级，让客服扫一眼就能分辨紧急程度，不必逐个读标签。
 */
const getPriorityAccentClass = (priority: FeedbackIssuePriority) => {
  return `is-priority-${priority}`
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

const getClientAccountTypeLabel = (conversation: FeedbackConversationRecord) => {
  return conversation.clientAccountType === 'department' ? '部门账户' : '个人账户'
}

const buildClientIdentitySummary = (conversation: FeedbackConversationRecord) => {
  const summaryParts = [getClientAccountTypeLabel(conversation)]
  if (conversation.clientDepartmentName) {
    summaryParts.push(conversation.clientDepartmentName)
  }
  if (conversation.clientStaffNo) {
    summaryParts.push(`工号 ${conversation.clientStaffNo}`)
  }
  return summaryParts.join(' · ')
}

const summaryCategoryDefinitions = computed(() => {
  return [
    {
      key: 'all' as const,
      label: '全部反馈',
      count: conversations.value.length,
      valueClass: 'text-slate-900 dark:text-slate-100',
    },
    {
      key: 'pending' as const,
      label: '待受理',
      count: summary.value.pending,
      valueClass: 'text-amber-600 dark:text-amber-400',
    },
    {
      key: 'processing' as const,
      label: '处理中',
      count: summary.value.processing,
      valueClass: 'text-sky-600 dark:text-sky-400',
    },
    {
      key: 'urgent' as const,
      label: '紧急反馈',
      count: summary.value.urgent,
      valueClass: 'text-rose-600 dark:text-rose-400',
    },
    {
      key: 'unassigned' as const,
      label: '待分配',
      count: summary.value.unassigned,
      valueClass: 'text-slate-700 dark:text-slate-300',
    },
    {
      key: 'sla_risk' as const,
      label: 'SLA 风险',
      count: summary.value.slaRisk,
      valueClass: 'text-rose-600 dark:text-rose-400',
    },
    {
      key: 'waiting_staff_reply' as const,
      label: '待客服跟进',
      count: summary.value.waitingStaffReply,
      valueClass: 'text-brand',
    },
  ]
})

const filteredConversations = computed(() => getQuickViewFilteredConversations())

/**
 * 队列栏筛选默认折叠，只在按钮上提示已启用的筛选数量，避免客服忘记筛选条件仍在生效。
 */
const activeFilterCount = computed(() => {
  return [
    searchForm.status,
    searchForm.priority,
    searchForm.assigneeScope !== 'all' ? searchForm.assigneeScope : '',
  ].filter(Boolean).length
})
const currentUserId = computed(() => authStore.currentUser?.id ?? '')

/**
 * Element Plus Scrollbar 的公开实例带有 `wrapRef` 和 `setScrollTop`：
 * - 页面内部只依赖这两个最稳定的滚动能力；
 * - 若后续组件实例类型升级，依旧可以在这里集中兼容。
 */
const getScrollbarWrap = (scrollbar: WorkbenchScrollbarLike | null) => {
  return scrollbar?.wrapRef ?? null
}

const captureScrollbarTop = (scrollbar: WorkbenchScrollbarLike | null) => {
  return getScrollbarWrap(scrollbar)?.scrollTop ?? 0
}

const restoreScrollbarTop = (scrollbar: WorkbenchScrollbarLike | null, top: number) => {
  if (scrollbar?.setScrollTop) {
    scrollbar.setScrollTop(top)
    return
  }
  const wrap = getScrollbarWrap(scrollbar)
  if (wrap) {
    wrap.scrollTop = top
  }
}

/**
 * 自动刷新前先快照当前 UI 状态：
 * - 当前标签、草稿、Issue 编辑内容都需要保留，避免客服看到数据更新时输入被覆盖；
 * - 列表和详情滚动位置也一起记录，保证同会话局部刷新不会把视线拉回顶部。
 */
const captureWorkbenchDetailUiSnapshot = (): WorkbenchDetailUiSnapshot => {
  return {
    activeDetailTab: activeDetailTab.value,
    replyDraft: replyDraft.value,
    selectedQuickReplyKey: selectedQuickReplyKey.value,
    transferAssigneeUserId: transferAssigneeUserId.value,
    issueForm: {
      ...issueForm,
    },
    listScrollTop: conversationListPanelRef.value?.scrollTop ?? 0,
    conversationScrollTop: captureScrollbarTop(conversationMessageScrollbarRef.value),
    issueScrollTop: captureScrollbarTop(issueFormScrollbarRef.value),
  }
}

const restoreWorkbenchDetailUiSnapshot = async (snapshot: WorkbenchDetailUiSnapshot | null) => {
  if (!snapshot) {
    return
  }
  runWithSuspendedDraftTracking(() => {
    activeDetailTab.value = snapshot.activeDetailTab
    replyDraft.value = snapshot.replyDraft
    selectedQuickReplyKey.value = snapshot.selectedQuickReplyKey
    transferAssigneeUserId.value = snapshot.transferAssigneeUserId
    Object.assign(issueForm, snapshot.issueForm)
  })
  await nextTick()
  if (conversationListPanelRef.value) {
    conversationListPanelRef.value.scrollTop = snapshot.listScrollTop
  }
  restoreScrollbarTop(conversationMessageScrollbarRef.value, snapshot.conversationScrollTop)
  restoreScrollbarTop(issueFormScrollbarRef.value, snapshot.issueScrollTop)
  syncLocalDraftFlags()
}

/**
 * 新项高亮只保留极短时间：
 * - 让客服一眼看到刚补进来的工单或消息；
 * - 又不会像强提醒那样持续干扰当前操作。
 */
const markFreshConversationIds = (ids: string[]) => {
  if (!ids.length) {
    return
  }
  freshConversationIds.value = [...new Set([...freshConversationIds.value, ...ids])]
  if (freshConversationTimer) {
    clearTimeout(freshConversationTimer)
  }
  freshConversationTimer = setTimeout(() => {
    freshConversationIds.value = []
    freshConversationTimer = null
  }, 1800)
}

const markFreshMessageIds = (ids: string[]) => {
  if (!ids.length) {
    return
  }
  freshMessageIds.value = [...new Set([...freshMessageIds.value, ...ids])]
  if (freshMessageTimer) {
    clearTimeout(freshMessageTimer)
  }
  freshMessageTimer = setTimeout(() => {
    freshMessageIds.value = []
    freshMessageTimer = null
  }, 1800)
}

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

const realtimeStateLabel = computed(() => {
  if (realtimeState.value === 'online') {
    return '客服在线'
  }
  return realtimeState.value === 'connecting' ? '连接中' : '客服离线'
})

const presenceSummaryText = computed(() => {
  if (presence.value?.availability?.isOnline) {
    return `${presence.value.session.serviceConnectionCount ?? 0} 位客服在线接待`
  }
  return presence.value?.availability?.offlineNotice || '正在确认客服在线状态...'
})

/**
 * 队列行时间使用紧凑格式：
 * - 当天只显示时分，当年显示月日时分，跨年才显示完整日期；
 * - 完整时间仍在会话栏与属性栏展示，列表只负责快速比对先后。
 */
const formatCompactDateTime = (value?: string | null) => {
  const fullText = formatDateTime(value, '')
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(fullText)) {
    return fullText
  }
  const todayText = formatDateTime(new Date().toISOString())
  if (fullText.slice(0, 10) === todayText.slice(0, 10)) {
    return fullText.slice(11, 16)
  }
  if (fullText.slice(0, 4) === todayText.slice(0, 4)) {
    return fullText.slice(5, 16)
  }
  return fullText.slice(0, 10)
}

/**
 * 消息流滚到底部：
 * - 切换会话或自己发送回复后，客服应直接看到最新消息；
 * - 同会话自动刷新仍走快照恢复，不在这里强制拉到底，避免打断客服翻看历史。
 */
const scrollConversationToBottom = async () => {
  await nextTick()
  const wrap = getScrollbarWrap(conversationMessageScrollbarRef.value)
  if (wrap) {
    restoreScrollbarTop(conversationMessageScrollbarRef.value, wrap.scrollHeight)
  }
}

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
  runWithSuspendedDraftTracking(() => {
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
  })
  syncLocalDraftFlags()
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
    runWithSuspendedDraftTracking(() => {
      replyDraft.value = ''
      selectedQuickReplyKey.value = ''
      transferAssigneeUserId.value = ''
    })
    syncIssueForm(null)
    syncLocalDraftFlags()
    return
  }

  const hasCurrentSelection = visibleConversations.some((item) => item.id === selectedConversationId.value)
  const nextConversationId = hasCurrentSelection ? selectedConversationId.value : visibleConversations[0].id
  const shouldLoadDetail = options.forceReloadDetail
    || !selectedConversation.value
    || selectedConversation.value.id !== nextConversationId
  const shouldPreserveDetailUiState = hasCurrentSelection
    && nextConversationId === selectedConversation.value?.id
    && Boolean(options.forceReloadDetail)

  selectedConversationId.value = nextConversationId
  if (shouldLoadDetail) {
    await loadConversationDetail(nextConversationId, {
      preserveDetailUiState: shouldPreserveDetailUiState,
    })
  }
}

const loadConversationDetail = async (
  conversationId: string,
  options: {
    preserveDetailUiState?: boolean
  } = {},
) => {
  if (!conversationId) {
    selectedConversation.value = null
    runWithSuspendedDraftTracking(() => {
      replyDraft.value = ''
      selectedQuickReplyKey.value = ''
      transferAssigneeUserId.value = ''
    })
    syncIssueForm(null)
    syncLocalDraftFlags()
    return
  }

  const previousConversationId = selectedConversation.value?.id ?? ''
  const shouldPreserveDetailUiState = Boolean(options.preserveDetailUiState && previousConversationId === conversationId)
  const detailUiSnapshot = shouldPreserveDetailUiState ? captureWorkbenchDetailUiSnapshot() : null
  const previousMessageIds = shouldPreserveDetailUiState
    ? new Set(selectedConversation.value?.messages.map((message) => message.id) ?? [])
    : null
  detailLoading.value = true
  await detailRequest.runLatest({
    executor: (signal) => getSupportFeedbackConversation(conversationId, { signal }),
    onSuccess: async (detail) => {
      if (selectedConversationId.value !== conversationId) {
        return
      }

      selectedConversation.value = detail
      if (previousConversationId !== conversationId) {
        runWithSuspendedDraftTracking(() => {
          replyDraft.value = ''
          selectedQuickReplyKey.value = ''
          transferAssigneeUserId.value = ''
        })
      }
      syncIssueForm(selectedConversation.value)
      if (shouldPreserveDetailUiState) {
        const nextFreshMessageIds = detail?.messages
          .filter((message) => !previousMessageIds?.has(message.id))
          .map((message) => message.id) ?? []
        markFreshMessageIds(nextFreshMessageIds)
        await restoreWorkbenchDetailUiSnapshot(detailUiSnapshot)
      }
      syncLocalDraftFlags()
    },
    onFinally: () => {
      detailLoading.value = false
    },
  })
}

const loadConversations = async (
  options: {
    refreshSelectedDetail?: boolean
    preserveUiState?: boolean
  } = {},
) => {
  const shouldRefreshSelectedDetail = options.refreshSelectedDetail ?? true
  const previousConversationIds = options.preserveUiState
    ? new Set(conversations.value.map((item) => item.id))
    : null
  const listScrollTop = options.preserveUiState ? (conversationListPanelRef.value?.scrollTop ?? 0) : null
  loading.value = true
  await listRequest.runLatest({
    executor: (signal) => listSupportFeedbackConversations({
      keyword: searchForm.keyword,
      status: searchForm.status,
      priority: searchForm.priority,
      assigneeScope: searchForm.assigneeScope,
    }, { signal }),
    onSuccess: async (nextConversations) => {
      conversations.value = nextConversations
      if (previousConversationIds) {
        markFreshConversationIds(
          nextConversations
            .filter((item) => !previousConversationIds.has(item.id))
            .map((item) => item.id),
        )
      }
      await syncVisibleConversationSelection({
        forceReloadDetail: shouldRefreshSelectedDetail,
      })
      if (listScrollTop !== null) {
        await nextTick()
        if (conversationListPanelRef.value) {
          conversationListPanelRef.value.scrollTop = listScrollTop
        }
      }
    },
    onFinally: () => {
      loading.value = false
    },
  })
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

  if (
    !saving.value
    && !remarkSaving.value
    && !replying.value
    && !hasUnsavedIssueDraft.value
    && !hasUnsavedInternalRemarkDraft.value
  ) {
    syncIssueForm(selectedConversation.value)
  }

  syncLocalDraftFlags()
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
  await loadConversationDetail(conversationId, {
    preserveDetailUiState: false,
  })
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
    showAppWarning('请先选择一条会话')
    return
  }
  if (!currentUserId.value) {
    showAppWarning('当前登录信息已失效，请重新进入工作台')
    return
  }
  if (selectedConversation.value.assigneeUserId === currentUserId.value) {
    showAppInfo('当前会话已经由你负责')
    return
  }

  assigneeUpdating.value = true
  try {
    await updateSupportConversationAssignee(selectedConversation.value.id, currentUserId.value)
    await loadConversations({
      refreshSelectedDetail: true,
      preserveUiState: true,
    })
    reconnectTip.value = '已完成显式接单，当前会话后续消息会继续实时同步。'
    showAppSuccess('当前会话已接单')
  } catch (error) {
    void showCriticalErrorDialog(error, {
      title: '接单失败',
      fallback: '接单失败，请稍后重试',
      operation: '客服会话接单',
    })
  } finally {
    assigneeUpdating.value = false
  }
}

const handleTransferConversation = async () => {
  if (!selectedConversation.value) {
    showAppWarning('请先选择一条会话')
    return
  }
  if (!transferAssigneeUserId.value) {
    showAppWarning('请先选择转派目标')
    return
  }

  assigneeUpdating.value = true
  try {
    await updateSupportConversationAssignee(selectedConversation.value.id, transferAssigneeUserId.value)
    transferAssigneeUserId.value = ''
    await loadConversations({
      refreshSelectedDetail: true,
      preserveUiState: true,
    })
    reconnectTip.value = '负责人已更新，工作台已同步最新归属信息。'
    showAppSuccess('负责人已更新')
  } catch (error) {
    void showCriticalErrorDialog(error, {
      title: '转派失败',
      fallback: '转派失败，请稍后重试',
      operation: '客服会话转派',
    })
  } finally {
    assigneeUpdating.value = false
  }
}

const handleSaveIssue = async () => {
  if (!selectedConversation.value) {
    showAppWarning('请先选择一条会话')
    return
  }

  const normalizedTitle = normalizeSubmitText(issueForm.title)
  const normalizedExpectedResult = normalizeSubmitText(issueForm.expectedResult)
  const normalizedActualResult = normalizeSubmitText(issueForm.actualResult)

  if (!normalizedTitle) {
    showAppWarning('请填写标题')
    return
  }

  if (issueForm.issueType === 'bug' && (!normalizedExpectedResult || !normalizedActualResult)) {
    showAppWarning('专业 BUG 需要完整填写期望结果与实际结果')
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
    hasUnsavedIssueDraft.value = false
    await loadConversations({
      preserveUiState: true,
    })
    showAppSuccess('Issue 字段已保存')
  } catch (error) {
    void showCriticalErrorDialog(error, {
      title: 'Issue 字段保存失败',
      fallback: 'Issue 字段保存失败，请稍后重试',
      operation: '保存客服 Issue 字段',
    })
  } finally {
    saving.value = false
  }
}

const handleQuickStatus = async (status: FeedbackIssueStatus) => {
  if (!selectedConversation.value) {
    showAppWarning('请先选择一条会话')
    return
  }

  quickStatusUpdating.value = status
  saving.value = true
  try {
    await updateFeedbackIssue(selectedConversation.value.id, {
      status,
    })
    issueForm.status = status
    hasUnsavedIssueDraft.value = false
    patchSelectedConversation({
      status,
      updatedAt: new Date().toISOString(),
    })
    patchConversationListItem(selectedConversation.value.id, {
      status,
      updatedAt: new Date().toISOString(),
    })
    await loadConversations({
      preserveUiState: true,
    })
    showAppSuccess(`状态已更新为${FEEDBACK_STATUS_META_MAP[status].label}`)
  } catch (error) {
    void showCriticalErrorDialog(error, {
      title: '反馈状态更新失败',
      fallback: '状态更新失败，请稍后重试',
      operation: '更新反馈状态',
    })
  } finally {
    quickStatusUpdating.value = ''
    saving.value = false
  }
}

const handleReassignPriority = async (priority: FeedbackIssuePriority) => {
  if (!selectedConversation.value) {
    showAppWarning('请先选择一条会话')
    return
  }

  priorityUpdating.value = priority
  saving.value = true
  try {
    await updateFeedbackIssue(selectedConversation.value.id, {
      priority,
    })
    issueForm.priority = priority
    hasUnsavedIssueDraft.value = false
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
      preserveUiState: true,
    })
    showAppSuccess(`已将优先级调整为${FEEDBACK_PRIORITY_META_MAP[priority].label}`)
  } catch (error) {
    void showCriticalErrorDialog(error, {
      title: '优先级调整失败',
      fallback: '优先级调整失败，请稍后重试',
      operation: '调整反馈优先级',
    })
  } finally {
    priorityUpdating.value = ''
    saving.value = false
  }
}

const handleSaveInternalRemark = async () => {
  if (!selectedConversation.value) {
    showAppWarning('请先选择一条会话')
    return
  }

  remarkSaving.value = true
  try {
    await updateFeedbackInternalRemark(selectedConversation.value.id, issueForm.internalRemark)
    hasUnsavedInternalRemarkDraft.value = false
    await loadConversationDetail(selectedConversation.value.id, {
      preserveDetailUiState: true,
    })
    showAppSuccess('内部备注已保存')
  } catch (error) {
    void showCriticalErrorDialog(error, {
      title: '内部备注保存失败',
      fallback: '内部备注保存失败，请稍后重试',
      operation: '保存客服内部备注',
    })
  } finally {
    remarkSaving.value = false
  }
}

const handleReply = async () => {
  if (!selectedConversation.value) {
    showAppWarning('请先选择一条会话')
    return
  }

  const normalizedReply = normalizeSubmitText(replyDraft.value)
  if (!normalizedReply) {
    showAppWarning('请输入回复内容')
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
    hasUnsavedReplyDraft.value = false
    await loadConversations({
      preserveUiState: true,
    })
    reconnectTip.value = '已续接当前客服会话，最新回复已同步发送给客户端。'
    void scrollConversationToBottom()
    showAppSuccess('客服回复已发送')
  } catch (error) {
    void showCriticalErrorDialog(error, {
      title: '客服回复发送失败',
      fallback: '客服回复发送失败，请稍后重试',
      operation: '发送客服回复',
    })
  } finally {
    replying.value = false
  }
}

const handleApplyQuickReply = () => {
  if (!selectedConversation.value) {
    showAppWarning('请先选择一条会话')
    return
  }
  if (!selectedQuickReplyTemplate.value) {
    showAppWarning('请先选择一条快捷回复')
    return
  }

  const nextDraft = replyDraft.value.trim()
    ? `${replyDraft.value.trimEnd()}\n\n${selectedQuickReplyTemplate.value.content}`
    : selectedQuickReplyTemplate.value.content
  replyDraft.value = nextDraft
  selectedQuickReplyKey.value = ''
  showAppSuccess('已插入快捷回复，可继续编辑后发送')
}

/**
 * Ctrl/⌘ + Enter 快捷发送：
 * - 与主流客服工具保持一致，客服不必把手移到鼠标上点发送；
 * - 未接单或正在发送时直接忽略，门禁与按钮禁用条件保持同一口径。
 */
const handleReplyShortcut = (event: Event | KeyboardEvent) => {
  event.preventDefault()
  if (replying.value || !isSelectedConversationOwnedByCurrentUser.value) {
    return
  }
  void handleReply()
}

const loadPresence = async () => {
  await presenceRequest.runLatest({
    executor: (signal) => getCustomerServicePresence({ signal }),
    onSuccess: (result) => {
      presence.value = result
      realtimeState.value = result.availability.isOnline ? 'online' : 'offline'
    },
  })
}

/**
 * 转派候选人列表单独加载：
 * - 页面只在工作台内获取一次，避免每次切换会话都重复请求；
 * - 若后端调整可接单范围，前端只消费统一结果，不自行推断角色。
 */
const loadAssignableUsers = async () => {
  assigneeLoading.value = true
  await assigneeRequest.runLatest({
    executor: (signal) => listSupportAssignableUsers({ signal }),
    onSuccess: (result) => {
      assigneeOptions.value = result
    },
    onFinally: () => {
      assigneeLoading.value = false
    },
  })
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
    preserveUiState?: boolean
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
      preserveUiState: options.preserveUiState ?? true,
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
    clearTimeout(refreshTimer)
  }
  const scheduleNextRefresh = () => {
    if (
      !isWorkbenchResident.value
      || currentToken !== lifecycleToken
      || globalThis.document?.visibilityState === 'hidden'
    ) {
      refreshTimer = null
      return
    }
    const delay = CUSTOMER_SERVICE_FALLBACK_POLL_MIN_MS
      + Math.floor(Math.random() * (CUSTOMER_SERVICE_FALLBACK_POLL_MAX_MS - CUSTOMER_SERVICE_FALLBACK_POLL_MIN_MS + 1))
    refreshTimer = setTimeout(async () => {
      refreshTimer = null
      await refreshWorkbenchData(currentToken, { refreshPresence: true })
      scheduleNextRefresh()
    }, delay)
  }
  scheduleNextRefresh()
}

const handleRealtimeConversation = async (
  currentToken: number,
  payload: FeedbackRealtimeConversationEvent | null,
) => {
  if (!isWorkbenchResident.value || currentToken !== lifecycleToken) {
    return
  }

  if (!payload) {
    await refreshWorkbenchData(currentToken, {
      refreshPresence: false,
      refreshSelectedDetail: Boolean(selectedConversationId.value),
      preserveUiState: true,
    })
    return
  }

  try {
    await applyRealtimeConversationPatch(payload)
  } catch {
    await refreshWorkbenchData(currentToken, {
      refreshPresence: false,
      refreshSelectedDetail: Boolean(selectedConversationId.value),
      preserveUiState: true,
    })
    return
  }

  await refreshWorkbenchData(currentToken, {
    refreshPresence: false,
    refreshSelectedDetail: Boolean(selectedConversationId.value),
    preserveUiState: true,
  })
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
const disposeRealtimeConnection = () => {
  realtimeConnection?.close()
  realtimeConnection = null

  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

const disposeRealtime = () => {
  disposeRealtimeConnection()

  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }

  if (freshConversationTimer) {
    clearTimeout(freshConversationTimer)
    freshConversationTimer = null
  }

  if (freshMessageTimer) {
    clearTimeout(freshMessageTimer)
    freshMessageTimer = null
  }
}

const connectRealtime = (currentToken: number) => {
  // 重连只替换 SSE 本身；兜底轮询与页面高亮计时必须继续保留。
  disposeRealtimeConnection()

  if (
    !isWorkbenchResident.value
    || currentToken !== lifecycleToken
    || globalThis.document?.visibilityState === 'hidden'
  ) {
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
      void refreshWorkbenchData(currentToken, {
        refreshPresence: true,
        refreshSelectedDetail: Boolean(selectedConversationId.value),
        preserveUiState: true,
      })
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
  if (!workbenchComponentActive || globalThis.document?.visibilityState === 'hidden') {
    return
  }
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
    showAppError(extractErrorMessage(error, '客服工作台初始化失败，请稍后重试'))
  }
}

const leaveWorkbench = () => {
  isWorkbenchResident.value = false
  lifecycleToken += 1
  pendingRefresh = false
  refreshInFlight = false
  listRequest.cancel()
  detailRequest.cancel()
  presenceRequest.cancel()
  assigneeRequest.cancel()
  loading.value = false
  detailLoading.value = false
  assigneeLoading.value = false
  disposeRealtime()
  realtimeState.value = 'offline'
  reconnectTip.value = '离开工作台后已释放在线状态，返回页面会自动续接。'
}

watch(
  () => selectedConversation.value?.id,
  (conversationId, previousConversationId) => {
    if (conversationId && conversationId !== previousConversationId) {
      void scrollConversationToBottom()
    }
  },
  { flush: 'post' },
)

watch(workbenchLayout, (layout) => {
  // 回到三栏时属性栏常驻右侧，标签状态复位到会话，避免窄屏切回后仍停留在属性标签。
  if (layout === 'wide') {
    activeDetailTab.value = 'conversation'
  }
})

watch(replyDraft, () => {
  syncLocalDraftFlags()
})

watch(
  () => [
    issueForm.title,
    issueForm.status,
    issueForm.priority,
    issueForm.issueType,
    issueForm.category,
    issueForm.orderRef,
    issueForm.expectedResult,
    issueForm.actualResult,
    issueForm.reproductionSteps,
    issueForm.contactPreference,
    issueForm.tagText,
  ],
  () => {
    syncLocalDraftFlags()
  },
)

watch(
  () => issueForm.internalRemark,
  () => {
    syncLocalDraftFlags()
  },
)

watch(
  () => authStore.currentUser?.id,
  (currentUserId, previousUserId) => {
    if (
      currentUserId
      && currentUserId !== previousUserId
      && workbenchComponentActive
      && globalThis.document?.visibilityState !== 'hidden'
    ) {
      void enterWorkbench()
      return
    }

    if (!currentUserId) {
      leaveWorkbench()
    }
  },
)

const handleVisibilityChange = () => {
  if (!workbenchComponentActive) {
    return
  }
  if (globalThis.document?.visibilityState === 'hidden') {
    leaveWorkbench()
    reconnectTip.value = '页面进入后台后已释放在线状态，返回页面会自动续接。'
    return
  }
  void enterWorkbench()
}

onActivated(() => {
  if (workbenchComponentActive) {
    return
  }
  workbenchComponentActive = true
  globalThis.document?.addEventListener('visibilitychange', handleVisibilityChange)
  if (globalThis.document?.visibilityState !== 'hidden') {
    void enterWorkbench()
  }
})

onDeactivated(() => {
  workbenchComponentActive = false
  globalThis.document?.removeEventListener('visibilitychange', handleVisibilityChange)
  leaveWorkbench()
})

onBeforeUnmount(() => {
  workbenchComponentActive = false
  globalThis.document?.removeEventListener('visibilitychange', handleVisibilityChange)
  leaveWorkbench()
})
</script>

<template>
  <PageContainer title="客服工作台">
    <div class="cs-workbench-shell">
      <div class="cs-statusbar">
        <div class="cs-statusbar__main">
          <el-tag :type="getRealtimeTagType()" effect="light" round size="small">
            {{ realtimeStateLabel }}
          </el-tag>
          <span class="cs-statusbar__text">{{ presenceSummaryText }}</span>
          <span class="cs-statusbar__tip" :title="reconnectTip">{{ reconnectTip }}</span>
        </div>
        <el-button size="small" :loading="loading" @click="handleSearch">刷新</el-button>
      </div>

      <div class="cs-workbench" :class="`is-${workbenchLayout}`">
        <aside class="cs-pane cs-queue" aria-label="反馈队列">
          <div class="cs-queue__head">
            <div class="cs-view-chips" role="group" aria-label="队列视图">
              <el-button
                v-for="item in summaryCategoryDefinitions"
                :key="item.key"
                size="small"
                class="cs-view-chip"
                :class="item.key === activeQuickView ? 'is-active' : ''"
                @click="handleChangeQuickView(item.key)"
              >
                <span>{{ item.label }}</span>
                <span class="cs-view-chip__count" :class="item.key === activeQuickView ? '' : item.valueClass">
                  {{ item.count }}
                </span>
              </el-button>
            </div>

            <div class="cs-queue__search">
              <el-input
                v-model="searchForm.keyword"
                maxlength="80"
                clearable
                placeholder="标题 / 编号 / 用户 / 标签"
                title="可搜索标题、Issue 编号、用户、关联编号与标签"
                @keyup.enter="handleSearch"
                @clear="handleSearch"
              />
              <el-button
                :type="activeFilterCount ? 'primary' : 'default'"
                plain
                @click="isFilterPanelExpanded = !isFilterPanelExpanded"
              >
                筛选{{ activeFilterCount ? ` ${activeFilterCount}` : '' }}
              </el-button>
            </div>

            <el-collapse-transition>
              <div v-show="isFilterPanelExpanded" class="cs-filter-panel">
                <el-form label-position="top" class="cs-filter-form">
                  <div class="grid grid-cols-2 gap-2">
                    <el-form-item label="状态" class="!mb-0">
                      <el-select v-model="searchForm.status" placeholder="全部状态" clearable class="w-full" @change="handleSearch">
                        <el-option
                          v-for="item in FEEDBACK_STATUS_OPTIONS"
                          :key="item.value"
                          :label="item.label"
                          :value="item.value"
                        />
                      </el-select>
                    </el-form-item>
                    <el-form-item label="优先级" class="!mb-0">
                      <el-select v-model="searchForm.priority" placeholder="全部优先级" clearable class="w-full" @change="handleSearch">
                        <el-option
                          v-for="item in FEEDBACK_PRIORITY_OPTIONS"
                          :key="item.value"
                          :label="item.label"
                          :value="item.value"
                        />
                      </el-select>
                    </el-form-item>
                  </div>
                  <div class="mt-2 flex items-end gap-2">
                    <el-form-item label="分配范围" class="!mb-0 min-w-0 flex-1">
                      <el-select v-model="searchForm.assigneeScope" class="w-full" @change="handleSearch">
                        <el-option label="全部工单" value="all" />
                        <el-option label="仅看我的" value="mine" />
                        <el-option label="仅看待分配" value="unassigned" />
                      </el-select>
                    </el-form-item>
                    <el-button @click="handleReset">重置</el-button>
                  </div>
                </el-form>
              </div>
            </el-collapse-transition>
          </div>

          <div class="cs-queue__meta">
            <span>{{ activeQuickViewDefinition.label }}</span>
            <span>{{ filteredConversations.length }} 条</span>
          </div>

          <div v-if="loading && !conversations.length" class="cs-queue__placeholder">
            <el-skeleton :rows="6" animated />
          </div>

          <div v-else-if="!filteredConversations.length" class="cs-queue__placeholder">
            <el-empty :description="`${activeQuickViewDefinition.label}视图下暂无反馈会话`" :image-size="72" />
          </div>

          <div
            v-else
            ref="conversationListPanelRef"
            class="cs-queue__list"
          >
            <TransitionGroup name="cs-conversation-list" tag="div" class="cs-conversation-list">
              <el-card
                v-for="item in filteredConversations"
                :key="item.id"
                class="cs-conversation-item"
                shadow="never"
                tabindex="0"
                :class="[
                  getPriorityAccentClass(item.priority),
                  item.id === selectedConversationId ? 'is-selected' : '',
                  freshConversationIds.includes(item.id) ? 'is-fresh' : '',
                ]"
                @click="handleSelectConversation(item.id)"
                @keydown.enter="handleSelectConversation(item.id)"
              >
                <div class="cs-conversation-item__row">
                  <p class="cs-conversation-item__title">{{ item.title }}</p>
                  <span class="cs-conversation-item__time">{{ formatCompactDateTime(item.lastMessageAt) }}</span>
                </div>
                <div class="cs-conversation-item__row mt-1">
                  <p class="cs-conversation-item__client">
                    {{ item.clientDisplayName }}<template v-if="item.clientDepartmentName"> · {{ item.clientDepartmentName }}</template>
                  </p>
                  <el-tag :type="getStatusTagType(item.status)" effect="light" round size="small">
                    {{ resolveFeedbackConversationStatusMeta(item).label }}
                  </el-tag>
                </div>
                <div class="cs-conversation-item__row mt-1.5">
                  <span class="cs-conversation-item__sla" :class="getSlaTextClass(item)">
                    {{ resolveSupportFeedbackConversationSla(item).countdownText }}
                  </span>
                  <div class="flex shrink-0 items-center gap-1.5">
                    <el-tag :type="getAssigneeTagType(item)" effect="plain" round size="small">
                      {{ getAssigneeTagLabel(item) }}
                    </el-tag>
                    <span
                      v-if="item.unreadForStaff > 0"
                      class="cs-unread-badge"
                      :aria-label="`待回复 ${item.unreadForStaff} 条`"
                    >
                      {{ item.unreadForStaff }}
                    </span>
                  </div>
                </div>
              </el-card>
            </TransitionGroup>
          </div>
        </aside>

        <section v-if="selectedConversation" class="cs-detail" aria-label="会话详情">
          <PassiveSegmentedTabs
            v-if="!isWideWorkbench"
            :model-value="activeDetailTab"
            :tabs="detailTabs"
            class="cs-detail-tabs"
            block
            aria-label="客服详情标签"
            @tab-change="handleDetailTabChange"
          />

          <div v-show="isWideWorkbench || activeDetailTab === 'conversation'" class="cs-pane cs-thread">
            <header class="cs-thread__head">
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="cs-issue-no">{{ selectedConversation.issueNo }}</span>
                  <span v-if="detailLoading" class="text-xs text-slate-400 dark:text-slate-500">同步中…</span>
                </div>
                <h2 class="cs-thread__title">{{ selectedConversation.title }}</h2>
                <p class="cs-thread__client">
                  {{ selectedConversation.clientDisplayName }} · {{ selectedConversation.clientAccount }} · {{ buildClientIdentitySummary(selectedConversation) }}
                </p>
              </div>
              <div class="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                <el-tag :type="getStatusTagType(selectedConversation.status)" effect="light" round>
                  {{ resolveFeedbackConversationStatusMeta(selectedConversation).label }}
                </el-tag>
                <el-tag :type="getPriorityTagType(selectedConversation.priority)" effect="light" round>
                  {{ FEEDBACK_PRIORITY_META_MAP[selectedConversation.priority].label }}
                </el-tag>
              </div>
            </header>

            <el-scrollbar ref="conversationMessageScrollbarRef" class="cs-thread__messages">
              <p v-if="!selectedConversation.messages.length" class="py-10 text-center text-sm text-slate-400">
                暂无会话消息
              </p>
              <TransitionGroup v-else name="cs-message-stack" tag="div" class="cs-message-list">
                <div
                  v-for="message in selectedConversation.messages"
                  :key="message.id"
                  class="cs-message"
                  :class="[
                    `is-${message.senderRole}`,
                    freshMessageIds.includes(message.id) ? 'is-fresh' : '',
                  ]"
                >
                  <p v-if="message.senderRole === 'system'" class="cs-message__system">
                    <span class="whitespace-pre-wrap">{{ message.body }}</span>
                    <span class="cs-message__system-time">{{ formatDateTime(message.createdAt) }}</span>
                  </p>
                  <template v-else>
                    <p class="cs-message__meta">
                      <span class="font-semibold text-slate-600 dark:text-slate-300">{{ getMessageTitle(message) }}</span>
                      <span>{{ getMessageRoleLabel(message.senderRole) }}</span>
                      <span>{{ formatDateTime(message.createdAt) }}</span>
                    </p>
                    <div class="cs-message__bubble">{{ message.body }}</div>
                  </template>
                </div>
              </TransitionGroup>
            </el-scrollbar>

            <div class="cs-composer">
              <div v-if="!isSelectedConversationOwnedByCurrentUser" class="cs-ownership-banner">
                <p class="min-w-0 flex-1">{{ assignmentActionTip }}</p>
                <el-button
                  type="primary"
                  size="small"
                  :loading="assigneeUpdating"
                  :disabled="assigneeUpdating"
                  @click="handleTakeOver"
                >
                  {{ takeOverButtonText }}
                </el-button>
              </div>

              <el-collapse-transition>
                <div v-if="selectedQuickReplyTemplate" class="cs-quick-reply-preview">
                  <div class="flex items-center justify-between gap-2">
                    <p class="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">
                      {{ selectedQuickReplyTemplate.label }}
                    </p>
                    <div class="flex shrink-0 items-center gap-1">
                      <el-button size="small" link @click="selectedQuickReplyKey = ''">取消</el-button>
                      <el-button size="small" type="primary" plain @click="handleApplyQuickReply">插入回复框</el-button>
                    </div>
                  </div>
                  <p class="mt-1.5 whitespace-pre-wrap text-sm leading-6 text-slate-700 dark:text-slate-300">
                    {{ selectedQuickReplyTemplate.content }}
                  </p>
                  <p class="mt-1.5 text-xs leading-5 text-slate-400 dark:text-slate-500">
                    {{ selectedQuickReplyTemplate.description }} · {{ getQuickReplySuggestedStatusText(selectedQuickReplyTemplate.suggestedStatuses) }} · 来源：{{ SUPPORT_QUICK_REPLY_SOURCE_META.sourceLabel }}
                  </p>
                </div>
              </el-collapse-transition>

              <el-input
                v-model="replyDraft"
                class="cs-composer__input"
                type="textarea"
                :autosize="{ minRows: 3, maxRows: 8 }"
                maxlength="500"
                show-word-limit
                resize="none"
                :placeholder="isSelectedConversationOwnedByCurrentUser ? '输入给客户的回复，例如处理结论、补充说明或下一步动作' : '接单后即可发送回复，可先在此起草'"
                @keydown.ctrl.enter="handleReplyShortcut"
                @keydown.meta.enter="handleReplyShortcut"
              />

              <div class="cs-composer__toolbar">
                <el-select
                  v-model="selectedQuickReplyKey"
                  class="cs-quick-reply-select"
                  size="small"
                  clearable
                  filterable
                  placeholder="快捷回复模板"
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
                <div class="flex items-center gap-3">
                  <span class="hidden text-xs text-slate-400 sm:inline dark:text-slate-500">Ctrl + Enter 发送</span>
                  <el-button
                    type="primary"
                    :loading="replying"
                    :disabled="replying || !isSelectedConversationOwnedByCurrentUser"
                    @click="handleReply"
                  >
                    发送回复
                  </el-button>
                </div>
              </div>
            </div>
          </div>

          <aside v-show="isWideWorkbench || activeDetailTab === 'detail'" class="cs-pane cs-inspector" aria-label="工单与协同">
            <el-scrollbar ref="issueFormScrollbarRef" class="cs-inspector__scroll">
              <div class="cs-inspector__body">
                <section class="cs-section">
                  <div class="cs-section__head">
                    <p class="cs-section__title">处理时效</p>
                    <el-tag :type="getSlaTagType(selectedConversation)" effect="light" round size="small">
                      {{ selectedConversationSla?.label }}
                    </el-tag>
                  </div>
                  <div class="cs-sla-card" :class="getSlaPanelClass(selectedConversation)">
                    <p class="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {{ selectedConversationSla?.stageLabel }}
                      <span class="ml-1 text-xs font-medium text-slate-500 dark:text-slate-400">{{ selectedConversationSla?.countdownText }}</span>
                    </p>
                    <p v-if="selectedConversationSla?.deadlineAt" class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      目标截止：{{ formatDateTime(selectedConversationSla.deadlineAt) }}
                    </p>
                    <p class="mt-1.5 text-xs leading-5 text-slate-500 dark:text-slate-400">{{ selectedConversationSla?.description }}</p>
                  </div>
                </section>

                <section class="cs-section">
                  <div class="cs-section__head">
                    <p class="cs-section__title">负责人</p>
                    <el-tag :type="getAssigneeTagType(selectedConversation)" effect="plain" round size="small">
                      {{ getAssigneeTagLabel(selectedConversation) }}
                    </el-tag>
                  </div>
                  <div class="flex items-center gap-2">
                    <el-select
                      v-model="transferAssigneeUserId"
                      class="min-w-0 flex-1"
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
                      转派
                    </el-button>
                  </div>
                </section>

                <section class="cs-section">
                  <div class="cs-section__head">
                    <p class="cs-section__title">状态</p>
                    <el-button
                      link
                      type="danger"
                      size="small"
                      :disabled="saving || !isSelectedConversationOwnedByCurrentUser"
                      @click="handleQuickStatus('closed')"
                    >
                      关闭会话
                    </el-button>
                  </div>
                  <div class="cs-option-row">
                    <el-button
                      v-for="item in FEEDBACK_STATUS_OPTIONS.filter((option) => ['pending', 'processing', 'resolved'].includes(option.value))"
                      :key="item.value"
                      size="small"
                      :type="getQuickStatusButtonType(item.value)"
                      :plain="issueForm.status !== item.value"
                      :loading="quickStatusUpdating === item.value"
                      :disabled="saving || !isSelectedConversationOwnedByCurrentUser"
                      @click="handleQuickStatus(item.value)"
                    >
                      {{ item.label }}
                    </el-button>
                  </div>
                  <p v-if="!isSelectedConversationOwnedByCurrentUser" class="cs-section__hint">接单后才能变更状态。</p>
                </section>

                <section class="cs-section">
                  <div class="cs-section__head">
                    <p class="cs-section__title">优先级</p>
                  </div>
                  <div class="cs-option-row">
                    <el-button
                      v-for="item in FEEDBACK_PRIORITY_OPTIONS"
                      :key="item.value"
                      size="small"
                      :type="getPriorityButtonType(item.value)"
                      :plain="issueForm.priority !== item.value"
                      :loading="priorityUpdating === item.value"
                      :disabled="saving"
                      @click="handleReassignPriority(item.value)"
                    >
                      {{ item.label }}
                    </el-button>
                  </div>
                </section>

                <section class="cs-section">
                  <div class="cs-section__head">
                    <p class="cs-section__title">工单信息</p>
                    <div class="flex items-center gap-1.5">
                      <el-tag v-if="hasUnsavedIssueDraft" type="warning" effect="light" round size="small">未保存</el-tag>
                      <el-tag type="info" effect="plain" round size="small">{{ getCategoryLabel(issueForm.category) }}</el-tag>
                    </div>
                  </div>
                  <el-form label-position="top" class="cs-issue-form">
                    <el-form-item label="标题">
                      <el-input v-model="issueForm.title" maxlength="80" show-word-limit />
                    </el-form-item>

                    <div class="grid grid-cols-2 gap-2">
                      <el-form-item label="问题类型">
                        <el-select v-model="issueForm.issueType" class="w-full">
                          <el-option
                            v-for="item in FEEDBACK_ISSUE_TYPE_OPTIONS"
                            :key="item.value"
                            :label="item.label"
                            :value="item.value"
                          />
                        </el-select>
                      </el-form-item>
                      <el-form-item label="问题分类">
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

                    <el-form-item label="关联编号">
                      <el-input
                        v-model="issueForm.orderRef"
                        maxlength="64"
                        placeholder="可填写预订单号、出库业务单号或核销码"
                      />
                    </el-form-item>

                    <el-form-item label="期望结果">
                      <el-input
                        v-model="issueForm.expectedResult"
                        type="textarea"
                        :autosize="{ minRows: 2, maxRows: 6 }"
                        maxlength="240"
                        show-word-limit
                        resize="none"
                      />
                    </el-form-item>

                    <el-form-item label="实际结果">
                      <el-input
                        v-model="issueForm.actualResult"
                        type="textarea"
                        :autosize="{ minRows: 2, maxRows: 6 }"
                        maxlength="240"
                        show-word-limit
                        resize="none"
                      />
                    </el-form-item>

                    <el-form-item label="复现步骤">
                      <el-input
                        v-model="issueForm.reproductionSteps"
                        type="textarea"
                        :autosize="{ minRows: 2, maxRows: 6 }"
                        maxlength="300"
                        show-word-limit
                        resize="none"
                      />
                    </el-form-item>

                    <div class="grid grid-cols-2 gap-2">
                      <el-form-item label="联系偏好">
                        <el-input v-model="issueForm.contactPreference" maxlength="64" />
                      </el-form-item>
                      <el-form-item label="标签">
                        <el-input
                          v-model="issueForm.tagText"
                          maxlength="120"
                          placeholder="中文逗号分隔"
                        />
                      </el-form-item>
                    </div>
                  </el-form>
                  <el-button
                    type="primary"
                    class="w-full"
                    :loading="saving && quickStatusUpdating === '' && priorityUpdating === ''"
                    :disabled="saving"
                    @click="handleSaveIssue"
                  >
                    保存工单信息
                  </el-button>
                </section>

                <section class="cs-section">
                  <div class="cs-section__head">
                    <p class="cs-section__title">内部备注</p>
                    <el-tag v-if="hasUnsavedInternalRemarkDraft" type="warning" effect="light" round size="small">未保存</el-tag>
                  </div>
                  <el-input
                    v-model="issueForm.internalRemark"
                    class="cs-issue-form"
                    type="textarea"
                    :autosize="{ minRows: 4, maxRows: 10 }"
                    maxlength="4000"
                    show-word-limit
                    resize="none"
                    placeholder="仅客服内部可见，可记录排查结论、交接信息或风险判断。"
                  />
                  <div class="mt-2 flex items-center justify-between gap-2">
                    <p class="min-w-0 truncate text-xs text-slate-400 dark:text-slate-500">
                      <template v-if="selectedConversation.internalRemark?.updatedAt">
                        {{
                          selectedConversation.internalRemark.updatedByDisplayName
                            || selectedConversation.internalRemark.updatedByUsername
                            || '未知客服'
                        }}
                        · {{ formatDateTime(selectedConversation.internalRemark.updatedAt) }}
                      </template>
                      <template v-else>暂无备注</template>
                    </p>
                    <el-button size="small" :loading="remarkSaving" :disabled="remarkSaving" @click="handleSaveInternalRemark">
                      保存备注
                    </el-button>
                  </div>
                </section>

                <section class="cs-section">
                  <div class="cs-section__head">
                    <p class="cs-section__title">会话信息</p>
                  </div>
                  <dl class="cs-meta-list">
                    <dt>客户账号</dt>
                    <dd>{{ selectedConversation.clientAccount }}</dd>
                    <dt>所属部门</dt>
                    <dd>{{ selectedConversation.clientDepartmentName || '未填写部门' }}</dd>
                    <dt>客户未读</dt>
                    <dd>{{ selectedConversation.unreadForClient }}</dd>
                    <dt>客服待处理</dt>
                    <dd>{{ selectedConversation.unreadForStaff }}</dd>
                    <dt>创建时间</dt>
                    <dd>{{ formatDateTime(selectedConversation.createdAt) }}</dd>
                    <dt>最近消息</dt>
                    <dd>{{ formatDateTime(selectedConversation.lastMessageAt) }}</dd>
                    <dt>最近更新</dt>
                    <dd>{{ formatDateTime(selectedConversation.updatedAt) }}</dd>
                  </dl>
                </section>
              </div>
            </el-scrollbar>
          </aside>
        </section>

        <section v-else class="cs-pane cs-detail-empty">
          <el-empty :image-size="96">
            <template #description>
              <div class="space-y-1.5">
                <p class="text-base font-semibold text-slate-900 dark:text-slate-100">暂无可查看的反馈会话</p>
                <p class="text-sm leading-6 text-slate-500 dark:text-slate-400">客户端提交反馈后，会话与工单信息会自动出现在这里。</p>
              </div>
            </template>
          </el-empty>
        </section>
      </div>
    </div>
  </PageContainer>
</template>

<style scoped>
/*
 * 工作台整体骨架：
 * - 宽屏与两栏模式锁定视口高度，三栏各自独立滚动，回复框始终贴底可见；
 * - 单列模式回到自然高度，仅限制列表与消息流的最大高度，避免页面无限拉长。
 */
.cs-workbench-shell {
  --cs-border: rgb(226 232 240);
  --cs-surface: #fff;
  --cs-surface-muted: rgb(248 250 252);
  --cs-brand: rgb(13 148 136);
  --cs-brand-soft: rgba(20, 184, 166, 0.08);
  --cs-brand-border: rgba(13, 148, 136, 0.35);
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

:global(.dark .cs-workbench-shell) {
  --cs-border: rgba(255, 255, 255, 0.07);
  --cs-surface: #141415;
  --cs-surface-muted: rgba(255, 255, 255, 0.03);
  --cs-brand-soft: rgba(45, 212, 191, 0.1);
  --cs-brand-border: rgba(45, 212, 191, 0.35);
}

.cs-statusbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  border: 1px solid var(--cs-border);
  border-radius: 12px;
  background: var(--cs-surface);
  padding: 0.5rem 0.75rem;
}

.cs-statusbar__main {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  align-items: center;
  gap: 0.6rem;
}

.cs-statusbar__text {
  flex-shrink: 0;
  color: rgb(51 65 85);
  font-size: 0.82rem;
  font-weight: 600;
}

.cs-statusbar__tip {
  min-width: 0;
  overflow: hidden;
  color: rgb(148 163 184);
  font-size: 0.75rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:global(.dark .cs-statusbar__text) {
  color: rgb(203 213 225);
}

:global(.dark .cs-statusbar__tip) {
  color: rgb(100 116 139);
}

.cs-workbench {
  display: grid;
  gap: 0.75rem;
  grid-template-columns: minmax(0, 1fr);
}

.cs-workbench.is-wide,
.cs-workbench.is-split {
  height: calc(100dvh - 13.5rem);
  min-height: 34rem;
  grid-template-columns: 300px minmax(0, 1fr);
}

.cs-workbench.is-wide .cs-detail {
  display: grid;
  min-height: 0;
  gap: 0.75rem;
  grid-template-columns: minmax(0, 1fr) 340px;
}

.cs-workbench.is-split .cs-detail {
  display: flex;
  min-height: 0;
  flex-direction: column;
  gap: 0.6rem;
}

.cs-workbench.is-split .cs-detail > .cs-pane {
  flex: 1 1 auto;
}

.cs-workbench.is-stacked .cs-detail {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.cs-pane {
  display: flex;
  min-height: 0;
  min-width: 0;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--cs-border);
  border-radius: 16px;
  background: var(--cs-surface);
}

/* 队列栏 */
.cs-queue__head {
  padding: 0.75rem 0.75rem 0.5rem;
  border-bottom: 1px solid var(--cs-border);
}

.cs-view-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.cs-view-chips :deep(.el-button + .el-button) {
  margin-left: 0;
}

.cs-view-chip {
  --el-button-bg-color: var(--cs-surface-muted);
  --el-button-border-color: transparent;
  --el-button-hover-bg-color: var(--cs-brand-soft);
  --el-button-hover-border-color: transparent;
  --el-button-hover-text-color: var(--cs-brand);
  border-radius: 9999px;
  color: rgb(71 85 105);
  font-weight: 600;
}

.cs-view-chip.is-active {
  --el-button-bg-color: var(--cs-brand);
  --el-button-hover-bg-color: var(--cs-brand);
  --el-button-hover-text-color: #fff;
  color: #fff;
}

.cs-view-chip__count {
  margin-left: 0.35rem;
  font-variant-numeric: tabular-nums;
  font-weight: 700;
}

:global(.dark .cs-view-chip) {
  color: rgb(203 213 225);
}

:global(.dark .cs-view-chip.is-active) {
  color: #fff;
}

.cs-queue__search {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.65rem;
}

.cs-filter-panel {
  padding-top: 0.6rem;
}

.cs-queue__meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.85rem;
  color: rgb(100 116 139);
  font-size: 0.75rem;
  font-weight: 600;
}

.cs-queue__placeholder {
  padding: 0.75rem;
}

.cs-queue__list {
  min-height: 0;
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 0 0.5rem 0.6rem;
}

.cs-workbench.is-stacked .cs-queue__list {
  max-height: 26rem;
}

.cs-conversation-list {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.cs-conversation-item {
  position: relative;
  cursor: pointer;
  border: 1px solid transparent;
  border-radius: 12px;
  background: transparent;
  transition:
    border-color 0.18s ease,
    background-color 0.18s ease;
}

.cs-conversation-item::before {
  content: '';
  position: absolute;
  top: 0.7rem;
  bottom: 0.7rem;
  left: 0;
  width: 3px;
  border-radius: 9999px;
  background: rgb(203 213 225);
}

.cs-conversation-item.is-priority-urgent::before {
  background: rgb(225 29 72);
}

.cs-conversation-item.is-priority-high::before {
  background: rgb(245 158 11);
}

.cs-conversation-item.is-priority-medium::before {
  background: rgb(20 184 166);
}

.cs-conversation-item :deep(.el-card__body) {
  padding: 0.6rem 0.7rem 0.6rem 0.85rem;
}

.cs-conversation-item:hover {
  background: var(--cs-surface-muted);
}

.cs-conversation-item:focus-visible {
  outline: 2px solid var(--cs-brand-border);
  outline-offset: 1px;
}

.cs-conversation-item.is-selected {
  border-color: var(--cs-brand-border);
  background: var(--cs-brand-soft);
}

.cs-conversation-item__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.cs-conversation-item__title {
  min-width: 0;
  overflow: hidden;
  color: rgb(15 23 42);
  font-size: 0.875rem;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cs-conversation-item__time {
  flex-shrink: 0;
  color: rgb(148 163 184);
  font-size: 0.72rem;
  font-variant-numeric: tabular-nums;
}

.cs-conversation-item__client {
  min-width: 0;
  overflow: hidden;
  color: rgb(100 116 139);
  font-size: 0.75rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cs-conversation-item__sla {
  min-width: 0;
  overflow: hidden;
  font-size: 0.72rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cs-unread-badge {
  display: inline-flex;
  min-width: 1.25rem;
  height: 1.25rem;
  align-items: center;
  justify-content: center;
  border-radius: 9999px;
  background: rgb(225 29 72);
  padding: 0 0.35rem;
  color: #fff;
  font-size: 0.68rem;
  font-weight: 700;
}

:global(.dark .cs-conversation-item__title) {
  color: rgb(241 245 249);
}

:global(.dark .cs-conversation-item__client) {
  color: rgb(148 163 184);
}

:global(.dark .cs-conversation-item::before) {
  background: rgb(71 85 105);
}

:global(.dark .cs-conversation-item.is-priority-urgent::before) {
  background: rgb(251 113 133);
}

:global(.dark .cs-conversation-item.is-priority-high::before) {
  background: rgb(251 191 36);
}

:global(.dark .cs-conversation-item.is-priority-medium::before) {
  background: rgb(45 212 191);
}

/* 会话栏 */
.cs-detail-tabs :deep(.el-segmented__item) {
  color: rgb(100 116 139);
  font-weight: 600;
}

.cs-detail-tabs :deep(.el-segmented__item.is-selected) {
  color: var(--cs-brand);
}

.cs-thread__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  border-bottom: 1px solid var(--cs-border);
  padding: 0.85rem 1rem;
}

.cs-issue-no {
  color: rgb(148 163 184);
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.08em;
}

.cs-thread__title {
  margin-top: 0.15rem;
  overflow: hidden;
  color: rgb(15 23 42);
  font-size: 1.05rem;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cs-thread__client {
  margin-top: 0.2rem;
  overflow: hidden;
  color: rgb(100 116 139);
  font-size: 0.78rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:global(.dark .cs-thread__title) {
  color: rgb(241 245 249);
}

:global(.dark .cs-thread__client) {
  color: rgb(148 163 184);
}

.cs-thread__messages {
  min-height: 0;
  flex: 1 1 auto;
  background: var(--cs-surface-muted);
}

.cs-workbench.is-stacked .cs-thread__messages {
  max-height: 30rem;
}

.cs-message-list {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
  padding: 1rem;
}

.cs-message {
  display: flex;
  max-width: min(78%, 40rem);
  flex-direction: column;
  align-items: flex-start;
}

.cs-message.is-staff {
  align-self: flex-end;
  align-items: flex-end;
}

.cs-message.is-system {
  max-width: 90%;
  align-self: center;
  align-items: center;
}

.cs-message__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-bottom: 0.25rem;
  color: rgb(148 163 184);
  font-size: 0.7rem;
}

.cs-message__bubble {
  border: 1px solid var(--cs-border);
  border-radius: 14px 14px 14px 4px;
  background: var(--cs-surface);
  padding: 0.55rem 0.8rem;
  color: rgb(51 65 85);
  font-size: 0.875rem;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.cs-message.is-staff .cs-message__bubble {
  border-color: transparent;
  border-radius: 14px 14px 4px 14px;
  background: rgb(204 251 241);
  color: rgb(17 94 89);
}

.cs-message__system {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.4rem;
  border-radius: 9999px;
  background: rgba(148, 163, 184, 0.14);
  padding: 0.25rem 0.75rem;
  color: rgb(100 116 139);
  font-size: 0.72rem;
  text-align: center;
}

.cs-message__system-time {
  color: rgb(148 163 184);
}

.cs-message.is-fresh .cs-message__bubble,
.cs-conversation-item.is-fresh {
  animation: cs-fresh-highlight 1.6s ease;
}

:global(.dark .cs-message__bubble) {
  color: rgb(226 232 240);
}

:global(.dark .cs-message.is-staff .cs-message__bubble) {
  background: rgba(45, 212, 191, 0.16);
  color: rgb(204 251 241);
}

:global(.dark .cs-message__system) {
  background: rgba(255, 255, 255, 0.05);
  color: rgb(148 163 184);
}

/* 回复区 */
.cs-composer {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  border-top: 1px solid var(--cs-border);
  padding: 0.75rem 1rem 0.85rem;
}

.cs-ownership-banner {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  border: 1px solid rgb(253 230 138);
  border-radius: 10px;
  background: rgb(255 251 235);
  padding: 0.45rem 0.6rem 0.45rem 0.75rem;
  color: rgb(146 64 14);
  font-size: 0.78rem;
  line-height: 1.5;
}

:global(.dark .cs-ownership-banner) {
  border-color: rgba(245, 158, 11, 0.3);
  background: rgba(245, 158, 11, 0.1);
  color: rgb(253 230 138);
}

.cs-quick-reply-preview {
  border: 1px dashed var(--cs-brand-border);
  border-radius: 10px;
  background: var(--cs-brand-soft);
  padding: 0.6rem 0.75rem;
}

.cs-composer__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.cs-quick-reply-select {
  width: 13rem;
  max-width: 100%;
}

/* 属性栏 */
.cs-inspector__scroll {
  min-height: 0;
  flex: 1 1 auto;
}

.cs-inspector__body {
  padding: 0.25rem 1rem 1rem;
}

.cs-section {
  border-bottom: 1px solid var(--cs-border);
  padding: 0.85rem 0;
}

.cs-section:last-child {
  border-bottom: 0;
}

.cs-section__head {
  display: flex;
  min-height: 1.5rem;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.55rem;
}

.cs-section__title {
  color: rgb(15 23 42);
  font-size: 0.82rem;
  font-weight: 700;
}

.cs-section__hint {
  margin-top: 0.4rem;
  color: rgb(148 163 184);
  font-size: 0.72rem;
}

:global(.dark .cs-section__title) {
  color: rgb(241 245 249);
}

.cs-sla-card {
  border-width: 1px;
  border-style: solid;
  border-radius: 12px;
  padding: 0.6rem 0.75rem;
}

.cs-option-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.cs-option-row :deep(.el-button + .el-button) {
  margin-left: 0;
}

.cs-meta-list {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.4rem 0.9rem;
  font-size: 0.78rem;
}

.cs-meta-list dt {
  color: rgb(148 163 184);
}

.cs-meta-list dd {
  min-width: 0;
  overflow: hidden;
  color: rgb(51 65 85);
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:global(.dark .cs-meta-list dd) {
  color: rgb(203 213 225);
}

.cs-detail-empty {
  justify-content: center;
}

/*
 * 表单细节：
 * - 只在本页收敛标签字号与输入框圆角，不覆盖全局主题；
 * - 属性栏表单项间距压缩，保证 340px 宽度下一屏能看到更多字段。
 */
.cs-filter-form :deep(.el-form-item__label),
.cs-issue-form :deep(.el-form-item__label) {
  margin-bottom: 0.25rem;
  color: rgb(100 116 139);
  font-size: 0.75rem;
  font-weight: 600;
  line-height: 1.4;
}

.cs-issue-form :deep(.el-form-item) {
  margin-bottom: 0.7rem;
}

.cs-queue :deep(.el-input__wrapper),
.cs-queue :deep(.el-select__wrapper),
.cs-inspector :deep(.el-input__wrapper),
.cs-inspector :deep(.el-select__wrapper),
.cs-inspector :deep(.el-textarea__inner),
.cs-composer :deep(.el-textarea__inner) {
  border-radius: 10px;
}

.cs-composer__input :deep(.el-textarea__inner) {
  padding: 0.6rem 0.75rem;
  line-height: 1.6;
}

@keyframes cs-fresh-highlight {
  0% {
    box-shadow: 0 0 0 2px rgba(45, 212, 191, 0.45);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(45, 212, 191, 0);
  }
}

.cs-conversation-list-enter-active,
.cs-conversation-list-leave-active,
.cs-message-stack-enter-active,
.cs-message-stack-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
}

.cs-conversation-list-enter-from,
.cs-conversation-list-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

.cs-message-stack-enter-from,
.cs-message-stack-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

.cs-message-stack-move,
.cs-conversation-list-move {
  transition: transform 0.2s ease;
}

@media (prefers-reduced-motion: reduce) {
  .cs-conversation-item,
  .cs-conversation-list-enter-active,
  .cs-conversation-list-leave-active,
  .cs-conversation-list-move,
  .cs-message-stack-enter-active,
  .cs-message-stack-leave-active,
  .cs-message-stack-move {
    transition: none;
  }

  .cs-message.is-fresh .cs-message__bubble,
  .cs-conversation-item.is-fresh {
    animation: none;
  }
}

@media (max-width: 767px) {
  .cs-statusbar__tip {
    display: none;
  }

  .cs-thread__head {
    flex-direction: column;
  }

  .cs-thread__head > div:last-child {
    justify-content: flex-start;
  }

  .cs-message {
    max-width: 88%;
  }

  .cs-composer__toolbar {
    flex-wrap: wrap;
  }
}

/*
 * 统一滚动条观感：内部滚动区域较多，弱化滚动条存在感但保留拖拽面积。
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
