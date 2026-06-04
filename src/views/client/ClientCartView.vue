<script setup lang="ts">
/**
 * 模块说明：src/views/client/ClientCartView.vue
 * 文件职责：负责客户端购物车列表、勾选态维护、批量删除与进入结算前的交互反馈。
 * 实现逻辑：
 * - 购物车页与商城内嵌购物车共用同一组件，通过 `standalone` 区分路由页与抽屉页模式；
 * - 去结算时统一沿用商城页口径，若用户尚未手动勾选，则自动勾选全部可结算商品再继续；
 * - 进入页面后会在后台静默同步一次最新商品目录，及时修正库存、限购与失效商品状态；
 * - 在路由跳转或抽屉切换前先进入短暂“处理中”状态，减少重复点击与“无响应”感知。
 * 维护说明：后续若继续扩展购物车入口，需要同步保持不同入口的勾选与反馈口径一致。
 */

import { computed, nextTick, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import { ArrowLeft } from '@element-plus/icons-vue'
import { useClientMallSnapshotRefresh } from '@/composables/useClientMallSnapshotRefresh'
import { useClientAuthStore, useClientCartStore } from '@/store'
import pinia from '@/store/pinia'


import { showAppSuccess, showAppWarning } from '@/utils/app-alert'

const props = defineProps<{
  standalone?: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'checkout'): void
}>()

const router = useRouter()
const clientAuthStore = useClientAuthStore(pinia)
const clientCartStore = useClientCartStore(pinia)
const { syncing: catalogSyncing, refreshMallSnapshot } = useClientMallSnapshotRefresh()
const checkoutPending = ref(false)

onMounted(() => {
  clientCartStore.initialize(clientAuthStore.currentUser?.id)
  // 购物车页优先展示本地快照，再静默拉取最新库存，避免把首屏等待绑定到目录同步上。
  void refreshMallSnapshot()
})

const selectedCount = computed(() => clientCartStore.selectedValidItems.length)
const totalAmount = computed(() => clientCartStore.selectedValidItems.reduce((sum, item) => sum + Math.max(0, Number(item.defaultPrice || 0)) * item.qty, 0))

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const removeSelected = () => {
  if (!selectedCount.value) {
    showAppWarning('请先选择商品')
    return
  }
  clientCartStore.clearSelectedItems()
  showAppSuccess('已删除选中商品')
}

const checkoutButtonText = computed(() => {
  if (!checkoutPending.value) {
    return '去结算'
  }
  return props.standalone ? '进入结算中...' : '打开结算中...'
})

const goCheckout = async () => {
  if (checkoutPending.value) {
    return
  }

  if (!clientCartStore.selectedValidItems.length) {
    if (clientCartStore.validItems.length > 0) {
      // 与商城页底部“去结算”保持一致：未手动勾选时默认勾选全部有效商品，再进入结算。
      clientCartStore.toggleAllValidSelected(true)
    } else {
      showAppWarning('购物车暂无可结算商品')
      return
    }
  }

  checkoutPending.value = true
  try {
    if (props.standalone) {
      await router.push('/client/checkout')
      return
    }

    emit('checkout')
    // 抽屉模式等待父层消费事件并开始切换，确保按钮文案至少完成一次可见反馈。
    await nextTick()
  } finally {
    checkoutPending.value = false
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
        <p class="mt-2 text-xs text-slate-400">
          {{ catalogSyncing ? '正在后台同步最新库存，不影响当前勾选与结算操作' : '商品库存与限购会在进入页面后自动静默同步' }}
        </p>
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

          <TransitionGroup name="cart-list-flow" tag="div" class="space-y-3">
            <article
              v-for="item in clientCartStore.validItems"
              :key="`valid-${item.productId}`"
              class="rounded-xl bg-[var(--ylink-color-surface-soft)] px-3 py-3 border border-slate-100"
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
                  <span class="min-w-8 text-center text-sm font-medium">
                    <Transition name="cart-qty-pop" mode="out-in">
                      <span :key="`drawer-qty-${item.productId}-${item.qty}`">{{ item.qty }}</span>
                    </Transition>
                  </span>
                  <button type="button" class="client-cart-qty-btn" @click="clientCartStore.incrementQty(item.productId, 1)">+</button>
                </div>
              </div>
            </article>
          </TransitionGroup>
        </div>

        <div
          v-if="clientCartStore.invalidItems.length"
          class="rounded-[1.2rem] bg-[var(--ylink-color-surface)] p-4 shadow-[var(--ylink-shadow-soft)]"
        >
          <p class="mb-3 text-sm font-semibold text-slate-700">失效商品</p>
          <TransitionGroup name="cart-list-flow" tag="div" class="space-y-2">
            <article
              v-for="item in clientCartStore.invalidItems"
              :key="`invalid-${item.productId}`"
              class="flex flex-col gap-3 rounded-xl bg-rose-50 px-3 py-3 border border-rose-100 sm:flex-row sm:items-center sm:justify-between"
            >
              <div class="min-w-0">
                <p class="text-sm font-semibold text-rose-700">{{ item.productName }}</p>
                <p class="text-xs text-rose-500 mt-1">当前不可预订，请移除后继续</p>
              </div>
              <button type="button" class="self-end text-xs font-medium text-rose-600 bg-white px-3 py-1.5 rounded-full border border-rose-200 hover:bg-rose-50 sm:self-auto" @click="clientCartStore.removeItem(item.productId)">移除</button>
            </article>
          </TransitionGroup>
        </div>
      </section>
    </section>

    <div v-if="clientCartStore.items.length" class="client-cart-summary absolute bottom-0 left-0 right-0 z-20 bg-white border-t border-slate-200 px-4 py-3 pb-safe shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)]">
      <div class="flex items-center justify-between w-full max-w-[1100px] mx-auto">
        <div class="flex flex-col">
          <p class="text-sm text-slate-500">
            已选
            <Transition name="cart-qty-pop" mode="out-in">
              <span :key="`summary-selected-${clientCartStore.selectedQty}`" class="font-bold text-slate-900">{{ clientCartStore.selectedQty }}</span>
            </Transition>
            件，合计
            <Transition name="cart-qty-pop" mode="out-in">
              <span :key="`summary-total-${totalAmount.toFixed(2)}`" class="font-bold text-teal-600">¥{{ totalAmount.toFixed(2) }}</span>
            </Transition>
          </p>
          <p class="text-xs text-slate-400 mt-0.5">
            共
            <Transition name="cart-qty-pop" mode="out-in">
              <span :key="`summary-count-${selectedCount}`">{{ selectedCount }}</span>
            </Transition>
            种商品
          </p>
        </div>
        <button
          type="button"
          class="rounded-full bg-slate-900 px-8 py-2.5 text-sm font-semibold text-white transition-transform active:scale-95 shadow-md hover:shadow-lg disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="checkoutPending"
          @click="goCheckout"
        >
          {{ checkoutButtonText }}
        </button>
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
  transition:
    background-color var(--motion-duration-fast) var(--ylink-motion-ease),
    transform var(--motion-duration-fast) var(--ylink-motion-ease);
}

.client-cart-qty-btn:active {
  background: #e2e8f0;
  transform: scale(0.95);
}

.pb-safe {
  padding-bottom: max(0.75rem, env(safe-area-inset-bottom));
}

.cart-list-flow-enter-active,
.cart-list-flow-leave-active {
  transition:
    transform 0.28s cubic-bezier(0.22, 1, 0.36, 1),
    opacity 0.24s ease;
}

.cart-list-flow-enter-from,
.cart-list-flow-leave-to {
  opacity: 0;
  transform: translateY(10px) scale(0.98);
}

.cart-list-flow-move {
  transition: transform 0.32s cubic-bezier(0.22, 1, 0.36, 1);
}

.cart-qty-pop-enter-active,
.cart-qty-pop-leave-active {
  transition:
    transform 0.2s cubic-bezier(0.22, 1, 0.36, 1),
    opacity 0.2s ease;
}

.cart-qty-pop-enter-from,
.cart-qty-pop-leave-to {
  opacity: 0;
  transform: translateY(-5px) scale(0.92);
}
</style>
