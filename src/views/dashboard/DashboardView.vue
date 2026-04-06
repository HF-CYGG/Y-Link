<script setup lang="ts">
import { computed, onActivated, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
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

/**
 * 当前用户可见快捷入口：
 * - 由路由配置与权限点共同派生；
 * - 当前用户只会看到自己具备权限的业务与治理入口。
 */
const shortcutItems = computed(() => buildDashboardShortcutItems(authStore.currentUser))
/**
 * 顶部横幅信息项：
 * - 在宽屏下补充轻量关键信息，提升首页首屏信息密度；
 * - 手机端自动换行为双列，不破坏阅读节奏；
 * - 当统计尚未准备完成时回落为占位符，避免布局跳变。
 */
const heroMetaItems = computed(() => [
  { label: '今日单据', value: `${stats.value?.todayOrderCount ?? '--'} 单` },
  { label: '今日金额', value: `¥${Number(stats.value?.todayOrderAmount ?? 0).toFixed(2)}` },
  { label: '在库产品', value: `${stats.value?.totalProductCount ?? '--'} 种` },
])

/**
 * 卡片网格策略：
 * - phone 使用单列，避免数值卡片过窄；
 * - tablet 使用双列；
 * - desktop 使用三列完整展示。
 */
const statsGridClass = computed(() => {
  if (appStore.isDesktop) {
    return 'xl:grid-cols-3 lg:grid-cols-3'
  }

  if (appStore.isTablet) {
    return 'sm:grid-cols-2'
  }

  return 'grid-cols-1'
})

/**
 * 快捷入口网格策略：
 * - phone 改为单列，点击区域更大；
 * - tablet 维持双列；
 * - desktop 提升为三列，提高宽屏首屏利用率。
 */
const shortcutGridClass = computed(() => {
  if (appStore.isDesktop) {
    return 'xl:grid-cols-3 lg:grid-cols-3'
  }

  if (appStore.isTablet) {
    return 'sm:grid-cols-2'
  }

  return 'grid-cols-1'
})

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
  if (stats.value || loading.value) {
    return
  }

  void loadData()
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
          <div class="grid grid-cols-1 gap-2 pt-2 sm:grid-cols-3">
            <div v-for="index in 3" :key="`hero-meta-skeleton-${index}`" class="h-14 rounded-xl bg-white/18" />
          </div>
        </div>
        <div
          class="pointer-events-none absolute right-0 top-0 translate-x-1/4 -translate-y-1/4 transform opacity-10"
          :class="appStore.isPhone ? 'hidden' : ''"
        >
          <el-icon :size="160"><DataAnalysis /></el-icon>
        </div>
      </section>

      <section class="space-y-4">
        <div class="h-6 w-24 animate-pulse rounded-full bg-slate-200 dark:bg-white/10" />
        <div :class="['grid gap-4', statsGridClass]">
          <div
            v-for="index in 3"
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

      <div :class="['grid gap-6 xl:gap-7', appStore.isDesktop ? 'xl:grid-cols-[1.45fr_1fr] lg:grid-cols-[1.2fr_0.9fr]' : 'grid-cols-1']">
        <section class="space-y-4">
          <div class="h-6 w-24 animate-pulse rounded-full bg-slate-200 dark:bg-white/10" />
          <div :class="['grid gap-4', shortcutGridClass]">
            <div
              v-for="index in 4"
              :key="`shortcut-skeleton-${index}`"
              :class="[
                'animate-pulse rounded-2xl bg-white/90 px-4 shadow-sm dark:bg-white/5',
                appStore.isPhone ? 'min-h-[128px] py-5' : 'min-h-[168px] py-6',
              ]"
            >
              <div class="mx-auto mb-4 h-14 w-14 rounded-2xl bg-slate-200 dark:bg-white/10" />
              <div class="mx-auto h-4 w-24 rounded-full bg-slate-200 dark:bg-white/10" />
              <div class="mx-auto mt-3 h-3 w-32 rounded-full bg-slate-200 dark:bg-white/10" />
            </div>
          </div>
        </section>

        <section class="space-y-4">
          <div class="h-6 w-24 animate-pulse rounded-full bg-slate-200 dark:bg-white/10" />
          <div class="min-h-[220px] animate-pulse rounded-2xl bg-white/90 p-6 shadow-sm dark:bg-white/5 sm:min-h-[260px]" />
        </section>
      </div>
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
            在这里您可以快速查看今日出库数据并进行快捷操作。
          </p>
          <div class="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div
              v-for="item in heroMetaItems"
              :key="item.label"
              class="rounded-xl border border-white/20 bg-white/12 px-3 py-2.5 backdrop-blur-sm"
            >
              <div class="text-[11px] tracking-wide text-teal-50/80">{{ item.label }}</div>
              <div class="mt-1 text-sm font-semibold text-white">{{ item.value }}</div>
            </div>
          </div>

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
                    ? '统计数据加载失败，但您仍可继续使用快捷入口进入业务页面。'
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
        <h2 class="mb-4 text-lg font-semibold text-slate-800 dark:text-slate-200">今日数据</h2>

        <transition-group name="staggered-fade" tag="div" :class="['grid gap-4 xl:gap-5', statsGridClass]" appear>
          <div key="card-1" class="apple-card-hover min-w-0 p-5 sm:p-6 xl:p-7" style="transition-delay: 0ms">
            <div class="mb-4 flex items-center justify-between gap-3">
              <div class="text-sm font-medium text-slate-500 dark:text-slate-400">今日出库单数</div>
              <div class="rounded-xl bg-brand/10 p-2 text-brand dark:bg-brand/20 dark:text-teal-400">
                <el-icon :size="20"><Document /></el-icon>
              </div>
            </div>
            <div class="text-3xl font-bold text-slate-800 dark:text-slate-100">
              {{ stats?.todayOrderCount || 0 }}
              <span class="ml-1 text-sm font-normal text-slate-500 dark:text-slate-400">单</span>
            </div>
          </div>

          <div key="card-2" class="apple-card-hover min-w-0 p-5 sm:p-6 xl:p-7" style="transition-delay: 100ms">
            <div class="mb-4 flex items-center justify-between gap-3">
              <div class="text-sm font-medium text-slate-500 dark:text-slate-400">今日出库金额</div>
              <div class="rounded-xl bg-secondary/10 p-2 text-secondary dark:bg-secondary/20 dark:text-slate-300">
                <el-icon :size="20"><Money /></el-icon>
              </div>
            </div>
            <div class="break-all text-3xl font-bold text-slate-800 dark:text-slate-100">
              <span class="mr-1 text-xl font-normal text-slate-500 dark:text-slate-400">¥</span>
              {{ Number(stats?.todayOrderAmount || 0).toFixed(2) }}
            </div>
          </div>

          <div key="card-3" class="apple-card-hover min-w-0 p-5 sm:p-6 xl:p-7" style="transition-delay: 200ms">
            <div class="mb-4 flex items-center justify-between gap-3">
              <div class="text-sm font-medium text-slate-500 dark:text-slate-400">在库产品总数</div>
              <div class="rounded-xl bg-brand/10 p-2 text-brand dark:bg-brand/20 dark:text-teal-400">
                <el-icon :size="20"><Box /></el-icon>
              </div>
            </div>
            <div class="text-3xl font-bold text-slate-800 dark:text-slate-100">
              {{ stats?.totalProductCount || 0 }}
              <span class="ml-1 text-sm font-normal text-slate-500 dark:text-slate-400">种</span>
            </div>
          </div>
        </transition-group>
      </section>

      <div :class="['grid gap-6 xl:gap-7', appStore.isDesktop ? 'xl:grid-cols-[1.45fr_1fr] lg:grid-cols-[1.2fr_0.9fr]' : 'grid-cols-1']">
        <section>
          <h2 class="mb-4 text-lg font-semibold text-slate-800 dark:text-slate-200">快捷操作</h2>
          <div :class="['grid gap-4 xl:gap-5', shortcutGridClass]">
            <button
              v-for="action in shortcutItems"
              :key="action.path"
              type="button"
              :class="[
                'apple-card-hover group flex min-w-0 cursor-pointer flex-col items-center justify-center gap-3 px-4 text-center xl:px-5',
                appStore.isPhone ? 'min-h-[128px] py-5' : 'min-h-[168px] py-6 xl:min-h-[176px]',
              ]"
              @click="navigateTo(action.path)"
            >
              <div :class="['rounded-2xl p-4 transition-colors duration-300', action.bgClass, action.colorClass]">
                <el-icon :size="28">
                  <component :is="action.icon" />
                </el-icon>
              </div>
              <span class="text-sm font-medium text-slate-700 transition-colors duration-300 group-hover:text-teal-600 dark:text-slate-300 dark:group-hover:text-teal-400">
                {{ action.title }}
              </span>
              <span class="text-xs leading-5 text-slate-500 dark:text-slate-400">
                {{ action.description }}
              </span>
            </button>

            <div
              :class="[
                'apple-card flex min-w-0 flex-col items-center justify-center gap-3 border-dashed p-6 opacity-50 xl:p-7',
                appStore.isPhone ? 'min-h-[128px]' : 'min-h-[168px] xl:min-h-[176px]',
              ]"
            >
              <div class="rounded-2xl bg-slate-100 p-4 text-slate-400 dark:bg-slate-800">
                <el-icon :size="28"><More /></el-icon>
              </div>
              <span class="text-sm font-medium text-slate-500 dark:text-slate-400">更多功能期待中...</span>
            </div>
          </div>
        </section>

        <section>
          <h2 class="mb-4 text-lg font-semibold text-slate-800 dark:text-slate-200">近期动态</h2>
          <div class="apple-card flex min-h-[220px] items-center justify-center p-6 xl:p-7 sm:min-h-[260px] xl:min-h-[100%]">
            <el-empty :image-size="80" description="暂无最新动态" />
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
