<script setup lang="ts">
/**
 * 模块说明：多规格本次新增数量编辑器。
 * 文件职责：按当前启用规格展示图片、价格与剩余可加量，保留失效规格草稿及逐行冲突。
 * 实现逻辑：输入原文由详情持有，不逐字截量；目录变更与单多切换不会静默重置草稿。
 * 维护说明：提交统一走购物车批量原子入口，补货仍由既有共享入口处理。
 */
import { computed } from 'vue'
import { resolveProductPlaceholder } from '@/utils/product-placeholder'
import type { O2oMallProduct, O2oMallSku } from '@/api/modules/o2o'
import type { ClientCartBatchResult } from '@/store/modules/client-cart'
import { parseClientBatchQty } from '../client-multi-sku.helpers'
const props = defineProps<{
  product: O2oMallProduct
  skus: O2oMallSku[]
  drafts: Record<string, string>
  maxBySku: Map<string, number>
  conflicts: ClientCartBatchResult['conflicts']
  thumbnail: (sku: O2oMallSku) => string
}>()
const emit = defineEmits<{ change: [skuId: string, raw: string]; restock: [sku: O2oMallSku]; preview: [sku: O2oMallSku] }>()
const activeIds = computed(() => new Set(props.product.skus.filter((sku) => sku.isActive !== false && sku.isCurrent !== false).map((sku) => sku.id)))
const handleImageError = (event: Event) => {
  const image = event.target as HTMLImageElement
  if (!image.dataset.placeholder) { image.dataset.placeholder = 'true'; image.src = resolveProductPlaceholder(null) }
}
const messageFor = (sku: O2oMallSku) => props.conflicts.find((entry) => entry.skuId === sku.id)?.message || (!activeIds.value.has(sku.id) ? '该规格已失效，请调整本次数量' : '')
const changeQty = (sku: O2oMallSku, delta: number) => {
  const qty = parseClientBatchQty(props.drafts[sku.id] ?? '0')
  if (!Number.isFinite(qty)) return
  const next = qty + delta
  if (next < 0 || (delta > 0 && next > (props.maxBySku.get(sku.id) ?? 0))) return
  emit('change', sku.id, String(next))
}
</script>
<template>
  <div class="multi-sku-list">
    <div v-for="sku in skus" :key="sku.id" class="multi-sku-row" :data-sku-id="sku.id" :class="{ 'is-selected': parseClientBatchQty(drafts[sku.id] ?? '0') > 0, 'is-unavailable': !activeIds.has(sku.id) || Number(sku.availableStock) <= 0 }">
      <el-button class="multi-sku-image" text :aria-label="`预览${sku.specText || '规格'}图片`" @click="emit('preview', sku)"><img :src="thumbnail(sku)" alt="" @error="handleImageError" /></el-button>
      <div class="multi-sku-info">
        <p :title="sku.specText || sku.skuCode">{{ sku.specText || sku.skuCode || '默认规格' }}</p>
        <span class="multi-sku-price">¥{{ Number(sku.discountedPrice).toFixed(2) }}</span>
        <small>库存 {{ sku.availableStock }} · 本次可加 {{ maxBySku.get(sku.id) ?? 0 }} 件</small>
        <el-button v-if="activeIds.has(sku.id)" text size="small" @click="emit('restock', sku)">申请补货</el-button>
        <p v-if="messageFor(sku)" class="multi-sku-error" role="alert">{{ messageFor(sku) }}</p>
      </div>
      <div class="multi-sku-qty">
        <el-button circle :disabled="!(parseClientBatchQty(drafts[sku.id] ?? '0') > 0)" :aria-label="`减少${sku.specText}数量`" @click="changeQty(sku, -1)">−</el-button>
        <el-input :model-value="drafts[sku.id] ?? '0'" inputmode="numeric" :maxlength="16" :aria-label="`${sku.specText}本次数量`" @update:model-value="emit('change', sku.id, String($event))" />
        <el-button circle :disabled="!activeIds.has(sku.id) || !(parseClientBatchQty(drafts[sku.id] ?? '0') < (maxBySku.get(sku.id) ?? 0))" :aria-label="`增加${sku.specText}数量`" @click="changeQty(sku, 1)">+</el-button>
      </div>
    </div>
  </div>
</template>
<style scoped>
.multi-sku-list { display: grid; gap: 10px; }
.multi-sku-row { display: grid; grid-template-columns: 48px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 12px; border: 1px solid var(--el-border-color-light); border-radius: 14px; background: var(--el-bg-color); }
.multi-sku-row.is-selected { border-color: var(--ylink-color-primary-strong); background: var(--ylink-color-primary-weak); }
.multi-sku-row.is-unavailable:not(.is-selected) { background: var(--el-fill-color-light); }
.multi-sku-image { width: 48px; height: 48px; padding: 0; margin: 0; }
.multi-sku-image img { width: 48px; height: 48px; object-fit: contain; border-radius: 8px; }
.multi-sku-info { min-width: 0; }
.multi-sku-info p { margin: 0; overflow-wrap: anywhere; font-size: 14px; font-weight: 700; line-height: 1.4; }
.multi-sku-info .multi-sku-price { display: block; margin-top: 3px; color: var(--ylink-color-primary-strong); font-size: 15px; font-weight: 800; }
.multi-sku-info small { display: block; margin-top: 2px; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.4; overflow-wrap: anywhere; }
.multi-sku-info .el-button { height: auto; padding: 4px 0 0; margin: 0; color: var(--ylink-color-primary-strong); }
.multi-sku-qty { display: flex; align-items: center; gap: 2px; }
.multi-sku-qty .el-button { width: 26px; height: 26px; margin: 0; padding: 0; }
.multi-sku-qty .el-input { width: 38px; }
.multi-sku-qty :deep(.el-input__inner) { font-size: 16px; text-align: center; }
.multi-sku-qty :deep(.el-input__wrapper) { padding: 0 2px; }
.multi-sku-info .multi-sku-error { margin-top: 4px; color: var(--el-color-danger); font-size: 12px; font-weight: 500; }
@media (max-width: 360px) {
  .multi-sku-row { grid-template-columns: 48px minmax(0, 1fr); gap: 8px; padding: 10px; }
  .multi-sku-qty { grid-column: 2; justify-self: start; }
}
</style>
