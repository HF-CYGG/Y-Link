<script setup lang="ts">
/**
 * 模块说明：src/views/client/components/ClientOrderReturnDialog.vue
 * 文件职责：承载客户端订单详情页中的“申请退货”弹层展示与表单输入交互。
 * 实现逻辑：
 * - 父页面保留退货资格判断、提交确认与接口调用，本组件只负责收集数量和原因；
 * - 通过 emit 把数量变化、原因编辑与提交动作回传给父页面，减少详情页模板噪音。
 * 维护说明：退货弹层若新增校验提示或录入项，优先在这里扩展，避免父页面再次膨胀。
 */

import type { O2oPreorderDetail } from '@/api/modules/o2o'

const props = defineProps<{
  visible: boolean
  detail: O2oPreorderDetail | null
  submitting: boolean
  returnReason: string
  returnQtyMap: Record<string, number>
  reasonMaxLength: number
  selectedReturnItemCount: number
  selectedReturnTotalQty: number
  canSubmitReturnRequest: boolean
}>()

const emit = defineEmits<{
  (event: 'update:visible', value: boolean): void
  (event: 'update:returnReason', value: string): void
  (event: 'update:returnQty', payload: { productId: string; maxQty: number; value: number | null | undefined }): void
  (event: 'submit'): void
  (event: 'closed'): void
}>()

const handleDialogVisibleChange = (value: boolean) => {
  emit('update:visible', value)
}

const handleReturnReasonChange = (value: string) => {
  emit('update:returnReason', value)
}
</script>

<template>
  <el-dialog
    v-if="detail"
    :model-value="visible"
    title="申请退货"
    width="92%"
    style="max-width: 760px"
    class="client-order-detail-dialog ylink-dialog-height-mode--scroll client-order-detail-dialog--form"
    body-class="client-order-detail-dialog__body client-order-detail-dialog__body--scroll"
    modal-class="client-order-detail-dialog-overlay"
    :close-on-click-modal="!submitting"
    :close-on-press-escape="!submitting"
    destroy-on-close
    append-to-body
    align-center
    :lock-scroll="true"
    @update:model-value="handleDialogVisibleChange"
    @closed="emit('closed')"
  >
    <div class="client-order-detail-dialog__content space-y-4">
      <div class="rounded-2xl bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-600">
        请按商品填写退货数量并说明原因。提交后系统会生成门店退货二维码，门店扫码核销后完成退货处理。
      </div>
      <div class="space-y-3">
        <div
          v-for="item in detail.items"
          :key="item.id"
          class="rounded-3xl border border-slate-100 bg-white px-4 py-4"
        >
          <div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <p class="text-sm font-semibold text-slate-900">{{ item.productName }}</p>
              <p class="mt-1 text-xs leading-5 text-slate-400">
                原订 {{ item.qty }} 件，当前可退 {{ item.availableReturnQty }} 件
              </p>
              <p v-if="item.returnedQty > 0" class="mt-2 text-xs leading-5 text-amber-600">
                已有 {{ item.returnedQty }} 件处于待退处理中，门店核销完成前不可重复申请。
              </p>
            </div>
            <div class="w-full md:w-44">
              <p class="mb-2 text-xs text-slate-400">本次退货数量</p>
              <el-input-number
                :model-value="Number(props.returnQtyMap[item.productId] ?? 0)"
                :min="0"
                :max="item.availableReturnQty"
                :step="1"
                :precision="0"
                class="w-full"
                @update:model-value="emit('update:returnQty', { productId: item.productId, maxQty: item.availableReturnQty, value: $event })"
              />
            </div>
          </div>
        </div>
      </div>

      <div class="rounded-3xl border border-slate-100 bg-white px-4 py-4">
        <p class="text-sm font-semibold text-slate-900">退货原因</p>
        <el-input
          :model-value="returnReason"
          type="textarea"
          :rows="4"
          :maxlength="reasonMaxLength"
          show-word-limit
          resize="none"
          class="mt-3"
          placeholder="请说明退货原因，便于门店快速处理。"
          @update:model-value="handleReturnReasonChange"
        />
        <p class="mt-2 text-xs text-slate-400">最多输入 {{ reasonMaxLength }} 个字符。</p>
      </div>

      <div class="rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-700">
        已选择 {{ selectedReturnItemCount }} 种商品，共 {{ selectedReturnTotalQty }} 件商品申请退货。
      </div>
    </div>

    <template #footer>
      <div class="flex flex-wrap justify-end gap-3">
        <el-button @click="emit('update:visible', false)">取消</el-button>
        <el-button
          type="primary"
          :loading="submitting"
          :disabled="!canSubmitReturnRequest"
          @click="emit('submit')"
        >
          提交退货申请
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>
