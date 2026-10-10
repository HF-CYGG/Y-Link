<script setup lang="ts">
/**
 * 模块说明：库位关联规格管理弹窗。
 * 文件职责：分页查看当前库位关联的 SKU 与可移入 SKU，并修改 SKU 的默认库位。
 * 实现逻辑：列表请求只接受最后一次结果；写入携带读取时的库位以阻止覆盖并发变更。
 * 维护说明：库位关联不等于库存数量，移入移出都不能在前端模拟库存变化。
 */
import { computed, ref, watch } from 'vue'
import { ElMessageBox } from 'element-plus'
import { getLocationSkus, updateLocationSku, type LocationRecord, type LocationSkuRecord } from '@/api/modules/inventory'
import { useStableRequest } from '@/composables/useStableRequest'
import { showAppError, showAppSuccess } from '@/utils/app-alert'
import { normalizeRequestError } from '@/utils/error'

const props = defineProps<{ modelValue: boolean; location: LocationRecord | null }>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  updated: []
}>()

const scope = ref<'assigned' | 'other'>('assigned')
const keyword = ref('')
const appliedKeyword = ref('')
const page = ref(1)
const pageSize = 10
const total = ref(0)
const rows = ref<LocationSkuRecord[]>([])
const loading = ref(false)
const pendingSkuId = ref<string | null>(null)
const listRequest = useStableRequest()
const dialogTitle = computed(() => `管理规格 · ${props.location?.locationCode ?? ''}`)

const loadSkus = async () => {
  if (!props.modelValue || !props.location) return
  const locationId = props.location.id
  const requestedScope = scope.value
  loading.value = true
  await listRequest.runLatest({
    executor: (signal) => getLocationSkus(locationId, {
      scope: requestedScope,
      keyword: appliedKeyword.value,
      page: page.value,
      pageSize,
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
    loading.value = false
    return
  }
  if (!previous?.[0] || id !== previous?.[1]) {
    scope.value = 'assigned'
    keyword.value = ''
    appliedKeyword.value = ''
    page.value = 1
    void loadSkus()
  }
}, { immediate: true })

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

const changePage = (value: number) => {
  page.value = value
  void loadSkus()
}

const changeAssignment = async (row: LocationSkuRecord) => {
  const location = props.location
  if (!location || pendingSkuId.value) return
  const removing = scope.value === 'assigned'
  const action = removing ? 'remove' : 'assign'
  pendingSkuId.value = row.skuId
  try {
    const target = removing ? '未设置默认库位' : location.locationCode
    const from = row.locationCode || '未设置默认库位'
    const stockNote = row.currentStock > 0 ? `该规格当前库存 ${row.currentStock} 件。` : ''
    await ElMessageBox.confirm(
      `将「${row.productName} · ${row.specText}」的默认库位从「${from}」改为「${target}」？${stockNote}此操作不会增减库存数量，但会改变找货与按库位盘点范围。`,
      removing ? '确认移出规格' : '确认移入规格',
      { type: 'warning', confirmButtonText: removing ? '确认移出' : '确认移入', cancelButtonText: '取消' },
    )
    await updateLocationSku(location.id, row.skuId, { action, expectedLocationId: row.locationId })
    showAppSuccess(removing ? '已移出规格' : '已移入规格')
    emit('updated')
    if (props.modelValue && props.location?.id === location.id) {
      if (rows.value.length === 1 && page.value > 1) page.value -= 1
      await loadSkus()
    }
  } catch (error) {
    if (error === 'cancel' || error === 'close') return
    const normalized = normalizeRequestError(error, '库位关联修改失败')
    showAppError(normalized.status === 409 ? '规格的库位已发生变化，请刷新列表后重试' : error, '库位关联修改失败')
    if (normalized.status === 409 && props.modelValue && props.location?.id === location.id) await loadSkus()
  } finally {
    pendingSkuId.value = null
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="dialogTitle"
    width="min(920px, 94vw)"
    append-to-body
    destroy-on-close
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="space-y-4">
      <p class="text-sm leading-6 text-slate-600 dark:text-slate-300">
        这里管理当前有效版本 SKU 的默认库位关联，包含已停用规格。关联数不是库存件数；变更库位不会增减库存，但会影响找货与按库位盘点范围。
      </p>
      <div class="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
        <el-radio-group :model-value="scope" size="default" @update:model-value="changeScope($event as 'assigned' | 'other')">
          <el-radio-button value="assigned">已关联</el-radio-button>
          <el-radio-button value="other">其他规格</el-radio-button>
        </el-radio-group>
        <div class="flex w-full min-w-0 gap-2 sm:w-auto sm:flex-1 sm:justify-end">
          <el-input v-model="keyword" clearable class="min-w-0 flex-1 sm:max-w-64" placeholder="搜索商品、规格或 SKU 编码" @keyup.enter="search" />
          <el-button class="!ml-0" @click="search">搜索</el-button>
        </div>
      </div>
      <div v-loading="loading" class="min-h-40">
        <el-table :data="rows" row-key="skuId" class="hidden sm:block" :empty-text="scope === 'assigned' ? '暂无关联规格' : '暂无可移入规格'">
          <el-table-column label="商品与规格" min-width="220">
            <template #default="{ row }">
              <div class="font-medium">{{ row.productName }}</div>
              <div class="text-xs text-slate-500 dark:text-slate-400">{{ row.specText }}</div>
            </template>
          </el-table-column>
          <el-table-column prop="skuCode" label="SKU 编码" min-width="140" />
          <el-table-column label="当前库位" min-width="130">
            <template #default="{ row }">{{ row.locationCode || '未设置' }}</template>
          </el-table-column>
          <el-table-column prop="currentStock" label="库存件数" width="96" />
          <el-table-column label="状态" width="72">
            <template #default="{ row }"><el-tag :type="row.isActive ? 'success' : 'info'" size="small">{{ row.isActive ? '启用' : '停用' }}</el-tag></template>
          </el-table-column>
          <el-table-column label="操作" width="94" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" :loading="pendingSkuId === row.skuId" :disabled="pendingSkuId !== null || loading" @click="changeAssignment(row)">
                {{ scope === 'assigned' ? '移出' : '移入' }}
              </el-button>
            </template>
          </el-table-column>
        </el-table>
        <div class="space-y-2 sm:hidden">
          <div v-for="row in rows" :key="row.skuId" class="rounded-lg border border-slate-200 p-3 dark:border-white/10">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0 break-words font-medium">{{ row.productName }} · {{ row.specText }}</div>
              <el-tag :type="row.isActive ? 'success' : 'info'" size="small">{{ row.isActive ? '启用' : '停用' }}</el-tag>
            </div>
            <div class="mt-2 break-all text-xs text-slate-500 dark:text-slate-400">SKU {{ row.skuCode }} · 当前库位 {{ row.locationCode || '未设置' }} · 库存 {{ row.currentStock }} 件</div>
            <div class="mt-2 text-right">
              <el-button size="small" :loading="pendingSkuId === row.skuId" :disabled="pendingSkuId !== null || loading" @click="changeAssignment(row)">
                {{ scope === 'assigned' ? '移出此库位' : '移入此库位' }}
              </el-button>
            </div>
          </div>
          <el-empty v-if="!loading && rows.length === 0" :description="scope === 'assigned' ? '暂无关联规格' : '暂无可移入规格'" :image-size="60" />
        </div>
      </div>
      <div class="flex justify-end">
        <el-pagination :current-page="page" :page-size="pageSize" :total="total" layout="prev, pager, next, total" :pager-count="5" small background @current-change="changePage" />
      </div>
    </div>
    <template #footer><el-button @click="emit('update:modelValue', false)">关闭</el-button></template>
  </el-dialog>
</template>
