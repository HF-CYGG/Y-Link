<!--
  模块说明：F:/Y-Link/src/views/base-data/TagManageView.vue
  文件职责：标签管理页面。
  实现逻辑：管理标签列表、创建编辑与删除操作。
  维护说明：标签规则变更需同步商品页筛选交互。
-->

<script setup lang="ts">
import { PageContainer } from '@/components/common'
import TagManager from './components/TagManager.vue'
</script>

<template>
  <PageContainer title="标签管理">
    <TagManager />
  </PageContainer>
</template>
