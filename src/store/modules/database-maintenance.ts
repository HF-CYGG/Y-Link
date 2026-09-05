/**
 * 模块说明：src/store/modules/database-maintenance.ts
 * 文件职责：维护数据库迁移期间的全局只读状态，并以跨标签页单主轮询确认维护开始与结束。
 * 实现逻辑：
 * - 通过 `/health.maintenance` 同步服务端只读状态，供根组件和 HTTP 层共享；
 * - 正常态采用 60～120 秒随机轮询，维护态才切换为约 3 秒快速确认，隐藏页完全停止请求；
 * - 同源标签页使用租约选出一个轮询者，并通过 BroadcastChannel 同步状态，避免多标签重复放大 `/health`；
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
const DATABASE_MAINTENANCE_NORMAL_POLL_MIN_MS = 60_000
const DATABASE_MAINTENANCE_NORMAL_POLL_MAX_MS = 120_000
const DATABASE_MAINTENANCE_ACTIVE_POLL_MIN_MS = 2_500
const DATABASE_MAINTENANCE_ACTIVE_POLL_MAX_MS = 3_500
const DATABASE_MAINTENANCE_POLL_TIMEOUT_MS = 5_000
const DATABASE_MAINTENANCE_CHANNEL_NAME = 'y-link:database-maintenance'
const DATABASE_MAINTENANCE_LEADER_STORAGE_KEY = 'y-link:database-maintenance:leader'
const DATABASE_MAINTENANCE_LEADER_LEASE_MS = 30_000
const DATABASE_MAINTENANCE_LEADER_RENEW_MS = 10_000

interface DatabaseMaintenancePublicState {
  readOnly: boolean
}

interface DatabaseMaintenanceHealthResponse {
  maintenance?: DatabaseMaintenancePublicState
}

interface DatabaseMaintenanceLeaderLease {
  ownerId: string
  expiresAt: number
}

type DatabaseMaintenanceChannelMessage =
  | {
      type: 'state'
      sourceId: string
      readOnly: boolean
      checkedAt: number
    }
  | {
      type: 'poll-request' | 'leader-released'
      sourceId: string
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

const randomBetween = (min: number, max: number) => {
  return min + Math.floor(Math.random() * (max - min + 1))
}

const createMaintenanceTabId = () => {
  const randomId = globalThis.crypto?.randomUUID?.()
  return randomId || `maintenance-${Date.now()}-${Math.random().toString(36).slice(2)}`
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
  let leadershipTimer: number | null = null
  let pollingInFlight = false
  let pollingController: AbortController | null = null
  let maintenanceChannel: BroadcastChannel | null = null
  let pollingStarted = false
  let isPollingLeader = false
  let lastSuccessfulPollAt = 0
  const tabId = createMaintenanceTabId()

  const isPageVisible = () => {
    return globalThis.document === undefined || globalThis.document.visibilityState !== 'hidden'
  }

  const getLeaderStorage = () => {
    if (globalThis.window === undefined) {
      return null
    }
    try {
      return globalThis.window.localStorage
    } catch {
      return null
    }
  }

  const readLeaderLease = (storage: Storage): DatabaseMaintenanceLeaderLease | null => {
    try {
      const raw = storage.getItem(DATABASE_MAINTENANCE_LEADER_STORAGE_KEY)
      if (!raw) {
        return null
      }
      const parsed = JSON.parse(raw) as Partial<DatabaseMaintenanceLeaderLease>
      if (typeof parsed.ownerId !== 'string' || !Number.isFinite(parsed.expiresAt)) {
        return null
      }
      return {
        ownerId: parsed.ownerId,
        expiresAt: Number(parsed.expiresAt),
      }
    } catch {
      return null
    }
  }

  const clearPollingTimer = () => {
    if (pollingTimer === null || globalThis.window === undefined) {
      return
    }
    globalThis.window.clearTimeout(pollingTimer)
    pollingTimer = null
  }

  const clearLeadershipTimer = () => {
    if (leadershipTimer === null || globalThis.window === undefined) {
      return
    }
    globalThis.window.clearTimeout(leadershipTimer)
    leadershipTimer = null
  }

  const postChannelMessage = (message: DatabaseMaintenanceChannelMessage) => {
    try {
      maintenanceChannel?.postMessage(message)
    } catch {
      // BroadcastChannel 在浏览器关闭或隐私模式异常时只退化为当前标签页轮询。
    }
  }

  const broadcastMaintenanceState = (checkedAt = Date.now()) => {
    postChannelMessage({
      type: 'state',
      sourceId: tabId,
      readOnly: isReadOnly.value,
      checkedAt,
    })
  }

  /**
   * 同步只读维护：
   * - true 既可由健康检查触发，也可由 HTTP 层识别 50301 后即时触发；
   * - false 仅由成功解析的健康检查传入，网络错误与重启断线不会误清除状态。
   */
  const setMaintenanceState = (readOnly: boolean, options: { broadcast?: boolean; checkedAt?: number } = {}) => {
    isReadOnly.value = readOnly
    persistMaintenanceState(readOnly)
    if (options.broadcast !== false) {
      broadcastMaintenanceState(options.checkedAt)
    }
  }

  const resolveNextPollDelay = () => {
    return isReadOnly.value
      ? randomBetween(DATABASE_MAINTENANCE_ACTIVE_POLL_MIN_MS, DATABASE_MAINTENANCE_ACTIVE_POLL_MAX_MS)
      : randomBetween(DATABASE_MAINTENANCE_NORMAL_POLL_MIN_MS, DATABASE_MAINTENANCE_NORMAL_POLL_MAX_MS)
  }

  const holdsLeadership = () => {
    if (!isPollingLeader || !isPageVisible()) {
      return false
    }
    const storage = getLeaderStorage()
    if (!storage) {
      return true
    }
    const lease = readLeaderLease(storage)
    return lease?.ownerId === tabId && lease.expiresAt > Date.now()
  }

  const tryAcquireOrRenewLeadership = () => {
    if (!pollingStarted || !isPageVisible()) {
      return false
    }
    const storage = getLeaderStorage()
    if (!storage) {
      return true
    }

    const now = Date.now()
    const existingLease = readLeaderLease(storage)
    if (existingLease && existingLease.ownerId !== tabId && existingLease.expiresAt > now) {
      return false
    }

    try {
      storage.setItem(DATABASE_MAINTENANCE_LEADER_STORAGE_KEY, JSON.stringify({
        ownerId: tabId,
        expiresAt: now + DATABASE_MAINTENANCE_LEADER_LEASE_MS,
      } satisfies DatabaseMaintenanceLeaderLease))
      return readLeaderLease(storage)?.ownerId === tabId
    } catch {
      return true
    }
  }

  const releaseLeadership = () => {
    const storage = getLeaderStorage()
    if (storage) {
      try {
        if (readLeaderLease(storage)?.ownerId === tabId) {
          storage.removeItem(DATABASE_MAINTENANCE_LEADER_STORAGE_KEY)
        }
      } catch {
        // 租约清理失败会在 30 秒后自然过期，不影响当前页面停止网络请求。
      }
    }
    if (isPollingLeader) {
      postChannelMessage({ type: 'leader-released', sourceId: tabId })
    }
    isPollingLeader = false
  }

  const pollMaintenanceState = async () => {
    if (pollingInFlight || globalThis.window === undefined || !isPageVisible()) {
      return
    }

    pollingInFlight = true
    const controller = new AbortController()
    pollingController = controller
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
        lastSuccessfulPollAt = Date.now()
        setMaintenanceState(readOnly, { checkedAt: lastSuccessfulPollAt })
      }
    } catch {
      // 已进入维护后必须保留状态；重启窗口中的短暂断线属于预期现象。
    } finally {
      globalThis.window.clearTimeout(timeout)
      if (pollingController === controller) {
        pollingController = null
      }
      pollingInFlight = false
    }
  }

  const scheduleNextPoll = (delay = resolveNextPollDelay()) => {
    clearPollingTimer()
    if (!pollingStarted || !holdsLeadership() || globalThis.window === undefined) {
      return
    }
    pollingTimer = globalThis.window.setTimeout(async () => {
      pollingTimer = null
      if (!holdsLeadership()) {
        return
      }
      await pollMaintenanceState()
      scheduleNextPoll()
    }, delay)
  }

  const pollNowAsLeader = async () => {
    clearPollingTimer()
    if (!pollingStarted || !holdsLeadership()) {
      return
    }
    await pollMaintenanceState()
    scheduleNextPoll()
  }

  const activateMaintenance = () => {
    setMaintenanceState(true)
    postChannelMessage({ type: 'poll-request', sourceId: tabId })
    if (holdsLeadership()) {
      void pollNowAsLeader()
    }
  }

  const runLeadershipElection = (pollImmediately: boolean) => {
    clearLeadershipTimer()
    if (!pollingStarted || globalThis.window === undefined || !isPageVisible()) {
      clearPollingTimer()
      return
    }

    const wasLeader = isPollingLeader
    isPollingLeader = tryAcquireOrRenewLeadership()
    if (!isPollingLeader) {
      clearPollingTimer()
      // 只在首次启动、重新变为可见或失去领导权时请求当前 leader 回传状态；
      // 普通 10 秒租约检查不能持续触发健康请求，否则多标签页仍会把正常态退化为高频轮询。
      if (pollImmediately || wasLeader) {
        postChannelMessage({ type: 'poll-request', sourceId: tabId })
      }
    } else if (pollImmediately || !wasLeader) {
      void pollNowAsLeader()
    } else if (pollingTimer === null) {
      scheduleNextPoll()
    }

    leadershipTimer = globalThis.window.setTimeout(
      () => runLeadershipElection(false),
      DATABASE_MAINTENANCE_LEADER_RENEW_MS,
    )
  }

  const handleChannelMessage = (event: MessageEvent<DatabaseMaintenanceChannelMessage>) => {
    const message = event.data
    if (!message || message.sourceId === tabId) {
      return
    }
    if (message.type === 'state') {
      // 多标签的维护激活与健康响应可能交错到达；旧消息不能覆盖更新的明确状态。
      if (message.checkedAt < lastSuccessfulPollAt) {
        return
      }
      lastSuccessfulPollAt = Math.max(lastSuccessfulPollAt, message.checkedAt)
      setMaintenanceState(message.readOnly, { broadcast: false })
      if (holdsLeadership()) {
        scheduleNextPoll()
      }
      return
    }
    if (message.type === 'poll-request' && holdsLeadership()) {
      if (lastSuccessfulPollAt && Date.now() - lastSuccessfulPollAt < 5_000) {
        broadcastMaintenanceState(lastSuccessfulPollAt)
        return
      }
      void pollNowAsLeader()
      return
    }
    if (message.type === 'leader-released' && pollingStarted && isPageVisible()) {
      runLeadershipElection(true)
    }
  }

  const handleVisibilityChange = () => {
    if (!pollingStarted) {
      return
    }
    if (!isPageVisible()) {
      clearPollingTimer()
      clearLeadershipTimer()
      pollingController?.abort()
      releaseLeadership()
      return
    }
    runLeadershipElection(true)
  }

  const handleLeaderStorageChange = (event: StorageEvent) => {
    if (!pollingStarted || event.key !== DATABASE_MAINTENANCE_LEADER_STORAGE_KEY || !isPageVisible()) {
      return
    }
    const storage = getLeaderStorage()
    const lease = storage ? readLeaderLease(storage) : null
    if (isPollingLeader && lease?.ownerId !== tabId) {
      isPollingLeader = false
      clearPollingTimer()
    }
    if (!lease || lease.expiresAt <= Date.now()) {
      runLeadershipElection(true)
    }
  }

  const startPolling = () => {
    if (pollingStarted || globalThis.window === undefined) {
      return
    }
    pollingStarted = true
    if ('BroadcastChannel' in globalThis.window) {
      try {
        maintenanceChannel = new BroadcastChannel(DATABASE_MAINTENANCE_CHANNEL_NAME)
        maintenanceChannel.addEventListener('message', handleChannelMessage)
      } catch {
        // 受限浏览器禁止创建频道时仍保留 localStorage 租约与当前标签轮询能力。
        maintenanceChannel = null
      }
    }
    globalThis.document?.addEventListener('visibilitychange', handleVisibilityChange)
    globalThis.window.addEventListener('storage', handleLeaderStorageChange)
    runLeadershipElection(true)
  }

  const stopPolling = () => {
    if (!pollingStarted || globalThis.window === undefined) {
      return
    }
    pollingStarted = false
    clearPollingTimer()
    clearLeadershipTimer()
    pollingController?.abort()
    pollingController = null
    globalThis.document?.removeEventListener('visibilitychange', handleVisibilityChange)
    globalThis.window.removeEventListener('storage', handleLeaderStorageChange)
    releaseLeadership()
    maintenanceChannel?.removeEventListener('message', handleChannelMessage)
    maintenanceChannel?.close()
    maintenanceChannel = null
  }

  return {
    isReadOnly,
    activateMaintenance,
    pollMaintenanceState,
    startPolling,
    stopPolling,
  }
})
