<!--
  模块说明：src/views/order-list/components/OrderMergeDialog.vue
  文件职责：承载管理端出库单合并工作台，按“目标选择 -> 服务端预检 -> 确认提交”组织不可逆业务操作。
  实现逻辑：
  - 只使用列表已选择的正常主单；已有父单只能作为目标，来源单始终由服务端预检裁决；
  - 每次参与单或原因变化都废弃旧预检结果，同一预检/提交重试复用一个幂等键；新一次打开会话才清空原因；
  - 预检结果完整展示汇总、明细、零库存影响与逐单阻塞原因，未 ready 时不允许提交。
  维护说明：
  - 禁止在这里推断库存或合并资格，新增约束必须由 /orders/merges/preview 返回；
  - 409 冲突后必须重新预检，不能沿用旧版本或旧 idempotencyKey 重提。
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { OrderMergePreviewResult } from '../../../../packages/shared-types/src/orders'
import { commitOrderMerge, previewOrderMerge, type OrderRecord } from '@/api/modules/order'
import { showAppError, showAppSuccess, showAppWarning } from '@/utils/app-alert'
import {
  canCommitOrderMerge,
  invalidateOrderMergePreviewRequestState,
  invalidateOrderMergePreviewState,
  isOrderMergePreviewRequestPending,
  resolveOrderMergeConflictState,
  settleOrderMergePreviewRequest,
  startOrderMergePreviewRequest,
} from '../order-merge-state'

const props = defineProps<{
  modelValue: boolean
  orders: OrderRecord[]
}>()

const emit = defineEmits<{
  'update:modelValue': [visible: boolean]
  committed: [targetOrderId: string]
}>()

const targetOrderId = ref('')
const reason = ref('')
const preview = ref<OrderMergePreviewResult | null>(null)
const previewing = ref(false)
const committing = ref(false)
const idempotencyKey = ref('')
let previewRequestState = {
  latestRequestVersion: 0,
  activeRequestVersion: null as number | null,
}

const selectedParents = computed(() => props.orders.filter((order) => order.merge.role === 'parent'))
const selectedStandaloneOrders = computed(() => props.orders.filter((order) => order.merge.role === 'standalone'))
const hasMultipleParentTargets = computed(() => selectedParents.value.length > 1)
const targetCandidates = computed(() => {
  if (selectedParents.value.length === 1) return selectedParents.value
  return selectedStandaloneOrders.value
})
const isTargetForced = computed(() => selectedParents.value.length === 1)
const sourceOrders = computed(() => {
  if (!targetOrderId.value) return []
  return selectedStandaloneOrders.value.filter((order) => order.id !== targetOrderId.value)
})
const canPreview = computed(() => {
  return !previewing.value
    && !hasMultipleParentTargets.value
    && Boolean(targetOrderId.value)
    && sourceOrders.value.length >= 1
    && reason.value.trim().length > 0
})
const canCommit = computed(() => canCommitOrderMerge({ preview: preview.value, idempotencyKey: idempotencyKey.value }, committing.value))

const createIdempotencyKey = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return `order-merge-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
}

const invalidatePreview = () => {
  previewRequestState = invalidateOrderMergePreviewRequestState(previewRequestState)
  previewing.value = isOrderMergePreviewRequestPending(previewRequestState)
  const nextState = invalidateOrderMergePreviewState({ preview: preview.value, idempotencyKey: idempotencyKey.value })
  preview.value = nextState.preview
  idempotencyKey.value = nextState.idempotencyKey
}

const selectDefaultTarget = () => {
  if (selectedParents.value.length === 1) {
    targetOrderId.value = selectedParents.value[0].id
    return
  }
  if (!targetCandidates.value.some((order) => order.id === targetOrderId.value)) {
    targetOrderId.value = targetCandidates.value[0]?.id ?? ''
  }
}

watch(
  () => [props.modelValue, props.orders.map((order) => `${order.id}:${order.editVersion}:${order.merge.role}`).join('|')] as const,
  ([visible], previousState) => {
    if (!visible) return
    const previousVisible = previousState?.[0]
    if (!previousVisible) reason.value = ''
    selectDefaultTarget()
    invalidatePreview()
  },
  { immediate: true },
)

watch([targetOrderId, reason], invalidatePreview)

const close = () => emit('update:modelValue', false)

const buildRequest = () => ({
  target: {
    orderId: targetOrderId.value,
    editVersion: targetCandidates.value.find((order) => order.id === targetOrderId.value)?.editVersion ?? 0,
  },
  sources: sourceOrders.value.map((order) => ({ orderId: order.id, editVersion: order.editVersion })),
  reason: reason.value.trim(),
})

const formatAmount = (value: string | number) => {
  const amount = Number(value)
  return Number.isFinite(amount) ? amount.toFixed(2) : '0.00'
}

const getOrderLabel = (order: Pick<OrderRecord, 'businessNo'>) => order.businessNo

const handlePreview = async () => {
  if (!canPreview.value) {
    showAppWarning(hasMultipleParentTargets.value ? '一次合并只能选择一个已有父单作为目标' : '请至少选择两张单据，并填写合并原因')
    return
  }
  const nextRequest = startOrderMergePreviewRequest(previewRequestState)
  previewRequestState = nextRequest.state
  previewing.value = isOrderMergePreviewRequestPending(previewRequestState)
  const { requestVersion } = nextRequest
  idempotencyKey.value ||= createIdempotencyKey()
  try {
    const result = await previewOrderMerge(buildRequest())
    if (previewRequestState.activeRequestVersion === requestVersion) preview.value = result
  } catch (error) {
    if (previewRequestState.activeRequestVersion !== requestVersion) return
    preview.value = null
    showAppError(error instanceof Error ? error.message : '订单合并预检失败，请稍后重试')
  } finally {
    previewRequestState = settleOrderMergePreviewRequest(previewRequestState, requestVersion)
    previewing.value = isOrderMergePreviewRequestPending(previewRequestState)
  }
}

const handleCommit = async () => {
  if (!preview.value?.ready || committing.value) return
  committing.value = true
  try {
    const result = await commitOrderMerge({ ...buildRequest(), idempotencyKey: idempotencyKey.value })
    showAppSuccess(result.idempotentReplay ? '已返回此前成功的订单合并结果' : '订单已合并')
    emit('committed', result.targetOrderId)
    close()
  } catch (error) {
    const currentState = { preview: preview.value, idempotencyKey: idempotencyKey.value }
    const nextState = resolveOrderMergeConflictState(error, currentState)
    if (nextState !== currentState) {
      invalidatePreview()
      showAppWarning('订单版本已变化，请重新预检后再提交')
    } else {
      showAppError(error instanceof Error ? error.message : '订单合并提交失败，请稍后重试')
    }
  } finally {
    committing.value = false
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="合并出库单"
    width="min(920px, calc(100vw - 24px))"
    destroy-on-close
    :close-on-click-modal="false"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="space-y-4">
      <el-alert
        title="合并后来源单将只读并归属到目标父单；库存数量与金额不会重复变动。"
        type="warning"
        :closable="false"
        show-icon
      />
      <el-alert v-if="hasMultipleParentTargets" title="一次操作不能同时选择多个已有父单，请回到列表重新选择。" type="error" :closable="false" show-icon />

      <el-form label-position="top">
        <el-form-item label="目标父单">
          <el-select v-model="targetOrderId" class="w-full" :disabled="isTargetForced || hasMultipleParentTargets">
            <el-option v-for="order in targetCandidates" :key="order.id" :label="getOrderLabel(order)" :value="order.id">
              <span>{{ getOrderLabel(order) }}</span>
              <span class="ml-2 text-xs text-slate-400">数量 {{ order.totalQty }} · ¥{{ formatAmount(order.totalAmount) }}</span>
            </el-option>
          </el-select>
          <p v-if="isTargetForced" class="mt-1 text-xs text-slate-500">已选择的已有父单只能作为本次合并目标。</p>
        </el-form-item>
        <el-form-item label="来源单">
          <div class="grid w-full gap-2 sm:grid-cols-2">
            <div v-for="order in sourceOrders" :key="order.id" class="rounded-xl border border-slate-200 px-3 py-2 text-sm">
              <p class="font-medium text-slate-800">{{ getOrderLabel(order) }}</p>
              <p class="mt-1 text-xs text-slate-500">数量 {{ order.totalQty }} · ¥{{ formatAmount(order.totalAmount) }}</p>
            </div>
          </div>
        </el-form-item>
        <el-form-item label="合并原因" required>
          <el-input v-model.trim="reason" type="textarea" :rows="3" maxlength="200" show-word-limit placeholder="说明本次合并原因，供审计追溯" />
        </el-form-item>
      </el-form>

      <div class="flex flex-wrap justify-end gap-2">
        <el-button :loading="previewing" :disabled="!canPreview" @click="handlePreview">服务端预检</el-button>
        <el-button type="primary" :loading="committing" :disabled="!canCommit" @click="handleCommit">确认合并</el-button>
      </div>

      <template v-if="preview">
        <el-alert
          :title="preview.ready ? '预检通过，可以确认合并。' : '预检未通过，请处理以下阻塞项。'"
          :type="preview.ready ? 'success' : 'error'"
          :closable="false"
          show-icon
        />
        <section class="grid gap-3 sm:grid-cols-2">
          <div class="rounded-xl bg-slate-50 p-3 text-sm"><p class="text-slate-500">合并前</p><p class="mt-1 font-semibold">{{ preview.beforeTotals.itemCount }} 行 · {{ preview.beforeTotals.totalQty }} 件 · ¥{{ formatAmount(preview.beforeTotals.totalAmount) }}</p></div>
          <div class="rounded-xl bg-teal-50 p-3 text-sm"><p class="text-teal-700">合并后</p><p class="mt-1 font-semibold text-teal-900">{{ preview.afterTotals.itemCount }} 行 · {{ preview.afterTotals.totalQty }} 件 · ¥{{ formatAmount(preview.afterTotals.totalAmount) }}</p></div>
        </section>
        <el-alert :title="`库存影响：${preview.inventoryImpact.message}`" type="info" :closable="false" show-icon />
        <el-table native-scrollbar :data="preview.mergedItems" size="small" max-height="220">
          <el-table-column prop="productNameSnapshot" label="产品" min-width="180" show-overflow-tooltip />
          <el-table-column prop="specTextSnapshot" label="规格" min-width="120" show-overflow-tooltip />
          <el-table-column prop="qty" label="数量" width="90" />
          <el-table-column prop="lineAmount" label="金额" width="110"><template #default="{ row }">¥{{ formatAmount(row.lineAmount) }}</template></el-table-column>
        </el-table>
        <el-alert
          v-for="blocker in preview.blockers"
          :key="`${blocker.orderId}:${blocker.code}`"
          :title="`${blocker.orderId}：${blocker.message}`"
          type="error"
          :closable="false"
          show-icon
        />
      </template>
    </div>
    <template #footer><el-button @click="close">取消</el-button></template>
  </el-dialog>
</template>
