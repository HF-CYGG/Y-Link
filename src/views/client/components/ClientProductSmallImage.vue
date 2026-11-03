<script setup lang="ts">
/**
 * 模块说明：客户端紧凑商品图。
 * 文件职责：按小图、同一规格原图、占位图顺序回退；源或规格变化后重置错误状态。
 * 维护说明：固定占位不参与购买校验，大图预览仍使用原始 thumbnail。
 */
import { computed, ref, watch } from 'vue'
import { resolveProductPlaceholder } from '@/utils/product-placeholder'
const props = defineProps<{ small?: string | null; original?: string | null; sourceKey?: string; alt: string }>()
const stage = ref(0)
watch(() => [props.small, props.original, props.sourceKey], () => { stage.value = 0 }, { flush: 'sync' })
const sources = computed(() => [...new Set([props.small, props.original].filter((url): url is string => Boolean(url?.trim())))])
const source = computed(() => sources.value[stage.value] || resolveProductPlaceholder(null))
const fail = () => { if (stage.value < sources.value.length) stage.value += 1 }
</script>
<template><img :key="source" :src="source" :alt="alt" width="40" height="40" class="client-small-product-image" loading="lazy" decoding="async" @error="fail" /></template>
<style scoped>
.client-small-product-image { width: 40px; height: 40px; flex: 0 0 40px; object-fit: cover; border-radius: 8px; }
</style>
