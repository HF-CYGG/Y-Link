<script setup lang="ts">
/**
 * 模块说明：src/views/base-data/components/ProductYzUpgradeDialog.vue
 * 文件职责：存量（legacy）商品升级到 YZ 通用 SKU 编码体系的确认弹窗，承载文创系列选择、升级预检展示与最终提交。
 * 实现逻辑：
 * - 弹窗打开时重置内部状态，由使用方（ProductManager.vue）传入商品 id/名称与可选的文创系列标签候选集；
 * - 选定系列后调用 previewProductYzUpgrade 预检，展示旧/新产品编码与 SKU 编码变化列表；
 * - blockingReason 非空时用醒目错误提示替代变更列表并禁用提交；提交前固定展示两条警示：编码会重新生成、
 *   旧编码会保留在历史编码字段中用于扫码兼容（B9 批次不再回填进 barcode，语义与之前不同）；
 * - 提交调用 upgradeProductToYzCode，成功后把最新商品数据通过 upgraded 事件回传，由使用方刷新列表与编辑态。
 * 维护说明：
 * - 升级涉及编码重算且不可逆，禁止在本组件内新增“静默重试”“忽略 blockingReason 强提交”等绕过后端拦截的逻辑；
 * - 若后续要支持批量升级，应新建入口而不是在本组件叠加多商品状态。
 */

import { computed, ref, watch } from 'vue'
import {
  previewProductYzUpgrade,
  upgradeProductToYzCode,
  type ProductRecord,
  type ProductYzUpgradePreview,
} from '@/api/modules/product'
import type { Tag } from '@/api/modules/tag'
import { BizCrudDialogShell } from '@/components/common'
import { showAppError, showAppSuccess } from '@/utils/app-alert'
import { extractErrorMessage } from '@/utils/error'
import { formatSeriesTagOptionLabel } from '@/views/base-data/components/product-manager.helpers'

interface Props {
  modelValue: boolean
  productId: string
  productName: string
  seriesTagOptions: Tag[]
}

const props = defineProps<Props>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  upgraded: [product: ProductRecord]
}>()

const selectedSeriesTagId = ref('')
const previewLoading = ref(false)
const preview = ref<ProductYzUpgradePreview | null>(null)
const submitting = ref(false)

/** 弹窗每次打开都重置内部状态，避免残留上一次选择的系列或预检结果。 */
const resetState = () => {
  selectedSeriesTagId.value = ''
  preview.value = null
  previewLoading.value = false
  submitting.value = false
}

watch(
  () => props.modelValue,
  (visible) => {
    if (visible) {
      resetState()
    }
  },
)

const canSubmit = computed(() => {
  return !!preview.value && !preview.value.blockingReason && !submitting.value
})

const handleClose = () => {
  emit('update:modelValue', false)
}

const handleSeriesTagChange = async () => {
  preview.value = null
  if (!selectedSeriesTagId.value) {
    return
  }
  previewLoading.value = true
  try {
    preview.value = await previewProductYzUpgrade(props.productId, selectedSeriesTagId.value)
  } catch (error) {
    showAppError(extractErrorMessage(error, '升级预检失败'))
  } finally {
    previewLoading.value = false
  }
}

const handleSubmit = async () => {
  if (!canSubmit.value || !selectedSeriesTagId.value) {
    return
  }
  submitting.value = true
  try {
    const updated = await upgradeProductToYzCode(props.productId, selectedSeriesTagId.value)
    showAppSuccess('商品已升级为 YZ 编码')
    emit('upgraded', updated)
  } catch (error) {
    showAppError(extractErrorMessage(error, '升级失败'))
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <BizCrudDialogShell
    :model-value="modelValue"
    title="升级到 YZ 编码"
    height-mode="scroll"
    phone-width="94%"
    tablet-width="88%"
    desktop-width="680px"
    dialog-class="product-yz-upgrade-dialog"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <template #default>
      <div class="flex flex-col gap-4">
        <p class="text-sm text-slate-600 dark:text-slate-300">
          商品「{{ productName }}」当前使用历史编码，升级后将改用 YZ 通用 SKU 编码体系，产品编码与全部在用 SKU 编码都会重新生成。
        </p>

        <el-alert type="warning" :closable="false" show-icon title="升级后产品编码与全部在用 SKU 编码都会重新生成，原编码会写入审计日志，已退役的历史 SKU 保持原编码不变。" />
        <el-alert type="warning" :closable="false" show-icon title="旧编码会保留在历史编码字段中参与扫码匹配，已打印的旧标签仍可正常扫描识别，无需强制重新打印；原厂条码字段不受影响。" />

        <div>
          <label class="mb-1 block text-xs text-slate-500">选择要升级到的文创系列</label>
          <el-select
            v-model="selectedSeriesTagId"
            filterable
            placeholder="请选择文创系列"
            class="w-full"
            @change="handleSeriesTagChange"
          >
            <el-option
              v-for="tag in seriesTagOptions"
              :key="tag.id"
              :label="formatSeriesTagOptionLabel(tag)"
              :value="tag.id"
            />
          </el-select>
        </div>

        <div v-if="previewLoading" class="text-sm text-slate-400">预检计算中，请稍候…</div>

        <template v-else-if="preview">
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
              <div class="mt-1 text-xs text-slate-500">
                系列内序号：{{ preview.seriesCode }}{{ preview.seriesSeq }}；已退役历史 SKU {{ preview.retiredSkuCount }} 个（编码保持不变，不参与本次变更）
              </div>
            </div>
            <div class="rounded-lg border border-slate-200 dark:border-white/10" style="overflow-x: auto">
              <el-table native-scrollbar :data="preview.skuChanges" size="small" max-height="320">
                <el-table-column prop="specText" label="规格" min-width="140" show-overflow-tooltip />
                <el-table-column label="旧 SKU 码" min-width="120">
                  <template #default="{ row }"><span class="font-mono text-xs">{{ row.oldSkuCode }}</span></template>
                </el-table-column>
                <el-table-column label="新 SKU 码" min-width="120">
                  <template #default="{ row }"><span class="font-mono text-xs font-semibold text-teal-600">{{ row.newSkuCode }}</span></template>
                </el-table-column>
              </el-table>
            </div>
          </template>
        </template>
      </div>
    </template>

    <template #footer>
      <span class="flex flex-wrap justify-end gap-2">
        <el-button @click="handleClose">取消</el-button>
        <el-button type="primary" :loading="submitting" :disabled="!canSubmit" @click="handleSubmit">
          确认升级
        </el-button>
      </span>
    </template>
  </BizCrudDialogShell>
</template>
