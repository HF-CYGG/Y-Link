<!--
  模块说明：F:/Y-Link/src/components/common/base-display/BaseRouteErrorState.vue
  文件职责：路由级异常兜底展示组件。
  实现逻辑：在页面组件加载失败或运行时异常时，统一展示用户可理解的提示与重试入口。
  维护说明：文案应保持业务语境，不要暴露内部错误代码、Prompt 标签或调试信息。
-->

<script setup lang="ts">
/**
 * 模块说明：src/components/common/base-display/BaseRouteErrorState.vue
 * 文件职责：提供管理端/客户端共用的路由异常兜底卡片，统一承接重试与回首页动作。
 * 实现逻辑：
 * - 外层仅传入标题、描述与首页路径，组件内部不感知具体业务模块；
 * - 操作按钮统一使用 Element Plus，保证按钮样式与其他页面一致；
 * - 保持单根节点输出，避免参与路由切换容器时触发根节点透传告警。
 * 维护说明：若后续要扩展更多按钮或插槽，优先继续保持“简短说明 + 明确动作”的结构。
 */

import { ElButton } from 'element-plus'

interface Props {
  title?: string
  description?: string
  homePath?: string
}

const props = withDefaults(defineProps<Props>(), {
  title: '页面暂时无法打开',
  description: '你可以重试当前页面，或先返回首页后再继续操作。',
  homePath: '/dashboard',
})

const emit = defineEmits<{
  retry: []
}>()
</script>

<template>
  <section class="flex min-h-[320px] items-center justify-center">
    <div class="w-full max-w-[620px] rounded-[28px] bg-white px-6 py-8 text-center shadow-[var(--ylink-shadow-soft)]">
      <div class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-amber-50 text-[28px] text-amber-500">
        !
      </div>
      <h2 class="mt-5 text-xl font-semibold text-slate-900">{{ props.title }}</h2>
      <p class="mt-3 text-sm leading-6 text-slate-500">{{ props.description }}</p>
      <div class="mt-6 flex flex-wrap items-center justify-center gap-3">
        <ElButton type="primary" @click="emit('retry')">重新加载</ElButton>
        <ElButton @click="$router.push(props.homePath)">返回首页</ElButton>
      </div>
    </div>
  </section>
</template>
