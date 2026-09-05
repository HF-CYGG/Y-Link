<!--
/**
 * 文件职责：在自动迁移主卡片展示连接测试、阻断原因与处理建议。
 * 实现逻辑：区分连接失败、连接成功但预检未通过和可迁移；保留后端问题码便于排查。
 * 维护说明：只展示脱敏预检结果，不接收连接密码，不触发任务创建或数据库变更。
 */
-->
<script setup lang="ts">
import type { SQLiteToMySqlPrecheckResult } from '@/api/modules/data-maintenance'

defineProps<{
  loading: boolean
  result: SQLiteToMySqlPrecheckResult | null
  error: string
  title: string
  alertType: 'info' | 'success' | 'warning' | 'error'
}>()
</script>

<template>
  <div v-if="loading || result || error" class="mt-4 space-y-3" aria-live="polite" data-testid="migration-connection-result">
    <el-alert :title="title" :type="alertType" :closable="false" show-icon>
      <template #default>
        <p v-if="loading">正在检查连接、数据库版本、基础权限和目标库状态，请稍候。</p>
        <p v-else-if="error">{{ error }}</p>
        <template v-else-if="result">
          <p v-if="result.target.reachable">
            MySQL {{ result.target.version || '版本未知' }} · 目标业务数据 {{ result.target.totalRows }} 行
          </p>
          <p v-if="result.canProceed">本次测试已通过。开始迁移时仍会重新预检，冻结写入后再复核。</p>
          <p v-else>请先处理下方阻断问题，再点击“测试连接”。</p>
        </template>
      </template>
    </el-alert>
    <template v-if="!loading && result">
      <el-alert
        v-for="issue in result.issues"
        :key="issue.code"
        :title="issue.code === 'target_not_empty' ? '目标库已有数据，请改用专用空库后重新测试。' : issue.message"
        :type="issue.level === 'error' ? 'error' : issue.level === 'warning' ? 'warning' : 'info'"
        :description="`问题代码：${issue.code}`"
        :closable="false"
        show-icon
      />
    </template>
  </div>
</template>
