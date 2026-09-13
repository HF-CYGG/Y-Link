/**
 * 模块说明：backend/src/services/account-business-guard.service.ts
 * 文件职责：在业务写事务内统一锁定账号并复核启用与注销状态，关闭旧鉴权请求越过注销提交的竞态。
 * 实现逻辑：多账号按 ID 升序获取 MySQL 写锁；SQLite 复用全局单写事务队列；锁后统一校验 status 与生命周期时间。
 * 维护说明：会新增账号职责或活动业务的写入口必须先调用本服务，再获取订单、会话、商品等业务锁，保持全局锁序。
 */

import { In, type EntityManager } from 'typeorm'
import { ClientUser } from '../entities/client-user.entity.js'
import { SysUser } from '../entities/sys-user.entity.js'
import { BizError } from '../utils/errors.js'

type LifecycleState = Pick<SysUser | ClientUser, 'status' | 'deactivatedAt' | 'restoredAt'>

export const isAccountCurrentlyDeactivated = (account: Pick<LifecycleState, 'deactivatedAt' | 'restoredAt'>) => (
  (account.deactivatedAt?.getTime() ?? 0) > (account.restoredAt?.getTime() ?? 0)
)

const assertActiveAccount = <T extends LifecycleState>(account: T, label: string): T => {
  if (account.status !== 'enabled' || isAccountCurrentlyDeactivated(account)) {
    throw new BizError(`${label}账号已停用或已注销，请重新登录后再试`, 409)
  }
  return account
}

export async function lockActiveClientAccountForBusiness(
  manager: EntityManager,
  userId: string,
): Promise<ClientUser> {
  const query = manager.getRepository(ClientUser)
    .createQueryBuilder('account')
    .where('account.id = :userId', { userId })
  if (manager.connection.options.type === 'mysql') query.setLock('pessimistic_write')
  const account = await query.getOne()
  if (!account) throw new BizError('客户端账号不存在，请重新登录后再试', 401)
  return assertActiveAccount(account, '客户端')
}

export async function lockActiveSysAccountsForBusiness(
  manager: EntityManager,
  userIds: readonly string[],
): Promise<Map<string, SysUser>> {
  const accounts = await lockSysAccountsInStableOrder(manager, userIds)
  const normalizedIds = [...new Set(userIds.map((item) => String(item).trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right))
  if (accounts.size !== normalizedIds.length) throw new BizError('系统账号不存在，请刷新后重试', 409)
  for (const account of accounts.values()) assertActiveAccount(account, '系统')
  return accounts
}

/** 生命周期治理需要在同一锁序中同时复核 actor 与 target，但 target 本身允许处于注销状态。 */
export async function lockSysAccountsInStableOrder(
  manager: EntityManager,
  userIds: readonly string[],
): Promise<Map<string, SysUser>> {
  const normalizedIds = [...new Set(userIds.map((item) => String(item).trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right))
  if (!normalizedIds.length) return new Map()

  const query = manager.getRepository(SysUser)
    .createQueryBuilder('account')
    .where({ id: In(normalizedIds) })
    .orderBy('account.id', 'ASC')
  if (manager.connection.options.type === 'mysql') query.setLock('pessimistic_write')
  const accounts = await query.getMany()
  return new Map(accounts.map((account) => [String(account.id), account]))
}

export async function lockActiveSysAccountForBusiness(
  manager: EntityManager,
  userId: string,
): Promise<SysUser> {
  const accounts = await lockActiveSysAccountsForBusiness(manager, [userId])
  const account = accounts.get(String(userId))
  if (!account) throw new BizError('系统账号不存在，请刷新后重试', 409)
  return account
}
