<script setup lang="ts">
/**
 * 模块说明：src/views/base-data/TagCenterView.vue
 * 文件职责：承载“标签管理”共享工作台，统一组织“商品标签”和“分类与库位”两个基础资料治理视角。
 * 实现逻辑：
 * - 复用 `TabbedWorkbenchPage` 与 `useRouteBoundWorkbenchTab`，与产品中心、用户中心保持同一套标签工作台交互；
 * - `/base-data/tags` 与 `/base-data/master-data` 两条路由共享 `viewKey: 'tag-center'`，切换标签只替换内容区，不重建壳层；
 * - “商品标签”与旧标签管理页一样随壳层同步加载；“分类与库位”为低频页，异步拆包，壳层挂载后在浏览器空闲时预取，
 *   切换标签时通常无需等待；预取放在壳层而非路由预热表，是为了不增加首屏路由包体积；
 * - 标签按路由权限过滤：缺少 `tags:view` 或 `products:view` 时不展示对应标签，避免点击后被路由守卫拦截。
 * 维护说明：
 * - “分类与库位”原位于库存管理菜单，旧地址 `/inventory/master-data` 由路由表重定向到本工作台，不要删除该兼容入口；
 * - 新增标签时同步补充路由表中的共享 `viewKey`、`route-performance.ts` 的预热项与本文件的映射关系。
 */
import { computed, defineAsyncComponent, onMounted } from 'vue'
import type { PermissionCode } from '@/api/modules/auth'
import { TabbedWorkbenchPage } from '@/components/common'
import { useRouteBoundWorkbenchTab } from '@/composables/useRouteBoundWorkbenchTab'
import { useAuthStore } from '@/store'
import pinia from '@/store/pinia'
import TagManager from './components/TagManager.vue'

const authStore = useAuthStore(pinia)

type TagCenterTabKey = 'tags' | 'masterData'

const loadInventoryMasterDataView = () => import('@/views/inventory/InventoryMasterDataView.vue')
const InventoryMasterDataView = defineAsyncComponent(loadInventoryMasterDataView)

// 标签定义与访问所需权限需和路由表 `requiredPermissions` 保持一致。
const tabDefinitions: ReadonlyArray<{ label: string; name: TagCenterTabKey; permission: PermissionCode }> = [
  { label: '商品标签', name: 'tags', permission: 'tags:view' },
  { label: '分类与库位', name: 'masterData', permission: 'products:view' },
]

/**
 * 空闲预取“分类与库位”子包：
 * - 仅在有权限查看该标签时预取，避免为无权账号下载用不到的代码；
 * - 优先 requestIdleCallback，缺失时退回短延时，失败静默（真正切换时 defineAsyncComponent 会重新请求并给出错误反馈）。
 */
onMounted(() => {
  if (!authStore.hasPermission('products:view')) {
    return
  }
  const prefetch = () => {
    void loadInventoryMasterDataView().catch(() => undefined)
  }
  if (typeof globalThis.window.requestIdleCallback === 'function') {
    globalThis.window.requestIdleCallback(prefetch, { timeout: 2000 })
  } else {
    globalThis.window.setTimeout(prefetch, 600)
  }
})

const tabs = computed(() => {
  return tabDefinitions
    .filter((tab) => authStore.hasPermission(tab.permission))
    .map(({ label, name }) => ({ label, name }))
})

// 关键流程：
// 1. routeNameToTab 把两条业务路由折叠为当前工作台标签；
// 2. tabToPath 负责在用户点击标签后跳回对应业务路由；
// 3. tabToComponent 决定当前标签下实际渲染的业务组件。
const { activeTab, activeComponent, handleTabChange } = useRouteBoundWorkbenchTab<TagCenterTabKey>({
  fallbackTab: 'tags',
  routeNameToTab: {
    tags: 'tags',
    'base-data-master-data': 'masterData',
  },
  tabToPath: {
    tags: '/base-data/tags',
    masterData: '/base-data/master-data',
  },
  tabToComponent: {
    tags: TagManager,
    masterData: InventoryMasterDataView,
  },
})
</script>

<template>
  <TabbedWorkbenchPage
    title="标签管理"
    description="商品标签维护标签名称、颜色与文创系列编码；分类与库位维护 WC 编码所用的商品分类和实物存放库位。"
    :tabs="tabs"
    :active-tab="activeTab"
    :active-component="activeComponent"
    compact-on-phone
    @tab-change="handleTabChange"
  />
</template>
