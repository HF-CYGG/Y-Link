<script setup lang="ts">
/**
 * 模块说明：src/views/client/ClientProfileView.vue
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */


import { useClientAuthStore } from '@/store'

const clientAuthStore = useClientAuthStore()
</script>

<template>
  <section class="space-y-4 pb-20">
    <div class="rounded-[1.4rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
      <p class="text-xl font-semibold text-slate-900">我的</p>
      <p class="mt-1 text-sm text-slate-500">查看账号信息与取货相关资料</p>
    </div>

    <div class="rounded-[1.2rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
      <p class="text-xs text-slate-400">姓名</p>
      <p class="mt-1 text-base font-semibold text-slate-900">{{ clientAuthStore.currentUser?.realName || '-' }}</p>

      <p class="mt-4 text-xs text-slate-400">手机号</p>
      <p class="mt-1 text-base font-semibold text-slate-900">{{ clientAuthStore.currentUser?.mobile || '-' }}</p>

      <p class="mt-4 text-xs text-slate-400">部门</p>
      <p class="mt-1 text-base font-semibold text-slate-900">{{ clientAuthStore.currentUser?.departmentName || '未设置' }}</p>
    </div>
  </section>
</template>
