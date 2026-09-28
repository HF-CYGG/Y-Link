<script setup lang="ts">
/**
 * 模块说明：src/views/inventory/InventoryOverviewView.vue
 * 文件职责：为库存查询、扫码作业和盘点提供统一入口，保证仅有单项库存权限的账号也能从菜单进入授权页面。
 * 实现逻辑：入口卡片从库存子路由及其权限元信息派生；当前库存与盘点页保留隐藏菜单状态，但授权用户可在此进入。
 * 维护说明：新增库存入口时先维护路由权限，再纳入 buildInventoryEntryItems，避免卡片指向无权限页面。
 */

import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { PageContainer } from '@/components/common'
import { buildInventoryEntryItems } from '@/router/routes'
import { useAuthStore } from '@/store'
import pinia from '@/store/pinia'

const router = useRouter()
const authStore = useAuthStore(pinia)

const entryDescriptions: Record<string, string> = {
  '/inventory/scan': '扫码办理入库、出库和库存调整。',
  '/inventory/stocks': '按商品规格查询当前库存。',
  '/inventory/stocktakes': '查看盘点单并进入盘点作业。',
  '/inventory/docs': '查看库存单据及处理记录。',
  '/inventory/logs': '追溯每次库存变动。',
}

const entries = computed(() => buildInventoryEntryItems(authStore.currentUser))
</script>

<template>
  <PageContainer title="库存管理" description="选择当前账号可使用的库存功能。">
    <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      <section
        v-for="entry in entries"
        :key="entry.path"
        class="flex min-w-0 flex-col rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800"
      >
        <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">{{ entry.title }}</h2>
        <p class="mt-2 flex-1 text-sm leading-6 text-slate-500 dark:text-slate-400">
          {{ entryDescriptions[entry.path] }}
        </p>
        <el-button type="primary" class="mt-5 self-start" @click="router.push(entry.path)">
          进入{{ entry.title }}
        </el-button>
      </section>
    </div>
  </PageContainer>
</template>
