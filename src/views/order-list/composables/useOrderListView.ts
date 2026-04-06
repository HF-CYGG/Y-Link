import dayjs from 'dayjs'
import { computed, onActivated, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useWindowSize } from '@vueuse/core'
import { useRoute, useRouter } from 'vue-router'
import {
  deleteOrderById,
  getOrderDetailById,
  getOrderList,
  restoreOrderById,
  type OrderDetailResult,
  type OrderListQuery,
  type OrderRecord,
} from '@/api/modules/order'
import { useAppStore, useAuthStore } from '@/store'
import { useStableRequest } from '@/composables/useStableRequest'
import { extractErrorMessage } from '@/utils/error'
import { applyPaginatedResult, createPaginatedListState } from '@/utils/list'

const ORDER_LIST_TARGET_ORDER_ID_QUERY_KEY = 'focusOrderId'
const ORDER_LIST_TARGET_ORDER_SHOW_NO_QUERY_KEY = 'focusOrderShowNo'
const ORDER_LIST_TARGET_REFRESH_QUERY_KEY = 'focusRefreshToken'

const normalizeRouteQueryValue = (value: unknown): string => {
  if (Array.isArray(value)) {
    return String(value[0] ?? '').trim()
  }

  if (value === null || value === undefined) {
    return ''
  }

  return String(value).trim()
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
  const appStore = useAppStore()
  const authStore = useAuthStore()
  const isPhone = computed(() => appStore.isPhone)
  const isTablet = computed(() => appStore.isTablet)
  const canDeleteOrder = computed(() => authStore.hasPermission('orders:delete'))
  const { height: windowHeight } = useWindowSize()
  const listRequest = useStableRequest()
  const detailRequest = useStableRequest()
  const pageReady = ref(false)
  const keepAliveActivated = ref(false)
  const processingTargetRefresh = ref(false)

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
  const searchForm = ref({
    showNo: '',
    dateRange: null as [Date, Date] | null,
    deletionScope: 'active' as 'active' | 'deleted' | 'all',
  })

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
    const params: OrderListQuery = {
      page: listState.query.page,
      pageSize: listState.query.pageSize,
    }

    if (searchForm.value.showNo) {
      params.showNo = searchForm.value.showNo
    }

    if (searchForm.value.dateRange?.length === 2) {
      params.startDate = dayjs(searchForm.value.dateRange[0]).format('YYYY-MM-DD')
      params.endDate = dayjs(searchForm.value.dateRange[1]).format('YYYY-MM-DD')
    }

    if (canDeleteOrder.value) {
      if (searchForm.value.deletionScope === 'deleted') {
        params.onlyDeleted = true
      } else if (searchForm.value.deletionScope === 'all') {
        params.includeDeleted = true
      }
    }

    return params
  }

  /**
   * 加载订单列表：
   * - 根据当前筛选与分页状态请求数据；
   * - 成功后回填统一分页状态；
   * - 失败时展示稳定错误消息。
   */
  const loadData = async () => {
    listState.loading = true
    await listRequest.runLatest({
      executor: (signal) => getOrderList(buildQueryParams(), { signal }),
      onSuccess: (result) => {
        applyPaginatedResult(listState, result)
      },
      onError: (error) => {
        ElMessage.error(extractErrorMessage(error, '获取单据列表失败'))
      },
      onFinally: () => {
        listState.loading = false
      },
    })
  }

  const loadOrderDetail = async (orderId: string) => {
    drawerVisible.value = true
    drawerLoading.value = true
    currentOrder.value = null

    let detailResult: OrderDetailResult | null = null

    await detailRequest.runLatest({
      executor: (signal) => getOrderDetailById(orderId, { signal }),
      onSuccess: (result) => {
        currentOrder.value = result
        detailResult = result
      },
      onError: (error) => {
        ElMessage.error(extractErrorMessage(error, '获取单据详情失败'))
        drawerVisible.value = false
      },
      onFinally: () => {
        drawerLoading.value = false
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
    listState.query.page = 1
    void loadData()
  }

  /**
   * 重置筛选：
   * - 恢复默认的业务单号与日期范围；
   * - 保持原先“重置后立即刷新列表”的体验。
   */
  const handleReset = () => {
    searchForm.value = {
      showNo: '',
      dateRange: null,
      deletionScope: 'active',
    }
    handleSearch()
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
    drawerVisible.value = true
    drawerLoading.value = true
    currentOrder.value = null

    await detailRequest.runLatest({
      executor: (signal) => getOrderDetailById(row.id, { signal }),
      onSuccess: (result) => {
        currentOrder.value = result
      },
      onError: (error) => {
        ElMessage.error(extractErrorMessage(error, '获取单据详情失败'))
        drawerVisible.value = false
      },
      onFinally: () => {
        drawerLoading.value = false
      },
    })
  }

  /**
   * 删除出库单：
   * - 管理员需输入业务单号完成二次确认；
   * - 删除采用软删除，后续可在“已删除”筛选下恢复。
   */
  const handleDeleteOrder = async (row: OrderRecord, confirmShowNo: string) => {
    await deleteOrderById(row.id, { confirmShowNo })
    ElMessage.success(`已删除单据：${row.showNo}`)
    await loadData()
  }

  /**
   * 删除二次确认：
   * - 管理员需输入完整业务单号，降低误删风险；
   * - 确认后调用软删除接口，单据可在“已删除”或“全部”筛选下找回。
   */
  const handleDeleteOrderWithConfirm = async (row: OrderRecord) => {
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
    await restoreOrderById(row.id)
    ElMessage.success(`已恢复单据：${row.showNo}`)
    await loadData()
  }

  /**
   * 恢复确认：
   * - 防止误触恢复；
   * - 恢复成功后刷新当前筛选结果。
   */
  const handleRestoreOrderWithConfirm = async (row: OrderRecord) => {
    await ElMessageBox.confirm(`确认恢复出库单 ${row.showNo} 吗？`, '恢复确认', {
      confirmButtonText: '确认恢复',
      cancelButtonText: '取消',
      type: 'info',
    })
    await handleRestoreOrder(row)
  }

  const refreshForSubmittedOrder = async () => {
    const payload = getTargetRefreshPayload()
    if (!payload || processingTargetRefresh.value) {
      return false
    }

    processingTargetRefresh.value = true

    try {
      listState.query.page = 1
      await loadData()

      const targetOrder = listState.records.find((record) => record.id === payload.orderId || record.showNo === payload.showNo)
      await loadOrderDetail(targetOrder?.id ?? payload.orderId)
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

  /**
   * 监听自适应 pageSize：
   * - 仅当实际容量发生变化时才刷新；
   * - 首次进入页面即按当前窗口尺寸初始化分页并拉取数据。
   */
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
    void refreshListView()
  })

  onActivated(() => {
    if (!pageReady.value) {
      return
    }

    if (!keepAliveActivated.value) {
      keepAliveActivated.value = true
      return
    }

    void refreshListView()
  })

  return {
    searchForm,
    listState,
    detailGridClass,
    paginationLayout,
    paginationPageSizes,
    drawerVisible,
    drawerLoading,
    currentOrder,
    canDeleteOrder,
    handleSearch,
    handleReset,
    handleCurrentChange,
    handlePageSizeChange,
    handleViewDetail,
    handleDeleteOrder,
    handleDeleteOrderWithConfirm,
    handleRestoreOrder,
    handleRestoreOrderWithConfirm,
  }
}
