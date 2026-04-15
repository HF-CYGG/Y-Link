<script setup lang="ts">
import { TabbedWorkbenchPage } from '@/components/common'
import { useRouteBoundWorkbenchTab } from '@/composables/useRouteBoundWorkbenchTab'
import UserManageView from '@/views/system/UserManageView.vue'
import ClientUserManageView from '@/views/system/ClientUserManageView.vue'

type UserCenterTab = 'management' | 'client'

const tabs = [
  { label: '管理端用户', name: 'management' },
  { label: '客户端用户', name: 'client' },
] as const

// 用户中心统一收口“管理端用户”和“客户端用户”两套治理页面，
// 通过共享组合式函数完成标签切换和路由兼容，减少页面级重复定义。
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
  <TabbedWorkbenchPage
    title="用户中心"
    description="统一治理管理端与客户端账号，减少切换成本并复用相同的账号运营动作。"
    :tabs="tabs"
    :active-tab="activeTab"
    :active-component="activeComponent"
    @tab-change="handleTabChange"
  />
</template>
