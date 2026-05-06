/**
 * 文件说明：系统用户中心性能辅助模块。
 * 实现逻辑：
 * 1. 统一沉淀用户中心两个低频治理标签页的异步加载器，避免壳层与预热层维护两套入口；
 * 2. 提供可复用的标签预热函数，让路由空闲预热时一并补齐默认标签子包；
 * 3. 通过 Promise.allSettled 收口批量预热，避免任一子包加载失败影响整体导航流程。
 */

export type UserCenterTabKey = 'management' | 'client'

/**
 * 用户中心标签页加载器：
 * - 管理端用户与客户端用户都属于低频治理页；
 * - 统一从这里导出，方便共享壳层和路由预热共同复用同一入口。
 */
export const userCenterTabLoaders = {
  management: () => import('@/views/system/UserManageView.vue'),
  client: () => import('@/views/system/ClientUserManageView.vue'),
} as const satisfies Record<UserCenterTabKey, () => Promise<unknown>>

const warmedUserCenterTabPromises = new Map<UserCenterTabKey, Promise<unknown>>()

/**
 * 预热用户中心标签页：
 * - 仅在需要时加载对应治理子页，避免把两套表格/表单能力强行并入壳层；
 * - 预热失败时静默吞掉单个异常，保证主导航与路由加载不被阻塞。
 */
export const preloadUserCenterTabs = async (tabs: UserCenterTabKey[]) => {
  const uniqueTabs = [...new Set(tabs)]
  await Promise.allSettled(
    uniqueTabs.map((tab) => {
      const cachedPromise = warmedUserCenterTabPromises.get(tab)
      if (cachedPromise !== undefined) {
        return cachedPromise
      }

      const warmupPromise = userCenterTabLoaders[tab]()
      warmedUserCenterTabPromises.set(tab, warmupPromise)
      return warmupPromise
    }),
  )
}
