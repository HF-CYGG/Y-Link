/**
 * 同一管理会话内按商品查询条件共享请求与短期快照。
 * 调用方以浅层引用保留结果，局部修改须替换行或数组，不能写回共享选项对象。
 */
import { getProductList, type ProductListQuery, type ProductRecord } from '@/api/modules/product'
import pinia from '@/store/pinia'
import { useAuthStore } from '@/store/modules/auth'
import { dataChangeVersions } from '@/utils/data-change-signal'

const CACHE_TTL_MS = 20_000
const MAX_CACHED_QUERIES = 6
type ProductOptionsRequest = { signal?: AbortSignal; force?: boolean }
type Snapshot = { version: string; validUntil: number; rows: ProductRecord[] }
type Flight = { controller: AbortController; result: Promise<ProductRecord[]> }

const snapshots = new Map<string, Snapshot>()
const flights = new Map<string, Flight>()
let sessionKey: string | null = null
let sessionEpoch = 0
let subscribed = false

// 请求参数是原始值；键排序将等价对象合并到同一查询。
const queryKeyFor = (query: ProductListQuery) =>
  JSON.stringify(Object.entries(query).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)))

function syncSession() {
  const auth = useAuthStore(pinia)
  const user = auth.currentUser
  const nextKey = user
    ? JSON.stringify([user.id, user.role, user.status, [...user.permissions].sort(), auth.expiresAt])
    : null
  if (sessionKey !== nextKey) {
    sessionKey = nextKey
    sessionEpoch += 1
    snapshots.clear()
    for (const flight of flights.values()) flight.controller.abort()
    flights.clear()
  }
}

export function readAdminProductOptionsExpiry(query: ProductListQuery): number {
  syncSession()
  return snapshots.get(queryKeyFor(query))?.validUntil ?? 0
}

function withCallerCancellation<T>(result: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return result
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('商品选项请求已取消', 'AbortError'))
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void result.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

export async function getAdminProductOptions(
  query: ProductListQuery,
  { signal, force }: ProductOptionsRequest = {},
): Promise<ProductRecord[]> {
  if (!subscribed) {
    subscribed = true
    useAuthStore(pinia).$subscribe(syncSession, { detached: true, flush: 'sync' })
  }
  syncSession()
  const epoch = sessionEpoch
  if (!sessionKey || signal?.aborted) throw new DOMException('商品选项请求已取消', 'AbortError')
  // 供货方响应的库存始终脱敏为零，正常出入库不需要刷新该投影。
  const includesStock = useAuthStore(pinia).currentUser?.role !== 'supplier'
  const readVersion = () => `${dataChangeVersions.products}:${includesStock ? dataChangeVersions.inventory : 0}`
  const params = { ...query }
  const queryKey = queryKeyFor(params)
  if (force) snapshots.delete(queryKey)

  while (epoch === sessionEpoch && !signal?.aborted) {
    const version = readVersion()
    const snapshot = snapshots.get(queryKey)
    if (!force && snapshot?.version === version && snapshot.validUntil > Date.now()) {
      snapshots.delete(queryKey)
      snapshots.set(queryKey, snapshot)
      return snapshot.rows
    }
    const flightKey = JSON.stringify([queryKey, version])
    let flight = flights.get(flightKey)
    if (!flight) {
      const controller = new AbortController()
      const result = getProductList(params, { signal: controller.signal }).then((rows) => {
        if (epoch === sessionEpoch && version === readVersion()) {
          snapshots.delete(queryKey)
          if (snapshots.size >= MAX_CACHED_QUERIES) snapshots.delete(snapshots.keys().next().value!)
          snapshots.set(queryKey, { rows, version, validUntil: Date.now() + CACHE_TTL_MS })
        }
        return rows
      }).finally(() => {
        if (flights.get(flightKey)?.controller === controller) flights.delete(flightKey)
      })
      flight = { controller, result }
      flights.set(flightKey, flight)
    }
    try {
      const rows = await withCallerCancellation(flight.result, signal)
      if (epoch === sessionEpoch && version === readVersion() && !signal?.aborted) return rows
    } catch (error) {
      if (epoch !== sessionEpoch || version === readVersion() || signal?.aborted) throw error
    }
    // 写操作发生时，不把旧结果交给等待中的组件，合并到新版本请求。
    force = false
  }
  throw new DOMException('商品选项请求已取消', 'AbortError')
}
