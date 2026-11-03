<script setup lang="ts">
/**
 * 模块说明：src/views/client/components/ClientRestockButton.vue
 * 文件职责：为四类商城单规格卡片提供一致的补货入口（商品详情底栏使用合并的“申请补货”主按钮）。
 * 实现逻辑：展示当前启用规格且不以库存限制补货资格；单规格先查询有效申请，多规格进入表单明确选择；查询与跳转逻辑统一由 useClientRestockEntry 提供。
 * 维护说明：不能用商城限购后的可购数量判断缺货，不改变父卡片和虚拟列表尺寸。
 */
import type { O2oMallProduct, O2oMallSku } from '@/api/modules/o2o'
import { useClientRestockEntry } from '@/composables/useClientRestockEntry'

const props = defineProps<{ product: O2oMallProduct; sku?: O2oMallSku | null; variant?: 'primary' | 'compact' }>()
const { loading, restockAvailable: visible, openRestock: open } = useClientRestockEntry(() => props.product, () => props.sku)
</script>
<template>
  <el-button v-if="visible" :size="variant === 'primary' ? 'large' : 'small'" :plain="variant !== 'primary'" type="primary" :loading="loading" class="client-restock-button" :class="{ 'client-restock-button--primary': variant === 'primary' }" @click.stop="open">申请补货</el-button>
</template>
<style scoped>
.client-restock-button { height: 1.7rem; margin: 0 !important; padding: 0 0.55rem; font-size: 0.7rem; border-radius: 999px; }
.client-restock-button--primary { width: 100%; height: 2.9rem; font-size: 0.92rem; font-weight: 700; }
</style>
