<script setup lang="ts">
/**
 * 模块说明：src/views/client/ClientOrderDetailView.vue
 * 文件职责：承载客户端订单详情展示、进度查看、二维码展示、订单撤回与退货申请。
 * 实现逻辑：
 * - 详情页加载成功后会同步刷新订单摘要缓存，方便返回列表页时立即看到最新状态；
 * - 订单 Store 初始化按当前客户端账号执行，避免共享终端切换账号后把旧订单摘要带入新账号上下文。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */


import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import QRCode from 'qrcode'
import {
  cancelMyO2oPreorder,
  getO2oMallProducts,
  getO2oPreorderDetail,
  submitO2oReturnRequest,
  updateMyO2oPreorder,
  type O2oMallProduct,
  type O2oPreorderDetail,
  type O2oPreorderSummary,
  type O2oReturnRequestDetail,
} from '@/api/modules/o2o'
import type { OrderDetailResult } from '@/api/modules/order'
import { BaseRequestState } from '@/components/common'
import { useStableRequest } from '@/composables/useStableRequest'
import {
  CLIENT_O2O_ORDER_STATUS_LABEL_MAP,
  getO2oOrderBusinessStatusMeta,
  getClientOrderStatusReportConfig,
  getClientOrderReportScenario,
  isO2oOrderCancelled,
  isO2oOrderPending,
  isO2oOrderVerified,
} from '@/constants/o2o-order-status'
import { useClientAuthStore, useClientOrderStore } from '@/store'
import { normalizeRequestError } from '@/utils/error'
import { exportVoucherPdf } from '@/utils/pdf/export-voucher-pdf'
import OrderVoucherTemplate from '@/views/order-list/components/OrderVoucherTemplate.vue'

const O2O_RETURN_REASON_MAX_LENGTH = 500
const O2O_PREORDER_REMARK_MAX_LENGTH = 255
const ORDER_TYPE_LABEL_MAP = {
  department: '部门订',
  walkin: '散客',
} as const

interface EditableOrderItem {
  productId: string
  productCode: string
  productName: string
  defaultPrice: string
  qty: number
  originalQty: number
  maxQty: number
  unavailableReason: string | null
}

interface OrderVoucherEditableFields {
  departmentOperator: string
  kingdeeVoucherNo: string
  receiverSignature: string
  issuerSignature: string
  completionSignature: string
}

type VoucherOrientation = 'portrait' | 'landscape'

const createEmptyVoucherEditableFields = (): OrderVoucherEditableFields => ({
  departmentOperator: '',
  kingdeeVoucherNo: '',
  receiverSignature: '',
  issuerSignature: '',
  completionSignature: '',
})

const route = useRoute()
const router = useRouter()

const loading = ref(false)
const recalling = ref(false)
const editDialogVisible = ref(false)
const editSubmitting = ref(false)
const editProductsLoading = ref(false)
const returnDialogVisible = ref(false)
const returnSubmitting = ref(false)
const detail = ref<O2oPreorderDetail | null>(null)
const qrDataUrl = ref('')
const returnQrMap = ref<Record<string, string>>({})
const mallProducts = ref<O2oMallProduct[]>([])
const editOrderItems = ref<EditableOrderItem[]>([])
const editRemark = ref('')
const editAddProductId = ref('')
const returnReason = ref('')
const returnQtyMap = ref<Record<string, number>>({})
const requestError = ref<{ type: 'offline' | 'error'; message: string } | null>(null)
const voucherDialogVisible = ref(false)
const voucherPrintRootRef = ref<HTMLElement | null>(null)
const exportPdfLoading = ref(false)
const voucherOrientation = ref<VoucherOrientation>('landscape')
const enableHtml2pdfExport = import.meta.env.VITE_ORDER_VOUCHER_HTML2PDF_ENABLED !== 'false'
const voucherEditableForm = reactive<OrderVoucherEditableFields>(createEmptyVoucherEditableFields())
const { runLatest } = useStableRequest()
const clientAuthStore = useClientAuthStore()
const clientOrderStore = useClientOrderStore()
clientOrderStore.initialize(clientAuthStore.currentUser?.id)

const currentReportScenario = computed(() => {
  if (!detail.value) {
    return 'pending'
  }
  if (detail.value.order.statusReport?.scenario) {
    return detail.value.order.statusReport.scenario
  }
  return getClientOrderReportScenario(detail.value.order.status, detail.value.order.timeoutAt)
})

const statusLabel = computed(() => {
  if (!detail.value) {
    return '待取货'
  }
  return getClientOrderStatusReportConfig({
    statusReport: detail.value.order.statusReport,
    status: detail.value.order.status,
    timeoutAt: detail.value.order.timeoutAt,
  }).statusLabel
})

const getOrderStatusLabel = (status: O2oPreorderSummary['status']) => {
  return CLIENT_O2O_ORDER_STATUS_LABEL_MAP[status] ?? '未知状态'
}

// 详细注释：退货申请已扩展为 pending、verified、rejected 三态。
// pending 表示门店尚未处理，verified 表示门店已完成回库核销，rejected 表示门店已明确拒绝并记录原因。
const getReturnRequestStatusMeta = (request: O2oReturnRequestDetail) => {
  if (request.status === 'verified') {
    return {
      label: '退货已完成',
      className: 'bg-emerald-50 text-emerald-700',
      description: '门店已完成退货核销，本次退货流程已闭环。',
      qrHint: '退货二维码已完成核销，仅保留记录供你查询。',
    }
  }
  if (request.status === 'rejected') {
    return {
      label: '退货已拒绝',
      className: 'bg-rose-50 text-rose-700',
      description: '门店已拒绝本次退货申请，请查看拒绝原因后再决定是否联系门店处理。',
      qrHint: '退货申请已被拒绝，退货二维码已停用。',
    }
  }
  return {
    label: '待门店核销',
    className: 'bg-amber-50 text-amber-700',
    description: '请携带商品与退货码到店，由门店扫码完成退货核销。',
    qrHint: '到店后向门店出示该二维码或退货码即可办理退货。',
  }
}

// 详细注释：返回上一页。使用 vue-router 的 back 方法，如果不支持则由浏览器处理回退历史。
const handleBack = () => {
  router.back()
}

const statusBanner = computed(() => {
  const report = detail.value
    ? getClientOrderStatusReportConfig({
        statusReport: detail.value.order.statusReport,
        status: detail.value.order.status,
        timeoutAt: detail.value.order.timeoutAt,
      })
    : getClientOrderStatusReportConfig({
        status: 'pending',
        timeoutAt: null,
      })
  return { className: report.cardClassName, title: report.cardTitle, description: report.cardDescription }
})

const businessStatusMeta = computed(() => {
  return getO2oOrderBusinessStatusMeta(detail.value?.order.businessStatus)
})

const merchantMessageContent = computed(() => {
  const value = detail.value?.order.merchantMessage ?? null
  if (!value) {
    return null
  }
  const normalizedValue = value.trim()
  return normalizedValue || null
})

const orderTypeLabel = computed(() => {
  return detail.value ? ORDER_TYPE_LABEL_MAP[detail.value.order.clientOrderType] : '散客'
})

const voucherOrientationLabel = computed(() => (voucherOrientation.value === 'landscape' ? '横版' : '竖版'))

const toVoucherMoneyText = (value: string | number | null | undefined) => {
  const normalizedValue = Number(value ?? 0)
  return Number.isFinite(normalizedValue) ? normalizedValue.toFixed(2) : '0.00'
}

/**
 * 订单详情到正式出库单模板的适配层：
 * - 客户端 O2O 订单结构与管理端出库单结构不同，这里统一映射为模板所需字段；
 * - 缺失字段提供安全兜底，确保任意订单状态都能稳定预览/打印。
 */
const voucherOrder = computed<OrderDetailResult | null>(() => {
  if (!detail.value) {
    return null
  }
  const { order, items, customerProfile } = detail.value
  const normalizedTotalAmount = toVoucherMoneyText(order.totalAmount ?? totalAmount.value)
  return {
    id: order.id,
    showNo: order.showNo,
    orderType: order.clientOrderType,
    hasCustomerOrder: order.clientOrderType === 'department',
    isSystemApplied: false,
    issuerName: '门店值班人员',
    customerDepartmentName: order.departmentNameSnapshot || customerProfile?.departmentName || null,
    customerName: customerProfile?.username || null,
    totalAmount: normalizedTotalAmount,
    totalQty: String(order.totalQty ?? 0),
    status: order.status,
    remark: order.remark,
    creatorUserId: customerProfile?.id || null,
    creatorUsername: customerProfile?.username || null,
    creatorDisplayName: customerProfile?.username || null,
    isDeleted: false,
    deletedAt: null,
    deletedByUserId: null,
    deletedByUsername: null,
    deletedByDisplayName: null,
    createdAt: order.createdAt,
    items: items.map((item) => {
      const unitPrice = toVoucherMoneyText(item.defaultPrice)
      const subTotal = toVoucherMoneyText(item.subTotal ?? Number(unitPrice) * Number(item.qty ?? 0))
      return {
        id: item.id,
        productId: item.productId,
        productCode: item.productCode,
        productName: item.productName,
        qty: String(item.qty),
        unitPrice,
        subTotal,
        remark: null,
      }
    }),
  }
})

const timelineItems = computed(() => {
  if (!detail.value) {
    return []
  }
  const order = detail.value.order
  const nowMs = Date.now()
  const report = getClientOrderStatusReportConfig({
    statusReport: order.statusReport,
    status: order.status,
    timeoutAt: order.timeoutAt,
  }, nowMs)
  const cancelledByTimeout = currentReportScenario.value === 'timeout_cancelled'

  if (isO2oOrderVerified(order.status)) {
    return [
      { key: 'created', title: '已下单', time: order.createdAt, active: true },
      { key: 'prepare', title: '备货完成', time: order.timeoutAt || '门店已备货', active: true },
      { key: 'verify', title: '已核销', time: order.verifiedAt || '核销成功', active: true },
      { key: 'done', title: '订单完成', time: order.verifiedAt || '已完成', active: true },
    ]
  }

  if (isO2oOrderCancelled(order.status)) {
    return [
      { key: 'created', title: '已下单', time: order.createdAt, active: true },
      { key: 'prepare', title: '备货中', time: order.timeoutAt || '门店处理中', active: !cancelledByTimeout },
      {
        key: 'cancelled',
        title: report.timelineCurrentTitle,
        time: order.timeoutAt || '已取消',
        active: true,
      },
      {
        key: 'closed',
        title: '订单关闭',
        time: report.timelineCurrentHint,
        active: true,
      },
    ]
  }

  return [
    { key: 'created', title: '已下单', time: order.createdAt, active: true },
    {
      key: 'prepare',
      title: '备货中',
      time: order.timeoutAt || '按门店通知准备',
      active: true,
    },
    {
      key: 'pending',
      title: report.timelineCurrentTitle,
      time: order.timeoutAt || report.timelineCurrentHint,
      active: true,
    },
    {
      key: 'future',
      title: '核销后完成订单',
      time: '待完成',
      active: false,
    },
  ]
})

const totalAmount = computed(() => {
  if (!detail.value) {
    return 0
  }
  return detail.value.items.reduce((sum, item) => {
    return sum + Math.max(0, Number(item.defaultPrice || 0)) * item.qty
  }, 0)
})

const displayVerifyCode = computed(() => {
  if (!canUseQrCode.value) {
    return '已停用'
  }
  const rawCode = detail.value?.order.verifyCode ?? ''
  if (!rawCode) {
    return ''
  }
  return rawCode
    .replaceAll('-', '')
    .toUpperCase()
    .replaceAll(/(.{4})/g, '$1 ')
    .trim()
})

const formatDisplayCode = (rawCode: string) => {
  return rawCode
    .replaceAll('-', '')
    .toUpperCase()
    .replaceAll(/(.{4})/g, '$1 ')
    .trim()
}

const canRecallOrder = computed(() => {
  return isO2oOrderPending(detail.value?.order.status)
})

const shouldShowModifyOrderButton = computed(() => {
  return isO2oOrderPending(detail.value?.order.status)
})

const canModifyOrder = computed(() => {
  if (!detail.value || !isO2oOrderPending(detail.value.order.status)) {
    return false
  }
  return Math.max(0, Number(detail.value.order.remainingUpdateCount ?? 0)) > 0
})

const modifyOrderQuotaText = computed(() => {
  if (!detail.value) {
    return '订单最多可修改 3 次'
  }
  return `已修改 ${detail.value.order.updateCount} / ${detail.value.order.maxUpdateCount} 次，剩余 ${detail.value.order.remainingUpdateCount} 次`
})

const modifyOrderDisabledHint = computed(() => {
  if (!detail.value) {
    return '当前订单不可修改'
  }
  if (!isO2oOrderPending(detail.value.order.status)) {
    return '当前订单状态不可修改'
  }
  if (detail.value.order.remainingUpdateCount <= 0) {
    return `本订单最多仅可修改 ${detail.value.order.maxUpdateCount} 次`
  }
  return ''
})

const shouldShowReturnSection = computed(() => {
  return isO2oOrderVerified(detail.value?.order.status)
})

const canApplyReturn = computed(() => {
  if (!detail.value || !shouldShowReturnSection.value) {
    return false
  }
  if (isO2oOrderCancelled(detail.value.order.status)) {
    return false
  }
  return detail.value.items.some((item) => item.availableReturnQty > 0)
})

const pendingReturnRequests = computed(() => {
  return (detail.value?.returnRequests ?? []).filter((item) => item.status === 'pending')
})

const hasReturnRequests = computed(() => {
  return (detail.value?.returnRequests?.length ?? 0) > 0
})

const returnRequestStats = computed(() => {
  const requests = detail.value?.returnRequests ?? []
  return {
    totalCount: requests.length,
    totalQty: requests.reduce((sum, item) => sum + item.totalQty, 0),
    pendingCount: requests.filter((item) => item.status === 'pending').length,
    pendingQty: requests
      .filter((item) => item.status === 'pending')
      .reduce((sum, item) => sum + item.totalQty, 0),
    verifiedCount: requests.filter((item) => item.status === 'verified').length,
  }
})

const returnableItemCount = computed(() => {
  return detail.value?.items.filter((item) => item.availableReturnQty > 0).length ?? 0
})

const selectedReturnItems = computed(() => {
  if (!detail.value) {
    return []
  }
  return detail.value.items
    .map((item) => ({
      ...item,
      selectedQty: Math.max(0, Math.min(item.availableReturnQty, Number(returnQtyMap.value[item.productId] ?? 0))),
    }))
    .filter((item) => item.selectedQty > 0)
})

const selectedReturnTotalQty = computed(() => {
  return selectedReturnItems.value.reduce((sum, item) => sum + item.selectedQty, 0)
})

const canSubmitReturnRequest = computed(() => {
  return selectedReturnItems.value.length > 0 && returnReason.value.trim().length > 0
})

const editableOrderTotalQty = computed(() => {
  return editOrderItems.value.reduce((sum, item) => sum + item.qty, 0)
})

const editableOrderTotalAmount = computed(() => {
  return editOrderItems.value.reduce((sum, item) => sum + Math.max(0, Number(item.defaultPrice || 0)) * item.qty, 0)
})

const editableProductOptions = computed(() => {
  const selectedProductIdSet = new Set(editOrderItems.value.map((item) => item.productId))
  return mallProducts.value.filter((item) => !selectedProductIdSet.has(item.id))
})

const canSubmitOrderEdit = computed(() => {
  return editableOrderTotalQty.value > 0 && canModifyOrder.value && !editSubmitting.value
})

const canUseQrCode = computed(() => {
  return isO2oOrderPending(detail.value?.order.status)
})

const qrDisabledHint = computed(() => {
  if (!detail.value) {
    return '当前订单二维码暂不可用'
  }
  if (detail.value.order.status === 'verified') {
    return '订单已核销完成，二维码与取货码已停用'
  }
  if (detail.value.order.statusReport?.cancelReason === 'manual') {
    return '订单已撤回，二维码与取货码已停用'
  }
  if (currentReportScenario.value === 'timeout_cancelled') {
    return '订单已超时取消，二维码与取货码已停用'
  }
  return '当前订单二维码暂不可用'
})

const buildOrderSummaryFromDetail = (nextDetail: O2oPreorderDetail): O2oPreorderSummary => {
  const { order } = nextDetail
  return {
    id: order.id,
    showNo: order.showNo,
    verifyCode: order.verifyCode,
    status: order.status,
    businessStatus: order.businessStatus,
    merchantMessage: order.merchantMessage,
    clientOrderType: order.clientOrderType,
    departmentNameSnapshot: order.departmentNameSnapshot,
    returnRequestCount: nextDetail.returnRequests.length,
    pendingReturnRequestCount: nextDetail.returnRequests.filter((item) => item.status === 'pending').length,
    latestReturnRequest: nextDetail.returnRequests.length
      ? nextDetail.returnRequests
          .slice()
          .sort((prev, next) => new Date(next.createdAt).getTime() - new Date(prev.createdAt).getTime())[0]
      : null,
    statusReport: order.statusReport,
    totalAmount: order.totalAmount,
    expireInSeconds: order.expireInSeconds,
    totalQty: order.totalQty,
    timeoutAt: order.timeoutAt,
    createdAt: order.createdAt,
  }
}

const toEditableItemMaxQty = (product: O2oMallProduct, originalQty = 0) => {
  return Math.max(0, Number(product.availableStock ?? 0) + originalQty)
}

const buildEditableItemsFromDetail = (nextDetail: O2oPreorderDetail) => {
  const productMap = new Map(mallProducts.value.map((item) => [item.id, item]))
  return nextDetail.items.map((item) => {
    const product = productMap.get(item.productId)
    const maxQty = product ? toEditableItemMaxQty(product, item.qty) : item.qty
    const unavailableReason = product
      ? null
      : '当前商品已不在可售目录中，仅支持减少或删除原有数量'
    return {
      productId: item.productId,
      productCode: item.productCode,
      productName: item.productName,
      defaultPrice: item.defaultPrice,
      qty: item.qty,
      originalQty: item.qty,
      maxQty,
      unavailableReason,
    } satisfies EditableOrderItem
  })
}

const resetEditForm = () => {
  editRemark.value = detail.value?.order.remark ?? ''
  editAddProductId.value = ''
  editOrderItems.value = detail.value ? buildEditableItemsFromDetail(detail.value) : []
}

const resetReturnForm = () => {
  returnReason.value = ''
  returnQtyMap.value = {}
}

const updateEditItemQty = (productId: string, value: number | null | undefined) => {
  editOrderItems.value = editOrderItems.value.map((item) => {
    if (item.productId !== productId) {
      return item
    }
    const normalizedQty = Math.max(0, Math.min(item.maxQty, Math.floor(Number(value ?? 0))))
    return {
      ...item,
      qty: normalizedQty,
    }
  })
}

const removeEditItem = (productId: string) => {
  editOrderItems.value = editOrderItems.value.filter((item) => item.productId !== productId)
}

const addEditProduct = () => {
  const productId = editAddProductId.value.trim()
  if (!productId) {
    ElMessage.warning('请先选择要加入订单的商品')
    return
  }
  if (editOrderItems.value.some((item) => item.productId === productId)) {
    ElMessage.warning('该商品已在当前订单中')
    return
  }
  const product = mallProducts.value.find((item) => item.id === productId)
  if (!product) {
    ElMessage.warning('未找到可加入的商品')
    return
  }
  const maxQty = toEditableItemMaxQty(product, 0)
  if (maxQty <= 0) {
    ElMessage.warning('该商品当前库存不足，暂不可加入订单')
    return
  }
  editOrderItems.value = [
    ...editOrderItems.value,
    {
      productId: product.id,
      productCode: product.productCode,
      productName: product.productName,
      defaultPrice: product.defaultPrice,
      qty: 1,
      originalQty: 0,
      maxQty,
      unavailableReason: null,
    },
  ]
  editAddProductId.value = ''
}

const updateReturnQty = (productId: string, value: number | undefined, maxQty: number) => {
  const nextQty = Math.max(0, Math.min(maxQty, Math.floor(Number(value ?? 0))))
  if (nextQty <= 0) {
    const nextQtyMap = { ...returnQtyMap.value }
    delete nextQtyMap[productId]
    returnQtyMap.value = nextQtyMap
    return
  }
  returnQtyMap.value = {
    ...returnQtyMap.value,
    [productId]: nextQty,
  }
}

// 详细注释：Element Plus 的数字输入框在清空、回填和边界切换时可能抛出 undefined / null，
// 这里统一先做一次前置归一化，再复用既有数量更新逻辑，避免模板事件参数退化成隐式 any。
const handleReturnQtyChange = (
  productId: string,
  maxQty: number,
  value: number | null | undefined,
) => {
  updateReturnQty(productId, value ?? undefined, maxQty)
}

const renderQrCode = async () => {
  // 二维码仅允许待提货订单展示，撤回、超时取消、已核销后立即切换为禁用态。
  if (!detail.value?.qrPayload || !canUseQrCode.value) {
    qrDataUrl.value = ''
    return
  }

  qrDataUrl.value = await QRCode.toDataURL(detail.value.qrPayload, {
    width: 260,
    margin: 1,
    color: {
      dark: '#0f172a',
      light: '#ffffff',
    },
  })
}

const renderReturnRequestQrs = async () => {
  // 退货二维码仅在 pending 阶段展示；进入 verified 后仅保留记录，不再展示可用二维码。
  const nextQrMap: Record<string, string> = {}
  const returnRequests = detail.value?.returnRequests ?? []
  for (const request of returnRequests) {
    if (request.status !== 'pending' || !request.qrPayload) {
      continue
    }
    nextQrMap[request.id] = await QRCode.toDataURL(request.qrPayload, {
      width: 220,
      margin: 1,
      color: {
        dark: '#0f172a',
        light: '#ffffff',
      },
    })
  }
  returnQrMap.value = nextQrMap
}

const loadMallProducts = async () => {
  if (mallProducts.value.length || editProductsLoading.value) {
    return
  }
  editProductsLoading.value = true
  try {
    mallProducts.value = await getO2oMallProducts()
  } catch (error) {
    const normalizedError = normalizeRequestError(error, '可修改商品加载失败')
    ElMessage.error(normalizedError.message)
  } finally {
    editProductsLoading.value = false
  }
}

const syncOrderStoreFromDetail = (nextDetail: O2oPreorderDetail) => {
  clientOrderStore.upsertOrder(buildOrderSummaryFromDetail(nextDetail))
}

const VOUCHER_PRINT_STYLE_ID = 'y-link-client-order-voucher-print-page-style'

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

const handleOpenVoucherDialog = () => {
  if (!voucherOrder.value) {
    ElMessage.warning('当前订单暂无可打印内容')
    return
  }
  voucherOrientation.value = 'landscape'
  voucherDialogVisible.value = true
}

const handlePrintVoucher = async () => {
  if (!voucherOrder.value) {
    ElMessage.warning('当前订单暂无可打印内容')
    return
  }
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

const handleExportVoucherPdf = async () => {
  if (!enableHtml2pdfExport) {
    ElMessage.info('PDF 导出开关未启用，当前仅支持打印')
    return
  }
  if (!voucherOrder.value) {
    ElMessage.warning('当前订单暂无可导出的凭证')
    return
  }
  const sourceElement = voucherPrintRootRef.value?.querySelector('.voucher-print-document')
  if (!(sourceElement instanceof HTMLElement)) {
    ElMessage.warning('凭证模板尚未准备完成，请稍后重试')
    return
  }
  exportPdfLoading.value = true
  try {
    await exportVoucherPdf({
      sourceElement,
      filename: `${voucherOrder.value.showNo || 'client-order'}-正式出库单.pdf`,
      marginMm: 8,
      scale: 2,
      orientation: voucherOrientation.value,
    })
    ElMessage.success('PDF 导出成功')
  } catch (error) {
    const normalizedError = normalizeRequestError(error, 'PDF 导出失败，请稍后重试')
    ElMessage.error(normalizedError.message)
  } finally {
    exportPdfLoading.value = false
  }
}

const loadDetail = async () => {
  const orderId = String(route.params.id ?? '').trim()
  if (!orderId) {
    return
  }

  loading.value = true
  requestError.value = null
  await runLatest({
    executor: (signal) => getO2oPreorderDetail(orderId, { signal }),
    onSuccess: async (result) => {
      detail.value = result
      syncOrderStoreFromDetail(result)
      await renderQrCode()
      await renderReturnRequestQrs()
    },
    onError: (error) => {
      const normalizedError = normalizeRequestError(error, '订单详情加载失败')
      requestError.value = {
        type: globalThis.navigator.onLine === false ? 'offline' : 'error',
        message: normalizedError.message,
      }
    },
    onFinally: () => {
      loading.value = false
    },
  })
}

// 详细注释：撤回订单操作，弹出二次确认，调用接口后刷新本地状态及二维码。
const handleRecallOrder = async () => {
  if (!detail.value) {
    return
  }
  if (!canRecallOrder.value) {
    ElMessage.warning('当前订单状态不可撤回')
    return
  }

  try {
    await ElMessageBox.confirm(
      `确认撤回订单“${detail.value.order.showNo}”吗？撤回后将释放预订库存，二维码会立即失效。`,
      '撤回订单',
      {
        type: 'warning',
        confirmButtonText: '确认撤回',
        cancelButtonText: '再想想',
        closeOnClickModal: false,
      },
    )
  } catch (error) {
    if (error === 'cancel' || error === 'close') {
      return
    }
    ElMessage.error('撤回确认失败，请稍后重试')
    return
  }

  recalling.value = true
  try {
    const nextDetail = await cancelMyO2oPreorder(detail.value.order.id)
    detail.value = nextDetail
    syncOrderStoreFromDetail(nextDetail)
    await renderQrCode()
    await renderReturnRequestQrs()
    ElMessage.success('订单已撤回')
  } catch (error) {
    const normalizedError = normalizeRequestError(error, '撤回订单失败')
    ElMessage.error(normalizedError.message)
  } finally {
    recalling.value = false
  }
}

const openEditDialog = async () => {
  if (!detail.value) {
    ElMessage.warning('当前订单不可修改')
    return
  }
  if (!canModifyOrder.value) {
    ElMessage.warning(modifyOrderDisabledHint.value || '当前订单不可修改')
    return
  }
  await loadMallProducts()
  resetEditForm()
  editDialogVisible.value = true
}

const handleEditDialogClosed = () => {
  resetEditForm()
}

const handleSubmitOrderEdit = async () => {
  if (!detail.value) {
    return
  }
  if (!canModifyOrder.value) {
    ElMessage.warning(modifyOrderDisabledHint.value || '当前订单不可修改')
    return
  }
  const normalizedItems = editOrderItems.value
    .map((item) => ({
      productId: item.productId,
      productName: item.productName,
      qty: Math.max(0, Math.floor(Number(item.qty ?? 0))),
    }))
    .filter((item) => item.qty > 0)
  if (!normalizedItems.length) {
    ElMessage.warning('订单至少保留一件商品')
    return
  }
  if (editRemark.value.trim().length > O2O_PREORDER_REMARK_MAX_LENGTH) {
    ElMessage.warning(`订单备注最多 ${O2O_PREORDER_REMARK_MAX_LENGTH} 个字符`)
    return
  }

  try {
    await ElMessageBox.confirm(
      `确认修改订单“${detail.value.order.showNo}”吗？保存后将按最新商品和数量重算预订库存。`,
      '修改订单',
      {
        type: 'warning',
        confirmButtonText: '确认保存',
        cancelButtonText: '取消',
        closeOnClickModal: false,
      },
    )
  } catch (error) {
    if (error === 'cancel' || error === 'close') {
      return
    }
    ElMessage.error('改单确认失败，请稍后重试')
    return
  }

  editSubmitting.value = true
  try {
    const nextDetail = await updateMyO2oPreorder(detail.value.order.id, {
      remark: editRemark.value.trim() || undefined,
      items: normalizedItems.map((item) => ({
        productId: item.productId,
        qty: item.qty,
      })),
    })
    detail.value = nextDetail
    syncOrderStoreFromDetail(nextDetail)
    await renderQrCode()
    await renderReturnRequestQrs()
    editDialogVisible.value = false
    ElMessage.success('订单修改成功')
  } catch (error) {
    const normalizedError = normalizeRequestError(error, '订单修改失败')
    ElMessage.error(normalizedError.message)
  } finally {
    editSubmitting.value = false
  }
}

const openReturnDialog = () => {
  if (!canApplyReturn.value) {
    ElMessage.warning('当前订单暂无可申请退货的商品')
    return
  }
  resetReturnForm()
  returnDialogVisible.value = true
}

const handleReturnDialogClosed = () => {
  resetReturnForm()
}

const handleSubmitReturnRequest = async () => {
  if (!detail.value) {
    return
  }
  if (!canApplyReturn.value) {
    ElMessage.warning('当前订单不可申请退货')
    return
  }
  if (!selectedReturnItems.value.length) {
    ElMessage.warning('请至少选择一件商品并填写退货数量')
    return
  }
  const normalizedReason = returnReason.value.trim()
  if (!normalizedReason) {
    ElMessage.warning('请填写退货原因')
    return
  }

  try {
    await ElMessageBox.confirm(
      `确认提交退货申请吗？本次共申请 ${selectedReturnTotalQty.value} 件商品退货，提交后会生成门店核销二维码。`,
      '提交退货申请',
      {
        type: 'warning',
        confirmButtonText: '确认提交',
        cancelButtonText: '取消',
        closeOnClickModal: false,
      },
    )
  } catch (error) {
    if (error === 'cancel' || error === 'close') {
      return
    }
    ElMessage.error('退货申请确认失败，请稍后重试')
    return
  }

  returnSubmitting.value = true
  try {
    const createdReturnRequest = await submitO2oReturnRequest(detail.value.order.id, {
      reason: normalizedReason,
      items: selectedReturnItems.value.map((item) => ({
        productId: item.productId,
        qty: item.selectedQty,
      })),
    })
    await loadDetail()
    returnDialogVisible.value = false
    ElMessage.success(`退货申请已提交，退货单号：${createdReturnRequest.returnNo}`)
  } catch (error) {
    const normalizedError = normalizeRequestError(error, '提交退货申请失败')
    ElMessage.error(normalizedError.message)
  } finally {
    returnSubmitting.value = false
  }
}

watch(
  () => route.params.id,
  async () => {
    await loadDetail()
  },
)

onMounted(async () => {
  await loadDetail()
})
</script>

<template>
  <section class="order-detail-page">
    <button
      type="button"
      class="order-back-floating inline-flex h-10 w-10 items-center justify-center rounded-full bg-white text-slate-700 shadow-[var(--ylink-shadow-soft)]"
      @click="handleBack"
    >
      <el-icon :size="18"><ArrowLeft /></el-icon>
    </button>

    <div v-if="loading" class="grid gap-3 rounded-[1.4rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
      <div v-for="index in 5" :key="index" class="h-[6.2rem] animate-pulse rounded-2xl bg-slate-100" />
    </div>
    <BaseRequestState
      v-else-if="requestError"
      :type="requestError.type"
      :title="requestError.type === 'offline' ? '网络不可用' : '订单详情加载失败'"
      :description="requestError.message"
      action-text="重试"
      @retry="loadDetail"
    />

    <section v-else-if="detail" class="grid gap-4 lg:grid-cols-[24rem_minmax(0,1fr)]">
      <aside class="rounded-[1.3rem] bg-white p-5 shadow-[var(--ylink-shadow-soft)]">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div class="flex flex-wrap items-center gap-2">
              <p class="text-lg font-semibold text-slate-900">{{ detail.order.showNo }}</p>
              <span class="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">{{ orderTypeLabel }}</span>
            </div>
            <p class="mt-1 text-sm text-slate-400">状态：{{ statusLabel }}</p>
          </div>
          <div class="flex flex-wrap gap-2">
            <button
              type="button"
              class="rounded-full border border-teal-200 px-4 py-2 text-sm font-medium text-teal-700 transition hover:bg-teal-50"
              @click="handleOpenVoucherDialog"
            >
              正式出库单
            </button>
            <button
              v-if="shouldShowModifyOrderButton"
              type="button"
              class="rounded-full border border-teal-200 px-4 py-2 text-sm font-medium text-teal-700 transition hover:bg-teal-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
              :disabled="editSubmitting || !canModifyOrder"
              @click="openEditDialog"
            >
              {{ editSubmitting ? '保存中...' : canModifyOrder ? '修改订单' : '修改次数已用完' }}
            </button>
            <button
              v-if="canRecallOrder"
              type="button"
              class="rounded-full border border-rose-200 px-4 py-2 text-sm font-medium text-rose-600 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
              :disabled="recalling"
              @click="handleRecallOrder"
            >
              {{ recalling ? '撤回中...' : '撤回订单' }}
            </button>
          </div>
        </div>
        <p
          v-if="shouldShowModifyOrderButton"
          class="mt-3 text-xs"
          :class="canModifyOrder ? 'text-slate-400' : 'text-amber-600'"
        >
          {{ canModifyOrder ? modifyOrderQuotaText : modifyOrderDisabledHint }}
        </p>
        <div class="mt-3 rounded-2xl px-3 py-2" :class="statusBanner.className">
          <p class="text-sm font-semibold">{{ statusBanner.title }}</p>
          <p class="mt-1 text-xs">{{ statusBanner.description }}</p>
        </div>
        <div v-if="businessStatusMeta" class="mt-3 rounded-2xl px-3 py-2" :class="businessStatusMeta.className">
          <p class="text-sm font-semibold">商家状态：{{ businessStatusMeta.label }}</p>
          <p class="mt-1 text-xs">{{ businessStatusMeta.clientDescription }}</p>
        </div>

        <div class="mt-5 rounded-3xl bg-slate-50 p-4 text-center">
          <img
            v-if="canUseQrCode && qrDataUrl"
            :src="qrDataUrl"
            alt="预订单二维码"
            class="mx-auto h-64 w-64 rounded-2xl bg-white p-3 shadow-sm"
          />
          <div
            v-else
            class="mx-auto flex h-64 w-64 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-white px-6 text-center"
          >
            <p class="text-sm font-semibold text-slate-700">二维码已停用</p>
            <p class="mt-2 text-xs leading-5 text-slate-400">{{ qrDisabledHint }}</p>
          </div>
          <p class="mt-4 text-xs text-slate-400">取货码</p>
          <p class="mt-1 text-xl font-semibold tracking-[0.18em]" :class="canUseQrCode ? 'text-slate-900' : 'text-slate-400'">
            {{ displayVerifyCode }}
          </p>
        </div>

        <div class="mt-4 space-y-2 rounded-2xl bg-amber-50 px-4 py-4 text-sm text-amber-700">
          <p>取货地址：海右书院112房间</p>
          <p>取货时段：10:00 - 22:00</p>
          <p>联系人：门店值班人员</p>
          <p>温馨提示：请在有效时段内到店核销，过期将自动取消。可截图或打印此二维码前往店铺核销取货。</p>
        </div>
      </aside>

      <div class="space-y-4">
        <div class="rounded-[1.3rem] bg-white p-5 shadow-[var(--ylink-shadow-soft)]">
          <p class="text-lg font-semibold text-slate-900">订单信息</p>
          <div class="mt-4 grid gap-3 sm:grid-cols-2">
            <div class="rounded-2xl bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">创建时间</p>
              <p class="mt-1 text-sm text-slate-700">{{ detail.order.createdAt }}</p>
            </div>
            <div class="rounded-2xl bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">下单归属</p>
              <p class="mt-1 text-sm text-slate-700">
                {{ orderTypeLabel }}{{ detail.order.departmentNameSnapshot ? ` / ${detail.order.departmentNameSnapshot}` : '' }}
              </p>
            </div>
            <div class="rounded-2xl bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">总件数</p>
              <p class="mt-1 text-sm text-slate-700">{{ detail.order.totalQty }} 件</p>
            </div>
            <div class="rounded-2xl bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">总金额</p>
              <p class="mt-1 text-sm font-semibold text-teal-600">¥{{ totalAmount.toFixed(2) }}</p>
            </div>
            <div class="rounded-2xl bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">超时取消时间</p>
              <p class="mt-1 text-sm text-slate-700">{{ detail.order.timeoutAt || '未开启自动取消' }}</p>
            </div>
            <div class="rounded-2xl bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">核销时间</p>
              <p class="mt-1 text-sm text-slate-700">{{ detail.order.verifiedAt || '尚未核销' }}</p>
            </div>
            <div class="rounded-2xl bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">商家状态</p>
              <p class="mt-1 text-sm text-slate-700">{{ businessStatusMeta?.label ?? '未设置' }}</p>
            </div>
            <div class="rounded-2xl bg-slate-50 px-4 py-3 sm:col-span-2">
              <p class="text-sm text-slate-400">订单备注</p>
              <p class="mt-1 whitespace-pre-wrap break-words text-sm text-slate-700">{{ detail.order.remark || '未填写' }}</p>
            </div>
          </div>
        </div>

        <div v-if="merchantMessageContent" class="rounded-[1.3rem] bg-white p-5 shadow-[var(--ylink-shadow-soft)]">
          <p class="text-lg font-semibold text-slate-900">商家留言</p>
          <p class="mt-3 whitespace-pre-wrap break-words rounded-2xl bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800">
            {{ merchantMessageContent }}
          </p>
        </div>

        <div v-if="shouldShowReturnSection" class="rounded-[1.3rem] bg-white p-5 shadow-[var(--ylink-shadow-soft)]">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p class="text-lg font-semibold text-slate-900">退货服务</p>
              <p class="mt-2 text-sm leading-6 text-slate-500">
                支持按商品申请退货，提交后会生成门店退货核销二维码，门店扫码后完成退货处理。
              </p>
            </div>
            <button
              type="button"
              class="rounded-full border border-teal-200 px-4 py-2 text-sm font-medium text-teal-700 transition hover:bg-teal-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
              :disabled="!canApplyReturn"
              @click="openReturnDialog"
            >
              {{ pendingReturnRequests.length > 0 ? '继续申请退货' : '申请退货' }}
            </button>
          </div>
          <div class="mt-4 grid gap-3 sm:grid-cols-3">
            <div class="rounded-2xl bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">可退商品种类</p>
              <p class="mt-1 text-sm font-semibold text-slate-800">{{ returnableItemCount }} 种</p>
            </div>
            <div class="rounded-2xl bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">待处理退货申请</p>
              <p class="mt-1 text-sm font-semibold text-amber-700">
                {{ returnRequestStats.pendingCount }} 单 / {{ returnRequestStats.pendingQty }} 件
              </p>
            </div>
            <div class="rounded-2xl bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">历史退货申请</p>
              <p class="mt-1 text-sm font-semibold text-slate-800">
                {{ returnRequestStats.totalCount }} 单 / {{ returnRequestStats.totalQty }} 件
              </p>
            </div>
          </div>
          <p v-if="canApplyReturn" class="mt-4 text-sm text-slate-500">
            当前仍有可退商品，可在本页直接选择商品和数量提交退货申请。
          </p>
          <p v-else class="mt-4 text-sm text-slate-500">
            {{
              detail.order.status === 'cancelled'
                ? '当前订单已取消，不能新增退货申请。'
                : '当前订单已无可退数量，如需继续处理请查看下方退货记录。'
            }}
          </p>
        </div>

        <div class="rounded-[1.3rem] bg-white p-5 shadow-[var(--ylink-shadow-soft)]">
          <p class="text-lg font-semibold text-slate-900">预订明细</p>
          <div class="mt-4 overflow-hidden rounded-2xl border border-slate-100">
            <table class="min-w-full divide-y divide-slate-100 text-sm">
              <thead class="bg-slate-50 text-slate-500">
                <tr>
                  <th class="px-4 py-3 text-left font-medium">商品</th>
                  <th class="px-4 py-3 text-right font-medium">单价</th>
                  <th class="px-4 py-3 text-right font-medium">数量</th>
                  <th v-if="shouldShowReturnSection" class="px-4 py-3 text-right font-medium">待退数量</th>
                  <th v-if="shouldShowReturnSection" class="px-4 py-3 text-right font-medium">可退数量</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-100 bg-white text-slate-700">
                <tr v-for="item in detail.items" :key="item.id">
                  <td class="px-4 py-3">{{ item.productName }}</td>
                  <td class="px-4 py-3 text-right">¥{{ Number(item.defaultPrice || 0).toFixed(2) }}</td>
                  <td class="px-4 py-3 text-right font-medium">{{ item.qty }}</td>
                  <td v-if="shouldShowReturnSection" class="px-4 py-3 text-right text-amber-700">{{ item.returnedQty }}</td>
                  <td v-if="shouldShowReturnSection" class="px-4 py-3 text-right font-medium text-teal-700">{{ item.availableReturnQty }}</td>
                </tr>
                <tr v-if="!detail.items.length">
                  <td :colspan="shouldShowReturnSection ? 5 : 3" class="px-4 py-6 text-center text-slate-400">暂无预订商品明细，请稍后刷新重试</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div v-if="shouldShowReturnSection" class="rounded-[1.3rem] bg-white p-5 shadow-[var(--ylink-shadow-soft)]">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p class="text-lg font-semibold text-slate-900">退货记录</p>
              <p class="mt-2 text-sm text-slate-500">展示当前订单全部退货申请、核销进度与门店扫码二维码。</p>
            </div>
            <div v-if="pendingReturnRequests.length" class="rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700">
              待处理 {{ pendingReturnRequests.length }} 单
            </div>
          </div>
          <div v-if="hasReturnRequests" class="mt-4 space-y-4">
            <article
              v-for="request in detail.returnRequests"
              :key="request.id"
              class="rounded-3xl border border-slate-100 bg-slate-50/60 p-4"
            >
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p class="text-base font-semibold text-slate-900">{{ request.returnNo }}</p>
                  <p class="mt-1 text-xs text-slate-400">申请时间：{{ request.createdAt }}</p>
                </div>
                <div
                  class="rounded-full px-3 py-1 text-xs font-medium"
                  :class="getReturnRequestStatusMeta(request).className"
                >
                  {{ getReturnRequestStatusMeta(request).label }}
                </div>
              </div>
              <p class="mt-3 rounded-2xl px-4 py-3 text-sm leading-6" :class="getReturnRequestStatusMeta(request).className">
                {{ getReturnRequestStatusMeta(request).description }}
              </p>
              <div class="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_15rem]">
                <div class="space-y-3">
                  <div class="grid gap-3 sm:grid-cols-2">
                    <div class="rounded-2xl bg-white px-4 py-3">
                      <p class="text-sm text-slate-400">退货件数</p>
                      <p class="mt-1 text-sm font-semibold text-slate-800">{{ request.totalQty }} 件</p>
                    </div>
                    <div class="rounded-2xl bg-white px-4 py-3">
                      <p class="text-sm text-slate-400">提交时订单状态</p>
                      <p class="mt-1 text-sm text-slate-700">{{ getOrderStatusLabel(request.sourceOrderStatus) }}</p>
                    </div>
                    <div class="rounded-2xl bg-white px-4 py-3">
                      <p class="text-sm text-slate-400">处理时间</p>
                      <p class="mt-1 text-sm text-slate-700">{{ request.handledAt || '等待门店处理' }}</p>
                    </div>
                    <div class="rounded-2xl bg-white px-4 py-3">
                      <p class="text-sm text-slate-400">处理人</p>
                      <p class="mt-1 text-sm text-slate-700">{{ request.handledBy || '门店待处理' }}</p>
                    </div>
                  </div>
                  <div class="rounded-2xl bg-white px-4 py-3">
                    <p class="text-sm text-slate-400">退货原因</p>
                    <p class="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-700">{{ request.reason }}</p>
                  </div>
                  <div
                    v-if="request.rejectedReason"
                    class="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3"
                  >
                    <p class="text-sm text-rose-500">拒绝原因</p>
                    <p class="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-rose-700">
                      {{ request.rejectedReason }}
                    </p>
                  </div>
                  <div class="overflow-hidden rounded-2xl border border-white/80 bg-white">
                    <table class="min-w-full divide-y divide-slate-100 text-sm">
                      <thead class="bg-slate-50 text-slate-500">
                        <tr>
                          <th class="px-4 py-3 text-left font-medium">商品</th>
                          <th class="px-4 py-3 text-right font-medium">数量</th>
                        </tr>
                      </thead>
                      <tbody class="divide-y divide-slate-100 text-slate-700">
                        <tr v-for="item in request.items" :key="item.id">
                          <td class="px-4 py-3">{{ item.productName }}</td>
                          <td class="px-4 py-3 text-right font-medium">{{ item.qty }}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>

                <div class="rounded-3xl bg-white p-4 text-center">
                  <img
                    v-if="request.status === 'pending' && returnQrMap[request.id]"
                    :src="returnQrMap[request.id]"
                    :alt="`${request.returnNo} 退货二维码`"
                    class="mx-auto h-52 w-52 rounded-2xl bg-white p-3 shadow-sm"
                  />
                  <div
                    v-else
                    class="mx-auto flex h-52 w-52 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-6 text-center"
                  >
                    <p class="text-sm font-semibold text-slate-700">二维码已停用</p>
                    <p class="mt-2 text-xs leading-5 text-slate-400">{{ getReturnRequestStatusMeta(request).qrHint }}</p>
                  </div>
                  <p class="mt-4 text-xs text-slate-400">退货码</p>
                  <p
                    class="mt-1 text-lg font-semibold tracking-[0.16em]"
                    :class="request.status === 'pending' ? 'text-slate-900' : 'text-slate-400'"
                  >
                    {{ formatDisplayCode(request.verifyCode) }}
                  </p>
                </div>
              </div>
            </article>
          </div>
          <div
            v-else
            class="mt-4 rounded-3xl border border-dashed border-slate-200 bg-slate-50 px-6 py-8 text-center text-sm text-slate-500"
          >
            暂无退货申请记录；如需退货，可点击上方“申请退货”提交。
          </div>
        </div>

        <div class="rounded-[1.3rem] bg-white p-5 shadow-[var(--ylink-shadow-soft)]">
          <p class="text-lg font-semibold text-slate-900">订单进度</p>
          <div class="mt-4 space-y-3">
            <div
              v-for="timeline in timelineItems"
              :key="timeline.key"
              class="flex items-start gap-3 rounded-2xl px-3 py-2"
              :class="timeline.active ? 'bg-teal-50' : 'bg-slate-50'"
            >
              <span class="mt-1 h-2.5 w-2.5 rounded-full" :class="timeline.active ? 'bg-teal-500' : 'bg-slate-300'" />
              <div>
                <p class="text-sm font-semibold text-slate-900">{{ timeline.title }}</p>
                <p class="text-xs text-slate-500">{{ timeline.time }}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <el-dialog
      v-if="detail"
      v-model="editDialogVisible"
      title="修改订单"
      width="92%"
      style="max-width: 860px"
      append-to-body
      @closed="handleEditDialogClosed"
    >
      <div class="space-y-4">
        <div class="rounded-2xl bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-600">
          待取货订单支持直接修改商品、数量和备注。保存后系统会按最新内容重算预订库存，原取货码保持不变。
          <p class="mt-2 text-xs text-slate-500">{{ modifyOrderQuotaText }}</p>
        </div>

        <div class="rounded-3xl border border-slate-100 bg-white px-4 py-4">
          <div class="flex flex-col gap-3 lg:flex-row lg:items-end">
            <div class="flex-1">
              <p class="text-sm font-semibold text-slate-900">添加商品</p>
              <el-select
                v-model="editAddProductId"
                class="mt-3 w-full"
                placeholder="请选择要加入订单的商品"
                filterable
                :loading="editProductsLoading"
              >
                <el-option
                  v-for="product in editableProductOptions"
                  :key="product.id"
                  :label="`${product.productName}（剩余 ${product.availableStock} 件）`"
                  :value="product.id"
                />
              </el-select>
            </div>
            <el-button type="primary" plain :disabled="!editableProductOptions.length" @click="addEditProduct">加入订单</el-button>
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
                    @update:model-value="updateEditItemQty(item.productId, $event)"
                  />
                </div>
                <el-button text type="danger" @click="removeEditItem(item.productId)">移除</el-button>
              </div>
            </div>
          </div>
        </div>

        <div class="rounded-3xl border border-slate-100 bg-white px-4 py-4">
          <p class="text-sm font-semibold text-slate-900">订单备注</p>
          <el-input
            v-model="editRemark"
            type="textarea"
            :rows="4"
            :maxlength="O2O_PREORDER_REMARK_MAX_LENGTH"
            show-word-limit
            resize="none"
            class="mt-3"
            placeholder="选填：例如领取时间、特殊说明"
          />
        </div>

        <div class="rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-700">
          修改后共 {{ editableOrderTotalQty }} 件商品，合计 ¥{{ editableOrderTotalAmount.toFixed(2) }}。
          <p class="mt-2 text-xs text-amber-700">保存成功后将占用 1 次改单机会。</p>
        </div>
      </div>

      <template v-slot:footer>
        <div class="flex flex-wrap justify-end gap-3">
          <el-button @click="editDialogVisible = false">取消</el-button>
          <el-button
            type="primary"
            :loading="editSubmitting"
            :disabled="!canSubmitOrderEdit"
            @click="handleSubmitOrderEdit"
          >
            保存修改
          </el-button>
        </div>
      </template>
    </el-dialog>

    <el-dialog
      v-if="voucherOrder"
      v-model="voucherDialogVisible"
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
                  placeholder="请输入完成日期或签字说明，例如：2026-04-30 已完成"
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
                当前方向：{{ voucherOrientationLabel }}，共 2 页，每页 1 联；申请部门：{{ voucherOrder.customerDepartmentName || '散客' }}
              </p>
            </div>
            <div class="voucher-preview-panel__summary">
              <span>商品 {{ voucherOrder.items.length }} 行</span>
              <span>总金额 ¥{{ Number(voucherOrder.totalAmount).toFixed(2) }}</span>
            </div>
          </div>
          <div class="voucher-preview-panel__body">
            <div class="order-voucher-preview-scope" :class="`is-${voucherOrientation}`">
              <OrderVoucherTemplate
                :order="voucherOrder"
                :editable-fields="voucherEditableForm"
                :orientation="voucherOrientation"
              />
            </div>
          </div>
        </section>
      </div>
      <template #footer>
        <span class="flex flex-wrap justify-end gap-2">
          <el-button @click="voucherDialogVisible = false">关闭</el-button>
          <el-button type="primary" plain @click="handlePrintVoucher">打印</el-button>
          <el-button type="primary" :disabled="!enableHtml2pdfExport" :loading="exportPdfLoading" @click="handleExportVoucherPdf">
            导出PDF
          </el-button>
        </span>
      </template>
    </el-dialog>

    <Teleport to="body">
      <div
        v-if="voucherOrder && voucherDialogVisible"
        ref="voucherPrintRootRef"
        class="order-voucher-print-root"
        aria-hidden="true"
      >
        <div class="order-voucher-print-scope" :class="`is-${voucherOrientation}`">
          <OrderVoucherTemplate
            :order="voucherOrder"
            :editable-fields="voucherEditableForm"
            :orientation="voucherOrientation"
          />
        </div>
      </div>
    </Teleport>

    <el-dialog
      v-if="detail"
      v-model="returnDialogVisible"
      title="申请退货"
      width="92%"
      style="max-width: 760px"
      append-to-body
      @closed="handleReturnDialogClosed"
    >
      <div class="space-y-4">
        <div class="rounded-2xl bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-600">
          请按商品填写退货数量并说明原因。提交后系统会生成门店退货二维码，门店扫码核销后完成退货处理。
        </div>
        <div class="space-y-3">
          <div
            v-for="item in detail.items"
            :key="item.id"
            class="rounded-3xl border border-slate-100 bg-white px-4 py-4"
          >
            <div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <p class="text-sm font-semibold text-slate-900">{{ item.productName }}</p>
                <p class="mt-1 text-xs leading-5 text-slate-400">
                  原订 {{ item.qty }} 件，当前可退 {{ item.availableReturnQty }} 件
                </p>
                <p v-if="item.returnedQty > 0" class="mt-2 text-xs leading-5 text-amber-600">
                  已有 {{ item.returnedQty }} 件处于待退处理中，门店核销完成前不可重复申请。
                </p>
              </div>
              <div class="w-full md:w-44">
                <p class="mb-2 text-xs text-slate-400">本次退货数量</p>
                <el-input-number
                  :model-value="Number(returnQtyMap[item.productId] ?? 0)"
                  :min="0"
                  :max="item.availableReturnQty"
                  :step="1"
                  :precision="0"
                  class="w-full"
                  @update:model-value="handleReturnQtyChange(item.productId, item.availableReturnQty, $event)"
                />
              </div>
            </div>
          </div>
        </div>

        <div class="rounded-3xl border border-slate-100 bg-white px-4 py-4">
          <p class="text-sm font-semibold text-slate-900">退货原因</p>
          <el-input
            v-model="returnReason"
            type="textarea"
            :rows="4"
            :maxlength="O2O_RETURN_REASON_MAX_LENGTH"
            show-word-limit
            resize="none"
            class="mt-3"
            placeholder="请说明退货原因，便于门店快速处理。"
          />
          <p class="mt-2 text-xs text-slate-400">最多输入 {{ O2O_RETURN_REASON_MAX_LENGTH }} 个字符。</p>
        </div>

        <div class="rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-700">
          已选择 {{ selectedReturnItems.length }} 种商品，共 {{ selectedReturnTotalQty }} 件商品申请退货。
        </div>
      </div>

      <template v-slot:footer>
        <div class="flex flex-wrap justify-end gap-3">
          <el-button @click="returnDialogVisible = false">取消</el-button>
          <el-button
            type="primary"
            :loading="returnSubmitting"
            :disabled="!canSubmitReturnRequest"
            @click="handleSubmitReturnRequest"
          >
            提交退货申请
          </el-button>
        </div>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
/* 订单详情页根容器：为固定底部导航与安全区预留空间，避免末尾卡片被遮挡。 */
.order-detail-page {
  padding-bottom: calc(7.5rem + env(safe-area-inset-bottom));
}

/*
 * 局部覆盖全局 client-page-absolute：
 * 仅订单详情页恢复到常规文档流，让页面高度随内容增长，从而可以滚动到最下方完整显示卡片。
 */
:global(.client-page-absolute.order-detail-page) {
  position: relative;
}

.order-back-floating {
  position: fixed;
  z-index: 30;
  left: max(10px, calc((100vw - 1240px) / 2 - 52px));
  top: calc(env(safe-area-inset-top) + 82px);
}

.voucher-editor-banner {
  margin-bottom: 12px;
  border-radius: 14px;
  border: 1px solid #dbeafe;
  background: #f0f9ff;
  padding: 12px 14px;
}

.voucher-editor-banner__title {
  font-size: 13px;
  font-weight: 600;
  color: #0f172a;
}

.voucher-editor-banner__content {
  margin-top: 8px;
  display: grid;
  gap: 4px;
  font-size: 12px;
  line-height: 1.5;
  color: #334155;
}

.voucher-workbench {
  display: grid;
  gap: 12px;
}

.voucher-editor-panel,
.voucher-preview-panel {
  border-radius: 14px;
  border: 1px solid #e2e8f0;
  background: #fff;
  padding: 14px;
}

.voucher-editor-panel__header,
.voucher-preview-panel__header {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px 16px;
}

.voucher-editor-panel__title,
.voucher-preview-panel__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: #0f172a;
}

.voucher-editor-panel__desc,
.voucher-preview-panel__desc {
  margin: 4px 0 0;
  font-size: 12px;
  color: #64748b;
}

.voucher-editor-panel__meta,
.voucher-preview-panel__summary {
  display: grid;
  justify-items: end;
  gap: 4px;
  font-size: 12px;
  color: #475569;
}

.voucher-orientation-toolbar {
  margin-top: 12px;
  display: flex;
  align-items: center;
  gap: 10px;
}

.voucher-orientation-toolbar__label {
  font-size: 12px;
  color: #64748b;
}

.voucher-editor-form {
  margin-top: 12px;
}

.voucher-editor-form__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 12px;
}

.voucher-editor-form__item--full {
  grid-column: 1 / -1;
}

.voucher-preview-panel__body {
  margin-top: 12px;
  max-height: 56vh;
  overflow: auto;
  border-radius: 12px;
  border: 1px solid #e2e8f0;
  background: #f8fafc;
  padding: 10px;
}

.order-voucher-preview-scope {
  transform-origin: top left;
}

.order-voucher-preview-scope.is-landscape {
  width: 281mm;
}

.order-voucher-preview-scope.is-portrait {
  width: 194mm;
}

.order-voucher-print-root {
  position: fixed;
  left: -20000px;
  top: 0;
  width: 0;
  height: 0;
  overflow: hidden;
  pointer-events: none;
  opacity: 0;
}

@media (max-width: 900px) {
  .voucher-editor-form__grid {
    grid-template-columns: 1fr;
  }

  .voucher-editor-panel__meta,
  .voucher-preview-panel__summary {
    justify-items: start;
  }
}

@media (max-width: 1023px) {
  .order-back-floating {
    left: 12px;
    top: calc(env(safe-area-inset-top) + 74px);
  }
}
</style>
