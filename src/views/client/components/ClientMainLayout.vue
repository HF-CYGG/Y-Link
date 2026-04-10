<script setup lang="ts">
/**
 * 模块说明：src/views/client/components/ClientMainLayout.vue
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */


import { computed, ref, watch } from 'vue'
import { useRoute, useRouter, type RouteLocationNormalizedLoaded } from 'vue-router'
import { ElMessageBox } from 'element-plus'
import { useClientAuthStore, useClientCartStore } from '@/store'

const route = useRoute()
const router = useRouter()
const clientAuthStore = useClientAuthStore()
const clientCartStore = useClientCartStore()

clientCartStore.initialize()
const transitionName = ref<'slide-left' | 'slide-right'>('slide-left')
const cartBadgeBouncing = ref(false)

const displayName = computed(() => {
  return clientAuthStore.currentUser?.realName || clientAuthStore.currentUser?.mobile || '访客'
})

const tabs = [
  { path: '/client/mall', label: '商城' },
  { path: '/client/orders', label: '订单' },
  { path: '/client/profile', label: '我的' },
]

const isTabActive = (path: string) => {
  if (path === '/client/orders') {
    return route.path.startsWith('/client/orders')
  }
  return route.path === path
}

const resolveViewKey = (currentRoute: RouteLocationNormalizedLoaded) => {
  if (currentRoute.meta.keepAlive && typeof currentRoute.name === 'string') {
    return currentRoute.name
  }
  return currentRoute.fullPath
}

const resolvePathDepth = (path: string) => {
  if (path.startsWith('/client/orders/')) {
    return 3
  }
  if (path.startsWith('/client/checkout')) {
    return 3
  }
  if (path.startsWith('/client/cart')) {
    return 2
  }
  if (path.startsWith('/client/orders')) {
    return 2
  }
  if (path.startsWith('/client/mall')) {
    return 2
  }
  if (path.startsWith('/client/profile')) {
    return 2
  }
  return 1
}

watch(
  () => route.fullPath,
  (nextPath, previousPath) => {
    const nextDepth = resolvePathDepth(nextPath)
    const previousDepth = resolvePathDepth(previousPath || '/client')
    transitionName.value = nextDepth >= previousDepth ? 'slide-left' : 'slide-right'
  },
  { immediate: true },
)

watch(
  () => clientCartStore.totalQty,
  (nextQty, previousQty) => {
    if (nextQty <= previousQty || nextQty <= 0) {
      return
    }
    cartBadgeBouncing.value = false
    globalThis.window.setTimeout(() => {
      cartBadgeBouncing.value = true
      globalThis.window.setTimeout(() => {
        cartBadgeBouncing.value = false
      }, 360)
    }, 16)
  },
)

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const handleLogout = async () => {
  try {
    await ElMessageBox.confirm('确认退出当前账号吗？', '退出登录', {
      type: 'warning',
      confirmButtonText: '退出',
      cancelButtonText: '取消',
    })
  } catch (_error) {
    return
  }

  await clientAuthStore.logout()
  clientCartStore.clearAll()
  await router.replace('/client/login')
}
</script>

<template>
  <div class="client-main-layout min-h-screen pb-24 text-slate-900">
    <header class="client-main-layout__header sticky top-0 z-30 border-b border-white/55 bg-white/80 backdrop-blur-xl">
      <div class="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-4 py-3">
        <div>
          <p class="text-xs font-semibold tracking-[0.16em] text-slate-400">Y-LINK CLIENT</p>
          <p class="text-base font-semibold text-slate-900">{{ displayName }}</p>
        </div>
        <button
          type="button"
          class="rounded-full border border-slate-200/90 bg-white/80 px-3 py-1.5 text-xs font-medium text-slate-600"
          @click="handleLogout"
        >
          退出
        </button>
      </div>
    </header>

    <main class="mx-auto w-full max-w-6xl px-4 pt-4">
      <router-view v-slot="{ Component, route: viewRoute }">
        <transition :name="transitionName" mode="out-in">
          <KeepAlive :max="3">
            <component :is="Component" v-if="Component && viewRoute.meta.keepAlive" :key="resolveViewKey(viewRoute)" />
          </KeepAlive>
        </transition>
        <transition :name="transitionName" mode="out-in">
          <component :is="Component" v-if="Component && !viewRoute.meta.keepAlive" :key="resolveViewKey(viewRoute)" />
        </transition>
      </router-view>
    </main>

    <nav class="client-main-layout__tab fixed bottom-3 left-1/2 z-30 w-[min(640px,calc(100vw-1.5rem))] -translate-x-1/2 rounded-[1.5rem] border border-white/60 bg-white/85 px-2 py-2 backdrop-blur-2xl">
      <div class="grid grid-cols-4 gap-1">
        <router-link
          v-for="tab in tabs"
          :key="tab.path"
          :to="tab.path"
          class="client-main-layout__tab-item"
          :class="isTabActive(tab.path) ? 'is-active' : ''"
        >
          {{ tab.label }}
        </router-link>
        <router-link to="/client/cart" class="client-main-layout__tab-item" :class="route.path === '/client/cart' ? 'is-active' : ''">
          购物车
          <span
            v-if="clientCartStore.totalQty > 0"
            class="client-main-layout__cart-badge ml-1 inline-flex min-w-5 items-center justify-center rounded-full bg-rose-500 px-1.5 text-[10px] leading-5 text-white"
            :class="cartBadgeBouncing ? 'is-bouncing' : ''"
          >
            {{ clientCartStore.totalQty }}
          </span>
        </router-link>
      </div>
    </nav>
  </div>
</template>

<style scoped>
.client-main-layout {
  background:
    radial-gradient(circle at top, rgba(45, 212, 191, 0.12), transparent 30%),
    radial-gradient(circle at bottom right, rgba(15, 23, 42, 0.08), transparent 24%),
    var(--ylink-color-bg);
}

.client-main-layout__tab {
  box-shadow: var(--ylink-shadow-floating);
}

.client-main-layout__tab-item {
  display: inline-flex;
  min-height: 44px;
  align-items: center;
  justify-content: center;
  border-radius: 0.9rem;
  color: #64748b;
  font-size: 0.87rem;
  font-weight: 600;
}

.client-main-layout__tab-item.is-active {
  background: rgba(15, 23, 42, 0.92);
  color: #ffffff;
}

.client-main-layout__cart-badge.is-bouncing {
  animation: cart-badge-bounce 0.36s ease;
}

@keyframes cart-badge-bounce {
  0% {
    transform: scale(1);
  }
  45% {
    transform: scale(1.22);
  }
  100% {
    transform: scale(1);
  }
}
</style>
