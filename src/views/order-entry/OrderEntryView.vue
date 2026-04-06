<script setup lang="ts">
import { computed } from 'vue'
import { PageContainer } from '@/components/common'
import OrderEntryHeaderCard from './components/OrderEntryHeaderCard.vue'
import OrderEntryItemsEditor from './components/OrderEntryItemsEditor.vue'
import OrderEntrySummaryCard from './components/OrderEntrySummaryCard.vue'
import { useOrderEntryForm } from './composables/useOrderEntryForm'

/**
 * 页面入口仅负责装配：
 * - 通过 composable 汇总订单录入页的所有业务状态与事件；
 * - 将主单、明细、汇总分别交给展示组件；
 * - 保持原有功能、样式与多端交互不变。
 */
const {
  headerForm,
  itemRows,
  products,
  productsLoading,
  isSaving,
  deletingRowUids,
  drawerVisible,
  editingRowUid,
  drawerForm,
  isPhone,
  isDesktop,
  cardListClass,
  drawerDirection,
  drawerSize,
  detailModeLabel,
  totalQty,
  totalAmount,
  appendRow,
  handleProductChange,
  getProductLabelById,
  calcLineAmount,
  toMoney,
  normalizeNumber,
  removeRow,
  getRowClassName,
  openDrawerByRow,
  openDrawerForCreate,
  applyDrawerEdit,
  handleDrawerProductChange,
  setFieldRef,
  handleGridKeydown,
  submitOrder,
} = useOrderEntryForm()

/**
 * 汇总文案：
 * - 在页面入口完成最终格式化，便于汇总组件保持纯展示；
 * - 让模板只做装配，不再重复出现格式转换细节。
 */
const totalQtyText = computed(() => toMoney(totalQty.value))
const totalAmountText = computed(() => toMoney(totalAmount.value))
</script>

<template>
  <PageContainer
    title="出库开单"
    description="支持桌面端键盘流录入，并针对平板与手机提供卡片 + 抽屉式编辑体验。"
  >
    <div class="space-y-4">
      <OrderEntryHeaderCard :model="headerForm" :is-phone="isPhone" />

      <OrderEntryItemsEditor
        v-model:drawer-visible="drawerVisible"
        :products-loading="productsLoading"
        :item-rows="itemRows"
        :products="products"
        :detail-mode-label="detailModeLabel"
        :is-desktop="isDesktop"
        :is-phone="isPhone"
        :card-list-class="cardListClass"
        :deleting-row-uids="deletingRowUids"
        :editing-row-uid="editingRowUid"
        :drawer-direction="drawerDirection"
        :drawer-size="drawerSize"
        :drawer-form="drawerForm"
        :get-row-class-name="getRowClassName"
        :set-field-ref="setFieldRef"
        :handle-product-change="handleProductChange"
        :handle-grid-keydown="handleGridKeydown"
        :append-row="appendRow"
        :open-drawer-for-create="openDrawerForCreate"
        :open-drawer-by-row="openDrawerByRow"
        :remove-row="removeRow"
        :apply-drawer-edit="applyDrawerEdit"
        :handle-drawer-product-change="handleDrawerProductChange"
        :get-product-label-by-id="getProductLabelById"
        :calc-line-amount="calcLineAmount"
        :to-money="toMoney"
        :normalize-number="normalizeNumber"
      />

      <OrderEntrySummaryCard
        :row-count="itemRows.length"
        :total-qty-text="totalQtyText"
        :total-amount-text="totalAmountText"
        :is-phone="isPhone"
        :is-saving="isSaving"
        :products-loading="productsLoading"
        @submit="submitOrder"
      />
    </div>
  </PageContainer>
</template>
