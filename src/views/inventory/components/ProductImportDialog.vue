<script setup lang="ts">
/**
 * 模块说明：src/views/inventory/components/ProductImportDialog.vue
 * 文件职责：商品 Excel 批量导入弹窗，按“下载模板 → 选择文件预览校验 → 确认导入”三步完成。
 * 实现逻辑：
 * - 选择文件后先调用预览接口，逐行展示校验结果；存在错误行时拒绝导入并提示先修正；
 * - 确认导入时重新上传同一文件，由服务端再次完整校验并在单个事务内建档；
 * - 导入成功后通知父组件刷新列表；导入进行中禁止关闭弹窗（按钮、遮罩、ESC、右上角关闭），保证完成通知不丢失。
 * 维护说明：
 * - 预览通过不代表一定能导入（期间可能有人占用了同一条码），导入失败时展示服务端原因；
 * - 只支持 .xlsx，文件大小上限与后端保持 5 MB。
 */

import { computed, ref } from 'vue'
import type { UploadRequestOptions } from 'element-plus'
import { BizCrudDialogShell } from '@/components/common'
import { downloadProductImportTemplate, importProducts, previewProductImport, type ProductImportPreview } from '@/api/modules/inventory'
import { showAppError, showAppSuccess, showAppWarning } from '@/utils/app-alert'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  imported: []
}>()

const MAX_FILE_SIZE = 5 * 1024 * 1024

const selectedFile = ref<File | null>(null)
const preview = ref<ProductImportPreview | null>(null)
const previewing = ref(false)
const importing = ref(false)
const templateLoading = ref(false)

/** 统一的关闭入口：导入进行中一律拒绝关闭。 */
const handleVisibleChange = (visible: boolean) => {
  if (!visible && importing.value) {
    showAppWarning('正在导入，请等待完成后再关闭')
    return
  }
  emit('update:modelValue', visible)
}

const canImport = computed(() => Boolean(selectedFile.value && preview.value && preview.value.errorCount === 0))

const handleTemplate = async () => {
  templateLoading.value = true
  try {
    await downloadProductImportTemplate()
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
  previewing.value = true
  try {
    preview.value = await previewProductImport(file)
  } catch (error) {
    selectedFile.value = null
    showAppError(error, '文件解析失败')
  } finally {
    previewing.value = false
  }
}

const handleImport = async () => {
  if (!selectedFile.value || !canImport.value) {
    showAppWarning('请先选择文件并修正所有错误行')
    return
  }
  importing.value = true
  try {
    const result = await importProducts(selectedFile.value)
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
}
</script>

<template>
  <BizCrudDialogShell
    :model-value="props.modelValue"
    title="Excel 批量导入商品"
    desktop-width="880px"
    tablet-width="92%"
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
          一行一个 SKU，商品名称相同的多行合并为同一商品的多个规格；填写分类编码后新 SKU 按 WC 规则自动编码。导入只新建商品，初始库存会记入库存流水。
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
        <el-table :data="preview.rows" size="small" max-height="360" row-key="rowNumber">
          <el-table-column prop="rowNumber" label="行" width="56" />
          <el-table-column prop="productName" label="商品名称" min-width="120" show-overflow-tooltip />
          <el-table-column prop="categoryCode" label="分类" width="60" />
          <el-table-column label="规格" min-width="120" show-overflow-tooltip>
            <template #default="{ row }">{{ row.specText || '默认规格' }}</template>
          </el-table-column>
          <el-table-column label="SKU / 条码" min-width="130" show-overflow-tooltip>
            <template #default="{ row }">{{ row.skuCode || '自动生成' }}{{ row.barcode ? ` / ${row.barcode}` : '' }}</template>
          </el-table-column>
          <el-table-column prop="initialStock" label="库存" width="64" align="right" />
          <el-table-column prop="locationCode" label="库位" width="90" />
          <el-table-column label="校验结果" min-width="200">
            <template #default="{ row }">
              <span v-if="!row.errors.length" class="text-emerald-600">通过</span>
              <span v-else class="text-red-600">{{ row.errors.join('；') }}</span>
            </template>
          </el-table-column>
        </el-table>
      </template>
    </div>

    <template #footer>
      <span class="flex flex-wrap justify-end gap-2">
        <el-button :disabled="importing" @click="handleVisibleChange(false)">取消</el-button>
        <el-button type="primary" :loading="importing" @click="handleImport">确认导入</el-button>
      </span>
    </template>
  </BizCrudDialogShell>
</template>
