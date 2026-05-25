<!--
  模块说明：F:/Y-Link/src/views/not-found/NotFoundView.vue
  文件职责：404 页面。
  实现逻辑：处理未知路由访问并提供返回入口。
  维护说明：导航策略调整需与路由守卫保持一致。
-->

<script setup lang="ts">
import { useRouter } from 'vue-router'
import { resolveDefaultManagementRedirect } from '@/router'
import { useAuthStore } from '@/store'
import pinia from '@/store/pinia'

const router = useRouter()
const authStore = useAuthStore(pinia)

/**
 * 返回首页动作：
 * - 404 场景下统一回到工作台；
 * - 使用 replace 避免无效路径继续留在历史栈中。
 */
const goHome = () => {
  void router.replace(resolveDefaultManagementRedirect(authStore.currentUser))
}
</script>

<template>
  <div class="flex min-h-[100dvh] items-center justify-center bg-[#eff1f5] px-4 dark:bg-[#0a0a0b]">
    <div class="apple-card max-w-md p-8 text-center">
      <p class="text-sm font-semibold uppercase tracking-[0.2em] text-brand dark:text-teal-300">Not Found</p>
      <h1 class="mt-3 text-4xl font-semibold text-slate-800 dark:text-slate-100">404</h1>
      <p class="mt-3 text-sm leading-6 text-slate-500 dark:text-slate-400">
        抱歉，当前页面不存在或已被迁移，请返回首页继续操作。
      </p>
      <el-button class="mt-6" type="primary" @click="goHome">返回首页</el-button>
    </div>
  </div>
</template>
