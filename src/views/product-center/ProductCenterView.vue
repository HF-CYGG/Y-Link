<script setup lang="ts">
import { TabbedWorkbenchPage } from '@/components/common'
import { useRouteBoundWorkbenchTab } from '@/composables/useRouteBoundWorkbenchTab'
import ProductManager from '@/views/base-data/components/ProductManager.vue'
import O2oProductMallManageView from '@/views/o2o/O2oProductMallManageView.vue'

type ProductCenterTab = 'basic' | 'o2o'

const tabs = [
  { label: '基础信息', name: 'basic' },
  { label: '线上展示', name: 'o2o' },
] as const

// 产品中心统一承载“基础资料”和“线上展示”两种视角。
// 旧路由仍然可访问，但会被映射到同一个共享工作台壳层。
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
  <TabbedWorkbenchPage
    title="产品中心"
    description="统一管理产品基础资料、库存信息与线上展示配置，减少多页来回切换。"
    :tabs="tabs"
    :active-tab="activeTab"
    :active-component="activeComponent"
    @tab-change="handleTabChange"
  />
</template>
