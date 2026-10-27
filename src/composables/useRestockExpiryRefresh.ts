/** 在服务端截止时间唤醒一次权威查询；不在客户端把业务状态改成 expired，也不失败循环重试。 */
import { onActivated, onBeforeUnmount, onDeactivated, onMounted, watch } from 'vue'
import type { FeedbackConversationRecord } from '@/api/modules/customer-service-feedback'
import { getRestockExpiryDelay } from '@/utils/restock'

export const useRestockExpiryRefresh = (records: () => FeedbackConversationRecord[], refresh: () => Promise<unknown>) => {
  let timer: ReturnType<typeof setTimeout> | null = null
  let active = false
  const awakened = new Set<string>()
  const clockSamples = new Map<string, number>()
  const stop = () => { if (timer) clearTimeout(timer); timer = null }
  const schedule = () => {
    stop()
    if (!active || globalThis.document?.visibilityState === 'hidden') return
    const currentClockKeys = new Set(records().map((record) => record.serverNow))
    for (const key of clockSamples.keys()) if (!currentClockKeys.has(key)) clockSamples.delete(key)
    const targets = records().flatMap((record) => {
      if (!record.restock) return []
      const key = `${record.clientUserId}:${record.restock.id}:${record.restock.latestPickupAt}`
      const delay = getRestockExpiryDelay(record.restock, record.serverNow)
      if (!clockSamples.has(record.serverNow)) clockSamples.set(record.serverNow, Date.now())
      return delay === null || awakened.has(key) ? [] : [{ key, deadline: clockSamples.get(record.serverNow)! + delay }]
    })
    if (!targets.length) return
    const first = targets.reduce((left, right) => left.deadline < right.deadline ? left : right, targets[0])
    const wake = () => {
      const delay = first.deadline - Date.now()
      if (delay > 0) { timer = setTimeout(wake, Math.min(delay, 2147483647)); return }
      targets.filter((target) => target.deadline <= Date.now() + 100).forEach((target) => awakened.add(target.key))
      timer = null
      void refresh().catch(() => { /* 错误提示由原加载入口统一处理，下一次可见恢复时再查询。 */ }).finally(schedule)
    }
    timer = setTimeout(wake, Math.min(Math.max(0, first.deadline - Date.now()) + 100, 2147483647))
  }
  const enter = () => { active = true; schedule() }
  const leave = () => { active = false; stop() }
  watch(records, schedule, { deep: true })
  onMounted(() => { enter(); globalThis.document?.addEventListener('visibilitychange', schedule) })
  onActivated(enter)
  onDeactivated(leave)
  onBeforeUnmount(() => { leave(); globalThis.document?.removeEventListener('visibilitychange', schedule) })
}
