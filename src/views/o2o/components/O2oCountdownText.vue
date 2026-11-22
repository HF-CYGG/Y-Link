<script lang="ts">
/**
 * 模块说明：订单池待提货倒计时。
 * 文件职责：局部渲染剩余时长，所有可见倒计时共享一个秒钟。
 * 实现逻辑：待提货且有未来截止时间的实例才订阅；历史数据仍可显示服务端给定的剩余秒数。
 * 维护说明：订单状态由工作台决定，倒计时结束只隐藏本节点。
 */
import { ref } from 'vue'

const clock = ref(Date.now())
let clockUsers = 0
let clockTimer: ReturnType<typeof setInterval> | undefined

const subscribeClock = () => {
  if (clockUsers++ === 0) {
    clock.value = Date.now()
    clockTimer = setInterval(() => { clock.value = Date.now() }, 1000)
  }
  return () => {
    if (--clockUsers === 0) {
      clearInterval(clockTimer)
      clockTimer = undefined
    }
  }
}
</script>

<script setup lang="ts">
import { computed, watchEffect } from 'vue'

const props = defineProps<{
  active: boolean
  timeoutAt: string | null
  expireInSeconds?: number
}>()

const deadline = computed(() => props.timeoutAt ? Date.parse(props.timeoutAt) : 0)
const remaining = computed(() => {
  if (deadline.value > 0) {
    const now = props.active ? clock.value : Date.now()
    return Math.max(0, Math.ceil((deadline.value - now) / 1000))
  }
  return props.timeoutAt ? 0 : Math.floor(props.expireInSeconds ?? 0)
})
const display = computed(() => {
  const seconds = remaining.value
  if (!(seconds > 0) || !Number.isFinite(seconds)) return ''
  return [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60]
    .map((unit) => String(unit).padStart(2, '0'))
    .join(':')
})

// 以是否仍有有效截止时间作为订阅条件，不随每个秒钟拆装订阅。
const clockNeeded = computed(() => props.active && deadline.value > 0 && remaining.value > 0)
watchEffect((onCleanup) => {
  if (clockNeeded.value) onCleanup(subscribeClock())
})
</script>

<template>
  <span
    v-if="display"
    class="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-300"
  >
    剩余 {{ display }}
  </span>
</template>
