<!--
/**
 * 模块说明：src/App.vue
 * 文件职责：作为根组件承接全局 Element Plus 配置、数据库维护状态轮询与路由页面渲染。
 * 实现逻辑：
 * - 通过 el-config-provider 统一提供中文 locale，业务布局继续由 layout 与页面组件接管；
 * - 根组件挂载时启动可见页单主健康检查，使管理端、客户端、供应方与登录页跨标签共享维护态；
 * - 全局维护横幅独立于路由壳层渲染，后端重启断线期间仍保持只读提示。
 * 维护说明：
 * - 维护检查必须覆盖整个应用生命周期，正常态低频、维护态快速，不能下沉到需要登录或特定权限的页面；
 * - 根组件卸载时要停止定时器，避免开发热更新或测试环境残留重复轮询。
 */
-->
<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import GlobalDatabaseMaintenanceBanner from '@/components/common/GlobalDatabaseMaintenanceBanner.vue'
import { useDatabaseMaintenanceStore } from '@/store/modules/database-maintenance'

const databaseMaintenanceStore = useDatabaseMaintenanceStore()

onMounted(() => {
  databaseMaintenanceStore.startPolling()
})

onBeforeUnmount(() => {
  databaseMaintenanceStore.stopPolling()
})
</script>

<template>
  <el-config-provider :locale="zhCn">
    <GlobalDatabaseMaintenanceBanner />
    <RouterView />
  </el-config-provider>
</template>
