<script setup lang="ts">
/**
 * 模块说明：src/views/inventory/InventoryDocListView.vue
 * 文件职责：查询扫码作业生成的库存单据，查看明细（含记账前后库存），并支持作废冲回。
 * 实现逻辑：
 * - 列表按单据类型、状态、日期与关键字（单号 / 商品 / SKU / 操作人）服务端筛选分页；
 * - 明细在响应式抽屉中展示；作废需填写原因，由服务端生成反向流水；
 * - 作废入口仅对拥有 inventory:void 的账号展示。
 * - 筛选与结果卡统一层级；桌面保留单据表格，窄屏改用单据卡，详情抽屉的明细也按屏宽切换。
 * 维护说明：
 * - 入库单作废需要库存足够才能扣回，失败时直接展示服务端原因，不做前端预判；
 * - 单据一旦作废不可恢复，确认文案必须写清楚会回滚库存；
 * - 列表请求经 useStableRequest 防乱序；缓存页首次进入只请求一次，再次激活时刷新。
 */

import { computed, onActivated, onMounted, reactive, ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import { BizResponsiveDrawerShell, PageContainer, PagePaginationBar, PageToolbarCard } from '@/components/common'
import { getStockDocDetail, getStockDocs, voidStockDoc, type StockDocRecord } from '@/api/modules/inventory'
import { useStableRequest } from '@/composables/useStableRequest'
import { STOCK_DOC_TYPE_OPTIONS } from '@/constants/inventory'
import { useAuthStore } from '@/store'
import pinia from '@/store/pinia'
import { showAppError, showAppSuccess } from '@/utils/app-alert'

const authStore = useAuthStore(pinia)
const canVoid = computed(() => authStore.hasPermission('inventory:void'))

const filters = reactive({ keyword: '', docType: '', status: '', dateRange: [] as string[] })
const pagination = reactive({ page: 1, pageSize: 20, total: 0 })
const rows = ref<StockDocRecord[]>([])
const loading = ref(false)
const detailVisible = ref(false)
const detailLoading = ref(false)
const detail = ref<StockDocRecord | null>(null)
const listRequest = useStableRequest()
/** onMounted 已加载时跳过紧随其后的首次 onActivated，避免缓存页首次进入重复请求。 */
let skipNextActivation = true

const loadData = () => {
  loading.value = true
  const query = {
    page: pagination.page,
    pageSize: pagination.pageSize,
    keyword: filters.keyword.trim() || undefined,
    docType: filters.docType || undefined,
    status: filters.status || undefined,
    startDate: filters.dateRange?.[0] || undefined,
    endDate: filters.dateRange?.[1] || undefined,
  }
  return listRequest.runLatest({
    executor: (signal) => getStockDocs(query, { signal }),
    onSuccess: (result) => {
      rows.value = result.list
      pagination.total = result.total
    },
    onError: (error) => {
      showAppError(error, '单据查询失败')
    },
    onFinally: () => {
      loading.value = false
    },
  })
}

const search = () => {
  pagination.page = 1
  void loadData()
}

const openDetail = async (row: StockDocRecord) => {
  detailVisible.value = true
  detailLoading.value = true
  detail.value = null
  try {
    detail.value = await getStockDocDetail(row.id)
  } catch (error) {
    showAppError(error, '单据详情加载失败')
  } finally {
    detailLoading.value = false
  }
}

const handleVoid = async (row: StockDocRecord) => {
  let reason = ''
  try {
    const result = await ElMessageBox.prompt(
      `作废 ${row.docNo} 会按原数量反向回滚库存（${row.docTypeLabel}），且不可恢复。请填写作废原因：`,
      '作废单据',
      { type: 'warning', confirmButtonText: '确认作废', inputValidator: (value) => Boolean(value?.trim()) || '请填写作废原因' },
    )
    reason = result.value.trim()
  } catch {
    return
  }
  try {
    const voided = await voidStockDoc(row.id, reason)
    showAppSuccess(`已作废 ${voided.docNo}`)
    if (detail.value?.id === voided.id) detail.value = voided
    await loadData()
  } catch (error) {
    showAppError(error, '作废失败')
  }
}

onMounted(() => {
  void loadData()
})
onActivated(() => {
  if (skipNextActivation) {
    skipNextActivation = false
    return
  }
  void loadData()
})
</script>

<template>
  <PageContainer title="库存单据" description="扫码作业提交的入库、出库、退货、报损与调整单据。">
    <PageToolbarCard class="mb-4" stack-actions-on-tablet>
      <div class="flex min-w-0 flex-wrap gap-3">
        <el-input v-model="filters.keyword" placeholder="单号 / 商品 / SKU / 操作人" clearable class="!w-full sm:!w-56" @keyup.enter="search" />
        <el-select v-model="filters.docType" placeholder="全部类型" clearable class="!w-full sm:!w-36">
          <el-option v-for="item in STOCK_DOC_TYPE_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
        <el-select v-model="filters.status" placeholder="全部状态" clearable class="!w-full sm:!w-32">
          <el-option label="已完成" value="completed" />
          <el-option label="已作废" value="voided" />
        </el-select>
        <el-date-picker v-model="filters.dateRange" type="daterange" value-format="YYYY-MM-DD" start-placeholder="开始日期" end-placeholder="结束日期" class="!w-full sm:!w-64" />
      </div>
      <template #actions><el-button type="primary" class="w-full sm:w-auto" @click="search">查询</el-button></template>
    </PageToolbarCard>

    <section class="apple-card min-w-0 p-3 sm:p-4 xl:p-5">
      <div class="mb-4 border-b border-slate-100 pb-3 dark:border-white/10">
        <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">单据记录</h2>
        <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">共 {{ pagination.total }} 张 · 查看明细与记账结果</p>
      </div>
      <div class="hidden xl:block">
      <el-table v-loading="loading" :data="rows" row-key="id" empty-text="暂无单据">
        <el-table-column prop="docNo" label="单号" width="170" />
        <el-table-column label="类型" width="110">
          <template #default="{ row }"><el-tag size="small" effect="plain">{{ row.docTypeLabel }}</el-tag></template>
        </el-table-column>
        <el-table-column label="原因 / 备注" min-width="180" show-overflow-tooltip>
          <template #default="{ row }">{{ [row.reasonLabel, row.remark].filter(Boolean).join('；') || '—' }}</template>
        </el-table-column>
        <el-table-column prop="itemCount" label="规格数" width="80" align="right" />
        <el-table-column prop="totalQty" label="数量" width="80" align="right" />
        <el-table-column label="操作人" width="110">
          <template #default="{ row }">{{ row.operatorName || '—' }}</template>
        </el-table-column>
        <el-table-column label="时间" width="170">
          <template #default="{ row }">{{ new Date(row.createdAt).toLocaleString('zh-CN', { hour12: false }) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag size="small" :type="row.status === 'voided' ? 'info' : 'success'">{{ row.status === 'voided' ? '已作废' : '已完成' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openDetail(row)">明细</el-button>
            <el-button v-if="canVoid && row.status === 'completed'" link type="danger" @click="handleVoid(row)">作废</el-button>
          </template>
        </el-table-column>
      </el-table>
      </div>
      <div v-loading="loading" class="space-y-3 xl:hidden">
        <div v-if="!rows.length" class="rounded-xl border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-500 dark:border-white/10 dark:text-slate-400">暂无单据</div>
        <article v-for="row in rows" :key="row.id" class="min-w-0 rounded-xl border border-slate-200 bg-white/70 p-3 dark:border-white/10 dark:bg-white/5">
          <div class="flex min-w-0 flex-wrap items-start justify-between gap-2">
            <div class="min-w-0 flex-1">
              <p class="break-all font-semibold text-slate-900 dark:text-slate-100">{{ row.docNo }}</p>
              <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">{{ new Date(row.createdAt).toLocaleString('zh-CN', { hour12: false }) }}</p>
            </div>
            <el-tag size="small" :type="row.status === 'voided' ? 'info' : 'success'">{{ row.status === 'voided' ? '已作废' : '已完成' }}</el-tag>
          </div>
          <div class="mt-3 flex flex-wrap items-center gap-2"><el-tag size="small" effect="plain">{{ row.docTypeLabel }}</el-tag><span class="text-xs text-slate-500 dark:text-slate-400">{{ row.operatorName || '—' }}</span></div>
          <p class="mt-2 break-words text-sm text-slate-600 dark:text-slate-300">{{ [row.reasonLabel, row.remark].filter(Boolean).join('；') || '无原因或备注' }}</p>
          <div class="mt-3 flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm dark:bg-white/5"><span>{{ row.itemCount }} 个规格</span><span class="font-semibold tabular-nums">合计 {{ row.totalQty }} 件</span></div>
          <div class="mt-3 flex justify-end gap-2 border-t border-slate-100 pt-2 dark:border-white/10">
            <el-button link type="primary" @click="openDetail(row)">明细</el-button>
            <el-button v-if="canVoid && row.status === 'completed'" link type="danger" @click="handleVoid(row)">作废</el-button>
          </div>
        </article>
      </div>
      <PagePaginationBar
        v-model:current-page="pagination.page"
        v-model:page-size="pagination.pageSize"
        :total="pagination.total"
        layout="total, sizes, prev, pager, next"
        class="mt-4"
        @current-change="loadData"
        @size-change="search"
      />
    </section>

    <BizResponsiveDrawerShell v-model="detailVisible" title="单据明细" :loading="detailLoading" desktop-size="640px">
      <div v-if="detail" class="space-y-4">
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="单号">{{ detail.docNo }}</el-descriptions-item>
          <el-descriptions-item label="类型">{{ detail.docTypeLabel }}</el-descriptions-item>
          <el-descriptions-item label="原因">{{ detail.reasonLabel || '—' }}</el-descriptions-item>
          <el-descriptions-item label="操作人">{{ detail.operatorName || '—' }}</el-descriptions-item>
          <el-descriptions-item label="备注">{{ detail.remark || '—' }}</el-descriptions-item>
          <el-descriptions-item v-if="detail.status === 'voided'" label="作废">
            {{ detail.voidedByName }} 于 {{ detail.voidedAt ? new Date(detail.voidedAt).toLocaleString('zh-CN', { hour12: false }) : '' }}：{{ detail.voidReason }}
          </el-descriptions-item>
        </el-descriptions>
        <el-table :data="detail.items ?? []" size="small" row-key="id" class="hidden sm:block">
          <el-table-column label="商品 / 规格" min-width="180">
            <template #default="{ row }">
              <div>{{ row.productName }}</div>
              <div class="text-xs text-slate-500 dark:text-slate-400">{{ row.specText }} · {{ row.skuCode }}</div>
            </template>
          </el-table-column>
          <el-table-column label="变动" width="80" align="right">
            <template #default="{ row }">
              <span :class="row.qty >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'">{{ row.qty >= 0 ? '+' : '' }}{{ row.qty }}</span>
            </template>
          </el-table-column>
          <el-table-column label="前 → 后" width="110" align="center">
            <template #default="{ row }">{{ row.beforeSkuStock }} → {{ row.afterSkuStock }}</template>
          </el-table-column>
        </el-table>
        <div class="space-y-2 sm:hidden">
          <div v-for="item in detail.items ?? []" :key="item.id" class="min-w-0 rounded-xl border border-slate-200 p-3 dark:border-white/10">
            <p class="break-words font-medium">{{ item.productName }}</p>
            <p class="mt-0.5 break-all text-xs text-slate-500 dark:text-slate-400">{{ item.specText }} · {{ item.skuCode }}</p>
            <div class="mt-2 flex flex-wrap items-center justify-between gap-2 text-sm"><span :class="item.qty >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'">{{ item.qty >= 0 ? '+' : '' }}{{ item.qty }}</span><span class="tabular-nums">{{ item.beforeSkuStock }} → {{ item.afterSkuStock }}</span></div>
          </div>
        </div>
      </div>
    </BizResponsiveDrawerShell>
  </PageContainer>
</template>
