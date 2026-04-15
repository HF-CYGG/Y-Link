/**
 * 模块说明：src/store/modules/client-order.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { O2oPreorderSummary } from '@/api/modules/o2o'
import { persistClientOrderSnapshot, readPersistedClientOrderSnapshot } from '@/utils/client-order-storage'

// 订单列表缓存时间比商品目录更短：
// 用户对“待提货 / 已核销 / 已取消”状态变化更敏感，需要更快看到最新状态。
const CLIENT_ORDER_CACHE_TTL_MS = 3 * 60 * 1000

export const useClientOrderStore = defineStore('client-order', () => {
  const orders = ref<O2oPreorderSummary[]>([])
  const activeStatus = ref<'all' | O2oPreorderSummary['status']>('all')
  const updatedAt = ref(0)
  const initialized = ref(false)

  const isFresh = computed(() => Date.now() - updatedAt.value <= CLIENT_ORDER_CACHE_TTL_MS)

  const persist = () => {
    // 除订单列表本身外，还同步记录当前筛选状态，保证用户返回订单页时仍停留在上次查看的标签。
    persistClientOrderSnapshot({
      activeStatus: activeStatus.value,
      orders: orders.value,
      updatedAt: updatedAt.value,
    })
  }

  const initialize = () => {
    if (initialized.value) {
      return
    }
    const snapshot = readPersistedClientOrderSnapshot()
    if (snapshot) {
      // 初始化只负责恢复快照，不主动发起请求；页面层可根据 isFresh 决定是否刷新。
      orders.value = snapshot.orders
      activeStatus.value = snapshot.activeStatus
      updatedAt.value = snapshot.updatedAt
    }
    initialized.value = true
  }

  const setOrders = (nextOrders: O2oPreorderSummary[]) => {
    orders.value = nextOrders
    // 每次订单列表更新都刷新时间戳，为“订单页回到前台是否立即重拉”提供依据。
    updatedAt.value = Date.now()
    persist()
  }

  const setActiveStatus = (status: 'all' | O2oPreorderSummary['status']) => {
    activeStatus.value = status
    persist()
  }

  const upsertOrder = (nextOrder: O2oPreorderSummary) => {
    const index = orders.value.findIndex((item) => item.id === nextOrder.id)
    if (index < 0) {
      // 新订单或详情页首次打开后同步回列表缓存，统一插入顶部便于用户立即看到结果。
      orders.value = [nextOrder, ...orders.value]
    } else {
      const nextOrders = orders.value.slice()
      nextOrders[index] = {
        ...nextOrders[index],
        ...nextOrder,
      }
      orders.value = nextOrders
    }
    updatedAt.value = Date.now()
    persist()
  }

  return {
    orders,
    activeStatus,
    updatedAt,
    initialized,
    isFresh,
    initialize,
    setOrders,
    setActiveStatus,
    upsertOrder,
  }
})
