<script setup lang="ts">
/**
 * 模块说明：src/views/dashboard/components/TopProductRankCard.vue
 * 文件职责：负责仪表盘热销商品排行卡片展示，提供“合并/细分规格”切换、指定商品筛选与 Top N 选择，并承接钻取入口。
 * 实现逻辑：
 * - 卡片层只做维度选择与排行项选中，真正的聚合查询由上层 useDashboardAnalytics 统一发起，避免首页出现多套口径；
 * - 默认按商品合并：同一商品的不同颜色/款式合并数量后参与排序，榜单只展示商品名称；
 * - 打开“细分规格”后按具体款式分别统计与排序，并用标签明确展示规格文本；
 * - 榜单行 key 与钻取入参统一使用后端下发的 rankKey，因为细分模式下同一 productId 会出现多行。
 * 维护说明：
 * - 若后续扩展更多排行维度，优先在卡片配置层补齐，不要复制一份新的排行组件；
 * - 商品排行文案和排序口径必须与后端统计接口保持一致（当前为出库数量），避免运营解读偏差；
 * - 规格文本来源于出库明细的商品名称快照，手工开单不含规格，统一显示为“默认规格”，改动前请先确认数据来源。
 */


import { computed, onBeforeUnmount, onDeactivated, ref } from 'vue'

import type { DashboardProductSpecMode, DashboardTopProduct } from '@/api/modules/dashboard'
import { getProductList, type ProductRecord } from '@/api/modules/product'
import TopProductDrilldownDrawer from './TopProductDrilldownDrawer.vue'
import type { DashboardAppliedFilter, DashboardRankOptions } from '../composables/useDashboardAnalytics'
import { DASHBOARD_TOP_N_OPTIONS } from '../composables/useDashboardAnalytics'
import { useStableRequest } from '@/composables/useStableRequest'
import { extractErrorMessage } from '@/utils/error'

import { showAppError, showAppWarning } from '@/utils/app-alert'

const props = defineProps<{
  topProducts: DashboardTopProduct[]
  options: DashboardRankOptions
  filter: DashboardAppliedFilter
  rangeLabel: string
  loading: boolean
}>()

const emit = defineEmits<{
  (event: 'update:options', value: Partial<DashboardRankOptions>): void
}>()

const drawerVisible = ref(false)
const activeProductId = ref('')
const activeNameSnapshot = ref('')
const productOptions = ref<ProductRecord[]>([])
const productSearching = ref(false)
const productSearchRequest = useStableRequest()

const isSpecMode = computed(() => props.options.productSpecMode === 'spec')

const rankSubtitle = computed(() => {
  const dimension = isSpecMode.value ? '按规格' : '按商品'
  return `${dimension}出库数量 Top ${props.options.topN}`
})

const emptyDescription = computed(() => {
  return props.options.productId ? '所选商品在该区间暂无出库' : '所选区间暂无榜单数据'
})

const formatQty = (value: string | number | null | undefined): string => {
  const normalizedNumber = Number(value ?? 0)
  return Number.isFinite(normalizedNumber) ? normalizedNumber.toFixed(2) : '0.00'
}

/**
 * 商品远程检索：
 * - 复用基础资料的商品列表接口；
 * - 不过滤启停状态：这里是历史报表的筛选维度，商品出库后被停用，其历史明细仍会被区间分析统计到，
 *   若只查启用商品，用户就再也无法在下拉里找到它做跨年或规格对比。停用只应阻止新业务使用商品，
 *   不该把它从历史报表里抹掉；候选项会为停用商品打上标记，避免误以为它还能开单；
 * - 关键字为空时不主动拉全量，由用户输入后再查，降低首页额外请求；
 * - 走 useStableRequest 并透传 signal：连续输入或中途清空时会中止在途请求，
 *   只允许最后一次结果回写候选列表，避免慢响应盖掉新关键字的结果。
 */
const handleProductSearch = async (keyword: string) => {
  const normalizedKeyword = keyword.trim()
  if (!normalizedKeyword) {
    // 清空关键字时同样要中止在途请求，否则它返回后仍会把旧候选写回已清空的下拉。
    productSearchRequest.cancel()
    productSearching.value = false
    productOptions.value = []
    return
  }

  productSearching.value = true
  await productSearchRequest.runLatest({
    executor: (signal) => getProductList({ keyword: normalizedKeyword }, { signal }),
    onSuccess: (result) => {
      productOptions.value = result
    },
    onError: (error) => {
      showAppError(extractErrorMessage(error, '检索商品失败'))
      productOptions.value = []
    },
    onFinally: () => {
      productSearching.value = false
    },
  })
}

/**
 * 失活与卸载时复位检索加载态：
 * - useStableRequest 的 cancel() 会把 activeController 置空，runLatest 随后判定请求已过期直接返回，
 *   onFinally 不会被调用；不复位的话下拉会永远停在“加载中”。
 */
const resetSearchingOnLeave = () => {
  productSearching.value = false
}

onDeactivated(resetSearchingOnLeave)
onBeforeUnmount(resetSearchingOnLeave)

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const handleSpecModeChange = (value: boolean) => {
  const productSpecMode: DashboardProductSpecMode = value ? 'spec' : 'merged'
  emit('update:options', { productSpecMode })
}

const handleProductChange = (value: string | null) => {
  emit('update:options', { productId: value ?? '' })
}

const handleTopNChange = (value: number) => {
  emit('update:options', { topN: value })
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const openDrilldown = (item: DashboardTopProduct) => {
  if (!item.productId.trim()) {
    showAppWarning('当前榜单项缺少产品标识')
    return
  }

  activeProductId.value = item.productId
  // 合并模式看整个商品的明细，细分模式只看该规格对应的名称快照。
  activeNameSnapshot.value = item.nameSnapshot ?? ''
  drawerVisible.value = true
}
</script>

<template>
  <div class="apple-card p-5 sm:p-6 xl:p-7">
    <div class="mb-4 flex flex-wrap items-start justify-between gap-2">
      <div class="min-w-0">
        <h2 class="text-lg font-semibold text-slate-800 dark:text-slate-200">热门出库文创榜</h2>
        <p class="mt-1 truncate text-xs text-slate-500 dark:text-slate-400">{{ props.rangeLabel }}</p>
      </div>
      <span class="shrink-0 text-xs text-slate-500 dark:text-slate-400">{{ rankSubtitle }}</span>
    </div>

    <div class="mb-4 flex flex-wrap items-center gap-2">
      <el-select
        :model-value="props.options.productId || null"
        class="!w-full sm:!w-[200px]"
        clearable
        filterable
        remote
        reserve-keyword
        :remote-method="handleProductSearch"
        :loading="productSearching"
        placeholder="全部商品（可搜索指定商品）"
        @update:model-value="handleProductChange($event as string | null)"
      >
        <el-option v-for="product in productOptions" :key="product.id" :label="product.productName" :value="product.id">
          <span class="flex items-center justify-between gap-2">
            <span class="truncate">{{ product.productName }}</span>
            <el-tag v-if="!product.isActive" size="small" type="info" effect="plain" class="shrink-0 !px-1.5">
              已停用
            </el-tag>
          </span>
        </el-option>
      </el-select>

      <el-select
        :model-value="props.options.topN"
        class="!w-[104px]"
        @update:model-value="handleTopNChange($event as number)"
      >
        <el-option v-for="topN in DASHBOARD_TOP_N_OPTIONS" :key="topN" :label="`Top ${topN}`" :value="topN" />
      </el-select>

      <div class="flex items-center gap-2">
        <el-switch
          :model-value="isSpecMode"
          @update:model-value="handleSpecModeChange($event as boolean)"
        />
        <span class="text-xs text-slate-500 dark:text-slate-400">细分规格</span>
      </div>
    </div>

    <div v-if="props.loading" class="min-h-[180px]">
      <el-skeleton animated :rows="5" class="w-full" />
    </div>
    <div v-else-if="topProducts.length" class="space-y-3">
      <button
        v-for="(item, index) in topProducts"
        :key="item.rankKey"
        type="button"
        class="flex w-full items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2.5 text-left transition hover:bg-slate-100 dark:bg-slate-900/40 dark:hover:bg-slate-900/60"
        @click="openDrilldown(item)"
      >
        <div class="flex min-w-0 items-center gap-3">
          <div class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand/10 text-xs font-bold text-brand dark:bg-brand/20 dark:text-teal-400">
            {{ index + 1 }}
          </div>
          <div class="min-w-0">
            <div class="truncate text-sm font-medium text-slate-700 dark:text-slate-200">{{ item.productName }}</div>
            <el-tag v-if="item.specLabel" size="small" effect="plain" class="mt-1 !px-1.5">
              {{ item.specLabel }}
            </el-tag>
          </div>
        </div>
        <div class="shrink-0 text-sm font-semibold text-slate-700 dark:text-slate-200">{{ formatQty(item.totalQty) }} 件</div>
      </button>
    </div>
    <div v-else class="flex min-h-[180px] items-center justify-center rounded-xl bg-slate-50 text-slate-400 dark:bg-slate-900/40">
      <el-empty :image-size="64" :description="emptyDescription" />
    </div>
  </div>
  <TopProductDrilldownDrawer
    v-model="drawerVisible"
    :product-id="activeProductId"
    :name-snapshot="activeNameSnapshot"
    :filter="props.filter"
  />
</template>
