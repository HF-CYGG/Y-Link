<script setup lang="ts">
/**
 * 模块说明：src/views/inbound/components/InboundDeliverySheetWorkbenchDialog.vue
 * 文件职责：承载供货方历史送货单详情中的“生成送货单”弹窗，集中处理预览、浏览器打印与 PDF 导出。
 * 实现逻辑：
 * - 送货单内容直接从当前送货单详情同步生成，不提供在线补填入口；
 * - 弹窗主体只保留 A4 竖版送货单预览，减少左右双栏滚动和临时表单维护成本；
 * - 打印时通过 Teleport 输出独立打印根节点，避免被详情抽屉或弹窗滚动容器裁剪；
 * - PDF 导出复用同一份模板 DOM，保证预览、打印、PDF 内容一致。
 * 维护说明：
 * - 验收情况和签字确认均作为纸面手写区域保留，不回写后端业务数据；
 * - 若后续恢复在线补填，应重新评估是否需要持久化接口和审计记录，避免只在前端隐式保存。
 */
import { nextTick, ref } from 'vue'
import type { InboundOrderDetail } from '@/api/modules/inbound'
import { showAppError, showAppSuccess, showAppWarning } from '@/utils/app-alert'
import { extractErrorMessage } from '@/utils/error'
import { exportVoucherPdf } from '@/utils/pdf/export-voucher-pdf'
import InboundDeliverySheetTemplate from './InboundDeliverySheetTemplate.vue'

const DELIVERY_SHEET_PRINT_STYLE_ID = 'y-link-inbound-delivery-sheet-print-page-style'

const props = withDefaults(
  defineProps<{
    modelValue: boolean
    detail: InboundOrderDetail | null
    enableHtml2pdfExport?: boolean
  }>(),
  {
    enableHtml2pdfExport: true,
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const printRootRef = ref<HTMLElement | null>(null)
const exportPdfLoading = ref(false)

const applyPrintPageStyle = () => {
  const styleContent = '@media print { @page { size: A4 portrait; margin: 8mm; } }'
  let styleElement = document.getElementById(DELIVERY_SHEET_PRINT_STYLE_ID) as HTMLStyleElement | null
  if (!styleElement) {
    styleElement = document.createElement('style')
    styleElement.id = DELIVERY_SHEET_PRINT_STYLE_ID
    document.head.appendChild(styleElement)
  }
  styleElement.textContent = styleContent
}

const clearPrintPageStyle = () => {
  document.getElementById(DELIVERY_SHEET_PRINT_STYLE_ID)?.remove()
}

const updateDialogVisible = (value: boolean) => {
  emit('update:modelValue', value)
}

const handlePrintDeliverySheet = async () => {
  if (!props.detail) {
    showAppWarning('送货单详情尚未加载完成')
    return
  }

  applyPrintPageStyle()
  const cleanup = () => {
    clearPrintPageStyle()
    globalThis.removeEventListener('afterprint', cleanup)
  }
  globalThis.addEventListener('afterprint', cleanup)
  await nextTick()
  globalThis.print()
  globalThis.setTimeout(cleanup, 1500)
}

const handleExportDeliverySheetPdf = async () => {
  if (!props.enableHtml2pdfExport) {
    showAppWarning('PDF 导出暂未启用，当前仅支持打印')
    return
  }

  if (!props.detail) {
    showAppWarning('送货单详情尚未加载完成')
    return
  }

  const sourceElement = printRootRef.value?.querySelector('.delivery-sheet-print-document')
  if (!(sourceElement instanceof HTMLElement)) {
    showAppWarning('送货单模板尚未准备完成，请稍后重试')
    return
  }

  exportPdfLoading.value = true
  try {
    await exportVoucherPdf({
      sourceElement,
      filename: `${props.detail.order.showNo || 'delivery-sheet'}-送货单.pdf`,
      marginMm: 8,
      scale: 2,
      orientation: 'portrait',
    })
    showAppSuccess('PDF 导出成功')
  } catch (error) {
    showAppError(extractErrorMessage(error, 'PDF 导出失败，请稍后重试'))
  } finally {
    exportPdfLoading.value = false
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="生成送货单"
    width="860px"
    align-center
    class="inbound-delivery-sheet-dialog"
    append-to-body
    :modal-append-to-body="true"
    :lock-scroll="true"
    @update:model-value="updateDialogVisible"
  >
    <div v-if="detail" class="delivery-sheet-workbench">
      <div class="delivery-sheet-preview__header">
        <div>
          <h3>送货单预览</h3>
          <p>A4 竖版，验收情况与签字确认保留为纸面手写区域。</p>
        </div>
        <el-tag type="success" effect="light" round>{{ detail.items.length }} 行商品</el-tag>
      </div>
      <div class="delivery-sheet-preview__body">
        <InboundDeliverySheetTemplate :detail="detail" />
      </div>
    </div>
    <el-empty v-else description="送货单详情尚未加载完成" />

    <template #footer>
      <div class="delivery-sheet-dialog-footer">
        <el-button @click="updateDialogVisible(false)">关闭</el-button>
        <el-button type="primary" plain :disabled="!detail" @click="handlePrintDeliverySheet">打印</el-button>
        <el-button
          type="primary"
          :disabled="!detail || !enableHtml2pdfExport"
          :loading="exportPdfLoading"
          @click="handleExportDeliverySheetPdf"
        >
          导出PDF
        </el-button>
      </div>
    </template>
  </el-dialog>

  <Teleport to="body">
    <div
      v-if="modelValue && detail"
      ref="printRootRef"
      class="inbound-delivery-sheet-print-root"
      aria-hidden="true"
    >
      <InboundDeliverySheetTemplate :detail="detail" />
    </div>
  </Teleport>
</template>

<style scoped>
.inbound-delivery-sheet-dialog :deep(.el-dialog) {
  max-width: calc(100vw - 24px);
  max-height: calc(100dvh - 24px);
  display: flex;
  flex-direction: column;
  border-radius: 20px;
  overflow: hidden;
}

.inbound-delivery-sheet-dialog :deep(.el-dialog__body) {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding-top: 10px;
}

.delivery-sheet-workbench {
  display: flex;
  min-height: min(70dvh, 720px);
  max-height: min(72dvh, 760px);
  flex-direction: column;
  overflow: hidden;
  border: 1px solid #dbe4e1;
  border-radius: 16px;
  background: #ffffff;
}

.delivery-sheet-preview__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid #e2e8f0;
  padding: 14px 16px;
}

.delivery-sheet-preview__header h3 {
  margin: 0;
  color: #0f172a;
  font-size: 16px;
  font-weight: 700;
}

.delivery-sheet-preview__header p {
  margin: 6px 0 0;
  color: #64748b;
  font-size: 13px;
  line-height: 1.5;
}

.delivery-sheet-preview__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: #f8fafc;
  padding: 18px;
}

.delivery-sheet-preview__body :deep(.delivery-sheet) {
  box-shadow: 0 18px 34px -28px rgba(15, 23, 42, 0.28);
}

.delivery-sheet-dialog-footer {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
}

@media (max-width: 900px) {
  .delivery-sheet-workbench {
    min-height: 0;
    max-height: min(78dvh, 820px);
  }
}
</style>

<style>
.inbound-delivery-sheet-print-root {
  position: fixed;
  inset: 0;
  z-index: -1;
  overflow: hidden;
  pointer-events: none;
  opacity: 0;
  background: #ffffff;
}

@media print {
  html,
  body {
    margin: 0 !important;
    padding: 0 !important;
    background: #ffffff !important;
  }

  body > *:not(.inbound-delivery-sheet-print-root) {
    display: none !important;
  }

  .inbound-delivery-sheet-print-root {
    position: static;
    z-index: auto;
    display: block !important;
    overflow: visible;
    opacity: 1;
    pointer-events: auto;
  }
}
</style>
