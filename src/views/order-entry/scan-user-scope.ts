/** 用户切换时同步清除扫码面板状态，并使旧账号的排队结果失效。 */
import { watch, type Ref } from 'vue'

export function watchScanUserScope<T>(
  getUserId: () => string | undefined,
  state: {
    manualCode: Ref<string>
    scanStatus: Ref<string>
    tickets: Map<string, T>
    invalidate: () => void
  },
): void {
  watch(getUserId, (userId, previousUserId) => {
    if (userId === previousUserId) return
    state.invalidate()
    state.tickets.clear()
    state.manualCode.value = ''
    state.scanStatus.value = ''
  }, { flush: 'sync' })
}
