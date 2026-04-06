import dayjs from 'dayjs'
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useWindowSize } from '@vueuse/core'
import {
  getOrderDetailById,
  getOrderList,
  type OrderDetailResult,
  type OrderListQuery,
  type OrderRecord,
} from '@/api/modules/order'
import { useAppStore } from '@/store'
import { useStableRequest } from '@/composables/useStableRequest'
import { extractErrorMessage } from '@/utils/error'
import { applyPaginatedResult, createPaginatedListState } from '@/utils/list'

/**
 * 订单列表页业务 composable：
 * - 收拢查询条件、分页、自适应 pageSize 与详情抽屉逻辑；
 * - 保持近期针对日期筛选与分页尺寸的调整不变；
 * - 让页面入口只负责装配筛选区、列表区与详情展示。
 */
export const useOrderListView = () => {
  const appStore = useAppStore()
  const isPhone = computed(() => appStore.isPhone)
  const isTablet = computed(() => appStore.isTablet)
  const { height: windowHeight } = useWindowSize()
  const listRequest = useStableRequest()
  const detailRequest = useStableRequest()

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
   * 监听自适应 pageSize：
   * - 仅当实际容量发生变化时才刷新；
   * - 首次进入页面即按当前窗口尺寸初始化分页并拉取数据。
   */
  watch(
    adaptivePageSize,
    (value) => {
      if (listState.query.pageSize === value) {
        return
      }

      listState.query.pageSize = value
      listState.query.page = 1
      void loadData()
    },
    { immediate: true },
  )

  return {
    searchForm,
    listState,
    detailGridClass,
    paginationLayout,
    paginationPageSizes,
    drawerVisible,
    drawerLoading,
    currentOrder,
    handleSearch,
    handleReset,
    handleCurrentChange,
    handlePageSizeChange,
    handleViewDetail,
  }
}
