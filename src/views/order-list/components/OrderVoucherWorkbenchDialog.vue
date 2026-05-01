<!--
  文件说明：
  该文件用于承载出库列表页中的“正式出库单工作台”低频弹窗。
  组件负责在线补填、横竖版预览、浏览器打印、PDF 导出以及打印专用 Teleport 输出，
  通过异步分包把重模板与低频逻辑从 OrderListView 主页面中拆出，降低订单列表首包体积。
-->
<script setup lang="ts">
/**
 * 模块说明：`src/views/order-list/components/OrderVoucherWorkbenchDialog.vue`
 * 文件职责：集中承接正式出库单的临时补填、预览、打印和导出流程，供订单列表页按需异步加载。
 * 实现逻辑：
 * 1. 父页面只维护“是否打开正式出库单”这一轻量入口状态，重逻辑全部沉到当前低频组件；
 * 2. 组件内部仍复用统一的 `OrderVoucherTemplate`，保证预览、打印、导出三者保持同一份 DOM 结构；
 * 3. 补填字段仅存在当前页面内存中，切换单据时自动重置，不回写数据库；
 * 4. 打印页方向通过临时注入全局 `@page` 样式控制，打印后立即清理，避免污染其它页面。
 */

import dayjs from 'dayjs'
import { ElMessage } from 'element-plus'
import { computed, nextTick, reactive, ref, watch } from 'vue'
import type { OrderDetailResult } from '@/api/modules/order'
import { extractErrorMessage } from '@/utils/error'
import { exportVoucherPdf } from '@/utils/pdf/export-voucher-pdf'
import OrderVoucherTemplate from './OrderVoucherTemplate.vue'

interface OrderVoucherEditableFields {
  departmentOperator: string
  kingdeeVoucherNo: string
  receiverSignature: string
  issuerSignature: string
  completionSignature: string
}

type VoucherOrientation = 'portrait' | 'landscape'

const props = withDefaults(
  defineProps<{
    modelValue: boolean
    order: OrderDetailResult
    enableHtml2pdfExport?: boolean
  }>(),
  {
    enableHtml2pdfExport: true,
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

/**
 * 字段映射说明：
 * - 固定字段由模板结构直接决定，不需要用户维护；
 * - 自动填充字段直接来自当前订单详情；
 * - 在线补填字段只存在当前弹窗会话里，关闭或切换单据后会重新初始化。
 */
const ORDER_VOUCHER_FIXED_FIELDS_TEXT = '固定版式字段：标题区、基础信息区、明细区、汇总区与签字区'
const ORDER_VOUCHER_AUTO_FIELDS_TEXT = '自动填充字段：申请部门、商品名称、产品编码、单价、数量、小计、总计、业务单号'
const ORDER_VOUCHER_EDITABLE_FIELDS_TEXT = '在线补填字段：部门经办人、金蝶单据编号、领取人签字、出库人签字、完成日期/签字'
const VOUCHER_PRINT_STYLE_ID = 'y-link-order-voucher-print-page-style'

const createEmptyVoucherEditableFields = (): OrderVoucherEditableFields => ({
  departmentOperator: '',
  kingdeeVoucherNo: '',
  receiverSignature: '',
  issuerSignature: '',
  completionSignature: '',
})

const dialogVisible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
})
const voucherPrintRootRef = ref<HTMLElement | null>(null)
const exportPdfLoading = ref(false)
const voucherEditableForm = reactive<OrderVoucherEditableFields>(createEmptyVoucherEditableFields())
const voucherOrientation = ref<VoucherOrientation>('landscape')
const voucherOrientationLabel = computed(() => (voucherOrientation.value === 'landscape' ? '横版' : '竖版'))

/**
 * 切换单据时重置补填字段：
 * - 防止部门经办人、签字等人工录入内容串到下一张单据；
 * - 只清空临时补填内容，不影响当前页面列表和详情数据。
 */
const resetVoucherEditableForm = () => {
  Object.assign(voucherEditableForm, createEmptyVoucherEditableFields())
}

watch(
  () => props.order.id,
  () => {
    resetVoucherEditableForm()
  },
  {
    immediate: true,
  },
)

watch(
  () => props.order.orderType,
  (orderType) => {
    // 正式出库单只适用于部门单；若父层详情切换成散客单，需要立即关闭工作台，
    // 避免继续展示上一张部门单的凭证预览，造成业务误解。
    if (orderType !== 'department' && dialogVisible.value) {
      dialogVisible.value = false
    }
  },
  {
    immediate: true,
  },
)

// 浏览器打印无法稳定从组件局部样式里动态切换 @page 方向，
// 因此在打印前临时写入全局样式，打印结束后再主动清理。
const applyVoucherPrintPageStyle = (orientation: VoucherOrientation) => {
  const styleContent = `@media print { @page { size: A4 ${orientation}; margin: 8mm; } }`
  let styleElement = document.getElementById(VOUCHER_PRINT_STYLE_ID) as HTMLStyleElement | null
  if (!styleElement) {
    styleElement = document.createElement('style')
    styleElement.id = VOUCHER_PRINT_STYLE_ID
    document.head.appendChild(styleElement)
  }
  styleElement.textContent = styleContent
}

const clearVoucherPrintPageStyle = () => {
  const styleElement = document.getElementById(VOUCHER_PRINT_STYLE_ID)
  styleElement?.remove()
}

/**
 * 打印正式出库单：
 * - 直接触发浏览器打印；
 * - 打印专用 DOM 通过 Teleport 输出到 body 根层，避免受弹窗滚动容器裁剪。
 */
const handlePrintVoucher = async () => {
  applyVoucherPrintPageStyle(voucherOrientation.value)
  const cleanup = () => {
    clearVoucherPrintPageStyle()
    globalThis.removeEventListener('afterprint', cleanup)
  }
  globalThis.addEventListener('afterprint', cleanup)
  await nextTick()
  globalThis.print()
  globalThis.setTimeout(cleanup, 1500)
}

/**
 * 导出 PDF：
 * - 与打印复用同一份正式模板 DOM；
 * - 导出的文件天然带上当前补填内容与当前横竖版方向。
 */
const handleExportVoucherPdf = async () => {
  if (!props.enableHtml2pdfExport) {
    ElMessage.info('PDF 导出开关未启用，当前仅支持打印')
    return
  }

  const sourceElement = voucherPrintRootRef.value?.querySelector('.voucher-print-document')
  if (!(sourceElement instanceof HTMLElement)) {
    ElMessage.warning('凭证模板尚未准备完成，请稍后重试')
    return
  }

  const outputFileName = `${props.order.showNo || 'order-voucher'}-正式出库单.pdf`

  exportPdfLoading.value = true
  try {
    await exportVoucherPdf({
      sourceElement,
      filename: outputFileName,
      marginMm: 8,
      scale: 2,
      orientation: voucherOrientation.value,
    })
    ElMessage.success('PDF 导出成功')
  } catch (error) {
    ElMessage.error(extractErrorMessage(error, 'PDF 导出失败，请稍后重试'))
  } finally {
    exportPdfLoading.value = false
  }
}
</script>

<template>
  <el-dialog
    v-model="dialogVisible"
    title="正式出库单"
    width="1100px"
    align-center
    class="order-voucher-dialog"
    append-to-body
    :modal-append-to-body="true"
    :lock-scroll="true"
  >
    <div class="voucher-editor-banner">
      <div class="voucher-editor-banner__title">正式出库单字段说明</div>
      <div class="voucher-editor-banner__content">
        <span>{{ ORDER_VOUCHER_FIXED_FIELDS_TEXT }}</span>
        <span>{{ ORDER_VOUCHER_AUTO_FIELDS_TEXT }}</span>
        <span>{{ ORDER_VOUCHER_EDITABLE_FIELDS_TEXT }}</span>
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
            <span>业务单号：{{ props.order.showNo }}</span>
            <span>开单时间：{{ dayjs(props.order.createdAt).format('YYYY-MM-DD HH:mm:ss') }}</span>
          </div>
        </div>
        <div class="voucher-orientation-toolbar">
          <span class="voucher-orientation-toolbar__label">页面方向</span>
          <el-radio-group v-model="voucherOrientation" size="small">
            <el-radio-button label="landscape">横版</el-radio-button>
            <el-radio-button label="portrait">竖版</el-radio-button>
          </el-radio-group>
        </div>
        <el-form label-position="top" class="voucher-editor-form">
          <div class="voucher-editor-form__grid">
            <el-form-item label="部门经办人">
              <el-input v-model="voucherEditableForm.departmentOperator" placeholder="请输入部门经办人" clearable />
            </el-form-item>
            <el-form-item label="金蝶单据编号">
              <el-input v-model="voucherEditableForm.kingdeeVoucherNo" placeholder="请输入金蝶单据编号" clearable />
            </el-form-item>
            <el-form-item label="领取人签字">
              <el-input v-model="voucherEditableForm.receiverSignature" placeholder="请输入领取人签字" clearable />
            </el-form-item>
            <el-form-item label="出库人签字">
              <el-input v-model="voucherEditableForm.issuerSignature" placeholder="请输入出库人签字" clearable />
            </el-form-item>
            <el-form-item class="voucher-editor-form__item--full" label="完成日期/签字">
              <el-input
                v-model="voucherEditableForm.completionSignature"
                placeholder="请输入完成日期或签字说明，例如：2026-04-28 已完成"
                clearable
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
              当前方向：{{ voucherOrientationLabel }}，共 2 页，每页 1 联；申请部门：{{ props.order.customerDepartmentName || '散客' }}
            </p>
          </div>
          <div class="voucher-preview-panel__summary">
            <span>商品 {{ props.order.items.length }} 行</span>
            <span>总金额 ¥{{ Number(props.order.totalAmount).toFixed(2) }}</span>
          </div>
        </div>
        <div class="voucher-preview-panel__body">
          <div class="order-voucher-preview-scope" :class="`is-${voucherOrientation}`">
            <OrderVoucherTemplate
              :order="props.order"
              :editable-fields="voucherEditableForm"
              :orientation="voucherOrientation"
            />
          </div>
        </div>
      </section>
    </div>
    <template #footer>
      <span class="flex flex-wrap justify-end gap-2">
        <el-button @click="dialogVisible = false">关闭</el-button>
        <el-button type="primary" plain @click="handlePrintVoucher">打印</el-button>
        <el-button type="primary" :disabled="!props.enableHtml2pdfExport" :loading="exportPdfLoading" @click="handleExportVoucherPdf">
          导出PDF
        </el-button>
      </span>
    </template>
  </el-dialog>

  <Teleport to="body">
    <div
      v-if="dialogVisible"
      ref="voucherPrintRootRef"
      class="order-voucher-print-root"
      aria-hidden="true"
    >
      <div class="order-voucher-print-scope" :class="`is-${voucherOrientation}`">
        <OrderVoucherTemplate
          :order="props.order"
          :editable-fields="voucherEditableForm"
          :orientation="voucherOrientation"
        />
      </div>
    </div>
  </Teleport>
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
