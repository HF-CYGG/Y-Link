<script setup lang="ts">
/**
 * 模块说明：src/views/inventory/StocktakeListView.vue
 * 文件职责：盘点单列表与建单入口，建单时选择盘点范围（全部 / 分类 / 库位 / 指定商品）与是否盲盘。
 * 实现逻辑：
 * - 列表服务端分页，展示进度（已盘 / 总数）与差异数（盲盘单对无审核权限者不返回差异数）；
 * - 指定商品范围通过扫码或输入条码逐个添加，避免一次拉取全部商品；
 * - 建单成功后直接进入盘点作业页。
 * 维护说明：
 * - 同一规格不能同时出现在两张未完成的盘点单里，冲突由服务端提示，前端不做预判；
 * - 盲盘默认开启，关闭时计数人员能看到账面库存；
 * - 列表请求经 useStableRequest 防乱序；缓存页首次进入只请求一次，再次激活时刷新。
 */

import { computed, onActivated, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { BizCrudDialogShell, PageContainer, PagePaginationBar } from '@/components/common'
import {
  createStocktake,
  getCategories,
  getLocations,
  getStocktakes,
  lookupProductByCode,
  type CategoryRecord,
  type LocationRecord,
  type StocktakeRecord,
} from '@/api/modules/inventory'
import { useStableRequest } from '@/composables/useStableRequest'
import { STOCKTAKE_STATUS_LABELS } from '@/constants/inventory'
import { useAuthStore } from '@/store'
import pinia from '@/store/pinia'
import { showAppError, showAppSuccess, showAppWarning } from '@/utils/app-alert'

const router = useRouter()
const authStore = useAuthStore(pinia)
const canCreate = computed(() => authStore.hasPermission('stocktake:count'))

const filters = reactive({ keyword: '', status: '' })
const pagination = reactive({ page: 1, pageSize: 20, total: 0 })
const rows = ref<StocktakeRecord[]>([])
const loading = ref(false)
const listRequest = useStableRequest()
/** onMounted 已加载时跳过紧随其后的首次 onActivated，避免缓存页首次进入重复请求。 */
let skipNextActivation = true

const createVisible = ref(false)
const creating = ref(false)
const categories = ref<CategoryRecord[]>([])
const locations = ref<LocationRecord[]>([])
const skuCode = ref('')
const createForm = reactive({
  scopeType: 'all' as StocktakeRecord['scopeType'],
  categoryIds: [] as string[],
  locationIds: [] as string[],
  skus: [] as Array<{ id: string; label: string }>,
  blindMode: true,
  remark: '',
})

const loadData = () => {
  loading.value = true
  const query = {
    page: pagination.page,
    pageSize: pagination.pageSize,
    keyword: filters.keyword.trim() || undefined,
    status: filters.status || undefined,
  }
  return listRequest.runLatest({
    executor: (signal) => getStocktakes(query, { signal }),
    onSuccess: (result) => {
      rows.value = result.list
      pagination.total = result.total
    },
    onError: (error) => {
      showAppError(error, '盘点单加载失败')
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

const openCreate = async () => {
  Object.assign(createForm, { scopeType: 'all', categoryIds: [], locationIds: [], skus: [], blindMode: true, remark: '' })
  createVisible.value = true
  try {
    const [categoryRows, locationRows] = await Promise.all([getCategories(), getLocations()])
    categories.value = categoryRows.filter((item) => item.isActive)
    locations.value = locationRows.filter((item) => item.isActive)
  } catch (error) {
    showAppError(error, '分类与库位加载失败')
  }
}

const addSku = async () => {
  const code = skuCode.value.trim()
  if (!code) return
  try {
    const result = await lookupProductByCode(code, 'stocktake')
    if (!createForm.skus.some((item) => item.id === result.sku.id)) {
      createForm.skus.push({ id: result.sku.id, label: `${result.product.productName} · ${result.sku.specText}（${result.sku.skuCode}）` })
    }
    skuCode.value = ''
  } catch (error) {
    showAppError(error, `未识别条码 ${code}`)
  }
}

const handleCreate = async () => {
  if (createForm.scopeType === 'category' && !createForm.categoryIds.length) return showAppWarning('请选择要盘点的分类')
  if (createForm.scopeType === 'location' && !createForm.locationIds.length) return showAppWarning('请选择要盘点的库位')
  if (createForm.scopeType === 'sku' && !createForm.skus.length) return showAppWarning('请至少添加一个商品规格')
  creating.value = true
  try {
    const created = await createStocktake({
      scopeType: createForm.scopeType,
      categoryIds: createForm.scopeType === 'category' ? createForm.categoryIds : undefined,
      locationIds: createForm.scopeType === 'location' ? createForm.locationIds : undefined,
      skuIds: createForm.scopeType === 'sku' ? createForm.skus.map((item) => item.id) : undefined,
      blindMode: createForm.blindMode,
      remark: createForm.remark.trim() || null,
    })
    showAppSuccess(`已创建盘点单 ${created.stocktakeNo}，共 ${created.itemCount} 个规格`)
    createVisible.value = false
    void router.push(`/inventory/stocktakes/${created.id}`)
  } catch (error) {
    showAppError(error, '创建盘点单失败')
  } finally {
    creating.value = false
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
  <PageContainer title="库存盘点" description="创建盘点单后扫码逐个计数，提交后核对账实差异并确认调账。">
    <el-card shadow="never" class="mb-4">
      <div class="flex flex-wrap gap-3">
        <el-input v-model="filters.keyword" placeholder="盘点单号 / 范围 / 备注" clearable class="w-56" @keyup.enter="search" />
        <el-select v-model="filters.status" placeholder="全部状态" clearable class="w-32">
          <el-option v-for="(item, key) in STOCKTAKE_STATUS_LABELS" :key="key" :label="item.label" :value="key" />
        </el-select>
        <el-button type="primary" @click="search">查询</el-button>
        <el-button v-if="canCreate" type="success" class="ml-auto" @click="openCreate">新建盘点单</el-button>
      </div>
    </el-card>

    <el-card shadow="never">
      <el-table v-loading="loading" :data="rows" row-key="id" empty-text="还没有盘点单" @row-click="(row: StocktakeRecord) => router.push(`/inventory/stocktakes/${row.id}`)">
        <el-table-column prop="stocktakeNo" label="盘点单号" width="150" />
        <el-table-column prop="scopeLabel" label="盘点范围" min-width="180" show-overflow-tooltip />
        <el-table-column label="模式" width="80">
          <template #default="{ row }">{{ row.blindMode ? '盲盘' : '明盘' }}</template>
        </el-table-column>
        <el-table-column label="进度" width="160">
          <template #default="{ row }">
            <el-progress :percentage="row.itemCount ? Math.round((row.countedCount / row.itemCount) * 100) : 0" :stroke-width="8">
              <span class="text-xs">{{ row.countedCount }}/{{ row.itemCount }}</span>
            </el-progress>
          </template>
        </el-table-column>
        <el-table-column label="差异" width="70" align="right">
          <template #default="{ row }">{{ row.diffCount ?? '—' }}</template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag size="small" :type="STOCKTAKE_STATUS_LABELS[row.status]?.type">{{ STOCKTAKE_STATUS_LABELS[row.status]?.label ?? row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="创建" width="170">
          <template #default="{ row }">
            <div>{{ row.createdByName || '—' }}</div>
            <div class="text-xs text-slate-500">{{ new Date(row.createdAt).toLocaleString('zh-CN', { hour12: false }) }}</div>
          </template>
        </el-table-column>
        <el-table-column label="" width="80" fixed="right">
          <template #default><el-button link type="primary">进入</el-button></template>
        </el-table-column>
      </el-table>
      <PagePaginationBar
        v-model:current-page="pagination.page"
        v-model:page-size="pagination.pageSize"
        :total="pagination.total"
        layout="total, prev, pager, next"
        class="mt-4"
        @current-change="loadData"
      />
    </el-card>

    <BizCrudDialogShell
      v-model="createVisible"
      title="新建盘点单"
      height-mode="auto"
      desktop-width="560px"
      :confirm-loading="creating"
      confirm-text="创建并开始盘点"
      @confirm="handleCreate"
    >
      <el-form label-width="88px" @submit.prevent>
        <el-form-item label="盘点范围">
          <el-radio-group v-model="createForm.scopeType">
            <el-radio-button value="all">全部商品</el-radio-button>
            <el-radio-button value="category">按分类</el-radio-button>
            <el-radio-button value="location">按库位</el-radio-button>
            <el-radio-button value="sku">指定商品</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="createForm.scopeType === 'category'" label="分类">
          <el-select v-model="createForm.categoryIds" multiple filterable placeholder="选择分类" class="w-full">
            <el-option v-for="item in categories" :key="item.id" :label="`${item.categoryCode} ${item.categoryName}`" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="createForm.scopeType === 'location'" label="库位">
          <el-select v-model="createForm.locationIds" multiple filterable placeholder="选择库位" class="w-full">
            <el-option v-for="item in locations" :key="item.id" :label="item.locationCode" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="createForm.scopeType === 'sku'" label="商品">
          <div class="w-full space-y-2">
            <el-input v-model="skuCode" placeholder="扫码或输入条码 / SKU 编码后回车" @keyup.enter="addSku" />
            <div class="flex flex-wrap gap-2">
              <el-tag
                v-for="(item, index) in createForm.skus"
                :key="item.id"
                closable
                @close="createForm.skus.splice(index, 1)"
              >{{ item.label }}</el-tag>
            </div>
          </div>
        </el-form-item>
        <el-form-item label="盲盘">
          <div>
            <el-switch v-model="createForm.blindMode" />
            <div class="text-xs text-slate-500">开启后，盘点人员只看到商品信息，看不到系统账面库存。</div>
          </div>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="createForm.remark" maxlength="255" placeholder="可选，如 月末全盘" />
        </el-form-item>
      </el-form>
    </BizCrudDialogShell>
  </PageContainer>
</template>
