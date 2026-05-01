<script setup lang="ts">
/**
 * 模块说明：src/views/o2o/O2oVerifyConsoleView.vue
 * 文件职责：提供 O2O 门店核销台，统一承接预订单取货核销、退货申请回库核销、退货拒绝与现场改单四类门店动作。
 * 实现逻辑：
 * - 输入框既支持直接录入核销码，也支持粘贴二维码链接、扫码枪文本和业务单号；
 * - 查询接口返回“预订单 / 退货申请”联合结果后，页面按真实单据类型切换展示卡片、表格与按钮文案；
 * - 对待处理退货申请开放“拒绝”弹窗，对待核销预订单开放“现场改单”面板，并在成功后原位刷新当前单据详情；
 * - 预订单详情区同步展示总金额、总件数等关键统计，便于门店核对改单后的最终出库金额；
 * - 所有前端提示文案都与后端实际业务含义保持一致，避免门店误把退货码当取货码处理。
 * 维护说明：
 * - 若后端扩展新的核销目标类型，必须同步补充本文件的类型守卫、状态映射和模板分支；
 * - 若变更退货申请状态枚举或现场改单结构，需同时更新共享 API 类型、表单构造逻辑与按钮显隐规则。
 */

import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRoute } from 'vue-router'
import { CameraFilled, DocumentCopy, Search } from '@element-plus/icons-vue'
import { PageContainer, UnifiedScanDialog } from '@/components/common'
import {
  VERIFY_CONSOLE_O2O_ORDER_STATUS_CLASS_MAP,
  VERIFY_CONSOLE_O2O_ORDER_STATUS_LABEL_MAP,
  isO2oOrderPending,
} from '@/constants/o2o-order-status'
import {
  getO2oVerifyDetail,
  getO2oVerifyDetailByShowNo,
  rejectO2oReturnRequest,
  updateO2oOrderComplianceFlags,
  updateO2oOrderOnsite,
  verifyO2oPreorder,
  type O2oPreorderDetail,
  type O2oReturnRequestDetail,
  type O2oVerifyDetailResult,
} from '@/api/modules/o2o'
import { getProductList, type ProductRecord } from '@/api/modules/product'
import { useCameraQrScanner } from '@/composables/useCameraQrScanner'
import { useDevice } from '@/composables/useDevice'
import { useAuthStore } from '@/store'

const O2O_RETURN_REJECT_REASON_MAX_LENGTH = 500
const O2O_PREORDER_REMARK_MAX_LENGTH = 255
const ORDER_TYPE_LABEL_MAP = {
  department: '部门订',
  walkin: '散客',
} as const

interface EditableOnsiteOrderItem {
  productId: string
  productCode: string
  productName: string
  defaultPrice: string
  qty: number
  originalQty: number
  maxQty: number
  unavailableReason: string | null
}

const verifyCode = ref('')
const verifyResult = ref<O2oVerifyDetailResult | null>(null)
const loading = ref(false)
const submitting = ref(false)
const inputRef = ref<{ focus: () => void } | null>(null)
const { isPhone } = useDevice()
const route = useRoute()
const authStore = useAuthStore()
const lastRouteVerifyKey = ref('')

const productCatalog = ref<ProductRecord[]>([])
const productCatalogLoading = ref(false)

const rejectDialogVisible = ref(false)
const rejectSubmitting = ref(false)
const rejectReason = ref('')

const onsiteAdjustDialogVisible = ref(false)
const onsiteAdjustSubmitting = ref(false)
const onsiteAddProductId = ref('')
const onsiteRemark = ref('')
const onsiteOrderItems = ref<EditableOnsiteOrderItem[]>([])
const complianceSaving = ref(false)
const complianceForm = ref({
  hasCustomerOrder: false,
  isSystemApplied: false,
})

// 查询接口会返回联合结构，这里先做类型守卫，后续模板与按钮逻辑都复用同一份收窄结果。
const isPreorderDetail = (
  detail: O2oVerifyDetailResult['detail'] | null | undefined,
): detail is O2oPreorderDetail => {
  return Boolean(detail && 'order' in detail)
}

const isReturnRequestDetail = (
  detail: O2oVerifyDetailResult['detail'] | null | undefined,
): detail is O2oReturnRequestDetail => {
  return Boolean(detail && 'returnNo' in detail)
}

// 核销台兼容预订单号 `PO...` 与退货申请单号 `RO...` 两类单据编号。
const isBizShowNo = (value: string) => /^(PO|RO)\d{8}\d{4}$/i.test(value)

const preorderDetail = computed(() => {
  const detail = verifyResult.value?.detail
  return isPreorderDetail(detail) ? detail : null
})

const returnRequestDetail = computed(() => {
  const detail = verifyResult.value?.detail
  return isReturnRequestDetail(detail) ? detail : null
})

const isReturnVerifyMode = computed(() => verifyResult.value?.verifyTargetType === 'return_request')

const canVerify = computed(() => {
  if (preorderDetail.value) {
    return isO2oOrderPending(preorderDetail.value.order.status)
  }
  if (returnRequestDetail.value) {
    return returnRequestDetail.value.status === 'pending'
  }
  return false
})

const canRejectReturnRequest = computed(() => {
  return returnRequestDetail.value?.status === 'pending'
})

// 现场改单严格只对待核销预订单开放，已取消/已核销/有退货记录时后端也会继续兜底阻断。
const canOpenOnsiteAdjust = computed(() => {
  return Boolean(preorderDetail.value && isO2oOrderPending(preorderDetail.value.order.status))
})

const canEditComplianceFlags = computed(() => authStore.hasPermission('orders:update'))
const isDepartmentPreorder = computed(() => preorderDetail.value?.order.clientOrderType === 'department')

const showVerifyActionButton = computed(() => {
  if (preorderDetail.value) {
    return true
  }
  return returnRequestDetail.value?.status === 'pending'
})

const currentDocumentTitle = computed(() => {
  if (preorderDetail.value) {
    return preorderDetail.value.order.showNo
  }
  if (returnRequestDetail.value) {
    return returnRequestDetail.value.returnNo
  }
  return ''
})

const currentDocumentTypeLabel = computed(() => {
  return isReturnVerifyMode.value ? '退货申请' : '预订单'
})

const currentVerifyCode = computed(() => {
  if (preorderDetail.value) {
    return preorderDetail.value.order.verifyCode
  }
  if (returnRequestDetail.value) {
    return returnRequestDetail.value.verifyCode
  }
  return ''
})

const currentStatusLabel = computed(() => {
  if (preorderDetail.value) {
    return VERIFY_CONSOLE_O2O_ORDER_STATUS_LABEL_MAP[preorderDetail.value.order.status]
  }
  if (returnRequestDetail.value?.status === 'pending') {
    return '待退货核销'
  }
  if (returnRequestDetail.value?.status === 'verified') {
    return '已完成回库'
  }
  if (returnRequestDetail.value?.status === 'rejected') {
    return '已拒绝'
  }
  return ''
})

const currentStatusClassName = computed(() => {
  if (preorderDetail.value) {
    return VERIFY_CONSOLE_O2O_ORDER_STATUS_CLASS_MAP[preorderDetail.value.order.status]
  }
  if (returnRequestDetail.value?.status === 'pending') {
    return 'status-chip--pending'
  }
  if (returnRequestDetail.value?.status === 'verified') {
    return 'status-chip--verified'
  }
  if (returnRequestDetail.value?.status === 'rejected') {
    return 'status-chip--rejected'
  }
  return ''
})

const preorderOwnershipLabel = computed(() => {
  if (!preorderDetail.value) {
    return ''
  }
  const order = preorderDetail.value.order
  const orderTypeLabel = ORDER_TYPE_LABEL_MAP[order.clientOrderType]
  const departmentLabel = order.departmentNameSnapshot ? ` / ${order.departmentNameSnapshot}` : ''
  return `${orderTypeLabel}${departmentLabel}`
})

/**
 * 预订单总金额展示文案：
 * - 后端详情已经返回订单汇总金额，这里统一格式化为金额文本；
 * - 现场改单后重新查询详情时，该值会自动刷新为最新总额。
 */
const preorderTotalAmountText = computed(() => {
  if (!preorderDetail.value) {
    return '0.00'
  }
  const normalizedAmount = Number(preorderDetail.value.order.totalAmount ?? 0)
  return Number.isFinite(normalizedAmount) ? normalizedAmount.toFixed(2) : '0.00'
})

const returnRequestResultHint = computed(() => {
  if (!returnRequestDetail.value) {
    return ''
  }
  if (returnRequestDetail.value.status === 'verified') {
    return '该退货申请已由门店完成回库核销，本页仅保留结果记录，不再展示回库按钮。'
  }
  if (returnRequestDetail.value.status === 'rejected') {
    return '该退货申请已被门店拒绝，本页仅展示拒绝原因和处理记录，不再允许继续回库核销。'
  }
  return '请核对退货原因与商品数量无误后，再执行退货回库或拒绝处理。'
})

const searchButtonText = computed(() => {
  return isReturnVerifyMode.value ? '查询退货单' : '查询单据'
})

const verifyButtonText = computed(() => {
  return isReturnVerifyMode.value ? '确认退货回库' : '确认核销出库'
})

const emptyStateText = computed(() => {
  return '请输入取货码、退货码，或使用扫码枪扫入业务二维码后查询'
})

const scanActionHint = computed(() => {
  if (scanModeLabel.value === '实时扫码') {
    return '轻触相机图标即可打开实时扫码，识别成功后会自动查询取货单或退货单。'
  }

  if (isSecureCameraContext.value) {
    return '当前浏览器已切换为拍照识别模式，点相机图标即可拍照识别取货码或退货码。'
  }

  return '当前为 HTTP 环境，已切换为拍照识别模式，点相机图标即可拍照识别取货码或退货码。'
})

const onsiteEditableProductOptions = computed(() => {
  const selectedProductIdSet = new Set(onsiteOrderItems.value.map((item) => item.productId))
  return productCatalog.value.filter((item) => !selectedProductIdSet.has(item.id))
})

const onsiteTotalQty = computed(() => {
  return onsiteOrderItems.value.reduce((sum, item) => sum + item.qty, 0)
})

const onsiteTotalAmount = computed(() => {
  return onsiteOrderItems.value.reduce((sum, item) => sum + Math.max(0, Number(item.defaultPrice || 0)) * item.qty, 0)
})

const canSubmitOnsiteAdjust = computed(() => {
  return onsiteTotalQty.value > 0 && canOpenOnsiteAdjust.value && !onsiteAdjustSubmitting.value
})

const normalizeVerifyCode = (rawValue: string) => {
  const value = rawValue.trim()
  if (!value) {
    return ''
  }

  // 兼容多种扫码结果：
  // 1. 纯核销码（UUID）；
  // 2. 带 verifyCode 参数的 URL；
  // 3. /verify/{code} 路径形式的 URL。
  try {
    const parsedUrl = new URL(value)
    const fromQuery = parsedUrl.searchParams.get('verifyCode')
    if (fromQuery?.trim()) {
      return fromQuery.trim()
    }
    const matched = parsedUrl.pathname.match(/\/verify\/([^/?#]+)/i)
    if (matched?.[1]) {
      return decodeURIComponent(matched[1]).trim()
    }
  } catch {
    // 非 URL 文本按纯核销码处理。
  }

  // 兼容“网页展示码复制”场景：
  // 例如 "0ECC 885A BDEF 462B B9BC 9C0C ..." 这类带空格分组的文本。
  // 统一提取字母数字后再归一化为标准 UUID（8-4-4-4-12）。
  const compact = value.replaceAll(/[^a-zA-Z0-9]/g, '')
  if (/^[a-fA-F0-9]{32}$/.test(compact)) {
    const hex = compact.toLowerCase()
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }

  return value
}

const focusInput = async () => {
  await nextTick()
  inputRef.value?.focus()
}

const replacePreorderDetail = (detail: O2oPreorderDetail) => {
  verifyResult.value = {
    verifyTargetType: 'preorder',
    detail,
  }
}

const replaceReturnRequestDetail = (detail: O2oReturnRequestDetail) => {
  verifyResult.value = {
    verifyTargetType: 'return_request',
    detail,
  }
}

const resolveEditableItemMaxQty = (product: ProductRecord, originalQty = 0) => {
  return Math.max(0, Number(product.availableStock ?? 0) + originalQty)
}

// 现场改单候选商品来自后台产品列表，但页面仍需兼容“订单已有商品已不在可售目录中”的历史情况。
// 因此缺失商品会保留在列表里，仅允许减少或删除，不允许超出原数量。
const buildOnsiteEditableItemsFromDetail = (detail: O2oPreorderDetail) => {
  const productMap = new Map(productCatalog.value.map((item) => [item.id, item]))
  return detail.items.map((item) => {
    const product = productMap.get(item.productId)
    const maxQty = product ? resolveEditableItemMaxQty(product, item.qty) : item.qty
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
    } satisfies EditableOnsiteOrderItem
  })
}

const resetRejectForm = () => {
  rejectReason.value = ''
}

const resetOnsiteAdjustForm = () => {
  onsiteAddProductId.value = ''
  onsiteRemark.value = preorderDetail.value?.order.remark ?? ''
  onsiteOrderItems.value = preorderDetail.value ? buildOnsiteEditableItemsFromDetail(preorderDetail.value) : []
}

const {
  imageInputRef,
  bindScannerContainer,
  isSecureCameraContext,
  scanModeLabel,
  scanButtonTitle,
  scanDialogVisible,
  scanLoading,
  scanStatusText,
  closeScanDialog,
  handleImageInputChange,
  openScanDialog,
} = useCameraQrScanner({
  normalizeCode: normalizeVerifyCode,
  onDetected: async (code) => {
    verifyCode.value = code
    await handleSearch()
  },
})

// 这里显式监听模板侧 input ref，避免严格构建下将其误判为“仅声明未读取”。
watch(imageInputRef, () => undefined, { flush: 'post' })

/**
 * 查询核销信息：
 * - 支持直接粘贴二维码解析后的核销码，也兼容扫码枪连续输入后回车；
 * - 查询成功后在当前页右侧展示预订单或退货申请详情，供工作人员复核。
 */
const handleSearch = async () => {
  const normalizedCode = normalizeVerifyCode(verifyCode.value)
  if (!normalizedCode) {
    ElMessage.warning('请输入核销码')
    return
  }
  verifyCode.value = normalizedCode

  loading.value = true
  try {
    verifyResult.value = isBizShowNo(normalizedCode)
      ? await getO2oVerifyDetailByShowNo(normalizedCode)
      : await getO2oVerifyDetail(normalizedCode)
  } catch (error) {
    const message = error instanceof Error ? error.message : '查询失败，请稍后重试'
    ElMessage.error(message)
    verifyResult.value = null
  } finally {
    loading.value = false
  }
}

const handlePasteAndSearch = async () => {
  if (!globalThis.navigator?.clipboard?.readText) {
    ElMessage.warning('当前环境不支持读取剪贴板，请手动粘贴')
    return
  }
  try {
    const text = await globalThis.navigator.clipboard.readText()
    verifyCode.value = normalizeVerifyCode(text)
    if (!verifyCode.value) {
      ElMessage.warning('剪贴板中未读取到核销码')
      return
    }
    await handleSearch()
  } catch {
    ElMessage.warning('读取剪贴板失败，请检查浏览器权限')
  }
}

const applyVerifyCodeFromRoute = async () => {
  const routeVerifyCode = typeof route.query.verifyCode === 'string' ? route.query.verifyCode : ''
  const normalizedCode = normalizeVerifyCode(routeVerifyCode)
  if (!normalizedCode) {
    return
  }
  const autoSearch = route.query.autoSearch === '1'
  const routeVerifyKey = `${normalizedCode}__${autoSearch ? '1' : '0'}`
  if (routeVerifyKey === lastRouteVerifyKey.value) {
    return
  }
  lastRouteVerifyKey.value = routeVerifyKey
  verifyCode.value = normalizedCode
  if (autoSearch) {
    await handleSearch()
  }
}

const loadProductCatalog = async () => {
  if (productCatalogLoading.value) {
    return
  }
  productCatalogLoading.value = true
  try {
    const result = await getProductList({ isActive: true })
    // 现场改单只允许加入仍在 O2O 商城上架的商品，避免门店把线下禁售商品加入线上预订单。
    productCatalog.value = result.filter((item) => item.o2oStatus === 'listed')
  } catch (error) {
    const message = error instanceof Error ? error.message : '可改单商品加载失败，请稍后重试'
    ElMessage.error(message)
  } finally {
    productCatalogLoading.value = false
  }
}

const openRejectDialog = () => {
  if (!canRejectReturnRequest.value) {
    ElMessage.warning('当前退货申请不可拒绝')
    return
  }
  resetRejectForm()
  rejectDialogVisible.value = true
}

const handleRejectDialogClosed = () => {
  resetRejectForm()
}

const handleSubmitReject = async () => {
  if (!returnRequestDetail.value?.id) {
    return
  }
  if (!canRejectReturnRequest.value) {
    ElMessage.warning('当前退货申请不可拒绝')
    return
  }

  const normalizedReason = rejectReason.value.trim()
  if (!normalizedReason) {
    ElMessage.warning('请填写拒绝原因')
    return
  }
  if (normalizedReason.length > O2O_RETURN_REJECT_REASON_MAX_LENGTH) {
    ElMessage.warning(`拒绝原因最多 ${O2O_RETURN_REJECT_REASON_MAX_LENGTH} 个字符`)
    return
  }

  try {
    await ElMessageBox.confirm(
      `确认拒绝退货申请“${returnRequestDetail.value.returnNo}”吗？拒绝后将记录原因并阻止继续回库核销。`,
      '拒绝退货申请',
      {
        type: 'warning',
        confirmButtonText: '确认拒绝',
        cancelButtonText: '取消',
        closeOnClickModal: false,
      },
    )
  } catch {
    return
  }

  rejectSubmitting.value = true
  try {
    const nextDetail = await rejectO2oReturnRequest(returnRequestDetail.value.id, normalizedReason)
    replaceReturnRequestDetail(nextDetail)
    rejectDialogVisible.value = false
    ElMessage.success('退货申请已拒绝')
  } catch (error) {
    const message = error instanceof Error ? error.message : '拒绝退货申请失败，请稍后重试'
    ElMessage.error(message)
  } finally {
    rejectSubmitting.value = false
  }
}

const updateOnsiteItemQty = (productId: string, value: number | null | undefined) => {
  onsiteOrderItems.value = onsiteOrderItems.value.map((item) => {
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

const removeOnsiteItem = (productId: string) => {
  onsiteOrderItems.value = onsiteOrderItems.value.filter((item) => item.productId !== productId)
}

const addOnsiteProduct = () => {
  const productId = onsiteAddProductId.value.trim()
  if (!productId) {
    ElMessage.warning('请先选择要加入订单的商品')
    return
  }
  if (onsiteOrderItems.value.some((item) => item.productId === productId)) {
    ElMessage.warning('该商品已在当前订单中')
    return
  }

  const product = productCatalog.value.find((item) => item.id === productId)
  if (!product) {
    ElMessage.warning('未找到可加入的商品')
    return
  }

  const maxQty = resolveEditableItemMaxQty(product, 0)
  if (maxQty <= 0) {
    ElMessage.warning('该商品当前库存不足，暂不可加入订单')
    return
  }

  onsiteOrderItems.value = [
    ...onsiteOrderItems.value,
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
  onsiteAddProductId.value = ''
}

const openOnsiteAdjustDialog = async () => {
  if (!preorderDetail.value) {
    return
  }
  if (!canOpenOnsiteAdjust.value) {
    ElMessage.warning('当前订单不可现场改单')
    return
  }
  await loadProductCatalog()
  resetOnsiteAdjustForm()
  onsiteAdjustDialogVisible.value = true
}

const handleOnsiteAdjustDialogClosed = () => {
  resetOnsiteAdjustForm()
}

const handleSubmitOnsiteAdjust = async () => {
  if (!preorderDetail.value?.order.id) {
    return
  }
  if (!canOpenOnsiteAdjust.value) {
    ElMessage.warning('当前订单不可现场改单')
    return
  }

  const normalizedItems = onsiteOrderItems.value
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
  if (onsiteRemark.value.trim().length > O2O_PREORDER_REMARK_MAX_LENGTH) {
    ElMessage.warning(`订单备注最多 ${O2O_PREORDER_REMARK_MAX_LENGTH} 个字符`)
    return
  }

  try {
    await ElMessageBox.confirm(
      `确认保存订单“${preorderDetail.value.order.showNo}”的现场改单结果吗？保存后核销依据会切换为最新商品与数量。`,
      '现场改单',
      {
        type: 'warning',
        confirmButtonText: '确认保存',
        cancelButtonText: '取消',
        closeOnClickModal: false,
      },
    )
  } catch {
    return
  }

  onsiteAdjustSubmitting.value = true
  try {
    const nextDetail = await updateO2oOrderOnsite(preorderDetail.value.order.id, {
      remark: onsiteRemark.value.trim() || undefined,
      items: normalizedItems.map((item) => ({
        productId: item.productId,
        qty: item.qty,
      })),
    })
    replacePreorderDetail(nextDetail)
    onsiteAdjustDialogVisible.value = false
    ElMessage.success('现场改单已保存')
  } catch (error) {
    const message = error instanceof Error ? error.message : '现场改单失败，请稍后重试'
    ElMessage.error(message)
  } finally {
    onsiteAdjustSubmitting.value = false
  }
}

const syncComplianceFormFromDetail = (detail: O2oPreorderDetail | null) => {
  complianceForm.value = {
    hasCustomerOrder: Boolean(detail?.order.hasCustomerOrder),
    isSystemApplied: Boolean(detail?.order.isSystemApplied),
  }
}

const handleSaveComplianceFlags = async () => {
  if (!preorderDetail.value?.order.id || !isDepartmentPreorder.value) {
    return
  }
  complianceSaving.value = true
  try {
    const nextDetail = await updateO2oOrderComplianceFlags(preorderDetail.value.order.id, {
      hasCustomerOrder: complianceForm.value.hasCustomerOrder,
      isSystemApplied: complianceForm.value.isSystemApplied,
    })
    replacePreorderDetail(nextDetail)
    syncComplianceFormFromDetail(nextDetail)
    ElMessage.success('状态已更新')
  } catch (error) {
    const message = error instanceof Error ? error.message : '状态更新失败，请稍后重试'
    ElMessage.error(message)
  } finally {
    complianceSaving.value = false
  }
}

// 详细注释：处理核销操作，先弹窗二次确认，成功后请求核销接口并刷新状态。
const handleVerify = async () => {
  if (!verifyResult.value) {
    return
  }
  const isReturnVerify = isReturnVerifyMode.value
  const activeVerifyCode = currentVerifyCode.value

  // 只有“待处理”单据才允许继续核销。
  // 预订单要求主状态仍为 pending，退货申请要求自身状态仍为 pending，
  // 后端事务内也会再次兜底校验，防止多终端重复核销。
  if (!canVerify.value) {
    ElMessage.warning(isReturnVerify ? '当前退货申请已处理，不可继续回库' : '当前订单已取消或已核销，不可继续核销')
    return
  }
  if (!activeVerifyCode) {
    ElMessage.warning(isReturnVerify ? '当前退货申请缺少退货码，无法继续处理' : '当前订单缺少核销码，无法继续处理')
    return
  }

  try {
    await ElMessageBox.confirm(
      isReturnVerify
        ? '确认执行退货核销回库吗？该操作会同步释放预订库存或补回现货库存，且不可撤销。'
        : '确认执行核销出库吗？该操作会同步扣减库存且不可撤销。',
      isReturnVerify ? '退货核销确认' : '核销确认',
      {
        confirmButtonText: isReturnVerify ? '确认回库' : '确认核销',
        cancelButtonText: '取消',
        type: 'warning',
        distinguishCancelAndClose: true,
      },
    )
  } catch {
    return
  }

  submitting.value = true
  try {
    verifyResult.value = await verifyO2oPreorder(activeVerifyCode)
    ElMessage.success(isReturnVerify ? '退货核销完成，库存已同步回补' : '核销完成，库存已同步扣减')
    verifyCode.value = ''
    await focusInput()
  } finally {
    submitting.value = false
  }
}

onMounted(async () => {
  await focusInput()
  await applyVerifyCodeFromRoute()
})

watch(
  () => preorderDetail.value?.order.id ?? '',
  () => {
    syncComplianceFormFromDetail(preorderDetail.value)
  },
)

watch(
  () => verifyCode.value,
  (value) => {
    if (!value.trim()) {
      verifyResult.value = null
    }
  },
)

watch(
  () => [route.query.verifyCode, route.query.autoSearch],
  async () => {
    await applyVerifyCodeFromRoute()
  },
)
</script>

<template>
  <PageContainer title="O2O 核销台" description="支持工作人员录入或扫码取货码、退货码，按单据类型完成核销、拒绝退货与现场改单">
    <div class="verify-console-layout">
      <section class="verify-console-entry rounded-3xl bg-white p-5 shadow-sm">
        <div class="flex items-center justify-between gap-3">
          <p class="text-lg font-semibold text-slate-900">扫码 / 输入核销码</p>
          <span class="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-500">
            {{ scanModeLabel }}
          </span>
        </div>
        <p class="mt-2 text-sm text-slate-500">支持手机扫码后自动填入；也支持直接粘贴二维码链接、业务单号，系统会自动识别取货码或退货码。</p>

        <div class="mt-4">
          <el-input
            ref="inputRef"
            v-model="verifyCode"
            class="verify-console-input"
            placeholder="请扫描二维码或输入取货码 / 退货码 / 业务单号"
            clearable
            @keyup.enter="handleSearch"
          >
            <template #suffix>
              <span class="text-xs text-slate-400">回车即查</span>
            </template>
          </el-input>
          <div class="mt-3 verify-console-toolbar">
            <div class="verify-console-icon-group">
              <el-tooltip :content="scanButtonTitle" placement="top">
                <el-button
                  class="verify-console-icon-btn"
                  :loading="scanLoading"
                  @click="openScanDialog"
                >
                  <el-icon :size="18"><CameraFilled /></el-icon>
                </el-button>
              </el-tooltip>
              <el-tooltip content="读取剪贴板并查询" placement="top">
                <el-button
                  class="verify-console-icon-btn"
                  :loading="loading"
                  @click="handlePasteAndSearch"
                >
                  <el-icon :size="18"><DocumentCopy /></el-icon>
                </el-button>
              </el-tooltip>
            </div>
            <el-button type="primary" class="verify-console-search-btn" :loading="loading" @click="handleSearch">
              <el-icon class="mr-1.5"><Search /></el-icon>
              {{ searchButtonText }}
            </el-button>
          </div>
        </div>

        <div class="mt-3 rounded-2xl border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-500">
          {{ scanActionHint }}
        </div>
      </section>

      <section class="rounded-3xl bg-white p-5 shadow-sm">
        <template v-if="verifyResult">
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div class="flex flex-wrap items-center gap-2">
                <p class="text-lg font-semibold text-slate-900">{{ currentDocumentTitle }}</p>
                <span class="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-500">
                  {{ currentDocumentTypeLabel }}
                </span>
              </div>
              <div class="mt-2 flex flex-wrap items-center gap-2">
                <span class="text-sm text-slate-400">状态</span>
                <span class="status-chip" :class="currentStatusClassName">{{ currentStatusLabel }}</span>
              </div>
            </div>
            <div class="flex flex-wrap gap-2">
              <el-button
                v-if="canOpenOnsiteAdjust"
                type="primary"
                plain
                :disabled="onsiteAdjustSubmitting"
                @click="openOnsiteAdjustDialog"
              >
                现场改单
              </el-button>
              <el-button
                v-if="canRejectReturnRequest"
                type="danger"
                plain
                :disabled="rejectSubmitting"
                @click="openRejectDialog"
              >
                拒绝退货
              </el-button>
              <el-button
                v-if="showVerifyActionButton"
                type="success"
                :disabled="!canVerify"
                :loading="submitting"
                @click="handleVerify"
              >
                {{ verifyButtonText }}
              </el-button>
            </div>
          </div>

          <div v-if="preorderDetail" class="mt-4 rounded-2xl border border-teal-100 bg-teal-50 px-4 py-3 text-sm text-teal-700">
            <p class="font-semibold">核销依据说明</p>
            <p class="mt-1 leading-6">当前页面支持待核销预订单现场改单。保存后，商品明细、总金额、总件数和后续核销出库都会以最新结果为准。</p>
          </div>

          <div v-if="preorderDetail" class="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div class="rounded-2xl bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">下单归属</p>
              <p class="mt-1 text-base font-semibold text-slate-900">{{ preorderOwnershipLabel }}</p>
            </div>
            <div class="rounded-2xl bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">总金额</p>
              <p class="mt-1 text-base font-semibold text-slate-900">¥{{ preorderTotalAmountText }}</p>
            </div>
            <div class="rounded-2xl bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">总件数</p>
              <p class="mt-1 text-base font-semibold text-slate-900">{{ preorderDetail.order.totalQty }} 件</p>
            </div>
            <div class="rounded-2xl bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">创建时间</p>
              <p class="mt-1 text-sm text-slate-700">{{ preorderDetail.order.createdAt }}</p>
            </div>
            <div class="rounded-2xl bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">核销码</p>
              <p class="mt-1 break-all text-sm text-slate-700">{{ preorderDetail.order.verifyCode }}</p>
            </div>
            <div class="rounded-2xl bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">订单备注</p>
              <p class="mt-1 whitespace-pre-wrap break-words text-sm text-slate-700">{{ preorderDetail.order.remark || '未填写' }}</p>
            </div>
          </div>

          <div v-if="preorderDetail" class="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p class="text-sm font-semibold text-slate-900">合规状态确认</p>
                <p class="mt-1 text-xs text-slate-500">仅部门单可编辑“是否有出库单”和“系统申请”状态。</p>
              </div>
              <el-button
                v-if="canEditComplianceFlags && isDepartmentPreorder"
                type="primary"
                size="small"
                :loading="complianceSaving"
                @click="handleSaveComplianceFlags"
              >
                保存状态
              </el-button>
            </div>
            <div class="mt-3 grid gap-3 sm:grid-cols-2">
              <div class="rounded-xl bg-white px-3 py-3">
                <p class="text-xs text-slate-500">是否有出库单</p>
                <div class="mt-2">
                  <el-switch
                    v-if="canEditComplianceFlags && isDepartmentPreorder"
                    v-model="complianceForm.hasCustomerOrder"
                    inline-prompt
                    active-text="是"
                    inactive-text="否"
                  />
                  <span v-else class="text-sm font-medium text-slate-700">
                    {{ isDepartmentPreorder ? (preorderDetail.order.hasCustomerOrder ? '是' : '否') : '不适用' }}
                  </span>
                </div>
              </div>
              <div class="rounded-xl bg-white px-3 py-3">
                <p class="text-xs text-slate-500">系统申请</p>
                <div class="mt-2">
                  <el-switch
                    v-if="canEditComplianceFlags && isDepartmentPreorder"
                    v-model="complianceForm.isSystemApplied"
                    inline-prompt
                    active-text="已申请"
                    inactive-text="未申请"
                  />
                  <span v-else class="text-sm font-medium text-slate-700">
                    {{ isDepartmentPreorder ? (preorderDetail.order.isSystemApplied ? '已申请' : '未申请') : '不适用' }}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <template v-if="preorderDetail">
            <el-table class="mt-4" :data="preorderDetail.items" row-key="id">
              <el-table-column prop="productName" label="商品名称" min-width="180" />
              <el-table-column prop="productCode" label="商品编码" min-width="140" />
              <el-table-column prop="defaultPrice" label="单价" width="120">
                <template #default="{ row }">
                  <span>¥{{ Number(row.defaultPrice || 0).toFixed(2) }}</span>
                </template>
              </el-table-column>
              <el-table-column prop="qty" label="数量" width="90" align="right" />
            </el-table>
          </template>

          <template v-else-if="returnRequestDetail">
            <div class="mt-4 rounded-2xl border px-4 py-3 text-sm" :class="returnRequestDetail.status === 'rejected' ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-slate-200 bg-slate-50 text-slate-600'">
              {{ returnRequestResultHint }}
            </div>

            <div class="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div class="rounded-2xl bg-slate-50 px-4 py-3">
                <p class="text-sm text-slate-400">退货总件数</p>
                <p class="mt-1 text-base font-semibold text-slate-900">{{ returnRequestDetail.totalQty }} 件</p>
              </div>
              <div class="rounded-2xl bg-slate-50 px-4 py-3">
                <p class="text-sm text-slate-400">申请时间</p>
                <p class="mt-1 text-sm text-slate-700">{{ returnRequestDetail.createdAt }}</p>
              </div>
              <div class="rounded-2xl bg-slate-50 px-4 py-3">
                <p class="text-sm text-slate-400">退货码</p>
                <p class="mt-1 break-all text-sm text-slate-700">{{ returnRequestDetail.verifyCode }}</p>
              </div>
              <div class="rounded-2xl bg-slate-50 px-4 py-3">
                <p class="text-sm text-slate-400">原订单状态</p>
                <p class="mt-1 text-sm font-medium text-slate-700">
                  {{ VERIFY_CONSOLE_O2O_ORDER_STATUS_LABEL_MAP[returnRequestDetail.sourceOrderStatus] }}
                </p>
              </div>
              <div class="rounded-2xl bg-slate-50 px-4 py-3">
                <p class="text-sm text-slate-400">处理时间</p>
                <p class="mt-1 text-sm text-slate-700">{{ returnRequestDetail.handledAt || '尚未处理' }}</p>
              </div>
              <div class="rounded-2xl bg-slate-50 px-4 py-3">
                <p class="text-sm text-slate-400">处理人</p>
                <p class="mt-1 text-sm text-slate-700">{{ returnRequestDetail.handledBy || '门店待处理' }}</p>
              </div>
            </div>

            <div class="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">退货原因</p>
              <p class="mt-1 text-sm leading-6 text-slate-700">{{ returnRequestDetail.reason }}</p>
            </div>

            <div
              v-if="returnRequestDetail.rejectedReason"
              class="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3"
            >
              <p class="text-sm text-rose-500">拒绝原因</p>
              <p class="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-rose-700">
                {{ returnRequestDetail.rejectedReason }}
              </p>
            </div>

            <el-table class="mt-4" :data="returnRequestDetail.items" row-key="id">
              <el-table-column prop="productName" label="商品名称" min-width="180" />
              <el-table-column prop="productCode" label="商品编码" min-width="140" />
              <el-table-column prop="qty" label="退货数量" width="110" align="right" />
            </el-table>
          </template>
        </template>

        <div v-else class="flex min-h-64 items-center justify-center rounded-2xl border border-dashed border-slate-200 px-6 text-center text-sm leading-6 text-slate-400">
          {{ emptyStateText }}
        </div>
      </section>
    </div>

    <Transition name="verify-mobile-bar">
      <div v-if="isPhone && verifyResult && (showVerifyActionButton || canRejectReturnRequest || canOpenOnsiteAdjust)" class="verify-mobile-bar">
        <div class="flex flex-col gap-2">
          <el-button
            v-if="canOpenOnsiteAdjust"
            type="primary"
            plain
            class="w-full"
            :disabled="onsiteAdjustSubmitting"
            @click="openOnsiteAdjustDialog"
          >
            现场改单
          </el-button>
          <el-button
            v-if="canRejectReturnRequest"
            type="danger"
            plain
            class="w-full"
            :disabled="rejectSubmitting"
            @click="openRejectDialog"
          >
            拒绝退货
          </el-button>
          <el-button
            v-if="showVerifyActionButton"
            type="success"
            class="w-full"
            :disabled="!canVerify"
            :loading="submitting"
            @click="handleVerify"
          >
            {{ verifyButtonText }}
          </el-button>
        </div>
      </div>
    </Transition>

    <el-dialog
      v-if="returnRequestDetail"
      v-model="rejectDialogVisible"
      title="拒绝退货申请"
      width="92%"
      style="max-width: 640px"
      append-to-body
      @closed="handleRejectDialogClosed"
    >
      <div class="space-y-4">
        <div class="rounded-2xl bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-700">
          请填写明确的拒绝原因，保存后核销台与后续查询都会按“已拒绝”结果展示。
        </div>
        <div class="rounded-3xl border border-slate-100 bg-white px-4 py-4">
          <p class="text-sm font-semibold text-slate-900">拒绝原因</p>
          <el-input
            v-model="rejectReason"
            type="textarea"
            :rows="4"
            :maxlength="O2O_RETURN_REJECT_REASON_MAX_LENGTH"
            show-word-limit
            resize="none"
            class="mt-3"
            placeholder="请说明拒绝原因，例如商品已拆封、超过可退期限等。"
          />
          <p class="mt-2 text-xs text-slate-400">最多输入 {{ O2O_RETURN_REJECT_REASON_MAX_LENGTH }} 个字符。</p>
        </div>
      </div>

      <template v-slot:footer>
        <div class="flex flex-wrap justify-end gap-3">
          <el-button @click="rejectDialogVisible = false">取消</el-button>
          <el-button
            type="danger"
            :loading="rejectSubmitting"
            @click="handleSubmitReject"
          >
            确认拒绝
          </el-button>
        </div>
      </template>
    </el-dialog>

    <el-dialog
      v-if="preorderDetail"
      v-model="onsiteAdjustDialogVisible"
      title="现场改单"
      width="92%"
      style="max-width: 860px"
      append-to-body
      @closed="handleOnsiteAdjustDialogClosed"
    >
      <div class="space-y-4">
        <div class="rounded-2xl bg-teal-50 px-4 py-3 text-sm leading-6 text-teal-700">
          待核销订单支持门店按现场实际领取情况调整商品、数量和备注。保存后系统会按最新内容重算预订库存，原核销码保持不变。
        </div>

        <div class="rounded-3xl border border-slate-100 bg-white px-4 py-4">
          <div class="flex flex-col gap-3 lg:flex-row lg:items-end">
            <div class="flex-1">
              <p class="text-sm font-semibold text-slate-900">添加商品</p>
              <el-select
                v-model="onsiteAddProductId"
                class="mt-3 w-full"
                placeholder="请选择要加入订单的商品"
                filterable
                :loading="productCatalogLoading"
              >
                <el-option
                  v-for="product in onsiteEditableProductOptions"
                  :key="product.id"
                  :label="`${product.productName}（剩余 ${product.availableStock} 件）`"
                  :value="product.id"
                />
              </el-select>
            </div>
            <el-button type="primary" plain :disabled="!onsiteEditableProductOptions.length" @click="addOnsiteProduct">加入订单</el-button>
          </div>
          <p v-if="!onsiteEditableProductOptions.length" class="mt-3 text-xs text-slate-400">当前没有可追加到本单的在售商品。</p>
        </div>

        <div class="space-y-3">
          <div
            v-for="item in onsiteOrderItems"
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
                    @update:model-value="updateOnsiteItemQty(item.productId, $event)"
                  />
                </div>
                <el-button text type="danger" @click="removeOnsiteItem(item.productId)">移除</el-button>
              </div>
            </div>
          </div>
        </div>

        <div class="rounded-3xl border border-slate-100 bg-white px-4 py-4">
          <p class="text-sm font-semibold text-slate-900">订单备注</p>
          <el-input
            v-model="onsiteRemark"
            type="textarea"
            :rows="4"
            :maxlength="O2O_PREORDER_REMARK_MAX_LENGTH"
            show-word-limit
            resize="none"
            class="mt-3"
            placeholder="选填：例如现场少拿一件、补加到店现货等说明"
          />
        </div>

        <div class="rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-700">
          修改后共 {{ onsiteTotalQty }} 件商品，合计 ¥{{ onsiteTotalAmount.toFixed(2) }}。
          <p class="mt-2 text-xs text-amber-700">保存成功后，本单后续核销出库会以此结果为准。</p>
        </div>
      </div>

      <template v-slot:footer>
        <div class="flex flex-wrap justify-end gap-3">
          <el-button @click="onsiteAdjustDialogVisible = false">取消</el-button>
          <el-button
            type="primary"
            :loading="onsiteAdjustSubmitting"
            :disabled="!canSubmitOnsiteAdjust"
            @click="handleSubmitOnsiteAdjust"
          >
            保存改单结果
          </el-button>
        </div>
      </template>
    </el-dialog>

    <input
      ref="imageInputRef"
      type="file"
      accept="image/*"
      capture="environment"
      class="hidden"
      @change="handleImageInputChange"
    />

    <UnifiedScanDialog
      v-model="scanDialogVisible"
      title="O2O 单据扫码核销"
      mode-label="核销识别"
      :loading="scanLoading"
      :status-text="scanStatusText"
      hint-text="请将取货码或退货码二维码置于取景框中央，识别成功后会自动查询待处理单据。"
      :bind-scanner-container="bindScannerContainer"
      @closed="closeScanDialog"
    />
  </PageContainer>
</template>

<style scoped>
.verify-console-layout {
  display: grid;
  gap: 1rem;
  grid-template-columns: 1fr;
}

.verify-console-entry :deep(.el-input__wrapper) {
  min-height: 48px;
  border-radius: 14px;
  box-shadow: 0 0 0 1px rgba(226, 232, 240, 0.95) inset;
}

.verify-console-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.verify-console-icon-group {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.verify-console-search-btn {
  border-radius: 14px;
  min-width: 8.5rem;
  padding-inline: 1.2rem;
}

.verify-console-icon-btn {
  border-radius: 14px;
  flex: 0 0 48px;
  min-height: 48px;
  padding: 0;
}

.status-chip {
  border-radius: 9999px;
  font-size: 0.75rem;
  font-weight: 600;
  line-height: 1;
  padding: 0.35rem 0.6rem;
}

.status-chip--pending {
  background: #ecfeff;
  color: #0f766e;
}

.status-chip--verified {
  background: #ecfdf3;
  color: #15803d;
}

.status-chip--cancelled,
.status-chip--rejected {
  background: #fef2f2;
  color: #b91c1c;
}

.verify-mobile-bar {
  position: sticky;
  bottom: calc(8px + env(safe-area-inset-bottom));
  z-index: 20;
  margin-top: 0.75rem;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.94);
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.12);
  padding: 0.65rem;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

.verify-mobile-bar-enter-active,
.verify-mobile-bar-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.verify-mobile-bar-enter-from,
.verify-mobile-bar-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

@media (min-width: 1024px) {
  .verify-console-layout {
    grid-template-columns: 22rem minmax(0, 1fr);
  }
}

@media (max-width: 767px) {
  .verify-console-toolbar {
    gap: 0.75rem;
  }

  .verify-console-icon-group {
    gap: 0.5rem;
  }

  .verify-console-search-btn {
    min-width: 0;
    flex: 1 1 auto;
    padding-inline: 1rem;
  }
}
</style>
