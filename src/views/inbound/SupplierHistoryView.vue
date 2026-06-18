<script setup lang="ts">
/**
 * 模块说明：src/views/inbound/SupplierHistoryView.vue
 * 文件职责：展示供货方历史送货单列表，并支持服务端筛选分页、详情查看、改单撤销与删除恢复等状态操作。
 * 实现逻辑：
 * - 页面采用“统计卡 + 筛选工具栏 + 列表容器 + 详情抽屉”的工作台布局，与录入页形成统一视觉语言；
 * - 历史页使用服务端筛选与分页，并通过自动同步保持库管入库、供货方删除恢复后的列表状态及时更新；
 * - 列表请求、详情请求与操作前状态校验都接入稳定请求或最新详情读取，避免旧结果覆盖新状态；
 * - 详情抽屉在打开期间进行轻量刷新，状态变化后立即收起不可用操作入口，降低误改单、误撤销风险。
 * 维护说明：
 * - 若后续要增加更多筛选维度，优先继续扩展服务端查询参数，而不是回退到前端全量筛选；
 * - 二维码生成失败时不能静默吞掉，否则用户只会看到空白占位而不知道单据本身已存在；
 * - 自动同步必须避开弹窗确认与表单编辑过程，避免覆盖用户正在输入的内容。
 */

import { computed, onActivated, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'

import { ElMessageBox } from 'element-plus'
import QRCode from 'qrcode'
import { useRoute, useRouter } from 'vue-router'
import { BizResponsiveDrawerShell, PageContainer, PagePaginationBar, PassiveNumberInput } from '@/components/common'
import {
  cancelSupplierDelivery,
  deleteSupplierDelivery,
  getSupplierDeliveries,
  getInboundDetail,
  permanentlyDeleteSupplierDelivery,
  restoreSupplierDelivery,
  updateSupplierDelivery,
  type InboundOrder,
  type InboundOrderDetail,
  type SupplierDeliverySummary,
} from '@/api/modules/inbound'
import { getProductList, type ProductRecord } from '@/api/modules/product'
import { useStableRequest } from '@/composables/useStableRequest'
import { AppRequestError, extractErrorMessage } from '@/utils/error'
import { applyPaginatedResult, createPaginatedListState } from '@/utils/list'
import dayjs from 'dayjs'
import InboundDeliverySheetWorkbenchDialog from './components/InboundDeliverySheetWorkbenchDialog.vue'


import { showAppError, showAppSuccess, showAppWarning } from '@/utils/app-alert'

const router = useRouter()
const route = useRoute()
const listRequest = useStableRequest()
const detailRequest = useStableRequest()
const productRequest = useStableRequest()
const actionRequest = useStableRequest()
const AUTO_REFRESH_INTERVAL_MS = 30_000
const DETAIL_SYNC_INTERVAL_MS = 30_000
const listRenderKey = ref(0)
const listState = reactive(createPaginatedListState<InboundOrder>({
  loading: false,
  query: {
    pageSize: 10,
  },
}))
const summary = ref<SupplierDeliverySummary>({
  total: 0,
  pending: 0,
  verified: 0,
  cancelled: 0,
  deleted: 0,
})
const detailVisible = ref(false)
const detailLoading = ref(false)
const currentDetail = ref<InboundOrderDetail | null>(null)
const qrCodeDataUrl = ref('')
const qrCodeUnavailable = ref(false)
const statusFilter = ref<'all' | InboundOrder['status']>('all')
const deleteStateFilter = ref<'active' | 'deleted' | 'all'>('active')
const keyword = ref('')
const cancelDialogVisible = ref(false)
const cancelReason = ref('')
const cancelSubmitting = ref(false)
const targetCancelOrder = ref<InboundOrder | null>(null)
const editDialogVisible = ref(false)
const editSubmitting = ref(false)
const editProductLoading = ref(false)
const deliverySheetDialogVisible = ref(false)
const products = ref<ProductRecord[]>([])
const interactionLockCount = ref(0)
const silentRefreshing = ref(false)
const detailSyncing = ref(false)
let autoRefreshTimer: ReturnType<typeof globalThis.setInterval> | null = null
let detailSyncTimer: ReturnType<typeof globalThis.setInterval> | null = null

interface EditItemRow {
  uid: string
  productId: string
  qty: number
}

const editUidSeed = ref(0)
const createEditItemRow = (): EditItemRow => ({
  uid: `supplier-history-edit-item-${editUidSeed.value++}`,
  productId: '',
  qty: 1,
})

const getProductOptionValue = (product: ProductRecord) => String(product.id)

const editForm = reactive({
  orderId: '',
  remark: '',
  items: [] as EditItemRow[],
})

const statusMap = {
  pending: { label: '待入库', type: 'warning' },
  verified: { label: '已入库', type: 'success' },
  cancelled: { label: '已取消', type: 'info' },
} as const

// 统一状态映射读取，避免模板内索引触发隐式 any 类型问题。
const getStatusMeta = (status: InboundOrder['status']) => {
  return statusMap[status]
}

// 统计卡配置：让模板结构稳定，同时便于后续按业务继续扩展指标卡。
const summaryCards = computed(() => {
  return [
    {
      label: '送货单总数',
      value: summary.value.total,
      hint: '全部记录',
      accentClass: 'bg-sky-50 text-sky-600 dark:bg-sky-950/30 dark:text-sky-300',
    },
    {
      label: '待入库',
      value: summary.value.pending,
      hint: '等待扫码',
      accentClass: 'bg-amber-50 text-amber-600 dark:bg-amber-950/30 dark:text-amber-300',
    },
    {
      label: '已入库',
      value: summary.value.verified,
      hint: '已完成确认',
      accentClass: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/30 dark:text-emerald-300',
    },
    {
      label: '已取消',
      value: summary.value.cancelled,
      hint: '不再处理',
      accentClass: 'bg-slate-100 text-slate-600 dark:bg-slate-700/60 dark:text-slate-300',
    },
  ]
})

// 当前是否处于筛选态：用于空态文案与局部提示收口，避免同一信息在多个区域重复出现。
const isFiltering = computed(() => {
  return statusFilter.value !== 'all' || deleteStateFilter.value !== 'active' || Boolean(keyword.value.trim())
})

// 列表头仅保留简短结果说明，避免再次重复展示完整筛选摘要。
const tableSummaryText = computed(() => {
  return isFiltering.value ? `当前结果 ${listState.total} 条` : `共 ${summary.value.total} 条记录`
})

// 空态文案按“全量为空 / 当前筛选为空”区分，减少误导。
const emptyDescription = computed(() => {
  return isFiltering.value ? '当前筛选下暂无单据' : '暂无历史送货记录'
})

const canEditOrder = (order: InboundOrder) => order.status === 'pending' && !order.isDeleted
const canCancelOrder = (order: InboundOrder) => order.status === 'pending' && !order.isDeleted
const canSoftDeleteOrder = (order: InboundOrder) => !order.isDeleted && order.status !== 'verified'
const canRestoreOrder = (order: InboundOrder) => order.isDeleted && order.status !== 'verified'
const canPermanentDeleteOrder = (order: InboundOrder) => order.isDeleted && order.status !== 'verified'
const shouldShowPendingQrCode = computed(() => {
  return currentDetail.value?.order.status === 'pending' && !currentDetail.value.order.isDeleted
})

const isOnSupplierHistoryRoute = computed(() => route.name === 'supplier-history')
const isInteractionLocked = computed(() => {
  return (
    interactionLockCount.value > 0 ||
    cancelDialogVisible.value ||
    editDialogVisible.value ||
    deliverySheetDialogVisible.value ||
    cancelSubmitting.value ||
    editSubmitting.value
  )
})

const buildListQuery = () => {
  return {
    page: listState.query.page,
    pageSize: listState.query.pageSize,
    keyword: keyword.value.trim() || undefined,
    status: statusFilter.value === 'all' ? undefined : statusFilter.value,
    includeDeleted: deleteStateFilter.value === 'all' ? true : undefined,
    onlyDeleted: deleteStateFilter.value === 'deleted' ? true : undefined,
  }
}

const replaceCurrentPageRecord = (nextOrder: InboundOrder) => {
  const targetIndex = listState.records.findIndex((item) => item.id === nextOrder.id)
  if (targetIndex < 0) {
    return
  }
  listState.records.splice(targetIndex, 1, nextOrder)
}

const resetEditForm = () => {
  editForm.orderId = ''
  editForm.remark = ''
  editForm.items = [createEditItemRow()]
}

const ensureEditRowsFromDetail = (detail: InboundOrderDetail) => {
  editForm.orderId = detail.order.id
  editForm.remark = detail.order.remark ?? ''
  editForm.items = detail.items.map((item) => ({
    uid: `supplier-history-edit-item-${editUidSeed.value++}`,
    productId: String(item.productId),
    qty: Number(item.qty) || 1,
  }))

  if (!editForm.items.length) {
    editForm.items = [createEditItemRow()]
  }
}

const ensureProductOptionsFromDetail = (detail: InboundOrderDetail) => {
  const existingIds = new Set(products.value.map((product) => getProductOptionValue(product)))
  const fallbackProducts = detail.items
    .filter((item) => item.productId && !existingIds.has(String(item.productId)))
    .map((item) => ({
      id: String(item.productId),
      productCode: '历史商品',
      productName: item.productNameSnapshot || '未匹配商品',
      pinyinAbbr: '',
      defaultPrice: '0',
      discountRate: '10.0',
      discountedPrice: '0.00',
      isActive: false,
      o2oStatus: 'unlisted' as const,
      o2oRecommended: false,
      thumbnail: null,
      detailContent: null,
      limitPerUser: 0,
      currentStock: 0,
      preOrderedStock: 0,
      availableStock: 0,
      tagIds: [],
      tags: [],
    }))

  if (fallbackProducts.length) {
    products.value = [...products.value, ...fallbackProducts]
  }
}

// 商品目录懒加载：改单弹窗打开时再取一次，保证能拿到当前仍可选的启用商品。
const ensureProductsLoaded = async () => {
  if (products.value.length > 0) {
    return
  }

  editProductLoading.value = true
  await productRequest.runLatest({
    executor: (signal) => getProductList({}, { signal }),
    onSuccess: (result) => {
      products.value = result
    },
    onError: (error) => {
      showAppError(extractErrorMessage(error, '可改单商品加载失败，请稍后重试'))
    },
    onFinally: () => {
      editProductLoading.value = false
    },
  })
}

const isMissingDeliveryError = (error: unknown) => {
  if (error instanceof AppRequestError && error.status === 404) {
    return true
  }

  const message = extractErrorMessage(error, '')
  return /不存在|已被删除|不可访问|无效/.test(message)
}

const canRunBackgroundSync = () => {
  return isOnSupplierHistoryRoute.value && !isInteractionLocked.value
}

const runWithInteractionLock = async <T,>(executor: () => Promise<T>) => {
  interactionLockCount.value += 1
  try {
    return await executor()
  } finally {
    interactionLockCount.value = Math.max(0, interactionLockCount.value - 1)
  }
}

const loadData = async (options: { silent?: boolean; force?: boolean } = {}) => {
  if (!options.force && options.silent && !canRunBackgroundSync()) {
    return
  }

  if (options.silent && listState.loading) {
    return
  }

  if (options.silent) {
    silentRefreshing.value = true
    listState.loading = false
  } else {
    silentRefreshing.value = false
    listState.loading = true
  }

  await listRequest.runLatest({
    executor: (signal) => getSupplierDeliveries(buildListQuery(), { signal }),
    onSuccess: (result) => {
      applyPaginatedResult(listState, result)
      summary.value = result.summary
      if (!options.silent) {
        listRenderKey.value += 1
      }
    },
    onError: (err) => {
      if (!options.silent) {
        showAppError(extractErrorMessage(err, '获取历史记录失败'))
      }
    },
    onFinally: () => {
      if (options.silent) {
        silentRefreshing.value = false
        listState.loading = false
      } else {
        listState.loading = false
      }
    },
  })
}

// 历史详情中仅对待入库单据补生成二维码，已入库单据无需重复展示核销码。
const generateQRCode = async (verifyCode: string) => {
  try {
    qrCodeDataUrl.value = await QRCode.toDataURL(verifyCode, {
      width: 200,
      margin: 1,
      color: { dark: '#000000', light: '#ffffff' },
    })
    qrCodeUnavailable.value = false
  } catch (err) {
    qrCodeDataUrl.value = ''
    qrCodeUnavailable.value = true
    showAppWarning(extractErrorMessage(err, '详情已加载，但二维码生成失败，请稍后重试'))
  }
}

const applyDetailResult = async (detail: InboundOrderDetail, options?: { openDrawer?: boolean }) => {
  currentDetail.value = detail
  replaceCurrentPageRecord(detail.order)

  if (options?.openDrawer !== false) {
    detailVisible.value = true
  }

  if (detail.order.status === 'pending') {
    await generateQRCode(detail.order.verifyCode)
    return
  }

  qrCodeDataUrl.value = ''
  qrCodeUnavailable.value = false
}

const handleMissingCurrentDetail = async (options: { notify?: boolean } = {}) => {
  const currentShowNo = currentDetail.value?.order.showNo
  detailVisible.value = false
  currentDetail.value = null
  qrCodeDataUrl.value = ''
  qrCodeUnavailable.value = false
  await loadData({ silent: true, force: true })
  if (options.notify !== false) {
    showAppWarning(currentShowNo ? `送货单“${currentShowNo}”已被永久删除或不可访问` : '送货单已被永久删除或不可访问')
  }
}

// 详情刷新共用入口：
// - 列表查看详情、改单成功后详情回写、撤销成功后详情切换都统一走这里；
// - 避免每个动作各自维护一套“重置二维码 + 请求详情 + 刷新抽屉”的分支。
const loadDetail = async (row: Pick<InboundOrder, 'id' | 'verifyCode'> & Partial<Pick<InboundOrder, 'isDeleted' | 'showNo'>>, options?: { openDrawer?: boolean }) => {
  if (options?.openDrawer !== false) {
    detailVisible.value = true
  }
  detailLoading.value = true
  qrCodeDataUrl.value = ''
  qrCodeUnavailable.value = false
  if (options?.openDrawer !== false) {
    currentDetail.value = null
  }

  await detailRequest.runLatest({
    executor: (signal) => getInboundDetail(row.verifyCode, {
      signal,
      includeDeleted: Boolean(row.isDeleted),
    }),
    onSuccess: async (detail) => {
      await applyDetailResult(detail, options)
    },
    onError: async (err) => {
      if (isMissingDeliveryError(err)) {
        detailVisible.value = false
        currentDetail.value = null
        await loadData({ silent: true, force: true })
        showAppWarning(row.showNo ? `送货单“${row.showNo}”已被永久删除或不可访问` : '送货单已被永久删除或不可访问')
        return
      }

      showAppError(extractErrorMessage(err, '获取详情失败'))
      if (options?.openDrawer !== false) {
        detailVisible.value = false
      }
    },
    onFinally: () => {
      detailLoading.value = false
    },
  })
}

const fetchLatestDetailForOrder = (order: Pick<InboundOrder, 'verifyCode'> & Partial<Pick<InboundOrder, 'isDeleted'>>) => {
  return getInboundDetail(order.verifyCode, {
    includeDeleted: true,
  })
}

const syncCurrentDetail = async (options: { notifyMissing?: boolean } = {}) => {
  if (!currentDetail.value || !detailVisible.value || !canRunBackgroundSync() || detailSyncing.value) {
    return
  }

  detailSyncing.value = true
  try {
    const detail = await fetchLatestDetailForOrder(currentDetail.value.order)
    await applyDetailResult(detail, { openDrawer: false })
  } catch (error) {
    if (isMissingDeliveryError(error)) {
      await handleMissingCurrentDetail({ notify: options.notifyMissing })
    }
  } finally {
    detailSyncing.value = false
  }
}

const buildStateChangedMessage = (detail: InboundOrderDetail, actionLabel: string) => {
  const order = detail.order
  if (order.isDeleted) {
    return `送货单“${order.showNo}”已删除，不能继续${actionLabel}`
  }
  if (order.status === 'verified') {
    return `送货单“${order.showNo}”已入库，不能继续${actionLabel}`
  }
  if (order.status === 'cancelled') {
    return `送货单“${order.showNo}”已撤销，不能继续${actionLabel}`
  }
  return `送货单“${order.showNo}”状态已变化，请确认后再操作`
}

const ensureLatestActionableDetail = async (
  order: InboundOrder,
  actionLabel: string,
  predicate: (latestOrder: InboundOrder) => boolean,
) => {
  try {
    const detail = await fetchLatestDetailForOrder(order)
    const shouldKeepDrawerOpen = detailVisible.value && currentDetail.value?.order.id === detail.order.id
    await applyDetailResult(detail, { openDrawer: shouldKeepDrawerOpen })
    if (!predicate(detail.order)) {
      await loadData({ silent: true, force: true })
      showAppWarning(buildStateChangedMessage(detail, actionLabel))
      return null
    }
    return detail
  } catch (error) {
    if (isMissingDeliveryError(error)) {
      if (currentDetail.value?.order.id === order.id) {
        await handleMissingCurrentDetail()
      } else {
        await loadData({ silent: true, force: true })
        showAppWarning(`送货单“${order.showNo}”已被永久删除或不可访问`)
      }
      return null
    }

    showAppError(extractErrorMessage(error, `确认送货单状态失败，已取消${actionLabel}`))
    return null
  }
}

const refreshVisibleSupplierHistory = async () => {
  if (!canRunBackgroundSync()) {
    return
  }

  await loadData({ silent: true })
}

const refreshSupplierHistoryNow = async () => {
  if (!isOnSupplierHistoryRoute.value) {
    return
  }

  await loadData({ silent: true, force: true })
  await syncCurrentDetail({ notifyMissing: true })
}

const startAutoRefresh = () => {
  if (autoRefreshTimer) {
    return
  }

  autoRefreshTimer = globalThis.setInterval(() => {
    void refreshVisibleSupplierHistory()
  }, AUTO_REFRESH_INTERVAL_MS)
}

const stopAutoRefresh = () => {
  if (!autoRefreshTimer) {
    return
  }

  globalThis.clearInterval(autoRefreshTimer)
  autoRefreshTimer = null
}

const startDetailSync = () => {
  if (detailSyncTimer) {
    return
  }

  detailSyncTimer = globalThis.setInterval(() => {
    void syncCurrentDetail({ notifyMissing: true })
  }, DETAIL_SYNC_INTERVAL_MS)
}

const stopDetailSync = () => {
  if (!detailSyncTimer) {
    return
  }

  globalThis.clearInterval(detailSyncTimer)
  detailSyncTimer = null
}

const handleVisibilitySync = () => {
  if (globalThis.document?.visibilityState === 'visible') {
    void refreshSupplierHistoryNow()
  }
}

// 查看详情时重置上一次弹窗状态，避免旧二维码或旧详情短暂闪现。
const handleViewDetail = async (row: InboundOrder) => {
  await loadDetail(row, { openDrawer: true })
}

const handleAddEditItem = () => {
  editForm.items.push(createEditItemRow())
}

const handleRemoveEditItem = (index: number) => {
  if (editForm.items.length === 1) {
    return
  }
  editForm.items.splice(index, 1)
}

const openCancelDialog = async (order: InboundOrder) => {
  if (!canCancelOrder(order)) {
    showAppWarning('当前送货单不可撤销')
    return
  }

  const detail = await ensureLatestActionableDetail(order, '撤销', canCancelOrder)
  if (!detail) {
    return
  }

  targetCancelOrder.value = detail.order
  cancelReason.value = ''
  cancelDialogVisible.value = true
}

const openDeliverySheetDialog = () => {
  if (!currentDetail.value) {
    showAppWarning('送货单详情尚未加载完成')
    return
  }

  deliverySheetDialogVisible.value = true
}

const openEditDialog = async (row: InboundOrder) => {
  if (!canEditOrder(row)) {
    showAppWarning('当前送货单不可改单')
    return
  }

  const latestDetail = await ensureLatestActionableDetail(row, '改单', canEditOrder)
  if (!latestDetail) {
    return
  }

  await ensureProductsLoaded()
  ensureProductOptionsFromDetail(latestDetail)

  const shouldReuseCurrentDetail = currentDetail.value?.order.id === latestDetail.order.id
  if (shouldReuseCurrentDetail && currentDetail.value) {
    ensureProductOptionsFromDetail(currentDetail.value)
    ensureEditRowsFromDetail(currentDetail.value)
    editDialogVisible.value = true
    return
  }

  ensureEditRowsFromDetail(latestDetail)
  editDialogVisible.value = true
}

const handleSubmitCancel = async () => {
  if (!targetCancelOrder.value) {
    return
  }

  const reason = cancelReason.value.trim()
  if (!reason) {
    showAppWarning('请填写撤销原因')
    return
  }

  const latestDetail = await ensureLatestActionableDetail(targetCancelOrder.value, '撤销', canCancelOrder)
  if (!latestDetail) {
    cancelDialogVisible.value = false
    return
  }
  targetCancelOrder.value = latestDetail.order

  cancelSubmitting.value = true
  await actionRequest.runLatest({
    executor: (signal) => cancelSupplierDelivery(targetCancelOrder.value!.id, { reason }, { signal }),
    onSuccess: async (detail) => {
      cancelDialogVisible.value = false
      cancelReason.value = ''
      targetCancelOrder.value = null
      await applyDetailResult(detail)
      await loadData()
      showAppSuccess('送货单已撤销')
    },
    onError: (error) => {
      showAppError(extractErrorMessage(error, '撤销送货单失败'))
    },
    onFinally: () => {
      cancelSubmitting.value = false
    },
  })
}

const handleSoftDeleteOrder = async (order: InboundOrder) => {
  if (!canSoftDeleteOrder(order)) {
    showAppWarning(order.status === 'verified' ? '已入库送货单不能删除' : '当前送货单不可删除')
    return
  }

  const latestDetail = await ensureLatestActionableDetail(order, '删除', canSoftDeleteOrder)
  if (!latestDetail) {
    return
  }

  try {
    await runWithInteractionLock(() => ElMessageBox.confirm(
      `删除后该送货单会从正常列表隐藏，可在“已删除单据”中恢复。\n送货单号：${latestDetail.order.showNo}`,
      '删除送货单',
      {
        type: 'warning',
        confirmButtonText: '确认删除',
        cancelButtonText: '取消',
      },
    ))
  } catch {
    return
  }

  const submitDetail = await ensureLatestActionableDetail(latestDetail.order, '删除', canSoftDeleteOrder)
  if (!submitDetail) {
    return
  }

  await actionRequest.runLatest({
    executor: (signal) => deleteSupplierDelivery(submitDetail.order.id, { signal }),
    onSuccess: async (detail) => {
      if (currentDetail.value?.order.id === detail.order.id) {
        await applyDetailResult(detail, { openDrawer: true })
      }
      await loadData()
      showAppSuccess('送货单已删除，可在已删除单据中恢复')
    },
    onError: (error) => {
      showAppError(extractErrorMessage(error, '删除送货单失败'))
    },
  })
}

const handleRestoreOrder = async (order: InboundOrder) => {
  if (!canRestoreOrder(order)) {
    showAppWarning('当前送货单不可恢复')
    return
  }

  const latestDetail = await ensureLatestActionableDetail(order, '恢复', canRestoreOrder)
  if (!latestDetail) {
    return
  }

  try {
    await runWithInteractionLock(() => ElMessageBox.confirm(`确认恢复送货单“${latestDetail.order.showNo}”？`, '恢复送货单', {
      type: 'warning',
      confirmButtonText: '确认恢复',
      cancelButtonText: '取消',
    }))
  } catch {
    return
  }

  const submitDetail = await ensureLatestActionableDetail(latestDetail.order, '恢复', canRestoreOrder)
  if (!submitDetail) {
    return
  }

  await actionRequest.runLatest({
    executor: (signal) => restoreSupplierDelivery(submitDetail.order.id, { signal }),
    onSuccess: async (detail) => {
      if (currentDetail.value?.order.id === detail.order.id) {
        await applyDetailResult(detail, { openDrawer: true })
      }
      await loadData()
      showAppSuccess('送货单已恢复')
    },
    onError: (error) => {
      showAppError(extractErrorMessage(error, '恢复送货单失败'))
    },
  })
}

const handlePermanentDeleteOrder = async (order: InboundOrder) => {
  if (!canPermanentDeleteOrder(order)) {
    showAppWarning('当前送货单不可永久删除')
    return
  }

  const latestDetail = await ensureLatestActionableDetail(order, '永久删除', canPermanentDeleteOrder)
  if (!latestDetail) {
    return
  }

  let confirmShowNo = ''
  let permanentDeletePassword = ''
  try {
    const result = await runWithInteractionLock(() => ElMessageBox.prompt(
      `永久删除后将清理送货单和商品明细，无法恢复。\n请输入送货单号确认：${latestDetail.order.showNo}`,
      '永久删除送货单',
      {
        type: 'error',
        confirmButtonText: '永久删除',
        cancelButtonText: '取消',
        inputPattern: new RegExp(`^${latestDetail.order.showNo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
        inputErrorMessage: '请输入完整送货单号',
      },
    ))
    confirmShowNo = result.value
    const passwordResult = await runWithInteractionLock(() => ElMessageBox.prompt(
      '请输入容器环境变量中配置的永久删除密码。',
      '永久删除密码',
      {
        type: 'error',
        confirmButtonText: '永久删除',
        cancelButtonText: '取消',
        inputType: 'password',
        inputPlaceholder: '请输入永久删除密码',
        inputValidator: (value: string) => {
          if (!String(value || '').trim()) {
            return '请输入永久删除密码'
          }
          return true
        },
      },
    ))
    permanentDeletePassword = passwordResult.value.trim()
  } catch {
    return
  }

  const submitDetail = await ensureLatestActionableDetail(latestDetail.order, '永久删除', canPermanentDeleteOrder)
  if (!submitDetail) {
    return
  }

  await actionRequest.runLatest({
    executor: (signal) => permanentlyDeleteSupplierDelivery(submitDetail.order.id, { confirmShowNo, permanentDeletePassword }, { signal }),
    onSuccess: async () => {
      if (currentDetail.value?.order.id === submitDetail.order.id) {
        detailVisible.value = false
        currentDetail.value = null
      }
      await loadData()
      showAppSuccess('送货单已永久删除')
    },
    onError: (error) => {
      showAppError(extractErrorMessage(error, '永久删除送货单失败'))
    },
  })
}

const buildEditPayload = () => {
  const validItems = editForm.items.filter((item) => item.productId && item.qty > 0)
  if (!validItems.length) {
    throw new Error('请至少保留一件有效商品')
  }

  const uniqueItems = new Map<string, number>()
  validItems.forEach((item) => {
    const productId = String(item.productId).trim()
    uniqueItems.set(productId, (uniqueItems.get(productId) || 0) + item.qty)
  })

  return {
    remark: editForm.remark.trim(),
    items: Array.from(uniqueItems.entries()).map(([productId, qty]) => ({ productId, qty })),
  }
}

const handleSubmitEdit = async () => {
  if (!editForm.orderId) {
    return
  }

  let payload: { remark: string; items: Array<{ productId: string; qty: number }> }
  try {
    payload = buildEditPayload()
  } catch (error) {
    showAppWarning(extractErrorMessage(error, '请至少保留一件有效商品'))
    return
  }

  const targetOrder = currentDetail.value?.order.id === editForm.orderId
    ? currentDetail.value.order
    : listState.records.find((order) => order.id === editForm.orderId)
  if (targetOrder) {
    const latestDetail = await ensureLatestActionableDetail(targetOrder, '改单', canEditOrder)
    if (!latestDetail) {
      editDialogVisible.value = false
      return
    }
  }

  editSubmitting.value = true
  await actionRequest.runLatest({
    executor: (signal) => updateSupplierDelivery(editForm.orderId, payload, { signal }),
    onSuccess: async (detail) => {
      editDialogVisible.value = false
      resetEditForm()
      await applyDetailResult(detail)
      await loadData()
      showAppSuccess('送货单已更新')
    },
    onError: (error) => {
      showAppError(extractErrorMessage(error, '改单失败'))
    },
    onFinally: () => {
      editSubmitting.value = false
    },
  })
}

const goToDelivery = () => {
  router.push('/supplier-delivery')
}

const handleSearch = () => {
  listState.query.page = 1
  void loadData()
}

const handleCurrentChange = (page: number) => {
  listState.query.page = page
  void loadData()
}

const handlePageSizeChange = (pageSize: number) => {
  listState.query.pageSize = pageSize
  listState.query.page = 1
  void loadData()
}

// 进入“历史单据”标签时主动刷新列表：
// - 供货工作台现在通过 KeepAlive 保留历史页状态，单纯依赖 onMounted 无法覆盖二次进入场景；
// - 这里监听路由名切回 supplier-history，在保留筛选条件和分页位置的前提下重新请求当前列表。
watch(() => route.name, (nextName, previousName) => {
  if (nextName !== 'supplier-history' || previousName === nextName) {
    return
  }

  void refreshSupplierHistoryNow()
})

watch(detailVisible, (visible) => {
  if (visible) {
    startDetailSync()
    void syncCurrentDetail({ notifyMissing: true })
    return
  }

  stopDetailSync()
})

onActivated(() => {
  void refreshSupplierHistoryNow()
})

onMounted(() => {
  resetEditForm()
  void loadData()
  startAutoRefresh()
  globalThis.document?.addEventListener('visibilitychange', handleVisibilitySync)
})

onBeforeUnmount(() => {
  stopAutoRefresh()
  stopDetailSync()
  globalThis.document?.removeEventListener('visibilitychange', handleVisibilitySync)
})
</script>

<template>
  <PageContainer>
    <div class="supplier-history-page mx-auto max-w-7xl">
      <transition-group name="history-summary-card" tag="div" class="history-summary-grid mb-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4" appear>
        <div
          v-for="(card, index) in summaryCards"
          :key="card.label"
          class="history-summary-card rounded-[26px] border border-slate-200/70 bg-white/95 p-5 shadow-[0_14px_34px_-34px_rgba(15,23,42,0.18)] dark:border-slate-700/80 dark:bg-slate-800/95"
          :style="{ '--history-card-delay': `${index * 48}ms` }"
        >
          <div :class="['history-summary-card__badge', card.accentClass]">
            {{ String(card.value).padStart(2, '0') }}
          </div>
          <p class="mt-4 text-sm font-medium text-slate-500 dark:text-slate-400">{{ card.label }}</p>
          <p class="mt-1 text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">{{ card.value }}</p>
          <p class="mt-2 text-xs leading-5 text-slate-400 dark:text-slate-500">{{ card.hint }}</p>
        </div>
      </transition-group>

      <div class="history-filter-card mb-4 rounded-[28px] border border-slate-200/70 bg-white/95 p-4 shadow-[0_14px_34px_-34px_rgba(15,23,42,0.16)] dark:border-slate-700/80 dark:bg-slate-800/95 sm:p-5">
        <div class="history-filter-card__toolbar flex flex-1 flex-col gap-3 xl:flex-row xl:items-center">
          <el-input
            v-model="keyword"
            clearable
            placeholder="按送货单号或供货方搜索"
            class="history-filter-card__input xl:max-w-xs"
            @clear="handleSearch"
            @keyup.enter="handleSearch"
          />
          <el-radio-group v-model="statusFilter" size="default" class="history-filter-card__tabs" @change="handleSearch">
            <el-radio-button value="all">全部状态</el-radio-button>
            <el-radio-button value="pending">待入库</el-radio-button>
            <el-radio-button value="verified">已入库</el-radio-button>
            <el-radio-button value="cancelled">已取消</el-radio-button>
          </el-radio-group>
          <el-select
            v-model="deleteStateFilter"
            class="history-filter-card__delete-state xl:w-40"
            placeholder="单据范围"
            @change="handleSearch"
          >
            <el-option label="正常单据" value="active" />
            <el-option :label="`已删除 ${summary.deleted}`" value="deleted" />
            <el-option label="全部单据" value="all" />
          </el-select>
          <el-button class="history-filter-card__submit" type="primary" @click="handleSearch">搜索</el-button>
        </div>
        <p class="history-filter-card__sync mt-3 text-xs leading-5 text-slate-400 dark:text-slate-500">
          自动同步已开启，约 30 秒刷新一次
        </p>
      </div>

      <div class="history-table-shell overflow-hidden rounded-[28px] border border-slate-200/70 bg-white/95 shadow-[0_18px_42px_-40px_rgba(15,23,42,0.18)] dark:border-slate-700/80 dark:bg-slate-800/95">
        <div class="history-table-shell__header flex flex-col gap-2 border-b border-slate-200/70 px-5 py-4 dark:border-slate-700/80 sm:px-6">
          <h3 class="text-base font-semibold text-slate-900 dark:text-slate-100">记录列表</h3>
          <p class="text-sm leading-6 text-slate-500 dark:text-slate-400">{{ tableSummaryText }}</p>
        </div>

        <div class="history-table-shell__body flex min-h-[520px] flex-col">
          <transition name="history-table-refresh" mode="out-in">
            <el-table
              :key="listRenderKey"
              native-scrollbar
              v-loading="listState.loading"
              :data="listState.records"
              stripe
              class="history-table-shell__table w-full flex-1"
            >
              <el-table-column prop="showNo" label="送货单号" min-width="180" />
              <el-table-column prop="totalQty" label="总数量" min-width="110">
                <template #default="{ row }">
                  <span class="font-medium text-slate-800 dark:text-slate-200">{{ Number(row.totalQty) }}</span> 件
                </template>
              </el-table-column>
              <el-table-column prop="status" label="状态" min-width="120">
                <template #default="{ row }">
                  <el-tag :type="getStatusMeta(row.status as InboundOrder['status']).type" effect="light" round>
                    {{ getStatusMeta(row.status as InboundOrder['status']).label }}
                  </el-tag>
                  <el-tag v-if="row.isDeleted" class="ml-2" type="danger" effect="light" round>已删除</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="创建时间" min-width="170">
                <template #default="{ row }">
                  {{ dayjs(row.createdAt).format('YYYY-MM-DD HH:mm') }}
                </template>
              </el-table-column>
              <el-table-column label="入库时间" min-width="170">
                <template #default="{ row }">
                  {{ row.verifiedAt ? dayjs(row.verifiedAt).format('YYYY-MM-DD HH:mm') : '-' }}
                </template>
              </el-table-column>
              <el-table-column label="操作" min-width="220" fixed="right" align="right">
                <template #default="{ row }">
                  <div class="history-table-shell__actions flex items-center justify-end gap-2">
                    <el-button
                      v-if="canEditOrder(row as InboundOrder)"
                      class="history-detail-button"
                      link
                      type="primary"
                      @click="openEditDialog(row as InboundOrder)"
                    >
                      改单
                    </el-button>
                    <el-button
                      v-if="canCancelOrder(row as InboundOrder)"
                      class="history-detail-button"
                      link
                      type="danger"
                      @click="openCancelDialog(row as InboundOrder)"
                    >
                      撤销
                    </el-button>
                    <el-button
                      v-if="canSoftDeleteOrder(row as InboundOrder)"
                      class="history-detail-button"
                      link
                      type="danger"
                      @click="handleSoftDeleteOrder(row as InboundOrder)"
                    >
                      删除
                    </el-button>
                    <el-button
                      v-if="canRestoreOrder(row as InboundOrder)"
                      class="history-detail-button"
                      link
                      type="primary"
                      @click="handleRestoreOrder(row as InboundOrder)"
                    >
                      恢复
                    </el-button>
                    <el-button
                      v-if="canPermanentDeleteOrder(row as InboundOrder)"
                      class="history-detail-button"
                      link
                      type="danger"
                      @click="handlePermanentDeleteOrder(row as InboundOrder)"
                    >
                      永久删除
                    </el-button>
                    <el-button class="history-detail-button" link type="primary" @click="handleViewDetail(row as InboundOrder)">
                      查看详情
                    </el-button>
                  </div>
                </template>
              </el-table-column>

              <template #empty>
                <div class="py-14">
                  <el-empty :description="emptyDescription" :image-size="120">
                    <el-button type="primary" @click="goToDelivery">去录入送货单</el-button>
                  </el-empty>
                </div>
              </template>
            </el-table>
          </transition>
        </div>
      </div>
      <PagePaginationBar
        v-if="listState.total > 0"
        v-model:current-page="listState.query.page"
        v-model:page-size="listState.query.pageSize"
        layout="total, sizes, prev, pager, next, jumper"
        :page-sizes="[10, 20, 50]"
        :total="listState.total"
        @current-change="handleCurrentChange"
        @size-change="handlePageSizeChange"
      />

      <!-- 详情面板：
       - 统一交给响应式抽屉壳承接滚动责任，避免页面内部继续用 100vh 差值硬编码高度；
       - 手机、平板、桌面分别走稳定尺寸，保证长内容只保留一层主滚动。
      -->
      <BizResponsiveDrawerShell
        v-model="detailVisible"
        title="送货单详情"
        height-mode="scroll"
        phone-size="100vw"
        tablet-size="52vw"
        desktop-size="48vw"
        phone-direction="rtl"
        default-direction="rtl"
        drawer-class="supplier-history-detail-drawer"
        body-class="pr-0"
        :loading="detailLoading"
      >
        <div class="supplier-history-detail-panel min-h-[200px]">
          <transition name="history-detail-fade" appear>
            <div v-if="currentDetail" class="space-y-4">
              <div class="history-detail-hero rounded-[26px] border border-slate-200/70 bg-white/95 p-5 shadow-[0_14px_32px_-32px_rgba(15,23,42,0.16)] dark:border-slate-700/80 dark:bg-slate-800/95">
                <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <p class="text-xs uppercase tracking-[0.2em] text-slate-400 dark:text-slate-500">送货单详情</p>
                    <h3 class="mt-2 text-lg font-semibold text-slate-900 dark:text-slate-100">{{ currentDetail.order.showNo }}</h3>
                    <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
                      创建于 {{ dayjs(currentDetail.order.createdAt).format('YYYY-MM-DD HH:mm') }}
                    </p>
                  </div>
                  <div class="history-detail-hero__actions flex shrink-0 flex-wrap items-center justify-start gap-2 lg:justify-end">
                    <el-button
                      type="primary"
                      plain
                      @click="openDeliverySheetDialog"
                    >
                      生成送货单
                    </el-button>
                    <el-button
                      v-if="canEditOrder(currentDetail.order)"
                      type="primary"
                      plain
                      @click="openEditDialog(currentDetail.order)"
                    >
                      改单
                    </el-button>
                    <el-button
                      v-if="canCancelOrder(currentDetail.order)"
                      type="danger"
                      plain
                      @click="openCancelDialog(currentDetail.order)"
                    >
                      撤销
                    </el-button>
                    <el-button
                      v-if="canSoftDeleteOrder(currentDetail.order)"
                      type="danger"
                      plain
                      @click="handleSoftDeleteOrder(currentDetail.order)"
                    >
                      删除
                    </el-button>
                    <el-button
                      v-if="canRestoreOrder(currentDetail.order)"
                      type="primary"
                      plain
                      @click="handleRestoreOrder(currentDetail.order)"
                    >
                      恢复
                    </el-button>
                    <el-button
                      v-if="canPermanentDeleteOrder(currentDetail.order)"
                      type="danger"
                      plain
                      @click="handlePermanentDeleteOrder(currentDetail.order)"
                    >
                      永久删除
                    </el-button>
                    <el-tag :type="getStatusMeta(currentDetail.order.status).type" size="small" effect="light" round>
                      {{ getStatusMeta(currentDetail.order.status).label }}
                    </el-tag>
                    <el-tag v-if="currentDetail.order.isDeleted" type="danger" size="small" effect="light" round>
                      已删除
                    </el-tag>
                  </div>
                </div>

                <div class="mt-4 grid gap-3 sm:grid-cols-4">
                  <div class="rounded-2xl border border-slate-200/70 bg-slate-50/80 p-4 dark:border-slate-700/70 dark:bg-slate-900/40">
                    <p class="text-xs text-slate-500 dark:text-slate-400">总件数</p>
                    <p class="mt-2 text-lg font-semibold text-brand dark:text-teal-400">{{ Number(currentDetail.order.totalQty) }} 件</p>
                  </div>
                  <div class="rounded-2xl border border-slate-200/70 bg-slate-50/80 p-4 dark:border-slate-700/70 dark:bg-slate-900/40">
                    <p class="text-xs text-slate-500 dark:text-slate-400">入库时间</p>
                    <p class="mt-2 text-lg font-semibold text-slate-800 dark:text-slate-100">
                      {{ currentDetail.order.verifiedAt ? dayjs(currentDetail.order.verifiedAt).format('MM-DD HH:mm') : '-' }}
                    </p>
                  </div>
                  <div class="rounded-2xl border border-slate-200/70 bg-slate-50/80 p-4 dark:border-slate-700/70 dark:bg-slate-900/40">
                    <p class="text-xs text-slate-500 dark:text-slate-400">供货方</p>
                    <p class="mt-2 text-lg font-semibold text-slate-800 dark:text-slate-100">{{ currentDetail.order.supplierName || '-' }}</p>
                  </div>
                  <div class="rounded-2xl border border-slate-200/70 bg-slate-50/80 p-4 dark:border-slate-700/70 dark:bg-slate-900/40">
                    <p class="text-xs text-slate-500 dark:text-slate-400">最近更新</p>
                    <p class="mt-2 text-lg font-semibold text-slate-800 dark:text-slate-100">
                      {{ dayjs(currentDetail.order.updatedAt).format('MM-DD HH:mm') }}
                    </p>
                  </div>
                </div>
              </div>

              <div
                class="rounded-[26px] border border-slate-200/70 bg-white/95 p-5 shadow-[0_14px_32px_-32px_rgba(15,23,42,0.14)] dark:border-slate-700/80 dark:bg-slate-800/95"
              >
                <div class="grid gap-3 sm:grid-cols-2">
                  <div class="rounded-2xl border border-slate-200/70 bg-slate-50/80 p-4 dark:border-slate-700/70 dark:bg-slate-900/40">
                    <p class="text-xs text-slate-500 dark:text-slate-400">备注</p>
                    <p class="mt-2 text-sm leading-6 text-slate-700 dark:text-slate-300">
                      {{ currentDetail.order.remark || '未填写备注' }}
                    </p>
                  </div>
                  <div
                    v-if="currentDetail.order.status === 'cancelled'"
                    class="rounded-2xl border border-rose-200/70 bg-rose-50/75 p-4 dark:border-rose-900/60 dark:bg-rose-950/20"
                  >
                    <p class="text-xs text-rose-500 dark:text-rose-300">撤销信息</p>
                    <p class="mt-2 text-sm font-medium text-rose-700 dark:text-rose-200">
                      {{ currentDetail.order.cancelReason || '未记录撤销原因' }}
                    </p>
                    <p class="mt-2 text-xs leading-5 text-rose-600/85 dark:text-rose-200/75">
                      {{ currentDetail.order.cancelledAt ? `撤销于 ${dayjs(currentDetail.order.cancelledAt).format('YYYY-MM-DD HH:mm')}` : '撤销时间未记录' }}
                    </p>
                    <p class="mt-1 text-xs leading-5 text-rose-600/85 dark:text-rose-200/75">
                      {{ currentDetail.order.cancelledByDisplayName || currentDetail.order.cancelledByUsername || '当前供货方' }}
                    </p>
                  </div>
                </div>
              </div>

              <div class="rounded-[26px] border border-slate-200/70 bg-white/95 p-5 shadow-[0_14px_32px_-32px_rgba(15,23,42,0.14)] dark:border-slate-700/80 dark:bg-slate-800/95">
                <h4 class="text-sm font-semibold text-slate-900 dark:text-slate-100">商品明细</h4>
                <div class="mt-4 space-y-3">
                  <div
                    v-for="(item, index) in currentDetail.items"
                    :key="item.id"
                    class="history-detail-item flex items-center justify-between gap-3 rounded-2xl border border-slate-200/70 bg-slate-50/80 p-4 dark:border-slate-700/70 dark:bg-slate-900/40"
                  >
                    <div class="flex min-w-0 items-center gap-3">
                      <span class="history-detail-item__index">{{ index + 1 }}</span>
                      <span class="truncate text-slate-700 dark:text-slate-300">{{ item.productNameSnapshot }}</span>
                    </div>
                    <span class="shrink-0 font-medium text-slate-800 dark:text-slate-200">x {{ Number(item.qty) }}</span>
                  </div>
                </div>
              </div>

              <!-- 若未入库，展示二维码以便补扫。 -->
              <transition name="history-detail-fade">
                <div v-if="shouldShowPendingQrCode && qrCodeDataUrl" class="rounded-[26px] border border-amber-200/70 bg-amber-50/65 p-5 text-center shadow-[0_12px_28px_-28px_rgba(245,158,11,0.18)] dark:border-amber-900/60 dark:bg-amber-950/20">
                  <p class="text-sm font-medium text-amber-700 dark:text-amber-300">向库管员出示此二维码完成入库</p>
                  <img :src="qrCodeDataUrl" alt="核销二维码" class="mx-auto mt-4 h-40 w-40 rounded-2xl border border-white/80 bg-white p-2 shadow-sm dark:border-slate-700/70 dark:bg-slate-900/70" />
                </div>
              </transition>

              <!-- 二维码生成失败时保留页面内提示，避免用户误以为详情尚未加载完成。 -->
              <transition name="history-detail-fade">
                <div
                  v-if="shouldShowPendingQrCode && qrCodeUnavailable"
                  class="rounded-[26px] border border-amber-200/70 bg-amber-50/65 p-5 text-center shadow-[0_12px_28px_-28px_rgba(245,158,11,0.14)] dark:border-amber-900/60 dark:bg-amber-950/20"
                >
                  <p class="text-sm font-medium text-amber-700 dark:text-amber-300">二维码暂未生成</p>
                  <p class="mt-2 text-sm leading-6 text-amber-700/85 dark:text-amber-200/85">
                    单据详情已加载，可稍后重新打开查看。
                  </p>
                </div>
              </transition>
            </div>
          </transition>
        </div>
      </BizResponsiveDrawerShell>

      <InboundDeliverySheetWorkbenchDialog
        v-model="deliverySheetDialogVisible"
        :detail="currentDetail"
      />

      <el-dialog
        v-model="cancelDialogVisible"
        title="撤销送货单"
        width="28rem"
        append-to-body
        destroy-on-close
        @closed="targetCancelOrder = null"
      >
        <div class="space-y-4">
          <p class="text-sm leading-6 text-slate-500 dark:text-slate-400">
            撤销后该送货单会保留在历史单据中，但不再允许库管继续扫码入库。
          </p>
          <div class="rounded-2xl border border-slate-200/70 bg-slate-50/80 px-4 py-3 text-sm text-slate-600 dark:border-slate-700/70 dark:bg-slate-900/40 dark:text-slate-300">
            当前单据：{{ targetCancelOrder?.showNo || '-' }}
          </div>
          <el-input
            v-model="cancelReason"
            type="textarea"
            :rows="4"
            maxlength="255"
            show-word-limit
            resize="none"
            placeholder="请填写撤销原因，例如到货延迟、送货内容有误、需重新录入等。"
          />
        </div>
        <template #footer>
          <div class="flex justify-end gap-3">
            <el-button @click="cancelDialogVisible = false">取消</el-button>
            <el-button type="danger" :loading="cancelSubmitting" @click="handleSubmitCancel">确认撤销</el-button>
          </div>
        </template>
      </el-dialog>

      <el-dialog
        v-model="editDialogVisible"
        title="修改送货单"
        width="46rem"
        append-to-body
        destroy-on-close
        @closed="resetEditForm"
      >
        <div class="space-y-4">
          <div class="rounded-2xl border border-slate-200/70 bg-slate-50/80 px-4 py-3 text-sm leading-6 text-slate-600 dark:border-slate-700/70 dark:bg-slate-900/40 dark:text-slate-300">
            仅待入库送货单支持改单。保存后会直接覆盖当前商品明细、总件数和备注，核销二维码保持不变。
          </div>

          <div class="space-y-3">
            <transition-group name="item-list" tag="div" class="space-y-3">
              <div
                v-for="(item, index) in editForm.items"
                :key="item.uid"
                class="history-edit-item-row flex flex-col gap-3 rounded-2xl border border-slate-200/70 bg-slate-50/75 p-4 dark:border-slate-700/70 dark:bg-slate-900/40 lg:flex-row lg:items-start"
              >
                <div class="history-detail-item__index flex-shrink-0">{{ index + 1 }}</div>
                <div class="flex-1">
                  <el-select
                    v-model="item.productId"
                    filterable
                    class="w-full"
                    placeholder="请选择商品"
                    :loading="editProductLoading"
                  >
                    <el-option
                      v-for="product in products"
                      :key="getProductOptionValue(product)"
                      :label="product.productName"
                      :value="getProductOptionValue(product)"
                    >
                      <span class="float-left">{{ product.productName }}</span>
                      <span class="float-right text-sm text-slate-400">{{ product.productCode }}</span>
                    </el-option>
                  </el-select>
                </div>
                <div class="w-full lg:w-36">
                  <PassiveNumberInput
                    v-model="item.qty"
                    :min="1"
                    :step="1"
                    step-strictly
                    class="w-full"
                    placeholder="数量"
                  />
                </div>
                <el-button
                  class="delete-button"
                  type="danger"
                  link
                  :disabled="editForm.items.length === 1"
                  @click="handleRemoveEditItem(index)"
                >
                  删除
                </el-button>
              </div>
            </transition-group>

            <el-button plain @click="handleAddEditItem">添加商品</el-button>
          </div>

          <div class="rounded-2xl border border-slate-200/70 bg-slate-50/70 p-4 dark:border-slate-700/70 dark:bg-slate-900/40">
            <p class="mb-2 text-sm font-medium text-slate-600 dark:text-slate-400">备注信息</p>
            <el-input
              v-model="editForm.remark"
              type="textarea"
              :rows="3"
              maxlength="255"
              show-word-limit
              resize="none"
              placeholder="备注信息（选填）"
            />
          </div>
        </div>
        <template #footer>
          <div class="flex justify-between gap-3">
            <div class="text-sm leading-6 text-slate-500 dark:text-slate-400">
              当前共 {{ editForm.items.filter((item) => item.productId && item.qty > 0).length }} 行有效商品
            </div>
            <div class="flex justify-end gap-3">
              <el-button @click="editDialogVisible = false">取消</el-button>
              <el-button type="primary" :loading="editSubmitting" @click="handleSubmitEdit">保存改单</el-button>
            </div>
          </div>
        </template>
      </el-dialog>
    </div>
  </PageContainer>
</template>

<style scoped>
.supplier-history-page {
  padding-top: 0.25rem;
}

.history-summary-card,
.history-filter-card,
.history-table-shell,
.history-detail-hero,
.history-detail-item {
  transition:
    box-shadow var(--ylink-motion-fast) var(--ylink-motion-ease),
    border-color var(--ylink-motion-fast) var(--ylink-motion-ease),
    transform var(--ylink-motion-fast) var(--ylink-motion-ease);
}

.history-summary-card:hover,
.history-filter-card:hover,
.history-table-shell:hover {
  box-shadow: 0 14px 28px -32px rgba(15, 23, 42, 0.16);
}

.history-summary-card:hover {
  transform: translateY(-1px);
}

.history-summary-card-enter-active {
  transition:
    opacity var(--ylink-motion-normal) var(--ylink-motion-ease),
    transform var(--ylink-motion-normal) var(--ylink-motion-ease);
  transition-delay: var(--history-card-delay, 0ms);
}

.history-summary-card-enter-from {
  opacity: 0;
  transform: translateY(8px);
}

.history-summary-card__badge {
  display: inline-flex;
  min-width: 3.1rem;
  align-items: center;
  justify-content: center;
  border-radius: 1rem;
  padding: 0.72rem 0.88rem;
  font-size: 0.95rem;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.history-filter-card__toolbar {
  min-width: 0;
}

.history-filter-card__input {
  min-width: 14rem;
}

.history-filter-card__delete-state {
  min-width: 9rem;
}

.history-filter-card__submit {
  min-width: 4.25rem;
}

.history-filter-card__sync {
  min-height: 1.25rem;
}

.history-filter-card__tabs {
  display: flex;
  flex-wrap: nowrap;
  gap: 0.45rem;
  max-width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  white-space: nowrap;
  scrollbar-width: none;
}

.history-filter-card__tabs::-webkit-scrollbar {
  display: none;
}

.history-filter-card__tabs :deep(.el-radio-button) {
  flex: 0 0 auto;
}

.history-filter-card__tabs :deep(.el-radio-button__inner) {
  border-radius: 999px;
  border-left: var(--el-border) !important;
  transition:
    background-color var(--ylink-motion-fast) var(--ylink-motion-ease),
    border-color var(--ylink-motion-fast) var(--ylink-motion-ease),
    color var(--ylink-motion-fast) var(--ylink-motion-ease);
}

.history-filter-card__tabs :deep(.el-radio-button:first-child .el-radio-button__inner),
.history-filter-card__tabs :deep(.el-radio-button:last-child .el-radio-button__inner) {
  border-radius: 999px;
}

.history-table-shell__header {
  background: linear-gradient(180deg, rgba(248, 250, 252, 0.9), rgba(255, 255, 255, 0.94));
}

.history-table-shell__table {
  min-height: 520px;
}

.history-table-shell__table :deep(.el-table__row > .el-table__cell) {
  transition:
    background-color var(--ylink-motion-fast) var(--ylink-motion-ease),
    color var(--ylink-motion-fast) var(--ylink-motion-ease);
}

.history-table-shell__table :deep(.el-table__row:hover > .el-table__cell) {
  background-color: rgba(20, 184, 166, 0.06) !important;
}

.history-table-shell__actions {
  min-width: 0;
}

.history-table-refresh-enter-active,
.history-table-refresh-leave-active {
  transition:
    opacity var(--ylink-motion-fast) var(--ylink-motion-ease),
    transform var(--ylink-motion-fast) var(--ylink-motion-ease);
}

.history-table-refresh-enter-from {
  opacity: 0;
  transform: translateY(5px);
}

.history-table-refresh-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

.history-detail-button {
  transition:
    opacity var(--ylink-motion-fast) var(--ylink-motion-ease),
    transform var(--ylink-motion-fast) var(--ylink-motion-ease);
}

.history-detail-button:hover {
  opacity: 0.88;
  transform: translateY(-1px);
}

/* 当前页详情抽屉样式：
 * - 页面内部不再负责主滚动，只保留最小高度与内容分区视觉；
 * - 真正的滚动职责已收敛到通用抽屉壳，避免再次形成双滚动。
 */
.supplier-history-detail-panel {
  min-height: 200px;
}

.history-detail-hero {
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(248, 250, 252, 0.94));
}

.history-detail-hero__actions {
  max-width: 100%;
}

.history-detail-item:hover {
  border-color: rgba(148, 163, 184, 0.46);
}

.history-detail-item__index {
  display: inline-flex;
  height: 1.9rem;
  width: 1.9rem;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.9);
  font-size: 0.78rem;
  font-weight: 600;
  color: rgb(100 116 139);
}

/* 详情面板内容分段入场动效，避免信息一次性突兀出现。 */
.history-detail-fade-enter-active,
.history-detail-fade-leave-active {
  transition:
    transform var(--ylink-motion-fast) var(--ylink-motion-ease),
    opacity var(--ylink-motion-fast) var(--ylink-motion-ease);
}

.history-detail-fade-enter-from,
.history-detail-fade-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

@media (max-width: 767px) {
  .history-summary-card,
  .history-filter-card,
  .history-table-shell {
    border-radius: 1.5rem;
  }

  .history-filter-card__input,
  .history-filter-card__delete-state,
  .history-filter-card__submit {
    width: 100%;
    min-width: 0;
  }

  .history-filter-card__submit {
    justify-content: center;
  }

  .history-detail-hero__actions {
    width: 100%;
  }

  .history-table-shell__table {
    min-height: 430px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .history-summary-card,
  .history-filter-card,
  .history-table-shell,
  .history-detail-hero,
  .history-detail-item,
  .history-detail-button,
  .history-summary-card-enter-active,
  .history-table-refresh-enter-active,
  .history-table-refresh-leave-active,
  .history-detail-fade-enter-active,
  .history-detail-fade-leave-active {
    transition: none;
  }

  .history-summary-card:hover,
  .history-detail-button:hover,
  .history-summary-card-enter-from,
  .history-table-refresh-enter-from,
  .history-table-refresh-leave-to,
  .history-detail-fade-enter-from,
  .history-detail-fade-leave-to {
    transform: none;
  }
}
</style>
