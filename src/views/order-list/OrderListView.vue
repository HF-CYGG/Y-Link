<script setup lang="ts">
/**
 * 模块说明：src/views/order-list/OrderListView.vue
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */



import dayjs from 'dayjs'
import { ElMessage } from 'element-plus'
import { computed, ref } from 'vue'
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
const hasActiveFilter = computed(() => {
  return Boolean(searchForm.value.keyword || searchForm.value.orderType !== 'all' || searchForm.value.dateRange)
})
const emptyDescription = computed(() => {
  return hasActiveFilter.value ? '未匹配到符合条件的订单，请调整筛选条件后重试' : '暂无订单数据，稍后可通过开单后回来查看'
})

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const handleOpenVoucherDialog = () => {
  if (!currentOrder.value) {
    ElMessage.warning('请先加载单据详情')
    return
  }

  voucherDialogVisible.value = true
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const handlePrintVoucher = () => {
  if (!currentOrder.value) {
    ElMessage.warning('当前无可打印凭证')
    return
  }

  globalThis.print()
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const handleExportVoucherPdf = async () => {
  if (!enableHtml2pdfExport) {
    ElMessage.info('PDF 导出开关未启用，当前仅支持打印')
    return
  }

  if (!currentOrder.value) {
    ElMessage.warning('当前无可导出的凭证')
    return
  }

  const sourceElement = voucherPrintRootRef.value?.querySelector('.voucher-sheet')
  if (!(sourceElement instanceof HTMLElement)) {
    ElMessage.warning('凭证模板尚未准备完成，请稍后重试')
    return
  }

  const outputFileName = `${currentOrder.value.showNo || 'order-voucher'}-购物凭证.pdf`

  exportPdfLoading.value = true
  try {
    await exportVoucherPdf({
      sourceElement,
      filename: outputFileName,
      marginMm: 8,
      scale: 2,
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
              <el-table-column label="客户名称" prop="customerName" min-width="200" show-overflow-tooltip>
                <template #default="{ row }">{{ row.customerName || '-' }}</template>
              </el-table-column>
              <el-table-column label="订单类型" min-width="100">
                <template #default="{ row }">{{ getOrderTypeLabel(row.orderType) }}</template>
              </el-table-column>
              <el-table-column label="是否有出库单" width="116" align="center">
                <template #default="{ row }">
                  <el-tag :type="row.hasCustomerOrder ? 'success' : 'info'" effect="light">
                    {{ row.hasCustomerOrder ? '是' : '否' }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="系统申请" width="90" align="center">
                <template #default="{ row }">
                  <el-tag :type="row.isSystemApplied ? 'warning' : 'info'" effect="light">
                    {{ row.isSystemApplied ? '是' : '否' }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="出单人" min-width="140" show-overflow-tooltip>
                <template #default="{ row }">{{ row.issuerName || '-' }}</template>
              </el-table-column>
              <el-table-column label="客户部门" min-width="160" show-overflow-tooltip>
                <template #default="{ row }">{{ row.customerDepartmentName || '-' }}</template>
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
              <div class="mb-3 flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class="truncate font-semibold text-slate-800 dark:text-slate-100">{{ item.showNo }}</div>
                  <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    {{ dayjs(item.createdAt).format('YYYY-MM-DD HH:mm') }}
                  </div>
                </div>
                <span class="rounded-full bg-brand/10 px-2 py-1 text-xs font-medium text-brand dark:bg-brand/20 dark:text-teal-300">
                  {{ isTablet ? '平板卡片' : '手机卡片' }}
                </span>
              </div>
              <div class="mt-1 text-sm text-slate-600 dark:text-slate-300">类型：{{ getOrderTypeLabel(item.orderType) }}</div>
              <div class="text-sm text-slate-600 dark:text-slate-300">
                是否有出库单：{{ item.hasCustomerOrder ? '是' : '否' }} / 系统申请：{{ item.isSystemApplied ? '是' : '否' }}
              </div>
              <div class="text-sm text-slate-600 dark:text-slate-300">出单人：{{ item.issuerName || '-' }}</div>
              <div class="text-sm text-slate-600 dark:text-slate-300">客户部门：{{ item.customerDepartmentName || '-' }}</div>
              <div class="text-sm text-slate-600 dark:text-slate-300">客户：{{ item.customerName || '-' }}</div>
              <div class="text-sm text-slate-600 dark:text-slate-300">开单人：{{ item.creatorDisplayName || item.creatorUsername || '-' }}</div>
              <div class="mt-3 flex items-center justify-between gap-4 border-t border-slate-100 pt-3 dark:border-white/10">
                <span class="text-sm text-slate-500 dark:text-slate-400">数量：{{ item.totalQty }}</span>
                <span class="font-medium text-red-500">¥{{ Number(item.totalAmount).toFixed(2) }}</span>
              </div>
              <div v-if="canDeleteOrder" class="mt-3 flex items-center gap-3">
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
          <el-button v-if="currentOrder" plain type="primary" @click="handleOpenVoucherDialog">生成凭证</el-button>
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
      v-model="voucherDialogVisible"
      title="确认出库信息"
      width="640px"
      align-center
      class="order-voucher-dialog"
      append-to-body
      :modal-append-to-body="true"
      :lock-scroll="true"
    >
      <div v-if="currentOrder" class="voucher-confirm-banner">
        <div class="voucher-confirm-banner__title">请先核对关键信息</div>
        <div class="voucher-confirm-banner__content">
          <span>确认无误后再打印凭证。</span>
        </div>
      </div>
      <div v-if="currentOrder" class="voucher-confirm-panel">
        <div class="voucher-confirm-grid">
          <div class="voucher-confirm-item">
            <span class="voucher-confirm-item__label">业务单号</span>
            <span class="voucher-confirm-item__value">{{ currentOrder.showNo }}</span>
          </div>
          <div class="voucher-confirm-item">
            <span class="voucher-confirm-item__label">订单类型</span>
            <span class="voucher-confirm-item__value">{{ getOrderTypeLabel(currentOrder.orderType) }}</span>
          </div>
          <div class="voucher-confirm-item">
            <span class="voucher-confirm-item__label">客户部门</span>
            <span class="voucher-confirm-item__value">{{ currentOrder.customerDepartmentName || '散客' }}</span>
          </div>
          <div class="voucher-confirm-item">
            <span class="voucher-confirm-item__label">领取人</span>
            <span class="voucher-confirm-item__value">{{ currentOrder.customerName || '-' }}</span>
          </div>
          <div class="voucher-confirm-item">
            <span class="voucher-confirm-item__label">出库人</span>
            <span class="voucher-confirm-item__value">{{ currentOrder.issuerName || '-' }}</span>
          </div>
          <div class="voucher-confirm-item">
            <span class="voucher-confirm-item__label">开单时间</span>
            <span class="voucher-confirm-item__value">{{ dayjs(currentOrder.createdAt).format('YYYY-MM-DD HH:mm:ss') }}</span>
          </div>
          <div class="voucher-confirm-item">
            <span class="voucher-confirm-item__label">总数量</span>
            <span class="voucher-confirm-item__value">{{ currentOrder.totalQty }}</span>
          </div>
          <div class="voucher-confirm-item">
            <span class="voucher-confirm-item__label">总金额</span>
            <span class="voucher-confirm-item__value voucher-confirm-item__value--accent">¥{{ Number(currentOrder.totalAmount).toFixed(2) }}</span>
          </div>
        </div>
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

    <div v-if="currentOrder && voucherDialogVisible" ref="voucherPrintRootRef" class="order-voucher-print-root" aria-hidden="true">
      <div class="order-voucher-print-scope">
        <OrderVoucherTemplate :order="currentOrder" />
      </div>
    </div>
  </PageContainer>
</template>

<style scoped>
.order-list-container {
  min-height: calc(100dvh - 190px);
}

.mobile-order-card {
  transition: transform 0.25s ease, box-shadow 0.25s ease;
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
}

.order-voucher-dialog :deep(.el-dialog__body) {
  padding-top: 8px;
}

.order-voucher-print-scope {
  background: #ffffff;
  border-radius: 16px;
}

.voucher-confirm-banner {
  margin-bottom: 10px;
  border: 1px solid #c7d2fe;
  border-radius: 12px;
  background: #f8faff;
  padding: 8px 10px;
}

.voucher-confirm-banner__title {
  font-size: 12px;
  font-weight: 700;
  color: #1e40af;
}

.voucher-confirm-banner__content {
  margin-top: 2px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  font-size: 11px;
  color: #334155;
}

.voucher-confirm-panel {
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  background: #fff;
  padding: 12px;
}

.voucher-confirm-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.voucher-confirm-item {
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 8px 10px;
  background: #fcfdff;
}

.voucher-confirm-item__label {
  display: block;
  margin-bottom: 2px;
  font-size: 11px;
  color: #64748b;
}

.voucher-confirm-item__value {
  display: block;
  font-size: 14px;
  font-weight: 600;
  color: #0f172a;
}

.voucher-confirm-item__value--accent {
  color: #b91c1c;
}

@media (max-width: 768px) {
  .voucher-confirm-grid {
    grid-template-columns: minmax(0, 1fr);
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

  body * {
    visibility: hidden !important;
  }

  .order-voucher-print-root,
  .order-voucher-print-root * {
    visibility: visible !important;
  }

  .order-voucher-print-root {
    position: fixed;
    inset: 0;
    width: 100vw;
    min-height: 100dvh;
    z-index: 99999;
    display: block !important;
    background: #ffffff;
    padding: 0;
    overflow: visible;
  }

  .order-voucher-print-root .order-voucher-print-scope {
    width: 194mm;
    max-width: 194mm;
    min-height: 297mm;
    margin: 0 auto;
    overflow: hidden;
  }
}
</style>
