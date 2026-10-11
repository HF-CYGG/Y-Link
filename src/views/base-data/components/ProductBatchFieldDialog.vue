<script setup lang="ts">
/**
 * 模块说明：src/views/base-data/components/ProductBatchFieldDialog.vue
 * 文件职责：为产品中心“批量操作”提供批量修改商品分类、批量修改规格默认库位的确认弹窗。
 * 实现逻辑：
 * - 同一弹窗按 field 切换“分类 / 库位”两种模式，选择目标值或“清空”后调用 /products/batch 一次性提交；
 * - 分类写在商品主记录上；库位写在规格上，会覆盖所选商品全部当前 SKU（含停用、不含退役）的默认库位；
 * - 下拉只列出启用中的分类与库位，停用项由服务端拒绝新挂入，前端不做本地兜底放行。
 * 维护说明：
 * - 本弹窗只改分类与默认库位，不触碰库存、价格与条码；若要逐个 SKU 精细调整库位，请走商品编辑或库位“管理规格”；
 * - 由 ProductManager 以异步组件按需加载，避免增加产品中心首屏体积。
 */
import { computed, ref, watch } from 'vue'
import type { CategoryRecord, LocationRecord } from '@/api/modules/inventory'
import { batchUpdateProducts } from '@/api/modules/product'
import { showAppError, showAppSuccess, showAppWarning } from '@/utils/app-alert'

/** 选择器里代表“清空”的哨兵值，提交时转换为 null。 */
const CLEAR_VALUE = '__clear__'

const props = defineProps<{
  modelValue: boolean
  field: 'category' | 'location'
  productIds: string[]
  categories: CategoryRecord[]
  locations: LocationRecord[]
}>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  updated: []
}>()

const targetValue = ref('')
const submitting = ref(false)
const isCategory = computed(() => props.field === 'category')
const fieldLabel = computed(() => (isCategory.value ? '分类' : '默认库位'))
const dialogTitle = computed(() => `批量修改${isCategory.value ? '分类' : '库位'}`)
const options = computed(() => (isCategory.value
  ? props.categories.filter((item) => item.isActive).map((item) => ({ value: item.id, label: `${item.categoryCode} ${item.categoryName}` }))
  : props.locations.filter((item) => item.isActive).map((item) => ({
    value: item.id,
    label: item.locationName ? `${item.locationCode}（${item.locationName}）` : item.locationCode,
  }))))

watch(() => props.modelValue, (visible) => {
  if (visible) targetValue.value = ''
}, { immediate: true })

const close = () => {
  if (submitting.value) return
  emit('update:modelValue', false)
}

const submit = async () => {
  if (!targetValue.value) {
    showAppWarning(`请选择要设置的${fieldLabel.value}`)
    return
  }
  if (!props.productIds.length) {
    showAppWarning('请先选择要批量处理的产品')
    return
  }
  const nextValue = targetValue.value === CLEAR_VALUE ? null : targetValue.value
  submitting.value = true
  try {
    await batchUpdateProducts(isCategory.value
      ? { ids: props.productIds, categoryId: nextValue }
      : { ids: props.productIds, locationId: nextValue })
    showAppSuccess(`已为 ${props.productIds.length} 个产品${nextValue ? '修改' : '清空'}${fieldLabel.value}`)
    emit('updated')
    emit('update:modelValue', false)
  } catch (error) {
    showAppError(error, `批量修改${fieldLabel.value}失败`)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="dialogTitle"
    width="min(460px, 94vw)"
    append-to-body
    :close-on-click-modal="!submitting"
    @update:model-value="!$event && close()"
  >
    <div class="space-y-4">
      <p class="text-sm leading-6 text-slate-600 dark:text-slate-300">
        已选 {{ productIds.length }} 个产品。
        <template v-if="isCategory">提交后这些产品的分类将统一改为所选分类，不会改变已有 SKU 编码与条码。</template>
        <template v-else>提交后这些产品下全部当前规格（含已停用规格）的默认库位将统一改为所选库位；不会增减库存，但会改变找货与按库位盘点范围。</template>
      </p>
      <el-select
        v-model="targetValue"
        filterable
        class="w-full"
        :placeholder="`选择${fieldLabel}`"
        :disabled="submitting"
      >
        <el-option :label="`清空${fieldLabel}`" :value="CLEAR_VALUE" />
        <el-option v-for="option in options" :key="option.value" :label="option.label" :value="option.value" />
      </el-select>
    </div>
    <template #footer>
      <el-button :disabled="submitting" @click="close">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="submit">确认修改</el-button>
    </template>
  </el-dialog>
</template>
