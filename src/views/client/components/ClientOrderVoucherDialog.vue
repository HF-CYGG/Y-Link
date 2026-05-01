<script setup lang="ts">
/**
 * 模块说明：src/views/client/components/ClientOrderVoucherDialog.vue
 * 文件职责：承载客户端订单详情页中的“正式出库单”弹层编辑与预览展示。
 * 实现逻辑：
 * - 父页面继续负责打印、副作用清理与 PDF 导出，本组件只管理弹层 UI 与补填字段输入；
 * - 通过统一的字段更新事件把输入回传给父页面，避免详情页同时承载大段预览模板。
 * 维护说明：若正式出库单新增补填字段，优先在字段联合类型与 `emitEditableFieldUpdate` 中补齐。
 */

import type { OrderDetailResult } from '@/api/modules/order'
import OrderVoucherTemplate from '@/views/order-list/components/OrderVoucherTemplate.vue'
import type { OrderVoucherEditableFields, VoucherOrientation } from '@/views/client/client-order-detail-types'

type VoucherEditableFieldKey = keyof OrderVoucherEditableFields

const props = defineProps<{
  visible: boolean
  voucherOrder: OrderDetailResult | null
  editableFields: OrderVoucherEditableFields
  orientation: VoucherOrientation
  orientationLabel: string
  enableHtml2pdfExport: boolean
  exportPdfLoading: boolean
}>()

const emit = defineEmits<{
  (event: 'update:visible', value: boolean): void
  (event: 'update:orientation', value: VoucherOrientation): void
  (event: 'update:editable-field', payload: { key: VoucherEditableFieldKey; value: string }): void
  (event: 'print'): void
  (event: 'export-pdf'): void
  (event: 'closed'): void
}>()

const handleDialogVisibleChange = (value: boolean) => {
  emit('update:visible', value)
}

const handleOrientationChange = (value: string | number | boolean | undefined) => {
  if (value === 'portrait' || value === 'landscape') {
    emit('update:orientation', value)
  }
}

const emitEditableFieldUpdate = (key: VoucherEditableFieldKey, value: string | number) => {
  emit('update:editable-field', { key, value: String(value ?? '') })
}
</script>

<template>
  <el-dialog
    v-if="voucherOrder"
    :model-value="visible"
    title="正式出库单"
    width="1100px"
    align-center
    class="client-order-detail-dialog client-order-detail-dialog--voucher order-voucher-dialog"
    body-class="client-order-detail-dialog__body client-order-detail-dialog__body--voucher"
    modal-class="client-order-detail-dialog-overlay"
    append-to-body
    destroy-on-close
    :modal-append-to-body="true"
    :lock-scroll="true"
    :close-on-click-modal="!exportPdfLoading"
    :close-on-press-escape="!exportPdfLoading"
    @update:model-value="handleDialogVisibleChange"
    @closed="emit('closed')"
  >
    <div class="voucher-editor-banner">
      <div class="voucher-editor-banner__title">正式出库单字段说明</div>
      <div class="voucher-editor-banner__content">
        <span>固定字段由系统按订单数据自动带出，联次默认为一式两份。</span>
        <span>可补填字段仅用于当前页面预览与打印，不会写回数据库。</span>
        <span>订单全流程均可打印，核销与否不影响出库单补打。</span>
      </div>
    </div>
    <div class="voucher-workbench">
      <section class="voucher-editor-panel">
        <div class="voucher-editor-panel__header">
          <div>
            <h3 class="voucher-editor-panel__title">在线补填</h3>
            <p class="voucher-editor-panel__desc">填写后会立即同步到下方正式出库单预览与打印结果。</p>
          </div>
          <div class="voucher-editor-panel__meta">
            <span>业务单号：{{ voucherOrder.showNo }}</span>
            <span>下单时间：{{ voucherOrder.createdAt }}</span>
          </div>
        </div>
        <div class="voucher-orientation-toolbar">
          <span class="voucher-orientation-toolbar__label">页面方向</span>
          <el-radio-group :model-value="orientation" size="small" @update:model-value="handleOrientationChange">
            <el-radio-button label="landscape">横版</el-radio-button>
            <el-radio-button label="portrait">竖版</el-radio-button>
          </el-radio-group>
        </div>
        <el-form label-position="top" class="voucher-editor-form">
          <div class="voucher-editor-form__grid">
            <el-form-item label="部门经办人">
              <el-input
                :model-value="editableFields.departmentOperator"
                placeholder="请输入部门经办人"
                clearable
                @update:model-value="emitEditableFieldUpdate('departmentOperator', $event)"
              />
            </el-form-item>
            <el-form-item label="金蝶单据编号">
              <el-input
                :model-value="editableFields.kingdeeVoucherNo"
                placeholder="请输入金蝶单据编号"
                clearable
                @update:model-value="emitEditableFieldUpdate('kingdeeVoucherNo', $event)"
              />
            </el-form-item>
            <el-form-item label="领取人签字">
              <el-input
                :model-value="editableFields.receiverSignature"
                placeholder="请输入领取人签字"
                clearable
                @update:model-value="emitEditableFieldUpdate('receiverSignature', $event)"
              />
            </el-form-item>
            <el-form-item label="出库人签字">
              <el-input
                :model-value="editableFields.issuerSignature"
                placeholder="请输入出库人签字"
                clearable
                @update:model-value="emitEditableFieldUpdate('issuerSignature', $event)"
              />
            </el-form-item>
            <el-form-item class="voucher-editor-form__item--full" label="完成日期/签字">
              <el-input
                :model-value="editableFields.completionSignature"
                placeholder="请输入完成日期或签字说明，例如：2026-04-30 已完成"
                clearable
                @update:model-value="emitEditableFieldUpdate('completionSignature', $event)"
              />
            </el-form-item>
          </div>
        </el-form>
      </section>

      <section class="voucher-preview-panel">
        <div class="voucher-preview-panel__header">
          <div>
            <h3 class="voucher-preview-panel__title">正式出库单预览</h3>
            <p class="voucher-preview-panel__desc">
              当前方向：{{ orientationLabel }}，共 2 页，每页 1 联；申请部门：{{ voucherOrder.customerDepartmentName || '散客' }}
            </p>
          </div>
          <div class="voucher-preview-panel__summary">
            <span>商品 {{ voucherOrder.items.length }} 行</span>
            <span>总金额 ¥{{ Number(voucherOrder.totalAmount).toFixed(2) }}</span>
          </div>
        </div>
        <div class="voucher-preview-panel__body">
          <div class="order-voucher-preview-scope" :class="`is-${orientation}`">
            <OrderVoucherTemplate
              :order="voucherOrder"
              :editable-fields="editableFields"
              :orientation="orientation"
            />
          </div>
        </div>
      </section>
    </div>
    <template #footer>
      <span class="flex flex-wrap justify-end gap-2">
        <el-button @click="emit('update:visible', false)">关闭</el-button>
        <el-button type="primary" plain @click="emit('print')">打印</el-button>
        <el-button type="primary" :disabled="!enableHtml2pdfExport" :loading="exportPdfLoading" @click="emit('export-pdf')">
          导出PDF
        </el-button>
      </span>
    </template>
  </el-dialog>
</template>
