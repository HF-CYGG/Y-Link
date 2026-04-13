<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import QRCode from 'qrcode'
import { PageContainer } from '@/components/common'
import { getSupplierDeliveries, getInboundDetail, type InboundOrder, type InboundOrderDetail } from '@/api/modules/inbound'
import { extractErrorMessage } from '@/utils/error'
import dayjs from 'dayjs'

const loading = ref(false)
const list = ref<InboundOrder[]>([])
const detailVisible = ref(false)
const detailLoading = ref(false)
const currentDetail = ref<InboundOrderDetail | null>(null)
const qrCodeDataUrl = ref('')

const statusMap = {
  pending: { label: '待入库', type: 'warning' },
  verified: { label: '已入库', type: 'success' },
  cancelled: { label: '已取消', type: 'info' },
} as const

const loadData = async () => {
  loading.value = true
  try {
    const res = await getSupplierDeliveries()
    list.value = res.data
  } catch (err) {
    ElMessage.error(extractErrorMessage(err, '获取历史记录失败'))
  } finally {
    loading.value = false
  }
}

const generateQRCode = async (verifyCode: string) => {
  try {
    qrCodeDataUrl.value = await QRCode.toDataURL(verifyCode, {
      width: 200,
      margin: 1,
      color: { dark: '#000000', light: '#ffffff' },
    })
  } catch (err) {
    console.error('QR code generation failed', err)
  }
}

const handleViewDetail = async (row: InboundOrder) => {
  detailVisible.value = true
  detailLoading.value = true
  qrCodeDataUrl.value = ''
  currentDetail.value = null
  
  try {
    const res = await getInboundDetail(row.verifyCode)
    currentDetail.value = res.data
    if (res.data.order.status === 'pending') {
      await generateQRCode(res.data.order.verifyCode)
    }
  } catch (err) {
    ElMessage.error(extractErrorMessage(err, '获取详情失败'))
    detailVisible.value = false
  } finally {
    detailLoading.value = false
  }
}

onMounted(() => {
  loadData()
})
</script>

<template>
  <PageContainer title="历史送货单">
    <div class="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-slate-100 dark:border-slate-700 overflow-hidden flex flex-col min-h-[500px]">
      <el-table v-loading="loading" :data="list" stripe class="w-full flex-1">
        <el-table-column prop="showNo" label="送货单号" min-width="160" />
        <el-table-column prop="totalQty" label="总数量" min-width="100">
          <template #default="{ row }">
            <span class="font-medium text-slate-800 dark:text-slate-200">{{ Number(row.totalQty) }}</span> 件
          </template>
        </el-table-column>
        <el-table-column prop="status" label="状态" min-width="120">
          <template #default="{ row }">
            <el-tag :type="statusMap[row.status].type" effect="light" round>
              {{ statusMap[row.status].label }}
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
            <el-empty description="暂无历史送货记录" :image-size="120" />
          </div>
        </template>
      </el-table>
    </div>

    <!-- 详情弹窗 -->
    <el-dialog
      v-model="detailVisible"
      title="送货单详情"
      width="500px"
      destroy-on-close
      class="!rounded-2xl"
    >
      <div v-loading="detailLoading" class="min-h-[200px]">
        <template v-if="currentDetail">
          <div class="bg-slate-50 dark:bg-slate-900/50 p-4 rounded-xl mb-4">
            <div class="flex justify-between items-center mb-2">
              <span class="text-slate-500 dark:text-slate-400">单号</span>
              <span class="font-medium text-slate-800 dark:text-slate-200">{{ currentDetail.order.showNo }}</span>
            </div>
            <div class="flex justify-between items-center mb-2">
              <span class="text-slate-500 dark:text-slate-400">状态</span>
              <el-tag :type="statusMap[currentDetail.order.status].type" size="small" effect="light" round>
                {{ statusMap[currentDetail.order.status].label }}
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
          <div v-if="currentDetail.order.status === 'pending' && qrCodeDataUrl" class="mt-6 text-center border-t border-slate-100 dark:border-slate-700 pt-6">
            <p class="text-sm text-slate-500 mb-3">向库管员出示此二维码完成入库</p>
            <img :src="qrCodeDataUrl" alt="核销二维码" class="w-40 h-40 mx-auto border border-slate-100 rounded-lg p-2" />
          </div>
        </template>
      </div>
    </el-dialog>
  </PageContainer>
</template>
