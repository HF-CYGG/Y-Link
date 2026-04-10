<script setup lang="ts">
/**
 * 模块说明：src/views/o2o/O2oProductMallManageView.vue
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */


import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { UploadRequestOptions } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import imageCompression from 'browser-image-compression'
import { PageContainer } from '@/components/common'
import { uploadImage } from '@/api/modules/upload'
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
  category: string
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

const availableCategories = computed(() => {
  const categories = products.value.map((p) => p.category).filter(Boolean)
  return [...new Set(categories)]
})

const form = reactive<O2oProductFormState>({
  id: '',
  productCode: '',
  productName: '',
  defaultPrice: 0,
  isActive: true,
  category: '默认分类',
  o2oStatus: 'listed',
  thumbnail: '',
  detailContent: '',
  limitPerUser: 5,
  currentStock: 0,
})

const pendingUploadFile = ref<File | null>(null)
const localPreviewUrl = ref<string>('')

const displayThumbnail = computed(() => {
  return localPreviewUrl.value || form.thumbnail
})

const dialogTitle = computed(() => {
  return form.id ? '编辑线上商品' : '新增线上商品'
})

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
  form.category = '默认分类'
  form.o2oStatus = 'listed'
  form.thumbnail = ''
  form.detailContent = ''
  form.limitPerUser = 5
  form.currentStock = 0
  
  if (localPreviewUrl.value) {
    URL.revokeObjectURL(localPreviewUrl.value)
  }
  pendingUploadFile.value = null
  localPreviewUrl.value = ''
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
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

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
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

  try {
    const compressedFile = await imageCompression(file, {
      maxSizeMB: 0.8, // 压缩到不超过 800KB
      maxWidthOrHeight: 1200, // 限制最大边长，保证画质同时减小体积
      useWebWorker: true,
      initialQuality: 0.85
    })

    if (localPreviewUrl.value) {
      URL.revokeObjectURL(localPreviewUrl.value)
    }
    // 将压缩后的 Blob 转换为 File 对象，以适配后续上传接口
    pendingUploadFile.value = new File([compressedFile], file.name, {
      type: compressedFile.type,
      lastModified: Date.now(),
    })
    localPreviewUrl.value = URL.createObjectURL(compressedFile)
  } catch (error) {
    console.error('图片压缩失败:', error)
    ElMessage.error('图片处理失败，请重试')
  }
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const openEditDialog = (product: ProductRecord) => {
  resetForm()
  form.id = product.id
  form.productCode = product.productCode
  form.productName = product.productName
  form.defaultPrice = Number(product.defaultPrice)
  form.isActive = product.isActive
  form.category = product.category || '默认分类'
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
  await updateProduct(product.id, {
    o2oStatus: nextStatus,
  })
  ElMessage.success(nextStatus === 'listed' ? '商品已上架' : '商品已下架')
  await loadProducts()
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const handleSubmit = async () => {
  if (!form.productName.trim()) {
    ElMessage.warning('请输入商品名称')
    return
  }

  submitting.value = true
  try {
    let finalThumbnail = form.thumbnail.trim() || null

    if (pendingUploadFile.value) {
      try {
        const res = await uploadImage(pendingUploadFile.value)
        finalThumbnail = res.url
      } catch (error: any) {
        ElMessage.error(error.message || '图片上传失败，请重试')
        return
      }
    }

    if (form.id) {
      const payload: UpdateProductDto = {
        productCode: form.productCode.trim() || undefined,
        productName: form.productName.trim(),
        defaultPrice: Number(form.defaultPrice) || 0,
        isActive: form.isActive,
        category: form.category.trim() || '默认分类',
        o2oStatus: form.o2oStatus,
        thumbnail: finalThumbnail,
        detailContent: form.detailContent.trim() || null,
        limitPerUser: Math.max(1, Math.floor(form.limitPerUser)),
        currentStock: Math.max(0, Math.floor(form.currentStock)),
      }
      await updateProduct(form.id, payload)
      ElMessage.success('商品已更新')
    } else {
      const payload: CreateProductDto = {
        productCode: form.productCode.trim() || undefined,
        productName: form.productName.trim(),
        defaultPrice: Number(form.defaultPrice) || 0,
        isActive: form.isActive,
        category: form.category.trim() || '默认分类',
        o2oStatus: form.o2oStatus,
        thumbnail: finalThumbnail,
        detailContent: form.detailContent.trim() || null,
        limitPerUser: Math.max(1, Math.floor(form.limitPerUser)),
        currentStock: Math.max(0, Math.floor(form.currentStock)),
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
        <el-input v-model="keyword" placeholder="搜索商品名称 / 编码" clearable style="width: 220px" @keyup.enter="loadProducts" />
        <el-button @click="loadProducts">刷新</el-button>
        <el-button type="primary" @click="openCreateDialog">新增商品</el-button>
      </el-space>
    </template>

    <div class="mt-4 rounded-3xl bg-white p-4 shadow-sm">
      <el-table :data="products" :loading="loading" row-key="id">
        <el-table-column prop="productName" label="商品名称" min-width="180" />
        <el-table-column prop="productCode" label="编码" min-width="120" />
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
              @change="toggleListed(row, $event ? 'listed' : 'unlisted')"
            />
          </template>
        </el-table-column>
        <el-table-column label="预览图" min-width="150">
          <template #default="{ row }">
            <el-image
              v-if="row.thumbnail"
              :src="row.thumbnail"
              fit="cover"
              style="width: 72px; height: 72px; border-radius: 16px"
            />
            <span v-else class="text-sm text-slate-400">未设置</span>
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

    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="720px">
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
          <el-col :span="12">
            <el-form-item label="商品分类">
              <el-select
                v-model="form.category"
                filterable
                allow-create
                default-first-option
                placeholder="选择或输入新分类"
                style="width: 100%"
              >
                <el-option
                  v-for="cat in availableCategories"
                  :key="cat"
                  :label="cat"
                  :value="cat"
                />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>

        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="当前库存">
              <el-input-number v-model="form.currentStock" :min="0" :step="1" style="width: 100%" />
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
              <el-switch v-model="form.o2oStatus" active-value="listed" inactive-value="unlisted" active-text="上架" inactive-text="下架" inline-prompt />
            </div>
            <p class="mt-2 text-xs text-slate-400">注释：基础状态启用且商城展示上架，商品才会在客户端大厅中展示。</p>
          </div>
        </el-form-item>

        <el-form-item label="商品预览图">
          <el-upload
            class="avatar-uploader"
            action=""
            :http-request="handleCustomUpload"
            :show-file-list="false"
            accept="image/*"
          >
            <img v-if="displayThumbnail" :src="displayThumbnail" class="avatar" alt="预览图" />
            <el-icon v-else class="avatar-uploader-icon"><Plus /></el-icon>
          </el-upload>
          <p class="mt-1 text-xs text-slate-400 w-full">支持点击或拍照上传，推荐 800x800 方形图片。</p>
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
  </PageContainer>
</template>

<style scoped>
.avatar-uploader :deep(.el-upload) {
  border: 1px dashed var(--el-border-color);
  border-radius: 6px;
  cursor: pointer;
  position: relative;
  overflow: hidden;
  transition: var(--el-transition-duration-fast);
}

.avatar-uploader :deep(.el-upload:hover) {
  border-color: var(--el-color-primary);
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
}
</style>
