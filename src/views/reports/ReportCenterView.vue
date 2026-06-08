<script setup lang="ts">
/**
 * 模块说明：src/views/reports/ReportCenterView.vue
 * 文件职责：提供管理端报表中心页面，承接库存、标签销售、金蝶、散客和出库流水的查看与导出。
 * 实现逻辑：
 * - 页面以报表类型为主入口，统一维护时间段、标签、字段勾选和分页预览参数；
 * - 报表预览与 Excel 导出共用同一套查询参数，避免用户看到的列表与导出的文件口径不一致；
 * - 字段勾选只负责用户偏好，最终字段白名单仍由后端报表服务二次校验。
 * 维护说明：
 * - 新增报表类型时需要同步补齐本页字段定义、报表说明和后端 ReportType；
 * - 库存表第一版采用当前库存快照，不在页面层伪造月度库存回算。
 */

import dayjs from 'dayjs'
import { Download, List, Refresh, Search, View } from '@element-plus/icons-vue'
import { computed, onMounted, reactive, ref } from 'vue'
import {
  BizResponsiveDataCollectionShell,
  PageContainer,
  PagePaginationBar,
  PageToolbarCard,
} from '@/components/common'
import { useAppStore } from '@/store'
import pinia from '@/store/pinia'
import { exportReportExcel, getReportData, type ReportFieldDefinition, type ReportRow, type ReportType } from '@/api/modules/report'
import { getTagList, type Tag } from '@/api/modules/tag'
import { usePermissionAction } from '@/composables/usePermissionAction'
import { useStableRequest } from '@/composables/useStableRequest'
import { applyPaginatedResult, createPaginatedListState } from '@/utils/list'
import { extractErrorMessage } from '@/utils/error'
import { showAppError, showAppSuccess, showAppWarning } from '@/utils/app-alert'

interface ReportTypeOption {
  label: string
  value: ReportType
  description: string
}

const reportTypeOptions: ReportTypeOption[] = [
  { label: '库存一览表', value: 'inventory', description: '按当前商品库存快照查看品类、售价、库存与状态。' },
  { label: '标签销售汇总表', value: 'tag-sales', description: '按时间段和标签查看商品销售明细，适用于品宣、联名、海右等分类查账。' },
  { label: '金蝶汇总表', value: 'kingdee', description: '仅统计部门单，包含部门、领取人、出库单与系统申请状态。' },
  { label: '散客汇总表', value: 'walkin', description: '仅统计个人购买，保留商品、数量、金额、领取人和操作人员。' },
  { label: '出库单流水表', value: 'outbound-flow', description: '按出库主单生成流水，包含单号、购买类型、金额和操作人员。' },
]

const reportFieldOptions: Record<ReportType, ReportFieldDefinition[]> = {
  inventory: [
    { key: 'category', label: '品类', width: 18 },
    { key: 'productCode', label: '商品编码', width: 18 },
    { key: 'productName', label: '商品名称', width: 28 },
    { key: 'defaultPrice', label: '售价', width: 14, numeric: true },
    { key: 'currentStock', label: '当前库存', width: 14, numeric: true },
    { key: 'preOrderedStock', label: '预订库存', width: 14, numeric: true },
    { key: 'availableStock', label: '可用库存', width: 14, numeric: true },
    { key: 'status', label: '状态', width: 12 },
  ],
  'tag-sales': [
    { key: 'time', label: '时间', width: 20 },
    { key: 'tags', label: '标签', width: 20 },
    { key: 'productName', label: '商品名称', width: 28 },
    { key: 'qty', label: '数量', width: 12, numeric: true },
    { key: 'unitPrice', label: '单价', width: 12, numeric: true },
    { key: 'amount', label: '总价', width: 14, numeric: true },
    { key: 'departmentName', label: '部门', width: 22 },
    { key: 'receiverName', label: '领取人', width: 18 },
    { key: 'showNo', label: '单号', width: 20 },
    { key: 'operatorName', label: '订单操作记录人员', width: 20 },
  ],
  kingdee: [
    { key: 'time', label: '时间', width: 20 },
    { key: 'productName', label: '商品名称', width: 28 },
    { key: 'qty', label: '数量', width: 12, numeric: true },
    { key: 'unitPrice', label: '单价', width: 12, numeric: true },
    { key: 'amount', label: '金额', width: 14, numeric: true },
    { key: 'departmentName', label: '部门', width: 22 },
    { key: 'receiverName', label: '领取人', width: 18 },
    { key: 'hasCustomerOrder', label: '是否有出库单', width: 16 },
    { key: 'isSystemApplied', label: '是否系统申请', width: 16 },
    { key: 'operatorName', label: '订单操作记录人员', width: 20 },
  ],
  walkin: [
    { key: 'time', label: '时间', width: 20 },
    { key: 'productName', label: '商品名称', width: 28 },
    { key: 'qty', label: '数量', width: 12, numeric: true },
    { key: 'unitPrice', label: '单价', width: 12, numeric: true },
    { key: 'amount', label: '金额', width: 14, numeric: true },
    { key: 'receiverName', label: '领取人', width: 18 },
    { key: 'operatorName', label: '订单操作记录人员', width: 20 },
  ],
  'outbound-flow': [
    { key: 'time', label: '时间', width: 20 },
    { key: 'showNo', label: '单号', width: 20 },
    { key: 'orderType', label: '购买类型', width: 14 },
    { key: 'totalQty', label: '总数量', width: 12, numeric: true },
    { key: 'totalAmount', label: '金额', width: 14, numeric: true },
    { key: 'departmentName', label: '部门', width: 22 },
    { key: 'receiverName', label: '领取人', width: 18 },
    { key: 'issuerName', label: '值班人员', width: 18 },
    { key: 'operatorName', label: '操作人员', width: 20 },
    { key: 'hasCustomerOrder', label: '是否有出库单', width: 16 },
    { key: 'isSystemApplied', label: '是否系统申请', width: 16 },
    { key: 'recordStatus', label: '记录状态', width: 14 },
  ],
}

const reportType = ref<ReportType>('inventory')
const dateRange = ref<[Date, Date] | []>([])
const selectedTagIds = ref<string[]>([])
const selectedFieldKeys = ref<string[]>(reportFieldOptions.inventory.map((field) => field.key))
const tags = ref<Tag[]>([])
const tagsLoading = ref(false)
const exportLoading = ref(false)
const exportPreviewVisible = ref(false)
const reportRequest = useStableRequest()
const appStore = useAppStore(pinia)
const { hasPermission, ensurePermission } = usePermissionAction()
const canExportReports = computed(() => hasPermission('reports:export'))

const listState = reactive(createPaginatedListState<ReportRow>({
  loading: true,
  query: {
    pageSize: 20,
  },
}))

const currentReportOption = computed(() => reportTypeOptions.find((item) => item.value === reportType.value) ?? reportTypeOptions[0])
const currentAvailableFields = computed(() => reportFieldOptions[reportType.value])
const displayFields = computed(() => {
  const selectedKeySet = new Set(selectedFieldKeys.value)
  return currentAvailableFields.value.filter((field) => selectedKeySet.has(field.key))
})
const exportPreviewRows = computed(() => listState.records.slice(0, 6))
const exportPreviewSummary = computed(() => {
  const totalText = listState.total > 0 ? `预计导出 ${listState.total} 条命中数据` : '当前条件暂无命中数据'
  return `${totalText}；已选 ${displayFields.value.length} 个字段`
})
const mobileCardTitleField = computed(() => {
  return displayFields.value.find((field) => ['productName', 'showNo', 'category', 'time'].includes(field.key)) ?? displayFields.value[0]
})
const mobileCardSubtitleFields = computed(() => {
  const titleKey = mobileCardTitleField.value?.key
  return displayFields.value
    .filter((field) => field.key !== titleKey && ['time', 'showNo', 'tags', 'departmentName', 'receiverName', 'operatorName', 'status', 'recordStatus'].includes(field.key))
    .slice(0, 2)
})
const mobileCardMetricFields = computed(() => {
  const excludedKeys = new Set([
    mobileCardTitleField.value?.key,
    ...mobileCardSubtitleFields.value.map((field) => field.key),
  ].filter(Boolean))
  return displayFields.value
    .filter((field) => field.numeric && !excludedKeys.has(field.key))
    .slice(0, 3)
})
const mobileCardDetailFields = computed(() => {
  const excludedKeys = new Set([
    mobileCardTitleField.value?.key,
    ...mobileCardSubtitleFields.value.map((field) => field.key),
    ...mobileCardMetricFields.value.map((field) => field.key),
  ].filter(Boolean))
  return displayFields.value.filter((field) => !excludedKeys.has(field.key))
})
const mobilePreviewDetailFields = computed(() => {
  const titleKey = mobileCardTitleField.value?.key
  return displayFields.value.filter((field) => field.key !== titleKey)
})
const paginationLayout = computed(() => appStore.isPhone ? 'total, prev, next' : 'total, sizes, prev, pager, next, jumper')
const paginationPageSizes = computed(() => appStore.isPhone ? [10, 20, 50] : [10, 20, 50, 100])
const showTagFilter = computed(() => reportType.value !== 'outbound-flow')
const showDateFilter = computed(() => reportType.value !== 'inventory')
const currentFilterSummary = computed(() => {
  const parts = [currentReportOption.value.label]
  if (showDateFilter.value && dateRange.value.length === 2) {
    parts.push(`${dayjs(dateRange.value[0]).format('YYYY-MM-DD')} 至 ${dayjs(dateRange.value[1]).format('YYYY-MM-DD')}`)
  } else if (showDateFilter.value) {
    parts.push('全部时间')
  }
  if (showTagFilter.value && selectedTagIds.value.length > 0) {
    const tagNameMap = new Map(tags.value.map((tag) => [tag.id, tag.tagName]))
    parts.push(`标签：${selectedTagIds.value.map((tagId) => tagNameMap.get(tagId) ?? tagId).join('、')}`)
  }
  parts.push(`字段：${displayFields.value.map((field) => field.label).join('、')}`)
  return parts.join('；')
})

const normalizeSelectedFields = () => {
  const availableKeys = new Set(currentAvailableFields.value.map((field) => field.key))
  const nextFieldKeys = selectedFieldKeys.value.filter((fieldKey) => availableKeys.has(fieldKey))
  const hasChanged =
    nextFieldKeys.length !== selectedFieldKeys.value.length ||
    nextFieldKeys.some((fieldKey, index) => fieldKey !== selectedFieldKeys.value[index])

  if (hasChanged) {
    selectedFieldKeys.value = nextFieldKeys
  }
}

const buildQueryParams = () => {
  normalizeSelectedFields()
  const params = {
    page: listState.query.page,
    pageSize: listState.query.pageSize,
    fields: selectedFieldKeys.value,
    tagIds: showTagFilter.value ? selectedTagIds.value : [],
    startDate: undefined as string | undefined,
    endDate: undefined as string | undefined,
  }
  if (showDateFilter.value && dateRange.value.length === 2) {
    params.startDate = dayjs(dateRange.value[0]).format('YYYY-MM-DD')
    params.endDate = dayjs(dateRange.value[1]).format('YYYY-MM-DD')
  }
  return params
}

const loadTags = async () => {
  tagsLoading.value = true
  try {
    tags.value = await getTagList()
  } catch (error) {
    showAppError(extractErrorMessage(error, '获取标签失败'))
  } finally {
    tagsLoading.value = false
  }
}

const loadData = async () => {
  if (!ensurePermission('reports:view', '报表中心查看')) {
    listState.loading = false
    listState.records = []
    listState.total = 0
    return
  }
  if (!selectedFieldKeys.value.length) {
    showAppWarning('请至少选择一个展示字段')
    return
  }

  listState.loading = true
  await reportRequest.runLatest({
    executor: (signal) => getReportData(reportType.value, buildQueryParams(), { signal }),
    onSuccess: (result) => {
      applyPaginatedResult(listState, result)
    },
    onError: (error) => {
      showAppError(extractErrorMessage(error, '获取报表数据失败'))
    },
    onFinally: () => {
      listState.loading = false
    },
  })
}

const handleSearch = () => {
  listState.query.page = 1
  void loadData()
}

const handleReset = () => {
  dateRange.value = []
  selectedTagIds.value = []
  selectedFieldKeys.value = currentAvailableFields.value.map((field) => field.key)
  handleSearch()
}

const handleReportTypeChange = () => {
  selectedTagIds.value = []
  selectedFieldKeys.value = currentAvailableFields.value.map((field) => field.key)
  listState.query.page = 1
  void loadData()
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

const handleOpenExportPreview = () => {
  if (!ensurePermission('reports:export', '报表导出')) {
    return
  }
  if (listState.loading) {
    showAppWarning('报表数据仍在加载，请稍候再导出')
    return
  }
  normalizeSelectedFields()
  if (!selectedFieldKeys.value.length) {
    showAppWarning('请至少选择一个导出字段')
    return
  }

  exportPreviewVisible.value = true
}

const handleExport = async () => {
  if (!ensurePermission('reports:export', '报表导出')) {
    return
  }
  if (!selectedFieldKeys.value.length) {
    showAppWarning('请至少选择一个导出字段')
    return
  }

  exportLoading.value = true
  try {
    const { page: _page, pageSize: _pageSize, ...filterParams } = buildQueryParams()
    const { blob, fileName } = await exportReportExcel(reportType.value, filterParams)
    const objectUrl = globalThis.URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = objectUrl
    link.download = fileName
    document.body.appendChild(link)
    link.click()
    link.remove()
    globalThis.URL.revokeObjectURL(objectUrl)
    exportPreviewVisible.value = false
    showAppSuccess('已导出当前报表')
  } catch (error) {
    showAppError(extractErrorMessage(error, '导出报表失败'))
  } finally {
    exportLoading.value = false
  }
}

const formatCellValue = (row: ReportRow, field: ReportFieldDefinition) => {
  const value = row[field.key]
  if (value === null || value === undefined || value === '') {
    return '-'
  }
  return String(value)
}

onMounted(() => {
  void loadTags()
  void loadData()
})
</script>

<template>
  <PageContainer title="报表中心" description="查看库存、销售、金蝶、散客和出库流水报表，并按自定义字段导出企业统一模板。">
    <div class="report-center-page flex min-w-0 flex-col gap-4">
      <PageToolbarCard content-class="items-start">
        <template #default="{ isPhone, isTablet }">
          <div :class="['report-filter-grid flex flex-1 flex-wrap items-start gap-2.5', isPhone ? 'w-full' : '']">
            <el-select
              v-model="reportType"
              placeholder="选择报表"
              :class="isPhone ? '!w-full' : isTablet ? '!w-[220px]' : '!w-[240px]'"
              @change="handleReportTypeChange"
            >
              <el-option v-for="item in reportTypeOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
            <el-date-picker
              v-if="showDateFilter"
              v-model="dateRange"
              type="daterange"
              range-separator="至"
              start-placeholder="开始日期"
              end-placeholder="结束日期"
              clearable
              :class="isPhone ? '!w-full report-date-picker--phone' : isTablet ? '!w-[330px]' : '!w-[360px]'"
              @change="handleSearch"
            />
            <el-select
              v-if="showTagFilter"
              v-model="selectedTagIds"
              multiple
              collapse-tags
              collapse-tags-tooltip
              clearable
              filterable
              :loading="tagsLoading"
              placeholder="按标签筛选"
              :class="isPhone ? '!w-full' : isTablet ? '!w-[260px]' : '!w-[300px]'"
              @change="handleSearch"
            >
              <el-option v-for="tag in tags" :key="tag.id" :label="tag.tagName" :value="tag.id" />
            </el-select>
            <div :class="['report-filter-actions flex gap-2', isPhone ? 'w-full' : '']">
              <el-popover placement="bottom-start" :width="isPhone ? 'calc(100vw - 32px)' : 320" trigger="click" popper-class="report-field-popover">
                <template #reference>
                  <el-button :class="isPhone ? 'flex-1' : ''" :icon="List">字段选择</el-button>
                </template>
                <div class="max-h-[360px] overflow-auto pr-1">
                  <p class="mb-3 text-sm font-semibold text-slate-700">选择预览与导出字段</p>
                  <el-checkbox-group v-model="selectedFieldKeys" class="report-field-checkbox-group">
                    <el-checkbox v-for="field in currentAvailableFields" :key="field.key" :value="field.key">
                      {{ field.label }}
                    </el-checkbox>
                  </el-checkbox-group>
                </div>
              </el-popover>
              <el-button :class="isPhone ? 'flex-1' : ''" type="primary" :icon="Search" @click="handleSearch">查询</el-button>
              <el-button :class="isPhone ? 'flex-1' : ''" :icon="Refresh" @click="handleReset">重置</el-button>
            </div>
          </div>
        </template>

        <template #actions="{ isPhone }">
          <el-button
            v-if="canExportReports"
            :class="isPhone ? 'w-full' : ''"
            :icon="Download"
            :loading="exportLoading"
            :disabled="listState.loading"
            @click="handleOpenExportPreview"
          >
            导出 Excel
          </el-button>
        </template>
      </PageToolbarCard>

      <div class="report-summary-card rounded-2xl border border-dashed border-brand/20 bg-brand/5 px-4 py-3 text-sm leading-6 text-slate-600 dark:border-brand/20 dark:bg-brand/10 dark:text-slate-300">
        <p class="font-semibold text-slate-800 dark:text-slate-100">{{ currentReportOption.label }}</p>
        <p class="mt-1">{{ currentReportOption.description }}</p>
        <p class="report-summary-card__condition mt-1 text-xs text-slate-500 dark:text-slate-400">当前条件：{{ currentFilterSummary }}</p>
      </div>

      <div class="apple-card flex min-h-0 flex-1 flex-col p-3 sm:p-4 xl:p-5">
        <BizResponsiveDataCollectionShell
          :items="listState.records"
          :loading="listState.loading"
          empty-description="暂无报表数据"
          loading-description="正在加载报表数据，请稍候..."
          empty-min-height="260px"
          :skeleton-rows="8"
          wrapper-class="flex min-h-0 flex-1 flex-col"
          table-wrapper-class="flex min-h-0 flex-1 flex-col overflow-hidden px-0"
          card-container-class="pb-4"
        >
          <template #table>
            <el-table native-scrollbar :data="listState.records" stripe class="w-full flex-1" height="100%" table-layout="auto">
              <el-table-column
                v-for="field in displayFields"
                :key="field.key"
                :label="field.label"
                :prop="field.key"
                :min-width="Math.max(120, field.width * 8)"
                show-overflow-tooltip
                :align="field.numeric ? 'right' : 'left'"
              >
                <template #default="{ row }">{{ formatCellValue(row, field) }}</template>
              </el-table-column>
            </el-table>
          </template>

          <template #card="{ item, isTablet }">
            <div class="apple-card report-mobile-card min-w-0 p-4">
              <div class="report-mobile-card__head">
                <div class="min-w-0">
                  <p class="report-mobile-card__label">{{ mobileCardTitleField?.label ?? '记录' }}</p>
                  <p class="report-mobile-card__title">
                    {{ mobileCardTitleField ? formatCellValue(item, mobileCardTitleField) : '-' }}
                  </p>
                </div>
                <span class="report-mobile-card__chip">{{ currentReportOption.label }}</span>
              </div>

              <div v-if="mobileCardSubtitleFields.length" class="report-mobile-card__subtitle">
                <span v-for="field in mobileCardSubtitleFields" :key="field.key">
                  {{ field.label }}：{{ formatCellValue(item, field) }}
                </span>
              </div>

              <div v-if="mobileCardMetricFields.length" class="report-mobile-card__metrics">
                <div v-for="field in mobileCardMetricFields" :key="field.key" class="report-mobile-card__metric">
                  <span>{{ field.label }}</span>
                  <strong>{{ formatCellValue(item, field) }}</strong>
                </div>
              </div>

              <div v-if="mobileCardDetailFields.length" class="report-mobile-card__meta" :class="isTablet ? 'is-tablet' : ''">
                <div v-for="field in mobileCardDetailFields" :key="field.key" class="report-mobile-card__meta-item">
                  <span class="report-mobile-card__meta-label">{{ field.label }}</span>
                  <span class="report-mobile-card__meta-value">{{ formatCellValue(item, field) }}</span>
                </div>
              </div>
            </div>
          </template>
        </BizResponsiveDataCollectionShell>

        <PagePaginationBar
          v-if="listState.total > 0"
          v-model:current-page="listState.query.page"
          v-model:page-size="listState.query.pageSize"
          :layout="paginationLayout"
          :page-sizes="paginationPageSizes"
          :total="listState.total"
          @current-change="handleCurrentChange"
          @size-change="handlePageSizeChange"
        />
      </div>
    </div>

    <el-dialog
      v-model="exportPreviewVisible"
      title="导出预览"
      width="min(920px, calc(100vw - 32px))"
      class="report-export-preview-dialog"
      modal-class="report-export-preview-overlay"
      align-center
      append-to-body
      destroy-on-close
    >
      <div class="space-y-4">
        <div class="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-600 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-300">
          <div class="flex items-center gap-2 font-semibold text-slate-800 dark:text-slate-100">
            <el-icon><View /></el-icon>
            <span>{{ currentReportOption.label }}</span>
          </div>
          <p class="mt-1">{{ exportPreviewSummary }}</p>
          <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">导出条件：{{ currentFilterSummary }}</p>
        </div>

        <div>
          <p class="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">导出字段</p>
          <div class="flex flex-wrap gap-2">
            <el-tag v-for="field in displayFields" :key="field.key" size="small" effect="plain">
              {{ field.label }}
            </el-tag>
          </div>
        </div>

        <div>
          <p class="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">数据预览</p>
          <el-table
            v-if="exportPreviewRows.length > 0 && !appStore.isPhone"
            :data="exportPreviewRows"
            border
            stripe
            max-height="320"
            table-layout="auto"
          >
            <el-table-column
              v-for="field in displayFields"
              :key="field.key"
              :label="field.label"
              :prop="field.key"
              :min-width="Math.max(120, field.width * 8)"
              show-overflow-tooltip
              :align="field.numeric ? 'right' : 'left'"
            >
              <template #default="{ row }">{{ formatCellValue(row, field) }}</template>
            </el-table-column>
          </el-table>
          <div v-else-if="exportPreviewRows.length > 0" class="report-preview-card-list">
            <div v-for="row in exportPreviewRows" :key="String(row.id ?? JSON.stringify(row))" class="report-preview-card">
              <div class="report-preview-card__head">
                <span>{{ mobileCardTitleField?.label ?? '记录' }}</span>
                <strong>{{ mobileCardTitleField ? formatCellValue(row, mobileCardTitleField) : '-' }}</strong>
              </div>
              <div class="report-preview-card__body">
                <div v-for="field in mobilePreviewDetailFields" :key="field.key">
                  <span>{{ field.label }}</span>
                  <strong>{{ formatCellValue(row, field) }}</strong>
                </div>
              </div>
            </div>
          </div>
          <el-empty v-else description="当前筛选暂无可预览数据，仍可导出空模板" :image-size="96" />
          <p class="mt-2 text-xs text-slate-400">仅展示当前页前 6 条数据，Excel 将按当前筛选导出全部命中数据。</p>
        </div>
      </div>

      <template #footer>
        <el-button @click="exportPreviewVisible = false">取消</el-button>
        <el-button type="primary" :icon="Download" :loading="exportLoading" @click="handleExport">
          确认导出 Excel
        </el-button>
      </template>
    </el-dialog>
  </PageContainer>
</template>

<style scoped>
.report-center-page {
  min-height: calc(100dvh - 190px);
}

.report-filter-grid {
  min-width: 0;
}

.report-filter-actions {
  min-width: 0;
}

.report-summary-card {
  min-width: 0;
}

.report-summary-card__condition {
  overflow-wrap: anywhere;
}

.report-field-checkbox-group {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
}

.report-field-checkbox-group :deep(.el-checkbox) {
  margin-right: 0;
}

.report-mobile-card {
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}

.report-mobile-card:active {
  transform: scale(0.99);
}

.report-mobile-card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.report-mobile-card__label {
  margin: 0;
  font-size: 12px;
  color: #64748b;
}

.report-mobile-card__title {
  margin: 3px 0 0;
  color: #0f172a;
  font-size: 18px;
  font-weight: 700;
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.report-mobile-card__chip {
  flex-shrink: 0;
  max-width: 112px;
  border-radius: 9999px;
  background: #ecfdf5;
  color: #0f766e;
  padding: 5px 8px;
  font-size: 12px;
  font-weight: 700;
  line-height: 1;
  text-align: center;
}

.report-mobile-card__subtitle {
  margin-top: 10px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  color: #64748b;
  font-size: 12px;
  line-height: 1.5;
}

.report-mobile-card__subtitle span {
  min-width: 0;
  overflow-wrap: anywhere;
}

.report-mobile-card__metrics {
  margin-top: 12px;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.report-mobile-card__metric {
  min-width: 0;
  border-radius: 12px;
  background: #f8fafc;
  padding: 9px 10px;
}

.report-mobile-card__metric span {
  display: block;
  color: #64748b;
  font-size: 12px;
}

.report-mobile-card__metric strong {
  display: block;
  margin-top: 3px;
  color: #0f766e;
  font-size: 16px;
  line-height: 1.25;
  overflow-wrap: anywhere;
}

.report-mobile-card__meta {
  margin-top: 12px;
  display: grid;
  gap: 7px 12px;
}

.report-mobile-card__meta.is-tablet {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.report-mobile-card__meta-item {
  min-width: 0;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.report-mobile-card__meta-label {
  flex-shrink: 0;
  color: #64748b;
  font-size: 13px;
}

.report-mobile-card__meta-value {
  min-width: 0;
  color: #334155;
  font-size: 13px;
  font-weight: 500;
  text-align: right;
  overflow-wrap: anywhere;
}

.report-preview-card-list {
  display: grid;
  gap: 10px;
}

.report-preview-card {
  min-width: 0;
  border-radius: 12px;
  border: 1px solid #e2e8f0;
  background: #ffffff;
  padding: 12px;
}

.report-preview-card__head {
  display: grid;
  gap: 3px;
  padding-bottom: 10px;
  border-bottom: 1px solid #e2e8f0;
}

.report-preview-card__head span,
.report-preview-card__body span {
  color: #64748b;
  font-size: 12px;
}

.report-preview-card__head strong {
  color: #0f172a;
  font-size: 16px;
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.report-preview-card__body {
  margin-top: 10px;
  display: grid;
  gap: 7px;
}

.report-preview-card__body div {
  min-width: 0;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.report-preview-card__body strong {
  min-width: 0;
  color: #334155;
  font-size: 13px;
  font-weight: 600;
  text-align: right;
  overflow-wrap: anywhere;
}

:global(.report-export-preview-overlay) {
  position: fixed !important;
  inset: 0;
}

:global(.report-export-preview-overlay .el-overlay-dialog) {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  min-height: 100dvh;
  overflow: hidden;
  padding: 16px;
}

.report-export-preview-dialog:deep(.el-dialog) {
  max-height: min(88vh, calc(100dvh - 32px));
  margin: 0 auto !important;
  overflow: hidden;
}

.report-export-preview-dialog:deep(.el-dialog__header),
.report-export-preview-dialog:deep(.el-dialog__footer) {
  flex: 0 0 auto;
}

.report-export-preview-dialog:deep(.el-dialog__body) {
  flex: 0 1 auto !important;
  max-height: calc(min(88vh, calc(100dvh - 32px)) - 118px);
  overflow: auto;
  overscroll-behavior: contain;
}

@media (max-width: 640px) {
  .report-center-page {
    min-height: auto;
    gap: 12px;
  }

  .report-filter-grid {
    gap: 8px;
  }

  .report-filter-actions {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .report-filter-actions :deep(.el-button) {
    min-width: 0;
    padding-inline: 8px;
  }

  .report-summary-card {
    border-radius: 14px;
    padding: 12px;
  }

  .report-summary-card__condition {
    display: -webkit-box;
    -webkit-line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .report-date-picker--phone:deep(.el-range-input) {
    width: 100%;
    min-width: 0;
    font-size: 13px;
  }

  .report-date-picker--phone:deep(.el-range-separator) {
    flex-shrink: 0;
    padding: 0 5px;
  }

  .report-mobile-card__metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  :global(.report-export-preview-overlay .el-overlay-dialog) {
    padding: 10px;
  }

  .report-export-preview-dialog:deep(.el-dialog) {
    width: calc(100vw - 20px) !important;
    max-height: calc(100dvh - 20px);
  }

  .report-export-preview-dialog:deep(.el-dialog__header) {
    padding: 14px 14px 8px;
  }

  .report-export-preview-dialog:deep(.el-dialog__body) {
    padding: 10px 14px;
    max-height: calc(100dvh - 138px);
  }

  .report-export-preview-dialog:deep(.el-dialog__footer) {
    display: flex;
    gap: 8px;
    padding: 10px 14px 14px;
  }

  .report-export-preview-dialog:deep(.el-dialog__footer .el-button) {
    flex: 1;
    min-width: 0;
  }
}

.dark .report-mobile-card__title,
.dark .report-preview-card__head strong {
  color: #e2e8f0;
}

.dark .report-mobile-card__label,
.dark .report-mobile-card__subtitle,
.dark .report-mobile-card__metric span,
.dark .report-mobile-card__meta-label,
.dark .report-preview-card__head span,
.dark .report-preview-card__body span {
  color: #94a3b8;
}

.dark .report-mobile-card__metric,
.dark .report-preview-card {
  border-color: rgba(148, 163, 184, 0.22);
  background: rgba(15, 23, 42, 0.58);
}

.dark .report-mobile-card__metric strong {
  color: #5eead4;
}

.dark .report-mobile-card__meta-value,
.dark .report-preview-card__body strong {
  color: #e2e8f0;
}

.dark .report-preview-card__head {
  border-bottom-color: rgba(148, 163, 184, 0.22);
}
</style>
