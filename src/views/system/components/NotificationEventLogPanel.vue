<script setup lang="ts">
/**
 * 模块说明：src/views/system/components/NotificationEventLogPanel.vue
 * 文件职责：审计日志页“通知事件”页签，按通知事件（eventId）聚合展示业务分类、事件类型、处理结果、外发渠道数量与处理详情。
 * 实现逻辑：
 * - 主列表以通知事件为单位分页，同一业务事件即使经历多次外发重试也只显示一条主记录；
 * - 支持业务分类 → 事件类型联动、处理结果、外发渠道、时间范围与事件 ID 筛选，筛选项由后端常量下发；
 * - 桌面表格使用展开行、手机/平板卡片使用展开按钮查看详情，详情首次展开时请求并按事件 ID 缓存；
 * - 列表请求接入稳定请求工具，快速切换筛选或翻页时旧结果不会覆盖新状态；
 * - 业务分类标签按后端下发的重要程度着色，与操作日志业务类别共用同一配色与图例。
 * 维护说明：
 * - “外发成功”只代表实际外发成功，处理结果口径以后端推导为准，前端不得自行根据审计记录改写；
 * - 从操作日志跳转时通过 focusEventId 精确定位事件，修改筛选逻辑时需保留该入口。
 */

import dayjs from 'dayjs'
import { computed, onMounted, reactive, watch } from 'vue'

import { BizResponsiveDataCollectionShell, PagePaginationBar, PageToolbarCard } from '@/components/common'
import {
  getNotificationEventLogDetail,
  getNotificationEventLogList,
  type NotificationEventFilterOptions,
  type NotificationEventLogDetail,
  type NotificationEventLogQuery,
  type NotificationEventLogRecord,
  type NotificationEventResultStatus,
} from '@/api/modules/audit'
import { useStableRequest } from '@/composables/useStableRequest'
import { applyPaginatedResult, createPaginatedListState } from '@/utils/list'
import { extractErrorMessage } from '@/utils/error'
import { showAppError } from '@/utils/app-alert'
import NotificationEventDetailContent from './NotificationEventDetailContent.vue'
import {
  CATEGORY_IMPORTANCE_META,
  CATEGORY_IMPORTANCE_ORDER,
  getCategoryDotClass,
  getCategoryTagType,
} from '../category-importance'

const props = defineProps<{
  filterOptions: NotificationEventFilterOptions | null
  /** 从操作日志跳转时指定的事件 ID，变化后自动按该事件精确筛选。 */
  focusEventId: string
}>()

const searchForm = reactive({
  category: '' as '' | NotificationEventLogQuery['category'],
  eventType: '',
  resultStatus: '' as '' | NotificationEventResultStatus,
  channel: '' as '' | NonNullable<NotificationEventLogQuery['channel']>,
  eventId: '',
  timeRange: [] as [Date, Date] | [] | null,
})

// el-date-picker 清空后绑定值为 null，只有完整起止时间才参与筛选。
const getSelectedTimeRange = (): [Date, Date] | null => {
  const range = searchForm.timeRange
  return Array.isArray(range) && range.length === 2 ? range : null
}

const listState = reactive(createPaginatedListState<NotificationEventLogRecord>({
  loading: true,
  query: {
    pageSize: 10,
  },
}))
const listRequest = useStableRequest()

// 详情缓存：按事件 ID 记录加载态、错误与数据，展开行与卡片共用。
const detailStateMap = reactive<Record<string, { loading: boolean; error: string; data: NotificationEventLogDetail | null }>>({})
const expandedCardIds = reactive(new Set<string>())

const categoryOptions = computed(() => props.filterOptions?.categories ?? [])
const eventTypeOptions = computed(() => {
  const categories = categoryOptions.value
  const scoped = searchForm.category ? categories.filter((item) => item.key === searchForm.category) : categories
  return scoped.flatMap((item) => item.eventTypes)
})
const resultStatusOptions = computed(() => props.filterOptions?.resultStatuses ?? [])
const channelOptions = computed(() => props.filterOptions?.channels ?? [])

const RESULT_TAG_TYPE: Record<NotificationEventResultStatus, 'success' | 'danger' | 'warning' | 'info'> = {
  success: 'success',
  internal_only: 'info',
  pending: 'warning',
  processing: 'warning',
  retrying: 'warning',
  partial_failed: 'danger',
  failed: 'danger',
}

const formatTime = (value: string | null | undefined) => (value ? dayjs(value).format('YYYY-MM-DD HH:mm:ss') : '-')

/** 外发数量摘要：展示邮件/飞书实际发送与失败数量，没有外发时明确提示。 */
const formatDispatchSummary = (record: NotificationEventLogRecord) => {
  const parts: string[] = []
  const { email, feishu } = record.dispatchSummary
  if (email.total) {
    parts.push(`邮件 成功 ${email.sent} / 失败 ${email.failed}${email.pending ? ` / 待发 ${email.pending}` : ''}`)
  }
  if (feishu.total) {
    parts.push(`飞书 成功 ${feishu.sent} / 失败 ${feishu.failed}${feishu.pending ? ` / 待发 ${feishu.pending}` : ''}`)
  }
  return parts.length ? parts.join('；') : '无外发'
}

const buildQueryParams = (): NotificationEventLogQuery => {
  const params: NotificationEventLogQuery = {
    page: listState.query.page,
    pageSize: listState.query.pageSize,
  }
  if (searchForm.category) params.category = searchForm.category
  if (searchForm.eventType) params.eventType = searchForm.eventType
  if (searchForm.resultStatus) params.resultStatus = searchForm.resultStatus
  if (searchForm.channel) params.channel = searchForm.channel
  if (searchForm.eventId.trim()) params.eventId = searchForm.eventId.trim()
  const selectedTimeRange = getSelectedTimeRange()
  if (selectedTimeRange) {
    params.startAt = selectedTimeRange[0].toISOString()
    params.endAt = selectedTimeRange[1].toISOString()
  }
  return params
}

const loadData = async () => {
  listState.loading = true
  await listRequest.runLatest({
    executor: (signal) => getNotificationEventLogList(buildQueryParams(), { signal }),
    onSuccess: (result) => {
      applyPaginatedResult(listState, result)
      expandedCardIds.clear()
    },
    onError: (error) => {
      showAppError(extractErrorMessage(error, '获取通知事件失败'))
    },
    onFinally: () => {
      listState.loading = false
    },
  })
}

const loadDetail = async (eventId: string) => {
  const cached = detailStateMap[eventId]
  if (cached && (cached.loading || cached.data)) {
    return
  }
  detailStateMap[eventId] = { loading: true, error: '', data: null }
  try {
    const data = await getNotificationEventLogDetail(eventId)
    detailStateMap[eventId] = { loading: false, error: '', data }
  } catch (error) {
    detailStateMap[eventId] = { loading: false, error: extractErrorMessage(error, '获取通知事件详情失败'), data: null }
  }
}

const getDetailState = (eventId: string) => detailStateMap[eventId] ?? { loading: true, error: '', data: null }

const handleExpandChange = (row: NotificationEventLogRecord, expandedRows: NotificationEventLogRecord[]) => {
  if (expandedRows.some((item) => item.id === row.id)) {
    void loadDetail(row.id)
  }
}

const handleToggleCard = (eventId: string) => {
  if (expandedCardIds.has(eventId)) {
    expandedCardIds.delete(eventId)
    return
  }
  expandedCardIds.add(eventId)
  void loadDetail(eventId)
}

const handleCategoryChange = () => {
  // 切换业务分类后，若已选事件类型不属于新分类则清空，保持二级筛选联动一致。
  if (searchForm.eventType && !eventTypeOptions.value.some((item) => item.value === searchForm.eventType)) {
    searchForm.eventType = ''
  }
  handleSearch()
}

const handleSearch = () => {
  listState.query.page = 1
  void loadData()
}

const handleReset = () => {
  searchForm.category = ''
  searchForm.eventType = ''
  searchForm.resultStatus = ''
  searchForm.channel = ''
  searchForm.eventId = ''
  searchForm.timeRange = []
  handleSearch()
}

const handleCurrentChange = (page: number) => {
  listState.query.page = page
  void loadData()
}

const handlePageSizeChange = (pageSize: number) => {
  listState.query.pageSize = pageSize
  listState.query.page = 1
  void loadData()
}

watch(
  () => props.focusEventId,
  (eventId, previousEventId) => {
    if (!eventId || eventId === previousEventId) {
      return
    }
    searchForm.category = ''
    searchForm.eventType = ''
    searchForm.resultStatus = ''
    searchForm.channel = ''
    searchForm.timeRange = []
    searchForm.eventId = eventId
    handleSearch()
  },
)

onMounted(() => {
  if (props.focusEventId) {
    searchForm.eventId = props.focusEventId
  }
  void loadData()
})
</script>

<template>
  <div class="flex min-w-0 flex-col gap-4">
    <PageToolbarCard content-class="items-start">
      <template #default="{ isPhone, isTablet }">
        <div class="flex flex-1 flex-wrap items-start gap-2.5">
          <el-select
            v-model="searchForm.category"
            placeholder="业务分类"
            clearable
            :class="isPhone ? '!w-full' : isTablet ? '!w-[160px]' : '!w-[160px]'"
            @change="handleCategoryChange"
          >
            <el-option v-for="item in categoryOptions" :key="item.key" :label="item.label" :value="item.key">
              <span class="flex items-center gap-2">
                <span class="inline-block h-2 w-2 shrink-0 rounded-full" :class="getCategoryDotClass(item.level)" />
                <span>{{ item.label }}</span>
              </span>
            </el-option>
          </el-select>
          <el-select
            v-model="searchForm.eventType"
            placeholder="事件类型"
            clearable
            :class="isPhone ? '!w-full' : isTablet ? '!w-[200px]' : '!w-[220px]'"
            @change="handleSearch"
          >
            <el-option v-for="item in eventTypeOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <el-select
            v-model="searchForm.resultStatus"
            placeholder="处理结果"
            clearable
            :class="isPhone ? '!w-full' : '!w-[160px]'"
            @change="handleSearch"
          >
            <el-option v-for="item in resultStatusOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <el-select
            v-model="searchForm.channel"
            placeholder="外发渠道"
            clearable
            :class="isPhone ? '!w-full' : '!w-[140px]'"
            @change="handleSearch"
          >
            <el-option v-for="item in channelOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <el-input
            v-model="searchForm.eventId"
            placeholder="事件 ID"
            clearable
            :class="isPhone ? '!w-full' : '!w-[160px]'"
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
    </PageToolbarCard>

    <div class="rounded-2xl border border-dashed border-brand/20 bg-brand/5 px-4 py-3 text-sm leading-6 text-slate-600 dark:border-brand/20 dark:bg-brand/10 dark:text-slate-300">
      同一通知事件只展示一条记录，展开后查看规则命中、外发渠道、重试次数与失败原因。“外发成功”仅表示邮件/飞书实际发送成功。
      <div class="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
        <span>业务分类颜色按重要程度区分：</span>
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
        :items="listState.records"
        :loading="listState.loading"
        empty-description="暂无通知事件"
        empty-min-height="260px"
        :skeleton-rows="6"
        wrapper-class="flex min-h-0 flex-1 flex-col"
        table-wrapper-class="flex min-h-0 flex-1 flex-col overflow-hidden px-0"
        card-container-class="pb-4"
      >
        <template #table>
          <el-table
            native-scrollbar
            :data="listState.records"
            row-key="id"
            stripe
            class="w-full flex-1"
            height="100%"
            table-layout="auto"
            @expand-change="handleExpandChange"
          >
            <el-table-column type="expand">
              <template #default="{ row }">
                <NotificationEventDetailContent
                  :loading="getDetailState(row.id).loading"
                  :error="getDetailState(row.id).error"
                  :detail="getDetailState(row.id).data"
                />
              </template>
            </el-table-column>
            <el-table-column label="时间" width="170">
              <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
            </el-table-column>
            <el-table-column label="业务分类" width="110">
              <template #default="{ row }">
                <el-tag :type="getCategoryTagType(row.categoryLevel)" effect="plain">{{ row.categoryLabel }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="通知事件" min-width="220" show-overflow-tooltip>
              <template #default="{ row }">
                {{ row.eventTypeLabel }}<span class="text-slate-400"> · {{ row.summary }}</span>
              </template>
            </el-table-column>
            <el-table-column label="处理结果" width="130">
              <template #default="{ row }">
                <el-tag :type="RESULT_TAG_TYPE[row.resultStatus as NotificationEventResultStatus]" effect="light">{{ row.resultLabel }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="外发结果" min-width="240" show-overflow-tooltip>
              <template #default="{ row }">{{ formatDispatchSummary(row) }}</template>
            </el-table-column>
            <el-table-column label="失败次数" width="100">
              <template #default="{ row }">{{ row.attemptCount }} / {{ row.maxAttempts }}</template>
            </el-table-column>
            <el-table-column label="事件 ID" width="110" prop="id" />
          </el-table>
        </template>

        <template #card="{ item }">
          <div class="apple-card flex min-w-0 flex-col gap-3 p-4">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="break-words text-base font-semibold text-slate-800 dark:text-slate-100">{{ item.eventTypeLabel }}</div>
                <div class="mt-1 break-words text-xs text-slate-500 dark:text-slate-400">{{ item.summary }} · {{ formatTime(item.createdAt) }}</div>
              </div>
              <el-tag :type="RESULT_TAG_TYPE[item.resultStatus as NotificationEventResultStatus]" effect="light">{{ item.resultLabel }}</el-tag>
            </div>
            <div class="grid gap-2 rounded-2xl bg-slate-50 p-3 text-sm text-slate-600 dark:bg-white/5 dark:text-slate-300">
              <div class="flex items-center justify-between gap-3">
                <span class="text-slate-400">业务分类</span>
                <el-tag :type="getCategoryTagType(item.categoryLevel)" effect="plain" size="small">{{ item.categoryLabel }}</el-tag>
              </div>
              <div class="flex items-start justify-between gap-3">
                <span class="shrink-0 text-slate-400">外发结果</span>
                <span class="min-w-0 break-words text-right">{{ formatDispatchSummary(item) }}</span>
              </div>
              <div class="flex items-center justify-between gap-3">
                <span class="text-slate-400">失败次数</span>
                <span>{{ item.attemptCount }} / {{ item.maxAttempts }}</span>
              </div>
              <div class="flex items-center justify-between gap-3">
                <span class="text-slate-400">事件 ID</span>
                <span>{{ item.id }}</span>
              </div>
            </div>
            <el-button class="w-full" @click="handleToggleCard(item.id)">
              {{ expandedCardIds.has(item.id) ? '收起处理详情' : '查看处理详情' }}
            </el-button>
            <NotificationEventDetailContent
              v-if="expandedCardIds.has(item.id)"
              :loading="getDetailState(item.id).loading"
              :error="getDetailState(item.id).error"
              :detail="getDetailState(item.id).data"
            />
          </div>
        </template>
      </BizResponsiveDataCollectionShell>

      <PagePaginationBar
        v-if="listState.total > 0"
        v-model:current-page="listState.query.page"
        v-model:page-size="listState.query.pageSize"
        layout="total, sizes, prev, pager, next, jumper"
        :page-sizes="[10, 20, 50]"
        :total="listState.total"
        @current-change="handleCurrentChange"
        @size-change="handlePageSizeChange"
      />
    </div>
  </div>
</template>
