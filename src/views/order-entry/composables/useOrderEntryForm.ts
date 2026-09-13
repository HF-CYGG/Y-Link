/**
 * 模块说明：src/views/order-entry/composables/useOrderEntryForm.ts
 * 文件职责：集中管理出库开单页的主单、明细、草稿恢复与提交逻辑。
 * 实现逻辑：
 * 1. 使用一个组合式函数统一管理页面全部响应式状态，避免多个组件重复维护业务字段；
 * 2. 提交前在这里完成校验、数据清洗与接口参数组装；
 * 3. 针对“正式出库单只给部门单”规则，在此做最终提交兜底，确保散客单不会误传相关状态。
 */

import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'

import { useRouter } from 'vue-router'
import { orderApi, productApi } from '@/api'
import type { OrderDepartmentOption, SubmitOrderPayload } from '@/api/modules/order'
import type { ProductRecord } from '@/api/modules/product'
import { useAppStore, useAuthStore } from '@/store'
import pinia from '@/store/pinia'
import { extractErrorMessage } from '@/utils/error'
import { showCriticalErrorDialog } from '@/utils/error-dialog'
import {
  clearLegacyScopedStorageKey,
  getBrowserStorage,
  resolveUserScopedStorageKey,
} from '@/utils/storage-user-scope'
import {
  getSelectableProductSkus,
  resolveLegacyOrderEntryProductValue,
  type FocusField,
  type OrderEntryDrawerForm,
  type OrderHeaderForm,
  type OrderItemRow,
} from '../types'


import { showAppError, showAppSuccess, showAppWarning } from '@/utils/app-alert'

/**
 * 数值归一化：
 * - 将 null / NaN / 非有限数字统一归 0；
 * - 作为 composable 外层纯函数，避免在每次组合函数实例化时重复创建。
 */
function normalizeNumber(value: number | string | null | undefined): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * 金额格式化：
 * - 所有金额统一输出两位小数；
 * - 作为外层工具函数复用，减少闭包内部重复定义。
 */
function toMoney(value: number): string {
  return value.toFixed(2)
}

function normalizeTextValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return ''
  }

  return String(value).trim()
}

/**
 * 订单录入页业务编排 composable：
 * - 收拢产品加载、明细编辑、键盘流与提交逻辑；
 * - 让页面入口只负责装配头部/明细/汇总展示单元；
 * - 保持现有桌面表格、移动端卡片与抽屉编辑体验不变。
 */
export const useOrderEntryForm = () => {
  const appStore = useAppStore(pinia)
  const authStore = useAuthStore(pinia)
  const router = useRouter()
  const ORDER_ENTRY_DRAFT_STORAGE_KEY_PREFIX = 'y-link.order-entry.draft.v1'
  const LEGACY_ORDER_ENTRY_DRAFT_STORAGE_KEY = 'y-link.order-entry.draft.v1'
  const defaultIssuerName = computed(() => {
    return authStore.currentUser?.displayName || authStore.currentUser?.username || ''
  })

  interface OrderEntryDraftSnapshot {
    headerForm: OrderHeaderForm
    itemRows: OrderItemRow[]
    drawerVisible: boolean
    editingRowUid: string
    drawerForm: OrderEntryDrawerForm
  }

  /**
   * 主单信息：
   * - 仅维护客户名称与整单备注；
   * - 作为多个展示组件共享的响应式表单模型。
   */
  const headerForm = reactive<OrderHeaderForm>({
    orderType: 'walkin',
    hasCustomerOrder: false,
    isSystemApplied: false,
    issuerName: defaultIssuerName.value,
    customerDepartmentName: '',
    customerDepartmentNodeId: '',
    customerName: '',
    remark: '',
  })

  /**
   * 明细与产品数据源：
   * - itemRows 保存用户当前录入的所有明细；
   * - products 只保存当前启用且至少有一个可选 SKU 的产品，供选择与自动带价使用。
   */
  const itemRows = ref<OrderItemRow[]>([])
  const products = ref<ProductRecord[]>([])

  /**
   * 交互状态：
   * - productsLoading 控制产品骨架；
   * - productCandidatesReady 标记候选已成功加载，避免加载失败时覆盖恢复草稿；
   * - isSaving 防止重复提交；
   * - deletingRowUids 用于列表删除过渡动画。
   */
  const productsLoading = ref(false)
  const productCandidatesReady = ref(false)
  /**
   * 客户部门选项：
   * - 来自系统部门配置的只读快照，加载失败时不阻断开单，控件退化为纯手动录入；
   * - customerDepartmentNodeId 始终由“当前部门名 + 选项”推导，不依赖草稿中保存的节点。
   */
  const departmentOptions = ref<OrderDepartmentOption[]>([])
  const departmentOptionsLoading = ref(false)
  const departmentOptionsLoadFailed = ref(false)
  const isSaving = ref(false)
  const deletingRowUids = ref<string[]>([])

  /**
   * 移动端抽屉编辑状态：
   * - editingRowUid 指向当前正在编辑的行；
   * - drawerForm 作为编辑草稿，点击应用后再统一回写。
   */
  const drawerVisible = ref(false)
  const editingRowUid = ref('')
  const drawerForm = reactive<OrderEntryDrawerForm>({
    productId: '',
    skuId: '',
    qty: null,
    unitPrice: null,
    remark: '',
  })

  /**
   * 桌面端键盘流缓存：
   * - 通过 uid + field 组合键保存单元格实例；
   * - 支持 Enter / Tab 在整张录入网格中顺序跳转。
   */
  const fieldRefMap = new Map<string, unknown>()
  const focusFieldOrder: FocusField[] = ['product', 'sku', 'qty', 'unitPrice', 'remark']
  const draftPersistenceReady = ref(false)

  /**
   * 设备模式：
   * - desktop 使用表格输入；
   * - tablet / phone 使用卡片 + 抽屉；
   * - 保留近期针对平板双列与手机单列的布局差异。
   */
  const isPhone = computed(() => appStore.isPhone)
  const isTablet = computed(() => appStore.isTablet)
  const isDesktop = computed(() => appStore.isDesktop)
  const cardListClass = computed(() => (isTablet.value ? 'sm:grid-cols-2' : 'grid-cols-1'))
  const drawerDirection = computed(() => (isPhone.value ? 'btt' : 'rtl'))
  const drawerSize = computed(() => {
    if (isPhone.value) {
      return '80%'
    }

    if (isTablet.value) {
      return '68%'
    }

    return '560px'
  })
  const detailModeLabel = computed(() => {
    if (isDesktop.value) {
      return '桌面表格'
    }

    if (isTablet.value) {
      return '平板卡片'
    }

    return '手机卡片'
  })

  /**
   * 产品映射：
   * - 让产品主键到对象的查找保持 O(1)；
   * - 同时服务默认单价带出与卡片名称展示。
   */
  const productMap = computed(() => {
    return new Map(products.value.map((item) => [item.id, item]))
  })

  const getSelectableSkus = (productId: string) => {
    return getSelectableProductSkus(productMap.value.get(productId))
  }

  const getSkuLabelById = (productId: string, skuId: string): string => {
    if (!skuId) {
      return '未选择规格'
    }
    const sku = getSelectableSkus(productId).find((item) => item.id === skuId)
    return sku?.specText || '未选择规格'
  }

  /**
   * 汇总信息：
   * - totalQty 汇总所有明细数量；
   * - totalAmount 汇总所有行金额；
   * - 始终基于统一数值归一化工具计算，避免 null / NaN 污染。
   */
  const totalQty = computed(() => {
    return itemRows.value.reduce((sum, row) => sum + normalizeNumber(row.qty), 0)
  })
  const totalAmount = computed(() => {
    return itemRows.value.reduce((sum, row) => sum + calcLineAmount(row), 0)
  })

  /**
   * 提交前有效明细：
   * - 仅保留已选择产品且数量大于 0 的行；
   * - 单价为空时按 0 补齐，保证提交参数结构稳定。
   */
  const validSubmitItems = computed<SubmitOrderPayload['items']>(() => {
    return itemRows.value
      .filter((row) => normalizeTextValue(row.productId) && normalizeNumber(row.qty) > 0)
      .map((row) => ({
        productId: normalizeTextValue(row.productId),
        skuId: normalizeTextValue(row.skuId) || undefined,
        qty: normalizeNumber(row.qty),
        unitPrice: normalizeNumber(row.unitPrice),
        remark: row.remark.trim() || undefined,
      }))
  })

  /**
   * 生成前端明细行唯一键：
   * - 不参与后端提交；
   * - 仅用于渲染、焦点控制与删除动画定位。
   */
  const createRowUid = () => `row-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  /**
   * 创建空白明细：
   * - 统一所有新增行与重置后的初始值；
   * - 避免不同入口创建出的默认结构不一致。
   */
  const createBlankRow = (): OrderItemRow => ({
    uid: createRowUid(),
    productId: '',
    skuId: '',
    qty: null,
    unitPrice: null,
    remark: '',
  })

  /**
   * 获取当前管理员的草稿存储上下文：
   * - 使用 sessionStorage 保留“当前浏览器会话内”的录入草稿；
   * - 同时清理历史全局 key，避免旧版本未分账号的草稿继续污染当前账号。
   */
  const resolveDraftStorageContext = () => {
    const storage = getBrowserStorage('session')
    if (!storage) {
      return {
        storage: null,
        storageKey: null,
      }
    }

    clearLegacyScopedStorageKey(storage, LEGACY_ORDER_ENTRY_DRAFT_STORAGE_KEY)
    return {
      storage,
      storageKey: resolveUserScopedStorageKey(ORDER_ENTRY_DRAFT_STORAGE_KEY_PREFIX, authStore.currentUser?.id),
    }
  }

  /**
   * 构建当前草稿快照：
   * - 仅保存录入页真实需要恢复的数据；
   * - 使用深拷贝后的普通对象，避免把 Vue 响应式代理直接写入 sessionStorage。
   */
  const buildDraftSnapshot = (): OrderEntryDraftSnapshot => ({
    headerForm: {
      orderType: headerForm.orderType,
      hasCustomerOrder: headerForm.hasCustomerOrder,
      isSystemApplied: headerForm.isSystemApplied,
      issuerName: headerForm.issuerName,
      customerDepartmentName: headerForm.customerDepartmentName,
      customerDepartmentNodeId: headerForm.customerDepartmentNodeId,
      customerName: headerForm.customerName,
      remark: headerForm.remark,
    },
    itemRows: itemRows.value.map((row) => ({
      uid: row.uid,
      productId: row.productId,
      skuId: row.skuId,
      qty: row.qty,
      unitPrice: row.unitPrice,
      remark: row.remark,
    })),
    drawerVisible: drawerVisible.value,
    editingRowUid: editingRowUid.value,
    drawerForm: {
      productId: drawerForm.productId,
      skuId: drawerForm.skuId,
      qty: drawerForm.qty,
      unitPrice: drawerForm.unitPrice,
      remark: drawerForm.remark,
    },
  })

  /**
   * 写入录入草稿：
   * - 使用 sessionStorage 保留“临时切页后返回”的输入状态；
   * - 仅在浏览器环境且持久化开关就绪后执行，避免初始化阶段把空白态覆盖到草稿。
   */
  const persistDraft = () => {
    if (!draftPersistenceReady.value || !productCandidatesReady.value) {
      return
    }

    const { storage, storageKey } = resolveDraftStorageContext()
    if (!storage || !storageKey) {
      return
    }

    storage.setItem(storageKey, JSON.stringify(buildDraftSnapshot()))
  }

  /**
   * 读取并恢复录入草稿：
   * - 只恢复结构完整的草稿，损坏数据直接忽略；
   * - 若草稿不存在或解析失败，则回退为全新空白录入状态。
   */
  const restoreDraft = (): boolean => {
    const { storage, storageKey } = resolveDraftStorageContext()
    if (!storage || !storageKey) {
      return false
    }

    const rawDraft = storage.getItem(storageKey)
    if (!rawDraft) {
      return false
    }

    try {
      const parsedDraft = JSON.parse(rawDraft) as Partial<OrderEntryDraftSnapshot> | null
      if (!parsedDraft || !Array.isArray(parsedDraft.itemRows) || !parsedDraft.headerForm || !parsedDraft.drawerForm) {
        return false
      }

      headerForm.orderType = parsedDraft.headerForm.orderType === 'department' ? 'department' : 'walkin'
      headerForm.hasCustomerOrder = Boolean(parsedDraft.headerForm.hasCustomerOrder)
      headerForm.isSystemApplied = Boolean(parsedDraft.headerForm.isSystemApplied)
      headerForm.issuerName = parsedDraft.headerForm.issuerName ?? defaultIssuerName.value
      headerForm.customerDepartmentName = parsedDraft.headerForm.customerDepartmentName ?? ''
      headerForm.customerName = parsedDraft.headerForm.customerName ?? ''
      headerForm.remark = parsedDraft.headerForm.remark ?? ''

      itemRows.value = parsedDraft.itemRows.length
        ? parsedDraft.itemRows.map((row) => ({
            uid: row.uid || createRowUid(),
            productId: row.productId ?? '',
            skuId: row.skuId ?? '',
            qty: typeof row.qty === 'number' ? row.qty : null,
            unitPrice: typeof row.unitPrice === 'number' ? row.unitPrice : null,
            remark: row.remark ?? '',
          }))
        : [createBlankRow()]

      editingRowUid.value = parsedDraft.editingRowUid ?? ''
      const hasEditingRow = itemRows.value.some((row) => row.uid === editingRowUid.value)
      drawerVisible.value = Boolean(parsedDraft.drawerVisible && hasEditingRow)
      if (!hasEditingRow) {
        editingRowUid.value = ''
      }
      drawerForm.productId = parsedDraft.drawerForm.productId ?? ''
      drawerForm.skuId = parsedDraft.drawerForm.skuId ?? ''
      drawerForm.qty = typeof parsedDraft.drawerForm.qty === 'number' ? parsedDraft.drawerForm.qty : null
      drawerForm.unitPrice = typeof parsedDraft.drawerForm.unitPrice === 'number' ? parsedDraft.drawerForm.unitPrice : null
      drawerForm.remark = parsedDraft.drawerForm.remark ?? ''
      return true
    } catch {
      storage.removeItem(storageKey)
      return false
    }
  }

  /**
   * 计算单行金额：
   * - 采用数量 * 单价；
   * - 统一固定两位后再转回 number，避免浮点噪音扩散到汇总结果。
   */
  function calcLineAmount(row: OrderItemRow): number {
    return Number((normalizeNumber(row.qty) * normalizeNumber(row.unitPrice)).toFixed(2))
  }

  /**
   * 根据产品主键获取展示名称：
   * - 已存在产品显示产品名；
   * - 旧草稿中的未知或失效值显示为不可用商品；
   * - 空值场景显示未选择。
   */
  const getProductLabelById = (productId: string): string => {
    const product = productMap.value.get(productId)
    if (product) {
      return product.productName
    }
    return productId ? `不可用商品：${productId}` : '未选择产品'
  }

  /**
   * 新增明细行：
   * - 桌面端支持在新增后直接聚焦到产品列；
   * - 供工具栏新增按钮与末行键盘流自动增行复用。
   */
  const appendRow = async (focusProduct = false) => {
    const row = createBlankRow()
    itemRows.value.push(row)

    if (focusProduct) {
      await nextTick()
      focusField(row.uid, 'product')
    }
  }

  /**
   * 加载可选产品：
   * - 仅请求启用产品，并过滤掉没有当前启用 SKU 的记录；
   * - 失败时给出稳定错误提示，避免页面沉默失败。
   */
  const loadProducts = async (): Promise<boolean> => {
    productsLoading.value = true
    productCandidatesReady.value = false
    try {
      const loadedProducts = await productApi.getProductList({
        isActive: true,
      })
      products.value = loadedProducts.filter((product) => getSelectableProductSkus(product).length > 0)
      productCandidatesReady.value = true
      return true
    } catch (error) {
      showAppError(extractErrorMessage(error, '产品加载失败，请稍后重试'))
      return false
    } finally {
      productsLoading.value = false
    }
  }

  /**
   * 加载客户部门选项：
   * - 失败时只记录状态并在控件下方提示，不弹阻断，保证手动录入仍可开单。
   */
  const loadDepartmentOptions = async () => {
    departmentOptionsLoading.value = true
    try {
      departmentOptions.value = await orderApi.getOrderDepartmentOptions()
      departmentOptionsLoadFailed.value = false
    } catch {
      departmentOptions.value = []
      departmentOptionsLoadFailed.value = true
    } finally {
      departmentOptionsLoading.value = false
    }
  }

  /**
   * 按当前部门名推导系统部门节点：
   * - 只有完整路径唯一命中配置选项时才携带节点 ID，由服务端解析规范路径；
   * - 手动录入、同一路径对应多个节点、选项未加载或部门已删除时一律按手动录入处理。
   */
  const syncDepartmentNodeId = () => {
    const departmentName = headerForm.customerDepartmentName.trim()
    const matched = departmentName
      ? departmentOptions.value.filter((option) => option.path === departmentName)
      : []
    headerForm.customerDepartmentNodeId = matched.length === 1 ? matched[0].nodeId : ''
  }

  /**
   * 将恢复草稿中的商品值与当前候选数据对齐：
   * - 旧版 allow-create 保存的唯一精确商品名会迁移为真实 ID，未知或重名值保持原样；
   * - 已失效商品清空 SKU/价格，单 SKU 自动补选并带入默认价，多 SKU 继续要求人工选择；
   * - 首次挂载与账号切换共用本协调器，避免两条恢复路径出现兼容差异。
   */
  const reconcileRestoredDraftProducts = () => {
    const reconcileSelection = (selection: Pick<OrderItemRow, 'productId' | 'skuId' | 'unitPrice'>) => {
      selection.productId = resolveLegacyOrderEntryProductValue(selection.productId, products.value)
      const candidates = getSelectableSkus(selection.productId)
      const selectedSku = candidates.find((sku) => sku.id === selection.skuId)
      if (selectedSku) {
        if (selection.unitPrice === null) {
          selection.unitPrice = normalizeNumber(selectedSku.defaultPrice)
        }
        return
      }

      const fallbackSku = candidates.length === 1 ? candidates[0] : undefined
      selection.skuId = fallbackSku?.id ?? ''
      selection.unitPrice = fallbackSku ? normalizeNumber(fallbackSku.defaultPrice) : null
    }

    itemRows.value.forEach(reconcileSelection)
    reconcileSelection(drawerForm)
  }

  /**
   * 选择产品后自动带出默认单价：
   * - 清空或非法产品时回退为 null；
   * - 使用产品默认单价初始化录入，减少重复输入。
   */
  const handleProductChange = (row: OrderItemRow) => {
    const product = productMap.value.get(row.productId)
    if (!product) {
      row.skuId = ''
      row.unitPrice = null
      return
    }
    const candidates = getSelectableProductSkus(product)
    const sku = candidates.length === 1 ? candidates[0] : undefined
    row.skuId = sku?.id ?? ''
    row.unitPrice = sku ? normalizeNumber(sku.defaultPrice) : null
  }

  const handleSkuChange = (row: OrderItemRow) => {
    const sku = getSelectableSkus(row.productId).find((item) => item.id === row.skuId)
    row.unitPrice = sku ? normalizeNumber(sku.defaultPrice) : null
  }

  /**
   * 构建最终提交明细：
   * - 顺序解析所有有效行，并再次确认商品仍在当前可选集合；
   * - 开单链路不创建商品，避免商品创建成功而库存型出库失败后留下半成功数据；
   * - 输出结果直接可用于整单提交接口。
   */
  const buildSubmitItems = (): SubmitOrderPayload['items'] => {
    const rows = itemRows.value.filter((row) => normalizeTextValue(row.productId) && normalizeNumber(row.qty) > 0)
    const submitItems: SubmitOrderPayload['items'] = []

    for (const [rowIndex, row] of rows.entries()) {
      if (!Number.isSafeInteger(normalizeNumber(row.qty))) {
        throw new Error(`第 ${rowIndex + 1} 行数量必须为正整数`)
      }
      const resolvedProductId = normalizeTextValue(row.productId)
      if (!productMap.value.has(resolvedProductId)) {
        throw new Error(`第 ${rowIndex + 1} 行商品未建档、已停用或暂无可用规格，请重新选择`)
      }
      const candidates = getSelectableSkus(resolvedProductId)
      let selectedSku = candidates.find((sku) => sku.id === row.skuId)
      if (!selectedSku && candidates.length === 1) {
        selectedSku = candidates[0]
        row.skuId = selectedSku?.id ?? ''
      }
      if (!selectedSku) {
        if (candidates.length > 1) {
          throw new Error(`商品“${getProductLabelById(resolvedProductId)}”为多规格商品，请选择规格`)
        }
        throw new Error(`商品“${getProductLabelById(resolvedProductId)}”暂无当前启用规格`)
      }
      submitItems.push({
        productId: resolvedProductId,
        skuId: selectedSku.id,
        qty: normalizeNumber(row.qty),
        unitPrice: normalizeNumber(row.unitPrice),
        remark: row.remark.trim() || undefined,
      })
    }

    return submitItems
  }

  /**
   * 删除明细行：
   * - 先记录删除标记触发 CSS 过渡；
   * - 动效完成后再从数据源中真正移除。
   */
  const removeRow = (uid: string) => {
    if (deletingRowUids.value.includes(uid)) {
      return
    }

    deletingRowUids.value.push(uid)
    globalThis.setTimeout(() => {
      itemRows.value = itemRows.value.filter((row) => row.uid !== uid)
      deletingRowUids.value = deletingRowUids.value.filter((item) => item !== uid)
    }, 220)
  }

  /**
   * 为桌面表格提供删除样式类：
   * - 仅在当前行处于删除过渡时返回类名；
   * - 其余场景保持表格原始样式不变。
   */
  const getRowClassName = ({ row }: { row: OrderItemRow }): string => {
    return deletingRowUids.value.includes(row.uid) ? 'order-row-deleting' : ''
  }

  /**
   * 打开移动端抽屉编辑指定明细：
   * - 先记录当前编辑 uid；
   * - 再将行数据复制到草稿，避免直接联动原始数据。
   */
  const openDrawerByRow = (row: OrderItemRow) => {
    editingRowUid.value = row.uid
    drawerForm.productId = row.productId
    drawerForm.skuId = row.skuId
    drawerForm.qty = row.qty
    drawerForm.unitPrice = row.unitPrice
    drawerForm.remark = row.remark
    drawerVisible.value = true
  }

  /**
   * 以“新增明细”模式打开抽屉：
   * - 先创建空白行，保证应用时一定有回写目标；
   * - 再打开抽屉进入编辑流程。
   */
  const openDrawerForCreate = async () => {
    await appendRow(false)
    const latest = itemRows.value.at(-1)
    if (!latest) {
      return
    }

    openDrawerByRow(latest)
  }

  /**
   * 应用抽屉草稿：
   * - 按 editingRowUid 找到对应明细；
   * - 回写后关闭抽屉，结束一次移动端编辑流程。
   */
  const applyDrawerEdit = () => {
    const row = itemRows.value.find((item) => item.uid === editingRowUid.value)
    if (!row) {
      drawerVisible.value = false
      return
    }

    if (!Number.isSafeInteger(normalizeNumber(drawerForm.qty)) || normalizeNumber(drawerForm.qty) <= 0) {
      showAppWarning('数量必须为正整数')
      return
    }

    if (!productMap.value.has(drawerForm.productId)) {
      showAppWarning('所选商品未建档、已停用或暂无可用规格，请重新选择')
      return
    }

    const candidates = getSelectableSkus(drawerForm.productId)
    if (!candidates.some((sku) => sku.id === drawerForm.skuId)) {
      showAppWarning(candidates.length > 1 ? '该商品有多个规格，请选择规格' : '该商品暂无当前启用规格')
      return
    }

    row.productId = drawerForm.productId
    row.skuId = drawerForm.skuId
    row.qty = drawerForm.qty
    row.unitPrice = drawerForm.unitPrice
    row.remark = drawerForm.remark
    drawerVisible.value = false
  }

  /**
   * 抽屉产品切换：
   * - 与桌面端选择行为保持一致；
   * - 选中现有产品后自动带出默认单价。
   */
  const handleDrawerProductChange = () => {
    const product = productMap.value.get(drawerForm.productId)
    const candidates = getSelectableProductSkus(product)
    const sku = candidates.length === 1 ? candidates[0] : undefined
    drawerForm.skuId = sku?.id ?? ''
    drawerForm.unitPrice = sku ? normalizeNumber(sku.defaultPrice) : null
  }

  const handleDrawerSkuChange = () => {
    const sku = getSelectableSkus(drawerForm.productId).find((item) => item.id === drawerForm.skuId)
    drawerForm.unitPrice = sku ? normalizeNumber(sku.defaultPrice) : null
  }

  /**
   * 注册 / 清理桌面端单元格引用：
   * - 组件卸载时传入空值以清理缓存；
   * - 避免因为动态增删行导致失效引用残留。
   */
  const setFieldRef = (uid: string, field: FocusField, instance: unknown) => {
    const key = `${uid}:${field}`
    if (!instance) {
      fieldRefMap.delete(key)
      return
    }

    fieldRefMap.set(key, instance)
  }

  /**
   * 聚焦指定单元格：
   * - 优先调用组件实例自带 focus；
   * - 否则回退到其内部 input / textarea 节点。
   */
  const focusField = (uid: string, field: FocusField) => {
    const target = fieldRefMap.get(`${uid}:${field}`) as
      | { focus?: () => void; $el?: HTMLElement }
      | undefined

    if (!target) {
      return
    }

    if (typeof target.focus === 'function') {
      target.focus()
      return
    }

    if (target.$el) {
      const inner = target.$el.querySelector('input,textarea') as HTMLInputElement | null
      inner?.focus()
    }
  }

  /**
   * 计算桌面端下一个焦点位置：
   * - 支持正向 / 反向移动；
   * - 在末行最后一列继续前进时自动新增明细并聚焦产品列。
   */
  const moveFocus = async (rowIndex: number, currentField: FocusField, backward: boolean) => {
    const fieldIndex = focusFieldOrder.indexOf(currentField)
    if (fieldIndex < 0) {
      return
    }

    if (backward) {
      if (fieldIndex > 0) {
        focusField(itemRows.value[rowIndex].uid, focusFieldOrder[fieldIndex - 1])
        return
      }

      if (rowIndex > 0) {
        focusField(itemRows.value[rowIndex - 1].uid, focusFieldOrder.at(-1) ?? 'remark')
      }
      return
    }

    if (fieldIndex < focusFieldOrder.length - 1) {
      focusField(itemRows.value[rowIndex].uid, focusFieldOrder[fieldIndex + 1])
      return
    }

    if (rowIndex < itemRows.value.length - 1) {
      focusField(itemRows.value[rowIndex + 1].uid, 'product')
      return
    }

    await appendRow(true)
  }

  /**
   * 处理桌面端 Tab / Enter 键盘流：
   * - 仅在桌面模式启用；
   * - 拦截浏览器默认焦点行为，改走统一录入顺序。
   */
  const handleGridKeydown = async (event: KeyboardEvent, rowIndex: number, field: FocusField) => {
    if (!isDesktop.value) {
      return
    }

    if (event.key !== 'Tab' && event.key !== 'Enter') {
      return
    }

    event.preventDefault()
    await moveFocus(rowIndex, field, event.key === 'Tab' && event.shiftKey)
  }

  /**
   * 重置页面：
   * - 清空主单信息；
   * - 重新初始化为一条空白明细；
   * - 关闭移动端抽屉并清理编辑上下文。
   */
  const resetForm = () => {
    headerForm.orderType = 'walkin'
    headerForm.hasCustomerOrder = false
    headerForm.isSystemApplied = false
    headerForm.issuerName = defaultIssuerName.value
    headerForm.customerDepartmentName = ''
    headerForm.customerDepartmentNodeId = ''
    headerForm.customerName = ''
    headerForm.remark = ''
    itemRows.value = [createBlankRow()]
    editingRowUid.value = ''
    drawerVisible.value = false
    drawerForm.productId = ''
    drawerForm.skuId = ''
    drawerForm.qty = null
    drawerForm.unitPrice = null
    drawerForm.remark = ''
  }

  /**
   * 提交整单：
   * - 先校验至少存在一条有效明细；
   * - 自动生成幂等键，配合后端防重复；
   * - 成功后回到初始状态并提示新单号。
   */
  const submitOrder = async () => {
    if (isSaving.value) {
      return
    }

    const invalidQtyRow = itemRows.value.find((row) => {
      if (!normalizeTextValue(row.productId)) return false
      const qty = normalizeNumber(row.qty)
      return !Number.isSafeInteger(qty) || qty <= 0
    })
    if (invalidQtyRow) {
      showAppWarning('数量必须为正整数')
      return
    }

    if (!validSubmitItems.value.length) {
      showAppWarning('请至少录入一条有效明细（已选择产品且数量大于 0）')
      return
    }

    const invalidProductRow = itemRows.value.find((row) => {
      const productId = normalizeTextValue(row.productId)
      return Boolean(productId) && normalizeNumber(row.qty) > 0 && !productMap.value.has(productId)
    })
    if (invalidProductRow) {
      showAppWarning('存在未建档、已停用或暂无可用规格的商品，请重新选择')
      return
    }

    const invalidSkuRow = itemRows.value.find((row) => {
      if (!productMap.value.has(row.productId) || normalizeNumber(row.qty) <= 0) {
        return false
      }
      return !getSelectableSkus(row.productId).some((sku) => sku.id === row.skuId)
    })
    if (invalidSkuRow) {
      const candidates = getSelectableSkus(invalidSkuRow.productId)
      showAppWarning(candidates.length > 1 ? '存在多规格商品尚未选择规格' : '存在商品暂无当前启用规格')
      return
    }
    const hasInvalidPriceRow = itemRows.value.some((row) => {
      const hasProduct = Boolean(normalizeTextValue(row.productId))
      const hasQty = normalizeNumber(row.qty) > 0
      return hasProduct && hasQty && normalizeNumber(row.unitPrice) <= 0
    })
    if (hasInvalidPriceRow) {
      showAppWarning('存在单价小于等于 0 的明细，请先修正后再保存')
      return
    }
    if (!headerForm.issuerName.trim()) {
      showAppWarning('请填写出单人')
      return
    }
    if (headerForm.orderType === 'department' && !headerForm.customerDepartmentName.trim()) {
      showAppWarning('部门单必须填写客户部门')
      return
    }
    if (headerForm.customerDepartmentName.trim().length > 271) {
      showAppWarning('客户部门名称不能超过 271 个字符')
      return
    }

    // 记录本次是否携带系统部门节点，失败后据此刷新部门选项。
    const submittedDepartmentNodeId = headerForm.orderType === 'department' ? headerForm.customerDepartmentNodeId : ''
    isSaving.value = true
    try {
      const submitItems = buildSubmitItems()
      const idempotencyKey = `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      const isDepartmentOrder = headerForm.orderType === 'department'
      const result = await orderApi.submitOrder({
        idempotencyKey,
        orderType: headerForm.orderType,
        // 详细注释：正式出库单、系统申请等概念只属于部门单。
        // 即便未来界面状态被草稿恢复或异常交互影响，这里仍统一按订单类型做一次最终兜底。
        hasCustomerOrder: isDepartmentOrder ? headerForm.hasCustomerOrder : false,
        isSystemApplied: isDepartmentOrder ? headerForm.isSystemApplied : false,
        issuerName: headerForm.issuerName.trim(),
        customerDepartmentName: isDepartmentOrder ? headerForm.customerDepartmentName.trim() || undefined : undefined,
        // 仅选自系统部门配置时携带节点 ID；手动录入不携带，服务端原样保存且不回写配置。
        customerDepartmentNodeId: isDepartmentOrder ? headerForm.customerDepartmentNodeId || undefined : undefined,
        customerName: headerForm.customerName.trim() || undefined,
        remark: headerForm.remark.trim() || undefined,
        items: submitItems,
      } as SubmitOrderPayload)

      showAppSuccess(`保存成功，业务单号：${result.order.businessNo}`)

      resetForm()
      persistDraft()
      await router.push({
        path: '/order-list',
        query: {
          focusOrderId: result.order.id,
          focusOrderShowNo: result.order.showNo,
          focusRefreshToken: String(Date.now()),
        },
      })
    } catch (error) {
      // 携带部门节点提交失败时刷新选项：节点若已被删除，本地旧选项随之移除，
      // 重新推导后同一路径按手动录入提交，避免不刷新页面就无法恢复。
      if (submittedDepartmentNodeId) {
        void loadDepartmentOptions()
      }
      void showCriticalErrorDialog(error, {
        title: '出库单保存失败',
        fallback: '保存失败，请稍后重试',
        operation: '保存出库单',
      })
    } finally {
      isSaving.value = false
    }
  }

  /**
   * 页面初始化：
   * - 首屏恢复草稿并拉取产品，再统一迁移旧商品名称和对齐 SKU/价格；
   * - 无论请求是否成功，都确保页面至少有一条可编辑的空白明细。
   */
  onMounted(async () => {
    if (!headerForm.issuerName) {
      headerForm.issuerName = defaultIssuerName.value
    }
    const restored = restoreDraft()
    // 部门选项与商品候选并行加载；部门加载内部已兜底失败，只影响下拉提示，不影响商品草稿对账。
    const departmentOptionsTask = loadDepartmentOptions()
    const productsLoaded = await loadProducts()
    if (productsLoaded) {
      reconcileRestoredDraftProducts()
    }
    await departmentOptionsTask
    if (!restored) {
      itemRows.value = [createBlankRow()]
    }
    syncDepartmentNodeId()
    draftPersistenceReady.value = true
    if (productsLoaded) {
      persistDraft()
    }
  })

  /**
   * 部门名或选项变化时重新推导节点：
   * - 覆盖下拉选择、手动输入、草稿恢复与选项异步加载完成等全部入口。
   */
  watch(
    [() => headerForm.customerDepartmentName, departmentOptions],
    () => {
      syncDepartmentNodeId()
    },
  )

  /**
   * 订单类型切换时清理依赖状态：
   * - 散客单不可有出库单（重置并禁用）；
   * - 散客单清空客户部门信息。
   */
  watch(
    () => headerForm.orderType,
    (newType) => {
      if (newType === 'walkin') {
        headerForm.hasCustomerOrder = false
        headerForm.isSystemApplied = false
        headerForm.customerDepartmentName = ''
        headerForm.customerDepartmentNodeId = ''
      }
    },
  )

  /**
   * “是否有出库单”与“是否系统申请”联动逻辑：
   * - 一般情况下两者同步（要有都有）；
   * - 特殊情况：有出库单但系统没申请通过，所以当开启出库单时，系统申请默认联动开启，但允许用户单独关闭系统申请；
   * - 若关闭了出库单，通常意味着连最基础的财务单据都没有，则系统申请也联动关闭。
   */
  watch(
    () => headerForm.hasCustomerOrder,
    (hasOrder) => {
      if (headerForm.orderType === 'department') {
        headerForm.isSystemApplied = hasOrder
      }
    },
  )

  /**
   * 监听录入态变化并实时保存草稿：
   * - 覆盖主单、明细、抽屉草稿三部分；
   * - 让用户临时切页后返回时恢复到离开前的输入状态。
   */
  watch(
    [
      () => headerForm.customerName,
      () => headerForm.remark,
      () => headerForm.orderType,
      () => headerForm.hasCustomerOrder,
      () => headerForm.isSystemApplied,
      () => headerForm.issuerName,
      () => headerForm.customerDepartmentName,
      itemRows,
      drawerVisible,
      editingRowUid,
      () => drawerForm.productId,
      () => drawerForm.skuId,
      () => drawerForm.qty,
      () => drawerForm.unitPrice,
      () => drawerForm.remark,
    ],
    () => {
      persistDraft()
    },
    { deep: true },
  )

  watch(
    () => defaultIssuerName.value,
    (value) => {
      if (!headerForm.issuerName.trim()) {
        headerForm.issuerName = value
      }
    },
  )

  /**
   * 账号切换时同步切换草稿作用域：
   * - 新账号优先恢复自己的草稿；
   * - 恢复后复用首次挂载的商品名称迁移与 SKU/价格对齐逻辑；
   * - 若没有草稿则回退到空白态，避免继续展示上一账号录入中的明细。
   */
  watch(
    () => authStore.currentUser?.id,
    (nextUserId, previousUserId) => {
      if (!draftPersistenceReady.value || nextUserId === previousUserId) {
        return
      }

      const restored = restoreDraft()
      if (!restored) {
        resetForm()
      }
      if (productCandidatesReady.value) {
        reconcileRestoredDraftProducts()
        persistDraft()
      }
    },
  )

  return {
    headerForm,
    itemRows,
    products,
    productsLoading,
    departmentOptions,
    departmentOptionsLoading,
    departmentOptionsLoadFailed,
    isSaving,
    deletingRowUids,
    drawerVisible,
    editingRowUid,
    drawerForm,
    isPhone,
    isTablet,
    isDesktop,
    cardListClass,
    drawerDirection,
    drawerSize,
    detailModeLabel,
    totalQty,
    totalAmount,
    appendRow,
    handleProductChange,
    handleSkuChange,
    getSelectableSkus,
    getSkuLabelById,
    getProductLabelById,
    calcLineAmount,
    toMoney,
    normalizeNumber,
    removeRow,
    getRowClassName,
    openDrawerByRow,
    openDrawerForCreate,
    applyDrawerEdit,
    handleDrawerProductChange,
    handleDrawerSkuChange,
    setFieldRef,
    handleGridKeydown,
    submitOrder,
  }
}
