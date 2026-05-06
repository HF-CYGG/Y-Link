<script setup lang="ts">
/**
 * 模块说明：`src/views/order-list/components/OrderDetailDrawerContent.vue`
 * 文件职责：负责渲染出库单详情抽屉中的主单信息与明细列表。
 * 实现逻辑：
 * 1. 主单信息按订单类型做条件化展示，部门单保留部门流程字段，散客单直接显示“不适用”或隐藏冗余项；
 * 2. 详情组件只负责展示，不参与数据请求与状态管理；
 * 3. 金额与订单类型在组件内统一格式化，确保表格端与移动端展示口径一致。
 */


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

const formatOrderType = (value: OrderDetailResult['orderType']) => {
  return value === 'department' ? '部门单' : '散客单'
}

/**
 * 详情主显示名称：
 * - 部门单优先使用客户部门名称；
 * - 散客单回退客户名称；
 * - 兼容历史数据缺失时的兜底展示。
 */
const getOrderDisplayName = (order: OrderDetailResult) => {
  if (order.orderType === 'department') {
    return order.customerDepartmentName || order.customerName || '-'
  }
  return order.customerName || order.customerDepartmentName || '-'
}
</script>

<template>
  <section class="mb-5 rounded-2xl border border-slate-100 bg-slate-50/70 p-3 sm:p-4 dark:border-white/10 dark:bg-white/5">
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h3 class="flex items-center gap-2 text-base font-semibold text-slate-800 dark:text-slate-100">
        <span class="inline-block h-2 w-2 rounded-full bg-brand" />
        主单信息
      </h3>
      <div class="rounded-full bg-white px-2.5 py-1 text-xs text-slate-500 dark:bg-white/10 dark:text-slate-400">
        {{ dayjs(order.createdAt).format('YYYY-MM-DD HH:mm:ss') }}
      </div>
    </div>
    <el-descriptions :column="isPhone ? 1 : 2" border size="small">
      <el-descriptions-item label="业务单号">{{ order.showNo }}</el-descriptions-item>
      <el-descriptions-item label="订单类型">{{ formatOrderType(order.orderType) }}</el-descriptions-item>
      <el-descriptions-item label="开单时间">{{ dayjs(order.createdAt).format('YYYY-MM-DD HH:mm:ss') }}</el-descriptions-item>
      <el-descriptions-item label="领用对象">{{ getOrderDisplayName(order) }}</el-descriptions-item>
      <el-descriptions-item label="客户部门">{{ order.orderType === 'department' ? order.customerDepartmentName || '-' : '不适用' }}</el-descriptions-item>
      <el-descriptions-item label="出库单状态">
        {{ order.orderType === 'department' ? (order.hasCustomerOrder ? '已带单' : '未带单') : '不适用' }}
      </el-descriptions-item>
      <el-descriptions-item label="系统申请">
        {{ order.orderType === 'department' ? (order.isSystemApplied ? '已申请' : '未申请') : '不适用' }}
      </el-descriptions-item>
      <el-descriptions-item v-if="order.customerName" label="客户名称">{{ order.customerName }}</el-descriptions-item>
      <el-descriptions-item label="出单人">{{ order.issuerName || '-' }}</el-descriptions-item>
      <el-descriptions-item label="开单人">{{ order.creatorDisplayName || order.creatorUsername || '-' }}</el-descriptions-item>
      <el-descriptions-item label="总数量">{{ order.totalQty }}</el-descriptions-item>
      <el-descriptions-item label="总金额">
        <span class="text-base font-bold text-red-500">¥{{ formatAmount(order.totalAmount) }}</span>
      </el-descriptions-item>
      <el-descriptions-item label="单据备注" :span="isPhone ? 1 : 2">{{ order.remark || '-' }}</el-descriptions-item>
    </el-descriptions>
  </section>

  <section class="mb-6 grid gap-2 sm:grid-cols-2">
    <div class="rounded-xl border border-slate-100 bg-white px-3 py-2.5 dark:border-white/10 dark:bg-white/5">
      <div class="text-xs text-slate-500 dark:text-slate-400">明细行数</div>
      <div class="mt-1 text-sm font-semibold text-slate-800 dark:text-slate-100">{{ order.items.length }} 行</div>
    </div>
    <div class="rounded-xl border border-slate-100 bg-white px-3 py-2.5 dark:border-white/10 dark:bg-white/5">
      <div class="text-xs text-slate-500 dark:text-slate-400">合计金额</div>
      <div class="mt-1 text-sm font-semibold text-red-500">¥{{ formatAmount(order.totalAmount) }}</div>
    </div>
  </section>

  <section>
    <h3 class="mb-3 flex items-center gap-2 text-base font-semibold text-slate-800 dark:text-slate-100">
      <span class="inline-block h-2 w-2 rounded-full bg-brand" />
      明细列表
    </h3>
    <el-table native-scrollbar v-if="isDesktop" :data="order.items" border stripe size="small" table-layout="auto">
      <el-table-column type="index" label="行号" width="68" align="center" />
      <el-table-column prop="productCode" label="产品编码" min-width="130" show-overflow-tooltip />
      <el-table-column prop="productName" label="产品名称" min-width="180" show-overflow-tooltip />
      <el-table-column prop="qty" label="数量" width="92" align="right" />
      <el-table-column prop="unitPrice" label="单价" width="118" align="right">
        <template #default="{ row }">¥{{ formatAmount(row.unitPrice) }}</template>
      </el-table-column>
      <el-table-column prop="subTotal" label="小计" width="118" align="right">
        <template #default="{ row }">
          <span class="font-medium text-red-500">¥{{ formatAmount(row.subTotal) }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="remark" label="备注" min-width="180" show-overflow-tooltip />
    </el-table>

    <div v-else :class="['grid gap-3', detailGridClass]">
      <div
        v-for="(item, index) in order.items"
        :key="item.id"
        class="rounded-xl border border-slate-100 bg-slate-50 p-3.5 dark:border-white/10 dark:bg-white/5"
      >
        <div class="mb-2 flex items-start justify-between gap-3">
          <span class="font-medium text-slate-800 dark:text-slate-100">
            <span class="mr-1 text-slate-400 dark:text-slate-500">{{ index + 1 }}.</span>
            {{ item.productName || '-' }}
          </span>
          <span class="font-semibold text-red-500">¥{{ formatAmount(item.subTotal) }}</span>
        </div>
        <div class="flex flex-wrap justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
          <span>编码：{{ item.productCode }}</span>
          <span>{{ item.qty }} × ¥{{ formatAmount(item.unitPrice) }}</span>
        </div>
        <div v-if="item.remark" class="mt-2 rounded bg-slate-100 p-1.5 text-xs text-slate-500 dark:bg-white/5 dark:text-slate-400">
          备注：{{ item.remark }}
        </div>
      </div>
    </div>
  </section>
</template>
