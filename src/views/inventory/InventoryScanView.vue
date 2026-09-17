<script setup lang="ts">
/**
 * 模块说明：src/views/inventory/InventoryScanView.vue
 * 文件职责：扫码作业台，完成采购入库、其他出库、退货入库、报损出库与库存调整，提交后生成库存单据与流水。
 * 实现逻辑：
 * - 扫码枪（键盘模式）无需聚焦也能识别；手动输入框回车、摄像头扫码三种方式共用同一识别入口，并进入串行队列逐个处理；
 * - 同一规格重复扫码时数量 +1（连扫逐次累计），每行实时展示“当前库存 → 变动 → 结果”预览，出库超出库存时标红；
 * - 确认弹窗打开或提交过程中暂停接收扫码，避免提交内容与确认文案不一致；
 * - 每张草稿持有一个幂等键：提交成功或收到 4xx 响应后换新键；网络错误、超时、5xx 保留原键，便于安全重试。
 * 维护说明：
 * - 预览里的“当前库存”是扫码时读到的值，最终以服务端记账结果为准，提交结果区展示真实前后库存；
 * - 销售出库仍在“出库开单”完成，这里不提供销售类型，避免两处出库口径分叉；
 * - 识别失败要明确提示条码内容，不能静默忽略，否则店员会误以为已扫入。
 */

import { computed, onActivated, onDeactivated, reactive, ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import { CameraFilled } from '@element-plus/icons-vue'
import { PageContainer, PassiveNumberInput, UnifiedScanDialog } from '@/components/common'
import { createStockDoc, lookupProductByCode, type StockDocRecord } from '@/api/modules/inventory'
import { useBarcodeScanInput, useSerialScanQueue } from '@/composables/useBarcodeScanInput'
import { useCameraQrScanner } from '@/composables/useCameraQrScanner'
import { STOCK_DOC_TYPE_OPTIONS, type StockDocType } from '@/constants/inventory'
import { showAppError, showAppSuccess, showAppWarning } from '@/utils/app-alert'
import { normalizeRequestError } from '@/utils/error'

interface DraftLine {
  skuId: string
  skuCode: string
  barcode: string
  productName: string
  specText: string
  locationCode: string | null
  currentStock: number
  availableStock: number
  qty: number | null
}

const CAMERA_FORMATS = ['code_128', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_39', 'qr_code']

const newRequestId = () => globalThis.crypto?.randomUUID?.() ?? `kd-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`

const docType = ref<StockDocType>('purchase_in')
const reasonCode = ref('')
const remark = ref('')
const lines = ref<DraftLine[]>([])
const manualCode = ref('')
const submitting = ref(false)
/** 确认弹窗打开期间同样暂停扫码。 */
const confirming = ref(false)
const pageActive = ref(true)
const lastResult = ref<StockDocRecord | null>(null)
const draft = reactive({ requestId: newRequestId() })

const typeOption = computed(() => STOCK_DOC_TYPE_OPTIONS.find((item) => item.value === docType.value) ?? STOCK_DOC_TYPE_OPTIONS[0])
const isAdjust = computed(() => typeOption.value.direction === 0)
const totalQty = computed(() => lines.value.reduce((sum, line) => sum + Math.abs(line.qty ?? 0), 0))

const signedDelta = (line: DraftLine) => {
  const qty = line.qty ?? 0
  return typeOption.value.direction === 0 ? qty : typeOption.value.direction * qty
}
const resultStock = (line: DraftLine) => line.currentStock + signedDelta(line)
const isShortage = (line: DraftLine) => signedDelta(line) < 0 && line.availableStock + signedDelta(line) < 0

const handleTypeChange = () => {
  reasonCode.value = ''
  lines.value = lines.value.map((line) => ({ ...line, qty: Math.abs(line.qty ?? 1) || 1 }))
}

const processCode = async (code: string) => {
  try {
    const result = await lookupProductByCode(code)
    if (!result.sku.isCurrent) {
      showAppWarning(`条码 ${code} 对应的规格已退役，不能再做库存操作`)
      return
    }
    const existing = lines.value.find((line) => line.skuId === result.sku.id)
    if (existing) {
      existing.qty = (existing.qty ?? 0) + (existing.qty !== null && existing.qty < 0 ? -1 : 1)
      lines.value = [existing, ...lines.value.filter((line) => line !== existing)]
    } else {
      lines.value = [{
        skuId: result.sku.id,
        skuCode: result.sku.skuCode,
        barcode: result.sku.effectiveBarcode ?? result.sku.skuCode,
        productName: result.product.productName,
        specText: result.sku.specText,
        locationCode: result.sku.locationCode ?? null,
        currentStock: result.sku.currentStock,
        availableStock: result.sku.availableStock,
        qty: 1,
      }, ...lines.value]
    }
    if (!result.sku.isActive || !result.product.isActive) {
      showAppWarning(`「${result.product.productName}」当前为停用状态，库存变动不会计入商品汇总`)
    }
  } catch (error) {
    showAppError(error, `未识别条码 ${code}`)
  }
}

const { enqueue: enqueueCode, pending: pendingScanCount } = useSerialScanQueue(processCode)
const lookupLoading = computed(() => pendingScanCount.value > 0)

const addByCode = (rawCode: string) => {
  const code = rawCode.trim()
  manualCode.value = ''
  if (!code) return
  if (confirming.value || submitting.value) {
    showAppWarning(`请先完成当前提交，条码 ${code} 未加入清单`)
    return
  }
  void enqueueCode(code)
}

useBarcodeScanInput({ onScan: addByCode, enabled: () => pageActive.value })
onActivated(() => { pageActive.value = true })
onDeactivated(() => { pageActive.value = false })

const {
  bindScannerContainer,
  imageInputRef,
  scanButtonTitle,
  scanDialogVisible,
  scanLoading,
  scanStatusText,
  closeScanDialog,
  handleImageInputChange,
  openScanDialog,
} = useCameraQrScanner({
  normalizeCode: (rawValue) => rawValue.trim(),
  formats: CAMERA_FORMATS,
  onDetected: (code) => {
    addByCode(code)
  },
})

const bindImageInput = (element: unknown) => {
  imageInputRef.value = element instanceof HTMLInputElement ? element : null
}

const removeLine = (skuId: string) => {
  lines.value = lines.value.filter((line) => line.skuId !== skuId)
}

const clearDraft = async () => {
  if (!lines.value.length) return
  try {
    await ElMessageBox.confirm('确定清空当前已扫描的商品吗？', '清空草稿', { type: 'warning' })
    lines.value = []
  } catch {
    // 用户取消
  }
}

const validateDraft = () => {
  if (!lines.value.length) return '请先扫描商品'
  const invalid = lines.value.find((line) => !line.qty || (!isAdjust.value && line.qty < 0))
  if (invalid) return `「${invalid.productName}」的数量${isAdjust.value ? '不能为 0' : '必须大于 0'}`
  if (typeOption.value.reasonRequired && !reasonCode.value) return `请选择${typeOption.value.label}原因`
  if (reasonCode.value === 'other' && !remark.value.trim()) return '原因为“其他”时请填写备注'
  const shortage = lines.value.find(isShortage)
  if (shortage) return `「${shortage.productName} ${shortage.specText}」可用库存只有 ${shortage.availableStock}，不足以出库`
  return ''
}

/** 提交明细：按扫码先后排序，同一规格只占一行（理论上已合并，这里兜底再合并一次）。 */
const buildSubmitItems = () => {
  const merged = new Map<string, number>()
  for (const line of [...lines.value].reverse()) {
    merged.set(line.skuId, (merged.get(line.skuId) ?? 0) + (line.qty ?? 0))
  }
  return [...merged.entries()].map(([skuId, qty]) => ({ skuId, qty }))
}

const handleSubmit = async () => {
  if (submitting.value || confirming.value) return
  if (pendingScanCount.value > 0) {
    showAppWarning('还有条码正在识别，请稍候再提交')
    return
  }
  const message = validateDraft()
  if (message) {
    showAppWarning(message)
    return
  }
  confirming.value = true
  try {
    await ElMessageBox.confirm(
      `${typeOption.value.label}：共 ${lines.value.length} 个规格、合计 ${totalQty.value} 件，提交后立即变更库存。`,
      '确认提交',
      { type: 'warning', confirmButtonText: '提交' },
    )
  } catch {
    return
  } finally {
    confirming.value = false
  }
  submitting.value = true
  try {
    const items = buildSubmitItems()
    if (items.some((item) => !item.qty)) {
      showAppWarning('同一规格合并后数量为 0，请检查清单')
      return
    }
    const doc = await createStockDoc({
      docType: docType.value,
      clientRequestId: draft.requestId,
      reasonCode: reasonCode.value || null,
      remark: remark.value.trim() || null,
      items,
    })
    lastResult.value = doc
    lines.value = []
    remark.value = ''
    draft.requestId = newRequestId()
    showAppSuccess(`已生成单据 ${doc.docNo}`)
  } catch (error) {
    // 4xx 表示服务端已明确拒绝（含幂等冲突，提示里带原单号），换新键；网络错误、超时、5xx 保留原键以便安全重试。
    const status = normalizeRequestError(error).status
    if (status !== undefined && status >= 400 && status < 500) draft.requestId = newRequestId()
    showAppError(error, '提交失败，库存未变更')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <PageContainer title="扫码作业" description="扫码枪直接扫描即可加入清单；也可手动输入条码或用手机摄像头扫码。">
    <div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <section class="min-w-0 space-y-4">
        <el-card shadow="never">
          <div class="flex flex-wrap items-center gap-3">
            <el-radio-group v-model="docType" @change="handleTypeChange">
              <el-radio-button v-for="option in STOCK_DOC_TYPE_OPTIONS" :key="option.value" :value="option.value">
                {{ option.label }}
              </el-radio-button>
            </el-radio-group>
          </div>
          <div class="mt-3 flex flex-wrap gap-3">
            <el-select
              v-if="typeOption.reasons.length"
              v-model="reasonCode"
              :placeholder="typeOption.reasonRequired ? '选择原因（必选）' : '选择原因（可选）'"
              clearable
              class="w-48"
            >
              <el-option v-for="reason in typeOption.reasons" :key="reason.value" :label="reason.label" :value="reason.value" />
            </el-select>
            <el-input v-model="remark" maxlength="255" placeholder="备注（可选）" class="min-w-0 flex-1" clearable />
          </div>
          <div class="mt-3 flex gap-2">
            <el-input
              v-model="manualCode"
              size="large"
              placeholder="扫码枪直接扫描，或在此输入条码 / SKU 编码后回车"
              clearable
              class="min-w-0 flex-1"
              data-barcode-scan-input
            />
            <el-tooltip :content="scanButtonTitle" placement="top">
              <el-button size="large" :loading="scanLoading" @click="openScanDialog">
                <el-icon :size="18"><CameraFilled /></el-icon>
              </el-button>
            </el-tooltip>
            <el-button size="large" type="primary" :loading="lookupLoading" @click="addByCode(manualCode)">加入</el-button>
          </div>
        </el-card>

        <el-card shadow="never">
          <template #header>
            <div class="flex items-center justify-between">
              <span class="font-semibold">待提交清单（{{ lines.length }} 个规格，合计 {{ totalQty }} 件）</span>
              <el-button link type="danger" :disabled="!lines.length" @click="clearDraft">清空</el-button>
            </div>
          </template>
          <el-empty v-if="!lines.length" description="扫描商品条码后会出现在这里" :image-size="120" />
          <div v-else class="space-y-3">
            <div
              v-for="line in lines"
              :key="line.skuId"
              class="flex flex-wrap items-center gap-3 rounded-xl border px-3 py-2"
              :class="isShortage(line) ? 'border-red-300 bg-red-50 dark:border-red-500/40 dark:bg-red-500/10' : 'border-slate-200 dark:border-white/10'"
            >
              <div class="min-w-0 flex-1">
                <div class="truncate font-medium">{{ line.productName }}</div>
                <div class="text-xs text-slate-500">
                  {{ line.specText }} · {{ line.skuCode }}<span v-if="line.locationCode"> · 库位 {{ line.locationCode }}</span>
                </div>
              </div>
              <div class="text-sm tabular-nums text-slate-600 dark:text-slate-300">
                库存 {{ line.currentStock }}
                <span :class="signedDelta(line) >= 0 ? 'text-emerald-600' : 'text-red-600'">
                  {{ signedDelta(line) >= 0 ? '+' : '' }}{{ signedDelta(line) }}
                </span>
                → <strong>{{ resultStock(line) }}</strong>
              </div>
              <PassiveNumberInput
                v-model="line.qty"
                :min="isAdjust ? -999999 : 1"
                :max="999999"
                :precision="0"
                class="w-32"
                size="small"
                data-barcode-scan-qty
              />
              <el-button link type="danger" @click="removeLine(line.skuId)">移除</el-button>
            </div>
            <el-alert
              v-if="isAdjust"
              type="info"
              :closable="false"
              show-icon
              title="库存调整的数量可正可负：正数增加库存，负数减少库存。"
            />
          </div>
          <div class="mt-4 flex justify-end">
            <el-button type="primary" size="large" :loading="submitting" :disabled="!lines.length" @click="handleSubmit">
              提交{{ typeOption.label }}
            </el-button>
          </div>
        </el-card>
      </section>

      <aside class="min-w-0">
        <el-card shadow="never">
          <template #header><span class="font-semibold">最近提交</span></template>
          <el-empty v-if="!lastResult" description="提交后在这里查看记账结果" :image-size="80" />
          <div v-else class="space-y-2 text-sm">
            <div class="flex items-center justify-between">
              <span class="font-semibold">{{ lastResult.docNo }}</span>
              <el-tag size="small">{{ lastResult.docTypeLabel }}</el-tag>
            </div>
            <div class="text-xs text-slate-500">{{ lastResult.reasonLabel || '' }} {{ lastResult.remark || '' }}</div>
            <div v-for="item in lastResult.items" :key="item.id" class="rounded-lg bg-slate-50 px-2 py-1 dark:bg-white/5">
              <div class="truncate">{{ item.productName }} · {{ item.specText }}</div>
              <div class="tabular-nums text-xs text-slate-500">
                {{ item.beforeSkuStock }} → {{ item.qty >= 0 ? '+' : '' }}{{ item.qty }} → <strong>{{ item.afterSkuStock }}</strong>
              </div>
            </div>
          </div>
        </el-card>
      </aside>
    </div>

    <input :ref="bindImageInput" type="file" accept="image/*" capture="environment" class="hidden" @change="handleImageInputChange" />
    <UnifiedScanDialog
      v-model="scanDialogVisible"
      title="商品条码识别"
      mode-label="库存作业"
      :loading="scanLoading"
      :status-text="scanStatusText"
      hint-text="请将商品条码置于取景框中央，识别成功后会自动加入清单。"
      :bind-scanner-container="bindScannerContainer"
      @closed="closeScanDialog"
    />
  </PageContainer>
</template>
