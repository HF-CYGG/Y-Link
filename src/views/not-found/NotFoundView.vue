<script setup lang="ts">
import { useRouter } from 'vue-router'

const router = useRouter()

/**
 * 返回首页动作：
 * - 404 场景下统一回到工作台；
 * - 使用 replace 避免无效路径继续留在历史栈中。
 */
const goHome = () => {
  void router.replace('/dashboard')
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-[#eff1f5] px-4 dark:bg-[#0a0a0b]">
    <div class="apple-card max-w-md p-8 text-center">
      <p class="text-sm font-semibold uppercase tracking-[0.2em] text-brand dark:text-teal-300">Not Found</p>
      <h1 class="mt-3 text-4xl font-semibold text-slate-800 dark:text-slate-100">404</h1>
      <p class="mt-3 text-sm leading-6 text-slate-500 dark:text-slate-400">
        抱歉，当前页面不存在或已被迁移，请返回工作台继续操作。
      </p>
      <el-button class="mt-6" type="primary" @click="goHome">返回工作台</el-button>
    </div>
  </div>
</template>
