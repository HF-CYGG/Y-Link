<script setup lang="ts">
/**
 * 模块说明：src/views/base-data/components/ProductManager.vue
 * 文件职责：维护产品主数据列表、编辑弹窗、批量操作、颜色/款式（YZ 编码语义下为“颜色/款式”与“尺码”两轴）规格配置，以及存量商品到 YZ 通用 SKU 编码体系的升级入口。
 * 实现逻辑：
 * - 通过 useCrudManager 统一收敛产品列表、弹窗保存与删除流程；
 * - 编辑弹窗在主商品字段之外维护 SKU 行，提交时把颜色、款式、售价、库存和启停状态转换为后端规格数据；
 * - 未配置规格时继续使用默认规格，由后端同步主商品价格与库存，兼容历史单规格商品；
 * - 表格、移动卡片和筛选条件仍复用既有数据集合，避免规格能力影响原有基础资料工作台；
 * - 商品可归属一个分类；单规格商品在编辑弹窗直接维护条码、成本价与库位（通过 defaultSku 提交），多规格商品在规格配置里逐行维护；
 * - 新增商品必须选择文创系列（seriesCode 非空的标签），选中后走 YZ 编码，productCode 由后端生成、前端禁用并清空该输入；
 *   编辑已有 YZ 编码商品时产品编码与文创系列均只读；编辑历史（legacy）商品保持原有自由编辑行为，并提供「升级到 YZ 编码」入口（ProductYzUpgradeDialog.vue）；
 * - 规格弹窗里一级变体轴（对应 YZ 编码位 1-9）展示并写入 key「颜色/款式」，尺码轴（对应 YZ 编码位 A-E）展示并
 *   写入 key「尺码」（B8 批次改名，新写入统一新 key）；读取历史 SKU 时兼容旧 key「颜色」「款式」，不做批量
 *   迁移，靠重新保存自然懒迁移，具体规则见 product-sku-matrix.helpers.ts 顶部注释；
 * - YZ 编码商品的规格弹窗会前置校验两轴取值数量（evaluateSkuDimensionCapacity），超限时禁用保存按钮，避免提交后才被后端 409 拦截；
 * - YZ 编码商品的规格弹窗额外提供「规格取值重命名」（ProductSpecValueRenameDialog.vue，只改显示名称、编码位不变）
 *   与「0 号规格演进」（ProductZeroSpecEvolveDialog.vue，把原本"无该轴规格"的 SKU 继承为具体取值，或退役保留）
 *   两个入口，均为异步组件、只读商品当前是否存在待演进的 0 号 SKU 决定是否展示；
 * - Excel 导入、条码打印弹窗、YZ 编码升级弹窗、规格取值重命名弹窗与 0 号规格演进弹窗均为异步组件，只在点击时加载。
 * 维护说明：
 * - 后续扩展尺码、容量等规格维度时，优先扩展 SKU 表单和后端规格归一化逻辑，不要绕过商品服务直接写库存；
 * - 删除或停用已有 SKU 前需保留占用库存汇总，避免已下单未核销记录丢失库存占用；
 * - 升级到 YZ 编码属于不可逆操作，不要在本文件里叠加绕过 ProductYzUpgradeDialog 预检结果的“快速升级”入口。
 */


import { computed, defineAsyncComponent, h, nextTick, onActivated, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { type FormInstance, type FormRules, type TableInstance, type UploadRequestOptions } from 'element-plus'
import type { RequestConfig } from '@/api/http'
import { createTag, getTagList, type Tag } from '@/api/modules/tag'
import { exportProducts, getCategories, getLocations, type CategoryRecord, type LocationRecord } from '@/api/modules/inventory'
import { uploadImage } from '@/api/modules/upload'
import {
  batchCreateProducts,
  batchUpdateProducts,
  type CreateProductDto,
  createProduct,
  deleteProduct,
  getProductDetail,
  getProductListPaged,
  updateProduct,
  type ProductListQuery,
  type ProductRecord,
  type ProductSkuRecord,
} from '@/api/modules/product'
import {
  BizCrudDialogShell,
  BizResponsiveDataCollectionShell,
  PassiveNumberInput,
  PassivePreviewImage,
  PageToolbarCard,
} from '@/components/common'
import { useCrudManager } from '@/composables/useCrudManager'
import { usePermissionAction } from '@/composables/usePermissionAction'
import { useStableRequest } from '@/composables/useStableRequest'
import { extractErrorMessage } from '@/utils/error'
import {
  normalizeOptionalSubmitText,
  normalizeSubmitNumber,
  normalizeSubmitText,
} from '@/utils/submit-feedback'
import { calculateDiscountedPriceText, normalizeDiscountRateText } from '@/utils/o2o-price'
import { showAppError, showAppSuccess, showAppWarning } from '@/utils/app-alert'
import { compressImageForUpload } from '@/utils/image-upload'
import {
  compareProductCode,
  createBatchCreateRow,
  filterSeriesTagOptions,
  formatSeriesTagOptionLabel,
  normalizeSelectValue,
  validateBatchCreateRows,
  validatePrimarySeriesTagRequired,
  type BatchCreateProductFormRow,
} from '@/views/base-data/components/product-manager.helpers'
import {
  buildSkuMatrixRows,
  evaluateSkuDimensionCapacity,
  extractSkuDimensionValues,
  SIZE_AXIS_SPEC_KEY,
  VARIANT_AXIS_SPEC_KEY,
  type ProductSkuMatrixRow,
} from '@/views/base-data/components/product-sku-matrix.helpers'

const ProductImportDialog = defineAsyncComponent(() => import('@/views/inventory/components/ProductImportDialog.vue'))
const ProductYzImportDialog = defineAsyncComponent(() => import('@/views/inventory/components/ProductYzImportDialog.vue'))
const BarcodeLabelPrintDialog = defineAsyncComponent(() => import('@/views/inventory/components/BarcodeLabelPrintDialog.vue'))
const ProductYzUpgradeDialog = defineAsyncComponent(() => import('@/views/base-data/components/ProductYzUpgradeDialog.vue'))
const ProductSpecValueRenameDialog = defineAsyncComponent(() => import('@/views/base-data/components/ProductSpecValueRenameDialog.vue'))
const ProductZeroSpecEvolveDialog = defineAsyncComponent(() => import('@/views/base-data/components/ProductZeroSpecEvolveDialog.vue'))

const allTags = ref<Tag[]>([])
const allCategories = ref<CategoryRecord[]>([])
const allLocations = ref<LocationRecord[]>([])
const importDialogVisible = ref(false)
const yzImportDialogVisible = ref(false)
const printDialogVisible = ref(false)
const printSkuIds = ref<string[]>([])
const exportLoading = ref(false)
const searchCategoryId = ref('')
const formRef = ref<FormInstance>()
const productTableRef = ref<TableInstance>()
const pageReady = ref(false)
const keepAliveActivated = ref(false)
const hasAutoCreatedTags = ref(false)
const editingProductId = ref('')
const editLoading = ref(false)
const productDetailRequest = useStableRequest()
const batchSubmitting = ref(false)
const batchCreateDialogVisible = ref(false)
const batchCreateSubmitting = ref(false)
const selectedProductIds = ref<string[]>([])
const yzUpgradeDialogVisible = ref(false)
const specValueRenameDialogVisible = ref(false)
const zeroSpecEvolveDialogVisible = ref(false)
const router = useRouter()

const searchKeyword = ref('')
const searchTagId = ref('')
const productCodeSortOrder = ref<'ascending' | 'descending'>('ascending')
const productPage = ref(1)
const productPageSize = ref(10)
const productTotal = ref(0)

/**
 * 产品表单类型：
 * - 与页面编辑字段保持一一对应；
 * - 单独声明类型，便于通用 CRUD composable 复用时获得完整推断。
 */
interface ProductForm {
  id: string
  productCode: string
  productName: string
  pinyinAbbr: string
  defaultPrice: number
  discountRate: number
  currentStock: number
  isActive: boolean
  productThumbnail: string | null
  tagIds: string[]
  categoryId: string
  defaultSkuCode: string
  defaultBarcode: string
  defaultCostPrice: number | null
  defaultLocationId: string
  skuColorText: string
  skuStyleText: string
  skus: ProductSkuForm[]
  /** YZ 编码体系专用：主系列标签ID；legacy 商品或未选择系列时为空字符串。 */
  primarySeriesTagId: string
  /** 编辑已有商品时的编码体系快照，决定产品编码/文创系列选择器是否只读；新增商品恒为 legacy，实际编码体系由是否选择系列决定。 */
  codeScheme: 'legacy' | 'yz'
  /**
   * 单规格商品（form.skus 为空、走 defaultSku 提交）的默认 SKU 编码位快照，仅用于判断「0 号规格演进」
   * 入口是否展示；多规格商品直接看 form.skus 里各行的 variantCode/sizeCode，不使用这两个字段。
   */
  defaultSkuVariantCode: string | null
  defaultSkuSizeCode: string | null
}

type ProductSkuForm = ProductSkuMatrixRow

type DiscountEditMode = 'rate' | 'price'

const ElInputTag = (
  props: { modelValue?: string[] },
  { emit }: { emit: (event: string, value: string[]) => void },
) => {
  const values = props.modelValue ?? []
  const update = (next: string[]) => emit('update:modelValue', next)
  const append = (event: Event) => {
    const input = event.target as HTMLInputElement
    const value = input.value.trim()
    value && update([...values, value])
    input.value = ''
  }

  return h('div', { class: 'el-input__wrapper w-full' }, [
    ...values.map((value, index) => h('span', { class: 'el-tag el-tag--info el-tag--small' }, [
      value,
      h('button', { class: 'el-tag__close', type: 'button', onClick: () => { values.splice(index, 1); update(values) } }, '×'),
    ])),
    h('input', {
      class: 'el-input__inner',
      onChange: append,
    }),
  ])
}

const BATCH_CREATE_MAX_ROWS = 50
const batchCreateRowSeed = ref(0)
const batchCreateRows = ref<BatchCreateProductFormRow[]>([])
const discountEditMode = ref<DiscountEditMode>('rate')
const skuDiscountEditModes = ref<Record<string, DiscountEditMode>>({})
const skuThumbnailDragActiveId = ref('')
const skuThumbnailUploadProgresses = ref<Record<string, number>>({})
const skuThumbnailUploadStatuses = ref<Record<string, 'success' | 'exception' | undefined>>({})
const skuThumbnailUploadClearTimers = ref<Record<string, number>>({})
const isSkuDialog = ref(false)

const discountEditModeOptions = [
  { label: '按折扣', value: 'rate' },
  { label: '按折后价', value: 'price' },
]

/**
 * 产品表单模型：
 * - 通过工厂函数统一创建初始值，避免新增与重置逻辑散落；
 * - 让“新增产品”与“关闭后重开”始终落回同一默认状态。
 */
const createDefaultForm = (): ProductForm => ({
  id: '',
  productCode: '',
  productName: '',
  pinyinAbbr: '',
  defaultPrice: 0,
  discountRate: 10,
  currentStock: 0,
  isActive: true,
  productThumbnail: null,
  tagIds: [] as string[],
  categoryId: '',
  defaultSkuCode: '',
  defaultBarcode: '',
  defaultCostPrice: null,
  defaultLocationId: '',
  skuColorText: '',
  skuStyleText: '',
  skus: [],
  primarySeriesTagId: '',
  codeScheme: 'legacy',
  defaultSkuVariantCode: null,
  defaultSkuSizeCode: null,
})

const selectedProductCount = computed(() => selectedProductIds.value.length)
const batchCreateRowCount = computed(() => batchCreateRows.value.length)
const { hasPermission, ensurePermission } = usePermissionAction()
const canManageProducts = computed(() => hasPermission('products:manage'))
const canImportProducts = computed(() => hasPermission('products:import') && hasPermission('products:manage'))
const activeCategoryOptions = computed(() => allCategories.value.filter((item) => item.isActive || item.id === form.value.categoryId))
const activeLocationOptions = computed(() => allLocations.value.filter((item) => item.isActive))
const resolveLocationLabel = (id: string | null | undefined) => allLocations.value.find((item) => item.id === id)?.locationCode ?? ''

/**
 * 文创系列（YZ 编码）相关派生状态：
 * - seriesTagOptions 只保留配置了两位系列编码的标签，供新增/编辑弹窗与升级弹窗共用；
 * - effectiveCodeScheme 新增商品按是否已选系列实时推算，编辑商品固定沿用后端返回的 codeScheme（不可切换）；
 * - 产品编码输入框的禁用态与占位文案统一由 effectiveCodeScheme 推导，避免模板里散落条件判断。
 */
const seriesTagOptions = computed(() => filterSeriesTagOptions(allTags.value))
const hasSeriesTagOptions = computed(() => seriesTagOptions.value.length > 0)
const effectiveCodeScheme = computed<'legacy' | 'yz'>(() => {
  if (form.value.id) {
    return form.value.codeScheme
  }
  return form.value.primarySeriesTagId ? 'yz' : 'legacy'
})
const isYzProduct = computed(() => effectiveCodeScheme.value === 'yz')

/**
 * 0 号规格演进入口的展示条件：
 * - 仅编辑已有 YZ 编码商品时可用（新增商品还没有 SKU，无从谈"0 号"）；
 * - 多规格商品（form.skus 非空）看各行的 variantCode/sizeCode；单规格商品（走 defaultSku 提交）看
 *   defaultSkuVariantCode/defaultSkuSizeCode 快照；
 * - 只是前端的展示态过滤，登记表是否已经真正被继承过以后端 400 校验为准。
 */
const hasZeroVariantSku = computed(() => {
  if (!form.value.id || effectiveCodeScheme.value !== 'yz') return false
  if (form.value.skus.length) {
    return form.value.skus.some((sku) => (sku.variantCode ?? '0') === '0')
  }
  return (form.value.defaultSkuVariantCode ?? '0') === '0'
})
const hasZeroSizeSku = computed(() => {
  if (!form.value.id || effectiveCodeScheme.value !== 'yz') return false
  if (form.value.skus.length) {
    return form.value.skus.some((sku) => sku.sizeCode === null || sku.sizeCode === undefined)
  }
  return form.value.defaultSkuSizeCode === null || form.value.defaultSkuSizeCode === undefined
})
const hasZeroSpecToEvolve = computed(() => hasZeroVariantSku.value || hasZeroSizeSku.value)
const productCodeFieldDisabled = computed(() => isYzProduct.value)
const productCodePlaceholder = computed(() => {
  if (!form.value.id) {
    return isYzProduct.value ? '由系统按所选系列自动生成，如 YZPX18' : '留空则自动生成统一编码'
  }
  return '请输入产品编码'
})

/** 选择文创系列后，新增商品的产品编码统一由后端生成：清空输入框，避免用户填写的内容被静默丢弃。 */
const handlePrimarySeriesTagChange = () => {
  if (!form.value.id) {
    form.value.productCode = ''
  }
}

const openYzUpgradeDialog = () => {
  if (!ensurePermission('products:manage', '升级到 YZ 编码')) {
    return
  }
  yzUpgradeDialogVisible.value = true
}

/** 升级成功后：用最新商品数据回填当前编辑态，并刷新列表，让用户立刻看到新编码。 */
const handleYzUpgraded = async (updated: ProductRecord) => {
  yzUpgradeDialogVisible.value = false
  form.value = buildEditForm(updated)
  await reloadProducts()
}

const openSpecValueRenameDialog = () => {
  if (!ensurePermission('products:manage', '重命名规格取值')) {
    return
  }
  specValueRenameDialogVisible.value = true
}

/** 重命名成功后：用最新商品数据回填当前编辑态，并刷新列表，让用户立刻看到新名称。 */
const handleSpecValueRenamed = async (updated: ProductRecord) => {
  specValueRenameDialogVisible.value = false
  form.value = buildEditForm(updated)
  await reloadProducts()
}

const openZeroSpecEvolveDialog = () => {
  if (!ensurePermission('products:manage', '0 号规格演进')) {
    return
  }
  zeroSpecEvolveDialogVisible.value = true
}

/** 演进成功后：用最新商品数据回填当前编辑态，并刷新列表。 */
const handleZeroSpecEvolved = async (updated: ProductRecord) => {
  zeroSpecEvolveDialogVisible.value = false
  form.value = buildEditForm(updated)
  await reloadProducts()
}

const goToTagManagement = () => {
  void router.push('/base-data/tags')
}

const createBatchCreateFormRow = (): BatchCreateProductFormRow => {
  batchCreateRowSeed.value += 1
  return createBatchCreateRow(`batch-row-${Date.now()}-${batchCreateRowSeed.value}`)
}

/**
 * 产品展示列表：
 * - 默认按产品编码正序排列；
 * - 支持正序/倒序切换，移动端卡片与桌面表格共用同一排序结果。
 */
const formatDiscountRateLabel = (value: string | number) => {
  return `${normalizeDiscountRateText(value).replace(/\.0$/, '')}折`
}

const normalizeDiscountRateNumber = (value: unknown) => {
  return Number(normalizeDiscountRateText(typeof value === 'number' ? value : Number(value)))
}

const resolveDiscountRateFromDiscountedPrice = (originalPrice: unknown, discountedPrice: unknown) => {
  const original = normalizeSubmitNumber(originalPrice, { fallback: 0, min: 0 })
  const discounted = normalizeSubmitNumber(discountedPrice, { fallback: original, min: 0 })

  if (original <= 0) {
    return 10
  }

  const rawRate = (discounted / original) * 10
  return normalizeDiscountRateNumber(Math.round(rawRate * 10) / 10)
}

const displayProducts = computed(() => {
  const sortedProducts = [...products.value]
  sortedProducts.sort((prev, next) => {
    const compareResult = compareProductCode(prev.productCode, next.productCode)
    return productCodeSortOrder.value === 'ascending' ? compareResult : -compareResult
  })
  return sortedProducts
})

/**
 * 表单规则：
 * - 确保关键主数据字段完整；
 * - 录入校验尽量前置到前端完成。
 */
const rules: FormRules = {
  productCode: [
    {
      validator: (_rule, value, callback) => {
        if (form.value.id && !String(value ?? '').trim()) {
          callback(new Error('请输入产品编码'))
          return
        }
        callback()
      },
      trigger: 'blur',
    },
  ],
  productName: [{ required: true, message: '请输入产品名称', trigger: 'blur' }],
  primarySeriesTagId: [
    {
      validator: (_rule, value, callback) => {
        const message = validatePrimarySeriesTagRequired(!form.value.id, normalizeSelectValue(value))
        if (message) {
          callback(new Error(message))
          return
        }
        callback()
      },
      trigger: ['blur', 'change'],
    },
  ],
  defaultPrice: [{ required: true, message: '请输入默认售价', trigger: 'blur' }],
  discountRate: [
    {
      validator: (_rule, value, callback) => {
        const discountRate = Number(value)
        if (!Number.isFinite(discountRate) || discountRate < 1 || discountRate > 10) {
          callback(new Error('折扣必须在 1.0 到 10.0 折之间'))
          return
        }
        callback()
      },
      trigger: ['blur', 'change'],
    },
  ],
}

/**
 * 加载标签全集：
 * - 供搜索筛选与表单关联标签共用；
 * - 失败时不阻断主页面渲染，仅输出调试日志。
 */
const loadTags = async (requestConfig: RequestConfig = {}) => {
  try {
    const res = await getTagList(requestConfig)
    allTags.value = res || []
  } catch (error) {
    console.error('Failed to load tags', error)
  }
}

/**
 * 将筛选条件映射为接口查询参数：
 * - 保持页面现有搜索交互与后端参数契约不变；
 * - 让通用 CRUD composable 只消费一个统一的 loadList 函数。
 */
const loadInventoryDictionaries = async () => {
  try {
    const [categories, locations] = await Promise.all([getCategories(), getLocations()])
    allCategories.value = categories
    allLocations.value = locations
  } catch (error) {
    showAppError(extractErrorMessage(error, '分类与库位加载失败'))
  }
}

const handleExportProducts = async () => {
  exportLoading.value = true
  try {
    await exportProducts()
  } catch (error) {
    showAppError(extractErrorMessage(error, '导出失败'))
  } finally {
    exportLoading.value = false
  }
}

const openPrintDialog = () => {
  const skuIds = products.value
    .filter((product) => selectedProductIds.value.includes(product.id))
    .flatMap((product) => (product.skus ?? []).filter((sku) => sku.isCurrent !== false && sku.id).map((sku) => String(sku.id)))
  if (!skuIds.length) {
    showAppWarning('请先勾选要打印条码的产品')
    return
  }
  printSkuIds.value = skuIds
  printDialogVisible.value = true
}

const buildQueryParams = (): ProductListQuery => {
  const params: ProductListQuery = {}
  if (searchKeyword.value) params.keyword = searchKeyword.value
  if (searchTagId.value) params.tagId = searchTagId.value
  if (searchCategoryId.value) params.categoryId = searchCategoryId.value
  return params
}

const handleSearch = () => {
  productPage.value = 1
  void reloadProducts()
}

const applyTableSelection = async () => {
  await nextTick()
  const table = productTableRef.value
  if (!table) {
    return
  }

  table.clearSelection()
  const selectedIdSet = new Set(selectedProductIds.value)
  products.value.forEach((product) => {
    if (selectedIdSet.has(product.id)) {
      table.toggleRowSelection(product, true)
    }
  })
}

const syncSelectedProductIds = async () => {
  const visibleIdSet = new Set(products.value.map((product) => product.id))
  selectedProductIds.value = selectedProductIds.value.filter((id) => visibleIdSet.has(id))
  await applyTableSelection()
}

const clearSelection = async () => {
  selectedProductIds.value = []
  await applyTableSelection()
}

const handleTableSelectionChange = (selection: ProductRecord[]) => {
  selectedProductIds.value = selection.map((item) => item.id)
}

/**
 * 表格排序切换：
 * - 仅接管产品编码列；
 * - 若表格返回空排序（理论上已通过 sort-orders 禁用），兜底回退为正序。
 */
const handleTableSortChange = (payload: { prop: string; order: 'ascending' | 'descending' | null }) => {
  if (payload.prop !== 'productCode') {
    return
  }

  productCodeSortOrder.value = payload.order || 'ascending'
}

const handleCardSelectionChange = async (productId: string, checked: boolean | string | number) => {
  const isChecked = checked === true
  if (isChecked) {
    selectedProductIds.value = [...new Set([...selectedProductIds.value, productId])]
  } else {
    selectedProductIds.value = selectedProductIds.value.filter((id) => id !== productId)
  }

  await applyTableSelection()
}

/**
 * 将产品实体映射为编辑表单：
 * - 标签集合转换为 id 数组，便于多选组件直接回填；
 * - 默认售价显式转 number，保持输入组件的数据类型稳定。
 */
// B8 批次改名：新 key 优先，缺失时回退旧 key（颜色→颜色/款式，款式→尺码），兼容尚未重新保存过的历史数据。
const resolveSkuFormColor = (specValues: Record<string, string> | undefined, specText: string | undefined) => {
  const color = String(specValues?.[VARIANT_AXIS_SPEC_KEY] ?? specValues?.颜色 ?? '').trim()
  if (color) {
    return color
  }
  return String(specValues?.规格 || specText || '').trim()
}

const resolveSkuFormStyle = (specValues: Record<string, string> | undefined) =>
  String(specValues?.[SIZE_AXIS_SPEC_KEY] ?? specValues?.款式 ?? '').trim()

const buildSkuSpecValues = (sku: ProductSkuForm, index: number): Record<string, string> => {
  if (sku.specValues && Object.keys(sku.specValues).length) {
    return sku.specValues
  }
  const color = String(sku.color ?? '').trim()
  const style = String(sku.style ?? '').trim()
  if (color || style) {
    const specValues: Record<string, string> = {}
    if (color) {
      specValues[VARIANT_AXIS_SPEC_KEY] = color
    }
    if (style) {
      specValues[SIZE_AXIS_SPEC_KEY] = style
    }
    return specValues
  }
  return { 规格: String(sku.specText ?? '').trim() || `规格${index + 1}` }
}

const isProductImplicitDefaultSku = (row: ProductRecord) => {
  const currentSkus = (row.skus ?? []).filter((sku) => sku.isCurrent !== false)
  if (currentSkus.length !== 1) {
    return false
  }
  const [sku] = currentSkus
  if (!sku) {
    return false
  }
  // 没有真实规格组：规格值为空，或历史数据里唯一的 { 规格: '默认规格' }。
  const specValues = sku.specValues ?? {}
  const specKeys = Object.keys(specValues)
  const specText = String(sku.specText ?? '').trim()
  if (specKeys.length === 0) {
    return true
  }
  return specKeys.length === 1 && specValues.规格 === '默认规格' && (!specText || specText === '默认规格')
}

/**
 * 编辑弹窗打开时的库存基线：
 * - 仅提交用户实际改动过的库存字段，未改动的由服务端保留锁内最新值；
 * - 改动时附带基线，服务端发现期间已被出入库改动会拒绝保存，避免静默覆盖出库扣减。
 */
let productEditStockBaseline: { productId: string; currentStock: number; skus: Map<string, number> } | null = null

/** 单规格商品默认 SKU 扩展字段的打开时快照：未改动时不提交 defaultSku，避免无关保存触发服务端校验。 */
let defaultSkuBaseline: string | null = null
/** 单规格商品的默认 SKU 原始记录：规格弹窗的占位行据此展示 id、编码、条码、成本价与库位。 */
let defaultSkuSnapshot: ProductSkuRecord | null = null
const buildDefaultSkuSignature = (barcode: string, costPrice: string | number | null, locationId: string) =>
  JSON.stringify([barcode.trim(), costPrice === null || costPrice === '' ? null : Number(costPrice), locationId || ''])
const EMPTY_DEFAULT_SKU_SIGNATURE = buildDefaultSkuSignature('', null, '')

const buildEditForm = (row: ProductRecord): ProductForm => {
  productEditStockBaseline = {
    productId: row.id,
    currentStock: Number(row.currentStock) || 0,
    skus: new Map((row.skus ?? [])
      .filter((sku) => typeof sku.id === 'string' && sku.id)
      .map((sku) => [String(sku.id), Number(sku.currentStock ?? 0)])),
  }
  const currentSkus = (row.skus ?? []).filter((sku) => sku.isCurrent !== false)
  const skus = currentSkus.length && !isProductImplicitDefaultSku(row)
    ? currentSkus.map((sku) => ({
        id: sku.id,
        specValues: sku.specValues ?? {},
        specText: sku.specText,
        color: resolveSkuFormColor(sku.specValues, sku.specText),
        style: resolveSkuFormStyle(sku.specValues),
        defaultPrice: Number(sku.defaultPrice ?? sku.originalPrice ?? row.defaultPrice),
        discountRate: Number(sku.discountRate ?? row.discountRate),
        currentStock: Number(sku.currentStock ?? 0),
        isActive: sku.isActive !== false,
        isCurrent: true,
        o2oRecommended: sku.o2oRecommended === true,
        thumbnail: sku.thumbnail ?? null,
        skuCode: sku.skuCode,
        barcode: sku.barcode ?? null,
        costPrice: sku.costPrice === null || sku.costPrice === undefined ? null : Number(sku.costPrice),
        locationId: sku.locationId ?? null,
        variantCode: sku.variantCode ?? null,
        sizeCode: sku.sizeCode ?? null,
      }))
    : []
  const dimensions = extractSkuDimensionValues(skus)
  const defaultSku = skus.length ? null : currentSkus[0] ?? null
  defaultSkuSnapshot = defaultSku
  defaultSkuBaseline =defaultSku ? buildDefaultSkuSignature(defaultSku.barcode ?? '', defaultSku.costPrice ?? null, defaultSku.locationId ?? '') : null

  return {
    id: row.id,
    productCode: row.productCode,
    productName: row.productName,
    pinyinAbbr: row.pinyinAbbr,
    defaultPrice: Number(row.defaultPrice),
    discountRate: Number(row.discountRate || 10),
    currentStock: Number(row.currentStock) || 0,
    isActive: row.isActive,
    productThumbnail: row.thumbnail ?? null,
    tagIds: row.tagIds,
    categoryId: row.categoryId ?? '',
    defaultSkuCode: defaultSku?.skuCode ?? '',
    defaultBarcode: defaultSku?.barcode ?? '',
    defaultCostPrice: defaultSku?.costPrice === null || defaultSku?.costPrice === undefined ? null : Number(defaultSku.costPrice),
    defaultLocationId: defaultSku?.locationId ?? '',
    skuColorText: dimensions.colors.join('，'),
    skuStyleText: dimensions.styles.join('，'),
    skus,
    primarySeriesTagId: row.primarySeriesTagId ?? '',
    codeScheme: row.codeScheme === 'yz' ? 'yz' : 'legacy',
    defaultSkuVariantCode: defaultSku?.variantCode ?? null,
    defaultSkuSizeCode: defaultSku?.sizeCode ?? null,
  }
}

/**
 * 将表单转换为提交 payload：
 * - 保存前先兜底创建缺失标签；
 * - 输出统一的产品 DTO，供新增与编辑接口共用。
 */
const resolveDefaultSkuPayload = (currentForm: ProductForm): { defaultSku?: CreateProductDto['defaultSku'] } => {
  // 与编辑表单的显示条件一致：没有真实规格行（form.skus 为空）时展示并提交默认规格字段。
  if (currentForm.skus.length) return {}
  const signature = buildDefaultSkuSignature(currentForm.defaultBarcode, currentForm.defaultCostPrice, currentForm.defaultLocationId)
  // 编辑时与打开时快照比较；新增或原本没有默认 SKU 记录时与空值比较，改动过就提交。
  const baseline = currentForm.id && defaultSkuBaseline !== null ? defaultSkuBaseline : EMPTY_DEFAULT_SKU_SIGNATURE
  if (signature === baseline) return {}
  return {
    defaultSku: {
      barcode: currentForm.defaultBarcode.trim() || null,
      costPrice: currentForm.defaultCostPrice === null ? null : normalizeSubmitNumber(currentForm.defaultCostPrice, { fallback: 0, min: 0 }),
      locationId: currentForm.defaultLocationId || null,
    },
  }
}

const buildSubmitPayload = async (currentForm: ProductForm): Promise<CreateProductDto> => {
  hasAutoCreatedTags.value = false
  const resolvedTagIds = await resolveTagIds(currentForm.tagIds)
  const normalizedPrimarySeriesTagId = normalizeSelectValue(currentForm.primarySeriesTagId)
  // 新增商品且已选文创系列时走 YZ 编码：productCode 由后端生成，这里不提交该字段（提交了会被后端 400 拒绝）。
  // 编辑场景下无论 legacy 还是 yz，都沿用输入框当前值（yz 商品该输入框已禁用，值与后端一致，不会触发“改码”校验）。
  const isNewYzSubmission = !currentForm.id && !!normalizedPrimarySeriesTagId
  // 编辑已有的 YZ 商品时，文创系列本就不可变更，干脆不提交该字段：
  // 后端只在该字段存在时才做“是否被改动”的比对，不传就完全绕开这条校验，
  // 避免因为主键类型差异等原因把“原样回传”误判成修改而挡住其它字段的保存。
  const isExistingYzProduct = !!currentForm.id && !!normalizedPrimarySeriesTagId
  const normalizedProductCode = isNewYzSubmission ? undefined : normalizeOptionalSubmitText(currentForm.productCode)
  const normalizedProductName = normalizeSubmitText(currentForm.productName)
  const normalizedPinyinAbbr = normalizeOptionalSubmitText(currentForm.pinyinAbbr)
  const normalizedDefaultPrice = normalizeSubmitNumber(currentForm.defaultPrice, {
    fallback: 0,
    min: 0,
  })
  const normalizedDiscountRate = normalizeDiscountRateNumber(normalizeSubmitNumber(currentForm.discountRate, {
    fallback: 10,
    min: 1,
    max: 10,
  }))
  const normalizedCurrentStock = normalizeSubmitNumber(currentForm.currentStock, {
    fallback: 0,
    min: 0,
    integer: true,
  })
  // 编辑已有商品时，只提交用户改动过的库存，并附带打开弹窗时的基线；新增商品不受影响。
  const baseline = currentForm.id && productEditStockBaseline?.productId === currentForm.id ? productEditStockBaseline : null
  const resolveSkuStockField = (skuId: string | undefined, stock: number) => {
    if (!baseline || !skuId) return { currentStock: stock }
    return baseline.skus.get(String(skuId)) === stock ? {} : { currentStock: stock }
  }

  return {
    // 详细注释：单个新增/编辑与批量新增统一使用相同的字段归一化口径，
    // 避免输入组件短暂产生空串或 NaN 时直接把非法值发给后端，导致点击保存表现为“没反应”。
    productCode: normalizedProductCode,
    productName: normalizedProductName,
    pinyinAbbr: normalizedPinyinAbbr,
    defaultPrice: normalizedDefaultPrice,
    discountRate: normalizedDiscountRate,
    ...(baseline && baseline.currentStock === normalizedCurrentStock ? {} : { currentStock: normalizedCurrentStock }),
    isActive: currentForm.isActive,
    tagIds: resolvedTagIds,
    categoryId: currentForm.categoryId || null,
    ...(isExistingYzProduct ? {} : { primarySeriesTagId: normalizedPrimarySeriesTagId || null }),
    ...resolveDefaultSkuPayload(currentForm),
    skus: currentForm.skus.length
      ? currentForm.skus.map((sku, index) => ({
          id: sku.id,
          specValues: buildSkuSpecValues(sku, index),
          defaultPrice: normalizeSubmitNumber(sku.defaultPrice, { fallback: normalizedDefaultPrice, min: 0 }),
          discountRate: normalizeSubmitNumber(sku.discountRate, { fallback: normalizedDiscountRate, min: 1, max: 10 }),
          ...resolveSkuStockField(sku.id, normalizeSubmitNumber(sku.currentStock, { fallback: 0, min: 0, integer: true })),
          isActive: sku.isActive !== false,
          isCurrent: true,
          o2oRecommended: sku.o2oRecommended === true,
          thumbnail: typeof sku.thumbnail === 'string' && sku.thumbnail.trim() ? sku.thumbnail.trim() : null,
          sortOrder: index,
          barcode: typeof sku.barcode === 'string' && sku.barcode.trim() ? sku.barcode.trim() : null,
          costPrice: sku.costPrice === null || sku.costPrice === undefined ? null : normalizeSubmitNumber(sku.costPrice, { fallback: 0, min: 0 }),
          locationId: sku.locationId || null,
        }))
      : [],
    ...(baseline
      ? {
          stockBaseline: {
            currentStock: baseline.currentStock,
            skus: [...baseline.skus.entries()].map(([id, currentStock]) => ({ id, currentStock })),
          },
        }
      : {}),
  }
}

const syncSkuMatrixRows = () => {
  const colors = parseSkuDimensionValues(form.value.skuColorText)
  const styles = parseSkuDimensionValues(form.value.skuStyleText)
  form.value.skuColorText = colors.join('，')
  form.value.skuStyleText = styles.join('，')
  form.value.skus = buildSkuMatrixRows({
    colors,
    styles,
    existingRows: form.value.skus,
    defaults: {
      defaultPrice: normalizeSubmitNumber(form.value.defaultPrice, { fallback: 0, min: 0 }),
      discountRate: normalizeDiscountRateNumber(form.value.discountRate),
      currentStock: 0,
    },
  })
}

const removeSkuRow = (index: number) => {
  form.value.skus.splice(index, 1)
}

const normalizeSkuDimensionValues = (values: string[]) => {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))]
}

const parseSkuDimensionValues = (value: string) => normalizeSkuDimensionValues(value.split(/[，,;；\n]/))

/**
 * 通用 CRUD 管理：
 * - 收敛产品页面的列表、弹窗、保存、删除流程；
 * - 页面只保留产品独有的筛选条件与标签解析逻辑。
 */
const {
  items: products,
  loading,
  dialogVisible,
  dialogTitle,
  submitting,
  form,
  loadData,
  handleAdd: openCreateDialog,
  handleEdit,
  handleDelete,
  handleSubmit,
} = useCrudManager<ProductRecord, ProductForm, CreateProductDto>({
  formRef,
  createDefaultForm,
  buildEditForm,
  buildSubmitPayload,
  loadList: async (requestConfig) => {
    const result = await getProductListPaged(
      {
        ...buildQueryParams(),
        page: productPage.value,
        pageSize: productPageSize.value,
      },
      requestConfig,
    )
    productPage.value = result.page
    productPageSize.value = result.pageSize
    productTotal.value = result.total
    return result.list
  },
  createItem: createProduct,
  updateItem: updateProduct,
  deleteItem: deleteProduct,
  messages: {
    createTitle: '新增产品',
    editTitle: '编辑产品',
    submitPending: '正在提交产品信息，请稍候',
    duplicateSubmit: '产品信息正在提交，请勿重复点击',
    validateError: '请先检查产品名称、价格等必填项',
    createSuccess: '创建成功',
    updateSuccess: '更新成功',
    saveError: '保存失败',
    loadError: '获取产品失败',
    deleteConfirm: '确定要删除该产品吗？',
    deleteSuccess: '删除成功',
    deleteError: '删除失败：该产品可能已被历史业务数据引用',
  },
  afterSubmit: async () => {
    if (!hasAutoCreatedTags.value) {
      return
    }

    hasAutoCreatedTags.value = false
    await loadTags()
  },
  syncAfterSubmit: () => {
    productPage.value = 1
    selectedProductIds.value = []
    return 'reload' as const
  },
  afterDelete: async () => {
    if (!products.value.length && productPage.value > 1) {
      productPage.value -= 1
    }
    await reloadProducts()
  },
})

const skuColorInput = computed({
  get: () => parseSkuDimensionValues(form.value.skuColorText),
  set: (values: string[]) => {
    form.value.skuColorText = normalizeSkuDimensionValues(values).join('，')
  },
})

const skuStyleInput = computed({
  get: () => parseSkuDimensionValues(form.value.skuStyleText),
  set: (values: string[]) => {
    form.value.skuStyleText = normalizeSkuDimensionValues(values).join('，')
  },
})

/**
 * YZ 编码两轴容量前置校验：
 * - 仅对已经是 YZ 编码的商品生效（legacy 商品无编码位限制）；
 * - 直接对当前输入的颜色/款式取值数量校验，不等用户点击“生成规格矩阵”，第一时间给出反馈；
 * - 非空即阻止保存，供 SKU 配置弹窗的确认按钮禁用态和错误提示共用。
 */
const skuDimensionCapacityIssues = computed(() => {
  if (form.value.codeScheme !== 'yz') {
    return []
  }
  return evaluateSkuDimensionCapacity(skuColorInput.value, skuStyleInput.value)
})

const discountRateOptions = computed(() => {
  return Array.from({ length: 91 }, (_item, index) => {
    const value = Math.round((10 - index * 0.1) * 10) / 10
    const discountedPrice = calculateDiscountedPriceText(form.value.defaultPrice, value)
    return {
      label: `${formatDiscountRateLabel(value)} / ¥${discountedPrice}`,
      value,
    }
  })
})

const buildDiscountRateOptions = (defaultPrice: unknown) => {
  return Array.from({ length: 91 }, (_item, index) => {
    const value = Math.round((10 - index * 0.1) * 10) / 10
    const discountedPrice = calculateDiscountedPriceText(defaultPrice as string | number, value)
    return {
      label: `${formatDiscountRateLabel(value)} / ¥${discountedPrice}`,
      value,
    }
  })
}

const resolveSkuThumbnail = (row: ProductSkuForm) => {
  const skuThumbnail = typeof row.thumbnail === 'string' ? row.thumbnail.trim() : ''
  return skuThumbnail || form.value.productThumbnail || ''
}

const resolveSkuFormKey = (row: ProductSkuForm) => {
  return row.id || row.specText || `${row.color || ''}-${row.style || ''}`
}

const clearSkuThumbnailUploadTimer = (key: string) => {
  const timer = skuThumbnailUploadClearTimers.value[key]
  if (timer) {
    globalThis.window.clearTimeout(timer)
    delete skuThumbnailUploadClearTimers.value[key]
  }
}

const setSkuThumbnailUploadProgress = (
  row: ProductSkuForm,
  percentage: number,
  status?: 'success' | 'exception',
) => {
  const key = resolveSkuFormKey(row)
  clearSkuThumbnailUploadTimer(key)
  skuThumbnailUploadProgresses.value[key] = Math.min(100, Math.max(0, Math.round(percentage)))
  skuThumbnailUploadStatuses.value[key] = status
}

const clearSkuThumbnailUploadProgress = (row: ProductSkuForm) => {
  const key = resolveSkuFormKey(row)
  clearSkuThumbnailUploadTimer(key)
  delete skuThumbnailUploadProgresses.value[key]
  delete skuThumbnailUploadStatuses.value[key]
}

const deferClearSkuThumbnailUploadProgress = (row: ProductSkuForm, delay = 900) => {
  const key = resolveSkuFormKey(row)
  clearSkuThumbnailUploadTimer(key)
  skuThumbnailUploadClearTimers.value[key] = globalThis.window.setTimeout(() => {
    delete skuThumbnailUploadProgresses.value[key]
    delete skuThumbnailUploadStatuses.value[key]
    delete skuThumbnailUploadClearTimers.value[key]
  }, delay)
}

const isSkuThumbnailUploading = (row: ProductSkuForm) => {
  const key = resolveSkuFormKey(row)
  return key in skuThumbnailUploadProgresses.value && skuThumbnailUploadStatuses.value[key] !== 'success' && skuThumbnailUploadStatuses.value[key] !== 'exception'
}

const resolveSkuThumbnailUploadProgress = (row: ProductSkuForm) => {
  return skuThumbnailUploadProgresses.value[resolveSkuFormKey(row)] ?? 0
}

const resolveSkuThumbnailUploadProgressStatus = (row: ProductSkuForm) => {
  return skuThumbnailUploadStatuses.value[resolveSkuFormKey(row)]
}

const currentSkuPreviewImageList = (row: ProductSkuForm) => {
  const thumbnail = resolveSkuThumbnail(row)
  return thumbnail ? [thumbnail] : []
}

const handleSkuThumbnailUpload = async (row: ProductSkuForm, options: UploadRequestOptions) => {
  const file = options.file
  try {
    setSkuThumbnailUploadProgress(row, 8)
    const { file: compressedUploadFile } = await compressImageForUpload(file)
    setSkuThumbnailUploadProgress(row, 12)
    const uploadResult = await uploadImage(compressedUploadFile, {
      onUploadProgress: (event) => {
        if (!event.total || event.total <= 0) {
          return
        }
        const uploadProgress = Math.round((event.loaded / event.total) * 87)
        setSkuThumbnailUploadProgress(row, Math.min(99, 12 + uploadProgress))
      },
    })
    row.thumbnail = uploadResult.url
    setSkuThumbnailUploadProgress(row, 100, 'success')
    options.onSuccess?.(uploadResult)
    showAppSuccess('规格图上传完成')
    deferClearSkuThumbnailUploadProgress(row)
  } catch (error) {
    console.error('规格图上传失败:', error)
    setSkuThumbnailUploadProgress(row, 100, 'exception')
    showAppError(error instanceof Error && error.message.trim() ? error.message : '规格图上传失败，请重试')
    deferClearSkuThumbnailUploadProgress(row, 1800)
  }
}

const buildSkuThumbnailUploadRequest = (row: ProductSkuForm) => {
  return (options: UploadRequestOptions) => handleSkuThumbnailUpload(row, options)
}

const handleSkuThumbnailDragEnter = (row: ProductSkuForm) => {
  skuThumbnailDragActiveId.value = resolveSkuFormKey(row)
}

const handleSkuThumbnailDragLeave = (row: ProductSkuForm) => {
  if (skuThumbnailDragActiveId.value === resolveSkuFormKey(row)) {
    skuThumbnailDragActiveId.value = ''
  }
}

const handleSkuThumbnailDrop = (row: ProductSkuForm, event: DragEvent) => {
  skuThumbnailDragActiveId.value = ''
  if (isSkuThumbnailUploading(row)) {
    showAppWarning('规格图正在上传，请稍后再试')
    return
  }
  const file = event.dataTransfer?.files?.[0]
  if (!file || !file.type.startsWith('image/')) {
    return
  }
  void handleSkuThumbnailUpload(row, {
    file,
    action: '',
    method: 'post',
    filename: 'file',
    data: {},
    headers: {},
    withCredentials: false,
    onProgress: () => undefined,
    onSuccess: () => undefined,
    onError: () => undefined,
  } as unknown as UploadRequestOptions)
}

const handleRemoveSkuThumbnail = (row: ProductSkuForm) => {
  if (isSkuThumbnailUploading(row)) {
    showAppWarning('规格图正在上传，请稍后再删除')
    return
  }
  clearSkuThumbnailUploadProgress(row)
  row.thumbnail = null
  showAppSuccess('已移除规格预览图')
}

const resolveSkuDiscountedPriceInput = (row: ProductSkuForm) => {
  return Number(calculateDiscountedPriceText(row.defaultPrice ?? 0, row.discountRate ?? 10))
}

const updateSkuDiscountedPriceInput = (row: ProductSkuForm, value: number | null) => {
  row.discountRate = resolveDiscountRateFromDiscountedPrice(row.defaultPrice ?? 0, value ?? 0)
}

const resolveSkuDiscountEditMode = (row: ProductSkuForm) => {
  return skuDiscountEditModes.value[resolveSkuFormKey(row)] ?? 'rate'
}

const handleSkuDiscountEditModeChange = (row: ProductSkuForm, value: unknown) => {
  skuDiscountEditModes.value[resolveSkuFormKey(row)] = value === 'price' ? 'price' : 'rate'
}

const isImplicitDefaultSku = (sku: ProductSkuForm) => {
  const specValues = sku.specValues ?? {}
  const specText = String(sku.specText ?? '').trim()
  return (!specText || specText === '默认规格') && (!Object.keys(specValues).length || specValues.规格 === '默认规格')
}

/**
 * 是否存在真实规格行：
 * - 与 resolveDefaultSkuPayload 同一口径——form.skus 为空即单规格商品（含历史“默认规格”唯一 SKU），
 *   编辑表单展示默认规格字段并通过 defaultSku 提交；否则提示到规格配置中维护。
 */
const hasMultipleEditableSkus = computed(() => form.value.skus.length > 0)

/**
 * 规格弹窗打开时的默认规格占位行：
 * - 代表单规格商品现有的默认 SKU，带上其 id、编码、条码、成本价与库位用于展示；
 * - 价格、折扣、库存、启停取商品级字段（单规格商品两者一致），保存时再回写。
 */
const ensureSkuConfigRows = () => {
  if (form.value.skus.length) {
    return
  }
  const snapshot = defaultSkuSnapshot
  form.value.skus = [{
    id: snapshot?.id,
    specValues: { 规格: '默认规格' },
    specText: '默认规格',
    defaultPrice: Number(form.value.defaultPrice) || 0,
    discountRate: normalizeDiscountRateNumber(form.value.discountRate),
    currentStock: Number(form.value.currentStock) || 0,
    isActive: form.value.isActive,
    isCurrent: true,
    o2oRecommended: snapshot?.o2oRecommended === true,
    thumbnail: form.value.productThumbnail,
    skuCode: snapshot?.skuCode,
    barcode: form.value.defaultBarcode || null,
    costPrice: form.value.defaultCostPrice,
    locationId: form.value.defaultLocationId || null,
    isDefaultPlaceholder: true,
    variantCode: snapshot?.variantCode ?? null,
    sizeCode: snapshot?.sizeCode ?? null,
  }]
}

/** 规格弹窗里只剩默认规格占位行时返回该行：此时仍按单规格商品保存。 */
const resolveDefaultSkuPlaceholder = (currentForm: ProductForm) => {
  const [row] = currentForm.skus
  return currentForm.skus.length === 1 && row?.isDefaultPlaceholder === true && isImplicitDefaultSku(row) ? row : null
}

/**
 * 把占位行的编辑结果回写为单规格表单：
 * - skus 置空，继续走 defaultSku 提交，避免原默认 SKU 被退役、编码变化、条码/成本价/库位丢失；
 * - 规格图回写为商品主图（仅在改动时提交）。
 */
const buildSingleSpecFormFromPlaceholder = (currentForm: ProductForm, row: ProductSkuForm): ProductForm => ({
  ...currentForm,
  defaultPrice: Number(row.defaultPrice ?? currentForm.defaultPrice) || 0,
  discountRate: normalizeDiscountRateNumber(row.discountRate ?? currentForm.discountRate),
  currentStock: Number(row.currentStock ?? currentForm.currentStock) || 0,
  isActive: row.isActive !== false,
  defaultBarcode: typeof row.barcode === 'string' ? row.barcode : '',
  defaultCostPrice: row.costPrice === null || row.costPrice === undefined ? null : Number(row.costPrice),
  defaultLocationId: row.locationId || '',
  skus: [],
})

const discountedPricePreview = computed(() => {
  return calculateDiscountedPriceText(form.value.defaultPrice, form.value.discountRate)
})

const discountedPriceInput = computed({
  get: () => Number(discountedPricePreview.value),
  set: (value: number) => {
    form.value.discountRate = resolveDiscountRateFromDiscountedPrice(form.value.defaultPrice, value)
  },
})

const minimumDiscountedPrice = computed(() => {
  return Number(calculateDiscountedPriceText(form.value.defaultPrice, 1))
})

const maximumDiscountedPrice = computed(() => {
  return Math.max(Number(form.value.defaultPrice) || 0, minimumDiscountedPrice.value)
})

const reloadProducts = async () => {
  await loadData()
  await syncSelectedProductIds()
}

const handleProductPageSizeChange = (pageSize: number) => {
  productPageSize.value = pageSize
  productPage.value = 1
  void reloadProducts()
}

const handleAdd = async () => {
  if (!ensurePermission('products:manage', '新增产品')) {
    return
  }
  await clearSelection()
  isSkuDialog.value = false
  openCreateDialog()
}

const handleEditProduct = async (row: ProductRecord) => {
  if (!ensurePermission('products:manage', '编辑产品')) {
    return
  }
  editingProductId.value = row.id
  editLoading.value = true
  await productDetailRequest.runLatest({
    executor: (signal) => getProductDetail(row.id, { signal }),
    onSuccess: (detail) => {
      isSkuDialog.value = false
      handleEdit(detail)
    },
    onError: (error) => {
      showAppError(extractErrorMessage(error, '获取产品详情失败'))
    },
    onFinally: () => {
      editingProductId.value = ''
      editLoading.value = false
    },
  })
}

const handleOpenSkuConfig = (row: ProductRecord) => {
  if (!ensurePermission('products:manage', '配置规格')) {
    return
  }
  form.value = buildEditForm(row)
  ensureSkuConfigRows()
  isSkuDialog.value = true
  dialogVisible.value = true
}

const handleSubmitSkuConfig = async () => {
  if (!form.value.id || submitting.value) {
    return
  }
  submitting.value = true
  try {
    const placeholder = resolveDefaultSkuPlaceholder(form.value)
    const submitForm = placeholder ? buildSingleSpecFormFromPlaceholder(form.value, placeholder) : form.value
    const payload = await buildSubmitPayload(submitForm)
    if (placeholder) {
      const nextThumbnail = typeof placeholder.thumbnail === 'string' && placeholder.thumbnail.trim() ? placeholder.thumbnail.trim() : null
      if (nextThumbnail !== (form.value.productThumbnail ?? null)) {
        payload.thumbnail = nextThumbnail
      }
    }
    await updateProduct(form.value.id, payload)
    dialogVisible.value = false
    showAppSuccess('规格配置已保存')
    await reloadProducts()
  } catch (error) {
    showAppError(extractErrorMessage(error, '规格配置保存失败'))
  } finally {
    submitting.value = false
  }
}

const handleDeleteProduct = async (row: ProductRecord) => {
  if (!ensurePermission('products:manage', '删除产品')) {
    return
  }
  await handleDelete(row)
}

const resolveTagIds = async (tagValues: Array<string | number>, silent = false): Promise<string[]> => {
  const createdTagNameCache = new Map<string, string>()
  const resolvedIds: string[] = []
  const autoCreatedTagNames: string[] = []

  for (const rawValue of tagValues) {
    const normalizedValue = normalizeSelectValue(rawValue)
    if (!normalizedValue) {
      continue
    }

    const existedById = allTags.value.find((tag) => tag.id === normalizedValue)
    if (existedById) {
      resolvedIds.push(existedById.id)
      continue
    }

    const existedByName = allTags.value.find((tag) => tag.tagName === normalizedValue)
    if (existedByName) {
      resolvedIds.push(existedByName.id)
      continue
    }

    const cachedId = createdTagNameCache.get(normalizedValue)
    if (cachedId) {
      resolvedIds.push(cachedId)
      continue
    }

    const created = await createTag({
      tagName: normalizedValue,
      tagCode: null,
    })
    allTags.value = [created, ...allTags.value]
    createdTagNameCache.set(normalizedValue, created.id)
    autoCreatedTagNames.push(normalizedValue)
    resolvedIds.push(created.id)
  }

  if (autoCreatedTagNames.length) {
    hasAutoCreatedTags.value = true
    if (!silent) {
      showAppSuccess(`已自动创建标签：${[...new Set(autoCreatedTagNames)].join('、')}`)
    }
  }

  return [...new Set(resolvedIds)]
}

const refreshProductView = async () => {
  await Promise.all([loadTags(), loadInventoryDictionaries(), reloadProducts()])
}

const handleBatchUpdateStatus = async (isActive: boolean) => {
  if (!ensurePermission('products:manage', isActive ? '批量启用产品' : '批量停用产品')) {
    return
  }
  if (!selectedProductIds.value.length) {
    showAppWarning('请先选择要批量处理的产品')
    return
  }

  batchSubmitting.value = true
  try {
    const updatedCount = selectedProductIds.value.length
    await batchUpdateProducts({
      ids: selectedProductIds.value,
      isActive,
    })
    await clearSelection()
    await reloadProducts()
    showAppSuccess(`已批量${isActive ? '启用' : '停用'} ${updatedCount} 个产品`)
  } catch (error) {
    showAppError(extractErrorMessage(error, '批量修改失败'))
  } finally {
    batchSubmitting.value = false
  }
}

const handleCompactBatchCommand = (command: string | number | object) => {
  if (command === 'activate') {
    void handleBatchUpdateStatus(true)
    return
  }

  if (command === 'deactivate') {
    void handleBatchUpdateStatus(false)
    return
  }

  if (command === 'clear') {
    void clearSelection()
    return
  }

  if (command === 'print') {
    openPrintDialog()
  }
}

const openBatchCreateDialog = () => {
  if (!ensurePermission('products:manage', '批量新增产品')) {
    return
  }
  batchCreateRows.value = [createBatchCreateFormRow()]
  batchCreateDialogVisible.value = true
}

const resetBatchCreateRows = () => {
  batchCreateRows.value = [createBatchCreateFormRow()]
}

const addBatchCreateRow = () => {
  if (batchCreateRows.value.length >= BATCH_CREATE_MAX_ROWS) {
    showAppWarning(`单次最多新增 ${BATCH_CREATE_MAX_ROWS} 行`)
    return
  }
  batchCreateRows.value.push(createBatchCreateFormRow())
}

const removeBatchCreateRow = (rowId: string) => {
  if (batchCreateRows.value.length <= 1) {
    showAppWarning('至少保留一行产品')
    return
  }
  batchCreateRows.value = batchCreateRows.value.filter((row) => row.rowId !== rowId)
}

const handleBatchCreate = async () => {
  if (!ensurePermission('products:manage', '批量新增产品')) {
    return
  }
  const validationError = validateBatchCreateRows(batchCreateRows.value)
  if (validationError) {
    showAppWarning(validationError)
    return
  }

  batchCreateSubmitting.value = true
  hasAutoCreatedTags.value = false
  try {
    const productsPayload: CreateProductDto[] = []
    for (const row of batchCreateRows.value) {
      const tagIds = await resolveTagIds(row.tagIds, true)
      productsPayload.push({
        productCode: normalizeOptionalSubmitText(row.productCode),
        productName: normalizeSubmitText(row.productName),
        pinyinAbbr: normalizeSubmitText(row.pinyinAbbr),
        defaultPrice: normalizeSubmitNumber(row.defaultPrice, {
          fallback: 0,
          min: 0,
        }),
        discountRate: normalizeSubmitNumber(row.discountRate, {
          fallback: 10,
          min: 1,
          max: 10,
        }),
        currentStock: normalizeSubmitNumber(row.currentStock, {
          fallback: 0,
          min: 0,
          integer: true,
        }),
        isActive: row.isActive,
        tagIds,
      })
    }

    const createdProducts = await batchCreateProducts({
      products: productsPayload,
    })
    if (hasAutoCreatedTags.value) {
      await loadTags()
      showAppSuccess('已自动创建并关联缺失标签')
    }
    await clearSelection()
    await reloadProducts()
    batchCreateDialogVisible.value = false
    showAppSuccess(`已批量新增 ${createdProducts.length} 个产品`)
  } catch (error) {
    showAppError(extractErrorMessage(error, '批量新增失败'))
  } finally {
    batchCreateSubmitting.value = false
  }
}

onMounted(() => {
  pageReady.value = true
  void refreshProductView()
  if (globalThis.sessionStorage.getItem('ylink:o2o-batch-create') === '1') {
    globalThis.sessionStorage.removeItem('ylink:o2o-batch-create')
    openBatchCreateDialog()
  }
})

onActivated(() => {
  if (!pageReady.value) {
    return
  }

  if (!keepAliveActivated.value) {
    keepAliveActivated.value = true
    return
  }

  void refreshProductView()
})
</script>

<template>
  <div class="product-manager flex min-w-0 flex-col gap-4">
    <PageToolbarCard compact content-class="product-toolbar-content" actions-class="product-toolbar-actions" :action-stretch-on-phone="false">
      <template #default="{ isPhone, isTablet }">
        <div class="product-toolbar-search flex w-full flex-wrap gap-2.5">
          <el-input
            v-model="searchKeyword"
            placeholder="搜索产品名称/拼音/编码"
            :class="isPhone ? 'product-toolbar-search__keyword' : isTablet ? '!w-[240px]' : '!w-[300px]'"
            clearable
            @clear="handleSearch"
            @keyup.enter="handleSearch"
          />
          <el-select
            v-model="searchTagId"
            placeholder="按标签筛选"
            clearable
            :class="isPhone ? 'product-toolbar-search__tag' : isTablet ? '!w-[200px]' : '!w-[220px]'"
            @change="handleSearch"
          >
            <el-option
              v-for="tag in allTags"
              :key="tag.id"
              :label="tag.tagName"
              :value="tag.id"
            />
          </el-select>
          <el-select
            v-model="searchCategoryId"
            placeholder="按分类筛选"
            clearable
            :class="isPhone ? 'product-toolbar-search__tag' : isTablet ? '!w-[160px]' : '!w-[180px]'"
            @change="handleSearch"
          >
            <el-option v-for="category in allCategories" :key="category.id" :label="`${category.categoryCode} ${category.categoryName}`" :value="category.id" />
          </el-select>
          <el-button :class="isPhone ? 'product-toolbar-search__submit' : ''" type="primary" icon="Search" @click="handleSearch">搜索</el-button>
        </div>
      </template>

      <template #actions="{ isPhone }">
        <div v-if="isPhone" class="product-toolbar-action-row">
          <el-tag v-if="canManageProducts" type="info">已选 {{ selectedProductCount }} 项</el-tag>
          <el-tag v-else type="info">当前为只读模式</el-tag>
          <template v-if="canManageProducts">
            <el-dropdown
              trigger="click"
              :disabled="!selectedProductCount || batchSubmitting"
              @command="handleCompactBatchCommand"
            >
              <el-button size="small" :disabled="!selectedProductCount" :loading="batchSubmitting">
                批量操作
              </el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="activate" :disabled="!selectedProductCount">批量启用</el-dropdown-item>
                  <el-dropdown-item command="deactivate" :disabled="!selectedProductCount">批量停用</el-dropdown-item>
                  <el-dropdown-item command="clear" :disabled="!selectedProductCount">清空选择</el-dropdown-item>
                  <el-dropdown-item command="print" :disabled="!selectedProductCount">打印条码</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
            <el-button size="small" type="primary" plain @click="openBatchCreateDialog">
              批量新增
            </el-button>
            <el-button size="small" type="primary" icon="Plus" @click="handleAdd">新增产品</el-button>
          </template>
        </div>
        <div v-else class="flex w-full flex-wrap justify-end gap-2">
          <el-tag v-if="canManageProducts" type="info">已选 {{ selectedProductCount }} 项</el-tag>
          <el-tag v-else type="info">当前为只读模式</el-tag>
          <el-button
            v-if="canManageProducts"
            :disabled="!selectedProductCount"
            :loading="batchSubmitting"
            @click="handleBatchUpdateStatus(true)"
          >
            批量启用
          </el-button>
          <el-button
            v-if="canManageProducts"
            :disabled="!selectedProductCount"
            :loading="batchSubmitting"
            @click="handleBatchUpdateStatus(false)"
          >
            批量停用
          </el-button>
          <el-button v-if="canManageProducts" :disabled="!selectedProductCount" @click="clearSelection">
            清空选择
          </el-button>
          <el-button :disabled="!selectedProductCount" @click="openPrintDialog">打印条码</el-button>
          <el-button :loading="exportLoading" @click="handleExportProducts">导出</el-button>
          <el-button v-if="canImportProducts" @click="importDialogVisible = true">Excel 导入</el-button>
          <el-button v-if="canImportProducts" @click="yzImportDialogVisible = true">YZ 建库导入</el-button>
          <el-button v-if="canManageProducts" type="primary" plain @click="openBatchCreateDialog">
            批量新增
          </el-button>
          <el-button v-if="canManageProducts" type="primary" icon="Plus" @click="handleAdd">新增产品</el-button>
        </div>
      </template>
    </PageToolbarCard>

    <BizResponsiveDataCollectionShell
      :items="displayProducts"
      :loading="loading"
      empty-description="暂无产品数据"
      :empty-card="true"
      :disable-card-transition="true"
      card-key="id"
      wrapper-class="flex min-h-0 flex-1 flex-col"
      table-wrapper-class="apple-card h-full min-w-0 overflow-hidden px-0 py-3 sm:py-4 xl:py-5"
      card-container-class="pb-4 xl:grid-cols-3"
    >
      <template #table>
        <el-table native-scrollbar
          ref="productTableRef"
          :data="displayProducts"
          class="h-full w-full"
          stripe
          border
          row-key="id"
          table-layout="auto"
          :default-sort="{ prop: 'productCode', order: 'ascending' }"
          @selection-change="handleTableSelectionChange"
          @sort-change="handleTableSortChange"
        >
            <el-table-column v-if="canManageProducts" type="selection" width="52" reserve-selection />
            <el-table-column
              label="产品编码"
              prop="productCode"
              min-width="150"
              show-overflow-tooltip
              sortable="custom"
              :sort-orders="['ascending', 'descending']"
            >
              <template #default="{ row }">
                <span>{{ row.productCode }}</span>
                <el-tag v-if="row.codeScheme === 'yz' && row.seriesCode" size="small" type="success" effect="plain" class="ml-1">
                  {{ row.seriesCode }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="产品名称" prop="productName" min-width="220" show-overflow-tooltip />
            <el-table-column label="拼音首字母" prop="pinyinAbbr" width="120" show-overflow-tooltip />
            <el-table-column label="分类" width="110" show-overflow-tooltip>
              <template #default="{ row }">{{ row.categoryName || '—' }}</template>
            </el-table-column>
            <el-table-column label="基础售价" prop="defaultPrice" width="132">
              <template #default="{ row }">
                ¥{{ Number(row.defaultPrice).toFixed(2) }}
              </template>
            </el-table-column>
            <el-table-column label="基础库存" min-width="170">
              <template #default="{ row }">
                <div class="leading-5">
                  <div>当前库存：{{ row.currentStock }}</div>
                  <div class="text-xs text-slate-500 dark:text-slate-400">可用库存：{{ row.availableStock }}</div>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="状态" prop="isActive" width="96">
              <template #default="{ row }">
                <el-tag :type="row.isActive ? 'success' : 'info'" size="small">
                  {{ row.isActive ? '启用' : '停用' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="标签" min-width="240">
              <template #default="{ row }">
                <div class="flex flex-wrap gap-1">
                  <el-tag
                    v-for="tag in row.tags"
                    :key="tag.id"
                    :color="tag.tagCode || '#409EFF'"
                    effect="dark"
                    size="small"
                    class="border-none"
                  >
                    {{ tag.tagName }}
                  </el-tag>
                </div>
              </template>
            </el-table-column>
            <el-table-column v-if="canManageProducts" label="操作" width="176" align="right" fixed="right">
              <template #default="{ row }">
                <el-button
                  link
                  type="primary"
                  @click="handleOpenSkuConfig(row)"
                >
                  规格
                </el-button>
                <el-button
                  link
                  type="primary"
                  :loading="editLoading && editingProductId === row.id"
                  @click="handleEditProduct(row)"
                >
                  编辑
                </el-button>
                <el-button link type="danger" @click="handleDeleteProduct(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
      </template>

      <template #card="{ item }">
        <div class="apple-card mobile-product-card min-w-0 p-3">
          <div class="mb-2 flex items-center justify-between gap-2">
            <el-checkbox
              v-if="canManageProducts"
              :model-value="selectedProductIds.includes(item.id)"
              @change="handleCardSelectionChange(item.id, $event)"
            >
              选择产品
            </el-checkbox>
            <el-tag :type="item.isActive ? 'success' : 'info'" size="small">
              {{ item.isActive ? '启用' : '停用' }}
            </el-tag>
          </div>
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <h4 class="truncate text-[15px] font-semibold leading-5 text-slate-800 dark:text-slate-100">
                {{ item.productName }}
              </h4>
              <p class="mt-0.5 break-all text-xs leading-5 text-slate-500 dark:text-slate-400">
                {{ item.productCode }}
                <el-tag v-if="item.codeScheme === 'yz' && item.seriesCode" size="small" type="success" effect="plain" class="ml-1">
                  {{ item.seriesCode }}
                </el-tag>
              </p>
            </div>
            <div class="text-right">
              <span class="font-medium text-red-500">¥{{ Number(item.defaultPrice).toFixed(2) }}</span>
            </div>
          </div>
          <div class="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
            库存：当前 {{ item.currentStock }} / 可用 {{ item.availableStock }}
          </div>
          <div v-if="item.tags.length" class="product-mobile-tag-row mt-2 flex flex-wrap gap-1">
            <el-tag
              v-for="tag in item.tags"
              :key="tag.id"
              :color="tag.tagCode || '#409EFF'"
              effect="dark"
              size="small"
              class="border-none"
            >
              {{ tag.tagName }}
            </el-tag>
          </div>
          <div v-if="canManageProducts" class="product-mobile-actions mt-2 flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-2 dark:border-white/10">
            <el-button size="small" @click="handleOpenSkuConfig(item)">
              规格
            </el-button>
            <el-button size="small" :loading="editLoading && editingProductId === item.id" @click="handleEditProduct(item)">
              编辑
            </el-button>
            <el-button size="small" type="danger" plain @click="handleDeleteProduct(item)">删除</el-button>
          </div>
        </div>
      </template>
    </BizResponsiveDataCollectionShell>

    <div class="flex w-full min-w-0 justify-end">
      <el-pagination
        v-model:current-page="productPage"
        v-model:page-size="productPageSize"
        layout="sizes, prev, pager, next"
        :page-sizes="[10, 20, 50]"
        :total="productTotal"
        @current-change="reloadProducts"
        @size-change="handleProductPageSizeChange"
      />
    </div>

    <BizCrudDialogShell
      v-if="canManageProducts"
      v-model="batchCreateDialogVisible"
      title="批量新增产品"
      height-mode="scroll"
      phone-width="96%"
      tablet-width="920px"
      desktop-width="1080px"
      :confirm-loading="batchCreateSubmitting"
      confirm-text="批量提交"
      dialog-class="product-dialog product-batch-dialog"
      @confirm="handleBatchCreate"
    >
      <template #default="{ isPhone }">
        <section class="flex flex-col gap-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="text-xs text-slate-500">
              当前 {{ batchCreateRowCount }} 行 / 上限 {{ BATCH_CREATE_MAX_ROWS }} 行
            </p>
            <div class="flex flex-wrap items-center gap-2">
              <el-button size="small" @click="resetBatchCreateRows">重置</el-button>
              <el-button size="small" type="primary" plain @click="addBatchCreateRow">新增一行</el-button>
            </div>
          </div>
          <div class="rounded-xl border border-slate-200">
            <el-table native-scrollbar :data="batchCreateRows" size="small" max-height="460">
              <el-table-column label="#" width="56" align="center">
                <template #default="{ $index }">
                  {{ $index + 1 }}
                </template>
              </el-table-column>
              <el-table-column label="产品编码" min-width="160">
                <template #default="{ row }">
                  <el-input v-model="row.productCode" placeholder="留空自动生成统一编码" />
                </template>
              </el-table-column>
              <el-table-column label="产品名称" min-width="180">
                <template #default="{ row }">
                  <el-input v-model="row.productName" placeholder="请输入产品名称" />
                </template>
              </el-table-column>
              <el-table-column label="拼音简写" min-width="160">
                <template #default="{ row }">
                  <el-input v-model="row.pinyinAbbr" placeholder="可选" />
                </template>
              </el-table-column>
              <el-table-column label="基础售价" min-width="150">
                <template #default="{ row }">
                  <PassiveNumberInput v-model="row.defaultPrice" :min="0" :precision="2" :step="1" class="w-full" />
                </template>
              </el-table-column>
              <el-table-column label="基础库存" min-width="150">
                <template #default="{ row }">
                  <PassiveNumberInput v-model="row.currentStock" :min="0" :step="1" :precision="0" class="w-full" />
                </template>
              </el-table-column>
              <el-table-column label="关联标签" min-width="220">
                <template #default="{ row }">
                  <el-select
                    v-model="row.tagIds"
                    multiple
                    filterable
                    allow-create
                    default-first-option
                    :reserve-keyword="false"
                    placeholder="请选择关联标签"
                    class="w-full"
                  >
                    <el-option
                      v-for="tag in allTags"
                      :key="tag.id"
                      :label="tag.tagName"
                      :value="tag.id"
                    />
                  </el-select>
                </template>
              </el-table-column>
              <el-table-column label="状态" width="108">
                <template #default="{ row }">
                  <el-switch v-model="row.isActive" inline-prompt active-text="启用" inactive-text="停用" />
                </template>
              </el-table-column>
              <el-table-column label="操作" width="86" fixed="right" align="center">
                <template #default="{ row }">
                  <el-button
                    link
                    type="danger"
                    :disabled="batchCreateRows.length <= 1"
                    @click="removeBatchCreateRow(row.rowId)"
                  >
                    删除
                  </el-button>
                </template>
              </el-table-column>
            </el-table>
          </div>
          <p class="text-xs leading-5 text-slate-400">
            提示：批量提交采用整批回滚策略；任一行校验失败会整体失败。不存在标签会自动创建后再关联。
          </p>
          <p class="text-xs leading-5 text-amber-500">
            批量新增本批仅支持历史编码（legacy），暂不支持按文创系列生成 YZ 编码；如需 YZ 编码商品，请使用「新增产品」逐个录入。
          </p>
          <p v-if="isPhone" class="text-xs text-slate-400">
            移动端建议分批录入，单次最多 50 行。
          </p>
        </section>
      </template>
    </BizCrudDialogShell>

    <BizCrudDialogShell
      v-if="canManageProducts"
      v-model="dialogVisible"
      :title="isSkuDialog ? '规格配置' : dialogTitle"
      height-mode="auto"
      phone-width="94%"
      :tablet-width="isSkuDialog ? '92%' : '720px'"
      :desktop-width="isSkuDialog ? '920px' : '500px'"
      :confirm-loading="submitting"
      dialog-class="product-dialog"
    >
      <template #default="{ isPhone }">
        <div v-if="isSkuDialog" class="product-sku-config-card flex flex-col gap-5">
          <div class="sku-card sku-form rounded-xl border border-slate-200 bg-slate-50/50 p-4 dark:border-white/10 dark:bg-slate-900/20" style="min-inline-size: 0; max-width: 100%">
            <h3 class="mb-4 text-sm font-semibold text-slate-800 dark:text-slate-200">规格维度配置</h3>
            <p v-if="form.codeScheme === 'yz'" class="mb-2 text-xs leading-5 text-slate-400">
              YZ 编码规则：颜色/款式最多 9 个（编码位 1-9），尺码最多 5 个（编码位 A-E）
            </p>
            <div class="sku-dims">
              <label>
                <span>颜色/款式</span>
                <el-input-tag
                  v-model="skuColorInput"
                  clearable
                  placeholder="输入颜色或款式后按回车，如：米色、明心书院"
                />
              </label>
              <label>
                <span>尺码</span>
                <el-input-tag
                  v-model="skuStyleInput"
                  clearable
                  placeholder="输入尺码后按回车，如：S、M、L"
                />
              </label>
              <div v-if="skuDimensionCapacityIssues.length" class="sku-capacity-issues">
                <p v-for="issue in skuDimensionCapacityIssues" :key="issue.dimension" class="text-xs text-red-500">
                  {{ issue.message }}
                </p>
              </div>
              <div class="mt-1 flex flex-wrap gap-2">
                <el-button class="sku-gen" icon="Grid" type="primary" plain @click="syncSkuMatrixRows">生成规格矩阵</el-button>
                <el-button v-if="form.id && form.codeScheme === 'yz'" plain @click="openSpecValueRenameDialog">
                  重命名规格取值
                </el-button>
                <el-button v-if="form.id && form.codeScheme === 'yz' && hasZeroSpecToEvolve" plain @click="openZeroSpecEvolveDialog">
                  0 号规格演进
                </el-button>
              </div>
            </div>
          </div>

          <div v-if="form.skus.length" class="flex flex-col gap-3">
            <h3 class="text-sm font-semibold text-slate-800 dark:text-slate-200">规格基础配置</h3>
            <div class="sku-scroll rounded-xl border border-slate-200 dark:border-white/10" style="overflow-x: auto">
              <el-table native-scrollbar :data="form.skus" size="small" class="sku-table w-full">
                <el-table-column prop="specText" label="规格" min-width="150" show-overflow-tooltip>
                  <template #default="{ row }">
                    <div>{{ row.specText }}</div>
                    <div class="text-xs text-slate-400">{{ row.skuCode || '保存后生成编码' }}</div>
                  </template>
                </el-table-column>
                <el-table-column v-if="form.codeScheme === 'yz'" label="编码位" width="88" align="center">
                  <template #default="{ row }">
                    <span class="font-mono text-xs text-slate-400">{{ `${row.variantCode ?? ''}${row.sizeCode ?? ''}` || '—' }}</span>
                  </template>
                </el-table-column>
                <el-table-column label="规格图" width="112" align="center">
                  <template #default="{ row }">
                    <div
                      class="sku-thumb-uploader"
                      :class="{
                        'is-drag-active': skuThumbnailDragActiveId === resolveSkuFormKey(row),
                      }"
                      @dragenter.prevent="handleSkuThumbnailDragEnter(row)"
                      @dragover.prevent="handleSkuThumbnailDragEnter(row)"
                      @dragleave.prevent="handleSkuThumbnailDragLeave(row)"
                      @drop.prevent="handleSkuThumbnailDrop(row, $event)"
                    >
                      <PassivePreviewImage
                        v-if="resolveSkuThumbnail(row) && !isSkuThumbnailUploading(row)"
                        :src="resolveSkuThumbnail(row)"
                        :preview-images="currentSkuPreviewImageList(row)"
                        fit="cover"
                        class="sku-thumb-image sku-thumb-preview-trigger"
                        alt="规格预览图"
                        dialog-title="规格预览图"
                      />
                      <el-upload
                        action=""
                        :http-request="buildSkuThumbnailUploadRequest(row)"
                        :show-file-list="false"
                        accept="image/*"
                        :disabled="isSkuThumbnailUploading(row)"
                      >
                        <button
                          v-if="!resolveSkuThumbnail(row) || isSkuThumbnailUploading(row)"
                          type="button"
                          class="sku-thumb-button"
                          :class="{ 'is-uploading': isSkuThumbnailUploading(row) }"
                        >
                          <template v-if="isSkuThumbnailUploading(row)">
                            <span class="sku-thumb-progress-label">{{ resolveSkuThumbnailUploadProgress(row) }}%</span>
                            <el-progress
                              class="sku-thumb-progress sku-thumb-progress-overlay"
                              :percentage="resolveSkuThumbnailUploadProgress(row)"
                              :status="resolveSkuThumbnailUploadProgressStatus(row)"
                              :stroke-width="4"
                              :show-text="false"
                            />
                          </template>
                          <span v-else>上传</span>
                        </button>
                        <button v-else type="button" class="sku-thumb-replace-button">更换</button>
                      </el-upload>
                      <button
                        v-if="row.thumbnail && !isSkuThumbnailUploading(row)"
                        type="button"
                        class="sku-thumb-remove"
                        aria-label="删除规格预览图"
                        @click.stop="handleRemoveSkuThumbnail(row)"
                      >
                        ×
                      </button>
                    </div>
                  </template>
                </el-table-column>
                <el-table-column label="基础售价" width="132">
                  <template #default="{ row }">
                    <PassiveNumberInput v-model="row.defaultPrice" class="w-full" :controls="false" :min="0" :precision="2" :step="1" placeholder="售价" />
                  </template>
                </el-table-column>
                <el-table-column label="默认折扣" width="174">
                  <template #default="{ row }">
                    <div class="sku-discount-editor">
                      <el-segmented
                        :model-value="resolveSkuDiscountEditMode(row)"
                        :options="discountEditModeOptions"
                        class="sku-discount-editor__mode"
                        @update:model-value="handleSkuDiscountEditModeChange(row, $event)"
                      />
                      <el-select
                        v-if="resolveSkuDiscountEditMode(row) === 'rate'"
                        v-model="row.discountRate"
                        filterable
                        class="sku-discount-select w-full"
                        placeholder="折扣"
                      >
                      <el-option
                        v-for="option in buildDiscountRateOptions(row.defaultPrice)"
                        :key="option.value"
                        :label="option.label"
                        :value="option.value"
                      />
                      </el-select>
                      <PassiveNumberInput
                        v-else
                        :model-value="resolveSkuDiscountedPriceInput(row)"
                        :min="Number(calculateDiscountedPriceText(row.defaultPrice || 0, 1))"
                        :max="Math.max(Number(row.defaultPrice) || 0, Number(calculateDiscountedPriceText(row.defaultPrice || 0, 1)))"
                        :precision="2"
                        :step="1"
                        class="w-full"
                        placeholder="折后价"
                        @update:model-value="updateSkuDiscountedPriceInput(row, $event)"
                      />
                    </div>
                  </template>
                </el-table-column>
                <el-table-column label="库存" width="132">
                  <template #default="{ row }">
                    <PassiveNumberInput v-model="row.currentStock" class="w-full" :controls="false" :min="0" :precision="0" :step="1" placeholder="库存" />
                  </template>
                </el-table-column>
                <el-table-column label="原厂条码" width="150">
                  <template #default="{ row }">
                    <el-input v-model="row.barcode" maxlength="64" placeholder="留空用 SKU 编码" />
                  </template>
                </el-table-column>
                <el-table-column label="成本价" width="110">
                  <template #default="{ row }">
                    <PassiveNumberInput v-model="row.costPrice" class="w-full" :controls="false" :min="0" :precision="2" placeholder="成本" />
                  </template>
                </el-table-column>
                <el-table-column label="库位" width="130">
                  <template #default="{ row }">
                    <el-select v-model="row.locationId" clearable filterable placeholder="库位">
                      <el-option
                        v-if="row.locationId && !activeLocationOptions.some((item) => item.id === row.locationId)"
                        :label="resolveLocationLabel(row.locationId)"
                        :value="row.locationId"
                      />
                      <el-option v-for="location in activeLocationOptions" :key="location.id" :label="location.locationCode" :value="location.id" />
                    </el-select>
                  </template>
                </el-table-column>
                <el-table-column label="状态" width="72" align="center">
                  <template #default="{ row }">
                    <el-switch v-model="row.isActive" aria-label="SKU 启停" />
                  </template>
                </el-table-column>
                <el-table-column label="操作" width="60" align="center">
                  <template #default="{ $index }">
                    <el-button type="danger" link @click="removeSkuRow($index)">移除</el-button>
                  </template>
                </el-table-column>
              </el-table>
            </div>
          </div>
        </div>
        <el-form v-else ref="formRef" :model="form" :rules="rules" :label-width="isPhone ? '82px' : '90px'">
          <el-form-item label="产品编码" prop="productCode">
            <el-input v-model="form.productCode" :disabled="productCodeFieldDisabled" :placeholder="productCodePlaceholder" />
          </el-form-item>
          <el-form-item label="文创系列" prop="primarySeriesTagId">
            <el-select
              v-model="form.primarySeriesTagId"
              filterable
              :disabled="!!form.id"
              placeholder="请选择文创系列"
              class="w-full"
              @change="handlePrimarySeriesTagChange"
            >
              <el-option
                v-for="tag in seriesTagOptions"
                :key="tag.id"
                :label="formatSeriesTagOptionLabel(tag)"
                :value="tag.id"
              />
            </el-select>
            <p v-if="!form.id && !hasSeriesTagOptions" class="mt-1 text-xs leading-5 text-amber-500">
              尚未配置文创系列，请先到标签管理页为标签设置两位系列编码
              <el-button link type="primary" size="small" class="ml-1" @click="goToTagManagement">前往标签管理</el-button>
            </p>
            <p v-else-if="form.id && form.codeScheme === 'yz'" class="mt-1 text-xs leading-5 text-slate-400">
              YZ 编码商品的文创系列不可修改
            </p>
            <template v-else-if="form.id && form.codeScheme === 'legacy'">
              <p class="mt-1 text-xs leading-5 text-slate-400">
                历史编码商品暂未接入文创系列，如需切换为 YZ 编码请使用下方升级入口
              </p>
              <el-button class="mt-2" size="small" type="primary" plain @click="openYzUpgradeDialog">
                升级到 YZ 编码
              </el-button>
            </template>
          </el-form-item>
          <el-form-item label="产品名称" prop="productName">
            <el-input v-model="form.productName" placeholder="请输入产品名称" />
          </el-form-item>
          <el-form-item label="拼音简写" prop="pinyinAbbr">
            <el-input v-model="form.pinyinAbbr" placeholder="请输入拼音简写(可选)" />
          </el-form-item>
          <el-form-item label="商品分类">
            <el-select v-model="form.categoryId" clearable filterable placeholder="选择分类后新规格按 WC 规则编码" class="w-full">
              <el-option
                v-for="category in activeCategoryOptions"
                :key="category.id"
                :label="`${category.categoryCode} ${category.categoryName}${category.isActive ? '' : '（已停用）'}`"
                :value="category.id"
              />
            </el-select>
          </el-form-item>
          <div v-if="hasMultipleEditableSkus" class="sku-owned-fields-hint">
            该商品已启用多规格，价格、库存和折扣请在规格配置中维护。
          </div>
          <template v-else>
            <el-form-item label="基础售价" prop="defaultPrice">
              <PassiveNumberInput
                v-model="form.defaultPrice"
                :min="0"
                :precision="2"
                :step="1"
                class="w-full"
                placeholder="请输入售价"
              />
            </el-form-item>
            <el-form-item label="基础折扣" prop="discountRate">
              <div class="product-discount-editor">
                <el-segmented
                  v-model="discountEditMode"
                  :options="discountEditModeOptions"
                  class="product-discount-editor__mode"
                />
                <el-select
                  v-if="discountEditMode === 'rate'"
                  v-model="form.discountRate"
                  filterable
                  class="w-full"
                  placeholder="请选择折扣"
                >
                  <el-option
                    v-for="option in discountRateOptions"
                    :key="option.value"
                    :label="option.label"
                    :value="option.value"
                  />
                </el-select>
                <PassiveNumberInput
                  v-else
                  v-model="discountedPriceInput"
                  :min="minimumDiscountedPrice"
                  :max="maximumDiscountedPrice"
                  :precision="2"
                  :step="1"
                  class="w-full"
                  placeholder="请输入折后价格"
                  :disabled="Number(form.defaultPrice) <= 0"
                />
                <p class="product-discount-editor__hint">
                  基础折扣作为商品默认值保存；线上展示策略请在“线上展示”中维护。当前折后价 ¥{{ discountedPricePreview }}。
                </p>
              </div>
            </el-form-item>
            <el-form-item label="基础库存" prop="currentStock">
              <PassiveNumberInput
                v-model="form.currentStock"
                :min="0"
                :step="1"
                class="w-full"
                placeholder="请输入基础库存"
              />
            </el-form-item>
            <el-form-item label="原厂条码">
              <el-input v-model="form.defaultBarcode" maxlength="64" :placeholder="form.defaultSkuCode ? `留空则打印 SKU 编码 ${form.defaultSkuCode}` : '留空则打印 SKU 编码'" />
            </el-form-item>
            <el-form-item label="成本价">
              <PassiveNumberInput v-model="form.defaultCostPrice" :min="0" :precision="2" class="w-full" placeholder="可选" />
            </el-form-item>
            <el-form-item label="默认库位">
              <el-select v-model="form.defaultLocationId" clearable filterable placeholder="可选" class="w-full">
                <el-option
                  v-if="form.defaultLocationId && !activeLocationOptions.some((item) => item.id === form.defaultLocationId)"
                  :label="resolveLocationLabel(form.defaultLocationId)"
                  :value="form.defaultLocationId"
                />
                <el-option v-for="location in activeLocationOptions" :key="location.id" :label="location.locationCode" :value="location.id" />
              </el-select>
            </el-form-item>
          </template>
          <el-form-item label="关联标签" prop="tagIds">
            <el-select
              v-model="form.tagIds"
              multiple
              filterable
              allow-create
              default-first-option
              :reserve-keyword="false"
              placeholder="请选择关联标签"
              class="w-full"
            >
              <el-option
                v-for="tag in allTags"
                :key="tag.id"
                :label="tag.tagName"
                :value="tag.id"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="基础状态" prop="isActive">
            <el-switch v-model="form.isActive" active-text="启用" inactive-text="停用" />
            <p class="mt-2 text-xs leading-5 text-slate-400">
              基础状态控制商品是否可被线上展示引用；客户端上架、推荐和图文内容请在“线上展示”中维护。
            </p>
          </el-form-item>
        </el-form>
      </template>

      <template #footer="{ close }">
        <span class="flex flex-wrap justify-end gap-2">
          <el-button @click="close">取消</el-button>
          <el-button
            type="primary"
            :loading="submitting"
            :disabled="isSkuDialog && skuDimensionCapacityIssues.length > 0"
            @click="isSkuDialog ? handleSubmitSkuConfig() : handleSubmit()"
          >
            确认
          </el-button>
        </span>
      </template>
    </BizCrudDialogShell>

    <ProductImportDialog v-if="importDialogVisible" v-model="importDialogVisible" @imported="reloadProducts" />
    <ProductYzImportDialog v-if="yzImportDialogVisible" v-model="yzImportDialogVisible" @imported="reloadProducts" />
    <BarcodeLabelPrintDialog v-if="printDialogVisible" v-model="printDialogVisible" :sku-ids="printSkuIds" />
    <ProductYzUpgradeDialog
      v-if="canManageProducts && yzUpgradeDialogVisible"
      v-model="yzUpgradeDialogVisible"
      :product-id="form.id"
      :product-name="form.productName"
      :series-tag-options="seriesTagOptions"
      @upgraded="handleYzUpgraded"
    />
    <ProductSpecValueRenameDialog
      v-if="canManageProducts && specValueRenameDialogVisible"
      v-model="specValueRenameDialogVisible"
      :product-id="form.id"
      :product-name="form.productName"
      :variant-values="skuColorInput"
      :size-values="skuStyleInput"
      @renamed="handleSpecValueRenamed"
    />
    <ProductZeroSpecEvolveDialog
      v-if="canManageProducts && zeroSpecEvolveDialogVisible"
      v-model="zeroSpecEvolveDialogVisible"
      :product-id="form.id"
      :product-name="form.productName"
      :variant-evolvable="hasZeroVariantSku"
      :size-evolvable="hasZeroSizeSku"
      @evolved="handleZeroSpecEvolved"
    />
  </div>
</template>

<style scoped>
.mobile-product-card {
  transition: transform 0.25s ease, box-shadow 0.25s ease;
}

.product-mobile-tag-row {
  max-height: 48px;
  overflow: hidden;
}

.product-discount-editor {
  display: flex;
  width: 100%;
  min-width: 0;
  flex-direction: column;
  gap: 10px;
}

.product-discount-editor__mode {
  align-self: flex-start;
}

.product-discount-editor__hint {
  margin: 0;
  color: rgb(100 116 139);
  font-size: 12px;
  line-height: 1.6;
}

.sku-owned-fields-hint {
  margin-bottom: 16px;
  border: 1px solid rgb(226 232 240);
  border-radius: 8px;
  background: rgb(248 250 252);
  padding: 12px 14px;
  color: rgb(100 116 139);
  font-size: 13px;
  line-height: 1.6;
}

.sku-dims {
  display: grid;
  gap: 8px;
}

.sku-dims label {
  display: grid;
  gap: 6px;
  min-width: 0;
  color: rgb(71 85 105);
  font-size: 13px;
}

.sku-capacity-issues {
  display: grid;
  gap: 2px;
  margin-top: 4px;
}

.sku-gen {
  margin-top: 8px;
}

.sku-scroll {
  max-width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
}

.sku-table {
  min-width: 860px;
}

.sku-thumb-uploader {
  position: relative;
  display: grid;
  justify-items: center;
  gap: 4px;
  width: 54px;
  margin: 0 auto;
}

.sku-thumb-preview-trigger {
  width: 54px;
  height: 54px;
}

.sku-thumb-uploader.is-drag-active .sku-thumb-button {
  border-color: rgb(15 118 110);
  background: rgb(240 253 250);
  color: rgb(15 118 110);
}

.sku-thumb-uploader.is-drag-active .sku-thumb-preview-trigger {
  outline: 2px solid rgb(15 118 110);
  outline-offset: 2px;
}

.sku-thumb-button {
  position: relative;
  display: grid;
  width: 54px;
  height: 54px;
  place-items: center;
  overflow: hidden;
  border: 1px dashed rgb(203 213 225);
  border-radius: 8px;
  background: rgb(248 250 252);
  color: rgb(100 116 139);
  font-size: 12px;
  cursor: pointer;
}

.sku-thumb-button img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.sku-thumb-image {
  width: 100%;
  height: 100%;
  border-radius: 8px;
}

.sku-thumb-remove {
  position: absolute;
  top: -6px;
  right: -6px;
  display: grid;
  width: 18px;
  height: 18px;
  place-items: center;
  border: 1px solid rgb(254 202 202);
  border-radius: 999px;
  background: rgb(255 255 255);
  color: rgb(239 68 68);
  font-size: 14px;
  line-height: 1;
  box-shadow: 0 2px 8px rgb(15 23 42 / 12%);
  cursor: pointer;
}

.sku-thumb-button:hover {
  border-color: rgb(15 118 110);
  color: rgb(15 118 110);
}

.sku-thumb-replace-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 54px;
  height: 20px;
  padding: 0;
  border: 1px solid rgb(204 251 241);
  border-radius: 999px;
  background: rgb(240 253 250);
  color: rgb(15 118 110);
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
}

.sku-thumb-replace-button:hover {
  border-color: rgb(15 118 110);
  background: rgb(204 251 241);
}

.sku-thumb-button.is-uploading {
  cursor: progress;
  opacity: 0.72;
}

.sku-thumb-progress {
  width: 40px;
}

.sku-thumb-progress-overlay {
  position: absolute;
  right: 7px;
  bottom: 8px;
  left: 7px;
  width: auto;
}

.sku-thumb-progress-label {
  transform: translateY(-4px);
  color: rgb(15 118 110);
  font-size: 11px;
  font-weight: 600;
}

.sku-thumb-button.is-uploading .sku-thumb-progress :deep(.el-progress-bar__outer) {
  background: rgb(204 251 241);
}

.sku-discount-editor {
  display: grid;
  gap: 6px;
}

.sku-discount-editor__mode {
  justify-self: start;
}

@media (max-width: 640px) {
  .product-manager {
    gap: 0.75rem;
  }

  .product-toolbar-search {
    gap: 0.5rem;
  }

  .product-toolbar-search__keyword {
    width: 100% !important;
  }

  .product-toolbar-search__tag {
    flex: 1 1 0;
    min-width: 0;
  }

  .product-toolbar-search__submit {
    width: 92px;
    flex: 0 0 92px;
  }

  :deep(.product-toolbar-actions) {
    width: 100%;
    justify-content: stretch;
  }

  .product-toolbar-action-row {
    display: grid;
    width: 100%;
    min-width: 0;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.5rem;
    align-items: center;
  }

  .product-toolbar-action-row > .el-button {
    min-width: 0;
  }

  .product-toolbar-action-row > .el-button:nth-last-child(-n + 2) {
    grid-column: span 1;
  }

  .product-toolbar-action-row > .el-button:last-child {
    width: 100%;
  }
}
</style>
