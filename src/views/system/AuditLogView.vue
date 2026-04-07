<script setup lang="ts">
import dayjs from 'dayjs'
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { BizResponsiveDataCollectionShell, PageContainer, PagePaginationBar, PageToolbarCard } from '@/components/common'
import { exportAuditLogs, getAuditLogList, type AuditLogListQuery, type AuditLogRecord } from '@/api/modules/audit'
import { useStableRequest } from '@/composables/useStableRequest'
import { useAuthStore } from '@/store'
import { applyPaginatedResult, createPaginatedListState } from '@/utils/list'
import { extractErrorMessage } from '@/utils/error'

/**
 * 审计日志筛选表单：
 * - actionType 用于快速聚焦登录/开单/用户管理动作；
 * - targetType 对业务对象做二级过滤；
 * - targetId 保留精确追溯入口，便于串联单据与审计日志；
 * - timeRange 为本期新增的时间范围筛选条件。
 */
const searchForm = reactive({
  actionType: '',
  targetType: '',
  targetId: '',
  timeRange: [] as [Date, Date] | [],
})

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
const authStore = useAuthStore()
const listRequest = useStableRequest()
const canViewAuditLogs = computed(() => authStore.hasPermission('audit_logs:view'))
const canExportAuditLogs = computed(() => authStore.hasPermission('audit_logs:export'))
const exportLoading = ref(false)

/**
 * 常用动作筛选项：
 * - 聚焦本期已接入的重要登录、开单、用户治理动作；
 * - 保留自由输入能力，不限制后续新增动作类型。
 */
const actionOptions = [
  { label: '用户登录', value: 'auth.login' },
  { label: '用户退出', value: 'auth.logout' },
  { label: '本人改密', value: 'auth.change_password' },
  { label: '创建出库单', value: 'order.create' },
  { label: '新增用户', value: 'user.create' },
  { label: '编辑用户', value: 'user.update' },
  { label: '启停用户', value: 'user.update_status' },
  { label: '重置密码', value: 'user.reset_password' },
  { label: '更新流水配置', value: 'system_config.update_order_serial' },
]

/**
 * 目标类型筛选项：
 * - order 对应出库单；
 * - user 对应账号管理；
 * - session 对应登录会话链路。
 */
const targetTypeOptions = [
  { label: '出库单', value: 'order' },
  { label: '用户', value: 'user' },
  { label: '会话', value: 'session' },
  { label: '系统配置', value: 'system_config' },
]

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

/**
 * 当前筛选说明：
 * - 用于导出按钮旁清晰提示“导出的到底是哪一批数据”；
 * - 让时间范围、动作类型等关键条件一眼可见。
 */
const currentFilterSummary = computed(() => {
  const summary: string[] = []

  if (searchForm.actionType) {
    summary.push(`动作=${searchForm.actionType}`)
  }
  if (searchForm.targetType) {
    summary.push(`目标=${searchForm.targetType}`)
  }
  if (searchForm.targetId.trim()) {
    summary.push(`目标ID=${searchForm.targetId.trim()}`)
  }
  if (searchForm.timeRange.length === 2) {
    summary.push(
      `时间=${dayjs(searchForm.timeRange[0]).format('YYYY-MM-DD HH:mm:ss')} ~ ${dayjs(searchForm.timeRange[1]).format('YYYY-MM-DD HH:mm:ss')}`,
    )
  }

  return summary.length > 0 ? summary.join('；') : '全部日志'
})

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

  if (searchForm.actionType) {
    params.actionType = searchForm.actionType
  }
  if (searchForm.targetType) {
    params.targetType = searchForm.targetType
  }
  if (searchForm.targetId.trim()) {
    params.targetId = searchForm.targetId.trim()
  }
  if (searchForm.timeRange.length === 2) {
    params.startAt = searchForm.timeRange[0].toISOString()
    params.endAt = searchForm.timeRange[1].toISOString()
  }

  return params
}

/**
 * 拉取审计日志列表：
 * - 成功后回填统一分页状态；
 * - 若当前账号无查看权限，则保持空列表并给出稳定提示。
 */
const loadData = async () => {
  if (!canViewAuditLogs.value) {
    listState.loading = false
    listState.records = []
    listState.total = 0
    ElMessage.warning('当前账号无权查看审计日志')
    return
  }

  listState.loading = true
  await listRequest.runLatest({
    executor: (signal) => getAuditLogList(buildQueryParams(), { signal }),
    onSuccess: (result) => {
      applyPaginatedResult(listState, result)
    },
    onError: (error) => {
      ElMessage.error(extractErrorMessage(error, '获取审计日志失败'))
    },
    onFinally: () => {
      listState.loading = false
    },
  })
}

/**
 * 导出当前筛选结果：
 * - 直接复用 buildQueryParams，保证导出与页面筛选完全一致；
 * - 导出范围覆盖当前筛选命中的全部结果，而不是仅当前分页。
 */
const handleExport = async () => {
  if (!canExportAuditLogs.value) {
    ElMessage.warning('当前账号无权导出审计日志')
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
    ElMessage.success('已导出当前筛选结果')
  } catch (error) {
    ElMessage.error(extractErrorMessage(error, '导出审计日志失败'))
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

const handleReset = () => {
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
  void loadData()
})
</script>

<template>
  <PageContainer title="审计日志" description="查看登录、用户治理与开单等关键动作留痕，支持按时间范围、动作与目标对象进行检索追溯。">
    <div class="flex min-w-0 flex-col gap-4">
      <PageToolbarCard content-class="items-start">
        <template #default="{ isPhone, isTablet }">
          <div class="flex flex-1 flex-wrap items-start gap-2.5">
            <el-select
              v-model="searchForm.actionType"
              placeholder="操作类型"
              clearable
              :class="isPhone ? '!w-full' : isTablet ? '!w-[240px]' : '!w-[260px]'"
              @change="handleSearch"
            >
              <el-option v-for="item in actionOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
            <el-select
              v-model="searchForm.targetType"
              placeholder="目标对象"
              clearable
              :class="isPhone ? '!w-full' : isTablet ? '!w-[176px]' : '!w-[180px]'"
              @change="handleSearch"
            >
              <el-option v-for="item in targetTypeOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
            <el-input
              v-model="searchForm.targetId"
              placeholder="按目标ID追溯"
              clearable
              :class="isPhone ? '!w-full' : isTablet ? '!w-[240px]' : '!w-[260px]'"
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
              :class="isPhone ? '!w-full' : isTablet ? '!w-[360px]' : '!w-[420px]'"
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
        <span v-if="canExportAuditLogs">导出按钮会按同一筛选条件导出全部命中结果。</span>
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
            <el-table :data="listState.records" stripe class="w-full flex-1" height="100%" table-layout="auto">
              <el-table-column label="时间" width="170">
                <template #default="{ row }">{{ dayjs(row.createdAt).format('YYYY-MM-DD HH:mm:ss') }}</template>
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
                <template #default="{ row }">{{ row.targetType }}<span v-if="row.targetCode"> / {{ row.targetCode }}</span></template>
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
                  <span class="text-slate-400">操作人</span>
                  <span>{{ item.actorDisplayName || item.actorUsername || '-' }}</span>
                </div>
                <div class="flex items-center justify-between gap-3">
                  <span class="text-slate-400">动作编码</span>
                  <span>{{ item.actionType }}</span>
                </div>
                <div class="flex items-center justify-between gap-3">
                  <span class="text-slate-400">目标对象</span>
                  <span>{{ item.targetType }}<span v-if="item.targetCode"> / {{ item.targetCode }}</span></span>
                </div>
              </div>

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
  </PageContainer>
</template>
