<script setup lang="ts">
/**
 * 模块说明：src/views/inventory/InventoryMasterDataView.vue
 * 文件职责：维护商品分类（两位编码，用于 WC SKU 编码）与库位（如 A-01-01）两类库存主数据。
 * 实现逻辑：
 * - 页签、刷新和新增集中在同一列表工作区，桌面表格与手机数据卡复用同一组数据；两类主数据共用编辑弹窗；
 * - 主数据只停用不删除，库位可直接管理当前 SKU 的默认库位关联；已关联商品的分类编码输入框直接禁用；
 * - 无 products:manage 权限时只读，不渲染新增、编辑与启停入口。
 * 维护说明：
 * - 分类编码一经被 SKU 编码使用就不能再改，服务端同样会拦截，前端禁用只是体验优化；
 * - 保存失败必须弹出服务端原因（例如编码重复），不能静默关闭弹窗。
 */

import { computed, onMounted, reactive, ref } from 'vue'
import { BizCrudDialogShell, BizResponsiveDataCollectionShell, PageContainer, PassiveNumberInput, PassiveSegmentedTabs } from '@/components/common'
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
import LocationSkuManageDialog from './components/LocationSkuManageDialog.vue'

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
const skuDialogVisible = ref(false)
const managingLocation = ref<LocationRecord | null>(null)

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

const openManageSkus = (row: LocationRecord) => {
  managingLocation.value = row
  skuDialogVisible.value = true
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
  <PageContainer title="分类与库位" description="维护商品分类编码和实物存放库位。">
    <section v-loading="loading && (activeTab === 'categories' ? categories.length > 0 : locations.length > 0)" class="apple-card min-w-0 p-3 sm:p-4">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-slate-100 pb-2 dark:border-white/10">
        <PassiveSegmentedTabs v-model="activeTab" :tabs="tabs" aria-label="主数据类型" class="!w-auto max-w-full" />
        <div class="flex flex-wrap gap-2">
          <el-button :loading="loading" class="!ml-0" @click="loadData">刷新</el-button>
          <el-button v-if="canManage" type="primary" class="!ml-0" @click="openCreate">
            {{ activeTab === 'categories' ? '新增分类' : '新增库位' }}
          </el-button>
        </div>
      </div>
      <div class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
        <span>{{ activeTab === 'categories' ? '分类' : '库位' }} {{ activeTab === 'categories' ? categories.length : locations.length }} 条</span>
        <span aria-hidden="true" class="hidden text-slate-300 sm:inline dark:text-slate-600">·</span>
        <span>{{ activeTab === 'categories' ? '分类编码用于生成新 SKU 编码' : '库位用于找货和按库位盘点' }}</span>
      </div>
      <BizResponsiveDataCollectionShell
        :items="activeTab === 'categories' ? categories : locations"
        :loading="loading"
        :empty-description="activeTab === 'categories' ? '暂无商品分类' : '暂无库位'"
        empty-min-height="128px"
        :disable-card-transition="true"
        table-wrapper-class="min-w-0"
        card-container-class="sm:grid-cols-2 xl:grid-cols-3"
      >
        <template #table>
          <el-table v-if="activeTab === 'categories'" :data="categories" row-key="id" empty-text="还没有分类">
            <el-table-column label="分类名称" min-width="180">
              <template #default="{ row }">
                <div class="font-medium text-slate-800 dark:text-slate-100">{{ row.categoryName }}</div>
                <div class="text-xs text-slate-500 dark:text-slate-400">排序 {{ row.sortOrder }}</div>
              </template>
            </el-table-column>
            <el-table-column label="分类编码" min-width="130">
              <template #default="{ row }">
                <div class="font-medium tabular-nums">{{ row.categoryCode }}</div>
                <div class="text-xs text-slate-500 dark:text-slate-400">SKU 前缀 WC{{ row.categoryCode }}</div>
              </template>
            </el-table-column>
            <el-table-column prop="productCount" label="关联商品" width="100" />
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

          <el-table v-else :data="locations" row-key="id" empty-text="还没有库位">
            <el-table-column prop="locationCode" label="库位编码" min-width="150" />
            <el-table-column label="库位名称" min-width="160">
              <template #default="{ row }">{{ row.locationName || '—' }}</template>
            </el-table-column>
            <el-table-column prop="skuCount" label="关联规格" width="100" />
            <el-table-column label="备注" min-width="160">
              <template #default="{ row }"><span class="text-slate-500 dark:text-slate-400">{{ row.remark || '—' }}</span></template>
            </el-table-column>
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag :type="row.isActive ? 'success' : 'info'" size="small">{{ row.isActive ? '启用' : '停用' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column v-if="canManage" label="操作" width="220" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" @click="openManageSkus(row)">管理规格</el-button>
                <el-button link type="primary" @click="openEditLocation(row)">编辑</el-button>
                <el-button link :type="row.isActive ? 'warning' : 'success'" @click="toggleLocation(row)">
                  {{ row.isActive ? '停用' : '启用' }}
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </template>
        <template #card="{ item }">
          <article v-if="activeTab === 'categories'" class="flex min-w-0 flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-white/10 dark:bg-slate-900/40">
            <div class="flex min-w-0 items-start justify-between gap-2">
              <div class="min-w-0">
                <div class="break-words font-semibold text-slate-800 dark:text-slate-100">{{ item.categoryName }}</div>
                <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">分类编码 {{ item.categoryCode }}</div>
              </div>
              <el-tag :type="item.isActive ? 'success' : 'info'" size="small">{{ item.isActive ? '启用' : '停用' }}</el-tag>
            </div>
            <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
              <span class="font-medium tabular-nums text-slate-800 dark:text-slate-100">关联商品 {{ item.productCount }}</span>
              <span class="text-xs text-slate-500 dark:text-slate-400">SKU 前缀 WC{{ item.categoryCode }} · 排序 {{ item.sortOrder }}</span>
            </div>
            <div v-if="canManage" class="flex gap-2 border-t border-slate-100 pt-3 dark:border-white/10">
              <el-button class="!ml-0 flex-1" @click="openEditCategory(item)">编辑</el-button>
              <el-button class="!ml-0 flex-1" :type="item.isActive ? 'warning' : 'success'" plain @click="toggleCategory(item)">{{ item.isActive ? '停用' : '启用' }}</el-button>
            </div>
          </article>
          <article v-else class="flex min-w-0 flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-white/10 dark:bg-slate-900/40">
            <div class="flex min-w-0 items-start justify-between gap-2">
              <div class="min-w-0">
                <div class="break-words font-semibold text-slate-800 dark:text-slate-100">{{ item.locationCode }}</div>
                <div class="mt-1 break-words text-sm text-slate-500 dark:text-slate-400">{{ item.locationName || '未设置名称' }}</div>
              </div>
              <el-tag :type="item.isActive ? 'success' : 'info'" size="small">{{ item.isActive ? '启用' : '停用' }}</el-tag>
            </div>
            <div class="space-y-1 text-sm">
              <div class="font-medium tabular-nums text-slate-800 dark:text-slate-100">关联规格 {{ item.skuCount }}</div>
              <div v-if="item.remark" class="break-words text-xs text-slate-500 dark:text-slate-400">备注：{{ item.remark }}</div>
            </div>
            <div v-if="canManage" class="flex flex-wrap gap-2 border-t border-slate-100 pt-3 dark:border-white/10">
              <el-button type="primary" plain class="!ml-0 w-full" @click="openManageSkus(item)">管理规格</el-button>
              <el-button class="!ml-0 flex-1" @click="openEditLocation(item)">编辑</el-button>
              <el-button class="!ml-0 flex-1" :type="item.isActive ? 'warning' : 'success'" plain @click="toggleLocation(item)">{{ item.isActive ? '停用' : '启用' }}</el-button>
            </div>
          </article>
        </template>
      </BizResponsiveDataCollectionShell>
    </section>

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
            <div v-if="editingInUse" class="mt-1 text-xs text-slate-500 dark:text-slate-400">该分类已有商品，编码不可修改</div>
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
    <LocationSkuManageDialog v-model="skuDialogVisible" :location="managingLocation" @updated="loadData" />
  </PageContainer>
</template>
