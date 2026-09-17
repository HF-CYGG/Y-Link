<script setup lang="ts">
/**
 * 模块说明：src/views/inventory/StocktakeWorkView.vue
 * 文件职责：单张盘点单的作业页：盘点中扫码计数，待确认时处理差异并确认调账，完成后只读查看结果。
 * 实现逻辑：
 * - 计数支持两种方式：“扫一次记一件”（每次扫码累加 1）与“扫码后输入数量”（扫码选中后输入实盘数回车保存）；
 * - 扫码结果进入串行队列逐个处理，连扫同一件商品逐次累计；数量框带扫码标记，扫码枪误入时不会写进数量；
 * - 盲盘单对无审核权限的账号不展示账面数与差异，数据本身由服务端裁剪，页面只按字段是否为空渲染；
 * - 待确认阶段逐行选择差异原因与处理方式（调整库存 / 报损 / 重新盘点 / 暂不处理），只提交本次改动的字段，同一行请求串行执行；
 * - 有“重新盘点”行时只能退回重盘，全部处理完成后才能确认调账。
 * 维护说明：
 * - 扫码计数失败（未识别、已退役、在其他盘点单中）必须弹出原因，避免漏盘；
 * - 差异原因为“其他”且处理方式不是“重新盘点”时必须有备注，与服务端规则一致；
 * - 范围外的行清除计数后会被服务端删除，清除后需刷新列表与进度；
 * - 确认调账不可撤销，确认文案需写清盘盈、盘亏、报损的合计影响。
 */

import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessageBox, type InputInstance } from 'element-plus'
import { CameraFilled } from '@element-plus/icons-vue'
import { PageContainer, PagePaginationBar, PassiveNumberInput, PassiveSegmentedTabs, UnifiedScanDialog } from '@/components/common'
import {
  cancelStocktake,
  completeStocktake,
  countStocktakeItem,
  getStocktakeDetail,
  getStocktakeItems,
  lookupProductByCode,
  reopenStocktake,
  resolveStocktakeItem,
  submitStocktake,
  type StocktakeItemRecord,
  type StocktakeRecord,
} from '@/api/modules/inventory'
import { useBarcodeScanInput, useSerialScanQueue } from '@/composables/useBarcodeScanInput'
import { useCameraQrScanner } from '@/composables/useCameraQrScanner'
import { useStableRequest } from '@/composables/useStableRequest'
import { STOCKTAKE_DIFF_REASON_OPTIONS, STOCKTAKE_RESOLUTION_OPTIONS, STOCKTAKE_STATUS_LABELS } from '@/constants/inventory'
import { useAuthStore } from '@/store'
import pinia from '@/store/pinia'
import { showAppError, showAppSuccess, showAppWarning } from '@/utils/app-alert'

type ItemFilter = 'all' | 'counted' | 'uncounted' | 'diff'
type ResolutionPatch = { diffReason?: string | null; resolution?: string | null; remark?: string | null }

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore(pinia)
const canCount = computed(() => authStore.hasPermission('stocktake:count'))
const canApprove = computed(() => authStore.hasPermission('stocktake:approve'))

const stocktakeId = computed(() => String(route.params.id ?? ''))
const stocktake = ref<StocktakeRecord | null>(null)
const items = ref<StocktakeItemRecord[]>([])
const loading = ref(false)
const itemLoading = ref(false)
const acting = ref(false)
const filter = ref<ItemFilter>('all')
const keyword = ref('')
const pagination = reactive({ page: 1, pageSize: 50, total: 0 })
const detailRequest = useStableRequest()
const itemsRequest = useStableRequest()

const quickMode = ref(true)
const manualCode = ref('')
const currentItem = ref<StocktakeItemRecord | null>(null)
const currentQty = ref<number | null>(null)
const qtyInputRef = ref<{ focus?: () => void; blur?: () => void } | null>(null)
const scanInputRef = ref<InputInstance | null>(null)
const submitDialogVisible = ref(false)

const isCounting = computed(() => stocktake.value?.status === 'counting')
const isReviewing = computed(() => stocktake.value?.status === 'reviewing')
const showBook = computed(() => Boolean(stocktake.value?.canViewBook))
const statusMeta = computed(() => (stocktake.value ? STOCKTAKE_STATUS_LABELS[stocktake.value.status] : null))
const uncountedCount = computed(() => (stocktake.value ? Math.max(0, stocktake.value.itemCount - stocktake.value.countedCount) : 0))
const progress = computed(() => {
  const record = stocktake.value
  if (!record || !record.itemCount) return 0
  return Math.round((record.countedCount / record.itemCount) * 100)
})

const filterTabs = computed(() => [
  { label: '全部', name: 'all' },
  { label: '已盘', name: 'counted' },
  { label: '未盘', name: 'uncounted' },
  ...(showBook.value ? [{ label: '有差异', name: 'diff' }] : []),
])

const reasonLabel = (value: string | null) => STOCKTAKE_DIFF_REASON_OPTIONS.find((item) => item.value === value)?.label ?? '—'
const resolutionLabel = (value: string | null) => STOCKTAKE_RESOLUTION_OPTIONS.find((item) => item.value === value)?.label ?? '—'
const formatTime = (value: string | null) => (value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—')
/** 与服务端规则一致：差异原因为“其他”且处理方式不是“重新盘点”时必须有备注。 */
const requiresRemark = (diffReason: string | null, resolution: string | null) => diffReason === 'other' && resolution !== 'recount'
const isRemarkMissing = (row: StocktakeItemRecord) => requiresRemark(row.diffReason, row.resolution) && !row.resolutionRemark?.trim()

/** 加载盘点单头；silent 用于计数后的进度刷新，避免整卡片闪烁。 */
const loadDetail = (silent = false) => {
  const id = stocktakeId.value
  if (!id) return Promise.resolve()
  if (!silent) loading.value = true
  return detailRequest.runLatest({
    executor: (signal) => getStocktakeDetail(id, { signal }),
    onSuccess: (record) => {
      stocktake.value = record
      if (!silent && record.status === 'reviewing' && record.canViewBook && filter.value === 'all') filter.value = 'diff'
    },
    onError: (error) => {
      showAppError(error, '盘点单加载失败')
    },
    onFinally: () => {
      loading.value = false
    },
  })
}

const loadItems = () => {
  const id = stocktakeId.value
  if (!id) return Promise.resolve()
  itemLoading.value = true
  return itemsRequest.runLatest({
    executor: (signal) => getStocktakeItems(id, {
      page: pagination.page,
      pageSize: pagination.pageSize,
      keyword: keyword.value.trim() || undefined,
      filter: filter.value,
    }, { signal }),
    onSuccess: (result) => {
      items.value = result.list
      pagination.total = result.total
    },
    onError: (error) => {
      showAppError(error, '盘点明细加载失败')
    },
    onFinally: () => {
      itemLoading.value = false
    },
  })
}

const reloadAll = async () => {
  await loadDetail()
  await loadItems()
}

const searchItems = () => {
  pagination.page = 1
  void loadItems()
}

const replaceItemRow = (item: StocktakeItemRecord) => {
  const index = items.value.findIndex((row) => row.id === item.id || row.skuId === item.skuId)
  if (index >= 0) items.value.splice(index, 1, item)
}

const saveCount = async (skuId: string, qty: number | null, mode: 'set' | 'add' | 'clear') => {
  if (!stocktake.value) return { ok: false as const, item: null }
  try {
    const item = await countStocktakeItem(stocktake.value.id, { skuId, qty, mode })
    if (item && mode !== 'clear') {
      currentItem.value = item
      replaceItemRow(item)
    }
    void loadDetail(true)
    return { ok: true as const, item: item ?? null }
  } catch (error) {
    showAppError(error, '计数保存失败')
    return { ok: false as const, item: null }
  }
}

const focusScanInput = () => {
  qtyInputRef.value?.blur?.()
  void nextTick(() => scanInputRef.value?.focus?.())
}

/** 串行处理单个扫码结果：上一个处理完才会进入下一个。 */
const processScan = async (code: string) => {
  if (!isCounting.value || !canCount.value) return
  try {
    const result = await lookupProductByCode(code, 'stocktake')
    if (quickMode.value) {
      const { item } = await saveCount(result.sku.id, 1, 'add')
      if (item && !item.inScope) showAppWarning(`「${result.product.productName}」不在本次盘点范围，已作为范围外商品加入`)
      return
    }
    const previous = currentItem.value
    if (previous && previous.skuId !== result.sku.id && currentQty.value !== null && currentQty.value !== previous.countedQty) {
      showAppWarning(`「${previous.productName}」输入的实盘数量尚未保存，已切换到新扫描的商品`)
    }
    const existing = items.value.find((row) => row.skuId === result.sku.id)
    currentItem.value = existing ?? {
      id: '',
      skuId: result.sku.id,
      skuCode: result.sku.skuCode,
      barcode: result.sku.effectiveBarcode ?? result.sku.skuCode,
      specText: result.sku.specText,
      productId: result.product.id,
      productName: result.product.productName,
      thumbnail: result.sku.thumbnail ?? result.product.thumbnail,
      locationCode: result.sku.locationCode ?? null,
      inScope: false,
      countedQty: null,
      countedByName: null,
      countedAt: null,
      bookQty: null,
      diffQty: null,
      diffReason: null,
      resolution: null,
      resolutionRemark: null,
      appliedQty: null,
    }
    currentQty.value = currentItem.value.countedQty
    await nextTick()
    qtyInputRef.value?.focus?.()
  } catch (error) {
    showAppError(error, `未识别条码 ${code}`)
  }
}

const { enqueue: enqueueScan, pending: pendingScanCount } = useSerialScanQueue(processScan)
const scanning = computed(() => pendingScanCount.value > 0)

const handleScan = (rawCode: string) => {
  const code = rawCode.trim()
  manualCode.value = ''
  if (!code || !isCounting.value || !canCount.value) return
  void enqueueScan(code)
}

const saveCurrentQty = async () => {
  const target = currentItem.value
  if (!target) return
  if (currentQty.value === null || currentQty.value < 0) {
    showAppWarning('请输入实盘数量')
    return
  }
  const { item } = await saveCount(target.skuId, currentQty.value, 'set')
  if (!item) return
  currentQty.value = item.countedQty
  showAppSuccess(`已记录「${item.productName}」实盘 ${item.countedQty}`)
  // 保存后数量框失焦，焦点回到扫码框，下一次扫码不会落进数量框。
  focusScanInput()
}

const editRowQty = async (row: StocktakeItemRecord) => {
  try {
    const { value } = await ElMessageBox.prompt(`「${row.productName} · ${row.specText}」实盘数量：`, '修改实盘数量', {
      inputValue: row.countedQty === null ? '' : String(row.countedQty),
      inputPattern: /^\d{1,6}$/,
      inputErrorMessage: '请输入 0 到 999999 的整数',
    })
    await saveCount(row.skuId, Number(value), 'set')
  } catch {
    // 用户取消
  }
}

const clearRow = async (row: StocktakeItemRecord) => {
  const tip = row.inScope ? '清除后该规格需要重新盘点。' : '该规格不在盘点范围内，清除后会从本盘点单移除。'
  try {
    await ElMessageBox.confirm(`清除「${row.productName} · ${row.specText}」的计数？${tip}`, '清除计数', { type: 'warning' })
  } catch {
    return
  }
  const { ok, item } = await saveCount(row.skuId, null, 'clear')
  if (!ok) return
  if (currentItem.value?.skuId === row.skuId) {
    currentItem.value = row.inScope && item ? item : null
    currentQty.value = currentItem.value?.countedQty ?? null
  }
  // 范围外的行会被服务端删除，统一重新拉取列表与进度。
  await loadItems()
}

useBarcodeScanInput({ onScan: handleScan, enabled: () => isCounting.value && canCount.value })

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
  formats: ['code_128', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_39', 'qr_code'],
  onDetected: (code) => {
    handleScan(code)
  },
})

const bindImageInput = (element: unknown) => {
  imageInputRef.value = element instanceof HTMLInputElement ? element : null
}

const runAction = async (action: () => Promise<StocktakeRecord>, successMessage: string) => {
  acting.value = true
  try {
    stocktake.value = await action()
    showAppSuccess(successMessage)
    pagination.page = 1
    if (stocktake.value.status !== 'reviewing' && filter.value === 'diff' && !stocktake.value.canViewBook) filter.value = 'all'
    await loadItems()
  } catch (error) {
    showAppError(error, '操作失败')
  } finally {
    acting.value = false
  }
}

const handleSubmit = async () => {
  const record = stocktake.value
  if (!record) return
  if (pendingScanCount.value > 0) {
    showAppWarning('还有条码正在处理，请稍候再提交')
    return
  }
  if (uncountedCount.value > 0) {
    // 存在未盘规格时改用自定义弹窗：“返回”在常规位置，“按 0 计并提交”作为明确的危险操作。
    submitDialogVisible.value = true
    return
  }
  try {
    await ElMessageBox.confirm('提交后不能再计数，等待审核人核对差异。确定提交？', '提交盘点', { type: 'info' })
  } catch {
    return
  }
  await runAction(() => submitStocktake(record.id, false), '已提交，等待确认差异')
}

const confirmSubmit = async (treatUncountedAsZero: boolean) => {
  const record = stocktake.value
  if (!record) return
  if (treatUncountedAsZero) {
    try {
      await ElMessageBox.confirm(
        `将把 ${uncountedCount.value} 个未盘规格的实盘数记为 0，确认调账时会按账面数全部盘亏。确定继续？`,
        '按 0 计并提交',
        { type: 'error', confirmButtonText: '按 0 计并提交', cancelButtonText: '返回', confirmButtonClass: 'el-button--danger' },
      )
    } catch {
      return
    }
  }
  submitDialogVisible.value = false
  await runAction(() => submitStocktake(record.id, treatUncountedAsZero), '已提交，等待确认差异')
}

/** 差异处理按行串行：上一个请求返回后再发下一个，避免旧数据互相覆盖。 */
const resolutionQueues = new Map<string, Promise<void>>()

const sendResolution = (row: StocktakeItemRecord, patch: ResolutionPatch) => {
  const record = stocktake.value
  if (!record || !row.id) return Promise.resolve()
  const rowId = row.id
  const previous = resolutionQueues.get(rowId) ?? Promise.resolve()
  const task = previous.then(async () => {
    try {
      const saved = await resolveStocktakeItem(record.id, rowId, patch)
      replaceItemRow(saved)
    } catch (error) {
      showAppError(error, '保存处理方式失败')
      await loadItems()
    }
  })
  resolutionQueues.set(rowId, task)
  void task.finally(() => {
    if (resolutionQueues.get(rowId) === task) resolutionQueues.delete(rowId)
  })
  return task
}

const REMARK_REQUIRED_MESSAGE = '差异原因为“其他”时备注不能为空'

const promptRequiredRemark = async (row: StocktakeItemRecord) => {
  try {
    const { value } = await ElMessageBox.prompt(
      `「${row.productName} · ${row.specText}」差异原因为“其他”，请先填写备注说明：`,
      '请填写差异备注',
      {
        inputValue: row.resolutionRemark ?? '',
        inputValidator: (text) => Boolean(text?.trim()) || REMARK_REQUIRED_MESSAGE,
        confirmButtonText: '保存',
      },
    )
    return value.trim()
  } catch {
    return null
  }
}

const handleDiffReasonChange = async (row: StocktakeItemRecord, value: string) => {
  const diffReason = value || null
  if (requiresRemark(diffReason, row.resolution) && !row.resolutionRemark?.trim()) {
    const remark = await promptRequiredRemark(row)
    if (remark === null) return
    await sendResolution(row, { diffReason, remark })
    return
  }
  await sendResolution(row, { diffReason })
}

const handleResolutionChange = async (row: StocktakeItemRecord, value: string) => {
  const resolution = value || null
  if (requiresRemark(row.diffReason, resolution) && !row.resolutionRemark?.trim()) {
    const remark = await promptRequiredRemark(row)
    if (remark === null) return
    await sendResolution(row, { resolution, remark })
    return
  }
  await sendResolution(row, { resolution })
}

const editResolutionRemark = async (row: StocktakeItemRecord) => {
  const required = requiresRemark(row.diffReason, row.resolution)
  try {
    const { value } = await ElMessageBox.prompt(required ? '处理备注（差异原因为“其他”时必填）：' : '处理备注：', '差异备注', {
      inputValue: row.resolutionRemark ?? '',
      inputValidator: required ? (text) => Boolean(text?.trim()) || REMARK_REQUIRED_MESSAGE : undefined,
    })
    const remark = value?.trim() || null
    if (remark === (row.resolutionRemark ?? null)) return
    await sendResolution(row, { remark })
  } catch {
    // 用户取消
  }
}

const handleComplete = async () => {
  const record = stocktake.value
  if (!record) return
  if (resolutionQueues.size) {
    showAppWarning('差异处理仍在保存中，请稍候再确认')
    return
  }
  try {
    await ElMessageBox.confirm(
      `确认后将按差异生成盘盈、盘亏或报损流水并立即校准库存（当前共 ${record.diffCount ?? 0} 个差异规格），此操作不可撤销。`,
      '确认调账',
      { type: 'warning', confirmButtonText: '确认调账' },
    )
  } catch {
    return
  }
  await runAction(() => completeStocktake(record.id), '盘点已完成，库存已校准')
}

const handleReopen = async () => {
  const record = stocktake.value
  if (!record) return
  try {
    await ElMessageBox.confirm('退回后单据回到“盘点中”，标记为“重新盘点”的规格计数会被清空。', '退回重新盘点', { type: 'warning' })
  } catch {
    return
  }
  filter.value = 'uncounted'
  await runAction(() => reopenStocktake(record.id), '已退回，请重新盘点')
}

const handleCancel = async () => {
  const record = stocktake.value
  if (!record) return
  try {
    await ElMessageBox.confirm('取消后该盘点单作废，不会调整任何库存。', '取消盘点单', { type: 'warning' })
  } catch {
    return
  }
  await runAction(() => cancelStocktake(record.id), '盘点单已取消')
}

watch(filter, searchItems)
watch(stocktakeId, (id, previous) => {
  if (id && id !== previous) {
    filter.value = 'all'
    currentItem.value = null
    currentQty.value = null
    void reloadAll()
  }
})

onMounted(reloadAll)
</script>

<template>
  <PageContainer :title="stocktake ? `盘点单 ${stocktake.stocktakeNo}` : '盘点作业'" :description="stocktake?.scopeLabel">
    <div class="mb-3">
      <el-button link @click="router.push('/inventory/stocktakes')">← 返回盘点单列表</el-button>
    </div>

    <el-card v-if="stocktake" v-loading="loading" shadow="never" class="mb-4">
      <div class="flex flex-wrap items-center gap-4">
        <el-tag v-if="statusMeta" :type="statusMeta.type">{{ statusMeta.label }}</el-tag>
        <el-tag effect="plain">{{ stocktake.blindMode ? '盲盘' : '明盘' }}</el-tag>
        <div class="min-w-48 flex-1">
          <el-progress :percentage="progress">
            <span class="text-xs">已盘 {{ stocktake.countedCount }} / {{ stocktake.itemCount }}</span>
          </el-progress>
        </div>
        <span v-if="stocktake.diffCount !== null" class="text-sm">差异 {{ stocktake.diffCount }} 个</span>
        <div class="ml-auto flex flex-wrap gap-2">
          <el-button v-if="isCounting && canCount" type="primary" :loading="acting" @click="handleSubmit">提交盘点</el-button>
          <template v-if="isReviewing && canApprove">
            <el-button :loading="acting" @click="handleReopen">退回重新盘点</el-button>
            <el-button type="primary" :loading="acting" @click="handleComplete">确认调账</el-button>
          </template>
          <el-button v-if="(isCounting || isReviewing) && canApprove" type="danger" plain :loading="acting" @click="handleCancel">取消盘点单</el-button>
        </div>
      </div>
      <div class="mt-2 text-xs text-slate-500">
        创建：{{ stocktake.createdByName || '—' }} {{ formatTime(stocktake.createdAt) }}
        <span v-if="stocktake.submittedAt"> · 提交：{{ formatTime(stocktake.submittedAt) }}</span>
        <span v-if="stocktake.completedAt"> · 完成：{{ stocktake.completedByName }} {{ formatTime(stocktake.completedAt) }}</span>
        <span v-if="stocktake.remark"> · 备注：{{ stocktake.remark }}</span>
      </div>
      <el-alert
        v-if="isReviewing && !canApprove"
        class="mt-3"
        type="info"
        :closable="false"
        show-icon
        title="盘点结果已提交，等待有审核权限的同事核对差异并确认调账。"
      />
    </el-card>

    <el-card v-if="isCounting && canCount" shadow="never" class="mb-4">
      <div class="flex flex-wrap items-center gap-3">
        <el-switch v-model="quickMode" active-text="扫一次记一件" inactive-text="扫码后输入数量" />
        <div class="flex min-w-0 flex-1 gap-2">
          <el-input
            ref="scanInputRef"
            v-model="manualCode"
            size="large"
            placeholder="扫码枪直接扫描，或输入条码 / SKU 编码后回车"
            clearable
            class="min-w-0 flex-1"
            data-barcode-scan-input
          />
          <el-tooltip :content="scanButtonTitle" placement="top">
            <el-button size="large" :loading="scanLoading || scanning" @click="openScanDialog">
              <el-icon :size="18"><CameraFilled /></el-icon>
            </el-button>
          </el-tooltip>
        </div>
      </div>
      <div v-if="currentItem" class="mt-4 flex flex-wrap items-center gap-4 rounded-xl bg-slate-50 p-3 dark:bg-white/5">
        <div class="min-w-0 flex-1">
          <div class="text-lg font-semibold">{{ currentItem.productName }}</div>
          <div class="text-sm text-slate-500">
            {{ currentItem.specText }} · {{ currentItem.skuCode }}<span v-if="currentItem.locationCode"> · 库位 {{ currentItem.locationCode }}</span>
          </div>
          <div v-if="currentItem.bookQty !== null" class="text-xs text-slate-500">账面 {{ currentItem.bookQty }}</div>
        </div>
        <template v-if="quickMode">
          <div class="text-right">
            <div class="text-xs text-slate-500">已计数</div>
            <div class="text-3xl font-bold tabular-nums">{{ currentItem.countedQty ?? 0 }}</div>
          </div>
        </template>
        <template v-else>
          <span class="text-sm">实盘数量</span>
          <PassiveNumberInput
            ref="qtyInputRef"
            v-model="currentQty"
            :min="0"
            :max="999999"
            :precision="0"
            class="w-40"
            data-barcode-scan-qty
            @keyup.enter="saveCurrentQty"
          />
          <el-button type="primary" @click="saveCurrentQty">保存</el-button>
        </template>
      </div>
    </el-card>

    <el-card shadow="never">
      <div class="mb-3 flex flex-wrap items-center gap-3">
        <PassiveSegmentedTabs v-model="filter" :tabs="filterTabs" aria-label="明细筛选" />
        <el-input v-model="keyword" placeholder="商品 / SKU / 条码 / 规格" clearable class="w-56" @keyup.enter="searchItems" />
        <el-button @click="searchItems">查询</el-button>
      </div>
      <el-table v-loading="itemLoading" :data="items" row-key="id" empty-text="没有符合条件的明细">
        <el-table-column label="商品 / 规格" min-width="200">
          <template #default="{ row }">
            <div class="font-medium">
              {{ row.productName }}
              <el-tag v-if="!row.inScope" size="small" type="warning" class="ml-1">范围外</el-tag>
            </div>
            <div class="text-xs text-slate-500">{{ row.specText }} · {{ row.skuCode }}</div>
          </template>
        </el-table-column>
        <el-table-column label="库位" width="100">
          <template #default="{ row }">{{ row.locationCode || '—' }}</template>
        </el-table-column>
        <el-table-column v-if="showBook" label="账面" width="80" align="right">
          <template #default="{ row }">{{ row.bookQty ?? '—' }}</template>
        </el-table-column>
        <el-table-column label="实盘" width="90" align="right">
          <template #default="{ row }">
            <span v-if="row.countedQty === null" class="text-slate-400">未盘</span>
            <span v-else class="font-semibold tabular-nums">{{ row.countedQty }}</span>
          </template>
        </el-table-column>
        <el-table-column v-if="showBook" label="差异" width="80" align="right">
          <template #default="{ row }">
            <span v-if="row.diffQty === null">—</span>
            <span v-else class="font-semibold tabular-nums" :class="row.diffQty > 0 ? 'text-emerald-600' : row.diffQty < 0 ? 'text-red-600' : ''">
              {{ row.diffQty > 0 ? '+' : '' }}{{ row.diffQty }}
            </span>
          </template>
        </el-table-column>
        <el-table-column v-if="showBook && !isCounting" label="差异原因" width="150">
          <template #default="{ row }">
            <el-select
              v-if="isReviewing && canApprove && row.diffQty"
              :model-value="row.diffReason ?? ''"
              placeholder="选择原因"
              size="small"
              clearable
              @change="(value: string) => handleDiffReasonChange(row, value)"
            >
              <el-option v-for="item in STOCKTAKE_DIFF_REASON_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
            <span v-else>{{ reasonLabel(row.diffReason) }}</span>
          </template>
        </el-table-column>
        <el-table-column v-if="showBook && !isCounting" label="处理方式" width="150">
          <template #default="{ row }">
            <el-select
              v-if="isReviewing && canApprove && row.diffQty"
              :model-value="row.resolution ?? ''"
              placeholder="选择处理"
              size="small"
              clearable
              @change="(value: string) => handleResolutionChange(row, value)"
            >
              <el-option
                v-for="item in STOCKTAKE_RESOLUTION_OPTIONS"
                :key="item.value"
                :label="item.label"
                :value="item.value"
                :disabled="item.value === 'damage' && row.diffQty > 0"
              />
            </el-select>
            <span v-else>
              {{ resolutionLabel(row.resolution) }}
              <span v-if="row.appliedQty !== null" class="text-xs text-slate-500">（已调 {{ row.appliedQty }}）</span>
            </span>
          </template>
        </el-table-column>
        <el-table-column v-if="showBook && !isCounting" label="备注" min-width="140">
          <template #default="{ row }">
            <template v-if="isReviewing && canApprove && row.diffQty">
              <el-button link :type="isRemarkMissing(row) ? 'danger' : 'primary'" @click="editResolutionRemark(row)">
                {{ row.resolutionRemark || (isRemarkMissing(row) ? '请先填写备注' : '添加备注') }}
              </el-button>
              <div v-if="isRemarkMissing(row)" class="text-xs text-red-600">原因为“其他”时必须填写备注</div>
            </template>
            <span v-else>{{ row.resolutionRemark || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="计数人" width="150">
          <template #default="{ row }">
            <div>{{ row.countedByName || '—' }}</div>
            <div v-if="row.countedAt" class="text-xs text-slate-500">{{ formatTime(row.countedAt) }}</div>
          </template>
        </el-table-column>
        <el-table-column v-if="isCounting && canCount" label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="editRowQty(row)">{{ row.countedQty === null ? '录入' : '修改' }}</el-button>
            <el-button v-if="row.countedQty !== null" link type="danger" @click="clearRow(row)">清除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <PagePaginationBar
        v-model:current-page="pagination.page"
        v-model:page-size="pagination.pageSize"
        :total="pagination.total"
        layout="total, prev, pager, next"
        class="mt-4"
        @current-change="loadItems"
      />
    </el-card>

    <el-dialog v-model="submitDialogVisible" title="存在未盘规格" width="min(92vw, 480px)" append-to-body align-center>
      <p class="leading-6">还有 <strong>{{ uncountedCount }}</strong> 个规格未盘点，请选择提交方式：</p>
      <ul class="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-600 dark:text-slate-300">
        <li>仅提交已盘：未盘规格不参与调账（推荐）。</li>
        <li>按 0 计并提交：未盘规格视为实盘 0，确认调账时会全部盘亏。</li>
      </ul>
      <template #footer>
        <div class="flex flex-wrap items-center gap-2">
          <el-button type="danger" plain :loading="acting" @click="confirmSubmit(true)">按 0 计并提交</el-button>
          <div class="ml-auto flex gap-2">
            <el-button @click="submitDialogVisible = false">返回</el-button>
            <el-button type="primary" :loading="acting" @click="confirmSubmit(false)">仅提交已盘</el-button>
          </div>
        </div>
      </template>
    </el-dialog>

    <input :ref="bindImageInput" type="file" accept="image/*" capture="environment" class="hidden" @change="handleImageInputChange" />
    <UnifiedScanDialog
      v-model="scanDialogVisible"
      title="盘点扫码"
      mode-label="库存盘点"
      :loading="scanLoading"
      :status-text="scanStatusText"
      hint-text="请将商品条码置于取景框中央，识别成功后会自动计数。"
      :bind-scanner-container="bindScannerContainer"
      @closed="closeScanDialog"
    />
  </PageContainer>
</template>
