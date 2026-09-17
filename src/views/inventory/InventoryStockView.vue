<script setup lang="ts">
/**
 * 模块说明：src/views/inventory/InventoryStockView.vue
 * 文件职责：按 SKU 查询当前库存，支持按分类、库位、关键字与“库存不高于 N”筛选，并可批量打印条码、跳转查看流水。
 * 实现逻辑：
 * - 查询条件全部交给服务端分页，顶部同时展示命中规格数与库存合计；
 * - 勾选行后打开条码打印弹窗（异步组件，避免条码库进入本页主包）；
 * - 点击“流水”跳到库存流水页并带上 skuId 过滤。
 * 维护说明：
 * - 库存数字只读，任何调整都要走扫码作业或盘点生成流水，不在这里提供直接修改入口；
 * - 成本价仅在有 products:manage 权限时展示，无权限时服务端返回 null，统一显示“—”；
 * - 列表请求经 useStableRequest 防乱序；缓存页首次进入只请求一次，再次激活时刷新。
 */

import { computed, defineAsyncComponent, onActivated, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { PageContainer, PagePaginationBar } from '@/components/common'
import { getCategories, getLocations, getStocks, type CategoryRecord, type LocationRecord, type StockRow } from '@/api/modules/inventory'
import { useStableRequest } from '@/composables/useStableRequest'
import { useAuthStore } from '@/store'
import pinia from '@/store/pinia'
import { showAppError, showAppWarning } from '@/utils/app-alert'

const BarcodeLabelPrintDialog = defineAsyncComponent(() => import('./components/BarcodeLabelPrintDialog.vue'))

const router = useRouter()
const authStore = useAuthStore(pinia)
const showCost = computed(() => authStore.hasPermission('products:manage'))
const canPrint = computed(() => authStore.hasPermission('products:view'))

const filters = reactive({ keyword: '', categoryId: '', locationId: '', maxStock: '' as string, includeInactive: false })
const pagination = reactive({ page: 1, pageSize: 20, total: 0 })
const rows = ref<StockRow[]>([])
const totalQty = ref(0)
const loading = ref(false)
const categories = ref<CategoryRecord[]>([])
const locations = ref<LocationRecord[]>([])
const selectedRows = ref<StockRow[]>([])
const printVisible = ref(false)
const listRequest = useStableRequest()
/** onMounted 已加载时跳过紧随其后的首次 onActivated，避免缓存页首次进入重复请求。 */
let skipNextActivation = true

const loadOptions = async () => {
  try {
    const [categoryRows, locationRows] = await Promise.all([getCategories(), getLocations()])
    categories.value = categoryRows
    locations.value = locationRows
  } catch (error) {
    showAppError(error, '筛选项加载失败')
  }
}

const loadData = () => {
  loading.value = true
  const maxStock = filters.maxStock.trim() === '' ? undefined : Number(filters.maxStock)
  const query = {
    page: pagination.page,
    pageSize: pagination.pageSize,
    keyword: filters.keyword.trim() || undefined,
    categoryId: filters.categoryId || undefined,
    locationId: filters.locationId || undefined,
    maxStock: Number.isFinite(maxStock) ? maxStock : undefined,
    includeInactive: filters.includeInactive,
  }
  return listRequest.runLatest({
    executor: (signal) => getStocks(query, { signal }),
    onSuccess: (result) => {
      rows.value = result.list
      pagination.total = result.total
      totalQty.value = result.totalQty
    },
    onError: (error) => {
      showAppError(error, '库存查询失败')
    },
    onFinally: () => {
      loading.value = false
    },
  })
}

const formatCost = (value: string | null | undefined) => (value === null || value === undefined || value === '' ? '—' : value)

const search = () => {
  pagination.page = 1
  void loadData()
}

const resetFilters = () => {
  Object.assign(filters, { keyword: '', categoryId: '', locationId: '', maxStock: '', includeInactive: false })
  search()
}

const openPrint = () => {
  if (!selectedRows.value.length) {
    showAppWarning('请先勾选要打印条码的规格')
    return
  }
  printVisible.value = true
}

const viewLogs = (row: StockRow) => {
  void router.push({ path: '/inventory/logs', query: { skuId: row.skuId, label: `${row.productName} · ${row.specText}` } })
}

onMounted(() => {
  void loadOptions()
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
  <PageContainer title="当前库存" description="按规格（SKU）查看实时库存；库存变化请通过扫码作业或盘点完成。">
    <el-card shadow="never" class="mb-4">
      <div class="flex flex-wrap gap-3">
        <el-input v-model="filters.keyword" placeholder="商品名称 / SKU / 条码 / 规格" clearable class="w-64" @keyup.enter="search" />
        <el-select v-model="filters.categoryId" placeholder="全部分类" clearable class="w-40">
          <el-option v-for="item in categories" :key="item.id" :label="`${item.categoryCode} ${item.categoryName}`" :value="item.id" />
        </el-select>
        <el-select v-model="filters.locationId" placeholder="全部库位" clearable filterable class="w-40">
          <el-option label="未设置库位" value="none" />
          <el-option v-for="item in locations" :key="item.id" :label="item.locationCode" :value="item.id" />
        </el-select>
        <el-input v-model="filters.maxStock" placeholder="库存不高于" clearable class="w-32" @keyup.enter="search" />
        <el-checkbox v-model="filters.includeInactive">含停用</el-checkbox>
        <el-button type="primary" @click="search">查询</el-button>
        <el-button @click="resetFilters">重置</el-button>
      </div>
    </el-card>

    <el-card shadow="never">
      <template #header>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="font-semibold">共 {{ pagination.total }} 个规格，库存合计 {{ totalQty }} 件</span>
          <el-button v-if="canPrint" :disabled="!selectedRows.length" @click="openPrint">
            打印条码（{{ selectedRows.length }}）
          </el-button>
        </div>
      </template>
      <el-table
        v-loading="loading"
        :data="rows"
        row-key="skuId"
        empty-text="没有符合条件的库存"
        @selection-change="selectedRows = $event"
      >
        <el-table-column v-if="canPrint" type="selection" width="44" />
        <el-table-column label="商品" min-width="200">
          <template #default="{ row }">
            <div class="font-medium">{{ row.productName }}</div>
            <div class="text-xs text-slate-500">{{ row.specText }}</div>
          </template>
        </el-table-column>
        <el-table-column label="SKU / 条码" min-width="170">
          <template #default="{ row }">
            <div>{{ row.skuCode }}</div>
            <div v-if="row.barcode" class="text-xs text-slate-500">{{ row.barcode }}</div>
          </template>
        </el-table-column>
        <el-table-column label="分类" width="110">
          <template #default="{ row }">{{ row.categoryName || '—' }}</template>
        </el-table-column>
        <el-table-column label="库位" width="110">
          <template #default="{ row }">{{ row.locationCode || '—' }}</template>
        </el-table-column>
        <el-table-column v-if="showCost" label="成本价" width="90" align="right">
          <template #default="{ row }">{{ formatCost(row.costPrice) }}</template>
        </el-table-column>
        <el-table-column prop="salePrice" label="售价" width="90" align="right" />
        <el-table-column label="当前库存" width="100" align="right">
          <template #default="{ row }">
            <span class="font-semibold tabular-nums" :class="row.currentStock <= 0 ? 'text-red-600' : ''">{{ row.currentStock }}</span>
          </template>
        </el-table-column>
        <el-table-column label="已预订 / 可用" width="120" align="right">
          <template #default="{ row }">{{ row.preOrderedStock }} / {{ row.availableStock }}</template>
        </el-table-column>
        <el-table-column label="状态" width="80">
          <template #default="{ row }">
            <el-tag size="small" :type="row.isActive ? 'success' : 'info'">{{ row.isActive ? '启用' : '停用' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="80" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="viewLogs(row)">流水</el-button>
          </template>
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

    <BarcodeLabelPrintDialog v-if="printVisible" v-model="printVisible" :sku-ids="selectedRows.map((row) => row.skuId)" />
  </PageContainer>
</template>
