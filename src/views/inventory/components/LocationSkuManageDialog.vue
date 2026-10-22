<script setup lang="ts">
/**
 * 模块说明：src/views/inventory/components/LocationSkuManageDialog.vue
 * 文件职责：分页查看当前库位关联的规格与可移入规格，支持按分类、标签、规格状态组合筛选，按数量移入 / 拨转，以及单条或批量整体移入、移出。
 * 实现逻辑：
 * - 列表请求只接受最后一次结果，切换范围、任一筛选条件、关键字或分页时清空勾选，避免批量操作带上看不见的行；
 * - 同一规格可分放多个库位：“已关联”= 主库位在此或在此拆有件数，列表展示本库位件数与整体分布；
 * - “移入”与“拨转”打开 SkuLocationTransferDialog 按数量拨转（移入时目标固定为本库位）；
 * - 整体移入 / 移出（单条与批量）都携带读取时的主库位作为并发基线，服务端任一行不一致即整批 409，前端提示后刷新列表；
 * - 筛选全部由服务端执行：分类含“未分类”，标签按商品关联命中（含系列标签），状态按规格启停；
 * - 分类选项由父页面传入，停用分类仍可筛选以便清理历史关联；标签选项在首次打开时按 tags:view 权限懒加载，无权限时隐藏该筛选。
 * 维护说明：
 * - 库位操作只搬动件数、不增减总库存，前端不要模拟任何库存变化；
 * - 批量单次上限与后端 locationSkuBatchChangeSchema 保持一致（100 条），调整每页条数选项时不要超过该值。
 */
import { computed, defineAsyncComponent, ref, watch } from 'vue'
import { ElMessageBox, type TableInstance } from 'element-plus'
import {
  getLocationSkus,
  updateLocationSku,
  updateLocationSkus,
  type CategoryRecord,
  type LocationRecord,
  type LocationSkuRecord,
} from '@/api/modules/inventory'
import { getTagList, type Tag } from '@/api/modules/tag'
import { usePermissionAction } from '@/composables/usePermissionAction'
import { useStableRequest } from '@/composables/useStableRequest'
import { showAppError, showAppSuccess } from '@/utils/app-alert'
import { normalizeRequestError } from '@/utils/error'

const UNCATEGORIZED_FILTER = 'none'

// 拨转弹窗只在点击“移入 / 拨转”时用到，异步拆包，不进入库位页主包。
const SkuLocationTransferDialog = defineAsyncComponent(() => import('./SkuLocationTransferDialog.vue'))

const props = defineProps<{ modelValue: boolean; location: LocationRecord | null; categories?: CategoryRecord[]; locations?: LocationRecord[] }>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  updated: []
}>()

const scope = ref<'assigned' | 'other'>('assigned')
const keyword = ref('')
const appliedKeyword = ref('')
const categoryId = ref('')
const tagId = ref('')
const skuStatus = ref<'' | 'active' | 'inactive'>('')
const tagOptions = ref<Tag[]>([])
const tagsLoaded = ref(false)
const tagsLoading = ref(false)
const { hasPermission } = usePermissionAction()
const canFilterByTag = computed(() => hasPermission('tags:view'))
const hasActiveFilters = computed(() => Boolean(categoryId.value || tagId.value || skuStatus.value || appliedKeyword.value))
const page = ref(1)
const pageSize = ref(10)
const total = ref(0)
const rows = ref<LocationSkuRecord[]>([])
const loading = ref(false)
const pendingSkuId = ref<string | null>(null)
const batchSubmitting = ref(false)
const selectedRows = ref<LocationSkuRecord[]>([])
const tableRef = ref<TableInstance>()
const listRequest = useStableRequest()
const dialogTitle = computed(() => `管理规格 · ${props.location?.locationCode ?? ''}`)
const categoryOptions = computed(() => props.categories ?? [])
const selectedSkuIds = computed(() => new Set(selectedRows.value.map((row) => row.skuId)))
const busy = computed(() => pendingSkuId.value !== null || batchSubmitting.value || loading.value)
const batchActionLabel = computed(() => (scope.value === 'assigned' ? '批量移出' : '批量整体移入'))

// 按数量拨转弹窗状态：移入时目标固定为本库位，拨转时从本库位拨出、目标可多选。
const transferVisible = ref(false)
const transferRow = ref<LocationSkuRecord | null>(null)
const transferMode = ref<'move-in' | 'move-out'>('move-in')
const transferLabel = computed(() => (transferRow.value ? `${transferRow.value.productName} · ${transferRow.value.specText}` : ''))

/** 库位分布文本，例如“主 A-01-01 ×6 · C-03-05 ×4”。 */
const describeDistribution = (row: LocationSkuRecord) => {
  const parts = [`主 ${row.locationCode || '未设置'} ×${row.mainQty}`]
  for (const item of row.otherLocations) parts.push(`${item.locationCode} ×${item.qty}`)
  return parts.join(' · ')
}

const openTransfer = (row: LocationSkuRecord, mode: 'move-in' | 'move-out') => {
  if (busy.value) return
  transferRow.value = row
  transferMode.value = mode
  transferVisible.value = true
}

const handleTransferred = async () => {
  const location = props.location
  emit('updated')
  if (location) await reloadAfterChange(location.id, transferMode.value === 'move-in' ? 1 : 0)
}

const clearSelection = () => {
  selectedRows.value = []
  tableRef.value?.clearSelection()
}

const loadSkus = async () => {
  if (!props.modelValue || !props.location) return
  const locationId = props.location.id
  const requestedScope = scope.value
  loading.value = true
  clearSelection()
  await listRequest.runLatest({
    executor: (signal) => getLocationSkus(locationId, {
      scope: requestedScope,
      keyword: appliedKeyword.value,
      categoryId: categoryId.value,
      tagId: tagId.value,
      status: skuStatus.value || undefined,
      page: page.value,
      pageSize: pageSize.value,
    }, { signal }),
    onSuccess: (result) => {
      if (!props.modelValue || props.location?.id !== locationId || scope.value !== requestedScope) return
      rows.value = result.list
      total.value = result.total
    },
    onError: (error) => { showAppError(error, '规格列表加载失败') },
    onFinally: () => { loading.value = false },
  })
}

watch([() => props.modelValue, () => props.location?.id], ([visible, id], previous) => {
  if (!visible || !id) {
    listRequest.cancel()
    rows.value = []
    total.value = 0
    selectedRows.value = []
    loading.value = false
    return
  }
  if (!previous?.[0] || id !== previous?.[1]) {
    scope.value = 'assigned'
    keyword.value = ''
    appliedKeyword.value = ''
    categoryId.value = ''
    tagId.value = ''
    skuStatus.value = ''
    page.value = 1
    void loadSkus()
    void loadTagOptions()
  }
}, { immediate: true })

/** 标签只在首次打开时拉一次；失败不影响列表，仅提示并允许下次打开重试。 */
async function loadTagOptions() {
  if (tagsLoaded.value || tagsLoading.value || !canFilterByTag.value) return
  tagsLoading.value = true
  try {
    tagOptions.value = await getTagList()
    tagsLoaded.value = true
  } catch (error) {
    showAppError(error, '标签列表加载失败')
  } finally {
    tagsLoading.value = false
  }
}

const changeScope = (value: 'assigned' | 'other') => {
  scope.value = value
  page.value = 1
  rows.value = []
  void loadSkus()
}

const search = () => {
  appliedKeyword.value = keyword.value.trim()
  page.value = 1
  void loadSkus()
}

const changeCategory = (value: string | undefined) => {
  categoryId.value = value ?? ''
  page.value = 1
  void loadSkus()
}

const changeTag = (value: string | undefined) => {
  tagId.value = value ?? ''
  page.value = 1
  void loadSkus()
}

const changeStatus = (value: '' | 'active' | 'inactive' | undefined) => {
  skuStatus.value = value ?? ''
  page.value = 1
  void loadSkus()
}

const resetFilters = () => {
  categoryId.value = ''
  tagId.value = ''
  skuStatus.value = ''
  keyword.value = ''
  appliedKeyword.value = ''
  page.value = 1
  void loadSkus()
}

const changePage = (value: number) => {
  page.value = value
  void loadSkus()
}

const changePageSize = (value: number) => {
  pageSize.value = value
  page.value = 1
  void loadSkus()
}

const handleSelectionChange = (selection: LocationSkuRecord[]) => {
  selectedRows.value = selection
}

const toggleMobileSelection = (row: LocationSkuRecord, checked: boolean) => {
  selectedRows.value = checked
    ? [...selectedRows.value.filter((item) => item.skuId !== row.skuId), row]
    : selectedRows.value.filter((item) => item.skuId !== row.skuId)
}

/** 写入后刷新：当前页被清空时回退一页，避免停在空页。 */
const reloadAfterChange = async (locationId: string, removedCount: number) => {
  if (!props.modelValue || props.location?.id !== locationId) return
  if (removedCount >= rows.value.length && page.value > 1) page.value -= 1
  await loadSkus()
}

const handleConflict = async (error: unknown, locationId: string, fallback: string) => {
  const normalized = normalizeRequestError(error, fallback)
  showAppError(normalized.status === 409 ? '规格的库位已发生变化，请刷新列表后重试' : error, fallback)
  if (normalized.status === 409 && props.modelValue && props.location?.id === locationId) await loadSkus()
}

/** 移出本库位：本库位是主库位时清空主库位（件数变为未设置库位）；只是拆分库位时件数并回主库位。 */
const removeFromLocation = async (row: LocationSkuRecord) => {
  const location = props.location
  if (!location || busy.value) return
  pendingSkuId.value = row.skuId
  try {
    const effect = row.isMainHere
      ? `本库位是该规格的主库位，移出后主库位改为“未设置”，这里的 ${row.locationQty} 件变为未设置库位`
      : row.locationId
        ? `这里的 ${row.locationQty} 件将并回主库位「${row.locationCode}」`
        : `该规格当前没有主库位，这里的 ${row.locationQty} 件将变为未设置库位`
    await ElMessageBox.confirm(
      `将「${row.productName} · ${row.specText}」移出「${location.locationCode}」？${effect}。此操作不会增减总库存。`,
      '确认移出规格',
      { type: 'warning', confirmButtonText: '确认移出', cancelButtonText: '取消' },
    )
    await updateLocationSku(location.id, row.skuId, { action: 'remove', expectedLocationId: row.locationId })
    showAppSuccess('已移出规格')
    emit('updated')
    await reloadAfterChange(location.id, 1)
  } catch (error) {
    if (error === 'cancel' || error === 'close') return
    await handleConflict(error, location.id, '移出库位失败')
  } finally {
    pendingSkuId.value = null
  }
}

const changeAssignmentInBatch = async () => {
  const location = props.location
  const targets = [...selectedRows.value]
  if (!location || busy.value || !targets.length) return
  const removing = scope.value === 'assigned'
  batchSubmitting.value = true
  try {
    const movedQty = targets.reduce((sum, row) => sum + Math.max(0, removing ? row.locationQty : row.mainQty), 0)
    const effect = removing
      ? `主库位在此的规格改为未设置主库位，拆分在此的件数并回各自主库位，涉及 ${movedQty} 件`
      : `各规格主库位的全部件数（合计 ${movedQty} 件）搬到「${location.locationCode}」并设为主库位，其他库位的件数保持不动`
    await ElMessageBox.confirm(
      `将选中的 ${targets.length} 个规格${removing ? `移出「${location.locationCode}」` : '整体移入'}？${effect}。此操作不会增减总库存。需要只移入部分件数时，请使用单行的“移入”。`,
      removing ? '确认批量移出' : '确认批量整体移入',
      { type: 'warning', confirmButtonText: removing ? '确认移出' : '确认移入', cancelButtonText: '取消' },
    )
    const result = await updateLocationSkus(location.id, {
      action: removing ? 'remove' : 'assign',
      items: targets.map((row) => ({ skuId: row.skuId, expectedLocationId: row.locationId })),
    })
    showAppSuccess(`已${removing ? '移出' : '整体移入'} ${result.updatedCount} 个规格`)
    emit('updated')
    await reloadAfterChange(location.id, targets.length)
  } catch (error) {
    if (error === 'cancel' || error === 'close') return
    await handleConflict(error, location.id, removing ? '批量移出失败' : '批量整体移入失败')
  } finally {
    batchSubmitting.value = false
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="dialogTitle"
    width="min(980px, 94vw)"
    append-to-body
    destroy-on-close
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="space-y-4">
      <p class="text-sm leading-6 text-slate-600 dark:text-slate-300">
        同一规格可以分放在多个库位：主库位件数 = 总库存减去其他库位件数，入库默认落在主库位。“移入”和“拨转”可以选择件数；整体移入会把主库位的全部件数搬到本库位并设为主库位。库位操作不会增减总库存，但会影响找货与按库位盘点。
      </p>
      <div class="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
        <el-radio-group :model-value="scope" size="default" @update:model-value="changeScope($event as 'assigned' | 'other')">
          <el-radio-button value="assigned">已关联</el-radio-button>
          <el-radio-button value="other">其他规格</el-radio-button>
        </el-radio-group>
        <div class="flex min-w-0 flex-1 gap-2 sm:justify-end">
          <el-input v-model="keyword" clearable class="min-w-0 flex-1 sm:max-w-72" placeholder="搜索商品、规格或 SKU 编码" @keyup.enter="search" />
          <el-button class="!ml-0" @click="search">搜索</el-button>
        </div>
      </div>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-[repeat(3,minmax(0,1fr))_auto]">
        <el-select
          :model-value="categoryId"
          clearable
          filterable
          placeholder="全部分类"
          @update:model-value="changeCategory"
        >
          <el-option label="未分类" :value="UNCATEGORIZED_FILTER" />
          <el-option
            v-for="category in categoryOptions"
            :key="category.id"
            :label="`${category.categoryCode} ${category.categoryName}${category.isActive ? '' : '（已停用）'}`"
            :value="category.id"
          />
        </el-select>
        <el-select
          v-if="canFilterByTag"
          :model-value="tagId"
          clearable
          filterable
          :loading="tagsLoading"
          placeholder="全部标签"
          @update:model-value="changeTag"
        >
          <el-option
            v-for="tag in tagOptions"
            :key="tag.id"
            :label="tag.seriesCode ? `${tag.tagName}（${tag.seriesCode}）` : tag.tagName"
            :value="tag.id"
          />
        </el-select>
        <el-select
          :model-value="skuStatus"
          clearable
          placeholder="全部状态"
          @update:model-value="changeStatus"
        >
          <el-option label="启用规格" value="active" />
          <el-option label="停用规格" value="inactive" />
        </el-select>
        <el-button class="!ml-0" :disabled="!hasActiveFilters" @click="resetFilters">重置筛选</el-button>
      </div>
      <div class="flex flex-wrap items-center justify-between gap-2 text-sm text-slate-500 dark:text-slate-400">
        <span>已选 {{ selectedRows.length }} 个规格</span>
        <div class="flex gap-2">
          <el-button v-if="selectedRows.length" size="small" :disabled="busy" @click="clearSelection">清空选择</el-button>
          <el-button
            size="small"
            :type="scope === 'assigned' ? 'default' : 'primary'"
            :disabled="!selectedRows.length || (busy && !batchSubmitting)"
            :loading="batchSubmitting"
            @click="changeAssignmentInBatch"
          >
            {{ batchActionLabel }}{{ selectedRows.length ? ` (${selectedRows.length})` : '' }}
          </el-button>
        </div>
      </div>
      <div v-loading="loading" class="min-h-40">
        <el-table
          ref="tableRef"
          :data="rows"
          row-key="skuId"
          class="hidden sm:block"
          :empty-text="scope === 'assigned' ? '暂无关联规格' : '暂无可移入规格'"
          @selection-change="handleSelectionChange"
        >
          <el-table-column type="selection" width="44" :selectable="() => !busy" />
          <el-table-column label="商品与规格" min-width="220">
            <template #default="{ row }">
              <div class="font-medium">{{ row.productName }}</div>
              <div class="text-xs text-slate-500 dark:text-slate-400">
                {{ row.specText }}<template v-if="row.categoryName"> · {{ row.categoryName }}</template>
              </div>
            </template>
          </el-table-column>
          <el-table-column prop="skuCode" label="SKU 编码" min-width="140" />
          <el-table-column label="库位分布" min-width="190">
            <template #default="{ row }">
              <span class="text-xs leading-5">{{ describeDistribution(row) }}</span>
            </template>
          </el-table-column>
          <el-table-column v-if="scope === 'assigned'" label="本库位件数" width="104">
            <template #default="{ row }">
              {{ row.locationQty }}<el-tag v-if="row.isMainHere" size="small" class="ml-1">主</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="currentStock" label="总库存" width="80" />
          <el-table-column label="状态" width="72">
            <template #default="{ row }"><el-tag :type="row.isActive ? 'success' : 'info'" size="small">{{ row.isActive ? '启用' : '停用' }}</el-tag></template>
          </el-table-column>
          <el-table-column label="操作" width="110" fixed="right">
            <template #default="{ row }">
              <template v-if="scope === 'assigned'">
                <el-button link type="primary" :disabled="busy || row.currentStock <= 0" @click="openTransfer(row, 'move-out')">拨转</el-button>
                <el-button link type="danger" :loading="pendingSkuId === row.skuId" :disabled="busy" @click="removeFromLocation(row)">移出</el-button>
              </template>
              <el-button v-else link type="primary" :disabled="busy || row.currentStock <= 0" @click="openTransfer(row, 'move-in')">移入</el-button>
            </template>
          </el-table-column>
        </el-table>
        <div class="space-y-2 sm:hidden">
          <div v-for="row in rows" :key="row.skuId" class="rounded-lg border border-slate-200 p-3 dark:border-white/10">
            <div class="flex items-start justify-between gap-2">
              <el-checkbox
                :model-value="selectedSkuIds.has(row.skuId)"
                :disabled="busy"
                class="min-w-0 !h-auto !items-start !whitespace-normal"
                @update:model-value="toggleMobileSelection(row, Boolean($event))"
              >
                <span class="break-words font-medium">{{ row.productName }} · {{ row.specText }}</span>
              </el-checkbox>
              <el-tag :type="row.isActive ? 'success' : 'info'" size="small">{{ row.isActive ? '启用' : '停用' }}</el-tag>
            </div>
            <div class="mt-2 break-all text-xs text-slate-500 dark:text-slate-400">
              SKU {{ row.skuCode }}<template v-if="row.categoryName"> · {{ row.categoryName }}</template> · 总库存 {{ row.currentStock }} 件
              <template v-if="scope === 'assigned'"> · 本库位 {{ row.locationQty }} 件{{ row.isMainHere ? '（主库位）' : '' }}</template>
            </div>
            <div class="mt-1 break-all text-xs text-slate-500 dark:text-slate-400">
              {{ describeDistribution(row) }}
            </div>
            <div class="mt-2 flex justify-end gap-2">
              <template v-if="scope === 'assigned'">
                <el-button size="small" :disabled="busy || row.currentStock <= 0" @click="openTransfer(row, 'move-out')">拨转</el-button>
                <el-button size="small" :loading="pendingSkuId === row.skuId" :disabled="busy" @click="removeFromLocation(row)">移出此库位</el-button>
              </template>
              <el-button v-else size="small" :disabled="busy || row.currentStock <= 0" @click="openTransfer(row, 'move-in')">移入此库位</el-button>
            </div>
          </div>
          <el-empty v-if="!loading && rows.length === 0" :description="scope === 'assigned' ? '暂无关联规格' : '暂无可移入规格'" :image-size="60" />
        </div>
      </div>
      <div class="flex justify-end">
        <el-pagination
          :current-page="page"
          :page-size="pageSize"
          :page-sizes="[10, 20, 50, 100]"
          :total="total"
          layout="total, sizes, prev, pager, next"
          :pager-count="5"
          size="small"
          background
          @current-change="changePage"
          @size-change="changePageSize"
        />
      </div>
    </div>
    <template #footer><el-button @click="emit('update:modelValue', false)">关闭</el-button></template>
    <SkuLocationTransferDialog
      v-if="transferRow"
      v-model="transferVisible"
      :sku-id="transferRow.skuId"
      :sku-label="transferLabel"
      :locations="locations ?? []"
      :fixed-target-location-id="transferMode === 'move-in' ? location?.id ?? null : null"
      :default-source-location-id="transferMode === 'move-out' ? location?.id ?? null : undefined"
      @transferred="handleTransferred"
    />
  </el-dialog>
</template>
