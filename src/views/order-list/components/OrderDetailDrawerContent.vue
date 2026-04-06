<script setup lang="ts">
import dayjs from 'dayjs'
import type { OrderDetailResult } from '@/api/modules/order'

/**
 * 单据详情展示组件：
 * - 仅负责渲染主单信息与明细列表；
 * - 页面层只需传入详情数据与当前设备信息；
 * - 保持桌面表格、移动端卡片的既有样式与展示逻辑不变。
 */
defineProps<{
  order: OrderDetailResult
  isPhone: boolean
  isDesktop: boolean
  detailGridClass: string
}>()

/**
 * 金额格式化：
 * - 统一将字符串金额安全转为两位小数；
 * - 避免接口字段缺失或异常值时直接渲染出 NaN；
 * - 与详情抽屉既有“¥xx.xx”展示保持一致。
 */
const formatAmount = (value: string | number | null | undefined) => {
  const normalizedValue = Number(value ?? 0)
  return Number.isFinite(normalizedValue) ? normalizedValue.toFixed(2) : '0.00'
}
</script>

<template>
  <div class="mb-6">
    <h3 class="mb-3 border-l-4 border-primary pl-2 text-lg font-medium text-slate-800 dark:text-slate-100">主单信息</h3>
    <el-descriptions :column="isPhone ? 1 : 2" border size="small">
      <el-descriptions-item label="业务单号">{{ order.showNo }}</el-descriptions-item>
      <el-descriptions-item label="开单时间">{{ dayjs(order.createdAt).format('YYYY-MM-DD HH:mm:ss') }}</el-descriptions-item>
      <el-descriptions-item label="客户名称">{{ order.customerName || '-' }}</el-descriptions-item>
      <el-descriptions-item label="开单人">{{ order.creatorDisplayName || order.creatorUsername || '-' }}</el-descriptions-item>
      <el-descriptions-item label="单据备注">{{ order.remark || '-' }}</el-descriptions-item>
      <el-descriptions-item label="总数量">{{ order.totalQty }}</el-descriptions-item>
      <el-descriptions-item label="总金额">
        <span class="font-bold text-red-500">¥{{ formatAmount(order.totalAmount) }}</span>
      </el-descriptions-item>
    </el-descriptions>
  </div>

  <div>
    <h3 class="mb-3 border-l-4 border-primary pl-2 text-lg font-medium text-slate-800 dark:text-slate-100">明细列表</h3>
    <el-table v-if="isDesktop" :data="order.items" border stripe size="small">
      <el-table-column type="index" label="行号" width="60" align="center" />
      <el-table-column prop="productCode" label="产品编码" width="100" />
      <el-table-column prop="productName" label="产品名称" min-width="120" />
      <el-table-column prop="qty" label="数量" width="80" align="right" />
      <el-table-column prop="unitPrice" label="单价" width="100" align="right">
        <template #default="{ row }">¥{{ formatAmount(row.unitPrice) }}</template>
      </el-table-column>
      <el-table-column prop="subTotal" label="小计" width="100" align="right">
        <template #default="{ row }">
          <span class="text-red-500">¥{{ formatAmount(row.subTotal) }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="remark" label="备注" min-width="100" show-overflow-tooltip />
    </el-table>

    <div v-else :class="['grid gap-3', detailGridClass]">
      <div
        v-for="(item, index) in order.items"
        :key="item.id"
        class="rounded-xl border border-slate-100 bg-slate-50 p-3 dark:border-white/10 dark:bg-white/5"
      >
        <div class="mb-2 flex items-start justify-between gap-3">
          <span class="font-medium text-slate-800 dark:text-slate-100">
            <span class="mr-1 text-slate-400 dark:text-slate-500">{{ index + 1 }}.</span>
            {{ item.productName || '-' }}
          </span>
          <span class="font-medium text-red-500">¥{{ formatAmount(item.subTotal) }}</span>
        </div>
        <div class="flex flex-wrap justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
          <span>编码：{{ item.productCode }}</span>
          <span>{{ item.qty }} × ¥{{ formatAmount(item.unitPrice) }}</span>
        </div>
        <div v-if="item.remark" class="mt-2 rounded bg-slate-100 p-1 text-xs text-slate-500 dark:bg-white/5 dark:text-slate-400">
          备注：{{ item.remark }}
        </div>
      </div>
    </div>
  </div>
</template>
