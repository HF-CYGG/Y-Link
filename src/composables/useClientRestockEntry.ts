/**
 * 模块说明：src/composables/useClientRestockEntry.ts
 * 文件职责：客户端“申请补货”入口的共享逻辑，供商城卡片补货按钮与商品详情底栏复用。
 * 实现逻辑：
 * - 当前启用规格均可申请，资格不受库存或限购约束；详情是否切换缺货动作由商城按真实库存单独判断；
 * - 单规格或已明确选择规格时，先查询该规格是否已有有效补货申请，有则直接进入原会话，无则进入新建表单；
 * - 多规格且未指定规格时直接进入表单，由用户在表单中明确选择；
 * - 请求通过 useStableRequest 收口，商品/规格/账号变化、页面失活或卸载时取消在途请求，防止旧结果跳转串号。
 * 维护说明：
 * - 入参使用 getter，保证卡片复用与详情切换规格时都读取最新值；
 * - 这里只负责跳转，不修改购物车或库存。
 */
import { computed, onActivated, onBeforeUnmount, onDeactivated, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import { getActiveClientRestockRequest } from '@/api/modules/customer-service-feedback'
import type { O2oMallProduct, O2oMallSku } from '@/api/modules/o2o'
import { useStableRequest } from '@/composables/useStableRequest'
import { useClientAuthStore } from '@/store'
import pinia from '@/store/pinia'
import { showAppError } from '@/utils/app-alert'
import { extractErrorMessage } from '@/utils/error'
import { getRestockSkus } from '@/utils/restock'

export const useClientRestockEntry = (
  resolveProduct: () => O2oMallProduct | null | undefined,
  resolveSku: () => O2oMallSku | null | undefined = () => null,
  resolveVisible: () => boolean = () => true,
) => {
  const router = useRouter()
  const auth = useClientAuthStore(pinia)
  const request = useStableRequest()
  const loading = ref(false)
  let active = true
  let generation = 0

  const resetPending = () => {
    generation += 1
    request.cancel()
    loading.value = false
  }
  watch(() => [resolveProduct()?.id, resolveSku()?.id, auth.currentUser?.id, resolveVisible()], resetPending, { flush: 'sync' })
  onActivated(() => { active = true })
  onDeactivated(() => { active = false; resetPending() })
  onBeforeUnmount(() => { active = false; resetPending() })

  const candidates = computed(() => {
    const product = resolveProduct()
    return product ? getRestockSkus(product) : []
  })

  /** 补货资格只看当前启用规格；现货数量不作为申请门槛。 */
  const restockAvailable = computed(() => {
    const sku = resolveSku()
    return sku ? candidates.value.some((candidate) => candidate.id === sku.id) : candidates.value.length > 0
  })

  const openRestock = async () => {
    const product = resolveProduct()
    if (!active || !resolveVisible() || !product || loading.value || !restockAvailable.value || !auth.currentUser?.id) return
    const userId = auth.currentUser.id
    const runId = ++generation
    const valid = () => active && resolveVisible() && runId === generation && resolveProduct()?.id === product.id && auth.currentUser?.id === userId
    const activeSkus = product.skus.filter((sku) => sku.isActive && sku.isCurrent)
    const sku = resolveSku() ?? (activeSkus.length === 1 ? candidates.value[0] : null)
    const query = { type: 'restock', productId: product.id, ...(sku ? { skuId: sku.id } : {}) }
    if (!sku) {
      await router.push({ path: '/client/feedback/create', query })
      return
    }
    loading.value = true
    await request.runLatest({
      executor: (signal) => getActiveClientRestockRequest(sku.id, { signal }),
      onSuccess: async (result) => {
        if (!valid()) return
        await router.push(result.restock ? `/client/feedback/${result.restock.conversationId}` : { path: '/client/feedback/create', query })
      },
      onError: (error) => { if (!valid()) return; showAppError(extractErrorMessage(error, '查询补货申请失败，请重试')) },
      onFinally: () => { loading.value = false },
    })
  }

  return { loading, restockAvailable, openRestock }
}
