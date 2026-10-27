<script setup lang="ts">
/**
 * 模块说明：src/views/inventory/components/SkuLocationTransferDialog.vue
 * 文件职责：展示单个规格在各库位的件数分布，并按数量把件数从来源库位拨到一个或多个目标库位。
 * 实现逻辑：
 * - 打开时读取服务端最新分布（主库位件数 = 总库存 − 其他库位件数之和），来源只能选有件数的库位；
 * - 目标库位可多选并分别填写件数，合计不能超过来源件数；传入 fixedTargetLocationId 时目标固定为该库位
 *   （库位管理弹窗里的“移入”），此时只填一个件数；
 * - 只有一个目标时可勾选“同时设为主库位”，原主库位剩余件数保留在原库位；
 * - 多个目标按顺序逐个提交，每次都携带来源件数基线；任一次 409 即停止并刷新分布，已成功的拨转不回滚。
 * 维护说明：
 * - 拨转只搬动件数，不增减总库存、不写库存流水，界面上不要做任何库存数量的乐观更新；
 * - 停用库位只能作为来源、不能作为目标，与服务端校验保持一致。
 */
import { computed, ref, watch } from 'vue'
import {
  getSkuLocationDistribution,
  transferLocationSku,
  type LocationRecord,
  type SkuLocationDistribution,
} from '@/api/modules/inventory'
import { showAppError, showAppSuccess } from '@/utils/app-alert'
import { normalizeRequestError } from '@/utils/error'

/** 主库位为空时的来源选项值（el-select 不能用 null 作为选项值）。 */
const UNASSIGNED_SOURCE = '__unassigned__'

const props = defineProps<{
  modelValue: boolean
  skuId: string | null
  /** 弹窗标题里的商品与规格名称。 */
  skuLabel?: string
  /** 全部库位（含停用），用于目标库位选项与编码展示。 */
  locations: LocationRecord[]
  /** 固定目标库位：库位管理里“移入本库位”时传入。 */
  fixedTargetLocationId?: string | null
  /** 默认来源库位；不传时默认主库位。 */
  defaultSourceLocationId?: string | null
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  transferred: []
}>()

const loading = ref(false)
const submitting = ref(false)
const distribution = ref<SkuLocationDistribution | null>(null)
const sourceKey = ref('')
const targetIds = ref<string[]>([])
const qtyByTarget = ref<Record<string, number>>({})
const setAsMain = ref(false)

const locationCodeOf = (id: string | null) => {
  if (!id) return '未设置库位'
  return props.locations.find((location) => location.id === id)?.locationCode ?? id
}

const sourceOptions = computed(() => {
  const current = distribution.value
  if (!current) return []
  return [
    {
      key: current.mainLocationId ?? UNASSIGNED_SOURCE,
      locationId: current.mainLocationId,
      label: `${current.mainLocationCode ?? '未设置库位'}（主库位）`,
      qty: current.mainQty,
    },
    ...current.others.map((item) => ({ key: item.locationId, locationId: item.locationId, label: item.locationCode, qty: item.qty })),
  ]
})

const selectedSource = computed(() => sourceOptions.value.find((option) => option.key === sourceKey.value) ?? null)
const sourceQty = computed(() => selectedSource.value?.qty ?? 0)

const targetOptions = computed(() => props.locations
  .filter((location) => location.isActive && location.id !== selectedSource.value?.locationId))

const totalQty = computed(() => targetIds.value.reduce((sum, id) => sum + Math.max(0, Number(qtyByTarget.value[id] ?? 0)), 0))
const canSetAsMain = computed(() => targetIds.value.length === 1 && targetIds.value[0] !== distribution.value?.mainLocationId)
const submitError = computed(() => {
  if (!selectedSource.value) return '请选择来源库位'
  if (sourceQty.value <= 0) return '来源库位没有件数可拨出'
  if (!targetIds.value.length) return '请选择目标库位'
  if (targetIds.value.some((id) => !Number.isInteger(qtyByTarget.value[id]) || (qtyByTarget.value[id] ?? 0) < 1)) return '每个目标库位的件数至少为 1'
  if (totalQty.value > sourceQty.value) return `拨出合计 ${totalQty.value} 件，超过来源库位的 ${sourceQty.value} 件`
  return ''
})

const dialogTitle = computed(() => (props.skuLabel ? `库位拨转 · ${props.skuLabel}` : '库位拨转'))

const resetForm = () => {
  const current = distribution.value
  const preferred = props.defaultSourceLocationId === undefined ? current?.mainLocationId ?? null : props.defaultSourceLocationId
  const preferredKey = preferred ?? UNASSIGNED_SOURCE
  const fallback = sourceOptions.value.find((option) => option.qty > 0)?.key ?? sourceOptions.value[0]?.key ?? ''
  sourceKey.value = sourceOptions.value.some((option) => option.key === preferredKey && option.qty > 0) ? preferredKey : fallback
  const fixed = props.fixedTargetLocationId ?? null
  targetIds.value = fixed && fixed !== selectedSource.value?.locationId ? [fixed] : []
  qtyByTarget.value = fixed ? { [fixed]: Math.max(1, sourceQty.value) } : {}
  setAsMain.value = false
}

const loadDistribution = async (keepForm = false) => {
  if (!props.skuId) return
  loading.value = true
  try {
    distribution.value = await getSkuLocationDistribution(props.skuId)
    if (!keepForm) resetForm()
  } catch (error) {
    showAppError(error, '库位分布加载失败')
  } finally {
    loading.value = false
  }
}

watch(() => [props.modelValue, props.skuId] as const, ([visible, skuId]) => {
  if (!visible || !skuId) {
    distribution.value = null
    return
  }
  void loadDistribution()
}, { immediate: true })

watch(targetIds, (ids) => {
  const next: Record<string, number> = {}
  // 固定目标（移入本库位）默认搬全部件数；自由多选时每个新目标默认 1 件，避免多选后合计直接超出来源件数。
  for (const id of ids) next[id] = qtyByTarget.value[id] ?? (props.fixedTargetLocationId ? Math.max(1, sourceQty.value) : 1)
  qtyByTarget.value = next
  if (!canSetAsMain.value) setAsMain.value = false
})

watch(sourceKey, () => {
  // 来源变化后，目标里不能再包含来源库位本身。
  targetIds.value = targetIds.value.filter((id) => id !== selectedSource.value?.locationId)
})

const submit = async () => {
  const current = distribution.value
  const source = selectedSource.value
  if (!current || !source || submitError.value || submitting.value || !props.skuId) return
  submitting.value = true
  let remaining = source.qty
  let doneCount = 0
  try {
    for (const targetId of targetIds.value) {
      const qty = Number(qtyByTarget.value[targetId])
      await transferLocationSku(targetId, props.skuId, {
        fromLocationId: source.locationId,
        qty,
        expectedFromQty: remaining,
        expectedMainLocationId: current.mainLocationId,
        setAsMain: canSetAsMain.value && setAsMain.value,
      })
      remaining -= qty
      doneCount += 1
    }
    showAppSuccess(doneCount > 1 ? `已拨转到 ${doneCount} 个库位` : '已完成拨转')
    emit('transferred')
    emit('update:modelValue', false)
  } catch (error) {
    const normalized = normalizeRequestError(error, '库位拨转失败')
    const partial = doneCount > 0 ? `已完成前 ${doneCount} 个库位的拨转，` : ''
    showAppError(normalized.status === 409 ? `${partial}${normalized.message}` : error, '库位拨转失败')
    if (doneCount > 0) emit('transferred')
    await loadDistribution(normalized.status !== 409)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="dialogTitle"
    width="min(640px, 94vw)"
    append-to-body
    destroy-on-close
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div v-loading="loading" class="space-y-4">
      <p class="text-sm leading-6 text-slate-600 dark:text-slate-300">
        拨转只调整件数所在的库位，不增减总库存，也不产生库存流水。主库位件数 = 总库存减去其他库位件数，入库默认落在主库位。
      </p>
      <el-table v-if="distribution" :data="sourceOptions" size="small" class="w-full">
        <el-table-column label="库位" min-width="160">
          <template #default="{ row }">{{ row.label }}</template>
        </el-table-column>
        <el-table-column prop="qty" label="件数" width="100" />
      </el-table>
      <div v-if="distribution" class="text-xs text-slate-500 dark:text-slate-400">
        规格 {{ distribution.skuCode }} · 总库存 {{ distribution.currentStock }} 件
      </div>

      <el-form v-if="distribution" label-position="top" class="space-y-1" @submit.prevent>
        <el-form-item label="来源库位">
          <el-select v-model="sourceKey" class="w-full" placeholder="选择来源库位">
            <el-option
              v-for="option in sourceOptions"
              :key="option.key"
              :label="`${option.label} · ${option.qty} 件`"
              :value="option.key"
              :disabled="option.qty <= 0"
            />
          </el-select>
        </el-form-item>
        <el-form-item :label="fixedTargetLocationId ? '目标库位' : '目标库位（可多选）'">
          <div v-if="fixedTargetLocationId" class="text-sm font-medium">{{ locationCodeOf(fixedTargetLocationId) }}</div>
          <el-select
            v-else
            v-model="targetIds"
            class="w-full"
            multiple
            filterable
            placeholder="选择一个或多个目标库位"
          >
            <el-option
              v-for="location in targetOptions"
              :key="location.id"
              :label="location.locationName ? `${location.locationCode}（${location.locationName}）` : location.locationCode"
              :value="location.id"
            />
          </el-select>
        </el-form-item>
        <div v-if="targetIds.length" class="space-y-2">
          <div
            v-for="targetId in targetIds"
            :key="targetId"
            class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 dark:border-white/10"
          >
            <span class="text-sm">拨到 {{ locationCodeOf(targetId) }}</span>
            <el-input-number
              v-model="qtyByTarget[targetId]"
              :min="1"
              :max="Math.max(1, sourceQty)"
              :step="1"
              step-strictly
              size="small"
              controls-position="right"
            />
          </div>
          <div class="text-xs text-slate-500 dark:text-slate-400">
            合计拨出 {{ totalQty }} 件，来源库位现有 {{ sourceQty }} 件
          </div>
        </div>
        <el-checkbox v-if="canSetAsMain" v-model="setAsMain" class="!mt-2">
          同时设为主库位（原主库位剩余件数仍留在原库位）
        </el-checkbox>
      </el-form>
    </div>
    <template #footer>
      <div class="flex flex-wrap items-center justify-end gap-2">
        <span v-if="distribution && submitError && targetIds.length" class="mr-auto text-xs text-amber-600 dark:text-amber-400">{{ submitError }}</span>
        <el-button @click="emit('update:modelValue', false)">取消</el-button>
        <el-button type="primary" :loading="submitting" :disabled="Boolean(submitError) || loading" @click="submit">确认拨转</el-button>
      </div>
    </template>
  </el-dialog>
</template>
