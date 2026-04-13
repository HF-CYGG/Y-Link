<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { PageContainer } from '@/components/common'
import {
  getInboundDetail,
  getInboundDetailByShowNo,
  verifyInboundOrder,
  type InboundOrderDetail,
} from '@/api/modules/inbound'
import { extractErrorMessage } from '@/utils/error'
import dayjs from 'dayjs'

const scanCode = ref('')
const scanInputRef = ref<{ focus: () => void } | null>(null)
const loading = ref(false)
const verifying = ref(false)
const successToastVisible = ref(false)

const currentOrder = ref<InboundOrderDetail | null>(null)
const recentScans = ref<Array<{ verifyCode: string; showNo: string; status: InboundOrderDetail['order']['status']; scannedAt: string }>>([])

const statusMap = {
  pending: { label: '待入库', type: 'warning' },
  verified: { label: '已入库', type: 'success' },
  cancelled: { label: '已取消', type: 'info' },
} as const

// 统一状态颜色映射，保障“顶部状态条 + 标签 + 文案提示”一致。
const statusToneClassMap = {
  pending: 'bg-amber-500/90',
  verified: 'bg-emerald-500/90',
  cancelled: 'bg-slate-400/90',
} as const

// 查询按钮可用状态：避免查询中、核销中重复触发请求。
const canQuery = computed(() => {
  return !loading.value && !verifying.value
})

// 确认入库按钮可用状态：仅待入库单据允许操作，其他状态禁止。
const canVerify = computed(() => {
  return Boolean(currentOrder.value && currentOrder.value.order.status === 'pending' && !verifying.value)
})

// 详情摘要卡数据，统一模板渲染，避免重复写格式化逻辑。
const summaryCards = computed(() => {
  if (!currentOrder.value) {
    return []
  }

  const order = currentOrder.value.order
  return [
    {
      label: '供货方',
      value: order.supplierName || '-',
    },
    {
      label: '送货单号',
      value: order.showNo || '-',
    },
    {
      label: '创建时间',
      value: dayjs(order.createdAt).format('YYYY-MM-DD HH:mm:ss'),
    },
    {
      label: '总件数',
      value: `${order.totalQty} 件`,
    },
  ]
})

// 将错误归类为可执行提示，避免“扫码失败”一刀切影响排障。
const normalizeScanErrorMessage = (error: unknown): string => {
  const rawMessage = extractErrorMessage(error, '扫码识别失败，请重试')
  const normalized = rawMessage.toLowerCase()

  if (normalized.includes('not found') || normalized.includes('不存在')) {
    return '未找到该送货单，请确认二维码是否正确'
  }
  if (normalized.includes('forbidden') || normalized.includes('权限')) {
    return '当前账号无权查看该送货单，请联系管理员'
  }
  if (normalized.includes('timeout') || normalized.includes('network')) {
    return '网络波动导致查询失败，请检查网络后重试'
  }
  if (normalized.includes('cancelled') || normalized.includes('已取消')) {
    return '该送货单已取消，不能继续入库'
  }

  return rawMessage
}

// 最新扫码记录用于快速回查，限制为 5 条，避免列表无限增长。
const appendRecentScan = (detail: InboundOrderDetail) => {
  const { verifyCode, showNo, status } = detail.order
  const nextRecord = {
    verifyCode,
    showNo,
    status,
    scannedAt: dayjs().format('HH:mm:ss'),
  }

  const deduplicated = recentScans.value.filter((record) => record.verifyCode !== verifyCode)
  recentScans.value = [nextRecord, ...deduplicated].slice(0, 5)
}

const focusScanInput = () => {
  nextTick(() => {
    scanInputRef.value?.focus()
  })
}

const isShowNoPattern = (code: string) => /^IN\d{12}$/i.test(code.trim())

const handleScan = async () => {
  const code = scanCode.value.trim()
  if (!code) {
    ElMessage.warning('请先扫描或输入送货单二维码')
    return
  }
  if (!canQuery.value) {
    return
  }
  if (currentOrder.value?.order.verifyCode === code) {
    ElMessage.info('该送货单已加载，无需重复扫描')
    scanCode.value = ''
    focusScanInput()
    return
  }

  loading.value = true
  try {
    let result: InboundOrderDetail
    try {
      result = await getInboundDetail(code)
    } catch (firstError) {
      // 当输入的是送货单号（IN+日期+流水）时，自动回退到按 showNo 查询接口。
      if (!isShowNoPattern(code)) {
        throw firstError
      }
      result = await getInboundDetailByShowNo(code.trim().toUpperCase())
    }

    currentOrder.value = result
    appendRecentScan(result)
    scanCode.value = ''
    focusScanInput()
  } catch (err) {
    ElMessage.error(normalizeScanErrorMessage(err))
    scanCode.value = ''
    currentOrder.value = null
    focusScanInput()
  } finally {
    loading.value = false
  }
}

const handleVerify = async () => {
  if (!canVerify.value || !currentOrder.value) return

  const { showNo, totalQty } = currentOrder.value.order
  try {
    await ElMessageBox.confirm(
      `请确认实物与清单一致。\n送货单号：${showNo}\n本次总件数：${totalQty} 件\n确认后库存将立刻增加，操作不可撤销。`,
      '一键入库确认',
      {
        type: 'warning',
        confirmButtonText: '确认入库',
        cancelButtonText: '取消',
      },
    )
  } catch {
    return
  }

  verifying.value = true
  try {
    const result = await verifyInboundOrder(currentOrder.value.order.verifyCode)
    currentOrder.value = result
    appendRecentScan(result)
    successToastVisible.value = true
    ElMessage.success('入库成功！库存已更新，可继续扫码下一单')

    // 成功提示条短暂展示，随后自动回焦扫码框。
    setTimeout(() => {
      successToastVisible.value = false
      focusScanInput()
    }, 1200)
  } catch (err) {
    ElMessage.error(extractErrorMessage(err, '入库失败'))
  } finally {
    verifying.value = false
  }
}

const handleReset = () => {
  currentOrder.value = null
  scanCode.value = ''
  focusScanInput()
}

// 快捷键策略：
// - Enter：执行扫码查询；
// - Ctrl + Enter：直接触发确认入库（仅待入库状态）；
// - Esc：清空当前单据并回到“等待扫码”。
const handleGlobalKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    event.preventDefault()
    handleReset()
    return
  }

  if (event.key === 'Enter' && event.ctrlKey) {
    event.preventDefault()
    if (canVerify.value) {
      void handleVerify()
    }
    return
  }

  if (event.key === 'Enter' && !event.ctrlKey) {
    const target = event.target as HTMLElement | null
    const isInputRelated = Boolean(
      target?.closest('.scan-input') || target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA',
    )
    if (isInputRelated) {
      event.preventDefault()
      void handleScan()
    }
  }
}

const handleReuseRecentScan = (verifyCode: string) => {
  scanCode.value = verifyCode
  void handleScan()
}

onMounted(() => {
  focusScanInput()
  window.addEventListener('keydown', handleGlobalKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleGlobalKeydown)
})
</script>

<template>
  <PageContainer title="一键扫码入库" description="扫码识别送货单、核对明细并确认入库，支持快捷键连续作业。">
    <div class="grid grid-cols-1 xl:grid-cols-[360px_minmax(0,1fr)] gap-6 min-h-[calc(100vh-160px)]">
      <!-- 左侧：扫码区 + 快捷指引 + 最近扫码 -->
      <section class="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-slate-100 dark:border-slate-700 flex flex-col overflow-hidden">
        <div class="p-5 border-b border-slate-100 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-900/40">
          <h2 class="text-lg font-semibold text-slate-800 dark:text-slate-100 mb-3 flex items-center gap-2">
            <el-icon class="text-brand"><Search /></el-icon>
            扫码作业区
          </h2>
          <el-input
            ref="scanInputRef"
            v-model="scanCode"
            placeholder="请用扫码枪扫描送货单二维码"
            size="large"
            clearable
            class="scan-input"
          >
            <template #prefix>
              <el-icon><Picture /></el-icon>
            </template>
            <template #append>
              <el-button :loading="loading" :disabled="!canQuery" @click="handleScan">
                {{ loading ? '识别中...' : '查询' }}
              </el-button>
            </template>
          </el-input>
          <div class="mt-4 rounded-xl bg-brand/5 dark:bg-brand/15 border border-brand/20 p-3 text-xs leading-6 text-slate-600 dark:text-slate-300">
            <p>快捷键：Enter 查询，Ctrl+Enter 确认入库，Esc 重置页面</p>
            <p>提示：连续作业时无需手动点击，系统会自动回焦扫码框。</p>
          </div>
        </div>

        <div class="p-5 border-b border-slate-100 dark:border-slate-700">
          <h3 class="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">作业指引</h3>
          <div class="space-y-2 text-sm text-slate-500 dark:text-slate-400">
            <p>1. 扫码或输入二维码后点击查询。</p>
            <p>2. 核对供货方、单号、商品明细与数量。</p>
            <p>3. 确认无误后执行“一键确认入库”。</p>
          </div>
        </div>

        <div class="p-5 flex-1">
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-sm font-semibold text-slate-700 dark:text-slate-200">最近查询</h3>
            <el-button link type="primary" @click="recentScans = []">清空</el-button>
          </div>
          <div v-if="recentScans.length" class="space-y-2">
            <button
              v-for="record in recentScans"
              :key="record.verifyCode"
              type="button"
              class="recent-item w-full text-left"
              @click="handleReuseRecentScan(record.verifyCode)"
            >
              <div class="flex items-center justify-between">
                <span class="font-medium text-slate-700 dark:text-slate-200">{{ record.showNo }}</span>
                <el-tag size="small" effect="light" :type="statusMap[record.status].type">
                  {{ statusMap[record.status].label }}
                </el-tag>
              </div>
              <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">查询时间：{{ record.scannedAt }}</p>
            </button>
          </div>
          <div v-else class="h-full flex items-center justify-center text-center text-slate-400 dark:text-slate-500">
            <div>
              <el-icon :size="48" class="mb-2"><Document /></el-icon>
              <p>暂无最近查询记录</p>
            </div>
          </div>
        </div>
      </section>

      <!-- 右侧：详情区 -->
      <section class="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-slate-100 dark:border-slate-700 flex flex-col overflow-hidden relative">
        <div v-if="loading" class="absolute inset-0 z-10 bg-white/80 dark:bg-slate-800/80 backdrop-blur-sm flex items-center justify-center">
          <el-icon class="is-loading text-brand text-4xl"><Loading /></el-icon>
        </div>

        <transition name="fade-slide" mode="out-in">
          <div v-if="currentOrder" key="order-detail" class="flex flex-col min-h-0 h-full">
            <!-- 顶部状态条 -->
            <div class="h-1.5" :class="statusToneClassMap[currentOrder.order.status]" />

            <!-- 单据标题与状态 -->
            <div class="p-5 border-b border-slate-100 dark:border-slate-700">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div class="flex items-center gap-3">
                  <h2 class="text-xl font-semibold text-slate-800 dark:text-slate-100">送货单核对</h2>
                  <el-tag :type="statusMap[currentOrder.order.status].type" effect="light" round>
                    {{ statusMap[currentOrder.order.status].label }}
                  </el-tag>
                </div>
                <div class="text-sm text-slate-500 dark:text-slate-400">
                  核销码：{{ currentOrder.order.verifyCode }}
                </div>
              </div>
            </div>

            <!-- 摘要卡 -->
            <div class="px-5 pt-5">
              <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
                <div
                  v-for="card in summaryCards"
                  :key="card.label"
                  class="rounded-xl border border-slate-100 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-900/40 p-3"
                >
                  <p class="text-xs text-slate-500 dark:text-slate-400">{{ card.label }}</p>
                  <p class="mt-1 text-sm font-semibold text-slate-800 dark:text-slate-100 break-all">{{ card.value }}</p>
                </div>
              </div>
            </div>

            <div v-if="currentOrder.order.remark" class="px-5 pt-3 text-sm text-slate-500 dark:text-slate-400">
              备注：{{ currentOrder.order.remark }}
            </div>

            <!-- 明细区 -->
            <div class="flex-1 min-h-0 overflow-auto px-5 py-4">
              <h3 class="text-base font-medium text-slate-800 dark:text-slate-200 mb-3">送货明细核对</h3>
              <div class="space-y-3">
                <div
                  v-for="(item, index) in currentOrder.items"
                  :key="item.id"
                  class="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-900/50 rounded-xl border border-slate-100 dark:border-slate-700 hover:bg-brand/5 dark:hover:bg-brand/10 transition-colors"
                >
                  <div class="flex items-center gap-3">
                    <div class="w-8 h-8 rounded-full bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 flex items-center justify-center text-slate-500 dark:text-slate-300 font-medium">
                      {{ index + 1 }}
                    </div>
                    <div>
                      <div class="text-[15px] font-semibold text-slate-800 dark:text-slate-100">{{ item.productNameSnapshot }}</div>
                    </div>
                  </div>
                  <div class="text-xl font-semibold text-slate-700 dark:text-slate-200">
                    x {{ Number(item.qty) }}
                  </div>
                </div>
              </div>
            </div>

            <!-- 底部操作栏 -->
            <div class="sticky bottom-0 p-5 border-t border-slate-100 dark:border-slate-700 bg-white/95 dark:bg-slate-800/95 backdrop-blur-sm flex flex-wrap gap-3 justify-between items-center">
              <el-button plain size="large" @click="handleReset" class="!rounded-xl px-8">
                重置并扫码下一单
              </el-button>
              <div class="flex gap-3">
                <el-button type="primary" plain size="large" :disabled="loading || verifying" @click="handleScan" class="!rounded-xl px-8">
                  重新查询
                </el-button>
                <el-button
                  type="primary"
                  size="large"
                  :loading="verifying"
                  :disabled="!canVerify"
                  @click="handleVerify"
                  class="!rounded-xl px-10"
                >
                  <el-icon class="mr-2"><Check /></el-icon>
                  {{ verifying ? '入库处理中...' : '一键确认入库' }}
                </el-button>
              </div>
            </div>

            <div
              v-if="successToastVisible"
              class="absolute top-4 right-4 px-4 py-2 rounded-xl bg-emerald-500 text-white text-sm shadow-lg success-toast"
            >
              入库成功，已准备下一单扫码
            </div>
          </div>
        </transition>

        <transition name="fade-slide" mode="out-in">
          <div v-if="!currentOrder" key="empty-detail" class="flex-1 flex items-center justify-center">
            <el-empty description="请先在左侧扫码或输入二维码" :image-size="200" />
          </div>
        </transition>
      </section>
    </div>
  </PageContainer>
</template>

<style scoped>
/* 扫码输入框增强：聚焦时边框强调，便于扫码枪连续作业时快速确认焦点位置。 */
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
.scan-input :deep(.el-input-group__append) {
  padding: 0;
}
.scan-input :deep(.el-input-group__append .el-button) {
  min-width: 78px;
  height: 48px;
  padding: 0 16px;
  border-radius: 0 12px 12px 0;
}

/* 最近查询项：卡片化并提供轻微 hover 提示可点击。 */
.recent-item {
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 12px;
  padding: 10px 12px;
  background: rgba(248, 250, 252, 0.9);
  transition: all 0.2s ease;
}
.recent-item:hover {
  border-color: rgba(20, 184, 166, 0.4);
  background: rgba(240, 253, 250, 0.9);
}

/* 详情区切换动效：扫码成功后右侧信息平滑入场。 */
.fade-slide-enter-active,
.fade-slide-leave-active {
  transition: all 0.2s ease;
}
.fade-slide-enter-from,
.fade-slide-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

/* 成功提示条使用轻量浮现动效，避免视觉突兀。 */
.success-toast {
  animation: toast-pop 0.24s ease;
}
@keyframes toast-pop {
  from {
    opacity: 0;
    transform: translateY(-8px) scale(0.96);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
</style>
