<script setup lang="ts">
/**
 * 模块说明：出库开单专用扫码面板。
 * 文件职责：按 HID 键盘节奏或专用输入框回车识别条码，串行查询并把识别结果交给开单草稿。
 * 实现逻辑：扫码从数字框触发时先转移焦点，使数字组件完成旧值提交，再由草稿累加数量；成功时只保留最新的非模态提示，离开页面使旧扫码与提示失效。
 * 维护说明：不在此组件提交订单、修改库存或绕过父层的当前商品/SKU 候选校验。
 */
import { onActivated, onBeforeUnmount, onDeactivated, ref, watch } from 'vue'
import { ElNotification, type InputInstance, type NotificationHandle } from 'element-plus'
import { lookupProductByCode } from '@/api/modules/inventory'
import { useBarcodeScanInput, useSerialScanQueue } from '@/composables/useBarcodeScanInput'
import { showAppError, showAppWarning } from '@/utils/app-alert'
import { extractErrorMessage } from '@/utils/error'
import type { ProductRecord } from '@/api/modules/product'
import type { OrderItemRow } from '../types'
import { addScannedSkuToOrderRows } from '../scan-order-entry'
import { watchScanUserScope } from '../scan-user-scope'

const props = defineProps<{
  pauseReason: string | null
  userId: string | undefined
  getContext: () => { rows: OrderItemRow[]; products: ProductRecord[] }
  commitRows: (rows: OrderItemRow[], expectedUserId: string | undefined, isCurrent: () => boolean) => string | null
}>()
const emit = defineEmits<{ pendingChange: [count: number] }>()

const manualCode = ref('')
const scanStatus = ref('')
const scanInputRef = ref<InputInstance>()
const pageActive = ref(true)
let pageEpoch = 0
let ticketSequence = 0
let successNotification: NotificationHandle | null = null
const tickets = new Map<string, { code: string; epoch: number; userId: string | undefined }>()

const closeSuccessNotification = (): void => {
  successNotification?.close()
  successNotification = null
}

const showScanSuccess = (productName: string, specText: string, skuCode: string, qty: number): void => {
  closeSuccessNotification()
  const notification = ElNotification({
    title: `已添加：${productName}`,
    message: `规格：${specText || '默认规格'} · SKU：${skuCode} · 当前行数量：${qty}`,
    type: 'success',
    position: 'top-right',
    duration: 4000,
    showClose: true,
    onClose: () => { if (successNotification === notification) successNotification = null },
  })
  successNotification = notification
}

const processTicket = async (ticketId: string): Promise<void> => {
  const ticket = tickets.get(ticketId)
  tickets.delete(ticketId)
  if (!ticket || !pageActive.value || ticket.epoch !== pageEpoch || ticket.userId !== props.userId) return
  closeSuccessNotification()
  if (props.pauseReason) {
    scanStatus.value = `${props.pauseReason}，条码 ${ticket.code} 未加入明细`
    showAppWarning(scanStatus.value)
    return
  }
  try {
    const lookup = await lookupProductByCode(ticket.code)
    if (!pageActive.value || ticket.epoch !== pageEpoch || ticket.userId !== props.userId) return
    if (props.pauseReason) {
      scanStatus.value = `${props.pauseReason}，条码 ${ticket.code} 未加入明细`
      showAppWarning(scanStatus.value)
      return
    }
    const { rows, products } = props.getContext()
    const result = addScannedSkuToOrderRows(
      rows,
      products,
      lookup,
      () => `row-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    )
    const error = result.rows
      ? props.commitRows(
          result.rows,
          ticket.userId,
          () => pageActive.value && ticket.epoch === pageEpoch && ticket.userId === props.userId,
        )
      : result.error ?? '扫码入单失败'
    if (error) {
      scanStatus.value = error
      showAppWarning(error)
      return
    }
    if (!pageActive.value || ticket.epoch !== pageEpoch || ticket.userId !== props.userId) return
    scanStatus.value = `已加入“${result.productName}”，该行数量 ${result.qty}`
    showScanSuccess(result.productName ?? lookup.product.productName, lookup.sku.specText, lookup.sku.skuCode || lookup.sku.id, result.qty ?? 1)
  } catch (error) {
    if (!pageActive.value || ticket.epoch !== pageEpoch) return
    scanStatus.value = extractErrorMessage(error, `未识别条码 ${ticket.code}`)
    showAppError(error, `未识别条码 ${ticket.code}`)
  }
}

const { enqueue, pending } = useSerialScanQueue(processTicket)
watch(pending, (count) => emit('pendingChange', count), { flush: 'sync' })
watchScanUserScope(() => props.userId, {
  manualCode,
  scanStatus,
  tickets,
  invalidate: () => { pageEpoch += 1; closeSuccessNotification() },
})

const addByCode = (rawCode: string): void => {
  const code = rawCode.trim()
  manualCode.value = ''
  if (!code || !pageActive.value) return
  closeSuccessNotification()
  if (props.pauseReason) {
    scanStatus.value = `${props.pauseReason}，条码 ${code} 未加入明细`
    showAppWarning(scanStatus.value)
    return
  }
  // 共享数字框聚焦时不会同步外部 modelValue；先 blur 提交恢复后的旧值，再让扫码队列累加。
  const active = document.activeElement
  if (active instanceof HTMLInputElement && active.closest('[data-barcode-scan-qty]')) {
    scanInputRef.value?.focus()
  }
  const ticketId = `scan-${++ticketSequence}`
  tickets.set(ticketId, { code, epoch: pageEpoch, userId: props.userId })
  void enqueue(ticketId)
}

useBarcodeScanInput({ onScan: addByCode, enabled: () => pageActive.value })
onActivated(() => { pageActive.value = true })
onDeactivated(() => { pageActive.value = false; pageEpoch += 1; tickets.clear(); closeSuccessNotification() })
onBeforeUnmount(() => { pageActive.value = false; pageEpoch += 1; tickets.clear(); closeSuccessNotification(); emit('pendingChange', 0) })
</script>

<template>
  <section class="apple-card p-3 sm:p-4" aria-label="条码快速入单">
    <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
      <strong class="text-sm text-slate-800">扫码添加商品</strong>
      <span v-if="pending" class="text-xs text-slate-500">正在识别 {{ pending }} 个条码</span>
    </div>
    <el-input
      ref="scanInputRef"
      v-model="manualCode"
      data-barcode-scan-input
      clearable
      placeholder="扫码枪扫码，或手动输入条码后按 Enter"
      aria-label="手动输入商品条码"
      :disabled="Boolean(pauseReason)"
    />
    <p class="mt-2 text-xs text-slate-500" aria-live="polite">
      {{ scanStatus || '支持原厂条码、SKU 编码和历史旧码；识别结果加入下方明细。' }}
    </p>
  </section>
</template>
