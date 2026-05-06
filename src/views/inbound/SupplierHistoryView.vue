<script setup lang="ts">
/**
 * 模块说明：src/views/inbound/SupplierHistoryView.vue
 * 文件职责：展示供货方历史送货单列表，并支持服务端筛选分页、详情查看和待入库二维码回查。
 * 实现逻辑：
 * - 页面采用“统计卡 + 筛选工具栏 + 列表容器 + 详情抽屉”的工作台布局，与录入页形成统一视觉语言；
 * - 历史页改为服务端筛选与分页，只返回当前页数据，降低首屏等待与前端内存占用；
 * - 列表请求与详情请求都接入稳定请求工具，避免快速切换筛选或连点详情时旧结果覆盖新状态；
 * - 详情抽屉保留原有查询与二维码逻辑，仅增强打开反馈与信息层级，不改动任何业务接口。
 * 维护说明：
 * - 若后续要增加更多筛选维度，优先继续扩展服务端查询参数，而不是回退到前端全量筛选；
 * - 二维码生成失败时不能静默吞掉，否则用户只会看到空白占位而不知道单据本身已存在。
 */

import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import QRCode from 'qrcode'
import { useRouter } from 'vue-router'
import { BizResponsiveDrawerShell, PageContainer, PagePaginationBar } from '@/components/common'
import {
  getSupplierDeliveries,
  getInboundDetail,
  type InboundOrder,
  type InboundOrderDetail,
  type SupplierDeliverySummary,
} from '@/api/modules/inbound'
import { useStableRequest } from '@/composables/useStableRequest'
import { extractErrorMessage } from '@/utils/error'
import { applyPaginatedResult, createPaginatedListState } from '@/utils/list'
import dayjs from 'dayjs'

const router = useRouter()
const listRequest = useStableRequest()
const detailRequest = useStableRequest()
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
})
const detailVisible = ref(false)
const detailLoading = ref(false)
const currentDetail = ref<InboundOrderDetail | null>(null)
const qrCodeDataUrl = ref('')
const qrCodeUnavailable = ref(false)
const statusFilter = ref<'all' | InboundOrder['status']>('all')
const keyword = ref('')

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
  return statusFilter.value !== 'all' || Boolean(keyword.value.trim())
})

// 列表头仅保留简短结果说明，避免再次重复展示完整筛选摘要。
const tableSummaryText = computed(() => {
  return isFiltering.value ? `当前结果 ${listState.total} 条` : `共 ${summary.value.total} 条记录`
})

// 空态文案按“全量为空 / 当前筛选为空”区分，减少误导。
const emptyDescription = computed(() => {
  return isFiltering.value ? '当前筛选下暂无单据' : '暂无历史送货记录'
})

const buildListQuery = () => {
  return {
    page: listState.query.page,
    pageSize: listState.query.pageSize,
    keyword: keyword.value.trim() || undefined,
    status: statusFilter.value === 'all' ? undefined : statusFilter.value,
  }
}

const loadData = async () => {
  listState.loading = true
  await listRequest.runLatest({
    executor: (signal) => getSupplierDeliveries(buildListQuery(), { signal }),
    onSuccess: (result) => {
      applyPaginatedResult(listState, result)
      summary.value = result.summary
    },
    onError: (err) => {
      ElMessage.error(extractErrorMessage(err, '获取历史记录失败'))
    },
    onFinally: () => {
      listState.loading = false
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
    ElMessage.warning(extractErrorMessage(err, '详情已加载，但二维码生成失败，请稍后重试'))
  }
}

// 查看详情时重置上一次弹窗状态，避免旧二维码或旧详情短暂闪现。
const handleViewDetail = async (row: InboundOrder) => {
  detailVisible.value = true
  detailLoading.value = true
  qrCodeDataUrl.value = ''
  qrCodeUnavailable.value = false
  currentDetail.value = null

  await detailRequest.runLatest({
    executor: (signal) => getInboundDetail(row.verifyCode, { signal }),
    onSuccess: async (detail) => {
      currentDetail.value = detail

      if (detail.order.status === 'pending') {
        await generateQRCode(detail.order.verifyCode)
      }
    },
    onError: (err) => {
      ElMessage.error(extractErrorMessage(err, '获取详情失败'))
      detailVisible.value = false
    },
    onFinally: () => {
      detailLoading.value = false
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

onMounted(() => {
  void loadData()
})
</script>

<template>
  <PageContainer title="历史送货单">
    <div class="mx-auto max-w-7xl">
      <div class="mb-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div
          v-for="card in summaryCards"
          :key="card.label"
          class="history-summary-card rounded-[26px] border border-slate-200/70 bg-white/95 p-5 shadow-[0_14px_34px_-34px_rgba(15,23,42,0.18)] dark:border-slate-700/80 dark:bg-slate-800/95"
        >
          <div :class="['history-summary-card__badge', card.accentClass]">
            {{ String(card.value).padStart(2, '0') }}
          </div>
          <p class="mt-4 text-sm font-medium text-slate-500 dark:text-slate-400">{{ card.label }}</p>
          <p class="mt-1 text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">{{ card.value }}</p>
          <p class="mt-2 text-xs leading-5 text-slate-400 dark:text-slate-500">{{ card.hint }}</p>
        </div>
      </div>

      <div class="history-filter-card mb-4 rounded-[28px] border border-slate-200/70 bg-white/95 p-4 shadow-[0_14px_34px_-34px_rgba(15,23,42,0.16)] dark:border-slate-700/80 dark:bg-slate-800/95 sm:p-5">
        <div class="flex flex-1 flex-col gap-3 lg:flex-row lg:items-center">
          <el-input
            v-model="keyword"
            clearable
            placeholder="按送货单号或供货方搜索"
            class="history-filter-card__input lg:max-w-xs"
            @clear="handleSearch"
            @keyup.enter="handleSearch"
          />
          <el-radio-group v-model="statusFilter" size="default" class="history-filter-card__tabs" @change="handleSearch">
            <el-radio-button label="all">全部状态</el-radio-button>
            <el-radio-button label="pending">待入库</el-radio-button>
            <el-radio-button label="verified">已入库</el-radio-button>
            <el-radio-button label="cancelled">已取消</el-radio-button>
          </el-radio-group>
          <el-button type="primary" @click="handleSearch">搜索</el-button>
        </div>
      </div>

      <div class="history-table-shell overflow-hidden rounded-[28px] border border-slate-200/70 bg-white/95 shadow-[0_18px_42px_-40px_rgba(15,23,42,0.18)] dark:border-slate-700/80 dark:bg-slate-800/95">
        <div class="history-table-shell__header flex flex-col gap-2 border-b border-slate-200/70 px-5 py-4 dark:border-slate-700/80 sm:px-6">
          <h3 class="text-base font-semibold text-slate-900 dark:text-slate-100">记录列表</h3>
          <p class="text-sm leading-6 text-slate-500 dark:text-slate-400">{{ tableSummaryText }}</p>
        </div>

        <div class="history-table-shell__body flex min-h-[520px] flex-col">
          <el-table native-scrollbar v-loading="listState.loading" :data="listState.records" stripe class="history-table-shell__table w-full flex-1">
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
            <el-table-column label="操作" min-width="132" fixed="right" align="right">
              <template #default="{ row }">
                <el-button class="history-detail-button" link type="primary" @click="handleViewDetail(row)">
                  查看详情
                </el-button>
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
                <div class="flex items-start justify-between gap-3">
                  <div>
                    <p class="text-xs uppercase tracking-[0.2em] text-slate-400 dark:text-slate-500">送货单详情</p>
                    <h3 class="mt-2 text-lg font-semibold text-slate-900 dark:text-slate-100">{{ currentDetail.order.showNo }}</h3>
                    <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">创建于 {{ dayjs(currentDetail.order.createdAt).format('YYYY-MM-DD HH:mm') }}</p>
                  </div>
                  <el-tag :type="getStatusMeta(currentDetail.order.status).type" size="small" effect="light" round>
                    {{ getStatusMeta(currentDetail.order.status).label }}
                  </el-tag>
                </div>

                <div class="mt-4 grid gap-3 sm:grid-cols-3">
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
                <div v-if="currentDetail.order.status === 'pending' && qrCodeDataUrl" class="rounded-[26px] border border-amber-200/70 bg-amber-50/65 p-5 text-center shadow-[0_12px_28px_-28px_rgba(245,158,11,0.18)] dark:border-amber-900/60 dark:bg-amber-950/20">
                  <p class="text-sm font-medium text-amber-700 dark:text-amber-300">向库管员出示此二维码完成入库</p>
                  <img :src="qrCodeDataUrl" alt="核销二维码" class="mx-auto mt-4 h-40 w-40 rounded-2xl border border-white/80 bg-white p-2 shadow-sm dark:border-slate-700/70 dark:bg-slate-900/70" />
                </div>
              </transition>

              <!-- 二维码生成失败时保留页面内提示，避免用户误以为详情尚未加载完成。 -->
              <transition name="history-detail-fade">
                <div
                  v-if="currentDetail.order.status === 'pending' && qrCodeUnavailable"
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
    </div>
  </PageContainer>
</template>

<style scoped>
.history-summary-card,
.history-filter-card,
.history-table-shell,
.history-detail-hero,
.history-detail-item {
  transition:
    box-shadow 0.16s ease,
    border-color 0.18s ease;
}

.history-summary-card:hover,
.history-filter-card:hover,
.history-table-shell:hover {
  box-shadow: 0 14px 28px -32px rgba(15, 23, 42, 0.16);
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

.history-filter-card__tabs :deep(.el-radio-button__inner) {
  border-radius: 999px;
}

.history-filter-card__tabs :deep(.el-radio-button:first-child .el-radio-button__inner),
.history-filter-card__tabs :deep(.el-radio-button:last-child .el-radio-button__inner) {
  border-radius: 999px;
}

.history-table-shell__header {
  background: linear-gradient(180deg, rgba(248, 250, 252, 0.9), rgba(255, 255, 255, 0.94));
}

.history-detail-button {
  transition: opacity 0.16s ease;
}

.history-detail-button:hover {
  opacity: 0.88;
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
    transform 0.16s ease,
    opacity 0.16s ease;
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
}

@media (prefers-reduced-motion: reduce) {
  .history-summary-card,
  .history-filter-card,
  .history-table-shell,
  .history-detail-hero,
  .history-detail-item,
  .history-detail-button,
  .history-detail-fade-enter-active,
  .history-detail-fade-leave-active {
    transition: none;
  }
}
</style>
