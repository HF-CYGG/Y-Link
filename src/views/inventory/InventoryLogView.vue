<script setup lang="ts">
/**
 * 模块说明：src/views/inventory/InventoryLogView.vue
 * 文件职责：通用库存流水查询与导出，覆盖入库、出库、预订、单据、盘点等所有库存变化。
 * 实现逻辑：
 * - 支持按操作类型多选、时间范围、关键字、单据类型筛选；从当前库存页跳转时自动带上 skuId；
 * - “操作前 / 操作后”优先展示 SKU 级库存，旧流水没有 SKU 快照时退回商品汇总库存；
 * - 导出按当前筛选条件由服务端生成 Excel；
 * - “变动”列展示带符号的实际库存变化 stockDelta；只影响占用量的流水（预订占用 / 释放）库存不变，改为中性色展示占用数量。
 * 维护说明：
 * - 流水只读，不提供任何修改入口；
 * - changeQty 沿用各类型历史口径（销售出库等记正数表示出库量），页面不再直接用它判断增减；
 * - 列表请求经 useStableRequest 防乱序；缓存页首次进入只请求一次，再次激活时刷新。
 */

import { onActivated, onDeactivated, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { PageContainer, PagePaginationBar } from '@/components/common'
import { exportInventoryLogs, getInventoryLogs, type InventoryLogRow } from '@/api/modules/inventory'
import { useStableRequest } from '@/composables/useStableRequest'
import { INVENTORY_CHANGE_TYPE_LABELS } from '@/constants/inventory'
import { showAppError } from '@/utils/app-alert'

const route = useRoute()
const router = useRouter()
const changeTypeOptions = Object.entries(INVENTORY_CHANGE_TYPE_LABELS).map(([value, label]) => ({ value, label }))
const REF_TYPE_LABELS: Record<string, string> = {
  inv_stock_doc: '库存单据',
  inv_stocktake: '盘点单',
  biz_outbound_order: '出库单',
  biz_inbound_order: '送货单',
  o2o_preorder: '预订单',
  o2o_return_request: '退货申请',
  base_product: '商品资料',
  manual_inbound: '手工补货',
}

const filters = reactive({
  keyword: '',
  changeTypes: [] as string[],
  dateRange: [] as string[],
  skuId: '',
  skuLabel: '',
})
const pagination = reactive({ page: 1, pageSize: 20, total: 0 })
const rows = ref<InventoryLogRow[]>([])
const loading = ref(false)
const exporting = ref(false)
const listRequest = useStableRequest()
let pageActive = true
/** onMounted 已加载时跳过紧随其后的首次 onActivated，避免重复请求。 */
let skipNextActivation = true

const buildQuery = () => ({
  keyword: filters.keyword.trim() || undefined,
  changeTypes: filters.changeTypes.length ? filters.changeTypes : undefined,
  skuId: filters.skuId || undefined,
  startDate: filters.dateRange?.[0] || undefined,
  endDate: filters.dateRange?.[1] || undefined,
})

const loadData = () => {
  loading.value = true
  const query = { ...buildQuery(), page: pagination.page, pageSize: pagination.pageSize }
  return listRequest.runLatest({
    executor: (signal) => getInventoryLogs(query, { signal }),
    onSuccess: (result) => {
      rows.value = result.list
      pagination.total = result.total
    },
    onError: (error) => {
      showAppError(error, '流水查询失败')
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

const clearSku = () => {
  filters.skuId = ''
  filters.skuLabel = ''
  void router.replace({ query: {} })
  search()
}

const handleExport = async () => {
  exporting.value = true
  try {
    await exportInventoryLogs(buildQuery())
  } catch (error) {
    showAppError(error, '导出失败')
  } finally {
    exporting.value = false
  }
}

const resolveStockDelta = (row: InventoryLogRow) =>
  typeof row.stockDelta === 'number' ? row.stockDelta : row.afterStock - row.beforeStock
/** 库存不变但有数量的流水（预订占用 / 释放），只影响占用量。 */
const isReservationOnly = (row: InventoryLogRow) => resolveStockDelta(row) === 0 && row.changeQty !== 0
const formatSigned = (value: number) => (value > 0 ? `+${value}` : value < 0 ? `−${Math.abs(value)}` : '0')

const deltaText = (row: InventoryLogRow) => {
  if (!isReservationOnly(row)) return formatSigned(resolveStockDelta(row))
  const qty = Math.abs(row.changeQty)
  if (row.changeType === 'preorder_release') return `释放 ${qty}`
  if (row.changeType === 'preorder_hold') return `占用 ${qty}`
  return `占用变动 ${row.changeQty}`
}

const deltaClass = (row: InventoryLogRow) => {
  if (isReservationOnly(row)) return 'text-slate-500'
  const delta = resolveStockDelta(row)
  if (delta > 0) return 'text-emerald-600'
  if (delta < 0) return 'text-red-600'
  return 'text-slate-500'
}

watch(
  () => route.query.skuId,
  (skuId) => {
    // 缓存页离开时路由已切到其他页面，不应据此清空筛选或发起查询。
    if (route.name !== 'inventory-logs') return
    const nextSkuId = typeof skuId === 'string' ? skuId : ''
    if (nextSkuId === filters.skuId) return
    filters.skuId = nextSkuId
    filters.skuLabel = typeof route.query.label === 'string' ? route.query.label : ''
    search()
    // 缓存页未激活时由路由变化触发的查询已包含最新数据，激活时不再重复请求。
    if (!pageActive) skipNextActivation = true
  },
)

onMounted(() => {
  filters.skuId = typeof route.query.skuId === 'string' ? route.query.skuId : ''
  filters.skuLabel = typeof route.query.label === 'string' ? route.query.label : ''
  void loadData()
})
onActivated(() => {
  pageActive = true
  if (skipNextActivation) {
    skipNextActivation = false
    return
  }
  void loadData()
})
onDeactivated(() => {
  pageActive = false
})
</script>

<template>
  <PageContainer title="库存流水" description="每一次库存变化都会在这里留下记录：谁、何时、因为什么、从多少变成多少。">
    <el-card shadow="never" class="mb-4">
      <div class="flex flex-wrap gap-3">
        <el-input v-model="filters.keyword" placeholder="商品 / SKU / 条码 / 操作人 / 备注" clearable class="w-64" @keyup.enter="search" />
        <el-select v-model="filters.changeTypes" multiple collapse-tags collapse-tags-tooltip placeholder="全部操作类型" clearable class="w-56">
          <el-option v-for="item in changeTypeOptions" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
        <el-date-picker
          v-model="filters.dateRange"
          type="daterange"
          value-format="YYYY-MM-DD"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          class="!w-64"
        />
        <el-button type="primary" @click="search">查询</el-button>
        <el-button :loading="exporting" @click="handleExport">导出 Excel</el-button>
      </div>
      <div v-if="filters.skuId" class="mt-3">
        <el-tag closable @close="clearSku">仅看：{{ filters.skuLabel || `规格 ${filters.skuId}` }}</el-tag>
      </div>
    </el-card>

    <el-card shadow="never">
      <el-table v-loading="loading" :data="rows" row-key="id" empty-text="暂无流水">
        <el-table-column label="时间" width="170">
          <template #default="{ row }">{{ new Date(row.createdAt).toLocaleString('zh-CN', { hour12: false }) }}</template>
        </el-table-column>
        <el-table-column label="商品 / 规格" min-width="200">
          <template #default="{ row }">
            <div class="font-medium">{{ row.productName }}</div>
            <div class="text-xs text-slate-500">{{ row.specText || '（未记录规格）' }} <span v-if="row.skuCode">· {{ row.skuCode }}</span></div>
          </template>
        </el-table-column>
        <el-table-column label="操作类型" width="140">
          <template #default="{ row }"><el-tag size="small" effect="plain">{{ row.changeTypeLabel }}</el-tag></template>
        </el-table-column>
        <el-table-column label="变动" width="100" align="right">
          <template #default="{ row }">
            <span class="font-semibold tabular-nums" :class="deltaClass(row)">{{ deltaText(row) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作前 → 操作后" width="140" align="center">
          <template #default="{ row }"><span class="tabular-nums">{{ row.beforeStock }} → {{ row.afterStock }}</span></template>
        </el-table-column>
        <el-table-column label="操作人" width="110">
          <template #default="{ row }">{{ row.operatorName || '系统' }}</template>
        </el-table-column>
        <el-table-column label="关联" width="110">
          <template #default="{ row }">{{ row.refType ? REF_TYPE_LABELS[row.refType] ?? row.refType : '—' }}</template>
        </el-table-column>
        <el-table-column label="备注" min-width="220" show-overflow-tooltip>
          <template #default="{ row }">{{ row.remark || '—' }}</template>
        </el-table-column>
      </el-table>
      <PagePaginationBar
        v-model:current-page="pagination.page"
        v-model:page-size="pagination.pageSize"
        :total="pagination.total"
        layout="total, sizes, prev, pager, next"
        class="mt-4"
        @current-change="loadData"
        @size-change="search"
      />
    </el-card>
  </PageContainer>
</template>
