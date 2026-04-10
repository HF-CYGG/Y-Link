import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { O2oPreorderSummary } from '@/api/modules/o2o'
import { persistClientOrderSnapshot, readPersistedClientOrderSnapshot } from '@/utils/client-order-storage'

const CLIENT_ORDER_CACHE_TTL_MS = 3 * 60 * 1000

export const useClientOrderStore = defineStore('client-order', () => {
  const orders = ref<O2oPreorderSummary[]>([])
  const activeStatus = ref<'all' | O2oPreorderSummary['status']>('all')
  const updatedAt = ref(0)
  const initialized = ref(false)

  const isFresh = computed(() => Date.now() - updatedAt.value <= CLIENT_ORDER_CACHE_TTL_MS)

  const persist = () => {
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
      orders.value = snapshot.orders
      activeStatus.value = snapshot.activeStatus
      updatedAt.value = snapshot.updatedAt
    }
    initialized.value = true
  }

  const setOrders = (nextOrders: O2oPreorderSummary[]) => {
    orders.value = nextOrders
    updatedAt.value = Date.now()
    persist()
  }

  const setActiveStatus = (status: 'all' | O2oPreorderSummary['status']) => {
    activeStatus.value = status
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
  }
})
