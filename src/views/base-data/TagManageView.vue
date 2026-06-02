<script setup lang="ts">
/**
 * 模块说明：src/views/base-data/TagManageView.vue
 * 文件职责：作为基础资料中的标签管理页壳层，负责承接页面标题与标签管理主体组件。
 * 实现逻辑：
 * - 页面壳层保持轻量，只做容器装配，把具体的标签查询、编辑和删除流程下沉到 `TagManager`；
 * - 这样可以让路由级页面继续保持稳定，同时把标签治理细节收口在专门组件中演进。
 * 维护说明：
 * - 若后续需要在标签管理页增加说明区或辅助面板，优先继续放在当前壳层装配，不要把路由页逻辑散落到多个文件；
 * - 标签的具体业务规则仍应优先维护在 `TagManager` 内，避免页面壳层承担过多细节。
 */


import { PageContainer } from '@/components/common'
import TagManager from './components/TagManager.vue'
</script>

<template>
  <PageContainer title="标签管理">
    <TagManager />
  </PageContainer>
</template>
