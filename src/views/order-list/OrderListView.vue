<!--
  文件说明：
  该文件用于承载出库单列表主页面。
  页面聚焦列表筛选、移动端卡片、详情抽屉与正式出库单入口装配，
  其中低频的正式出库单工作台已拆到异步子组件，避免列表主分包携带整套打印模板与导出逻辑。
-->
<script setup lang="ts">
/**
 * 模块说明：`src/views/order-list/OrderListView.vue`
 * 文件职责：装配出库单列表、详情抽屉、合规状态编辑，以及正式出库单低频入口。
 * 实现逻辑：
 * 1. 复用列表 composable 提供的详情查询结果，不新增服务端接口；
 * 2. 将正式出库单编辑、预览、打印、导出整体拆到异步工作台组件，降低 `OrderListView` 主分包体积；
 * 3. 页面层仅保留低频入口控制，确保高频“列表 -> 详情”路径不被打印模板拖重；
 * 4. 列表与移动端卡片按订单类型收口展示字段，部门单展示部门流程字段，散客单隐藏不适用信息；
 * 5. 清理早期设备调试文案，避免把“手机卡片 / 平板卡片”等开发态信息暴露给最终用户。
 */

import dayjs from 'dayjs'
import { ElMessage } from 'element-plus'
import { computed, defineAsyncComponent, ref, watch } from 'vue'
import { updateOrderComplianceFlags } from '@/api/modules/order'
import {
  BizResponsiveDataCollectionShell,
  BizResponsiveDrawerShell,
  PageContainer,
  PagePaginationBar,
  PageToolbarCard,
} from '@/components/common'
import { usePermissionAction } from '@/composables/usePermissionAction'
import { extractErrorMessage } from '@/utils/error'
import OrderDetailDrawerContent from './components/OrderDetailDrawerContent.vue'
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
const { hasPermission, ensurePermission } = usePermissionAction()
const OrderVoucherWorkbenchDialog = defineAsyncComponent(() => import('./components/OrderVoucherWorkbenchDialog.vue'))

const voucherDialogVisible = ref(false)
const enableHtml2pdfExport = import.meta.env.VITE_ORDER_VOUCHER_HTML2PDF_ENABLED !== 'false'
const canUseOrderVoucher = computed(() => currentOrder.value?.orderType === 'department')
const canEditComplianceFlags = computed(() => hasPermission('orders:update'))
const complianceSaving = ref(false)
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

const syncComplianceFormFromCurrentOrder = () => {
  complianceForm.value = {
    hasCustomerOrder: Boolean(currentOrder.value?.hasCustomerOrder),
    isSystemApplied: Boolean(currentOrder.value?.isSystemApplied),
  }
}

watch(
  () => currentOrder.value?.id ?? '',
  () => {
    syncComplianceFormFromCurrentOrder()
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

  voucherDialogVisible.value = true
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
    ElMessage.info('散客单不适用该状态编辑')
    return
  }
  complianceSaving.value = true
  try {
    const nextDetail = await updateOrderComplianceFlags(currentOrder.value.id, {
      hasCustomerOrder: complianceForm.value.hasCustomerOrder,
      isSystemApplied: complianceForm.value.isSystemApplied,
    })
    currentOrder.value = nextDetail
    listState.records = listState.records.map((item) =>
      item.id === nextDetail.id
        ? {
            ...item,
            hasCustomerOrder: nextDetail.hasCustomerOrder,
            isSystemApplied: nextDetail.isSystemApplied,
          }
        : item,
    )
    ElMessage.success('状态已更新')
  } catch (error) {
    ElMessage.error(extractErrorMessage(error, '状态更新失败，请稍后重试'))
  } finally {
    complianceSaving.value = false
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
            <el-table native-scrollbar
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
              v-if="canEditComplianceFlags && currentOrder.orderType === 'department'"
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
                  v-if="canEditComplianceFlags && currentOrder.orderType === 'department'"
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
                  v-if="canEditComplianceFlags && currentOrder.orderType === 'department'"
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
        />
      </template>
    </BizResponsiveDrawerShell>

    <OrderVoucherWorkbenchDialog
      v-if="canUseOrderVoucher && currentOrder"
      v-model="voucherDialogVisible"
      :order="currentOrder"
      :enable-html2pdf-export="enableHtml2pdfExport"
    />
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

</style>
