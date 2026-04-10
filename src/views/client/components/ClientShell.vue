<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useClientAuthStore } from '@/store'

interface Props {
  title: string
  subtitle?: string
}

const props = defineProps<Props>()

const router = useRouter()
const clientAuthStore = useClientAuthStore()

/**
 * 顶部展示名称：
 * - 优先显示真实姓名，保证客户端更像面向最终用户的产品；
 * - 若姓名为空则退回手机号，避免出现空标题。
 */
const displayName = computed(() => {
  return clientAuthStore.currentUser?.realName || clientAuthStore.currentUser?.mobile || '未登录用户'
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
  } catch (_error) {
    return
  }

  await clientAuthStore.logout()
  ElMessage.success('已退出登录')
  await router.replace('/client/login')
}
</script>

<template>
  <div class="min-h-screen bg-slate-50 text-slate-900">
    <header class="sticky top-0 z-20 border-b border-white/60 bg-white/90 backdrop-blur">
      <div class="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
        <div>
          <p class="text-lg font-semibold text-slate-900">{{ props.title }}</p>
          <p v-if="props.subtitle" class="text-sm text-slate-500">{{ props.subtitle }}</p>
        </div>

        <div class="flex items-center gap-2">
          <router-link
            to="/client/mall"
            class="rounded-full px-3 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
          >
            商品大厅
          </router-link>
          <router-link
            to="/client/orders"
            class="rounded-full px-3 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
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
      <div class="mb-4 rounded-3xl bg-gradient-to-r from-brand to-cyan-400 px-5 py-4 text-white shadow-sm">
        <p class="text-sm/6 opacity-90">当前登录</p>
        <div class="mt-1 flex flex-wrap items-center gap-3">
          <span class="text-xl font-semibold">{{ displayName }}</span>
          <span class="rounded-full bg-white/20 px-3 py-1 text-sm">
            {{ clientAuthStore.currentUser?.departmentName || '未设置部门' }}
          </span>
        </div>
      </div>

      <slot />
    </main>
  </div>
</template>
