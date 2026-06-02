<script setup lang="ts">
/**
 * 模块说明：src/views/base-data/ProductManageView.vue
 * 文件职责：作为基础资料中的产品管理页壳层，负责装配页面标题与产品维护主体组件。
 * 实现逻辑：
 * - 路由级页面只负责提供统一页面容器，把产品查询、批量编辑和上下架等重业务交互留在 `ProductManager`；
 * - 这样既能保持页面入口稳定，也方便后续继续拆分产品维护内部能力。
 * 维护说明：
 * - 若产品管理页后续增加说明栏、筛选摘要或权限提示，优先在当前壳层扩展页面结构；
 * - 具体的产品治理规则仍应集中维护在 `ProductManager` 与其辅助文件中，避免职责混杂。
 */


import { PageContainer } from '@/components/common'
import ProductManager from './components/ProductManager.vue'
</script>

<template>
  <PageContainer title="产品管理">
    <ProductManager />
  </PageContainer>
</template>
