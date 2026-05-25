<!--
模块说明：src/App.vue
文件职责：承接全局配置提供器，并在出现全局运行时异常时给出统一兜底视图。
-->
<script setup lang="ts">
import { computed } from 'vue'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import { BaseRouteErrorState } from '@/components/common'
import { clearGlobalAppError, runtimeErrorState } from '@/utils/runtime-error-state'

const globalError = computed(() => runtimeErrorState.globalError.value)

const retryGlobalRender = () => {
  clearGlobalAppError()
  globalThis.window?.location.reload()
}
</script>

<template>
  <el-config-provider :locale="zhCn">
    <div v-if="globalError" class="min-h-screen bg-[var(--ylink-color-bg)] px-4 py-10">
      <div class="mx-auto max-w-2xl">
        <BaseRouteErrorState
          :title="globalError.title"
          :description="globalError.message"
          home-path="/"
          @retry="retryGlobalRender"
        />
      </div>
    </div>
    <RouterView v-else />
  </el-config-provider>
</template>
