/**
 * 模块说明：src/store/modules/client-order.ts
 * 文件职责：维护客户端“我的订单”列表的内存态、按账号隔离缓存与分页查询上下文。
 * 实现逻辑：
 * - 订单缓存按 `clientUserId` 绑定，账号切换时立即清空旧内存态并读取新账号快照，避免串号；
 * - Store 同步保存状态筛选、关键词、当前页、总数与最后更新时间，供订单列表页和详情页共享；
 * - 页面层可基于 `isFresh` 判断是否直接使用缓存，或在展示旧内容的同时发起后台刷新。
 * 维护说明：
 * - 若订单列表查询条件继续扩展，需要同时补齐 `persist()` 与 `initialize()` 的快照字段；
 * - 详情页与列表页收到单条订单变更时会复用 `syncOrderSummary()`，因此新增摘要字段时也要同步合并策略。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { O2oPreorderSummary } from '@/api/modules/o2o'
import {
  clearPersistedClientOrderSnapshot,
  persistClientOrderSnapshot,
  readPersistedClientOrderSnapshot,
} from '@/utils/client-order-storage'
import { matchesClientOrderQuery } from '@/utils/client-order-summary'

// 订单列表缓存时间比商品目录更短：
// 用户对“待提货 / 已核销 / 已取消”状态变化更敏感，需要更快看到最新状态。
const CLIENT_ORDER_CACHE_TTL_MS = 3 * 60 * 1000
let hasWarnedUnexpectedClientUserIdType = false

const isSupportedClientUserIdType = (value: unknown): boolean => {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
}

const normalizeClientUserId = (value: unknown): string => {
  if (typeof value === 'string') {
    return value.trim()
  }
  // 防御性日志：
  // 订单缓存初始化允许 string 与 number 两种 userId 形态；
  // 仅当出现“非空且不在兼容范围内”的值时，记录一次告警便于追源。
  if (
    value !== null &&
    value !== undefined &&
    !isSupportedClientUserIdType(value) &&
    !hasWarnedUnexpectedClientUserIdType
  ) {
    hasWarnedUnexpectedClientUserIdType = true
    console.warn('[client-order] initialize 收到异常类型 clientUserId，已按兼容逻辑归一化处理。', {
      value,
      valueType: typeof value,
    })
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value).trim()
  }
  return ''
}

export const useClientOrderStore = defineStore('client-order', () => {
  const clientUserId = ref('')
  const orders = ref<O2oPreorderSummary[]>([])
  const activeStatus = ref<'all' | O2oPreorderSummary['status']>('all')
  const keyword = ref('')
  const page = ref(1)
  const pageSize = ref(20)
  const total = ref(0)
  const updatedAt = ref(0)
  const initialized = ref(false)

  const isFresh = computed(() => Date.now() - updatedAt.value <= CLIENT_ORDER_CACHE_TTL_MS)

  const resetState = () => {
    orders.value = []
    activeStatus.value = 'all'
    keyword.value = ''
    page.value = 1
    pageSize.value = 20
    total.value = 0
    updatedAt.value = 0
  }

  const persist = (options?: { includeOrders?: boolean }) => {
    if (!clientUserId.value) {
      return
    }
    // 除订单列表本身外，还同步记录当前筛选状态，保证用户返回订单页时仍停留在上次查看的标签。
    persistClientOrderSnapshot(clientUserId.value, {
      activeStatus: activeStatus.value,
      keyword: keyword.value,
      orders: orders.value,
      page: page.value,
      pageSize: pageSize.value,
      total: total.value,
      updatedAt: updatedAt.value,
    }, options)
  }

  // 详细注释：
  // - 订单缓存需要显式绑定当前 clientUserId；
  // - 同一浏览器切换账号时，先清空旧内存态，再尝试恢复新账号自己的快照；
  // - 若未传账号，直接回到空态，防止未登录状态还残留上一个账号的订单。
  const initialize = (nextClientUserId: string | number | null | undefined) => {
    const normalizedClientUserId = normalizeClientUserId(nextClientUserId)
    if (!normalizedClientUserId) {
      clientUserId.value = ''
      resetState()
      initialized.value = true
      return
    }

    const switchedUser = clientUserId.value !== normalizedClientUserId
    if (initialized.value && !switchedUser) {
      return
    }

    clientUserId.value = normalizedClientUserId
    resetState()

    const snapshot = readPersistedClientOrderSnapshot(normalizedClientUserId)
    if (snapshot) {
      // 初始化只负责恢复快照，不主动发起请求；页面层可根据 isFresh 决定是否刷新。
      orders.value = snapshot.orders
      activeStatus.value = snapshot.activeStatus
      keyword.value = snapshot.keyword
      page.value = snapshot.page
      pageSize.value = snapshot.pageSize
      total.value = snapshot.total
      updatedAt.value = snapshot.updatedAt
    }
    initialized.value = true
  }

  const setOrders = (
    nextOrders: O2oPreorderSummary[],
    payload?: {
      page?: number
      pageSize?: number
      total?: number
    },
  ) => {
    orders.value = nextOrders
    // 每次订单列表更新都刷新时间戳，为“订单页回到前台是否立即重拉”提供依据。
    page.value = payload?.page ?? 1
    pageSize.value = payload?.pageSize ?? pageSize.value
    total.value = payload?.total ?? nextOrders.length
    updatedAt.value = Date.now()
    persist()
  }

  const appendOrders = (
    nextOrders: O2oPreorderSummary[],
    payload: {
      page: number
      pageSize: number
      total: number
    },
  ) => {
    const existedOrderIdSet = new Set(orders.value.map((item) => item.id))
    const mergedOrders = [
      ...orders.value,
      ...nextOrders.filter((item) => !existedOrderIdSet.has(item.id)),
    ]
    orders.value = mergedOrders
    page.value = payload.page
    pageSize.value = payload.pageSize
    total.value = payload.total
    updatedAt.value = Date.now()
    persist()
  }

  const setActiveStatus = (status: 'all' | O2oPreorderSummary['status']) => {
    if (activeStatus.value === status) {
      return
    }
    activeStatus.value = status
    // 详细注释：切换筛选标签只会改变查询上下文，不需要把整份订单数组再次重写到 localStorage。
    persist({ includeOrders: false })
  }

  const setKeyword = (nextKeyword: string) => {
    const normalizedKeyword = nextKeyword.trim()
    if (keyword.value === normalizedKeyword) {
      return
    }
    keyword.value = normalizedKeyword
    // 详细注释：关键词输入在弱网和高频搜索下会频繁变化，只持久化 meta 可显著降低同步写入成本。
    persist({ includeOrders: false })
  }

  const markStale = () => {
    if (updatedAt.value === 0) {
      return
    }
    updatedAt.value = 0
    persist({ includeOrders: false })
  }

  const finalizeLocalSync = (preserveFresh?: boolean) => {
    updatedAt.value = preserveFresh ? Date.now() : 0
    persist()
  }

  const upsertOrder = (nextOrder: O2oPreorderSummary, options?: { preserveFresh?: boolean }) => {
    const index = orders.value.findIndex((item) => item.id === nextOrder.id)
    if (index < 0) {
      // 新订单或详情页首次打开后同步回列表缓存，统一插入顶部便于用户立即看到结果。
      orders.value = [nextOrder, ...orders.value]
      total.value = Math.max(total.value, orders.value.length)
    } else {
      const nextOrders = orders.value.slice()
      nextOrders[index] = {
        ...nextOrders[index],
        ...nextOrder,
      }
      orders.value = nextOrders
    }
    finalizeLocalSync(options?.preserveFresh)
  }

  const removeOrder = (orderId: string, options?: { preserveFresh?: boolean }) => {
    const existedOrderCount = orders.value.length
    orders.value = orders.value.filter((item) => item.id !== orderId)
    if (orders.value.length === existedOrderCount) {
      return
    }
    total.value = Math.max(0, total.value - 1)
    finalizeLocalSync(options?.preserveFresh)
  }

  const syncOrderSummary = (nextOrder: O2oPreorderSummary, options?: { preserveFresh?: boolean }) => {
    const matchesCurrentQuery = matchesClientOrderQuery(nextOrder, {
      activeStatus: activeStatus.value,
      keyword: keyword.value,
    })
    if (!matchesCurrentQuery) {
      removeOrder(nextOrder.id, options)
      return
    }
    upsertOrder(nextOrder, options)
  }

  const clearAll = (options?: { clearPersisted?: boolean }) => {
    const currentClientUserId = clientUserId.value
    resetState()
    clientUserId.value = ''
    initialized.value = false
    if (options?.clearPersisted !== false && currentClientUserId) {
      clearPersistedClientOrderSnapshot(currentClientUserId)
    }
  }

  return {
    clientUserId,
    orders,
    activeStatus,
    keyword,
    page,
    pageSize,
    total,
    updatedAt,
    initialized,
    isFresh,
    initialize,
    setOrders,
    appendOrders,
    setActiveStatus,
    setKeyword,
    markStale,
    upsertOrder,
    removeOrder,
    syncOrderSummary,
    clearAll,
  }
})
