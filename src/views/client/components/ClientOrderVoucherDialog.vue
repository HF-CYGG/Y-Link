<script setup lang="ts">
/**
 * 模块说明：src/views/client/components/ClientOrderVoucherDialog.vue
 * 文件职责：承载客户端订单详情页中的“正式出库单”弹层编辑与预览展示。
 * 实现逻辑：
 * - 父页面继续负责打印、副作用清理、打印状态回写与 PDF 导出，本组件只负责工作台界面与补填字段输入；
 * - 客户端正式出库单工作台需要与管理端保持同一套视觉结构，因此这里直接复用同样的说明区、双栏布局与预览舞台样式；
 * - 通过统一的字段更新事件把输入回传给父页面，避免详情页同时承载大段预览模板。
 * 维护说明：若正式出库单新增补填字段，优先在字段联合类型与 `emitEditableFieldUpdate` 中补齐。
 */

import dayjs from 'dayjs'
import type { OrderDetailResult } from '@/api/modules/order'
import OrderVoucherTemplate from '@/views/order-list/components/OrderVoucherTemplate.vue'
import type { OrderVoucherEditableFields, VoucherOrientation } from '@/views/client/client-order-detail-types'

type VoucherEditableFieldKey = keyof OrderVoucherEditableFields

/**
 * 说明文案与管理端保持一致：
 * - 固定字段、自动带出字段、在线补填字段三段说明完全复用同一口径；
 * - 客户端仍额外保留“不会回写数据库”的提示，但整体视觉与层级对齐管理端工作台。
 */
const ORDER_VOUCHER_FIXED_FIELDS_TEXT = '固定版式字段：标题区、基础信息区、明细区、汇总区与签字区'
const ORDER_VOUCHER_AUTO_FIELDS_TEXT = '自动填充字段：申请部门、商品名称、产品编码、单价、数量、小计、总计、业务单号'
const ORDER_VOUCHER_EDITABLE_FIELDS_TEXT = '在线补填字段：部门经办人、金蝶单据编号、领取人签字、完成日期'
const ORDER_VOUCHER_OFFLINE_SIGNATURE_TEXT = '线下手写字段：文创工坊管理员签字、出库人签字'

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
        <span>{{ ORDER_VOUCHER_FIXED_FIELDS_TEXT }}</span>
        <span>{{ ORDER_VOUCHER_AUTO_FIELDS_TEXT }}</span>
        <span>{{ ORDER_VOUCHER_EDITABLE_FIELDS_TEXT }}</span>
        <span>{{ ORDER_VOUCHER_OFFLINE_SIGNATURE_TEXT }}</span>
        <span>本期补填内容仅在当前页面临时生效，不回写数据库。</span>
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
            <span>开单时间：{{ dayjs(voucherOrder.createdAt).format('YYYY-MM-DD HH:mm:ss') }}</span>
          </div>
        </div>
        <div class="voucher-orientation-toolbar">
          <span class="voucher-orientation-toolbar__label">页面方向</span>
          <el-radio-group :model-value="orientation" size="small" @update:model-value="handleOrientationChange">
            <el-radio-button value="landscape">横版</el-radio-button>
            <el-radio-button value="portrait">竖版</el-radio-button>
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
            <el-form-item label="完成日期">
              <el-input
                :model-value="editableFields.completionDate"
                placeholder="请输入完成日期，例如：2026-04-30"
                clearable
                @update:model-value="emitEditableFieldUpdate('completionDate', $event)"
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

<style scoped>
.order-voucher-dialog :deep(.el-dialog) {
  border-radius: 20px;
  overflow: hidden;
  max-width: calc(100vw - 24px);
  max-height: calc(100dvh - 24px);
  display: flex;
  flex-direction: column;
}

.order-voucher-dialog :deep(.el-dialog__body) {
  padding-top: 10px;
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.order-voucher-print-scope {
  background: #ffffff;
  border-radius: 16px;
}

.voucher-editor-banner {
  margin-bottom: 12px;
  border: 1px solid #c7d2fe;
  border-radius: 14px;
  background: linear-gradient(135deg, #f8faff 0%, #eef4ff 100%);
  padding: 10px 12px;
}

.voucher-editor-banner__title {
  font-size: 13px;
  font-weight: 700;
  color: #1e40af;
}

.voucher-editor-banner__content {
  margin-top: 6px;
  display: grid;
  gap: 4px;
  font-size: 12px;
  color: #334155;
}

.voucher-workbench {
  display: grid;
  grid-template-columns: minmax(300px, 340px) minmax(0, 1fr);
  gap: 14px;
  align-items: start;
  flex: 1;
  min-height: 0;
}

.voucher-editor-panel,
.voucher-preview-panel {
  border: 1px solid #e2e8f0;
  border-radius: 16px;
  background: #fff;
}

.voucher-editor-panel {
  padding: 14px;
  position: sticky;
  top: 0;
}

.voucher-editor-panel__header,
.voucher-preview-panel__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.voucher-editor-panel__title,
.voucher-preview-panel__title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: #0f172a;
}

.voucher-editor-panel__desc,
.voucher-preview-panel__desc {
  margin: 4px 0 0;
  font-size: 12px;
  color: #64748b;
  line-height: 1.6;
}

.voucher-editor-panel__meta,
.voucher-preview-panel__summary {
  display: grid;
  gap: 4px;
  font-size: 12px;
  color: #475569;
  text-align: right;
}

.voucher-editor-form {
  margin-top: 14px;
}

.voucher-orientation-toolbar {
  margin-top: 14px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border: 1px dashed #cbd5e1;
  border-radius: 12px;
  background: #f8fafc;
  padding: 10px 12px;
}

.voucher-orientation-toolbar__label {
  font-size: 13px;
  font-weight: 600;
  color: #334155;
}

.voucher-editor-form__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 12px;
}

.voucher-editor-form__item--full {
  grid-column: 1 / -1;
}

.voucher-editor-form :deep(.el-form-item) {
  margin-bottom: 0;
}

.voucher-preview-panel {
  min-width: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.voucher-preview-panel__header {
  padding: 14px 16px;
  border-bottom: 1px solid #e2e8f0;
  background: #f8fafc;
}

.voucher-preview-panel__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 14px;
  background: #f8fafc;
}

.order-voucher-preview-scope {
  margin: 0 auto;
}

.order-voucher-preview-scope.is-landscape {
  width: 281mm;
  min-width: 281mm;
}

.order-voucher-preview-scope.is-portrait {
  width: 194mm;
  min-width: 194mm;
}

@media (max-width: 768px) {
  .voucher-workbench {
    grid-template-columns: minmax(0, 1fr);
  }

  .voucher-editor-panel {
    position: static;
  }

  .voucher-editor-panel__header,
  .voucher-preview-panel__header {
    flex-direction: column;
  }

  .voucher-editor-panel__meta,
  .voucher-preview-panel__summary {
    width: 100%;
    text-align: left;
  }

  .voucher-editor-form__grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .voucher-orientation-toolbar {
    align-items: flex-start;
  }

  .voucher-preview-panel__body {
    max-height: none;
    padding: 10px;
  }

  .order-voucher-preview-scope.is-landscape,
  .order-voucher-preview-scope.is-portrait {
    width: 100%;
    min-width: 100%;
  }
}
</style>

<style>
.order-voucher-print-root {
  display: none;
}

@media print {
  html,
  body {
    margin: 0 !important;
    padding: 0 !important;
    background: #fff !important;
  }

  body > *:not(.order-voucher-print-root) {
    display: none !important;
  }

  .order-voucher-print-root {
    display: block !important;
    background: #ffffff;
    width: auto;
    min-height: auto;
    margin: 0;
    padding: 0 !important;
    overflow: visible;
  }

  .order-voucher-print-root .order-voucher-print-scope {
    width: fit-content;
    margin: 0 auto;
    overflow: visible;
    break-inside: auto;
    page-break-inside: auto;
  }

  .order-voucher-print-root .order-voucher-print-scope.is-landscape {
    width: 281mm;
    max-width: 281mm;
    min-height: 194mm;
  }

  .order-voucher-print-root .order-voucher-print-scope.is-portrait {
    width: 194mm;
    max-width: 194mm;
    min-height: 279mm;
  }
}
</style>
