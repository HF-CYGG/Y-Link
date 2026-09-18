<script setup lang="ts">
/**
 * 模块说明：src/views/base-data/components/ProductSpecValueRenameDialog.vue
 * 文件职责：YZ 编码商品规格取值重命名弹窗，只改显示名称，不改变编码位（skuCode/variantCode/sizeCode）。
 * 实现逻辑：
 * - 弹窗打开时重置内部状态，由使用方（ProductManager.vue）传入商品 id/名称与当前一级变体轴、尺码轴的已录入取值；
 * - 用户选择要重命名的轴与原取值，填写新取值后提交 renameProductSpecValue；
 * - 提交成功后把最新商品数据通过 renamed 事件回传，由使用方回填编辑态并刷新列表。
 * 维护说明：
 * - 本组件不做前置去重/合法性校验（交给后端登记表的唯一约束），只做基本的非空与不能相同校验；
 * - 观感从简：能选轴、能选原值、能填新值、能提交即可，不追加额外交互。
 */

import { computed, ref, watch } from 'vue'
import { renameProductSpecValue, type ProductRecord, type ProductSpecAxis } from '@/api/modules/product'
import { BizCrudDialogShell } from '@/components/common'
import { showAppError, showAppSuccess } from '@/utils/app-alert'
import { extractErrorMessage } from '@/utils/error'

interface Props {
  modelValue: boolean
  productId: string
  productName: string
  variantValues: string[]
  sizeValues: string[]
}

const props = defineProps<Props>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  renamed: [product: ProductRecord]
}>()

const axis = ref<ProductSpecAxis>('variant')
const oldValue = ref('')
const newValue = ref('')
const submitting = ref(false)

const resetState = () => {
  axis.value = 'variant'
  oldValue.value = ''
  newValue.value = ''
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

const axisOptions: Array<{ label: string; value: ProductSpecAxis }> = [
  { label: '颜色/款式（一级变体轴）', value: 'variant' },
  { label: '尺码', value: 'size' },
]

const currentValueOptions = computed(() => (axis.value === 'variant' ? props.variantValues : props.sizeValues))

const canSubmit = computed(() => {
  const trimmedOld = oldValue.value.trim()
  const trimmedNew = newValue.value.trim()
  return !!trimmedOld && !!trimmedNew && trimmedOld !== trimmedNew && !submitting.value
})

const handleClose = () => {
  emit('update:modelValue', false)
}

const handleAxisChange = () => {
  oldValue.value = ''
}

const handleSubmit = async () => {
  if (!canSubmit.value) {
    return
  }
  submitting.value = true
  try {
    const updated = await renameProductSpecValue(props.productId, {
      axis: axis.value,
      oldValue: oldValue.value.trim(),
      newValue: newValue.value.trim(),
    })
    showAppSuccess('规格取值已重命名，编码位保持不变，仅更新显示名称')
    emit('renamed', updated)
  } catch (error) {
    showAppError(extractErrorMessage(error, '重命名失败'))
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <BizCrudDialogShell
    :model-value="modelValue"
    title="重命名规格取值"
    height-mode="scroll"
    phone-width="94%"
    tablet-width="88%"
    desktop-width="480px"
    dialog-class="product-spec-value-rename-dialog"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <template #default>
      <div class="flex flex-col gap-4">
        <p class="text-sm text-slate-600 dark:text-slate-300">
          商品「{{ productName }}」重命名规格取值仅更新显示名称，SKU 编码（skuCode）与编码位（variantCode/sizeCode）保持不变。
        </p>

        <div>
          <label class="mb-1 block text-xs text-slate-500">规格轴</label>
          <el-radio-group v-model="axis" @change="handleAxisChange">
            <el-radio v-for="option in axisOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </el-radio>
          </el-radio-group>
        </div>

        <div>
          <label class="mb-1 block text-xs text-slate-500">原取值</label>
          <el-select v-model="oldValue" filterable placeholder="请选择要重命名的取值" class="w-full">
            <el-option v-for="value in currentValueOptions" :key="value" :label="value" :value="value" />
          </el-select>
          <p v-if="!currentValueOptions.length" class="mt-1 text-xs leading-5 text-amber-500">
            该轴当前没有已录入的规格取值
          </p>
        </div>

        <div>
          <label class="mb-1 block text-xs text-slate-500">新取值</label>
          <el-input v-model="newValue" maxlength="64" placeholder="请输入新的规格取值名称" />
        </div>
      </div>
    </template>

    <template #footer>
      <span class="flex flex-wrap justify-end gap-2">
        <el-button @click="handleClose">取消</el-button>
        <el-button type="primary" :loading="submitting" :disabled="!canSubmit" @click="handleSubmit">
          确认重命名
        </el-button>
      </span>
    </template>
  </BizCrudDialogShell>
</template>
