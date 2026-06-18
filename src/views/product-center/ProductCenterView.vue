<!--
  文件用途：承载产品中心共享工作台页面，统一组织“基础信息”和“线上展示”两个产品治理视角。
  核心职责：负责标签工作台外壳、路由到标签的映射、异步子页面装配以及统一页面入口编排。
  设计原因：将两个相对重量级的产品治理子页收口到同一工作台中，并通过异步组件拆分降低主壳层首包体积。
  页面边界：当前文件只管理产品中心层级的导航和承载，不直接实现标签维护、商品编辑、图片上传等具体业务细节。
-->
<script setup lang="ts">
import { defineAsyncComponent } from 'vue'
import { TabbedWorkbenchPage } from '@/components/common'
import { useRouteBoundWorkbenchTab } from '@/composables/useRouteBoundWorkbenchTab'
import {
  productCenterTabLoaders,
  type ProductCenterTabKey,
} from '@/views/product-center/product-center-performance'

type ProductCenterTab = ProductCenterTabKey

// 定义工作台顶部标签，名称需要与下方映射配置中的标签键保持一致。
const tabs = [
  { label: '基础信息', name: 'basic' },
  { label: '线上展示', name: 'o2o' },
] as const

// 产品中心的两个业务子页都较重：
// - 基础信息侧承载标签、批量维护与明细编辑；
// - 线上展示侧承载图片压缩、上传与商城配置。
// 这里改为页内异步组件，避免 ProductCenterView 主壳层一次性把两套实现都打进同一分包。
const ProductManager = defineAsyncComponent(productCenterTabLoaders.basic)
const O2oProductMallManageView = defineAsyncComponent(productCenterTabLoaders.o2o)

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
    compact-on-phone
    @tab-change="handleTabChange"
  />
</template>
