<!--
  文件用途：承载系统用户中心共享工作台页面，统一组织管理端用户与客户端用户两类治理入口。
  核心职责：负责标签路由同步、异步子页装配、工作台外壳承载以及用户治理入口的统一编排。
  设计原因：把两套低频治理页面收口到同一工作台中，并通过异步组件延后加载重表格与表单能力，降低壳层页面首包开销。
  页面边界：当前文件聚焦用户中心壳层与标签切换，不直接处理具体用户列表查询、编辑弹窗和权限表单细节。
-->
<script setup lang="ts">
import { defineAsyncComponent } from 'vue'
import { TabbedWorkbenchPage } from '@/components/common'
import { useRouteBoundWorkbenchTab } from '@/composables/useRouteBoundWorkbenchTab'
import { userCenterTabLoaders } from '@/views/system/user-center-performance'

type UserCenterTab = 'management' | 'client'

const UserManageView = defineAsyncComponent(userCenterTabLoaders.management)
const ClientUserManageView = defineAsyncComponent(userCenterTabLoaders.client)

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
