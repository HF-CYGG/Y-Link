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


import { computed, onMounted, reactive, ref, watch } from 'vue'

import type { UploadRequestOptions } from 'element-plus'
import { Delete, UploadFilled } from '@element-plus/icons-vue'
import { BizCrudDialogShell, PageContainer, PassiveNumberInput } from '@/components/common'
import { uploadImage } from '@/api/modules/upload'
 import { compressImageForUpload } from '@/utils/image-upload'
import { resolveProductPlaceholder } from '@/utils/product-placeholder'
import {
  createProduct,
  getProductList,
  updateProduct,
  type CreateProductDto,
  type ProductRecord,
  type UpdateProductDto,
} from '@/api/modules/product'
import { useDevice } from '@/composables/useDevice'


import { showAppError, showAppSuccess, showAppWarning } from '@/utils/app-alert'

type O2oProductFormState = {
  id: string
  productCode: string
  productName: string
  defaultPrice: number
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
const products = ref<ProductRecord[]>([])
const { isPhone } = useDevice()

const form = reactive<O2oProductFormState>({
  id: '',
  productCode: '',
  productName: '',
  defaultPrice: 0,
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

// 详细注释：加载商品列表，支持按名称关键词进行模糊搜索，刷新商城大厅商品数据。
const loadProducts = async () => {
  loading.value = true
  try {
    products.value = await getProductList({
      keyword: keyword.value.trim() || undefined,
    })
  } finally {
    loading.value = false
  }
}

// 详细注释：打开新增商品弹窗，执行表单重置，确保表单为干净状态。
const openCreateDialog = () => {
  resetForm()
  dialogVisible.value = true
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
  resetForm()
  form.id = product.id
  form.productCode = product.productCode
  form.productName = product.productName
  form.defaultPrice = Number(product.defaultPrice)
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
  await loadProducts()
})
</script>

<template>
  <PageContainer title="线上商品大厅" description="维护客户端可见商品，支持上/下架、预览图、详情文案与库存配置">
    <template #actions>
      <el-space wrap>
        <el-input v-model="keyword" placeholder="搜索商品名称" clearable style="width: 220px" @keyup.enter="loadProducts" />
        <el-button @click="loadProducts">刷新</el-button>
        <el-button type="primary" @click="openCreateDialog">新增商品</el-button>
      </el-space>
    </template>

    <div class="mt-4 rounded-3xl bg-white p-4 shadow-sm">
      <div
        v-if="isPhone"
        v-loading="loading"
        element-loading-text="正在加载线上商品..."
        class="mall-mobile-list"
      >
        <template v-if="products.length">
          <article
            v-for="product in products"
            :key="product.id"
            class="mall-mobile-card"
          >
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
                <p class="mall-mobile-card__section-label">建议单价</p>
                <p class="mall-mobile-card__price">
                  {{ formatProductPrice(product.defaultPrice) }}
                </p>
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
                :disabled="!product.isActive"
                @change="toggleListed(product, $event ? 'listed' : 'unlisted')"
              />
            </div>
          </article>
        </template>

        <el-empty v-else description="暂无线上商品" :image-size="110" />
      </div>

      <el-table v-else native-scrollbar :data="products" :loading="loading" row-key="id">
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
        <el-table-column label="单价" min-width="108">
          <template #default="{ row }">
            <span class="font-semibold text-teal-600">{{ formatProductPrice(row.defaultPrice) }}</span>
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
              :disabled="!row.isActive"
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
        <el-table-column label="操作" width="84" fixed="right" align="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEditDialog(row)">编辑</el-button>
          </template>
        </el-table-column>
      </el-table>
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
.mall-mobile-list {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
  min-height: 220px;
}

.mall-mobile-card {
  display: flex;
  flex-direction: column;
  gap: 0.95rem;
  padding: 1rem;
  border: 1px solid rgba(226, 232, 240, 0.92);
  border-radius: 24px;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(248, 250, 252, 0.96));
  box-shadow: 0 16px 40px -34px rgba(15, 23, 42, 0.28);
}

.mall-mobile-card__head {
  display: flex;
  align-items: flex-start;
  gap: 0.85rem;
  min-width: 0;
}

.mall-mobile-card__thumb {
  width: 84px;
  height: 84px;
  flex: 0 0 auto;
  border-radius: 20px;
  overflow: hidden;
  background: rgb(241 245 249);
}

.mall-mobile-card__title {
  font-size: 1rem;
  line-height: 1.45;
  font-weight: 600;
  color: rgb(15 23 42);
  word-break: break-word;
}

.mall-mobile-card__code {
  margin-top: 0.3rem;
  font-size: 0.78rem;
  line-height: 1.5;
  color: rgb(100 116 139);
  word-break: break-all;
}

.mall-mobile-card__edit-button {
  flex: 0 0 auto;
  align-self: flex-start;
  padding-top: 0;
}

.mall-mobile-card__tag-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
  margin-top: 0.7rem;
}

.mall-mobile-card__price-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.9rem 0.95rem;
  border-radius: 20px;
  background: rgba(240, 249, 255, 0.86);
}

.mall-mobile-card__section-label {
  display: block;
  font-size: 0.75rem;
  color: rgb(100 116 139);
  line-height: 1.4;
}

.mall-mobile-card__price {
  margin-top: 0.2rem;
  font-size: 1.18rem;
  line-height: 1.2;
  font-weight: 700;
  color: rgb(13 148 136);
}

.mall-mobile-card__limit {
  flex: 0 0 auto;
  padding: 0.38rem 0.72rem;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.92);
  font-size: 0.78rem;
  color: rgb(51 65 85);
}

.mall-mobile-card__stock-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.65rem;
}

.mall-mobile-card__stock-item {
  display: flex;
  flex-direction: column;
  gap: 0.28rem;
  min-width: 0;
  padding: 0.8rem 0.72rem;
  border-radius: 18px;
  background: rgba(248, 250, 252, 0.96);
}

.mall-mobile-card__stock-item.is-highlight {
  background: rgba(236, 253, 245, 0.96);
}

.mall-mobile-card__stock-label {
  font-size: 0.73rem;
  line-height: 1.4;
  color: rgb(100 116 139);
}

.mall-mobile-card__stock-value {
  font-size: 1rem;
  line-height: 1.2;
  font-weight: 600;
  color: rgb(15 23 42);
}

.mall-mobile-card__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding-top: 0.15rem;
}

.mall-mobile-card__footer-copy {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  min-width: 0;
}

.mall-mobile-card__footer-hint {
  font-size: 0.76rem;
  line-height: 1.45;
  color: rgb(100 116 139);
}

.mall-table-product-cell {
  min-width: 0;
}

.mall-table-product-cell__name {
  font-size: 0.95rem;
  line-height: 1.5;
  font-weight: 600;
  color: rgb(15 23 42);
  word-break: break-word;
}

.mall-table-product-cell__code {
  margin-top: 0.25rem;
  font-size: 0.78rem;
  line-height: 1.45;
  color: rgb(100 116 139);
  word-break: break-all;
}

.avatar-uploader :deep(.el-upload) {
  width: 100%;
  border: 1px solid rgba(203, 213, 225, 0.88);
  border-radius: 22px;
  cursor: pointer;
  position: relative;
  overflow: hidden;
  transition: border-color 0.18s ease, box-shadow 0.18s ease, background-color 0.18s ease;
  background: rgba(255, 255, 255, 0.98);
}

.avatar-uploader-wrap.is-drag-active :deep(.el-upload),
.avatar-uploader :deep(.el-upload:hover) {
  border-color: rgba(148, 163, 184, 0.95);
  box-shadow: 0 18px 36px -28px rgba(15, 23, 42, 0.24);
}

.avatar-uploader-wrap.is-drag-active :deep(.el-upload) {
  background: rgba(240, 249, 255, 0.96);
  box-shadow: 0 0 0 4px rgba(14, 165, 233, 0.08);
}

.avatar-uploader :deep(.el-upload-dragger) {
  border: none;
  background: transparent;
  padding: 0;
}

.avatar-uploader__content {
  display: block;
  width: 100%;
  min-height: 172px;
  padding: 0;
}

.avatar-uploader__content.has-image {
  min-height: 240px;
}

.avatar-uploader__content.is-empty {
  padding: 1.1rem 1.2rem;
}

.avatar-uploader__empty-state {
  display: grid;
  grid-template-columns: 132px minmax(0, 1fr);
  align-items: center;
  gap: 1.1rem;
}

.avatar-uploader__preview-shell {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 132px;
  height: 132px;
  border-radius: 28px;
  background: linear-gradient(180deg, rgb(248 250 252), rgb(241 245 249));
}

.avatar-uploader__preview-shell.is-empty {
  background: linear-gradient(180deg, rgb(249 250 251), rgb(244 246 248));
}

.avatar-uploader__text {
  display: flex;
  flex-direction: column;
  gap: 0.22rem;
  min-width: 0;
}

.thumbnail-actions__hint {
  font-size: 13px;
  color: #64748b;
  line-height: 1.6;
}

.avatar-uploader__title {
  font-size: 1rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: rgb(15 23 42);
}

.avatar-uploader__hint {
  font-size: 0.82rem;
  color: rgb(100 116 139);
}

.el-icon.avatar-uploader-icon {
  font-size: 28px;
  color: #8c939d;
  width: 140px;
  height: 140px;
  text-align: center;
}

.avatar {
  width: 100px;
  height: 100px;
  display: block;
  object-fit: cover;
  border-radius: 24px;
  background: transparent;
}

.avatar--full {
  width: 100%;
  height: 240px;
  border-radius: 22px;
  object-fit: cover;
}

.avatar-uploader__empty-icon {
  font-size: 1.55rem;
  color: rgb(148 163 184);
}

.thumbnail-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.65rem;
}

.thumbnail-actions :deep(.el-button) {
  min-height: 38px;
  border-radius: 999px;
  border-color: rgba(203, 213, 225, 0.96);
  background: rgba(255, 255, 255, 0.96);
  color: rgb(51 65 85);
  font-weight: 500;
  padding-inline: 1rem;
}

.thumbnail-remove-button {
  color: rgb(185 28 28) !important;
  border-color: rgba(254, 205, 211, 0.92) !important;
  background: rgba(255, 255, 255, 0.96) !important;
}

.thumbnail-preview-dialog-image {
  display: block;
  width: 100%;
  max-height: min(78vh, 760px);
  border-radius: 14px;
  object-fit: contain;
  background: #f8fafc;
}

.thumbnail-progress-fade-enter-active,
.thumbnail-progress-fade-leave-active {
  transition:
    opacity 0.26s ease,
    transform 0.32s ease;
}

.thumbnail-progress-fade-enter-from,
.thumbnail-progress-fade-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

@media (max-width: 767px) {
  .mall-mobile-card {
    padding: 0.9rem;
    border-radius: 22px;
  }

  .mall-mobile-card__head {
    gap: 0.75rem;
  }

  .mall-mobile-card__thumb {
    width: 76px;
    height: 76px;
    border-radius: 18px;
  }

  .mall-mobile-card__price-strip {
    align-items: flex-start;
    flex-direction: column;
  }

  .mall-mobile-card__limit {
    align-self: flex-start;
  }

  .mall-mobile-card__stock-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .mall-mobile-card__stock-item.is-highlight {
    grid-column: 1 / -1;
  }

  .mall-mobile-card__footer {
    align-items: flex-start;
    flex-direction: column;
  }

  .avatar-uploader__empty-state {
    grid-template-columns: 1fr;
    align-items: start;
  }

  .avatar-uploader__preview-shell {
    width: 120px;
    height: 120px;
  }

  .avatar {
    width: 88px;
    height: 88px;
  }

  .avatar--full {
    height: 220px;
  }
}
</style>
