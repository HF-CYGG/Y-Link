<script setup lang="ts">
import { computed } from 'vue'
import type { RouteLocationNormalizedLoaded } from 'vue-router'
import AppHeader from '@/layout/components/AppHeader.vue'
import AppSidebar from '@/layout/components/AppSidebar.vue'
import { useDevice } from '@/composables/useDevice'
import { buildAppMenuItems } from '@/router/routes'
import { useAppStore, useAuthStore } from '@/store'

/**
 * 初始化设备监听：
 * - AppLayout 作为全局壳层入口，负责在应用启动后立即同步设备模式；
 * - 其余页面直接读取 store，即可获得统一设备状态。
 */
useDevice()

/**
 * 全局应用状态：
 * - appStore 负责页面级加载条与布局间距；
 * - authStore 负责根据当前角色派生菜单与登录过渡蒙层。
 */
const appStore = useAppStore()
const authStore = useAuthStore()

/**
 * 当前用户可见菜单：
 * - 由路由配置按权限点实时派生；
 * - 确保当前账号只看到自己具备权限的菜单入口。
 */
const menuItems = computed(() => buildAppMenuItems(authStore.currentUser))

/**
 * 主内容区边距策略：
 * - desktop 保留较大留白，维持管理后台信息密度；
 * - tablet 收紧边距，提升中等宽度利用率；
 * - phone 使用最小安全边距，保证主内容完整可见。
 */
const mainPaddingClass = computed(() => {
  if (appStore.isDesktop) {
    return 'px-4 py-4'
  }

  if (appStore.isTablet) {
    return 'px-3 py-3'
  }

  return 'px-2.5 py-2.5'
})

/**
 * 路由缓存键：
 * - keep-alive 页面优先按命名路由缓存，保证返回时直接复用原组件实例与筛选状态；
 * - 非缓存页面保留 fullPath 级粒度，避免不同查询串互相串状态。
 */
const resolveViewKey = (route: RouteLocationNormalizedLoaded) => {
  if (route.meta.keepAlive && typeof route.name === 'string') {
    return route.name
  }

  return route.fullPath
}
</script>

<template>
  <div class="flex h-[100dvh] w-full overflow-hidden bg-[#eff1f5] dark:bg-[#0a0a0b]">
    <AppSidebar :menu-items="menuItems" />

    <div class="relative flex min-w-0 flex-1 flex-col overflow-hidden">
      <AppHeader class="z-20" />

      <div v-if="appStore.isGlobalLoading" class="absolute left-0 top-16 z-30 h-1 w-full bg-brand/20">
        <div class="h-full w-1/3 animate-pulse bg-brand" />
      </div>

      <transition name="system-entry-fade">
        <div
          v-if="authStore.enteringSystem"
          class="absolute inset-0 z-40 flex items-center justify-center bg-slate-950/20 backdrop-blur-[2px]"
        >
          <div class="rounded-2xl border border-white/70 bg-white/92 px-7 py-6 shadow-2xl dark:border-white/10 dark:bg-[#141415]/92">
            <div class="text-sm font-semibold text-slate-800 dark:text-slate-100">正在进入主系统</div>
            <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">先加载壳层，再平滑呈现业务数据</div>
            <div class="mt-4 flex gap-2">
              <span class="h-1.5 w-10 animate-pulse rounded-full bg-brand/85" />
              <span class="h-1.5 w-6 animate-pulse rounded-full bg-brand/45 [animation-delay:120ms]" />
              <span class="h-1.5 w-3 animate-pulse rounded-full bg-brand/30 [animation-delay:220ms]" />
            </div>
          </div>
        </div>
      </transition>

      <main :class="['relative flex-1 overflow-y-auto overflow-x-hidden', mainPaddingClass]">
        <router-view v-slot="{ Component, route }">
          <Suspense timeout="120">
            <template #default>
              <div class="min-h-full">
                <transition name="fade-slide" mode="out-in">
                  <KeepAlive :max="8">
                    <component
                      :is="Component"
                      v-if="Component && route.meta.keepAlive"
                      :key="resolveViewKey(route)"
                    />
                  </KeepAlive>
                </transition>

                <transition name="fade-slide" mode="out-in">
                  <component
                    :is="Component"
                    v-if="Component && !route.meta.keepAlive"
                    :key="resolveViewKey(route)"
                  />
                </transition>
              </div>
            </template>

            <template #fallback>
              <div class="route-loading-shell min-h-full rounded-[28px] border border-slate-200/70 bg-white/92 p-5 shadow-sm dark:border-white/10 dark:bg-[#111214]/94">
                <div class="route-loading-shell__heading">
                  <span class="route-loading-shell__title" />
                  <span class="route-loading-shell__subtitle" />
                </div>
                <div class="route-loading-shell__hero" />
                <div class="route-loading-shell__card-grid">
                  <span v-for="index in 3" :key="`hero-card-${index}`" class="route-loading-shell__card" />
                </div>
                <div class="route-loading-shell__table">
                  <span
                    v-for="index in 6"
                    :key="`table-row-${index}`"
                    class="route-loading-shell__table-row"
                  />
                </div>
              </div>
            </template>
          </Suspense>
        </router-view>
      </main>
    </div>
  </div>
</template>

<style scoped>
.system-entry-fade-enter-active,
.system-entry-fade-leave-active {
  transition: opacity 0.22s ease;
}

.system-entry-fade-enter-from,
.system-entry-fade-leave-to {
  opacity: 0;
}

.route-loading-shell {
  display: grid;
  gap: 1rem;
}

.route-loading-shell__heading {
  display: grid;
  gap: 0.75rem;
}

.route-loading-shell__title,
.route-loading-shell__subtitle,
.route-loading-shell__hero,
.route-loading-shell__card,
.route-loading-shell__table-row {
  position: relative;
  overflow: hidden;
  border-radius: 1.25rem;
  background: rgba(148, 163, 184, 0.12);
}

.route-loading-shell__title {
  height: 1.4rem;
  width: min(14rem, 42%);
}

.route-loading-shell__subtitle {
  height: 0.95rem;
  width: min(20rem, 62%);
}

.dark .route-loading-shell__title,
.dark .route-loading-shell__subtitle,
.dark .route-loading-shell__hero,
.dark .route-loading-shell__card,
.dark .route-loading-shell__table-row {
  background: rgba(255, 255, 255, 0.08);
}

.route-loading-shell__title::after,
.route-loading-shell__subtitle::after,
.route-loading-shell__hero::after,
.route-loading-shell__card::after,
.route-loading-shell__table-row::after {
  content: '';
  position: absolute;
  inset: 0;
  transform: translateX(-100%);
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.46), transparent);
  animation: route-loading-shimmer 1.2s ease-in-out infinite;
}

.route-loading-shell__hero {
  min-height: 132px;
}

.route-loading-shell__card-grid {
  display: grid;
  gap: 1rem;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
}

.route-loading-shell__card {
  min-height: 108px;
}

.route-loading-shell__table {
  display: grid;
  gap: 0.75rem;
}

.route-loading-shell__table-row {
  min-height: 64px;
}

@keyframes route-loading-shimmer {
  100% {
    transform: translateX(100%);
  }
}
</style>
