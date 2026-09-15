<script setup lang="ts">
/**
 * 模块说明：src/views/system/AuditLogView.vue
 * 文件职责：提供系统审计日志查询页，承接操作日志的业务类别筛选、分页浏览、结果导出，以及按事件聚合的通知事件查看。
 * 实现逻辑：
 * - 页面分为“操作日志 / 通知事件”两个页签，当前页签同步到路由 query.tab，刷新或分享链接后保持所在页签；
 * - 操作日志以“业务类别 → 操作类型”二级联动筛选，类别与动作映射、目标对象中文名均由后端下发，不在前端模糊推断；
 * - 未选择业务类别与操作类型时，后端默认隐藏通知内部处理记录，改在“通知事件”页签按 eventId 聚合展示；
 * - 业务类别标签按后端下发的重要程度着色（高风险/重要/常规业务/一般），筛选下拉与图例使用同一配色；
 * - 列表查询与导出共用 buildQueryParams，保证导出结果与当前筛选口径完全一致。
 * 维护说明：
 * - 若后续新增审计字段，优先同步补齐查询条件、表格列与导出列映射；
 * - 审计日志页面只负责展示与导出，不应在前端侧改写服务端留痕语义。
 */


import dayjs from 'dayjs'
import { computed, defineAsyncComponent, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { BizResponsiveDataCollectionShell, PageContainer, PagePaginationBar, PageToolbarCard } from '@/components/common'
import PassiveSegmentedTabs from '@/components/common/page-shared/PassiveSegmentedTabs.vue'
import {
  exportAuditLogs,
  getAuditLogFilterOptions,
  getAuditLogList,
  type AuditCategoryKey,
  type AuditFilterOptions,
  type AuditLogListQuery,
  type AuditLogRecord,
} from '@/api/modules/audit'
import { usePermissionAction } from '@/composables/usePermissionAction'
import { useStableRequest } from '@/composables/useStableRequest'
import { applyPaginatedResult, createPaginatedListState } from '@/utils/list'
import { extractErrorMessage } from '@/utils/error'

import { showAppError, showAppSuccess } from '@/utils/app-alert'
import {
  CATEGORY_IMPORTANCE_META,
  CATEGORY_IMPORTANCE_ORDER,
  getCategoryDotClass,
  getCategoryTagType,
} from './category-importance'

// 通知事件面板按需异步加载：只有进入“通知事件”页签才下载对应分包，保持审计日志路由首包在性能预算内。
const NotificationEventLogPanel = defineAsyncComponent(() => import('./components/NotificationEventLogPanel.vue'))

type AuditTabKey = 'operation' | 'notification'

// 页签复用共享轻量分段标签，不引入 el-tabs，避免新增组件样式进入首屏公共包。
const AUDIT_TABS = [
  { label: '操作日志', name: 'operation' },
  { label: '通知事件', name: 'notification' },
] as const

const route = useRoute()
const router = useRouter()

const resolveTabFromQuery = (value: unknown): AuditTabKey => (value === 'notification' ? 'notification' : 'operation')
const activeTab = ref<AuditTabKey>(resolveTabFromQuery(route.query.tab))
// 通知事件页签首次激活后才挂载，避免打开审计页时额外请求通知事件列表。
const notificationTabMounted = ref(activeTab.value === 'notification')
const focusNotificationEventId = ref('')

/**
 * 审计日志筛选表单：
 * - category 为业务类别一级筛选，actionType 为该类别下的操作类型二级筛选；
 * - targetType 对业务对象做过滤；
 * - targetId 保留精确追溯入口，便于串联单据与审计日志；
 * - timeRange 为时间范围筛选条件。
 */
const searchForm = reactive({
  category: '' as '' | AuditCategoryKey,
  actionType: '',
  targetType: '',
  targetId: '',
  timeRange: [] as [Date, Date] | [] | null,
})

/**
 * 读取已选时间范围：
 * - el-date-picker 点击清空后会把绑定值置为 null，不能直接读取 length；
 * - 只有完整的起止时间才参与筛选、摘要与导出。
 */
const getSelectedTimeRange = (): [Date, Date] | null => {
  const range = searchForm.timeRange
  return Array.isArray(range) && range.length === 2 ? range : null
}

/**
 * 审计列表分页状态：
 * - 复用统一分页状态结构；
 * - records 用于表格与卡片视图共享数据源。
 */
const listState = reactive(createPaginatedListState<AuditLogRecord>({
  loading: true,
  query: {
    pageSize: 12,
  },
}))

/**
 * 当前登录用户权限：
 * - audit_logs:view 控制列表查看；
 * - audit_logs:export 控制导出当前筛选结果按钮。
 */
const listRequest = useStableRequest()
const { hasPermission, ensurePermission } = usePermissionAction()
const canExportAuditLogs = computed(() => hasPermission('audit_logs:export'))
const exportLoading = ref(false)

// 后端下发的筛选项：业务类别（含操作类型）、目标对象中文名与通知事件筛选项。
const filterOptions = ref<AuditFilterOptions | null>(null)

const categoryOptions = computed(() => filterOptions.value?.categories ?? [])

/**
 * 操作类型树：
 * - 一级节点为业务类别，二级节点为该类别下的操作类型，只有叶子节点可选；
 * - 已选择业务类别时只展示该类别并默认展开，未选类别时展示全部类别供逐级展开；
 * - 类别节点值加 `category:` 前缀，避免与动作编码冲突，并设为 disabled：el-tree-select 默认允许选中父节点，
 *   否则点击类别节点会把合成值写入 actionType，后端按不存在的动作编码精确查询导致空结果。
 */
const ACTION_TREE_CATEGORY_PREFIX = 'category:'

const actionTreeData = computed(() => {
  return categoryOptions.value
    .filter((item) => item.actionTypes.length > 0 && (!searchForm.category || item.key === searchForm.category))
    .map((item) => ({
      value: `${ACTION_TREE_CATEGORY_PREFIX}${item.key}`,
      label: item.label,
      disabled: true,
      children: item.actionTypes.map((action) => ({ value: action.value, label: action.label })),
    }))
})

const actionTreeExpandedKeys = computed(() => (searchForm.category ? [`${ACTION_TREE_CATEGORY_PREFIX}${searchForm.category}`] : []))

const targetTypeOptions = computed(() => filterOptions.value?.targetTypes ?? [])

const actionTypeCategoryMap = computed(() => {
  const map = new Map<string, { category: AuditCategoryKey; label: string }>()
  for (const category of categoryOptions.value) {
    for (const action of category.actionTypes) {
      map.set(action.value, { category: category.key, label: action.label })
    }
  }
  return map
})

/**
 * 结果状态标签类型：
 * - success 用成功色突出可追溯的正向动作；
 * - failed 用危险色提醒关注失败尝试。
 */
const getResultTagType = (status: AuditLogRecord['resultStatus']) => {
  return status === 'success' ? 'success' : 'danger'
}

/**
 * 结果状态中文文案：
 * - 统一列表与卡片模式的显示口径；
 * - 让非技术用户也能快速理解执行结果。
 */
const getResultLabel = (status: AuditLogRecord['resultStatus']) => {
  return status === 'success' ? '成功' : '失败'
}

/**
 * 安全解析 detailJson：
 * - 审计详情为 JSON 字符串，页面需做容错解析；
 * - 解析失败时直接回退原字符串，保证页面仍可展示。
 */
const formatDetail = (detailJson: string | null) => {
  if (!detailJson) {
    return '-'
  }

  try {
    return JSON.stringify(JSON.parse(detailJson), null, 2)
  } catch {
    return detailJson
  }
}

const getTargetTypeLabel = (targetType: string) => targetTypeOptions.value.find((item) => item.value === targetType)?.label ?? targetType

/**
 * 当前筛选说明：
 * - 用于导出按钮旁清晰提示“导出的到底是哪一批数据”；
 * - 让业务类别、时间范围、动作类型等关键条件以中文名一眼可见。
 */
const currentFilterSummary = computed(() => {
  const summary: string[] = []

  if (searchForm.category) {
    summary.push(`业务类别=${categoryOptions.value.find((item) => item.key === searchForm.category)?.label ?? searchForm.category}`)
  }
  if (searchForm.actionType) {
    summary.push(`操作类型=${actionTypeCategoryMap.value.get(searchForm.actionType)?.label ?? searchForm.actionType}`)
  }
  if (searchForm.targetType) {
    summary.push(`目标=${getTargetTypeLabel(searchForm.targetType)}`)
  }
  if (searchForm.targetId.trim()) {
    summary.push(`目标ID=${searchForm.targetId.trim()}`)
  }
  const selectedTimeRange = getSelectedTimeRange()
  if (selectedTimeRange) {
    summary.push(
      `时间=${dayjs(selectedTimeRange[0]).format('YYYY-MM-DD HH:mm:ss')} ~ ${dayjs(selectedTimeRange[1]).format('YYYY-MM-DD HH:mm:ss')}`,
    )
  }

  return summary.length > 0 ? summary.join('；') : '全部日志'
})

// 未选择业务类别与操作类型时，后端默认隐藏通知内部处理记录，页面需明确提示避免误以为记录丢失。
const showHiddenNotificationHint = computed(() => !searchForm.category && !searchForm.actionType)

/**
 * 构建查询参数：
 * - 仅在筛选项有值时才注入参数；
 * - 列表查询与导出会共用同一套参数，确保口径一致。
 */
const buildQueryParams = (): AuditLogListQuery => {
  const params: AuditLogListQuery = {
    page: listState.query.page,
    pageSize: listState.query.pageSize,
  }

  if (searchForm.category) {
    params.category = searchForm.category
  }
  if (searchForm.actionType) {
    params.actionType = searchForm.actionType
  }
  if (searchForm.targetType) {
    params.targetType = searchForm.targetType
  }
  if (searchForm.targetId.trim()) {
    params.targetId = searchForm.targetId.trim()
  }
  const selectedTimeRange = getSelectedTimeRange()
  if (selectedTimeRange) {
    params.startAt = selectedTimeRange[0].toISOString()
    params.endAt = selectedTimeRange[1].toISOString()
  }

  return params
}

/**
 * 拉取审计日志列表：
 * - 成功后回填统一分页状态；
 * - 若当前账号无查看权限，则保持空列表并给出稳定提示。
 */
const loadData = async () => {
  // 统一走共享权限动作工具：
  // - 页面首屏加载与手动刷新共用同一套越权提示口径；
  // - 无权限时仍清空列表状态，避免保留上一位用户的旧数据视图。
  if (!ensurePermission('audit_logs:view', '审计日志查看')) {
    listState.loading = false
    listState.records = []
    listState.total = 0
    return
  }

  listState.loading = true
  await listRequest.runLatest({
    executor: (signal) => getAuditLogList(buildQueryParams(), { signal }),
    onSuccess: (result) => {
      applyPaginatedResult(listState, result)
    },
    onError: (error) => {
      showAppError(extractErrorMessage(error, '获取审计日志失败'))
    },
    onFinally: () => {
      listState.loading = false
    },
  })
}

/** 加载筛选项：失败时不阻断列表查询，只提示用户稍后重试。 */
const loadFilterOptions = async () => {
  if (!hasPermission('audit_logs:view')) {
    return
  }
  try {
    filterOptions.value = await getAuditLogFilterOptions()
  } catch (error) {
    showAppError(extractErrorMessage(error, '获取审计筛选项失败'))
  }
}

/**
 * 导出当前筛选结果：
 * - 直接复用 buildQueryParams，保证导出与页面筛选完全一致；
 * - 导出范围覆盖当前筛选命中的全部结果，而不是仅当前分页。
 */
const handleExport = async () => {
  // 导出动作改为共享门禁，避免页面继续散落独立提示逻辑。
  if (!ensurePermission('audit_logs:export', '审计日志导出')) {
    return
  }

  exportLoading.value = true
  try {
    const { page: _page, pageSize: _pageSize, ...filterParams } = buildQueryParams()
    const { blob, fileName } = await exportAuditLogs(filterParams)
    const objectUrl = globalThis.URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = objectUrl
    link.download = fileName
    document.body.appendChild(link)
    link.click()
    link.remove()
    globalThis.URL.revokeObjectURL(objectUrl)
    showAppSuccess('已导出当前筛选结果')
  } catch (error) {
    showAppError(extractErrorMessage(error, '导出审计日志失败'))
  } finally {
    exportLoading.value = false
  }
}

/**
 * 搜索与重置：
 * - 搜索前回到第一页；
 * - 重置后立即刷新，保持系统治理页的标准交互。
 */
const handleSearch = () => {
  listState.query.page = 1
  void loadData()
}

/** 切换业务类别：已选操作类型不属于新类别时清空，保证二级筛选联动收敛。 */
const handleCategoryChange = () => {
  if (searchForm.actionType && actionTypeCategoryMap.value.get(searchForm.actionType)?.category !== searchForm.category) {
    searchForm.actionType = searchForm.category ? '' : searchForm.actionType
  }
  handleSearch()
}

/** 先选操作类型时自动带出所属业务类别，避免一级与二级筛选互相矛盾。 */
const handleActionTypeChange = () => {
  // 兜底：类别父节点已禁用，若仍收到类别合成值（如键盘或组件行为变化），视为未选择操作类型，避免按不存在的动作编码查询。
  if (searchForm.actionType.startsWith(ACTION_TREE_CATEGORY_PREFIX)) {
    searchForm.actionType = ''
  }
  const matched = searchForm.actionType ? actionTypeCategoryMap.value.get(searchForm.actionType) : undefined
  if (matched) {
    searchForm.category = matched.category
  }
  handleSearch()
}

const handleReset = () => {
  searchForm.category = ''
  searchForm.actionType = ''
  searchForm.targetType = ''
  searchForm.targetId = ''
  searchForm.timeRange = []
  handleSearch()
}

/**
 * 分页切换：
 * - 与其他列表页交互一致；
 * - pageSize 变化时自动归位第一页，确保结果稳定。
 */
const handleCurrentChange = (page: number) => {
  listState.query.page = page
  void loadData()
}

const handlePageSizeChange = (pageSize: number) => {
  listState.query.pageSize = pageSize
  listState.query.page = 1
  void loadData()
}

/** 页签切换：同步到路由 query，并在首次进入通知事件页签时挂载面板。 */
const handleTabChange = (tab: string | number) => {
  const nextTab = resolveTabFromQuery(tab)
  activeTab.value = nextTab
  if (nextTab === 'notification') {
    notificationTabMounted.value = true
  }
  if (resolveTabFromQuery(route.query.tab) !== nextTab) {
    void router.replace({ query: { ...route.query, tab: nextTab === 'notification' ? 'notification' : undefined } })
  }
}

/** 从操作日志中的通知事件记录跳转到通知事件页签，并按事件 ID 精确定位。 */
const handleOpenNotificationEvent = (eventId: string | null) => {
  if (!eventId) {
    return
  }
  focusNotificationEventId.value = eventId
  handleTabChange('notification')
}

watch(
  () => route.query.tab,
  (tab) => {
    const nextTab = resolveTabFromQuery(tab)
    if (nextTab !== activeTab.value) {
      handleTabChange(nextTab)
    }
  },
)

/**
 * 卡片模式下详情展示：
 * - 预格式化 JSON 文本，减少模板内重复计算；
 * - 表格模式则通过 tooltip + 弹性换行展示。
 */
const cardRecords = computed(() => {
  return listState.records.map((item) => ({
    ...item,
    detailText: formatDetail(item.detailJson),
  }))
})

onMounted(() => {
  void loadFilterOptions()
  void loadData()
})
</script>

<template>
  <PageContainer title="审计日志" description="按业务类别、操作类型与目标对象检索关键动作留痕，并按事件聚合查看通知处理与外发结果。">
    <div class="flex min-w-0 flex-col gap-4">
      <PassiveSegmentedTabs
        :model-value="activeTab"
        :tabs="AUDIT_TABS"
        aria-label="审计日志页签"
        @tab-change="handleTabChange"
      />

      <div v-show="activeTab === 'operation'" class="flex min-w-0 flex-col gap-4">
        <PageToolbarCard content-class="items-start">
          <template #default="{ isPhone, isTablet }">
            <div class="flex flex-1 flex-wrap items-start gap-2.5">
              <el-select
                v-model="searchForm.category"
                placeholder="业务类别"
                clearable
                :class="isPhone ? '!w-full' : isTablet ? '!w-[176px]' : '!w-[180px]'"
                @change="handleCategoryChange"
              >
                <el-option v-for="item in categoryOptions" :key="item.key" :label="item.label" :value="item.key">
                  <span class="flex items-center gap-2">
                    <span class="inline-block h-2 w-2 shrink-0 rounded-full" :class="getCategoryDotClass(item.level)" />
                    <span>{{ item.label }}</span>
                  </span>
                </el-option>
              </el-select>
              <el-tree-select
                v-model="searchForm.actionType"
                :data="actionTreeData"
                node-key="value"
                placeholder="操作类型"
                clearable
                filterable
                :render-after-expand="false"
                :default-expanded-keys="actionTreeExpandedKeys"
                :class="isPhone ? '!w-full' : isTablet ? '!w-[240px]' : '!w-[260px]'"
                @change="handleActionTypeChange"
              />
              <el-select
                v-model="searchForm.targetType"
                placeholder="目标对象"
                clearable
                filterable
                :class="isPhone ? '!w-full' : isTablet ? '!w-[176px]' : '!w-[180px]'"
                @change="handleSearch"
              >
                <el-option v-for="item in targetTypeOptions" :key="item.value" :label="item.label" :value="item.value" />
              </el-select>
              <el-input
                v-model="searchForm.targetId"
                placeholder="按目标ID追溯"
                clearable
                :class="isPhone ? '!w-full' : isTablet ? '!w-[240px]' : '!w-[220px]'"
                @clear="handleSearch"
                @keyup.enter="handleSearch"
              />
              <el-date-picker
                v-model="searchForm.timeRange"
                type="datetimerange"
                range-separator="至"
                start-placeholder="开始时间"
                end-placeholder="结束时间"
                clearable
                :class="isPhone ? '!w-full' : isTablet ? '!w-[360px]' : '!w-[400px]'"
                @change="handleSearch"
              />
              <el-button :class="isPhone ? 'w-full' : ''" type="primary" icon="Search" @click="handleSearch">搜索</el-button>
              <el-button :class="isPhone ? 'w-full' : ''" icon="Refresh" @click="handleReset">重置</el-button>
            </div>
          </template>

          <template #actions="{ isPhone }">
            <div :class="['flex flex-wrap gap-2', isPhone ? 'w-full' : 'justify-end']">
              <el-button
                v-if="canExportAuditLogs"
                :class="isPhone ? 'w-full' : ''"
                icon="Download"
                :loading="exportLoading"
                @click="handleExport"
              >
                导出当前筛选结果
              </el-button>
            </div>
          </template>
        </PageToolbarCard>

        <div class="rounded-2xl border border-dashed border-brand/20 bg-brand/5 px-4 py-3 text-sm leading-6 text-slate-600 dark:border-brand/20 dark:bg-brand/10 dark:text-slate-300">
          当前筛选条件：{{ currentFilterSummary }}。
          <span v-if="showHiddenNotificationHint">默认隐藏通知规则命中、外发执行等内部处理记录，可在“通知事件”页签按事件查看，或选择“通知中心”类别查询明细。</span>
          <span v-if="canExportAuditLogs">导出按钮会按同一筛选条件导出全部命中结果。</span>
          <div class="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
            <span>业务类别颜色按重要程度区分：</span>
            <el-tag
              v-for="level in CATEGORY_IMPORTANCE_ORDER"
              :key="level"
              :type="CATEGORY_IMPORTANCE_META[level].tagType"
              effect="plain"
              size="small"
            >
              {{ CATEGORY_IMPORTANCE_META[level].label }}
            </el-tag>
          </div>
        </div>

        <div class="apple-card flex min-h-0 flex-1 flex-col p-3 sm:p-4 xl:p-5">
          <BizResponsiveDataCollectionShell
            :items="cardRecords"
            :loading="listState.loading"
            empty-description="暂无审计日志"
            empty-min-height="260px"
            :skeleton-rows="8"
            wrapper-class="flex min-h-0 flex-1 flex-col"
            table-wrapper-class="flex min-h-0 flex-1 flex-col overflow-hidden px-0"
            card-container-class="pb-4"
          >
            <template #table>
              <el-table native-scrollbar :data="listState.records" stripe class="w-full flex-1" height="100%" table-layout="auto">
                <el-table-column label="时间" width="170">
                  <template #default="{ row }">{{ dayjs(row.createdAt).format('YYYY-MM-DD HH:mm:ss') }}</template>
                </el-table-column>
                <el-table-column label="业务类别" width="130">
                  <template #default="{ row }">
                    <el-tag :type="getCategoryTagType(row.categoryLevel)" effect="plain">{{ row.categoryLabel }}</el-tag>
                  </template>
                </el-table-column>
                <el-table-column prop="actionLabel" label="动作" min-width="160" show-overflow-tooltip />
                <el-table-column label="结果" width="90">
                  <template #default="{ row }">
                    <el-tag :type="getResultTagType(row.resultStatus)" effect="light">{{ getResultLabel(row.resultStatus) }}</el-tag>
                  </template>
                </el-table-column>
                <el-table-column label="操作人" min-width="148" show-overflow-tooltip>
                  <template #default="{ row }">{{ row.actorDisplayName || row.actorUsername || '-' }}</template>
                </el-table-column>
                <el-table-column label="目标对象" min-width="210" show-overflow-tooltip>
                  <template #default="{ row }">
                    {{ row.targetTypeLabel }}<span v-if="row.targetCode"> / {{ row.targetCode }}</span>
                    <el-button
                      v-if="row.targetType === 'notification_event' && row.targetId"
                      link
                      type="primary"
                      class="!ml-2"
                      @click="handleOpenNotificationEvent(row.targetId)"
                    >
                      查看通知事件
                    </el-button>
                  </template>
                </el-table-column>
                <el-table-column label="详情" min-width="420" show-overflow-tooltip>
                  <template #default="{ row }">
                    <pre class="max-h-[92px] overflow-hidden whitespace-pre-wrap break-all text-xs leading-5 text-slate-500 dark:text-slate-400">{{ formatDetail(row.detailJson) }}</pre>
                  </template>
                </el-table-column>
              </el-table>
            </template>

            <template #card="{ item }">
              <div class="apple-card flex min-w-0 flex-col gap-3 p-4">
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <div class="text-base font-semibold text-slate-800 dark:text-slate-100">{{ item.actionLabel }}</div>
                    <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">{{ dayjs(item.createdAt).format('YYYY-MM-DD HH:mm:ss') }}</div>
                  </div>
                  <el-tag :type="getResultTagType(item.resultStatus)" effect="light">{{ getResultLabel(item.resultStatus) }}</el-tag>
                </div>

                <div class="grid gap-2 rounded-2xl bg-slate-50 p-3 text-sm text-slate-600 dark:bg-white/5 dark:text-slate-300">
                  <div class="flex items-center justify-between gap-3">
                    <span class="text-slate-400">业务类别</span>
                    <el-tag :type="getCategoryTagType(item.categoryLevel)" effect="plain" size="small">{{ item.categoryLabel }}</el-tag>
                  </div>
                  <div class="flex items-center justify-between gap-3">
                    <span class="text-slate-400">操作人</span>
                    <span>{{ item.actorDisplayName || item.actorUsername || '-' }}</span>
                  </div>
                  <div class="flex items-center justify-between gap-3">
                    <span class="text-slate-400">动作编码</span>
                    <span class="min-w-0 break-all text-right">{{ item.actionType }}</span>
                  </div>
                  <div class="flex items-center justify-between gap-3">
                    <span class="text-slate-400">目标对象</span>
                    <span class="min-w-0 break-all text-right">{{ item.targetTypeLabel }}<span v-if="item.targetCode"> / {{ item.targetCode }}</span></span>
                  </div>
                </div>

                <el-button
                  v-if="item.targetType === 'notification_event' && item.targetId"
                  class="w-full"
                  @click="handleOpenNotificationEvent(item.targetId)"
                >
                  查看通知事件
                </el-button>

                <div class="rounded-2xl border border-dashed border-slate-200 p-3 text-xs leading-6 text-slate-500 dark:border-white/10 dark:text-slate-400">
                  <div class="mb-1 font-semibold text-slate-700 dark:text-slate-200">详情上下文</div>
                  <pre class="whitespace-pre-wrap break-all font-sans">{{ item.detailText }}</pre>
                </div>
              </div>
            </template>
          </BizResponsiveDataCollectionShell>

          <PagePaginationBar
            v-if="listState.total > 0"
            v-model:current-page="listState.query.page"
            v-model:page-size="listState.query.pageSize"
            layout="total, sizes, prev, pager, next, jumper"
            :page-sizes="[12, 20, 50]"
            :total="listState.total"
            @current-change="handleCurrentChange"
            @size-change="handlePageSizeChange"
          />
        </div>
      </div>

      <NotificationEventLogPanel
        v-if="notificationTabMounted"
        v-show="activeTab === 'notification'"
        :filter-options="filterOptions?.notificationEvent ?? null"
        :focus-event-id="focusNotificationEventId"
      />
    </div>
  </PageContainer>
</template>
