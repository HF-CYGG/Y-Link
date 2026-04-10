/**
 * 模块说明：src/views/order-entry/composables/useOrderEntryForm.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useRouter } from 'vue-router'
import { orderApi, productApi } from '@/api'
import type { SubmitOrderPayload } from '@/api/modules/order'
import type { ProductRecord } from '@/api/modules/product'
import { useAppStore, useAuthStore } from '@/store'
import { extractErrorMessage } from '@/utils/error'
import type { FocusField, OrderEntryDrawerForm, OrderHeaderForm, OrderItemRow } from '../types'

/**
 * 数值归一化：
 * - 将 null / NaN / 非有限数字统一归 0；
 * - 作为 composable 外层纯函数，避免在每次组合函数实例化时重复创建。
 */
function normalizeNumber(value: number | null): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
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
  const appStore = useAppStore()
  const authStore = useAuthStore()
  const router = useRouter()
  const ORDER_ENTRY_DRAFT_STORAGE_KEY = 'y-link.order-entry.draft.v1'
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
    customerName: '',
    remark: '',
  })

  /**
   * 明细与产品数据源：
   * - itemRows 保存用户当前录入的所有明细；
   * - products 保存当前启用产品全集，供选择与自动带价使用。
   */
  const itemRows = ref<OrderItemRow[]>([])
  const products = ref<ProductRecord[]>([])

  /**
   * 交互状态：
   * - productsLoading 控制产品骨架；
   * - isSaving 防止重复提交；
   * - deletingRowUids 用于列表删除过渡动画；
   * - autoCreatedProductNames 记录本次提交中新建的商品名，供成功提示复用。
   */
  const productsLoading = ref(false)
  const isSaving = ref(false)
  const deletingRowUids = ref<string[]>([])
  const autoCreatedProductNames = ref<string[]>([])

  /**
   * 移动端抽屉编辑状态：
   * - editingRowUid 指向当前正在编辑的行；
   * - drawerForm 作为编辑草稿，点击应用后再统一回写。
   */
  const drawerVisible = ref(false)
  const editingRowUid = ref('')
  const drawerForm = reactive<OrderEntryDrawerForm>({
    productId: '',
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
  const focusFieldOrder: FocusField[] = ['product', 'qty', 'unitPrice', 'remark']
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
    qty: null,
    unitPrice: null,
    remark: '',
  })

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
      customerName: headerForm.customerName,
      remark: headerForm.remark,
    },
    itemRows: itemRows.value.map((row) => ({
      uid: row.uid,
      productId: row.productId,
      qty: row.qty,
      unitPrice: row.unitPrice,
      remark: row.remark,
    })),
    drawerVisible: drawerVisible.value,
    editingRowUid: editingRowUid.value,
    drawerForm: {
      productId: drawerForm.productId,
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
    if (!draftPersistenceReady.value || globalThis.window === undefined) {
      return
    }

    globalThis.window.sessionStorage.setItem(ORDER_ENTRY_DRAFT_STORAGE_KEY, JSON.stringify(buildDraftSnapshot()))
  }

  /**
   * 读取并恢复录入草稿：
   * - 只恢复结构完整的草稿，损坏数据直接忽略；
   * - 若草稿不存在或解析失败，则回退为全新空白录入状态。
   */
  const restoreDraft = (): boolean => {
    if (globalThis.window === undefined) {
      return false
    }

    const rawDraft = globalThis.window.sessionStorage.getItem(ORDER_ENTRY_DRAFT_STORAGE_KEY)
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
      drawerForm.qty = typeof parsedDraft.drawerForm.qty === 'number' ? parsedDraft.drawerForm.qty : null
      drawerForm.unitPrice = typeof parsedDraft.drawerForm.unitPrice === 'number' ? parsedDraft.drawerForm.unitPrice : null
      drawerForm.remark = parsedDraft.drawerForm.remark ?? ''
      return true
    } catch {
      globalThis.window.sessionStorage.removeItem(ORDER_ENTRY_DRAFT_STORAGE_KEY)
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
   * - allow-create 的临时输入显示“新建商品”；
   * - 空值场景显示未选择。
   */
  const getProductLabelById = (productId: string): string => {
    const product = productMap.value.get(productId)
    if (product) {
      return product.productName
    }
    return productId ? `新建商品：${productId}` : '未选择产品'
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
   * - 仅请求启用产品；
   * - 失败时给出稳定错误提示，避免页面沉默失败。
   */
  const loadProducts = async () => {
    productsLoading.value = true
    try {
      products.value = await productApi.getProductList({
        isActive: true,
      })
    } catch (error) {
      ElMessage.error(extractErrorMessage(error, '产品加载失败，请稍后重试'))
    } finally {
      productsLoading.value = false
    }
  }

  /**
   * 选择产品后自动带出默认单价：
   * - 清空或非法产品时回退为 null；
   * - 使用产品默认单价初始化录入，减少重复输入。
   */
  const handleProductChange = (row: OrderItemRow) => {
    const product = productMap.value.get(row.productId)
    if (!product) {
      row.unitPrice = null
      return
    }

    row.unitPrice = normalizeNumber(Number(product.defaultPrice))
  }

  /**
   * 判断输入值是否是现有产品主键：
   * - allow-create 场景下，现有产品与“待自动建档名称”需要区分处理；
   * - 若能直接命中主键则无需再自动建档。
   */
  const isExistingProductId = (value: string): boolean => {
    return productMap.value.has(value)
  }

  /**
   * 确保提交使用真实产品主键：
   * - 允许直接提交现有产品；
   * - 若用户输入的是新商品名称，则自动建档后回填主键；
   * - createdCache 避免同一次提交重复创建同名商品。
   */
  const ensureProductId = async (
    rawValue: string,
    createdCache: Map<string, string>,
    unitPrice: number,
  ): Promise<string> => {
    const normalizedValue = normalizeTextValue(rawValue)
    if (!normalizedValue) {
      throw new Error('产品不能为空')
    }

    if (isExistingProductId(normalizedValue)) {
      return normalizedValue
    }

    const cachedId = createdCache.get(normalizedValue)
    if (cachedId) {
      return cachedId
    }

    const existed = products.value.find((item) => item.productName === normalizedValue)
    if (existed) {
      createdCache.set(normalizedValue, existed.id)
      return existed.id
    }

    const created = await productApi.createProduct({
      productName: normalizedValue,
      pinyinAbbr: '',
      defaultPrice: Math.max(unitPrice, 0),
      isActive: true,
    })
    products.value = [created, ...products.value]
    createdCache.set(normalizedValue, created.id)
    autoCreatedProductNames.value.push(normalizedValue)
    return created.id
  }

  /**
   * 构建最终提交明细：
   * - 顺序解析所有有效行；
   * - 在需要时自动建档商品并回写真实 productId；
   * - 输出结果直接可用于整单提交接口。
   */
  const buildSubmitItemsWithAutoProducts = async (): Promise<SubmitOrderPayload['items']> => {
    const createdCache = new Map<string, string>()
    autoCreatedProductNames.value = []

    const rows = itemRows.value.filter((row) => normalizeTextValue(row.productId) && normalizeNumber(row.qty) > 0)
    const submitItems: SubmitOrderPayload['items'] = []

    for (const row of rows) {
      const resolvedProductId = await ensureProductId(row.productId, createdCache, normalizeNumber(row.unitPrice))
      row.productId = resolvedProductId
      submitItems.push({
        productId: resolvedProductId,
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

    row.productId = drawerForm.productId
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
    drawerForm.unitPrice = product ? normalizeNumber(Number(product.defaultPrice)) : null
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
    headerForm.customerName = ''
    headerForm.remark = ''
    itemRows.value = [createBlankRow()]
    editingRowUid.value = ''
    drawerVisible.value = false
    drawerForm.productId = ''
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

    if (!validSubmitItems.value.length) {
      ElMessage.warning('请至少录入一条有效明细（已选择产品且数量大于 0）')
      return
    }

    const hasInvalidPriceRow = itemRows.value.some((row) => {
      const hasProduct = Boolean(normalizeTextValue(row.productId))
      const hasQty = normalizeNumber(row.qty) > 0
      return hasProduct && hasQty && normalizeNumber(row.unitPrice) <= 0
    })
    if (hasInvalidPriceRow) {
      ElMessage.warning('存在单价小于等于 0 的明细，请先修正后再保存')
      return
    }
    if (!headerForm.issuerName.trim()) {
      ElMessage.warning('请填写出单人')
      return
    }
    if (headerForm.orderType === 'department' && !headerForm.customerDepartmentName.trim()) {
      ElMessage.warning('部门单必须填写客户部门')
      return
    }

    isSaving.value = true
    try {
      const submitItems = await buildSubmitItemsWithAutoProducts()
      const idempotencyKey = `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      const result = await orderApi.submitOrder({
        idempotencyKey,
        orderType: headerForm.orderType,
        hasCustomerOrder: headerForm.hasCustomerOrder,
        isSystemApplied: headerForm.isSystemApplied,
        issuerName: headerForm.issuerName.trim(),
        customerDepartmentName: headerForm.customerDepartmentName.trim() || undefined,
        customerName: headerForm.customerName.trim() || undefined,
        remark: headerForm.remark.trim() || undefined,
        items: submitItems,
      } as SubmitOrderPayload)

      ElMessage.success(`保存成功，单号：${result.order.showNo}`)
      if (autoCreatedProductNames.value.length) {
        ElMessage.success(`已自动建档商品：${[...new Set(autoCreatedProductNames.value)].join('、')}`)
      }

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
      ElMessage.error(extractErrorMessage(error, '保存失败，请稍后重试'))
    } finally {
      isSaving.value = false
    }
  }

  /**
   * 页面初始化：
   * - 首屏拉取产品；
   * - 无论请求是否成功，都确保页面至少有一条可编辑的空白明细。
   */
  onMounted(async () => {
    if (!headerForm.issuerName) {
      headerForm.issuerName = defaultIssuerName.value
    }
    const restored = restoreDraft()
    await loadProducts()
    if (!restored) {
      itemRows.value = [createBlankRow()]
    }
    draftPersistenceReady.value = true
    persistDraft()
  })

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

  return {
    headerForm,
    itemRows,
    products,
    productsLoading,
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
    setFieldRef,
    handleGridKeydown,
    submitOrder,
  }
}
