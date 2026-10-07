<script setup lang="ts">
/**
 * 模块说明：src/views/o2o/O2oProductMallManageView.vue
 * 文件职责：集中维护商品在客户端商城的上下架、推荐、限购和详情文案。
 * 实现逻辑：桌面紧凑表格与手机卡片共用筛选、选择和预览图规则；写入仅调用线上展示专用接口。
 * 维护说明：商品资料、SKU 启停、价格、库存和图片只读；新增和规格配置跳基础资料入口，不能回传完整商品或 SKU。
 */
import { computed, nextTick, onActivated, onDeactivated, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { TableInstance } from 'element-plus'
import { PageContainer, PageToolbarCard, PassivePreviewImage } from '@/components/common'
import { getTagList, type Tag } from '@/api/modules/tag'
import {
  batchUpdateProductOnlineDisplay,
  getProductDetail,
  getProductList,
  updateProductOnlineDisplay,
  type ProductRecord,
  type ProductSkuRecord,
} from '@/api/modules/product'
import { useDevice } from '@/composables/useDevice'
import { usePermissionAction } from '@/composables/usePermissionAction'
import { showAppError, showAppSuccess, showAppWarning } from '@/utils/app-alert'
import { normalizeRequestError } from '@/utils/error'
import { resolveO2oPriceView } from '@/utils/o2o-price'
import { resolveProductPlaceholder } from '@/utils/product-placeholder'
import { resolveProductPreviewImage, resolveProductPreviewSku } from '@/utils/product-preview'
import {
  buildOnlineDisplayPatch,
  clampOnlineDisplayPage,
  filterOnlineDisplayProducts,
  mergeOnlineDisplayPageSelection,
  validateOnlineDisplayPatch,
  type OnlineDisplaySnapshot,
} from './o2o-online-display.helpers'

type StatusFilter = 'all' | 'listed' | 'unlisted'
type BaseFilter = 'all' | 'active' | 'inactive'
type ImageFilter = 'all' | 'missing'
type RecommendationMode = 'all' | 'selected' | 'none'

const router = useRouter()
const { isPhone } = useDevice()
const { hasPermission, ensurePermission } = usePermissionAction()
const canManageProducts = computed(() => hasPermission('products:manage'))

const loading = ref(false)
const tags = ref<Tag[]>([])
const products = ref<ProductRecord[]>([])
const keywordDraft = ref('')
const keyword = ref('')
const tagId = ref('')
const onlineFilter = ref<StatusFilter>('all')
const baseFilter = ref<BaseFilter>('all')
const imageFilter = ref<ImageFilter>('all')
const page = ref(1)
const pageSize = ref(10)
const pageSizes = [10, 20, 50]
const selectedIds = ref<string[]>([])
const tableRef = ref<TableInstance>()
const restoringSelection = ref(false)
let selectionRestoreEpoch = 0
const batchSubmitting = ref(false)
const busyIds = ref<Set<string>>(new Set())
let loadSequence = 0
let editorRequestSequence = 0
let mountedReady = false

const filteredProducts = computed(() => filterOnlineDisplayProducts(products.value, {
  online: onlineFilter.value, base: baseFilter.value, image: imageFilter.value,
}))
const total = computed(() => filteredProducts.value.length)
const pagedProducts = computed(() => filteredProducts.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value))
const selectedCount = computed(() => selectedIds.value.length)

const currentSkus = (product: ProductRecord): ProductSkuRecord[] =>
  (product.skus ?? []).filter((sku) => sku.isCurrent !== false)
const activeCurrentSkus = (product: ProductRecord): ProductSkuRecord[] =>
  currentSkus(product).filter((sku) => sku.isActive !== false)
const skuName = (sku: ProductSkuRecord) => sku.specText || sku.skuCode || '默认规格'
const imageUrl = (product: ProductRecord) => resolveProductPreviewImage(product)
const imageOrPlaceholder = (product: ProductRecord) => resolveProductPlaceholder(imageUrl(product))
const priceText = (product: ProductRecord) =>
  `¥${Number(resolveO2oPriceView(resolveProductPreviewSku(product) ?? product).discountedPrice).toFixed(2)}`
const recommendationLabel = (product: ProductRecord) => {
  if (product.o2oRecommended) return '全部推荐'
  const count = activeCurrentSkus(product).filter((sku) => sku.o2oRecommended === true).length
  return count ? `指定 ${count} 款` : '未推荐'
}

const editorVisible = ref(false)
const editorLoading = ref(false)
const submitting = ref(false)
const editingProduct = ref<ProductRecord | null>(null)
const form = reactive({
  o2oStatus: 'unlisted' as 'listed' | 'unlisted',
  recommendationMode: 'none' as RecommendationMode,
  selectedSkuIds: [] as string[],
  limitPerUser: 5,
  detailContent: '',
})
let originalDisplay: OnlineDisplaySnapshot | null = null
const availableRecommendationSkus = computed(() => editingProduct.value ? activeCurrentSkus(editingProduct.value) : [])

function clampPage(): void {
  page.value = clampOnlineDisplayPage(page.value, pageSize.value, total.value)
}

async function restoreTableSelection(): Promise<void> {
  const epoch = ++selectionRestoreEpoch
  // 必须在等待表格数据更新前阻断 Element Plus 因翻页发出的 selection-change([])。
  restoringSelection.value = true
  await nextTick()
  try {
    if (!tableRef.value) return
    tableRef.value.clearSelection()
    const ids = new Set(selectedIds.value)
    pagedProducts.value.forEach((product) => {
      if (ids.has(product.id)) tableRef.value?.toggleRowSelection(product, true)
    })
  } finally {
    if (epoch === selectionRestoreEpoch) restoringSelection.value = false
  }
}

async function clearSelection(): Promise<void> {
  selectedIds.value = []
  await restoreTableSelection()
}

function onTableSelectionChange(rows: ProductRecord[]): void {
  if (restoringSelection.value) return
  selectedIds.value = mergeOnlineDisplayPageSelection(selectedIds.value, pagedProducts.value, rows)
}

function onCardSelectionChange(id: string, value: boolean | string | number): void {
  selectedIds.value = value === true
    ? [...new Set([...selectedIds.value, id])]
    : selectedIds.value.filter((selectedId) => selectedId !== id)
}

function onCompactBatchCommand(command: string): void {
  if (command === 'listed' || command === 'unlisted') void batchSetListed(command)
  if (command === 'clear') void clearSelection()
}

async function loadProducts(): Promise<void> {
  const sequence = ++loadSequence
  loading.value = true
  try {
    const result = await getProductList({ keyword: keyword.value || undefined, tagId: tagId.value || undefined })
    if (sequence !== loadSequence) return
    products.value = result
    const visibleIds = new Set(filteredProducts.value.map((product) => product.id))
    selectedIds.value = selectedIds.value.filter((id) => visibleIds.has(id))
    clampPage()
    await restoreTableSelection()
  } catch (error) {
    if (sequence === loadSequence) showAppError(error, '加载线上商品失败')
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

function applySearch(): void {
  keyword.value = keywordDraft.value.trim()
  page.value = 1
  void clearSelection()
  void loadProducts()
}

watch([onlineFilter, baseFilter, imageFilter], () => {
  page.value = 1
  void clearSelection()
})
watch([page, pageSize], () => {
  clampPage()
  void restoreTableSelection()
})

function goToBasic(action: 'create' | 'batch-create' | 'sku-config', productId?: string): void {
  if (!ensurePermission('products:manage', '维护商品基础资料')) return
  editorRequestSequence += 1
  editorVisible.value = false
  void router.push({
    path: '/base-data/products',
    query: { productAction: action, ...(productId ? { productId } : {}) },
  })
}

async function openEditor(product: ProductRecord): Promise<void> {
  const sequence = ++editorRequestSequence
  editorLoading.value = true
  try {
    const latest = await getProductDetail(product.id)
    if (sequence !== editorRequestSequence) return
    editingProduct.value = latest
    form.o2oStatus = latest.o2oStatus
    const recommendedIds = activeCurrentSkus(latest)
      .filter((sku) => sku.o2oRecommended === true && sku.id)
      .map((sku) => String(sku.id))
    form.recommendationMode = latest.o2oRecommended ? 'all' : recommendedIds.length ? 'selected' : 'none'
    form.selectedSkuIds = recommendedIds
    form.limitPerUser = latest.limitPerUser
    form.detailContent = latest.detailContent ?? ''
    originalDisplay = {
      o2oStatus: form.o2oStatus,
      recommendationMode: form.recommendationMode,
      selectedSkuIds: [...form.selectedSkuIds],
      limitPerUser: form.limitPerUser,
      detailContent: form.detailContent,
    }
    editorVisible.value = true
  } catch (error) {
    if (sequence === editorRequestSequence) showAppError(error, '加载商品详情失败')
  } finally {
    if (sequence === editorRequestSequence) editorLoading.value = false
  }
}

watch(editorVisible, (visible) => {
  if (!visible) editorRequestSequence += 1
})

async function refreshAfterConflict(error: unknown): Promise<boolean> {
  const normalized = normalizeRequestError(error)
  if (normalized.status !== 409) return false
  editorVisible.value = false
  showAppWarning(`${normalized.message}，已刷新商品，请检查后重试`)
  await loadProducts()
  return true
}

async function saveOnlineDisplay(): Promise<void> {
  const product = editingProduct.value
  if (!product || !originalDisplay || !ensurePermission('products:manage', '保存线上展示')) return
  if (!product.isActive && form.o2oStatus === 'listed') {
    showAppWarning('商品已停用，请先在基础资料中启用')
    return
  }
  const selectedSkuIds = [...new Set(form.selectedSkuIds)]
  if (selectedSkuIds.some((id) => !availableRecommendationSkus.value.some((sku) => sku.id === id))) {
    showAppWarning('推荐规格不属于当前启用规格，请刷新后重试')
    return
  }
  if (form.recommendationMode === 'selected' && !selectedSkuIds.length) {
    showAppWarning('请选择至少一个当前启用的推荐规格')
    return
  }
  const payload = buildOnlineDisplayPatch(originalDisplay, {
    o2oStatus: form.o2oStatus,
    recommendationMode: form.recommendationMode,
    selectedSkuIds,
    limitPerUser: form.limitPerUser,
    detailContent: form.detailContent,
  }, currentSkus(product).map((sku) => String(sku.id ?? '')).filter(Boolean))
  const validationError = validateOnlineDisplayPatch(payload)
  if (validationError) {
    showAppWarning(validationError)
    return
  }
  if (!Object.keys(payload).length) {
    showAppWarning('线上展示没有需要保存的变更')
    return
  }
  submitting.value = true
  try {
    await updateProductOnlineDisplay(product.id, payload)
    editorVisible.value = false
    showAppSuccess('线上展示已保存')
    await loadProducts()
  } catch (error) {
    if (!(await refreshAfterConflict(error))) showAppError(error, '保存线上展示失败')
  } finally {
    submitting.value = false
  }
}

async function toggleListed(product: ProductRecord, nextStatus: 'listed' | 'unlisted'): Promise<void> {
  if (!ensurePermission('products:manage', '切换线上状态')) return
  if (nextStatus === 'listed' && !product.isActive) {
    showAppWarning('商品已停用，请先在基础资料中启用')
    return
  }
  busyIds.value = new Set([...busyIds.value, product.id])
  try {
    await updateProductOnlineDisplay(product.id, { o2oStatus: nextStatus })
    showAppSuccess(nextStatus === 'listed' ? '商品已上架' : '商品已下架')
    await loadProducts()
  } catch (error) {
    if (!(await refreshAfterConflict(error))) showAppError(error, '切换线上状态失败')
  } finally {
    const next = new Set(busyIds.value)
    next.delete(product.id)
    busyIds.value = next
  }
}

async function batchSetListed(nextStatus: 'listed' | 'unlisted'): Promise<void> {
  if (!ensurePermission('products:manage', '批量切换线上状态')) return
  if (!selectedIds.value.length) {
    showAppWarning('请先选择商品')
    return
  }
  if (selectedIds.value.length > 100) {
    showAppWarning('每次最多批量处理 100 个商品')
    return
  }
  if (nextStatus === 'listed' && products.value.some((product) => selectedIds.value.includes(product.id) && !product.isActive)) {
    showAppWarning('选中商品包含已停用商品，请先在基础资料中启用')
    return
  }
  batchSubmitting.value = true
  try {
    const result = await batchUpdateProductOnlineDisplay({ ids: selectedIds.value, o2oStatus: nextStatus })
    await clearSelection()
    await loadProducts()
    showAppSuccess(`已${nextStatus === 'listed' ? '上架' : '下架'} ${result.updatedCount} 个商品`)
  } catch (error) {
    if (!(await refreshAfterConflict(error))) showAppError(error, '批量切换线上状态失败')
  } finally {
    batchSubmitting.value = false
  }
}

onMounted(async () => {
  await Promise.all([loadProducts(), getTagList().then((result) => { tags.value = result }).catch(() => {})])
  mountedReady = true
})
onActivated(() => {
  if (mountedReady) void loadProducts()
})
onDeactivated(() => {
  editorRequestSequence += 1
  editorVisible.value = false
})
</script>

<template>
  <PageContainer title="线上展示" description="维护客户端商城的展示内容。商品资料、价格、库存和图片在基础资料中配置。">
    <PageToolbarCard compact content-class="mall-toolbar-stack" actions-class="mall-toolbar-actions">
      <template #default>
        <div class="mall-filters">
          <el-input v-model="keywordDraft" clearable placeholder="搜索名称、拼音或编码" class="mall-filters__keyword" @keyup.enter="applySearch" @clear="applySearch" />
          <el-select v-model="tagId" clearable placeholder="全部标签" class="mall-filters__select" @change="applySearch">
            <el-option v-for="tag in tags" :key="tag.id" :value="tag.id" :label="tag.tagName" />
          </el-select>
          <el-select v-model="onlineFilter" class="mall-filters__select" aria-label="线上状态筛选">
            <el-option value="all" label="全部线上状态" />
            <el-option value="listed" label="已上架" />
            <el-option value="unlisted" label="已下架" />
          </el-select>
          <el-select v-model="baseFilter" class="mall-filters__select" aria-label="基础状态筛选">
            <el-option value="all" label="全部基础状态" />
            <el-option value="active" label="基础启用" />
            <el-option value="inactive" label="基础停用" />
          </el-select>
          <el-select v-model="imageFilter" class="mall-filters__select" aria-label="预览图筛选">
            <el-option value="all" label="全部图片状态" />
            <el-option value="missing" label="缺少有效预览图" />
          </el-select>
          <el-button type="primary" @click="applySearch">搜索</el-button>
        </div>
      </template>
      <template #actions>
        <div class="mall-actions">
          <span class="mall-actions__summary">结果 {{ total }} 件<span v-if="canManageProducts"> · 已选 {{ selectedCount }} 件</span><span v-else> · 只读模式</span></span>
          <template v-if="canManageProducts">
            <el-dropdown v-if="isPhone" trigger="click" :disabled="!selectedCount || batchSubmitting" @command="onCompactBatchCommand">
              <el-button :disabled="!selectedCount" :loading="batchSubmitting">批量操作</el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="listed">批量上架</el-dropdown-item>
                  <el-dropdown-item command="unlisted">批量下架</el-dropdown-item>
                  <el-dropdown-item command="clear">清空选择</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
            <template v-else>
              <el-button :disabled="!selectedCount" :loading="batchSubmitting" @click="batchSetListed('listed')">批量上架</el-button>
              <el-button :disabled="!selectedCount" :loading="batchSubmitting" @click="batchSetListed('unlisted')">批量下架</el-button>
              <el-button :disabled="!selectedCount" @click="clearSelection">清空选择</el-button>
            </template>
            <el-button @click="goToBasic('batch-create')">批量新增</el-button>
            <el-button type="primary" @click="goToBasic('create')">新增商品</el-button>
          </template>
        </div>
      </template>
    </PageToolbarCard>

    <section class="mall-surface" v-loading="loading">
      <div v-if="isPhone" class="mall-cards">
        <article v-for="product in pagedProducts" :key="product.id" class="mall-card">
          <div v-if="canManageProducts" class="mall-card__selection">
            <el-checkbox :model-value="selectedIds.includes(product.id)" @change="onCardSelectionChange(product.id, $event)">选择商品</el-checkbox>
          </div>
          <div class="mall-product">
            <PassivePreviewImage :src="imageOrPlaceholder(product)" :preview-images="imageUrl(product) ? [imageUrl(product)!] : []" fit="cover" class="mall-product__image" style="width:48px;height:48px;min-width:48px;max-width:48px;flex:0 0 48px;border-radius:10px" alt="商品预览图" dialog-title="商品预览图" />
            <div class="mall-product__copy">
              <strong>{{ product.productName }}</strong>
              <span>{{ product.productCode }}</span>
              <el-button v-if="!imageUrl(product) && canManageProducts" link type="warning" @click="goToBasic('sku-config', product.id)">缺图，配置规格</el-button>
            </div>
          </div>
          <div class="mall-card__tags">
            <el-tag size="small" :type="product.isActive ? 'success' : 'info'">基础{{ product.isActive ? '启用' : '停用' }}</el-tag>
            <el-tag size="small" :type="product.o2oStatus === 'listed' ? 'success' : 'warning'">{{ product.o2oStatus === 'listed' ? '已上架' : '已下架' }}</el-tag>
            <el-tag size="small" type="info">{{ recommendationLabel(product) }}</el-tag>
          </div>
          <div class="mall-card__facts">
            <span>展示价 <b>{{ priceText(product) }}</b></span>
            <span>可用 {{ product.availableStock }}</span>
            <span>限购 {{ product.limitPerUser }}</span>
          </div>
          <div class="mall-card__footer">
            <el-switch v-if="canManageProducts" :model-value="product.o2oStatus === 'listed'" active-text="上架" inactive-text="下架" inline-prompt
              :loading="busyIds.has(product.id)" :disabled="busyIds.has(product.id) || (!product.isActive && product.o2oStatus !== 'listed')"
              @change="toggleListed(product, $event === true ? 'listed' : 'unlisted')" />
            <el-button link type="primary" @click="openEditor(product)">{{ canManageProducts ? '编辑展示' : '查看展示' }}</el-button>
          </div>
        </article>
        <el-empty v-if="!pagedProducts.length && !loading" description="没有符合条件的商品" />
      </div>

      <el-table v-else ref="tableRef" :data="pagedProducts" row-key="id" native-scrollbar size="small" @selection-change="onTableSelectionChange">
        <el-table-column v-if="canManageProducts" type="selection" width="48" reserve-selection />
        <el-table-column label="商品" min-width="250">
          <template #default="{ row }">
            <div class="mall-product">
              <PassivePreviewImage :src="imageOrPlaceholder(row)" :preview-images="imageUrl(row) ? [imageUrl(row)!] : []" fit="cover" class="mall-product__image" style="width:48px;height:48px;min-width:48px;max-width:48px;flex:0 0 48px;border-radius:10px" alt="商品预览图" dialog-title="商品预览图" />
              <div class="mall-product__copy">
                <strong>{{ row.productName }}</strong>
                <span>{{ row.productCode }}</span>
                <el-button v-if="!imageUrl(row) && canManageProducts" link type="warning" @click="goToBasic('sku-config', row.id)">缺图，配置规格</el-button>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="展示价" width="105"><template #default="{ row }"><strong class="mall-price">{{ priceText(row) }}</strong></template></el-table-column>
        <el-table-column label="可用库存" prop="availableStock" width="88" align="center" />
        <el-table-column label="基础状态" width="100"><template #default="{ row }"><el-tag size="small" :type="row.isActive ? 'success' : 'info'">{{ row.isActive ? '启用' : '停用' }}</el-tag></template></el-table-column>
        <el-table-column label="线上状态" width="116">
          <template #default="{ row }">
            <el-switch v-if="canManageProducts" :model-value="row.o2oStatus === 'listed'" active-text="上架" inactive-text="下架" inline-prompt
              :loading="busyIds.has(row.id)" :disabled="busyIds.has(row.id) || (!row.isActive && row.o2oStatus !== 'listed')"
              @change="toggleListed(row, $event === true ? 'listed' : 'unlisted')" />
            <el-tag v-else size="small" :type="row.o2oStatus === 'listed' ? 'success' : 'warning'">{{ row.o2oStatus === 'listed' ? '已上架' : '已下架' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="推荐" width="110"><template #default="{ row }">{{ recommendationLabel(row) }}</template></el-table-column>
        <el-table-column label="限购" prop="limitPerUser" width="72" align="center" />
        <el-table-column label="操作" width="92" fixed="right"><template #default="{ row }"><el-button link type="primary" @click="openEditor(row)">{{ canManageProducts ? '编辑展示' : '查看' }}</el-button></template></el-table-column>
        <template #empty><el-empty description="没有符合条件的商品" /></template>
      </el-table>

      <div v-if="total" class="mall-pagination">
        <el-pagination v-model:current-page="page" v-model:page-size="pageSize" :page-sizes="pageSizes"
          :layout="isPhone ? 'prev, pager, next' : 'total, sizes, prev, pager, next'" :total="total" />
      </div>
    </section>

    <el-dialog v-model="editorVisible" title="线上展示设置" width="min(720px, 94vw)" destroy-on-close>
      <div v-if="editingProduct" v-loading="editorLoading" class="mall-editor">
        <div class="mall-editor__summary">
          <div class="mall-product">
            <PassivePreviewImage :src="imageOrPlaceholder(editingProduct)" :preview-images="imageUrl(editingProduct) ? [imageUrl(editingProduct)!] : []" fit="cover" class="mall-product__image" style="width:48px;height:48px;min-width:48px;max-width:48px;flex:0 0 48px;border-radius:10px" alt="商品预览图" dialog-title="商品预览图" />
            <div class="mall-product__copy"><strong>{{ editingProduct.productName }}</strong><span>{{ editingProduct.productCode }}</span></div>
          </div>
          <el-tag :type="editingProduct.isActive ? 'success' : 'info'">基础{{ editingProduct.isActive ? '启用' : '停用' }}</el-tag>
        </div>
        <p class="mall-editor__note">基础资料、SKU 启停、价格、库存和图片均在基础资料中维护。本窗口只保存线上展示字段。</p>
        <div v-if="canManageProducts" class="mall-editor__links">
          <el-button link type="primary" @click="goToBasic('sku-config', editingProduct.id)">前往基础资料配置规格与图片</el-button>
        </div>

        <el-form label-position="top" class="mall-editor__form">
          <div class="mall-editor__row">
            <el-form-item label="客户端上架状态">
              <el-switch v-model="form.o2oStatus" active-value="listed" inactive-value="unlisted" active-text="上架" inactive-text="下架" inline-prompt
                :disabled="!canManageProducts || (!editingProduct.isActive && form.o2oStatus !== 'listed')" />
            </el-form-item>
            <el-form-item label="单人限购">
              <el-input-number v-model="form.limitPerUser" :min="1" :max="Math.max(999999, editingProduct.limitPerUser)" :step="1" :disabled="!canManageProducts" controls-position="right" />
            </el-form-item>
          </div>
          <el-form-item label="客户端推荐">
            <el-radio-group v-model="form.recommendationMode" :disabled="!canManageProducts">
              <el-radio-button value="none">不推荐</el-radio-button>
              <el-radio-button value="all">全部规格</el-radio-button>
              <el-radio-button value="selected">指定规格</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item v-if="form.recommendationMode === 'selected'" label="推荐的当前启用规格">
            <el-select v-model="form.selectedSkuIds" multiple filterable class="mall-editor__sku-select" placeholder="选择规格" :disabled="!canManageProducts">
              <el-option v-for="sku in availableRecommendationSkus" :key="sku.id" :value="sku.id!" :label="skuName(sku)" />
            </el-select>
          </el-form-item>
          <el-form-item label="客户端详情">
            <el-input v-model="form.detailContent" type="textarea" :rows="5" :maxlength="20000" placeholder="填写商品详情说明" :disabled="!canManageProducts" />
          </el-form-item>
        </el-form>
        <div class="mall-editor__sku-list">
          <strong>当前规格（只读）</strong>
          <p v-if="!currentSkus(editingProduct).length">暂无当前规格，请前往基础资料配置。</p>
          <div v-for="sku in currentSkus(editingProduct)" :key="sku.id" class="mall-editor__sku-row">
            <span>{{ skuName(sku) }}</span>
            <span>可用 {{ sku.availableStock ?? 0 }}</span>
            <el-tag size="small" :type="sku.isActive === false ? 'info' : 'success'">{{ sku.isActive === false ? '停用' : '启用' }}</el-tag>
          </div>
        </div>
      </div>
      <template #footer>
        <el-button @click="editorVisible = false">{{ canManageProducts ? '取消' : '关闭' }}</el-button>
        <el-button v-if="canManageProducts" type="primary" :loading="submitting" @click="saveOnlineDisplay">保存线上展示</el-button>
      </template>
    </el-dialog>
  </PageContainer>
</template>

<style scoped>
.mall-filters { display: flex; flex-wrap: wrap; align-items: center; gap: .6rem; width: 100%; }
:deep(.mall-toolbar-stack) { flex-direction: column !important; }
:deep(.mall-toolbar-actions) { width: 100%; justify-content: flex-start !important; }
.mall-filters__keyword { width: min(260px, 100%); }
.mall-filters__select { width: 150px; }
.mall-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: .5rem; }
.mall-actions__summary { margin-right: auto; color: #64748b; font-size: .78rem; white-space: nowrap; }
.mall-surface { margin-top: 1rem; padding: 1rem; border: 1px solid #e2e8f0; border-radius: 18px; background: #fff; min-height: 210px; }
.mall-product { display: flex; align-items: center; gap: .7rem; min-width: 0; }
.mall-product__copy { display: flex; flex-direction: column; align-items: flex-start; min-width: 0; line-height: 1.4; }
.mall-product__copy strong { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #0f172a; }
.mall-product__copy span { color: #64748b; font-size: .75rem; }
.mall-price { color: #0f766e; }
.mall-pagination { display: flex; justify-content: flex-end; margin-top: .9rem; }
.mall-cards { display: grid; gap: .7rem; }
.mall-card { padding: .85rem; border: 1px solid #e2e8f0; border-radius: 14px; background: #fff; }
.mall-card__selection { margin-bottom: .35rem; }
.mall-card__tags, .mall-card__facts, .mall-card__footer { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; margin-top: .7rem; }
.mall-card__facts { justify-content: space-between; color: #64748b; font-size: .82rem; }
.mall-card__facts b { color: #0f766e; }
.mall-card__footer { justify-content: space-between; padding-top: .6rem; border-top: 1px solid #f1f5f9; }
.mall-editor { display: grid; gap: .9rem; }
.mall-editor__summary { display: flex; align-items: center; justify-content: space-between; gap: .8rem; }
.mall-editor__note { margin: 0; color: #64748b; font-size: .8rem; line-height: 1.6; }
.mall-editor__links { margin-top: -.5rem; }
.mall-editor__form { min-width: 0; }
.mall-editor__row { display: grid; grid-template-columns: 1fr 1fr; gap: .8rem; }
.mall-editor__sku-select { width: 100%; }
.mall-editor__sku-list { display: grid; gap: .45rem; border-top: 1px solid #e2e8f0; padding-top: .8rem; font-size: .84rem; }
.mall-editor__sku-list > p { color: #64748b; }
.mall-editor__sku-row { display: flex; align-items: center; justify-content: space-between; gap: .5rem; padding: .4rem .6rem; border-radius: 8px; background: #f8fafc; }
@media (max-width: 640px) {
  .mall-filters__keyword { width: 100%; }
  .mall-filters__select { width: calc(50% - .3rem); }
  .mall-actions { width: 100%; justify-content: flex-start; }
  .mall-actions__summary { flex-basis: 100%; }
  .mall-surface { padding: .7rem; }
  .mall-pagination { justify-content: center; }
  .mall-editor__row { grid-template-columns: 1fr; gap: 0; }
}
</style>
