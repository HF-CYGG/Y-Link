/**
 * 模块说明：金蝶登记响应的新鲜度边界。
 * 文件职责：按管理端/客户端会话隔离原预订单登记版本，拒绝换号迟到响应，防止旧 GET 回退成功登记。
 * 实现逻辑：仅记登记投影的单调版本，不缓存完整父单；轮询的其他业务字段仍使用服务端响应。
 * 维护说明：账号变化必须同步调用 setKingdeeIdentity；不使用 Biz editVersion 推断登记版本，不持久化本状态。
 */
import { shallowRef } from 'vue'
import { CanceledError } from 'axios'
type Scope = 'client' | 'admin'
type Projection = { kingdeeVersion: number; kingdeeVoucherNo: string | null; kingdeeStatus: unknown; isSystemApplied?: boolean }
interface Session { identity: string | null; epoch: number; registrations: Map<string, Projection> }
const sessions = { client: shallowRef<Session>({ identity: null, epoch: 0, registrations: new Map() }), admin: shallowRef<Session>({ identity: null, epoch: 0, registrations: new Map() }) }
export const getKingdeeSession = (scope: Scope) => sessions[scope].value
export function setKingdeeIdentity(scope: Scope, identity: string | null) {
  const previous = getKingdeeSession(scope)
  if (previous.identity !== identity) sessions[scope].value = { identity, epoch: previous.epoch + 1, registrations: new Map() }
}
function reconcile<T>(input: T, session: Session): T {
  if (Array.isArray(input)) return input.map((value) => reconcile(value, session)) as T
  if (!input || typeof input !== 'object') return input
  const result = { ...input } as Record<string, unknown>
  // 只递归业务响应容器，不把任意嵌套对象当作订单，避免扩大缓存范围。
  for (const key of ['order', 'list', 'records', 'detail', 'preorder', 'sourcePreorderRegistrations']) {
    if (result[key] && typeof result[key] === 'object') result[key] = reconcile(result[key], session)
  }
  if (typeof result.kingdeeVersion === 'number' && Number.isSafeInteger(result.kingdeeVersion) && result.kingdeeVersion >= 0) {
    const id = String(result.sourcePreorderId ?? result.id ?? '')
    if (id) {
      const known = session.registrations.get(id)
      if (known && known.kingdeeVersion > Number(result.kingdeeVersion)) Object.assign(result, known)
      else session.registrations.set(id, { kingdeeVersion: Number(result.kingdeeVersion), kingdeeVoucherNo: typeof result.kingdeeVoucherNo === 'string' ? result.kingdeeVoucherNo : null,
        kingdeeStatus: result.kingdeeStatus, ...(typeof result.isSystemApplied === 'boolean' ? { isSystemApplied: result.isSystemApplied } : known?.isSystemApplied === undefined ? {} : { isSystemApplied: known.isSystemApplied }),
      })
    }
  }
  return result as T
}
export const synchronizeKingdeeResponse = <T>(scope: Scope, input: T): T => reconcile(input, getKingdeeSession(scope))
export async function requestWithKingdeeFreshness<T>(scope: Scope, request: () => Promise<T>): Promise<T> {
  const session = getKingdeeSession(scope)
  try {
    const result = await request()
    if (session !== getKingdeeSession(scope)) throw new CanceledError('账号已变化，忽略旧会话响应')
    return reconcile(result, session)
  } catch (error) {
    if (session !== getKingdeeSession(scope)) throw new CanceledError('账号已变化，忽略旧会话响应')
    throw error
  }
}
