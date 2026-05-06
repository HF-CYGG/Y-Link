<script setup lang="ts">
/**
 * 模块说明：src/views/client/components/ClientOrderEditDialog.vue
 * 文件职责：承载客户端订单详情页中的“修改订单”弹层展示与表单输入交互。
 * 实现逻辑：
 * - 父页面保留库存重算、保存提交与权限判断，本组件只负责渲染与输入事件分发；
 * - 通过 emit 回传数量变更、商品追加、备注编辑与提交流程，降低详情页模板体积。
 * 维护说明：若改单弹层新增字段，优先在这里扩展展示，再回到父页面补齐状态与提交载荷。
 */

import type { O2oMallProduct, O2oPreorderDetail } from '@/api/modules/o2o'
import type { EditableOrderItem } from '@/views/client/client-order-detail-types'

const props = defineProps<{
  visible: boolean
  detail: O2oPreorderDetail | null
  submitting: boolean
  productsLoading: boolean
  canModifyOrder: boolean
  modifyOrderQuotaText: string
  remarkMaxLength: number
  editRemark: string
  editAddProductId: string
  editOrderItems: EditableOrderItem[]
  editableProductOptions: O2oMallProduct[]
  editableOrderTotalQty: number
  editableOrderTotalAmount: number
  canSubmitOrderEdit: boolean
}>()

const emit = defineEmits<{
  (event: 'update:visible', value: boolean): void
  (event: 'update:editRemark', value: string): void
  (event: 'update:editAddProductId', value: string): void
  (event: 'update:itemQty', payload: { productId: string; value: number | null | undefined }): void
  (event: 'remove-item', productId: string): void
  (event: 'add-product'): void
  (event: 'submit'): void
  (event: 'closed'): void
}>()

const handleDialogVisibleChange = (value: boolean) => {
  emit('update:visible', value)
}

const handleRemarkChange = (value: string) => {
  emit('update:editRemark', value)
}

const handleAddProductIdChange = (value: string) => {
  emit('update:editAddProductId', value)
}
</script>

<template>
  <el-dialog
    v-if="detail"
    :model-value="visible"
    title="修改订单"
    width="92%"
    style="max-width: 860px"
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
        待取货订单支持直接修改商品、数量和备注。保存后系统会按最新内容重算预订库存，原取货码保持不变。
        <p class="mt-2 text-xs text-slate-500">{{ modifyOrderQuotaText }}</p>
      </div>

      <div class="rounded-3xl border border-slate-100 bg-white px-4 py-4">
        <div class="flex flex-col gap-3 lg:flex-row lg:items-end">
          <div class="flex-1">
            <p class="text-sm font-semibold text-slate-900">添加商品</p>
            <el-select
              :model-value="editAddProductId"
              class="mt-3 w-full"
              placeholder="请选择要加入订单的商品"
              filterable
              :loading="productsLoading"
              @update:model-value="handleAddProductIdChange"
            >
              <el-option
                v-for="product in editableProductOptions"
                :key="product.id"
                :label="`${product.productName}（剩余 ${product.availableStock} 件）`"
                :value="product.id"
              />
            </el-select>
          </div>
          <el-button type="primary" plain :disabled="!editableProductOptions.length" @click="emit('add-product')">加入订单</el-button>
        </div>
        <p v-if="!editableProductOptions.length" class="mt-3 text-xs text-slate-400">当前没有可追加到本单的在售商品。</p>
      </div>

      <div class="space-y-3">
        <div
          v-for="item in editOrderItems"
          :key="item.productId"
          class="rounded-3xl border border-slate-100 bg-white px-4 py-4"
        >
          <div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div class="min-w-0 flex-1">
              <p class="text-sm font-semibold text-slate-900">{{ item.productName }}</p>
              <p class="mt-1 text-xs leading-5 text-slate-400">
                原数量 {{ item.originalQty }} 件，当前最多可改为 {{ item.maxQty }} 件
              </p>
              <p v-if="item.unavailableReason" class="mt-2 text-xs leading-5 text-amber-600">
                {{ item.unavailableReason }}
              </p>
            </div>
            <div class="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div class="w-full sm:w-44">
                <p class="mb-2 text-xs text-slate-400">修改后数量</p>
                <el-input-number
                  :model-value="item.qty"
                  :min="0"
                  :max="item.maxQty"
                  :step="1"
                  :precision="0"
                  class="w-full"
                  @update:model-value="emit('update:itemQty', { productId: item.productId, value: $event })"
                />
              </div>
              <el-button text type="danger" @click="emit('remove-item', item.productId)">移除</el-button>
            </div>
          </div>
        </div>
      </div>

      <div class="rounded-3xl border border-slate-100 bg-white px-4 py-4">
        <p class="text-sm font-semibold text-slate-900">订单备注</p>
        <el-input
          :model-value="editRemark"
          type="textarea"
          :rows="4"
          :maxlength="remarkMaxLength"
          show-word-limit
          resize="none"
          class="mt-3"
          placeholder="选填：例如领取时间、特殊说明"
          @update:model-value="handleRemarkChange"
        />
      </div>

      <div class="rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-700">
        修改后共 {{ editableOrderTotalQty }} 件商品，合计 ¥{{ editableOrderTotalAmount.toFixed(2) }}。
        <p class="mt-2 text-xs text-amber-700">保存成功后将占用 1 次改单机会。</p>
      </div>
    </div>

    <template #footer>
      <div class="flex flex-wrap justify-end gap-3">
        <el-button @click="emit('update:visible', false)">取消</el-button>
        <el-button
          type="primary"
          :loading="submitting"
          :disabled="!canSubmitOrderEdit || !canModifyOrder"
          @click="emit('submit')"
        >
          保存修改
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>
