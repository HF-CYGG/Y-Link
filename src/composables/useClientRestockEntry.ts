/**
 * 模块说明：src/composables/useClientRestockEntry.ts
 * 文件职责：客户端“申请补货”入口的共享逻辑，供商城卡片补货按钮与商品详情底栏复用。
 * 实现逻辑：
 * - 当前启用规格均可申请，资格不受库存或限购约束；详情是否切换缺货动作由商城按真实库存单独判断；
 * - 单规格或已明确选择规格时，先查询该规格是否已有有效补货申请，有则直接进入原会话，无则进入新建表单；
 * - 多规格且未指定规格时直接进入表单，由用户在表单中明确选择；
 * - 请求通过 useStableRequest 收口，商品/规格/账号变化、页面失活或卸载时取消在途请求，防止旧结果跳转串号。
 * 维护说明：
 * - 一个页面只持有一个查询；点击时提供读取当前目标的 getter，规格失效立即取消；
 * - 这里只负责跳转，不修改购物车或库存。
 */
import { onActivated, onBeforeUnmount, onDeactivated, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'

import { getActiveClientRestockRequest } from '@/api/modules/client-restock-query'
import type { O2oMallProduct } from '@/api/modules/o2o'
import { useStableRequest } from '@/composables/useStableRequest'
import { useClientAuthStore } from '@/store'
import pinia from '@/store/pinia'
import { showAppError } from '@/utils/app-alert'
import { extractErrorMessage } from '@/utils/error'
import { getRestockSkus } from '@/utils/restock'

type RestockEntrySource = 'card' | 'detail' | 'batch'
type ResolveRestockTarget = () => { product: O2oMallProduct; skuId?: string } | null

const resolveEligibleTarget = (resolveTarget: ResolveRestockTarget) => {
  const target = resolveTarget()
  if (!target) return null
  const skus = getRestockSkus(target.product)
  if (!skus.length || (target.skuId && !skus.some((sku) => sku.id === target.skuId))) return null
  return { productId: target.product.id, skuId: target.skuId ?? (skus.length === 1 ? skus[0]?.id : undefined) }
}

export const useClientRestockEntry = () => {
  const router = useRouter()
  const auth = useClientAuthStore(pinia)
  const request = useStableRequest()
  const pending = shallowRef<{
    source: RestockEntrySource
    productId: string
    skuId: string
    resolveTarget: ResolveRestockTarget
  } | null>(null)
  let active = true

  const resetPending = () => {
    request.cancel()
    pending.value = null
  }
  const isCurrentTarget = () => {
    const current = pending.value
    if (!current) return false
    const target = resolveEligibleTarget(current.resolveTarget)
    return target?.productId === current.productId && target.skuId === current.skuId
  }
  watch(isCurrentTarget, (valid) => { if (!valid && pending.value) resetPending() }, { flush: 'sync' })
  watch([() => auth.currentUser?.id, () => auth.sessionGeneration], resetPending, { flush: 'sync' })
  onActivated(() => { active = true })
  onDeactivated(() => { active = false; resetPending() })
  onBeforeUnmount(() => { active = false; resetPending() })

  const isLoading = (source: RestockEntrySource, productId: string | undefined) => (
    pending.value?.source === source && pending.value.productId === productId
  )

  const openRestock = async (source: RestockEntrySource, resolveTarget: ResolveRestockTarget) => {
    if (!active || !auth.currentUser?.id) return
    const target = resolveEligibleTarget(resolveTarget)
    if (!target) return
    const { productId, skuId } = target
    if (pending.value?.source === source && pending.value.productId === productId && pending.value.skuId === skuId) return
    resetPending()
    const query = { type: 'restock', productId, ...(skuId ? { skuId } : {}) }
    if (!skuId) {
      await router.push({ path: '/client/feedback/create', query })
      return
    }
    const current = { source, productId, skuId, resolveTarget }
    pending.value = current
    const valid = () => active && pending.value === current && isCurrentTarget()
    await request.runLatest({
      executor: (signal) => getActiveClientRestockRequest(skuId, { signal }),
      onSuccess: async (result) => {
        if (!valid()) return
        await router.push(result.restock ? `/client/feedback/${result.restock.conversationId}` : { path: '/client/feedback/create', query })
      },
      onError: (error) => { if (!valid()) return; showAppError(extractErrorMessage(error, '查询补货申请失败，请重试')) },
      onFinally: () => { if (pending.value === current) pending.value = null },
    })
  }

  return { isLoading, openRestock }
}
