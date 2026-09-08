/**
 * 模块说明：`src/views/dashboard/composables/useDashboardAnalytics.ts`
 * 文件职责：收敛工作台首页“统计区间 + 榜单维度”筛选状态，并统一驱动趋势图与两个排行榜的数据加载。
 * 实现逻辑：
 * - 区间条件分为草稿态与已应用态：草稿只跟随控件变化，点击“查询统计”或“重置条件”后才提交，避免拖动日期时反复打接口；
 * - 榜单维度（规格模式 / 指定商品 / Top N）属于即时生效项，变更后直接重新加载，符合“切一下就看结果”的使用直觉；
 * - 按月模式下把 YYYY-MM 展开为当月首日与当月末日，保证跨月跨年区间完整覆盖首月与末月；
 * - 请求竞态交给 useStableRequest 的 runLatest 处理，不再使用 `if (loading) return` 这类早退守卫，
 *   否则用户快速切换筛选时新请求会被直接吞掉，反而更容易看到过期结果。
 * 维护说明：
 * - 饼图、趋势图、榜单必须共用这里的 appliedFilter，任何一处单独维护区间都会导致首页出现两套口径；
 * - 新增筛选维度时优先在本文件扩展，不要把请求逻辑下沉到图表或榜单组件内部。
 */

import { computed, reactive, ref } from 'vue'
import dayjs from 'dayjs'

import {
  getDashboardAnalytics,
  type DashboardAnalyticsResult,
  type DashboardProductSpecMode,
  type DashboardTopCustomer,
  type DashboardTopProduct,
  type DashboardTrendGranularity,
  type DashboardTrendPoint,
} from '@/api/modules/dashboard'
import { useStableRequest } from '@/composables/useStableRequest'
import { extractErrorMessage } from '@/utils/error'
import { showAppError } from '@/utils/app-alert'

export type DashboardOrderTypeFilter = '' | 'department' | 'walkin'

/** 已应用的统计区间：饼图、趋势图、榜单与下钻抽屉共用同一份口径。 */
export interface DashboardAppliedFilter {
  granularity: DashboardTrendGranularity
  /** 展开后的实际起止日期（YYYY-MM-DD），为空表示交由后端回落到本月。 */
  dateRange: [string, string] | null
  orderType: DashboardOrderTypeFilter
}

/** 榜单维度选项，变更后立即重新加载。 */
export interface DashboardRankOptions {
  productSpecMode: DashboardProductSpecMode
  productId: string
  topN: number
}

export const DASHBOARD_TOP_N_OPTIONS = [5, 10, 20] as const

/**
 * 把控件值展开为实际统计日期：
 * - 按日模式直接透传 YYYY-MM-DD；
 * - 按月模式把 YYYY-MM 展开为当月首日 / 当月末日，确保末月整月都被统计进来。
 */
const expandRangeValue = (
  granularity: DashboardTrendGranularity,
  rawRange: [string, string] | [],
): [string, string] | null => {
  if (rawRange.length !== 2) {
    return null
  }

  const [rawStart, rawEnd] = rawRange
  if (!rawStart || !rawEnd) {
    return null
  }

  if (granularity === 'day') {
    return [rawStart, rawEnd]
  }

  const startMonth = dayjs(rawStart)
  const endMonth = dayjs(rawEnd)
  if (!startMonth.isValid() || !endMonth.isValid()) {
    return null
  }

  return [startMonth.startOf('month').format('YYYY-MM-DD'), endMonth.endOf('month').format('YYYY-MM-DD')]
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
export const useDashboardAnalytics = () => {
  const analyticsRequest = useStableRequest()
  const analyticsLoading = ref(false)
  const trend = ref<DashboardTrendPoint[]>([])
  const topProducts = ref<DashboardTopProduct[]>([])
  const topCustomers = ref<DashboardTopCustomer[]>([])
  /** 后端回执的真实生效区间，用于标题与“当前统计区间”文案，避免前端自说自话。 */
  const resolvedRange = ref<DashboardAnalyticsResult['range'] | null>(null)

  // 草稿态：只跟随筛选控件，点击查询/重置后才提交到 appliedFilter。
  const draftFilter = reactive({
    granularity: 'day' as DashboardTrendGranularity,
    rangeValue: [] as [string, string] | [],
    orderType: '' as DashboardOrderTypeFilter,
  })

  const appliedFilter = ref<DashboardAppliedFilter>({
    granularity: 'day',
    dateRange: null,
    orderType: '',
  })

  const rankOptions = reactive<DashboardRankOptions>({
    productSpecMode: 'merged',
    productId: '',
    topN: DASHBOARD_TOP_N_OPTIONS[0],
  })

  /** 当前统计区间文案：区间未知时不编造“本月”，等后端回执再展示。 */
  const rangeLabel = computed(() => {
    const range = resolvedRange.value
    if (!range?.startDate || !range?.endDate) {
      return '统计区间加载中'
    }
    return `${range.startDate} 至 ${range.endDate}`
  })

  const granularityLabel = computed(() => (resolvedRange.value?.granularity === 'month' ? '按月' : '按日'))

  const orderTypeLabel = computed(() => {
    if (appliedFilter.value.orderType === 'department') {
      return '部门单'
    }
    if (appliedFilter.value.orderType === 'walkin') {
      return '散客单'
    }
    return '全部订单类型'
  })

  /** 下钻抽屉复用的筛选条件，保证明细口径与榜单一致。 */
  const drilldownFilter = computed(() => ({
    dateRange: appliedFilter.value.dateRange,
    orderType: appliedFilter.value.orderType || undefined,
  }))

  const loadAnalytics = async () => {
    analyticsLoading.value = true
    await analyticsRequest.runLatest({
      executor: (signal) =>
        getDashboardAnalytics(
          {
            dateRange: appliedFilter.value.dateRange,
            orderType: appliedFilter.value.orderType || undefined,
            granularity: appliedFilter.value.granularity,
            productSpecMode: rankOptions.productSpecMode,
            productId: rankOptions.productId || undefined,
            topN: rankOptions.topN,
          },
          { signal },
        ),
      onSuccess: (result) => {
        trend.value = result.trend ?? []
        topProducts.value = result.topProducts ?? []
        topCustomers.value = result.topCustomers ?? []
        resolvedRange.value = result.range
      },
      onError: (error) => {
        showAppError(extractErrorMessage(error, '获取区间统计失败'))
      },
      onFinally: ({ status }) => {
        // 请求被新筛选中止时不要提前收起加载态，否则会闪出一次空态。
        if (status !== 'canceled') {
          analyticsLoading.value = false
        }
      },
    })
  }

  /** 提交草稿区间：切换粒度时清空已选值，避免把月份值当日期发给后端。 */
  const applyDraftFilter = () => {
    appliedFilter.value = {
      granularity: draftFilter.granularity,
      dateRange: expandRangeValue(draftFilter.granularity, draftFilter.rangeValue),
      orderType: draftFilter.orderType,
    }
  }

  const handleGranularityChange = () => {
    draftFilter.rangeValue = []
  }

  const handleSearch = () => {
    applyDraftFilter()
    void loadAnalytics()
  }

  const handleReset = () => {
    draftFilter.granularity = 'day'
    draftFilter.rangeValue = []
    draftFilter.orderType = ''
    applyDraftFilter()
    void loadAnalytics()
  }

  const handleRankOptionsChange = (next: Partial<DashboardRankOptions>) => {
    if (next.productSpecMode) {
      rankOptions.productSpecMode = next.productSpecMode
    }
    if (typeof next.productId === 'string') {
      rankOptions.productId = next.productId
    }
    if (next.topN) {
      rankOptions.topN = next.topN
    }
    void loadAnalytics()
  }

  return {
    analyticsLoading,
    trend,
    topProducts,
    topCustomers,
    resolvedRange,
    draftFilter,
    appliedFilter,
    rankOptions,
    rangeLabel,
    granularityLabel,
    orderTypeLabel,
    drilldownFilter,
    loadAnalytics,
    handleGranularityChange,
    handleSearch,
    handleReset,
    handleRankOptionsChange,
  }
}
