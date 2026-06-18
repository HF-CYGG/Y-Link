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

import type { TableInstance, UploadRequestOptions } from 'element-plus'
import { Delete, UploadFilled } from '@element-plus/icons-vue'
import { BizCrudDialogShell, PageContainer, PassiveNumberInput } from '@/components/common'
import { getTagList, type Tag } from '@/api/modules/tag'
import { uploadImage } from '@/api/modules/upload'
import { compressImageForUpload } from '@/utils/image-upload'
import { resolveProductPlaceholder } from '@/utils/product-placeholder'
import { formatDiscountRate } from '@/utils/o2o-price'
import {
  createProduct,
  getProductList,
  updateProduct,
  type CreateProductDto,
  type ProductRecord,
  type UpdateProductDto,
} from '@/api/modules/product'
import { useDevice } from '@/composables/useDevice'
import { usePermissionAction } from '@/composables/usePermissionAction'


import { showAppError, showAppSuccess, showAppWarning } from '@/utils/app-alert'

type O2oProductFormState = {
  id: string
  productCode: string
  productName: string
  defaultPrice: number
  discountRate: number
  isActive: boolean
  o2oStatus: 'listed' | 'unlisted'
  thumbnail: string
  detailContent: string
  limitPerUser: number
  currentStock: number
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
  isActive: true,
  o2oStatus: 'listed',
  thumbnail: '',
  detailContent: '',
  limitPerUser: 5,
  currentStock: 0,
})

const localPreviewUrl = ref<string>('')
const uploadingThumbnail = ref(false)
const uploadProgress = ref(0)
const uploadProgressVisible = ref(false)
const thumbnailDragActive = ref(false)

const configuredThumbnailUrl = computed(() => {
  return localPreviewUrl.value || form.thumbnail.trim()
})

const displayThumbnail = computed(() => {
  return configuredThumbnailUrl.value ? resolveProductPlaceholder(configuredThumbnailUrl.value) : ''
})

const hasConfiguredThumbnail = computed(() => {
  return Boolean(configuredThumbnailUrl.value)
})

const currentPreviewImageList = computed(() => {
  return displayThumbnail.value ? [displayThumbnail.value] : []
})

const uploadProgressStatus = computed(() => {
  return uploadProgress.value >= 100 ? 'success' : undefined
})

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

watch(
  () => form.isActive,
  (isActive) => {
    if (!isActive) {
      form.o2oStatus = 'unlisted'
    }
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
  form.isActive = true
  form.o2oStatus = 'listed'
  form.thumbnail = ''
  form.detailContent = ''
  form.limitPerUser = 5
  form.currentStock = 0

  if (localPreviewUrl.value) {
    URL.revokeObjectURL(localPreviewUrl.value)
  }
  localPreviewUrl.value = ''
  uploadingThumbnail.value = false
  uploadProgress.value = 0
  uploadProgressVisible.value = false
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

const handleCustomUpload = async (options: UploadRequestOptions) => {
  thumbnailDragActive.value = false
  const file = options.file

  uploadingThumbnail.value = true
  uploadProgress.value = 0
  uploadProgressVisible.value = true

  let uploadStage: 'compress' | 'upload' = 'compress'
  try {
    const { file: compressedUploadFile } = await compressImageForUpload(file)

    if (localPreviewUrl.value) {
      URL.revokeObjectURL(localPreviewUrl.value)
    }
    localPreviewUrl.value = URL.createObjectURL(compressedUploadFile)

    uploadStage = 'upload'
    const uploadResult = await uploadImage(compressedUploadFile, {
      onUploadProgress: (event) => {
        if (!event.total || event.total <= 0) {
          return
        }
        // 上传过程中最高显示 99%，成功返回后再置 100%，避免“先满后失败”的误导。
        const nextProgress = Math.min(99, Math.max(1, Math.round((event.loaded / event.total) * 100)))
        uploadProgress.value = nextProgress
      },
    })

    form.thumbnail = uploadResult.url
    uploadProgress.value = 100
    options.onSuccess?.(uploadResult)
    showAppSuccess('图片上传完成')
    globalThis.window.setTimeout(() => {
      uploadProgressVisible.value = false
      uploadProgress.value = 0
    }, 520)
  } catch (error) {
    console.error(uploadStage === 'compress' ? '图片压缩失败:' : '图片上传失败:', error)
    const fallbackMessage = uploadStage === 'compress' ? '图片处理失败，请重试' : '图片上传失败，请重试'
    showAppError(error instanceof Error && error.message.trim() ? error.message : fallbackMessage)
    uploadProgress.value = 0
    uploadProgressVisible.value = false
  } finally {
    uploadingThumbnail.value = false
  }
}

const handleThumbnailDragEnter = () => {
  if (uploadingThumbnail.value) {
    return
  }
  thumbnailDragActive.value = true
}

const handleThumbnailDragLeave = (event: DragEvent) => {
  const nextTarget = event.relatedTarget
  if (nextTarget instanceof Node && event.currentTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
    return
  }
  thumbnailDragActive.value = false
}

const handleThumbnailDrop = () => {
  thumbnailDragActive.value = false
}

const handleRemoveThumbnail = () => {
  if (uploadingThumbnail.value) {
    showAppWarning('图片正在上传，请稍后再删除')
    return
  }
  if (localPreviewUrl.value) {
    URL.revokeObjectURL(localPreviewUrl.value)
  }
  localPreviewUrl.value = ''
  form.thumbnail = ''
  uploadProgress.value = 0
  uploadProgressVisible.value = false
  showAppSuccess('已移除商品预览图')
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
  form.isActive = product.isActive
  form.o2oStatus = product.o2oStatus
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

// 详细注释：提交商品表单（新增/编辑），处理图片上传逻辑并构造对应 payload 发起请求。
const handleSubmit = async () => {
  if (!form.productName.trim()) {
    showAppWarning('请输入商品名称')
    return
  }

  submitting.value = true
  try {
    const finalThumbnail = form.thumbnail.trim() || null

    if (form.id) {
      const payload: UpdateProductDto = {
        productCode: form.productCode.trim() || undefined,
        productName: form.productName.trim(),
        defaultPrice: Number(form.defaultPrice) || 0,
        discountRate: Math.min(10, Math.max(0.01, Number(form.discountRate) || 10)),
        isActive: form.isActive,
        o2oStatus: form.o2oStatus,
        thumbnail: finalThumbnail,
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
        discountRate: Math.min(10, Math.max(0.01, Number(form.discountRate) || 10)),
        isActive: form.isActive,
        o2oStatus: form.o2oStatus,
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
  <PageContainer title="线上商品大厅" description="维护客户端可见商品，支持上/下架、预览图、详情文案与库存配置">
    <div class="apple-card flex min-w-0 flex-col gap-3 p-4">
      <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div class="min-w-0 flex-1">
        <div class="flex w-full flex-wrap gap-2.5">
          <el-input
            v-model="keyword"
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
        </div>

        <div class="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <el-tag v-if="canManageProducts" type="info">已选 {{ selectedProductCount }} 项</el-tag>
          <el-tag v-else type="info">当前为只读模式</el-tag>
          <el-button
            v-if="canManageProducts"
            :class="isPhone ? 'w-full' : ''"
            :disabled="!selectedProductCount"
            :loading="batchSubmitting"
            @click="handleBatchUpdateStatus(true)"
          >
            批量上架
          </el-button>
          <el-button
            v-if="canManageProducts"
            :class="isPhone ? 'w-full' : ''"
            :disabled="!selectedProductCount"
            :loading="batchSubmitting"
            @click="handleBatchUpdateStatus(false)"
          >
            批量下架
          </el-button>
          <el-button v-if="canManageProducts" :class="isPhone ? 'w-full' : ''" :disabled="!selectedProductCount" @click="clearSelection">
            清空选择
          </el-button>
          <el-button v-if="canManageProducts" :class="isPhone ? 'w-full' : ''" type="primary" plain @click="openBatchCreateDialog">
            批量新增
          </el-button>
          <el-button v-if="canManageProducts" :class="isPhone ? 'w-full' : ''" type="primary" icon="Plus" @click="openCreateDialog">新增产品</el-button>
        </div>
      </div>
    </div>

    <div class="mt-4 rounded-3xl bg-white p-4 shadow-sm">
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
                </div>
              </div>
            </div>

            <div class="mall-mobile-card__price-strip">
              <div>
                <p class="mall-mobile-card__section-label">价格</p>
                <p class="mall-mobile-card__price">
                  {{ formatProductPrice(product.discountedPrice) }}
                </p>
                <p class="text-xs text-slate-400">原价 {{ formatProductPrice(product.defaultPrice) }} · {{ formatDiscountRate(product.discountRate) }}</p>
              </div>
              <div class="mall-mobile-card__limit">
                单人限购 {{ product.limitPerUser }}
              </div>
            </div>

            <div class="mall-mobile-card__stock-grid">
              <div class="mall-mobile-card__stock-item">
                <span class="mall-mobile-card__stock-label">当前库存</span>
                <span class="mall-mobile-card__stock-value">{{ product.currentStock }}</span>
              </div>
              <div class="mall-mobile-card__stock-item">
                <span class="mall-mobile-card__stock-label">已预订</span>
                <span class="mall-mobile-card__stock-value">{{ product.preOrderedStock }}</span>
              </div>
              <div class="mall-mobile-card__stock-item is-highlight">
                <span class="mall-mobile-card__stock-label">可用库存</span>
                <span class="mall-mobile-card__stock-value">{{ product.availableStock }}</span>
              </div>
            </div>

            <div class="mall-mobile-card__footer">
              <div class="mall-mobile-card__footer-copy">
                <span class="mall-mobile-card__section-label">商城展示</span>
                <span class="mall-mobile-card__footer-hint">
                  {{ product.isActive ? '支持直接切换上下架' : '商品停用时不可上架' }}
                </span>
              </div>
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
        <el-table-column label="价格" min-width="170">
          <template #default="{ row }">
            <div class="leading-5">
              <p class="font-semibold text-teal-600">{{ formatProductPrice(row.discountedPrice) }}</p>
              <p class="text-xs text-slate-400">原价 {{ formatProductPrice(row.defaultPrice) }} · {{ formatDiscountRate(row.discountRate) }}</p>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="库存信息" min-width="190">
          <template #default="{ row }">
            <div class="text-sm leading-6 text-slate-600">
              <div>当前库存：{{ row.currentStock }}</div>
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
      height-mode="auto"
      phone-width="94%"
      tablet-width="720px"
      desktop-width="720px"
      :confirm-loading="submitting"
      confirm-text="保存"
      dialog-class="o2o-mall-product-edit-dialog"
      @confirm="handleSubmit"
    >
      <template #default="{ isPhone }">
      <el-form :label-width="isPhone ? '92px' : '110px'">
        <el-row :gutter="16">
          <el-col :span="isPhone ? 24 : 12">
            <el-form-item label="商品编码">
              <el-input v-model="form.productCode" placeholder="可选，不填则后端自动生成" :disabled="!!form.id" />
            </el-form-item>
          </el-col>
          <el-col :span="isPhone ? 24 : 12">
            <el-form-item label="商品名称">
              <el-input v-model="form.productName" placeholder="请输入商品名称" :disabled="!!form.id" />
            </el-form-item>
          </el-col>
        </el-row>

        <el-row :gutter="16">
          <el-col :span="isPhone ? 24 : 12">
            <el-form-item label="建议单价">
              <PassiveNumberInput v-model="form.defaultPrice" :min="0" :precision="2" style="width: 100%" :disabled="!!form.id" />
            </el-form-item>
          </el-col>
          <el-col :span="isPhone ? 24 : 12">
            <el-form-item label="商品折扣">
              <PassiveNumberInput v-model="form.discountRate" :min="0.01" :max="10" :precision="2" :step="0.1" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>

        <el-row :gutter="16">
          <el-col :span="isPhone ? 24 : 12">
            <el-form-item label="当前库存">
              <PassiveNumberInput v-model="form.currentStock" :min="0" :step="1" style="width: 100%" disabled />
              <div class="mt-1 text-xs text-slate-400">请在“基础资料-产品管理”中编辑库存</div>
            </el-form-item>
          </el-col>
          <el-col :span="isPhone ? 24 : 12">
            <el-form-item label="单人限购">
              <PassiveNumberInput v-model="form.limitPerUser" :min="1" :step="1" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>

        <el-form-item label="商品状态" class="mb-4">
          <div class="w-full rounded-xl bg-slate-50 border border-slate-100 p-3">
            <div class="flex items-center justify-between mb-2">
              <span class="text-sm font-medium text-slate-700">基础状态</span>
              <el-switch v-model="form.isActive" active-text="启用" inactive-text="停用" inline-prompt />
            </div>
            <div class="flex items-center justify-between">
              <span class="text-sm font-medium text-slate-700">商城展示</span>
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
            <p class="mt-2 text-xs text-slate-400">注释：基础状态启用且商城展示上架，商品才会在客户端大厅中展示；重新启用后仍需人工重新上架。</p>
          </div>
        </el-form-item>

        <el-form-item label="商品预览图">
          <div
            class="avatar-uploader-wrap"
            :class="{ 'is-drag-active': thumbnailDragActive }"
            @dragenter.prevent="handleThumbnailDragEnter"
            @dragover.prevent="handleThumbnailDragEnter"
            @dragleave.prevent="handleThumbnailDragLeave"
            @drop.prevent="handleThumbnailDrop"
          >
            <el-upload
              class="avatar-uploader"
              drag
              action=""
              :http-request="handleCustomUpload"
              :show-file-list="false"
              accept="image/*"
              :disabled="uploadingThumbnail"
            >
              <div
                class="avatar-uploader__content"
                :class="{ 'has-image': hasConfiguredThumbnail, 'is-empty': !hasConfiguredThumbnail }"
              >
                <el-image
                  v-if="hasConfiguredThumbnail"
                  :src="displayThumbnail"
                  :preview-src-list="currentPreviewImageList"
                  preview-teleported
                  fit="cover"
                  class="avatar avatar--full"
                  alt="商品预览"
                />
                <div v-else class="avatar-uploader__empty-state">
                  <div class="avatar-uploader__preview-shell" :class="{ 'is-empty': !hasConfiguredThumbnail }">
                    <el-icon class="avatar-uploader__empty-icon"><UploadFilled /></el-icon>
                  </div>
                  <div class="avatar-uploader__text">
                    <p class="avatar-uploader__title">{{ uploadingThumbnail ? '正在上传图片' : thumbnailDragActive ? '松手即可上传' : '拖拽或点击上传' }}</p>
                    <p class="avatar-uploader__hint">{{ thumbnailDragActive ? '已识别到图片拖入' : '推荐 800x800 方形图' }}</p>
                  </div>
                </div>
              </div>
            </el-upload>
          </div>
          <Transition name="thumbnail-progress-fade">
            <div v-if="uploadProgressVisible" class="mt-3 w-full">
              <el-progress :percentage="uploadProgress" :stroke-width="6" :status="uploadProgressStatus" :show-text="false" />
            </div>
          </Transition>
          <div class="thumbnail-actions mt-3 w-full">
            <span class="thumbnail-actions__hint">
              {{ hasConfiguredThumbnail ? '点击图片可查看大图' : '上传完成后可点击图片查看大图' }}
            </span>
            <el-popconfirm
              width="240"
              title="确认删除当前预览图吗？"
              confirm-button-text="删除"
              cancel-button-text="取消"
              @confirm="handleRemoveThumbnail"
            >
              <template #reference>
                <el-button
                  plain
                  :icon="Delete"
                  :disabled="!hasConfiguredThumbnail || uploadingThumbnail"
                  class="thumbnail-remove-button"
                >
                  删除预览图
                </el-button>
              </template>
            </el-popconfirm>
          </div>
          <p class="mt-2 w-full text-xs text-slate-400">列表缩略图与编辑区预览图都已统一接入系统图片预览器。</p>
        </el-form-item>
        <el-form-item label="详情内容">
          <el-input v-model="form.detailContent" type="textarea" :rows="6" placeholder="请输入客户端商品详情说明" />
        </el-form-item>
      </el-form>
      </template>
    </BizCrudDialogShell>

  </PageContainer>
</template>

<style scoped>
.mall-mobile-list,
.mall-mobile-card,
.mall-mobile-card__footer-copy {
  display: flex;
  flex-direction: column;
}

.mall-mobile-list,
.mall-mobile-card {
  gap: 0.9rem;
}

.mall-mobile-card {
  padding: 1rem;
  border: 1px solid rgb(226 232 240);
  border-radius: 22px;
}

.mall-mobile-card__head,
.mall-mobile-card__price-strip,
.mall-mobile-card__footer {
  display: flex;
  gap: 0.75rem;
  justify-content: space-between;
}

.mall-mobile-card__tag-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
  margin-top: 0.7rem;
}

.mall-mobile-card__thumb {
  width: 80px;
  height: 80px;
  flex: 0 0 auto;
  border-radius: 18px;
  overflow: hidden;
}

.mall-mobile-card__title,
.mall-table-product-cell__name {
  font-weight: 600;
  color: rgb(15 23 42);
}

.mall-mobile-card__code,
.mall-mobile-card__section-label,
.mall-mobile-card__footer-hint,
.mall-table-product-cell__code {
  color: rgb(100 116 139);
}

.mall-mobile-card__price {
  font-weight: 700;
  color: rgb(13 148 136);
}

.mall-mobile-card__stock-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.65rem;
}

.mall-mobile-card__stock-item {
  padding: 0.75rem;
  border-radius: 16px;
  background: rgb(248 250 252);
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

.avatar-uploader :deep(.el-upload),
.avatar-uploader__content {
  width: 100%;
}

.avatar-uploader :deep(.el-upload-dragger) {
  padding: 0;
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
  width: 120px;
  height: 120px;
  border-radius: 20px;
  background: rgb(248 250 252);
}

.avatar--full {
  width: 100%;
  height: 240px;
  object-fit: cover;
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
  .mall-pagination-bar {
    justify-content: flex-start;
  }

  .mall-pagination-bar :deep(.el-pagination) {
    justify-content: flex-start;
  }
}
</style>
