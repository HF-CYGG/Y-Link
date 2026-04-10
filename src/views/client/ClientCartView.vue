<script setup lang="ts">
/**
 * 模块说明：src/views/client/ClientCartView.vue
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { ArrowLeft } from '@element-plus/icons-vue'
import { useClientCartStore } from '@/store'

const props = defineProps<{
  standalone?: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'checkout'): void
}>()

const router = useRouter()
const clientCartStore = useClientCartStore()

onMounted(() => {
  clientCartStore.initialize()
})

const selectedCount = computed(() => clientCartStore.selectedValidItems.length)
const totalAmount = computed(() => clientCartStore.selectedValidItems.reduce((sum, item) => sum + Math.max(0, Number(item.defaultPrice || 0)) * item.qty, 0))

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const removeSelected = () => {
  if (!selectedCount.value) {
    ElMessage.warning('请先选择商品')
    return
  }
  clientCartStore.clearSelectedItems()
  ElMessage.success('已删除选中商品')
}

const goCheckout = () => {
  if (!clientCartStore.selectedValidItems.length) {
    ElMessage.warning('请选择至少一件可结算商品')
    return
  }
  if (props.standalone) {
    router.push('/client/checkout')
  } else {
    emit('checkout')
  }
}

const handleBack = () => {
  if (props.standalone) {
    router.back()
  } else {
    emit('close')
  }
}
</script>

<template>
  <div class="h-full flex flex-col bg-[var(--ylink-color-bg)]">
    <div class="sticky top-0 z-10 flex items-center gap-3 bg-[var(--ylink-color-surface)] px-4 py-3 shadow-sm">
      <button type="button" class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-slate-100" @click="handleBack">
        <el-icon :size="20"><ArrowLeft /></el-icon>
      </button>
      <p class="text-lg font-semibold text-slate-900">购物车管理</p>
    </div>

    <section class="flex-1 overflow-y-auto px-4 py-4 sm:px-5 pb-32">
      <div class="mb-4 rounded-[1.4rem] bg-[var(--ylink-color-surface)] p-4 shadow-[var(--ylink-shadow-soft)]">
        <p class="text-sm text-slate-500">支持全选、批量删除与失效商品分组</p>
      </div>

      <div
        v-if="!clientCartStore.items.length"
        class="rounded-[1.4rem] bg-[var(--ylink-color-surface)] p-10 text-center text-sm text-slate-400 shadow-[var(--ylink-shadow-soft)]"
      >
        购物车为空，去商城挑选商品吧
        <div class="mt-4">
          <button type="button" @click="handleBack" class="rounded-full bg-slate-900 px-4 py-2 text-xs text-white">去逛逛</button>
        </div>
      </div>

      <section v-else class="space-y-4">
        <div class="rounded-[1.2rem] bg-[var(--ylink-color-surface)] p-4 shadow-[var(--ylink-shadow-soft)]">
          <div class="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-slate-100 pb-3">
            <label class="inline-flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                :checked="clientCartStore.allValidSelected"
                @change="clientCartStore.toggleAllValidSelected(($event.target as HTMLInputElement).checked)"
              />
              全选有效商品
            </label>
            <button type="button" class="self-start text-xs text-rose-500 sm:self-auto hover:text-rose-600" @click="removeSelected">批量删除</button>
          </div>

          <article
            v-for="item in clientCartStore.validItems"
            :key="item.productId"
            class="mb-3 rounded-xl bg-[var(--ylink-color-surface-soft)] px-3 py-3 border border-slate-100"
          >
            <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div class="flex min-w-0 items-start gap-3">
                <input
                  type="checkbox"
                  :checked="item.selected"
                  class="mt-1 w-4 h-4 rounded text-teal-600 focus:ring-teal-500 cursor-pointer"
                  @change="clientCartStore.toggleItemSelected(item.productId, ($event.target as HTMLInputElement).checked)"
                />
                <div class="min-w-0">
                  <p class="truncate text-sm font-semibold text-slate-900">{{ item.productName }}</p>
                  <p class="mt-1 text-sm font-bold text-teal-600">¥{{ Number(item.defaultPrice).toFixed(2) }}</p>
                  <p class="text-xs text-slate-400 mt-1">可预订 {{ item.availableStock }} · 限购 {{ item.limitPerUser }}</p>
                </div>
              </div>
              <div class="flex items-center justify-end gap-3 sm:w-auto w-full">
                <button type="button" class="client-cart-qty-btn" @click="clientCartStore.incrementQty(item.productId, -1)">-</button>
                <span class="min-w-8 text-center text-sm font-medium">{{ item.qty }}</span>
                <button type="button" class="client-cart-qty-btn" @click="clientCartStore.incrementQty(item.productId, 1)">+</button>
              </div>
            </div>
          </article>
        </div>

        <div
          v-if="clientCartStore.invalidItems.length"
          class="rounded-[1.2rem] bg-[var(--ylink-color-surface)] p-4 shadow-[var(--ylink-shadow-soft)]"
        >
          <p class="mb-3 text-sm font-semibold text-slate-700">失效商品</p>
          <article
            v-for="item in clientCartStore.invalidItems"
            :key="item.productId"
            class="mb-2 flex flex-col gap-3 rounded-xl bg-rose-50 px-3 py-3 border border-rose-100 sm:flex-row sm:items-center sm:justify-between"
          >
            <div class="min-w-0">
              <p class="text-sm font-semibold text-rose-700">{{ item.productName }}</p>
              <p class="text-xs text-rose-500 mt-1">当前不可预订，请移除后继续</p>
            </div>
            <button type="button" class="self-end text-xs font-medium text-rose-600 bg-white px-3 py-1.5 rounded-full border border-rose-200 hover:bg-rose-50 sm:self-auto" @click="clientCartStore.removeItem(item.productId)">移除</button>
          </article>
        </div>
      </section>
    </section>

    <div v-if="clientCartStore.items.length" class="client-cart-summary absolute bottom-0 left-0 right-0 z-20 bg-white border-t border-slate-200 px-4 py-3 pb-safe shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)]">
      <div class="flex items-center justify-between w-full max-w-[1100px] mx-auto">
        <div class="flex flex-col">
          <p class="text-sm text-slate-500">已选 <span class="font-bold text-slate-900">{{ clientCartStore.selectedQty }}</span> 件，合计 <span class="font-bold text-teal-600">¥{{ totalAmount.toFixed(2) }}</span></p>
          <p class="text-xs text-slate-400 mt-0.5">共 {{ selectedCount }} 种商品</p>
        </div>
        <button type="button" class="rounded-full bg-slate-900 px-8 py-2.5 text-sm font-semibold text-white transition-transform active:scale-95 shadow-md hover:shadow-lg" @click="goCheckout">去结算</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.client-cart-qty-btn {
  height: 1.85rem;
  width: 1.85rem;
  border: none;
  border-radius: 9999px;
  background: #f1f5f9;
  color: #334155;
  font-weight: bold;
  transition: all 0.2s;
}

.client-cart-qty-btn:active {
  background: #e2e8f0;
  transform: scale(0.95);
}

.pb-safe {
  padding-bottom: max(0.75rem, env(safe-area-inset-bottom));
}
</style>
