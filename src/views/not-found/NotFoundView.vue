<script setup lang="ts">
/**
 * 模块说明：src/views/not-found/NotFoundView.vue
 * 文件职责：承接管理端路由未命中的兜底页面，并根据当前登录状态给出返回首页或重新登录入口。
 * 实现逻辑：
 * - 页面本身只负责展示错误状态与回跳动作，不在这里重复实现权限判断；
 * - 真正的默认跳转目标继续复用路由层的共享解析逻辑，保证 404 返回路径与系统首页口径一致。
 * 维护说明：
 * - 若后续管理端默认首页发生调整，应优先修改共享重定向方法，而不是只在本页硬编码跳转地址；
 * - 404 页面文案必须保持终端用户语境，不能泄露内部路由名或系统提示标签。
 */


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
const goHome = async () => {
  await router.replace(resolveDefaultManagementRedirect(authStore.currentUser))
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
