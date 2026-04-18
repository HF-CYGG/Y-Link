<!--
  文件说明：
  该文件用于承载产品中心共享工作台页面。
  页面通过统一标签工作台外壳，在“基础信息”和“线上展示”两个产品视角之间切换，
  并复用共享的路由绑定组合式逻辑，兼容旧入口访问。
-->
<script setup lang="ts">
import { TabbedWorkbenchPage } from '@/components/common'
import { useRouteBoundWorkbenchTab } from '@/composables/useRouteBoundWorkbenchTab'
import ProductManager from '@/views/base-data/components/ProductManager.vue'
import O2oProductMallManageView from '@/views/o2o/O2oProductMallManageView.vue'

type ProductCenterTab = 'basic' | 'o2o'

// 定义工作台顶部标签，名称需要与下方映射配置中的标签键保持一致。
const tabs = [
  { label: '基础信息', name: 'basic' },
  { label: '线上展示', name: 'o2o' },
] as const

// 产品中心统一承载“基础资料”和“线上展示”两种视角。
// 旧路由仍然可访问，但会被映射到同一个共享工作台壳层。
// 关键流程：
// 1. routeNameToTab 负责把历史路由入口折叠为当前工作台标签。
// 2. tabToPath 负责在用户点击标签后跳回对应业务路由。
// 3. tabToComponent 负责决定当前标签下实际渲染哪个页面组件。
const { activeTab, activeComponent, handleTabChange } = useRouteBoundWorkbenchTab<ProductCenterTab>({
  fallbackTab: 'basic',
  routeNameToTab: {
    products: 'basic',
    'o2o-console-products': 'o2o',
  },
  tabToPath: {
    basic: '/base-data/products',
    o2o: '/o2o-console/products',
  },
  tabToComponent: {
    basic: ProductManager,
    o2o: O2oProductMallManageView,
  },
})
</script>

<template>
  <!-- 统一工作台外壳负责展示标题、说明、标签栏和当前激活的业务组件。 -->
  <TabbedWorkbenchPage
    title="产品中心"
    description="统一管理产品基础资料、库存信息与线上展示配置，减少多页来回切换。"
    :tabs="tabs"
    :active-tab="activeTab"
    :active-component="activeComponent"
    @tab-change="handleTabChange"
  />
</template>
