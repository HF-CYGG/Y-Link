<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { PageContainer } from '@/components/common'
import { getInboundDetail, verifyInboundOrder, type InboundOrderDetail } from '@/api/modules/inbound'
import { extractErrorMessage } from '@/utils/error'
import dayjs from 'dayjs'

const scanCode = ref('')
const scanInputRef = ref<{ focus: () => void } | null>(null)
const loading = ref(false)
const verifying = ref(false)

const currentOrder = ref<InboundOrderDetail | null>(null)

const statusMap = {
  pending: { label: '待入库', type: 'warning' },
  verified: { label: '已入库', type: 'success' },
  cancelled: { label: '已取消', type: 'info' },
} as const

const handleScan = async () => {
  const code = scanCode.value.trim()
  if (!code) return

  loading.value = true
  try {
    const result = await getInboundDetail(code)
    currentOrder.value = result
    scanCode.value = ''
    scanInputRef.value?.focus()
  } catch (err) {
    ElMessage.error(extractErrorMessage(err, '扫码识别失败'))
    scanCode.value = ''
    currentOrder.value = null
    scanInputRef.value?.focus()
  } finally {
    loading.value = false
  }
}

const handleVerify = async () => {
  if (!currentOrder.value || currentOrder.value.order.status !== 'pending') return

  try {
    await ElMessageBox.confirm('请确认实物与清单一致。确认后库存将立刻增加，操作不可撤销。', '一键入库确认', {
      type: 'warning',
      confirmButtonText: '确认入库',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }

  verifying.value = true
  try {
    const result = await verifyInboundOrder(currentOrder.value.order.verifyCode)
    currentOrder.value = result
    ElMessage.success('入库成功！库存已更新')
    
    // 自动重置焦点，准备扫下一单
    setTimeout(() => {
      scanInputRef.value?.focus()
    }, 1000)
  } catch (err) {
    ElMessage.error(extractErrorMessage(err, '入库失败'))
  } finally {
    verifying.value = false
  }
}

const handleReset = () => {
  currentOrder.value = null
  scanCode.value = ''
  nextTick(() => {
    scanInputRef.value?.focus()
  })
}

onMounted(() => {
  scanInputRef.value?.focus()
})
</script>

<template>
  <PageContainer title="一键扫码入库">
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 h-[calc(100vh-140px)]">
      <!-- 左侧：扫码录入区 -->
      <div class="lg:col-span-1 bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-slate-100 dark:border-slate-700 flex flex-col overflow-hidden">
        <div class="p-6 border-b border-slate-100 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-900/50">
          <h2 class="text-lg font-medium text-slate-800 dark:text-slate-100 mb-4 flex items-center gap-2">
            <el-icon class="text-brand"><Search /></el-icon> 扫码核验
          </h2>
          <el-input
            ref="scanInputRef"
            v-model="scanCode"
            placeholder="请使用扫码枪扫描送货单二维码"
            size="large"
            clearable
            @keyup.enter="handleScan"
            class="scan-input"
          >
            <template #prefix>
              <el-icon><Picture /></el-icon>
            </template>
            <template #append>
              <el-button :loading="loading" @click="handleScan">查询</el-button>
            </template>
          </el-input>
          <div class="mt-4 text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
            <p>操作指引：</p>
            <ul class="list-disc pl-5 mt-1 space-y-1">
              <li>光标停留在上方输入框时，直接扫码即可。</li>
              <li>扫码后右侧会展示该送货单明细。</li>
              <li>核对实物无误后，点击“确认入库”完成库存增加。</li>
            </ul>
          </div>
        </div>

        <!-- 扫码后状态概览 (如果不在这里展示，也可以在右侧卡片头部展示) -->
        <div class="p-6 flex-1 flex flex-col justify-center items-center text-center" v-if="!currentOrder && !loading">
          <el-icon :size="64" class="text-slate-200 dark:text-slate-700 mb-4"><Document /></el-icon>
          <p class="text-slate-400 dark:text-slate-500">等待扫码...</p>
        </div>
      </div>

      <!-- 右侧：送货单详情与确认区 -->
      <div class="lg:col-span-2 bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-slate-100 dark:border-slate-700 flex flex-col overflow-hidden relative">
        <div v-if="loading" class="absolute inset-0 z-10 bg-white/80 dark:bg-slate-800/80 backdrop-blur-sm flex items-center justify-center">
          <el-icon class="is-loading text-brand text-4xl"><Loading /></el-icon>
        </div>

        <template v-if="currentOrder">
          <div class="p-6 border-b border-slate-100 dark:border-slate-700 flex justify-between items-start">
            <div>
              <div class="flex items-center gap-3 mb-2">
                <h2 class="text-xl font-semibold text-slate-800 dark:text-slate-100">
                  供货方：{{ currentOrder.order.supplierName }}
                </h2>
                <el-tag
                  :type="statusMap[currentOrder.order.status].type"
                  effect="light"
                  round
                >
                  {{ statusMap[currentOrder.order.status].label }}
                </el-tag>
              </div>
              <div class="text-slate-500 dark:text-slate-400 text-sm space-y-1">
                <p>单号：{{ currentOrder.order.showNo }}</p>
                <p>时间：{{ dayjs(currentOrder.order.createdAt).format('YYYY-MM-DD HH:mm:ss') }}</p>
                <p v-if="currentOrder.order.remark">备注：{{ currentOrder.order.remark }}</p>
              </div>
            </div>
            
            <div class="text-right">
              <div class="text-sm text-slate-500 dark:text-slate-400 mb-1">本次入库总计</div>
              <div class="text-3xl font-bold text-brand dark:text-teal-400">{{ currentOrder.order.totalQty }} <span class="text-base font-normal text-slate-400">件</span></div>
            </div>
          </div>

          <!-- 明细列表 -->
          <div class="flex-1 overflow-auto p-6">
            <h3 class="text-base font-medium text-slate-800 dark:text-slate-200 mb-4">送货明细核对</h3>
            <div class="space-y-3">
              <div
                v-for="(item, index) in currentOrder.items"
                :key="item.id"
                class="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-900/50 rounded-xl hover:bg-brand/5 dark:hover:bg-brand/10 transition-colors"
              >
                <div class="flex items-center gap-4">
                  <div class="w-8 h-8 rounded-full bg-slate-200 dark:bg-slate-700 flex items-center justify-center text-slate-500 dark:text-slate-400 font-medium">
                    {{ index + 1 }}
                  </div>
                  <div>
                    <div class="font-medium text-slate-800 dark:text-slate-200">{{ item.productNameSnapshot }}</div>
                  </div>
                </div>
                <div class="text-lg font-semibold text-slate-700 dark:text-slate-300">
                  x {{ Number(item.qty) }}
                </div>
              </div>
            </div>
          </div>

          <!-- 底部操作栏 -->
          <div class="p-6 border-t border-slate-100 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-900/50 flex justify-between items-center">
            <el-button plain size="large" @click="handleReset" class="!rounded-xl px-8">
              取消返回
            </el-button>
            <el-button
              v-if="currentOrder.order.status === 'pending'"
              type="primary"
              size="large"
              :loading="verifying"
              @click="handleVerify"
              class="!rounded-xl px-12"
            >
              <el-icon class="mr-2"><Check /></el-icon>
              一键确认入库
            </el-button>
            <el-button
              v-else
              type="success"
              size="large"
              disabled
              class="!rounded-xl px-12"
            >
              已入库完毕
            </el-button>
          </div>
        </template>

        <div v-else class="flex-1 flex items-center justify-center">
          <el-empty description="请先在左侧扫码" :image-size="200" />
        </div>
      </div>
    </div>
  </PageContainer>
</template>

<style scoped>
.scan-input :deep(.el-input__wrapper) {
  border-radius: 12px;
  box-shadow: 0 0 0 1px var(--el-border-color) inset;
  transition: all 0.3s;
}
.scan-input :deep(.el-input__wrapper.is-focus) {
  box-shadow: 0 0 0 2px var(--el-color-primary) inset;
}
.scan-input :deep(.el-input__inner) {
  height: 48px;
  font-size: 16px;
}
</style>
