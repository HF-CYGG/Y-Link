<!--
模块说明：src/App.vue
文件职责：作为根组件承接全局配置提供器，并把最终页面渲染权交给路由层。
实现逻辑：
1. 通过 `el-config-provider` 统一向全站 Element Plus 组件提供中文 locale；
2. 保持根组件只承载最薄的一层平台职责，避免业务布局耦合到入口。
-->
<script setup lang="ts">
import zhCn from 'element-plus/es/locale/lang/zh-cn'
</script>

<template>
  <!-- 根组件仅负责承载全局配置与路由出口，业务布局由 layout 层统一接管。 -->
  <el-config-provider :locale="zhCn">
    <RouterView />
  </el-config-provider>
</template>
