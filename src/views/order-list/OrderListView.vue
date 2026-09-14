<!--
  文件用途：承载管理端出库单列表主页面，是出库查询、详情查看与后续单据操作的页面壳层。
  核心职责：负责装配筛选栏、列表卡片、详情抽屉、手工单内容编辑、自动刷新提示以及正式出库单工作台入口。
  设计原因：把高频使用的列表浏览链路保留在主页面内，把正式出库单这类低频重能力拆到异步子组件，减少主分包体积与首开压力。
  页面边界：当前文件关注“列表与详情”的主交互编排，不直接承载正式出库单的内部打印实现细节。
-->
<script setup lang="ts">
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

import dayjs from 'dayjs'

import { computed, defineAsyncComponent, defineComponent, h, ref, watch, type ComponentPublicInstance } from 'vue'
import { updateOrderComplianceFlags, type OrderDetailResult, type OrderRecord } from '@/api/modules/order'
import type { OrderMergeOrderReference } from '../../../packages/shared-types/src/orders'
import { createTimedAsyncLoader } from './order-list-mobile-card-loader'
import {
  BizResponsiveDataCollectionShell,
  BizResponsiveDrawerShell,
  PageContainer,
  PagePaginationBar,
  PageToolbarCard,
} from '@/components/common'
import { usePermissionAction } from '@/composables/usePermissionAction'
import { showCriticalErrorDialog } from '@/utils/error-dialog'
import { useOrderListView } from './composables/useOrderListView'

import { showAppInfo, showAppSuccess, showAppWarning } from '@/utils/app-alert'

const getOrderTypeLabel = (value: 'department' | 'walkin') => {
  return value === 'department' ? '部门单' : '散客单'
}

/**
 * 列表主显示名称：
 * - 部门单优先显示部门名，更符合后台检索与识别习惯；
 * - 散客单或部门缺失时回退客户名；
 * - 最终兜底为短横线，避免表格留空。
 */
const getOrderDisplayName = (order: {
  orderType: 'department' | 'walkin'
  customerDepartmentName?: string | null
  customerName?: string | null
}) => {
  if (order.orderType === 'department') {
    return order.customerDepartmentName || order.customerName || '-'
  }
  return order.customerName || order.customerDepartmentName || '-'
}

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
  handlePurgeOrderWithConfirm,
  handleRestoreOrderWithConfirm,
  refreshOrders,
} = useOrderListView()
const { hasPermission, ensurePermission } = usePermissionAction()
const OrderDetailDrawerContent = defineAsyncComponent(() => import('./components/OrderDetailDrawerContent.vue'))
const OrderVoucherWorkbenchDialog = defineAsyncComponent(() => import('./components/OrderVoucherWorkbenchDialog.vue'))
const OrderAmendmentDialog = defineAsyncComponent(() => import('./components/OrderAmendmentDialog.vue'))
const OrderContentEditDialog = defineAsyncComponent(() => import('./components/OrderContentEditDialog.vue'))
const OrderMergeDialog = defineAsyncComponent(() => import('./components/OrderMergeDialog.vue'))
const OrderListMobileCardLoading = defineComponent({
  name: 'OrderListMobileCardLoading',
  setup: () => () => h(
    'div',
    { class: 'rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500', 'aria-hidden': 'true' },
    '正在加载订单卡片…',
  ),
})
const OrderListMobileCardLoadError = defineComponent({
  name: 'OrderListMobileCardLoadError',
  setup: () => () => h(
    'div',
    { class: 'rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800', 'aria-hidden': 'true' },
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
const canEditComplianceFlags = computed(() => hasPermission('orders:update'))
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
const hasActiveFilter = computed(() => {
  return Boolean(searchForm.value.keyword || searchForm.value.orderType !== 'all' || searchForm.value.dateRange)
})
const emptyDescription = computed(() => {
  return hasActiveFilter.value ? '未匹配到符合条件的订单，请调整筛选条件后重试' : '暂无订单数据，稍后可通过开单后回来查看'
})
const bindListBodyRef = (element: Element | ComponentPublicInstance | null) => {
  listBodyRef.value = element instanceof HTMLElement ? element : null
}
const getTableRowClassName = (payload: { row: { id: string } }) => {
  return [
    isOrderRecentlyInserted(payload.row.id) ? 'order-list-table-row--new' : '',
    isOrderDetailActive(payload.row.id) ? 'order-list-table-row--active' : '',
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
const getMergeLabel = (order: Pick<OrderRecord, 'merge'>) => {
  if (isParentOrder(order)) return `父单 · 已合并 ${order.merge.children.length} 张`
  return isSourceOrder(order) ? '已合并至父单' : ''
}
type OrderTreeRecord = OrderRecord & { children?: OrderTreeRecord[] }
const toMergeReference = (order: OrderRecord): OrderMergeOrderReference => order
const orderTreeRows = computed<OrderTreeRecord[]>(() => listState.records.map((order) => ({
  ...order,
  children: order.merge.children.map((child) => ({
    ...order,
    ...child,
    contentEditable: false,
    contentEditBlockers: ['已合并至父单，内容不可编辑'],
    merge: { role: 'source', parent: toMergeReference(order), children: [] },
    children: [],
  })),
})))

const syncComplianceFormFromCurrentOrder = (options: { force?: boolean } = {}) => {
  if (!options.force && hasUnsavedComplianceDraft.value) {
    return
  }

  complianceDraftTrackingSuspended.value = true
  complianceForm.value = {
    hasCustomerOrder: Boolean(currentOrder.value?.hasCustomerOrder),
    isSystemApplied: Boolean(currentOrder.value?.isSystemApplied),
  }
  hasUnsavedComplianceDraft.value = false
  complianceDraftTrackingSuspended.value = false
}

watch(
  () => currentOrder.value?.id ?? '',
  (currentOrderId, previousOrderId) => {
    syncComplianceFormFromCurrentOrder({
      // 详细注释：切换到另一张单据时必须强制重置编辑表单，
      // 否则上一张单据的本地草稿会错误带到新详情里。
      force: currentOrderId !== previousOrderId,
    })
  },
)

watch(
  () => [currentOrder.value?.hasCustomerOrder, currentOrder.value?.isSystemApplied],
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
      complianceForm.value.hasCustomerOrder !== Boolean(currentOrder.value?.hasCustomerOrder)
      || complianceForm.value.isSystemApplied !== Boolean(currentOrder.value?.isSystemApplied)
  },
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

const handleSaveComplianceFlags = async () => {
  if (!currentOrder.value) {
    return
  }
  // 状态编辑属于高频越权入口，统一收口到共享权限动作工具：
  // - 保持按钮显隐与点击后二次拦截一致；
  // - 避免订单页继续维护散点 showPermissionDenied 调用。
  if (!ensurePermission('orders:update', '合规状态编辑')) {
    return
  }
  if (currentOrder.value.orderType !== 'department') {
    showAppInfo('散客单不适用该状态编辑')
    return
  }
  complianceSaving.value = true
  try {
    const nextDetail = await updateOrderComplianceFlags(currentOrder.value.id, {
      editVersion: currentOrder.value.editVersion,
      hasCustomerOrder: complianceForm.value.hasCustomerOrder,
      isSystemApplied: complianceForm.value.isSystemApplied,
    })
    currentOrder.value = nextDetail
    hasUnsavedComplianceDraft.value = false
    syncComplianceFormFromCurrentOrder({
      force: true,
    })
    listState.records = listState.records.map((item) =>
      item.id === nextDetail.id
        ? {
            ...item,
            editVersion: nextDetail.editVersion,
            hasCustomerOrder: nextDetail.hasCustomerOrder,
            isSystemApplied: nextDetail.isSystemApplied,
          }
        : item,
    )
    showAppSuccess('状态已更新')
  } catch (error) {
    void showCriticalErrorDialog(error, {
      title: '订单状态更新失败',
      fallback: '状态更新失败，请稍后重试',
      operation: '更新出库单状态',
    })
  } finally {
    complianceSaving.value = false
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
          class="rounded-2xl border border-teal-100 bg-teal-50 px-4 py-3 text-sm text-teal-700"
        >
          正在静默同步最新单据，当前筛选、分页、滚动与详情查看保持不变
        </div>
      </Transition>

      <Transition name="new-order-notice">
        <div
          v-if="newOrderNotice"
          class="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700"
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
              class="flex-1 w-full"
              height="100%"
              table-layout="auto"
              v-loading="listState.loading"
              element-loading-text="正在刷新订单数据，请稍候..."
              @selection-change="handleSelectionChange"
            >
              <el-table-column
                v-if="canAmendOrders || canMergeOrders"
                type="selection"
                width="48"
                reserve-selection
                :selectable="isOrderAmendable"
              />
              <el-table-column label="业务单号" prop="businessNo" min-width="220" show-overflow-tooltip>
                <template #default="{ row }">
                  <span>{{ row.businessNo }}</span>
                  <el-tag v-if="getMergeLabel(row)" class="ml-2" size="small" :type="isSourceOrder(row) ? 'info' : 'success'">{{ getMergeLabel(row) }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="领用对象" min-width="200" show-overflow-tooltip>
                <template #default="{ row }">{{ getOrderDisplayName(row) }}</template>
              </el-table-column>
              <el-table-column label="订单类型" min-width="100">
                <template #default="{ row }">{{ getOrderTypeLabel(row.orderType) }}</template>
              </el-table-column>
              <el-table-column label="出库单状态" width="116" align="center">
                <template #default="{ row }">
                  <el-tag :type="row.orderType === 'department' && row.hasCustomerOrder ? 'success' : 'info'" effect="light">
                    {{ row.orderType === 'department' ? (row.hasCustomerOrder ? '已带单' : '未带单') : '不适用' }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="系统申请" width="96" align="center">
                <template #default="{ row }">
                  <el-tag :type="row.orderType === 'department' && row.isSystemApplied ? 'warning' : 'info'" effect="light">
                    {{ row.orderType === 'department' ? (row.isSystemApplied ? '已申请' : '未申请') : '不适用' }}
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
              <el-table-column label="操作" width="310" fixed="right" align="right">
                <template #default="{ row }">
                  <el-button link type="primary" @click="handleViewDetail(row)">详情</el-button>
                  <el-button v-if="canAmendOrders && !row.isDeleted && !isSourceOrder(row)" link type="warning" @click="openOrderAmendment([row])">修订</el-button>
                  <el-button
                    v-if="canDeleteOrder && !row.isDeleted && !isSourceOrder(row)"
                    link
                    type="danger"
                    @click="handleDeleteOrderWithConfirm(row).catch(() => undefined)"
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
              @delete="handleDeleteOrderWithConfirm($event).catch(() => undefined)"
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
      </template>
      <template #default="{ isPhone, isDesktop }">
        <div
          v-if="currentOrder"
          class="mb-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3"
        >
          <div class="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p class="text-sm font-semibold text-slate-900">合规状态确认</p>
              <p class="mt-1 text-xs text-slate-500">仅部门单可编辑“是否有出库单”和“系统申请”。</p>
            </div>
            <el-button
              v-if="canEditComplianceFlags && currentOrder.orderType === 'department' && currentOrder.merge.role !== 'source'"
              size="small"
              type="primary"
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
                  v-if="canEditComplianceFlags && currentOrder.orderType === 'department' && currentOrder.merge.role !== 'source'"
                  v-model="complianceForm.hasCustomerOrder"
                  inline-prompt
                  active-text="是"
                  inactive-text="否"
                />
                <span v-else class="text-sm font-medium text-slate-700">
                  {{ currentOrder.orderType === 'department' ? (currentOrder.hasCustomerOrder ? '是' : '否') : '不适用' }}
                </span>
              </div>
            </div>
            <div class="rounded-xl bg-white px-3 py-3">
              <p class="text-xs text-slate-500">系统申请</p>
              <div class="mt-2">
                <el-switch
                  v-if="canEditComplianceFlags && currentOrder.orderType === 'department' && currentOrder.merge.role !== 'source'"
                  v-model="complianceForm.isSystemApplied"
                  inline-prompt
                  active-text="已申请"
                  inactive-text="未申请"
                />
                <span v-else class="text-sm font-medium text-slate-700">
                  {{ currentOrder.orderType === 'department' ? (currentOrder.isSystemApplied ? '已申请' : '未申请') : '不适用' }}
                </span>
              </div>
            </div>
          </div>
        </div>
        <OrderDetailDrawerContent
          v-if="currentOrder"
          :order="currentOrder"
          :is-phone="isPhone"
          :is-desktop="isDesktop"
          :detail-grid-class="detailGridClass"
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
