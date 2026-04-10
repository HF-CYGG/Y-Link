<script setup lang="ts">
/**
 * 模块说明：src/views/client/ClientCartView.vue
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */


import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useDevice } from '@/composables/useDevice'
import { useClientCartStore } from '@/store'

const router = useRouter()
const clientCartStore = useClientCartStore()
const { isPhone, isTablet } = useDevice()

onMounted(() => {
  clientCartStore.initialize()
})

const selectedCount = computed(() => clientCartStore.selectedValidItems.length)
const cartSummaryClass = computed(() => {
  if (isPhone.value) {
    return 'client-cart-summary--phone'
  }
  if (isTablet.value) {
    return 'client-cart-summary--tablet'
  }
  return 'client-cart-summary--desktop'
})

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
    <div class="rounded-[1.4rem] bg-[var(--ylink-color-surface)] p-4 shadow-[var(--ylink-shadow-soft)]">
      <p class="text-xl font-semibold text-slate-900">购物车</p>
      <p class="mt-1 text-sm text-slate-500">支持全选、批量删除与失效商品分组</p>
    </div>

    <div
      v-if="!clientCartStore.items.length"
      class="rounded-[1.4rem] bg-[var(--ylink-color-surface)] p-10 text-center text-sm text-slate-400 shadow-[var(--ylink-shadow-soft)]"
    >
      购物车为空，去商城挑选商品吧
      <div class="mt-4">
        <router-link to="/client/mall" class="rounded-full bg-slate-900 px-4 py-2 text-xs text-white">去逛逛</router-link>
      </div>
    </div>

    <section v-else class="space-y-4">
      <div class="rounded-[1.2rem] bg-[var(--ylink-color-surface)] p-4 shadow-[var(--ylink-shadow-soft)]">
        <div class="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <label class="inline-flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              :checked="clientCartStore.allValidSelected"
              @change="clientCartStore.toggleAllValidSelected(($event.target as HTMLInputElement).checked)"
            />
            全选有效商品
          </label>
          <button type="button" class="self-start text-xs text-rose-500 sm:self-auto" @click="removeSelected">批量删除</button>
        </div>

        <article
          v-for="item in clientCartStore.validItems"
          :key="item.productId"
          class="mb-2 rounded-xl bg-[var(--ylink-color-surface-soft)] px-3 py-3"
        >
          <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div class="flex min-w-0 items-start gap-3">
              <input
                type="checkbox"
                :checked="item.selected"
                class="mt-0.5"
                @change="clientCartStore.toggleItemSelected(item.productId, ($event.target as HTMLInputElement).checked)"
              />
              <div class="min-w-0">
                <p class="truncate text-sm font-semibold text-slate-900">{{ item.productName }}</p>
                <p class="text-xs text-slate-400">可预订 {{ item.availableStock }} · 限购 {{ item.limitPerUser }}</p>
              </div>
            </div>
            <div class="flex items-center justify-end gap-2">
              <button type="button" class="client-cart-qty-btn" @click="clientCartStore.incrementQty(item.productId, -1)">-</button>
              <span class="min-w-8 text-center text-sm">{{ item.qty }}</span>
              <button type="button" class="client-cart-qty-btn" @click="clientCartStore.incrementQty(item.productId, 1)">+</button>
            </div>
          </div>
        </article>
      </div>

      <div
        v-if="clientCartStore.invalidItems.length"
        class="rounded-[1.2rem] bg-[var(--ylink-color-surface)] p-4 shadow-[var(--ylink-shadow-soft)]"
      >
        <p class="mb-2 text-sm font-semibold text-slate-700">失效商品</p>
        <article
          v-for="item in clientCartStore.invalidItems"
          :key="item.productId"
          class="mb-2 flex flex-col gap-3 rounded-xl bg-rose-50 px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <div class="min-w-0">
            <p class="text-sm font-semibold text-rose-700">{{ item.productName }}</p>
            <p class="text-xs text-rose-500">当前不可预订，请移除后继续结算</p>
          </div>
          <button type="button" class="self-start text-xs text-rose-500 sm:self-auto" @click="clientCartStore.removeItem(item.productId)">移除</button>
        </article>
      </div>
    </section>

    <div v-if="clientCartStore.items.length" class="client-cart-summary fixed left-1/2 z-20 -translate-x-1/2" :class="cartSummaryClass">
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

.client-cart-summary {
  display: flex;
  width: min(1100px, calc(100vw - 1.5rem));
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  border-radius: 1.2rem;
  background: #0f172a;
  padding: 0.85rem 1rem;
  color: #ffffff;
  box-shadow: var(--ylink-shadow-floating);
}

.client-cart-summary--desktop,
.client-cart-summary--tablet {
  bottom: 82px;
}

.client-cart-summary--phone {
  bottom: 82px;
}

@media (max-width: 767px) {
  .client-cart-summary {
    bottom: 82px;
    flex-direction: column;
    align-items: stretch;
    gap: 0.75rem;
    padding-bottom: calc(0.9rem + env(safe-area-inset-bottom));
  }
}
</style>
