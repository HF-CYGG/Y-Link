<!--
  文件用途：承载管理端出库单列表主页面，是出库查询、详情查看与后续单据操作的页面壳层。
  核心职责：负责装配筛选栏、列表卡片、详情抽屉、手工单内容编辑、自动刷新提示以及正式出库单工作台入口。
  设计原因：把高频使用的列表浏览链路保留在主页面内，把正式出库单这类低频重能力拆到异步子组件，减少主分包体积与首开压力。
  页面边界：当前文件关注“列表与详情”的主交互编排，不直接承载正式出库单的内部打印实现细节。
-->
<script setup lang="ts">
import { formatOrderRecipient } from './order-recipient-display'
/**
 * 模块说明：`src/views/order-list/OrderListView.vue`
 * 文件职责：装配出库单列表、详情抽屉、手工单内容编辑、合规状态编辑、自动刷新提示、新单高亮动画，以及正式出库单低频入口。
 * 实现逻辑：
 * 1. 复用列表 composable 提供的详情查询结果，内容编辑成功后用服务端完整快照刷新抽屉；
 * 2. 将正式出库单编辑、预览、打印、导出整体拆到异步工作台组件，降低 `OrderListView` 主分包体积；
 * 3. 页面层仅保留低频入口控制，确保高频“列表 -> 详情”路径不被打印模板拖重；
 * 4. 列表与移动端卡片按订单类型收口展示字段，部门单展示部门流程字段，散客单隐藏不适用信息；
 * 5. 管理端自动刷新期间仅展示轻量提示，并为新增单据补充克制的入场高亮，不打断当前筛选、分页、滚动与详情抽屉；
 * 6. 清理早期设备调试文案，避免把“手机卡片 / 平板卡片”等开发态信息暴露给最终用户。
 * 7. 内容编辑只在服务端判定可编辑且当前用户具有 `orders:edit` 时开放，成功后同步刷新列表与详情。
 */
import { formatOrderKingdeeStatus } from '@/utils/kingdee-status'


import dayjs from 'dayjs'

import { computed, defineAsyncComponent, defineComponent, h, onBeforeUnmount, ref, watch, type ComponentPublicInstance } from 'vue'
import { getOrderDetailById, updateOrderComplianceFlags, type OrderDetailResult, type OrderRecord } from '@/api/modules/order'
import { updateO2oOrderComplianceFlags } from '@/api/modules/o2o'
import { getKingdeeSession } from '@/utils/kingdee-freshness'
import { normalizeRequestError } from '@/utils/error'
import { createTimedAsyncLoader } from './order-list-mobile-card-loader'
import {
  BizResponsiveDataCollectionShell,
  BizResponsiveDrawerShell,
  PageContainer,
  PagePaginationBar,
  PageToolbarCard,
} from '@/components/common'
import { usePermissionAction } from '@/composables/usePermissionAction'
import { useAuthStore } from '@/store'
import pinia from '@/store/pinia'
import { showCriticalErrorDialog } from '@/utils/error-dialog'
import { useOrderListView } from './composables/useOrderListView'

import { showAppInfo, showAppSuccess, showAppWarning } from '@/utils/app-alert'

const getOrderTypeLabel = (value: 'department' | 'walkin') => {
  return value === 'department' ? '部门单' : '散客单'
}

/** O2O 领取人按真实来源显示，手工单沿用原名称规则。 */
const getOrderDisplayName = formatOrderRecipient

/**
 * 页面入口只负责装配：
 * - 查询、分页、自适应容量与详情抽屉逻辑都迁移到 composable；
 * - 详情区域改由独立展示组件渲染；
 * - 保持原有列表样式、日期筛选与分页行为不变。
 */
const {
  searchForm,
  listState,
  listBodyRef,
  detailGridClass,
  paginationLayout,
  paginationPageSizes,
  drawerVisible,
  drawerLoading,
  currentOrder,
  silentRefreshing,
  autoRefreshStatusText,
  newOrderNotice,
  canDeleteOrder,
  canPurgeOrder,
  isOrderRecentlyInserted,
  isOrderDetailActive,
  dismissNewOrderNotice,
  handleSearch,
  handleReset,
  handleCurrentChange,
  handlePageSizeChange,
  handleViewDetail,
  handleDeleteOrderWithConfirm,
  handleDeleteDialogConfirm,
  deleteDialogVisible,
  deleteDialogOrder,
  deleteDialogSubmitting,
  handlePurgeOrderWithConfirm,
  handleRestoreOrderWithConfirm,
  refreshOrders,
} = useOrderListView()
const { hasPermission, ensurePermission } = usePermissionAction()
const authStore = useAuthStore(pinia)
const isAdmin = computed(() => authStore.currentUser?.role === 'admin')
const ignoreAsyncLoadState = () => undefined
const OrderDetailDrawerLoadError = () => h('p', { role: 'alert', class: 'rounded-xl bg-amber-50 p-3 text-sm text-amber-800' }, '详情加载失败，请刷新后重试。')
const OrderDetailDrawerContent = defineAsyncComponent({
  loader: createTimedAsyncLoader({
    load: () => import('./components/OrderDetailDrawerContent.vue'),
    timeoutMs: 15_000,
    timeoutMessage: '单据详情加载超时',
    onLoading: ignoreAsyncLoadState,
    onSuccess: ignoreAsyncLoadState,
    onError: ignoreAsyncLoadState,
  }),
  errorComponent: OrderDetailDrawerLoadError,
})
const OrderVoucherWorkbenchDialog = defineAsyncComponent(() => import('./components/OrderVoucherWorkbenchDialog.vue'))
const OrderAmendmentDialog = defineAsyncComponent(() => import('./components/OrderAmendmentDialog.vue'))
const OrderContentEditDialog = defineAsyncComponent(() => import('./components/OrderContentEditDialog.vue'))
const OrderMergeDialog = defineAsyncComponent(() => import('./components/OrderMergeDialog.vue'))
let deleteDialogLoadFailed = false
const deleteDialogLoadErrorMessage = '删除确认加载失败，请刷新后重试'
const handleDeleteDialogLoadError = () => {
  deleteDialogLoadFailed = true
  deleteDialogVisible.value = false
  showAppWarning(deleteDialogLoadErrorMessage)
}
const handleOpenDeleteDialog = (row: OrderRecord) => {
  if (deleteDialogLoadFailed) {
    showAppWarning(deleteDialogLoadErrorMessage)
    return
  }
  void handleDeleteOrderWithConfirm(row).catch(() => undefined)
}
const OrderDeleteConfirmDialog = defineAsyncComponent({
  loader: createTimedAsyncLoader({
    load: () => import('./components/OrderDeleteConfirmDialog.vue'),
    timeoutMs: 15_000,
    timeoutMessage: '删除确认弹窗加载超时',
    onLoading: ignoreAsyncLoadState,
    onSuccess: ignoreAsyncLoadState,
    onError: handleDeleteDialogLoadError,
  }),
})
const OrderListMobileCardLoading = defineComponent({
  name: 'OrderListMobileCardLoading',
  setup: () => () => h(
    'div',
    { class: 'rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500 dark:border-white/10 dark:bg-[#141415] dark:text-slate-400', 'aria-hidden': 'true' },
    '正在加载订单卡片…',
  ),
})
const OrderListMobileCardLoadError = defineComponent({
  name: 'OrderListMobileCardLoadError',
  setup: () => () => h(
    'div',
    { class: 'rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900/60 dark:bg-amber-500/10 dark:text-amber-300', 'aria-hidden': 'true' },
    '订单卡片暂时无法加载，请刷新后重试。',
  ),
})
const mobileCardLoadAnnouncement = ref('')
let hasAnnouncedMobileCardLoadError = false
/**
 * 仅当响应式列表实际挂载卡片 slot 时，Vue 才会调用此 loader；桌面树表不会产生加载播报。
 * 单一页面级 live region 避免每一行的 loading/error fallback 重复打断辅助技术阅读。
 */
const loadOrderListMobileCard = createTimedAsyncLoader({
  timeoutMs: 15_000,
  timeoutMessage: '订单卡片加载超时，请刷新后重试。',
  load: () => import('./components/OrderListMobileCard.vue'),
  onLoading: () => {
    mobileCardLoadAnnouncement.value = '正在加载订单卡片。'
  },
  onSuccess: () => {
    mobileCardLoadAnnouncement.value = ''
  },
  onError: () => {
    if (!hasAnnouncedMobileCardLoadError) {
      mobileCardLoadAnnouncement.value = '订单卡片加载失败，请刷新后重试。'
      hasAnnouncedMobileCardLoadError = true
    }
  },
})
const OrderListMobileCard = defineAsyncComponent({
  loader: loadOrderListMobileCard,
  loadingComponent: OrderListMobileCardLoading,
  errorComponent: OrderListMobileCardLoadError,
  delay: 0,
})

const voucherDialogVisible = ref(false)
const enableHtml2pdfExport = import.meta.env.VITE_ORDER_VOUCHER_HTML2PDF_ENABLED !== 'false'
const canUseOrderVoucher = computed(() => currentOrder.value?.orderType === 'department' && currentOrder.value.merge.role !== 'source')
const canEditStandaloneComplianceFlags = computed(() => Boolean(
  currentOrder.value
  && hasPermission('orders:update')
  && currentOrder.value.orderType === 'department'
  && currentOrder.value.merge.role === 'standalone',
))
const canAmendOrders = computed(() => hasPermission('orders:update'))
const amendmentDialogVisible = ref(false)
const contentEditDialogVisible = ref(false)
const mergeDialogVisible = ref(false)
const amendmentTargets = ref<OrderRecord[]>([])
const selectedOrders = ref<OrderRecord[]>([])
const expandedParentOrderIds = ref<string[]>([])
const orderTableRef = ref<{ clearSelection: () => void } | null>(null)
const complianceSaving = ref(false)
const canMergeOrders = computed(() => hasPermission('orders:merge'))
const canEditOrderContent = computed(() => Boolean(
  currentOrder.value
  && hasPermission('orders:edit')
  && currentOrder.value.contentEditable,
))
const complianceDraftTrackingSuspended = ref(false)
const hasUnsavedComplianceDraft = ref(false)
const complianceForm = ref({
  hasCustomerOrder: false,
  isSystemApplied: false,
})
const isO2oComplianceOrder = computed(() => currentOrder.value?.inventoryMode === 'o2o_preapplied' || currentOrder.value?.sourceDocType === 'o2o_preorder')
const complianceSource = computed(() => {
  const order = currentOrder.value
  const sources = order?.sourcePreorderRegistrations ?? []
  return order?.merge.role === 'standalone' && sources.length === 1 && sources[0]?.sourceOrderId === order.id
    ? sources[0] : null
})
const canEditSystemApplied = computed(() => canEditStandaloneComplianceFlags.value && (!isO2oComplianceOrder.value || Boolean(
  complianceSource.value?.sourcePreorderId && complianceSource.value.kingdeeStatus !== null
  && Number.isSafeInteger(complianceSource.value.kingdeeVersion) && complianceSource.value.kingdeeVersion >= 0,
)))
// 草稿基线独立于轮询投影；有未保存输入或冲突时不能偷偷采用新 CAS 版本。
const complianceBaseline = ref({ hasCustomerOrder: false, isSystemApplied: false, editVersion: 0, sourceId: null as string | null, kingdeeVersion: 0 })
const complianceRefreshRequired = ref<'conflict' | 'partial' | 'saved' | null>(null)
const complianceFeedback = ref('')
let complianceGeneration = 0
let complianceRequestSequence = 0
let activeComplianceRequest: number | null = null
const invalidateComplianceRequest = () => {
  complianceGeneration += 1
  activeComplianceRequest = null
  complianceSaving.value = false
}
const beginComplianceRequest = () => {
  const token = ++complianceRequestSequence
  activeComplianceRequest = token
  complianceSaving.value = true
  return token
}
const finishComplianceRequest = (token: number) => {
  if (activeComplianceRequest !== token) return
  activeComplianceRequest = null
  complianceSaving.value = false
}
onBeforeUnmount(invalidateComplianceRequest)
const emptyDescription = computed(() => {
  return searchForm.value.keyword || searchForm.value.orderType !== 'all' || searchForm.value.dateRange
    ? '未匹配到符合条件的订单，请调整筛选条件后重试'
    : '暂无订单数据，稍后可通过开单后回来查看'
})
const bindListBodyRef = (element: Element | ComponentPublicInstance | null) => {
  listBodyRef.value = element instanceof HTMLElement ? element : null
}
const getTableRowClassName = (payload: { row: OrderRecord }) => {
  return [
    isOrderRecentlyInserted(payload.row.id) ? 'order-list-table-row--new' : '',
    isOrderDetailActive(payload.row.id) ? 'order-list-table-row--active' : '',
    payload.row.merge.role === 'source' ? 'order-list-table-row--source' : '',
  ]
    .filter(Boolean)
    .join(' ')
}
const isParentExpanded = (orderId: string) => expandedParentOrderIds.value.includes(orderId)
const toggleParentExpanded = (orderId: string) => {
  expandedParentOrderIds.value = isParentExpanded(orderId)
    ? expandedParentOrderIds.value.filter((id) => id !== orderId)
    : [...expandedParentOrderIds.value, orderId]
}
const isSourceOrder = (order: Pick<OrderRecord, 'merge'>) => order.merge.role === 'source'
const isParentOrder = (order: Pick<OrderRecord, 'merge'>) => order.merge.role === 'parent'
type OrderTreeRecord = OrderRecord & { children?: OrderTreeRecord[] }
const orderTreeRows = computed<OrderTreeRecord[]>(() => listState.records.map((order) => ({
  ...order,
  children: order.merge.children.map((child) => ({
    ...order,
    ...child,
    sourcePreorderPickupContacts: order.sourcePreorderPickupContacts?.filter((source) => source.sourceOrderId === child.id),
    sourcePreorderRegistrations: order.sourcePreorderRegistrations?.filter((source) => source.sourceOrderId === child.id),
    contentEditable: false,
    contentEditBlockers: ['已合并至父单，内容不可编辑'],
    merge: { role: 'source', parent: order, children: [] },
    children: [],
  })),
})))

const syncComplianceFormFromCurrentOrder = (options: { force?: boolean } = {}) => {
  if (!options.force && (hasUnsavedComplianceDraft.value || complianceSaving.value || complianceRefreshRequired.value)) {
    return
  }

  complianceDraftTrackingSuspended.value = true
  complianceForm.value = {
    hasCustomerOrder: Boolean(currentOrder.value?.hasCustomerOrder),
    isSystemApplied: Boolean(currentOrder.value?.isSystemApplied),
  }
  complianceBaseline.value = {
    ...complianceForm.value,
    editVersion: currentOrder.value?.editVersion ?? 0,
    sourceId: complianceSource.value?.sourcePreorderId ?? null,
    kingdeeVersion: complianceSource.value?.kingdeeVersion ?? 0,
  }
  hasUnsavedComplianceDraft.value = false
  complianceDraftTrackingSuspended.value = false
}

watch(
  [() => currentOrder.value?.id, () => complianceSource.value?.sourcePreorderId, () => drawerVisible.value, () => getKingdeeSession('admin').epoch],
  (values, previous) => {
    invalidateComplianceRequest()
    complianceRefreshRequired.value = null
    complianceFeedback.value = ''
    syncComplianceFormFromCurrentOrder({ force: true })
    if (previous && values[3] !== previous[3] && currentOrder.value) complianceRefreshRequired.value = 'conflict'
  },
  { flush: 'sync' },
)

watch(
  () => [currentOrder.value?.hasCustomerOrder, currentOrder.value?.isSystemApplied, currentOrder.value?.editVersion, complianceSource.value?.kingdeeVersion],
  () => {
    syncComplianceFormFromCurrentOrder()
  },
)

watch(
  () => [complianceForm.value.hasCustomerOrder, complianceForm.value.isSystemApplied],
  () => {
    if (complianceDraftTrackingSuspended.value) {
      return
    }

    hasUnsavedComplianceDraft.value =
      complianceForm.value.hasCustomerOrder !== complianceBaseline.value.hasCustomerOrder
      || complianceForm.value.isSystemApplied !== complianceBaseline.value.isSystemApplied
  },
  { flush: 'sync' },
)

watch(
  drawerVisible,
  (visible) => {
    if (visible) {
      return
    }

    hasUnsavedComplianceDraft.value = false
    syncComplianceFormFromCurrentOrder({
      force: true,
    })
  },
)

watch(
  () => currentOrder.value?.orderType ?? 'walkin',
  (orderType) => {
    // 详细注释：正式出库单现在只服务“部门单”，当用户切换到散客单详情时，
    // 需要立即关闭弹窗并清空打印态，避免继续保留上一张部门单的模板界面造成误解。
    if (orderType !== 'department') {
      voucherDialogVisible.value = false
    }
  },
)

/**
 * 打开正式出库单弹窗：
 * - 前提是详情数据已经加载完成；
 * - 仅部门单允许打开；
 * - 弹窗内提供补填表单与正式模板预览，供用户核对后打印。
 */
const handleOpenVoucherDialog = () => {
  if (!currentOrder.value) {
    showAppWarning('请先加载单据详情')
    return
  }
  if (currentOrder.value.orderType !== 'department') {
    showAppInfo('正式出库单仅适用于部门单，散客单无需生成')
    return
  }

  voucherDialogVisible.value = true
}

const isOrderAmendable = (order: OrderRecord) => !order.isDeleted && !isSourceOrder(order)

const handleSelectionChange = (rows: OrderRecord[]) => {
  selectedOrders.value = rows.filter(isOrderAmendable)
}

const isOrderSelected = (orderId: string) => selectedOrders.value.some((order) => order.id === orderId)

const handleMobileSelectionChange = (row: OrderRecord, selected: boolean) => {
  if (!isOrderAmendable(row)) return
  selectedOrders.value = selected
    ? [...selectedOrders.value.filter((order) => order.id !== row.id), row]
    : selectedOrders.value.filter((order) => order.id !== row.id)
}

const openOrderMerge = () => {
  if (!ensurePermission('orders:merge', '合并出库单')) return
  if (selectedOrders.value.length < 2) {
    showAppWarning('请至少选择两张正常单据后再合并')
    return
  }
  if (selectedOrders.value.filter(isParentOrder).length > 1) {
    showAppWarning('一次合并只能选择一个已有父单作为目标')
    return
  }
  mergeDialogVisible.value = true
}

const handleOrderMergeCommitted = async (targetOrderId: string) => {
  selectedOrders.value = []
  orderTableRef.value?.clearSelection()
  await refreshOrders()
  await handleViewDetail({ id: targetOrderId })
}

const openOrderAmendment = (orders: OrderRecord[]) => {
  if (!ensurePermission('orders:update', '历史出库单修订')) return
  if (!orders.length) {
    showAppWarning('请先选择待修订订单')
    return
  }
  if (orders.some((order) => order.isDeleted)) {
    showAppWarning('已删除订单不可修订，请重新选择')
    return
  }
  amendmentTargets.value = orders
  amendmentDialogVisible.value = true
}

const handleAmendmentCommitted = async () => {
  const activeOrderId = currentOrder.value?.id
  selectedOrders.value = []
  orderTableRef.value?.clearSelection()
  await refreshOrders()
  if (activeOrderId && drawerVisible.value) {
    const activeOrder = listState.records.find((order) => order.id === activeOrderId)
    if (activeOrder) await handleViewDetail(activeOrder)
  }
}

const handleOpenContentEdit = () => {
  if (!currentOrder.value || !ensurePermission('orders:edit', '订单内容编辑')) return
  if (!currentOrder.value.contentEditable) {
    showAppWarning(currentOrder.value.contentEditBlockers.join('；') || '当前订单内容已锁定')
    return
  }
  contentEditDialogVisible.value = true
}

const handleContentEditCommitted = async (result: OrderDetailResult) => {
  currentOrder.value = result
  await refreshOrders()
}

const applyComplianceDetail = (detail: OrderDetailResult) => {
  currentOrder.value = detail
  listState.records = listState.records.map((item) => item.id === detail.id ? { ...item, ...detail } : item)
}

// 409 后由用户明确刷新并确认最新版本，保留输入；成功但刷新失败只重读，不重放 PATCH。
const handleRefreshCompliance = async () => {
  if (complianceSaving.value || !currentOrder.value || !drawerVisible.value) return
  const id = currentOrder.value.id
  const generation = complianceGeneration
  const session = getKingdeeSession('admin')
  const reason = complianceRefreshRequired.value
  const draft = { ...complianceForm.value }
  const sourceId = complianceBaseline.value.sourceId
  const active = () => generation === complianceGeneration && session === getKingdeeSession('admin') && drawerVisible.value && currentOrder.value?.id === id
  const token = beginComplianceRequest()
  try {
    const detail = await getOrderDetailById(id)
    if (!active()) return
    applyComplianceDetail(detail)
    complianceRefreshRequired.value = null
    complianceFeedback.value = ''
    syncComplianceFormFromCurrentOrder({ force: true })
    if ((reason === 'conflict' || reason === 'partial') && sourceId === complianceBaseline.value.sourceId) {
      // 部分成功后只保留未保存的申请意图，客户标记采用本次明确读取的正式单状态。
      complianceForm.value = reason === 'partial'
        ? { ...complianceForm.value, isSystemApplied: draft.isSystemApplied }
        : draft
      complianceFeedback.value = reason === 'partial'
        ? '已确认最新状态，仅保留未保存的系统申请草稿，请核对后保存。'
        : '已读取最新状态并确认版本，请核对后再次保存。'
      showAppInfo(complianceFeedback.value)
    }
  } catch (error) {
    if (active()) showAppWarning('状态刷新失败，已保留输入，请重试刷新')
  } finally {
    finishComplianceRequest(token)
  }
}

const handleSaveComplianceFlags = async () => {
  if (complianceSaving.value || !currentOrder.value || !drawerVisible.value) return
  if (!ensurePermission('orders:update', '合规状态编辑') || !canEditStandaloneComplianceFlags.value) return
  if (complianceRefreshRequired.value) {
    showAppWarning('请先刷新并确认最新状态，再保存')
    return
  }
  const order = currentOrder.value
  const baseline = { ...complianceBaseline.value }
  const draft = { ...complianceForm.value }
  const o2o = isO2oComplianceOrder.value
  const customerChanged = draft.hasCustomerOrder !== baseline.hasCustomerOrder
  const appliedChanged = draft.isSystemApplied !== baseline.isSystemApplied
  if (!customerChanged && !appliedChanged) {
    showAppInfo('状态未变化，无需保存')
    return
  }
  if (o2o && appliedChanged && (!canEditSystemApplied.value || baseline.sourceId !== complianceSource.value?.sourcePreorderId)) {
    showAppWarning('来源预订单未唯一确认，系统申请仅供查看')
    return
  }
  if (o2o && appliedChanged && !draft.isSystemApplied && complianceSource.value?.kingdeeVoucherNo) {
    showAppWarning('已有金蝶编号，请先清空编号再改为未申请')
    return
  }
  const generation = complianceGeneration
  const session = getKingdeeSession('admin')
  const active = () => generation === complianceGeneration && session === getKingdeeSession('admin') && drawerVisible.value && currentOrder.value?.id === order.id
  let customerSaved = false
  let appliedSaved = false
  let persisted = false
  const notifyDetachedSave = () => {
    if (session !== getKingdeeSession('admin') || (!persisted && !customerSaved && !appliedSaved)) return
    const result = customerSaved && appliedChanged && !appliedSaved
      ? '客户订单标记已保存；系统申请未保存，请重新打开原单核对。'
      : '提交的状态已保存，请重新打开原单查看最新状态。'
    showAppInfo(`单据 ${order.businessNo || order.id}：${result}`)
  }
  const token = beginComplianceRequest()
  try {
    let nextDetail: OrderDetailResult = order
    if (o2o) {
      if (customerChanged) {
        nextDetail = await updateOrderComplianceFlags(order.id, {
          editVersion: baseline.editVersion,
          hasCustomerOrder: draft.hasCustomerOrder,
        })
        customerSaved = true
        if (!active()) { notifyDetachedSave(); return }
        applyComplianceDetail(nextDetail)
        if (!active()) { notifyDetachedSave(); return }
        // 仅确认已成功的正式单字段，不能从其投影抬高仍待提交的申请 CAS 版本。
        complianceBaseline.value = { ...baseline, hasCustomerOrder: Boolean(nextDetail.hasCustomerOrder), editVersion: nextDetail.editVersion }
        complianceForm.value = { hasCustomerOrder: Boolean(nextDetail.hasCustomerOrder), isSystemApplied: draft.isSystemApplied }
      }
      if (appliedChanged && baseline.sourceId) {
        await updateO2oOrderComplianceFlags(baseline.sourceId, {
          isSystemApplied: draft.isSystemApplied,
          expectedKingdeeVersion: baseline.kingdeeVersion,
        })
        appliedSaved = true
        if (!active()) { notifyDetachedSave(); return }
        nextDetail = await getOrderDetailById(order.id)
      }
    } else {
      nextDetail = await updateOrderComplianceFlags(order.id, {
        editVersion: baseline.editVersion,
        hasCustomerOrder: draft.hasCustomerOrder,
        isSystemApplied: draft.isSystemApplied,
      })
      persisted = true
    }
    if (!active()) { notifyDetachedSave(); return }
    applyComplianceDetail(nextDetail)
    complianceRefreshRequired.value = null
    complianceFeedback.value = ''
    syncComplianceFormFromCurrentOrder({ force: true })
    showAppSuccess('状态已更新')
  } catch (error) {
    if (!active()) { notifyDetachedSave(); return }
    if (customerSaved && appliedChanged && !appliedSaved) {
      complianceRefreshRequired.value = 'partial'
      complianceFeedback.value = `客户订单标记已保存；系统申请未保存：${normalizeRequestError(error).message}。请刷新并确认后仅重试未保存部分。`
      showAppWarning(complianceFeedback.value)
      return
    }
    if (persisted || appliedSaved) {
      complianceRefreshRequired.value = 'saved'
      complianceFeedback.value = '状态已保存，但详情刷新失败；请刷新状态，不要重复提交。'
      showAppWarning(complianceFeedback.value)
      return
    }
    const normalized = normalizeRequestError(error)
    if (normalized.status === 409 || normalized.code === 409) complianceRefreshRequired.value = 'conflict'
    void showCriticalErrorDialog(error, {
      title: '订单状态更新失败',
      fallback: '状态更新失败，请稍后重试',
      operation: '更新出库单状态',
    })
  } finally {
    finishComplianceRequest(token)
  }
}

</script>

<template>
  <PageContainer title="出库单列表" description="按业务单号或日期筛选历史单据，并在抽屉中查看详情。">
    <div class="order-list-container flex min-w-0 flex-col gap-4">
      <p v-if="mobileCardLoadAnnouncement" class="sr-only" aria-live="polite" aria-atomic="true">{{ mobileCardLoadAnnouncement }}</p>
      <PageToolbarCard content-class="items-start">
        <template #default="{ isPhone, isTablet }">
          <div class="flex w-full flex-wrap items-center gap-3">
            <el-input
              v-model="searchForm.keyword"
              placeholder="输入业务单号/客户/部门/出单人关键词"
              :class="isPhone ? '!w-full' : isTablet ? '!w-[240px]' : '!w-[280px]'"
              clearable
            />
            <el-select
              v-model="searchForm.orderType"
              placeholder="订单分类"
              :class="isPhone ? '!w-full' : isTablet ? '!w-[160px]' : '!w-[170px]'"
            >
              <el-option label="全部分类" value="all" />
              <el-option label="部门单" value="department" />
              <el-option label="散客单" value="walkin" />
            </el-select>
            <el-date-picker
              v-model="searchForm.dateRange"
              type="daterange"
              range-separator="至"
              start-placeholder="开始日期"
              end-placeholder="结束日期"
              :class="isPhone ? '!w-full' : isTablet ? '!w-[340px]' : '!w-[380px]'"
            />
            <el-select
              v-if="canDeleteOrder"
              v-model="searchForm.deletionScope"
              :class="isPhone ? '!w-full' : isTablet ? '!w-[170px]' : '!w-[180px]'"
            >
              <el-option label="仅正常单据" value="active" />
              <el-option label="仅已删除单据" value="deleted" />
              <el-option label="全部单据" value="all" />
            </el-select>
            <div :class="['flex gap-2', isPhone ? 'w-full' : '']">
              <el-button :class="isPhone ? 'flex-1' : ''" type="primary" @click="handleSearch" icon="Search">搜索</el-button>
              <el-button :class="isPhone ? 'flex-1' : ''" @click="handleReset" icon="Refresh">重置</el-button>
            </div>
            <el-button
              v-if="canAmendOrders"
              type="warning"
              plain
              :disabled="selectedOrders.length === 0"
              @click="openOrderAmendment(selectedOrders)"
            >
              批量修订（{{ selectedOrders.length }}）
            </el-button>
            <el-button
              v-if="canMergeOrders"
              type="primary"
              plain
              :disabled="selectedOrders.length < 2"
              @click="openOrderMerge"
            >
              合并单据（{{ selectedOrders.length }}）
            </el-button>
          </div>
        </template>
      </PageToolbarCard>

      <Transition name="order-refresh-badge">
        <div
          v-if="silentRefreshing"
          class="rounded-2xl border border-teal-100 bg-teal-50 px-4 py-3 text-sm text-teal-700 dark:border-teal-500/20 dark:bg-teal-500/10 dark:text-teal-300"
        >
          正在静默同步最新单据，当前筛选、分页、滚动与详情查看保持不变
        </div>
      </Transition>

      <Transition name="new-order-notice">
        <div
          v-if="newOrderNotice"
          class="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700 dark:border-amber-900/60 dark:bg-amber-500/10 dark:text-amber-300"
        >
          <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div class="min-w-0">
              <p class="font-medium">新单提醒：新增 {{ newOrderNotice.count }} 张单据，已在当前列表中高亮显示</p>
              <p class="mt-1 text-xs text-amber-600">{{ autoRefreshStatusText }}</p>
            </div>
            <el-button link type="warning" @click="dismissNewOrderNotice">知道了</el-button>
          </div>
        </div>
      </Transition>

      <p v-if="listState.records.length" class="px-1 text-xs text-slate-400">{{ autoRefreshStatusText }}</p>

      <div :ref="bindListBodyRef" class="data-area apple-card flex min-h-0 flex-1 flex-col p-3 sm:p-4 xl:p-5">
        <BizResponsiveDataCollectionShell
          :items="listState.records"
          :loading="listState.loading"
          :empty-description="emptyDescription"
          loading-description="正在加载订单列表，请稍候..."
          empty-min-height="260px"
          :skeleton-rows="8"
          card-key="id"
          wrapper-class="flex min-h-0 flex-1 flex-col"
          table-wrapper-class="flex min-h-0 flex-1 flex-col overflow-hidden px-0"
          card-container-class="flex-1 content-start pb-4"
        >
          <template #table>
            <el-table ref="orderTableRef" native-scrollbar
              :data="orderTreeRows"
              :row-class-name="getTableRowClassName"
              row-key="id"
              :tree-props="{ children: 'children' }"
              stripe
              class="order-list-table flex-1 w-full"
              height="100%"
              table-layout="auto"
              v-loading="listState.loading"
              element-loading-text="正在刷新订单数据，请稍候..."
              @selection-change="handleSelectionChange"
            >
              <el-table-column
                v-if="canAmendOrders || canMergeOrders"
                type="selection"
                class-name="order-list-table__selection-cell"
                width="48"
                reserve-selection
                :selectable="isOrderAmendable"
              />
              <el-table-column label="业务单号" prop="businessNo" width="280" class-name="order-list-table__business-cell">
                <template #default="{ row }">
                  <div class="order-list-identity" :class="{ 'is-parent': isParentOrder(row), 'is-source': isSourceOrder(row) }">
                    <div class="order-list-identity__main">
                      <span class="order-list-identity__number" :title="row.businessNo">{{ row.businessNo }}</span>
                      <el-tag v-if="isParentOrder(row) || isSourceOrder(row)" size="small" :type="isSourceOrder(row) ? 'info' : 'success'">{{ isSourceOrder(row) ? '来源子单' : '合并父单' }}</el-tag>
                    </div>
                    <div v-if="isParentOrder(row)" class="order-list-identity__summary">本单 + {{ row.merge.children.length }} 张来源单 · 数量和金额为汇总</div>
                    <div v-else-if="isSourceOrder(row)" class="order-list-identity__summary">归属父单 {{ row.merge.parent?.businessNo || '-' }} · 数量和金额为来源口径</div>
                    <el-tag v-if="row.matchedIdentifierType && row.matchedIdentifierValue && (row.matchedIdentifierType !== 'systemNo' || isAdmin)" size="small" effect="plain" type="warning">
                      命中{{ row.matchedIdentifierType === 'businessNo' ? '业务单号' : row.matchedIdentifierType === 'systemNo' ? '系统编号' : '预订单号' }}：{{ row.matchedIdentifierValue }}
                    </el-tag>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="领用对象" min-width="200" show-overflow-tooltip>
                <template #default="{ row }">{{ getOrderDisplayName(row) }}</template>
              </el-table-column>
              <el-table-column label="订单类型" width="100" class-name="order-list-table__type-cell" label-class-name="order-list-table__type-header">
                <template #default="{ row }">{{ getOrderTypeLabel(row.orderType) }}</template>
              </el-table-column>
              <el-table-column label="出库单状态" width="116" align="center">
                <template #default="{ row }">
                  <el-tag :type="row.orderType === 'department' && row.hasCustomerOrder ? 'success' : 'info'" effect="light">
                    {{ row.orderType === 'department' ? (row.hasCustomerOrder ? '已带单' : '未带单') : '不适用' }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="金蝶状态" width="96" align="center">
                <template #default="{ row }">
                  <el-tag :type="row.orderType === 'department' && row.isSystemApplied ? 'warning' : 'info'" effect="light">
                    {{ formatOrderKingdeeStatus(row) }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="出单人" min-width="140" show-overflow-tooltip>
                <template #default="{ row }">{{ row.issuerName || '-' }}</template>
              </el-table-column>
              <el-table-column label="客户部门" min-width="160" show-overflow-tooltip>
                <template #default="{ row }">{{ row.orderType === 'department' ? row.customerDepartmentName || '-' : '不适用' }}</template>
              </el-table-column>
              <el-table-column label="总数量" prop="totalQty" width="110" />
              <el-table-column label="总金额" prop="totalAmount" width="132">
                <template #default="{ row }">
                  <span class="font-medium text-red-500">¥{{ Number(row.totalAmount).toFixed(2) }}</span>
                </template>
              </el-table-column>
              <el-table-column label="开单人" min-width="160" show-overflow-tooltip>
                <template #default="{ row }">
                  {{ row.creatorDisplayName || row.creatorUsername || '-' }}
                </template>
              </el-table-column>
              <el-table-column label="开单时间" prop="createdAt" width="186">
                <template #default="{ row }">
                  {{ dayjs(row.createdAt).format('YYYY-MM-DD HH:mm') }}
                </template>
              </el-table-column>
              <el-table-column label="状态" width="98" align="center">
                <template #default="{ row }">
                  <el-tag v-if="row.isDeleted" type="danger" effect="light">已删除</el-tag>
                  <el-tag v-else type="success" effect="light">正常</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="操作" width="310" fixed="right" align="right" class-name="order-list-table__actions-cell">
                <template #default="{ row }">
                  <el-button link type="primary" @click="handleViewDetail(row)">详情</el-button>
                  <el-button v-if="canAmendOrders && !row.isDeleted && !isSourceOrder(row)" link type="warning" @click="openOrderAmendment([row])">修订</el-button>
                  <el-button
                    v-if="canDeleteOrder && !row.isDeleted && !isSourceOrder(row)"
                    link
                    type="danger"
                    @click="handleOpenDeleteDialog(row)"
                  >
                    删除
                  </el-button>
                  <el-button
                    v-if="canDeleteOrder && row.isDeleted && !isSourceOrder(row)"
                    link
                    type="warning"
                    @click="handleRestoreOrderWithConfirm(row).catch(() => undefined)"
                  >
                    恢复
                  </el-button>
                  <el-button
                    v-if="canPurgeOrder && row.isDeleted && !isSourceOrder(row)"
                    link
                    type="danger"
                    @click="handlePurgeOrderWithConfirm(row).catch(() => undefined)"
                  >
                    永久删除
                  </el-button>
                </template>
              </el-table-column>
            </el-table>
          </template>

          <template #card="{ item, isTablet }">
            <OrderListMobileCard
              :item="item"
              :is-tablet="isTablet"
              :selected="isOrderSelected(item.id)"
              :can-select="(canAmendOrders || canMergeOrders) && !item.isDeleted && !isSourceOrder(item)"
              :can-amend="canAmendOrders"
              :can-delete="canDeleteOrder"
              :can-purge="canPurgeOrder"
              :parent-expanded="isParentExpanded(item.id)"
              :is-new="isOrderRecentlyInserted(item.id)"
              :is-active="isOrderDetailActive(item.id)"
              @view="handleViewDetail"
              @view-id="handleViewDetail({ id: $event })"
              @select="handleMobileSelectionChange(item, $event)"
              @amend="openOrderAmendment([$event])"
              @delete="handleOpenDeleteDialog"
              @restore="handleRestoreOrderWithConfirm($event).catch(() => undefined)"
              @purge="handlePurgeOrderWithConfirm($event).catch(() => undefined)"
              @toggle-parent="toggleParentExpanded"
            />
          </template>
        </BizResponsiveDataCollectionShell>

        <PagePaginationBar
          v-if="listState.total > 0"
          v-model:current-page="listState.query.page"
          v-model:page-size="listState.query.pageSize"
          :layout="paginationLayout"
          :page-sizes="paginationPageSizes"
          :total="listState.total"
          @current-change="handleCurrentChange"
          @size-change="handlePageSizeChange"
        />
      </div>
    </div>

    <BizResponsiveDrawerShell
      v-model="drawerVisible"
      title="单据详情"
      height-mode="scroll"
      tablet-size="50vw"
      desktop-size="50vw"
      :loading="drawerLoading"
      :close-on-click-modal="true"
      body-class="order-detail-content"
      drawer-class="order-detail-drawer"
    >
      <template #header>
        <div class="order-detail-drawer-header">
          <span class="order-detail-drawer-header__title">单据详情</span>
          <div class="order-detail-drawer-header__actions">
            <el-button
              v-if="hasPermission('orders:edit') && currentOrder?.merge.role !== 'source'"
              plain
              type="warning"
              :disabled="!canEditOrderContent"
              @click="handleOpenContentEdit"
            >
              编辑内容
            </el-button>
            <el-button v-if="canUseOrderVoucher" plain type="primary" @click="handleOpenVoucherDialog">正式出库单</el-button>
          </div>
        </div>
      </template>
      <template #default="{ isPhone, isDesktop }">
        <OrderDetailDrawerContent
          v-if="currentOrder"
          :order="currentOrder"
          :is-phone="isPhone"
          :is-desktop="isDesktop"
          :detail-grid-class="detailGridClass"
          :can-edit-standalone-compliance-flags="canEditStandaloneComplianceFlags"
          :compliance-form="complianceForm"
          :compliance-saving="complianceSaving"
          :can-edit-system-applied="canEditSystemApplied"
          :compliance-refresh-required="complianceRefreshRequired"
          :compliance-feedback="complianceFeedback"
          @update:has-customer-order="complianceForm.hasCustomerOrder = $event"
          @update:is-system-applied="complianceForm.isSystemApplied = $event"
          @save-compliance="handleSaveComplianceFlags"
          @refresh-compliance="handleRefreshCompliance"
          @navigate="handleViewDetail({ id: $event })"
        />
      </template>
    </BizResponsiveDrawerShell>

    <OrderVoucherWorkbenchDialog
      v-if="canUseOrderVoucher && currentOrder"
      v-model="voucherDialogVisible"
      :order="currentOrder"
      :enable-html2pdf-export="enableHtml2pdfExport"
    />

    <OrderAmendmentDialog
      v-if="canAmendOrders"
      v-model="amendmentDialogVisible"
      :orders="amendmentTargets"
      @committed="handleAmendmentCommitted"
    />

    <OrderContentEditDialog
      v-if="currentOrder && hasPermission('orders:edit')"
      v-model="contentEditDialogVisible"
      :order="currentOrder"
      @committed="handleContentEditCommitted"
    />

    <OrderDeleteConfirmDialog
      v-if="deleteDialogVisible"
      v-model="deleteDialogVisible"
      :order="deleteDialogOrder"
      :submitting="deleteDialogSubmitting"
      @confirm="handleDeleteDialogConfirm"
    />

    <OrderMergeDialog
      v-if="canMergeOrders"
      v-model="mergeDialogVisible"
      :orders="selectedOrders"
      @committed="handleOrderMergeCommitted"
    />
  </PageContainer>
</template>

<style scoped>
.order-list-container {
  min-height: calc(100dvh - 190px);
}

.order-detail-content {
  padding: 14px 14px 18px;
  background: linear-gradient(180deg, rgba(15, 118, 110, 0.03) 0%, rgba(15, 118, 110, 0) 28%);
}

.order-detail-drawer-header {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  padding-right: 10px;
}

.order-detail-drawer-header__title {
  font-size: 22px;
  font-weight: 600;
  color: #0f172a;
}

.dark .order-detail-drawer-header__title {
  color: #e2e8f0;
}

.order-detail-drawer-header :deep(.el-button) {
  flex-shrink: 0;
}

/* 相邻按钮间距交给容器 gap，清零 Element Plus 默认 margin-left，避免间距与 gap 叠加 */
.order-detail-drawer-header__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  margin-left: auto;
}

.order-detail-drawer-header__actions :deep(.el-button + .el-button) {
  margin-left: 0;
}

@media (max-width: 768px) {
  .order-detail-drawer-header {
    padding-right: 0;
  }

  .order-detail-drawer-header__title {
    font-size: 18px;
  }
}

/* 清理旧的内容区吸顶按钮样式 */
.order-detail-sticky-actions {
  display: none;
  z-index: 5;
  background: transparent;
}

@media (min-width: 768px) {
  .order-detail-content {
    padding: 16px 18px 20px;
  }
}

.order-detail-content :deep(.el-descriptions__label),
.order-detail-content :deep(.el-descriptions__content) {
  background-color: transparent;
}

.dark .order-detail-content :deep(.el-descriptions__label) {
  color: #cbd5e1;
}

.dark .order-detail-content :deep(.el-descriptions__content) {
  color: #e2e8f0;
}

/* 固定操作列自身合成不透明底色，防止横向滚动的单元格内容透出。 */
.order-list-table :deep(.order-list-table__type-cell .cell),
.order-list-table :deep(.order-list-table__type-header .cell) {
  white-space: nowrap;
}

.order-list-table :deep(.order-list-table-row--source .order-list-table__selection-cell .el-checkbox) { display: none; }

.order-list-table :deep(.order-list-table__business-cell .cell) { display: flex; align-items: center; white-space: normal; overflow: visible; text-overflow: clip; }
.order-list-table :deep(.order-list-table__business-cell .el-table__indent),
.order-list-table :deep(.order-list-table__business-cell .el-table__expand-icon),
.order-list-table :deep(.order-list-table__business-cell .el-table__placeholder) { flex: 0 0 auto; }
.order-list-identity { flex: 1 1 auto; min-width: 0; max-width: 100%; padding: 5px 0; overflow-wrap: anywhere; }
.order-list-identity__number { min-width: 0; overflow-wrap: anywhere; }
.order-list-identity :deep(.el-tag) { max-width: 100%; height: auto; white-space: normal; }
.order-list-identity :deep(.el-tag__content) { overflow-wrap: anywhere; }
.order-list-identity.is-source { margin-left: 8px; padding-left: 14px; }
.order-list-identity__main { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-weight: 600; }
.order-list-identity__summary { color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.5; white-space: normal; }

.order-list-table :deep(.el-table__body tr > td.order-list-table__actions-cell) {
  --order-fixed-row-bg: var(--el-table-tr-bg-color);
  background-color: var(--order-fixed-row-bg);
}

.order-list-table :deep(.el-table__body tr.el-table__row--striped > td.order-list-table__actions-cell) {
  --order-fixed-row-bg: var(--el-fill-color-lighter);
  background-color: var(--order-fixed-row-bg);
}

.order-list-table :deep(.el-table__body tr.hover-row > td.order-list-table__actions-cell),
.order-list-table :deep(.el-table__body tr:hover > td.order-list-table__actions-cell) {
  --order-fixed-row-bg: var(--el-fill-color-light);
  background-color: var(--order-fixed-row-bg);
}

:global(.dark .order-list-table .el-table__body tr.hover-row > td.order-list-table__actions-cell),
:global(.dark .order-list-table .el-table__body tr:hover > td.order-list-table__actions-cell) {
  --order-fixed-row-bg: #1d1d1e;
}

.order-list-table :deep(.el-table__body tr.order-list-table-row--active > td.order-list-table__actions-cell) {
  --order-fixed-row-bg: #e7f4f3;
  background: var(--order-fixed-row-bg) !important;
}

:global(.dark .order-list-table .el-table__body tr.order-list-table-row--active > td.order-list-table__actions-cell) {
  --order-fixed-row-bg: #132121;
}

.order-list-table :deep(.el-table__body tr.order-list-table-row--new > td.order-list-table__actions-cell) {
  animation-name: order-table-fixed-row-fade-highlight;
}

:global(.dark .order-list-table .el-table__body tr.order-list-table-row--new > td.order-list-table__actions-cell) {
  animation-name: order-table-fixed-row-fade-highlight-dark;
}

@keyframes order-table-fixed-row-fade-highlight {
  0% { background-color: #fef4cd; }
  65% { background-color: #fefdf0; }
  100% { background-color: var(--order-fixed-row-bg); }
}

@keyframes order-table-fixed-row-fade-highlight-dark {
  0% { background-color: #41321a; }
  65% { background-color: #2b2114; }
  100% { background-color: var(--order-fixed-row-bg); }
}

:deep(.el-table__body tr.order-list-table-row--active > td) {
  background: rgba(13, 148, 136, 0.1) !important;
}

:deep(.el-table__body tr.order-list-table-row--new > td) {
  animation: order-table-row-fade-highlight 1s ease;
}

@keyframes order-table-row-fade-highlight {
  0% {
    background-color: rgba(254, 243, 199, 0.9);
  }

  65% {
    background-color: rgba(254, 252, 232, 0.72);
  }

  100% {
    background-color: transparent;
  }
}

/* 暗色：新单高亮改用低饱和琥珀色，避免暗色表格里闪出一行亮黄。 */
:global(.dark .el-table__body tr.order-list-table-row--new > td) {
  animation-name: order-table-row-fade-highlight-dark;
}

@keyframes order-table-row-fade-highlight-dark {
  0% {
    background-color: rgba(245, 158, 11, 0.22);
  }

  65% {
    background-color: rgba(245, 158, 11, 0.1);
  }

  100% {
    background-color: transparent;
  }
}

.order-refresh-badge-enter-active,
.order-refresh-badge-leave-active,
.new-order-notice-enter-active,
.new-order-notice-leave-active {
  transition: opacity 0.22s ease, transform 0.22s ease;
}

.order-refresh-badge-enter-from,
.order-refresh-badge-leave-to,
.new-order-notice-enter-from,
.new-order-notice-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

@media (prefers-reduced-motion: reduce) {
  :deep(.el-table__body tr.order-list-table-row--new > td) {
    animation: none !important;
  }

  .order-refresh-badge-enter-active,
  .order-refresh-badge-leave-active,
  .new-order-notice-enter-active,
  .new-order-notice-leave-active {
    transition-duration: 0.01ms !important;
  }
}

</style>
