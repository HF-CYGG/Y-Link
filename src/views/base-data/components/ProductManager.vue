<script setup lang="ts">
/**
 * 模块说明：src/views/base-data/components/ProductManager.vue
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */


import { computed, nextTick, onActivated, onMounted, ref } from 'vue'
import { ElMessage, type FormInstance, type FormRules, type TableInstance } from 'element-plus'
import type { RequestConfig } from '@/api/http'
import { createTag, getTagList, type Tag } from '@/api/modules/tag'
import {
  batchCreateProducts,
  batchUpdateProducts,
  type CreateProductDto,
  createProduct,
  deleteProduct,
  getProductDetail,
  getProductList,
  updateProduct,
  type ProductListQuery,
  type ProductRecord,
} from '@/api/modules/product'
import {
  BizCrudDialogShell,
  BizResponsiveDataCollectionShell,
  PageToolbarCard,
} from '@/components/common'
import { useCrudManager } from '@/composables/useCrudManager'
import { extractErrorMessage } from '@/utils/error'

const allTags = ref<Tag[]>([])
const formRef = ref<FormInstance>()
const productTableRef = ref<TableInstance>()
const pageReady = ref(false)
const keepAliveActivated = ref(false)
const hasAutoCreatedTags = ref(false)
const editingProductId = ref('')
const editLoading = ref(false)
const batchSubmitting = ref(false)
const batchCreateDialogVisible = ref(false)
const batchCreateSubmitting = ref(false)
const selectedProductIds = ref<string[]>([])

const searchKeyword = ref('')
const searchTagId = ref('')
const productCodeSortOrder = ref<'ascending' | 'descending'>('ascending')

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
  currentStock: number
  isActive: boolean
  tagIds: string[]
}

interface BatchCreateProductFormRow {
  rowId: string
  productCode: string
  productName: string
  pinyinAbbr: string
  defaultPrice: number
  currentStock: number
  isActive: boolean
  tagIds: Array<string | number>
}

const BATCH_CREATE_MAX_ROWS = 50
const batchCreateRowSeed = ref(0)
const batchCreateRows = ref<BatchCreateProductFormRow[]>([])

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
  currentStock: 0,
  isActive: true,
  tagIds: [] as string[],
})

const selectedProductCount = computed(() => selectedProductIds.value.length)
const batchCreateRowCount = computed(() => batchCreateRows.value.length)

const createBatchCreateRow = (): BatchCreateProductFormRow => {
  batchCreateRowSeed.value += 1
  return {
    rowId: `batch-row-${Date.now()}-${batchCreateRowSeed.value}`,
    productCode: '',
    productName: '',
    pinyinAbbr: '',
    defaultPrice: 0,
    currentStock: 0,
    isActive: true,
    tagIds: [],
  }
}

/**
 * 编码排序比较器：
 * - 统一按字符串字母序比较，兼容 UUID/自动编码等场景；
 * - 通过 toUpperCase 规避大小写导致的排序抖动。
 */
const compareProductCode = (left: string, right: string): number => {
  const normalizedLeft = String(left ?? '').trim().toUpperCase()
  const normalizedRight = String(right ?? '').trim().toUpperCase()
  return normalizedLeft.localeCompare(normalizedRight, 'en')
}

/**
 * 产品展示列表：
 * - 默认按产品编码正序排列；
 * - 支持正序/倒序切换，移动端卡片与桌面表格共用同一排序结果。
 */
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
  defaultPrice: [{ required: true, message: '请输入默认售价', trigger: 'blur' }],
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
const buildQueryParams = (): ProductListQuery => {
  const params: ProductListQuery = {}
  if (searchKeyword.value) params.keyword = searchKeyword.value
  if (searchTagId.value) params.tagId = searchTagId.value
  return params
}

const handleSearch = () => {
  void reloadProducts()
}

const productMatchesFilters = (product: ProductRecord) => {
  const normalizedKeyword = searchKeyword.value.trim().toLowerCase()
  const normalizedTagId = searchTagId.value.trim()

  if (normalizedKeyword) {
    const searchableText = [product.productName, product.productCode, product.pinyinAbbr]
      .join(' ')
      .toLowerCase()

    if (!searchableText.includes(normalizedKeyword)) {
      return false
    }
  }

  if (normalizedTagId && !product.tagIds.includes(normalizedTagId)) {
    return false
  }

  return true
}

const upsertProduct = (product: ProductRecord) => {
  const currentIndex = products.value.findIndex((item) => item.id === product.id)

  if (!productMatchesFilters(product)) {
    if (currentIndex > -1) {
      products.value.splice(currentIndex, 1)
    }
    return
  }

  if (currentIndex > -1) {
    products.value.splice(currentIndex, 1, product)
    return
  }

  products.value.unshift(product)
}

const normalizeSelectValue = (value: string | number | null | undefined): string => {
  if (value === null || value === undefined) {
    return ''
  }

  return String(value).trim()
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
const buildEditForm = (row: ProductRecord): ProductForm => ({
  id: row.id,
  productCode: row.productCode,
  productName: row.productName,
  pinyinAbbr: row.pinyinAbbr,
  defaultPrice: Number(row.defaultPrice),
  currentStock: Number(row.currentStock) || 0,
  isActive: row.isActive,
  tagIds: row.tagIds,
})

/**
 * 将表单转换为提交 payload：
 * - 保存前先兜底创建缺失标签；
 * - 输出统一的产品 DTO，供新增与编辑接口共用。
 */
const buildSubmitPayload = async (currentForm: ProductForm): Promise<CreateProductDto> => {
  hasAutoCreatedTags.value = false
  const resolvedTagIds = await resolveTagIds(currentForm.tagIds)
  return {
    productCode: currentForm.productCode,
    productName: currentForm.productName,
    pinyinAbbr: currentForm.pinyinAbbr,
    defaultPrice: currentForm.defaultPrice,
    currentStock: currentForm.currentStock,
    isActive: currentForm.isActive,
    tagIds: resolvedTagIds,
  }
}

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
  loadList: (requestConfig) => getProductList(buildQueryParams(), requestConfig),
  createItem: createProduct,
  updateItem: updateProduct,
  deleteItem: deleteProduct,
  messages: {
    createTitle: '新增产品',
    editTitle: '编辑产品',
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
  syncAfterSubmit: ({ result }) => {
    upsertProduct(result)
    void syncSelectedProductIds()
    return 'local'
  },
})

const reloadProducts = async () => {
  await loadData()
  await syncSelectedProductIds()
}

const handleAdd = async () => {
  await clearSelection()
  openCreateDialog()
}

const handleEditProduct = async (row: ProductRecord) => {
  editingProductId.value = row.id
  editLoading.value = true
  try {
    const detail = await getProductDetail(row.id)
    handleEdit(detail)
  } catch (error) {
    ElMessage.error(extractErrorMessage(error, '获取产品详情失败'))
  } finally {
    editingProductId.value = ''
    editLoading.value = false
  }
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
      ElMessage.success(`已自动创建标签：${[...new Set(autoCreatedTagNames)].join('、')}`)
    }
  }

  return [...new Set(resolvedIds)]
}

const refreshProductView = async () => {
  await Promise.all([loadTags(), reloadProducts()])
}

const handleBatchUpdateStatus = async (isActive: boolean) => {
  if (!selectedProductIds.value.length) {
    ElMessage.warning('请先选择要批量处理的产品')
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
    ElMessage.success(`已批量${isActive ? '启用' : '停用'} ${updatedCount} 个产品`)
  } catch (error) {
    ElMessage.error(extractErrorMessage(error, '批量修改失败'))
  } finally {
    batchSubmitting.value = false
  }
}

const openBatchCreateDialog = () => {
  batchCreateRows.value = [createBatchCreateRow()]
  batchCreateDialogVisible.value = true
}

const resetBatchCreateRows = () => {
  batchCreateRows.value = [createBatchCreateRow()]
}

const addBatchCreateRow = () => {
  if (batchCreateRows.value.length >= BATCH_CREATE_MAX_ROWS) {
    ElMessage.warning(`单次最多新增 ${BATCH_CREATE_MAX_ROWS} 行`)
    return
  }
  batchCreateRows.value.push(createBatchCreateRow())
}

const removeBatchCreateRow = (rowId: string) => {
  if (batchCreateRows.value.length <= 1) {
    ElMessage.warning('至少保留一行产品')
    return
  }
  batchCreateRows.value = batchCreateRows.value.filter((row) => row.rowId !== rowId)
}

const validateBatchCreateRows = (): string | null => {
  if (!batchCreateRows.value.length) {
    return '请至少添加一行产品'
  }

  const explicitProductCodeRowMap = new Map<string, number>()
  for (let index = 0; index < batchCreateRows.value.length; index += 1) {
    const row = batchCreateRows.value[index]
    if (!row.productName.trim()) {
      return `第 ${index + 1} 行产品名称不能为空`
    }

    if (!Number.isFinite(row.defaultPrice) || row.defaultPrice < 0) {
      return `第 ${index + 1} 行默认售价必须大于等于 0`
    }

    if (!Number.isFinite(row.currentStock) || row.currentStock < 0 || !Number.isInteger(row.currentStock)) {
      return `第 ${index + 1} 行当前库存必须是大于等于 0 的整数`
    }

    const normalizedProductCode = row.productCode.trim()
    if (!normalizedProductCode) {
      continue
    }
    const duplicatedRow = explicitProductCodeRowMap.get(normalizedProductCode)
    if (duplicatedRow !== undefined) {
      return `第 ${index + 1} 行产品编码与第 ${duplicatedRow + 1} 行重复`
    }
    explicitProductCodeRowMap.set(normalizedProductCode, index)
  }

  return null
}

const handleBatchCreate = async () => {
  const validationError = validateBatchCreateRows()
  if (validationError) {
    ElMessage.warning(validationError)
    return
  }

  batchCreateSubmitting.value = true
  hasAutoCreatedTags.value = false
  try {
    const productsPayload: CreateProductDto[] = []
    for (const row of batchCreateRows.value) {
      const tagIds = await resolveTagIds(row.tagIds, true)
      productsPayload.push({
        productCode: row.productCode.trim() || undefined,
        productName: row.productName.trim(),
        pinyinAbbr: row.pinyinAbbr.trim(),
        defaultPrice: Number(row.defaultPrice),
        currentStock: Math.max(0, Math.floor(row.currentStock)),
        isActive: row.isActive,
        tagIds,
      })
    }

    const createdProducts = await batchCreateProducts({
      products: productsPayload,
    })
    if (hasAutoCreatedTags.value) {
      await loadTags()
      ElMessage.success('已自动创建并关联缺失标签')
    }
    await clearSelection()
    await reloadProducts()
    batchCreateDialogVisible.value = false
    ElMessage.success(`已批量新增 ${createdProducts.length} 个产品`)
  } catch (error) {
    ElMessage.error(extractErrorMessage(error, '批量新增失败'))
  } finally {
    batchCreateSubmitting.value = false
  }
}

onMounted(() => {
  pageReady.value = true
  void refreshProductView()
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
    <PageToolbarCard>
      <template #default="{ isPhone, isTablet }">
        <div class="flex w-full flex-wrap gap-2.5">
          <el-input
            v-model="searchKeyword"
            placeholder="搜索产品名称/拼音/编码"
            :class="isPhone ? '!w-full' : isTablet ? '!w-[240px]' : '!w-[300px]'"
            clearable
            @clear="handleSearch"
            @keyup.enter="handleSearch"
          />
          <el-select
            v-model="searchTagId"
            placeholder="按标签筛选"
            clearable
            :class="isPhone ? '!w-full' : isTablet ? '!w-[200px]' : '!w-[220px]'"
            @change="handleSearch"
          >
            <el-option
              v-for="tag in allTags"
              :key="tag.id"
              :label="tag.tagName"
              :value="tag.id"
            />
          </el-select>
          <el-button :class="isPhone ? 'w-full' : ''" type="primary" icon="Search" @click="handleSearch">搜索</el-button>
        </div>
      </template>

      <template #actions="{ isPhone }">
        <div class="flex w-full flex-wrap justify-end gap-2">
          <el-tag type="info">已选 {{ selectedProductCount }} 项</el-tag>
          <el-button
            :class="isPhone ? 'w-full' : ''"
            :disabled="!selectedProductCount"
            :loading="batchSubmitting"
            @click="handleBatchUpdateStatus(true)"
          >
            批量启用
          </el-button>
          <el-button
            :class="isPhone ? 'w-full' : ''"
            :disabled="!selectedProductCount"
            :loading="batchSubmitting"
            @click="handleBatchUpdateStatus(false)"
          >
            批量停用
          </el-button>
          <el-button :class="isPhone ? 'w-full' : ''" :disabled="!selectedProductCount" @click="clearSelection">
            清空选择
          </el-button>
          <el-button :class="isPhone ? 'w-full' : ''" type="primary" plain @click="openBatchCreateDialog">
            批量新增
          </el-button>
          <el-button :class="isPhone ? 'w-full' : ''" type="primary" icon="Plus" @click="handleAdd">新增产品</el-button>
        </div>
      </template>
    </PageToolbarCard>

    <BizResponsiveDataCollectionShell
      :items="displayProducts"
      :loading="loading"
      empty-description="暂无产品数据"
      :empty-card="true"
      card-key="id"
      wrapper-class="flex min-h-0 flex-1 flex-col"
      table-wrapper-class="apple-card h-full min-w-0 overflow-hidden px-0 py-3 sm:py-4 xl:py-5"
      card-container-class="pb-4 xl:grid-cols-3"
    >
      <template #table>
        <el-table
          ref="productTableRef"
          :data="displayProducts"
          class="h-full w-full"
          stripe
          row-key="id"
          table-layout="auto"
          :default-sort="{ prop: 'productCode', order: 'ascending' }"
          @selection-change="handleTableSelectionChange"
          @sort-change="handleTableSortChange"
        >
            <el-table-column type="selection" width="52" reserve-selection />
            <el-table-column
              label="产品编码"
              prop="productCode"
              min-width="150"
              show-overflow-tooltip
              sortable="custom"
              :sort-orders="['ascending', 'descending']"
            />
            <el-table-column label="产品名称" prop="productName" min-width="220" show-overflow-tooltip />
            <el-table-column label="拼音首字母" prop="pinyinAbbr" width="120" show-overflow-tooltip />
            <el-table-column label="默认售价" prop="defaultPrice" width="132">
              <template #default="{ row }">
                ¥{{ Number(row.defaultPrice).toFixed(2) }}
              </template>
            </el-table-column>
            <el-table-column label="库存数量" min-width="170">
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
            <el-table-column label="操作" width="132" align="right" fixed="right">
              <template #default="{ row }">
                <el-button
                  link
                  type="primary"
                  :loading="editLoading && editingProductId === row.id"
                  @click="handleEditProduct(row)"
                >
                  编辑
                </el-button>
                <el-button link type="danger" @click="handleDelete(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
      </template>

      <template #card="{ item }">
        <div class="apple-card mobile-product-card min-w-0 p-4">
          <div class="mb-3 flex items-center justify-between">
            <el-checkbox
              :model-value="selectedProductIds.includes(item.id)"
              @change="handleCardSelectionChange(item.id, $event)"
            >
              选择产品
            </el-checkbox>
            <el-tag :type="item.isActive ? 'success' : 'info'" size="small">
              {{ item.isActive ? '启用' : '停用' }}
            </el-tag>
          </div>
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <h4 class="truncate text-base font-semibold text-slate-800 dark:text-slate-100">
                {{ item.productName }}
              </h4>
              <p class="mt-1 break-all text-sm text-slate-500 dark:text-slate-400">{{ item.productCode }}</p>
            </div>
            <div class="text-right">
              <span class="font-medium text-red-500">¥{{ Number(item.defaultPrice).toFixed(2) }}</span>
            </div>
          </div>
          <div class="mt-2 text-xs text-slate-500 dark:text-slate-400">
            拼音简写：{{ item.pinyinAbbr || '-' }}
          </div>
          <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">
            库存：当前 {{ item.currentStock }} / 可用 {{ item.availableStock }}
          </div>
          <div class="mt-3 flex flex-wrap gap-1">
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
          <div class="mt-3 flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-3 dark:border-white/10">
            <el-button size="small" :loading="editLoading && editingProductId === item.id" @click="handleEditProduct(item)">
              编辑
            </el-button>
            <el-button size="small" type="danger" plain @click="handleDelete(item)">删除</el-button>
          </div>
        </div>
      </template>
    </BizResponsiveDataCollectionShell>

    <BizCrudDialogShell
      v-model="batchCreateDialogVisible"
      title="批量新增产品"
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
            <el-table :data="batchCreateRows" size="small" max-height="460">
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
              <el-table-column label="默认售价" min-width="150">
                <template #default="{ row }">
                  <el-input-number v-model="row.defaultPrice" :min="0" :precision="2" :step="1" class="w-full" />
                </template>
              </el-table-column>
              <el-table-column label="当前库存" min-width="150">
                <template #default="{ row }">
                  <el-input-number v-model="row.currentStock" :min="0" :step="1" :precision="0" class="w-full" />
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
          <p v-if="isPhone" class="text-xs text-slate-400">
            移动端建议分批录入，单次最多 50 行。
          </p>
        </section>
      </template>
    </BizCrudDialogShell>

    <BizCrudDialogShell
      v-model="dialogVisible"
      :title="dialogTitle"
      phone-width="94%"
      tablet-width="720px"
      desktop-width="500px"
      :confirm-loading="submitting"
      dialog-class="product-dialog"
      @confirm="handleSubmit"
    >
      <template #default="{ isPhone }">
        <el-form ref="formRef" :model="form" :rules="rules" :label-width="isPhone ? '82px' : '90px'">
          <el-form-item label="产品编码" prop="productCode">
            <el-input v-model="form.productCode" :placeholder="form.id ? '请输入产品编码' : '留空则自动生成统一编码'" />
          </el-form-item>
          <el-form-item label="产品名称" prop="productName">
            <el-input v-model="form.productName" placeholder="请输入产品名称" />
          </el-form-item>
          <el-form-item label="拼音简写" prop="pinyinAbbr">
            <el-input v-model="form.pinyinAbbr" placeholder="请输入拼音简写(可选)" />
          </el-form-item>
          <el-form-item label="默认售价" prop="defaultPrice">
            <el-input-number
              v-model="form.defaultPrice"
              :min="0"
              :precision="2"
              :step="1"
              class="w-full"
              placeholder="请输入售价"
            />
          </el-form-item>
          <el-form-item label="当前库存" prop="currentStock">
            <el-input-number
              v-model="form.currentStock"
              :min="0"
              :step="1"
              class="w-full"
              placeholder="请输入当前库存"
            />
          </el-form-item>
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
          <el-form-item label="状态" prop="isActive">
            <el-switch v-model="form.isActive" active-text="启用" inactive-text="停用" />
            <p class="mt-2 text-xs leading-5 text-slate-400">
              商品停用后会自动从线上预订中下架；重新启用后仍需人工重新上架，避免误恢复到客户端大厅。
            </p>
          </el-form-item>
        </el-form>
      </template>
    </BizCrudDialogShell>
  </div>
</template>

<style scoped>
.mobile-product-card {
  transition: transform 0.25s ease, box-shadow 0.25s ease;
}
</style>
