<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { PageContainer } from '@/components/common'
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
  form.o2oStatus = 'listed'
  form.thumbnail = ''
  form.detailContent = ''
  form.limitPerUser = 5
  form.currentStock = 0
}

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

const openCreateDialog = () => {
  resetForm()
  dialogVisible.value = true
}

const openEditDialog = (product: ProductRecord) => {
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
  await updateProduct(product.id, {
    o2oStatus: nextStatus,
  })
  ElMessage.success(nextStatus === 'listed' ? '商品已上架' : '商品已下架')
  await loadProducts()
}

const handleSubmit = async () => {
  if (!form.productName.trim()) {
    ElMessage.warning('请输入商品名称')
    return
  }

  submitting.value = true
  try {
    if (form.id) {
      const payload: UpdateProductDto = {
        productCode: form.productCode.trim() || undefined,
        productName: form.productName.trim(),
        defaultPrice: Number(form.defaultPrice) || 0,
        isActive: form.isActive,
        o2oStatus: form.o2oStatus,
        thumbnail: form.thumbnail.trim() || null,
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
        o2oStatus: form.o2oStatus,
        thumbnail: form.thumbnail.trim() || null,
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

    <div class="rounded-3xl bg-white p-4 shadow-sm">
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
              <el-input v-model="form.productCode" placeholder="可选，不填则后端自动生成" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="商品名称">
              <el-input v-model="form.productName" placeholder="请输入商品名称" />
            </el-form-item>
          </el-col>
        </el-row>

        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="建议单价">
              <el-input-number v-model="form.defaultPrice" :min="0" :precision="2" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="当前库存">
              <el-input-number v-model="form.currentStock" :min="0" :step="1" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>

        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="单人限购">
              <el-input-number v-model="form.limitPerUser" :min="1" :step="1" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="商品状态">
              <el-space wrap>
                <el-switch v-model="form.isActive" inline-prompt active-text="启用" inactive-text="停用" />
                <el-switch
                  v-model="form.o2oStatus"
                  inline-prompt
                  active-value="listed"
                  inactive-value="unlisted"
                  active-text="上架"
                  inactive-text="下架"
                />
              </el-space>
            </el-form-item>
          </el-col>
        </el-row>

        <el-form-item label="预览图地址">
          <el-input v-model="form.thumbnail" placeholder="请输入可访问的图片地址" />
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
