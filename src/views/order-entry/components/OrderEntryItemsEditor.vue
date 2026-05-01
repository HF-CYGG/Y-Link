<script setup lang="ts">
/**
 * 模块说明：src/views/order-entry/components/OrderEntryItemsEditor.vue
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */


import { computed } from 'vue'
import type { ProductRecord } from '@/api/modules/product'
import { BizResponsiveDrawerShell } from '@/components/common'
import type { FocusField, OrderEntryDrawerForm, OrderItemRow } from '../types'
import { getProductOptionLabel } from '../types'

type DrawerDirection = 'ltr' | 'rtl' | 'ttb' | 'btt'

/**
 * 明细录入展示组件：
 * - 负责桌面表格、移动卡片与抽屉 UI 的渲染；
 * - 所有业务状态与事件处理均由页面 composable 提供；
 * - 页面入口仅负责装配此组件，不再直接承载大段明细模板。
 */
const props = defineProps<{
  productsLoading: boolean
  itemRows: OrderItemRow[]
  products: ProductRecord[]
  detailModeLabel: string
  isDesktop: boolean
  isPhone: boolean
  cardListClass: string
  deletingRowUids: string[]
  drawerVisible: boolean
  editingRowUid: string
  drawerDirection: DrawerDirection
  drawerSize: string
  drawerForm: OrderEntryDrawerForm
  getRowClassName: (payload: { row: OrderItemRow }) => string
  setFieldRef: (uid: string, field: FocusField, instance: unknown) => void
  handleProductChange: (row: OrderItemRow) => void
  handleGridKeydown: (event: KeyboardEvent, rowIndex: number, field: FocusField) => void
  appendRow: (focusProduct?: boolean) => Promise<void>
  openDrawerForCreate: () => Promise<void>
  openDrawerByRow: (row: OrderItemRow) => void
  removeRow: (uid: string) => void
  applyDrawerEdit: () => void
  handleDrawerProductChange: () => void
  getProductLabelById: (productId: string) => string
  calcLineAmount: (row: OrderItemRow) => number
  toMoney: (value: number) => string
  normalizeNumber: (value: number | string | null | undefined) => number
}>()

const emit = defineEmits<{
  'update:drawerVisible': [value: boolean]
}>()

/**
 * 抽屉显隐代理：
 * - 子组件通过 setter 将关闭动作通知给父层；
 * - 保持抽屉显隐状态仍由页面 composable 统一持有。
 */
const drawerVisibleModel = computed({
  get: () => props.drawerVisible,
  set: (value: boolean) => emit('update:drawerVisible', value),
})

/**
 * 新增明细入口：
 * - 桌面端直接追加并聚焦到产品列；
 * - 非桌面端沿用抽屉创建流程。
 */
const handleAddRow = () => {
  if (props.isDesktop) {
    props.appendRow(true).catch(() => undefined)
    return
  }

  props.openDrawerForCreate().catch(() => undefined)
}

/**
 * 判断是否为已录入商品：
 * - 只要产品 ID 能在产品列表中找到，即说明是已录入商品；
 * - 用于控制单价是否允许在明细目录内更改。
 */
const isExistingProduct = (productId: string | undefined | null) => {
  if (!productId) {
    return false
  }
  return props.products.some(p => p.id === productId)
}
</script>

<template>
  <div class="apple-card p-3 sm:p-4 xl:p-5">
    <div class="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-100 bg-slate-50 px-3 py-2.5 dark:border-white/10 dark:bg-[#1f1f21]">
      <span class="flex items-center gap-2 font-medium text-slate-800 dark:text-slate-100">
        <span class="inline-block h-2 w-2 rounded-full bg-brand" />
        <span>明细录入</span>
        <span class="text-xs font-normal text-slate-500 dark:text-slate-400">（{{ detailModeLabel }}）</span>
      </span>
      <div class="flex flex-wrap items-center gap-2">
        <span class="rounded-full bg-white px-2.5 py-1 text-xs text-slate-500 dark:bg-white/10 dark:text-slate-400">
          共 {{ itemRows.length }} 行
        </span>
        <el-button v-if="!productsLoading" type="primary" plain size="small" @click="handleAddRow">新增明细</el-button>
      </div>
    </div>

    <el-skeleton v-if="productsLoading" animated :rows="6">
      <template #template>
        <div class="space-y-3">
          <el-skeleton-item variant="h3" style="width: 180px" />
          <el-skeleton-item variant="text" />
          <el-skeleton-item variant="text" />
          <el-skeleton-item variant="text" />
          <el-skeleton-item variant="button" style="width: 120px; height: 32px" />
        </div>
      </template>
    </el-skeleton>

    <template v-else>
      <div v-if="!itemRows.length" class="flex justify-center rounded-xl border border-slate-100 bg-slate-50 p-8 dark:border-white/10 dark:bg-[#1b1b1d]">
        <el-empty description="暂无明细，请点击下方按钮开始录入">
          <el-button type="primary" @click="handleAddRow">新增明细</el-button>
        </el-empty>
      </div>

      <div v-else-if="isDesktop" class="space-y-3">
        <el-table :data="itemRows" border :row-class-name="getRowClassName" class="order-grid-table w-full">
          <el-table-column type="index" label="#" width="56" align="center" />
          <el-table-column label="产品（支持拼音首字母）" min-width="300">
            <template #default="{ row, $index }">
              <el-select
                :ref="(el: unknown) => setFieldRef(row.uid, 'product', el)"
                v-model="row.productId"
                filterable
                allow-create
                default-first-option
                :reserve-keyword="false"
                clearable
                placeholder="输入产品名/拼音首字母检索"
                class="w-full"
                @change="handleProductChange(row)"
                @keydown="handleGridKeydown($event, $index, 'product')"
              >
                <el-option
                  v-for="product in products"
                  :key="product.id"
                  :label="getProductOptionLabel(product)"
                  :value="product.id"
                />
              </el-select>
            </template>
          </el-table-column>
          <el-table-column label="数量" width="150">
            <template #default="{ row, $index }">
              <el-input-number
                :ref="(el: unknown) => setFieldRef(row.uid, 'qty', el)"
                v-model="row.qty"
                :min="0"
                :precision="2"
                :step="1"
                class="w-full"
                @keydown="handleGridKeydown($event, $index, 'qty')"
              />
            </template>
          </el-table-column>
          <el-table-column label="单价" width="150">
            <template #default="{ row, $index }">
              <el-input-number
                :ref="(el: unknown) => setFieldRef(row.uid, 'unitPrice', el)"
                v-model="row.unitPrice"
                :min="0"
                :precision="2"
                :step="1"
                class="w-full"
                :disabled="isExistingProduct(row.productId)"
                @keydown="handleGridKeydown($event, $index, 'unitPrice')"
              />
            </template>
          </el-table-column>
          <el-table-column label="行金额" width="130" align="right">
            <template #default="{ row }">
              <span class="font-medium text-red-500">¥{{ toMoney(calcLineAmount(row)) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="备注" min-width="180">
            <template #default="{ row, $index }">
              <el-input
                :ref="(el: unknown) => setFieldRef(row.uid, 'remark', el)"
                v-model="row.remark"
                maxlength="255"
                placeholder="选填"
                @keydown="handleGridKeydown($event, $index, 'remark')"
              />
            </template>
          </el-table-column>
          <el-table-column label="操作" width="80" fixed="right" align="center">
            <template #default="{ row }">
              <el-button type="danger" link @click="removeRow(row.uid)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <div v-else class="space-y-3">
        <transition-group name="row-fade" tag="div" :class="['grid gap-3', cardListClass]">
          <div
            v-for="(row, index) in itemRows"
            :key="row.uid"
            class="rounded-xl border border-slate-100 bg-slate-50 p-4 shadow-sm transition-all duration-200 dark:border-white/10 dark:bg-[#1b1b1d]"
            :class="{ 'translate-x-2 opacity-0': deletingRowUids.includes(row.uid) }"
          >
            <div class="mb-2 flex items-start justify-between gap-3 text-sm">
              <div class="min-w-0 font-medium text-slate-800 dark:text-slate-100">
                <span class="mr-1 text-slate-400 dark:text-slate-500">{{ index + 1 }}.</span>
                <span class="break-words">{{ getProductLabelById(row.productId) }}</span>
              </div>
              <div class="font-medium text-red-500">¥{{ toMoney(calcLineAmount(row)) }}</div>
            </div>
            <div class="flex flex-wrap justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
              <div>数量：{{ toMoney(normalizeNumber(row.qty)) }}</div>
              <div>单价：¥{{ toMoney(normalizeNumber(row.unitPrice)) }}</div>
            </div>
            <div v-if="row.remark" class="mt-2 rounded-lg bg-white/70 px-2.5 py-2 text-xs text-slate-500 dark:bg-white/5 dark:text-slate-400">
              备注：{{ row.remark }}
            </div>
            <div class="mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 pt-3 dark:border-white/10">
              <el-button size="small" @click="openDrawerByRow(row)">编辑</el-button>
              <el-button size="small" type="danger" plain @click="removeRow(row.uid)">删除</el-button>
            </div>
          </div>
        </transition-group>
      </div>

      <!-- 移动端明细编辑统一切到共享抽屉壳：
       - 方向、尺寸继续复用父层传入值，避免改变现有手机/平板交互口径；
       - 将底部操作区并入正文尾部，统一由共享壳承接滚动与高度模式。
      -->
      <BizResponsiveDrawerShell
        v-if="!isDesktop"
        v-model="drawerVisibleModel"
        :title="editingRowUid ? '编辑明细' : '新增明细'"
        height-mode="scroll"
        :phone-size="drawerSize"
        :tablet-size="drawerSize"
        :desktop-size="drawerSize"
        :phone-direction="drawerDirection"
        :default-direction="drawerDirection"
        body-class="pr-2"
      >
        <el-form :label-width="isPhone ? '72px' : '80px'">
          <el-form-item label="产品">
            <el-select
              v-model="drawerForm.productId"
              filterable
              allow-create
              default-first-option
              :reserve-keyword="false"
              clearable
              class="w-full"
              placeholder="输入产品名/拼音首字母检索"
              @change="handleDrawerProductChange"
            >
              <el-option
                v-for="product in products"
                :key="product.id"
                :label="getProductOptionLabel(product)"
                :value="product.id"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="数量">
            <el-input-number v-model="drawerForm.qty" :min="0" :precision="2" class="w-full" />
          </el-form-item>
          <el-form-item label="单价">
            <el-input-number v-model="drawerForm.unitPrice" :min="0" :precision="2" class="w-full" :disabled="isExistingProduct(drawerForm.productId)" />
          </el-form-item>
          <el-form-item label="备注">
            <el-input v-model="drawerForm.remark" maxlength="255" placeholder="选填" />
          </el-form-item>
        </el-form>
        <div class="mt-4 flex justify-end gap-2 border-t border-slate-200 pt-4 dark:border-white/10">
          <el-button @click="drawerVisibleModel = false">取消</el-button>
          <el-button type="primary" @click="applyDrawerEdit">应用</el-button>
        </div>
      </BizResponsiveDrawerShell>
    </template>
  </div>
</template>

<style scoped>
.order-grid-table :deep(.order-row-deleting) {
  opacity: 0;
  transform: translateX(10px);
  transition:
    opacity var(--motion-duration-fast) var(--ylink-motion-ease),
    transform var(--motion-duration-fast) var(--ylink-motion-ease);
}

.row-fade-enter-active,
.row-fade-leave-active {
  transition:
    opacity var(--motion-duration-fast) var(--ylink-motion-ease),
    transform var(--motion-duration-fast) var(--ylink-motion-ease);
}

.row-fade-enter-from,
.row-fade-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
