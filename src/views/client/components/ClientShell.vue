<script setup lang="ts">
/**
 * 模块说明：src/views/client/components/ClientShell.vue
 * 文件职责：客户端壳层头部，负责展示当前账号信息并提供统一退出登录入口。
 * 实现逻辑：
 * - 退出时先由客户端鉴权 Store 统一清理登录态及与账号相关的订单缓存；
 * - 再通过硬跳转回登录页，彻底卸载旧页面树，降低残留旧数据或白屏的风险。
 * 维护说明：若后续新增更多“与当前账号强绑定”的本地状态，应优先挂到退出链路统一清理。
 */


import { computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useClientAuthStore } from '@/store'
import { redirectToClientLogin } from '@/utils/client-auth-navigation'
import { normalizeRequestError } from '@/utils/error'

interface Props {
  title: string
  subtitle?: string
}

const props = defineProps<Props>()

const clientAuthStore = useClientAuthStore()

/**
 * 顶部展示名称：
 * - 当前客户端账号体系以“用户名”作为主展示字段，优先展示 account；
 * - 若旧缓存尚未补齐 account，则回退到 realName / mobile，避免出现空标题。
 */
const displayName = computed(() => {
  return clientAuthStore.currentUser?.account || clientAuthStore.currentUser?.realName || clientAuthStore.currentUser?.mobile || '未登录用户'
})

/**
 * 退出客户端账号：
 * - 二次确认可避免在移动端误触；
 * - 成功后回到客户端登录页，形成清晰闭环。
 */
const handleLogout = async () => {
  try {
    await ElMessageBox.confirm('确认退出当前客户端账号吗？', '退出登录', {
      type: 'warning',
      confirmButtonText: '退出',
      cancelButtonText: '取消',
    })
  } catch (error) {
    const normalizedError = normalizeRequestError(error, '退出已取消')
    if (normalizedError.message === 'cancel' || normalizedError.message === 'close') {
      return
    }
    return
  }

  await clientAuthStore.logout()
  ElMessage.success('已退出登录')
  // 退出后使用硬跳转重建页面，避免旧壳层在极端情况下残留成白屏。
  redirectToClientLogin()
}
</script>

<template>
  <div class="client-shell min-h-[100dvh] text-slate-900">
    <header class="sticky top-0 z-20 border-b border-white/60 bg-white/80 backdrop-blur-xl">
      <div class="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
        <div>
          <p class="text-xs font-semibold tracking-[0.18em] text-slate-400">Y-LINK CLIENT</p>
          <p class="mt-1 break-words text-lg font-semibold text-slate-900">{{ props.title }}</p>
          <p v-if="props.subtitle" class="break-words text-sm text-slate-500">{{ props.subtitle }}</p>
        </div>

        <div class="flex flex-wrap items-center justify-end gap-2">
          <router-link
            to="/client/mall"
            class="rounded-full px-3 py-2 text-sm font-medium text-slate-600 transition hover:bg-white/80 hover:text-slate-900"
          >
            商品大厅
          </router-link>
          <router-link
            to="/client/orders"
            class="rounded-full px-3 py-2 text-sm font-medium text-slate-600 transition hover:bg-white/80 hover:text-slate-900"
          >
            我的订单
          </router-link>
          <button
            type="button"
            class="rounded-full bg-slate-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-slate-700"
            @click="handleLogout"
          >
            退出
          </button>
        </div>
      </div>
    </header>

    <main class="mx-auto max-w-6xl px-4 py-5">
      <div class="client-shell-hero mb-4 rounded-[2rem] px-5 py-5 text-white shadow-sm">
        <div class="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p class="text-sm/6 opacity-90">当前登录</p>
            <div class="mt-1 flex flex-wrap items-center gap-3">
              <span class="text-2xl font-semibold">{{ displayName }}</span>
              <span class="rounded-full bg-white/20 px-3 py-1 text-sm">
                {{ clientAuthStore.currentUser?.departmentName || '未设置部门' }}
              </span>
            </div>
            <p class="mt-3 max-w-2xl text-sm leading-7 text-white/80">
              在线查看库存、快速提交预订单，到店后出示二维码即可完成核销。
            </p>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <router-link to="/client/mall" class="client-shell-chip">
              <span class="text-xs text-white/70">进入</span>
              <span class="mt-1 text-base font-semibold text-white">商品大厅</span>
            </router-link>
            <router-link to="/client/orders" class="client-shell-chip">
              <span class="text-xs text-white/70">查看</span>
              <span class="mt-1 text-base font-semibold text-white">我的订单</span>
            </router-link>
          </div>
        </div>
      </div>

      <slot />
    </main>
  </div>
</template>

<style scoped>
.client-shell {
  background:
    radial-gradient(circle at top, rgba(44, 196, 196, 0.14), transparent 30%),
    radial-gradient(circle at bottom right, rgba(15, 23, 42, 0.08), transparent 24%),
    linear-gradient(180deg, #f8fbfd 0%, #eef4f7 100%);
}

.client-shell-hero {
  background:
    linear-gradient(135deg, rgba(15, 23, 42, 0.92), rgba(13, 148, 136, 0.88)),
    linear-gradient(135deg, rgba(255, 255, 255, 0.08), rgba(255, 255, 255, 0));
  box-shadow: 0 20px 60px rgba(15, 23, 42, 0.12);
}

.client-shell-chip {
  display: block;
  min-width: 9rem;
  border-radius: 1.35rem;
  background: rgba(255, 255, 255, 0.12);
  padding: 0.9rem 1rem;
  backdrop-filter: blur(12px);
}
</style>
