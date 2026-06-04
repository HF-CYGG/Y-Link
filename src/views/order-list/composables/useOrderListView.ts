/**
 * 模块说明：src/views/order-list/composables/useOrderListView.ts
 * 文件职责：集中承载管理端出库单列表页的筛选、分页、详情抽屉、静默自动刷新、上下文保持与新单高亮能力。
 * 实现逻辑：
 * - 使用 `useStableRequest` 统一兜底列表与详情并发，仅允许最后一次有效请求回写页面；
 * - 将“输入中的筛选条件”与“已提交的筛选条件”拆开，避免自动刷新打断用户尚未确认的查询输入；
 * - 静默刷新时仅更新当前页数据，并尽量恢复列表滚动位置、分页、抽屉打开态与当前查看单据；
 * - 当新单进入当前结果集时，仅对新增项做局部插入高亮与轻提示，不触发整页重载或抽屉关闭。
 * 维护说明：
 * - 若后续新增筛选项，需同时补齐默认值、克隆逻辑与 `buildQueryParams()`；
 * - 若调整自动刷新频率，需同时评估详情抽屉静默回写、滚动恢复与高亮动画时长；
 * - 若表格 DOM 结构因组件升级变化，需同步检查桌面端滚动容器选择器是否仍然有效。
 */

import dayjs from 'dayjs'
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, reactive, ref, watch } from 'vue'
import { ElMessageBox } from 'element-plus'
import { useWindowSize } from '@vueuse/core'
import { useRoute, useRouter } from 'vue-router'
import {
  deleteOrderById,
  getOrderDetailById,
  getOrderList,
  purgeOrderById,
  restoreOrderById,
  type OrderDetailResult,
  type OrderListQuery,
  type OrderRecord,
} from '@/api/modules/order'
import { usePermissionAction } from '@/composables/usePermissionAction'
import { useStableRequest } from '@/composables/useStableRequest'
import { useAppStore } from '@/store'
import pinia from '@/store/pinia'
import { extractErrorMessage } from '@/utils/error'
import { applyPaginatedResult, createPaginatedListState } from '@/utils/list'
import { captureOrderRefreshAnchor, restoreOrderRefreshAnchor, type OrderRefreshAnchorSnapshot } from '@/utils/order-refresh-visual'


import { showAppError, showAppSuccess } from '@/utils/app-alert'

const ORDER_LIST_TARGET_ORDER_ID_QUERY_KEY = 'focusOrderId'
const ORDER_LIST_TARGET_ORDER_SHOW_NO_QUERY_KEY = 'focusOrderShowNo'
const ORDER_LIST_TARGET_REFRESH_QUERY_KEY = 'focusRefreshToken'
const ORDER_AUTO_REFRESH_INTERVAL_MS = 15 * 1000
const ORDER_REFRESH_MARK_MS = 3200
const ORDER_REFRESH_NOTICE_MS = 6000
const ORDER_REFRESH_VIEWPORT_TOP_OFFSET = 104

type OrderTypeFilter = 'all' | 'department' | 'walkin'
type OrderDeletionScope = 'active' | 'deleted' | 'all'

interface OrderListSearchFormState {
  keyword: string
  orderType: OrderTypeFilter
  dateRange: [Date, Date] | null
  deletionScope: OrderDeletionScope
}

interface OrderListViewportSnapshot {
  tableScrollTop: number | null
  cardAnchor: OrderRefreshAnchorSnapshot | null
}

interface LoadOrderListOptions {
  silent?: boolean
  preserveScroll?: boolean
  highlightNewOrders?: boolean
}

interface LoadOrderDetailOptions {
  silent?: boolean
}

const createDefaultSearchForm = (): OrderListSearchFormState => ({
  keyword: '',
  orderType: 'all',
  dateRange: null,
  deletionScope: 'active',
})

const cloneSearchDateRange = (value: [Date, Date] | null): [Date, Date] | null => {
  if (!value?.length) {
    return null
  }

  return [new Date(value[0]), new Date(value[1])]
}

const cloneSearchForm = (value: OrderListSearchFormState): OrderListSearchFormState => {
  return {
    keyword: value.keyword,
    orderType: value.orderType,
    dateRange: cloneSearchDateRange(value.dateRange),
    deletionScope: value.deletionScope,
  }
}

const normalizeRouteQueryValue = (value: unknown): string => {
  if (Array.isArray(value)) {
    return String(value[0] ?? '').trim()
  }

  if (value === null || value === undefined) {
    return ''
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim()
  }

  return ''
}

/**
 * 订单列表页业务 composable：
 * - 收拢查询条件、分页、自适应 pageSize 与详情抽屉逻辑；
 * - 保持近期针对日期筛选与分页尺寸的调整不变；
 * - 让页面入口只负责装配筛选区、列表区与详情展示。
 */
export const useOrderListView = () => {
  const route = useRoute()
  const router = useRouter()
  const appStore = useAppStore(pinia)
  const { hasPermission, ensurePermission } = usePermissionAction()
  const isPhone = computed(() => appStore.isPhone)
  const isTablet = computed(() => appStore.isTablet)
  const canViewOrder = computed(() => hasPermission('orders:view'))
  const canDeleteOrder = computed(() => hasPermission('orders:delete'))
  const { height: windowHeight } = useWindowSize()
  const listRequest = useStableRequest()
  const detailRequest = useStableRequest()
  const pageReady = ref(false)
  const pageActive = ref(false)
  const keepAliveActivated = ref(false)
  const processingTargetRefresh = ref(false)
  const listSnapshotReady = ref(false)
  const listBodyRef = ref<HTMLElement | null>(null)
  const silentRefreshing = ref(false)
  const lastAutoRefreshAt = ref(0)
  const newOrderNotice = ref<{ count: number; eventAt: number } | null>(null)
  const recentOrderMarkExpiresAtMap = ref<Record<string, number>>({})
  let autoRefreshTimer: ReturnType<typeof globalThis.setInterval> | null = null
  let refreshMarkCleanupTimer: ReturnType<typeof globalThis.setTimeout> | null = null
  let newOrderNoticeTimer: ReturnType<typeof globalThis.setTimeout> | null = null

  /**
   * 列表分页状态：
   * - loading / records / total 统一集中到 listState；
   * - query 收拢 page / pageSize，避免分页参数散落在多个 ref。
   */
  const listState = reactive(createPaginatedListState<OrderRecord>({
    loading: true,
    query: {
      pageSize: 12,
    },
  }))

  /**
   * 查询表单：
   * - showNo 对应业务单号模糊筛选；
   * - dateRange 保持最近日期筛选交互方式不变。
   */
  const searchForm = ref<OrderListSearchFormState>(createDefaultSearchForm())
  const appliedSearchForm = ref<OrderListSearchFormState>(cloneSearchForm(searchForm.value))

  /**
   * 详情区域卡片网格：
   * - 平板保持双列，手机保持单列；
   * - 避免移动端单条明细卡片被过度压缩。
   */
  const detailGridClass = computed(() => (isTablet.value ? 'sm:grid-cols-2' : 'grid-cols-1'))

  /**
   * 分页栏布局：
   * - 保持 total / sizes / pager / jumper 的既有交互；
   * - 让页面模板只消费统一的布局字符串。
   */
  const paginationLayout = 'total, sizes, prev, pager, next, jumper'

  /**
   * 自适应分页容量：
   * - 根据设备类型与可视高度估算合理 pageSize；
   * - 保留最近对 phone / tablet / desktop 的容量区间调整。
   */
  const adaptivePageSize = computed(() => {
    let reservedHeight = 400
    let itemHeight = 56
    let minSize = 8
    let maxSize = 20

    if (isPhone.value) {
      reservedHeight = 430
      itemHeight = 152
      minSize = 4
      maxSize = 8
    } else if (isTablet.value) {
      reservedHeight = 420
      itemHeight = 160
      minSize = 6
      maxSize = 10
    }

    const columns = isTablet.value ? 2 : 1
    const usableHeight = Math.max(windowHeight.value - reservedHeight, itemHeight)
    const rows = Math.max(1, Math.floor(usableHeight / itemHeight))
    const size = rows * columns
    return Math.min(maxSize, Math.max(minSize, size))
  })

  /**
   * 分页容量选项：
   * - 保留固定常用档位；
   * - 同时注入当前自适应 pageSize，避免下拉项缺失当前值。
   */
  const paginationPageSizes = computed(() => {
    return [...new Set([4, 6, 8, 10, 12, 16, 20, adaptivePageSize.value])].sort((prev, next) => prev - next)
  })

  /**
   * 详情抽屉状态：
   * - drawerVisible 控制抽屉显隐；
   * - drawerLoading 控制详情加载骨架；
   * - currentOrder 保存当前查看的单据详情。
   */
  const drawerVisible = ref(false)
  const drawerLoading = ref(false)
  const currentOrder = ref<OrderDetailResult | null>(null)
  const activeDetailOrderId = ref('')
  const autoRefreshStatusText = computed(() => {
    if (!lastAutoRefreshAt.value) {
      return '自动刷新已开启'
    }

    return `最近同步 ${dayjs(lastAutoRefreshAt.value).format('YYYY-MM-DD HH:mm:ss')}`
  })

  /**
   * 清空当前页面可见数据：
   * - 在无权限或切换会话时避免继续展示上一位用户遗留的列表与详情；
   * - 统一由组合式函数收口，而不是让页面模板自己兜底。
   */
  const resetVisibleData = () => {
    activeDetailOrderId.value = ''
    detailRequest.cancel()
    listRequest.cancel()
    listState.records = []
    listState.total = 0
    currentOrder.value = null
    drawerVisible.value = false
    drawerLoading.value = false
    silentRefreshing.value = false
    listSnapshotReady.value = false
    lastAutoRefreshAt.value = 0
    newOrderNotice.value = null
    recentOrderMarkExpiresAtMap.value = {}
  }

  /**
   * 记录当前筛选快照：
   * - 列表自动刷新只读取“已提交条件”，不读取用户输入中的草稿；
   * - 避免用户还没点“搜索”，后台轮询就提前把草稿条件应用到列表上。
   */
  const commitSearchForm = () => {
    appliedSearchForm.value = cloneSearchForm(searchForm.value)
  }

  const getTargetRefreshPayload = () => {
    const orderId = normalizeRouteQueryValue(route.query[ORDER_LIST_TARGET_ORDER_ID_QUERY_KEY])
    const showNo = normalizeRouteQueryValue(route.query[ORDER_LIST_TARGET_ORDER_SHOW_NO_QUERY_KEY])
    const refreshToken = normalizeRouteQueryValue(route.query[ORDER_LIST_TARGET_REFRESH_QUERY_KEY])

    if (!orderId || !refreshToken) {
      return null
    }

    return {
      orderId,
      showNo,
      refreshToken,
    }
  }

  const clearTargetRefreshQuery = async () => {
    const hasTargetQuery = [ORDER_LIST_TARGET_ORDER_ID_QUERY_KEY, ORDER_LIST_TARGET_ORDER_SHOW_NO_QUERY_KEY, ORDER_LIST_TARGET_REFRESH_QUERY_KEY]
      .some((key) => key in route.query)

    if (!hasTargetQuery) {
      return
    }

    const nextQuery = { ...route.query }
    delete nextQuery[ORDER_LIST_TARGET_ORDER_ID_QUERY_KEY]
    delete nextQuery[ORDER_LIST_TARGET_ORDER_SHOW_NO_QUERY_KEY]
    delete nextQuery[ORDER_LIST_TARGET_REFRESH_QUERY_KEY]

    await router.replace({
      query: nextQuery,
    })
  }

  /**
   * 统一拼装查询参数：
   * - 仅在用户实际填写条件时注入对应字段；
   * - 日期始终格式化为 YYYY-MM-DD，保持后端查询兼容性。
   */
  const buildQueryParams = (): OrderListQuery => {
    const filters = appliedSearchForm.value
    const params: OrderListQuery = {
      page: listState.query.page,
      pageSize: listState.query.pageSize,
    }

    if (filters.keyword) {
      params.keyword = filters.keyword
    }

    if (filters.orderType !== 'all') {
      params.orderType = filters.orderType
    }

    if (filters.dateRange?.length === 2) {
      params.startDate = dayjs(filters.dateRange[0]).format('YYYY-MM-DD')
      params.endDate = dayjs(filters.dateRange[1]).format('YYYY-MM-DD')
    }

    if (canDeleteOrder.value) {
      if (filters.deletionScope === 'deleted') {
        params.onlyDeleted = true
      } else if (filters.deletionScope === 'all') {
        params.includeDeleted = true
      }
    }

    return params
  }

  /**
   * 查找桌面表格真实滚动容器：
   * - Element Plus 表格会把滚动放到内部 body wrapper；
   * - 刷新前后恢复它的 scrollTop，能避免桌面端列表突然跳回顶部。
   */
  const resolveTableScrollContainer = () => {
    if (!listBodyRef.value) {
      return null
    }

    return listBodyRef.value.querySelector<HTMLElement>('.el-table__body-wrapper, .el-scrollbar__wrap')
  }

  /**
   * 捕获当前列表可视上下文：
   * - 桌面端优先记录表格内部滚动条位置；
   * - 移动端卡片列表记录首个可视卡片锚点，刷新后尽量恢复到同一阅读位置。
   */
  const captureListViewportSnapshot = (): OrderListViewportSnapshot | null => {
    if (globalThis.window === undefined || !listBodyRef.value) {
      return null
    }

    return {
      tableScrollTop: resolveTableScrollContainer()?.scrollTop ?? null,
      cardAnchor: captureOrderRefreshAnchor({
        listRoot: listBodyRef.value,
        itemAttributeName: 'data-order-list-item-id',
        visibilityTopOffset: ORDER_REFRESH_VIEWPORT_TOP_OFFSET,
      }),
    }
  }

  const restoreListViewportSnapshot = async (snapshot: OrderListViewportSnapshot | null) => {
    if (!snapshot) {
      return
    }

    await nextTick()

    if (snapshot.tableScrollTop !== null) {
      const tableScrollContainer = resolveTableScrollContainer()
      if (tableScrollContainer) {
        tableScrollContainer.scrollTop = snapshot.tableScrollTop
      }
    }

    restoreOrderRefreshAnchor(snapshot.cardAnchor, {
      listRoot: listBodyRef.value,
      itemAttributeName: 'data-order-list-item-id',
    })
  }

  const scheduleRefreshMarkCleanup = () => {
    if (refreshMarkCleanupTimer !== null) {
      globalThis.clearTimeout(refreshMarkCleanupTimer)
      refreshMarkCleanupTimer = null
    }

    const activeExpiresAtList = Object.values(recentOrderMarkExpiresAtMap.value)
    if (!activeExpiresAtList.length) {
      return
    }

    const nextExpiresAt = Math.min(...activeExpiresAtList)
    const delay = Math.max(0, nextExpiresAt - Date.now() + 32)
    refreshMarkCleanupTimer = globalThis.setTimeout(() => {
      const now = Date.now()
      recentOrderMarkExpiresAtMap.value = Object.fromEntries(
        Object.entries(recentOrderMarkExpiresAtMap.value).filter(([, expiresAt]) => expiresAt > now),
      )
      scheduleRefreshMarkCleanup()
    }, delay)
  }

  const markRecentOrders = (orderIds: string[]) => {
    if (!orderIds.length) {
      return
    }

    const expiresAt = Date.now() + ORDER_REFRESH_MARK_MS
    const nextMarkMap = { ...recentOrderMarkExpiresAtMap.value }
    for (const orderId of orderIds) {
      nextMarkMap[orderId] = expiresAt
    }
    recentOrderMarkExpiresAtMap.value = nextMarkMap
    scheduleRefreshMarkCleanup()
  }

  const dismissNewOrderNotice = () => {
    if (newOrderNoticeTimer !== null) {
      globalThis.clearTimeout(newOrderNoticeTimer)
      newOrderNoticeTimer = null
    }

    newOrderNotice.value = null
  }

  const showNewOrderNotice = (count: number) => {
    if (count <= 0) {
      return
    }

    dismissNewOrderNotice()
    newOrderNotice.value = {
      count,
      eventAt: Date.now(),
    }
    newOrderNoticeTimer = globalThis.setTimeout(() => {
      newOrderNotice.value = null
      newOrderNoticeTimer = null
    }, ORDER_REFRESH_NOTICE_MS)
  }

  const isOrderRecentlyInserted = (orderId: string) => {
    return (recentOrderMarkExpiresAtMap.value[orderId] ?? 0) > Date.now()
  }

  const isOrderDetailActive = (orderId: string) => {
    return activeDetailOrderId.value === orderId && drawerVisible.value
  }

  /**
   * 将详情页里最新的主单摘要回写到当前列表：
   * - 详情自动刷新后，列表中的“带单 / 系统申请 / 删除态”等摘要也要同步更新；
   * - 只更新当前页已存在记录，避免偷偷改动其它分页的数据感知。
   */
  const syncOrderSummaryIntoList = (order: OrderRecord) => {
    const targetIndex = listState.records.findIndex((item) => item.id === order.id)
    if (targetIndex < 0) {
      return
    }

    const nextRecords = listState.records.slice()
    nextRecords[targetIndex] = {
      ...nextRecords[targetIndex],
      ...order,
    }
    listState.records = nextRecords
  }

  /**
   * 加载订单列表：
   * - 根据“已提交筛选”与当前分页状态请求数据；
   * - 静默刷新时只局部回写当前页结果，并尽量恢复滚动位置；
   * - 新单进入当前结果集时，仅做高亮与提示，不额外打断用户当前上下文。
   */
  const loadData = async (options: LoadOrderListOptions = {}) => {
    if (!ensurePermission('orders:view', '出库单查看')) {
      listState.loading = false
      resetVisibleData()
      return
    }

    const silent = options.silent === true
    const previousRecords = listState.records.slice()
    const previousOrderIds = new Set(previousRecords.map((record) => record.id))
    const viewportSnapshot = options.preserveScroll && previousRecords.length > 0
      ? captureListViewportSnapshot()
      : null

    if (silent) {
      silentRefreshing.value = previousRecords.length > 0
    } else {
      listState.loading = true
    }

    await listRequest.runLatest({
      executor: (signal) => getOrderList(buildQueryParams(), { signal }),
      onSuccess: async (result) => {
        applyPaginatedResult(listState, result)

        if (listSnapshotReady.value && options.highlightNewOrders) {
          const incrementalNewOrderIds = listState.records
            .filter((record) => !previousOrderIds.has(record.id))
            .map((record) => record.id)

          if (incrementalNewOrderIds.length) {
            markRecentOrders(incrementalNewOrderIds)
            showNewOrderNotice(incrementalNewOrderIds.length)
          }
        }

        if (viewportSnapshot) {
          await restoreListViewportSnapshot(viewportSnapshot)
        }

        listSnapshotReady.value = true
        if (silent) {
          lastAutoRefreshAt.value = Date.now()
        }
      },
      onError: (error) => {
        if (silent) {
          return
        }

        showAppError(extractErrorMessage(error, '获取单据列表失败'))
      },
      onFinally: () => {
        listState.loading = false
        silentRefreshing.value = false
      },
    })
  }

  /**
   * 加载详情抽屉：
   * - 手动打开时展示骨架并重置旧详情；
   * - 静默刷新时保持抽屉打开与当前内容，只回写最新详情字段。
   */
  const loadOrderDetail = async (row: { id: string }, options: LoadOrderDetailOptions = {}) => {
    if (!ensurePermission('orders:view', '出库单查看')) {
      resetVisibleData()
      return null
    }

    const orderId = row.id
    const silent = options.silent === true
    activeDetailOrderId.value = orderId
    if (!silent) {
      drawerVisible.value = true
      drawerLoading.value = true
      currentOrder.value = null
    }

    let detailResult: OrderDetailResult | null = null

    await detailRequest.runLatest({
      executor: (signal) => getOrderDetailById(row.id, { signal }),
      onSuccess: (result) => {
        if (activeDetailOrderId.value !== orderId) {
          return
        }
        currentOrder.value = result
        syncOrderSummaryIntoList(result)
        detailResult = result
      },
      onError: (error) => {
        if (activeDetailOrderId.value !== orderId) {
          return
        }

        if (silent) {
          return
        }

        showAppError(extractErrorMessage(error, '获取单据详情失败'))
        drawerVisible.value = false
      },
      onFinally: () => {
        if (!silent) {
          drawerLoading.value = false
        }
      },
    })

    return detailResult
  }

  /**
   * 执行搜索：
   * - 搜索条件变化时统一回到第一页；
   * - 再按当前条件重新请求列表。
   */
  const handleSearch = () => {
    commitSearchForm()
    listState.query.page = 1
    void loadData()
  }

  /**
   * 重置筛选：
   * - 恢复默认的业务单号与日期范围；
   * - 保持原先“重置后立即刷新列表”的体验。
   */
  const handleReset = () => {
    searchForm.value = createDefaultSearchForm()
    commitSearchForm()
    listState.query.page = 1
    void loadData()
  }

  /**
   * 分页切换：
   * - 当前页变化时直接按新页码加载；
   * - 与统一分页条 current-change 事件约定保持一致。
   */
  const handleCurrentChange = (value: number) => {
    listState.query.page = value
    void loadData()
  }

  /**
   * 分页容量切换：
   * - 改变 pageSize 后强制回到第一页；
   * - 避免出现页码越界造成的空白列表。
   */
  const handlePageSizeChange = (value: number) => {
    listState.query.pageSize = value
    listState.query.page = 1
    void loadData()
  }

  /**
   * 查看单据详情：
   * - 先打开抽屉并展示 loading；
   * - 请求失败时关闭抽屉，避免留下空壳视图。
   */
  const handleViewDetail = async (row: OrderRecord) => {
    if (!ensurePermission('orders:view', '出库单查看')) {
      resetVisibleData()
      return
    }
    await loadOrderDetail(row)
  }

  /**
   * 删除出库单：
   * - 管理员需输入业务单号完成二次确认；
   * - 删除采用软删除，后续可在“已删除”筛选下恢复。
   */
  const handleDeleteOrder = async (row: OrderRecord, confirmShowNo: string) => {
    if (!ensurePermission('orders:delete', '删除出库单')) {
      return
    }
    await deleteOrderById(row.id, { confirmShowNo })
    showAppSuccess(`已删除单据：${row.showNo}`)
    await loadData()
  }

  /**
   * 删除二次确认：
   * - 管理员需输入完整业务单号，降低误删风险；
   * - 确认后调用软删除接口，单据可在“已删除”或“全部”筛选下找回。
   */
  const handleDeleteOrderWithConfirm = async (row: OrderRecord) => {
    if (!ensurePermission('orders:delete', '删除出库单')) {
      return
    }
    const result = await ElMessageBox.prompt(
      `请输入业务单号 ${row.showNo} 以确认删除。删除后可恢复。`,
      '删除二次确认',
      {
        confirmButtonText: '确认删除',
        cancelButtonText: '取消',
        inputPlaceholder: '请输入完整业务单号',
        inputValue: '',
        inputValidator: (value: string) => {
          if (!String(value || '').trim()) {
            return '请输入业务单号'
          }
          return true
        },
        type: 'warning',
      },
    )
    await handleDeleteOrder(row, result.value.trim())
  }

  /**
   * 恢复出库单：
   * - 仅对已删除单据生效；
   * - 恢复后可在默认列表继续查看详情。
   */
  const handleRestoreOrder = async (row: OrderRecord) => {
    if (!ensurePermission('orders:delete', '恢复出库单')) {
      return
    }
    await restoreOrderById(row.id)
    showAppSuccess(`已恢复单据：${row.showNo}`)
    await loadData()
  }

  /**
   * 恢复确认：
   * - 防止误触恢复；
   * - 恢复成功后刷新当前筛选结果。
   */
  const handleRestoreOrderWithConfirm = async (row: OrderRecord) => {
    if (!ensurePermission('orders:delete', '恢复出库单')) {
      return
    }
    await ElMessageBox.confirm(`确认恢复出库单 ${row.showNo} 吗？`, '恢复确认', {
      confirmButtonText: '确认恢复',
      cancelButtonText: '取消',
      type: 'info',
    })
    await handleRestoreOrder(row)
  }

  /**
   * 永久删除出库单：
   * - 仅对已软删除单据开放，彻底移除主单与明细；
   * - 若命中“最后一个流水号”，后端会同步回拨流水，便于测试场景连续重建首单。
   */
  const handlePurgeOrder = async (row: OrderRecord, confirmShowNo: string) => {
    if (!ensurePermission('orders:delete', '永久删除出库单')) {
      return
    }
    const result = await purgeOrderById(row.id, { confirmShowNo })
    showAppSuccess(
      result.serialRolledBack
        ? `已永久删除单据：${row.showNo}，流水已安全回拨`
        : `已永久删除单据：${row.showNo}`,
    )
    await loadData()
  }

  /**
   * 永久删除二次确认：
   * - 仍要求输入完整业务单号，避免把“测试删库”误点到正式历史单据；
   * - 明确提示该操作不可恢复，并说明只有最后一张单据才会触发安全回拨。
   */
  const handlePurgeOrderWithConfirm = async (row: OrderRecord) => {
    if (!ensurePermission('orders:delete', '永久删除出库单')) {
      return
    }
    const result = await ElMessageBox.prompt(
      `请输入业务单号 ${row.showNo} 以确认永久删除。永久删除后不可恢复；仅当它是当前类型最后一张单据时，流水才会安全回拨。`,
      '永久删除确认',
      {
        confirmButtonText: '确认永久删除',
        cancelButtonText: '取消',
        inputPlaceholder: '请输入完整业务单号',
        inputValue: '',
        inputValidator: (value: string) => {
          if (!String(value || '').trim()) {
            return '请输入业务单号'
          }
          return true
        },
        type: 'warning',
      },
    )
    await handlePurgeOrder(row, result.value.trim())
  }

  const refreshForSubmittedOrder = async () => {
    if (!canViewOrder.value) {
      resetVisibleData()
      return false
    }
    const payload = getTargetRefreshPayload()
    if (!payload || processingTargetRefresh.value) {
      return false
    }

    processingTargetRefresh.value = true

    try {
      listState.query.page = 1
      await loadData({
        highlightNewOrders: true,
      })

      const targetOrder = listState.records.find((record) => record.id === payload.orderId || record.showNo === payload.showNo)
      await loadOrderDetail({
        id: targetOrder?.id ?? payload.orderId,
      })
    } finally {
      processingTargetRefresh.value = false
      await clearTargetRefreshQuery()
    }

    return true
  }

  const initializePageSize = () => {
    if (listState.query.pageSize === adaptivePageSize.value) {
      return
    }

    listState.query.pageSize = adaptivePageSize.value
    listState.query.page = 1
  }

  const refreshListView = async () => {
    const handledSubmittedOrder = await refreshForSubmittedOrder()
    if (handledSubmittedOrder) {
      return
    }

    await loadData()
  }

  const refreshCurrentDetailSilently = async () => {
    if (!drawerVisible.value || !activeDetailOrderId.value) {
      return
    }

    await loadOrderDetail({
      id: activeDetailOrderId.value,
    }, {
      silent: true,
    })
  }

  const canRunAutoRefresh = () => {
    if (!pageReady.value || !pageActive.value || !canViewOrder.value) {
      return false
    }

    if (processingTargetRefresh.value || listState.loading || drawerLoading.value) {
      return false
    }

    if (globalThis.document?.visibilityState === 'hidden') {
      return false
    }

    return true
  }

  const triggerSilentRefresh = async () => {
    if (!canRunAutoRefresh()) {
      return
    }

    await loadData({
      silent: true,
      preserveScroll: true,
      highlightNewOrders: true,
    })
    await refreshCurrentDetailSilently()
  }

  const stopAutoRefresh = () => {
    if (autoRefreshTimer !== null) {
      globalThis.clearInterval(autoRefreshTimer)
      autoRefreshTimer = null
    }
  }

  const scheduleAutoRefresh = () => {
    stopAutoRefresh()
    autoRefreshTimer = globalThis.setInterval(() => {
      void triggerSilentRefresh()
    }, ORDER_AUTO_REFRESH_INTERVAL_MS)
  }

  const handleVisibilityChange = () => {
    if (globalThis.document?.visibilityState === 'visible') {
      void triggerSilentRefresh()
    }
  }

  /**
   * 监听自适应 pageSize：
   * - 仅当实际容量发生变化时才刷新；
   * - 首次进入页面即按当前窗口尺寸初始化分页并拉取数据。
   */
  watch(
    drawerVisible,
    (visible) => {
      if (visible) {
        return
      }

      activeDetailOrderId.value = ''
      detailRequest.cancel()
      drawerLoading.value = false
      currentOrder.value = null
    },
  )

  watch(
    adaptivePageSize,
    (value) => {
      if (!pageReady.value) {
        return
      }

      if (listState.query.pageSize === value) {
        return
      }

      listState.query.pageSize = value
      listState.query.page = 1
      void loadData()
    },
  )

  onMounted(() => {
    initializePageSize()
    pageReady.value = true
    pageActive.value = true
    globalThis.document?.addEventListener('visibilitychange', handleVisibilityChange)
    scheduleAutoRefresh()
    void refreshListView()
  })

  onActivated(() => {
    pageActive.value = true
    scheduleAutoRefresh()
    if (!pageReady.value) {
      return
    }

    if (!keepAliveActivated.value) {
      keepAliveActivated.value = true
      return
    }

    void triggerSilentRefresh()
  })

  onDeactivated(() => {
    pageActive.value = false
    stopAutoRefresh()
  })

  onBeforeUnmount(() => {
    pageActive.value = false
    stopAutoRefresh()
    globalThis.document?.removeEventListener('visibilitychange', handleVisibilityChange)
    if (refreshMarkCleanupTimer !== null) {
      globalThis.clearTimeout(refreshMarkCleanupTimer)
      refreshMarkCleanupTimer = null
    }
    dismissNewOrderNotice()
  })

  return {
    searchForm,
    listState,
    listBodyRef,
    detailGridClass,
    paginationLayout,
    paginationPageSizes,
    drawerVisible,
    drawerLoading,
    currentOrder,
    silentRefreshing,
    autoRefreshStatusText,
    newOrderNotice,
    canDeleteOrder,
    activeDetailOrderId,
    isOrderRecentlyInserted,
    isOrderDetailActive,
    dismissNewOrderNotice,
    handleSearch,
    handleReset,
    handleCurrentChange,
    handlePageSizeChange,
    handleViewDetail,
    handleDeleteOrder,
    handleDeleteOrderWithConfirm,
    handleRestoreOrder,
    handleRestoreOrderWithConfirm,
    handlePurgeOrder,
    handlePurgeOrderWithConfirm,
  }
}
