<script setup lang="ts">
/**
 * 模块说明：src/views/inbound/SupplierHistoryView.vue
 * 文件职责：展示供货方历史送货单列表，并支持筛选、查看详情和待入库二维码回查。
 * 维护说明：
 * - 历史页走“先拉全量、再做前端轻筛选”的策略，适合当前供应商侧数据量级；
 * - 二维码生成失败时不能静默吞掉，否则用户只会看到空白占位而不知道单据本身已存在。
 */

import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import QRCode from 'qrcode'
import { useRouter } from 'vue-router'
import { PageContainer } from '@/components/common'
import { getSupplierDeliveries, getInboundDetail, type InboundOrder, type InboundOrderDetail } from '@/api/modules/inbound'
import { useAppStore } from '@/store'
import { extractErrorMessage } from '@/utils/error'
import dayjs from 'dayjs'

const router = useRouter()
const appStore = useAppStore()
const loading = ref(false)
const list = ref<InboundOrder[]>([])
const detailVisible = ref(false)
const detailLoading = ref(false)
const currentDetail = ref<InboundOrderDetail | null>(null)
const qrCodeDataUrl = ref('')
const statusFilter = ref<'all' | InboundOrder['status']>('all')
const keyword = ref('')

const statusMap = {
  pending: { label: '待入库', type: 'warning' },
  verified: { label: '已入库', type: 'success' },
  cancelled: { label: '已取消', type: 'info' },
} as const

// 统一状态映射读取，避免模板内索引触发隐式 any 类型问题
const getStatusMeta = (status: InboundOrder['status']) => {
  return statusMap[status]
}

// 顶部统计条：帮助供应商快速掌握送货单总体进度
const summary = computed(() => {
  const total = list.value.length
  const pending = list.value.filter((item) => item.status === 'pending').length
  const verified = list.value.filter((item) => item.status === 'verified').length
  return { total, pending, verified }
})

// 详情面板尺寸策略：
// - 手机端使用全屏宽度，保证二维码与明细都能完整展示；
// - 平板与桌面端使用接近半屏的阅读宽度，兼顾列表上下文与详情查看。
const detailDrawerSize = computed(() => {
  if (appStore.isPhone) {
    return '100vw'
  }

  if (appStore.isTablet) {
    return '52vw'
  }

  return '48vw'
})

// 前端轻筛选：按状态+关键字过滤，避免每次操作都触发后端请求
const filteredList = computed(() => {
  const keywordText = keyword.value.trim().toLowerCase()
  return list.value.filter((item) => {
    const statusMatched = statusFilter.value === 'all' ? true : item.status === statusFilter.value
    const keywordMatched = keywordText
      ? item.showNo?.toLowerCase().includes(keywordText) || item.supplierName?.toLowerCase().includes(keywordText)
      : true
    return statusMatched && keywordMatched
  })
})

const loadData = async () => {
  loading.value = true
  try {
    list.value = await getSupplierDeliveries()
  } catch (err) {
    ElMessage.error(extractErrorMessage(err, '获取历史记录失败'))
  } finally {
    loading.value = false
  }
}

// 历史详情中仅对待入库单据补生成二维码，已入库单据无需重复展示核销码。
const generateQRCode = async (verifyCode: string) => {
  try {
    qrCodeDataUrl.value = await QRCode.toDataURL(verifyCode, {
      width: 200,
      margin: 1,
      color: { dark: '#000000', light: '#ffffff' },
    })
  } catch (err) {
    qrCodeDataUrl.value = ''
    ElMessage.warning(extractErrorMessage(err, '详情已加载，但二维码生成失败，请稍后重试'))
  }
}

// 查看详情时重置上一次弹窗状态，避免旧二维码或旧详情短暂闪现。
const handleViewDetail = async (row: InboundOrder) => {
  detailVisible.value = true
  detailLoading.value = true
  qrCodeDataUrl.value = ''
  currentDetail.value = null
  
  try {
    const detail = await getInboundDetail(row.verifyCode)
    currentDetail.value = detail
    if (detail.order.status === 'pending') {
      await generateQRCode(detail.order.verifyCode)
    }
  } catch (err) {
    ElMessage.error(extractErrorMessage(err, '获取详情失败'))
    detailVisible.value = false
  } finally {
    detailLoading.value = false
  }
}

const goToDelivery = () => {
  router.push('/supplier-delivery')
}

onMounted(() => {
  loadData()
})
</script>

<template>
  <PageContainer title="历史送货单">
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
      <div class="bg-white dark:bg-slate-800 rounded-2xl p-4 shadow-sm border border-slate-100 dark:border-slate-700">
        <p class="text-sm text-slate-500 dark:text-slate-400">送货单总数</p>
        <p class="mt-2 text-2xl font-semibold text-slate-800 dark:text-slate-100">{{ summary.total }}</p>
      </div>
      <div class="bg-white dark:bg-slate-800 rounded-2xl p-4 shadow-sm border border-slate-100 dark:border-slate-700">
        <p class="text-sm text-slate-500 dark:text-slate-400">待入库</p>
        <p class="mt-2 text-2xl font-semibold text-amber-500">{{ summary.pending }}</p>
      </div>
      <div class="bg-white dark:bg-slate-800 rounded-2xl p-4 shadow-sm border border-slate-100 dark:border-slate-700">
        <p class="text-sm text-slate-500 dark:text-slate-400">已入库</p>
        <p class="mt-2 text-2xl font-semibold text-emerald-500">{{ summary.verified }}</p>
      </div>
    </div>

    <div class="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-slate-100 dark:border-slate-700 p-4 mb-4">
      <div class="flex flex-col md:flex-row md:items-center gap-3">
        <el-input
          v-model="keyword"
          clearable
          placeholder="按送货单号或供货方搜索"
          class="md:max-w-xs"
        />
        <el-radio-group v-model="statusFilter" size="default">
          <el-radio-button label="all">全部状态</el-radio-button>
          <el-radio-button label="pending">待入库</el-radio-button>
          <el-radio-button label="verified">已入库</el-radio-button>
          <el-radio-button label="cancelled">已取消</el-radio-button>
        </el-radio-group>
      </div>
    </div>

    <div class="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-slate-100 dark:border-slate-700 overflow-hidden flex flex-col min-h-[500px]">
      <el-table v-loading="loading" :data="filteredList" stripe class="w-full flex-1">
        <el-table-column prop="showNo" label="送货单号" min-width="160" />
        <el-table-column prop="totalQty" label="总数量" min-width="100">
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
        <el-table-column label="创建时间" min-width="160">
          <template #default="{ row }">
            {{ dayjs(row.createdAt).format('YYYY-MM-DD HH:mm') }}
          </template>
        </el-table-column>
        <el-table-column label="入库时间" min-width="160">
          <template #default="{ row }">
            {{ row.verifiedAt ? dayjs(row.verifiedAt).format('YYYY-MM-DD HH:mm') : '-' }}
          </template>
        </el-table-column>
        <el-table-column label="操作" min-width="120" fixed="right" align="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="handleViewDetail(row)">查看详情</el-button>
          </template>
        </el-table-column>
        
        <template #empty>
          <div class="py-12">
            <el-empty description="暂无历史送货记录" :image-size="120">
              <el-button type="primary" @click="goToDelivery">去录入送货单</el-button>
            </el-empty>
          </div>
        </template>
      </el-table>
    </div>

    <!-- 详情面板：改为右侧滑入，保留原有详情、二维码与异常处理逻辑 -->
    <el-drawer
      v-model="detailVisible"
      title="送货单详情"
      direction="rtl"
      :size="detailDrawerSize"
      destroy-on-close
      class="supplier-history-detail-drawer"
      append-to-body
      :modal-append-to-body="true"
      :lock-scroll="true"
      :close-on-click-modal="true"
    >
      <div v-loading="detailLoading" class="supplier-history-detail-panel min-h-[200px]">
        <transition name="fade-up" appear>
          <div v-if="currentDetail">
            <div class="bg-slate-50 dark:bg-slate-900/50 p-4 rounded-xl mb-4">
              <div class="flex justify-between items-center mb-2">
                <span class="text-slate-500 dark:text-slate-400">单号</span>
                <span class="font-medium text-slate-800 dark:text-slate-200">{{ currentDetail.order.showNo }}</span>
              </div>
              <div class="flex justify-between items-center mb-2">
                <span class="text-slate-500 dark:text-slate-400">状态</span>
                <el-tag :type="getStatusMeta(currentDetail.order.status).type" size="small" effect="light" round>
                  {{ getStatusMeta(currentDetail.order.status).label }}
                </el-tag>
              </div>
              <div class="flex justify-between items-center">
                <span class="text-slate-500 dark:text-slate-400">总计</span>
                <span class="font-medium text-brand dark:text-teal-400">{{ Number(currentDetail.order.totalQty) }} 件</span>
              </div>
            </div>

            <div class="mb-4 max-h-[300px] overflow-y-auto pr-2">
              <h4 class="text-sm font-medium text-slate-800 dark:text-slate-200 mb-2">商品明细</h4>
              <div class="space-y-2">
                <div
                  v-for="(item, index) in currentDetail.items"
                  :key="item.id"
                  class="flex justify-between items-center p-3 bg-white dark:bg-slate-800 border border-slate-100 dark:border-slate-700 rounded-lg"
                >
                  <div class="flex items-center gap-3">
                    <span class="text-slate-400 text-sm">{{ index + 1 }}.</span>
                    <span class="text-slate-700 dark:text-slate-300">{{ item.productNameSnapshot }}</span>
                  </div>
                  <span class="font-medium text-slate-800 dark:text-slate-200">x {{ Number(item.qty) }}</span>
                </div>
              </div>
            </div>

            <!-- 若未入库，展示二维码以便补扫 -->
            <transition name="fade-up">
              <div v-if="currentDetail.order.status === 'pending' && qrCodeDataUrl" class="mt-6 text-center border-t border-slate-100 dark:border-slate-700 pt-6">
                <p class="text-sm text-slate-500 mb-3">向库管员出示此二维码完成入库</p>
                <img :src="qrCodeDataUrl" alt="核销二维码" class="w-40 h-40 mx-auto border border-slate-100 rounded-lg p-2" />
              </div>
            </transition>
          </div>
        </transition>
      </div>
    </el-drawer>
  </PageContainer>
</template>

<style scoped>
/* 当前页详情抽屉样式：
 * - 用于在不同设备下控制内容可视高度；
 * - 手机端抽屉铺满屏幕，平板与桌面保持舒适留白。
 */
.supplier-history-detail-panel {
  height: calc(100vh - 132px);
  overflow-y: auto;
  padding-right: 0.5rem;
}

/* 详情弹窗内容分段入场动效，避免信息一次性突兀出现 */
.fade-up-enter-active,
.fade-up-leave-active {
  transition: all 0.22s ease;
}
.fade-up-enter-from,
.fade-up-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

@media (max-width: 767px) {
  .supplier-history-detail-panel {
    height: calc(100vh - 104px);
    padding-right: 0;
  }
}
</style>
