<script setup lang="ts">
/**
 * 模块说明：src/views/order-list/components/OrderDeleteConfirmDialog.vue
 * 文件职责：出库单软删除确认弹窗，承载业务单号确认、库存回补选择、3 秒等待与二次确认。
 * 实现逻辑：
 * - 打开时重置输入并启动 3 秒倒计时，倒计时结束前“确认删除”不可点击，降低误删；
 * - 手工库存单（manual_applied）必须明确选择“回补库存 / 不回补库存”，不给默认值，并列出将回补的明细；
 * - 点击确认后再弹一次二次确认，总结本次选择；最终由父层调用接口并决定是否关闭弹窗。
 * 维护说明：库存回补以服务端事务为准，本组件只负责收集意图，不在前端推算或修改库存。
 */

import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessageBox } from 'element-plus'
import { getOrderDetailById, type OrderItemRecord, type OrderRecord } from '@/api/modules/order'
import { extractErrorMessage } from '@/utils/error'

const CONFIRM_DELAY_SECONDS = 3

const props = defineProps<{
  modelValue: boolean
  order: OrderRecord | null
  submitting: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  confirm: [payload: { confirmShowNo: string; releaseInventory: boolean }]
}>()

const confirmShowNo = ref('')
const inventoryChoice = ref<'release' | 'keep' | ''>('')
const countdown = ref(CONFIRM_DELAY_SECONDS)
const items = ref<OrderItemRecord[]>([])
const itemsLoading = ref(false)
const itemsLoadError = ref('')
let countdownTimer: ReturnType<typeof setInterval> | null = null
let detailRequestToken = 0

const visibleModel = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
})

const isInventoryOrder = computed(() => props.order?.inventoryMode === 'manual_applied')
const totalReleaseQty = computed(() => items.value.reduce((sum, item) => sum + (Number(item.qty) || 0), 0))

const confirmDisabled = computed(() => {
  if (props.submitting || countdown.value > 0 || !confirmShowNo.value.trim()) return true
  if (isInventoryOrder.value && !inventoryChoice.value) return true
  // 选择回补时必须已加载明细，确保管理员看过将回补的数量。
  return isInventoryOrder.value && inventoryChoice.value === 'release' && (itemsLoading.value || Boolean(itemsLoadError.value))
})

const confirmButtonText = computed(() => (countdown.value > 0 ? `确认删除（${countdown.value}）` : '确认删除'))

const stopCountdown = () => {
  if (countdownTimer) {
    clearInterval(countdownTimer)
    countdownTimer = null
  }
}

const startCountdown = () => {
  stopCountdown()
  countdown.value = CONFIRM_DELAY_SECONDS
  countdownTimer = setInterval(() => {
    countdown.value = Math.max(0, countdown.value - 1)
    if (countdown.value === 0) stopCountdown()
  }, 1000)
}

const loadItems = async (order: OrderRecord) => {
  const token = ++detailRequestToken
  items.value = []
  itemsLoadError.value = ''
  itemsLoading.value = true
  try {
    const detail = await getOrderDetailById(order.id)
    if (token === detailRequestToken) items.value = detail.items
  } catch (error) {
    if (token === detailRequestToken) itemsLoadError.value = extractErrorMessage(error, '明细加载失败，无法确认回补数量')
  } finally {
    if (token === detailRequestToken) itemsLoading.value = false
  }
}

watch(
  () => [props.modelValue, props.order?.id] as const,
  ([visible]) => {
    if (!visible || !props.order) {
      stopCountdown()
      return
    }
    confirmShowNo.value = ''
    inventoryChoice.value = ''
    startCountdown()
    if (props.order.inventoryMode === 'manual_applied') {
      void loadItems(props.order)
    } else {
      items.value = []
      itemsLoadError.value = ''
    }
  },
  { immediate: true },
)

onBeforeUnmount(stopCountdown)

const handleConfirm = async () => {
  const order = props.order
  if (!order || confirmDisabled.value) return
  const releaseInventory = isInventoryOrder.value && inventoryChoice.value === 'release'
  const summary = !isInventoryOrder.value
    ? `将删除出库单 ${order.businessNo}，该单不涉及手工库存扣减。`
    : releaseInventory
      ? `将删除出库单 ${order.businessNo}，并回补库存共 ${totalReleaseQty.value} 件。恢复该单时会重新扣减库存。`
      : `将删除出库单 ${order.businessNo}，不回补库存（该单扣减的库存保持不变）。`
  try {
    await ElMessageBox.confirm(summary, '请再次确认', {
      confirmButtonText: '确定执行',
      cancelButtonText: '返回修改',
      type: 'warning',
    })
  } catch {
    return
  }
  emit('confirm', { confirmShowNo: confirmShowNo.value.trim(), releaseInventory })
}
</script>

<template>
  <el-dialog
    v-model="visibleModel"
    title="删除出库单"
    width="min(520px, 92vw)"
    :close-on-click-modal="false"
    append-to-body
  >
    <div v-if="order" class="space-y-4">
      <el-alert type="warning" :closable="false" show-icon>
        <template #title>
          删除后可在“已删除”筛选中恢复。请输入业务单号 <strong>{{ order.businessNo }}</strong> 确认。
        </template>
      </el-alert>

      <el-input
        v-model="confirmShowNo"
        placeholder="请输入完整业务单号"
        clearable
        :disabled="submitting"
      />

      <div v-if="isInventoryOrder" class="space-y-2">
        <div class="text-sm font-medium text-slate-700 dark:text-slate-200">该单已扣减库存，请选择删除时是否回补库存：</div>
        <el-radio-group v-model="inventoryChoice" :disabled="submitting" class="order-delete-choice">
          <el-radio value="release" border>回补库存</el-radio>
          <el-radio value="keep" border>不回补库存</el-radio>
        </el-radio-group>

        <div class="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600 dark:border-white/10 dark:bg-white/5 dark:text-slate-300">
          <div v-if="itemsLoading">正在加载明细…</div>
          <div v-else-if="itemsLoadError" class="text-red-500">{{ itemsLoadError }}</div>
          <template v-else>
            <div class="mb-1 font-medium">将回补的明细（共 {{ totalReleaseQty }} 件）：</div>
            <ul class="space-y-0.5">
              <li v-for="item in items" :key="item.id" class="flex justify-between gap-3">
                <span class="min-w-0 break-words">{{ item.productName }}{{ item.specText ? ` / ${item.specText}` : '' }}</span>
                <span class="shrink-0">× {{ Number(item.qty) }}</span>
              </li>
            </ul>
          </template>
        </div>
      </div>
      <div v-else class="text-xs text-slate-500 dark:text-slate-400">该单不涉及手工库存扣减，删除不会改动库存。</div>
    </div>

    <template #footer>
      <el-button :disabled="submitting" @click="visibleModel = false">取消</el-button>
      <el-button type="danger" :disabled="confirmDisabled" :loading="submitting" @click="handleConfirm">
        {{ confirmButtonText }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.order-delete-choice {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.order-delete-choice :deep(.el-radio) {
  margin-right: 0;
}
</style>
