<script setup lang="ts">
import { computed, defineAsyncComponent, onActivated, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import dayjs from 'dayjs'
import { ElMessage } from 'element-plus'
import { Box, DataAnalysis, Document, Money, More, WarningFilled } from '@element-plus/icons-vue'
import { PageContainer } from '@/components/common'
import { getDashboardStats, type DashboardStats } from '@/api/modules/dashboard'
import { useStableRequest } from '@/composables/useStableRequest'
import { buildDashboardShortcutItems } from '@/router/routes'
import { useAppStore, useAuthStore } from '@/store'
import { extractErrorMessage } from '@/utils/error'

const router = useRouter()
const appStore = useAppStore()
const authStore = useAuthStore()
const loading = ref(false)
const stats = ref<DashboardStats | null>(null)
const loadStatus = ref<'idle' | 'success' | 'error' | 'canceled'>('idle')
const dashboardRequest = useStableRequest()
const TREND_VIEWBOX_WIDTH = 640
const TREND_VIEWBOX_HEIGHT = 240
const TREND_PADDING_X = 24
const TREND_PADDING_Y = 24
const activeTrendDate = ref('')
const DashboardPieSection = defineAsyncComponent(() => import('./components/DashboardPieSection.vue'))
const TopProductRankCard = defineAsyncComponent(() => import('./components/TopProductRankCard.vue'))
const TopCustomerRankCard = defineAsyncComponent(() => import('./components/TopCustomerRankCard.vue'))

/**
 * 当前用户可见快捷入口：
 * - 由路由配置与权限点共同派生；
 * - 当前用户只会看到自己具备权限的业务与治理入口。
 */
const shortcutItems = computed(() => buildDashboardShortcutItems(authStore.currentUser))

/**
 * 精简后的快捷入口：
 * - 工作台保留“高频入口”，其余入口交给左侧导航；
 * - 手机端默认展示 2 个入口，桌面端展示 4 个入口。
 */
const compactShortcutItems = computed(() => {
  const visibleSize = appStore.isPhone ? 2 : 4
  return shortcutItems.value.slice(0, visibleSize)
})

/**
 * 金额格式化：
 * - 看板金额统一以两位小数展示，避免模板里重复 Number().toFixed()；
 * - 兜底 0.00，防止接口波动导致空值显示。
 */
const formatAmount = (value: string | number | null | undefined): string => {
  const normalizedNumber = Number(value ?? 0)
  return Number.isFinite(normalizedNumber) ? normalizedNumber.toFixed(2) : '0.00'
}

/**
 * 数量格式化：
 * - 业务数量允许出现小数，统一保留两位；
 * - 排行榜与趋势辅助信息使用同一格式策略。
 */
const formatQty = (value: string | number | null | undefined): string => {
  const normalizedNumber = Number(value ?? 0)
  return Number.isFinite(normalizedNumber) ? normalizedNumber.toFixed(2) : '0.00'
}

/**
 * 卡片网格策略：
 * - phone 使用单列，避免数值卡片过窄；
 * - tablet 使用双列；
 * - desktop 使用四列完整展示，形成均衡四宫格。
 */
const statsGridClass = computed(() => {
  if (appStore.isDesktop) {
    return 'xl:grid-cols-4 lg:grid-cols-4'
  }

  if (appStore.isTablet) {
    return 'sm:grid-cols-2'
  }

  return 'grid-cols-1'
})

/**
 * 核心看板卡片：
 * - “今日”反映即时状态；
 * - “本月”补充周期业绩；
 * - 四宫格统一视觉节奏，避免首屏右侧留白。
 */
const metricCards = computed(() => [
  {
    key: 'today-order',
    title: '今日出库单数',
    value: `${stats.value?.todayOrderCount ?? 0}`,
    unit: '单',
    iconBgClass: 'bg-brand/10 dark:bg-brand/20',
    iconTextClass: 'text-brand dark:text-teal-400',
    delay: '0ms',
    icon: Document,
  },
  {
    key: 'today-amount',
    title: '今日出库金额',
    value: formatAmount(stats.value?.todayOrderAmount),
    unit: '¥',
    iconBgClass: 'bg-secondary/10 dark:bg-secondary/20',
    iconTextClass: 'text-secondary dark:text-slate-300',
    delay: '100ms',
    icon: Money,
  },
  {
    key: 'product-total',
    title: '在库产品总数',
    value: `${stats.value?.totalProductCount ?? 0}`,
    unit: '种',
    iconBgClass: 'bg-brand/10 dark:bg-brand/20',
    iconTextClass: 'text-brand dark:text-teal-400',
    delay: '200ms',
    icon: Box,
  },
  {
    key: 'month-amount',
    title: '本月累计出库',
    value: formatAmount(stats.value?.monthOrderAmount),
    unit: '¥',
    iconBgClass: 'bg-brand/10 dark:bg-brand/20',
    iconTextClass: 'text-brand dark:text-teal-400',
    delay: '300ms',
    icon: DataAnalysis,
  },
])

/**
 * 近 7 日趋势点：
 * - 接口已保证返回 7 天完整序列（无数据日期为 0）；
 * - 前端只负责把金额映射到 SVG 坐标系。
 */
const trendPoints = computed(() => {
  const trend = stats.value?.trend7Days ?? []
  if (!trend.length) {
    return []
  }

  const amounts = trend.map((item) => Number(item.amount ?? 0))
  const maxAmount = Math.max(...amounts, 0)
  const minAmount = Math.min(...amounts, 0)
  const range = Math.max(maxAmount - minAmount, 1)
  const usableWidth = TREND_VIEWBOX_WIDTH - TREND_PADDING_X * 2
  const usableHeight = TREND_VIEWBOX_HEIGHT - TREND_PADDING_Y * 2

  return trend.map((item, index) => {
    const x = TREND_PADDING_X + (usableWidth * index) / Math.max(trend.length - 1, 1)
    const amount = Number(item.amount ?? 0)
    const normalizedY = (amount - minAmount) / range
    const y = TREND_VIEWBOX_HEIGHT - TREND_PADDING_Y - normalizedY * usableHeight
    return {
      ...item,
      amount,
      x,
      y,
    }
  })
})

/**
 * 趋势悬停热区：
 * - 为每个日期点生成可命中的透明区域，提升鼠标悬停易用性；
 * - 热区覆盖整张图的高度，避免用户必须精准命中小圆点。
 */
const trendHoverSegments = computed(() => {
  const points = trendPoints.value
  if (!points.length) {
    return []
  }

  return points.map((point, index) => {
    const prevX = points[index - 1]?.x ?? TREND_PADDING_X
    const nextX = points[index + 1]?.x ?? TREND_VIEWBOX_WIDTH - TREND_PADDING_X
    const startX = index === 0 ? TREND_PADDING_X : (prevX + point.x) / 2
    const endX = index === points.length - 1 ? TREND_VIEWBOX_WIDTH - TREND_PADDING_X : (point.x + nextX) / 2
    return {
      date: point.date,
      x: startX,
      width: Math.max(endX - startX, 1),
    }
  })
})

/**
 * 当前悬停的趋势点：
 * - 根据日期主键映射具体数据；
 * - 仅在用户悬停到图表日期点时返回。
 */
const activeTrendPoint = computed(() => {
  if (!activeTrendDate.value) {
    return null
  }

  return trendPoints.value.find((point) => point.date === activeTrendDate.value) ?? null
})

/**
 * 趋势悬浮卡位置：
 * - 以悬停点 x 坐标为中心；
 * - 对边缘位置做裁剪，避免提示框溢出图表区域。
 */
const activeTrendTooltipStyle = computed(() => {
  if (!activeTrendPoint.value) {
    return {}
  }

  const xPercent = (activeTrendPoint.value.x / TREND_VIEWBOX_WIDTH) * 100
  const clampedPercent = Math.max(12, Math.min(88, xPercent))
  return {
    left: `${clampedPercent}%`,
  }
})

const setActiveTrendPoint = (date: string) => {
  activeTrendDate.value = date
}

const clearActiveTrendPoint = () => {
  activeTrendDate.value = ''
}

/**
 * 趋势折线路径：
 * - 使用平滑二次贝塞尔曲线，避免折线过于生硬；
 * - 当数据点不足时自动退化为空路径。
 */
const trendPath = computed(() => {
  const points = trendPoints.value
  if (points.length < 2) {
    return ''
  }

  let path = `M ${points[0].x} ${points[0].y}`
  for (let index = 1; index < points.length; index += 1) {
    const prevPoint = points[index - 1]
    const point = points[index]
    const controlX = (prevPoint.x + point.x) / 2
    path += ` Q ${controlX} ${prevPoint.y}, ${point.x} ${point.y}`
  }

  return path
})

/**
 * 趋势面积路径：
 * - 在折线下方补充渐变填充，提升看板层次感；
 * - 以图表底部为基线闭合路径。
 */
const trendAreaPath = computed(() => {
  const points = trendPoints.value
  if (points.length < 2 || !trendPath.value) {
    return ''
  }

  const baseY = TREND_VIEWBOX_HEIGHT - TREND_PADDING_Y
  const firstPoint = points[0]
  const lastPoint = points[points.length - 1]
  return `${trendPath.value} L ${lastPoint.x} ${baseY} L ${firstPoint.x} ${baseY} Z`
})

/**
 * 趋势最大值：
 * - 作为图表右上角辅助信息，帮助快速感知峰值。
 */
const trendMaxAmount = computed(() => {
  const maxValue = Math.max(...trendPoints.value.map((point) => point.amount), 0)
  return formatAmount(maxValue)
})

/**
 * 近期出库动态：
 * - 复用后端审计事件流，仅展示出库相关动作；
 * - 首页默认展示最近 8 条，避免列表过长挤压首屏。
 */
const recentActivities = computed(() => {
  return (stats.value?.recentActivities ?? []).slice(0, 6)
})

/**
 * 动作标签样式：
 * - 新建强调成功态；
 * - 删除使用风险态；
 * - 恢复使用提醒态，帮助管理者快速识别事件类型。
 */
const resolveActivityTagType = (actionType: string): 'success' | 'danger' | 'warning' | 'info' => {
  if (actionType === 'order.create') {
    return 'success'
  }
  if (actionType === 'order.delete') {
    return 'danger'
  }
  if (actionType === 'order.restore') {
    return 'warning'
  }
  return 'info'
}

/**
 * 动态时间格式化：
 * - 同日显示“HH:mm”，便于快速追踪操作时序；
 * - 跨日显示“MM-DD HH:mm”，保留日期信息避免歧义。
 */
const formatActivityTime = (value: string): string => {
  const targetDate = dayjs(value)
  if (!targetDate.isValid()) {
    return '-'
  }
  return targetDate.isSame(dayjs(), 'day') ? targetDate.format('HH:mm') : targetDate.format('MM-DD HH:mm')
}

/**
 * 动态联动跳转：
 * - 点击首页动态后跳转到出库列表页；
 * - 通过 query 透传目标单据信息，复用列表页既有“定位并打开详情抽屉”逻辑。
 */
const navigateToActivityOrder = (activity: { id: string; showNo: string }) => {
  router.push({
    path: '/order-list',
    query: {
      focusOrderId: activity.id,
      focusOrderShowNo: activity.showNo,
      focusRefreshToken: String(Date.now()),
    },
  }).catch(() => undefined)
}

/**
 * 加载工作台统计数据：
 * - 请求后端聚合接口；
 * - 异常时通过统一消息提示反馈给用户。
 */
const loadData = async () => {
  if (loading.value) {
    return
  }

  loading.value = true
  await dashboardRequest.runLatest({
    executor: (signal) => getDashboardStats({ signal }),
    onSuccess: (result) => {
      stats.value = result
      loadStatus.value = 'success'
    },
    onError: (error) => {
      loadStatus.value = 'error'
      ElMessage.error(extractErrorMessage(error, '获取看板数据失败'))
    },
    onFinally: ({ status }) => {
      if (status === 'canceled' && !stats.value) {
        loadStatus.value = 'canceled'
      }

      loading.value = false
    },
  })
}

/**
 * 快捷入口跳转：
 * - 数据源由路由配置统一派生；
 * - 只保留页面层的跳转行为，不再维护额外配置。
 */
const navigateTo = (path: string) => {
  router.push(path)
}

/**
 * 工作台可见兜底：
 * - Dashboard 被 keep-alive 缓存后，首次请求若在离页时被取消，重新进入不会再次触发 onMounted；
 * - 因此在 mounted / activated 两个入口都补一次“无数据则拉取”，保证重复进入仍能恢复内容。
 */
const ensureDashboardReady = () => {
  if (!stats.value && !loading.value) {
    void loadData()
  }
}

/**
 * 工作台重试动作：
 * - 当首次请求失败或被取消时，允许用户在页面内直接恢复概览数据；
 * - 保留快捷入口可见，避免首页再次出现“看起来像空白”的断层感。
 */
const retryLoadData = () => {
  void loadData()
}

onMounted(() => {
  ensureDashboardReady()
})

onActivated(() => {
  ensureDashboardReady()
})
</script>

<template>
  <PageContainer title="工作台" description="查看今日出库概览，快速进入常用业务操作。">
    <div v-if="(loading && !stats) || loadStatus === 'idle'" class="dashboard-container min-w-0 space-y-5 sm:space-y-6 lg:space-y-7">
      <section
        :class="[
          'relative overflow-hidden rounded-2xl bg-gradient-to-r from-teal-500 via-teal-400 to-cyan-400 text-white shadow-sm',
          appStore.isPhone ? 'p-5' : 'p-6 sm:p-8 xl:p-9',
        ]"
      >
        <div class="relative z-10 max-w-2xl space-y-3">
          <div class="h-7 w-44 animate-pulse rounded-full bg-white/30" />
          <div class="h-4 w-full max-w-xl animate-pulse rounded-full bg-white/20" />
          <div class="h-4 w-3/4 max-w-lg animate-pulse rounded-full bg-white/20" />
        </div>
        <div
          class="pointer-events-none absolute right-0 top-0 translate-x-1/4 -translate-y-1/4 transform opacity-10"
          :class="appStore.isPhone ? 'hidden' : ''"
        >
          <el-icon :size="160"><DataAnalysis /></el-icon>
        </div>
      </section>

      <section class="space-y-4">
        <div class="h-6 w-28 animate-pulse rounded-full bg-slate-200 dark:bg-white/10" />
        <div :class="['grid gap-4', statsGridClass]">
          <div
            v-for="index in 4"
            :key="`stats-skeleton-${index}`"
            class="min-h-[112px] animate-pulse rounded-2xl bg-white/90 p-5 shadow-sm dark:bg-white/5"
          >
            <div class="mb-5 flex items-center justify-between">
              <div class="h-4 w-24 rounded-full bg-slate-200 dark:bg-white/10" />
              <div class="h-10 w-10 rounded-xl bg-slate-200 dark:bg-white/10" />
            </div>
            <div class="h-8 w-20 rounded-full bg-slate-200 dark:bg-white/10" />
          </div>
        </div>
      </section>

      <section class="space-y-4">
        <div class="h-6 w-24 animate-pulse rounded-full bg-slate-200 dark:bg-white/10" />
        <div class="flex flex-wrap gap-3">
          <div
            v-for="index in 4"
            :key="`shortcut-chip-skeleton-${index}`"
            class="h-10 w-[160px] animate-pulse rounded-xl bg-white/90 shadow-sm dark:bg-white/5"
          />
        </div>
      </section>

      <div :class="['grid gap-6 xl:gap-7', appStore.isDesktop ? 'xl:grid-cols-[1.3fr_1fr] lg:grid-cols-[1.2fr_1fr]' : 'grid-cols-1']">
        <section class="space-y-4">
          <div class="h-6 w-32 animate-pulse rounded-full bg-slate-200 dark:bg-white/10" />
          <div class="min-h-[300px] animate-pulse rounded-2xl bg-white/90 p-6 shadow-sm dark:bg-white/5" />
        </section>

        <section class="space-y-4">
          <div class="h-6 w-32 animate-pulse rounded-full bg-slate-200 dark:bg-white/10" />
          <div class="min-h-[300px] animate-pulse rounded-2xl bg-white/90 p-6 shadow-sm dark:bg-white/5" />
        </section>
      </div>

      <section class="space-y-4">
        <div class="h-6 w-24 animate-pulse rounded-full bg-slate-200 dark:bg-white/10" />
        <div class="min-h-[220px] animate-pulse rounded-2xl bg-white/90 p-6 shadow-sm dark:bg-white/5 sm:min-h-[260px]" />
      </section>
    </div>

    <div v-else class="dashboard-container min-w-0 space-y-5 sm:space-y-6 lg:space-y-7">
      <section
        :class="[
          'relative overflow-hidden rounded-2xl bg-gradient-to-r from-teal-500 via-teal-400 to-cyan-400 text-white shadow-sm',
          appStore.isPhone ? 'p-5' : 'p-6 sm:p-8 xl:p-9',
        ]"
      >
        <div class="relative z-10 max-w-2xl">
          <h1 :class="['mb-2 font-bold', appStore.isPhone ? 'text-xl' : 'text-2xl']">欢迎回来，开始高效的一天！</h1>
          <p class="text-sm leading-6 text-teal-50/90 sm:text-base">
            系统运行稳定，今日出库流程顺畅。您可以在下方快速查看核心指标与趋势变化。
          </p>

          <div
            v-if="!stats"
            class="mt-4 inline-flex max-w-xl items-start gap-3 rounded-2xl bg-white/14 px-4 py-3 text-left shadow-sm ring-1 ring-white/18 backdrop-blur-sm"
          >
            <div class="rounded-xl bg-white/16 p-2 text-white/95">
              <el-icon :size="18"><WarningFilled /></el-icon>
            </div>
            <div class="min-w-0 flex-1">
              <div class="text-sm font-semibold text-white">工作台概览暂不可用</div>
              <p class="mt-1 text-xs leading-5 text-teal-50/90">
                {{
                  loadStatus === 'error'
                    ? '统计数据加载失败，但您仍可继续使用高频入口进入业务页面。'
                    : '检测到上次进入时概览尚未准备完成，您仍可继续操作，并可手动恢复统计数据。'
                }}
              </p>
            </div>
            <button
              type="button"
              class="rounded-full bg-white/18 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-white/24"
              @click="retryLoadData"
            >
              重新加载
            </button>
          </div>
        </div>
        <div
          class="pointer-events-none absolute right-0 top-0 translate-x-1/4 -translate-y-1/4 transform opacity-10"
          :class="appStore.isPhone ? 'hidden' : ''"
        >
          <el-icon :size="160"><DataAnalysis /></el-icon>
        </div>
      </section>

      <section>
        <h2 class="mb-4 text-lg font-semibold text-slate-800 dark:text-slate-200">核心看板</h2>

        <transition-group name="staggered-fade" tag="div" :class="['grid gap-4 xl:gap-5', statsGridClass]" appear>
          <div
            v-for="metric in metricCards"
            :key="metric.key"
            class="apple-card-hover min-w-0 p-5 sm:p-6 xl:p-7"
            :style="{ transitionDelay: metric.delay }"
          >
            <div class="mb-4 flex items-center justify-between gap-3">
              <div class="text-sm font-medium text-slate-500 dark:text-slate-400">{{ metric.title }}</div>
              <div :class="['rounded-xl p-2', metric.iconBgClass, metric.iconTextClass]">
                <el-icon :size="20">
                  <component :is="metric.icon" />
                </el-icon>
              </div>
            </div>
            <div class="break-all text-3xl font-bold text-slate-800 dark:text-slate-100">
              <span v-if="metric.unit === '¥'" class="mr-1 text-xl font-normal text-slate-500 dark:text-slate-400">¥</span>
              {{ metric.value }}
              <span v-if="metric.unit !== '¥'" class="ml-1 text-sm font-normal text-slate-500 dark:text-slate-400">{{ metric.unit }}</span>
            </div>
          </div>
        </transition-group>
      </section>

      <section>
        <h2 class="mb-4 text-lg font-semibold text-slate-800 dark:text-slate-200">高频入口</h2>
        <div class="flex flex-wrap gap-3">
          <button
            v-for="action in compactShortcutItems"
            :key="action.path"
            type="button"
            class="apple-card-hover inline-flex min-h-[44px] min-w-[150px] items-center gap-2 rounded-xl px-4 text-sm font-medium text-slate-700 dark:text-slate-200"
            @click="navigateTo(action.path)"
          >
            <el-icon :size="16"><component :is="action.icon" /></el-icon>
            <span class="truncate">{{ action.title }}</span>
          </button>
          <button
            type="button"
            class="apple-card inline-flex min-h-[44px] min-w-[150px] items-center gap-2 rounded-xl border-dashed px-4 text-sm font-medium text-slate-500 dark:text-slate-400"
            @click="navigateTo('/order-list')"
          >
            <el-icon :size="16"><More /></el-icon>
            <span>更多入口见左侧导航</span>
          </button>
        </div>
      </section>

      <DashboardPieSection />

      <div :class="['grid gap-6 xl:gap-7', appStore.isDesktop ? 'xl:grid-cols-[1.3fr_1fr] lg:grid-cols-[1.2fr_1fr]' : 'grid-cols-1']">
        <section>
          <div class="apple-card p-5 sm:p-6 xl:p-7">
            <div class="mb-5 flex items-center justify-between">
              <h2 class="text-lg font-semibold text-slate-800 dark:text-slate-200">近 7 日出库趋势</h2>
              <div class="text-xs text-slate-500 dark:text-slate-400">
                峰值：<span class="font-semibold text-slate-700 dark:text-slate-200">¥{{ trendMaxAmount }}</span>
              </div>
            </div>

            <div v-if="trendPoints.length > 1" class="relative space-y-3" @mouseleave="clearActiveTrendPoint">
              <div
                v-if="activeTrendPoint"
                class="pointer-events-none absolute top-2 z-10 min-w-[190px] -translate-x-1/2 rounded-xl border border-slate-100 bg-white/96 px-3 py-2 text-xs shadow-md dark:border-white/10 dark:bg-slate-900/95"
                :style="activeTrendTooltipStyle"
              >
                <div class="mb-1 font-semibold text-slate-700 dark:text-slate-200">{{ activeTrendPoint.label }}</div>
                <div class="text-slate-600 dark:text-slate-300">出库单数：{{ activeTrendPoint.orderCount }} 单</div>
                <div class="text-slate-600 dark:text-slate-300">出库总额：¥{{ formatAmount(activeTrendPoint.amount) }}</div>
                <div class="text-slate-600 dark:text-slate-300">出库数量：{{ formatQty(activeTrendPoint.totalQty) }}</div>
              </div>

              <svg class="h-[260px] w-full" :viewBox="`0 0 ${TREND_VIEWBOX_WIDTH} ${TREND_VIEWBOX_HEIGHT}`" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="dashboardTrendAreaGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="rgba(20, 184, 166, 0.45)" />
                    <stop offset="100%" stop-color="rgba(20, 184, 166, 0.03)" />
                  </linearGradient>
                </defs>
                <line
                  :x1="TREND_PADDING_X"
                  :y1="TREND_VIEWBOX_HEIGHT - TREND_PADDING_Y"
                  :x2="TREND_VIEWBOX_WIDTH - TREND_PADDING_X"
                  :y2="TREND_VIEWBOX_HEIGHT - TREND_PADDING_Y"
                  stroke="rgba(148, 163, 184, 0.35)"
                  stroke-width="1"
                />
                <path :d="trendAreaPath" fill="url(#dashboardTrendAreaGradient)" />
                <path :d="trendPath" fill="none" stroke="rgb(13, 148, 136)" stroke-width="3" stroke-linecap="round" />

                <rect
                  v-for="segment in trendHoverSegments"
                  :key="`segment-${segment.date}`"
                  :x="segment.x"
                  y="0"
                  :width="segment.width"
                  :height="TREND_VIEWBOX_HEIGHT"
                  fill="transparent"
                  class="cursor-pointer"
                  @mouseenter="setActiveTrendPoint(segment.date)"
                />

                <circle
                  v-for="point in trendPoints"
                  :key="point.date"
                  :cx="point.x"
                  :cy="point.y"
                  r="4"
                  fill="white"
                  stroke="rgb(13, 148, 136)"
                  stroke-width="2"
                  class="cursor-pointer"
                  @mouseenter="setActiveTrendPoint(point.date)"
                />
              </svg>
              <div class="grid grid-cols-7 gap-2 text-center text-xs text-slate-500 dark:text-slate-400">
                <div v-for="point in trendPoints" :key="`label-${point.date}`">{{ point.label }}</div>
              </div>
            </div>

            <div v-else class="flex min-h-[260px] items-center justify-center rounded-xl bg-slate-50 text-slate-400 dark:bg-slate-900/40">
              <el-empty :image-size="72" description="暂无趋势数据" />
            </div>
          </div>
        </section>

        <section class="space-y-6">
          <TopProductRankCard :top-products="stats?.topProducts ?? []" />
          <TopCustomerRankCard :top-customers="stats?.topCustomers ?? []" />

          <div class="apple-card p-5 sm:p-6 xl:p-7">
            <h2 class="mb-4 text-lg font-semibold text-slate-800 dark:text-slate-200">近期出库动态</h2>
            <div v-if="recentActivities.length" class="space-y-2">
              <button
                v-for="activity in recentActivities"
                :key="activity.id"
                type="button"
                class="w-full rounded-lg border border-slate-100 bg-slate-50/70 px-2.5 py-2 text-left transition hover:border-brand/40 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-900/40 dark:hover:border-brand/40 dark:hover:bg-slate-900/55"
                @click="navigateToActivityOrder(activity)"
              >
                <div class="mb-1 flex items-center justify-between gap-2">
                  <div class="flex min-w-0 items-center gap-1.5">
                    <el-tag :type="resolveActivityTagType(activity.actionType)" size="small" effect="light" class="!px-1.5">
                      {{ activity.actionLabel }}
                    </el-tag>
                    <span class="truncate text-xs font-medium text-slate-700 dark:text-slate-200">
                      {{ activity.showNo }}
                    </span>
                  </div>
                  <span class="shrink-0 text-[11px] text-slate-500 dark:text-slate-400">
                    {{ formatActivityTime(activity.createdAt) }}
                  </span>
                </div>
                <div class="truncate text-[11px] leading-4 text-slate-600 dark:text-slate-300">
                  {{ activity.customerName }} ｜ {{ formatQty(activity.totalQty) }} 件 ｜ ¥{{ formatAmount(activity.totalAmount) }} ｜ {{ activity.actorDisplayName }}
                </div>
              </button>
            </div>
            <div v-else class="flex min-h-[160px] items-center justify-center">
              <el-empty :image-size="72" description="最近24小时暂无出库变更" />
            </div>
          </div>
        </section>
      </div>
    </div>
  </PageContainer>
</template>

<style scoped>
.staggered-fade-enter-active {
  transition: opacity 0.5s ease-out, transform 0.5s ease-out;
}

.staggered-fade-enter-from {
  opacity: 0;
  transform: translateY(20px);
}

.staggered-fade-enter-to {
  opacity: 1;
  transform: translateY(0);
}
</style>
