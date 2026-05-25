<script setup lang="ts">
import { useRouter } from 'vue-router'
import BaseRequestState from './BaseRequestState.vue'

interface Props {
  title?: string
  description?: string
  homePath: string
}

const props = withDefaults(defineProps<Props>(), {
  title: '页面加载失败',
  description: '请稍后重试，或返回上一页继续操作',
})

const emit = defineEmits<{
  retry: []
}>()

const router = useRouter()

const goBack = () => {
  router.back()
}

const goHome = async () => {
  await router.replace(props.homePath).catch(() => undefined)
}
</script>

<template>
  <div class="grid gap-4">
    <BaseRequestState
      type="error"
      :title="props.title"
      :description="props.description"
      action-text="重试"
      @retry="emit('retry')"
    />
    <div class="flex flex-wrap justify-center gap-3">
      <button
        type="button"
        class="inline-flex h-10 items-center justify-center rounded-full border border-slate-200 bg-white px-4 text-sm text-slate-700 transition hover:border-slate-300 hover:text-slate-900"
        @click="goBack"
      >
        返回上一页
      </button>
      <button
        type="button"
        class="inline-flex h-10 items-center justify-center rounded-full border border-teal-600 bg-teal-600 px-4 text-sm text-white transition hover:bg-teal-700"
        @click="goHome"
      >
        回到首页
      </button>
    </div>
  </div>
</template>
