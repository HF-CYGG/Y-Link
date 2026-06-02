<script setup lang="ts">
/**
 * 模块说明：src/components/common/base-display/BaseRequestState.vue
 * 文件职责：提供通用请求状态展示组件，统一承接空数据、错误态和离线态等请求结果反馈界面。
 * 实现逻辑：
 * - 通过有限的状态类型枚举统一映射标题、描述和操作按钮，避免页面重复拼装状态区；
 * - 支持卡片模式与普通模式两种外观，便于在详情页、列表页和弹窗内复用；
 * - 把重试等交互继续通过事件向外抛出，业务页仍掌握真实请求时机。
 */


interface Props {
  type?: 'empty' | 'error' | 'offline'
  title?: string
  description?: string
  actionText?: string
  card?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  type: 'empty',
  title: '暂无数据',
  description: '请稍后再试',
  actionText: '重新加载',
  card: true,
})

const emit = defineEmits<{
  retry: []
}>()

const iconMap: Record<NonNullable<Props['type']>, string> = {
  empty: '📦',
  error: '⚠️',
  offline: '📡',
}
</script>

<template>
  <section
    :class="[
      'ylink-request-state rounded-[1.4rem] px-5 py-10 text-center',
      props.card ? 'bg-white shadow-[var(--ylink-shadow-soft)]' : '',
    ]"
  >
    <p class="text-4xl">{{ iconMap[props.type] }}</p>
    <p class="mt-3 text-base font-semibold text-slate-900">{{ props.title }}</p>
    <p class="mt-1 text-sm text-slate-500">{{ props.description }}</p>
    <button
      type="button"
      class="mt-5 inline-flex h-10 items-center justify-center rounded-full border border-slate-200 bg-slate-50 px-4 text-sm text-slate-700 transition hover:border-teal-300 hover:text-teal-700"
      @click="emit('retry')"
    >
      {{ props.actionText }}
    </button>
  </section>
</template>
