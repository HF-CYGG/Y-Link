<script setup lang="ts">
/**
 * 模块说明：src/views/client/components/ClientRestockButton.vue
 * 文件职责：为四类商城卡片及商品详情提供一致的缺货入口。
 * 实现逻辑：只展示当前启用且缺货的规格；单规格先查询有效申请，多规格进入表单明确选择。
 * 维护说明：不能用商城限购后的可购数量判断缺货，不改变父卡片和虚拟列表尺寸。
 */
import { computed, onBeforeUnmount, onDeactivated, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { getActiveClientRestockRequest } from '@/api/modules/customer-service-feedback'
import type { O2oMallProduct, O2oMallSku } from '@/api/modules/o2o'
import { useStableRequest } from '@/composables/useStableRequest'
import { useClientAuthStore } from '@/store'
import pinia from '@/store/pinia'
import { getRestockSkus } from '@/utils/restock'
import { extractErrorMessage } from '@/utils/error'
import { showAppError } from '@/utils/app-alert'
const props = defineProps<{ product: O2oMallProduct; sku?: O2oMallSku | null }>()
const router = useRouter()
const auth = useClientAuthStore(pinia)
const request = useStableRequest()
const loading = ref(false)
const resetPending = () => { request.cancel(); loading.value = false }
watch(() => [props.product.id, props.sku?.id, auth.currentUser?.id], resetPending)
onDeactivated(resetPending)
onBeforeUnmount(resetPending)
const candidates = computed(() => getRestockSkus(props.product))
const visible = computed(() => props.sku ? candidates.value.some((sku) => sku.id === props.sku?.id) : candidates.value.length > 0)
const open = async () => {
  if (loading.value || !visible.value || !auth.currentUser?.id) return
  const userId = auth.currentUser.id
  const activeSkus = props.product.skus.filter((sku) => sku.isActive && sku.isCurrent)
  const sku = props.sku ?? (activeSkus.length === 1 ? candidates.value[0] : null)
  const query = { type: 'restock', productId: props.product.id, ...(sku ? { skuId: sku.id } : {}) }
  if (!sku) { await router.push({ path: '/client/feedback/create', query }); return }
  loading.value = true
  await request.runLatest({
    executor: (signal) => getActiveClientRestockRequest(sku.id, { signal }),
    onSuccess: async (result) => {
      if (auth.currentUser?.id !== userId) return
      await router.push(result.restock ? `/client/feedback/${result.restock.conversationId}` : { path: '/client/feedback/create', query })
    },
    onError: (error) => { showAppError(extractErrorMessage(error, '查询补货申请失败，请重试')) },
    onFinally: () => { loading.value = false },
  })
}
</script>
<template>
  <el-button v-if="visible" size="small" plain type="primary" :loading="loading" class="client-restock-button" @click.stop="open">请补货</el-button>
</template>
<style scoped>
.client-restock-button { height: 1.7rem; margin: 0 !important; padding: 0 0.55rem; font-size: 0.7rem; border-radius: 999px; }
</style>
