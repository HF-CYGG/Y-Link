<script setup lang="ts">
/**
 * 模块说明：src/views/o2o/components/O2oOrderPoolCardStatus.vue
 * 文件职责：渲染 O2O 订单池卡片右上角的“状态标签 + 待核销倒计时”两枚徽标。
 * 实现逻辑：
 * - 倒计时与“临近超时 / 超时取消”判定都依赖每秒推进的页面时钟；把这两处读时钟的模板收敛到本组件，
 *   每秒只重渲染各卡片里这一小块，而不是整页订单池 + 详情面板；
 * - 时钟通过 `resolveNowMs` 函数传入：父组件模板只传函数引用、不读取时钟值，因此父组件渲染不会订阅时钟；
 * - 状态文案继续复用共享状态配置，与详情区、客户端口径保持一致。
 * 维护说明：
 * - 不要改成直接传 `nowMs` 数值，否则父组件模板会重新订阅时钟，每秒整页重渲染的问题会回来；
 * - 卡片上新增任何依赖当前时间的展示，都应放进本组件，而不是写回订单池页面模板。
 */

import { computed } from 'vue'
import { getClientOrderStatusReportConfig, type O2oOrderStatus } from '@/constants/o2o-order-status'
import type { O2oOrderStatusReport } from '@/api/modules/o2o'

const props = defineProps<{
  order: {
    statusReport?: O2oOrderStatusReport
    status: O2oOrderStatus
    timeoutAt: string | null
    expireInSeconds?: number
  }
  resolveNowMs: () => number
}>()

const reportConfig = computed(() => getClientOrderStatusReportConfig({
  statusReport: props.order.statusReport,
  status: props.order.status,
  timeoutAt: props.order.timeoutAt,
}, props.resolveNowMs()))

const resolveRemainSeconds = () => {
  const { order } = props
  if (order.status !== 'pending') {
    return null
  }
  if (order.timeoutAt) {
    const remain = Math.floor((new Date(order.timeoutAt).getTime() - props.resolveNowMs()) / 1000)
    return Math.max(0, remain)
  }
  if (typeof order.expireInSeconds === 'number') {
    return Math.max(0, Math.floor(order.expireInSeconds))
  }
  return null
}

/**
 * 卡片倒计时文案：
 * - 仅待核销订单且存在有效剩余时间时展示；
 * - 已超时、已取消、已核销不在卡片重复展示倒计时，状态标签本身已足够表达结果。
 */
const countdownText = computed(() => {
  const remainSeconds = resolveRemainSeconds()
  if (remainSeconds === null || remainSeconds <= 0) {
    return ''
  }
  const hour = Math.floor(remainSeconds / 3600)
  const minute = Math.floor((remainSeconds % 3600) / 60)
  const second = remainSeconds % 60
  return `剩余 ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`
})
</script>

<template>
  <span class="rounded-full px-2 py-0.5 text-[11px] font-medium" :class="reportConfig.cardClassName">
    {{ reportConfig.statusLabel }}
  </span>
  <span
    v-if="countdownText"
    class="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-300"
  >
    {{ countdownText }}
  </span>
</template>
