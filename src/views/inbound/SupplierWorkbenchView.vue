<script setup lang="ts">
import { TabbedWorkbenchPage } from '@/components/common'
import { useRouteBoundWorkbenchTab } from '@/composables/useRouteBoundWorkbenchTab'
import SupplierDeliveryView from '@/views/inbound/SupplierDeliveryView.vue'
import SupplierHistoryView from '@/views/inbound/SupplierHistoryView.vue'

type SupplierWorkbenchTab = 'delivery' | 'history'

const tabs = [
  { label: '送货单录入', name: 'delivery' },
  { label: '历史单据', name: 'history' },
] as const

// 供货方工作台统一接管“录入”和“历史”两个旧页面入口，
// 通过共享组合式函数自动完成“路由 -> 标签 -> 组件”的双向绑定。
const { activeTab, activeComponent, handleTabChange } = useRouteBoundWorkbenchTab<SupplierWorkbenchTab>({
  fallbackTab: 'delivery',
  routeNameToTab: {
    'supplier-delivery': 'delivery',
    'supplier-history': 'history',
  },
  tabToPath: {
    delivery: '/supplier-delivery',
    history: '/supplier-history',
  },
  tabToComponent: {
    delivery: SupplierDeliveryView,
    history: SupplierHistoryView,
  },
})
</script>

<template>
  <TabbedWorkbenchPage
    title="供货工作台"
    description="统一处理送货单录入与历史单据查询，供货方只需记住一个入口。"
    :tabs="tabs"
    :active-tab="activeTab"
    :active-component="activeComponent"
    @tab-change="handleTabChange"
  />
</template>
