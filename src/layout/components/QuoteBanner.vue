<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RefreshRight } from '@element-plus/icons-vue'

/**
 * 公开语录接口返回结构：
 * - 仅提取当前页面展示所需字段；
 * - 失败时统一回退到本地语录池。
 */
interface HitokotoResponse {
  hitokoto?: string
  from?: string
  from_who?: string | null
}

const quoteLoading = ref(false)
const quoteText = ref('保持热爱，奔赴山海。')
const quoteFrom = ref('佚名')

/**
 * 本地兜底语录池：
 * - 当外部接口不可用时保障顶栏内容始终完整；
 * - 通过随机挑选降低重复感。
 */
const fallbackQuotes = [
  { text: '知不足而奋进，望远山而前行。', from: '中国古训' },
  { text: '你现在的努力，是未来从容生活的底气。', from: '成长箴言' },
  { text: '真正的自由，是在认清现实后依然热爱生活。', from: '哲思短句' },
  { text: '慢一点没关系，只要始终在向前。', from: '每日一语' },
]

const applyFallbackQuote = () => {
  const picked = fallbackQuotes[Math.floor(Math.random() * fallbackQuotes.length)]
  quoteText.value = picked.text
  quoteFrom.value = picked.from
}

/**
 * 刷新语录：
 * - 优先请求 HTTPS 公共接口；
 * - 任一异常均进入本地兜底逻辑，避免头部空白。
 */
const loadQuote = async () => {
  quoteLoading.value = true
  try {
    const response = await fetch('https://v1.hitokoto.cn/?c=i&c=k&c=d', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })

    if (!response.ok) {
      throw new Error(`请求失败: ${response.status}`)
    }

    const data = (await response.json()) as HitokotoResponse
    if (!data.hitokoto) {
      throw new Error('返回内容为空')
    }

    quoteText.value = data.hitokoto
    quoteFrom.value = data.from_who || data.from || '网络语录'
  } catch {
    applyFallbackQuote()
  } finally {
    quoteLoading.value = false
  }
}

onMounted(() => {
  void loadQuote()
})
</script>

<template>
  <div class="min-w-0 flex flex-1 items-center gap-2 overflow-hidden whitespace-nowrap text-sm">
    <span class="shrink-0 rounded-md bg-brand/10 px-2 py-1 text-xs font-medium text-brand dark:bg-teal-500/20 dark:text-teal-300">
      每日一语
    </span>
    <p class="min-w-0 truncate text-slate-700 dark:text-slate-200">
      {{ quoteText }}
    </p>
    <span class="shrink-0 text-xs text-slate-500 dark:text-slate-400">
      —— {{ quoteFrom }}
    </span>
    <el-button
      link
      :disabled="quoteLoading"
      class="shrink-0"
      aria-label="刷新语录"
      @click="loadQuote"
    >
      <el-icon :class="{ 'animate-spin': quoteLoading }">
        <RefreshRight />
      </el-icon>
    </el-button>
  </div>
</template>
