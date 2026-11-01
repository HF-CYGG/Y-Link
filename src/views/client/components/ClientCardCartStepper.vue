<script setup lang="ts">
/**
 * 模块说明：src/views/client/components/ClientCardCartStepper.vue
 * 文件职责：商城四套商品卡片共用的加购入口；单规格商品在加购后由“+ 加购”胶囊分裂为“− 数量 +”两枚圆形按钮，多规格商品显示“选规格”并带已加购角标。
 * 实现逻辑：
 * - 组件只读取购物车 store 中的已加购数量，加购、减购、选规格全部通过事件交给商城页处理，复用页面既有的库存/限购校验与提示；
 * - 展开动画：“+ 加购”胶囊宽度收缩为圆形，同时“−”圆从右侧滑出到左侧、数量淡入，减到 0 时反向收拢；
 * - 根节点宽度固定，展开/收起都不改变卡片第三列宽度，避免商品名与价格在动画中重排抖动；
 * - 当前规格无可购库存且购物车里也没有该商品时不渲染，由同列的补货按钮成为唯一操作。
 * 维护说明：
 * - 动画只使用 transform / opacity / width 的轻量过渡，并统一在 prefers-reduced-motion 下关闭；
 * - 触顶时“+”只做 aria-disabled 弱化而不禁用点击，保证用户仍能收到“已达限购/库存不足”的提示；
 * - 不要在这里直接写购物车，避免与商城页的飞入动画、触感反馈和提示口径分叉。
 */
import { computed } from 'vue'

import type { O2oMallProduct, O2oMallSku } from '@/api/modules/o2o'
import { useClientCartStore } from '@/store'
import pinia from '@/store/pinia'
import { resolveClientCartMaxQty } from '@/store/modules/client-cart'
import { resolveProductPreviewSku, resolveSortedActivePreviewSkus } from '@/utils/product-preview'

const props = defineProps<{ product: O2oMallProduct }>()
const emit = defineEmits<{
  /** 加购一件：携带触发按钮，供商城页计算飞入动画起点。 */
  add: [source: HTMLElement | null]
  /** 减少一件：减到 0 时由购物车 store 移除该行。 */
  decrease: [itemId: string]
  /** 多规格商品：打开详情选择规格。 */
  choose: []
}>()

const clientCartStore = useClientCartStore(pinia)

const activeSkus = computed<O2oMallSku[]>(() => resolveSortedActivePreviewSkus(props.product))
const isMultiSku = computed(() => activeSkus.value.length > 1)
// 与商城页 quickAdd 的默认规格口径保持一致（推荐优先、有货优先）。
const defaultSku = computed(() => resolveProductPreviewSku(props.product))
const itemId = computed(() => defaultSku.value?.id || props.product.id)

const cartQty = computed(() => {
  if (isMultiSku.value) {
    return clientCartStore.qtyByProductId.get(props.product.id) ?? 0
  }
  return clientCartStore.qtyByItemId.get(itemId.value) ?? 0
})

const maxQty = computed(() => resolveClientCartMaxQty({
  availableStock: Math.max(0, Number(defaultSku.value?.availableStock ?? props.product.availableStock ?? 0)),
  limitPerUser: Math.max(0, Number(props.product.limitPerUser ?? 0)),
}))

const hasAnyStock = computed(() => {
  if (!activeSkus.value.length) {
    return Math.max(0, Number(props.product.availableStock ?? 0)) > 0
  }
  return activeSkus.value.some((sku) => Math.max(0, Number(sku.availableStock ?? 0)) > 0)
})

const visible = computed(() => cartQty.value > 0 || hasAnyStock.value)
const expanded = computed(() => !isMultiSku.value && cartQty.value > 0)
const canIncrease = computed(() => cartQty.value < maxQty.value)

const handleAdd = (event: MouseEvent) => {
  emit('add', event.currentTarget instanceof HTMLElement ? event.currentTarget : null)
}
</script>

<template>
  <div
    v-if="visible"
    class="client-card-stepper"
    :class="{ 'is-expanded': expanded, 'is-multi': isMultiSku }"
  >
    <template v-if="isMultiSku">
      <button type="button" class="client-card-stepper__pill" aria-label="选择规格后加购" @click.stop="emit('choose')">
        选规格
        <Transition name="client-card-stepper-badge">
          <span v-if="cartQty > 0" :key="cartQty" class="client-card-stepper__badge">{{ cartQty }}</span>
        </Transition>
      </button>
    </template>
    <template v-else>
      <button
        type="button"
        class="client-card-stepper__minus"
        aria-label="减少一件"
        :tabindex="expanded ? 0 : -1"
        :aria-hidden="!expanded"
        @click.stop="emit('decrease', itemId)"
      >
        <span aria-hidden="true">−</span>
      </button>
      <span class="client-card-stepper__qty" aria-live="polite">
        <Transition name="client-card-stepper-num" mode="out-in">
          <span :key="cartQty">{{ cartQty > 0 ? cartQty : '' }}</span>
        </Transition>
      </span>
      <button
        type="button"
        class="client-card-stepper__plus"
        :class="{ 'is-limited': expanded && !canIncrease }"
        :aria-label="expanded ? '增加一件' : '加入购物车'"
        :aria-disabled="expanded && !canIncrease"
        @click.stop="handleAdd"
      >
        <span class="client-card-stepper__plus-icon" aria-hidden="true">+</span>
        <span class="client-card-stepper__label">加购</span>
      </button>
    </template>
  </div>
</template>

<style scoped>
.client-card-stepper {
  --stepper-size: 1.95rem;
  --stepper-width: 5.1rem;
  --stepper-pill-width: 3.85rem;
  --stepper-duration: var(--ylink-motion-normal, 260ms);
  --stepper-ease: var(--ylink-motion-ease, cubic-bezier(0.22, 1, 0.36, 1));
  position: relative;
  display: block;
  width: var(--stepper-width);
  height: var(--stepper-size);
  flex-shrink: 0;
}

.client-card-stepper button {
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.client-card-stepper__plus,
.client-card-stepper__pill {
  position: absolute;
  top: 0;
  right: 0;
  display: inline-flex;
  height: var(--stepper-size);
  align-items: center;
  justify-content: center;
  gap: 0.12rem;
  overflow: hidden;
  border: none;
  border-radius: 9999px;
  background: var(--ylink-color-primary-strong);
  color: #ffffff;
  font-size: 0.72rem;
  font-weight: 700;
  white-space: nowrap;
  cursor: pointer;
  transition:
    width var(--stepper-duration) var(--stepper-ease),
    transform 120ms ease,
    opacity 160ms ease;
}

.client-card-stepper__plus {
  width: var(--stepper-pill-width);
  padding: 0;
}

.client-card-stepper__pill {
  padding: 0 0.72rem;
}

.client-card-stepper__plus-icon {
  font-size: 0.95rem;
  line-height: 1;
}

.client-card-stepper__label {
  display: inline-block;
  max-width: 2.2rem;
  overflow: hidden;
  opacity: 1;
  transition:
    max-width var(--stepper-duration) var(--stepper-ease),
    opacity 140ms ease;
}

.client-card-stepper__minus {
  position: absolute;
  top: 0;
  left: 0;
  display: inline-flex;
  width: var(--stepper-size);
  height: var(--stepper-size);
  align-items: center;
  justify-content: center;
  border: 1.5px solid var(--ylink-color-primary-strong);
  border-radius: 9999px;
  /* 背景与文字色直接引用主题变量，暗色模式自动切换。 */
  background: var(--ylink-color-surface, #ffffff);
  color: var(--ylink-color-primary-strong);
  font-size: 1rem;
  font-weight: 800;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  /* 收起态：“−”与“+”重叠在右侧并缩小，展开时向左滑出，形成“一分为二”的效果。 */
  transform: translateX(calc(var(--stepper-width) - var(--stepper-size))) scale(0.6);
  transition:
    transform var(--stepper-duration) var(--stepper-ease),
    opacity 180ms ease;
}

.client-card-stepper__qty {
  position: absolute;
  top: 0;
  right: var(--stepper-size);
  left: var(--stepper-size);
  display: flex;
  height: var(--stepper-size);
  align-items: center;
  justify-content: center;
  color: var(--ylink-color-text, #0f172a);
  font-size: 0.86rem;
  font-variant-numeric: tabular-nums;
  font-weight: 800;
  opacity: 0;
  transform: scale(0.6);
  transition:
    opacity 180ms ease,
    transform var(--stepper-duration) var(--stepper-ease);
}

.client-card-stepper.is-expanded .client-card-stepper__plus {
  width: var(--stepper-size);
}

.client-card-stepper.is-expanded .client-card-stepper__label {
  max-width: 0;
  opacity: 0;
}

.client-card-stepper.is-expanded .client-card-stepper__minus {
  opacity: 1;
  pointer-events: auto;
  transform: translateX(0) scale(1);
}

.client-card-stepper.is-expanded .client-card-stepper__qty {
  opacity: 1;
  transform: scale(1);
}

.client-card-stepper__plus.is-limited {
  opacity: 0.45;
}

.client-card-stepper__plus:active,
.client-card-stepper__pill:active,
.client-card-stepper__minus:active {
  transform: scale(0.9);
}

.client-card-stepper.is-expanded .client-card-stepper__minus:active {
  transform: translateX(0) scale(0.9);
}

.client-card-stepper__plus:focus-visible,
.client-card-stepper__pill:focus-visible,
.client-card-stepper__minus:focus-visible {
  outline: 2px solid var(--ylink-color-primary);
  outline-offset: 2px;
}

.client-card-stepper__badge {
  position: absolute;
  top: -0.28rem;
  right: -0.2rem;
  min-width: 1rem;
  height: 1rem;
  border: 1.5px solid #ffffff;
  border-radius: 9999px;
  background: #ef4444;
  color: #ffffff;
  font-size: 0.6rem;
  line-height: 0.75rem;
  padding: 0 0.22rem;
  text-align: center;
}

.client-card-stepper.is-multi .client-card-stepper__pill {
  overflow: visible;
}

.client-card-stepper-num-enter-active,
.client-card-stepper-num-leave-active,
.client-card-stepper-badge-enter-active,
.client-card-stepper-badge-leave-active {
  transition:
    opacity 140ms ease,
    transform 140ms ease;
}

.client-card-stepper-num-enter-from {
  opacity: 0;
  transform: translateY(-40%);
}

.client-card-stepper-num-leave-to {
  opacity: 0;
  transform: translateY(40%);
}

.client-card-stepper-badge-enter-from,
.client-card-stepper-badge-leave-to {
  opacity: 0;
  transform: scale(0.4);
}

@media (max-width: 640px) {
  .client-card-stepper {
    --stepper-size: 1.9rem;
    --stepper-width: 4.9rem;
    --stepper-pill-width: 3.7rem;
  }

  .client-card-stepper__plus,
  .client-card-stepper__pill {
    font-size: 0.7rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  .client-card-stepper,
  .client-card-stepper * {
    transition-duration: 0.01ms !important;
  }
}
</style>
