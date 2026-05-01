<script setup lang="ts">
/**
 * 模块说明：src/views/dashboard/components/TopProductDrilldownDrawer.vue
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */


import { ref, watch } from 'vue'
import dayjs from 'dayjs'
import { ElMessage } from 'element-plus'
import { BizResponsiveDrawerShell } from '@/components/common'
import { getProductDrilldown, type ProductDrilldownResult } from '@/api/modules/dashboard'
import { useStableRequest } from '@/composables/useStableRequest'
import { extractErrorMessage } from '@/utils/error'

const props = defineProps<{
  modelValue: boolean
  productId: string
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
}>()

const request = useStableRequest()
const loading = ref(false)
const data = ref<ProductDrilldownResult | null>(null)

const formatAmount = (value: string | number | null | undefined): string => {
  const normalizedNumber = Number(value ?? 0)
  return Number.isFinite(normalizedNumber) ? normalizedNumber.toFixed(2) : '0.00'
}

const formatQty = (value: string | number | null | undefined): string => {
  const normalizedNumber = Number(value ?? 0)
  return Number.isFinite(normalizedNumber) ? normalizedNumber.toFixed(2) : '0.00'
}

const formatOrderType = (value: 'department' | 'walkin'): string => {
  return value === 'department' ? '部门单' : '散客单'
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const loadData = async () => {
  if (!props.productId.trim()) {
    ElMessage.warning('当前榜单项缺少产品标识')
    emit('update:modelValue', false)
    return
  }

  loading.value = true
  data.value = null
  await request.runLatest({
    executor: (signal) => getProductDrilldown(props.productId, {}, { signal }),
    onSuccess: (result) => {
      data.value = result
    },
    onError: (error) => {
      ElMessage.error(extractErrorMessage(error, '获取Top5明细失败'))
      emit('update:modelValue', false)
    },
    onFinally: () => {
      loading.value = false
    },
  })
}

watch(
  () => [props.modelValue, props.productId] as const,
  ([visible]) => {
    if (visible) {
      void loadData()
    }
  },
  { immediate: true },
)
</script>

<template>
  <BizResponsiveDrawerShell
    :model-value="props.modelValue"
    title="Top5 明细下钻"
    height-mode="scroll"
    phone-size="92%"
    tablet-size="680px"
    desktop-size="680px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <template #header>
      <div class="min-w-0">
        <div class="truncate text-base font-semibold text-slate-800 dark:text-slate-100">
          {{ data?.productName || 'Top5 明细下钻' }}
        </div>
        <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">
          最多展示 100 条订单记录
        </div>
      </div>
    </template>
    <div v-loading="loading" class="space-y-4">
      <template v-if="data">
        <div class="grid gap-3 sm:grid-cols-3">
          <div class="rounded-xl bg-slate-50 px-3 py-2 dark:bg-slate-900/40">
            <div class="text-xs text-slate-500 dark:text-slate-400">总数量</div>
            <div class="mt-1 text-sm font-semibold text-slate-700 dark:text-slate-200">{{ formatQty(data.totalQty) }}</div>
          </div>
          <div class="rounded-xl bg-slate-50 px-3 py-2 dark:bg-slate-900/40">
            <div class="text-xs text-slate-500 dark:text-slate-400">总金额</div>
            <div class="mt-1 text-sm font-semibold text-slate-700 dark:text-slate-200">¥{{ formatAmount(data.totalAmount) }}</div>
          </div>
          <div class="rounded-xl bg-slate-50 px-3 py-2 dark:bg-slate-900/40">
            <div class="text-xs text-slate-500 dark:text-slate-400">订单数</div>
            <div class="mt-1 text-sm font-semibold text-slate-700 dark:text-slate-200">{{ data.orderCount }} 单</div>
          </div>
        </div>
        <!-- 明细表不再自建滚动容器：
         - 当前抽屉已使用共享壳的 scroll 模式，主滚动职责应由壳层统一承接；
         - 避免抽屉正文与表格区域形成双滚动，影响桌面端阅读与触控手感。
        -->
        <div v-if="data.records.length">
          <el-table :data="data.records" stripe table-layout="auto">
            <el-table-column prop="showNo" label="业务单号" min-width="150" show-overflow-tooltip />
            <el-table-column label="订单类型" width="100">
              <template #default="{ row }">{{ formatOrderType(row.orderType) }}</template>
            </el-table-column>
            <el-table-column label="开单时间" min-width="170">
              <template #default="{ row }">{{ dayjs(row.createdAt).format('YYYY-MM-DD HH:mm:ss') }}</template>
            </el-table-column>
            <el-table-column prop="qty" label="数量" width="92" align="right">
              <template #default="{ row }">{{ formatQty(row.qty) }}</template>
            </el-table-column>
            <el-table-column prop="amount" label="金额" width="110" align="right">
              <template #default="{ row }">¥{{ formatAmount(row.amount) }}</template>
            </el-table-column>
          </el-table>
        </div>
        <div v-else class="flex min-h-[180px] items-center justify-center rounded-xl bg-slate-50 dark:bg-slate-900/40">
          <el-empty :image-size="72" description="当前筛选条件下暂无明细" />
        </div>
      </template>
    </div>
  </BizResponsiveDrawerShell>
</template>
