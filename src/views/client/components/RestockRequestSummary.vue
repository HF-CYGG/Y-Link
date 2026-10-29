<script setup lang="ts">
/**
 * 模块说明：src/views/client/components/RestockRequestSummary.vue
 * 文件职责：在客户端会话与客服属性区展示同一份补货申请快照。
 * 实现逻辑：业务状态直接使用服务端 effectiveStatus，截止时间固定按北京时间精确到分钟显示。
 * 维护说明：聊天状态与补货状态独立；历史商品、规格使用申请快照，不依赖当前目录。
 */
import type { ClientRestockRequest } from '@/api/modules/customer-service-feedback'
import { formatRestockTime, RESTOCK_STATUS_LABELS } from '@/utils/restock'
defineProps<{ restock: ClientRestockRequest }>()
</script>

<template>
  <section class="rounded-xl border border-teal-200 bg-teal-50/70 p-3 text-sm dark:border-teal-900 dark:bg-teal-500/10" aria-label="补货需求">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <p class="font-semibold text-slate-900 dark:text-slate-100">补货需求 · {{ restock.productNameSnapshot }}</p>
      <el-tag effect="plain" :type="restock.effectiveStatus === 'expired' || restock.effectiveStatus === 'cancelled' ? 'info' : 'success'">{{ RESTOCK_STATUS_LABELS[restock.effectiveStatus] }}</el-tag>
    </div>
    <p class="mt-2 break-words text-slate-600 dark:text-slate-300">规格：{{ restock.specTextSnapshot || '默认规格' }} · {{ restock.skuCodeSnapshot }}</p>
    <p class="mt-1 text-slate-600 dark:text-slate-300">期望数量：{{ restock.quantity }}</p>
    <p class="mt-1 text-slate-600 dark:text-slate-300">最晚取货：{{ formatRestockTime(restock.latestPickupAt) }}（UTC+8）</p>
    <p v-if="restock.remark" class="mt-2 whitespace-pre-wrap break-words text-slate-600 dark:text-slate-300">备注：{{ restock.remark }}</p>
  </section>
</template>
