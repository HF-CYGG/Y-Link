/**
 * 文件用途：提供系统用户中心相关的性能辅助能力，供用户中心壳层和路由预热流程共同复用。
 * 核心职责：统一导出标签页异步加载器、预热入口以及与用户中心分包加载有关的共享配置。
 * 设计原因：把用户中心低频子页的加载策略集中到单独模块中，避免页面壳层与预热逻辑各自维护一套入口，降低维护成本。
 * 使用边界：当前文件只处理分包加载与预热层面的能力，不承担用户数据治理、表格展示和表单交互逻辑。
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
