<script setup lang="ts">
/**
 * 模块说明：src/views/base-data/components/ProductYzBatchUpgradeDialog.vue
 * 文件职责：产品中心“批量升级到 YZ 编码”的确认弹窗，承载统一文创系列选择、逐商品预检展示与整批提交。
 * 实现逻辑：
 * - 使用方按列表顺序传入所选商品 ID；选定系列后调用批量预检，服务端按同一顺序预测连续的系列内序号；
 * - 预检把商品分为“可升级 / 不可升级”两组：已是 YZ、规格容量超限、编码冲突、序号耗尽的商品只展示原因，不参与提交；
 * - 提交前必须勾选“已知晓不可逆”，只提交可升级商品；服务端整批同事务执行，任一失败整批回滚，前端提示后重新预检；
 * - 成功后通过 upgraded 事件回传升级结果，由使用方清空选择并刷新列表。
 * 维护说明：
 * - 升级涉及编码重算且不可逆，禁止新增“忽略 blockingReason 强提交”“失败自动重试”等绕过后端拦截的逻辑；
 * - 单品升级仍走 ProductYzUpgradeDialog.vue，两处共用后端 upgradeLegacyProductWithManager，不要在前端各自拼编码。
 */

import { computed, ref, watch } from 'vue'
import {
  batchUpgradeProductsToYzCode,
  previewBatchProductYzUpgrade,
  type ProductYzBatchUpgradePreview,
  type ProductYzBatchUpgradeResult,
} from '@/api/modules/product'
import type { Tag } from '@/api/modules/tag'
import { BizCrudDialogShell } from '@/components/common'
import { useStableRequest } from '@/composables/useStableRequest'
import { showAppError, showAppSuccess } from '@/utils/app-alert'
import { extractErrorMessage } from '@/utils/error'
import { formatSeriesTagOptionLabel } from '@/views/base-data/components/product-manager.helpers'

interface Props {
  modelValue: boolean
  productIds: string[]
  seriesTagOptions: Tag[]
}

const props = defineProps<Props>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  upgraded: [result: ProductYzBatchUpgradeResult]
}>()

const selectedSeriesTagId = ref('')
const previewLoading = ref(false)
const preview = ref<ProductYzBatchUpgradePreview | null>(null)
const acknowledged = ref(false)
const submitting = ref(false)
const previewRequest = useStableRequest()

const eligibleItems = computed(() => preview.value?.items.filter((item) => item.eligible) ?? [])
const blockedItems = computed(() => preview.value?.items.filter((item) => !item.eligible) ?? [])
const eligibleSkuCount = computed(() => eligibleItems.value.reduce((sum, item) => sum + item.currentSkuCount, 0))
const canSubmit = computed(() => eligibleItems.value.length > 0 && acknowledged.value && !submitting.value && !previewLoading.value)

watch(
  () => props.modelValue,
  (visible) => {
    if (!visible) {
      previewRequest.cancel()
      return
    }
    selectedSeriesTagId.value = ''
    preview.value = null
    previewLoading.value = false
    acknowledged.value = false
    submitting.value = false
  },
  { immediate: true },
)

const loadPreview = async () => {
  preview.value = null
  acknowledged.value = false
  const seriesTagId = selectedSeriesTagId.value
  if (!seriesTagId) {
    previewRequest.cancel()
    previewLoading.value = false
    return
  }
  previewLoading.value = true
  await previewRequest.runLatest({
    executor: () => previewBatchProductYzUpgrade(props.productIds, seriesTagId),
    onSuccess: (result) => {
      if (selectedSeriesTagId.value === seriesTagId) preview.value = result
    },
    onError: (error) => { showAppError(extractErrorMessage(error, '批量升级预检失败')) },
    onFinally: () => { previewLoading.value = false },
  })
}

const handleClose = () => {
  if (submitting.value) return
  emit('update:modelValue', false)
}

const handleSubmit = async () => {
  if (!canSubmit.value || !selectedSeriesTagId.value) return
  submitting.value = true
  try {
    const result = await batchUpgradeProductsToYzCode(eligibleItems.value.map((item) => item.productId), selectedSeriesTagId.value)
    showAppSuccess(`已将 ${result.items.length} 个商品升级为 YZ 编码`)
    emit('upgraded', result)
  } catch (error) {
    // 整批已回滚：提示具体失败商品，并重新预检让管理员看到最新状态。
    showAppError(extractErrorMessage(error, '批量升级失败，所有商品均未升级'))
    submitting.value = false
    await loadPreview()
    return
  }
  submitting.value = false
}
</script>

<template>
  <BizCrudDialogShell
    :model-value="modelValue"
    title="批量升级到 YZ 编码"
    height-mode="scroll"
    phone-width="94%"
    tablet-width="90%"
    desktop-width="760px"
    dialog-class="product-yz-batch-upgrade-dialog"
    @update:model-value="!$event && handleClose()"
  >
    <template #default>
      <div class="flex flex-col gap-4">
        <p class="text-sm text-slate-600 dark:text-slate-300">
          已选 {{ productIds.length }} 个商品，将统一升级到同一文创系列，按列表顺序依次分配系列内序号；产品编码与全部在用 SKU 编码都会重新生成。
        </p>

        <el-alert type="warning" :closable="false" show-icon title="升级不可撤销。旧编码会保留在历史编码字段中参与扫码匹配，已打印的旧标签仍可识别；已退役的历史 SKU 保持原编码不变。" />

        <div>
          <label class="mb-1 block text-xs text-slate-500 dark:text-slate-400">选择要升级到的文创系列</label>
          <el-select
            v-model="selectedSeriesTagId"
            filterable
            placeholder="请选择文创系列"
            class="w-full"
            :disabled="submitting"
            @change="loadPreview"
          >
            <el-option
              v-for="tag in seriesTagOptions"
              :key="tag.id"
              :label="formatSeriesTagOptionLabel(tag)"
              :value="tag.id"
            />
          </el-select>
          <p v-if="!seriesTagOptions.length" class="mt-1 text-xs text-amber-600">暂无配置了系列编码的标签，请先在标签管理页设置。</p>
        </div>

        <div v-if="previewLoading" class="text-sm text-slate-400">预检计算中，请稍候…</div>

        <template v-else-if="preview">
          <div class="flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-600 dark:text-slate-300">
            <span>可升级 <b class="text-teal-600">{{ eligibleItems.length }}</b> 个商品（共 {{ eligibleSkuCount }} 个在用 SKU）</span>
            <span v-if="blockedItems.length">不可升级 <b class="text-rose-600">{{ blockedItems.length }}</b> 个，将自动跳过</span>
          </div>

          <div v-if="eligibleItems.length" class="rounded-lg border border-slate-200 dark:border-white/10" style="overflow-x: auto">
            <el-table native-scrollbar :data="eligibleItems" row-key="productId" size="small" max-height="320">
              <el-table-column type="expand" width="36">
                <template #default="{ row }">
                  <div class="px-3 py-2">
                    <div v-for="change in row.skuChanges" :key="change.skuId" class="flex flex-wrap gap-x-3 py-0.5 text-xs">
                      <span class="min-w-24 text-slate-500 dark:text-slate-400">{{ change.specText || '默认规格' }}</span>
                      <span class="font-mono">{{ change.oldSkuCode }}</span>
                      <span>→</span>
                      <span class="font-mono font-semibold text-teal-600">{{ change.newSkuCode }}</span>
                    </div>
                    <div v-if="row.retiredSkuCount" class="mt-1 text-xs text-slate-400">已退役历史 SKU {{ row.retiredSkuCount }} 个（编码保持不变）</div>
                  </div>
                </template>
              </el-table-column>
              <el-table-column prop="productName" label="商品" min-width="160" show-overflow-tooltip />
              <el-table-column label="产品编码变化" min-width="220">
                <template #default="{ row }">
                  <span class="font-mono text-xs">{{ row.oldProductCode }}</span>
                  →
                  <span class="font-mono text-xs font-semibold text-teal-600">{{ row.newProductCode }}</span>
                </template>
              </el-table-column>
              <el-table-column prop="currentSkuCount" label="在用 SKU" width="84" align="center" />
            </el-table>
          </div>

          <div v-if="blockedItems.length" class="rounded-lg border border-rose-200 bg-rose-50/60 p-3 dark:border-rose-500/30 dark:bg-rose-500/10">
            <div class="mb-1 text-xs font-medium text-rose-600 dark:text-rose-300">以下商品不会升级</div>
            <div v-for="item in blockedItems" :key="item.productId" class="py-0.5 text-xs leading-5 text-slate-600 dark:text-slate-300">
              <span class="font-medium">{{ item.productName || item.productId }}</span>
              <span v-if="item.oldProductCode" class="ml-1 font-mono text-slate-400">{{ item.oldProductCode }}</span>
              ：{{ item.blockingReason }}
            </div>
          </div>

          <el-checkbox v-if="eligibleItems.length" v-model="acknowledged" :disabled="submitting">
            我已核对上述编码变化，知晓升级不可撤销
          </el-checkbox>
        </template>
      </div>
    </template>

    <template #footer>
      <span class="flex flex-wrap justify-end gap-2">
        <el-button :disabled="submitting" @click="handleClose">取消</el-button>
        <el-button type="primary" :loading="submitting" :disabled="!canSubmit" @click="handleSubmit">
          确认升级{{ eligibleItems.length ? ` ${eligibleItems.length} 个商品` : '' }}
        </el-button>
      </span>
    </template>
  </BizCrudDialogShell>
</template>
