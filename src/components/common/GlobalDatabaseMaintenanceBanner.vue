<!--
/**
 * 模块说明：src/components/common/GlobalDatabaseMaintenanceBanner.vue
 * 文件职责：在管理端、客户端、供应方与登录页上方统一展示数据库只读维护提示。
 * 实现逻辑：
 * - 直接消费全局数据库维护 Store，确保所有路由入口使用同一维护状态；
 * - 采用固定定位与高层级覆盖不同页面壳层，后端重启断线时仍保持可见；
 * - 横幅不提供手动关闭入口，只有健康检查明确确认维护结束后自动消失。
 * 维护说明：
 * - 固定提示文案属于前后端统一业务口径，不应在页面局部覆写；
 * - 若后续增加维护详情，只能补充非敏感阶段信息，不能暴露任务 ID、路径或连接配置。
 */
-->
<script setup lang="ts">
import {
  DATABASE_MAINTENANCE_READ_ONLY_MESSAGE,
  useDatabaseMaintenanceStore,
} from '@/store/modules/database-maintenance'

const maintenanceStore = useDatabaseMaintenanceStore()
</script>

<template>
  <div
    v-if="maintenanceStore.isReadOnly"
    class="global-database-maintenance-banner"
    role="status"
    aria-live="assertive"
  >
    <el-alert
      :title="DATABASE_MAINTENANCE_READ_ONLY_MESSAGE"
      type="warning"
      effect="dark"
      :closable="false"
      show-icon
      center
    />
  </div>
</template>

<style scoped>
.global-database-maintenance-banner {
  position: fixed;
  inset: 0.5rem 0.75rem auto;
  z-index: 5000;
}
</style>
