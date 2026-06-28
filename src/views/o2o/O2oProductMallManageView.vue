<script setup lang="ts">
/**
 * 模块说明：src/views/o2o/O2oProductMallManageView.vue
 * 文件职责：维护线上商品大厅的新增、编辑、上架状态切换与商品预览图上传交互。
 * 实现逻辑：
 * - 商品预览图支持拖拽/点击上传，上传前会进行图片压缩，上传中展示进度条；
 * - 上传完成后可点击“查看大图”进行清晰预览，并支持带确认的删除操作；
 * - 商品编辑与创建共用同一表单，提交时只落库当前表单已确认的图片 URL。
 * 维护说明：修改上传流程时需同步验证压缩、进度反馈、预览和删除四条链路，避免状态不一致。
 */


import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'

import type { TableInstance } from 'element-plus'
import { BizCrudDialogShell, PageContainer, PageToolbarCard, PassiveNumberInput } from '@/components/common'
import { getTagList, type Tag } from '@/api/modules/tag'
import { resolveProductPlaceholder } from '@/utils/product-placeholder'
import { calculateDiscountedPriceText, normalizeDiscountRateText, resolveO2oPriceView } from '@/utils/o2o-price'
import {
  createProduct,
  getProductList,
  updateProduct,
  type CreateProductDto,
  type ProductRecord,
  type ProductSkuRecord,
  type UpdateProductDto,
} from '@/api/modules/product'
import { useDevice } from '@/composables/useDevice'
import { usePermissionAction } from '@/composables/usePermissionAction'


import { showAppSuccess, showAppWarning } from '@/utils/app-alert'

type O2oProductFormState = {
  id: string
  productCode: string
  productName: string
  defaultPrice: number
  discountRate: number
  skus: EditableProductSku[]
  selectedSkuId: string
  recommendationMode: 'all' | 'specific'
  selectedRecommendedSkuIds: string[]
  isActive: boolean
  o2oStatus: 'listed' | 'unlisted'
  o2oRecommended: boolean
  thumbnail: string
  detailContent: string
  limitPerUser: number
  currentStock: number
}

type EditableProductSku = {
  localId: string
  id?: string
  productId?: string
  skuCode: string
  specValues: Record<string, string>
  specText: string
  defaultPrice: number
  originalPrice?: string
  discountRate: number
  discountedPrice?: string
  currentStock: number
  preOrderedStock: number
  availableStock: number
  isActive: boolean
  o2oRecommended: boolean
  thumbnail: string
  sortOrder: number
}

const loading = ref(false)
const submitting = ref(false)
const dialogVisible = ref(false)
const keyword = ref('')
const searchTagId = ref('')
const products = ref<ProductRecord[]>([])
const allTags = ref<Tag[]>([])
const productTableRef = ref<TableInstance>()
const selectedProductIds = ref<string[]>([])
const batchSubmitting = ref(false)
const mallPage = ref(1)
const mallPageSize = ref(10)
const mallPageSizes = [10, 20, 50]
const { isPhone, isTablet } = useDevice()
const { hasPermission, ensurePermission } = usePermissionAction()

const canManageProducts = computed(() => hasPermission('products:manage'))
const selectedProductCount = computed(() => selectedProductIds.value.length)
const mallTotal = computed(() => products.value.length)
const pagedProducts = computed(() => {
  const start = (mallPage.value - 1) * mallPageSize.value
  return products.value.slice(start, start + mallPageSize.value)
})

const form = reactive<O2oProductFormState>({
  id: '',
  productCode: '',
  productName: '',
  defaultPrice: 0,
  discountRate: 10,
  skus: [],
  selectedSkuId: '',
  recommendationMode: 'all',
  selectedRecommendedSkuIds: [],
  isActive: true,
  o2oStatus: 'listed',
  o2oRecommended: false,
  thumbnail: '',
  detailContent: '',
  limitPerUser: 5,
  currentStock: 0,
})

const resolveSkuLocalId = (sku: ProductSkuRecord, index: number) => {
  const preferredId = typeof sku.id === 'string' && sku.id.trim()
    ? sku.id.trim()
    : typeof sku.skuCode === 'string' && sku.skuCode.trim()
      ? sku.skuCode.trim()
      : `sku-${index + 1}`
  return `${preferredId}-${index}`
}

const normalizeSkuSpecValues = (specValues: ProductSkuRecord['specValues']) => {
  if (!specValues || typeof specValues !== 'object') {
    return {}
  }

  return Object.fromEntries(
    Object.entries(specValues)
      .map(([key, value]) => [key.trim(), String(value ?? '').trim()])
      .filter(([key, value]) => key && value),
  )
}

const normalizeSkuInteger = (value: unknown) => {
  const normalized = Number(value)
  if (!Number.isFinite(normalized)) {
    return 0
  }
  return Math.max(0, Math.floor(normalized))
}

const resolveEditableSkuPrice = (sku: ProductSkuRecord, productDefaultPrice: number) => {
  const candidates = [sku.defaultPrice, sku.originalPrice, sku.discountedPrice, productDefaultPrice]
  for (const candidate of candidates) {
    const normalized = Number(candidate)
    if (Number.isFinite(normalized) && normalized > 0) {
      return normalized
    }
  }

  return 0
}

const normalizeEditableSku = (sku: ProductSkuRecord, index: number, productDefaultPrice: number): EditableProductSku => {
  return {
    localId: resolveSkuLocalId(sku, index),
    id: typeof sku.id === 'string' && sku.id.trim() ? sku.id.trim() : undefined,
    productId: typeof sku.productId === 'string' && sku.productId.trim() ? sku.productId.trim() : undefined,
    skuCode: typeof sku.skuCode === 'string' ? sku.skuCode.trim() : '',
    specValues: normalizeSkuSpecValues(sku.specValues),
    specText: typeof sku.specText === 'string' ? sku.specText.trim() : '',
    defaultPrice: resolveEditableSkuPrice(sku, productDefaultPrice),
    originalPrice: typeof sku.originalPrice === 'string' && sku.originalPrice.trim() ? sku.originalPrice.trim() : undefined,
    discountRate: normalizeDiscountRateNumber(sku.discountRate ?? 10),
    discountedPrice: typeof sku.discountedPrice === 'string' && sku.discountedPrice.trim() ? sku.discountedPrice.trim() : undefined,
    currentStock: normalizeSkuInteger(sku.currentStock),
    preOrderedStock: normalizeSkuInteger(sku.preOrderedStock),
    availableStock: normalizeSkuInteger(sku.availableStock),
    isActive: sku.isActive !== false,
    o2oRecommended: sku.o2oRecommended === true,
    thumbnail: typeof sku.thumbnail === 'string' ? sku.thumbnail.trim() : '',
    sortOrder: normalizeSkuInteger(sku.sortOrder ?? index),
  }
}

const resolveSkuDisplayLabel = (sku: EditableProductSku, index: number) => {
  const specLabel = sku.specText || Object.values(sku.specValues).filter(Boolean).join(' / ')
  return specLabel || sku.skuCode || `规格 ${index + 1}`
}

const skuSelectOptions = computed(() => {
  return form.skus.map((sku, index) => ({
    label: resolveSkuDisplayLabel(sku, index),
    value: sku.localId,
  }))
})

const selectedSkuForEdit = computed(() => {
  return form.skus.find((sku) => sku.localId === form.selectedSkuId) ?? null
})

const selectedSkuOnlineStatus = computed({
  get: () => selectedSkuForEdit.value?.isActive !== false,
  set: (value: boolean) => {
    if (!selectedSkuForEdit.value) {
      return
    }
    selectedSkuForEdit.value.isActive = value
  },
})

const hasMultipleOnlineSkus = computed(() => form.skus.length > 1)

const recommendationMode = computed({
  get: () => form.recommendationMode,
  set: (value: 'all' | 'specific') => {
    form.recommendationMode = value
  },
})

const selectedRecommendedSkuIds = computed({
  get: () => form.selectedRecommendedSkuIds,
  set: (value: string[]) => {
    form.selectedRecommendedSkuIds = value
  },
})

const resolveRecommendationLabel = (product: ProductRecord) => {
  if (product.o2oRecommended) {
    return '全部推荐'
  }
  const recommendedCount = (product.skus ?? []).filter((sku) => sku.o2oRecommended).length
  return recommendedCount > 0 ? `部分规格（${recommendedCount}）` : '否'
}

const dialogTitle = computed(() => {
  return form.id ? '编辑线上商品' : '新增线上商品'
})

/**
 * 列表展示辅助文案：
 * - 手机卡片与桌面表格共用一套状态判断，避免同一商品在不同断点出现不同语义；
 * - 保持“基础状态 / 商城展示”两个维度分离，方便管理员快速判断不可上架原因。
 */
const getBaseStatusLabel = (product: ProductRecord) => {
  return product.isActive ? '启用' : '停用'
}

const getBaseStatusTagType = (product: ProductRecord) => {
  return product.isActive ? 'success' : 'info'
}

const getMallStatusLabel = (product: ProductRecord) => {
  return product.o2oStatus === 'listed' ? '已上架' : '已下架'
}

const getMallStatusTagType = (product: ProductRecord) => {
  return product.o2oStatus === 'listed' ? 'success' : 'warning'
}

const formatProductPrice = (price: string | number) => {
  return `¥${Number(price).toFixed(2)}`
}

const formatDiscountRateLabel = (value: string | number) => {
  return `${normalizeDiscountRateText(value).replace(/\.0$/, '')}折`
}

const normalizeDiscountRateNumber = (value: unknown) => {
  return Number(normalizeDiscountRateText(typeof value === 'number' ? value : Number(value)))
}


watch(
  () => form.isActive,
  (isActive) => {
    if (!isActive) {
      form.o2oStatus = 'unlisted'
    }
  },
)

watch(
  () => form.skus.map((sku) => sku.localId).join('|'),
  (skuKey) => {
    const availableSkuIds = new Set(form.skus.map((sku) => sku.localId))
    form.selectedRecommendedSkuIds = form.selectedRecommendedSkuIds.filter((skuId) => availableSkuIds.has(skuId))
    if (!skuKey) {
      form.selectedSkuId = ''
      return
    }

    if (form.selectedSkuId && form.skus.some((sku) => sku.localId === form.selectedSkuId)) {
      return
    }

    form.selectedSkuId = ''
  },
)

/**
 * 重置编辑表单：
 * - 新增和编辑共用一个弹窗，切换时先清理旧值；
 * - 避免上一次编辑残留到下一次新增中。
 */
const resetForm = () => {
  form.id = ''
  form.productCode = ''
  form.productName = ''
  form.defaultPrice = 0
  form.discountRate = 10
  form.skus = []
  form.selectedSkuId = ''
  form.recommendationMode = 'all'
  form.selectedRecommendedSkuIds = []
  form.isActive = true
  form.o2oStatus = 'listed'
  form.o2oRecommended = false
  form.thumbnail = ''
  form.detailContent = ''
  form.limitPerUser = 5
  form.currentStock = 0
}

// 详细注释：加载商品列表，支持按名称、拼音、编码与标签筛选，刷新商城大厅商品数据。
const loadProducts = async () => {
  loading.value = true
  try {
    products.value = await getProductList({
      keyword: keyword.value.trim() || undefined,
      tagId: searchTagId.value || undefined,
    })
    clampMallPage()
    await syncSelectedProductIds()
  } finally {
    loading.value = false
  }
}

const loadTags = async () => {
  try {
    allTags.value = await getTagList()
  } catch (error) {
    console.error('Failed to load tags', error)
  }
}

const handleSearch = () => {
  mallPage.value = 1
  void loadProducts()
}

const clampMallPage = () => {
  const maxPage = Math.max(1, Math.ceil(products.value.length / mallPageSize.value))
  if (mallPage.value > maxPage) {
    mallPage.value = maxPage
  }
}

const applyTableSelection = async () => {
  await nextTick()
  const table = productTableRef.value
  if (!table) {
    return
  }

  table.clearSelection()
  const selectedIdSet = new Set(selectedProductIds.value)
  pagedProducts.value.forEach((product) => {
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
  const currentPageIdSet = new Set(pagedProducts.value.map((product) => product.id))
  const selectedIdSet = new Set(selection.map((item) => item.id))
  selectedProductIds.value = Array.from(new Set([
    ...selectedProductIds.value.filter((id) => !currentPageIdSet.has(id)),
    ...Array.from(selectedIdSet),
  ]))
}

const handleMallPageChange = async () => {
  await applyTableSelection()
}

const handleMallPageSizeChange = async (pageSize: number) => {
  mallPageSize.value = pageSize
  mallPage.value = 1
  await applyTableSelection()
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

// 详细注释：打开新增商品弹窗，执行表单重置，确保表单为干净状态。
const openCreateDialog = () => {
  if (!ensurePermission('products:manage', '新增产品')) {
    return
  }
  resetForm()
  dialogVisible.value = true
}

const openBatchCreateDialog = () => {
  if (!ensurePermission('products:manage', '批量新增产品')) {
    return
  }
  globalThis.sessionStorage.setItem('ylink:o2o-batch-create', '1')
  globalThis.location.assign('/base-data/products')
}

// 详细注释：打开编辑商品弹窗，将商品记录字段回显到表单模型中。
const openEditDialog = (product: ProductRecord) => {
  if (!ensurePermission('products:manage', '编辑产品')) {
    return
  }
  resetForm()
  form.id = product.id
  form.productCode = product.productCode
  form.productName = product.productName
  form.defaultPrice = Number(product.defaultPrice)
  form.discountRate = Number(product.discountRate || 10)
  form.skus = (product.skus ?? []).map((sku, index) => normalizeEditableSku(sku, index, Number(product.defaultPrice)))
  form.selectedSkuId = ''
  form.recommendationMode = product.o2oRecommended ? 'all' : 'specific'
  form.selectedRecommendedSkuIds = form.skus.filter((sku) => sku.o2oRecommended).map((sku) => sku.localId)
  form.isActive = product.isActive
  form.o2oStatus = product.o2oStatus
  form.o2oRecommended = product.o2oRecommended
  form.thumbnail = product.thumbnail ?? ''
  form.detailContent = product.detailContent ?? ''
  form.limitPerUser = product.limitPerUser
  form.currentStock = product.currentStock
  dialogVisible.value = true
}

/**
 * 一键切换上下架：
 * - 管理端最常用动作是快速上/下架，不应每次都打开编辑弹窗；
 * - 这里直接只更新 O2O 状态，操作完成后刷新列表。
 */
const toggleListed = async (product: ProductRecord, nextStatus: 'listed' | 'unlisted') => {
  if (!product.isActive && nextStatus === 'listed') {
    showAppWarning('请先启用商品，再手动上架到线上商城')
    return
  }

  await updateProduct(product.id, {
    o2oStatus: nextStatus,
  })
  showAppSuccess(nextStatus === 'listed' ? '商品已上架' : '商品已下架')
  await loadProducts()
}

const handleBatchUpdateStatus = async (enabled: boolean) => {
  if (!ensurePermission('products:manage', enabled ? '批量上架线上展示' : '批量下架线上展示')) {
    return
  }
  if (!selectedProductIds.value.length) {
    showAppWarning('请先选择要批量处理的产品')
    return
  }

  const selectedProducts = products.value.filter((product) => selectedProductIds.value.includes(product.id))
  if (enabled && selectedProducts.some((product) => !product.isActive)) {
    showAppWarning('选中的产品包含已停用产品，请先在基础信息中启用后再批量上架线上展示')
    return
  }

  batchSubmitting.value = true
  try {
    const updatedCount = selectedProductIds.value.length
    await Promise.all(selectedProductIds.value.map((id) => updateProduct(id, {
      o2oStatus: enabled ? 'listed' : 'unlisted',
    })))
    await clearSelection()
    await loadProducts()
    showAppSuccess(`已批量${enabled ? '上架' : '下架'} ${updatedCount} 个产品`)
  } finally {
    batchSubmitting.value = false
  }
}

const handleCompactBatchCommand = (command: string | number | object) => {
  if (command === 'list') {
    void handleBatchUpdateStatus(true)
    return
  }

  if (command === 'unlist') {
    void handleBatchUpdateStatus(false)
    return
  }

  if (command === 'clear') {
    void clearSelection()
  }
}

const buildSkuSubmitPayload = (): ProductSkuRecord[] => {
  const recommendedSkuIdSet = new Set(form.recommendationMode === 'specific' ? form.selectedRecommendedSkuIds : [])
  return form.skus.map((sku) => ({
    id: sku.id || undefined,
    productId: sku.productId || undefined,
    skuCode: sku.skuCode || undefined,
    specValues: { ...sku.specValues },
    specText: sku.specText || undefined,
    defaultPrice: sku.defaultPrice,
    originalPrice: sku.originalPrice,
    discountRate: sku.discountRate,
    discountedPrice: calculateDiscountedPriceText(sku.defaultPrice, sku.discountRate),
    currentStock: sku.currentStock,
    preOrderedStock: sku.preOrderedStock,
    availableStock: sku.availableStock,
    isActive: sku.isActive,
    o2oRecommended: recommendedSkuIdSet.has(sku.localId),
    thumbnail: sku.thumbnail.trim() || null,
    sortOrder: sku.sortOrder,
  }))
}

// 详细注释：提交商品表单（新增/编辑），处理图片上传逻辑并构造对应 payload 发起请求。
const handleSubmit = async () => {
  if (!form.productName.trim()) {
    showAppWarning('请输入商品名称')
    return
  }

  submitting.value = true
  try {
    const finalThumbnail = form.thumbnail.trim() || null
    const finalO2oRecommended = hasMultipleOnlineSkus.value
      ? form.recommendationMode === 'all'
      : form.o2oRecommended

    if (form.id) {
      const payload: UpdateProductDto = {
        isActive: form.isActive,
        o2oStatus: form.o2oStatus,
        o2oRecommended: finalO2oRecommended,
        skus: buildSkuSubmitPayload(),
        detailContent: form.detailContent.trim() || null,
        limitPerUser: Math.max(1, Math.floor(form.limitPerUser)),
      }
      await updateProduct(form.id, payload)
      showAppSuccess('商品已更新')
    } else {
      const payload: CreateProductDto = {
        productCode: form.productCode.trim() || undefined,
        productName: form.productName.trim(),
        defaultPrice: Number(form.defaultPrice) || 0,
        discountRate: Number(form.discountRate) || 10,
        isActive: form.isActive,
        o2oStatus: form.o2oStatus,
        o2oRecommended: finalO2oRecommended,
        skus: buildSkuSubmitPayload(),
        thumbnail: finalThumbnail,
        detailContent: form.detailContent.trim() || null,
        limitPerUser: Math.max(1, Math.floor(form.limitPerUser)),
      }
      await createProduct(payload)
      showAppSuccess('商品已创建')
    }
    dialogVisible.value = false
    await loadProducts()
  } finally {
    submitting.value = false
  }
}

onMounted(async () => {
  await Promise.all([loadTags(), loadProducts()])
})
</script>

<template>
  <PageContainer title="线上展示" description="维护客户端可见配置：上/下架、详情文案、推荐与限购；编码、售价和库存来源于基础资料，图片来源于规格配置。">
    <PageToolbarCard compact content-class="product-toolbar-content" actions-class="product-toolbar-actions" :action-stretch-on-phone="false">
      <template #default>
        <div class="product-toolbar-search flex w-full flex-wrap gap-2.5">
          <el-input
            v-model="keyword"
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
          <el-button :class="isPhone ? 'product-toolbar-search__submit' : ''" type="primary" icon="Search" @click="handleSearch">搜索</el-button>
        </div>
      </template>

      <template #actions>
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
                  <el-dropdown-item command="list" :disabled="!selectedProductCount">批量上架</el-dropdown-item>
                  <el-dropdown-item command="unlist" :disabled="!selectedProductCount">批量下架</el-dropdown-item>
                  <el-dropdown-item command="clear" :disabled="!selectedProductCount">清空选择</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
            <el-button size="small" type="primary" plain @click="openBatchCreateDialog">
              批量新增线上商品
            </el-button>
            <el-button size="small" type="primary" icon="Plus" @click="openCreateDialog">新增线上商品</el-button>
          </template>
        </div>
        <div v-else class="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <el-tag v-if="canManageProducts" type="info">已选 {{ selectedProductCount }} 项</el-tag>
          <el-tag v-else type="info">当前为只读模式</el-tag>
          <el-button
            v-if="canManageProducts"
            :disabled="!selectedProductCount"
            :loading="batchSubmitting"
            @click="handleBatchUpdateStatus(true)"
          >
            批量上架
          </el-button>
          <el-button
            v-if="canManageProducts"
            :disabled="!selectedProductCount"
            :loading="batchSubmitting"
            @click="handleBatchUpdateStatus(false)"
          >
            批量下架
          </el-button>
          <el-button v-if="canManageProducts" :disabled="!selectedProductCount" @click="clearSelection">
            清空选择
          </el-button>
          <el-button v-if="canManageProducts" type="primary" plain @click="openBatchCreateDialog">
            批量新增线上商品
          </el-button>
          <el-button v-if="canManageProducts" type="primary" icon="Plus" @click="openCreateDialog">新增线上商品</el-button>
        </div>
      </template>
    </PageToolbarCard>

    <div class="product-list-surface mt-3 rounded-3xl bg-white p-3 shadow-sm sm:mt-4 sm:p-4">
      <div
        v-if="isPhone"
        v-loading="loading"
        element-loading-text="正在加载线上商品..."
        class="mall-mobile-list"
      >
        <template v-if="products.length">
          <article
            v-for="product in pagedProducts"
            :key="product.id"
            class="mall-mobile-card"
          >
            <div v-if="canManageProducts" class="mb-1 flex items-center justify-between">
              <el-checkbox
                :model-value="selectedProductIds.includes(product.id)"
                @change="handleCardSelectionChange(product.id, $event)"
              >
                选择产品
              </el-checkbox>
            </div>
            <div class="mall-mobile-card__head">
              <el-image
                :src="resolveProductPlaceholder(product.thumbnail)"
                :preview-src-list="product.thumbnail ? [resolveProductPlaceholder(product.thumbnail)] : []"
                preview-teleported
                fit="cover"
                class="mall-mobile-card__thumb"
              />

              <div class="min-w-0 flex-1">
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0 flex-1">
                    <h3 class="mall-mobile-card__title">
                      {{ product.productName }}
                    </h3>
                    <p class="mall-mobile-card__code">
                      商品编码：{{ product.productCode || '系统自动生成' }}
                    </p>
                  </div>

                  <el-button
                    v-if="canManageProducts"
                    link
                    type="primary"
                    class="mall-mobile-card__edit-button"
                    @click="openEditDialog(product)"
                  >
                    编辑
                  </el-button>
                </div>

                <div class="mall-mobile-card__tag-row">
                  <el-tag :type="getBaseStatusTagType(product)" size="small" effect="light">
                    {{ getBaseStatusLabel(product) }}
                  </el-tag>
                  <el-tag :type="getMallStatusTagType(product)" size="small" effect="light">
                    {{ getMallStatusLabel(product) }}
                  </el-tag>
                  <el-tag v-if="resolveRecommendationLabel(product) !== '否'" type="success" size="small" effect="light">
                    {{ resolveRecommendationLabel(product) }}
                  </el-tag>
                </div>
              </div>
            </div>

            <div class="mall-mobile-card__price-strip">
              <div>
                <p class="mall-mobile-card__section-label">展示售价</p>
                <p class="mall-mobile-card__price">
                  {{ formatProductPrice(resolveO2oPriceView(product).discountedPrice) }}
                </p>
              </div>
              <div class="mall-mobile-card__limit">
                单人限购 {{ product.limitPerUser }}
              </div>
            </div>

            <div class="mall-mobile-card__stock-summary">
              <span>库存：当前 {{ product.currentStock }}</span>
              <span>已预订 {{ product.preOrderedStock }}</span>
              <span>可用 {{ product.availableStock }}</span>
            </div>

            <div class="mall-mobile-card__footer">
              <el-switch
                :model-value="product.o2oStatus === 'listed'"
                inline-prompt
                active-text="上架"
                inactive-text="下架"
                :disabled="!canManageProducts || !product.isActive"
                @change="toggleListed(product, $event ? 'listed' : 'unlisted')"
              />
            </div>
          </article>
        </template>

        <el-empty v-else description="暂无线上商品" :image-size="110" />
      </div>

      <el-table
        v-else
        ref="productTableRef"
        native-scrollbar
        :data="pagedProducts"
        :loading="loading"
        row-key="id"
        @selection-change="handleTableSelectionChange"
      >
        <el-table-column v-if="canManageProducts" type="selection" width="52" reserve-selection />
        <el-table-column label="商品信息" min-width="250">
          <template #default="{ row }">
            <div class="mall-table-product-cell">
              <div class="mall-table-product-cell__name">{{ row.productName }}</div>
              <div class="mall-table-product-cell__code">
                商品编码：{{ row.productCode || '系统自动生成' }}
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="展示售价" min-width="108">
          <template #default="{ row }">
            <div class="leading-5">
              <div class="font-semibold text-teal-600">{{ formatProductPrice(resolveO2oPriceView(row).discountedPrice) }}</div>
              <div v-if="resolveO2oPriceView(row).isDiscounted" class="text-xs text-slate-400">
                原价 {{ formatProductPrice(resolveO2oPriceView(row).originalPrice) }} · {{ resolveO2oPriceView(row).discountLabel }}
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="库存信息" min-width="190">
          <template #default="{ row }">
            <div class="text-sm leading-6 text-slate-600">
              <div>基础库存：{{ row.currentStock }}</div>
              <div>已预订：{{ row.preOrderedStock }}</div>
              <div>可用库存：{{ row.availableStock }}</div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="上架状态" min-width="118">
          <template #default="{ row }">
            <el-switch
              :model-value="row.o2oStatus === 'listed'"
              inline-prompt
              active-text="上架"
              inactive-text="下架"
              :disabled="!canManageProducts || !row.isActive"
              @change="toggleListed(row, $event ? 'listed' : 'unlisted')"
            />
          </template>
        </el-table-column>
        <el-table-column label="推荐" width="88" align="center">
          <template #default="{ row }">
            <el-tag v-if="resolveRecommendationLabel(row) !== '否'" type="success" size="small">
              {{ resolveRecommendationLabel(row) }}
            </el-tag>
            <span v-else class="text-xs text-slate-400">否</span>
          </template>
        </el-table-column>
        <el-table-column label="预览图" min-width="110">
          <template #default="{ row }">
            <el-image
              :src="resolveProductPlaceholder(row.thumbnail)"
              :preview-src-list="row.thumbnail ? [resolveProductPlaceholder(row.thumbnail)] : []"
              preview-teleported
              fit="cover"
              style="width: 72px; height: 72px; border-radius: 16px"
            />
          </template>
        </el-table-column>
        <el-table-column prop="limitPerUser" label="单人限购" width="96" align="center" />
        <el-table-column v-if="canManageProducts" label="操作" width="84" fixed="right" align="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEditDialog(row)">编辑</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div v-if="products.length" class="mall-pagination-bar mt-4">
        <el-pagination
          v-model:current-page="mallPage"
          v-model:page-size="mallPageSize"
          layout="sizes, prev, pager, next"
          :page-sizes="mallPageSizes"
          :total="mallTotal"
          @current-change="handleMallPageChange"
          @size-change="handleMallPageSizeChange"
        />
      </div>
    </div>

    <BizCrudDialogShell
      v-model="dialogVisible"
      :title="dialogTitle"
      height-mode="scroll"
      phone-width="94%"
      tablet-width="760px"
      desktop-width="820px"
      :confirm-loading="submitting"
      confirm-text="保存"
      dialog-class="o2o-mall-product-edit-dialog"
      @confirm="handleSubmit"
    >
      <template #default="{ isPhone }">
      <el-form class="o2o-product-edit-form" :label-width="isPhone ? '92px' : '110px'">
        <el-row :gutter="16">
          <el-col :span="isPhone ? 24 : 12">
            <el-form-item label="基础编码">
              <el-input v-model="form.productCode" placeholder="可选，不填则后端自动生成" :disabled="!!form.id" />
            </el-form-item>
          </el-col>
          <el-col :span="isPhone ? 24 : 12">
            <el-form-item label="基础名称">
              <el-input v-model="form.productName" placeholder="请输入商品名称" :disabled="!!form.id" />
            </el-form-item>
          </el-col>
        </el-row>

        <el-row :gutter="16">
          <el-col :span="isPhone ? 24 : 12">
            <el-form-item label="基础摘要">
              <div class="o2o-base-summary">
                <span>售价 {{ formatProductPrice(form.defaultPrice) }}</span>
                <span>库存 {{ form.currentStock }}</span>
                <span>折扣 {{ formatDiscountRateLabel(form.discountRate) }}</span>
              </div>
            </el-form-item>
          </el-col>
          <el-col :span="isPhone ? 24 : 12">
            <el-form-item label="单人限购">
              <PassiveNumberInput v-model="form.limitPerUser" :min="1" :step="1" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>

        <el-form-item label="展示状态" class="mb-4">
          <div class="product-status-card w-full rounded-xl bg-slate-50 border border-slate-100 p-3">
            <div class="flex items-center justify-between mb-2">
              <span class="text-sm font-medium text-slate-700">基础启停</span>
              <el-switch v-model="form.isActive" active-text="启用" inactive-text="停用" inline-prompt />
            </div>
            <div class="flex items-center justify-between">
              <span class="text-sm font-medium text-slate-700">客户端展示</span>
              <el-switch
                v-model="form.o2oStatus"
                active-value="listed"
                inactive-value="unlisted"
                active-text="上架"
                inactive-text="下架"
                inline-prompt
                :disabled="!form.isActive"
              />
            </div>
            <div v-if="hasMultipleOnlineSkus" class="o2o-recommendation-editor">
              <el-select
                v-model="form.selectedSkuId"
                filterable
                class="w-full"
                placeholder="选择当前查看的商品规格"
              >
                <el-option
                  v-for="option in skuSelectOptions"
                  :key="option.value"
                  :label="option.label"
                  :value="option.value"
                />
              </el-select>
              <p v-if="selectedSkuForEdit" class="o2o-recommendation-editor__hint">
                当前查看规格：{{ selectedSkuForEdit.specText || selectedSkuForEdit.skuCode || '默认规格' }}
              </p>
              <div v-if="selectedSkuForEdit" class="flex items-center justify-between gap-3">
                <span class="text-sm font-medium text-slate-700">当前规格展示</span>
                <el-switch
                  v-model="selectedSkuOnlineStatus"
                  active-text="上架"
                  inactive-text="下架"
                  inline-prompt
                  :disabled="!form.isActive || form.o2oStatus !== 'listed'"
                />
              </div>
            </div>
            <div class="o2o-recommendation-block">
              <div class="flex items-center justify-between gap-3">
                <span class="text-sm font-medium text-slate-700">客户端推荐</span>
                <el-switch
                  v-if="!hasMultipleOnlineSkus"
                  v-model="form.o2oRecommended"
                  active-text="推荐"
                  inactive-text="普通"
                  inline-prompt
                />
                <el-radio-group v-else v-model="recommendationMode" class="o2o-recommendation-mode-row">
                  <el-radio-button value="all">全部规格推荐</el-radio-button>
                  <el-radio-button value="specific">指定规格推荐</el-radio-button>
                </el-radio-group>
              </div>
              <el-select
                v-if="hasMultipleOnlineSkus && recommendationMode === 'specific'"
                v-model="selectedRecommendedSkuIds"
                multiple
                filterable
                class="o2o-recommendation-tag-row"
                placeholder="选择需要标注推荐的规格"
              >
                <el-option
                  v-for="option in skuSelectOptions"
                  :key="option.value"
                  :label="option.label"
                  :value="option.value"
                />
              </el-select>
              <p v-if="hasMultipleOnlineSkus" class="o2o-recommendation-editor__hint">
                全部规格推荐会使用商品级推荐；指定规格推荐只会在客户端对应规格卡展示“推荐”标记。
              </p>
            </div>
            <p class="mt-2 text-xs text-slate-400">说明：基础启停决定商品是否可被引用；基础启用且客户端展示上架后，商品才会出现在客户端大厅。</p>
          </div>
        </el-form-item>

        <el-form-item label="客户端详情">
          <el-input v-model="form.detailContent" type="textarea" :rows="isPhone ? 5 : 9" placeholder="请输入客户端商品详情说明" />
        </el-form-item>
      </el-form>
      </template>
    </BizCrudDialogShell>

  </PageContainer>
</template>

<style scoped>
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

.product-toolbar-action-row {
  display: grid;
  width: 100%;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.5rem;
  align-items: center;
}

@media (max-width: 640px) {
  :deep(.product-toolbar-actions) {
    width: 100%;
    justify-content: stretch;
  }

  .product-toolbar-search {
    gap: 0.5rem;
  }
}

.mall-mobile-list,
.mall-mobile-card {
  display: flex;
  flex-direction: column;
}

.mall-mobile-list,
.mall-mobile-card {
  gap: 0.7rem;
}

.mall-mobile-card {
  padding: 0.75rem;
  border: 1px solid rgb(226 232 240);
  border-radius: 18px;
}

.mall-mobile-card__head,
.mall-mobile-card__price-strip,
.mall-mobile-card__footer {
  display: flex;
  gap: 0.6rem;
  justify-content: space-between;
}

.mall-mobile-card__tag-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  margin-top: 0.45rem;
}

.mall-mobile-card__thumb {
  width: 64px;
  height: 64px;
  flex: 0 0 auto;
  border-radius: 14px;
  overflow: hidden;
}

.mall-mobile-card__title,
.mall-table-product-cell__name {
  font-weight: 600;
  color: rgb(15 23 42);
}

.mall-mobile-card__title {
  font-size: 15px;
  line-height: 1.35;
}

.mall-mobile-card__code,
.mall-mobile-card__section-label,
.mall-table-product-cell__code {
  color: rgb(100 116 139);
}

.mall-mobile-card__price {
  font-weight: 700;
  color: rgb(13 148 136);
}

.mall-mobile-card__stock-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 0.7rem;
  color: rgb(100 116 139);
  font-size: 12px;
  line-height: 1.5;
}

.mall-mobile-card__footer {
  justify-content: flex-end;
}

.mall-pagination-bar {
  display: flex;
  width: 100%;
  min-width: 0;
  justify-content: flex-end;
  overflow-x: auto;
  padding-bottom: 0.1rem;
}

.mall-pagination-bar :deep(.el-pagination) {
  flex-wrap: wrap;
  justify-content: flex-end;
  row-gap: 0.5rem;
}

:global(.o2o-mall-product-edit-dialog .el-dialog__body) {
  overflow-x: hidden;
}

.o2o-product-edit-form {
  width: 100%;
  min-width: 0;
  overflow-x: clip;
}

.o2o-product-edit-form :deep(.el-row) {
  margin-right: 0 !important;
  margin-left: 0 !important;
  row-gap: 0.2rem;
}

.o2o-product-edit-form :deep(.el-form-item) {
  margin-bottom: 0.72rem;
}

.o2o-base-summary {
  display: flex;
  min-height: 32px;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  color: rgb(100 116 139);
  font-size: 13px;
}

.o2o-base-summary span {
  border-radius: 999px;
  background: rgb(248 250 252);
  padding: 4px 10px;
}

.o2o-recommendation-editor {
  display: grid;
  gap: 8px;
  margin-top: 8px;
  border-top: 1px solid rgb(226 232 240);
  padding-top: 10px;
}

.o2o-recommendation-editor__hint {
  margin: 0;
  color: rgb(100 116 139);
  font-size: 12px;
  line-height: 1.6;
}

.o2o-recommendation-block {
  display: grid;
  gap: 6px;
}

.o2o-recommendation-mode-row {
  flex: 0 0 auto;
}

.o2o-recommendation-tag-row {
  width: 100%;
  min-width: 0;
}

.o2o-product-edit-form :deep(.el-form-item__label) {
  padding-right: 1rem;
  color: rgb(71 85 105);
}

.o2o-product-edit-form :deep(.el-form-item__content) {
  min-width: 0;
}

.product-status-card {
  display: grid;
  gap: 0.55rem;
}

.product-status-card > div {
  min-width: 0;
}

.o2o-discount-editor {
  display: flex;
  width: 100%;
  min-width: 0;
  flex-direction: column;
  gap: 0.45rem;
}

.o2o-discount-editor__mode {
  align-self: flex-start;
}

.o2o-discount-editor__hint {
  margin: 0;
  color: rgb(100 116 139);
  font-size: 12px;
  line-height: 1.4;
}

.avatar-uploader :deep(.el-upload),
.avatar-uploader__content {
  width: 100%;
}

.product-media-row :deep(.el-textarea__inner) {
  min-height: 240px !important;
}

.o2o-product-edit-form .avatar-uploader-wrap,
.o2o-product-edit-form .thumbnail-actions,
.o2o-product-edit-form .thumbnail-progress {
  width: 240px;
  max-width: 100%;
}

.sku-thumbnail-panel {
  display: grid;
  gap: 0.75rem;
  margin-top: 1rem;
}

.sku-thumbnail-panel__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
}

.sku-thumbnail-panel__title,
.sku-thumbnail-panel__subtitle {
  margin: 0;
}

.sku-thumbnail-panel__title {
  font-size: 13px;
  font-weight: 600;
  color: rgb(15 23 42);
}

.sku-thumbnail-panel__subtitle {
  margin-top: 0.2rem;
  font-size: 12px;
  line-height: 1.5;
  color: rgb(100 116 139);
}

.avatar-uploader-wrap.is-disabled {
  opacity: 0.72;
}

.avatar-uploader :deep(.el-upload-dragger) {
  width: 100%;
  padding: 0;
  overflow: hidden;
  border-radius: 14px;
}

.avatar-uploader__empty-state,
.thumbnail-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  align-items: center;
}

.avatar-uploader__preview-shell {
  display: grid;
  place-items: center;
  width: 100%;
  min-height: 160px;
  border-radius: 20px;
  background: rgb(248 250 252);
}

.avatar--full {
  width: 100%;
  aspect-ratio: 1 / 1;
  height: auto;
  max-height: 240px;
  object-fit: cover;
}

.thumbnail-actions {
  margin-top: 0.55rem;
  justify-content: space-between;
}

.thumbnail-actions__hint,
.avatar-uploader__hint {
  color: rgb(100 116 139);
}

.avatar-uploader__title {
  font-weight: 600;
  color: rgb(15 23 42);
}

.thumbnail-progress-fade-enter-active,
.thumbnail-progress-fade-leave-active {
  transition: opacity 0.2s ease;
}

.thumbnail-progress-fade-enter-from,
.thumbnail-progress-fade-leave-to {
  opacity: 0;
}

@media (max-width: 640px) {
  .o2o-product-edit-form :deep(.el-form-item__label) {
    padding-right: 0.75rem;
  }

  .o2o-recommendation-mode-row {
    width: 100%;
  }

  .o2o-recommendation-mode-row :deep(.el-segmented),
  .o2o-recommendation-mode-row :deep(.el-radio-button) {
    min-width: 0;
  }

  .product-media-row :deep(.el-textarea__inner) {
    min-height: 140px !important;
  }

  .o2o-product-edit-form .avatar-uploader-wrap,
  .o2o-product-edit-form .thumbnail-actions,
  .o2o-product-edit-form .thumbnail-progress {
    width: 100%;
  }

  .mall-pagination-bar {
    justify-content: flex-start;
  }

  .mall-pagination-bar :deep(.el-pagination) {
    justify-content: flex-start;
  }
}
</style>
