/**
 * 模块说明：src/store/modules/database-maintenance.ts
 * 文件职责：维护数据库迁移期间的全局只读状态，并独立轮询公开健康检查确认维护开始与结束。
 * 实现逻辑：
 * - 通过 `/health.maintenance` 同步服务端只读状态，供根组件和 HTTP 层共享；
 * - 已确认进入维护后把状态保存在会话存储中，后端重启断线期间不因轮询失败误清除横幅；
 * - 只有健康检查明确返回 `readOnly=false` 时才结束维护，业务码 50301 也可立即激活维护态。
 * 维护说明：
 * - 健康检查不能复用统一 HTTP 实例，否则会与 HTTP 拦截器形成循环依赖；
 * - 不要根据普通请求恢复或网络失败推断维护结束，服务端健康状态是唯一结束依据。
 */

import { ref } from 'vue'
import { defineStore } from 'pinia'

export const DATABASE_MAINTENANCE_READ_ONLY_CODE = 50301
export const DATABASE_MAINTENANCE_READ_ONLY_MESSAGE = '服务器维护中，当前为只读状态，暂时无法提交操作'

const DATABASE_MAINTENANCE_STORAGE_KEY = 'y-link:database-maintenance'
const DATABASE_MAINTENANCE_POLL_INTERVAL_MS = 3_000
const DATABASE_MAINTENANCE_POLL_TIMEOUT_MS = 5_000

interface DatabaseMaintenancePublicState {
  readOnly: boolean
}

interface DatabaseMaintenanceHealthResponse {
  maintenance?: DatabaseMaintenancePublicState
}

const readPersistedMaintenanceState = () => {
  if (globalThis.window === undefined) {
    return false
  }

  try {
    return globalThis.window.sessionStorage.getItem(DATABASE_MAINTENANCE_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

const persistMaintenanceState = (readOnly: boolean) => {
  if (globalThis.window === undefined) {
    return
  }

  try {
    if (readOnly) {
      globalThis.window.sessionStorage.setItem(DATABASE_MAINTENANCE_STORAGE_KEY, '1')
      return
    }
    globalThis.window.sessionStorage.removeItem(DATABASE_MAINTENANCE_STORAGE_KEY)
  } catch {
    // 隐私模式或存储配额异常不应阻断维护态本身，当前页面内存状态仍会继续生效。
  }
}

/**
 * 健康检查与业务 API 同源，但不带 `/api` 前缀：
 * - 默认开发环境由 `/api` 反向代理到后端，因此需要回到同源 `/health`；
 * - 若配置了完整 API 地址，则保留其 origin 与可能存在的部署子路径。
 */
const resolveHealthCheckUrl = () => {
  const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || '/api'
  const normalizedUrl = apiBaseUrl.replace(/\/+$/, '')
  return `${normalizedUrl.endsWith('/api') ? normalizedUrl.slice(0, -4) : normalizedUrl}/health`
}

export const useDatabaseMaintenanceStore = defineStore('database-maintenance', () => {
  const isReadOnly = ref(readPersistedMaintenanceState())

  let pollingTimer: number | null = null
  let pollingInFlight = false

  /**
   * 同步只读维护：
   * - true 既可由健康检查触发，也可由 HTTP 层识别 50301 后即时触发；
   * - false 仅由成功解析的健康检查传入，网络错误与重启断线不会误清除状态。
   */
  const setMaintenanceState = (readOnly: boolean) => {
    isReadOnly.value = readOnly
    persistMaintenanceState(readOnly)
  }

  const activateMaintenance = () => setMaintenanceState(true)

  const pollMaintenanceState = async () => {
    if (pollingInFlight || globalThis.window === undefined) {
      return
    }

    pollingInFlight = true
    const controller = new AbortController()
    const timeout = globalThis.window.setTimeout(() => controller.abort(), DATABASE_MAINTENANCE_POLL_TIMEOUT_MS)
    try {
      const response = await globalThis.window.fetch(resolveHealthCheckUrl(), {
        cache: 'no-store',
        signal: controller.signal,
      })
      if (!response.ok) {
        return
      }

      const payload = await response.json() as DatabaseMaintenanceHealthResponse
      const readOnly = payload.maintenance?.readOnly
      if (typeof readOnly === 'boolean') {
        setMaintenanceState(readOnly)
      }
    } catch {
      // 已进入维护后必须保留状态；重启窗口中的短暂断线属于预期现象。
    } finally {
      globalThis.window.clearTimeout(timeout)
      pollingInFlight = false
    }
  }

  const startPolling = () => {
    if (pollingTimer || globalThis.window === undefined) {
      return
    }

    void pollMaintenanceState()
    pollingTimer = globalThis.window.setInterval(pollMaintenanceState, DATABASE_MAINTENANCE_POLL_INTERVAL_MS)
  }

  const stopPolling = () => {
    if (!pollingTimer || globalThis.window === undefined) {
      return
    }
    globalThis.window.clearInterval(pollingTimer)
    pollingTimer = null
  }

  return {
    isReadOnly,
    activateMaintenance,
    pollMaintenanceState,
    startPolling,
    stopPolling,
  }
})
