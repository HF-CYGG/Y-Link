<script setup lang="ts">
/**
 * 模块说明：src/views/reports/components/InventorySkuDetailDrawer.vue
 * 文件职责：展示库存一览表中单个商品下全部规格（SKU）的当前库存、预订库存、可用库存与启用状态。
 * 实现逻辑：
 * - 抽屉仅在用户点击商品行“规格明细”后懒加载，请求接入稳定请求工具，快速切换商品时旧响应不会覆盖新商品；
 * - 顶部三格合计直接取后端 summary，与报表商品行同源计算；表格/手机卡片逐条展示规格并用标签区分“计入合计 / 已停用 / 历史规格”；
 * - 商品没有当前规格时合计回退商品主表库存，抽屉显式提示，避免把规格之和与合计对不上误判为数据错误。
 * 维护说明：
 * - 计入口径（当前且启用）只能由后端 countedInSummary 决定，页面不得自行重算或把停用、历史规格算作可用；
 * - 本组件由报表中心异步加载，新增字段时保持抽屉式延迟加载，不要把明细回填到报表主表。
 */

import { ref, watch } from 'vue'

import { BizResponsiveDrawerShell } from '@/components/common'
import { getInventorySkuDetail, type InventorySkuDetail, type InventorySkuDetailResult } from '@/api/modules/report'
import { useStableRequest } from '@/composables/useStableRequest'
import { extractErrorMessage } from '@/utils/error'
import { showAppError, showAppWarning } from '@/utils/app-alert'

const props = defineProps<{
  modelValue: boolean
  productId: string
  /** 打开瞬间用于标题占位，数据返回后以接口中的商品名称为准。 */
  productName?: string
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
}>()

const request = useStableRequest()
const loading = ref(false)
const data = ref<InventorySkuDetailResult | null>(null)

const resolveSkuStatus = (sku: InventorySkuDetail): { label: string, type: 'success' | 'info' | 'warning' } => {
  if (sku.countedInSummary) {
    return { label: '当前启用·计入合计', type: 'success' }
  }
  if (!sku.isCurrent) {
    return { label: '历史规格·不计入', type: 'warning' }
  }
  return { label: '已停用·不计入', type: 'info' }
}

// 不计入合计的规格行整体弱化，桌面表格与手机卡片保持同一视觉提示。
const resolveSkuRowClass = ({ row }: { row: InventorySkuDetail }) => (row.countedInSummary ? '' : 'inventory-sku-row--excluded')

const loadData = async () => {
  if (!props.productId.trim()) {
    showAppWarning('当前商品行缺少商品标识，无法查看规格明细')
    emit('update:modelValue', false)
    return
  }

  loading.value = true
  data.value = null
  await request.runLatest({
    executor: (signal) => getInventorySkuDetail(props.productId, { signal }),
    onSuccess: (result) => {
      data.value = result
    },
    onError: (error) => {
      showAppError(extractErrorMessage(error, '获取规格库存明细失败'))
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
    title="规格库存明细"
    height-mode="scroll"
    phone-size="92%"
    tablet-size="720px"
    desktop-size="720px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <template #header>
      <div class="min-w-0">
        <div class="truncate text-base font-semibold text-slate-800 dark:text-slate-100">
          {{ data?.productName || props.productName || '规格库存明细' }}
        </div>
        <div class="mt-1 truncate text-xs text-slate-500 dark:text-slate-400">
          {{ data ? `商品编码 ${data.productCode} · 商品${data.productStatus}` : '合计口径：仅当前且启用的规格计入' }}
        </div>
      </div>
    </template>

    <template #default="{ isPhone }">
      <div v-loading="loading" class="space-y-4">
        <template v-if="data">
          <div class="grid gap-3 sm:grid-cols-3">
            <div class="rounded-xl bg-slate-50 px-3 py-2 dark:bg-slate-900/40">
              <div class="text-xs text-slate-500 dark:text-slate-400">当前库存合计</div>
              <div class="mt-1 text-sm font-semibold text-slate-700 dark:text-slate-200">{{ data.summary.currentStock }}</div>
            </div>
            <div class="rounded-xl bg-slate-50 px-3 py-2 dark:bg-slate-900/40">
              <div class="text-xs text-slate-500 dark:text-slate-400">预订库存合计</div>
              <div class="mt-1 text-sm font-semibold text-slate-700 dark:text-slate-200">{{ data.summary.preOrderedStock }}</div>
            </div>
            <div class="rounded-xl bg-slate-50 px-3 py-2 dark:bg-slate-900/40">
              <div class="text-xs text-slate-500 dark:text-slate-400">可用库存合计</div>
              <div class="mt-1 text-sm font-semibold text-brand">{{ data.summary.availableStock }}</div>
            </div>
          </div>

          <div
            v-if="data.fallbackToProductStock"
            class="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800 dark:border-amber-700/40 dark:bg-amber-900/20 dark:text-amber-200"
          >
            该商品没有当前规格，报表合计按商品主表库存展示；下方规格均不参与合计，数值之和与合计不相等属于正常口径。
          </div>
          <p v-else class="text-xs text-slate-500 dark:text-slate-400">
            合计仅统计标记为“计入合计”的规格；已停用和历史规格单独列出，不代表可用库存。
          </p>

          <template v-if="data.skus.length">
            <div v-if="isPhone" class="space-y-3">
              <div
                v-for="sku in data.skus"
                :key="sku.skuId"
                class="inventory-sku-card rounded-xl border border-slate-100 bg-white p-3 dark:border-slate-700 dark:bg-slate-800"
                :class="sku.countedInSummary ? '' : 'is-excluded'"
              >
                <div class="flex items-start justify-between gap-2">
                  <div class="min-w-0">
                    <p class="break-words text-sm font-semibold text-slate-800 dark:text-slate-100">{{ sku.specText }}</p>
                    <p class="mt-0.5 break-all text-xs text-slate-500 dark:text-slate-400">{{ sku.skuCode }}</p>
                  </div>
                  <el-tag size="small" effect="light" :type="resolveSkuStatus(sku).type" class="shrink-0">
                    {{ resolveSkuStatus(sku).label }}
                  </el-tag>
                </div>
                <div class="mt-3 grid grid-cols-3 gap-2 text-center">
                  <div class="rounded-lg bg-slate-50 px-1 py-1.5 dark:bg-slate-900/40">
                    <div class="text-[11px] text-slate-500 dark:text-slate-400">当前</div>
                    <div class="text-sm font-semibold text-slate-700 dark:text-slate-200">{{ sku.currentStock }}</div>
                  </div>
                  <div class="rounded-lg bg-slate-50 px-1 py-1.5 dark:bg-slate-900/40">
                    <div class="text-[11px] text-slate-500 dark:text-slate-400">预订</div>
                    <div class="text-sm font-semibold text-slate-700 dark:text-slate-200">{{ sku.preOrderedStock }}</div>
                  </div>
                  <div class="rounded-lg bg-slate-50 px-1 py-1.5 dark:bg-slate-900/40">
                    <div class="text-[11px] text-slate-500 dark:text-slate-400">可用</div>
                    <div class="text-sm font-semibold text-slate-700 dark:text-slate-200">{{ sku.availableStock }}</div>
                  </div>
                </div>
              </div>
            </div>

            <el-table v-else native-scrollbar :data="data.skus" stripe table-layout="auto" :row-class-name="resolveSkuRowClass">
              <el-table-column prop="specText" label="规格" min-width="160" show-overflow-tooltip />
              <el-table-column prop="skuCode" label="规格编码" min-width="140" show-overflow-tooltip />
              <el-table-column prop="currentStock" label="当前库存" width="92" align="right" />
              <el-table-column prop="preOrderedStock" label="预订库存" width="92" align="right" />
              <el-table-column prop="availableStock" label="可用库存" width="92" align="right" />
              <el-table-column label="状态" min-width="150">
                <template #default="{ row }">
                  <el-tag size="small" effect="light" :type="resolveSkuStatus(row).type">{{ resolveSkuStatus(row).label }}</el-tag>
                </template>
              </el-table-column>
            </el-table>
          </template>
          <div v-else class="flex min-h-[160px] items-center justify-center rounded-xl bg-slate-50 dark:bg-slate-900/40">
            <el-empty :image-size="72" description="该商品暂无规格记录" />
          </div>
        </template>
      </div>
    </template>
  </BizResponsiveDrawerShell>
</template>

<style scoped>
.inventory-sku-card.is-excluded {
  opacity: 0.78;
}

:deep(.inventory-sku-row--excluded) {
  color: #94a3b8;
}
</style>
