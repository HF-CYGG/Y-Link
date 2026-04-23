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
import { ElMessage } from 'element-plus'
import type { UploadRequestOptions } from 'element-plus'
import { Delete, UploadFilled, ZoomIn } from '@element-plus/icons-vue'
import imageCompression from 'browser-image-compression'
import { PageContainer } from '@/components/common'
import { uploadImage } from '@/api/modules/upload'
import { resolveProductPlaceholder } from '@/utils/product-placeholder'
import {
  createProduct,
  getProductList,
  updateProduct,
  type CreateProductDto,
  type ProductRecord,
  type UpdateProductDto,
} from '@/api/modules/product'

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
const imagePreviewVisible = ref(false)
const uploadingThumbnail = ref(false)
const uploadProgress = ref(0)

const displayThumbnail = computed(() => {
  return resolveProductPlaceholder(localPreviewUrl.value || form.thumbnail)
})

const hasConfiguredThumbnail = computed(() => {
  return Boolean(localPreviewUrl.value || form.thumbnail.trim())
})

const uploadProgressStatus = computed(() => {
  return uploadProgress.value >= 100 ? 'success' : undefined
})

const dialogTitle = computed(() => {
  return form.id ? '编辑线上商品' : '新增线上商品'
})

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
  imagePreviewVisible.value = false
  uploadingThumbnail.value = false
  uploadProgress.value = 0
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
  const file = options.file
  if (!file.type.startsWith('image/')) {
    ElMessage.error('只能上传图片文件')
    return
  }

  if (file.size > 20 * 1024 * 1024) {
    ElMessage.error('原图过大，不能超过 20MB')
    return
  }

  uploadingThumbnail.value = true
  uploadProgress.value = 0

  try {
    const compressedFile = await imageCompression(file, {
      maxSizeMB: 0.8, // 压缩到不超过 800KB
      maxWidthOrHeight: 1200, // 限制最大边长，保证画质同时减小体积
      useWebWorker: true,
      initialQuality: 0.85
    })

    const compressedUploadFile = new File([compressedFile], file.name, {
      type: compressedFile.type,
      lastModified: Date.now(),
    })

    if (localPreviewUrl.value) {
      URL.revokeObjectURL(localPreviewUrl.value)
    }
    localPreviewUrl.value = URL.createObjectURL(compressedUploadFile)

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
    ElMessage.success('图片上传完成')
  } catch (error) {
    console.error('图片压缩失败:', error)
    ElMessage.error('图片处理失败，请重试')
    uploadProgress.value = 0
  } finally {
    uploadingThumbnail.value = false
  }
}

const handleRemoveThumbnail = () => {
  if (uploadingThumbnail.value) {
    ElMessage.warning('图片正在上传，请稍后再删除')
    return
  }
  if (localPreviewUrl.value) {
    URL.revokeObjectURL(localPreviewUrl.value)
  }
  localPreviewUrl.value = ''
  form.thumbnail = ''
  uploadProgress.value = 0
  ElMessage.success('已移除商品预览图')
}

const openThumbnailPreview = () => {
  if (!hasConfiguredThumbnail.value) {
    ElMessage.warning('当前没有可预览的图片')
    return
  }
  imagePreviewVisible.value = true
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
    ElMessage.warning('请先启用商品，再手动上架到线上商城')
    return
  }

  await updateProduct(product.id, {
    o2oStatus: nextStatus,
  })
  ElMessage.success(nextStatus === 'listed' ? '商品已上架' : '商品已下架')
  await loadProducts()
}

// 详细注释：提交商品表单（新增/编辑），处理图片上传逻辑并构造对应 payload 发起请求。
const handleSubmit = async () => {
  if (!form.productName.trim()) {
    ElMessage.warning('请输入商品名称')
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
      ElMessage.success('商品已更新')
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
      ElMessage.success('商品已创建')
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
      <el-table :data="products" :loading="loading" row-key="id">
        <el-table-column prop="productName" label="商品名称" min-width="180" />
        <el-table-column label="单价" min-width="120">
          <template #default="{ row }">
            <span class="font-semibold text-teal-600">¥{{ Number(row.defaultPrice).toFixed(2) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="库存信息" min-width="220">
          <template #default="{ row }">
            <div class="text-sm leading-6 text-slate-600">
              <div>当前库存：{{ row.currentStock }}</div>
              <div>已预订：{{ row.preOrderedStock }}</div>
              <div>可用库存：{{ row.availableStock }}</div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="上架状态" min-width="120">
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
        <el-table-column label="预览图" min-width="150">
          <template #default="{ row }">
            <el-image
              :src="resolveProductPlaceholder(row.thumbnail)"
              fit="cover"
              style="width: 72px; height: 72px; border-radius: 16px"
            />
          </template>
        </el-table-column>
        <el-table-column prop="limitPerUser" label="单人限购" width="110" align="center" />
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEditDialog(row)">编辑</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-dialog
      v-model="dialogVisible"
      :title="dialogTitle"
      width="720px"
      append-to-body
      align-center
      destroy-on-close
    >
      <el-form label-width="110px">
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="商品编码">
              <el-input v-model="form.productCode" placeholder="可选，不填则后端自动生成" :disabled="!!form.id" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="商品名称">
              <el-input v-model="form.productName" placeholder="请输入商品名称" :disabled="!!form.id" />
            </el-form-item>
          </el-col>
        </el-row>

        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="建议单价">
              <el-input-number v-model="form.defaultPrice" :min="0" :precision="2" style="width: 100%" :disabled="!!form.id" />
            </el-form-item>
          </el-col>
        </el-row>

        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="当前库存">
              <el-input-number v-model="form.currentStock" :min="0" :step="1" style="width: 100%" disabled />
              <div class="mt-1 text-xs text-slate-400">请在“基础资料-产品管理”中编辑库存</div>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="单人限购">
              <el-input-number v-model="form.limitPerUser" :min="1" :step="1" style="width: 100%" />
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
          <el-upload
            class="avatar-uploader"
            drag
            action=""
            :http-request="handleCustomUpload"
            :show-file-list="false"
            accept="image/*"
            :disabled="uploadingThumbnail"
          >
            <div class="avatar-uploader__content">
              <img :src="displayThumbnail" class="avatar" alt="商品预览" />
              <div class="avatar-uploader__text">
                <el-icon class="avatar-uploader__icon"><UploadFilled /></el-icon>
                <p class="avatar-uploader__title">{{ uploadingThumbnail ? '图片上传中，请稍候…' : '拖拽图片到此处，或点击上传' }}</p>
                <p class="avatar-uploader__hint">推荐 800x800 方形图，系统会自动压缩并上传。</p>
              </div>
            </div>
          </el-upload>
          <div v-if="uploadingThumbnail || uploadProgress > 0" class="mt-3 w-full">
            <el-progress :percentage="uploadProgress" :stroke-width="10" :status="uploadProgressStatus" />
          </div>
          <div class="mt-3 flex w-full flex-wrap items-center gap-2">
            <el-button type="primary" plain :icon="ZoomIn" :disabled="!hasConfiguredThumbnail" @click="openThumbnailPreview">
              查看大图
            </el-button>
            <el-popconfirm
              width="240"
              title="确认删除当前预览图吗？"
              confirm-button-text="删除"
              cancel-button-text="取消"
              @confirm="handleRemoveThumbnail"
            >
              <template #reference>
                <el-button
                  type="danger"
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
          <p class="mt-2 w-full text-xs text-slate-400">支持拖拽上传，上传完成后可点击“查看大图”进行清晰预览。</p>
        </el-form-item>
        <el-form-item label="详情内容">
          <el-input v-model="form.detailContent" type="textarea" :rows="6" placeholder="请输入客户端商品详情说明" />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-space>
          <el-button @click="dialogVisible = false">取消</el-button>
          <el-button type="primary" :loading="submitting" @click="handleSubmit">保存</el-button>
        </el-space>
      </template>
    </el-dialog>

    <el-dialog
      v-model="imagePreviewVisible"
      title="商品预览图"
      width="min(92vw, 900px)"
      append-to-body
      align-center
      destroy-on-close
    >
      <img :src="displayThumbnail" alt="商品预览图大图" class="thumbnail-preview-dialog-image" />
    </el-dialog>
  </PageContainer>
</template>

<style scoped>
.avatar-uploader :deep(.el-upload) {
  border: 1px dashed rgba(148, 163, 184, 0.5);
  border-radius: 16px;
  cursor: pointer;
  position: relative;
  overflow: hidden;
  transition: border-color 0.2s ease, box-shadow 0.2s ease, transform 0.2s ease;
  background: linear-gradient(180deg, rgba(248, 250, 252, 0.78), rgba(255, 255, 255, 0.96));
}

.avatar-uploader :deep(.el-upload:hover) {
  border-color: var(--el-color-primary);
  box-shadow: 0 10px 24px -18px rgba(15, 23, 42, 0.45);
  transform: translateY(-1px);
}

.avatar-uploader :deep(.el-upload-dragger) {
  border: none;
  background: transparent;
  padding: 0;
}

.avatar-uploader__content {
  display: flex;
  width: 100%;
  min-height: 190px;
  align-items: center;
  gap: 1rem;
  padding: 1rem;
}

.avatar-uploader__text {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  min-width: 0;
}

.avatar-uploader__icon {
  font-size: 1.4rem;
  color: rgb(14 116 144);
}

.avatar-uploader__title {
  font-size: 0.9rem;
  font-weight: 600;
  color: rgb(30 41 59);
}

.avatar-uploader__hint {
  font-size: 0.76rem;
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
  width: 140px;
  height: 140px;
  display: block;
  object-fit: cover;
  border-radius: 14px;
  background: #f8fafc;
}

.thumbnail-remove-button {
  border-radius: 999px;
}

.thumbnail-preview-dialog-image {
  display: block;
  width: 100%;
  max-height: min(78vh, 760px);
  border-radius: 14px;
  object-fit: contain;
  background: #f8fafc;
}

@media (max-width: 767px) {
  .avatar-uploader__content {
    flex-direction: column;
    align-items: flex-start;
  }

  .avatar {
    width: 124px;
    height: 124px;
  }
}
</style>
