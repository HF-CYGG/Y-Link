<script setup lang="ts">
/**
 * 模块说明：src/views/client/components/ClientRestockButton.vue
 * 文件职责：为四类商城单规格卡片提供一致的补货入口（商品详情底栏使用合并的“申请补货”主按钮）。
 * 实现逻辑：展示由商城计算的补货入口，查询与加载状态均由商城管理。
 * 维护说明：不能用商城限购后的可购数量判断缺货，不改变父卡片和虚拟列表尺寸。
 */
defineProps<{ loading: boolean }>()
const emit = defineEmits<{ restock: [] }>()
</script>
<template>
  <el-button size="small" plain type="primary" :loading="loading" class="client-restock-button" @click.stop="emit('restock')">申请补货</el-button>
</template>
<style scoped>
.client-restock-button { height: 1.7rem; margin: 0 !important; padding: 0 0.55rem; font-size: 0.7rem; border-radius: 999px; }
</style>
