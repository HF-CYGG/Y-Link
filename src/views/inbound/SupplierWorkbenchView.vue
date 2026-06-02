<!--
  文件用途：承载供货方共享工作台页面，统一收口送货录入与历史单据两个常用入口。
  核心职责：通过标签工作台外壳完成路由兼容、标签切换、页面组件装配以及统一页头文案输出。
  设计原因：把原本分散的供货入口折叠到同一工作台中，减少路由跳转割裂感，也避免子页面重复维护相似的壳层结构。
  页面边界：当前文件只负责工作台级导航与容器编排，具体送货录入和历史明细逻辑分别留在对应子页面内部实现。
-->
<script setup lang="ts">
import { TabbedWorkbenchPage } from '@/components/common'
import { useRouteBoundWorkbenchTab } from '@/composables/useRouteBoundWorkbenchTab'
import SupplierDeliveryView from '@/views/inbound/SupplierDeliveryView.vue'
import SupplierHistoryView from '@/views/inbound/SupplierHistoryView.vue'

type SupplierWorkbenchTab = 'delivery' | 'history'

// 定义供货工作台标签，标签键同时承担路由映射键和组件映射键的职责。
const tabs = [
  { label: '送货单录入', name: 'delivery' },
  { label: '历史单据', name: 'history' },
] as const

// 供货方工作台统一接管“录入”和“历史”两个旧页面入口，
// 通过共享组合式函数自动完成“路由 -> 标签 -> 组件”的双向绑定。
// 关键流程：
// 1. routeNameToTab 把旧入口路由识别为工作台标签。
// 2. tabToPath 让标签切换后仍然落到原有业务路由。
// 3. tabToComponent 让统一工作台壳层按标签渲染不同业务内容。
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
  <!-- 共享工作台组件负责输出统一页头与标签栏，并渲染当前选中的业务页面。 -->
  <TabbedWorkbenchPage
    title="供货工作台"
    :tabs="tabs"
    :active-tab="activeTab"
    :active-component="activeComponent"
    component-cache-key-prefix="supplier-workbench"
    card-class="supplier-workbench-page"
    content-class="supplier-workbench-page__content"
    @tab-change="handleTabChange"
  />
</template>
