<script setup lang="ts">
/**
 * 模块说明：src/views/inventory/components/ProductYzImportDialog.vue
 * 文件职责：YZ 通用 SKU 编码体系专用的 Excel 建库导入弹窗，按“下载模板 → 选择文件预览 → 确认导入”三步完成。
 * 实现逻辑：
 * - 选择文件后调用 YZ 专用预览接口，按“系列+序号”分组展示商品汇总表与逐行明细表；
 * - 预览中的待确认项（同序号多商品名 / 疑似轴错位）渲染成单选组，由用户逐项显式选择，绝不自动采信任何建议；
 * - 待确认项未全部选完或存在校验错误行时禁用“确认导入”按钮；
 * - 确认导入时重新上传同一文件并附带用户选择的 resolutions，由服务端在事务内重新解析校验后批量建档；
 * - 导入进行中禁止关闭弹窗（按钮、遮罩、ESC、右上角关闭），保证完成通知不丢失。
 * 维护说明：
 * - 本弹窗只新建商品，不支持覆盖已有商品；与现有窄表 Excel 导入（ProductImportDialog.vue）完全独立，互不影响；
 * - 待确认项的 groupKey/kind/value 结构需要与后端 product-import-yz.service.ts 的 YzImportResolution 保持一致。
 */

import { computed, ref } from 'vue'
import type { UploadRequestOptions } from 'element-plus'
import { BizCrudDialogShell } from '@/components/common'
import {
  downloadProductYzImportTemplate,
  importProductsYz,
  previewProductYzImport,
  type YzImportPreview,
  type YzImportResolution,
} from '@/api/modules/inventory'
import { showAppError, showAppSuccess, showAppWarning } from '@/utils/app-alert'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  imported: []
}>()

const MAX_FILE_SIZE = 5 * 1024 * 1024

const selectedFile = ref<File | null>(null)
const preview = ref<YzImportPreview | null>(null)
const previewing = ref(false)
const importing = ref(false)
const templateLoading = ref(false)
/** key: `${groupKey}:${kind}` → 用户选中的 value。 */
const resolutionChoices = ref<Record<string, string>>({})

const handleVisibleChange = (visible: boolean) => {
  if (!visible && importing.value) {
    showAppWarning('正在导入，请等待完成后再关闭')
    return
  }
  emit('update:modelValue', visible)
}

/** 汇总全部分组的待确认项，附带唯一 key，供页面统一渲染单选组。 */
const pendingConfirms = computed(() => {
  if (!preview.value) return []
  return preview.value.groups.flatMap((group) => group.pendingConfirms.map((item) => ({
    ...item,
    uniqueKey: `${item.groupKey}:${item.kind}`,
    groupLabel: `系列 ${group.seriesCode} · 序号 ${group.seriesSeq}`,
  })))
})

const unresolvedCount = computed(() => pendingConfirms.value.filter((item) => !resolutionChoices.value[item.uniqueKey]).length)

const canImport = computed(() => Boolean(
  selectedFile.value
  && preview.value
  && preview.value.errorCount === 0
  && unresolvedCount.value === 0,
))

const handleTemplate = async () => {
  templateLoading.value = true
  try {
    await downloadProductYzImportTemplate()
  } catch (error) {
    showAppError(error, '模板下载失败')
  } finally {
    templateLoading.value = false
  }
}

const handleSelect = async (options: UploadRequestOptions) => {
  const file = options.file
  if (!file.name.toLowerCase().endsWith('.xlsx')) {
    showAppWarning('请选择 .xlsx 格式的 Excel 文件')
    return
  }
  if (file.size > MAX_FILE_SIZE) {
    showAppWarning('文件不能超过 5 MB')
    return
  }
  selectedFile.value = file
  preview.value = null
  resolutionChoices.value = {}
  previewing.value = true
  try {
    preview.value = await previewProductYzImport(file)
  } catch (error) {
    selectedFile.value = null
    showAppError(error, '文件解析失败')
  } finally {
    previewing.value = false
  }
}

const buildResolutions = (): YzImportResolution[] => pendingConfirms.value
  .filter((item) => resolutionChoices.value[item.uniqueKey])
  .map((item) => ({ groupKey: item.groupKey, kind: item.kind, value: resolutionChoices.value[item.uniqueKey] }))

const handleImport = async () => {
  if (!selectedFile.value || !canImport.value) {
    showAppWarning('请先选择文件、修正所有错误行并处理完全部待确认项')
    return
  }
  importing.value = true
  try {
    const result = await importProductsYz(selectedFile.value, buildResolutions())
    showAppSuccess(`已导入 ${result.productCount} 个商品、${result.skuCount} 个规格`)
    emit('imported')
    emit('update:modelValue', false)
  } catch (error) {
    showAppError(error, '导入失败，未写入任何数据')
  } finally {
    importing.value = false
  }
}

const reset = () => {
  selectedFile.value = null
  preview.value = null
  resolutionChoices.value = {}
}
</script>

<template>
  <BizCrudDialogShell
    :model-value="props.modelValue"
    title="YZ 建库导入"
    desktop-width="960px"
    tablet-width="94%"
    height-mode="scroll"
    confirm-text="确认导入"
    :confirm-loading="importing"
    :close-on-click-modal="!importing"
    :close-on-press-escape="!importing"
    :show-close="!importing"
    @update:model-value="handleVisibleChange"
    @confirm="handleImport"
    @closed="reset"
  >
    <div class="space-y-3">
      <el-alert type="info" :closable="false" show-icon>
        <template #title>
          六列宽表：品类 / 序号 / 商品 / 款式颜色 / 尺码 / 价格，按“系列+序号”把多行合并为一个商品的多条 SKU。
          品类需先在标签管理页设置两位系列编码；序号会原样保留。本导入只新建商品，不支持覆盖已有商品。
        </template>
      </el-alert>
      <div class="flex flex-wrap items-center gap-3">
        <el-button :loading="templateLoading" @click="handleTemplate">下载导入模板</el-button>
        <el-upload :show-file-list="false" accept=".xlsx" :http-request="handleSelect">
          <el-button type="primary" :loading="previewing">选择 Excel 文件</el-button>
        </el-upload>
        <span v-if="selectedFile" class="text-sm text-slate-500">{{ selectedFile.name }}</span>
      </div>

      <template v-if="preview">
        <el-alert
          :type="preview.errorCount ? 'error' : 'success'"
          :closable="false"
          show-icon
          :title="preview.errorCount
            ? `共 ${preview.skuCount} 行，其中 ${preview.errorCount} 行有错误，请修正后重新选择文件`
            : `校验通过：将新建 ${preview.productCount} 个商品、${preview.skuCount} 个规格`"
        />

        <div v-if="pendingConfirms.length" class="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-500/40 dark:bg-amber-500/10">
          <div class="mb-2 text-sm font-medium text-amber-700 dark:text-amber-300">
            待确认项（还剩 {{ unresolvedCount }} 项未选择）
          </div>
          <div class="flex flex-col gap-3">
            <div v-for="item in pendingConfirms" :key="item.uniqueKey" class="rounded border border-amber-200 bg-white p-2 dark:border-amber-500/30 dark:bg-transparent">
              <div class="mb-1 text-xs text-slate-500">{{ item.groupLabel }}</div>
              <div class="mb-2 text-sm">{{ item.description }}</div>
              <el-radio-group v-model="resolutionChoices[item.uniqueKey]">
                <el-radio v-for="option in item.options" :key="option.value" :value="option.value">
                  {{ option.label }}
                </el-radio>
              </el-radio-group>
            </div>
          </div>
        </div>

        <div>
          <div class="mb-1 text-sm font-medium">按商品分组的汇总</div>
          <el-table :data="preview.groups" size="small" max-height="240" row-key="groupKey">
            <el-table-column label="系列" width="70">
              <template #default="{ row }">{{ row.seriesCode }}</template>
            </el-table-column>
            <el-table-column prop="seriesSeq" label="序号" width="60" />
            <el-table-column label="商品名" min-width="160" show-overflow-tooltip>
              <template #default="{ row }">
                <span v-if="row.chosenProductName">{{ row.chosenProductName }}</span>
                <span v-else class="text-amber-600">待选择（{{ row.productNames.join(' / ') }}）</span>
              </template>
            </el-table-column>
            <el-table-column label="变体数" width="70" align="right">
              <template #default="{ row }">{{ row.variantValues.length }}</template>
            </el-table-column>
            <el-table-column label="尺码数" width="70" align="right">
              <template #default="{ row }">{{ row.sizeValues.length }}</template>
            </el-table-column>
            <el-table-column prop="skuCount" label="SKU 数" width="70" align="right" />
          </el-table>
        </div>

        <div>
          <div class="mb-1 text-sm font-medium">逐行明细</div>
          <el-table :data="preview.rows" size="small" max-height="320" row-key="rowNumber">
            <el-table-column prop="rowNumber" label="行" width="56" />
            <el-table-column prop="category" label="品类" width="80" show-overflow-tooltip />
            <el-table-column prop="seriesSeq" label="序号" width="56" />
            <el-table-column prop="productName" label="商品名" min-width="120" show-overflow-tooltip />
            <el-table-column label="款式/颜色" width="100" show-overflow-tooltip>
              <template #default="{ row }">{{ row.variantAxisValue || '—' }}</template>
            </el-table-column>
            <el-table-column label="尺码" width="80" show-overflow-tooltip>
              <template #default="{ row }">{{ row.sizeAxisValue || '—' }}</template>
            </el-table-column>
            <el-table-column prop="price" label="价格" width="70" align="right" />
            <el-table-column label="预测 SKU 编码" min-width="120">
              <template #default="{ row }">
                <span v-if="row.predictedSkuCode" class="font-mono text-xs">{{ row.predictedSkuCode }}</span>
                <span v-else class="text-slate-400">待确认</span>
              </template>
            </el-table-column>
            <el-table-column label="校验结果" min-width="180">
              <template #default="{ row }">
                <span v-if="!row.errors.length" class="text-emerald-600">通过</span>
                <span v-else class="text-red-600">{{ row.errors.join('；') }}</span>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </template>
    </div>

    <template #footer>
      <span class="flex flex-wrap items-center justify-end gap-2">
        <span v-if="preview && (unresolvedCount > 0 || preview.errorCount > 0)" class="text-xs text-slate-400">
          <template v-if="unresolvedCount > 0">还有 {{ unresolvedCount }} 项待确认</template>
          <template v-else>请先修正校验错误</template>
        </span>
        <el-button :disabled="importing" @click="handleVisibleChange(false)">取消</el-button>
        <el-button type="primary" :loading="importing" :disabled="!canImport" @click="handleImport">确认导入</el-button>
      </span>
    </template>
  </BizCrudDialogShell>
</template>
