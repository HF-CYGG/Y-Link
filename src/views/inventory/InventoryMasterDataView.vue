<script setup lang="ts">
/**
 * 模块说明：src/views/inventory/InventoryMasterDataView.vue
 * 文件职责：维护商品分类（两位编码，用于 WC SKU 编码）与库位（如 A-01-01）两类库存主数据。
 * 实现逻辑：
 * - 页签用 PassiveSegmentedTabs 切换，两张表共用一个编辑弹窗，按当前页签决定表单字段；
 * - 主数据只停用不删除，列表展示引用数量，已关联商品的分类编码输入框直接禁用；
 * - 无 products:manage 权限时只读，不渲染新增、编辑与启停入口。
 * 维护说明：
 * - 分类编码一经被 SKU 编码使用就不能再改，服务端同样会拦截，前端禁用只是体验优化；
 * - 保存失败必须弹出服务端原因（例如编码重复），不能静默关闭弹窗。
 */

import { computed, onMounted, reactive, ref } from 'vue'
import { BizCrudDialogShell, PageContainer, PassiveNumberInput, PassiveSegmentedTabs } from '@/components/common'
import {
  createCategory,
  createLocation,
  getCategories,
  getLocations,
  updateCategory,
  updateLocation,
  type CategoryRecord,
  type LocationRecord,
} from '@/api/modules/inventory'
import { useAuthStore } from '@/store'
import pinia from '@/store/pinia'
import { showAppError, showAppSuccess } from '@/utils/app-alert'

type TabKey = 'categories' | 'locations'

const authStore = useAuthStore(pinia)
const canManage = computed(() => authStore.hasPermission('products:manage'))
const activeTab = ref<TabKey>('categories')
const tabs = [
  { label: '商品分类', name: 'categories' },
  { label: '库位', name: 'locations' },
]

const loading = ref(false)
const categories = ref<CategoryRecord[]>([])
const locations = ref<LocationRecord[]>([])

const dialogVisible = ref(false)
const saving = ref(false)
const editingId = ref<string | null>(null)
const editingInUse = ref(false)
const form = reactive({
  categoryCode: '',
  categoryName: '',
  sortOrder: 0 as number | null,
  locationCode: '',
  locationName: '',
  remark: '',
  isActive: true,
})

const dialogTitle = computed(() => {
  const target = activeTab.value === 'categories' ? '分类' : '库位'
  return editingId.value ? `编辑${target}` : `新增${target}`
})

const loadData = async () => {
  loading.value = true
  try {
    const [categoryRows, locationRows] = await Promise.all([getCategories(), getLocations()])
    categories.value = categoryRows
    locations.value = locationRows
  } catch (error) {
    showAppError(error, '主数据加载失败')
  } finally {
    loading.value = false
  }
}

const suggestNextCategoryCode = () => {
  const used = new Set(categories.value.map((item) => item.categoryCode))
  for (let value = 1; value < 100; value += 1) {
    const code = String(value).padStart(2, '0')
    if (!used.has(code)) return code
  }
  return ''
}

const openCreate = () => {
  editingId.value = null
  editingInUse.value = false
  Object.assign(form, {
    categoryCode: activeTab.value === 'categories' ? suggestNextCategoryCode() : '',
    categoryName: '',
    sortOrder: 0,
    locationCode: '',
    locationName: '',
    remark: '',
    isActive: true,
  })
  dialogVisible.value = true
}

const openEditCategory = (row: CategoryRecord) => {
  editingId.value = row.id
  editingInUse.value = row.productCount > 0
  Object.assign(form, { categoryCode: row.categoryCode, categoryName: row.categoryName, sortOrder: row.sortOrder, isActive: row.isActive })
  dialogVisible.value = true
}

const openEditLocation = (row: LocationRecord) => {
  editingId.value = row.id
  editingInUse.value = false
  Object.assign(form, { locationCode: row.locationCode, locationName: row.locationName ?? '', remark: row.remark ?? '', isActive: row.isActive })
  dialogVisible.value = true
}

const handleSave = async () => {
  saving.value = true
  try {
    if (activeTab.value === 'categories') {
      const payload = {
        categoryCode: form.categoryCode.trim(),
        categoryName: form.categoryName.trim(),
        sortOrder: form.sortOrder ?? 0,
        isActive: form.isActive,
      }
      if (editingId.value) await updateCategory(editingId.value, payload)
      else await createCategory(payload)
    } else {
      const payload = {
        locationCode: form.locationCode.trim(),
        locationName: form.locationName.trim() || null,
        remark: form.remark.trim() || null,
        isActive: form.isActive,
      }
      if (editingId.value) await updateLocation(editingId.value, payload)
      else await createLocation(payload)
    }
    showAppSuccess('已保存')
    dialogVisible.value = false
    await loadData()
  } catch (error) {
    showAppError(error, '保存失败')
  } finally {
    saving.value = false
  }
}

const toggleCategory = async (row: CategoryRecord) => {
  try {
    await updateCategory(row.id, { isActive: !row.isActive })
    await loadData()
  } catch (error) {
    showAppError(error, '操作失败')
  }
}

const toggleLocation = async (row: LocationRecord) => {
  try {
    await updateLocation(row.id, { isActive: !row.isActive })
    await loadData()
  } catch (error) {
    showAppError(error, '操作失败')
  }
}

onMounted(loadData)
</script>

<template>
  <PageContainer title="分类与库位" description="分类编码参与 SKU 编码（WC + 分类编码 + 流水号）；库位用于找货与按库位盘点。">
    <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
      <PassiveSegmentedTabs v-model="activeTab" :tabs="tabs" aria-label="主数据类型" />
      <div class="flex gap-2">
        <el-button :loading="loading" @click="loadData">刷新</el-button>
        <el-button v-if="canManage" type="primary" @click="openCreate">
          {{ activeTab === 'categories' ? '新增分类' : '新增库位' }}
        </el-button>
      </div>
    </div>

    <el-card shadow="never">
      <el-table v-if="activeTab === 'categories'" v-loading="loading" :data="categories" row-key="id" empty-text="还没有分类">
        <el-table-column prop="categoryCode" label="分类编码" width="110" />
        <el-table-column prop="categoryName" label="分类名称" min-width="160" />
        <el-table-column label="SKU 编码前缀" width="140">
          <template #default="{ row }">WC{{ row.categoryCode }}</template>
        </el-table-column>
        <el-table-column prop="productCount" label="商品数" width="90" />
        <el-table-column prop="sortOrder" label="排序" width="80" />
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.isActive ? 'success' : 'info'" size="small">{{ row.isActive ? '启用' : '停用' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column v-if="canManage" label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEditCategory(row)">编辑</el-button>
            <el-button link :type="row.isActive ? 'warning' : 'success'" @click="toggleCategory(row)">
              {{ row.isActive ? '停用' : '启用' }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-table v-else v-loading="loading" :data="locations" row-key="id" empty-text="还没有库位">
        <el-table-column prop="locationCode" label="库位编码" width="140" />
        <el-table-column label="库位名称" min-width="140">
          <template #default="{ row }">{{ row.locationName || '—' }}</template>
        </el-table-column>
        <el-table-column prop="skuCount" label="存放规格数" width="110" />
        <el-table-column label="备注" min-width="160">
          <template #default="{ row }">{{ row.remark || '—' }}</template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.isActive ? 'success' : 'info'" size="small">{{ row.isActive ? '启用' : '停用' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column v-if="canManage" label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEditLocation(row)">编辑</el-button>
            <el-button link :type="row.isActive ? 'warning' : 'success'" @click="toggleLocation(row)">
              {{ row.isActive ? '停用' : '启用' }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <BizCrudDialogShell
      v-model="dialogVisible"
      :title="dialogTitle"
      height-mode="auto"
      :confirm-loading="saving"
      confirm-text="保存"
      @confirm="handleSave"
    >
      <el-form label-width="96px" @submit.prevent>
        <template v-if="activeTab === 'categories'">
          <el-form-item label="分类编码" required>
            <el-input v-model="form.categoryCode" maxlength="2" placeholder="两位数字，如 02" :disabled="editingInUse" />
            <div v-if="editingInUse" class="mt-1 text-xs text-slate-500">该分类已有商品，编码不可修改</div>
          </el-form-item>
          <el-form-item label="分类名称" required>
            <el-input v-model="form.categoryName" maxlength="64" placeholder="如 贴纸、帆布包" />
          </el-form-item>
          <el-form-item label="排序">
            <PassiveNumberInput v-model="form.sortOrder" :min="0" :max="999999" :precision="0" />
          </el-form-item>
        </template>
        <template v-else>
          <el-form-item label="库位编码" required>
            <el-input v-model="form.locationCode" maxlength="32" placeholder="如 A-01-01（区-架-层）" />
          </el-form-item>
          <el-form-item label="库位名称">
            <el-input v-model="form.locationName" maxlength="64" placeholder="可选，如 A 区一号架第一层" />
          </el-form-item>
          <el-form-item label="备注">
            <el-input v-model="form.remark" maxlength="255" />
          </el-form-item>
        </template>
        <el-form-item label="启用">
          <el-switch v-model="form.isActive" />
        </el-form-item>
      </el-form>
    </BizCrudDialogShell>
  </PageContainer>
</template>
