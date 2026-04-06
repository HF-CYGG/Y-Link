<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import type { RequestConfig } from '@/api/http'
import { createTag, getTagList, type Tag } from '@/api/modules/tag'
import {
  type CreateProductDto,
  createProduct,
  deleteProduct,
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

const allTags = ref<Tag[]>([])
const formRef = ref<FormInstance>()

const searchKeyword = ref('')
const searchTagId = ref('')

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
  isActive: boolean
  tagIds: string[]
}

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
  isActive: true,
  tagIds: [] as string[],
})

/**
 * 表单规则：
 * - 确保关键主数据字段完整；
 * - 录入校验尽量前置到前端完成。
 */
const rules: FormRules = {
  productCode: [{ required: true, message: '请输入产品编码', trigger: 'blur' }],
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
  void loadData()
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
  isActive: row.isActive,
  tagIds: row.tags ? row.tags.map((tag) => tag.id) : [],
})

/**
 * 将表单转换为提交 payload：
 * - 保存前先兜底创建缺失标签；
 * - 输出统一的产品 DTO，供新增与编辑接口共用。
 */
const buildSubmitPayload = async (currentForm: ProductForm): Promise<CreateProductDto> => {
  const resolvedTagIds = await resolveTagIds(currentForm.tagIds)
  return {
    productCode: currentForm.productCode,
    productName: currentForm.productName,
    pinyinAbbr: currentForm.pinyinAbbr,
    defaultPrice: currentForm.defaultPrice,
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
  handleAdd,
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
    deleteError: '删除失败',
  },
})

const resolveTagIds = async (tagValues: string[]): Promise<string[]> => {
  const createdTagNameCache = new Map<string, string>()
  const resolvedIds: string[] = []
  const autoCreatedTagNames: string[] = []

  for (const rawValue of tagValues) {
    const normalizedValue = rawValue.trim()
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
    ElMessage.success(`已自动创建标签：${[...new Set(autoCreatedTagNames)].join('、')}`)
  }

  return [...new Set(resolvedIds)]
}

onMounted(() => {
  void loadTags()
  void loadData()
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
        <el-button :class="isPhone ? 'w-full' : ''" type="primary" icon="Plus" @click="handleAdd">新增产品</el-button>
      </template>
    </PageToolbarCard>

    <BizResponsiveDataCollectionShell
      :items="products"
      :loading="loading"
      empty-description="暂无产品数据"
      :empty-card="true"
      card-key="id"
      wrapper-class="flex min-h-0 flex-1 flex-col"
      table-wrapper-class="apple-card h-full min-w-0 overflow-hidden px-0 py-3 sm:py-4 xl:py-5"
      card-container-class="pb-4 xl:grid-cols-3"
    >
      <template #table>
        <el-table :data="products" class="h-full w-full" stripe row-key="id" table-layout="auto">
            <el-table-column label="产品编码" prop="productCode" min-width="150" show-overflow-tooltip />
            <el-table-column label="产品名称" prop="productName" min-width="220" show-overflow-tooltip />
            <el-table-column label="拼音首字母" prop="pinyinAbbr" width="120" show-overflow-tooltip />
            <el-table-column label="默认售价" prop="defaultPrice" width="132">
              <template #default="{ row }">
                ¥{{ Number(row.defaultPrice).toFixed(2) }}
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
                <el-button link type="primary" @click="handleEdit(row)">编辑</el-button>
                <el-button link type="danger" @click="handleDelete(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
      </template>

      <template #card="{ item }">
        <div class="apple-card mobile-product-card min-w-0 p-4">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <h4 class="truncate text-base font-semibold text-slate-800 dark:text-slate-100">
                {{ item.productName }}
              </h4>
              <p class="mt-1 break-all text-sm text-slate-500 dark:text-slate-400">{{ item.productCode }}</p>
            </div>
            <div class="text-right">
              <span class="font-medium text-red-500">¥{{ Number(item.defaultPrice).toFixed(2) }}</span>
              <div class="mt-1">
                <el-tag :type="item.isActive ? 'success' : 'info'" size="small">
                  {{ item.isActive ? '启用' : '停用' }}
                </el-tag>
              </div>
            </div>
          </div>
          <div class="mt-2 text-xs text-slate-500 dark:text-slate-400">
            拼音简写：{{ item.pinyinAbbr || '-' }}
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
            <el-button size="small" @click="handleEdit(item)">编辑</el-button>
            <el-button size="small" type="danger" plain @click="handleDelete(item)">删除</el-button>
          </div>
        </div>
      </template>
    </BizResponsiveDataCollectionShell>

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
            <el-input v-model="form.productCode" placeholder="请输入产品编码" />
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
