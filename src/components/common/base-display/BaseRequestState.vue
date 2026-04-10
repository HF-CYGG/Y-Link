<script setup lang="ts">
/**
 * 模块说明：src/components/common/base-display/BaseRequestState.vue
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
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
