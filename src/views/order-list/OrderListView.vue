<script setup lang="ts">
import dayjs from 'dayjs'
import {
  BizResponsiveDataCollectionShell,
  BizResponsiveDrawerShell,
  PageContainer,
  PagePaginationBar,
  PageToolbarCard,
} from '@/components/common'
import OrderDetailDrawerContent from './components/OrderDetailDrawerContent.vue'
import { useOrderListView } from './composables/useOrderListView'

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
  handleSearch,
  handleReset,
  handleCurrentChange,
  handlePageSizeChange,
  handleViewDetail,
} = useOrderListView()
</script>

<template>
  <PageContainer title="出库单列表" description="按业务单号或日期筛选历史单据，并在抽屉中查看详情。">
    <div class="order-list-container flex min-w-0 flex-col gap-4">
      <PageToolbarCard content-class="items-start">
        <template #default="{ isPhone, isTablet }">
          <div class="flex flex-wrap items-center gap-3">
            <el-input
              v-model="searchForm.showNo"
              placeholder="请输入业务单号"
              :class="isPhone ? '!w-full' : isTablet ? '!w-[220px]' : '!w-56'"
              clearable
            />
            <el-date-picker
              v-model="searchForm.dateRange"
              type="daterange"
              range-separator="至"
              start-placeholder="开始日期"
              end-placeholder="结束日期"
              :class="isPhone ? '!w-full' : isTablet ? '!w-[320px]' : '!w-[320px]'"
            />
            <div :class="['flex gap-2', isPhone ? 'w-full' : '']">
              <el-button :class="isPhone ? 'flex-1' : ''" type="primary" @click="handleSearch" icon="Search">搜索</el-button>
              <el-button :class="isPhone ? 'flex-1' : ''" @click="handleReset" icon="Refresh">重置</el-button>
            </div>
          </div>
        </template>
      </PageToolbarCard>

      <div class="data-area apple-card flex min-h-0 flex-1 flex-col p-4">
        <BizResponsiveDataCollectionShell
          :items="listState.records"
          :loading="listState.loading"
          empty-description="暂无出库单数据"
          empty-min-height="260px"
          :skeleton-rows="8"
          card-key="id"
          wrapper-class="flex min-h-0 flex-1 flex-col"
          table-wrapper-class="flex min-h-0 flex-1 flex-col overflow-hidden"
          card-container-class="flex-1 content-start pb-4"
        >
          <template #table>
            <el-table :data="listState.records" stripe class="flex-1 w-full" height="100%">
              <el-table-column label="业务单号" prop="showNo" min-width="150" />
              <el-table-column label="客户名称" prop="customerName" min-width="150">
                <template #default="{ row }">{{ row.customerName || '-' }}</template>
              </el-table-column>
              <el-table-column label="总数量" prop="totalQty" width="100" />
              <el-table-column label="总金额" prop="totalAmount" width="120">
                <template #default="{ row }">
                  <span class="font-medium text-red-500">¥{{ Number(row.totalAmount).toFixed(2) }}</span>
                </template>
              </el-table-column>
              <el-table-column label="开单人" min-width="140">
                <template #default="{ row }">
                  {{ row.creatorDisplayName || row.creatorUsername || '-' }}
                </template>
              </el-table-column>
              <el-table-column label="开单时间" prop="createdAt" width="180">
                <template #default="{ row }">
                  {{ dayjs(row.createdAt).format('YYYY-MM-DD HH:mm') }}
                </template>
              </el-table-column>
              <el-table-column label="操作" width="100" fixed="right" align="right">
                <template #default="{ row }">
                  <el-button link type="primary" @click="handleViewDetail(row)">详情</el-button>
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
              <div class="text-sm text-slate-600 dark:text-slate-300">客户：{{ item.customerName || '-' }}</div>
              <div class="text-sm text-slate-600 dark:text-slate-300">开单人：{{ item.creatorDisplayName || item.creatorUsername || '-' }}</div>
              <div class="mt-3 flex items-center justify-between gap-4 border-t border-slate-100 pt-3 dark:border-white/10">
                <span class="text-sm text-slate-500 dark:text-slate-400">数量：{{ item.totalQty }}</span>
                <span class="font-medium text-red-500">¥{{ Number(item.totalAmount).toFixed(2) }}</span>
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
  </PageContainer>
</template>

<style scoped>
.order-list-container {
  min-height: calc(100vh - 190px);
}

.mobile-order-card {
  transition: transform 0.25s ease, box-shadow 0.25s ease;
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
