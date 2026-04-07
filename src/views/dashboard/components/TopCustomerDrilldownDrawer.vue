<script setup lang="ts">
import { ref, watch } from 'vue'
import dayjs from 'dayjs'
import { ElMessage } from 'element-plus'
import { getCustomerDrilldown, type CustomerDrilldownResult } from '@/api/modules/dashboard'
import { useStableRequest } from '@/composables/useStableRequest'
import { extractErrorMessage } from '@/utils/error'

const props = defineProps<{
  modelValue: boolean
  customerName: string
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
}>()

const request = useStableRequest()
const loading = ref(false)
const data = ref<CustomerDrilldownResult | null>(null)

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

const loadData = async () => {
  if (!props.customerName.trim()) {
    ElMessage.warning('当前榜单项缺少客户标识')
    emit('update:modelValue', false)
    return
  }

  loading.value = true
  data.value = null
  await request.runLatest({
    executor: (signal) => getCustomerDrilldown(props.customerName, {}, { signal }),
    onSuccess: (result) => {
      data.value = result
    },
    onError: (error) => {
      ElMessage.error(extractErrorMessage(error, '获取客户榜明细失败'))
      emit('update:modelValue', false)
    },
    onFinally: () => {
      loading.value = false
    },
  })
}

watch(
  () => [props.modelValue, props.customerName] as const,
  ([visible]) => {
    if (visible) {
      void loadData()
    }
  },
  { immediate: true },
)
</script>

<template>
  <el-drawer :model-value="props.modelValue" size="720px" :destroy-on-close="true" @update:model-value="emit('update:modelValue', $event)">
    <template #header>
      <div class="min-w-0">
        <div class="truncate text-base font-semibold text-slate-800 dark:text-slate-100">
          {{ data?.customerName || '客户榜明细下钻' }}
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
            <div class="text-xs text-slate-500 dark:text-slate-400">总金额</div>
            <div class="mt-1 text-sm font-semibold text-slate-700 dark:text-slate-200">¥{{ formatAmount(data.totalAmount) }}</div>
          </div>
          <div class="rounded-xl bg-slate-50 px-3 py-2 dark:bg-slate-900/40">
            <div class="text-xs text-slate-500 dark:text-slate-400">总数量</div>
            <div class="mt-1 text-sm font-semibold text-slate-700 dark:text-slate-200">{{ formatQty(data.totalQty) }}</div>
          </div>
          <div class="rounded-xl bg-slate-50 px-3 py-2 dark:bg-slate-900/40">
            <div class="text-xs text-slate-500 dark:text-slate-400">订单数</div>
            <div class="mt-1 text-sm font-semibold text-slate-700 dark:text-slate-200">{{ data.orderCount }} 单</div>
          </div>
        </div>
        <div v-if="data.records.length" class="max-h-[55vh] overflow-auto">
          <el-table :data="data.records" stripe table-layout="auto">
            <el-table-column prop="showNo" label="业务单号" min-width="150" show-overflow-tooltip />
            <el-table-column label="订单类型" width="100">
              <template #default="{ row }">{{ formatOrderType(row.orderType) }}</template>
            </el-table-column>
            <el-table-column prop="customerDepartmentName" label="客户部门" min-width="120" show-overflow-tooltip />
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
  </el-drawer>
</template>
