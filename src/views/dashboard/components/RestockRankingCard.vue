<script setup lang="ts">
/**
 * 模块说明：src/views/dashboard/components/RestockRankingCard.vue
 * 文件职责：显示按商品合并规格的补货申请次数 Top 5，提供客服列表下钻。
 * 实现逻辑：只消费上层独立日期请求结果，跳转携带服务端生效日期，避免默认本月跨日漂移。
 * 维护说明：次数包括完成、过期和撤回历史；没有客服查看权限时仅展示，不能提供跳转入口。
 */
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import type { RestockRankingResult } from '@/api/modules/dashboard'
import { usePermissionAction } from '@/composables/usePermissionAction'
const props = defineProps<{ result: RestockRankingResult | null; loading: boolean; error: string }>()
defineEmits<{ (event: 'retry'): void }>()
const router = useRouter()
const { hasPermission, ensurePermission } = usePermissionAction()
const canOpen = computed(() => hasPermission('customer_service:view'))
const open = (item: RestockRankingResult['list'][number]) => {
  if (!props.result || !ensurePermission('customer_service:view', '查看补货会话')) return
  void router.push({ path: '/system/customer-service', query: {
    issueType: 'restock', productId: item.productId, productName: item.productName,
    dateRange: `${props.result.range.startDate},${props.result.range.endDate}`,
  } })
}
</script>

<template>
  <section class="apple-card p-5 sm:p-6 xl:p-7" aria-label="补货需求排行">
    <div class="flex items-center justify-between gap-2">
      <h2 class="text-lg font-semibold text-slate-800 dark:text-slate-200">补货需求排行 Top 5</h2>
      <span class="text-xs text-slate-500 dark:text-slate-400">申请次数</span>
    </div>
    <p class="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">{{ result ? `${result.range.startDate} 至 ${result.range.endDate}` : '跟随已应用的统计日期，默认本月' }} · 按商品合并规格</p>
    <p class="mt-1 text-xs leading-5 text-slate-400">包含已补货、过期和撤回申请；同一有效需求的重复提交不计次。</p>
    <el-skeleton v-if="loading" :rows="3" animated class="mt-4" />
    <div v-else-if="error" class="mt-4 text-sm text-rose-600 dark:text-rose-300" role="alert">{{ error }} <el-button link type="primary" @click="$emit('retry')">重试</el-button></div>
    <el-empty v-else-if="!result?.list.length" description="该日期范围暂无补货申请" :image-size="65" />
    <ol v-else class="mt-4 space-y-2">
      <li v-for="(item, index) in result.list.slice(0, 5)" :key="item.productId" class="flex min-w-0 items-center gap-3 rounded-lg bg-slate-50 px-3 py-2 dark:bg-white/5">
        <span class="shrink-0 text-sm font-semibold text-teal-600 dark:text-teal-300">{{ index + 1 }}</span>
        <div class="min-w-0 flex-1">
          <el-button v-if="canOpen" link type="primary" class="!h-auto !max-w-full !justify-start !whitespace-normal !text-left" @click="open(item)">{{ item.productName }}</el-button>
          <span v-else class="break-words text-sm text-slate-800 dark:text-slate-200">{{ item.productName }}</span>
          <p class="truncate text-xs text-slate-400">{{ item.productCode }}</p>
        </div>
        <span class="shrink-0 text-sm font-semibold text-slate-800 dark:text-slate-200">{{ item.requestCount }} 次</span>
      </li>
    </ol>
  </section>
</template>
