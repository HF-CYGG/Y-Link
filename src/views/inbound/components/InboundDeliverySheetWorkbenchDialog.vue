<script setup lang="ts">
/**
 * 模块说明：src/views/inbound/components/InboundDeliverySheetWorkbenchDialog.vue
 * 文件职责：承载供货方历史送货单详情中的“生成送货单”弹窗，集中处理补填、预览、打印与 PDF 导出。
 * 实现逻辑：
 * - 打开弹窗时根据当前送货单详情自动生成项目内容、供货方、日期时间、签字日期等默认补填字段；
 * - 使用 Element Plus 表单维护临时补填内容，并实时同步到右侧 A4 竖版送货单预览；
 * - 组件内部根据核销码生成送货单二维码，确保待入库、已入库、已撤销单据都能输出纸质核对信息；
 * - 打印时通过 Teleport 输出独立打印根节点，PDF 导出复用同一份模板 DOM，保证预览、打印、PDF 内容一致。
 * 维护说明：
 * - 补填字段只存在当前弹窗会话，关闭或切换单据后自动重置，不回写后端业务数据；
 * - 若后续增加持久化验收字段，应新增后端接口和审计记录，不要在当前打印弹窗中隐式保存。
 */
import dayjs from 'dayjs'
import QRCode from 'qrcode'
import { computed, nextTick, reactive, ref, watch } from 'vue'
import type { InboundOrderDetail } from '@/api/modules/inbound'
import { showAppError, showAppSuccess, showAppWarning } from '@/utils/app-alert'
import { extractErrorMessage } from '@/utils/error'
import { exportVoucherPdf } from '@/utils/pdf/export-voucher-pdf'
import InboundDeliverySheetTemplate from './InboundDeliverySheetTemplate.vue'
import type { InboundDeliverySheetFields } from './inbound-delivery-sheet-types'

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

const dialogVisible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
})

const printRootRef = ref<HTMLElement | null>(null)
const exportPdfLoading = ref(false)
const qrCodeDataUrl = ref('')
const qrCodeGenerating = ref(false)

const createDefaultFields = (detail: InboundOrderDetail | null): InboundDeliverySheetFields => {
  const order = detail?.order
  const createdAt = order?.createdAt ? dayjs(order.createdAt) : dayjs()
  const arrivedAt = order?.verifiedAt ? dayjs(order.verifiedAt) : createdAt
  const supplierName = order?.supplierName?.trim() || ''
  const productSummary = detail?.items
    .map((item) => `${item.productNameSnapshot || '未命名商品'} x ${Number(item.qty || 0)}`)
    .join('，')

  return {
    projectCategory: '文创送货',
    content: productSummary || (order?.showNo ? `送货单 ${order.showNo}` : ''),
    senderName: supplierName,
    deliveryDate: createdAt.format('YYYY-MM-DD'),
    deliveredTime: arrivedAt.format('HH:mm'),
    quantityMatched: true,
    qualityAccepted: true,
    hasIssue: false,
    issueDescription: '',
    inspectorName: '',
    senderSignature: supplierName,
    receiverSignature: '',
    senderSignDate: dayjs().format('YYYY-MM-DD'),
    receiverSignDate: dayjs().format('YYYY-MM-DD'),
  }
}

const sheetFields = reactive<InboundDeliverySheetFields>(createDefaultFields(null))

const resetSheetFields = () => {
  Object.assign(sheetFields, createDefaultFields(props.detail))
}

const generateSheetQrCode = async () => {
  const verifyCode = props.detail?.order.verifyCode
  if (!verifyCode) {
    qrCodeDataUrl.value = ''
    return
  }

  qrCodeGenerating.value = true
  try {
    qrCodeDataUrl.value = await QRCode.toDataURL(verifyCode, {
      width: 180,
      margin: 1,
      color: { dark: '#000000', light: '#ffffff' },
    })
  } catch (error) {
    qrCodeDataUrl.value = ''
    showAppWarning(extractErrorMessage(error, '送货单二维码生成失败，可先打印纸质信息'))
  } finally {
    qrCodeGenerating.value = false
  }
}

watch(
  () => props.detail?.order.id,
  () => {
    resetSheetFields()
    void generateSheetQrCode()
  },
  {
    immediate: true,
  },
)

watch(
  () => dialogVisible.value,
  (visible) => {
    if (visible) {
      resetSheetFields()
      void generateSheetQrCode()
    }
  },
)

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
    v-model="dialogVisible"
    title="生成送货单"
    width="1120px"
    align-center
    class="inbound-delivery-sheet-dialog"
    append-to-body
    :modal-append-to-body="true"
    :lock-scroll="true"
  >
    <div v-if="detail" class="delivery-sheet-workbench">
      <section class="delivery-sheet-editor">
        <div class="delivery-sheet-editor__header">
          <h3>在线补填</h3>
          <p>内容只用于本次送货单打印和 PDF 导出，不会保存到数据库。</p>
          <div class="delivery-sheet-editor__meta">
            <span>送货单号：{{ detail.order.showNo }}</span>
            <span>二维码：{{ qrCodeGenerating ? '生成中' : (qrCodeDataUrl ? '已生成' : '未生成') }}</span>
          </div>
        </div>

        <el-form label-position="top" class="delivery-sheet-editor-form">
          <el-form-item label="项目类别">
            <el-input v-model="sheetFields.projectCategory" clearable />
          </el-form-item>
          <el-form-item label="具体内容">
            <el-input v-model="sheetFields.content" type="textarea" :rows="3" maxlength="180" show-word-limit resize="none" />
          </el-form-item>
          <div class="delivery-sheet-editor-form__grid">
            <el-form-item label="送货方姓名">
              <el-input v-model="sheetFields.senderName" clearable />
            </el-form-item>
            <el-form-item label="送货日期">
              <el-input v-model="sheetFields.deliveryDate" clearable />
            </el-form-item>
            <el-form-item label="送达时间">
              <el-input v-model="sheetFields.deliveredTime" clearable />
            </el-form-item>
            <el-form-item label="验收人">
              <el-input v-model="sheetFields.inspectorName" clearable />
            </el-form-item>
          </div>
          <el-form-item label="验收情况">
            <el-checkbox v-model="sheetFields.quantityMatched">数量相符</el-checkbox>
            <el-checkbox v-model="sheetFields.qualityAccepted">质量合格</el-checkbox>
            <el-checkbox v-model="sheetFields.hasIssue">存在问题</el-checkbox>
          </el-form-item>
          <el-form-item label="问题描述">
            <el-input v-model="sheetFields.issueDescription" type="textarea" :rows="3" maxlength="160" show-word-limit resize="none" />
          </el-form-item>
          <div class="delivery-sheet-editor-form__grid">
            <el-form-item label="送货方签字">
              <el-input v-model="sheetFields.senderSignature" clearable />
            </el-form-item>
            <el-form-item label="收货方签字">
              <el-input v-model="sheetFields.receiverSignature" clearable />
            </el-form-item>
            <el-form-item label="送货方签字日期">
              <el-input v-model="sheetFields.senderSignDate" clearable />
            </el-form-item>
            <el-form-item label="收货方签字日期">
              <el-input v-model="sheetFields.receiverSignDate" clearable />
            </el-form-item>
          </div>
        </el-form>
      </section>

      <section class="delivery-sheet-preview">
        <div class="delivery-sheet-preview__header">
          <div>
            <h3>送货单预览</h3>
            <p>A4 竖版，预览、打印与 PDF 使用同一份模板。</p>
          </div>
          <el-tag type="success" effect="light" round>{{ detail.items.length }} 行商品</el-tag>
        </div>
        <div class="delivery-sheet-preview__body">
          <InboundDeliverySheetTemplate
            :detail="detail"
            :fields="sheetFields"
            :qr-code-data-url="qrCodeDataUrl"
          />
        </div>
      </section>
    </div>
    <el-empty v-else description="送货单详情尚未加载完成" />

    <template #footer>
      <div class="delivery-sheet-dialog-footer">
        <el-button @click="dialogVisible = false">关闭</el-button>
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
      v-if="dialogVisible && detail"
      ref="printRootRef"
      class="inbound-delivery-sheet-print-root"
      aria-hidden="true"
    >
      <InboundDeliverySheetTemplate
        :detail="detail"
        :fields="sheetFields"
        :qr-code-data-url="qrCodeDataUrl"
      />
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
  display: grid;
  grid-template-columns: minmax(300px, 360px) minmax(0, 1fr);
  gap: 14px;
  height: min(72dvh, 760px);
  min-height: 520px;
}

.delivery-sheet-editor,
.delivery-sheet-preview {
  min-height: 0;
  border: 1px solid #dbe4e1;
  border-radius: 16px;
  background: #ffffff;
}

.delivery-sheet-editor {
  overflow: auto;
  padding: 16px;
}

.delivery-sheet-editor__header h3,
.delivery-sheet-preview__header h3 {
  margin: 0;
  color: #0f172a;
  font-size: 16px;
  font-weight: 700;
}

.delivery-sheet-editor__header p,
.delivery-sheet-preview__header p {
  margin: 6px 0 0;
  color: #64748b;
  font-size: 13px;
  line-height: 1.5;
}

.delivery-sheet-editor__meta {
  display: grid;
  gap: 4px;
  margin-top: 10px;
  color: #475569;
  font-size: 12px;
}

.delivery-sheet-editor-form {
  margin-top: 14px;
}

.delivery-sheet-editor-form__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 10px;
}

.delivery-sheet-preview {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.delivery-sheet-preview__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid #e2e8f0;
  padding: 14px 16px;
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
    grid-template-columns: 1fr;
    height: min(78dvh, 820px);
    min-height: 0;
  }

  .delivery-sheet-editor-form__grid {
    grid-template-columns: 1fr;
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
