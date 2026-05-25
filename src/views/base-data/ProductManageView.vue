<!--
  模块说明：F:/Y-Link/src/views/base-data/ProductManageView.vue
  文件职责：商品管理页面。
  实现逻辑：编排商品列表、筛选、编辑弹窗与标签关联操作。
  维护说明：字段与操作按钮变更需同步权限与 API 参数。
-->

<script setup lang="ts">
import { PageContainer } from '@/components/common'
import ProductManager from './components/ProductManager.vue'
</script>

<template>
  <PageContainer title="产品管理">
    <ProductManager />
  </PageContainer>
</template>
