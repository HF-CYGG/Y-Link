<script setup lang="ts">
/**
 * 模块说明：src/views/base-data/components/ProductZeroSpecEvolveDialog.vue
 * 文件职责：YZ 编码商品「0 号规格演进」弹窗——把商品原本"无该轴规格"的 SKU 继承为具体取值，或退役保留。
 * 实现逻辑：
 * - 弹窗打开时重置内部状态，由使用方（ProductManager.vue）传入商品 id/名称，以及一级变体轴/尺码轴
 *   当前是否存在待演进的 0 号 SKU（variantEvolvable/sizeEvolvable），据此过滤可选的规格轴；
 * - 继承（inherit）：需要填写要继承的规格取值，提交后原 SKU 的 skuCode 与库存保持不变，只是补上了该轴的取值；
 * - 保留（retain）：原 SKU 直接退役（不删除），后续该轴新增取值从候选池正常分配（0 号永久不再使用）；
 * - 提交调用 evolveProductZeroSpec，成功后把最新商品数据通过 evolved 事件回传，由使用方回填编辑态并刷新列表。
 * 维护说明：
 * - 观感从简：能选轴、能选继承/保留、继承时能填取值、能提交即可，不追加额外交互；
 * - 演进属于不可逆操作（保留会让原 SKU 退役），不要在本组件叠加"静默重试"之类绕过后端拦截的逻辑。
 */

import { computed, ref, watch } from 'vue'
import { evolveProductZeroSpec, type ProductRecord, type ProductSpecAxis } from '@/api/modules/product'
import { BizCrudDialogShell } from '@/components/common'
import { showAppError, showAppSuccess } from '@/utils/app-alert'
import { extractErrorMessage } from '@/utils/error'

interface Props {
  modelValue: boolean
  productId: string
  productName: string
  /** 该商品当前是否存在待演进的"无一级变体"SKU（variantCode='0' 且尚未被继承）。 */
  variantEvolvable: boolean
  /** 该商品当前是否存在待演进的"无尺码位"SKU（sizeCode=null 且尚未被继承）。 */
  sizeEvolvable: boolean
}

const props = defineProps<Props>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  evolved: [product: ProductRecord]
}>()

type EvolveMode = 'inherit' | 'retain'

const axis = ref<ProductSpecAxis>('variant')
const mode = ref<EvolveMode>('inherit')
const inheritValue = ref('')
const submitting = ref(false)

const axisOptions = computed(() => {
  const options: Array<{ label: string; value: ProductSpecAxis }> = []
  if (props.variantEvolvable) {
    options.push({ label: '颜色/款式（一级变体轴）', value: 'variant' })
  }
  if (props.sizeEvolvable) {
    options.push({ label: '尺码', value: 'size' })
  }
  return options
})

const resetState = () => {
  axis.value = axisOptions.value[0]?.value ?? 'variant'
  mode.value = 'inherit'
  inheritValue.value = ''
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

const modeOptions: Array<{ label: string; value: EvolveMode; description: string }> = [
  { label: '继承', value: 'inherit', description: '原 SKU 编码与库存保持不变，只是补上这个取值。' },
  { label: '保留', value: 'retain', description: '原 SKU 停用并保留以便历史核对，新取值从 1 开始编号。' },
]

const canSubmit = computed(() => {
  if (submitting.value) return false
  if (!axisOptions.value.length) return false
  if (mode.value === 'inherit') {
    return !!inheritValue.value.trim()
  }
  return true
})

const handleClose = () => {
  emit('update:modelValue', false)
}

const handleSubmit = async () => {
  if (!canSubmit.value) {
    return
  }
  submitting.value = true
  try {
    const updated = await evolveProductZeroSpec(props.productId, {
      axis: axis.value,
      mode: mode.value,
      ...(mode.value === 'inherit' ? { inheritValue: inheritValue.value.trim() } : {}),
    })
    showAppSuccess(mode.value === 'inherit' ? '已继承为具体规格取值，SKU 编码保持不变' : '原规格已停用保留，新取值将从头编号')
    emit('evolved', updated)
  } catch (error) {
    showAppError(extractErrorMessage(error, '规格演进失败'))
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <BizCrudDialogShell
    :model-value="modelValue"
    title="0 号规格演进"
    height-mode="scroll"
    phone-width="94%"
    tablet-width="88%"
    desktop-width="480px"
    dialog-class="product-zero-spec-evolve-dialog"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <template #default>
      <div class="flex flex-col gap-4">
        <p class="text-sm text-slate-600 dark:text-slate-300">
          商品「{{ productName }}」当前存在尚未使用该轴规格的 SKU（编码位固定为 0），可以把它继承为具体取值，或直接停用保留。
        </p>

        <el-alert
          v-if="!axisOptions.length"
          type="info"
          :closable="false"
          show-icon
          title="该商品当前没有待演进的 0 号规格，无需操作"
        />

        <template v-else>
          <div>
            <label class="mb-1 block text-xs text-slate-500">规格轴</label>
            <el-radio-group v-model="axis">
              <el-radio v-for="option in axisOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </el-radio>
            </el-radio-group>
          </div>

          <div>
            <label class="mb-1 block text-xs text-slate-500">演进方式</label>
            <el-radio-group v-model="mode" class="flex flex-col gap-1">
              <el-radio v-for="option in modeOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </el-radio>
            </el-radio-group>
            <p class="mt-1 text-xs leading-5 text-slate-400">
              {{ modeOptions.find((option) => option.value === mode)?.description }}
            </p>
          </div>

          <div v-if="mode === 'inherit'">
            <label class="mb-1 block text-xs text-slate-500">要继承的规格取值</label>
            <el-input v-model="inheritValue" maxlength="64" placeholder="请输入具体取值，如：红色" />
          </div>
        </template>
      </div>
    </template>

    <template #footer>
      <span class="flex flex-wrap justify-end gap-2">
        <el-button @click="handleClose">取消</el-button>
        <el-button type="primary" :loading="submitting" :disabled="!canSubmit" @click="handleSubmit">
          确认提交
        </el-button>
      </span>
    </template>
  </BizCrudDialogShell>
</template>
