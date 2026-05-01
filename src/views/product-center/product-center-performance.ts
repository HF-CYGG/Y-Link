/**
 * 模块说明：src/views/product-center/product-center-performance.ts
 * 文件职责：集中维护产品中心工作台内部各标签页的异步加载器与预热能力。
 * 实现逻辑：
 * - 把“基础信息”和“线上展示”两个重量级子页面从 ProductCenterView 主壳层中拆出，避免路由壳层分包一次性打入两套业务代码；
 * - 同时暴露统一的预热函数，让路由层在命中 `products` 或 `o2o-console-products` 时，既能预热共享壳层，也能按入口补齐当前标签对应的业务子包；
 * - 通过 Promise 缓存避免重复 import，同一路径被 keepAlive 恢复、标签切换或 afterEach 预热多次命中时，只会真正请求一次。
 * 维护说明：
 * - 若产品中心后续新增更多标签，必须同步补充 `ProductCenterTabKey`、`productCenterTabLoaders` 与 `resolveProductCenterWarmupTargets()`；
 * - 若某个标签页改回同步导入，会直接抬高 `ProductCenterView` 主分包体积，应优先保留当前异步拆分模式。
 */
import type { AsyncComponentLoader, Component } from 'vue'

export type ProductCenterTabKey = 'basic' | 'o2o'

type ProductCenterTabLoader = AsyncComponentLoader<Component>

/**
 * 产品中心子页异步加载器：
 * - `basic` 对应基础资料侧的产品主数据维护；
 * - `o2o` 对应线上商品展示与上架配置。
 */
export const productCenterTabLoaders: Record<ProductCenterTabKey, ProductCenterTabLoader> = {
  basic: () => import('@/views/base-data/components/ProductManager.vue'),
  o2o: () => import('@/views/o2o/O2oProductMallManageView.vue'),
}

const warmedProductCenterTabPromises = new Map<ProductCenterTabKey, Promise<unknown>>()

/**
 * 预热指定产品中心标签页：
 * - 供路由预热和页面空闲补包共用；
 * - 已预热过的标签直接复用既有 Promise，避免重复发起网络请求。
 */
export const preloadProductCenterTabs = async (tabKeys: ProductCenterTabKey[]) => {
  const uniqueTabKeys = [...new Set(tabKeys)]
  await Promise.allSettled(
    uniqueTabKeys.map((tabKey) => {
      const cachedPromise = warmedProductCenterTabPromises.get(tabKey)
      if (cachedPromise) {
        return cachedPromise
      }

      const warmupPromise = productCenterTabLoaders[tabKey]()
      warmedProductCenterTabPromises.set(tabKey, warmupPromise)
      return warmupPromise
    }),
  )
}

/**
 * 根据当前命中的产品中心路由，推导应该优先预热的标签页：
 * - 基础资料入口优先预热“基础信息”；
 * - 线上展示入口优先预热“线上展示”；
 * - 其余兜底到“基础信息”，保证旧入口仍可获得稳定结果。
 */
export const resolveProductCenterWarmupTargets = (routeName: string): ProductCenterTabKey[] => {
  if (routeName === 'o2o-console-products') {
    return ['o2o']
  }

  return ['basic']
}
