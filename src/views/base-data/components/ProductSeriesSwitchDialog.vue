<script setup lang="ts">
/**
 * 模块说明：src/views/base-data/components/ProductSeriesSwitchDialog.vue
 * 文件职责：管理员为 YZ 编码商品更换文创系列的二次确认弹窗，承载换系列预检展示、影响说明与最终提交。
 * 实现逻辑：
 * - 使用方（ProductManager.vue）在管理员改选「文创系列」下拉时打开本弹窗，并传入商品与目标系列；
 * - 打开即调用 previewProductSeriesSwitch 只读预检，展示旧/新产品编码、在用与已退役 SKU 的编码变化；
 * - blockingReason 非空时用错误提示替代变更列表并禁用提交；
 * - 提交需两道确认：先勾选“已了解上述影响”，再在 ElMessageBox 中再次确认，最后调用 switchProductSeries，
 *   成功后通过 switched 事件回传最新商品数据，由使用方刷新列表与编辑态。
 * 维护说明：
 * - 更换系列会重算编码、让已打印的 YZ 标签失效且不可撤销，禁止新增跳过预检或跳过二次确认的“快速更换”入口；
 * - 影响说明必须与后端 switchProductSeries 的真实行为保持一致（历史编码不变、旧序号永久作废、标签关联同步）。
 */

import { computed, ref, watch } from 'vue'
import { ElMessageBox } from 'element-plus'
import {
  previewProductSeriesSwitch,
  switchProductSeries,
  type ProductRecord,
  type ProductSeriesSwitchPreview,
} from '@/api/modules/product'
import { BizCrudDialogShell } from '@/components/common'
import { showAppError, showAppSuccess } from '@/utils/app-alert'
import { extractErrorMessage } from '@/utils/error'

interface Props {
  modelValue: boolean
  productId: string
  productName: string
  targetSeriesTagId: string
}

const props = defineProps<Props>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  switched: [product: ProductRecord]
}>()

const previewLoading = ref(false)
const preview = ref<ProductSeriesSwitchPreview | null>(null)
const acknowledged = ref(false)
const submitting = ref(false)

const currentSkuChangeCount = computed(() => preview.value?.skuChanges.filter((change) => change.isCurrent).length ?? 0)
const retiredSkuChangeCount = computed(() => preview.value?.skuChanges.filter((change) => !change.isCurrent).length ?? 0)
const oldSeriesLabel = computed(() => {
  if (!preview.value?.oldSeriesName) return '原系列'
  return preview.value.oldSeriesCode ? `${preview.value.oldSeriesName}（${preview.value.oldSeriesCode}）` : preview.value.oldSeriesName
})
const newSeriesLabel = computed(() => (preview.value ? `${preview.value.newSeriesName}（${preview.value.newSeriesCode}）` : ''))

const canSubmit = computed(() => !!preview.value && !preview.value.blockingReason && acknowledged.value && !submitting.value)

const loadPreview = async () => {
  preview.value = null
  acknowledged.value = false
  if (!props.targetSeriesTagId) return
  previewLoading.value = true
  try {
    preview.value = await previewProductSeriesSwitch(props.productId, props.targetSeriesTagId)
  } catch (error) {
    showAppError(extractErrorMessage(error, '更换系列预检失败'))
  } finally {
    previewLoading.value = false
  }
}

watch(
  () => [props.modelValue, props.targetSeriesTagId] as const,
  ([visible]) => {
    if (visible) {
      submitting.value = false
      void loadPreview()
    }
  },
  { immediate: true },
)

const handleClose = () => {
  emit('update:modelValue', false)
}

const handleSubmit = async () => {
  if (!canSubmit.value || !preview.value) return
  try {
    await ElMessageBox.confirm(
      `确定将「${props.productName}」从「${oldSeriesLabel.value}」更换到「${newSeriesLabel.value}」吗？产品编码将由 ${preview.value.oldProductCode} 变为 ${preview.value.newProductCode}，此操作不可撤销。`,
      '再次确认更换文创系列',
      { type: 'warning', confirmButtonText: '确认更换', cancelButtonText: '再想想' },
    )
  } catch {
    return
  }
  submitting.value = true
  try {
    const updated = await switchProductSeries(props.productId, props.targetSeriesTagId)
    showAppSuccess(`已更换文创系列，新产品编码为 ${updated.productCode}`)
    emit('switched', updated)
  } catch (error) {
    showAppError(extractErrorMessage(error, '更换文创系列失败'))
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <BizCrudDialogShell
    :model-value="modelValue"
    title="更换文创系列"
    height-mode="scroll"
    phone-width="94%"
    tablet-width="88%"
    desktop-width="680px"
    dialog-class="product-series-switch-dialog"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <template #default>
      <div class="flex flex-col gap-4">
        <div v-if="previewLoading" class="text-sm text-slate-400">正在计算更换后的编码，请稍候…</div>

        <template v-else-if="preview">
          <p class="text-sm text-slate-600 dark:text-slate-300">
            将商品「{{ productName }}」从「{{ oldSeriesLabel }}」更换到「{{ newSeriesLabel }}」。
          </p>

          <el-alert
            v-if="preview.blockingReason"
            type="error"
            :closable="false"
            show-icon
            :title="preview.blockingReason"
          />
          <template v-else>
            <div class="rounded-lg border border-slate-200 p-3 text-sm dark:border-white/10">
              <div>
                产品编码：
                <span class="font-mono">{{ preview.oldProductCode }}</span>
                →
                <span class="font-mono font-semibold text-teal-600">{{ preview.newProductCode }}</span>
              </div>
              <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                将改写在用规格 {{ currentSkuChangeCount }} 个、已退役规格 {{ retiredSkuChangeCount }} 个的编码（只替换产品编码部分，颜色/尺码位不变）
              </div>
            </div>

            <div class="rounded-lg border border-slate-200 dark:border-white/10" style="overflow-x: auto">
              <el-table native-scrollbar :data="preview.skuChanges" size="small" max-height="260">
                <el-table-column prop="specText" label="规格" min-width="140" show-overflow-tooltip />
                <el-table-column label="状态" width="72">
                  <template #default="{ row }">
                    <span class="text-xs" :class="row.isCurrent ? 'text-slate-600 dark:text-slate-300' : 'text-slate-400'">
                      {{ row.isCurrent ? '在用' : '已退役' }}
                    </span>
                  </template>
                </el-table-column>
                <el-table-column label="旧 SKU 码" min-width="120">
                  <template #default="{ row }"><span class="font-mono text-xs">{{ row.oldSkuCode }}</span></template>
                </el-table-column>
                <el-table-column label="新 SKU 码" min-width="120">
                  <template #default="{ row }"><span class="font-mono text-xs font-semibold text-teal-600">{{ row.newSkuCode }}</span></template>
                </el-table-column>
              </el-table>
            </div>

            <el-alert type="warning" :closable="false" show-icon title="更换前请确认以下影响：">
              <ul class="series-switch-impact-list">
                <li>已打印的 {{ preview.oldProductCode }} 开头的商品/规格标签更换后将<strong>无法扫码识别</strong>，需要重新打印并贴标。</li>
                <li v-if="preview.legacyProductCode">升级前的历史编码 {{ preview.legacyProductCode }} 不受影响，对应旧标签仍可扫码。</li>
                <li>原编码 {{ preview.oldProductCode }} 将永久作废、不会再分配给其他商品；此操作不可撤销，再次更换会继续占用新序号。</li>
                <li>商品会从「{{ oldSeriesLabel }}」标签下移除并归入「{{ newSeriesLabel }}」，商城按系列展示与筛选随之变化。</li>
                <li>已有出库单、入库单、预订单等历史单据保留当时的编码快照，不会被改写。</li>
                <li>确认后编辑弹窗会以最新数据刷新，尚未保存的其他修改将丢失，请先保存再更换。</li>
              </ul>
            </el-alert>

            <el-checkbox v-model="acknowledged">我已了解上述影响，确认要更换文创系列</el-checkbox>
          </template>
        </template>
      </div>
    </template>

    <template #footer>
      <span class="flex flex-wrap justify-end gap-2">
        <el-button @click="handleClose">取消</el-button>
        <el-button type="danger" :loading="submitting" :disabled="!canSubmit" @click="handleSubmit">
          确认更换
        </el-button>
      </span>
    </template>
  </BizCrudDialogShell>
</template>

<style scoped>
.series-switch-impact-list {
  margin: 4px 0 0;
  padding-left: 18px;
  list-style: disc;
  font-size: 12px;
  line-height: 1.7;
}
</style>
