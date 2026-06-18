<script setup lang="ts">
/**
 * 模块说明：src/views/inbound/SupplierWorkbenchView.vue
 * 文件职责：承载供货方共享工作台页面，统一收口送货单录入与历史单据两个常用入口。
 * 实现逻辑：
 * - 页面通过 TabbedWorkbenchPage 输出统一页头、标签栏和内容容器，减少供货端页面来回跳转的割裂感；
 * - 通过 useRouteBoundWorkbenchTab 维持旧路由与新标签的双向绑定，保证直接访问旧入口仍能进入对应子页；
 * - 录入页和历史页保持各自业务状态，由工作台壳层负责 keep-alive 和切换动画。
 * 维护说明：
 * - 新增供货端子页面时优先扩展 tabs、routeNameToTab、tabToPath 和 tabToComponent，不要另建重复工作台壳层；
 * - 当前文件只负责导航与容器编排，具体送货单业务逻辑应继续留在对应子页面内部实现。
 */
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
