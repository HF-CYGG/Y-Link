<script setup lang="ts">
/**
 * 模块说明：src/views/client/ClientCartView.vue
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */


import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useClientCartStore } from '@/store'

const router = useRouter()
const clientCartStore = useClientCartStore()

onMounted(() => {
  clientCartStore.initialize()
})

const selectedCount = computed(() => clientCartStore.selectedValidItems.length)

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const removeSelected = () => {
  if (!selectedCount.value) {
    ElMessage.warning('请先选择商品')
    return
  }
  clientCartStore.clearSelectedItems()
  ElMessage.success('已删除选中商品')
}

const goCheckout = async () => {
  if (!clientCartStore.selectedValidItems.length) {
    ElMessage.warning('请选择至少一件可结算商品')
    return
  }
  await router.push('/client/checkout')
}
</script>

<template>
  <section class="space-y-4 pb-24">
    <div class="rounded-[1.4rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
      <p class="text-xl font-semibold text-slate-900">购物车</p>
      <p class="mt-1 text-sm text-slate-500">支持全选、批量删除与失效商品分组</p>
    </div>

    <div v-if="!clientCartStore.items.length" class="rounded-[1.4rem] bg-white p-10 text-center text-sm text-slate-400 shadow-[var(--ylink-shadow-soft)]">
      购物车为空，去商城挑选商品吧
      <div class="mt-4">
        <router-link to="/client/mall" class="rounded-full bg-slate-900 px-4 py-2 text-xs text-white">去逛逛</router-link>
      </div>
    </div>

    <section v-else class="space-y-4">
      <div class="rounded-[1.2rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
        <div class="mb-3 flex items-center justify-between">
          <label class="inline-flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              :checked="clientCartStore.allValidSelected"
              @change="clientCartStore.toggleAllValidSelected(($event.target as HTMLInputElement).checked)"
            />
            全选有效商品
          </label>
          <button type="button" class="text-xs text-rose-500" @click="removeSelected">批量删除</button>
        </div>

        <article
          v-for="item in clientCartStore.validItems"
          :key="item.productId"
          class="mb-2 flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2"
        >
          <div class="flex min-w-0 items-center gap-3">
            <input
              type="checkbox"
              :checked="item.selected"
              @change="clientCartStore.toggleItemSelected(item.productId, ($event.target as HTMLInputElement).checked)"
            />
            <div class="min-w-0">
              <p class="truncate text-sm font-semibold text-slate-900">{{ item.productName }}</p>
              <p class="text-xs text-slate-400">可预订 {{ item.availableStock }} · 限购 {{ item.limitPerUser }}</p>
            </div>
          </div>
          <div class="ml-2 flex items-center gap-2">
            <button type="button" class="client-cart-qty-btn" @click="clientCartStore.incrementQty(item.productId, -1)">-</button>
            <span class="min-w-8 text-center text-sm">{{ item.qty }}</span>
            <button type="button" class="client-cart-qty-btn" @click="clientCartStore.incrementQty(item.productId, 1)">+</button>
          </div>
        </article>
      </div>

      <div v-if="clientCartStore.invalidItems.length" class="rounded-[1.2rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
        <p class="mb-2 text-sm font-semibold text-slate-700">失效商品</p>
        <article
          v-for="item in clientCartStore.invalidItems"
          :key="item.productId"
          class="mb-2 flex items-center justify-between rounded-xl bg-rose-50 px-3 py-2"
        >
          <div>
            <p class="text-sm font-semibold text-rose-700">{{ item.productName }}</p>
            <p class="text-xs text-rose-500">当前不可预订，请移除后继续结算</p>
          </div>
          <button type="button" class="text-xs text-rose-500" @click="clientCartStore.removeItem(item.productId)">移除</button>
        </article>
      </div>
    </section>

    <div v-if="clientCartStore.items.length" class="fixed bottom-[82px] left-1/2 z-20 flex w-[min(640px,calc(100vw-1.5rem))] -translate-x-1/2 items-center justify-between rounded-[1.2rem] bg-slate-900 px-4 py-3 text-white shadow-[var(--ylink-shadow-floating)]">
      <div>
        <p class="text-sm font-semibold">已选 {{ clientCartStore.selectedQty }} 件</p>
        <p class="text-xs text-white/70">共 {{ selectedCount }} 种商品</p>
      </div>
      <button type="button" class="rounded-full bg-white px-4 py-2 text-sm font-semibold text-slate-900" @click="goCheckout">去确认</button>
    </div>
  </section>
</template>

<style scoped>
.client-cart-qty-btn {
  height: 1.75rem;
  width: 1.75rem;
  border: none;
  border-radius: 9999px;
  background: #0f172a;
  color: #ffffff;
}
</style>
