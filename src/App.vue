<!--
模块说明：src/App.vue
文件职责：作为根组件承接全局 Element Plus 配置，并把页面渲染权交给路由层。
实现逻辑：通过 el-config-provider 统一提供中文 locale，业务布局由 layout 与页面组件接管。
-->
<script setup lang="ts">
import zhCn from 'element-plus/es/locale/lang/zh-cn'
</script>

<template>
  <el-config-provider :locale="zhCn">
    <RouterView />
  </el-config-provider>
</template>
