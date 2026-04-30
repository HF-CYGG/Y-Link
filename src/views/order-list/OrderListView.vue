<script setup lang="ts">
/**
 * 模块说明：`src/views/order-list/OrderListView.vue`
 * 文件职责：装配出库单列表、详情抽屉、正式出库单预览弹窗，以及在线补填后打印/导出 PDF 的完整流程。
 * 实现逻辑：
 * 1. 复用列表 composable 提供的详情查询结果，不新增服务端接口；
 * 2. 在页面层维护正式出库单的临时补填字段，切换单据时自动重置，不写回数据库；
 * 3. 预览区与打印区共用同一个模板组件，确保用户看到什么、打印出来就是什么；
 * 4. 列表与移动端卡片按订单类型收口展示字段，部门单展示部门流程字段，散客单隐藏不适用信息；
 * 5. 清理早期设备调试文案，避免把“手机卡片 / 平板卡片”等开发态信息暴露给最终用户。
 */

import dayjs from 'dayjs'
import { ElMessage } from 'element-plus'
import { computed, nextTick, reactive, ref, watch } from 'vue'
import {
  BizResponsiveDataCollectionShell,
  BizResponsiveDrawerShell,
  PageContainer,
  PagePaginationBar,
  PageToolbarCard,
} from '@/components/common'
import { extractErrorMessage } from '@/utils/error'
import { exportVoucherPdf } from '@/utils/pdf/export-voucher-pdf'
import OrderDetailDrawerContent from './components/OrderDetailDrawerContent.vue'
import OrderVoucherTemplate from './components/OrderVoucherTemplate.vue'
import { useOrderListView } from './composables/useOrderListView'

const getOrderTypeLabel = (value: 'department' | 'walkin') => {
  return value === 'department' ? '部门单' : '散客单'
}

/**
 * 卡片状态展示文案：
 * - 将“出库单状态 / 系统申请 / 记录状态”统一收敛到结构化方法，避免模板中重复三元表达式；
 * - 同时输出语义化样式类别，便于在平板卡片中建立主次层级。
 */
const getShipmentStatusMeta = (order: {
  orderType: 'department' | 'walkin'
  hasCustomerOrder?: boolean
}) => {
  if (order.orderType !== 'department') {
    return {
      label: '不适用',
      toneClass: 'is-neutral',
    }
  }
  return {
    label: order.hasCustomerOrder ? '已带单' : '未带单',
    toneClass: order.hasCustomerOrder ? 'is-positive' : 'is-warning',
  }
}

const getSystemApplyStatusMeta = (order: {
  orderType: 'department' | 'walkin'
  isSystemApplied?: boolean
}) => {
  if (order.orderType !== 'department') {
    return {
      label: '不适用',
      toneClass: 'is-neutral',
    }
  }
  return {
    label: order.isSystemApplied ? '已申请' : '未申请',
    toneClass: order.isSystemApplied ? 'is-warning' : 'is-neutral',
  }
}

const getRecordStatusMeta = (order: { isDeleted?: boolean }) => {
  return order.isDeleted
    ? {
        label: '已删除',
        toneClass: 'is-danger',
      }
    : {
        label: '正常',
        toneClass: 'is-positive',
      }
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

interface OrderVoucherEditableFields {
  departmentOperator: string
  kingdeeVoucherNo: string
  receiverSignature: string
  issuerSignature: string
  completionSignature: string
}

type VoucherOrientation = 'portrait' | 'landscape'

/**
 * 字段映射说明：
 * - 固定字段只由模板结构决定，不需要用户维护；
 * - 自动填充字段直接取当前详情数据；
 * - 在线补填字段仅保存在当前页面内存中，关闭或切换单据后重新初始化。
 */
const ORDER_VOUCHER_FIXED_FIELDS_TEXT = '固定版式字段：标题区、基础信息区、明细区、汇总区与签字区'
const ORDER_VOUCHER_AUTO_FIELDS_TEXT = '自动填充字段：申请部门、商品名称、产品编码、单价、数量、小计、总计、业务单号'
const ORDER_VOUCHER_EDITABLE_FIELDS_TEXT = '在线补填字段：部门经办人、金蝶单据编号、领取人签字、出库人签字、完成日期/签字'

const createEmptyVoucherEditableFields = (): OrderVoucherEditableFields => ({
  departmentOperator: '',
  kingdeeVoucherNo: '',
  receiverSignature: '',
  issuerSignature: '',
  completionSignature: '',
})

/**
 * 页面入口只负责装配：
 * - 查询、分页、自适应容量与详情抽屉逻辑都迁移到 composable；
 * - 详情区域改由独立展示组件渲染；
 * - 保持原有列表样式、日期筛选与分页行为不变。
 */
const {
  searchForm,
  listState,
  detailGridClass,
  paginationLayout,
  paginationPageSizes,
  drawerVisible,
  drawerLoading,
  currentOrder,
  canDeleteOrder,
  handleSearch,
  handleReset,
  handleCurrentChange,
  handlePageSizeChange,
  handleViewDetail,
  handleDeleteOrderWithConfirm,
  handleRestoreOrderWithConfirm,
} = useOrderListView()

const voucherDialogVisible = ref(false)
const voucherPrintRootRef = ref<HTMLElement | null>(null)
const enableHtml2pdfExport = import.meta.env.VITE_ORDER_VOUCHER_HTML2PDF_ENABLED !== 'false'
const exportPdfLoading = ref(false)
const voucherEditableForm = reactive<OrderVoucherEditableFields>(createEmptyVoucherEditableFields())
const voucherOrientation = ref<VoucherOrientation>('landscape')
const voucherOrientationLabel = computed(() => (voucherOrientation.value === 'landscape' ? '横版' : '竖版'))
const canUseOrderVoucher = computed(() => currentOrder.value?.orderType === 'department')
const hasActiveFilter = computed(() => {
  return Boolean(searchForm.value.keyword || searchForm.value.orderType !== 'all' || searchForm.value.dateRange)
})
const emptyDescription = computed(() => {
  return hasActiveFilter.value ? '未匹配到符合条件的订单，请调整筛选条件后重试' : '暂无订单数据，稍后可通过开单后回来查看'
})

/**
 * 重置临时补填字段：
 * - 当用户切换到另一张单据时，上一张单据的手工录入内容必须清空；
 * - 这样可以防止部门经办人、签字信息串单打印。
 */
const resetVoucherEditableForm = () => {
  Object.assign(voucherEditableForm, createEmptyVoucherEditableFields())
}

watch(
  () => currentOrder.value?.id ?? '',
  () => {
    resetVoucherEditableForm()
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
    ElMessage.warning('请先加载单据详情')
    return
  }
  if (currentOrder.value.orderType !== 'department') {
    ElMessage.info('正式出库单仅适用于部门单，散客单无需生成')
    return
  }

  voucherOrientation.value = 'landscape'
  voucherDialogVisible.value = true
}

const VOUCHER_PRINT_STYLE_ID = 'y-link-order-voucher-print-page-style'

// 详细注释：浏览器打印无法稳定从组件局部样式中动态切换 @page 方向，
// 因此在点击打印前按当前选择临时注入全局打印页样式，打印结束后再清理。
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

/**
 * 打印正式出库单：
 * - 直接调用浏览器打印；
 * - 打印区使用隐藏的专用根节点，只输出正式模板内容。
 */
const handlePrintVoucher = async () => {
  if (!currentOrder.value) {
    ElMessage.warning('当前无可打印凭证')
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

/**
 * 导出 PDF：
 * - 与打印共用同一份正式模板 DOM；
 * - 这样导出的内容能完整带上当前补填后的预览结果。
 */
const handleExportVoucherPdf = async () => {
  if (!enableHtml2pdfExport) {
    ElMessage.info('PDF 导出开关未启用，当前仅支持打印')
    return
  }

  if (!currentOrder.value) {
    ElMessage.warning('当前无可导出的凭证')
    return
  }

  const sourceElement = voucherPrintRootRef.value?.querySelector('.voucher-print-document')
  if (!(sourceElement instanceof HTMLElement)) {
    ElMessage.warning('凭证模板尚未准备完成，请稍后重试')
    return
  }

  const outputFileName = `${currentOrder.value.showNo || 'order-voucher'}-正式出库单.pdf`

  exportPdfLoading.value = true
  try {
    await exportVoucherPdf({
      sourceElement,
      filename: outputFileName,
      marginMm: 8,
      scale: 2,
      orientation: voucherOrientation.value,
    })
    ElMessage.success('PDF 导出成功')
  } catch (error) {
    ElMessage.error(extractErrorMessage(error, 'PDF 导出失败，请稍后重试'))
  } finally {
    exportPdfLoading.value = false
  }
}
</script>

<template>
  <PageContainer title="出库单列表" description="按业务单号或日期筛选历史单据，并在抽屉中查看详情。">
    <div class="order-list-container flex min-w-0 flex-col gap-4">
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
          </div>
        </template>
      </PageToolbarCard>

      <div class="data-area apple-card flex min-h-0 flex-1 flex-col p-3 sm:p-4 xl:p-5">
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
            <el-table
              :data="listState.records"
              stripe
              class="flex-1 w-full"
              height="100%"
              table-layout="auto"
              v-loading="listState.loading"
              element-loading-text="正在刷新订单数据，请稍候..."
            >
              <el-table-column label="业务单号" prop="showNo" min-width="180" show-overflow-tooltip />
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
              <el-table-column label="操作" width="190" fixed="right" align="right">
                <template #default="{ row }">
                  <el-button link type="primary" @click="handleViewDetail(row)">详情</el-button>
                  <el-button
                    v-if="canDeleteOrder && !row.isDeleted"
                    link
                    type="danger"
                    @click="handleDeleteOrderWithConfirm(row).catch(() => undefined)"
                  >
                    删除
                  </el-button>
                  <el-button
                    v-if="canDeleteOrder && row.isDeleted"
                    link
                    type="warning"
                    @click="handleRestoreOrderWithConfirm(row).catch(() => undefined)"
                  >
                    恢复
                  </el-button>
                </template>
              </el-table-column>
            </el-table>
          </template>

          <template #card="{ item, isTablet }">
            <div class="apple-card mobile-order-card min-w-0 p-4 active:scale-[0.99]" @click="handleViewDetail(item)">
              <div class="mobile-order-card__head">
                <div class="min-w-0">
                  <div class="mobile-order-card__show-no">{{ item.showNo }}</div>
                  <div class="mobile-order-card__time">
                    {{ dayjs(item.createdAt).format('YYYY-MM-DD HH:mm') }}
                  </div>
                </div>
                <div class="mobile-order-card__head-tags">
                  <span class="mobile-order-card__chip is-brand">
                    {{ getRecordStatusMeta(item).label }}
                  </span>
                  <span class="mobile-order-card__chip is-brand-soft">
                    {{ getOrderTypeLabel(item.orderType) }}
                  </span>
                </div>
              </div>

              <div class="mobile-order-card__primary">
                <p class="mobile-order-card__primary-label">领用对象</p>
                <p class="mobile-order-card__primary-value">{{ getOrderDisplayName(item) }}</p>
              </div>

              <div class="mobile-order-card__metrics">
                <span class="mobile-order-card__metric-qty">数量：{{ Number(item.totalQty).toFixed(2) }}</span>
                <span class="mobile-order-card__metric-amount">¥{{ Number(item.totalAmount).toFixed(2) }}</span>
              </div>

              <div class="mobile-order-card__meta" :class="isTablet ? 'is-tablet' : ''">
                <div class="mobile-order-card__meta-item">
                  <span class="mobile-order-card__meta-label">出库单状态</span>
                  <span class="mobile-order-card__meta-value" :class="getShipmentStatusMeta(item).toneClass">
                    {{ getShipmentStatusMeta(item).label }}
                  </span>
                </div>
                <div class="mobile-order-card__meta-item">
                  <span class="mobile-order-card__meta-label">系统申请</span>
                  <span class="mobile-order-card__meta-value" :class="getSystemApplyStatusMeta(item).toneClass">
                    {{ getSystemApplyStatusMeta(item).label }}
                  </span>
                </div>
                <div class="mobile-order-card__meta-item">
                  <span class="mobile-order-card__meta-label">出单人</span>
                  <span class="mobile-order-card__meta-value">{{ item.issuerName || '-' }}</span>
                </div>
                <div class="mobile-order-card__meta-item">
                  <span class="mobile-order-card__meta-label">开单人</span>
                  <span class="mobile-order-card__meta-value">{{ item.creatorDisplayName || item.creatorUsername || '-' }}</span>
                </div>
                <div v-if="item.orderType === 'department'" class="mobile-order-card__meta-item">
                  <span class="mobile-order-card__meta-label">客户部门</span>
                  <span class="mobile-order-card__meta-value">{{ item.customerDepartmentName || '-' }}</span>
                </div>
                <div v-if="item.customerName" class="mobile-order-card__meta-item">
                  <span class="mobile-order-card__meta-label">客户名称</span>
                  <span class="mobile-order-card__meta-value">{{ item.customerName }}</span>
                </div>
              </div>

              <div v-if="canDeleteOrder" class="mobile-order-card__actions">
                <el-button link type="primary" @click.stop="handleViewDetail(item)">详情</el-button>
                <el-button
                  v-if="!item.isDeleted"
                  link
                  type="danger"
                  @click.stop="handleDeleteOrderWithConfirm(item).catch(() => undefined)"
                >
                  删除
                </el-button>
                <el-button
                  v-else
                  link
                  type="warning"
                  @click.stop="handleRestoreOrderWithConfirm(item).catch(() => undefined)"
                >
                  恢复
                </el-button>
              </div>
              <div v-else class="mobile-order-card__actions">
                <el-button link type="primary" @click.stop="handleViewDetail(item)">详情</el-button>
              </div>
            </div>
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
          <el-button v-if="canUseOrderVoucher" plain type="primary" @click="handleOpenVoucherDialog">正式出库单</el-button>
        </div>
      </template>
      <template #default="{ isPhone, isDesktop }">
        <OrderDetailDrawerContent
          v-if="currentOrder"
          :order="currentOrder"
          :is-phone="isPhone"
          :is-desktop="isDesktop"
          :detail-grid-class="detailGridClass"
        />
      </template>
    </BizResponsiveDrawerShell>

    <el-dialog
      v-if="canUseOrderVoucher && currentOrder"
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
          <span>{{ ORDER_VOUCHER_FIXED_FIELDS_TEXT }}</span>
          <span>{{ ORDER_VOUCHER_AUTO_FIELDS_TEXT }}</span>
          <span>{{ ORDER_VOUCHER_EDITABLE_FIELDS_TEXT }}</span>
          <span>本期补填内容仅在当前页面临时生效，不回写数据库。</span>
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
              <span>业务单号：{{ currentOrder.showNo }}</span>
              <span>开单时间：{{ dayjs(currentOrder.createdAt).format('YYYY-MM-DD HH:mm:ss') }}</span>
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
                  placeholder="请输入完成日期或签字说明，例如：2026-04-28 已完成"
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
                当前方向：{{ voucherOrientationLabel }}，共 2 页，每页 1 联；申请部门：{{ currentOrder.customerDepartmentName || '散客' }}
              </p>
            </div>
            <div class="voucher-preview-panel__summary">
              <span>商品 {{ currentOrder.items.length }} 行</span>
              <span>总金额 ¥{{ Number(currentOrder.totalAmount).toFixed(2) }}</span>
            </div>
          </div>
          <div class="voucher-preview-panel__body">
            <div class="order-voucher-preview-scope" :class="`is-${voucherOrientation}`">
              <OrderVoucherTemplate
                :order="currentOrder"
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
        v-if="canUseOrderVoucher && currentOrder && voucherDialogVisible"
        ref="voucherPrintRootRef"
        class="order-voucher-print-root"
        aria-hidden="true"
      >
        <div class="order-voucher-print-scope" :class="`is-${voucherOrientation}`">
          <OrderVoucherTemplate
            :order="currentOrder"
            :editable-fields="voucherEditableForm"
            :orientation="voucherOrientation"
          />
        </div>
      </div>
    </Teleport>
  </PageContainer>
</template>

<style scoped>
.order-list-container {
  min-height: calc(100dvh - 190px);
}

.mobile-order-card {
  transition: transform 0.25s ease, box-shadow 0.25s ease;
}

.mobile-order-card__head {
  margin-bottom: 10px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.mobile-order-card__show-no {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 20px;
  font-weight: 700;
  color: #0f172a;
}

.mobile-order-card__time {
  margin-top: 2px;
  font-size: 12px;
  color: #64748b;
}

.mobile-order-card__head-tags {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.mobile-order-card__chip {
  border-radius: 9999px;
  padding: 4px 8px;
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
}

.mobile-order-card__chip.is-brand {
  background: #ecfdf5;
  color: #0f766e;
}

.mobile-order-card__chip.is-brand-soft {
  background: #ccfbf1;
  color: #134e4a;
}

.mobile-order-card__primary {
  border-radius: 12px;
  background: #f8fafc;
  padding: 10px 12px;
}

.mobile-order-card__primary-label {
  margin: 0;
  font-size: 12px;
  color: #64748b;
}

.mobile-order-card__primary-value {
  margin: 4px 0 0;
  font-size: 15px;
  font-weight: 600;
  color: #0f172a;
  line-height: 1.45;
  word-break: break-all;
}

.mobile-order-card__metrics {
  margin-top: 10px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.mobile-order-card__metric-qty {
  color: #475569;
  font-size: 14px;
}

.mobile-order-card__metric-amount {
  font-size: 18px;
  font-weight: 700;
  color: #ef4444;
}

.mobile-order-card__meta {
  margin-top: 10px;
  display: grid;
  gap: 6px 12px;
}

.mobile-order-card__meta.is-tablet {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.mobile-order-card__meta-item {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.mobile-order-card__meta-label {
  color: #64748b;
  font-size: 13px;
  flex-shrink: 0;
}

.mobile-order-card__meta-value {
  color: #334155;
  font-size: 13px;
  font-weight: 500;
  text-align: right;
  word-break: break-all;
}

.mobile-order-card__meta-value.is-positive {
  color: #15803d;
}

.mobile-order-card__meta-value.is-warning {
  color: #b45309;
}

.mobile-order-card__meta-value.is-danger {
  color: #b91c1c;
}

.mobile-order-card__meta-value.is-neutral {
  color: #64748b;
}

.mobile-order-card__actions {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid #e2e8f0;
  display: flex;
  align-items: center;
  gap: 14px;
}

.dark .mobile-order-card__show-no {
  color: #e2e8f0;
}

.dark .mobile-order-card__time,
.dark .mobile-order-card__primary-label,
.dark .mobile-order-card__meta-label {
  color: #94a3b8;
}

.dark .mobile-order-card__primary {
  background: rgba(30, 41, 59, 0.65);
}

.dark .mobile-order-card__primary-value,
.dark .mobile-order-card__meta-value {
  color: #e2e8f0;
}

.dark .mobile-order-card__actions {
  border-top-color: rgba(148, 163, 184, 0.28);
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

.order-voucher-dialog :deep(.el-dialog) {
  border-radius: 20px;
  overflow: hidden;
  max-width: calc(100vw - 24px);
}

.order-voucher-dialog :deep(.el-dialog__body) {
  padding-top: 10px;
}

.order-voucher-print-scope {
  background: #ffffff;
  border-radius: 16px;
}

.voucher-editor-banner {
  margin-bottom: 12px;
  border: 1px solid #c7d2fe;
  border-radius: 14px;
  background: linear-gradient(135deg, #f8faff 0%, #eef4ff 100%);
  padding: 10px 12px;
}

.voucher-editor-banner__title {
  font-size: 13px;
  font-weight: 700;
  color: #1e40af;
}

.voucher-editor-banner__content {
  margin-top: 6px;
  display: grid;
  gap: 4px;
  font-size: 12px;
  color: #334155;
}

.voucher-workbench {
  display: grid;
  grid-template-columns: minmax(300px, 340px) minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}

.voucher-editor-panel,
.voucher-preview-panel {
  border: 1px solid #e2e8f0;
  border-radius: 16px;
  background: #fff;
}

.voucher-editor-panel {
  padding: 14px;
  position: sticky;
  top: 0;
}

.voucher-editor-panel__header,
.voucher-preview-panel__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.voucher-editor-panel__title,
.voucher-preview-panel__title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: #0f172a;
}

.voucher-editor-panel__desc,
.voucher-preview-panel__desc {
  margin: 4px 0 0;
  font-size: 12px;
  color: #64748b;
  line-height: 1.6;
}

.voucher-editor-panel__meta,
.voucher-preview-panel__summary {
  display: grid;
  gap: 4px;
  font-size: 12px;
  color: #475569;
  text-align: right;
}

.voucher-editor-form {
  margin-top: 14px;
}

.voucher-orientation-toolbar {
  margin-top: 14px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border: 1px dashed #cbd5e1;
  border-radius: 12px;
  background: #f8fafc;
  padding: 10px 12px;
}

.voucher-orientation-toolbar__label {
  font-size: 13px;
  font-weight: 600;
  color: #334155;
}

.voucher-editor-form__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 12px;
}

.voucher-editor-form__item--full {
  grid-column: 1 / -1;
}

.voucher-editor-form :deep(.el-form-item) {
  margin-bottom: 0;
}

.voucher-preview-panel {
  min-width: 0;
  overflow: hidden;
}

.voucher-preview-panel__header {
  padding: 14px 16px;
  border-bottom: 1px solid #e2e8f0;
  background: #f8fafc;
}

.voucher-preview-panel__body {
  max-height: calc(100vh - 260px);
  overflow: auto;
  padding: 14px;
  background: #f8fafc;
}

.order-voucher-preview-scope {
  margin: 0 auto;
}

.order-voucher-preview-scope.is-landscape {
  width: 281mm;
  min-width: 281mm;
}

.order-voucher-preview-scope.is-portrait {
  width: 194mm;
  min-width: 194mm;
}

@media (max-width: 768px) {
  .voucher-workbench {
    grid-template-columns: minmax(0, 1fr);
  }

  .voucher-editor-panel {
    position: static;
  }

  .voucher-editor-panel__header,
  .voucher-preview-panel__header {
    flex-direction: column;
  }

  .voucher-editor-panel__meta,
  .voucher-preview-panel__summary {
    width: 100%;
    text-align: left;
  }

  .voucher-editor-form__grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .voucher-orientation-toolbar {
    align-items: flex-start;
  }

  .voucher-preview-panel__body {
    max-height: none;
    padding: 10px;
  }

  .order-voucher-preview-scope.is-landscape,
  .order-voucher-preview-scope.is-portrait {
    width: 100%;
    min-width: 100%;
  }
}
</style>

<style>
.order-voucher-print-root {
  display: none;
}

@media print {
  html,
  body {
    margin: 0 !important;
    padding: 0 !important;
    background: #fff !important;
  }

  body > *:not(.order-voucher-print-root) {
    display: none !important;
  }

  .order-voucher-print-root {
    display: block !important;
    background: #ffffff;
    width: auto;
    min-height: auto;
    margin: 0;
    padding: 0 !important;
    overflow: visible;
  }

  .order-voucher-print-root .order-voucher-print-scope {
    width: fit-content;
    margin: 0 auto;
    overflow: visible;
    break-inside: auto;
    page-break-inside: auto;
  }

  .order-voucher-print-root .order-voucher-print-scope.is-landscape {
    width: 281mm;
    max-width: 281mm;
    min-height: 194mm;
  }

  .order-voucher-print-root .order-voucher-print-scope.is-portrait {
    width: 194mm;
    max-width: 194mm;
    min-height: 279mm;
  }
}
</style>
