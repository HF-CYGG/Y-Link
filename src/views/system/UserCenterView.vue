<!--
  文件说明：
  该文件用于承载用户中心共享工作台页面。
  页面把“管理端用户”和“客户端用户”两个治理入口收口到同一个工作台中，
  通过共享标签切换逻辑实现路由兼容、标签同步和动态组件切换。
-->
<script setup lang="ts">
import { TabbedWorkbenchPage } from '@/components/common'
import { useRouteBoundWorkbenchTab } from '@/composables/useRouteBoundWorkbenchTab'
import UserManageView from '@/views/system/UserManageView.vue'
import ClientUserManageView from '@/views/system/ClientUserManageView.vue'

type UserCenterTab = 'management' | 'client'

// 定义用户中心的标签结构，标签值会同时用于路由映射和组件选择。
const tabs = [
  { label: '管理端用户', name: 'management' },
  { label: '客户端用户', name: 'client' },
] as const

// 用户中心统一收口“管理端用户”和“客户端用户”两套治理页面，
// 通过共享组合式函数完成标签切换和路由兼容，减少页面级重复定义。
// 关键流程：
// 1. 先根据当前路由名确定默认高亮的标签。
// 2. 再根据标签决定渲染管理端还是客户端用户页面。
// 3. 用户点击标签时，统一跳转到该标签绑定的目标路由。
const { activeTab, activeComponent, handleTabChange } = useRouteBoundWorkbenchTab<UserCenterTab>({
  fallbackTab: 'management',
  routeNameToTab: {
    'system-users': 'management',
    'system-client-users': 'client',
  },
  tabToPath: {
    management: '/system/users',
    client: '/system/client-users',
  },
  tabToComponent: {
    management: UserManageView,
    client: ClientUserManageView,
  },
})
</script>

<template>
  <!-- 公共工作台页面负责承接标签切换，并把当前业务页面作为动态内容区域渲染。 -->
  <TabbedWorkbenchPage
    title="用户中心"
    description="统一治理管理端与客户端账号，减少切换成本并复用相同的账号运营动作。"
    :tabs="tabs"
    :active-tab="activeTab"
    :active-component="activeComponent"
    @tab-change="handleTabChange"
  />
</template>
