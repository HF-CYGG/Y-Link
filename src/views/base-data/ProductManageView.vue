<script setup lang="ts">
/**
 * 模块说明：src/views/base-data/ProductManageView.vue
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */


import { PageContainer } from '@/components/common'
import ProductManager from './components/ProductManager.vue'
</script>

<template>
  <PageContainer title="产品管理">
    <ProductManager />
  </PageContainer>
</template>
